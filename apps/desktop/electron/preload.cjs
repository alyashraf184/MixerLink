const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mixerlink", {
  scanCompatibility: () => ipcRenderer.invoke("compatibility:scan")
});

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.runtime = "electron";
});
