/**
 * Android entry — HTTP UI first, hub loaded lazily (avoids crash on import).
 *
 * Env (set by the APK before start):
 *   BEDROCK_REPLAY_ROOT  — code + node_modules
 *   BEDROCK_REPLAY_DATA  — writable config / replays
 *   BEDROCK_REPLAY_MOBILE=1
 */
import http from 'http'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'

process.env.BEDROCK_REPLAY_MOBILE = '1'

if (!process.env.BEDROCK_REPLAY_ROOT) {
  throw new Error('BEDROCK_REPLAY_ROOT is required')
}
const ROOT = path.resolve(process.env.BEDROCK_REPLAY_ROOT)
const DATA_ROOT = path.resolve(process.env.BEDROCK_REPLAY_DATA || path.join(ROOT, 'data'))

const API_PORT = Number(process.env.BEDROCK_REPLAY_API_PORT || 18766)
const UI_DIR = path.join(ROOT, 'src', 'mobile', 'www')

let hubApi = null
let hubStarting = false
let lastError = null
const logLines = []

let logFlushTimer = null
let logPending = ''

function flushHubLog () {
  logFlushTimer = null
  if (!logPending) return
  const chunk = logPending
  logPending = ''
  try {
    fs.appendFile(path.join(DATA_ROOT, 'hub.log'), chunk, () => {})
  } catch {}
}

function pushLog (line) {
  const s = String(line).replace(/\s+$/, '')
  if (!s) return
  logLines.push(s)
  if (logLines.length > 2000) logLines.splice(0, logLines.length - 2000)
  try { process.stdout.write(s + '\n') } catch {}
  // Async batched writes — sync append during join was stalling RakNet (EVENT_LOOP_STALL).
  logPending += s + '\n'
  if (logPending.length > 16000) {
    flushHubLog()
    return
  }
  if (!logFlushTimer) {
    logFlushTimer = setTimeout(flushHubLog, 80)
    try { if (typeof logFlushTimer.unref === 'function') logFlushTimer.unref() } catch {}
  }
}

function wrapConsole () {
  const wrap = (fn, prefix) => (...a) => {
    pushLog((prefix || '') + a.map(String).join(' '))
    try { fn(...a) } catch {}
  }
  console.log = wrap(console.log.bind(console), '')
  console.warn = wrap(console.warn.bind(console), '[warn] ')
  console.error = wrap(console.error.bind(console), '[err] ')
}

function readJsonBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function sendJson (res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function configPath () {
  return path.join(DATA_ROOT, 'config.json')
}

async function loadConfigMod () {
  return import('./config.js')
}

async function patchConfig (partial) {
  const { loadConfig } = await loadConfigMod()
  const cfg = loadConfig(configPath())
  const next = { ...cfg, ...partial }
  if (partial.destination && typeof partial.destination === 'object') {
    next.destination = { ...cfg.destination, ...partial.destination }
  }
  const out = { ...next }
  delete out.profilesFolder
  delete out.replaysDir
  out.profilesFolder = './auth_cache'
  // Prefer durable external path from Android; keep relative only as last resort
  out.replaysDir = process.env.BEDROCK_REPLAY_REPLAYS
    ? process.env.BEDROCK_REPLAY_REPLAYS
    : './replays'
  out.advertiseHost = out.advertiseHost || '127.0.0.1'
  if (process.env.BEDROCK_REPLAY_FORCE_JSP === '1') {
    out.raknetBackend = 'jsp-raknet'
  } else {
    const { nativeRaknetPrebuildPresent } = await loadConfigMod()
    out.raknetBackend = nativeRaknetPrebuildPresent() ? 'raknet-native' : 'jsp-raknet'
  }
  out.offline = true
  out.controlHotbar = false
  out.controlUi = false
  if (out.destination && typeof out.destination === 'object') {
    out.destination = { ...out.destination, offline: true }
  }
  fs.mkdirSync(DATA_ROOT, { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(out, null, 2) + '\n', 'utf8')
  return loadConfig(configPath())
}

async function ensureHub () {
  if (hubApi) return hubApi
  if (hubStarting) {
    while (hubStarting) await new Promise((r) => setTimeout(r, 100))
    return hubApi
  }
  hubStarting = true
  lastError = null
  try {
    await patchConfig({})
    try {
      const logFile = path.join(DATA_ROOT, 'hub.log')
      fs.writeFileSync(logFile, `\n===== hub session ${new Date().toISOString()} =====\n`)
    } catch {}
    pushLog('[mobile] loading hub module…')
    const { startHub } = await import('./hub.js')
    pushLog('[mobile] starting hub…')
    hubApi = await startHub({ mode: 'both' })
    pushLog('[mobile] hub running')
    return hubApi
  } catch (e) {
    lastError = e?.message || String(e)
    pushLog('[mobile] hub failed: ' + lastError)
    throw e
  } finally {
    hubStarting = false
  }
}

async function stopHub () {
  if (!hubApi) return
  const api = hubApi
  hubApi = null
  lastError = null
  try {
    if (api.shutdown) await api.shutdown()
  } catch (e) {
    pushLog('[mobile] stop warn: ' + (e?.message || e))
  }
  pushLog('[mobile] hub stopped')
}

function mimeFor (file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8'
  if (file.endsWith('.css')) return 'text/css; charset=utf-8'
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (file.endsWith('.png')) return 'image/png'
  if (file.endsWith('.svg')) return 'image/svg+xml'
  return 'application/octet-stream'
}

function serveStatic (req, res) {
  let urlPath = (req.url || '/').split('?')[0]
  if (urlPath === '/') urlPath = '/index.html'
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '')
  const full = path.join(UI_DIR, safe)
  if (!full.startsWith(UI_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404)
    res.end('Not found')
    return
  }
  res.writeHead(200, { 'Content-Type': mimeFor(full) })
  fs.createReadStream(full).pipe(res)
}

function loadClientVersionFile () {
  const candidates = [
    path.join(ROOT, 'data', 'bedrock-client-versions.json'),
    path.join(DATA_ROOT, 'bedrock-client-versions.json')
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch {}
  }
  return { versions: [], unreliable: [] }
}

async function listVersionEntries () {
  const { buildClientVersionEntries, listSupportedBedrockVersions, compareSemver, SPECTATOR_SINCE } =
    await import('./version.js')
  const raw = loadClientVersionFile()
  let entries = buildClientVersionEntries(raw.versions || [], { unreliable: raw.unreliable || [] })
  if (!entries.length) {
    entries = listSupportedBedrockVersions()
      .map((v) => {
        const noPossess = compareSemver(v, SPECTATOR_SINCE) < 0
        return { value: v, base: v, stable: !noPossess, noPossess }
      })
      .sort((a, b) => compareSemver(b.value, a.value))
  }
  return entries
}

async function handleApi (req, res) {
  const url = (req.url || '').split('?')[0]
  if (req.method === 'GET' && url === '/api/status') {
    let cfg = null
    try {
      const { loadConfig } = await loadConfigMod()
      cfg = loadConfig(configPath())
    } catch {}
    return sendJson(res, 200, {
      running: !!hubApi,
      starting: hubStarting,
      error: lastError,
      root: ROOT,
      data: DATA_ROOT,
      version: cfg?.version || null,
      destination: cfg?.destination || null,
      livePort: cfg?.livePort ?? 19132,
      playPort: cfg?.playPort ?? 19133,
      activeReplay: hubApi?.playApi?.getActiveFile
        ? path.basename(hubApi.playApi.getActiveFile() || '') || null
        : null,
      log: logLines.slice(-500)
    })
  }
  if (req.method === 'GET' && url === '/api/versions') {
    try {
      const entries = await listVersionEntries()
      const { SPECTATOR_SINCE } = await import('./version.js')
      return sendJson(res, 200, {
        entries,
        versions: entries.map((e) => e.value),
        spectatorSince: SPECTATOR_SINCE
      })
    } catch (e) {
      return sendJson(res, 500, { error: e.message, entries: [], versions: [] })
    }
  }
  if (req.method === 'GET' && url === '/api/config') {
    try {
      const { loadConfig } = await loadConfigMod()
      const cfg = loadConfig(configPath())
      return sendJson(res, 200, {
        version: cfg.version,
        destination: cfg.destination,
        livePort: cfg.livePort,
        playPort: cfg.playPort,
        offline: cfg.offline !== false,
        autoRecord: !!cfg.autoRecord,
        saveOnDisconnect: cfg.saveOnDisconnect !== false,
        showPlayerNames: cfg.showPlayerNames !== false,
        playShowChat: !!cfg.playShowChat,
        playShowSidebar: !!cfg.playShowSidebar,
        playSounds: cfg.playSounds !== false,
        overlayControls: cfg.overlayControls !== false,
        pauseOnSeek: !!(cfg.pauseOnSeek || cfg.seekPaused || cfg.restartPaused)
      })
    } catch (e) {
      return sendJson(res, 500, { error: e.message })
    }
  }
  if (req.method === 'POST' && url === '/api/config') {
    try {
      const body = await readJsonBody(req)
      const cfg = await patchConfig(body)
      return sendJson(res, 200, { ok: true, version: cfg.version, destination: cfg.destination })
    } catch (e) {
      return sendJson(res, 400, { error: e.message })
    }
  }
  if (req.method === 'POST' && url === '/api/start') {
    try {
      const { loadConfig } = await loadConfigMod()
      const cfg = loadConfig(configPath())
      const host = String(cfg.destination?.host || '').trim()
      if (!host) {
        return sendJson(res, 400, { ok: false, error: 'Укажи IP или хост сервера' })
      }
      await ensureHub()
      return sendJson(res, 200, { ok: true, running: true })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message })
    }
  }
  if (req.method === 'POST' && url === '/api/stop') {
    try {
      await stopHub()
      return sendJson(res, 200, { ok: true, running: false })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message })
    }
  }
  if (req.method === 'GET' && url === '/api/replays') {
    try {
      const { loadConfig, listReplays } = await loadConfigMod()
      const { readReplayMeta } = await import('./replayStream.js')
      const cfg = loadConfig(configPath())
      const list = listReplays(cfg.replaysDir).map((r) => {
        const meta = readReplayMeta(r.path)
        return {
          name: r.name,
          size: r.size,
          mtime: r.mtime instanceof Date ? r.mtime.toISOString() : String(r.mtime),
          version: meta?.version ? String(meta.version) : null,
          durationMs: typeof meta?.durationMs === 'number' ? meta.durationMs : null
        }
      })
      return sendJson(res, 200, {
        dir: cfg.replaysDir,
        replays: list
      })
    } catch (e) {
      return sendJson(res, 500, { error: e.message, replays: [] })
    }
  }
  if (req.method === 'POST' && url === '/api/replays/play') {
    try {
      const body = await readJsonBody(req)
      const name = String(body.name || body.file || '').trim()
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
        return sendJson(res, 400, { error: 'bad name' })
      }
      const { loadConfig, normalizeVersion } = await loadConfigMod()
      const { versionsCompatible } = await import('./version.js')
      const { readReplayMeta } = await import('./replayStream.js')
      const cfg = loadConfig(configPath())
      const fileName = name.endsWith('.mcreplay.gz') || name.endsWith('.mcreplay')
        ? name
        : `${name}.mcreplay.gz`
      const full = path.resolve(cfg.replaysDir, fileName)
      const root = path.resolve(cfg.replaysDir)
      if (full !== root && !full.startsWith(root + path.sep)) {
        return sendJson(res, 400, { error: 'bad path' })
      }
      if (!fs.existsSync(full)) {
        return sendJson(res, 404, { error: 'not found' })
      }

      const meta = readReplayMeta(full)
      const fileVer = meta?.version ? normalizeVersion(meta.version) : null
      const cfgVer = normalizeVersion(cfg.version)
      if (fileVer && cfgVer && !versionsCompatible(fileVer, cfgVer)) {
        return sendJson(res, 409, {
          ok: false,
          error:
            `Версия не совпадает: запись ${fileVer}, сейчас ${cfgVer}. ` +
            `Смени версию в настройках на ${fileVer}.`,
          fileVersion: fileVer,
          cfgVersion: cfgVer
        })
      }

      await ensureHub()
      const ok = !!hubApi?.playApi?.setActiveFile?.(fileName)
      if (!ok) {
        return sendJson(res, 500, { ok: false, error: 'setActiveFile failed' })
      }
      const base = fileName.replace(/\.mcreplay(\.gz)?$/i, '')
      pushLog('[mobile] active replay → ' + base)
      return sendJson(res, 200, {
        ok: true,
        activeBase: base,
        activeReplay: path.basename(hubApi.playApi.getActiveFile() || fileName)
      })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message })
    }
  }
  if (req.method === 'POST' && url === '/api/replays/rename') {
    try {
      const body = await readJsonBody(req)
      const name = String(body.name || '').trim()
      const newRaw = String(body.newName || body.to || '').trim()
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
        return sendJson(res, 400, { error: 'bad name' })
      }
      if (!name.endsWith('.mcreplay') && !name.endsWith('.mcreplay.gz')) {
        return sendJson(res, 400, { error: 'not a replay' })
      }
      const { loadConfig, sanitizeReplayName } = await loadConfigMod()
      const { replayMetaPath } = await import('./replayStream.js')
      const cfg = loadConfig(configPath())
      const base = sanitizeReplayName(newRaw)
      if (!base) return sendJson(res, 400, { error: 'bad new name' })
      const full = path.resolve(cfg.replaysDir, name)
      const root = path.resolve(cfg.replaysDir)
      if (full !== root && !full.startsWith(root + path.sep)) {
        return sendJson(res, 400, { error: 'bad path' })
      }
      if (!fs.existsSync(full)) return sendJson(res, 404, { error: 'not found' })
      const ext = name.endsWith('.mcreplay.gz') ? '.mcreplay.gz' : '.mcreplay'
      let dest = path.join(cfg.replaysDir, `${base}${ext}`)
      if (path.resolve(dest) === full) {
        return sendJson(res, 200, { ok: true, name, base })
      }
      if (fs.existsSync(dest)) {
        for (let i = 2; i < 10000; i++) {
          const cand = path.join(cfg.replaysDir, `${base}_${i}${ext}`)
          if (!fs.existsSync(cand)) { dest = cand; break }
        }
      }
      fs.renameSync(full, dest)
      try {
        const oldMeta = replayMetaPath(full)
        const newMeta = replayMetaPath(dest)
        if (fs.existsSync(oldMeta)) fs.renameSync(oldMeta, newMeta)
      } catch {}
      const outName = path.basename(dest)
      const outBase = outName.replace(/\.mcreplay(\.gz)?$/i, '')
      pushLog('[mobile] renamed replay → ' + outBase)
      return sendJson(res, 200, { ok: true, name: outName, base: outBase })
    } catch (e) {
      return sendJson(res, 500, { error: e.message })
    }
  }
  if (req.method === 'POST' && url === '/api/replays/delete') {
    try {
      const body = await readJsonBody(req)
      const name = String(body.name || '').trim()
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
        return sendJson(res, 400, { error: 'bad name' })
      }
      if (!name.endsWith('.mcreplay') && !name.endsWith('.mcreplay.gz')) {
        return sendJson(res, 400, { error: 'not a replay' })
      }
      const { loadConfig } = await loadConfigMod()
      const cfg = loadConfig(configPath())
      const full = path.resolve(cfg.replaysDir, name)
      const root = path.resolve(cfg.replaysDir)
      if (full !== root && !full.startsWith(root + path.sep)) {
        return sendJson(res, 400, { error: 'bad path' })
      }
      if (!fs.existsSync(full)) {
        return sendJson(res, 404, { error: 'not found' })
      }
      fs.unlinkSync(full)
      try {
        const { replayMetaPath } = await import('./replayStream.js')
        const meta = replayMetaPath(full)
        if (fs.existsSync(meta)) fs.unlinkSync(meta)
      } catch {}
      pushLog('[mobile] deleted replay ' + name)
      return sendJson(res, 200, { ok: true })
    } catch (e) {
      return sendJson(res, 500, { error: e.message })
    }
  }

  // --- Minecraft overlay control surface ---
  if (req.method === 'GET' && url === '/api/overlay/state') {
    try {
      const busy = !!hubApi?.recordApi?.handshakeBusy
      // During Minecraft login: return a tiny payload — no FS / listReplays
      if (busy) {
        return sendJson(res, 200, {
          hubRunning: !!hubApi,
          overlayControls: true,
          mode: 'live',
          liveConnected: true,
          playConnected: false,
          worldReady: false,
          canRecord: false,
          hubLobby: false,
          recording: false,
          recordingFile: null,
          recordingElapsedMs: 0,
          handshakeBusy: true,
          activeReplay: null,
          replays: []
        })
      }
      const { loadConfig, listReplays } = await loadConfigMod()
      const cfg = loadConfig(configPath())
      const liveOn = !!hubApi?.recordApi?.overlayLive
      const clientLive = !!hubApi?.recordApi?.clientLive
      const playOn = !!(hubApi?.playApi?.overlayPlay || hubApi?.recordApi?.overlayPlay)
      const hubLobby = !!hubApi?.recordApi?.hubLobby
      // Idle in Minecraft menu / loading; LIVE after connect (REC) or start_game
      let mode = 'idle'
      if (liveOn || clientLive) mode = 'live'
      else if (playOn) mode = 'play'
      const plane = hubApi?.playApi?.plane
      const snap = playOn ? (plane?.snapshot?.() || null) : null
      const recording = !!hubApi?.recordApi?.recording
      let recordingFile = null
      try {
        const w = hubApi?.recordApi?.writer
        if (w?.filePath) recordingFile = path.basename(w.filePath).replace(/\.mcreplay\.gz$/i, '')
      } catch {}
      const recordingElapsedMs = recording
        ? (Number(hubApi?.recordApi?.recordingElapsedMs) || 0)
        : 0
      // Replays for overlay — cached list; skip meta.json (FUSE reads stall join handshake)
      let replays = []
      try {
        replays = listReplays(cfg.replaysDir).slice(0, 16).map((r) => {
          let mtime = null
          try {
            mtime = r.mtime instanceof Date ? r.mtime.toISOString() : (r.mtime ? String(r.mtime) : null)
          } catch {}
          return {
            name: r.name,
            base: r.name.replace(/\.mcreplay(\.gz)?$/i, ''),
            durationMs: null,
            mtime
          }
        })
      } catch (e) {
        pushLog('[mobile] overlay replays list: ' + (e && e.message))
      }
      let activeReplay = null
      try {
        const af = hubApi?.playApi?.getActiveFile?.()
        if (af) activeReplay = path.basename(af).replace(/\.mcreplay(\.gz)?$/i, '')
      } catch {}
      if (!activeReplay && snap?.fileName) {
        activeReplay = String(snap.fileName).replace(/\.mcreplay(\.gz)?$/i, '')
      }
      return sendJson(res, 200, {
        hubRunning: !!hubApi,
        overlayControls: cfg.overlayControls !== false,
        mode,
        liveConnected: !!(liveOn || clientLive),
        playConnected: playOn,
        worldReady: !!hubApi?.recordApi?.worldReady,
        canRecord: !!(clientLive || liveOn),
        hubLobby,
        recording: recording && liveOn,
        recordingFile: (recording && liveOn) ? recordingFile : null,
        recordingElapsedMs: (recording && liveOn) ? recordingElapsedMs : 0,
        handshakeBusy: false,
        play: snap,
        activeReplay,
        replays
      })
    } catch (e) {
      return sendJson(res, 500, { error: e.message })
    }
  }
  if (req.method === 'POST' && url === '/api/overlay/record/start') {
    try {
      if (!hubApi?.recordApi) return sendJson(res, 400, { ok: false, error: 'hub_stopped' })
      const body = await readJsonBody(req)
      const r = hubApi.recordApi.startManual?.(body.name || null)
      return sendJson(res, r?.ok ? 200 : 400, r || { ok: false })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message })
    }
  }
  if (req.method === 'POST' && url === '/api/overlay/record/stop') {
    try {
      if (!hubApi?.recordApi) return sendJson(res, 400, { ok: false, error: 'hub_stopped' })
      const body = await readJsonBody(req)
      const r = await hubApi.recordApi.stopManual?.(body.name || null)
      return sendJson(res, r?.ok ? 200 : 400, r || { ok: false })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message })
    }
  }
  if (req.method === 'POST' && url === '/api/overlay/play/toggle') {
    try {
      const plane = hubApi?.playApi?.plane
      if (!plane) return sendJson(res, 400, { ok: false, error: 'no_play' })
      return sendJson(res, 200, { ok: true, ...plane.togglePause() })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message })
    }
  }
  if (req.method === 'POST' && url === '/api/overlay/play/speed') {
    try {
      const plane = hubApi?.playApi?.plane
      if (!plane) return sendJson(res, 400, { ok: false, error: 'no_play' })
      const body = await readJsonBody(req)
      return sendJson(res, 200, { ok: true, ...plane.setSpeed(body.speed) })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message })
    }
  }
  if (req.method === 'POST' && url === '/api/overlay/play/seek') {
    try {
      const plane = hubApi?.playApi?.plane
      if (!plane) return sendJson(res, 400, { ok: false, error: 'no_play' })
      const body = await readJsonBody(req)
      const r = await plane.seek(body.deltaMs ?? 0)
      return sendJson(res, 200, { ok: true, ...r })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message })
    }
  }
  if (req.method === 'POST' && url === '/api/overlay/play/restart') {
    try {
      const plane = hubApi?.playApi?.plane
      if (!plane) return sendJson(res, 400, { ok: false, error: 'no_play' })
      const r = await plane.restart({ resetCamera: false })
      return sendJson(res, 200, { ok: true, ...r })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message })
    }
  }
  if (req.method === 'POST' && url === '/api/overlay/play/spawn') {
    try {
      const ok = !!hubApi?.playApi?.snapFreecamHome?.()
      return sendJson(res, ok ? 200 : 400, { ok, error: ok ? undefined : 'no_session' })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message })
    }
  }
  if (req.method === 'POST' && url === '/api/overlay/play/file') {
    try {
      if (!hubApi) return sendJson(res, 400, { ok: false, error: 'hub_stopped' })
      const body = await readJsonBody(req)
      const name = String(body.name || body.file || '').trim()
      if (!name) return sendJson(res, 400, { ok: false, error: 'need_name' })
      // Overlay never starts in-place .play (heavy wipe on LIVE). Always queue for PLAY port.
      // Chat `.play` still does in-place via hub onPlayCommand.
      const fileName = name.endsWith('.mcreplay.gz') || name.endsWith('.mcreplay')
        ? name
        : `${name}.mcreplay.gz`
      const ok = !!hubApi.playApi?.setActiveFile?.(fileName)
      if (!ok) return sendJson(res, 500, { ok: false, error: 'setActiveFile failed' })
      const base = fileName.replace(/\.mcreplay(\.gz)?$/i, '')
      pushLog('[mobile] overlay selected replay → ' + base + ' (join :19133)')
      return sendJson(res, 200, {
        ok: true,
        queued: true,
        activeBase: base,
        hint: 'Зайди на 127.0.0.1:19133'
      })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message })
    }
  }

  sendJson(res, 404, { error: 'not found' })
}

async function main () {
  wrapConsole()
  process.on('uncaughtException', (e) => {
    const msg = String(e && (e.stack || e.message || e))
    // jsp-raknet often throws this while closing UDP during transfer/stop — ignore
    if (msg.includes('ERR_SOCKET_DGRAM_NOT_RUNNING') || msg.includes('Not running')) {
      pushLog('[mobile] ignore dgram-close: ' + (e && e.message || e))
      return
    }
    if (msg.includes('EROFS') || msg.includes('packetReadError') || msg.includes('read-only file system')) {
      pushLog('[mobile] ignore parse-dump fs: ' + (e && e.message || e))
      return
    }
    pushLog('[mobile] uncaughtException ' + msg)
  })
  process.on('unhandledRejection', (e) => {
    pushLog('[mobile] unhandledRejection ' + (e && (e.stack || e)))
  })
  pushLog(`[mobile] boot ok`)
  pushLog(`[mobile] root=${ROOT}`)
  pushLog(`[mobile] data=${DATA_ROOT}`)
  try {
    const { loadConfig, nativeRaknetPrebuildPresent } = await import('./config.js')
    const cfg = loadConfig(configPath())
    pushLog(`[mobile] raknetBackend=${cfg.raknetBackend} nativePrebuild=${nativeRaknetPrebuildPresent()}`)
  } catch (e) {
    pushLog(`[mobile] raknet probe failed: ${e && e.message}`)
  }
  fs.mkdirSync(DATA_ROOT, { recursive: true })

  const cfgFile = configPath()
  if (!fs.existsSync(cfgFile)) {
    let version = '1.26.30'
    try {
      const { buildClientVersionEntries } = await import('./version.js')
      const seed = path.join(ROOT, 'data', 'bedrock-client-versions.json')
      const raw = JSON.parse(fs.readFileSync(
        fs.existsSync(path.join(DATA_ROOT, 'bedrock-client-versions.json'))
          ? path.join(DATA_ROOT, 'bedrock-client-versions.json')
          : seed,
        'utf8'
      ))
      const entries = buildClientVersionEntries(raw.versions || [], { unreliable: raw.unreliable || [] })
      const newestStable = entries.find((e) => e.stable)?.value
      if (newestStable) version = newestStable
    } catch {}
    fs.writeFileSync(cfgFile, JSON.stringify({
      version,
      advertiseHost: '127.0.0.1',
      livePort: 19132,
      playPort: 19133,
      offline: true,
      destination: { host: '', port: 19132, offline: true },
      autoRecord: false,
      saveOnDisconnect: true
    }, null, 2) + '\n')
    pushLog(`[mobile] default config version=${version} dest host empty`)
  }
  try {
    const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    if (!raw.version || raw.version === '1.21.100') {
      raw.version = '1.26.30'
      raw.advertiseHost = raw.advertiseHost || '127.0.0.1'
      fs.writeFileSync(cfgFile, JSON.stringify(raw, null, 2) + '\n')
      pushLog('[mobile] config.version → 1.26.30')
    }
  } catch {}

  // Seed client version list into writable data (APK assets may have it under ROOT/data)
  try {
    const seed = path.join(ROOT, 'data', 'bedrock-client-versions.json')
    const dest = path.join(DATA_ROOT, 'bedrock-client-versions.json')
    if (fs.existsSync(seed) && !fs.existsSync(dest)) {
      fs.copyFileSync(seed, dest)
    }
  } catch {}

  const server = http.createServer(async (req, res) => {
    try {
      if ((req.url || '').startsWith('/api/')) return await handleApi(req, res)
      return serveStatic(req, res)
    } catch (e) {
      sendJson(res, 500, { error: e.message })
    }
  })

  await new Promise((resolve, reject) => {
    server.listen(API_PORT, '127.0.0.1', resolve)
    server.on('error', reject)
  })
  pushLog(`[mobile] UI http://127.0.0.1:${API_PORT}/`)
  pushLog('[mobile] proxy stopped — press Start to listen on :19132 / :19133')
}

main().catch((e) => {
  try { process.stderr.write('[mobile] fatal ' + (e && e.stack || e) + '\n') } catch {}
  setTimeout(() => process.exit(1), 2000)
})

void pathToFileURL
