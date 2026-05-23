const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mixerlink", {
  scanCompatibility: () => ipcRenderer.invoke("compatibility:scan"),
  getCustomPluginFolders: () => ipcRenderer.invoke("plugin-folders:get"),
  addCustomPluginFolder: () => ipcRenderer.invoke("plugin-folders:add"),
  removeCustomPluginFolder: (folder) => ipcRenderer.invoke("plugin-folders:remove", folder)
});

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.runtime = "electron";
});
