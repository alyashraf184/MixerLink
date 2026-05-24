const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mixerlink", {
  scanCompatibility: () => ipcRenderer.invoke("compatibility:scan"),
  getLocalRelayUrls: () => ipcRenderer.invoke("relay-urls:get"),
  getCustomFlStudioFolders: () => ipcRenderer.invoke("fl-studio-folders:get"),
  addCustomFlStudioFolder: () => ipcRenderer.invoke("fl-studio-folders:add"),
  removeCustomFlStudioFolder: (folder) => ipcRenderer.invoke("fl-studio-folders:remove", folder),
  getUserDataFolders: () => ipcRenderer.invoke("user-data-folders:get"),
  addUserDataFolder: () => ipcRenderer.invoke("user-data-folders:add"),
  removeUserDataFolder: (folder) => ipcRenderer.invoke("user-data-folders:remove", folder),
  getProjectFolders: () => ipcRenderer.invoke("project-folders:get"),
  addProjectFolder: () => ipcRenderer.invoke("project-folders:add"),
  removeProjectFolder: (folder) => ipcRenderer.invoke("project-folders:remove", folder),
  getCustomPluginFolders: () => ipcRenderer.invoke("plugin-folders:get"),
  addCustomPluginFolder: () => ipcRenderer.invoke("plugin-folders:add"),
  removeCustomPluginFolder: (folder) => ipcRenderer.invoke("plugin-folders:remove", folder)
});

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.runtime = "electron";
});
