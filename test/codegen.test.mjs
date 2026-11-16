import assert from "node:assert/strict";
import {
  EXAMPLE_SECRET,
  WINDOW_MS,
  WINDOW_SECONDS,
  generateCode,
  msUntilNextWindow,
  normalizeSecret,
  parseSecret,
} from "../src/codegen.js";

const SECRET = "8813821400-2ba2c5b82a2c8b4dac39fdd6a0ec3d31";
const TIME = new Date("2026-11-15T10:25:43Z");
const CODE = generateCode(SECRET, TIME).code;

assert.equal(WINDOW_MS, 30_000);
assert.equal(WINDOW_SECONDS, 30);

// --- normalizeSecret: the dirt that a copy/paste brings along ---------------
const variants = [
  "  " + SECRET + "  ",
  `${SECRET}\n`,
  `\ufeff${SECRET}\u200b`,
  SECRET.replace("-", "－"), // U+FF0D full-width hyphen-minus
  SECRET.replace("-", "—"), // U+2014 em dash
  SECRET.replace("-", "–"), // U+2013 en dash
  SECRET.replace("-", "−"), // U+2212 minus sign
  SECRET.replace("-", " - "), // spaces around the separator
  "８８１３８２１４００－２ｂａ２ｃ５ｂ８２ａ２ｃ８ｂ４ｄａｃ３９ｆｄｄ６ａ０ｅｃ３ｄ３１", // full-width everything
];

for (const variant of variants) {
  assert.equal(normalizeSecret(variant), SECRET, `normalized: ${JSON.stringify(variant)}`);
  assert.equal(generateCode(variant, TIME).code, CODE, `same code for: ${JSON.stringify(variant)}`);
}

// Case is preserved by normalization but does not matter to the code.
assert.equal(generateCode(SECRET.toUpperCase(), TIME).code, CODE);
assert.equal(normalizeSecret(SECRET.toUpperCase()), SECRET.toUpperCase());

assert.equal(normalizeSecret(undefined), "");
assert.equal(normalizeSecret(null), "");
assert.equal(normalizeSecret("\u3000"), "", "ideographic space is dropped like a normal space");
assert.equal(normalizeSecret("a\u200bb"), "ab");

// --- parseSecret ------------------------------------------------------------
assert.deepEqual(parseSecret(EXAMPLE_SECRET), {
  serial: "8810552096",
  key: "5faf56ca673d910187068f1373e679c0",
});
assert.match(parseSecret("nodash").error, /^格式错误/);
assert.match(parseSecret("8813821400-short").error, /^复制过少/);
assert.match(parseSecret(`8813821400-${"a".repeat(33)}`).error, /^复制过多/);
assert.match(parseSecret(`8813821400-${"a".repeat(31)}!`).error, /^格式错误/);
// The service reads the serial as leading digits, so junk letters there are 0.
assert.equal(generateCode(`abcdefghij-${"0".repeat(32)}`, TIME).code, generateCode(`0000000000-${"0".repeat(32)}`, TIME).code);

// --- windows: the next boundary is at most 30 s away, and the code is stable
for (const iso of [
  "2026-11-15T10:25:37Z",
  "2026-11-15T10:25:43Z",
  "2026-11-15T23:59:59.999Z",
  "2027-01-01T00:00:00.000Z",
]) {
  const now = new Date(iso);
  const remaining = msUntilNextWindow(now);
  assert.ok(remaining > 0 && remaining <= WINDOW_MS, `remaining ${remaining} at ${iso}`);
  assert.equal(
    generateCode(SECRET, new Date(now.getTime() + remaining - 1)).code,
    generateCode(SECRET, now).code,
    `the code holds to the last millisecond of the window at ${iso}`,
  );
  assert.equal(msUntilNextWindow(new Date(now.getTime() + remaining)), WINDOW_MS);
}

// Two instants in the same 30-second window share a code; the window after it
// starts a new one (guarded against the 1-in-a-million collision). The window
// boundary sits 2.666 s before the wall-clock multiple of 30 s, so align first.
const anchor = new Date("2026-11-15T10:25:30Z");
const windowStart = new Date(anchor.getTime() - (WINDOW_MS - msUntilNextWindow(anchor)));
assert.equal(msUntilNextWindow(windowStart), WINDOW_MS);
assert.equal(generateCode(SECRET, windowStart).code, generateCode(SECRET, new Date(windowStart.getTime() + 29_999)).code);
assert.notEqual(generateCode(SECRET, windowStart).code, generateCode(SECRET, new Date(windowStart.getTime() + 30_000)).code);

console.log("All window and input-normalization tests passed.");