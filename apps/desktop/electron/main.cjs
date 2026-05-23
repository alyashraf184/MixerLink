const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { startSessionRelay } = require("./session-relay.cjs");

const isDev = Boolean(process.env.MIXERLINK_DEV_SERVER_URL);
let sessionRelay;
let mainWindow;

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

async function readSettings() {
  try {
    const raw = await fs.readFile(getSettingsPath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {
      customPluginFolders: []
    };
  }
}

async function writeSettings(settings) {
  await fs.mkdir(path.dirname(getSettingsPath()), { recursive: true });
  await fs.writeFile(getSettingsPath(), JSON.stringify(settings, null, 2));
}

function normalizeFolders(folders) {
  const seen = new Set();
  const result = [];

  for (const folder of folders) {
    const normalized = String(folder ?? "").trim();
    const key = normalized.toLowerCase();

    if (normalized && !seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }

  return result;
}

function getScannerModulePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "scanner", "index.js");
  }

  return path.join(__dirname, "..", "..", "..", "packages", "scanner", "dist", "index.js");
}

async function scanCompatibility() {
  try {
    const scanner = await import(pathToFileURL(getScannerModulePath()).href);
    const settings = await readSettings();
    return scanner.scanLocalCompatibility({
      customPluginFolders: settings.customPluginFolders
    });
  } catch (error) {
    console.error("MixerLink compatibility scan failed:", error);
    throw new Error(error instanceof Error ? error.message : "Unknown compatibility scan error");
  }
}

async function getCustomPluginFolders() {
  const settings = await readSettings();
  return normalizeFolders(settings.customPluginFolders ?? []);
}

async function addCustomPluginFolder() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Add plugin folder",
    properties: ["openDirectory"]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return getCustomPluginFolders();
  }

  const settings = await readSettings();
  const customPluginFolders = normalizeFolders([...(settings.customPluginFolders ?? []), result.filePaths[0]]);
  await writeSettings({
    ...settings,
    customPluginFolders
  });
  return customPluginFolders;
}

async function removeCustomPluginFolder(_event, folderToRemove) {
  const settings = await readSettings();
  const customPluginFolders = normalizeFolders(settings.customPluginFolders ?? []).filter(
    (folder) => folder.toLowerCase() !== String(folderToRemove).toLowerCase()
  );
  await writeSettings({
    ...settings,
    customPluginFolders
  });
  return customPluginFolders;
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
  mainWindow = window;

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
  ipcMain.handle("plugin-folders:get", getCustomPluginFolders);
  ipcMain.handle("plugin-folders:add", addCustomPluginFolder);
  ipcMain.handle("plugin-folders:remove", removeCustomPluginFolder);
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
