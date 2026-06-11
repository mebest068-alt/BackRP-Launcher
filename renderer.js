const SERVER_ADDRESS = "188.127.241.8:1464";
const NICKNAME_PATTERN = /^[A-Za-z0-9_\[\]\(\)$@.=]{3,20}$/;

// Все DOM-узлы собираются один раз при старте, чтобы дальше не искать их повторно.
const elements = {
  appVersion: document.querySelector("#app-version"),
  onlineValue: document.querySelector("#online-value"),
  maxPlayers: document.querySelector("#max-players"),
  serverStatus: document.querySelector("#server-status"),
  serverHostname: document.querySelector("#server-hostname"),
  gamemode: document.querySelector("#gamemode"),
  language: document.querySelector("#language"),
  updateText: document.querySelector("#update-text"),
  updateProgress: document.querySelector("#update-progress"),
  updateProgressText: document.querySelector("#update-progress-text"),
  playButton: document.querySelector("#play-button"),
  checkUpdatesButton: document.querySelector("#check-updates"),
  selectGameButton: document.querySelector("#select-game"),
  nicknameInput: document.querySelector("#nickname-input"),
  nicknameHint: document.querySelector("#nickname-hint"),
  gamePath: document.querySelector("#game-path"),
  gtaState: document.querySelector("#gta-state"),
  sampState: document.querySelector("#samp-state"),
  toastStack: document.querySelector("#toast-stack"),
  splash: document.querySelector("#splash")
};

const state = {
  gameReady: false,
  nicknameValid: false
};

// Универсальные всплывающие уведомления лаунчера.
function notify(title, message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <strong>${title}</strong>
    <span>${message}</span>
  `;

  elements.toastStack.appendChild(toast);

  setTimeout(() => toast.classList.add("toast-visible"), 50);
  setTimeout(() => {
    toast.classList.remove("toast-visible");
    setTimeout(() => toast.remove(), 250);
  }, 5200);
}

function updatePlayButtonState() {
  elements.playButton.disabled = !state.gameReady || !state.nicknameValid;
}

function validateNicknameInput(showMessage = false) {
  const nickname = elements.nicknameInput.value.trim();
  const valid = NICKNAME_PATTERN.test(nickname);

  state.nicknameValid = valid;
  elements.nicknameInput.classList.toggle("input-error", !valid);
  elements.nicknameHint.textContent = valid
    ? "Ник сохранится и будет установлен в SA:MP перед запуском."
    : "3-20 символов: латиница, цифры и _ [ ] ( ) $ @ . =";

  if (!valid && showMessage) {
    notify("Проверьте ник", elements.nicknameHint.textContent, "error");
  }

  updatePlayButtonState();
  return valid;
}

async function loadNickname() {
  const profile = await window.backrp.getNickname();
  elements.nicknameInput.value = profile.nickname || "BackRP_Player";
  validateNicknameInput(false);
}

async function saveNickname(showSuccess = false) {
  if (!validateNicknameInput(true)) {
    return false;
  }

  const result = await window.backrp.saveNickname(elements.nicknameInput.value);

  if (!result.ok) {
    notify("Ник не сохранён", result.reason, "error");
    return false;
  }

  elements.nicknameInput.value = result.nickname;

  if (showSuccess) {
    notify("Ник сохранён", `Выбран ник ${result.nickname}.`, "success");
  }

  return true;
}

// Приводим ответ сервера к безопасному виду для UI, включая недоступный сервер.
function formatOnline(serverInfo) {
  if (!serverInfo.reachable || serverInfo.online === null) {
    return {
      online: "--",
      maxPlayers: "--",
      status: "Нет ответа"
    };
  }

  return {
    online: String(serverInfo.online),
    maxPlayers: String(serverInfo.maxPlayers),
    status: "Онлайн"
  };
}

// Обновляем блок сервера: онлайн, максимум игроков, режим и язык.
function renderServerInfo(serverInfo) {
  const formatted = formatOnline(serverInfo);

  elements.onlineValue.textContent = formatted.online;
  elements.maxPlayers.textContent = formatted.maxPlayers;
  elements.serverStatus.textContent = formatted.status;
  elements.serverStatus.classList.toggle("status-offline", !serverInfo.reachable);
  elements.serverHostname.textContent = serverInfo.hostname || "BackRP";
  elements.gamemode.textContent = serverInfo.gamemode || "RolePlay";
  elements.language.textContent = serverInfo.language || "Russian";
}

// Онлайн обновляется по UDP-запросу через main process, чтобы не раскрывать Node.js в UI.
async function refreshServerInfo(silent = false) {
  try {
    const serverInfo = await window.backrp.getServerInfo();
    renderServerInfo(serverInfo);

    if (!silent && serverInfo.reachable) {
      notify("Сервер доступен", `Игроков онлайн: ${serverInfo.online}/${serverInfo.maxPlayers}`, "success");
    }
  } catch {
    renderServerInfo({ reachable: false, online: null, maxPlayers: null });
    if (!silent) {
      notify("Сервер не отвечает", "Не удалось получить текущий онлайн.", "error");
    }
  }
}

// Состояние кнопки "Играть" зависит от наличия gta_sa.exe и samp.exe.
function renderGameState(game) {
  const pathText = game.gtaDirectory || "Папка GTA San Andreas не выбрана";

  elements.gamePath.textContent = pathText;
  elements.gtaState.textContent = game.gtaExists ? "GTA найдена" : "GTA не найдена";
  elements.sampState.textContent = game.sampExists ? "SA:MP найден" : "SA:MP не найден";
  elements.gtaState.classList.toggle("check-ok", game.gtaExists);
  elements.sampState.classList.toggle("check-ok", game.sampExists);
  state.gameReady = game.ready;
  updatePlayButtonState();
}

// При старте лаунчер пробует найти игру автоматически.
async function refreshGameState() {
  const game = await window.backrp.locateGame();
  renderGameState(game);

  if (!game.ready) {
    notify("Нужна папка игры", "Выберите директорию с gta_sa.exe и samp.exe.", "info");
  }
}

// Запуск выполняется в main process, renderer только показывает результат пользователю.
async function launchGame() {
  const nicknameSaved = await saveNickname(false);

  if (!nicknameSaved) {
    return;
  }

  elements.playButton.disabled = true;
  elements.playButton.classList.add("button-loading");

  try {
    const result = await window.backrp.launchGame();

    if (result.ok) {
      notify("Запуск игры", result.message, "success");
    } else {
      notify("Запуск невозможен", result.reason, "error");
      await refreshGameState();
    }
  } finally {
    elements.playButton.classList.remove("button-loading");
    const game = await window.backrp.locateGame();
    state.gameReady = game.ready;
    updatePlayButtonState();
  }
}

// Пользователь может явно указать папку, если автопоиск не нашёл установку.
async function selectGameDirectory() {
  const result = await window.backrp.selectGameDirectory();
  renderGameState(result.game);

  if (!result.canceled && result.game.ready) {
    notify("Папка сохранена", "GTA San Andreas и SA:MP успешно найдены.", "success");
  } else if (!result.canceled) {
    notify("Файлы не найдены", "В выбранной папке должны быть gta_sa.exe и samp.exe.", "error");
  }
}

// Кастомные кнопки окна вызывают IPC-методы Electron.
function bindWindowControls() {
  document.querySelector("#window-minimize").addEventListener("click", () => window.backrp.minimize());
  document.querySelector("#window-maximize").addEventListener("click", () => window.backrp.maximize());
  document.querySelector("#window-close").addEventListener("click", () => window.backrp.close());
}

// Прогресс автообновления приходит событиями от electron-updater.
function bindUpdateEvents() {
  window.backrp.onUpdateMessage((payload) => {
    elements.updateText.textContent = payload.message;
    notify("Обновления", payload.message, payload.type);
  });

  window.backrp.onUpdateProgress((payload) => {
    elements.updateProgress.style.width = `${payload.percent}%`;
    elements.updateProgressText.textContent = `${payload.percent}%`;
  });
}

// Основные действия интерфейса: запуск, выбор папки, проверка обновлений и ссылки.
function bindActions() {
  elements.playButton.addEventListener("click", launchGame);
  elements.selectGameButton.addEventListener("click", selectGameDirectory);
  elements.nicknameInput.addEventListener("input", () => validateNicknameInput(false));
  elements.nicknameInput.addEventListener("change", () => saveNickname(true));
  elements.checkUpdatesButton.addEventListener("click", () => {
    elements.updateText.textContent = "Запущена проверка обновлений...";
    window.backrp.checkUpdates();
  });

  document.querySelectorAll("[data-url]").forEach((link) => {
    link.addEventListener("click", () => window.backrp.openExternal(link.dataset.url));
  });
}

// Единая точка загрузки интерфейса: биндим события, тянем данные и прячем splash.
async function boot() {
  bindWindowControls();
  bindUpdateEvents();
  bindActions();

  elements.appVersion.textContent = `v${await window.backrp.getVersion()}`;
  document.querySelector("#server-address").textContent = SERVER_ADDRESS;

  await Promise.all([
    loadNickname(),
    refreshServerInfo(true),
    refreshGameState()
  ]);

  setInterval(() => refreshServerInfo(true), 30000);

  setTimeout(() => {
    elements.splash.classList.add("splash-hidden");
  }, 900);
}

boot();
