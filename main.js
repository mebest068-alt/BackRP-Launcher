const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const childProcess = require("child_process");
const dgram = require("dgram");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SERVER_IP = "188.127.241.8";
const SERVER_PORT = 1464;
const SERVER_ADDRESS = `${SERVER_IP}:${SERVER_PORT}`;
const DEFAULT_NICKNAME = "BackRP_Player";
const NICKNAME_PATTERN = /^[A-Za-z0-9_\[\]\(\)$@.=]{3,20}$/;

let mainWindow;

// Конфиг хранится в userData, чтобы настройки не терялись после обновления лаунчера.
function getConfigPath() {
  return path.join(app.getPath("userData"), "config.json");
}

// Читаем сохранённую папку GTA. Если файла ещё нет, возвращаем стартовые значения.
function readConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    return {
      gtaDirectory: "",
      nickname: DEFAULT_NICKNAME,
      firstLaunch: true,
      ...config
    };
  } catch {
    return {
      gtaDirectory: "",
      nickname: DEFAULT_NICKNAME,
      firstLaunch: true
    };
  }
}

// Записываем настройки синхронно: объём данных маленький, а результат нужен сразу.
function writeConfig(config) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf8");
}

function normalizeNickname(nickname) {
  return String(nickname || "").trim();
}

function validateNickname(nickname) {
  const normalized = normalizeNickname(nickname);

  if (!NICKNAME_PATTERN.test(normalized)) {
    return {
      ok: false,
      nickname: normalized,
      reason: "Ник должен быть 3-20 символов: латиница, цифры и _ [ ] ( ) $ @ . ="
    };
  }

  return {
    ok: true,
    nickname: normalized
  };
}

function getNicknameState() {
  const config = readConfig();
  const validation = validateNickname(config.nickname);

  return {
    nickname: validation.ok ? validation.nickname : DEFAULT_NICKNAME,
    valid: validation.ok,
    reason: validation.reason || ""
  };
}

function saveNickname(nickname) {
  const validation = validateNickname(nickname);

  if (!validation.ok) {
    return validation;
  }

  const config = readConfig();
  writeConfig({
    ...config,
    nickname: validation.nickname
  });

  return validation;
}

function writeSampNickname(nickname) {
  const validation = validateNickname(nickname);

  if (!validation.ok) {
    return validation;
  }

  const result = childProcess.spawnSync("reg", [
    "add",
    "HKCU\\Software\\SAMP",
    "/v",
    "PlayerName",
    "/t",
    "REG_SZ",
    "/d",
    validation.nickname,
    "/f"
  ], {
    windowsHide: true,
    encoding: "utf8"
  });

  if (result.error || result.status !== 0) {
    return {
      ok: false,
      nickname: validation.nickname,
      reason: "Не удалось сохранить ник в настройках SA:MP."
    };
  }

  return validation;
}

// Безопасная отправка событий в renderer: окно может быть уже закрыто при обновлении.
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// Главное окно без стандартной рамки Windows. Кнопки управления реализованы в HTML.
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: "#090b10",
    title: "BackRP Launcher",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile("index.html");

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    checkForUpdates();
  });
}

// SA:MP query-пакет: сигнатура SAMP, IP, порт в little-endian и opcode "i".
function buildSampQueryPacket() {
  const ipBytes = SERVER_IP.split(".").map((part) => Number(part));
  const packet = Buffer.alloc(11);

  packet.write("SAMP", 0, "ascii");
  packet[4] = ipBytes[0];
  packet[5] = ipBytes[1];
  packet[6] = ipBytes[2];
  packet[7] = ipBytes[3];
  packet.writeUInt16LE(SERVER_PORT, 8);
  packet.write("i", 10, "ascii");

  return packet;
}

// Ответ SA:MP содержит онлайн, максимум игроков, название сервера, режим и язык.
function parseSampInfoResponse(buffer) {
  if (buffer.length < 20 || buffer.toString("ascii", 0, 4) !== "SAMP") {
    throw new Error("Некорректный ответ SA:MP сервера.");
  }

  let offset = 11;
  const passworded = Boolean(buffer.readUInt8(offset));
  offset += 1;

  const players = buffer.readUInt16LE(offset);
  offset += 2;

  const maxPlayers = buffer.readUInt16LE(offset);
  offset += 2;

  const hostnameLength = buffer.readUInt32LE(offset);
  offset += 4;
  const hostname = buffer.toString("utf8", offset, offset + hostnameLength);
  offset += hostnameLength;

  const gamemodeLength = buffer.readUInt32LE(offset);
  offset += 4;
  const gamemode = buffer.toString("utf8", offset, offset + gamemodeLength);
  offset += gamemodeLength;

  const languageLength = buffer.readUInt32LE(offset);
  offset += 4;
  const language = buffer.toString("utf8", offset, offset + languageLength);

  return {
    address: SERVER_ADDRESS,
    online: players,
    maxPlayers,
    hostname,
    gamemode,
    language,
    passworded,
    reachable: true
  };
}

// UDP-запрос не должен подвешивать интерфейс, поэтому всегда завершается по таймауту.
function queryServerOnline(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const packet = buildSampQueryPacket();
    let completed = false;

    const finish = (payload) => {
      if (completed) {
        return;
      }

      completed = true;
      socket.close();
      resolve(payload);
    };

    const timeout = setTimeout(() => {
      finish({
        address: SERVER_ADDRESS,
        online: null,
        maxPlayers: null,
        hostname: "BackRP",
        gamemode: "RolePlay",
        language: "Russian",
        passworded: false,
        reachable: false
      });
    }, timeoutMs);

    socket.once("message", (message) => {
      clearTimeout(timeout);
      try {
        finish(parseSampInfoResponse(message));
      } catch (error) {
        finish({
          address: SERVER_ADDRESS,
          online: null,
          maxPlayers: null,
          hostname: "BackRP",
          gamemode: "RolePlay",
          language: "Russian",
          passworded: false,
          reachable: false,
          error: error.message
        });
      }
    });

    socket.once("error", () => {
      clearTimeout(timeout);
      finish({
        address: SERVER_ADDRESS,
        online: null,
        maxPlayers: null,
        hostname: "BackRP",
        gamemode: "RolePlay",
        language: "Russian",
        passworded: false,
        reachable: false
      });
    });

    socket.send(packet, SERVER_PORT, SERVER_IP);
  });
}

// Популярные пути установки GTA. Пользователь всё равно может выбрать папку вручную.
function getCandidateGameDirectories() {
  const home = os.homedir();

  return [
    "C:\\Games\\GTA San Andreas",
    "C:\\Games\\GTA San Andreas Multiplayer",
    "C:\\Program Files\\Rockstar Games\\GTA San Andreas",
    "C:\\Program Files (x86)\\Rockstar Games\\GTA San Andreas",
    "C:\\Program Files\\GTA San Andreas",
    "C:\\Program Files (x86)\\GTA San Andreas",
    path.join(home, "Desktop", "GTA San Andreas"),
    path.join(home, "Downloads", "GTA San Andreas")
  ];
}

// Проверяем именно файлы, нужные для SA:MP: оригинальную GTA и клиент мультиплеера.
function inspectGameDirectory(gtaDirectory) {
  if (!gtaDirectory) {
    return {
      gtaDirectory: "",
      gtaExists: false,
      sampExists: false,
      gtaPath: "",
      sampPath: "",
      ready: false
    };
  }

  const gtaPath = path.join(gtaDirectory, "gta_sa.exe");
  const sampPath = path.join(gtaDirectory, "samp.exe");
  const gtaExists = fs.existsSync(gtaPath);
  const sampExists = fs.existsSync(sampPath);

  return {
    gtaDirectory,
    gtaExists,
    sampExists,
    gtaPath,
    sampPath,
    ready: gtaExists && sampExists
  };
}

// Сначала доверяем сохранённому пути, затем пробуем стандартные директории.
function locateGameDirectory() {
  const config = readConfig();
  const configured = inspectGameDirectory(config.gtaDirectory);

  if (configured.ready) {
    return configured;
  }

  for (const candidate of getCandidateGameDirectories()) {
    const inspected = inspectGameDirectory(candidate);
    if (inspected.ready) {
      writeConfig({
        ...config,
        gtaDirectory: candidate,
        firstLaunch: false
      });
      return inspected;
    }
  }

  return configured;
}

// SA:MP принимает адрес сервера аргументом командной строки и подключается сразу.
function launchGame() {
  const game = locateGameDirectory();
  const config = readConfig();
  const nicknameResult = writeSampNickname(config.nickname);

  if (!nicknameResult.ok) {
    return {
      ok: false,
      reason: nicknameResult.reason
    };
  }

  if (!game.ready) {
    return {
      ok: false,
      reason: "Не найдены gta_sa.exe и samp.exe. Укажите папку с GTA San Andreas."
    };
  }

  try {
    childProcess.spawn(game.sampPath, [SERVER_ADDRESS], {
      cwd: game.gtaDirectory,
      detached: true,
      stdio: "ignore"
    }).unref();

    return {
      ok: true,
      message: `SA:MP запущен с подключением к ${SERVER_ADDRESS}.`
    };
  } catch (error) {
    return {
      ok: false,
      reason: `Не удалось запустить samp.exe: ${error.message}`
    };
  }
}

// В dev-режиме electron-updater не устанавливает релизы, поэтому показываем честный статус.
function checkForUpdates() {
  if (!app.isPackaged) {
    sendToRenderer("update-message", {
      type: "info",
      message: "Автообновление доступно после сборки лаунчера."
    });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.checkForUpdates().catch((error) => {
    sendToRenderer("update-message", {
      type: "error",
      message: `Ошибка проверки обновлений: ${error.message}`
    });
  });
}

autoUpdater.on("checking-for-update", () => {
  sendToRenderer("update-message", {
    type: "info",
    message: "Проверяем обновления..."
  });
});

autoUpdater.on("update-available", (info) => {
  sendToRenderer("update-message", {
    type: "success",
    message: `Найдена версия ${info.version}. Начинаем загрузку.`
  });
});

autoUpdater.on("update-not-available", () => {
  sendToRenderer("update-message", {
    type: "success",
    message: "Установлена последняя версия лаунчера."
  });
});

autoUpdater.on("download-progress", (progress) => {
  sendToRenderer("update-progress", {
    percent: Math.round(progress.percent),
    transferred: progress.transferred,
    total: progress.total
  });
});

autoUpdater.on("update-downloaded", () => {
  sendToRenderer("update-message", {
    type: "success",
    message: "Обновление загружено. Лаунчер перезапустится."
  });

  setTimeout(() => autoUpdater.quitAndInstall(false, true), 1500);
});

autoUpdater.on("error", (error) => {
  sendToRenderer("update-message", {
    type: "error",
    message: `Ошибка автообновления: ${error.message}`
  });
});

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// IPC-методы доступны только через preload.js. Renderer не получает прямой доступ к Node.js.
ipcMain.handle("app:get-version", () => app.getVersion());
ipcMain.handle("profile:get-nickname", () => getNicknameState());
ipcMain.handle("profile:save-nickname", (_event, nickname) => saveNickname(nickname));
ipcMain.handle("server:get-info", () => queryServerOnline());
ipcMain.handle("game:locate", () => locateGameDirectory());
ipcMain.handle("game:launch", () => launchGame());
ipcMain.handle("updates:check", () => {
  checkForUpdates();
  return { ok: true };
});

ipcMain.handle("game:select-directory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Выберите папку GTA San Andreas",
    properties: ["openDirectory"]
  });

  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true, game: locateGameDirectory() };
  }

  const config = readConfig();
  const gtaDirectory = result.filePaths[0];

  writeConfig({
    ...config,
    gtaDirectory,
    firstLaunch: false
  });

  return {
    canceled: false,
    game: inspectGameDirectory(gtaDirectory)
  };
});

// Кнопки кастомной шапки окна.
ipcMain.handle("window:minimize", () => {
  mainWindow.minimize();
});

ipcMain.handle("window:maximize", () => {
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    return { maximized: false };
  }

  mainWindow.maximize();
  return { maximized: true };
});

ipcMain.handle("window:close", () => {
  mainWindow.close();
});

// Открываем только http/https ссылки, чтобы renderer не мог вызвать произвольный протокол.
ipcMain.handle("app:open-external", (_event, url) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) {
    shell.openExternal(url);
  }
});
