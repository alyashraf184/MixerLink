const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL, URL } = require("node:url");

const isDev = Boolean(process.env.MIXERLINK_DEV_SERVER_URL);
let sessionRelay;
let flBridgeServer;
let flBridgeMidiListener;
let flBridgeMidiListenerRestartTimeout;
let mainWindow;
let bridgeSequence = 0;
const bridgeEvents = [];
let flBridgeFilePollInterval;
let lastLocalBridgeOperationKey;
let pendingFlReportTempoLsb = 0;
let pendingFlReportTempoMsb = 0;
const flBridgeFolderName = "MixerLink";
const flBridgeScriptName = "device_MixerLink.py";
const legacyFlBridgeFolderName = "MixerLink Bridge";
const legacyFlBridgeScriptName = "device_MixerLink Bridge.py";
let flBridgeRuntime = {
  connected: false,
  lastSeenAt: undefined,
  playing: undefined,
  tempoBpm: undefined,
  script: undefined
};

const { startSessionRelay } = require("./session-relay.cjs");

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

function getBundledFlBridgeScriptPath() {
  return path.join(__dirname, "..", "fl-bridge", flBridgeFolderName, flBridgeScriptName);
}

function getMidiSenderPath() {
  return path.join(__dirname, "midi-send.exe");
}

function getMidiListenerPath() {
  return path.join(__dirname, "midi-listen.ps1");
}

function getAppIconPath() {
  return path.join(__dirname, "..", "build", "icon.ico");
}

function getFlBridgeInstallFolder() {
  return path.join(app.getPath("documents"), "Image-Line", "FL Studio", "Settings", "Hardware", flBridgeFolderName);
}

function getFlBridgeInstallPath() {
  return path.join(getFlBridgeInstallFolder(), flBridgeScriptName);
}

function getFlBridgeDataFolder() {
  return path.join(app.getPath("documents"), "Image-Line", "FL Studio", "Settings", "MixerLink");
}

function getFlBridgeCommandsPath() {
  return path.join(getFlBridgeDataFolder(), "commands.json");
}

function getFlBridgeRuntimePath() {
  return path.join(getFlBridgeDataFolder(), "runtime.json");
}

function getFlBridgeLocalOperationPath() {
  return path.join(getFlBridgeDataFolder(), "last-local-operation.json");
}

function getLegacyFlBridgeInstallPath() {
  return path.join(
    app.getPath("documents"),
    "Image-Line",
    "FL Studio",
    "Settings",
    "Hardware",
    legacyFlBridgeFolderName,
    legacyFlBridgeScriptName
  );
}

async function getFlBridgeStatus() {
  const installPath = getFlBridgeInstallPath();
  const legacyInstallPath = getLegacyFlBridgeInstallPath();
  const installed = await pathExists(installPath);
  const scriptOutdated = installed ? !(await filesMatch(getBundledFlBridgeScriptPath(), installPath)) : false;

  return {
    installed,
    scriptOutdated,
    installPath,
    legacyInstalled: await pathExists(legacyInstallPath),
    legacyInstallPath,
    commandPath: getFlBridgeCommandsPath(),
    runtimePath: getFlBridgeRuntimePath(),
    bridgeUrl: "http://127.0.0.1:4318",
    runtime: await refreshFlBridgeRuntimeFromFile()
  };
}

async function installFlBridgeScript() {
  const sourcePath = getBundledFlBridgeScriptPath();
  const installFolder = getFlBridgeInstallFolder();
  const installPath = getFlBridgeInstallPath();
  const legacyInstallFolder = path.dirname(getLegacyFlBridgeInstallPath());
  const legacyInstallPath = getLegacyFlBridgeInstallPath();

  if (!(await pathExists(sourcePath))) {
    throw new Error("Bundled MixerLink FL Studio bridge script was not found.");
  }

  await fs.mkdir(installFolder, { recursive: true });
  await fs.copyFile(sourcePath, installPath);
  await fs.rm(legacyInstallPath, { force: true }).catch(() => undefined);
  await fs.rmdir(legacyInstallFolder).catch(() => undefined);

  return {
    installed: true,
    scriptOutdated: false,
    installPath,
    legacyInstalled: false,
    legacyInstallPath,
    commandPath: getFlBridgeCommandsPath(),
    runtimePath: getFlBridgeRuntimePath(),
    bridgeUrl: "http://127.0.0.1:4318",
    runtime: await refreshFlBridgeRuntimeFromFile()
  };
}

function getFlBridgeRuntime() {
  const lastSeenTime = flBridgeRuntime.lastSeenAt ? Date.parse(flBridgeRuntime.lastSeenAt) : 0;
  const connected = Boolean(lastSeenTime && Date.now() - lastSeenTime < 5000);

  return {
    ...flBridgeRuntime,
    connected
  };
}

async function refreshFlBridgeRuntimeFromFile() {
  try {
    const raw = await fs.readFile(getFlBridgeRuntimePath(), "utf-8");
    const payload = JSON.parse(raw);

    if (payload && typeof payload === "object") {
      updateFlBridgeRuntime({
        script: payload.script,
        playing: payload.playing,
        tempoBpm: payload.tempoBpm,
        lastSeenAt: payload.lastSeenAt
      });
    }
  } catch {
    // The runtime file only exists after FL Studio has loaded the bridge script.
  }

  return getFlBridgeRuntime();
}

async function refreshFlBridgeLocalOperationFromFile() {
  try {
    const raw = await fs.readFile(getFlBridgeLocalOperationPath(), "utf-8");
    const payload = JSON.parse(raw);
    const operation = payload?.operation;
    const createdAt = String(payload?.createdAt ?? "");
    const operationKey = `${createdAt}:${JSON.stringify(operation)}`;

    if (operationKey && operationKey !== lastLocalBridgeOperationKey && isBridgeOperation(operation)) {
      lastLocalBridgeOperationKey = operationKey;
      mainWindow?.webContents.send("bridge:operation-from-fl", operation);
    }
  } catch {
    // The local-operation file is created only after FL Studio changes transport or tempo locally.
  }
}

function updateFlBridgeRuntime(payload) {
  const lastSeenAt =
    typeof payload.lastSeenAt === "string" && !Number.isNaN(Date.parse(payload.lastSeenAt))
      ? payload.lastSeenAt
      : new Date().toISOString();

  flBridgeRuntime = {
    connected: true,
    lastSeenAt,
    playing: typeof payload.playing === "boolean" ? payload.playing : flBridgeRuntime.playing,
    tempoBpm: Number.isFinite(Number(payload.tempoBpm)) ? Math.round(Number(payload.tempoBpm) * 10) / 10 : flBridgeRuntime.tempoBpm,
    script: typeof payload.script === "string" ? payload.script : flBridgeRuntime.script
  };

  mainWindow?.webContents.send("fl-bridge:runtime", getFlBridgeRuntime());
  return getFlBridgeRuntime();
}

function updateFlBridgeRuntimeFromOperation(operation) {
  if (operation.type === "transport.play") {
    return updateFlBridgeRuntime({
      playing: true
    });
  }

  if (operation.type === "transport.stop") {
    return updateFlBridgeRuntime({
      playing: false
    });
  }

  if (operation.type === "tempo.changed") {
    return updateFlBridgeRuntime({
      tempoBpm: operation.payload.bpm
    });
  }

  return getFlBridgeRuntime();
}

function receiveBridgeOperationFromFl(operation) {
  if (!isBridgeOperation(operation)) {
    return;
  }

  mainWindow?.webContents.send("bridge:operation-from-fl", operation);
  updateFlBridgeRuntimeFromOperation(operation);
}

async function writeJsonFile(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2));
  await fs.rename(tempPath, filePath);
}

async function filesMatch(firstPath, secondPath) {
  try {
    const [first, second] = await Promise.all([fs.readFile(firstPath), fs.readFile(secondPath)]);
    return crypto.createHash("sha256").update(first).digest("hex") === crypto.createHash("sha256").update(second).digest("hex");
  } catch {
    return false;
  }
}

function getMidiMessagesForOperation(operation) {
  const controlChange = 0xb0;

  if (operation.type === "transport.play") {
    return [controlChange | (20 << 8) | (1 << 16)];
  }

  if (operation.type === "transport.stop") {
    return [controlChange | (20 << 8) | (2 << 16)];
  }

  if (operation.type === "tempo.changed") {
    const tempoBpm = Math.max(20, Math.min(300, Number(operation.payload.bpm)));
    const tempoTenths = Math.round(tempoBpm * 10);
    const lsb = tempoTenths & 0x7f;
    const msb = (tempoTenths >> 7) & 0x7f;
    return [
      controlChange | (21 << 8) | (lsb << 16),
      controlChange | (22 << 8) | (msb << 16),
      controlChange | (20 << 8) | (3 << 16)
    ];
  }

  return [controlChange | (20 << 8) | (0 << 16)];
}

function sendMidiOperation(operation) {
  if (process.platform !== "win32") {
    return;
  }

  const messages = getMidiMessagesForOperation(operation).map((message) => `0x${message.toString(16).padStart(8, "0")}`);
  const child = spawn(getMidiSenderPath(), ["MixerLink", ...messages], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function startFlBridgeMidiListener() {
  if (process.platform !== "win32") {
    return;
  }

  if (flBridgeMidiListener && !flBridgeMidiListener.killed) {
    return;
  }

  const listenerPath = getMidiListenerPath();
  flBridgeMidiListener = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", listenerPath, "MixerLink"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  );

  flBridgeMidiListener.stdout.setEncoding("utf-8");
  flBridgeMidiListener.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const trimmed = line.trim();

      if (trimmed) {
        handleFlBridgeMidiMessageLine(trimmed);
      }
    }
  });

  flBridgeMidiListener.stderr.setEncoding("utf-8");
  flBridgeMidiListener.stderr.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (message) {
      console.log(`MixerLink MIDI listener: ${message}`);
    }
  });

  flBridgeMidiListener.on("exit", () => {
    flBridgeMidiListener = undefined;
    flBridgeMidiListenerRestartTimeout = setTimeout(startFlBridgeMidiListener, 5000);
  });
}

function handleFlBridgeMidiMessageLine(line) {
  let message;

  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  handleFlBridgeMidiMessage(message);
}

function handleFlBridgeMidiMessage(message) {
  const status = Number(message.status) & 0xf0;
  const data1 = Number(message.data1);
  const data2 = Number(message.data2) & 0x7f;

  if (status !== 0xb0) {
    return;
  }

  if (data1 === 31) {
    pendingFlReportTempoLsb = data2;
    return;
  }

  if (data1 === 32) {
    pendingFlReportTempoMsb = data2;
    return;
  }

  if (data1 !== 30) {
    return;
  }

  if (data2 === 1) {
    receiveBridgeOperationFromFl({ type: "transport.play" });
    return;
  }

  if (data2 === 2) {
    receiveBridgeOperationFromFl({ type: "transport.stop" });
    return;
  }

  if (data2 === 3) {
    const bpm = Math.round(((pendingFlReportTempoLsb + pendingFlReportTempoMsb * 128) / 10) * 10) / 10;

    if (bpm >= 20 && bpm <= 300) {
      receiveBridgeOperationFromFl({
        type: "tempo.changed",
        payload: { bpm }
      });
    }
  }
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

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "http://localhost",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  response.end(JSON.stringify(payload));
}

function isBridgeOperation(operation) {
  if (!operation || typeof operation !== "object" || typeof operation.type !== "string") {
    return false;
  }

  if (operation.type === "transport.play" || operation.type === "transport.stop") {
    return true;
  }

  return operation.type === "tempo.changed" && Number.isFinite(Number(operation.payload?.bpm));
}

async function enqueueBridgeOperation(operation, source = "session") {
  if (!isBridgeOperation(operation)) {
    throw new Error("Bridge operation was not valid.");
  }

  bridgeSequence += 1;
  bridgeEvents.push({
    id: bridgeSequence,
    source,
    operation,
    createdAt: new Date().toISOString()
  });

  while (bridgeEvents.length > 200) {
    bridgeEvents.shift();
  }

  await writeJsonFile(getFlBridgeCommandsPath(), {
    app: "MixerLink",
    latestSequence: bridgeSequence,
    events: bridgeEvents
  });

  sendMidiOperation(operation);

  return { ok: true, id: bridgeSequence };
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    let rawBody = "";

    request.on("data", (chunk) => {
      rawBody += chunk.toString("utf-8");

      if (rawBody.length > 64 * 1024) {
        request.destroy();
        reject(new Error("Request body is too large."));
      }
    });

    request.on("end", () => {
      try {
        resolve(rawBody ? JSON.parse(rawBody) : {});
      } catch {
        reject(new Error("Request body was not valid JSON."));
      }
    });

    request.on("error", reject);
  });
}

function startFlBridge(port) {
  const server = http.createServer(async (request, response) => {
    if (!request.url) {
      writeJson(response, 404, { error: "Not found" });
      return;
    }

    if (request.method === "OPTIONS") {
      writeJson(response, 204, {});
      return;
    }

    const url = new URL(request.url, `http://127.0.0.1:${port}`);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          app: "MixerLink",
          bridge: "fl-studio-local",
          latestSequence: bridgeSequence,
          queuedEvents: bridgeEvents.length,
          flStudio: getFlBridgeRuntime()
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/status") {
        writeJson(response, 200, {
          app: "MixerLink",
          bridge: "fl-studio-local",
          latestSequence: bridgeSequence,
          queuedEvents: bridgeEvents.length,
          flStudio: getFlBridgeRuntime()
        });
        return;
      }

      if (request.method === "POST" && (url.pathname === "/fl/hello" || url.pathname === "/fl/state")) {
        const body = await readRequestJson(request);
        writeJson(response, 200, {
          ok: true,
          runtime: updateFlBridgeRuntime(body)
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/events") {
        const after = Number(url.searchParams.get("after") ?? 0);
        writeJson(response, 200, {
          latestSequence: bridgeSequence,
          events: bridgeEvents.filter((event) => event.id > after)
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/operation") {
        const body = await readRequestJson(request);
        const operation = body.operation ?? body;

        if (!isBridgeOperation(operation)) {
          writeJson(response, 400, { error: "Bridge operation was not valid." });
          return;
        }

        receiveBridgeOperationFromFl(operation);
        writeJson(response, 200, { ok: true });
        return;
      }

      writeJson(response, 404, { error: "Not found" });
    } catch (error) {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : "Unknown bridge error"
      });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`MixerLink FL bridge listening on http://127.0.0.1:${port}`);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.log(`MixerLink FL bridge port ${port} is already in use.`);
      return;
    }

    console.error(error);
  });

  return server;
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
    icon: getAppIconPath(),
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
  ipcMain.handle("bridge:queue-operation", (_event, operation) => enqueueBridgeOperation(operation));
  ipcMain.handle("fl-bridge:status", getFlBridgeStatus);
  ipcMain.handle("fl-bridge:install", installFlBridgeScript);
  ipcMain.handle("fl-bridge:runtime", refreshFlBridgeRuntimeFromFile);
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
  flBridgeServer = startFlBridge(4318);
  startFlBridgeMidiListener();
  flBridgeFilePollInterval = setInterval(() => {
    refreshFlBridgeRuntimeFromFile().catch(() => undefined);
    refreshFlBridgeLocalOperationFromFile().catch(() => undefined);
  }, 1000);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  sessionRelay?.close();
  flBridgeServer?.close();
  if (flBridgeMidiListenerRestartTimeout) {
    clearTimeout(flBridgeMidiListenerRestartTimeout);
  }
  if (flBridgeMidiListener) {
    flBridgeMidiListener.kill();
  }
  if (flBridgeFilePollInterval) {
    clearInterval(flBridgeFilePollInterval);
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});
