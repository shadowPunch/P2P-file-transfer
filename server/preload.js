const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // One-shot fetch — useful on startup to catch a URL that arrived before
  // the renderer registered its event listener.
  getPublicUrl: () => ipcRenderer.invoke("get-public-url"),

  // Push-based: main.js calls win.webContents.send("tunnel-url", url)
  // the instant the SSH tunnel establishes. Much faster than polling.
  onTunnelUrl: (callback) => ipcRenderer.on("tunnel-url", (_event, url) => callback(url)),

  copyToClipboard: (text) => ipcRenderer.send("copy-to-clipboard", text),
});
