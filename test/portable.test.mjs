import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { generateCode } from "../src/codegen.js";

// Overridable so the same checks can run against a downloaded release asset:
//   CODE163_EXE=C:\path\to\163Code-1.0.0.exe npm run test:portable
const exe = process.env.CODE163_EXE
  ? fileURLToPath(process.env.CODE163_EXE)
  : fileURLToPath(new URL("../release/163Code-1.0.0.exe", import.meta.url));
const screenshotPath = process.env.CODE163_SCREENSHOT
  ? fileURLToPath(process.env.CODE163_SCREENSHOT)
  : fileURLToPath(new URL("../checks/portable-window.png", import.meta.url));

// A fixed port breaks as soon as something else holds it, so ask the OS for a
// free one and hand it to Chromium.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const debugPort = await freePort();

// Some tooling (including Electron-based agent harnesses) exports
// ELECTRON_RUN_AS_NODE=1, which would turn the packaged app into a plain Node
// process that exits immediately. Drop it so the window really starts.
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const app = spawn(exe, [`--remote-debugging-port=${debugPort}`], {
  stdio: "ignore",
  windowsHide: false,
  env: childEnv,
});

async function waitForDebugger() {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (response.ok) return;
    } catch {
      // The portable launcher is still unpacking.
    }
    await delay(500);
  }
  throw new Error("Packaged app did not expose its debug port in time.");
}

let browser;
try {
  await waitForDebugger();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const context = browser.contexts()[0];
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "app://site" }).catch(() => {});
  const page = context.pages().find((candidate) => candidate.url().startsWith("app://"))
    ?? await context.waitForEvent("page", { timeout: 30000 });
  await page.waitForLoadState("load");

  const secrets = [
    "8813821400-2ba2c5b82a2c8b4dac39fdd6a0ec3d31",
    "8811637300-bce5e990eae33fc2c32e000f8fedbf53",
  ];

  // Put a key in first so the measured height includes the current card and the
  // saved list, which is what the shipped window actually looks like.
  await page.fill("#secret", secrets[0]);
  await page.fill("#note", "打包自检");
  await page.click('input[type="submit"]');
  await page.waitForTimeout(300);

  const layout = await page.evaluate(() => {
    const form = document.querySelector("form").getBoundingClientRect();
    const rows = [...document.querySelectorAll("#saved-list .saved-row")];
    return {
      title: document.title,
      h1: document.querySelector("h1")?.textContent,
      h2: [...document.querySelectorAll("h2")].map((heading) => heading.textContent.trim()),
      images: document.querySelectorAll("img").length,
      formWidth: Math.round(form.width),
      bodyHeight: Math.ceil(document.body.getBoundingClientRect().height),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      expectedWidth: Math.min(520, Math.max(320, window.screen.availWidth - 40)),
      expectedHeight: Math.min(document.body.getBoundingClientRect().height, Math.max(240, window.screen.availHeight - 80)),
      currentHidden: document.getElementById("current-card").hidden,
      savedHidden: document.getElementById("saved-card").hidden,
      savedRows: rows.length,
      savedCode: rows[0]?.querySelector(".saved-code")?.textContent,
      currentNote: document.getElementById("current-note").textContent,
      code: document.getElementById("code").value,
      countdown: document.getElementById("countdown").textContent,
    };
  });

  // The HTML <title> becomes the window title once the page loads.
  assert.equal(layout.title, "网易将军令验证码在线获取");
  assert.equal(layout.h1, "网易将军令验证码在线获取");
  assert.equal(layout.h2.length, 1, "only the saved-keys heading is left");
  assert.match(layout.h2[0], /^已保存的密钥/);
  assert.equal(layout.images, 0, "the tutorial picture was removed on request");
  assert.equal(layout.formWidth, 440);
  assert.ok(layout.bodyHeight > 380 && layout.bodyHeight < 1100, `body height ${layout.bodyHeight}`);
  assert.equal(layout.currentHidden, false);
  assert.equal(layout.savedHidden, false);
  assert.equal(layout.savedRows, 1, "the key added above shows up in the saved list");
  assert.equal(layout.savedCode, layout.code, "the row and the big card agree");
  assert.equal(layout.currentNote, "打包自检");
  assert.match(layout.countdown, /^本验证码 \d+ 秒后自动更新$/);

  // The window sizes itself to the card instead of the old fixed 720x500, and
  // backs off to the work area on a screen narrower than 560 DIP.
  assert.equal(layout.innerWidth, layout.expectedWidth, "window hugs the content width or the screen");
  assert.ok(
    Math.abs(layout.innerHeight - layout.expectedHeight) <= 24,
    `window height ${layout.innerHeight} should hug ${layout.expectedHeight}`,
  );

  for (const secret of secrets) {
    await page.fill("#secret", secret);
    await page.click('input[type="submit"]');
    const shown = await page.inputValue("#code");
    const now = Date.now();
    const accepted = [0, -30000, 30000].map((offset) => generateCode(secret, new Date(now + offset)).code);
    assert.equal(shown.length, 6, `six digits for ${secret}`);
    assert.ok(accepted.includes(shown), `code ${shown} is current for ${secret}`);
  }

  const savedRows = await page.evaluate(() =>
    [...document.querySelectorAll("#saved-list .saved-row")].map((row) => row.querySelector(".saved-code").textContent),
  );
  const savedSecrets = await page.evaluate(() =>
    [...document.querySelectorAll("#saved-list .saved-row")].map((row) => row.dataset.secret),
  );
  assert.equal(savedRows.length, 2, "both keys stay in the list");
  for (const [index, secret] of savedSecrets.entries()) {
    const accepted = [0, -30000, 30000].map((offset) => generateCode(secret, new Date(Date.now() + offset)).code);
    assert.ok(accepted.includes(savedRows[index]), `row code ${savedRows[index]} is current for ${secret}`);
  }

  const generated = await page.inputValue("#code");
  await page.click(".copy-button");
  // Only the read-back can be unavailable; the copy itself must work, and the
  // label is only set once the clipboard write really resolved.
  let clipboard = null;
  try {
    clipboard = await page.evaluate(() => navigator.clipboard.readText());
  } catch (error) {
    console.warn("Clipboard read was not available in the packaged test:", error.message);
  }
  if (clipboard !== null) {
    assert.equal(clipboard, generated, "copy button must copy the code");
  }
  assert.equal(await page.evaluate(() => document.querySelector(".copy-button").value), "已复制");

  await page.screenshot({ path: screenshotPath });
  console.log("Packaged app test passed:", layout, "code", generated);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (app.pid) {
    await new Promise((resolve) => {
      execFile("taskkill", ["/PID", String(app.pid), "/T", "/F"], () => resolve());
    });
  }
}