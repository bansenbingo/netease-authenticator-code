import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { generateCode, msUntilNextWindow } from "../src/codegen.js";

const root = fileURLToPath(new URL("../dist/", import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = pathname === "/" ? "index.html" : pathname.slice(1);
    const body = await readFile(join(root, file));
    response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });

const errors = [];
context.on("page", (opened) => {
  opened.on("pageerror", (error) => errors.push(String(error)));
  opened.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
});

const page = await context.newPage();
await page.goto(origin, { waitUntil: "load" });

const cases = [
  "8813821400-2ba2c5b82a2c8b4dac39fdd6a0ec3d31",
  "8811637300-bce5e990eae33fc2c32e000f8fedbf53",
];

const rowOf = (secret) => `#saved-list .saved-row[data-secret="${secret}"]`;
const sixDigits = (secret, now = Date.now()) =>
  [0, -30000, 30000].map((offset) => generateCode(secret, new Date(now + offset)).code);

async function addKey(target, secret, note = "") {
  await target.fill("#secret", secret);
  await target.fill("#note", note);
  await target.click('input[type="submit"]');
}

const initial = await page.evaluate(() => {
  const form = document.querySelector("form").getBoundingClientRect();
  return {
    formWidth: form.width,
    pageHeight: Math.ceil(document.body.getBoundingClientRect().height),
    title: document.title,
    headings: [...document.querySelectorAll("h1")].map((node) => node.textContent),
    h2: [...document.querySelectorAll("h2")].map((node) => node.textContent.trim()),
    images: document.querySelectorAll("img").length,
    text: document.body.innerText,
    currentHidden: document.getElementById("current-card").hidden,
    savedHidden: document.getElementById("saved-card").hidden,
    secretFontSize: getComputedStyle(document.getElementById("secret")).fontSize,
  };
});

assert.equal(Math.round(initial.formWidth), 440);
// The tutorial picture is gone, so the page starts as one compact card.
assert.ok(initial.pageHeight > 380 && initial.pageHeight < 700, `page height ${initial.pageHeight}`);
assert.equal(initial.title, "网易将军令验证码在线获取");
assert.deepEqual(initial.headings, ["网易将军令验证码在线获取"]);
assert.equal(initial.h2.length, 1);
assert.ok(initial.h2[0].startsWith("已保存的密钥"), `saved section heading: ${initial.h2[0]}`);
assert.equal(initial.images, 0);
assert.ok(!initial.text.includes("战网登录教程"), "the tutorial section is intentionally removed");
assert.ok(initial.currentHidden, "no code card before a key is saved");
assert.ok(initial.savedHidden, "no saved list before a key is saved");
assert.equal(initial.secretFontSize, "14px");

// --- adding keys, notes and the per-key dashboard ---------------------------

await addKey(page, cases[0], "欧服大号");

const firstCode = await page.inputValue("#code");
assert.ok(sixDigits(cases[0]).includes(firstCode), `code ${firstCode} matches a live window`);
assert.equal(await page.evaluate(() => document.getElementById("current-card").hidden), false);
const afterFirst = await page.evaluate(() => ({
  countdown: document.getElementById("countdown").textContent,
  progress: document.getElementById("progress-bar").style.width,
  note: document.getElementById("current-note").textContent,
  hint: document.getElementById("hint").textContent,
  rows: document.querySelectorAll("#saved-list .saved-row").length,
  rowNote: document.querySelector(".saved-row .saved-note").textContent,
  rowCode: document.querySelector(".saved-row .saved-code").textContent,
  meta: document.getElementById("saved-meta").textContent,
}));
assert.match(afterFirst.countdown, /^本验证码 \d+ 秒后自动更新$/);
const seconds = Number(afterFirst.countdown.match(/\d+/)[0]);
assert.ok(seconds >= 1 && seconds <= 30, `countdown ${seconds}`);
assert.ok(Math.abs(Number.parseFloat(afterFirst.progress) - (seconds / 30) * 100) < 4, `progress ${afterFirst.progress}`);
assert.equal(afterFirst.note, "欧服大号");
assert.ok(afterFirst.hint.includes("30 秒"), "the hint explains the refresh window");
assert.equal(afterFirst.rows, 1);
assert.equal(afterFirst.rowNote, "欧服大号");
assert.equal(afterFirst.rowCode, firstCode, "the saved row shows the same code as the big card");
assert.match(afterFirst.meta, /共 1 个 · 每 10 秒刷新/);

await addKey(page, cases[1], "国服小号");

const twoRows = await page.evaluate(
  (secrets) =>
    secrets.map((secret) => {
      const row = document.querySelector(`#saved-list .saved-row[data-secret="${secret}"]`);
      return {
        note: row.querySelector(".saved-note").textContent,
        code: row.querySelector(".saved-code").textContent,
        active: row.classList.contains("active"),
      };
    }),
  cases,
);
assert.equal(twoRows.length, 2);
assert.equal(twoRows[0].note, "欧服大号");
assert.equal(twoRows[1].note, "国服小号");
for (const [index, row] of twoRows.entries()) {
  assert.ok(sixDigits(cases[index]).includes(row.code), `row ${index} code ${row.code} is live`);
}
assert.equal(twoRows[1].active, true, "the key just added is the one shown large");
assert.equal(twoRows[0].active, false);

// Clicking a row brings that key back to the big card without retyping it.
await page.click(`${rowOf(cases[0])} .saved-note`);
const switched = await page.evaluate(
  (secret) => ({
    code: document.getElementById("code").value,
    note: document.getElementById("current-note").textContent,
    active: document.querySelector(`#saved-list .saved-row[data-secret="${secret}"]`).classList.contains("active"),
  }),
  cases[0],
);
assert.ok(sixDigits(cases[0]).includes(switched.code), `switched code ${switched.code} is live`);
assert.equal(switched.note, "欧服大号");
assert.equal(switched.active, true);

// Renaming a note inline (Enter commits).
await page.click(`${rowOf(cases[0])} .mini.note`);
await page.fill(`${rowOf(cases[0])} .saved-note-input`, "欧服主号");
await page.keyboard.press("Enter");
assert.equal(await page.textContent(`${rowOf(cases[0])} .saved-note`), "欧服主号");
assert.equal(await page.textContent("#current-note"), "欧服主号", "the big card follows the rename");

// Deleting the other key leaves exactly one row and one stored entry.
await page.click(`${rowOf(cases[1])} .mini.danger`);
const afterDelete = await page.evaluate(() => ({
  rows: document.querySelectorAll("#saved-list .saved-row").length,
  stored: JSON.parse(localStorage.getItem("code163.saved-secrets") ?? "[]").map((entry) => entry.secret),
  meta: document.getElementById("saved-meta").textContent,
}));
assert.equal(afterDelete.rows, 1);
assert.deepEqual(afterDelete.stored, [cases[0]]);
assert.match(afterDelete.meta, /共 1 个/);

// --- errors, copy and the clipboard ----------------------------------------

await page.fill("#secret", "wrongformat");
await page.click('input[type="submit"]');
const failure = await page.evaluate(() => ({
  errorHidden: document.getElementById("error").hidden,
  message: document.getElementById("error").textContent,
  hint: document.getElementById("hint").textContent,
  code: document.getElementById("code").value,
}));
assert.equal(failure.errorHidden, false);
assert.match(failure.message, /^格式错误/);
assert.ok(failure.hint.includes("32 位"), "the hint says what a key looks like");
assert.equal(failure.code, "", "a rejected key clears the code box");

// A paste from a Chinese keyboard: full-width characters and a full-width dash
// are folded into the real key, and the tidied key is written back.
await page.fill("#secret", "８８１３８２１４００－２ｂａ２ｃ５ｂ８２ａ２ｃ８ｂ４ｄａｃ３９ｆｄｄ６ａ０ｅｃ３ｄ３１");
await page.click('input[type="submit"]');
assert.equal(await page.inputValue("#secret"), cases[0], "the tidied key is written back to the box");
assert.equal(await page.evaluate(() => document.getElementById("error").hidden), true);
assert.equal((await page.inputValue("#code")).length, 6);
assert.equal(
  await page.evaluate(() => document.querySelectorAll("#saved-list .saved-row").length),
  1,
  "re-adding an existing key must not duplicate the row",
);

const generated = await page.inputValue("#code");
await page.click(".copy-button");

// Reading the clipboard back may be refused by the browser; the copy itself is
// not optional, so the label assertion stays outside the try. The app only
// shows "已复制" once the write really resolved.
let clipboard = null;
try {
  clipboard = await page.evaluate(() => navigator.clipboard.readText());
} catch (error) {
  console.warn("Clipboard read was not available in this test:", error.message);
}
if (clipboard !== null) {
  assert.equal(clipboard, generated, "the copy button must put the code on the clipboard");
}
assert.equal(await page.evaluate(() => document.querySelector(".copy-button").value), "已复制");
assert.match(await page.textContent("#hint"), /已复制 \d{6} 到剪贴板/);

// Each row has its own copy button for the key it belongs to.
await page.click(`${rowOf(cases[0])} .mini.copy`);
assert.equal(await page.textContent(`${rowOf(cases[0])} .mini.copy`), "已复制");
let rowClipboard = null;
try {
  rowClipboard = await page.evaluate(() => navigator.clipboard.readText());
} catch (error) {
  console.warn("Clipboard read was not available in this test:", error.message);
}
if (rowClipboard !== null) {
  assert.ok(sixDigits(cases[0]).includes(rowClipboard), `row copy put ${rowClipboard} on the clipboard`);
}

// A refused clipboard must not claim success: the user would walk away with the
// previous code still on the clipboard. Its own context keeps this from
// touching the saved keys used by the rest of the test.
const deniedContext = await browser.newContext({ viewport: { width: 520, height: 700 } });
const deniedPage = await deniedContext.newPage();
await deniedPage.addInitScript(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => Promise.reject(new Error("denied")) },
  });
  document.execCommand = () => false;
});
await deniedPage.goto(origin, { waitUntil: "load" });
await addKey(deniedPage, cases[0], "被拒绝");
await deniedPage.click(".copy-button");
assert.match(await deniedPage.textContent("#hint"), /复制失败/);
assert.equal(await deniedPage.evaluate(() => document.querySelector(".copy-button").value), "复制验证码");
await deniedContext.close();

// --- persistence ------------------------------------------------------------

await page.reload({ waitUntil: "load" });
const restored = await page.evaluate(
  (secret) => ({
    rows: document.querySelectorAll("#saved-list .saved-row").length,
    note: document.querySelector(`#saved-list .saved-row[data-secret="${secret}"] .saved-note`).textContent,
    code: document.getElementById("code").value,
    currentHidden: document.getElementById("current-card").hidden,
    noteInput: document.getElementById("note").value,
    rowCount: document.getElementById("saved-meta").textContent,
  }),
  cases[0],
);
assert.equal(restored.rows, 1, "the saved key survives a reload");
assert.equal(restored.note, "欧服主号", "the note survives a reload");
assert.match(restored.code, /^\d{6}$/, "the code is shown again without typing");
assert.equal(restored.currentHidden, false);
assert.equal(restored.noteInput, "", "the add form stays empty for the next key");
assert.match(restored.rowCount, /共 1 个/);

// Old "recent secrets" lists from the previous version are migrated.
const legacyContext = await browser.newContext({ viewport: { width: 520, height: 700 } });
const legacyPage = await legacyContext.newPage();
await legacyPage.addInitScript((secret) => {
  localStorage.setItem("code163.recent-secrets", JSON.stringify([secret]));
}, cases[1]);
await legacyPage.goto(origin, { waitUntil: "load" });
const migrated = await legacyPage.evaluate(() => ({
  rows: document.querySelectorAll("#saved-list .saved-row").length,
  note: document.querySelector("#saved-list .saved-row .saved-note").textContent,
  code: document.getElementById("code").value,
}));
assert.equal(migrated.rows, 1);
assert.equal(migrated.note, "未命名");
assert.match(migrated.code, /^\d{6}$/);
await legacyContext.close();

// --- phone layout -----------------------------------------------------------

await page.setViewportSize({ width: 390, height: 844 });
const phone = await page.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth: window.innerWidth,
  headingHeight: document.querySelector("h1").getBoundingClientRect().height,
}));
assert.ok(phone.scrollWidth <= phone.innerWidth, "phone layout must not scroll sideways");
assert.ok(phone.headingHeight < 40, `heading stays on one line (${phone.headingHeight}px)`);

assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);

// --- auto refresh on a fake clock ------------------------------------------

const clockContext = await browser.newContext({ viewport: { width: 520, height: 760 } });
const clockPage = await clockContext.newPage();
await clockPage.clock.install({ time: new Date("2026-03-04T05:06:07.890Z") });
await clockPage.goto(origin, { waitUntil: "load" });
await addKey(clockPage, cases[0], "甲");
await addKey(clockPage, cases[1], "乙");

const readClock = () =>
  clockPage.evaluate((secrets) => {
    const rows = secrets.map((secret) => {
      const row = document.querySelector(`#saved-list .saved-row[data-secret="${secret}"]`);
      return row.querySelector(".saved-code").textContent;
    });
    return {
      now: Date.now(),
      code: document.getElementById("code").value,
      rows,
      countdown: document.getElementById("countdown").textContent,
      progress: Number.parseFloat(document.getElementById("progress-bar").style.width),
    };
  }, cases);

const first = await readClock();
// The last key added is the one shown in the big card.
assert.equal(first.code, generateCode(cases[1], new Date(first.now)).code, "code matches the fake clock");
const expectedSeconds = Math.max(1, Math.ceil(msUntilNextWindow(new Date(first.now)) / 1000));
assert.equal(first.countdown, `本验证码 ${expectedSeconds} 秒后自动更新`);
assert.ok(Math.abs(first.progress - (expectedSeconds / 30) * 100) < 4);
assert.deepEqual(
  first.rows,
  [generateCode(cases[0], new Date(first.now)).code, generateCode(cases[1], new Date(first.now)).code],
  "both saved rows show the code for now",
);

// Past a 30-second boundary the big card and every row move by themselves.
await clockPage.clock.runFor(31_000);
const second = await readClock();
assert.equal(second.code, generateCode(cases[1], new Date(second.now)).code, "the code rolled over by itself");
assert.deepEqual(
  second.rows,
  [generateCode(cases[0], new Date(second.now)).code, generateCode(cases[1], new Date(second.now)).code],
  "the saved rows rolled over with it",
);
assert.notEqual(second.now, first.now, "the clock really advanced");

await clockPage.clock.runFor(60_000);
const third = await readClock();
assert.equal(third.code, generateCode(cases[1], new Date(third.now)).code, "still correct two windows later");
assert.deepEqual(
  third.rows,
  [generateCode(cases[0], new Date(third.now)).code, generateCode(cases[1], new Date(third.now)).code],
);

// The 10-second list refresh runs on its own timer even when the code is
// unchanged, so a long sleep never leaves a stale row behind.
await clockPage.clock.runFor(10_000);
const fourth = await readClock();
assert.deepEqual(
  fourth.rows,
  [generateCode(cases[0], new Date(fourth.now)).code, generateCode(cases[1], new Date(fourth.now)).code],
);

await clockContext.close();
await browser.close();
server.close();
console.log("Browser test passed.");