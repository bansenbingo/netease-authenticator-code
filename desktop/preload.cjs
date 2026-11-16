// The page is one small card whose height changes a little as the countdown
// row, the error line and the hint appear. Rather than guess a window size,
// report the real document height and let the main process hug it.
const { ipcRenderer } = require("electron");

let lastReported = 0;

function reportHeight() {
  const height = Math.ceil(document.body.getBoundingClientRect().height);
  if (height <= 0 || height === lastReported) return;
  lastReported = height;
  ipcRenderer.send("fit-height", height);
}

window.addEventListener("DOMContentLoaded", () => {
  reportHeight();
  // Content-driven height changes (a new countdown row, a wrapped hint).
  new ResizeObserver(reportHeight).observe(document.body);
  // Font swap-in and the fresh-code animation do not always resize the body,
  // so poll slowly as a safety net; duplicates never leave the renderer.
  setInterval(reportHeight, 2000);
});