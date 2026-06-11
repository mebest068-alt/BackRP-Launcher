const { contextBridge, ipcRenderer } = require("electron");

// preload.js — единственная точка связи интерфейса с Electron API.
// Так renderer остаётся обычной веб-страницей без прямого доступа к Node.js.
contextBridge.exposeInMainWorld("backrp", {
  // Информация о лаунчере и сервере.
  getVersion: () => ipcRenderer.invoke("app:get-version"),
  getNickname: () => ipcRenderer.invoke("profile:get-nickname"),
  saveNickname: (nickname) => ipcRenderer.invoke("profile:save-nickname", nickname),
  getServerInfo: () => ipcRenderer.invoke("server:get-info"),

  // Проверка и запуск GTA San Andreas / SA:MP.
  locateGame: () => ipcRenderer.invoke("game:locate"),
  launchGame: () => ipcRenderer.invoke("game:launch"),
  selectGameDirectory: () => ipcRenderer.invoke("game:select-directory"),

  // Автообновления через GitHub Releases.
  checkUpdates: () => ipcRenderer.invoke("updates:check"),

  // Управление кастомным окном без стандартной рамки Windows.
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximize: () => ipcRenderer.invoke("window:maximize"),
  close: () => ipcRenderer.invoke("window:close"),

  // Внешние ссылки проходят через main process с проверкой протокола.
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),

  // События автообновления приходят асинхронно, поэтому используем подписки.
  onUpdateMessage: (callback) => ipcRenderer.on("update-message", (_event, payload) => callback(payload)),
  onUpdateProgress: (callback) => ipcRenderer.on("update-progress", (_event, payload) => callback(payload))
});
