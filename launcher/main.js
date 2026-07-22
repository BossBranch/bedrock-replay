const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const zlib = require('zlib')
const http = require('http')
const { spawn } = require('child_process')

const PACKAGED = app.isPackaged

function readAppVersion () {
  try {
    return require('./package.json').version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const APP_VERSION = readAppVersion()

/** Hub code + node_modules (dev: repo root; install: resources/hub) */
const HUB_ROOT = PACKAGED
  ? path.join(process.resourcesPath, 'hub')
  : path.resolve(__dirname, '..')

/** Writable config / replays (dev: repo root; install: %APPDATA%/BedrockServerReplay) */
const DATA_ROOT = PACKAGED
  ? path.join(app.getPath('appData'), 'BedrockServerReplay')
  : HUB_ROOT

/** @deprecated use HUB_ROOT / DATA_ROOT — kept for get-state display */
const ROOT = DATA_ROOT

const CONFIG_PATH = path.join(DATA_ROOT, 'config.json')
const CONFIG_EXAMPLE = path.join(HUB_ROOT, 'config.example.json')
const REPLAYS_DIR = path.join(DATA_ROOT, 'replays')
/** Easy-to-find logs for support: %APPDATA%\BedrockServerReplay\logs */
const LOGS_DIR = path.join(DATA_ROOT, 'logs')
const CRASH_LOG = path.join(LOGS_DIR, 'launcher.log')
/** Theme / language — launcher UI only */
const UI_PREFS_PATH = path.join(DATA_ROOT, 'ui-prefs.json')

function readUiPrefs () {
  try {
    const raw = JSON.parse(fs.readFileSync(UI_PREFS_PATH, 'utf8'))
    return {
      theme: raw.theme === 'dark' ? 'dark' : 'light',
      lang: raw.lang === 'en' ? 'en' : 'ru',
      /** Opt-in: LAN IP in LIVE/PLAY only when phone join is enabled */
      phoneLan: raw.phoneLan === true
    }
  } catch {
    return { theme: 'light', lang: 'ru', phoneLan: false }
  }
}

function writeUiPrefs (partial = {}) {
  const cur = readUiPrefs()
  const next = {
    theme: partial.theme === 'dark' || partial.theme === 'light' ? partial.theme : cur.theme,
    lang: partial.lang === 'en' || partial.lang === 'ru' ? partial.lang : cur.lang,
    phoneLan: typeof partial.phoneLan === 'boolean' ? partial.phoneLan : cur.phoneLan
  }
  try {
    fs.mkdirSync(DATA_ROOT, { recursive: true })
    fs.writeFileSync(UI_PREFS_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8')
  } catch (e) {
    crashLog('writeUiPrefs: ' + (e && e.message))
  }
  return next
}

function ensureLogsDir () {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    const tip = path.join(LOGS_DIR, 'README.txt')
    if (!fs.existsSync(tip)) {
      fs.writeFileSync(
        tip,
        'Логи лаунчера и хаба.\n' +
          'Если что-то сломалось — скинь файлы из этой папки.\n' +
          'launcher.log — лаунчер\n' +
          'hub-ГГГГ-ММ-ДД.log — вывод хаба за день\n',
        'utf8'
      )
    }
  } catch {}
}

function crashLog (msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    if (PACKAGED) fs.mkdirSync(DATA_ROOT, { recursive: true })
    ensureLogsDir()
    fs.appendFileSync(CRASH_LOG, line, 'utf8')
  } catch {}
  try { console.error(msg) } catch {}
}

function appendHubFileLog (line) {
  try {
    ensureLogsDir()
    const day = new Date().toISOString().slice(0, 10)
    fs.appendFileSync(path.join(LOGS_DIR, `hub-${day}.log`), `${line}\n`, 'utf8')
  } catch {}
}

process.on('uncaughtException', (err) => {
  crashLog('uncaughtException: ' + (err && err.stack ? err.stack : err))
})
process.on('unhandledRejection', (err) => {
  crashLog('unhandledRejection: ' + (err && err.stack ? err.stack : err))
})

// Cyrillic paths / weak GPU drivers often kill the window instantly on Windows
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-software-rasterizer')

// One launcher window only — second start focuses the first
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

let mainWindow = null
/** @type {import('child_process').ChildProcess | null} */
let hubProc = null
let hubRunning = false
/** @type {string | null} basename without .mcreplay.gz */
let pendingActiveBase = null

function send (channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function appendLog (line) {
  send('hub:log', { line: String(line).replace(/\r/g, '') })
}

function ensureConfig () {
  try { fs.mkdirSync(DATA_ROOT, { recursive: true }) } catch {}
  try { fs.mkdirSync(REPLAYS_DIR, { recursive: true }) } catch {}
  ensureLogsDir()
  if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(CONFIG_EXAMPLE)) {
    fs.copyFileSync(CONFIG_EXAMPLE, CONFIG_PATH)
  }
}

function readConfig () {
  ensureConfig()
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
  return JSON.parse(raw)
}

function writeConfig (partial) {
  const cfg = readConfig()
  if (partial.destination) {
    cfg.destination = { ...cfg.destination, ...partial.destination }
    delete partial.destination
  }
  Object.assign(cfg, partial)
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  return cfg
}

const SKIP_IFACE_RE = /virtual|vmware|vbox|hyper-v|vethernet|docker|wsl|loopback|bluetooth|isatap|teredo|vpn|tailscale|hamachi|radmin|npcap/i

function isPrivateIpv4 (ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''))
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

function isDefaultAdvertiseHost (host) {
  const h = String(host || '').trim().toLowerCase()
  return !h || h === '127.0.0.1' || h === 'localhost' || h === '0.0.0.0' || h === 'auto' || h === '::1'
}

function lanIpScore (ip, ifaceName) {
  const m = /^(\d{1,3})\.(\d{1,3})\./.exec(ip)
  if (!m) return 0
  const a = Number(m[1])
  const b = Number(m[2])
  let score = 0
  if (a === 192 && b === 168) score = 300
  else if (a === 10) score = 200
  else if (a === 172 && b >= 16 && b <= 31) score = 150
  else return 0
  const name = String(ifaceName || '')
  if (/wi-?fi|wlan|wireless|беспровод/i.test(name)) score += 40
  else if (/ethernet|eth|lan|локал/i.test(name)) score += 20
  if (SKIP_IFACE_RE.test(name)) score -= 500
  return score
}

/** Local IPv4 addresses suitable for phone↔PC on the same LAN. */
function listLanIpv4 () {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const [name, list] of Object.entries(ifaces || {})) {
    if (!list) continue
    for (const info of list) {
      if (info.family !== 'IPv4' && info.family !== 4) continue
      if (info.internal) continue
      const ip = info.address
      if (!ip || ip.startsWith('169.254.')) continue
      if (!isPrivateIpv4(ip)) continue
      const score = lanIpScore(ip, name)
      if (score <= 0) continue
      out.push({ ip, name, score })
    }
  }
  out.sort((a, b) => b.score - a.score || a.ip.localeCompare(b.ip))
  return out
}

function pickLanIpv4 () {
  const list = listLanIpv4()
  return list[0]?.ip || null
}

/** @type {boolean|null} last known LAN availability (for one-shot log on change) */
let lastLanOk = null

function phoneLanEnabled () {
  return !!readUiPrefs().phoneLan
}

/** Host shown in LIVE/PLAY and written to advertiseHost for the hub. */
function resolveAdvertiseHost (cfg) {
  if (!phoneLanEnabled()) return '127.0.0.1'
  const lan = pickLanIpv4()
  if (lan) return lan
  const cur = String(cfg?.advertiseHost || cfg?.publicHost || '').trim()
  if (cur && !isDefaultAdvertiseHost(cur) && isPrivateIpv4(cur)) return cur
  return '127.0.0.1'
}

function getLanStatus (cfg) {
  const ip = pickLanIpv4()
  const host = resolveAdvertiseHost(cfg)
  const ok = !!ip
  let issue = null
  if (!phoneLanEnabled()) {
    issue = null
  } else if (!ok) {
    issue = 'no_lan'
  } else if (host && isPrivateIpv4(host) && host !== ip && !listLanIpv4().some((x) => x.ip === host)) {
    issue = 'stale'
  }
  return { ok, ip, host, issue, phoneLan: phoneLanEnabled() }
}

function noteLanStatusChange (lan) {
  if (!lan) return
  if (lastLanOk === null) {
    lastLanOk = lan.ok
    return
  }
  if (lan.ok === lastLanOk) return
  lastLanOk = lan.ok
  try {
    if (!lan.ok) {
      appendLog('[launcher] Нет локальной сети (Wi‑Fi/LAN выключен?) — со смартфона сейчас не подключиться')
    } else {
      appendLog(`[launcher] Локальная сеть снова есть · LAN IP: ${lan.ip}`)
    }
  } catch {}
}

/**
 * Sync advertiseHost with phone-LAN mode:
 * - phone off → always 127.0.0.1 (PC-local)
 * - phone on → LAN IP (auto / refresh if stale)
 */
function syncAdvertiseHost (cfg, { persist = true, log = false } = {}) {
  if (!cfg) return cfg
  const current = String(cfg.advertiseHost || cfg.publicHost || '').trim()
  let next

  if (!phoneLanEnabled()) {
    next = '127.0.0.1'
  } else {
    const detected = pickLanIpv4()
    if (!detected) return cfg
    const localIps = new Set(listLanIpv4().map((x) => x.ip))
    if (isDefaultAdvertiseHost(current) || (!localIps.has(current) && isPrivateIpv4(current))) {
      next = detected
    } else if (localIps.has(current)) {
      next = current
    } else {
      next = detected
    }
  }

  if (!next || next === current) return cfg
  if (!persist) {
    cfg.advertiseHost = next
    return cfg
  }
  const updated = writeConfig({ advertiseHost: next })
  try {
    if (log || hubRunning) {
      if (next === '127.0.0.1') {
        appendLog('[launcher] Режим ПК: LIVE/PLAY → 127.0.0.1')
      } else {
        appendLog(`[launcher] Режим смартфона: LIVE/PLAY → ${next}${current ? ` (было ${current})` : ''}`)
      }
    }
    if (hubRunning && !log) {
      appendLog('[launcher] IP сменился — перезапустите сервер, чтобы адрес обновился')
    }
  } catch {}
  return updated
}

/** Peek first NDJSON header line from .mcreplay.gz (version, title, …). */
function peekReplayHeader (filePath) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      resolve(v)
    }

    const input = fs.createReadStream(filePath)
    const gunzip = zlib.createGunzip()
    let buf = ''

    const onError = () => done(null)
    input.on('error', onError)
    gunzip.on('error', onError)

    input.pipe(gunzip)
    gunzip.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl === -1) {
        if (buf.length > 256 * 1024) {
          input.destroy()
          gunzip.destroy()
          done(null)
        }
        return
      }
      input.destroy()
      gunzip.destroy()
      try {
        const row = JSON.parse(buf.slice(0, nl))
        done(row && row.type === 'header' ? row : null)
      } catch {
        done(null)
      }
    })
    gunzip.on('end', () => done(null))
  })
}

function sidecarMetaPath (filePath) {
  return String(filePath || '').replace(/\.mcreplay\.gz$/i, '').replace(/\.mcreplay$/i, '') + '.meta.json'
}

function readSidecarMeta (filePath) {
  try {
    const p = sidecarMetaPath(filePath)
    if (!fs.existsSync(p)) return null
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

/**
 * Prefer sidecar .meta.json (fast). Else one-pass peek header + footer duration.
 * @returns {Promise<{ header: object|null, durationMs: number|null }>}
 */
async function peekReplayMeta (filePath) {
  const side = readSidecarMeta(filePath)
  if (side && typeof side.durationMs === 'number' && Number.isFinite(side.durationMs)) {
    return {
      header: side.version != null ? { version: side.version } : null,
      durationMs: side.durationMs
    }
  }

  return new Promise((resolve) => {
    let settled = false
    /** @type {object|null} */
    let header = null
    let lastLine = ''
    let buf = ''

    const done = (durationMs) => {
      if (settled) return
      settled = true
      try { input.destroy() } catch {}
      try { gunzip.destroy() } catch {}
      resolve({ header, durationMs: durationMs ?? null })
    }

    const input = fs.createReadStream(filePath)
    const gunzip = zlib.createGunzip()
    const onError = () => done(null)
    input.on('error', onError)
    gunzip.on('error', onError)

    input.pipe(gunzip)
    gunzip.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        lastLine = line
        if (!header) {
          try {
            const row = JSON.parse(line)
            if (row && row.type === 'header') header = row
          } catch {}
        }
      }
    })
    gunzip.on('end', () => {
      const tail = (lastLine || buf.trim())
      let durationMs = null
      if (tail) {
        try {
          const row = JSON.parse(tail)
          if (row && row.type === 'footer') {
            if (typeof row.durationMs === 'number' && Number.isFinite(row.durationMs)) {
              durationMs = row.durationMs
            } else if (typeof row.t === 'number' && Number.isFinite(row.t)) {
              durationMs = row.t
            }
          }
        } catch {}
      }
      done(durationMs)
    })
  })
}

async function listReplays () {
  if (!fs.existsSync(REPLAYS_DIR)) return []
  const names = fs.readdirSync(REPLAYS_DIR)
    .filter((f) => f.endsWith('.mcreplay.gz') && !f.startsWith('_'))

  const rows = await Promise.all(names.map(async (name) => {
    const full = path.join(REPLAYS_DIR, name)
    const st = fs.statSync(full)
    const meta = await peekReplayMeta(full)
    const header = meta?.header
    return {
      name,
      base: name.replace(/\.mcreplay\.gz$/i, ''),
      size: st.size,
      mtime: st.mtime.toISOString(),
      version: header?.version ? String(header.version) : null,
      durationMs: meta?.durationMs != null ? Number(meta.durationMs) : null
    }
  }))

  rows.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
  return rows
}

/** Spectator shipped in Bedrock 1.19.50 — possess (.me/.spec) from here. */
const SPECTATOR_SINCE = '1.19.50'
/** Oldest freecam floor (minecraft-data); below spectator = yellow, no possess. */
const FREECAM_SINCE = '1.16.201'

function compareSemver (a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1
    if ((pa[i] || 0) > (pb[i] || 0)) return 1
  }
  return 0
}

function normalizeVer (v) {
  if (!v) return null
  const m = String(v).trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!m) return null
  return `${m[1]}.${m[2]}.${m[3] || '0'}`
}

function resolveToSupportedVer (wanted, supportedList) {
  const v = normalizeVer(wanted)
  if (!v) return null
  const list = (Array.isArray(supportedList) ? supportedList : listLauncherVersions())
    .slice()
    .sort(compareSemver)
  if (list.includes(v)) return v
  const [maj, min] = v.split('.').map((x) => parseInt(x, 10) || 0)
  const same = list.filter((x) => {
    const p = x.split('.').map((n) => parseInt(n, 10) || 0)
    return p[0] === maj && p[1] === min
  })
  const pool = same.length ? same : list
  // Floor: highest supported ≤ client — never map to a newer protocol pack
  const floor = pool.filter((c) => compareSemver(c, v) <= 0)
  if (floor.length) return floor[floor.length - 1]
  const above = pool.filter((c) => compareSemver(c, v) > 0)
  return above[0] || null
}

function protocolIdForVer (v) {
  const ver = normalizeVer(v)
  if (!ver) return null
  const base = resolveToSupportedVer(ver)
  if (!base) return null
  try {
    const mcData = require(path.join(HUB_ROOT, 'node_modules', 'minecraft-data'))
    const d = mcData('bedrock_' + base)
    const id = d?.version?.version
    return Number.isFinite(Number(id)) ? Number(id) : null
  } catch {
    return null
  }
}

/**
 * Extended client versions (wiki releases) + protocol base.
 * Skips "unreliable" where wiki protocol ≠ our floor base.
 * Includes freecam range 1.16.201–1.19.40 (only shown when extended is on).
 * Default/stable UI list is listStableLauncherVersions() (≥ 1.19.50).
 */
function listClientVersionEntries () {
  const bases = listProtocolBases()
  let clients = []
  /** @type {Set<string>} */
  let unreliable = new Set()
  try {
    const file = path.join(HUB_ROOT, 'data', 'bedrock-client-versions.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    clients = Array.isArray(raw.versions) ? raw.versions : []
    unreliable = new Set((raw.unreliable || []).map(normalizeVer).filter(Boolean))
  } catch (e) {
    crashLog('listClientVersionEntries: ' + (e && e.message))
    clients = bases
  }

  /** @type {{ value: string, base: string, stable: boolean, noPossess: boolean }[]} */
  const entries = []
  const seen = new Set()
  for (const c of clients) {
    const v = normalizeVer(c)
    if (!v || seen.has(v)) continue
    if (compareSemver(v, FREECAM_SINCE) < 0) continue
    if (unreliable.has(v)) continue
    const base = resolveToSupportedVer(v, bases)
    if (!base) continue
    seen.add(v)
    const noPossess = compareSemver(v, SPECTATOR_SINCE) < 0
    entries.push({ value: v, base, stable: v === base && !noPossess, noPossess })
  }
  for (const b of bases) {
    if (seen.has(b)) continue
    seen.add(b)
    const noPossess = compareSemver(b, SPECTATOR_SINCE) < 0
    entries.push({ value: b, base: b, stable: !noPossess, noPossess })
  }
  entries.sort((a, b) => compareSemver(b.value, a.value))
  return entries
}

/** Same label or same Bedrock protocol id (adjacent patches). */
function versionsCompatible (a, b) {
  const va = normalizeVer(a)
  const vb = normalizeVer(b)
  if (!va || !vb) return false
  if (va === vb) return true
  const ba = resolveToSupportedVer(va)
  const bb = resolveToSupportedVer(vb)
  if (ba && bb && ba === bb) return true
  const pa = protocolIdForVer(va)
  const pb = protocolIdForVer(vb)
  return pa != null && pb != null && pa === pb
}

/**
 * All protocol bases this install can run (≥ 1.16.201).
 * Used for floor mapping; freecam bases are not in the default UI list.
 */
function listProtocolBases () {
  try {
    const mcData = require(path.join(HUB_ROOT, 'node_modules', 'minecraft-data'))
    const { Versions } = require(path.join(HUB_ROOT, 'node_modules', 'bedrock-protocol', 'src', 'options'))
    const fromBp = Object.keys(Versions || {})
      .map(normalizeVer)
      .filter(Boolean)
      .filter((v) => compareSemver(v, FREECAM_SINCE) >= 0)

    const versions = []
    for (const v of fromBp) {
      try {
        const d = mcData('bedrock_' + v)
        if (d && d.protocol) versions.push(v)
      } catch {}
    }
    const uniq = [...new Set(versions)]
    uniq.sort((a, b) => compareSemver(b, a)) // newest first
    if (!uniq.length) throw new Error('empty version list')
    return uniq
  } catch (e) {
    crashLog('listProtocolBases: ' + e.message)
    return [
      '1.21.100', '1.21.90', '1.21.80', '1.21.70', '1.21.50', '1.21.30', '1.21.0',
      '1.20.80', '1.19.80', '1.19.50', '1.19.40', '1.18.30', '1.17.40', '1.16.220', '1.16.201'
    ]
  }
}

/** Default picker: spectator-capable protocol bases only (≥ 1.19.50). */
function listStableLauncherVersions () {
  return listProtocolBases().filter((v) => compareSemver(v, SPECTATOR_SINCE) >= 0)
}

/** @deprecated alias — full protocol bases for floor / compatibility checks */
function listLauncherVersions () {
  return listProtocolBases()
}

function findNode () {
  if (process.env.BEDROCK_REPLAY_NODE) return process.env.BEDROCK_REPLAY_NODE
  // Packaged: run hub with Electron as Node (no system Node required)
  if (PACKAGED) return process.execPath
  return 'node'
}

function hubEnv () {
  const env = {
    ...process.env,
    FORCE_COLOR: '0',
    BEDROCK_REPLAY_ROOT: HUB_ROOT,
    BEDROCK_REPLAY_DATA: DATA_ROOT
  }
  if (PACKAGED) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

function controlBaseUrl () {
  try {
    const cfg = readConfig()
    const port = Number(cfg.controlPort ?? 18765)
    return `http://127.0.0.1:${port}`
  } catch {
    return 'http://127.0.0.1:18765'
  }
}

function httpJson (method, urlPath, body) {
  return new Promise((resolve) => {
    const base = new URL(controlBaseUrl())
    const payload = body != null ? JSON.stringify(body) : null
    const req = http.request({
      hostname: base.hostname,
      port: base.port,
      path: urlPath,
      method,
      timeout: 2500,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : undefined
    }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(raw || '{}') })
        } catch {
          resolve({ ok: false, status: res.statusCode, data: null })
        }
      })
    })
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }) })
    req.on('error', (e) => resolve({ ok: false, error: e.message }))
    if (payload) req.write(payload)
    req.end()
  })
}

function startHub (fileBase) {
  if (hubProc) return { ok: false, error: 'already_running' }

  ensureConfig()
  try {
    syncAdvertiseHost(readConfig(), { persist: true, log: true })
  } catch {}
  const node = findNode()
  const script = path.join(HUB_ROOT, 'src', 'cli.js')
  if (!fs.existsSync(script)) {
    return { ok: false, error: 'cli_missing' }
  }

  const args = [script, 'start']
  if (fileBase) {
    args.push('--file', String(fileBase))
    pendingActiveBase = String(fileBase).replace(/\.mcreplay\.gz$/i, '')
  } else {
    pendingActiveBase = null
  }

  appendLog(`[launcher] Starting hub: ${PACKAGED ? 'electron-as-node' : node} src/cli.js start${fileBase ? ` --file ${pendingActiveBase}` : ''}`)
  appendLog(`[launcher] hub=${HUB_ROOT}`)
  appendLog(`[launcher] data=${DATA_ROOT}`)

  hubProc = spawn(node, args, {
    cwd: DATA_ROOT,
    env: hubEnv(),
    windowsHide: true
  })
  hubRunning = true
  send('hub:status', { running: true, activeBase: pendingActiveBase })

  const onData = (buf) => {
    const text = buf.toString('utf8')
    for (const line of text.split(/\n/)) {
      if (!line.trim()) continue
      appendLog(line)
      appendHubFileLog(line)
      // Keep launcher "Сейчас играет" in sync with in-game .play / file switches
      const mActive = line.match(/\[play\] active file(?:\s*[→=]\s*|\s+)(.+)$/i)
      const mHubPlay = line.match(/\[hub\] \.play\s*→\s*in-place\s+(.+)$/i)
      const mReady = line.match(/\[play\] ready duration=/i)
      const pathHit = mActive?.[1] || mHubPlay?.[1]
      if (pathHit) {
        const base = path.basename(pathHit.trim()).replace(/\.mcreplay\.gz$/i, '')
        pendingActiveBase = base
        send('hub:play', { activeBase: base, status: 'готов', refreshList: true })
      } else if (mReady) {
        send('hub:play', { activeBase: pendingActiveBase, status: 'playing' })
      }
    }
  }
  hubProc.stdout?.on('data', onData)
  hubProc.stderr?.on('data', onData)

  hubProc.on('exit', (code, signal) => {
    appendLog(`[launcher] Hub stopped (code=${code} signal=${signal || '-'})`)
    hubProc = null
    hubRunning = false
    pendingActiveBase = null
    send('hub:status', { running: false, code, activeBase: null })
  })

  hubProc.on('error', (err) => {
    appendLog(`[launcher] Hub error: ${err.message}`)
    hubProc = null
    hubRunning = false
    pendingActiveBase = null
    send('hub:status', { running: false, error: err.message, activeBase: null })
  })

  return { ok: true, activeBase: pendingActiveBase }
}

function stopHub () {
  if (!hubProc) {
    hubRunning = false
    pendingActiveBase = null
    send('hub:status', { running: false, activeBase: null })
    return { ok: true }
  }
  appendLog('[launcher] Stopping hub…')
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(hubProc.pid), '/T', '/F'], { windowsHide: true })
    } else {
      hubProc.kill('SIGTERM')
    }
  } catch (e) {
    appendLog(`[launcher] stop failed: ${e.message}`)
  }
  return { ok: true }
}

async function playReplay (base) {
  const clean = String(base || '').replace(/\.mcreplay\.gz$/i, '').trim()
  if (!clean) return { ok: false, error: 'empty' }

  const full = path.join(REPLAYS_DIR, `${clean}.mcreplay.gz`)
  if (!fs.existsSync(full)) return { ok: false, error: 'not_found' }

  let cfgVersion = null
  let fileVersion = null
  try {
    cfgVersion = normalizeVer(readConfig().version)
    const header = await peekReplayHeader(full)
    fileVersion = header?.version ? normalizeVer(header.version) : null
  } catch {}

  const mismatch = !!(fileVersion && cfgVersion && !versionsCompatible(fileVersion, cfgVersion))

  if (mismatch) {
    const error =
      `Версия не совпадает: запись ${fileVersion}, в настройках ${cfgVersion}. ` +
      `Поставь в настройках ${fileVersion} и запусти снова.`
    appendLog(`[launcher] ${error}`)
    return { ok: false, error, mismatch: true, fileVersion, cfgVersion }
  }
  if (fileVersion && cfgVersion && fileVersion !== cfgVersion) {
    appendLog(`[launcher] Версии ${fileVersion} ~ ${cfgVersion} (один protocol) — OK`)
  }

  if (!hubProc) {
    const res = startHub(clean)
    if (res.ok) {
      appendLog(`[launcher] Запуск с реплеем: ${clean}`)
    }
    return { ...res, mismatch: false, fileVersion, cfgVersion }
  }

  const r = await httpJson('POST', '/api/active-file', { file: clean })
  if (!r.ok) {
    appendLog(`[launcher] Не удалось выбрать реплей: ${r.error || r.data?.error || r.status}`)
    return { ok: false, error: r.error || r.data?.error || 'control_api', mismatch: false, fileVersion, cfgVersion }
  }
  pendingActiveBase = clean
  appendLog(`[launcher] Активный реплей → ${clean}`)
  send('hub:status', { running: true, activeBase: clean })
  return { ok: true, activeBase: clean, mismatch: false, fileVersion, cfgVersion, state: r.data }
}

async function fetchPlayState () {
  if (!hubRunning) {
    return { ok: true, running: false, fileName: null, status: 'idle', activeBase: null }
  }
  const r = await httpJson('GET', '/api/state')
  if (!r.ok || !r.data) {
    return {
      ok: false,
      running: true,
      fileName: pendingActiveBase,
      status: 'unknown',
      activeBase: pendingActiveBase
    }
  }
  const fileName = r.data.fileName || null
  const base = fileName
    ? String(fileName).replace(/\.mcreplay\.gz$/i, '')
    : pendingActiveBase
  if (base) pendingActiveBase = base
  return {
    ok: true,
    running: true,
    fileName,
    status: r.data.status || 'idle',
    paused: !!r.data.paused,
    t: r.data.t ?? 0,
    durationMs: r.data.durationMs ?? 0,
    activeBase: base
  }
}

function createWindow () {
  const iconPath = path.join(__dirname, 'assets', 'avatar.png')
  mainWindow = new BrowserWindow({
    width: 980,
    height: 860,
    minWidth: 820,
    minHeight: 640,
    title: `Bedrock Server Replay v${APP_VERSION}`,
    backgroundColor: '#e4e4e4',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  mainWindow.setMenuBarVisibility(false)

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    crashLog('window ready-to-show')
  })

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    crashLog(`did-fail-load ${code} ${desc} ${url}`)
    dialog.showErrorBox('Bedrock Server Replay', `Не удалось открыть UI:\n${desc}\n\nСм. папку logs (launcher.log)`)
  })

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    crashLog('render-process-gone: ' + JSON.stringify(details))
  })

  mainWindow.on('unresponsive', () => crashLog('window unresponsive'))
  mainWindow.on('closed', () => {
    crashLog('window closed')
    mainWindow = null
  })

  const html = path.join(__dirname, 'index.html')
  crashLog('loadFile ' + html)
  mainWindow.loadFile(html).catch((err) => {
    crashLog('loadFile failed: ' + err)
    dialog.showErrorBox('Bedrock Server Replay', String(err))
  })
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return
  if (PACKAGED) {
    try { app.setAppUserModelId('ru.bedrock.serverreplay') } catch {}
  }
  crashLog(`app ready packaged=${PACKAGED} hub=${HUB_ROOT} data=${DATA_ROOT}`)
  try {
    ensureConfig()
    createWindow()
  } catch (err) {
    crashLog('startup failed: ' + (err && err.stack ? err.stack : err))
    dialog.showErrorBox('Bedrock Server Replay', 'Старт лаунчера упал:\n' + err.message + '\n\nСм. папку logs (launcher.log)')
    app.quit()
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((err) => {
  crashLog('whenReady rejected: ' + err)
})

app.on('window-all-closed', () => {
  stopHub()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopHub()
})

// Hard guarantee: closing the launcher kills the hub ports
app.on('will-quit', () => {
  stopHub()
  hubProc = null
  hubRunning = false
})

app.on('child-process-gone', (_e, details) => {
  crashLog('child-process-gone: ' + JSON.stringify(details))
})

ipcMain.handle('get-state', async () => {
  let cfg = null
  let cfgError = null
  try {
    cfg = syncAdvertiseHost(readConfig(), { persist: true, log: false })
  } catch (e) {
    cfgError = e.message
  }
  const playState = await fetchPlayState()
  const lan = getLanStatus(cfg)
  if (phoneLanEnabled()) noteLanStatusChange(lan)
  const host = resolveAdvertiseHost(cfg)
  return {
    root: DATA_ROOT,
    hubRoot: HUB_ROOT,
    logsDir: LOGS_DIR,
    appVersion: APP_VERSION,
    running: hubRunning,
    activeBase: playState.activeBase || pendingActiveBase,
    playState,
    config: cfg,
    configError: cfgError,
    lan,
    versions: listStableLauncherVersions(),
    versionEntries: listClientVersionEntries(),
    replays: await listReplays(),
    live: cfg
      ? {
          host,
          port: Number(cfg.livePort ?? cfg.listenPort ?? 19132)
        }
      : null,
    play: cfg
      ? {
          host,
          port: Number(cfg.playPort ?? 19133)
        }
      : null,
    uiPrefs: readUiPrefs()
  }
})

ipcMain.handle('lan-status', () => {
  let cfg = null
  try {
    cfg = syncAdvertiseHost(readConfig(), { persist: true, log: false })
  } catch {
    try { cfg = readConfig() } catch {}
  }
  const lan = getLanStatus(cfg)
  if (phoneLanEnabled()) noteLanStatusChange(lan)
  return {
    lan,
    advertiseHost: resolveAdvertiseHost(cfg),
    phoneLan: phoneLanEnabled()
  }
})

ipcMain.handle('set-phone-lan', async (_e, enabled) => {
  const on = !!enabled
  writeUiPrefs({ phoneLan: on })
  const cfg = syncAdvertiseHost(readConfig(), { persist: true, log: true })
  let restart = { ok: true, skipped: true }
  if (hubRunning) {
    restart = await restartHub(pendingActiveBase || undefined)
  }
  return {
    ok: true,
    uiPrefs: readUiPrefs(),
    config: cfg,
    lan: getLanStatus(cfg),
    advertiseHost: resolveAdvertiseHost(cfg),
    restart
  }
})

ipcMain.handle('save-config', (_e, partial) => {
  const p = { ...(partial || {}) }
  if (Object.prototype.hasOwnProperty.call(p, 'advertiseHost')) {
    const raw = String(p.advertiseHost || '').trim()
    if (!phoneLanEnabled()) {
      p.advertiseHost = '127.0.0.1'
    } else if (isDefaultAdvertiseHost(raw)) {
      p.advertiseHost = pickLanIpv4() || '127.0.0.1'
    } else {
      p.advertiseHost = raw
    }
  }
  const cfg = writeConfig(p)
  return { ok: true, config: cfg }
})

ipcMain.handle('save-ui-prefs', (_e, partial) => {
  const uiPrefs = writeUiPrefs(partial || {})
  if (Object.prototype.hasOwnProperty.call(partial || {}, 'phoneLan')) {
    try { syncAdvertiseHost(readConfig(), { persist: true, log: false }) } catch {}
  }
  return { ok: true, uiPrefs }
})

function sleep (ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function restartHub (fileBase) {
  const keep = fileBase !== undefined ? fileBase : pendingActiveBase
  if (hubProc) {
    appendLog('[launcher] Перезапуск сервера с новыми настройками…')
    const proc = hubProc
    stopHub()
    await new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      const t = setTimeout(finish, 2500)
      try {
        proc.once('exit', () => {
          clearTimeout(t)
          finish()
        })
      } catch {
        clearTimeout(t)
        finish()
      }
    })
    hubProc = null
    hubRunning = false
    await sleep(400)
  }
  return startHub(keep || undefined)
}

ipcMain.handle('hub-start', () => startHub())
ipcMain.handle('hub-stop', () => stopHub())
ipcMain.handle('hub-restart', (_e, fileBase) => restartHub(fileBase))
ipcMain.handle('play-replay', (_e, base) => playReplay(base))
ipcMain.handle('play-state', () => fetchPlayState())
ipcMain.handle('refresh-replays', () => listReplays())

ipcMain.handle('delete-replay', async (_e, base) => {
  const clean = String(base || '').replace(/\.mcreplay\.gz$/i, '').trim()
  if (!clean || clean.includes('..') || clean.includes('/') || clean.includes('\\')) {
    return { ok: false, error: 'bad name' }
  }
  const full = path.join(REPLAYS_DIR, `${clean}.mcreplay.gz`)
  if (!fs.existsSync(full)) return { ok: false, error: 'not found' }
  const win = BrowserWindow.getFocusedWindow() || mainWindow
  const res = await dialog.showMessageBox(win || undefined, {
    type: 'warning',
    buttons: ['Удалить', 'Отмена'],
    defaultId: 1,
    cancelId: 1,
    title: 'Удалить реплей',
    message: `Удалить «${clean}»?`,
    detail: 'Файл будет удалён с диска. Это нельзя отменить.'
  })
  if (res.response !== 0) return { ok: false, cancelled: true }
  try {
    fs.unlinkSync(full)
    try {
      const meta = sidecarMetaPath(full)
      if (fs.existsSync(meta)) fs.unlinkSync(meta)
    } catch {}
    appendLog(`[launcher] Удалён реплей: ${clean}`)
    if (pendingActiveBase === clean) pendingActiveBase = null
    return { ok: true, base: clean, replays: await listReplays() }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('open-path', (_e, which) => {
  const map = {
    root: DATA_ROOT,
    replays: REPLAYS_DIR,
    config: CONFIG_PATH
  }
  const target = map[which] || DATA_ROOT
  shell.openPath(target)
  return { ok: true }
})
