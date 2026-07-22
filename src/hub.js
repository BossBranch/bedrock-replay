/**
 * Unified hub — TWO ports always up (one process):
 *   livePort (19132)  = record proxy → real server
 *   playPort (19133)  = replay freecam (optional direct join)
 *
 * .play  → save file, run replay IN-PLACE on the same LIVE connection
 * .live  → leave replay (disconnect); user rejoins LIVE manually
 */

import { loadConfig, listReplays } from './config.js'
import { resolveRuntimeVersion } from './version.js'
import { startRecord } from './record.js'
import { startPlay } from './play.js'
import {
  liveAddress,
  playAddress,
  disconnectWithJoinHint
} from './transfer.js'

function systemText (message) {
  return {
    type: 'system',
    needs_translation: false,
    message,
    xuid: '',
    platform_chat_id: '',
    filtered_message: ''
  }
}

function sleep (ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * @param {{
 *   configPath?: string,
 *   mode?: 'live'|'replay'|'both',
 *   file?: string,
 *   speed?: number,
 *   follow?: boolean
 * }} opts
 */
export async function startHub (opts = {}) {
  const cfg = loadConfig(opts.configPath)
  const runtime = await resolveRuntimeVersion(cfg)
  const live = liveAddress(cfg)
  const play = playAddress(cfg)
  const mode = opts.mode || 'both'

  console.log('[hub] Bedrock Replay — dual port')
  console.log(`[hub] version=${runtime.version} viewerMode=${runtime.viewerMode}`)
  console.log(`[hub] LIVE  (record)  → ${live.host}:${live.port}`)
  console.log(`[hub] PLAY  (replay)  → ${play.host}:${play.port}  (optional direct join)`)
  console.log('[hub] .play = in-place replay on LIVE')
  console.log('[hub] .live = leave replay (disconnect) → join LIVE again')

  /** @type {Awaited<ReturnType<typeof startPlay>> | null} */
  let playApi = null
  /** @type {Awaited<ReturnType<typeof startRecord>> | null} */
  let recordApi = null
  let returningToLive = false

  const returnToLive = async (client) => {
    if (returningToLive) {
      console.log('[hub] .live already in progress — ignore duplicate')
      return
    }
    returningToLive = true
    try {
      // Mid-session GamePE resume is broken on Bedrock after in-place replay.
      // Stop playback and ask to rejoin LIVE (clear message, not a crash).
      console.log('[hub] .live → rejoin LIVE hint')
      try { playApi?.abortActive?.({ reason: 'live' }) } catch {}
      await sleep(200)
      if (client?.status === 0) {
        console.log('[hub] .live: already left')
        return
      }
      const res = await recordApi.resumeLive(client)
      console.log(`[hub] .live done (${res?.method || 'ok'})`)
    } catch (e) {
      console.error('[hub] .live failed', e)
      try {
        client.queue('text', systemText(
          `§e[Replay] Выход из просмотра · зайди на LIVE: §f${live.host}:${live.port}`
        ))
      } catch {}
    } finally {
      returningToLive = false
    }
  }

  const isMobile = process.env.BEDROCK_REPLAY_MOBILE === '1'
  const shutdown = async () => {
    console.log('\n[hub] Shutting down…')
    try { await recordApi?.closeWriter?.('shutdown') } catch {}
    // Drop Minecraft clients + GamePE upstream with disconnect (not bare close),
    // otherwise GamePE keeps the nick online until UDP timeout.
    try { recordApi?.relay?.close?.() } catch {}
    try { playApi?.close?.({ exitProcess: false }) } catch {}
    // Give disconnect packets a moment to leave before process exit (PC).
    await new Promise((r) => setTimeout(r, 250))
    // Android UI shares this Node process — never exit on stop
    if (isMobile) return
    process.exit(0)
  }
  if (!isMobile) {
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }
  process.on('uncaughtException', (err) => {
    const msg = String(err && (err.stack || err.message || err))
    if (msg.includes('ERR_SOCKET_DGRAM_NOT_RUNNING') || msg.includes('Not running')) {
      console.warn('[hub] ignore dgram-close:', err?.message || err)
      return
    }
    if (msg.includes('EROFS') || msg.includes('packetReadError')) {
      console.warn('[hub] ignore parse-dump fs error:', err?.message || err)
      return
    }
    console.error('[hub] uncaughtException', err)
  })
  process.on('unhandledRejection', (err) => console.error('[hub] unhandledRejection', err))

  // LIVE first so Minecraft can join :19132 ASAP (PLAY is optional)
  if (mode !== 'replay') {
    recordApi = await startRecord({
      configPath: opts.configPath,
      version: runtime.version,
      advertiseVersion: runtime.advertiseVersion || runtime.version,
      listenPort: live.port,
      ownSignals: false,
      playHint: play,
      onInPlaceLive: async ({ player }) => {
        await returnToLive(player)
      },
      onPlayCommand: async ({ player, name, resolvePlayFile }) => {
        try {
          const stats = await resolvePlayFile(name)
          if (!stats?.path) {
            try {
              player.queue('text', systemText(
                name
                  ? `§c[Replay] Нет файла §f${name}`
                  : '§c[Replay] Нечего смотреть — сначала §f.start'
              ))
            } catch {}
            return
          }

          console.log(`[hub] .play → in-place ${stats.path}`)

          if (!playApi?.attachClient) {
            try {
              player.queue('text', systemText('§c[Replay] Play engine not running'))
            } catch {}
            return
          }
          playApi.setActiveFile(stats.path)

          try { recordApi.detachForInPlacePlay(player) } catch (e) {
            console.warn('[hub] detach failed', e.message)
          }

          void playApi.attachClient(player, {
            inPlace: true,
            onRequestLive: async ({ client }) => {
              await returnToLive(client)
            }
          }).catch((e) => {
            console.error('[hub] in-place play failed', e)
            try {
              player.queue('text', systemText(`§c[Replay] Play failed: ${e.message}`))
            } catch {}
            try { returnToLive(player) } catch {}
          })
        } catch (e) {
          console.error('[hub] .play failed', e)
          try {
            player.queue('text', systemText(`§c[Replay] .play failed: ${e.message}`))
          } catch {}
        }
      }
    })
  }

  if (mode !== 'live') {
    playApi = await startPlay({
      configPath: opts.configPath,
      file: opts.file,
      port: play.port,
      version: runtime.version,
      advertiseVersion: runtime.advertiseVersion || runtime.version,
      viewerMode: runtime.viewerMode,
      speed: opts.speed,
      follow: opts.follow,
      ownSignals: false,
      allowEmpty: true,
      onRequestLive: async ({ client }) => {
        // Joined PLAY port directly — cannot reopen LIVE upstream on this socket.
        console.log('[hub] .live from PLAY port → join hint (no in-place upstream)')
        disconnectWithJoinHint(
          client,
          live.host,
          live.port,
          'Выход из просмотра · зайди на LIVE:'
        )
      }
    })
  }

  const list = listReplays(cfg.replaysDir)
  console.log(`[hub] replays on disk: ${list.length}`)
  console.log(`[hub] Minecraft server: ${live.host}:${live.port}`)
  console.log(`[hub] Optional PLAY-only: ${play.host}:${play.port}`)

  return { recordApi, playApi, live, play, runtime, shutdown }
}
