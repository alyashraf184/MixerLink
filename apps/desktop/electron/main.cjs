const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
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
      customFlStudioFolders: [],
      userDataFolders: [],
      projectFolders: [],
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

function getLocalRelayUrls() {
  const urls = ["ws://localhost:4317"];
  const interfaces = os.networkInterfaces();

  for (const networkInterface of Object.values(interfaces)) {
    for (const address of networkInterface ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        urls.push(`ws://${address.address}:4317`);
      }
    }
  }

  return Array.from(new Set(urls));
}

async function scanCompatibility() {
  try {
    const scanner = await import(pathToFileURL(getScannerModulePath()).href);
    const settings = await readSettings();
    return scanner.scanLocalCompatibility({
      customFlStudioFolders: settings.customFlStudioFolders,
      userDataFolders: settings.userDataFolders,
      projectFolders: settings.projectFolders,
      customPluginFolders: settings.customPluginFolders
    });
  } catch (error) {
    console.error("MixerLink compatibility scan failed:", error);
    throw new Error(error instanceof Error ? error.message : "Unknown compatibility scan error");
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function launchDetached(executablePath, args = []) {
  const child = spawn(executablePath, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

async function launchFlStudio(_event, executablePath) {
  const normalizedExecutablePath = String(executablePath ?? "").trim();

  if (normalizedExecutablePath && (await pathExists(normalizedExecutablePath))) {
    launchDetached(normalizedExecutablePath);
    return { ok: true };
  }

  const settings = await readSettings();
  const scanner = await import(pathToFileURL(getScannerModulePath()).href);
  const snapshot = await scanner.scanLocalCompatibility({
    customFlStudioFolders: settings.customFlStudioFolders,
    userDataFolders: settings.userDataFolders,
    projectFolders: settings.projectFolders,
    customPluginFolders: settings.customPluginFolders,
    maxPluginsPerFolder: 1,
    maxProjectFilesPerFolder: 1,
    maxDepth: 1
  });

  if (snapshot.daw?.executablePath && (await pathExists(snapshot.daw.executablePath))) {
    launchDetached(snapshot.daw.executablePath);
    return { ok: true };
  }

  throw new Error("FL Studio executable was not found. Add the FL Studio install folder, then scan again.");
}

async function openProjectInFlStudio(_event, request) {
  const projectPath = String(request?.projectPath ?? "").trim();
  const executablePath = String(request?.executablePath ?? "").trim();

  if (!projectPath || !(await pathExists(projectPath))) {
    throw new Error("Project file was not found.");
  }

  if (executablePath && (await pathExists(executablePath))) {
    launchDetached(executablePath, [projectPath]);
    return { ok: true };
  }

  const result = await shell.openPath(projectPath);
  if (result) {
    throw new Error(result);
  }

  return { ok: true };
}

async function revealPath(_event, targetPath) {
  const normalizedPath = String(targetPath ?? "").trim();

  if (!normalizedPath || !(await pathExists(normalizedPath))) {
    throw new Error("Path was not found.");
  }

  shell.showItemInFolder(normalizedPath);
  return { ok: true };
}

async function getFolders(settingsKey) {
  const settings = await readSettings();
  return normalizeFolders(settings[settingsKey] ?? []);
}

async function addFolder(settingsKey, title) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    properties: ["openDirectory"]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return getFolders(settingsKey);
  }

  const settings = await readSettings();
  const folders = normalizeFolders([...(settings[settingsKey] ?? []), result.filePaths[0]]);
  await writeSettings({
    ...settings,
    [settingsKey]: folders
  });
  return folders;
}

async function removeFolder(settingsKey, folderToRemove) {
  const settings = await readSettings();
  const folders = normalizeFolders(settings[settingsKey] ?? []).filter(
    (folder) => folder.toLowerCase() !== String(folderToRemove).toLowerCase()
  );
  await writeSettings({
    ...settings,
    [settingsKey]: folders
  });
  return folders;
}

function getCustomFlStudioFolders() {
  return getFolders("customFlStudioFolders");
}

function addCustomFlStudioFolder() {
  return addFolder("customFlStudioFolders", "Add FL Studio install folder");
}

function removeCustomFlStudioFolder(_event, folderToRemove) {
  return removeFolder("customFlStudioFolders", folderToRemove);
}

function getUserDataFolders() {
  return getFolders("userDataFolders");
}

function addUserDataFolder() {
  return addFolder("userDataFolders", "Add FL Studio user data folder");
}

function removeUserDataFolder(_event, folderToRemove) {
  return removeFolder("userDataFolders", folderToRemove);
}

function getProjectFolders() {
  return getFolders("projectFolders");
}

function addProjectFolder() {
  return addFolder("projectFolders", "Add project folder");
}

function removeProjectFolder(_event, folderToRemove) {
  return removeFolder("projectFolders", folderToRemove);
}

async function getCustomPluginFolders() {
  return getFolders("customPluginFolders");
}

async function addCustomPluginFolder() {
  return addFolder("customPluginFolders", "Add plugin folder");
}

async function removeCustomPluginFolder(_event, folderToRemove) {
  return removeFolder("customPluginFolders", folderToRemove);
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
  window.maximize();

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
  ipcMain.handle("fl-studio:launch", launchFlStudio);
  ipcMain.handle("project:open", openProjectInFlStudio);
  ipcMain.handle("path:reveal", revealPath);
  ipcMain.handle("relay-urls:get", getLocalRelayUrls);
  ipcMain.handle("fl-studio-folders:get", getCustomFlStudioFolders);
  ipcMain.handle("fl-studio-folders:add", addCustomFlStudioFolder);
  ipcMain.handle("fl-studio-folders:remove", removeCustomFlStudioFolder);
  ipcMain.handle("user-data-folders:get", getUserDataFolders);
  ipcMain.handle("user-data-folders:add", addUserDataFolder);
  ipcMain.handle("user-data-folders:remove", removeUserDataFolder);
  ipcMain.handle("project-folders:get", getProjectFolders);
  ipcMain.handle("project-folders:add", addProjectFolder);
  ipcMain.handle("project-folders:remove", removeProjectFolder);
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
