import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { WINDOW_MS, generateCode, msUntilNextWindow } from "../src/codegen.js";

const root = fileURLToPath(new URL("../dist/", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

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

async function siteCode(secret) {
  const response = await fetch("https://battla.net/163code.php", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret }).toString(),
  });
  const html = await response.text();
  return {
    code: (html.match(/id="code" value="([^"]*)"/) ?? [])[1],
    date: response.headers.get("date"),
    status: response.status,
  };
}

// A comparison made 100 ms before a window boundary can legitimately read the
// old code locally and the new one from the service. Sample in the calm middle
// of a window instead of racing the boundary.
async function settleInsideWindow() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const remaining = msUntilNextWindow();
    const elapsed = WINDOW_MS - remaining;
    if (elapsed >= 4000 && elapsed <= 22000) return elapsed;
    await new Promise((resolve) => setTimeout(resolve, Math.min(remaining + 4000, 12000)));
  }
  throw new Error("could not find a stable point inside a 30-second window");
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(origin, { waitUntil: "load" });

const secrets = [
  "8813821400-2ba2c5b82a2c8b4dac39fdd6a0ec3d31",
  "8811637300-bce5e990eae33fc2c32e000f8fedbf53",
];

// Read the page's code on both sides of the network call: the round trip can
// straddle a 30-second boundary, in which case the service is right either way.
async function sample(secret) {
  const elapsed = await settleInsideWindow();
  await page.fill("#secret", secret);
  await page.click('input[type="submit"]');
  const before = await page.inputValue("#code");
  const requestedAt = Date.now();
  const live = await siteCode(secret);
  const after = await page.inputValue("#code");
  const serverMs = Date.parse(live.date);
  return {
    elapsed,
    before,
    after,
    live,
    requestedAt,
    drift: Number.isFinite(serverMs) ? serverMs - requestedAt : null,
  };
}

function assertAgrees(result, secret, label) {
  const { before, after, live } = result;
  assert.equal(live.status, 200, "the reference form answered");
  assert.match(before, /^\d{6}$/);
  assert.match(live.code ?? "", /^\d{6}$/, "the service printed a six-digit code");
  assert.ok(
    [before, after].includes(live.code),
    `${label}: the service said ${live.code}, the page said ${before} (then ${after}) for ${secret}`,
  );
}

for (let round = 0; round < 3; round += 1) {
  for (const secret of secrets) {
    const result = await sample(secret);
    console.log(
      `round ${round + 1} ${secret.slice(0, 10)} local ${result.before}->${result.after} ` +
        `site ${result.live.code} ${Math.round(result.elapsed / 1000)}s into window, ` +
        `clock delta ${result.drift === null ? "unknown" : `${Math.round(result.drift)}ms`}`,
    );

    assertAgrees(result, secret, `round ${round + 1}`);
    // The known ~2.7 s offset only decides the last seconds of a window; a
    // clock that has drifted by minutes would show up here first. Services are
    // free to omit the Date header, so only check it when it is there.
    if (result.drift !== null) {
      assert.ok(Math.abs(result.drift) < 10_000, `client clock is ${result.drift}ms away from the service`);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 8000));
}

// Cross at least one window boundary and confirm both sides move together.
await new Promise((resolve) => setTimeout(resolve, msUntilNextWindow() + 2000));
for (const secret of secrets) {
  const result = await sample(secret);
  console.log(`after the boundary ${secret.slice(0, 10)} local ${result.before} site ${result.live.code}`);
  assertAgrees(result, secret, "after the window turned over");
  assert.equal(result.after, generateCode(secret).code, "the page follows its own clock");
}

await browser.close();
server.close();
console.log("Local build matches the live service for both keys.");