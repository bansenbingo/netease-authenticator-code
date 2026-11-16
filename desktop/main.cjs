const { app, BrowserWindow, Menu, ipcMain, protocol, screen } = require("electron");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const siteDirectory = app.isPackaged
  ? path.resolve(process.resourcesPath, "site")
  : path.resolve(__dirname, "..", "dist");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

let mainWindow = null;

const CONTENT_WIDTH = 520;
const MIN_CONTENT_WIDTH = 320;
const MIN_CONTENT_HEIGHT = 380;
const MIN_CONTENT_HEIGHT_SMALL = 240;

// The page is a single small card, so a fixed 720x500 window left a lot of
// empty grey. The renderer reports the documented height (see preload.cjs) and
// the window hugs it, staying inside the work area of its display.
function fitWindowToContent(height) {
  if (!mainWindow || !Number.isFinite(height) || height <= 0) return;

  const workArea = screen.getDisplayMatching(mainWindow.getBounds()).workAreaSize;
  // A tiny work area (a small laptop at 200% scaling) must not push the window
  // past the screen: clamp the *available* space, then stay inside it.
  const availableWidth = Math.max(MIN_CONTENT_WIDTH, workArea.width - 40);
  const availableHeight = Math.max(MIN_CONTENT_HEIGHT_SMALL, workArea.height - 80);
  const width = Math.min(CONTENT_WIDTH, availableWidth);
  const target = Math.min(Math.max(Math.ceil(height), MIN_CONTENT_HEIGHT), availableHeight);
  const [, current] = mainWindow.getContentSize();

  if (Math.abs(target - current) < 2) return;
  mainWindow.setContentSize(width, target, false);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: CONTENT_WIDTH,
    height: MIN_CONTENT_HEIGHT,
    minWidth: MIN_CONTENT_WIDTH,
    minHeight: MIN_CONTENT_HEIGHT_SMALL,
    useContentSize: true,
    show: false,
    // The card owns the layout: dragging the frame would only be undone by the
    // next content-height report, so the frame is not resizable at all.
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: "#f4f4f4",
    title: "网易将军令验证码生成器",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.center();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // This window only ever shows the bundled page: no popups, no navigation away.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("app://site/")) event.preventDefault();
  });

  mainWindow.loadURL("app://site/index.html");
}

function registerSiteProtocol() {
  protocol.handle("app", async (request) => {
    try {
      const requested = new URL(request.url);
      if (requested.host !== "site") {
        return new Response("Forbidden", { status: 403 });
      }

      let pathname = decodeURIComponent(requested.pathname);
      if (pathname === "" || pathname === "/") pathname = "/index.html";

      const relative = path.normalize(pathname).replace(/^[/\\]+/, "");
      const filePath = path.resolve(siteDirectory, relative);
      if (filePath !== siteDirectory && !filePath.startsWith(siteDirectory + path.sep)) {
        return new Response("Forbidden", { status: 403 });
      }

      const data = await readFile(filePath);
      const type = contentTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
      return new Response(new Uint8Array(data), {
        headers: {
          "content-type": type,
          "cache-control": "no-cache",
          // The bundle is local and static: nothing inline, nothing remote.
          "content-security-policy":
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.setAppUserModelId("net.battla.code163");

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerSiteProtocol();
    createWindow();

    ipcMain.on("fit-height", (event, height) => {
      if (!mainWindow || event.sender !== mainWindow.webContents) return;
      if (event.senderFrame !== mainWindow.webContents.mainFrame) return;
      fitWindowToContent(height);
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
