/**
 * Tiny HTTP + SSE control UI for ControlPlane (desktop + phone LAN).
 * No extra deps — fetch polling + EventSource.
 */

import http from 'http'
import { parseTimeArg } from './plane.js'

const HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<title>Bedrock Replay</title>
<style>
  :root {
    --bg: #12141a;
    --panel: #1c2029;
    --text: #e8eaef;
    --muted: #8b93a7;
    --accent: #3d9cf0;
    --danger: #e85d5d;
    --ok: #3ecf8e;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: "Segoe UI", system-ui, sans-serif;
    background: radial-gradient(1200px 600px at 10% -10%, #243049, var(--bg));
    color: var(--text); min-height: 100vh; padding: 20px;
  }
  h1 { font-size: 1.15rem; font-weight: 600; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 0.85rem; margin-bottom: 18px; }
  .card {
    background: var(--panel); border-radius: 14px; padding: 16px;
    max-width: 420px; margin: 0 auto; box-shadow: 0 12px 40px rgba(0,0,0,.35);
  }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0; }
  button {
    appearance: none; border: 0; border-radius: 10px; padding: 12px 14px;
    font-size: 0.95rem; font-weight: 600; cursor: pointer;
    background: #2a3140; color: var(--text); flex: 1; min-width: 72px;
  }
  button:active { transform: scale(0.98); }
  button.primary { background: var(--accent); color: #061018; }
  button.ok { background: var(--ok); color: #062016; }
  .time {
    font-variant-numeric: tabular-nums; font-size: 1.6rem; font-weight: 700;
    letter-spacing: 0.02em; text-align: center; margin: 8px 0 4px;
  }
  .meta { text-align: center; color: var(--muted); font-size: 0.8rem; }
  input[type="range"] { width: 100%; margin: 8px 0; }
  input[type="text"] {
    flex: 1; border-radius: 10px; border: 1px solid #333a4a; background: #12151c;
    color: var(--text); padding: 12px; font-size: 1rem;
  }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; background:#666; }
  .dot.on { background: var(--ok); }
  .dot.off { background: var(--danger); }
</style>
</head>
<body>
  <div class="card">
    <h1>Bedrock Replay</h1>
    <div class="sub"><span id="conn" class="dot off"></span><span id="file">—</span></div>
    <div class="time" id="clock">0:00.0</div>
    <div class="meta" id="meta">speed 1x</div>
    <div class="meta" id="hint" style="margin-top:6px;color:#3d9cf0">Seek / restart — без паузы по умолчанию (config: pauseOnSeek)</div>
    <input id="scrub" type="range" min="0" max="1000" value="0"/>
    <div class="row">
      <button id="btnPause" class="primary">Pause</button>
    </div>
    <div class="row">
      <button data-seek="-10000">−10s</button>
      <button data-seek="-5000">−5s</button>
      <button data-seek="5000">+5s</button>
      <button data-seek="10000">+10s</button>
    </div>
    <div class="row">
      <button data-speed="0.25">×0.25</button>
      <button data-speed="0.5">×0.5</button>
      <button data-speed="1">×1</button>
      <button data-speed="2">×2</button>
      <button data-speed="4">×4</button>
    </div>
    <div class="row">
      <input id="goto" type="text" placeholder="goto 1:23"/>
      <button id="btnGoto" class="primary">Go</button>
    </div>
    <div class="row">
      <button id="btnRestart">Restart</button>
      <button id="btnRestart0">Restart0</button>
      <button id="btnMute">Mute</button>
      <button id="btnUnmute" class="ok">Unmute</button>
    </div>
  </div>
<script>
const state = { durationMs: 0, scrubbing: false }
const $ = (id) => document.getElementById(id)
function fmt(ms) {
  const t = Math.max(0, Math.floor(ms/1000))
  const m = Math.floor(t/60), s = t%60, f = Math.floor((ms%1000)/100)
  return m + ':' + String(s).padStart(2,'0') + '.' + f
}
function apply(s) {
  if (!s) return
  state.durationMs = s.durationMs || 0
  $('file').textContent = s.fileName || 'replay'
  $('clock').textContent = fmt(s.t||0) + ' / ' + fmt(s.durationMs||0)
  $('meta').textContent = (s.paused ? 'PAUSED · ' : '') + 'speed ' + (s.speed||1) + 'x' + (s.seeking ? ' · seeking' : '') + (s.muted ? ' · MUTE' : '')
  const hint = document.getElementById('hint')
  if (hint) hint.style.opacity = s.paused ? '1' : '0.45'
  const btn = $('btnPause')
  if (btn) {
    btn.textContent = s.paused ? 'Play' : 'Pause'
    btn.className = s.paused ? 'ok' : 'primary'
  }
  $('scrub').max = Math.max(1, Math.floor(s.durationMs||1))
  if (!state.scrubbing) $('scrub').value = Math.floor(s.t||0)
  $('conn').className = 'dot on'
}
async function api(path, body) {
  const r = await fetch(path, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  return r.json()
}
$('btnPause').onclick = () => api('/api/toggle', {})
document.querySelectorAll('[data-seek]').forEach(b => {
  b.onclick = () => api('/api/seek', { deltaMs: Number(b.dataset.seek) })
})
document.querySelectorAll('[data-speed]').forEach(b => {
  b.onclick = () => api('/api/speed', { speed: Number(b.dataset.speed) })
})
$('btnGoto').onclick = () => api('/api/goto', { time: $('goto').value })
$('btnRestart').onclick = () => api('/api/restart', {})
$('btnRestart0').onclick = () => api('/api/restart0', {})
$('btnMute').onclick = () => api('/api/mute', { muted: true })
$('btnUnmute').onclick = () => api('/api/mute', { muted: false })
$('goto').addEventListener('keydown', e => { if (e.key==='Enter') $('btnGoto').click() })
$('scrub').addEventListener('pointerdown', () => { state.scrubbing = true })
$('scrub').addEventListener('pointerup', async () => {
  state.scrubbing = false
  await api('/api/goto', { ms: Number($('scrub').value) })
})
api('/api/state').then(apply).catch(()=>{})
try {
  const es = new EventSource('/api/events')
  es.onmessage = (ev) => { try { apply(JSON.parse(ev.data)) } catch {} }
  es.onerror = () => { $('conn').className = 'dot off' }
} catch {}
setInterval(() => { if (!state.scrubbing) api('/api/state').then(apply).catch(()=>{}) }, 1000)
</script>
</body>
</html>
`

/**
 * @param {import('./plane.js').ControlPlane} plane
 * @param {{
 *   port?: number,
 *   host?: string,
 *   setActiveFile?: (file: string) => boolean,
 *   getActiveFile?: () => string | null
 * }} opts
 */
export function startControlServer (plane, opts = {}) {
  const port = opts.port ?? 18765
  const host = opts.host ?? '0.0.0.0'
  const setActiveFile = typeof opts.setActiveFile === 'function' ? opts.setActiveFile : null
  const getActiveFile = typeof opts.getActiveFile === 'function' ? opts.getActiveFile : null
  /** @type {Set<import('http').ServerResponse>} */
  const sseClients = new Set()

  const sendJson = (res, code, obj) => {
    const body = JSON.stringify(obj)
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    })
    res.end(body)
  }

  const broadcast = (snap) => {
    const payload = `data: ${JSON.stringify(snap)}\n\n`
    for (const res of sseClients) {
      try { res.write(payload) } catch { sseClients.delete(res) }
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      })
      return res.end()
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(HTML)
    }

    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      })
      res.write(`data: ${JSON.stringify(plane.snapshot())}\n\n`)
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      const snap = plane.snapshot()
      if (getActiveFile) {
        const full = getActiveFile()
        snap.activePath = full || null
        if (full && !snap.fileName) snap.fileName = full.split(/[/\\]/).pop()
      }
      return sendJson(res, 200, snap)
    }

    const readBody = () => new Promise((resolve) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
      })
    })

    if (req.method === 'POST') {
      const body = await readBody()
      if (url.pathname === '/api/pause' || url.pathname === '/api/toggle') {
        return sendJson(res, 200, plane.togglePause())
      }
      if (url.pathname === '/api/speed') return sendJson(res, 200, plane.setSpeed(body.speed))
      if (url.pathname === '/api/seek') {
        const r = await plane.seek(body.deltaMs ?? 0)
        return sendJson(res, 200, r)
      }
      if (url.pathname === '/api/goto') {
        let ms = body.ms
        if (ms == null && body.time != null) ms = parseTimeArg(body.time)
        if (ms == null) return sendJson(res, 400, { ok: false, error: 'bad time' })
        const r = await plane.goto(ms)
        return sendJson(res, 200, r)
      }
      if (url.pathname === '/api/restart') {
        const r = await plane.restart({ resetCamera: false })
        return sendJson(res, 200, r)
      }
      if (url.pathname === '/api/restart0') {
        const r = await plane.restart0()
        return sendJson(res, 200, r)
      }
      if (url.pathname === '/api/mute') {
        return sendJson(res, 200, plane.setMuted(!!body.muted))
      }
      if (url.pathname === '/api/active-file') {
        if (!setActiveFile) {
          return sendJson(res, 501, { ok: false, error: 'setActiveFile not available' })
        }
        const file = body.file || body.path || body.name
        if (!file) return sendJson(res, 400, { ok: false, error: 'file required' })
        const ok = !!setActiveFile(String(file))
        const snap = plane.snapshot()
        return sendJson(res, ok ? 200 : 404, {
          ok,
          fileName: snap.fileName,
          status: snap.status,
          error: ok ? undefined : 'file not found'
        })
      }
    }

    sendJson(res, 404, { error: 'not found' })
  })

  const unsub = plane.subscribe((snap) => broadcast(snap))

  const tick = setInterval(() => {
    if (sseClients.size === 0) return
    broadcast(plane.snapshot())
  }, 250)

  server.listen(port, host, () => {
    console.log(`[control] Web UI  http://127.0.0.1:${port}/  (LAN: http://<pc-ip>:${port}/)`)
  })

  return {
    server,
    port,
    close () {
      unsub()
      clearInterval(tick)
      for (const res of sseClients) {
        try { res.end() } catch {}
      }
      sseClients.clear()
      try { server.close() } catch {}
    }
  }
}
