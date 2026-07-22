const $ = (id) => document.getElementById(id)

const logEl = $('log')
const statusPill = $('statusPill')
const statusText = $('statusText')
const btnStart = $('btnStart')
const btnStop = $('btnStop')
const versionInput = $('version')
const versionBtn = $('versionBtn')
const versionBtnText = $('versionBtnText')
const versionMenu = $('versionMenu')
const versionPicker = $('versionPicker')
/** @type {{ value: string, base: string, stable?: boolean }[]} */
let versionEntries = []
/** Full lists from main — stable = protocol bases; extended = + hotfixes */
let stableVersionEntries = []
let extendedVersionEntries = []
const LS_VERSION_EXT = 'bsr-version-extended'
const LS_VERSION_WARN = 'bsr-version-extended-warn'
let versionExtended = false
let versionWarnResolve = null
const nowPlaying = $('nowPlaying')
const nowPlayingName = $('nowPlayingName')
const nowPlayingStatus = $('nowPlayingStatus')

let versionList = []
let hubRunning = false
let activeBase = null
let cfgVersion = null
let playPollTimer = null
let lastListedActive = null

/** UI prefs (launcher only — not Minecraft) */
const LS_THEME = 'bsr-theme'
const LS_LANG = 'bsr-lang'

const I18N = {
  ru: {
    tagReplay: 'Replay для серверов',
    statusOff: 'Остановлен',
    statusOn: 'REC · работает',
    liveLabel: 'LIVE · запись на сервере',
    playLabel: 'PLAY · просмотр',
    addrIp: 'IP:',
    addrPort: 'Порт:',
    copied: 'Скопировано',
    copyTitle: 'Нажмите, чтобы скопировать',
    phoneModeTitle: 'Откуда заходите',
    phoneModePc: 'ПК',
    phoneModePhone: 'Смартфон',
    phoneIpHint: 'ПК и телефон в одной Wi‑Fi',
    phoneIpOffline: 'Нет локальной сети (Wi‑Fi выключен?) — со смартфона сейчас не подключиться',
    btnPhoneAccess: 'Телефон',
    btnPhoneAccessTitle: 'Смартфон / LAN-хост',
    phoneModalTitle: 'Игра со смартфона',
    phoneModalApk: 'Скачайте Android-приложение Bedrock Server Replay и зайдите в Minecraft с телефона.',
    phoneModalOr: 'Или используйте этот ПК как хост — Minecraft на телефоне подключается к IP ниже (одна Wi‑Fi сеть):',
    phoneModalOk: 'Готово',
    btnStart: 'Запустить',
    btnStop: 'Стоп',
    btnReplaysFolder: 'Папка реплеев',
    btnConfigFile: 'Настройки (файл)',
    btnHelp: 'Помощь',
    panelServer: 'Сервер',
    labelHost: 'Хост',
    labelPort: 'Порт',
    labelVersion: 'Версия клиента',
    hintVersion: 'От 1.19.50 · ниже (с 1.16.201) — в расширенном списке',
    hintVersionAdjacent: 'На этой версии возможны ошибки',
    hintVersionNoPossess: 'На этой версии возможны ошибки. Вселение и режим спектатора не работают',
    optVersionExtended: 'Расширенный список',
    hintVersionExperimental: 'Экспериментально',
    versionWarnTitle: 'Экспериментально',
    versionWarnBody: 'Расширенный список может включать нестабильные версии клиента. Запись и просмотр на них могут работать хуже.',
    versionWarnOk: 'Понятно',
    btnSaveServer: 'Сохранить сервер',
    panelReplays: 'Реплеи',
    btnRefresh: 'Обновить',
    nowPlayingLabel: 'Сейчас играет',
    helpDataPath: 'Реплеи и настройки: %APPDATA%\\BedrockServerReplay (остаются после удаления программы)',
    panelOptions: 'Параметры',
    btnSaveOpts: 'Сохранить параметры',
    yes: 'Да',
    no: 'Нет',
    optHotbar: 'Горячие клавиши',
    optHotbarHint: 'Включает горячие клавиши для управления просмотром. Не работают при слежке за собой.',
    optHotbarTipAria: 'Подсказка по горячим клавишам',
    optHotbarTipLead: 'Нажимайте эти клавиши в режиме просмотра, чтобы управлять записью.',
    optHotbarTipAlt: 'Клавиши 1–8 на клавиатуре',
    optHotbarTipMap: '1 пауза · 2–4 скорость · 5/6 перемотка · 7 след. игрок · 8 рестарт',
    optAutoRecord: 'Автозапись',
    optAutoRecordHint: 'Начинает писать сразу при входе на LIVE, без команды .start',
    optSaveDisconnect: 'Сохранять при выходе',
    optSaveDisconnectHint: 'Если выйти из игры без .stop — запись всё равно сохранится',
    optNames: 'Имена игроков',
    optNamesHint: 'Показывать ники других игроков над головой при просмотре',
    optChat: 'Показывать чат при просмотре',
    optChatHint: 'Во время реплея показывает сохранённые сообщения',
    optSidebar: 'Показывать боковую панель',
    optSidebarHint: 'Таблица очков / список сбоку экрана из записи',
    optSounds: 'Звуки записи',
    optSoundsHint: 'Воспроизводит звуки мира из реплея',
    optPauseOnSeek: 'Пауза после перемотки / рестарта',
    optPauseOnSeekHint: 'После ±N / .seek / .restart ставить на паузу (по умолчанию нет)',
    panelLog: 'Лог',
    btnClearLog: 'Очистить',
    cmdTitle: 'Команды чата',
    cmdLiveTitle: 'LIVE · запись',
    cmdPlayTitle: 'PLAY · просмотр',
    cmdStart: 'Начать запись',
    cmdStop: 'Остановить и сохранить',
    cmdPlay: 'Открыть последний реплей (или .play имя)',
    cmdStatus: 'Статус записи',
    cmdReplays: 'Список файлов',
    cmdHelp: 'Краткая справка',
    cmdPause: 'Пауза / продолжить',
    cmdRestart: 'С начала (камера сохраняется)',
    cmdSeek: 'Перемотка на N секунд',
    cmdGoto: 'Перейти ко времени',
    cmdSpeed: 'Скорость (напр. .speed 2)',
    cmdMe: 'Следить за собой (запись)',
    cmdSpec: 'Следить за игроком (.spec имя)',
    cmdNext: 'Следующий игрок',
    cmdFree: 'Свободная камера',
    cmdLiveBack: 'Выйти из просмотра (потом зайди на LIVE)',
    cmdTime: 'Текущее время реплея',
    themeToDark: 'Тёмная тема',
    themeToLight: 'Светлая тема',
    langToEn: 'English',
    langToRu: 'Русский',
    saveError: 'Ошибка',
    savedRestart: 'Сохранено · перезапуск…',
    saved: 'Сохранено',
    labelServer: 'Сервер',
    labelOpts: 'Параметры',
    logSaveFail: 'Не удалось сохранить',
    logSaved: 'сохранены',
    logRestart: 'Перезапуск сервера…',
    logRestartFail: 'Перезапуск не удался',
    logRestartOk: 'Сервер запущен с новым конфигом',
    npReady: 'готов',
    versionMissing: 'нет в списке',
    replaysEmpty: 'Пока пусто — зайди на LIVE и сделай .start / .play',
    deleteTitle: 'Удалить реплей',
    deleteAria: 'Удалить',
    replayClickTitle: 'Запустить / выбрать эту запись',
    logReplay: 'Реплей',
    logFail: 'Не удалось',
    logDeleteFail: 'Не удалось удалить',
    logDeleted: 'Удалено',
    logStart: 'Start…',
    logVersions: 'Версий в списке',
    logFromVersion: '(с 1.16.201)'
  },
  en: {
    tagReplay: 'Server replay tool',
    statusOff: 'Stopped',
    statusOn: 'REC · running',
    liveLabel: 'LIVE · record on server',
    playLabel: 'PLAY · watch',
    addrIp: 'IP:',
    addrPort: 'Port:',
    copied: 'Copied',
    copyTitle: 'Click to copy',
    phoneModeTitle: 'Where you join from',
    phoneModePc: 'PC',
    phoneModePhone: 'Phone',
    phoneIpHint: 'PC and phone on the same Wi‑Fi',
    phoneIpOffline: 'No local network (Wi‑Fi off?) — phone cannot join right now',
    btnPhoneAccess: 'Phone',
    btnPhoneAccessTitle: 'Phone / LAN host',
    phoneModalTitle: 'Play from a phone',
    phoneModalApk: 'Download the Bedrock Server Replay Android app and join Minecraft from your phone.',
    phoneModalOr: 'Or use this PC as the host — Minecraft on the phone connects to the IP below (same Wi‑Fi):',
    phoneModalOk: 'Done',
    btnStart: 'Start',
    btnStop: 'Stop',
    btnReplaysFolder: 'Replays folder',
    btnConfigFile: 'Settings (file)',
    btnHelp: 'Help',
    panelServer: 'Server',
    labelHost: 'Host',
    labelPort: 'Port',
    labelVersion: 'Client version',
    hintVersion: 'From 1.19.50 · older (from 1.16.201) in extended list',
    hintVersionAdjacent: 'This version may have errors',
    hintVersionNoPossess: 'This version may have errors. Possess and spectator mode are unavailable',
    optVersionExtended: 'Extended list',
    hintVersionExperimental: 'Experimental',
    versionWarnTitle: 'Experimental',
    versionWarnBody: 'The extended list may include unstable client versions. Recording and playback on them may work worse.',
    versionWarnOk: 'Got it',
    btnSaveServer: 'Save server',
    panelReplays: 'Replays',
    btnRefresh: 'Refresh',
    nowPlayingLabel: 'Now playing',
    helpDataPath: 'Replays & settings: %APPDATA%\\BedrockServerReplay (kept after uninstall)',
    panelOptions: 'Options',
    btnSaveOpts: 'Save options',
    yes: 'Yes',
    no: 'No',
    optHotbar: 'Hotkeys',
    optHotbarHint: 'Enables hotkeys for playback control. Disabled while spectating yourself.',
    optHotbarTipAria: 'Hotkeys tip',
    optHotbarTipLead: 'Press these keys in playback to control the recording.',
    optHotbarTipAlt: 'Keys 1–8 on the keyboard',
    optHotbarTipMap: '1 pause · 2–4 speed · 5/6 seek · 7 next player · 8 restart',
    optAutoRecord: 'Auto-record',
    optAutoRecordHint: 'Starts recording as soon as you join LIVE, without .start',
    optSaveDisconnect: 'Save on disconnect',
    optSaveDisconnectHint: 'If you leave without .stop, the recording is still saved',
    optNames: 'Player names',
    optNamesHint: 'Show other players’ nametags during playback',
    optChat: 'Show chat during playback',
    optChatHint: 'Shows saved chat messages in the replay',
    optSidebar: 'Show sidebar',
    optSidebarHint: 'Scoreboard / side list from the recording',
    optSounds: 'Replay sounds',
    optSoundsHint: 'Play world sounds from the replay',
    optPauseOnSeek: 'Pause after seek / restart',
    optPauseOnSeekHint: 'Pause after ±N / .seek / .restart (off by default)',
    panelLog: 'Log',
    btnClearLog: 'Clear',
    cmdTitle: 'Chat commands',
    cmdLiveTitle: 'LIVE · record',
    cmdPlayTitle: 'PLAY · watch',
    cmdStart: 'Start recording',
    cmdStop: 'Stop and save',
    cmdPlay: 'Open last replay (or .play name)',
    cmdStatus: 'Recording status',
    cmdReplays: 'List files',
    cmdHelp: 'Short help',
    cmdPause: 'Pause / resume',
    cmdRestart: 'From start (camera kept)',
    cmdSeek: 'Seek by N seconds',
    cmdGoto: 'Jump to time',
    cmdSpeed: 'Speed (e.g. .speed 2)',
    cmdMe: 'Follow yourself (recording)',
    cmdSpec: 'Spectate a player (.spec name)',
    cmdNext: 'Next player',
    cmdFree: 'Freecam',
    cmdLiveBack: 'Leave replay (then join LIVE again)',
    cmdTime: 'Current replay time',
    themeToDark: 'Dark theme',
    themeToLight: 'Light theme',
    langToEn: 'English',
    langToRu: 'Русский',
    saveError: 'Error',
    savedRestart: 'Saved · restarting…',
    saved: 'Saved',
    labelServer: 'Server',
    labelOpts: 'Options',
    logSaveFail: 'Failed to save',
    logSaved: 'saved',
    logRestart: 'Restarting server…',
    logRestartFail: 'Restart failed',
    logRestartOk: 'Server started with new config',
    npReady: 'ready',
    versionMissing: 'not in list',
    replaysEmpty: 'Empty — join LIVE and use .start / .play',
    deleteTitle: 'Delete replay',
    deleteAria: 'Delete',
    replayClickTitle: 'Start / select this recording',
    logReplay: 'Replay',
    logFail: 'Failed',
    logDeleteFail: 'Failed to delete',
    logDeleted: 'Deleted',
    logStart: 'Start…',
    logVersions: 'Versions listed',
    logFromVersion: '(from 1.16.201)'
  }
}

let uiLang = 'ru'
let uiTheme = 'light'

function t (key) {
  return (I18N[uiLang] && I18N[uiLang][key]) || I18N.ru[key] || key
}

function applyI18n () {
  document.documentElement.lang = uiLang
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n')
    if (key) el.textContent = t(key)
  }
  for (const el of document.querySelectorAll('[data-i18n-aria]')) {
    const key = el.getAttribute('data-i18n-aria')
    if (key) el.setAttribute('aria-label', t(key))
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    const key = el.getAttribute('data-i18n-title')
    if (key) el.setAttribute('title', t(key))
  }
  for (const el of document.querySelectorAll('[data-i18n-alt]')) {
    const key = el.getAttribute('data-i18n-alt')
    if (key) el.setAttribute('alt', t(key))
  }
  updateLangSwitch()
  updateThemeButton()
  syncVersionExtendedUi()
  for (const btn of document.querySelectorAll('.addr-copy')) {
    btn.title = t('copyTitle')
  }
  if (statusText) statusText.textContent = hubRunning ? t('statusOn') : t('statusOff')
  if (activeBase) {
    const st = nowPlayingStatus.textContent
    if (!st || st === 'готов' || st === 'ready') nowPlayingStatus.textContent = t('npReady')
  }
  syncVersionWarnHint(versionInput?.value || '')
}

function updateLangSwitch () {
  for (const btn of document.querySelectorAll('.lang-opt')) {
    btn.classList.toggle('active', btn.dataset.lang === uiLang)
  }
}

function updateThemeButton () {
  const btn = $('btnTheme')
  if (!btn) return
  btn.title = uiTheme === 'dark' ? t('themeToLight') : t('themeToDark')
  btn.setAttribute('aria-label', btn.title)
}

function setTheme (theme, { persist = true } = {}) {
  uiTheme = theme === 'dark' ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', uiTheme)
  try { localStorage.setItem(LS_THEME, uiTheme) } catch {}
  updateThemeButton()
  if (persist) {
    try { window.api?.saveUiPrefs?.({ theme: uiTheme }) } catch {}
  }
}

function setLang (lang, { persist = true } = {}) {
  uiLang = lang === 'en' ? 'en' : 'ru'
  try { localStorage.setItem(LS_LANG, uiLang) } catch {}
  applyI18n()
  const ul = $('replayList')
  if (ul && ul.querySelector('li.empty')) {
    ul.querySelector('li.empty').textContent = t('replaysEmpty')
  }
  for (const del of document.querySelectorAll('.replay-del')) {
    del.title = t('deleteTitle')
  }
  for (const li of document.querySelectorAll('.replay-list li[data-base]')) {
    li.title = t('replayClickTitle')
  }
  if (persist) {
    try { window.api?.saveUiPrefs?.({ lang: uiLang }) } catch {}
  }
}

function applyUiPrefs (prefs, { persist = false } = {}) {
  if (!prefs) return
  if (prefs.theme === 'dark' || prefs.theme === 'light') setTheme(prefs.theme, { persist })
  if (prefs.lang === 'en' || prefs.lang === 'ru') setLang(prefs.lang, { persist })
  if (typeof prefs.phoneLan === 'boolean') setPhoneLan(prefs.phoneLan, { persist })
}

let lanOffline = false

function isPhoneMode () {
  return !!$('phoneModeSeg')?.querySelector('.seg-btn[data-phone="phone"].active')
}

function setPhoneLan (on, { persist = false } = {}) {
  const enabled = !!on
  const hostBox = $('phoneStrip')
  const seg = $('phoneModeSeg')
  const body = $('phoneStripBody')
  const accessBtn = $('btnPhoneAccess')
  if (seg) {
    for (const btn of seg.querySelectorAll('.seg-btn[data-phone]')) {
      btn.classList.toggle('active', (btn.dataset.phone === 'phone') === enabled)
    }
  }
  if (body) body.hidden = !enabled
  accessBtn?.classList.toggle('is-phone-on', enabled)
  if (!enabled) {
    hostBox?.classList.remove('warn')
    accessBtn?.classList.remove('warn')
  } else if (lanOffline) {
    hostBox?.classList.add('warn')
    accessBtn?.classList.add('warn')
  }
  previewAdvertiseHost()
  if (persist) {
    try { window.api?.saveUiPrefs?.({ phoneLan: enabled }) } catch {}
  }
}

async function applyPhoneModeChange (on) {
  setPhoneLan(on, { persist: false })
  const wasRunning = hubRunning
  try {
    const res = await window.api.setPhoneLan(!!on)
    if (wasRunning) {
      logLine(`[launcher] ${t('logRestart')}`)
      if (res?.restart && res.restart.ok === false) {
        logLine(`[launcher] ${t('logRestartFail')}: ${res.restart.error || 'error'}`)
      } else {
        logLine(`[launcher] ${t('logRestartOk')}`)
      }
    } else {
      logLine(on
        ? `[launcher] Смартфон: LIVE/PLAY → ${res?.advertiseHost || res?.lan?.ip || 'LAN'}`
        : '[launcher] ПК: LIVE/PLAY → 127.0.0.1')
    }
    await refresh()
  } catch (err) {
    logLine(`[launcher] phoneMode: ${err?.message || err}`)
  }
}

function initUiPrefs () {
  let theme = 'light'
  let lang = 'ru'
  try {
    const savedTheme = localStorage.getItem(LS_THEME)
    const savedLang = localStorage.getItem(LS_LANG)
    if (savedTheme === 'dark' || savedTheme === 'light') theme = savedTheme
    if (savedLang === 'en' || savedLang === 'ru') lang = savedLang
  } catch {}
  setTheme(theme, { persist: false })
  setLang(lang, { persist: false })
}

/** Да/Нет параметры → ключи config.json */
const TOGGLE_DEFAULTS = {
  controlHotbar: false,
  autoRecord: false,
  saveOnDisconnect: true,
  showPlayerNames: true,
  playShowChat: false,
  playShowSidebar: false,
  playSounds: true,
  pauseOnSeek: false
}

const toggleState = { ...TOGGLE_DEFAULTS }
/** @type {string | null} */
let savedServerSnap = null
/** @type {string | null} */
let savedOptsSnap = null
let suppressDirty = false

function serverSnapshot () {
  return JSON.stringify({
    host: ($('destHost')?.value || '').trim(),
    port: Number($('destPort')?.value) || 19132,
    version: versionInput?.value || ''
  })
}

function getAdvertiseHostText () {
  const raw = ($('advertiseHost')?.textContent || '').trim()
  return !raw || raw === '—' ? '' : raw
}

function setAdvertiseHostText (host) {
  const el = $('advertiseHost')
  if (!el) return
  el.textContent = host ? String(host) : '—'
}

/** LIVE/PLAY: LAN IP only in smartphone mode; otherwise 127.0.0.1. */
function previewAdvertiseHost () {
  const phoneOn = isPhoneMode()
  const host = phoneOn
    ? (getAdvertiseHostText() || '127.0.0.1')
    : '127.0.0.1'
  setAddrPart('liveHost', host)
  setAddrPart('playHost', host)
}

let lanPollTimer = null

function applyLanStatus (lan, advertiseHost) {
  const hostBox = $('phoneStrip')
  const accessBtn = $('btnPhoneAccess')
  const hint = $('phoneIpHint')
  const offline = !lan?.ok
  lanOffline = offline
  const phoneOn = isPhoneMode()
  hostBox?.classList.toggle('warn', offline && phoneOn)
  accessBtn?.classList.toggle('warn', offline && phoneOn)
  if (hint) {
    const key = offline ? 'phoneIpOffline' : 'phoneIpHint'
    hint.setAttribute('data-i18n', key)
    hint.textContent = t(key)
  }
  // Strip always shows detected LAN IP (phone-only info), not 127.0.0.1
  const phoneIp = lan?.ip || (phoneOn ? advertiseHost : '') || ''
  if (phoneIp && getAdvertiseHostText() !== String(phoneIp)) {
    setAdvertiseHostText(phoneIp)
  } else if (!phoneIp && !getAdvertiseHostText()) {
    setAdvertiseHostText('')
  }
  previewAdvertiseHost()
}

async function refreshLanStatus () {
  try {
    const res = await window.api.lanStatus()
    if (typeof res?.phoneLan === 'boolean') {
      setPhoneLan(res.phoneLan, { persist: false })
    }
    applyLanStatus(res?.lan, res?.advertiseHost || res?.lan?.ip)
  } catch {}
}

function startLanPoll () {
  if (lanPollTimer) return
  lanPollTimer = setInterval(() => { refreshLanStatus() }, 3000)
}

function optsSnapshot () {
  return JSON.stringify({ ...toggleState })
}

function updateSaveBtns () {
  const bs = $('btnSaveServer')
  const bo = $('btnSaveOpts')
  if (bs) bs.disabled = !(savedServerSnap != null && serverSnapshot() !== savedServerSnap)
  if (bo) bo.disabled = !(savedOptsSnap != null && optsSnapshot() !== savedOptsSnap)
}

function markServerBaseline () {
  savedServerSnap = serverSnapshot()
  updateSaveBtns()
}

function markOptsBaseline () {
  savedOptsSnap = optsSnapshot()
  updateSaveBtns()
}

function markSavedBaseline () {
  markServerBaseline()
  markOptsBaseline()
}

function setToggle (key, value) {
  toggleState[key] = !!value
  const row = document.querySelector(`.toggle-row[data-key="${key}"]`)
  if (!row) return
  for (const btn of row.querySelectorAll('.seg-btn')) {
    btn.classList.toggle('active', (btn.dataset.v === 'true') === toggleState[key])
  }
  if (!suppressDirty) updateSaveBtns()
}

function initToggles () {
  for (const row of document.querySelectorAll('.toggle-row[data-key]')) {
    const key = row.dataset.key
    for (const btn of row.querySelectorAll('.seg-btn')) {
      btn.addEventListener('click', () => {
        setToggle(key, btn.dataset.v === 'true')
      })
    }
    setToggle(key, TOGGLE_DEFAULTS[key])
  }
}

initUiPrefs()
initToggles()

$('destHost')?.addEventListener('input', () => updateSaveBtns())
$('destPort')?.addEventListener('input', () => updateSaveBtns())

$('phoneModeSeg')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn[data-phone]')
  if (!btn || !$('phoneModeSeg').contains(btn)) return
  const on = btn.dataset.phone === 'phone'
  if (isPhoneMode() === on) return
  void applyPhoneModeChange(on)
})

function openPhoneModal () {
  const m = $('phoneModal')
  if (!m) return
  m.hidden = false
  requestAnimationFrame(() => m.classList.add('open'))
  refreshLanStatus()
}

function closePhoneModal () {
  const m = $('phoneModal')
  if (!m) return
  m.classList.remove('open')
  setTimeout(() => { m.hidden = true }, 160)
}

$('btnPhoneAccess')?.addEventListener('click', openPhoneModal)
$('btnClosePhoneModal')?.addEventListener('click', closePhoneModal)
$('btnPhoneModalOk')?.addEventListener('click', closePhoneModal)
$('phoneModal')?.addEventListener('click', (e) => {
  if (e.target === $('phoneModal')) closePhoneModal()
})

$('chkVersionExtended')?.addEventListener('change', async (e) => {
  const on = !!e.target.checked
  if (on && !hasSeenVersionWarn()) {
    e.target.checked = false
    const ok = await showVersionWarn()
    if (!ok) return
    markVersionWarnSeen()
    setVersionExtended(true)
    return
  }
  setVersionExtended(on)
})

$('btnVersionWarnOk')?.addEventListener('click', () => closeVersionWarn(true))
$('versionWarnModal')?.addEventListener('click', (e) => {
  if (e.target === $('versionWarnModal')) closeVersionWarn(false)
})

$('btnTheme')?.addEventListener('click', () => {
  setTheme(uiTheme === 'dark' ? 'light' : 'dark')
})

$('langSwitch')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.lang-opt')
  if (!btn?.dataset?.lang) return
  setLang(btn.dataset.lang)
})

function openCommandsModal () {
  const m = $('commandsModal')
  if (!m) return
  m.hidden = false
  requestAnimationFrame(() => m.classList.add('open'))
}

function closeCommandsModal () {
  const m = $('commandsModal')
  if (!m) return
  m.classList.remove('open')
  setTimeout(() => { m.hidden = true }, 160)
}

$('btnCommands')?.addEventListener('click', openCommandsModal)
$('btnCloseCommands')?.addEventListener('click', closeCommandsModal)
$('commandsModal')?.addEventListener('click', (e) => {
  if (e.target === $('commandsModal')) closeCommandsModal()
})

async function saveAndMaybeRestart (partial, noteEl, labelKey) {
  const wasRunning = hubRunning
  const label = t(labelKey)
  const res = await window.api.saveConfig(partial)
  if (!res.ok) {
    if (noteEl) {
      noteEl.textContent = t('saveError')
      setTimeout(() => { noteEl.textContent = '' }, 2000)
    }
    logLine(`[launcher] ${t('logSaveFail')} ${label}`)
    return false
  }
  if (noteEl) {
    noteEl.textContent = wasRunning ? t('savedRestart') : t('saved')
    setTimeout(() => { noteEl.textContent = '' }, 2500)
  }
  logLine(`[launcher] ${label} ${t('logSaved')}`)
  if (wasRunning) {
    logLine(`[launcher] ${t('logRestart')}`)
    const r = await window.api.hubRestart(activeBase || undefined)
    if (!r.ok) logLine(`[launcher] ${t('logRestartFail')}: ${r.error}`)
    else logLine(`[launcher] ${t('logRestartOk')}`)
  }
  await refresh()
  return true
}

function setRunning (running, nextActive) {
  hubRunning = !!running
  if (nextActive !== undefined) activeBase = nextActive
  statusPill.dataset.state = hubRunning ? 'on' : 'off'
  statusText.textContent = hubRunning ? t('statusOn') : t('statusOff')
  document.body.classList.toggle('hub-running', hubRunning)
  btnStart.disabled = hubRunning
  btnStop.disabled = !hubRunning
  if (!hubRunning) {
    activeBase = null
    setNowPlaying(null, '')
  }
  markActiveReplay()
  if (hubRunning) startPlayPoll()
  else stopPlayPoll()
}

function setNowPlaying (base, status) {
  const name = base || '—'
  nowPlayingName.textContent = name
  nowPlaying.dataset.state = base ? 'on' : 'off'
  const st = !base
    ? ''
    : (status && status !== 'idle'
      ? (status === 'готов' || status === 'ready' ? t('npReady') : status)
      : (hubRunning ? t('npReady') : ''))
  nowPlayingStatus.textContent = st
}

function logLine (line) {
  logEl.textContent += (logEl.textContent ? '\n' : '') + line
  logEl.scrollTop = logEl.scrollHeight
}

function fmtSize (n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function fmtDuration (ms) {
  if (ms == null || !Number.isFinite(Number(ms)) || Number(ms) < 0) return '—'
  const total = Math.floor(Number(ms) / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function fmtReplayDate (iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(uiLang === 'en' ? 'en-GB' : 'ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  })
}

function compareVerAsc (a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1
    if ((pa[i] || 0) > (pb[i] || 0)) return 1
  }
  return 0
}

function protocolBaseFor (v) {
  const pool = extendedVersionEntries.length ? extendedVersionEntries : versionEntries
  const hit = pool.find((e) => e.value === v)
  if (hit) return hit.base
  const sorted = [...pool].sort((a, b) => compareVerAsc(a.base, b.base))
  let best = null
  for (const e of sorted) {
    if (compareVerAsc(e.base, v) <= 0) best = e.base
  }
  return best || v
}

function syncVersionExtendedUi () {
  const chk = $('chkVersionExtended')
  if (chk) chk.checked = !!versionExtended
}

function hasSeenVersionWarn () {
  try { return localStorage.getItem(LS_VERSION_WARN) === '1' } catch { return false }
}

function markVersionWarnSeen () {
  try { localStorage.setItem(LS_VERSION_WARN, '1') } catch {}
}

function showVersionWarn () {
  const modal = $('versionWarnModal')
  if (!modal) return Promise.resolve(true)
  modal.hidden = false
  requestAnimationFrame(() => modal.classList.add('open'))
  return new Promise((resolve) => {
    versionWarnResolve = resolve
    $('btnVersionWarnOk')?.focus()
  })
}

function closeVersionWarn (ok) {
  const modal = $('versionWarnModal')
  if (modal) {
    modal.classList.remove('open')
    modal.hidden = true
  }
  const resolve = versionWarnResolve
  versionWarnResolve = null
  if (resolve) resolve(!!ok)
}

function versionEntryFor (v) {
  if (!v) return null
  return extendedVersionEntries.find((e) => e.value === v)
    || stableVersionEntries.find((e) => e.value === v)
    || versionEntries.find((e) => e.value === v)
    || null
}

function isNoPossessVersion (v) {
  const hit = versionEntryFor(v)
  if (hit && typeof hit.noPossess === 'boolean') return hit.noPossess
  // fallback: pre-1.19.50
  const p = String(v || '0').split('.').map((x) => parseInt(x, 10) || 0)
  const s = [1, 19, 50]
  for (let i = 0; i < 3; i++) {
    if ((p[i] || 0) < s[i]) return true
    if ((p[i] || 0) > s[i]) return false
  }
  return false
}

function isStableVersion (v) {
  if (!v) return false
  const hit = versionEntryFor(v)
  if (hit) return !!hit.stable && !hit.noPossess
  return stableVersionEntries.some((e) => e.value === v && e.stable !== false && !e.noPossess)
}

/** Yellow selection: adjacent hotfix vs freecam (no spectator). */
function versionWarnHintKey (v) {
  if (!v) return null
  if (isNoPossessVersion(v)) return 'hintVersionNoPossess'
  if (!isStableVersion(v)) return 'hintVersionAdjacent'
  return null
}

function syncVersionWarnHint (v) {
  const el = $('versionWarnHint') || $('versionNoPossessHint')
  if (!el) return
  const key = versionWarnHintKey(v)
  el.hidden = !key
  if (key) {
    el.setAttribute('data-i18n', key)
    el.textContent = t(key)
  }
}

function activeVersionSource () {
  if (versionExtended && extendedVersionEntries.length) return extendedVersionEntries
  if (stableVersionEntries.length) return stableVersionEntries
  return versionEntries
}

function setVersionExtended (on, { persist = true, keepSelection = true } = {}) {
  versionExtended = !!on
  if (persist) {
    try { localStorage.setItem(LS_VERSION_EXT, versionExtended ? '1' : '0') } catch {}
  }
  syncVersionExtendedUi()
  let selected = versionInput?.value || ''
  const source = activeVersionSource()
  // Resolve hotfix → stable base; freecam-only versions leave the list when extended is off.
  if (keepSelection && selected && !source.some((e) => e.value === selected)) {
    const base = protocolBaseFor(selected)
    if (base && source.some((e) => e.value === base)) selected = base
    else if (source.length) selected = source[0].value
  }
  fillVersions(null, selected, source)
}

function setVersionValue (v) {
  versionInput.value = v
  versionBtnText.textContent = v || '—'
  const stable = isStableVersion(v)
  const noPossess = isNoPossessVersion(v)
  const dot = $('versionBtnDot')
  if (dot) {
    dot.hidden = !v
    dot.className = (stable && !noPossess) ? 'ver-dot' : 'ver-dot warn'
  }
  {
    const hintKey = versionWarnHintKey(v)
    versionBtn.title = hintKey ? `${v} · ${t(hintKey)}` : (v || '')
  }
  syncVersionWarnHint(v)
  if (!suppressDirty) updateSaveBtns()
  cfgVersion = v || null
  for (const li of versionMenu.querySelectorAll('li')) {
    li.setAttribute('aria-selected', li.dataset.value === v ? 'true' : 'false')
  }
  markActiveReplay()
}

function closeVersionMenu () {
  versionMenu.hidden = true
  versionPicker.classList.remove('open')
  versionBtn.setAttribute('aria-expanded', 'false')
}

function openVersionMenu () {
  versionMenu.hidden = false
  versionPicker.classList.add('open')
  versionBtn.setAttribute('aria-expanded', 'true')
  const selected = versionMenu.querySelector('li[aria-selected="true"]')
  if (selected) selected.scrollIntoView({ block: 'nearest' })
}

/**
 * @param {string[]|{value:string,base:string}[]|null} versionsOrEntries
 * @param {string} selected
 * @param {{value:string,base:string,stable?:boolean}[]} [entriesFromMain]
 */
function mapVersionEntry (e) {
  const value = String(e.value)
  const base = String(e.base || e.value)
  const noPossess = e.noPossess === true || isNoPossessVersion(value)
  const stable = e.stable === true && !noPossess
  return { value, base, stable, noPossess }
}

function fillVersions (versionsOrEntries, selected, entriesFromMain) {
  if (Array.isArray(entriesFromMain) && entriesFromMain.length) {
    versionEntries = entriesFromMain.map(mapVersionEntry)
  } else if (Array.isArray(versionsOrEntries) && versionsOrEntries[0] && typeof versionsOrEntries[0] === 'object') {
    versionEntries = versionsOrEntries.map(mapVersionEntry)
  } else if (versionsOrEntries == null && versionEntries.length) {
    // keep current versionEntries (mode switch already set source)
  } else {
    const bases = Array.isArray(versionsOrEntries) && versionsOrEntries.length
      ? versionsOrEntries.map(String)
      : ['1.21.100']
    versionEntries = bases.map((b) => mapVersionEntry({ value: b, base: b, stable: true }))
  }
  versionList = versionEntries.map((e) => e.value)

  const mappedBase = selected ? protocolBaseFor(selected) : null
  const want = selected && versionList.includes(selected)
    ? selected
    : (mappedBase && versionList.includes(mappedBase)
      ? mappedBase
      : (versionList[0] || '1.21.100'))

  versionMenu.innerHTML = ''
  for (const e of versionEntries) {
    const li = document.createElement('li')
    li.setAttribute('role', 'option')
    li.dataset.value = e.value
    li.dataset.base = e.base
    const line = document.createElement('span')
    line.className = 'ver-line'
    const dot = document.createElement('span')
    const warn = !e.stable || e.noPossess
    dot.className = warn ? 'ver-dot warn' : 'ver-dot'
    dot.setAttribute('aria-hidden', 'true')
    line.appendChild(dot)
    const main = document.createElement('span')
    main.className = 'ver-main'
    main.textContent = e.value
    line.appendChild(main)
    li.appendChild(line)
    {
      const hintKey = e.noPossess
        ? 'hintVersionNoPossess'
        : (!e.stable ? 'hintVersionAdjacent' : null)
      li.title = hintKey ? `${e.value} · ${t(hintKey)}` : e.value
    }
    li.addEventListener('click', (ev) => {
      ev.preventDefault()
      setVersionValue(e.value)
      closeVersionMenu()
    })
    versionMenu.appendChild(li)
  }

  // Orphan row only for versions with no protocol base in the current list
  // (never insert a hotfix stub when switching back to stable).
  if (selected && !versionList.includes(selected) && !(mappedBase && versionList.includes(mappedBase))) {
    const li = document.createElement('li')
    li.setAttribute('role', 'option')
    li.dataset.value = selected
    li.dataset.base = mappedBase || selected
    const line = document.createElement('span')
    line.className = 'ver-line'
    const dot = document.createElement('span')
    dot.className = 'ver-dot warn'
    dot.setAttribute('aria-hidden', 'true')
    line.appendChild(dot)
    const main = document.createElement('span')
    main.className = 'ver-main'
    main.textContent = `${selected} (${t('versionMissing')})`
    line.appendChild(main)
    li.appendChild(line)
    li.title = selected
    li.addEventListener('click', (ev) => {
      ev.preventDefault()
      setVersionValue(selected)
      closeVersionMenu()
    })
    versionMenu.insertBefore(li, versionMenu.firstChild)
    setVersionValue(selected)
  } else {
    setVersionValue(want)
  }
}

versionBtn.addEventListener('click', (e) => {
  e.preventDefault()
  e.stopPropagation()
  if (versionMenu.hidden) openVersionMenu()
  else closeVersionMenu()
})

document.addEventListener('click', (e) => {
  if (!versionPicker.contains(e.target)) closeVersionMenu()
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeVersionMenu()
    closeCommandsModal()
  }
})

function markActiveReplay () {
  const ul = $('replayList')
  for (const li of ul.querySelectorAll('li[data-base]')) {
    const base = li.dataset.base
    const ver = li.dataset.version || ''
    li.classList.toggle('active', !!activeBase && base === activeBase)
    // Yellow only when protocol base truly differs (hotfixes like 1.26.33 ~ 1.26.30 are OK)
    const realMismatch = !!(ver && cfgVersion && ver !== cfgVersion &&
      protocolBaseFor(ver) !== protocolBaseFor(cfgVersion))
    li.classList.toggle('mismatch', realMismatch)
  }
}

async function onReplayClick (base) {
  logLine(`[launcher] ${t('logReplay')}: ${base}…`)
  const res = await window.api.playReplay(base)
  if (!res.ok) {
    logLine(`[launcher] ${t('logFail')}: ${res.error || 'error'}`)
    return
  }
  activeBase = res.activeBase || base
  setNowPlaying(activeBase, hubRunning ? t('npReady') : 'старт…')
  markActiveReplay()
}

const TRASH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
  '<line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>' +
  '</svg>'

async function onReplayDelete (base, ev) {
  ev?.stopPropagation?.()
  ev?.preventDefault?.()
  const res = await window.api.deleteReplay(base)
  if (res?.cancelled) return
  if (!res?.ok) {
    logLine(`[launcher] ${t('logDeleteFail')}: ${res?.error || 'error'}`)
    return
  }
  logLine(`[launcher] ${t('logDeleted')}: ${base}`)
  if (activeBase === base) {
    activeBase = null
    setNowPlaying(null, '')
  }
  renderReplays(res.replays || await window.api.refreshReplays())
}

function renderReplays (list) {
  const ul = $('replayList')
  ul.innerHTML = ''
  if (!list?.length) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = t('replaysEmpty')
    ul.appendChild(li)
    return
  }
  for (const r of list) {
    const li = document.createElement('li')
    li.dataset.base = r.base || r.name
    if (r.version) li.dataset.version = r.version

    const left = document.createElement('span')
    left.className = 'replay-left'
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = r.base || r.name
    const sub = document.createElement('span')
    sub.className = 'ver'
    const verText = r.version ? `v${r.version}` : (uiLang === 'en' ? 'version ?' : 'версия ?')
    const durText = fmtDuration(r.durationMs)
    const dateText = fmtReplayDate(r.mtime)
    sub.textContent = `${verText} · ${durText} · ${dateText}`
    left.append(name, sub)

    const meta = document.createElement('span')
    meta.className = 'meta'
    const size = document.createElement('span')
    size.className = 'replay-size'
    size.textContent = fmtSize(r.size)
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'replay-del'
    del.title = t('deleteTitle')
    del.setAttribute('aria-label', `${t('deleteAria')} ${r.base || r.name}`)
    del.innerHTML = TRASH_SVG
    del.addEventListener('click', (e) => onReplayDelete(li.dataset.base, e))
    meta.append(size, del)

    li.append(left, meta)
    li.title = t('replayClickTitle')
    li.addEventListener('click', () => onReplayClick(li.dataset.base))
    ul.appendChild(li)
  }
  markActiveReplay()
}

function fillConfig (cfg, live, play, versions, versionEntriesFromMain) {
  if (!cfg) return
  suppressDirty = true
  $('destHost').value = cfg.destination?.host || ''
  $('destPort').value = cfg.destination?.port ?? 19132

  const bases = Array.isArray(versions) && versions.length ? versions.map(String) : ['1.21.100']
  const fromMain = Array.isArray(versionEntriesFromMain) ? versionEntriesFromMain : []
  stableVersionEntries = bases.map((b) => {
    const hit = fromMain.find((e) => String(e.value) === b)
    return mapVersionEntry(hit || { value: b, base: b, stable: true, noPossess: false })
  })
  extendedVersionEntries = fromMain.length
    ? fromMain.map(mapVersionEntry)
    : [...stableVersionEntries]

  try {
    versionExtended = localStorage.getItem(LS_VERSION_EXT) === '1'
  } catch {
    versionExtended = false
  }
  // Config on freecam/hotfix → keep extended on so the selection stays visible
  const cfgVer = cfg.version ? String(cfg.version) : ''
  if (!versionExtended && cfgVer) {
    const inStable = stableVersionEntries.some((e) => e.value === cfgVer)
    const inExt = extendedVersionEntries.some((e) => e.value === cfgVer)
    if (!inStable && inExt) versionExtended = true
  }
  syncVersionExtendedUi()
  fillVersions(null, cfg.version || '1.21.100', activeVersionSource())
  for (const key of Object.keys(TOGGLE_DEFAULTS)) {
    let v = cfg[key]
    if (key === 'pauseOnSeek' && v === undefined) {
      v = cfg.seekPaused || cfg.restartPaused
    }
    setToggle(key, v === undefined ? TOGGLE_DEFAULTS[key] : !!v)
  }
  const liveHost = (live?.host || '127.0.0.1').trim()
  setAddrPart('liveHost', liveHost)
  setAddrPart('livePort', live?.port)
  setAddrPart('playHost', play?.host || liveHost)
  setAddrPart('playPort', play?.port)
  suppressDirty = false
  markSavedBaseline()
}

function setAddrPart (id, value) {
  const el = $(id)
  if (!el) return
  const text = value == null || value === '' ? '—' : String(value)
  el.textContent = text
}

let copyToastTimer = null

async function copyText (text) {
  const v = String(text || '').trim()
  if (!v || v === '—') return false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(v)
      return true
    }
  } catch {}
  try {
    const ta = document.createElement('textarea')
    ta.value = v
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function showCopyToast () {
  const toast = $('copyToast')
  if (!toast) return
  toast.hidden = false
  requestAnimationFrame(() => toast.classList.add('show'))
  if (copyToastTimer) clearTimeout(copyToastTimer)
  copyToastTimer = setTimeout(() => {
    toast.classList.remove('show')
    setTimeout(() => { toast.hidden = true }, 180)
  }, 1400)
}

document.querySelectorAll('.addr-copy').forEach((btn) => {
  btn.title = t('copyTitle')
  btn.addEventListener('click', async () => {
    const id = btn.getAttribute('data-copy-target')
    const el = id ? $(id) : null
    const ok = await copyText(el?.textContent)
    if (ok) showCopyToast()
  })
})

async function refreshPlayState () {
  if (!hubRunning) return
  const s = await window.api.playState()
  if (!s) return
  if (s.activeBase) activeBase = s.activeBase
  else if (s.fileName) activeBase = String(s.fileName).replace(/\.mcreplay\.gz$/i, '')

  const label = s.status === 'playing'
    ? 'playing'
    : s.status === 'paused' || s.paused
      ? 'paused'
      : s.status === 'seeking'
        ? 'seeking'
        : s.status === 'ended'
          ? 'ended'
          : (activeBase ? t('npReady') : '')
  setNowPlaying(activeBase, label)
  markActiveReplay()

  if (activeBase && activeBase !== lastListedActive) {
    lastListedActive = activeBase
    try { renderReplays(await window.api.refreshReplays()) } catch {}
  }
}

function startPlayPoll () {
  if (playPollTimer) return
  playPollTimer = setInterval(() => { refreshPlayState().catch(() => {}) }, 1000)
  refreshPlayState().catch(() => {})
}

function stopPlayPoll () {
  if (playPollTimer) {
    clearInterval(playPollTimer)
    playPollTimer = null
  }
  lastListedActive = null
}

/** Bedrock 1.26+ often shown as 26.x (dropped leading 1.). */
function shortMcLabel (v) {
  const m = String(v || '').match(/^1\.(\d+)\.(\d+)$/)
  if (!m) return String(v || '')
  return parseInt(m[1], 10) >= 26 ? `${m[1]}.${m[2]}` : `1.${m[1]}.${m[2]}`
}

function supportRangeLabel (versionEntries, versions) {
  const floor = '1.16.201'
  const pool = []
  if (Array.isArray(versionEntries)) {
    for (const e of versionEntries) {
      if (e && e.value) pool.push(String(e.value))
    }
  }
  if (!pool.length && Array.isArray(versions)) {
    for (const v of versions) pool.push(String(v))
  }
  if (!pool.length) return `${floor}+`
  // lists are newest-first
  const top = pool[0]
  if (!top || top === floor) return `${floor}+`
  return `${floor} – ${shortMcLabel(top)}`
}

function syncSupportRange (state) {
  const label = supportRangeLabel(state.versionEntries, state.versions)
  const el = $('supportRange')
  if (el) {
    el.textContent = label
    el.title = `Bedrock ${label}`
  }
  return label
}

async function refresh () {
  const state = await window.api.getState()
  if (state.uiPrefs) applyUiPrefs(state.uiPrefs, { persist: false })
  setRunning(!!state.running, state.activeBase || null)
  const support = syncSupportRange(state)
  if (state.appVersion) {
    const el = $('appVersion')
    if (el) el.textContent = `v${state.appVersion}`
    try { document.title = `Bedrock Server Replay v${state.appVersion} · ${support}` } catch {}
  }
  if (state.configError) {
    logLine(`[launcher] config error: ${state.configError}`)
  }
  fillConfig(state.config, state.live, state.play, state.versions, state.versionEntries)
  if (state.uiPrefs && typeof state.uiPrefs.phoneLan === 'boolean') {
    setPhoneLan(state.uiPrefs.phoneLan, { persist: false })
  }
  applyLanStatus(state.lan, state.live?.host || state.lan?.ip)
  renderReplays(state.replays)
  if (state.activeBase) setNowPlaying(state.activeBase, state.playState?.status || t('npReady'))
  startLanPoll()
  return state
}

btnStart.addEventListener('click', async () => {
  logLine(`[launcher] ${t('logStart')}`)
  const res = await window.api.hubStart()
  if (!res.ok) logLine(`[launcher] ${t('logFail')}: ${res.error}`)
})

btnStop.addEventListener('click', async () => {
  await window.api.hubStop()
})

$('btnRefresh').addEventListener('click', async () => {
  renderReplays(await window.api.refreshReplays())
})

$('btnReplaysFolder').addEventListener('click', () => window.api.openPath('replays'))
$('btnConfigFile').addEventListener('click', () => window.api.openPath('config'))

$('btnClearLog').addEventListener('click', () => {
  logEl.textContent = ''
})

$('cfgForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  if ($('btnSaveServer')?.disabled) return
  closeVersionMenu()
  await saveAndMaybeRestart({
    version: versionInput.value || '1.21.100',
    autoVersion: false,
    destination: {
      host: $('destHost').value.trim(),
      port: Number($('destPort').value) || 19132
    }
  }, $('saveNoteServer'), 'labelServer')
  markServerBaseline()
})

$('btnSaveOpts')?.addEventListener('click', async () => {
  if ($('btnSaveOpts')?.disabled) return
  await saveAndMaybeRestart({
    controlHotbar: toggleState.controlHotbar,
    autoRecord: toggleState.autoRecord,
    saveOnDisconnect: toggleState.saveOnDisconnect,
    recordChat: true,
    showPlayerNames: toggleState.showPlayerNames,
    playShowChat: toggleState.playShowChat,
    playShowSidebar: toggleState.playShowSidebar,
    playSounds: toggleState.playSounds,
    pauseOnSeek: toggleState.pauseOnSeek
  }, $('saveNoteOpts'), 'labelOpts')
  markOptsBaseline()
})

window.api.onLog(({ line }) => logLine(line))
window.api.onStatus((s) => {
  setRunning(!!s.running, s.activeBase !== undefined ? s.activeBase : undefined)
})
window.api.onPlay(async (s) => {
  if (s?.activeBase) {
    activeBase = s.activeBase
    setNowPlaying(activeBase, s.status || t('npReady'))
    markActiveReplay()
  } else if (s?.status) {
    setNowPlaying(activeBase, s.status)
  }
  if (s?.refreshList) {
    try { renderReplays(await window.api.refreshReplays()) } catch {}
  }
})

refresh().then((state) => {
  logLine(`[launcher] Bedrock Server Replay · ${state.root}`)
  const nStable = state.versions?.length || 0
  const nExt = state.versionEntries?.length || nStable
  logLine(`[launcher] ${t('logVersions')}: ${nStable} stable / ${nExt} extended ${t('logFromVersion')}`)
  if (state.uiPrefs?.phoneLan) {
    if (state.lan && !state.lan.ok) logLine(`[launcher] ${t('phoneIpOffline')}`)
    else if (state.lan?.ip) logLine(`[launcher] LAN IP: ${state.lan.ip}`)
  }
})
