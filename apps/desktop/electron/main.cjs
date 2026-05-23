const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { startSessionRelay } = require("./session-relay.cjs");

const isDev = Boolean(process.env.MIXERLINK_DEV_SERVER_URL);
let sessionRelay;

function getScannerModulePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "scanner", "index.js");
  }

  return path.join(__dirname, "..", "..", "..", "packages", "scanner", "dist", "index.js");
}

async function scanCompatibility() {
  try {
    const scanner = await import(pathToFileURL(getScannerModulePath()).href);
    return scanner.scanLocalCompatibility();
  } catch (error) {
    console.error("MixerLink compatibility scan failed:", error);
    throw new Error(error instanceof Error ? error.message : "Unknown compatibility scan error");
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1120,
    height: 860,
    minWidth: 900,
    minHeight: 680,
    backgroundColor: "#090a0f",
    title: "MixerLink",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs")
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    window.loadURL(process.env.MIXERLINK_DEV_SERVER_URL);
  } else {
    window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  ipcMain.handle("compatibility:scan", scanCompatibility);
  sessionRelay = startSessionRelay(4317);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  sessionRelay?.close();

  if (process.platform !== "darwin") {
    app.quit();
  }
});
