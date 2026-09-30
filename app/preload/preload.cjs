// The only bridge between the windows and the app. The renderers have no Node access.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jarvis", {
  state: () => ipcRenderer.invoke("state"),
  setMode: (mode, minutes) => ipcRenderer.invoke("set-mode", mode, minutes),
  stop: () => ipcRenderer.invoke("stop"),
  connect: () => ipcRenderer.invoke("connect"),
  testVoice: () => ipcRenderer.invoke("test-voice"),
  open: (what) => ipcRenderer.invoke("open", what),
  menu: () => ipcRenderer.invoke("menu"),
  hide: () => ipcRenderer.invoke("hide"),
  showMain: (section) => ipcRenderer.invoke("show-main", section),
  // Main window: one checked entry point. Resolves to the value or rejects with a readable message.
  dash: async (name, args) => {
    const r = await ipcRenderer.invoke("dash", name, args);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  },
  onNavigate: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on("navigate", h);
    return () => ipcRenderer.off("navigate", h);
  },
  onState: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on("state", h);
    return () => ipcRenderer.off("state", h);
  },
});
