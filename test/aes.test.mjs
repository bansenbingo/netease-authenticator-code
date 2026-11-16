import assert from "node:assert/strict";
import crypto from "node:crypto";
import { encryptBlock } from "../src/aes.js";
import { generateCode } from "../src/codegen.js";

function reference(block, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", Buffer.from(key), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.from(block)), cipher.final()]);
}

for (let sample = 0; sample < 24; sample += 1) {
  const key = crypto.createHash("sha256").update(`key-${sample}`).digest().subarray(0, 16);
  const block = crypto.createHash("sha256").update(`block-${sample}`).digest().subarray(0, 16);
  assert.deepEqual(Buffer.from(encryptBlock(new Uint8Array(block), new Uint8Array(key))), reference(block, key));
}

const vectors = [
  ["8813821400-2ba2c5b82a2c8b4dac39fdd6a0ec3d31", "2026-11-15T10:25:37Z", "185869"],
  ["8811637300-bce5e990eae33fc2c32e000f8fedbf53", "2026-11-15T10:25:43Z", "809345"],
  ["8813821400-2ba2c5b82a2c8b4dac39fdd6a0ec3d31", "2026-11-15T10:57:05Z", "850903"],
  ["8811637300-bce5e990eae33fc2c32e000f8fedbf53", "2026-11-15T10:57:05Z", "682091"],
  ["8813821400-2BA2C5B82A2C8B4DAC39FDD6A0EC3D31", "2026-11-15T10:25:43Z", "185869"],
  ["8813821400-00000000000000000000000000000000", "2026-11-15T10:59:50Z", "428984"],
  ["8813821400-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", "2026-11-15T10:59:50Z", "047625"],
  ["8813821400-gggggggggggggggggggggggggggggggg", "2026-11-15T10:59:50Z", "154177"],
];

for (const [secret, time, expected] of vectors) {
  assert.equal(generateCode(secret, new Date(time)).code, expected, `${secret} at ${time}`);
}

assert.match(generateCode("notasecret").error, /^格式错误/);
assert.match(generateCode("8813821400-too-short").error, /^复制过少/);
assert.match(generateCode("8813821400-" + "a".repeat(33)).error, /^复制过多/);

const nonNumericSerial = generateCode("abcdefghij-" + "0".repeat(32), new Date("2026-11-15T10:59:50Z"));
const zeroSerial = generateCode("0000000000-" + "0".repeat(32), new Date("2026-11-15T10:59:50Z"));
assert.equal(nonNumericSerial.code, zeroSerial.code);

console.log("All code generation tests passed.");
