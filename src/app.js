import {
  WINDOW_MS,
  WINDOW_SECONDS,
  generateCode,
  msUntilNextWindow,
  normalizeSecret,
} from "./codegen.js";

const SAVED_KEY = "code163.saved-secrets";
const LEGACY_RECENT_KEY = "code163.recent-secrets";
const MAX_SAVED = 20;
const MAX_NOTE = 24;
const TICK_MS = 1000;
const SAVED_REFRESH_MS = 10_000;
const COPY_FEEDBACK_MS = 1500;
const FRESH_MS = 700;
const COPY_LABEL = "复制验证码";

const addForm = document.getElementById("code-form");
const secretInput = document.getElementById("secret");
const noteInput = document.getElementById("note");
const recentOptions = document.getElementById("recent-secrets");
const errorBox = document.getElementById("error");

const currentCard = document.getElementById("current-card");
const currentNote = document.getElementById("current-note");
const currentSecret = document.getElementById("current-secret");
const codeInput = document.getElementById("code");
const codeStatus = document.getElementById("code-status");
const copyButton = document.querySelector(".copy-button");
const countdown = document.getElementById("countdown");
const progressBar = document.getElementById("progress-bar");

const savedCard = document.getElementById("saved-card");
const savedMeta = document.getElementById("saved-meta");
const savedList = document.getElementById("saved-list");
const hint = document.getElementById("hint");

/** @type {{ secret: string, note: string, addedAt: number }[]} */
let saved = [];
let activeSecret = null;
let clockTimer = null;
let savedTimer = null;
let copyTimer = null;
let freshTimer = null;
let copying = false;

function setHint(text) {
  hint.textContent = text;
}

function maskSecret(secret) {
  return secret.length > 18 ? `${secret.slice(0, 10)}…${secret.slice(-6)}` : secret;
}

function paintCountdown(now = new Date()) {
  const remaining = msUntilNextWindow(now);
  const seconds = Math.max(1, Math.ceil(remaining / 1000));
  countdown.textContent = `本验证码 ${seconds} 秒后自动更新`;
  progressBar.style.width = `${(remaining / WINDOW_MS) * 100}%`;
}

function markFresh() {
  codeInput.classList.remove("fresh");
  // Reading offsetWidth restarts the animation when two windows share a code.
  void codeInput.offsetWidth;
  codeInput.classList.add("fresh");
  clearTimeout(freshTimer);
  freshTimer = setTimeout(() => codeInput.classList.remove("fresh"), FRESH_MS);
}

function hintForError(message) {
  if (message.startsWith("复制过少")) {
    return "还差几个字符：密钥是 10 位数字 + “-” + 32 位字母或数字，请确认整段都复制到了。";
  }
  if (message.startsWith("复制过多")) {
    return "多了几个字符：只保留 10 位数字 + “-” + 32 位字母或数字即可。";
  }
  return "格式应为 10 位数字 + “-” + 32 位字母或数字；全角符号、空格和换行会自动修正。";
}

function showError(message) {
  clearActive();
  errorBox.textContent = message;
  errorBox.hidden = false;
  setHint(hintForError(message));
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = "";
}

function loadSaved() {
  const entries = [];
  const seen = new Set();
  const accept = (secret, note, addedAt) => {
    const normalized = normalizeSecret(String(secret ?? ""));
    if (!normalized || seen.has(normalized)) return;
    if (generateCode(normalized).error) return;
    seen.add(normalized);
    entries.push({
      secret: normalized,
      note: String(note ?? "").trim().slice(0, MAX_NOTE),
      addedAt: Number(addedAt) || Date.now(),
    });
  };

  try {
    const raw = JSON.parse(localStorage.getItem(SAVED_KEY) ?? "[]");
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item && typeof item === "object") accept(item.secret, item.note, item.addedAt);
      }
    }
  } catch {
    // A corrupt or locked-down store just means starting empty.
  }

  if (entries.length === 0) {
    // Carry the old "recent secrets" list over so nobody loses their keys.
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_RECENT_KEY) ?? "[]");
      if (Array.isArray(legacy)) for (const secret of legacy) accept(secret, "", 0);
    } catch {
      // Nothing to migrate.
    }
  }

  return entries.slice(0, MAX_SAVED);
}

function persistSaved() {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
  } catch {
    // A refused write still leaves the in-memory list usable for this run.
  }
}

function renderDatalist() {
  recentOptions.replaceChildren(
    ...saved.map((entry) => {
      const option = document.createElement("option");
      option.value = entry.secret;
      option.label = entry.note || "";
      return option;
    }),
  );
}

function stopClock() {
  if (clockTimer !== null) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
  if (savedTimer !== null) {
    clearInterval(savedTimer);
    savedTimer = null;
  }
}

function paintRowCode(row, entry, now) {
  const cell = row.querySelector(".saved-code");
  const result = generateCode(entry.secret, now);
  const next = result.error ? "——" : result.code;
  if (cell.textContent !== next) {
    cell.textContent = next;
    if (!result.error) {
      cell.classList.remove("fresh");
      void cell.offsetWidth;
      cell.classList.add("fresh");
    }
  }
}

// The saved list is refreshed on its own 10-second beat, plus immediately
// whenever the visible code turns over, so the two views never disagree.
function refreshSavedCodes(now = new Date()) {
  for (const row of savedList.children) {
    const entry = saved.find((item) => item.secret === row.dataset.secret);
    if (entry) paintRowCode(row, entry, now);
  }
}

function tick() {
  if (!activeSecret) return;

  // One timestamp for both the code and the countdown, so the frame that
  // crosses a window boundary cannot show the old code next to a full timer.
  const now = new Date();
  const result = generateCode(activeSecret, now);
  if (result.error) {
    showError(result.error);
    return;
  }

  if (result.code !== codeInput.value) {
    codeInput.value = result.code;
    codeStatus.textContent = `验证码更新为 ${result.code.split("").join(" ")}`;
    markFresh();
    refreshSavedCodes(now);
  }
  paintCountdown(now);
}

function startClock() {
  stopClock();
  tick();
  clockTimer = setInterval(tick, TICK_MS);
  savedTimer = setInterval(() => refreshSavedCodes(), SAVED_REFRESH_MS);
}

function paintCurrentNote(entry) {
  currentNote.textContent = entry?.note || "未命名";
  currentNote.classList.toggle("placeholder", !entry?.note);
}

function highlightActiveRow() {
  for (const row of savedList.children) {
    row.classList.toggle("active", row.dataset.secret === activeSecret);
  }
}

function miniButton(label, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `mini ${className}`;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function buildRow(entry) {
  const row = document.createElement("li");
  row.className = "saved-row";
  row.dataset.secret = entry.secret;
  row.classList.toggle("active", entry.secret === activeSecret);

  const main = document.createElement("div");
  main.className = "saved-main";

  const note = document.createElement("p");
  note.className = entry.note ? "saved-note" : "saved-note placeholder";
  note.textContent = entry.note || "未命名";

  const secretLine = document.createElement("p");
  secretLine.className = "saved-secret";
  secretLine.textContent = maskSecret(entry.secret);

  main.append(note, secretLine);

  const side = document.createElement("div");
  side.className = "saved-side";

  const code = document.createElement("span");
  code.className = "saved-code";
  code.textContent = "······";

  const actions = document.createElement("div");
  actions.className = "saved-actions";

  const copy = miniButton("复制", "copy", async () => {
    const result = generateCode(entry.secret);
    if (result.error) return;
    const copied = await copyText(result.code);
    copy.textContent = copied ? "已复制" : "失败";
    copy.classList.toggle("ok", copied);
    clearTimeout(copy.dataset.timer ?? 0);
    copy.dataset.timer = String(
      setTimeout(() => {
        copy.textContent = "复制";
        copy.classList.remove("ok");
      }, COPY_FEEDBACK_MS),
    );
    setHint(
      copied
        ? `已复制 ${result.code}（${entry.note || "未命名"}）到剪贴板。`
        : "复制失败，请手动选中验证码后按 Ctrl+C 复制。",
    );
  });

  const rename = miniButton("备注", "note", () => beginNoteEdit(row, entry));
  const remove = miniButton("删除", "danger", () => removeSaved(entry));

  actions.append(copy, rename, remove);
  side.append(code, actions);
  row.append(main, side);

  row.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    const note2 = entry.note;
    if (setActive(entry.secret)) {
      setHint(
        note2
          ? `正在显示「${note2}」，验证码每 ${WINDOW_SECONDS} 秒自动更新。`
          : `正在显示该密钥，验证码每 ${WINDOW_SECONDS} 秒自动更新。`,
      );
    }
  });

  return row;
}

function renderSaved() {
  savedCard.hidden = saved.length === 0;
  savedMeta.textContent = saved.length ? `共 ${saved.length} 个 · 每 ${SAVED_REFRESH_MS / 1000} 秒刷新` : "";
  savedList.replaceChildren(...saved.map(buildRow));
  renderDatalist();
  refreshSavedCodes(new Date());
}

function beginNoteEdit(row, entry) {
  const noteEl = row.querySelector(".saved-note");
  if (!noteEl) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "saved-note-input";
  input.maxLength = MAX_NOTE;
  input.value = entry.note;
  noteEl.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = (commit) => {
    if (settled) return;
    settled = true;
    if (commit) {
      entry.note = input.value.trim().slice(0, MAX_NOTE);
      persistSaved();
      // Renaming the key that is currently on show must update the big card
      // too, otherwise the two places disagree until the next switch.
      if (activeSecret === entry.secret) paintCurrentNote(entry);
    }
    renderSaved();
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

function removeSaved(entry) {
  saved = saved.filter((item) => item.secret !== entry.secret);
  persistSaved();
  const wasActive = activeSecret === entry.secret;
  if (wasActive) clearActive();
  renderSaved();
  // Deleting the key that was on show falls through to the next one instead of
  // leaving an empty card, since the point of the list is always-on codes.
  if (wasActive && saved.length > 0) setActive(saved[0].secret);
  setHint(`已删除${entry.note ? `「${entry.note}」` : "该密钥"}。`);
}

function clearActive() {
  activeSecret = null;
  stopClock();
  currentCard.hidden = true;
  codeInput.value = "";
  codeInput.classList.remove("fresh", "invalid");
  codeStatus.textContent = "";
  highlightActiveRow();
}

function setActive(secret) {
  const normalized = normalizeSecret(secret);
  const result = generateCode(normalized);
  if (result.error) {
    showError(result.error);
    return false;
  }

  activeSecret = normalized;
  clearError();

  const entry = saved.find((item) => item.secret === normalized);
  currentCard.hidden = false;
  paintCurrentNote(entry);
  currentSecret.textContent = maskSecret(normalized);

  codeInput.value = result.code;
  codeStatus.textContent = `验证码为 ${result.code.split("").join(" ")}`;
  markFresh();
  paintCountdown();
  startClock();
  highlightActiveRow();
  return true;
}

function fallbackCopy(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.className = "visually-hidden";
  document.body.append(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand("copy") === true;
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the selection-based copy.
    }
  }
  return fallbackCopy(text);
}

async function copyCurrentCode() {
  const value = codeInput.value;

  if (!activeSecret || !/^\d{6}$/.test(value)) {
    setHint("还没有可复制的验证码，请先粘贴密钥并点“添加并显示验证码”。");
    return;
  }

  // A second click while the first write is still pending would interleave two
  // hints and two button states; ignore it instead.
  if (copying) return;
  copying = true;

  let copied = false;
  try {
    copied = await copyText(value);
  } finally {
    copying = false;
  }

  // Clipboard access can be refused (a busy clipboard, a locked-down profile),
  // and telling the user "已复制" then would send them off with a stale code.
  if (!copied) {
    clearTimeout(copyTimer);
    copyButton.value = COPY_LABEL;
    setHint("复制失败，请手动选中验证码后按 Ctrl+C 复制。");
    return;
  }

  copyButton.value = "已复制";
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copyButton.value = COPY_LABEL;
  }, COPY_FEEDBACK_MS);
  // The clipboard write is asynchronous and a window can turn over mid-copy;
  // say which code actually landed there instead of implying it is the one on
  // screen.
  setHint(
    codeInput.value === value
      ? `已复制 ${value} 到剪贴板。`
      : `已复制 ${value} 到剪贴板；验证码刚刚更新为 ${codeInput.value}，请重新复制。`,
  );
}

addForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const normalized = normalizeSecret(secretInput.value);
  secretInput.value = normalized;

  const result = generateCode(normalized);
  if (result.error) {
    showError(result.error);
    return;
  }

  const note = noteInput.value.trim().slice(0, MAX_NOTE);
  const existing = saved.find((item) => item.secret === normalized);
  if (existing) {
    if (note) existing.note = note;
  } else {
    saved.unshift({ secret: normalized, note, addedAt: Date.now() });
    saved = saved.slice(0, MAX_SAVED);
  }

  persistSaved();
  noteInput.value = "";
  renderSaved();
  setActive(normalized);

  const label = note || existing?.note;
  setHint(
    label
      ? `已保存「${label}」，验证码每 ${WINDOW_SECONDS} 秒自动更新。`
      : `已保存该密钥，验证码每 ${WINDOW_SECONDS} 秒自动更新。`,
  );
});

copyButton.addEventListener("click", copyCurrentCode);

secretInput.addEventListener("input", () => {
  clearError();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    tick();
    refreshSavedCodes();
  }
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    tick();
    refreshSavedCodes();
  }
});

saved = loadSaved();
renderSaved();

if (saved.length > 0) {
  const first = saved[0];
  setActive(first.secret);
  setHint(
    `已载入 ${saved.length} 个密钥，列表每 ${SAVED_REFRESH_MS / 1000} 秒自动刷新；点一行可切换到大窗显示。`,
  );
} else {
  setHint("粘贴一整段密钥（形如 8810552096-5faf…）后点“添加并显示验证码”，可以加备注保存多个密钥。");
}

// Put the cursor at the end of the key so pasting over a remembered key is one
// keystroke away.
secretInput.focus();
secretInput.setSelectionRange(secretInput.value.length, secretInput.value.length);