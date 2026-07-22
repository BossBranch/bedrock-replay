async function api (path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

const $ = (id) => document.getElementById(id)
const LS_EXT = 'bsr-mobile-version-extended'
const LS_LANG = 'bsr-mobile-lang'

const I18N = {
  ru: {
    statusOff: 'Остановлен',
    statusOn: 'Работает',
    statusStarting: 'Запуск…',
    statusStopping: 'Остановка…',
    statusError: 'Ошибка',
    statusOffline: 'Нет связи',
    joinHint: 'В Minecraft: <strong class="mono">127.0.0.1:19132</strong> · <strong class="mono">:19133</strong>',
    serverTitle: 'Целевой сервер',
    labelHost: 'Хост',
    labelPort: 'Порт',
    labelVersion: 'Версия Minecraft',
    optVersionExtended: 'Расширенный список <em>экспериментально</em>',
    hintVersionWarn: 'На этой версии возможны ошибки',
    hintVersionNoPossess: 'На этой версии возможны ошибки. Вселение и режим спектатора не работают',
    btnStart: 'Запустить',
    btnStop: 'Стоп',
    replaysTitle: 'Реплеи',
    btnRefresh: 'Обновить',
    selectedLabel: 'Выбрано',
    btnConfig: 'Конфиг',
    btnLog: 'Терминал',
    optsTitle: 'Параметры',
    optOverlay: 'Оверлей в Minecraft',
    optAutoRecord: 'Автозапись',
    optSaveDisconnect: 'Сохранять при выходе',
    optNames: 'Имена игроков',
    optChat: 'Показывать чат при просмотре',
    optSidebar: 'Показывать боковую панель',
    optSounds: 'Звуки записи',
    optPauseOnSeek: 'Пауза после перемотки / рестарта',
    livePort: 'LIVE порт',
    playPort: 'PLAY порт',
    btnSave: 'Сохранить',
    logTitle: 'Терминал',
    sec: 'с',
    min: 'м'
  },
  en: {
    statusOff: 'Stopped',
    statusOn: 'Running',
    statusStarting: 'Starting…',
    statusStopping: 'Stopping…',
    statusError: 'Error',
    statusOffline: 'Offline',
    joinHint: 'In Minecraft: <strong class="mono">127.0.0.1:19132</strong> · <strong class="mono">:19133</strong>',
    serverTitle: 'Target server',
    labelHost: 'Host',
    labelPort: 'Port',
    labelVersion: 'Minecraft version',
    optVersionExtended: 'Extended list <em>experimental</em>',
    hintVersionWarn: 'This version may have errors',
    hintVersionNoPossess: 'This version may have errors. Possess and spectator mode are unavailable',
    btnStart: 'Start',
    btnStop: 'Stop',
    replaysTitle: 'Replays',
    btnRefresh: 'Refresh',
    selectedLabel: 'Selected',
    btnConfig: 'Config',
    btnLog: 'Terminal',
    optsTitle: 'Options',
    optOverlay: 'In-game overlay',
    optAutoRecord: 'Auto-record',
    optSaveDisconnect: 'Save on disconnect',
    optNames: 'Player names',
    optChat: 'Show chat in playback',
    optSidebar: 'Show sidebar',
    optSounds: 'Recording sounds',
    optPauseOnSeek: 'Pause after seek / restart',
    livePort: 'LIVE port',
    playPort: 'PLAY port',
    btnSave: 'Save',
    logTitle: 'Terminal',
    sec: 's',
    min: 'm'
  }
}

let uiLang = 'ru'
try {
  const saved = localStorage.getItem(LS_LANG)
  if (saved === 'en' || saved === 'ru') uiLang = saved
  else if ((navigator.language || '').toLowerCase().startsWith('en')) uiLang = 'en'
} catch {}

function t (key) {
  return (I18N[uiLang] && I18N[uiLang][key]) || I18N.ru[key] || key
}

function applyI18n () {
  document.documentElement.lang = uiLang
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n')
    if (key) el.innerHTML = t(key)
  }
  for (const el of document.querySelectorAll('[data-i18n-html]')) {
    const key = el.getAttribute('data-i18n-html')
    if (key) el.innerHTML = t(key)
  }
  for (const btn of document.querySelectorAll('.lang-opt')) {
    btn.classList.toggle('active', btn.dataset.lang === uiLang)
  }
  try { window.BsrBridge?.setUiLang?.(uiLang) } catch {}
}

function setLang (lang) {
  uiLang = lang === 'en' ? 'en' : 'ru'
  try { localStorage.setItem(LS_LANG, uiLang) } catch {}
  try { window.BsrBridge?.setUiLang?.(uiLang) } catch {}
  applyI18n()
  // Refresh status pill with current state class
  const banner = $('statusBanner')
  const state = banner?.className?.includes('on') ? 'on'
    : banner?.className?.includes('busy') ? 'busy' : 'off'
  if (state === 'on') setPill('on', t('statusOn'))
  else if (state === 'busy') setPill('busy', t('statusStarting'))
  else setPill('off', t('statusOff'))
}

document.getElementById('langSwitch')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.lang-opt[data-lang]')
  if (!btn) return
  setLang(btn.dataset.lang)
})

let allEntries = []
let versionExtended = false

function tWarn (e) {
  if (!e) return null
  if (e.noPossess) return t('hintVersionNoPossess')
  if (!e.stable) return t('hintVersionWarn')
  return null
}

function activeEntries () {
  if (versionExtended) return allEntries
  return allEntries.filter((e) => e.stable && !e.noPossess)
}

function findEntry (v) {
  return allEntries.find((e) => e.value === v) || null
}

function setPill (state, text) {
  const banner = $('statusBanner')
  const pill = $('pill')
  pill.textContent = text
  banner.className = 'status-banner ' + (state || 'off')
}

function numOr (el, fallback) {
  const n = Number(el.value)
  return Number.isFinite(n) && el.value !== '' ? n : fallback
}

function formatSize (n) {
  const b = Number(n) || 0
  if (b < 1024) return b + ' B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
  return (b / (1024 * 1024)).toFixed(1) + ' MB'
}

function formatWhen (iso) {
  try {
    const d = new Date(iso)
    return d.toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit'
    })
  } catch {
    return ''
  }
}

function formatDuration (ms) {
  if (ms == null || ms === '') return null
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return null
  const s = Math.round(n / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m <= 0) return r + t('sec')
  return m + t('min') + ' ' + String(r).padStart(2, '0') + t('sec')
}

function shortPath (dir) {
  const s = String(dir || '')
  if (!s) return ''
  const parts = s.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length <= 3) return s
  return '…/' + parts.slice(-3).join('/')
}

let activeReplayBase = null
let cfgVersion = null

function setNowPlaying (base) {
  activeReplayBase = base || null
  const box = $('nowPlaying')
  const name = $('nowPlayingName')
  if (!box || !name) return
  if (!activeReplayBase) {
    box.hidden = true
    name.textContent = '—'
    return
  }
  box.hidden = false
  name.textContent = activeReplayBase
}

function markActiveReplayRows () {
  for (const li of $('replayList').querySelectorAll('.replay-item[data-base]')) {
    li.classList.toggle('active', !!activeReplayBase && li.dataset.base === activeReplayBase)
  }
}

async function refreshStatus () {
  const s = await api('/api/status')
  if (s.starting) setPill('busy', t('statusStarting'))
  else if (s.running) setPill('on', t('statusOn'))
  else if (s.error) setPill('off', t('statusError'))
  else setPill('off', t('statusOff'))
  document.body.classList.toggle('hub-running', !!s.running)
  try {
    if (window.BsrBridge?.setProxyRunning) {
      window.BsrBridge.setProxyRunning(!!s.running)
    }
  } catch {}
  if (s.version) cfgVersion = s.version
  if (s.activeReplay) {
    const base = String(s.activeReplay).replace(/\.mcreplay(\.gz)?$/i, '')
    setNowPlaying(base)
    markActiveReplayRows()
  } else if (!s.running) {
    setNowPlaying(null)
    markActiveReplayRows()
  }
  if (!$('logPanel').hidden) {
    $('log').textContent = (s.log || []).join('\n')
  }
  return s
}

async function selectReplay (fileName) {
  const base = fileName.replace(/\.mcreplay(\.gz)?$/i, '')
  try {
    const res = await api('/api/replays/play', {
      method: 'POST',
      body: JSON.stringify({ name: fileName })
    })
    setNowPlaying(res.activeBase || base)
    markActiveReplayRows()
    await refreshStatus()
  } catch (e) {
    alert(e.message)
  }
}

async function loadReplays () {
  const ul = $('replayList')
  try {
    const data = await api('/api/replays')
    ul.innerHTML = ''
    const list = data.replays || []
    const hint = $('replaysHint')
    if (data.dir) {
      hint.hidden = false
      hint.textContent = 'Папка: ' + shortPath(data.dir)
      hint.title = data.dir
    } else {
      hint.hidden = true
      hint.textContent = ''
    }
    for (const r of list) {
      const base = r.name.replace(/\.mcreplay(\.gz)?$/i, '')
      const li = document.createElement('li')
      li.className = 'replay-item'
      li.dataset.base = base
      li.dataset.name = r.name
      if (r.version) li.dataset.version = r.version
      if (activeReplayBase && activeReplayBase === base) li.classList.add('active')
      const name = document.createElement('div')
      name.className = 'replay-name'
      name.textContent = base
      const meta = document.createElement('div')
      meta.className = 'replay-meta'
      const bits = []
      bits.push(r.version ? ('v' + r.version) : 'версия ?')
      const dur = formatDuration(r.durationMs)
      if (dur) bits.push(dur)
      bits.push(formatSize(r.size))
      bits.push(formatWhen(r.mtime))
      meta.textContent = bits.join(' · ')
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'replay-del'
      del.textContent = 'Удалить'
      del.onclick = async (ev) => {
        ev.stopPropagation()
        if (!confirm('Удалить ' + r.name + '?')) return
        try {
          await api('/api/replays/delete', {
            method: 'POST',
            body: JSON.stringify({ name: r.name })
          })
          if (activeReplayBase === base) setNowPlaying(null)
          await loadReplays()
        } catch (e) {
          alert(e.message)
        }
      }
      const ren = document.createElement('button')
      ren.type = 'button'
      ren.className = 'replay-ren'
      ren.textContent = 'Имя'
      ren.onclick = (ev) => {
        ev.stopPropagation()
        openRenameSheet(r.name, base)
      }
      const actions = document.createElement('div')
      actions.className = 'replay-actions'
      actions.appendChild(ren)
      actions.appendChild(del)
      li.onclick = () => { selectReplay(r.name).catch(() => {}) }
      li.appendChild(name)
      li.appendChild(actions)
      li.appendChild(meta)
      ul.appendChild(li)
    }
  } catch (e) {
    ul.innerHTML = ''
    const li = document.createElement('li')
    li.className = 'replay-item'
    li.textContent = 'Не удалось загрузить: ' + (e.message || e)
    ul.appendChild(li)
  }
}

function setVersionValue (v) {
  const input = $('version')
  input.value = v || ''
  $('versionBtnText').textContent = v || '—'
  const e = findEntry(v)
  const dot = $('versionBtnDot')
  if (!v) {
    dot.hidden = true
  } else {
    dot.hidden = false
    const ok = e ? (e.stable && !e.noPossess) : false
    dot.className = ok ? 'ver-dot' : 'ver-dot warn'
  }
  const hint = $('versionWarnHint')
  const msg = tWarn(e)
  hint.hidden = !msg
  hint.textContent = msg || ''
  for (const li of $('versionMenu').querySelectorAll('li')) {
    li.setAttribute('aria-selected', li.dataset.value === v ? 'true' : 'false')
  }
}

function fillVersionMenu (selected) {
  const menu = $('versionMenu')
  menu.innerHTML = ''
  const source = activeEntries()
  let pick = selected
  if (pick && !source.some((e) => e.value === pick)) {
    const e = findEntry(pick)
    if (e?.base && source.some((x) => x.value === e.base)) pick = e.base
    else if (source.length) pick = source[0].value
    else pick = ''
  }
  for (const e of source) {
    const li = document.createElement('li')
    li.role = 'option'
    li.dataset.value = e.value
    const warn = e.noPossess || !e.stable
    const dot = document.createElement('span')
    dot.className = warn ? 'ver-dot warn' : 'ver-dot'
    dot.setAttribute('aria-hidden', 'true')
    li.appendChild(dot)
    const lab = document.createElement('span')
    lab.textContent = e.value
    li.appendChild(lab)
    const msg = tWarn(e)
    if (msg) li.title = `${e.value} · ${msg}`
    else li.title = e.value
    li.onclick = () => {
      setVersionValue(e.value)
      closeVersionMenu()
    }
    menu.appendChild(li)
  }
  setVersionValue(pick || (source[0] && source[0].value) || '')
}

function closeVersionMenu () {
  $('versionSheet').hidden = true
  $('versionPicker').classList.remove('open')
  $('versionBtn').setAttribute('aria-expanded', 'false')
}

let renameTargetName = null
let renameTargetBase = null

function openRenameSheet (fileName, base) {
  renameTargetName = fileName
  renameTargetBase = base
  const input = $('renameInput')
  input.value = base
  const sheet = $('renameSheet')
  sheet.hidden = false
  sheet.classList.add('rename-open')
  syncKeyboardInset()
  setTimeout(() => {
    input.focus()
    input.select()
    syncKeyboardInset()
    try { input.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch {}
  }, 80)
}

function closeRenameSheet () {
  $('renameSheet').hidden = true
  $('renameSheet').classList.remove('rename-open')
  document.documentElement.style.setProperty('--kb-inset', '0px')
  renameTargetName = null
  renameTargetBase = null
}

function syncKeyboardInset () {
  try {
    const vv = window.visualViewport
    if (!vv) {
      document.documentElement.style.setProperty('--kb-inset', '0px')
      return
    }
    const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
    document.documentElement.style.setProperty('--kb-inset', covered + 'px')
  } catch {
    document.documentElement.style.setProperty('--kb-inset', '0px')
  }
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncKeyboardInset)
  window.visualViewport.addEventListener('scroll', syncKeyboardInset)
}
window.addEventListener('resize', syncKeyboardInset)

async function submitRename () {
  const name = renameTargetName
  const oldBase = renameTargetBase
  if (!name) return
  const trimmed = String($('renameInput').value || '').trim()
  if (!trimmed) {
    alert('Введи имя')
    return
  }
  if (trimmed === oldBase) {
    closeRenameSheet()
    return
  }
  try {
    const res = await api('/api/replays/rename', {
      method: 'POST',
      body: JSON.stringify({ name, newName: trimmed })
    })
    if (activeReplayBase === oldBase) setNowPlaying(res.base || trimmed)
    closeRenameSheet()
    await loadReplays()
  } catch (e) {
    alert(e.message)
  }
}

function openVersionMenu () {
  $('versionSheet').hidden = false
  $('versionPicker').classList.add('open')
  $('versionBtn').setAttribute('aria-expanded', 'true')
  const selected = $('versionMenu').querySelector('li[aria-selected="true"]')
  if (selected) selected.scrollIntoView({ block: 'nearest' })
}

function readParamsFromForm () {
  return {
    version: $('version').value.trim(),
    destination: {
      host: $('destHost').value.trim(),
      port: numOr($('destPort'), 19132)
    },
    advertiseHost: '127.0.0.1',
    controlHotbar: false,
    autoRecord: !!$('cfgAutoRecord').checked,
    saveOnDisconnect: !!$('cfgSaveOnDisconnect').checked,
    showPlayerNames: !!$('cfgShowPlayerNames').checked,
    playShowChat: !!$('cfgPlayShowChat').checked,
    playShowSidebar: !!$('cfgPlayShowSidebar').checked,
    playSounds: !!$('cfgPlaySounds').checked,
    overlayControls: !!$('cfgOverlayControls').checked,
    pauseOnSeek: !!$('cfgPauseOnSeek').checked,
    recordChat: true,
    livePort: numOr($('cfgLivePort'), 19132),
    playPort: numOr($('cfgPlayPort'), 19133)
  }
}

function applyParamsToForm (c) {
  $('destHost').value = c.destination?.host || ''
  $('destPort').value = c.destination?.port ?? 19132
  $('cfgAutoRecord').checked = !!c.autoRecord
  $('cfgSaveOnDisconnect').checked = c.saveOnDisconnect !== false
  $('cfgShowPlayerNames').checked = c.showPlayerNames !== false
  $('cfgPlayShowChat').checked = !!c.playShowChat
  $('cfgPlayShowSidebar').checked = !!c.playShowSidebar
  $('cfgPlaySounds').checked = c.playSounds !== false
  $('cfgOverlayControls').checked = c.overlayControls !== false
  $('cfgPauseOnSeek').checked = !!(c.pauseOnSeek || c.seekPaused || c.restartPaused)
  $('cfgLivePort').value = c.livePort ?? 19132
  $('cfgPlayPort').value = c.playPort ?? 19133
}

async function saveConfig () {
  const body = readParamsFromForm()
  await api('/api/config', {
    method: 'POST',
    body: JSON.stringify(body)
  })
  try {
    if (window.BsrBridge) {
      if (body.overlayControls) window.BsrBridge.enableOverlay()
      else window.BsrBridge.disableOverlay()
    }
  } catch {}
}

async function loadConfig () {
  const c = await api('/api/config')
  applyParamsToForm(c)
  try {
    const v = await api('/api/versions')
    allEntries = Array.isArray(v.entries) ? v.entries : []
  } catch {
    allEntries = []
  }
  try {
    versionExtended = localStorage.getItem(LS_EXT) === '1'
  } catch {}
  $('chkVersionExtended').checked = versionExtended
  fillVersionMenu(c.version || '')
}

function setPanel (panel, btn, open) {
  panel.hidden = !open
  btn.setAttribute('aria-expanded', open ? 'true' : 'false')
}

$('btnToggleConfig').onclick = () => {
  const open = $('configPanel').hidden
  setPanel($('configPanel'), $('btnToggleConfig'), open)
}

$('btnToggleLog').onclick = async () => {
  const open = $('logPanel').hidden
  setPanel($('logPanel'), $('btnToggleLog'), open)
  if (open) {
    try {
      const s = await api('/api/status')
      $('log').textContent = (s.log || []).join('\n')
    } catch (e) {
      $('log').textContent = String(e.message || e)
    }
  }
}

$('versionBtn').onclick = (ev) => {
  ev.stopPropagation()
  if ($('versionSheet').hidden) openVersionMenu()
  else closeVersionMenu()
}

$('versionSheetBackdrop').onclick = () => closeVersionMenu()

$('renameSheetBackdrop').onclick = () => closeRenameSheet()
$('btnRenameCancel').onclick = () => closeRenameSheet()
$('btnRenameOk').onclick = () => { submitRename().catch(() => {}) }
$('renameInput').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault()
    submitRename().catch(() => {})
  } else if (ev.key === 'Escape') {
    closeRenameSheet()
  }
})

$('chkVersionExtended').onchange = () => {
  versionExtended = !!$('chkVersionExtended').checked
  try { localStorage.setItem(LS_EXT, versionExtended ? '1' : '0') } catch {}
  fillVersionMenu($('version').value)
}

$('btnSave').onclick = async () => {
  try {
    await saveConfig()
    await refreshStatus()
  } catch (e) {
    alert(e.message)
  }
}

$('btnStart').onclick = async () => {
  try {
    $('btnStart').disabled = true
    await saveConfig()
    await api('/api/start', { method: 'POST', body: '{}' })
    await refreshStatus()
    try {
      if (window.BsrBridge && $('cfgOverlayControls').checked) {
        window.BsrBridge.enableOverlay()
      }
    } catch {}
  } catch (e) {
    alert(e.message)
    await refreshStatus().catch(() => {})
  } finally {
    $('btnStart').disabled = false
  }
}

$('btnStop').onclick = async () => {
  try {
    $('btnStop').disabled = true
    await api('/api/stop', { method: 'POST', body: '{}' })
    setPill('off', t('statusOff'))
    setNowPlaying(null)
    await refreshStatus()
    await loadReplays()
  } catch (e) {
    alert(e.message)
  } finally {
    $('btnStop').disabled = false
  }
}

$('btnRefreshReplays').onclick = () => { loadReplays().catch(() => {}) }

applyI18n()
setPill('off', t('statusOff'))
loadConfig()
  .then(refreshStatus)
  .then(loadReplays)
  .catch((e) => {
    setPill('off', t('statusOffline'))
    $('log').textContent = String(e.message || e)
  })
setInterval(() => {
  refreshStatus().catch(() => {})
}, 2000)
setInterval(() => {
  if (document.visibilityState === 'visible') loadReplays().catch(() => {})
}, 8000)
