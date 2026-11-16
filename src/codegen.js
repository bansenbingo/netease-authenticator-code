import { encryptBlock } from "./aes.js";

export const EXAMPLE_SECRET = "8810552096-5faf56ca673d910187068f1373e679c0";

// The reference service's clock runs a little ahead of this machine. Keeping
// that difference here makes the 30-second window turn over at the same moment
// as the service; without it the last few seconds of every window differ.
const REFERENCE_CLOCK_OFFSET_MS = 2666;

// Every code belongs to a 30-second window; the service prints a new one when
// the window turns over. The page uses these two values to show a countdown and
// to know when the displayed code has to be recomputed.
export const WINDOW_SECONDS = 30;
export const WINDOW_MS = WINDOW_SECONDS * 1000;

const TOO_FEW = `复制过少，例：8809085213-32fdf427572ca1a055e26b1122885481`;
const TOO_MANY = `复制过多，例：8809085213-32fdf427572ca1a055e26b1122885481`;
const WRONG_FORMAT = `格式错误，例：8809085213-32fdf427572ca1a055e26b1122885481 请注意分割符号" － "`;

const ZERO_WIDTH = /[\u200b-\u200f\u2060\ufeff]/g;
const DASHES = /[\u2010-\u2015\u2212]/g;
const FULL_WIDTH = /[\uff01-\uff5e]/g;

// Copying a key out of a chat, a note or a spreadsheet brings guests along:
// full-width characters from a Chinese keyboard, a "－" or "—" instead of the
// ASCII dash, invisible zero-width characters, stray spaces and line breaks.
// Every one of them used to end in "格式错误"; they are folded back to the
// characters the service actually expects before anything is validated.
export function normalizeSecret(input) {
  return String(input ?? "")
    .replace(ZERO_WIDTH, "")
    .replace(FULL_WIDTH, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .replace(DASHES, "-")
    .replace(/[\s\u3000]+/g, "");
}

// The service keeps its clock in China Standard Time (UTC+8), and the window
// boundary is the same instant for every key: when the shifted clock crosses a
// multiple of 30 seconds.
function referenceTime(now) {
  return now.getTime() + REFERENCE_CLOCK_OFFSET_MS;
}

export function msUntilNextWindow(now = new Date()) {
  const elapsed = ((referenceTime(now) % WINDOW_MS) + WINDOW_MS) % WINDOW_MS;
  return WINDOW_MS - elapsed;
}

// The service turns every character of the 32-character key into a
// hexadecimal-style digit. Letters beyond f continue the sequence, which is
// why an all-letter key still produces a code instead of an error.
function characterValue(character) {
  const code = character.toLowerCase().charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 122) return code - 87;
  return 0;
}

function keyBytes(key) {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 32; i += 2) {
    const high = characterValue(key[i]);
    const low = characterValue(key[i + 1]);
    bytes[i / 2] = (high * 16 + low) & 0xff;
  }
  return bytes;
}

function serialBytes(serial) {
  const leadingDigits = serial.match(/^\d+/);
  let value = leadingDigits ? BigInt(leadingDigits[0]) : 0n;
  const bytes = new Uint8Array(6);
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

export function parseSecret(input) {
  const text = normalizeSecret(input);

  if (!text.includes("-")) {
    return { error: WRONG_FORMAT };
  }

  const parts = text.split("-");
  const serial = parts[0];
  const key = parts[parts.length - 1];

  if (key.length < 32 || serial.length < 10) {
    return { error: TOO_FEW };
  }
  if (key.length > 32 || serial.length > 10) {
    return { error: TOO_MANY };
  }
  if (!/^[0-9a-zA-Z]{32}$/.test(key)) {
    return { error: WRONG_FORMAT };
  }

  return { serial, key };
}

export function generateCode(secret, now = new Date()) {
  const parsed = parseSecret(secret);
  if (parsed.error) {
    return { error: parsed.error };
  }

  const local = new Date(referenceTime(now) + 8 * 60 * 60 * 1000);
  const salt = new Uint8Array(16);

  salt[0] = 0;
  salt[1] = 20;
  salt[2] = local.getUTCFullYear() % 10;
  salt[3] = local.getUTCMonth();
  salt[4] = local.getUTCDate();
  salt[5] = local.getUTCHours();
  salt[6] = local.getUTCMinutes();
  salt[7] = 30 * Math.floor(local.getUTCSeconds() / 30);

  salt.set(serialBytes(parsed.serial), 8);
  salt[14] = 0;
  salt[15] = 0;

  const encrypted = encryptBlock(salt, keyBytes(parsed.key));
  let code = "";
  for (let i = 10; i < 16; i += 1) {
    code += String(encrypted[i] % 10);
  }

  return { code };
}