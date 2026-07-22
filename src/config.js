import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Code / node_modules root (installer: resources/hub) */
export const ROOT = process.env.BEDROCK_REPLAY_ROOT
  ? path.resolve(process.env.BEDROCK_REPLAY_ROOT)
  : path.resolve(__dirname, '..')

/** Writable data: config, replays, auth (installer: %APPDATA%/BedrockServerReplay) */
export const DATA_ROOT = process.env.BEDROCK_REPLAY_DATA
  ? path.resolve(process.env.BEDROCK_REPLAY_DATA)
  : ROOT

/** True when a shippable Android (or local) raknet-native prebuild exists. */
export function nativeRaknetPrebuildPresent () {
  const rn = path.join(ROOT, 'node_modules', 'raknet-native')
  const dirs = []
  if (process.arch === 'arm64' || process.arch === 'aarch64') dirs.push('android-arm64')
  else if (process.arch === 'arm') dirs.push('android-arm')
  else if (process.arch === 'x64') dirs.push('android-x64')
  dirs.push('android-arm64') // common phone ABI even if detect is odd
  for (const d of dirs) {
    if (fs.existsSync(path.join(rn, 'prebuilds', d, 'node-raknet.node'))) return true
  }
  return false
}

function resolveRaknetBackend (cfg) {
  if (process.env.BEDROCK_REPLAY_FORCE_JSP === '1') return 'jsp-raknet'
  if (cfg.raknetBackend === 'jsp-raknet') return 'jsp-raknet'
  if (cfg.raknetBackend === 'raknet-native' || cfg.raknetBackend === 'raknet-node') {
    return cfg.raknetBackend
  }
  // Mobile: prefer native when we shipped a .node; else jsp
  if (process.env.BEDROCK_REPLAY_MOBILE === '1') {
    return nativeRaknetPrebuildPresent() ? 'raknet-native' : 'jsp-raknet'
  }
  return cfg.raknetBackend || undefined
}

let _cfgCache = { path: '', t: 0, cfg: null }

export function loadConfig (configPath = path.join(DATA_ROOT, 'config.json')) {
  // Hot path (overlay poll): avoid re-reading JSON + mkdir every tick on Android FUSE
  if (
    _cfgCache.cfg &&
    _cfgCache.path === configPath &&
    Date.now() - _cfgCache.t < 5000
  ) {
    return _cfgCache.cfg
  }
  fs.mkdirSync(DATA_ROOT, { recursive: true })
  const example = path.join(ROOT, 'config.example.json')
  if (!fs.existsSync(configPath)) {
    if (fs.existsSync(example)) fs.copyFileSync(example, configPath)
    else throw new Error('Missing config.json')
  }
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  cfg.profilesFolder = path.resolve(DATA_ROOT, cfg.profilesFolder || './auth_cache')
  // Durable Android path survives uninstall (Documents/BedrockServerReplay/replays)
  if (process.env.BEDROCK_REPLAY_REPLAYS) {
    cfg.replaysDir = path.resolve(process.env.BEDROCK_REPLAY_REPLAYS)
  } else {
    cfg.replaysDir = path.resolve(DATA_ROOT, cfg.replaysDir || './replays')
  }
  const backend = resolveRaknetBackend(cfg)
  if (backend) cfg.raknetBackend = backend
  fs.mkdirSync(cfg.profilesFolder, { recursive: true })
  fs.mkdirSync(cfg.replaysDir, { recursive: true })
  _cfgCache = { path: configPath, t: Date.now(), cfg }
  return cfg
}

/** Options fragment for bedrock-protocol Server / Relay */
export function raknetOptions (cfg) {
  if (cfg?.raknetBackend === 'jsp-raknet') {
    return { raknetBackend: 'jsp-raknet', useNativeRaknet: false }
  }
  if (cfg?.raknetBackend === 'raknet-native') {
    return { raknetBackend: 'raknet-native', useNativeRaknet: true }
  }
  if (process.env.BEDROCK_REPLAY_MOBILE === '1' && !nativeRaknetPrebuildPresent()) {
    return { raknetBackend: 'jsp-raknet', useNativeRaknet: false }
  }
  return {}
}

/** Normalize Bedrock version to x.y.z used by bedrock-protocol */
export function normalizeVersion (v) {
  if (!v) return null
  return String(v).split('.').slice(0, 3).join('.')
}

/** Next free default name: Replay 1, Replay 2, … (scans existing files). */
export function nextReplayName (dir) {
  let max = 0
  try {
    for (const r of listReplays(dir)) {
      const base = String(r.name || '').replace(/\.mcreplay(\.gz)?$/i, '')
      // "Replay 1", "Replay_1", or uniqueReplayPath collision "Replay 1_2"
      let m = /^Replay (\d+)(?:_\d+)?$/i.exec(base)
      if (!m) m = /^Replay_(\d+)(?:_\d+)?$/i.exec(base)
      if (!m) continue
      const n = parseInt(m[1], 10)
      // Ignore timestamp leftovers (replay_YYYYMMDD_…) — those are 8+ digits
      if (Number.isFinite(n) && n >= 1 && n <= 99999 && n > max) max = n
    }
  } catch {}
  return `Replay ${max + 1}`
}

/** @deprecated Prefer nextReplayName(dir). Kept as timestamp fallback. */
export function stampName (dir) {
  if (dir) return nextReplayName(dir)
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `replay_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * Safe replay basename (no path, no extension).
 * Allows Latin, digits, Cyrillic, spaces, . _ -
 */
export function sanitizeReplayName (raw, { maxLen = 64 } = {}) {
  if (raw == null) return null
  let s = String(raw).trim()
  if (!s) return null
  s = s.replace(/\.mcreplay(\.gz)?$/i, '')
  s = s.replace(/[\\/:*?"<>|]/g, '')
  s = s.replace(/[^\w.\-а-яА-ЯёЁ ]/gu, '_')
  s = s.replace(/_+/g, '_').replace(/ {2,}/g, ' ').replace(/^[._ ]+|[._ ]+$/g, '')
  if (!s) return null
  if (s.length > maxLen) s = s.slice(0, maxLen)
  return s
}

/** Resolve unique path under dir for basename.mcreplay.gz (adds _2, _3, …). */
export function uniqueReplayPath (dir, basename) {
  const base = sanitizeReplayName(basename) || nextReplayName(dir)
  fs.mkdirSync(dir, { recursive: true })
  let candidate = path.join(dir, `${base}.mcreplay.gz`)
  if (!fs.existsSync(candidate)) return candidate
  for (let i = 2; i < 10000; i++) {
    candidate = path.join(dir, `${base}_${i}.mcreplay.gz`)
    if (!fs.existsSync(candidate)) return candidate
  }
  return path.join(dir, `${base}_${Date.now()}.mcreplay.gz`)
}

/** Index path — survives FUSE readdir gaps on Android Documents. */
export function replayIndexPath () {
  return path.join(DATA_ROOT, 'replay-index.json')
}

/**
 * Remember a saved replay by absolute path so listReplays finds it even when
 * Android Documents readdir omits newly written files (same session / after reinstall).
 */
export function registerReplay (filePath) {
  try {
    const abs = path.resolve(String(filePath || ''))
    if (!abs || !fs.existsSync(abs)) return false
    const name = path.basename(abs)
    if (!name.endsWith('.mcreplay') && !name.endsWith('.mcreplay.gz')) return false
    try { fs.chmodSync(abs, 0o666) } catch {}
    const metaGuess = abs.replace(/\.mcreplay\.gz$/i, '.meta.json').replace(/\.mcreplay$/i, '.meta.json')
    try { if (fs.existsSync(metaGuess)) fs.chmodSync(metaGuess, 0o666) } catch {}

    let arr = []
    const idxPath = replayIndexPath()
    try {
      if (fs.existsSync(idxPath)) {
        const raw = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
        if (Array.isArray(raw)) arr = raw
      }
    } catch {}
    arr = arr.filter((x) => x && x.name !== name && x.path !== abs)
    arr.unshift({ name, path: abs, registeredAt: new Date().toISOString() })
    if (arr.length > 200) arr = arr.slice(0, 200)
    fs.mkdirSync(path.dirname(idxPath), { recursive: true })
    fs.writeFileSync(idxPath, JSON.stringify(arr, null, 2) + '\n', 'utf8')
    try { invalidateReplayListCache() } catch {}
    return true
  } catch (e) {
    console.warn('[replayIndex] register fail', e?.message || e)
    return false
  }
}

let _listCache = { dir: '', t: 0, list: null }

/** Invalidate after save/delete/rename so UI sees new files without waiting for TTL. */
export function invalidateReplayListCache () {
  _listCache = { dir: '', t: 0, list: null }
}

/**
 * @param {string} dir
 * @param {{ fresh?: boolean, probe?: boolean }} [opts]
 *   probe — try Replay N by path (slow on Android Documents). Default: only if list empty.
 */
export function listReplays (dir, opts = {}) {
  const now = Date.now()
  if (
    !opts.fresh &&
    _listCache.list &&
    _listCache.dir === String(dir || '') &&
    now - _listCache.t < 3000
  ) {
    return _listCache.list
  }

  const byName = new Map()
  const add = (full) => {
    try {
      if (!full) return
      const abs = path.resolve(full)
      if (!fs.existsSync(abs)) return
      const st = fs.statSync(abs)
      if (!st.isFile()) return
      const f = path.basename(abs)
      if (!f.endsWith('.mcreplay') && !f.endsWith('.mcreplay.gz')) return
      byName.set(f, { name: f, path: abs, size: st.size, mtime: st.mtime })
    } catch { /* unreadable entry */ }
  }

  try {
    if (dir && fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) add(path.join(dir, f))
    }
  } catch (e) {
    console.warn('[listReplays] readdir fail', dir, e?.message || e)
  }

  // Android Documents: readdir often misses files that still open by path.
  try {
    const idxPath = replayIndexPath()
    if (fs.existsSync(idxPath)) {
      const raw = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
      if (Array.isArray(raw)) {
        for (const row of raw) {
          if (row?.path) add(row.path)
          else if (row?.name && dir) add(path.join(dir, row.name))
        }
      }
    }
  } catch { /* ignore bad index */ }

  // Probe only when needed — 80×9 existsSync on every overlay poll stalled join (no login).
  const wantProbe =
    opts.probe === true ||
    (opts.probe !== false && byName.size === 0)
  if (wantProbe && dir) {
    for (let i = 1; i <= 40; i++) {
      add(path.join(dir, `Replay ${i}.mcreplay.gz`))
    }
  }

  const list = [...byName.values()].sort((a, b) => b.mtime - a.mtime)
  _listCache = { dir: String(dir || ''), t: now, list }
  return list
}
