#!/usr/bin/env node
/**
 * Headless PLAY smoke bot — joins like a client, runs chat commands, detects kicks.
 *
 * Usage:
 *   node tools/smoke-bot.mjs
 *   node tools/smoke-bot.mjs --file "Replay 1"
 *   node tools/smoke-bot.mjs --port 29133 --settle 2500
 *
 * Exit 0 = all steps survived. Exit 1 = kick / fail.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import bedrock from 'bedrock-protocol'
import { loadConfig, listReplays } from '../src/config.js'
import { startPlay } from '../src/play.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = args.indexOf(name)
  if (i === -1) return fallback
  return args[i + 1] ?? fallback
}
const has = (name) => args.includes(name)

const PORT = Number(flag('--port', '29133')) || 29133
const SETTLE_MS = Number(flag('--settle', '2500')) || 2500
const JOIN_TIMEOUT_MS = Number(flag('--join-timeout', '45000')) || 45000
const USERNAME = String(flag('--user', 'SmokeBot65058'))
const REPORT_PATH = path.resolve(ROOT, flag('--report', 'logs/smoke-bot-report.json'))

function sleep (ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function resolveReplayFile (cfg, raw) {
  if (raw) {
    if (path.isAbsolute(raw) && fs.existsSync(raw)) return raw
    let rel = raw
    if (!/\.mcreplay\.gz$/i.test(rel)) rel = `${rel}.mcreplay.gz`
    const p = path.join(cfg.replaysDir, rel)
    if (fs.existsSync(p)) return p
  }
  const prefer = path.join(cfg.replaysDir, 'Replay 1.mcreplay.gz')
  if (fs.existsSync(prefer)) return prefer
  const list = listReplays(cfg.replaysDir)
  if (!list.length) throw new Error('No replays in ' + cfg.replaysDir)
  return list[0].path
}

function chatPacket (username, message) {
  return {
    type: 'chat',
    needs_translation: false,
    source_name: username,
    xuid: '',
    platform_chat_id: '',
    message,
    filtered_message: ''
  }
}

function writeTempConfig (baseCfg) {
  const dir = path.join(ROOT, 'logs')
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `smoke-bot-config-${PORT}.json`)
  const cfg = {
    ...baseCfg,
    controlUi: false,
    controlHotbar: false,
    playPort: PORT,
    livePort: PORT - 1,
    listenHost: '127.0.0.1',
    advertiseHost: '127.0.0.1',
    offline: true,
    playStartMode: 'auto',
    showSelfGhost: true,
    suppressServerUi: true
  }
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2))
  return tmp
}

class SmokeSession {
  constructor () {
    this.alive = true
    this.kicked = false
    this.kickReason = null
    this.closeReason = null
    this.spawned = false
    this.playersSeen = 0
    this.chunksSeen = 0
    this.ghostHint = false
    this.serverTexts = []
    this.client = null
    this.play = null
    this.steps = []
    this.startedAt = Date.now()
  }

  note (step, ok, detail = '') {
    const row = {
      step,
      ok: !!ok,
      detail: String(detail || ''),
      t: Date.now() - this.startedAt,
      players: this.playersSeen,
      chunks: this.chunksSeen,
      alive: this.alive && !this.kicked
    }
    this.steps.push(row)
    const mark = ok ? 'OK ' : 'FAIL'
    console.log(`[smoke] ${mark} ${step}${detail ? ' — ' + detail : ''}`)
    return row
  }

  assertAlive (step) {
    if (!this.alive || this.kicked || !this.client || this.client.status === 0) {
      this.note(step, false, this.kickReason || this.closeReason || 'disconnected')
      return false
    }
    return true
  }

  async chat (msg, waitMs = SETTLE_MS) {
    if (!this.assertAlive(`chat:${msg}`)) return false
    try {
      this.client.queue('text', chatPacket(USERNAME, msg))
    } catch (e) {
      this.note(`chat:${msg}`, false, e.message)
      return false
    }
    await sleep(waitMs)
    if (!this.alive || this.kicked) {
      this.note(`survive:${msg}`, false, this.kickReason || this.closeReason || 'kicked')
      return false
    }
    this.note(`survive:${msg}`, true, `alive players=${this.playersSeen}`)
    return true
  }

  report () {
    const failed = this.steps.filter((s) => !s.ok)
    return {
      ok: failed.length === 0 && this.alive && !this.kicked,
      username: USERNAME,
      port: PORT,
      durationMs: Date.now() - this.startedAt,
      playersSeen: this.playersSeen,
      chunksSeen: this.chunksSeen,
      kicked: this.kicked,
      kickReason: this.kickReason,
      closeReason: this.closeReason,
      failed: failed.map((s) => s.step),
      steps: this.steps,
      lastServerTexts: this.serverTexts.slice(-12)
    }
  }
}

async function waitSpawn (session, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (session.kicked || !session.alive) {
      return false
    }
    if (session.spawned || session.client?.status === 4 || session.chunksSeen > 20) {
      return true
    }
    await sleep(200)
  }
  return session.chunksSeen > 0
}

async function main () {
  const baseCfg = loadConfig()
  const filePath = resolveReplayFile(baseCfg, flag('--file', null))
  const configPath = writeTempConfig(baseCfg)
  const version = baseCfg.version || '1.21.100'

  console.log(`[smoke] file=${path.basename(filePath)} version=${version} port=${PORT} user=${USERNAME}`)
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true })

  const session = new SmokeSession()

  const play = await startPlay({
    configPath,
    file: filePath,
    port: PORT,
    version,
    ownSignals: false,
    allowEmpty: false
  })
  session.play = play
  console.log('[smoke] play server up')

  const client = bedrock.createClient({
    host: '127.0.0.1',
    port: PORT,
    username: USERNAME,
    offline: true,
    version,
    skipPing: true,
    connectTimeout: 20000,
    ...(baseCfg.raknetBackend === 'jsp-raknet'
      ? { raknetBackend: 'jsp-raknet', useNativeRaknet: false }
      : {})
  })
  session.client = client

  client.on('kick', (reason) => {
    session.kicked = true
    session.alive = false
    session.kickReason = typeof reason === 'string' ? reason : JSON.stringify(reason)
    console.log('[smoke] KICK', session.kickReason)
  })
  client.on('close', () => {
    if (session.alive) session.closeReason = session.closeReason || 'close'
    session.alive = false
    console.log('[smoke] CLOSE', session.kickReason || session.closeReason || '')
  })
  client.on('error', (e) => {
    session.closeReason = e?.message || String(e)
    console.warn('[smoke] client error', session.closeReason)
  })
  client.on('spawn', () => {
    session.spawned = true
    console.log('[smoke] client spawn event')
  })
  client.on('start_game', () => {
    session.spawned = true
  })
  client.on('level_chunk', () => { session.chunksSeen++ })
  client.on('add_player', (p) => {
    session.playersSeen++
    if (p?.username) console.log(`[smoke] add_player ${p.username}`)
  })
  client.on('player_list', () => { session.ghostHint = true })
  client.on('text', (p) => {
    const m = p?.message
    if (typeof m === 'string' && m.includes('[Replay]')) {
      session.serverTexts.push(m.replace(/§./g, ''))
    }
  })

  // Mimic real client flight ticks — empty auth_input often exposes .me/.free kicks.
  let authTimer = null
  const startAuthInput = () => {
    if (authTimer) return
    let tick = 0n
    authTimer = setInterval(() => {
      if (!session.alive || session.kicked || !client || client.status === 0) return
      tick += 1n
      try {
        client.queue('player_auth_input', {
          pitch: 0,
          yaw: 0,
          position: { x: 1.7, y: 68.5, z: 172.7 },
          move_vector: { x: 0, z: 0 },
          head_yaw: 0,
          input_data: 0n,
          input_mode: 'mouse',
          play_mode: 'normal',
          interaction_model: 'touch',
          tick,
          delta: { x: 0, y: 0, z: 0 }
        })
      } catch {}
    }, 50)
  }
  client.on('spawn', () => startAuthInput())
  // Also arm after a delay if spawn event is flaky
  setTimeout(() => startAuthInput(), 2500)

  try {
    // --- join ---
    const joined = await waitSpawn(session, JOIN_TIMEOUT_MS)
    if (!joined || session.kicked) {
      session.note('join', false, session.kickReason || session.closeReason || 'timeout')
      throw new Error('join failed')
    }
    session.note('join', true, `chunks=${session.chunksSeen} status=${client.status}`)

    // Wait for world + players + ghost settle (Replay 1 joins ~1–3s)
    await sleep(Math.max(SETTLE_MS, 4000))
    if (!session.assertAlive('settle')) throw new Error('died during settle')
    session.note('settle', true, `players=${session.playersSeen} chunks=${session.chunksSeen}`)

    // Config-ish surface checks via packets already flowing
    if (session.chunksSeen < 10) {
      session.note('world_chunks', false, `only ${session.chunksSeen}`)
    } else {
      session.note('world_chunks', true, String(session.chunksSeen))
    }
    if (session.playersSeen < 1) {
      // soft fail — some tiny replays have none; Replay 1 must have players
      const isReplay1 = /Replay 1/i.test(path.basename(filePath))
      session.note('other_players', !isReplay1, `players=${session.playersSeen}`)
    } else {
      session.note('other_players', true, `players=${session.playersSeen}`)
    }

    // --- transport commands ---
    const transport = [
      ['.help', 800],
      ['.pause', 800],
      ['.pause', 800],
      ['.speed 2', 800],
      ['.speed 1', 800],
      ['.seek 3', 2000],
      ['.goto 0:08', 2500],
      ['.restart', 3000]
    ]
    for (const [cmd, wait] of transport) {
      if (!(await session.chat(cmd, wait))) throw new Error('transport kick: ' + cmd)
    }

    // --- spectate critical ---
    if (!(await session.chat('.me', Math.max(SETTLE_MS, 3500)))) {
      throw new Error('.me kick')
    }
    // Stay in .me a bit (packet storm window)
    await sleep(3000)
    if (!session.assertAlive('me_hold')) throw new Error('.me hold kick')
    session.note('me_hold', true)

    if (!(await session.chat('.free', Math.max(SETTLE_MS, 3500)))) {
      throw new Error('.free kick')
    }
    await sleep(2000)
    if (!session.assertAlive('free_hold')) throw new Error('.free hold kick')
    session.note('free_hold', true)

    // Second cycle — regressions often appear here
    if (!(await session.chat('.me', 3000))) throw new Error('.me#2 kick')
    if (!(await session.chat('.free', 3000))) throw new Error('.free#2 kick')

    // Cycle others
    if (!(await session.chat('.next', 2000))) throw new Error('.next kick')
    if (!(await session.chat('.free', 2500))) throw new Error('.free after next kick')
    if (!(await session.chat('.spawn', 1500))) throw new Error('.spawn kick')

    // Stress: rapid .me / .free (real client often dies here)
    for (let i = 1; i <= 3; i++) {
      if (!(await session.chat('.me', 1200))) throw new Error(`.me stress#${i}`)
      if (!(await session.chat('.free', 1200))) throw new Error(`.free stress#${i}`)
    }
    session.note('me_free_stress_x3', true)

    // Idle survival under freecam playback
    await sleep(4000)
    if (!session.assertAlive('idle_end')) throw new Error('idle kick')
    session.note('idle_end', true)

    // Config key presence (static) — optional spectate* may be omitted (defaults in code)
    const example = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8')
    )
    const cfgNow = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
    const required = [
      'version', 'livePort', 'playPort', 'destination', 'offline',
      'replaysDir', 'playSpeed', 'showSelfGhost', 'suppressServerUi'
    ]
    const missingReq = required.filter((k) => !(k in cfgNow))
    const missingOpt = Object.keys(example).filter((k) => !(k in cfgNow))
    session.note(
      'config_required',
      missingReq.length === 0,
      missingReq.length ? missingReq.join(',') : 'ok'
    )
    session.note(
      'config_optional',
      true,
      missingOpt.length ? `missing(ok): ${missingOpt.join(',')}` : 'all example keys present'
    )
  } catch (e) {
    console.error('[smoke] aborted:', e.message)
    if (!session.steps.some((s) => !s.ok)) {
      session.note('abort', false, e.message)
    }
  }

  const report = session.report()
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2))
  console.log('[smoke] report →', REPORT_PATH)
  console.log(
    `[smoke] RESULT ok=${report.ok} failed=${report.failed.length}` +
    (report.failed.length ? ' [' + report.failed.join(', ') + ']' : '')
  )

  try { client.close?.() } catch {}
  try { client.disconnect?.('smoke done') } catch {}
  try { if (authTimer) clearInterval(authTimer) } catch {}
  await sleep(300)
  try { play.close({ exitProcess: false }) } catch {}
  await sleep(200)

  // Avoid hanging on open handles
  setTimeout(() => process.exit(report.ok ? 0 : 1), 500).unref?.()
  process.exitCode = report.ok ? 0 : 1
}

main().catch((e) => {
  console.error('[smoke] fatal', e)
  process.exit(1)
})
