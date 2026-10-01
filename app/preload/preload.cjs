// The only bridge between the windows and the app. The renderers have no Node access.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("earpiece", {
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
  // "done" marks a session done (answers a pending "needs you"); "forget" removes it from the list.
  session: async (action, agent, session) => {
    const r = await ipcRenderer.invoke("session", action, agent, session);
    if (!r.ok) throw new Error(r.error);
  },
  // Floating card window only.
  card: (action, value) => ipcRenderer.invoke("card", action, value),
  answer: (id, answer) => ipcRenderer.invoke("ask-answer", id, answer),
  previewCard:() => ipcRenderer.invoke("card-preview"),
  onCard: (cb) => {
    const h = (_e, c) => cb(c);
    ipcRenderer.on("card", h);
    return () => ipcRenderer.off("card", h);
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
