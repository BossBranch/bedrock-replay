import fs from 'fs'
import path from 'path'
import bedrock from 'bedrock-protocol'
import { loadConfig, nextReplayName, sanitizeReplayName, uniqueReplayPath, listReplays, normalizeVersion, registerReplay } from './config.js'
import { resolveRuntimeVersion, applyBedrockVersionCompat } from './version.js'
import { ReplayWriter, sanitize, revive } from './format.js'
import { writeReplayMeta, replayMetaPath } from './replayStream.js'

import { buildSelfRecord, skinFromLogin } from './ghost.js'
import { liveAddress, playAddress, liveMotdOptions } from './transfer.js'
import { fixPlayerListParams, fixActorIds, asUniqueId, fixSkin } from './packetFix.js'
import {
  inventoryArmorToMobArmor,
  inventorySlotArmorToMobArmor,
  peekInventoryWindowId,
  PKT_INVENTORY_CONTENT,
  PKT_INVENTORY_SLOT,
  WIN_ARMOR,
  EMPTY_ITEM_V4
} from './packetPatch.js'
import { createLiveDiag } from './liveDiag.js'

/** Packets kept from join until .start so mid-session files still have a real world bootstrap */
const BOOTSTRAP_PACKETS = new Set([
  'start_game',
  'play_status',
  'level_chunk',
  'subchunk',
  'network_chunk_publisher_update',
  'chunk_radius_update',
  'biome_definition_list',
  'available_entity_identifiers',
  'item_registry',
  'creative_content',
  'set_time',
  'set_spawn_position',
  'respawn',
  'game_rules_changed',
  'set_difficulty',
  'update_attributes'
])

/** Never drop these when trimming the 800-packet bootstrap window */
const BOOTSTRAP_PIN = new Set([
  'start_game',
  'item_registry',
  'biome_definition_list',
  'available_entity_identifiers',
  'creative_content',
  'play_status'
])

function ridStr (id) {
  if (id == null) return null
  if (typeof id === 'bigint') return id.toString()
  if (typeof id === 'object' && id.$bigint != null) return String(id.$bigint)
  return String(id)
}

function playerListRecords (params) {
  if (!params) return { type: null, records: [] }
  const wrapped = params.records?.records != null
  const type = wrapped ? params.records.type : params.type
  const raw = wrapped ? params.records.records : params.records
  return { type, records: Array.isArray(raw) ? raw : [], wrapped }
}

const { Relay, Client } = bedrock

/** Reject GamePE join placeholders like 0,0,0 */
function isSanePos (p) {
  if (!p) return false
  const { x, y, z } = p
  if (![x, y, z].every((n) => typeof n === 'number' && Number.isFinite(n))) return false
  return Math.abs(x) + Math.abs(y) + Math.abs(z) > 8
}

function posFromStartGame (params) {
  if (!params) return null
  if (isSanePos(params.player_position)) return { ...params.player_position }
  if (isSanePos(params.spawn_position)) {
    return {
      x: params.spawn_position.x,
      y: params.spawn_position.y,
      z: params.spawn_position.z
    }
  }
  if (isSanePos(params.spawn)) return { ...params.spawn }
  return null
}

function extractCamera (name, params) {
  if ((name === 'player_auth_input' || name === 'move_player') && params?.position) {
    return {
      x: params.position.x,
      y: params.position.y,
      z: params.position.z,
      pitch: params.pitch,
      yaw: params.yaw,
      head_yaw: params.head_yaw ?? params.yaw
    }
  }
  if (name === 'network_chunk_publisher_update' && params?.coordinates) {
    const c = params.coordinates
    if (typeof c.x === 'number' && typeof c.y === 'number' && typeof c.z === 'number') {
      return { x: c.x, y: c.y, z: c.z, pitch: 0, yaw: 0, head_yaw: 0 }
    }
  }
  if (name === 'change_dimension' && params?.position && isSanePos(params.position)) {
    return {
      x: params.position.x,
      y: params.position.y,
      z: params.position.z,
      pitch: 0,
      yaw: 0,
      head_yaw: 0
    }
  }
  if (name === 'respawn' && params?.position && isSanePos(params.position)) {
    return {
      x: params.position.x,
      y: params.position.y,
      z: params.position.z,
      pitch: 0,
      yaw: 0,
      head_yaw: 0
    }
  }
  if (name === 'set_spawn_position') {
    const p = params?.position || params?.coordinates
    if (isSanePos(p)) {
      return { x: p.x, y: p.y, z: p.z, pitch: 0, yaw: 0, head_yaw: 0 }
    }
  }
  return null
}

function itemNetworkId (item) {
  if (!item || typeof item !== 'object') return 0
  const n = item.network_id ?? item.networkId
  if (n == null) return 0
  const v = typeof n === 'bigint' ? Number(n) : Number(n)
  return Number.isFinite(v) ? v : 0
}

function isOffhandWindow (win) {
  return win === 'offhand' || win === 119
}

/**
 * GamePE / modern Bedrock often never echoes your own mob_equipment clientbound,
 * and may not send serverbound mob_equipment on hotbar change either.
 * Held item still appears inside auth-input / inventory transactions when you use it.
 * Offhand (arrow etc.) only arrives via serverbound mob_equipment window=offhand.
 */
function extractHeldFromServerbound (name, params) {
  if (!params) return null

  if (name === 'mob_equipment') {
    const win = params.window_id
    if (isOffhandWindow(win)) {
      return {
        item: params.item || { network_id: 0 },
        slot: 1,
        selected_slot: 0,
        window_id: 'offhand',
        src: 'mob_equipment_offhand',
        offhand: true
      }
    }
    const slot = Number(params.selected_slot ?? params.slot ?? 0) || 0
    return {
      item: params.item || { network_id: 0 },
      slot,
      selected_slot: slot,
      window_id: win || 'inventory',
      src: 'mob_equipment'
    }
  }

  if (name === 'player_hotbar') {
    if (isOffhandWindow(params.window_id)) return null
    const slot = Number(params.selected_slot ?? 0) || 0
    return {
      item: null, // slot-only — caller fills from hotbar mirror
      slot,
      selected_slot: slot,
      window_id: params.window_id || 'inventory',
      src: 'player_hotbar',
      slotOnly: true
    }
  }

  if (name === 'inventory_transaction') {
    const tx = params.transaction || params
    const data = tx.transaction_data || tx.data
    if (data?.held_item != null) {
      const slot = Number(data.hotbar_slot ?? 0) || 0
      return {
        item: data.held_item,
        slot,
        selected_slot: slot,
        window_id: 'inventory',
        src: 'inventory_transaction'
      }
    }
    return null
  }

  if (name === 'player_auth_input') {
    // item_interact → compact UseItem blob (main hand only)
    const authData = params.transaction?.data || params.transaction?.transaction_data
    if (authData?.held_item != null) {
      const slot = Number(authData.hotbar_slot ?? 0) || 0
      return {
        item: authData.held_item,
        slot,
        selected_slot: slot,
        window_id: 'inventory',
        src: 'auth_input'
      }
    }
    // Some builds nest a full inventory_transaction under auth input
    const nested = params.transaction
    if (nested?.transaction_data?.held_item != null) {
      const data = nested.transaction_data
      const slot = Number(data.hotbar_slot ?? 0) || 0
      return {
        item: data.held_item,
        slot,
        selected_slot: slot,
        window_id: 'inventory',
        src: 'auth_input_tx'
      }
    }
    return null
  }

  return null
}

/**
 * @returns {{ action: 'start'|'stop'|'status'|'play'|'list'|'help', name?: string|null } | null}
 */
function parseRecCommand (raw) {
  if (!raw || typeof raw !== 'string') return null
  let m = raw.trim()
  if (m.startsWith('/')) m = m.slice(1)
  m = m.replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim()
  const lower = m.toLowerCase()

  if (
    lower === '.' ||
    lower === '.h' ||
    lower === '.help' ||
    lower === 'help' ||
    lower === '.?' ||
    lower === '.commands' ||
    lower === '.cmds'
  ) {
    return { action: 'help' }
  }

  const playM = lower.match(/^(?:\.play|play)(?:\s+(.+))?$/)
  if (playM) return { action: 'play', name: sanitizeReplayName(playM[1]) }

  const startM = lower.match(/^(?:\.start|\.rec|\.record|start|rec|record)(?:\s+(.+))?$/)
  if (startM) return { action: 'start', name: sanitizeReplayName(startM[1]) }

  const stopM = lower.match(/^(?:\.stop|\.recstop|stop)(?:\s+(.+))?$/)
  if (stopM) return { action: 'stop', name: sanitizeReplayName(stopM[1]) }

  if (lower === '.recstatus' || lower === '.status' || lower === 'recstatus') {
    return { action: 'status' }
  }
  if (
    lower === '.replays' || lower === 'replays' || lower === '.recordings' ||
    lower === '.files' || lower === '.ls'
  ) {
    return { action: 'list' }
  }
  return null
}

function sayLiveHelp (say, _playHint = null) {
  say('§e[Replay] §f.start §8· §f.stop §8· §f.play §8· §f.status')
}

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

function patchFlushForRecording (player, _onPacket) {
  // Must go through readUpstream (clientbound + RAW_ENT + parse-fail raw forward).
  // Old path used write() and silently DROPPED unparsable join packets → frozen hub.
  player.flushDownQueue = function patchedFlush () {
    player.downOutLog?.('Flushing downstream queue (recording patch)')
    const q = player.downQ
    player.downQ = []
    player.startRelaying = true
    for (const packet of q) {
      try {
        player.readUpstream(packet)
      } catch (e) {
        console.error('[record] flush readUpstream error', e.message)
        try {
          player.sendBuffer(packet, false)
        } catch (e2) {
          console.error('[record] flush raw fallback fail', e2.message)
        }
      }
    }
  }
}

/** Read one unsigned varint from buf at off → [value, nextOff] */
function readVarIntAt (buf, off) {
  let v = 0
  let sh = 0
  let o = off
  while (o < buf.length) {
    const b = buf[o++]
    v |= (b & 0x7f) << sh
    if (!(b & 0x80)) return [v >>> 0, o]
    sh += 7
    if (sh > 35) break
  }
  return [v >>> 0, o]
}

function unzigzag (n) {
  return (n >>> 1) ^ -(n & 1)
}

/** level_chunk raw packet → "x,z" key (varint id, zigzag x, zigzag z) */
function rawChunkKey (buf) {
  try {
    let off = 0
    let x, z
    ;[, off] = readVarIntAt(buf, 0) // packet id
    ;[x, off] = readVarIntAt(buf, off)
    ;[z, off] = readVarIntAt(buf, off)
    return `${unzigzag(x)},${unzigzag(z)}`
  } catch {
    return null
  }
}

/** Mobile selective raw — keep lean: players/forms/dim. NOT move spam (flood → GamePE goes quiet). */
const MOBILE_RAW_ENT = new Set([
  'add_player', 'add_entity', 'add_item_entity', 'remove_entity',
  'mob_equipment', 'mob_armor_equipment',
  'modal_form_request', 'npc_dialogue', 'npc_dialogue_request',
  'boss_event', 'camera_instruction',
  'change_dimension', 'respawn',
  'update_client_input_locks'
])

function softCloseUpstream (up, reason = 'proxy') {
  if (!up) return
  try { up.removeAllListeners?.('close') } catch {}
  try { up.removeAllListeners?.('error') } catch {}
  try { up.disconnect?.(reason) } catch {}
  // close() often throws ERR_SOCKET_DGRAM_NOT_RUNNING on jsp-raknet — swallow
  try { up.close?.() } catch {}
}

/**
 * Custom upstream open so we can follow `transfer` hops (lobby → mode server)
 * while Minecraft always reconnects to THIS proxy.
 */
class RecordingRelay extends Relay {
  async openUpstreamConnection (ds, clientAddr) {
    // Implemented on the instance below
    return this._openUpstream(ds, clientAddr)
  }

  /**
   * Stock Relay drops the 2nd connection when forceSingle=true. That breaks GamePE
   * transfers on Android (reconnect within ms). Replace the old socket instead.
   * Upstream still opens on `login` — same as the working early Android builds.
   */
  onOpenConnection = (conn) => {
    if (this.forceSingle && this.clientCount > 0) {
      console.log('[record] Transfer/reconnect — replacing previous client')
      const prev = { ...(this.clients || {}) }
      for (const addr of Object.keys(prev)) {
        const p = prev[addr]
        try { if (p._aliveTimer) clearInterval(p._aliveTimer) } catch {}
        try {
          softCloseUpstream(p.upstream, 'replaced')
          try { p.upstream = null } catch {}
        } catch {}
        try { p.removeAllListeners('close') } catch {}
        try { p.connection?.close?.() } catch {}
        try { delete this.clients[addr] } catch {}
      }
      this.clientCount = 0
    }
    this.clientCount++
    const player = new this.RelayPlayer(this, conn)
    this.conLog?.('New connection from', conn.address)
    this.clients[conn.address] = player
    const openUp = () => {
      if (player._upstreamOpenStarted) return
      player._upstreamOpenStarted = true
      console.log(`[record] player login → open upstream (${player.profile?.name || '?'})`)
      Promise.resolve(this.openUpstreamConnection(player, conn.address)).catch((e) => {
        player._upstreamOpenStarted = false
        console.error('[record] openUpstreamConnection failed', e?.stack || e)
        try {
          player.disconnect('Не удалось подключиться к GamePE:\n' + (e?.message || e))
        } catch {}
      })
    }
    // Attach BEFORE emit('connect') — login can race with connect listeners
    player.on('loggingIn', () => {
      console.log('[record] client loggingIn…')
    })
    player.on('login', openUp)
    player.on('join', () => {
      console.log(`[record] client encrypted/join ok user=${player.profile?.name || '?'}`)
    })
    this.emit('connect', player)
    if (player.profile) openUp()
    // Do NOT open upstream without a real login — GamePE as "Player" = dead session.
    const loginWait = setTimeout(() => {
      if (player._upstreamOpenStarted || player.status === 'disconnected') return
      console.warn(
        '[record] still waiting for client login after 8s — ' +
        'see [auth] lines (encryption/JWT). Do not force-open.'
      )
    }, 8000)
    try { if (typeof loginWait.unref === 'function') loginWait.unref() } catch {}
    player.on('close', (reason) => {
      try { clearTimeout(loginWait) } catch {}
      this.conLog?.('player disconnected', conn.address, reason)
      // Nick release: disconnect if upstream still attached (RelayPlayer.close may have closed it)
      try {
        softCloseUpstream(
          player.upstream || this.upstreams?.get?.(conn.address?.hash),
          'Client left proxy'
        )
        if (conn.address?.hash != null) this.upstreams?.delete?.(conn.address.hash)
        try { player.upstream = null } catch {}
      } catch {}
      if (this.clients[conn.address] === player) {
        this.clientCount = Math.max(0, this.clientCount - 1)
        delete this.clients[conn.address]
      }
    })
  }

  /** Prefer disconnect() so GamePE frees the nickname immediately (close-only = UDP timeout). */
  close (...a) {
    try {
      for (const addr of Object.keys(this.clients || {})) {
        const p = this.clients[addr]
        try { p.disconnect?.('Proxy stopped') } catch {}
      }
    } catch {}
    try {
      for (const [, up] of this.upstreams || []) {
        softCloseUpstream(up, 'Proxy stopped')
      }
      this.upstreams?.clear?.()
    } catch {}
    try { super.close(...a) } catch {}
  }
}

export async function startRecord (opts = {}) {
  const cfg = loadConfig(opts.configPath)
  const { version } = opts.version
    ? { version: opts.version }
    : await resolveRuntimeVersion(cfg)
  const dest = cfg.destination
  const listenPort = Number(opts.listenPort ?? cfg.livePort ?? cfg.listenPort ?? 19132)
  const followTransfers = cfg.followTransfers !== false
  const live = liveAddress({ ...cfg, livePort: listenPort, listenPort })
  const playHint = opts.playHint || playAddress(cfg)
  const advHost = live.host
  const advPort = live.port
  /**
   * Android Bedrock often ignores transfer to the exact same host:port you joined
   * (127.0.0.1→127.0.0.1). Use an alternate loopback label so the client reconnects.
   * PC LAN IPs are unchanged.
   */
  const transferAdvHost = (() => {
    const h = String(advHost || '127.0.0.1').trim().toLowerCase()
    if (h === '127.0.0.1' || h === '0.0.0.0') return 'localhost'
    if (h === 'localhost') return '127.0.0.1'
    return advHost
  })()
  /** Hub callback: finalize + switch replay file + in-place play */
  const onPlayCommand = opts.onPlayCommand || null
  /** Hub callback: .live during in-place replay → resume upstream */
  const onInPlaceLive = opts.onInPlaceLive || null
  const ownSignals = opts.ownSignals !== false

  function isLiveChatCommand (raw) {
    if (!raw || typeof raw !== 'string') return false
    let m = raw.trim()
    if (m.startsWith('/')) m = m.slice(1)
    m = m.replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim().toLowerCase()
    return (
      m === '.live' || m === 'live' ||
      m === '.back' || m === 'back' ||
      m === '.real' || m === '.server'
    )
  }

  if (!dest?.host) throw new Error('config.destination.host is required')

  let writer = null
  let recording = false
  let recordingStartedAt = 0
  let leftHubLobby = false
  let lastCamAt = 0
  let lastCheckpointAt = 0
  const camEvery = cfg.recordCameraEveryMs ?? 0
  const checkpointEveryMs = cfg.recordCheckpointEveryMs ?? 5000
  const recordChat = cfg.recordChat === true
  /** @type {import('bedrock-protocol').Player | null} */
  let livePlayer = null
  /** True after start_game on current LIVE session (overlay idle vs LIVE) */
  let worldReady = false

  /** Preferred basename set by .rec name (applied on open or kept for stop rename) */
  let pendingName = null
  /** When true, disconnect is expected (legacy transfer) — do not auto-save again */
  let switchingAway = false
  /** True while LIVE client is watching replay in-place (upstream detached) */
  let inPlacePlay = false
  /** Latest start_game seen on this connection (even before .start) */
  let cachedStartGame = null
  /** World bootstrap packets since last start_game (flushed into file on .start) */
  let bootstrapBuf = []
  /**
   * Mobile: chunks stream RAW (whitelist bypasses parse), so bootstrapBuf never
   * sees them. Cache raw level_chunk buffers before .start — without them the
   * viewer spawns on a missing chunk = frozen in void.
   * @type {Map<string, {buf: Buffer, at: number}>} "cx,cz" → raw packet + when cached
   */
  const rawChunkCache = new Map()
  const RAW_CHUNK_CACHE_MAX = 350
  const rememberRawChunk = (buf) => {
    const key = rawChunkKey(buf)
    if (!key) return
    if (rawChunkCache.has(key)) rawChunkCache.delete(key)
    rawChunkCache.set(key, { buf: Buffer.from(buf), at: Date.now() })
    while (rawChunkCache.size > RAW_CHUNK_CACHE_MAX) {
      const oldest = rawChunkCache.keys().next().value
      rawChunkCache.delete(oldest)
    }
  }
  /**
   * Mobile: item_registry (id=162) is NOT in the parse whitelist — it streams
   * RAW once at join. Mid-session .start never sees it in bootstrapBuf, so
   * recordings miss the palette and PLAY crashes on ground items / inventory.
   * Keep the raw bytes for flush + disk cache (prefer raw over JSON re-encode).
   * @type {Buffer | null}
   */
  let rawItemRegistryBuf = null
  const persistItemRegistryCache = (itemstates, rawBuf) => {
    if (!Array.isArray(itemstates) || !itemstates.length) return
    try {
      const body = JSON.stringify({
        version,
        savedAt: new Date().toISOString(),
        itemstates: sanitize(itemstates)
      })
      const dirs = [
        process.env.BEDROCK_REPLAY_DATA ? path.join(process.env.BEDROCK_REPLAY_DATA, 'replays') : null,
        cfg.replaysDir
      ].filter(Boolean)
      let wrote = 0
      for (const d of dirs) {
        try {
          fs.mkdirSync(d, { recursive: true })
          fs.writeFileSync(path.join(d, 'item_registry_cache.json'), body)
          try { fs.writeFileSync(path.join(d, '.item_registry_cache.json'), body) } catch {}
          if (rawBuf?.length) {
            try { fs.writeFileSync(path.join(d, 'item_registry_cache.bin'), rawBuf) } catch {}
            try { fs.writeFileSync(path.join(d, '.item_registry_cache.bin'), rawBuf) } catch {}
          }
          wrote++
        } catch {}
      }
      if (wrote) {
        console.log(`[record] item_registry cached (${itemstates.length} items, raw=${rawBuf?.length || 0}B, dirs=${wrote})`)
      } else {
        console.warn('[record] item_registry cache write failed everywhere')
      }
    } catch (e) {
      console.warn('[record] item_registry cache write failed', e.message)
    }
  }
  const rememberRawItemRegistry = (buf, player) => {
    if (!buf?.length) return
    rawItemRegistryBuf = Buffer.from(buf)
    console.log(`[record] cached raw item_registry (${rawItemRegistryBuf.length}B) for next .start`)
    // Decode off the hot path — JSON cache for OLD replays that lack registry.
    const copy = rawItemRegistryBuf
    setImmediate(() => {
      try {
        const des = player?.server?.deserializer?.parsePacketBuffer?.(copy)
        const states = des?.data?.params?.itemstates
        if (Array.isArray(states) && states.length) persistItemRegistryCache(states, copy)
      } catch (e) {
        console.warn('[record] item_registry raw decode for cache failed', e.message)
      }
    })
  }
  /**
   * Players/entities already in the world before .start.
   * Without flushing these, replay has move_entity but nobody to show.
   * @type {Map<string, object>}
   */
  let knownPlayers = new Map()
  /** @type {Map<string, object>} */
  let knownEntities = new Map()
  /** @type {Map<string, object>} uuid → player_list record */
  let knownListRecords = new Map()
  /** @type {Map<string, object>} rid → last armor packet */
  let knownArmor = new Map()
  /** @type {Map<string, object>} rid → add_item_entity (drops on the ground) */
  let knownItems = new Map()
  /** Last known player camera from auth_input / move_player / publisher */
  let lastCamPos = null

  const noteViewerPos = (pos, src = '') => {
    if (!isSanePos(pos)) return
    lastCamPos = {
      x: pos.x,
      y: pos.y,
      z: pos.z,
      pitch: pos.pitch ?? lastCamPos?.pitch ?? 0,
      yaw: pos.yaw ?? lastCamPos?.yaw ?? 0,
      head_yaw: pos.head_yaw ?? pos.yaw ?? lastCamPos?.head_yaw ?? 0
    }
    if (src) {
      // rare log — join / first fix after GamePE 0,0,0
    }
  }

  const patchStartGamePos = (params) => {
    if (!params || typeof params !== 'object') return params
    if (isSanePos(params.player_position)) return params
    const fromCam = lastCamPos && isSanePos(lastCamPos) ? lastCamPos : null
    const fromSg = posFromStartGame(params)
    const pick = fromCam || fromSg
    if (!pick) return params
    console.log(
      `[record] patch start_game pos ${params.player_position?.x},${params.player_position?.y},${params.player_position?.z}` +
      ` → ${pick.x},${pick.y},${pick.z}` +
      (fromCam ? ' (viewer)' : ' (spawn_position)')
    )
    return {
      ...params,
      player_position: { x: pick.x, y: pick.y, z: pick.z }
    }
  }
  /** Hotbar / offhand mirror for local player (serverbound held samples) */
  const localHotbar = Array.from({ length: 9 }, () => ({ network_id: 0 }))
  let localHotbarSlot = 0
  let localOffhand = { network_id: 0 }
  let heldEventsWritten = 0
  let heldLastSigMain = ''
  let heldLastSigOff = ''
  let heldRawWritten = 0
  /** Last RAW SB mob_equipment / CB armor for mid-session .start flush */
  let lastHeldRawMain = null
  let lastHeldRawOff = null
  let lastArmorRaw = null
  /** Mutable 5-slot ItemV4 kit built from inventory_slot(window=armor). */
  const armorKitItems = [
    Buffer.from(EMPTY_ITEM_V4),
    Buffer.from(EMPTY_ITEM_V4),
    Buffer.from(EMPTY_ITEM_V4),
    Buffer.from(EMPTY_ITEM_V4),
    Buffer.from(EMPTY_ITEM_V4)
  ]
  /** Local runtime id from start_game — for self armor RAW capture */
  let localRuntimeId = null
  /** Debug: which serverbound names we saw while recording (held pipeline) */
  const sbHeldProbe = Object.create(null)

  /** Always remember latest RAW equip (even before .start) for mid-session flush. */
  const rememberEquipRaw = (sample, rawBuf) => {
    if (!sample || !rawBuf?.length) return
    if (sample.src !== 'mob_equipment' && sample.src !== 'mob_equipment_offhand') return
    const offhand = !!(sample.offhand || isOffhandWindow(sample.window_id))
    const copy = Buffer.from(rawBuf)
    if (offhand) lastHeldRawOff = copy
    else lastHeldRawMain = copy
  }

  const flushCachedEquipRaw = () => {
    if (!writer) return 0
    let n = 0
    try {
      if (lastHeldRawMain?.length) {
        writer.heldRaw(lastHeldRawMain, {
          n: 'mob_equipment',
          p: { window_id: 'inventory', src: 'pre_start' }
        })
        n++
      }
      if (lastHeldRawOff?.length) {
        writer.heldRaw(lastHeldRawOff, {
          n: 'mob_equipment',
          p: { window_id: 'offhand', src: 'pre_start' }
        })
        n++
      }
      if (lastArmorRaw?.length) {
        writer.heldRaw(lastArmorRaw, {
          n: 'mob_armor_equipment',
          p: { src: 'pre_start' }
        })
        n++
      }
    } catch (e) {
      console.warn('[record] cached RAW equip flush failed', e.message)
    }
    if (n) {
      heldRawWritten += n
      heldEventsWritten += n
      console.log(`[record] Flushed ${n} cached RAW equip into mid-session recording`)
    }
    return n
  }

  /** @type {{ host: string, port: number } | null} */
  let overrideDest = null
  let expectReconnect = false
  let reconnectTimer = null
  let hop = 0

  const snapshot = (params) => revive(sanitize(params))

  const clearPresence = () => {
    knownPlayers = new Map()
    knownEntities = new Map()
    knownListRecords = new Map()
    knownArmor = new Map()
    knownItems = new Map()
  }

  const writeHeldSample = (sample, rawBuf = null) => {
    if (!recording || !writer || !sample) return false
    const offhand = !!(sample.offhand || isOffhandWindow(sample.window_id))

    // Prefer RAW bytes when present (client-encoded Item). JSON held stays as
    // a lightweight fallback for slot/nid logging / old play paths.
    if (rawBuf?.length && (sample.src === 'mob_equipment' || sample.src === 'mob_equipment_offhand')) {
      const nid = itemNetworkId(sample.item)
      const slot = offhand
        ? 1
        : Math.max(0, Math.min(8, Number(sample.selected_slot ?? sample.slot ?? 0) || 0))
      const sig = offhand ? `raw-off:${nid}` : `raw-main:${slot}:${nid}`
      if (offhand) {
        if (sig === heldLastSigOff && heldRawWritten > 0) return false
        heldLastSigOff = sig
        localOffhand = nid ? snapshot(sample.item) : { network_id: 0 }
        lastHeldRawOff = Buffer.from(rawBuf)
      } else {
        if (sig === heldLastSigMain && heldRawWritten > 0) return false
        heldLastSigMain = sig
        localHotbarSlot = slot
        if (nid) localHotbar[slot] = snapshot(sample.item)
        lastHeldRawMain = Buffer.from(rawBuf)
      }
      try {
        writer.heldRaw(rawBuf, {
          n: 'mob_equipment',
          p: {
            window_id: offhand ? 'offhand' : 'inventory',
            slot,
            selected_slot: offhand ? 0 : slot,
            network_id: nid,
            item: nid ? (sample.item || { network_id: nid }) : { network_id: 0 },
            src: sample.src
          }
        })
        heldRawWritten++
        heldEventsWritten++
        if (heldRawWritten <= 3 || heldRawWritten % 25 === 0) {
          console.log(
            `[record] heldRaw #${heldRawWritten} ${offhand ? 'OFF' : 'main'} ` +
            `slot=${slot} nid=${nid} len=${rawBuf.length}`
          )
        }
        return true
      } catch (e) {
        console.warn('[record] heldRaw failed', e.message)
      }
    }

    if (offhand) {
      let item = sample.item
      if (item == null) item = localOffhand
      const nid = itemNetworkId(item)
      localOffhand = nid ? snapshot(item) : { network_id: 0 }
      const sig = `off:${nid}`
      if (sig === heldLastSigOff && heldEventsWritten > 0) return false
      heldLastSigOff = sig
      try {
        writer.held({
          item: nid ? item : { network_id: 0 },
          slot: 1,
          selected_slot: 0,
          window_id: 'offhand'
        })
        heldEventsWritten++
        console.log(`[record] held #${heldEventsWritten} OFFHAND nid=${nid} via ${sample.src || '?'}`)
        return true
      } catch (e) {
        console.warn('[record] held offhand capture failed', e.message)
        return false
      }
    }

    let slot = Math.max(0, Math.min(8, Number(sample.selected_slot ?? sample.slot ?? localHotbarSlot) || 0))
    let item = sample.item
    if (sample.slotOnly || item == null) {
      item = localHotbar[slot] || { network_id: 0 }
    } else {
      const nid = itemNetworkId(item)
      localHotbar[slot] = nid ? snapshot(item) : { network_id: 0 }
    }
    localHotbarSlot = slot
    const nid = itemNetworkId(item)
    const sig = `main:${slot}:${nid}`
    // Skip identical spam from auth_input every tick
    if (sig === heldLastSigMain && heldEventsWritten > 0) return false
    heldLastSigMain = sig
    try {
      writer.held({
        item: nid ? item : { network_id: 0 },
        slot,
        selected_slot: slot,
        window_id: sample.window_id || 'inventory'
      })
      heldEventsWritten++
      if (heldEventsWritten === 1 || heldEventsWritten % 25 === 0) {
        console.log(`[record] held #${heldEventsWritten} main slot=${slot} nid=${nid} via ${sample.src || '?'}`)
      }
      return true
    } catch (e) {
      console.warn('[record] held capture failed', e.message)
      return false
    }
  }

  const trimBootstrap = () => {
    const max = 800
    if (bootstrapBuf.length <= max) return
    // Always keep pinned world defs (item_registry etc.) — dropping them = invisible drops
    const pinned = bootstrapBuf.filter((p) => BOOTSTRAP_PIN.has(p.name))
    const rest = bootstrapBuf.filter((p) => !BOOTSTRAP_PIN.has(p.name))
    const room = Math.max(0, max - pinned.length)
    bootstrapBuf = [...pinned, ...rest.slice(-room)]
  }

  const rememberBootstrap = (name, params) => {
    if (!BOOTSTRAP_PACKETS.has(name)) return
    if (name === 'start_game') {
      // New join: wipe chunks, but keep prior item_registry if server sent it before start_game
      const keep = bootstrapBuf.filter((p) => p.name === 'item_registry')
      bootstrapBuf = keep
    }
    // Latest wins for pinned singles
    if (BOOTSTRAP_PIN.has(name) && name !== 'level_chunk' && name !== 'subchunk') {
      bootstrapBuf = bootstrapBuf.filter((p) => p.name !== name)
    }
    const snap = snapshot(params)
    bootstrapBuf.push({ name, params: snap })
    // Persist item map for older mid-session replays that lost registry in the 800-cap trim
    if (name === 'item_registry' && Array.isArray(snap?.itemstates) && snap.itemstates.length) {
      persistItemRegistryCache(snap.itemstates, null)
    }
    trimBootstrap()
  }

  const rememberPresence = (name, params) => {
    if (name === 'start_game') {
      // New world session — old actors and terrain are gone. BUT: GamePE sends
      // the innermost spawn chunks BEFORE start_game (hold path), and those
      // belong to the NEW world. Wiping them left a hole under the start point.
      // Drop only stale entries; fresh ones (≤15s) are the new world's terrain.
      clearPresence()
      const cutoff = Date.now() - 15000
      let dropped = 0
      for (const [key, entry] of rawChunkCache) {
        if (entry.at < cutoff) {
          rawChunkCache.delete(key)
          dropped++
        }
      }
      if (dropped || rawChunkCache.size) {
        console.log(`[record] start_game: chunk cache pruned ${dropped}, kept ${rawChunkCache.size} fresh`)
      }
      return
    }
    if (name === 'add_player' && params) {
      const rid = ridStr(params.runtime_id)
      if (!rid) return
      knownPlayers.set(rid, snapshot(params))
      const uuid = params.uuid
      if (uuid && !knownListRecords.has(String(uuid))) {
        knownListRecords.set(String(uuid), snapshot({
          uuid,
          entity_unique_id: params.unique_id ?? params.entity_unique_id,
          username: params.username,
          xbox_user_id: params.xuid || '0',
          platform_chat_id: params.platform_chat_id || '',
          build_platform: params.device_os ?? 0,
          skin_data: params.skin || undefined,
          is_teacher: false,
          is_host: false,
          is_subclient: false,
          player_color: -1
        }))
      }
      return
    }
    if (name === 'add_entity' && params) {
      const rid = ridStr(params.runtime_id ?? params.runtime_entity_id)
      if (rid) knownEntities.set(rid, snapshot(params))
      return
    }
    if (name === 'add_item_entity' && params) {
      const rid = ridStr(params.runtime_entity_id ?? params.runtime_id)
      if (rid) knownItems.set(rid, snapshot(params))
      return
    }
    if (name === 'take_item_entity' && params) {
      const rid = ridStr(params.runtime_id ?? params.target)
      const uid = ridStr(params.entity_id_self)
      if (rid) knownItems.delete(rid)
      if (uid) {
        for (const [k, it] of knownItems) {
          if (ridStr(it.entity_id_self) === uid) knownItems.delete(k)
        }
      }
      return
    }
    if (name === 'player_list' && params) {
      const { type, records } = playerListRecords(params)
      const t = String(type ?? '')
      const isRemove = t === 'remove' || t === '1'
      for (const rec of records) {
        if (!rec) continue
        const uuid = rec.uuid != null ? String(rec.uuid) : null
        if (!uuid) continue
        if (isRemove) {
          knownListRecords.delete(uuid)
          for (const [rid, ap] of knownPlayers) {
            if (String(ap.uuid) === uuid) knownPlayers.delete(rid)
          }
        } else {
          knownListRecords.set(uuid, snapshot(rec))
        }
      }
      return
    }
    if (name === 'remove_entity' && params) {
      const uid = ridStr(params.entity_id_self ?? params.entity_unique_id)
      if (!uid) return
      for (const [rid, ap] of knownPlayers) {
        if (ridStr(ap.unique_id) === uid) {
          knownPlayers.delete(rid)
          if (ap.uuid) knownListRecords.delete(String(ap.uuid))
        }
      }
      for (const [rid, ent] of knownEntities) {
        if (ridStr(ent.entity_unique_id ?? ent.unique_id) === uid) knownEntities.delete(rid)
      }
      for (const [rid, it] of knownItems) {
        if (ridStr(it.entity_id_self) === uid) knownItems.delete(rid)
      }
      return
    }
    if (name === 'mob_armor_equipment' && params) {
      const rid = ridStr(params.runtime_entity_id ?? params.runtime_id)
      if (rid) knownArmor.set(rid, snapshot(params))
      return
    }
    // Keep spawn positions fresh until .start
    if ((name === 'move_entity' || name === 'move_entity_delta') && params) {
      const rid = ridStr(params.runtime_entity_id ?? params.runtime_id)
      if (!rid || !params.position) return
      if (knownPlayers.has(rid)) {
        const ap = knownPlayers.get(rid)
        knownPlayers.set(rid, { ...ap, position: { ...params.position } })
      }
      if (knownEntities.has(rid)) {
        const ent = knownEntities.get(rid)
        knownEntities.set(rid, { ...ent, position: { ...params.position } })
      }
      if (knownItems.has(rid)) {
        const it = knownItems.get(rid)
        knownItems.set(rid, { ...it, position: { ...params.position } })
      }
      return
    }
    if (name === 'move_player' && params?.position) {
      const rid = ridStr(params.runtime_id)
      if (rid && knownPlayers.has(rid)) {
        const ap = knownPlayers.get(rid)
        knownPlayers.set(rid, {
          ...ap,
          position: { ...params.position },
          pitch: params.pitch ?? ap.pitch,
          yaw: params.yaw ?? ap.yaw,
          head_yaw: params.head_yaw ?? ap.head_yaw
        })
      }
    }
  }

  const flushBootstrap = () => {
    if (!writer || !bootstrapBuf.length) return 0
    let n = 0
    for (const pkt of bootstrapBuf) {
      try {
        let params = pkt.params
        if (pkt.name === 'start_game') {
          params = patchStartGamePos(params)
        }
        writer.clientbound(pkt.name, params)
        n++
      } catch (e) {
        console.warn(`[record] bootstrap flush ${pkt.name}:`, e.message)
      }
    }
    console.log(`[record] Flushed ${n} bootstrap packets into recording (start_game+world)`)
    return n
  }

  const flushPresence = () => {
    if (!writer) return 0
    let n = 0
    const listRecs = [...knownListRecords.values()]
    if (listRecs.length) {
      try {
        const pl = fixPlayerListParams({
          records: { type: 'add', records: listRecs }
        })
        writer.clientbound('player_list', pl)
        n++
      } catch (e) {
        console.warn('[record] presence player_list:', e.message)
      }
    }
    for (const ap of knownPlayers.values()) {
      try {
        writer.clientbound('add_player', fixActorIds('add_player', ap))
        n++
        const rid = ridStr(ap.runtime_id)
        if (rid && knownArmor.has(rid)) {
          writer.clientbound('mob_armor_equipment', knownArmor.get(rid))
          n++
        }
      } catch (e) {
        console.warn('[record] presence add_player:', e.message)
      }
    }
    for (const ent of knownEntities.values()) {
      try {
        writer.clientbound('add_entity', fixActorIds('add_entity', ent))
        n++
      } catch (e) {
        console.warn('[record] presence add_entity:', e.message)
      }
    }
    for (const it of knownItems.values()) {
      try {
        writer.clientbound('add_item_entity', fixActorIds('add_item_entity', it))
        n++
      } catch (e) {
        console.warn('[record] presence add_item_entity:', e.message)
      }
    }
    console.log(
      `[record] Flushed presence: players=${knownPlayers.size} entities=${knownEntities.size} items=${knownItems.size} list=${listRecs.length}`
    )
    return n
  }

  const openWriter = (marker = 'start', nameHint = null) => {
    if (recording && writer) {
      writer.marker(marker)
      return writer
    }
    const base = sanitizeReplayName(nameHint) || sanitizeReplayName(pendingName) || nextReplayName(cfg.replaysDir)
    pendingName = null
    const filePath = uniqueReplayPath(cfg.replaysDir, base)
    writer = new ReplayWriter(filePath, {
      version,
      destination: { host: dest.host, port: dest.port || 19132 },
      offline: !!(dest.offline ?? cfg.offline),
      followTransfers,
      title: path.basename(filePath, '.mcreplay.gz')
    })
    recording = true
    recordingStartedAt = Date.now()
    heldEventsWritten = 0
    heldRawWritten = 0
    heldLastSigMain = ''
    heldLastSigOff = ''
    for (const k of Object.keys(sbHeldProbe)) delete sbHeldProbe[k]
    lastCheckpointAt = Date.now()
    writer.marker(marker)
    // Mid-session .start: prepend join bootstrap + everyone already in the world
    if (marker === 'manual_start') {
      const flushed = flushBootstrap()
      if (!flushed && cachedStartGame) {
        try {
          const p = patchStartGamePos({ ...cachedStartGame })
          writer.clientbound('start_game', p)
          console.log('[record] Injected cached start_game into mid-session recording')
        } catch (e) {
          console.warn('[record] Failed to inject cached start_game:', e.message)
        }
      }
      // Mobile raw path: terrain seen before .start (parsed path misses it).
      // noDrop: the writer's 64-slot raw queue would shift out the FIRST
      // (= innermost, GamePE sends center-out) chunks — hole under spawn.
      // item_registry MUST land before presence add_item_entity / inventory,
      // or the client hard-crashes on ground drops («Произошла ошибка»).
      if (rawItemRegistryBuf?.length) {
        try {
          writer.rawClientbound(rawItemRegistryBuf, { noDrop: true, n: 'item_registry' })
          console.log(`[record] Flushed raw item_registry (${rawItemRegistryBuf.length}B) into recording`)
        } catch (e) {
          console.warn('[record] item_registry flush failed', e.message)
        }
      } else {
        console.warn(
          '[record] No raw item_registry cached — PLAY may crash on items. ' +
          'Rejoin LIVE once so GamePE resends the palette, then .start again.'
        )
      }
      if (rawChunkCache.size) {
        let n = 0
        for (const entry of rawChunkCache.values()) {
          try {
            writer.rawClientbound(entry.buf, { noDrop: true })
            n++
          } catch {}
        }
        console.log(`[record] Flushed ${n} cached raw chunks into recording`)
      }
      flushPresence()
      // Current hotbar/armor from before .start (JSON held never saw these)
      flushCachedEquipRaw()
    }
    // Mid-session .start: login/join/1.5s captureSelf already ran while !recording.
    // Write self now or ghost falls back to login/Steve on PLAY.
    try {
      if (livePlayer) {
        const self = buildSelfRecord(livePlayer)
        if (self?.skin) {
          writer.self(self)
          console.log(
            `[record] Self identity: ${self.name} skin=yes bytes=` +
              `${self.skin?.skin_data?.$bytes?.length || self.skin?.skin_data?.data?.length || '?'}`
          )
        } else {
          console.warn('[record] Self skin not ready at .start — ghost may use login skin')
        }
      }
    } catch (e) {
      console.warn('[record] self capture at start failed', e.message)
    }
    console.log(`[record] STARTED → ${filePath}`)
    return writer
  }

  const closeWriter = async (reason = 'stop', renameTo = null) => {
    if (!writer) return null
    const w = writer
    writer = null
    recording = false
    recordingStartedAt = 0
    expectReconnect = false
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    const stats = await w.close({ reason })
    let finalPath = stats.path
    const want = sanitizeReplayName(renameTo)
    if (want) {
      const current = path.resolve(stats.path)
      const desired = path.join(cfg.replaysDir, `${want}.mcreplay.gz`)
      try {
        if (current === path.resolve(desired)) {
          finalPath = stats.path
        } else if (!fs.existsSync(desired)) {
          fs.renameSync(stats.path, desired)
          finalPath = desired
          console.log(`[record] Renamed → ${path.basename(desired)}`)
        } else {
          const destPath = uniqueReplayPath(cfg.replaysDir, want)
          fs.renameSync(stats.path, destPath)
          finalPath = destPath
          console.log(`[record] Renamed → ${path.basename(destPath)}`)
        }
        try {
          const fromMeta = replayMetaPath(stats.path)
          const toMeta = replayMetaPath(finalPath)
          if (fromMeta !== toMeta && fs.existsSync(fromMeta)) {
            try { fs.renameSync(fromMeta, toMeta) } catch {}
          }
        } catch {}
      } catch (e) {
        console.warn(`[record] Rename failed (${e.message}), keeping ${stats.path}`)
      }
    }
    pendingName = null
    console.log(`[record] SAVED ${finalPath}`)
    console.log(
      `[record] packets=${stats.packets} camera=${stats.cameras} ` +
      `held=${heldEventsWritten} heldRaw=${heldRawWritten} ` +
      `duration=${(stats.durationMs / 1000).toFixed(1)}s`
    )
    try {
      writeReplayMeta(finalPath, {
        durationMs: stats.durationMs,
        packets: stats.packets,
        cameras: stats.cameras,
        version: cfg.version || null,
        reason: reason || 'stop'
      })
    } catch (e) {
      console.warn(`[record] meta write failed: ${e.message}`)
    }
    try {
      if (registerReplay(finalPath)) {
        console.log(`[record] indexed for UI → ${path.basename(finalPath)}`)
      }
    } catch (e) {
      console.warn(`[record] index register failed: ${e.message}`)
    }
    if (!heldEventsWritten) {
      const probe = ['mob_equipment', 'player_hotbar', 'inventory_transaction', 'player_auth_input', 'item_stack_request']
        .map((n) => `${n}=${sbHeldProbe[n] || 0}`)
        .join(' ')
      console.warn(
        '[record] No held-events — hand will be empty in .free/.me. ' +
        'During recording: switch hotbar or use/place an item once. ' +
        `sb: ${probe}`
      )
    }
    return { ...stats, path: finalPath }
  }

  /** Drop in-progress recording without keeping the file (no .stop). */
  const discardWriter = async (reason = 'discard') => {
    if (!writer) return null
    const w = writer
    const filePath = w.filePath
    writer = null
    recording = false
    expectReconnect = false
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    pendingName = null
    try { await w.close({ reason }) } catch { /* ignore */ }
    try {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath)
    } catch (e) {
      console.warn(`[record] discard unlink failed: ${e.message}`)
    }
    console.log(`[record] DISCARDED (${reason}) ${filePath || '?'}`)
    return null
  }

  const resolvePlayFile = async (nameHint) => {
    if (recording && writer) {
      return closeWriter('switch_to_play', nameHint)
    }
    const list = listReplays(cfg.replaysDir)
    if (!list.length) return null
    if (nameHint) {
      const hit = list.find((r) => r.name === nameHint || r.name === `${nameHint}.mcreplay.gz` ||
        r.name.replace(/\.mcreplay\.gz$/i, '') === nameHint)
      if (hit) return { path: hit.path, packets: 0, cameras: 0, durationMs: 0 }
      // try with extension
      const p = path.join(cfg.replaysDir, nameHint.endsWith('.mcreplay.gz') ? nameHint : `${nameHint}.mcreplay.gz`)
      if (fs.existsSync(p)) return { path: p, packets: 0, cameras: 0, durationMs: 0 }
      return null
    }
    return { path: list[0].path, packets: 0, cameras: 0, durationMs: 0 }
  }

  /** True while Minecraft is connected but not yet past login (overlay must stay quiet). */
  let handshakeBusy = false

  const recordClientbound = (name, params) => {
    if (!recording || !writer) return
    // Chat off by default — cleaner replays for video
    if (!recordChat && (name === 'text' || name === 'whisper' || name === 'say')) return
    try {
      writer.clientbound(name, params)
    } catch (e) {
      console.error('[record] failed to write', name, e.message)
    }
  }

  const relay = new RecordingRelay({
    host: cfg.listenHost || '0.0.0.0',
    port: listenPort,
    version,
    offline: cfg.offline !== false,
    profilesFolder: cfg.profilesFolder,
    forceSingle: true,
    enableChunkCaching: false,
    // Parse-fail soft mode: jsp only. Native Android matches PC (hard fail + raw forward in relay).
    omitParseErrors: cfg.raknetBackend === 'jsp-raknet',
    motd: liveMotdOptions(),
    // Mobile: lighter deflate during handshake (big skin login)
    ...(process.env.BEDROCK_REPLAY_MOBILE === '1'
      ? { compressionLevel: 1, compressionThreshold: 256, batchingInterval: 10 }
      : {}),
    ...(cfg.raknetBackend === 'jsp-raknet'
      ? { raknetBackend: 'jsp-raknet', useNativeRaknet: false }
      : cfg.raknetBackend === 'raknet-native'
        ? { raknetBackend: 'raknet-native', useNativeRaknet: true }
        : {}),
    destination: {
      host: dest.host,
      port: dest.port || 19132,
      offline: dest.offline ?? cfg.offline
    },
    onMsaCode: (code, player) => {
      console.log('\n=== Microsoft login required ===')
      console.log(code.message || code)
      console.log('================================\n')
      player?.disconnect?.('Sign in using the code in the recorder console, then reconnect.')
    }
  })

  relay._openUpstream = async function (ds, clientAddr) {
    hop += 1
    const override = overrideDest
    const destNow = override || {
      host: this.options.destination.host,
      port: this.options.destination.port
    }
    if (override) overrideDest = null

    console.log(`[record] --- HOP ${hop} → ${destNow.host}:${destNow.port} ---`)
    const upOffline = this.options.destination.offline ?? this.options.offline
    const upName = (upOffline ? ds.profile?.name : ds.profile?.xuid) || ds.profile?.name || 'Player'
    console.log(`[record] Upstream identity offline=${Boolean(upOffline)} user=${upName} xuid=${ds.profile?.xuid || '-'} profile=${ds.profile?.name || '-'}`)

    const useJsp = cfg.raknetBackend === 'jsp-raknet' ||
      this.options.raknetBackend === 'jsp-raknet'
    const useNative = !useJsp && (
      cfg.raknetBackend === 'raknet-native' ||
      this.options.raknetBackend === 'raknet-native'
    )
    const options = {
      authTitle: this.options.authTitle,
      flow: this.options.flow,
      deviceType: this.options.deviceType,
      offline: upOffline,
      username: upName,
      version: this.options.version,
      realms: this.options.destination.realms,
      host: destNow.host,
      port: destNow.port,
      batchingInterval: this.options.batchingInterval,
      onMsaCode: (code) => {
        if (this.options.onMsaCode) this.options.onMsaCode(code, ds)
        else ds.disconnect("Sign in required:\n\n" + (code.message || code))
      },
      profilesFolder: this.options.profilesFolder,
      backend: this.options.backend,
      autoInitPlayer: false,
      // Skip dest ping on mobile / later hops — hanging ping = infinite “connecting”
      skipPing:
        hop > 1 ||
        Boolean(override) ||
        cfg.raknetBackend === 'jsp-raknet' ||
        process.env.BEDROCK_REPLAY_MOBILE === '1',
      ...(useJsp
        ? { raknetBackend: 'jsp-raknet', useNativeRaknet: false, useRaknetWorkers: false }
        : useNative
          ? { raknetBackend: 'raknet-native', useNativeRaknet: true, useRaknetWorkers: false }
          : {})
    }

    const client = new Client(options)
    // Forward client skin; mark trusted so local/third-party viewers accept custom PNGs
    if (!client.noLoginForward && ds.skinData) {
      client.options.skinData = {
        ...ds.skinData,
        TrustedSkin: true,
        OverrideSkin: true
      }
    }

    // Offline upstream normally gets uuidFrom(username) — that ≠ the Minecraft
    // client's real identity UUID. Server then advertises skin on the wrong UUID,
    // so others see you but local F5/body stays Steve (bedrock-protocol#438).
    // Align identity BEFORE sendLogin (session → _connect).
    client.on('session', () => {
      try {
        if (ds.profile?.uuid) client.profile.uuid = ds.profile.uuid
        if (ds.profile?.xuid != null && ds.profile.xuid !== '') {
          client.profile.xuid = ds.profile.xuid
        }
        if (ds.profile?.name) {
          client.profile.name = ds.profile.name
          client.username = ds.profile.name
        }
        console.log(
          `[record] upstream identity aligned uuid=${client.profile?.uuid} ` +
          `xuid=${client.profile?.xuid || 0} name=${client.username}`
        )
      } catch (e) {
        console.warn('[record] upstream identity align failed', e?.message || e)
      }
    })

    // Attach listeners BEFORE connect — jsp-raknet can fail immediately
    client.outLog = ds.upOutLog
    client.inLog = ds.upInLog
    client.on('error', (err) => {
      const msg = err?.message || String(err)
      console.warn(`[record] Upstream error: ${msg}`)
      if (!switchingAway && !expectReconnect && !inPlacePlay) {
        ds.disconnect('Не удалось подключиться к серверу:\n' + msg)
      }
      this.upstreams.delete(clientAddr.hash)
    })
    client.on('close', () => {
      console.log('[record] Upstream closed (GamePE side)')
      try { ds._liveDiag?.dumpKick?.('upstream_closed') } catch {}
      if (!expectReconnect && !switchingAway && !inPlacePlay) {
        // Prefer real disconnect text if GamePE sent one; else generic
        const why = ds._lastCbDisconnect || 'Сервер закрыл соединение'
        ds.disconnect(why)
      } else if (switchingAway || inPlacePlay) {
        console.log('[record] Upstream closed during in-place play — skip client kick')
      }
      this.upstreams.delete(clientAddr.hash)
    })
    client.once('join', () => {
      client.write('client_cache_status', { enabled: this.enableChunkCaching })
      ds.upstream = client
      ds.flushUpQueue()
      try { ds.startRelaying = true } catch {}
      try { ds.flushDownQueue() } catch {}
      console.log(`[record] Upstream joined ${options.host}:${options.port}`)
      // Attach AFTER flush — live packets during flush reorder/stall join (infinite search)
      client.readPacket = (packet) => ds.readUpstream(packet)
      this.emit('join', ds, client)
    })
    this.upstreams.set(clientAddr.hash, client)

    this.conLog?.('Connecting to', options.host, options.port)
    const connect = () => client.connect()
    if (options.skipPing) connect()
    else {
      client.ping().then(connect).catch((err) => {
        console.warn('[record] Ping failed:', err?.message || err)
        ds.disconnect('Пинг сервера не удался: ' + (err?.message || err))
        this.upstreams.delete(clientAddr.hash)
      })
    }
  }

  applyBedrockVersionCompat(relay, {
    protocolBase: version,
    advertiseVersion: opts.advertiseVersion || normalizeVersion(cfg.version) || version
  })

  // Must await: bind happens before onOpenConnection is wired; floating listen() races joins
  await Promise.resolve(relay.listen())
  try {
    if (relay.raknet) {
      relay.raknet.onOpenConnection = (conn) => relay.onOpenConnection(conn)
      console.log('[record] raknet onOpenConnection rebound to RecordingRelay')
    }
    // Kick forensics: 21 = client left on purpose, 22 = RakNet timeout/lost
    relay.raknet?.raknet?.on?.('closeConnection', (conn, id) => {
      console.log(`[record] raknet close id=${id} (21=client left, 22=connection lost) addr=${conn?.address ?? '?'}`)
    })
  } catch (e) {
    console.warn('[record] raknet rebind failed', e?.message || e)
  }
  try {
    // Warm shared ECDH on the relay before first Minecraft join (slow on Android ARM)
    const { createRequire } = await import('module')
    const req = createRequire(import.meta.url)
    const { KeyExchange } = req('bedrock-protocol/src/handshake/keyExchange.js')
    const warm = { on () {} }
    KeyExchange(warm, relay, relay.options || {})
    console.log('[record] ECDH keypair warmed')
  } catch (e) {
    console.warn('[record] ECDH warm failed:', e?.message || e)
  }
  try {
    const ad = relay.advertisement
    console.log(`[record] MOTD="${ad?.motd || '?'}" level=${ad?.levelName || '?'} ver=${ad?.version || '?'}`)
  } catch {}
  console.log(`[record] Proxy  ${cfg.listenHost || '0.0.0.0'}:${listenPort}`)
  console.log(`[record] Target ${dest.host}:${dest.port || 19132}  version=${version}`)
  console.log(`[record] LIVE ${advHost}:${advPort}  |  PLAY ${playHint.host}:${playHint.port}`)
  console.log(`[record] followTransfers=${followTransfers} recordChat=${recordChat}`)
  console.log('[record] Chat: .start / .stop / .play / .replays / .help')

  /** Push own skin onto the local client (offline-relay self-view fix). */
  const refreshLocalSkin = (player) => {
    if (!player || player.status === 'disconnected') return false
    const skin = fixSkin(skinFromLogin(player.skinData))
    if (!skin?.skin_data?.data?.length) return false
    const uuid = player.profile?.uuid
    if (!uuid) return false
    const name = player.profile?.name || player.username || 'Player'
    const uid = asUniqueId(
      player.entityId ??
      cachedStartGame?.runtime_entity_id ??
      cachedStartGame?.runtime_id ??
      1n
    )
    try {
      player.write('player_list', fixPlayerListParams({
        records: {
          type: 'add',
          records: [{
            uuid,
            entity_unique_id: uid,
            username: name,
            xbox_user_id: String(player.profile?.xuid || '0'),
            platform_chat_id: '',
            build_platform: 7,
            skin_data: skin,
            is_teacher: false,
            is_host: false,
            is_subclient: false,
            player_color: -1
          }],
          verified: [true]
        }
      }))
    } catch (e) {
      console.warn('[record] local player_list skin:', e.message)
    }
    try {
      player.write('player_skin', {
        uuid,
        skin,
        skin_name: name,
        old_skin_name: '',
        is_verified: true
      })
      console.log(
        `[record] local skin refresh uuid=${uuid} ` +
        `bytes=${skin.skin_data.data.length} arm=${skin.arm_size}`
      )
      return true
    } catch (e) {
      console.warn('[record] local player_skin:', e.message)
      return false
    }
  }

  relay.on('connect', (player) => {
    console.log(`[record] Client connected ${player.connection?.address}`)
    // Without an 'error' listener a decryption "Checksum mismatch" becomes an
    // uncaughtException thrown BEFORE the lib can disconnect — the session then
    // zombies: world streams in, but no serverbound packet decodes (no commands,
    // no movement reaches GamePE) until GamePE kicks ~70s later. Kick instantly.
    player.on('error', (err) => {
      const msg = err?.message || String(err)
      console.warn(`[record] client stream error: ${msg}`)
      if (/checksum mismatch/i.test(msg)) {
        console.warn('[record] serverbound decryption desynced — kicking client for clean rejoin')
        try { player.disconnect('Соединение рассинхронизировалось.\nПерезайди на сервер (LIVE).') } catch {}
        setTimeout(() => { try { player.close?.() } catch {} }, 500)
      }
    })
    livePlayer = player
    handshakeBusy = true
    worldReady = false
    leftHubLobby = false
    cachedStartGame = null
    bootstrapBuf = []
    rawChunkCache.clear()
    rawItemRegistryBuf = null
    clearPresence()
    lastCamPos = null

    const diag = createLiveDiag('record')
    player._liveDiag = diag
    // Start DIAG after login — interval+logging during handshake worsened “infinite loading”
    player.once('login', () => {
      handshakeBusy = false
      try { diag.start() } catch {}
    })
    player.on('diagUpstream', (info) => {
      try { diag.noteUpstream(info?.len, info?.ms, info) } catch {}
    })
    player.on('diagServerbound', (info) => {
      try {
        diag.noteServerbound(info?.path === 'raw' ? `raw:${info?.id ?? '?'}` : (info?.name || 'sb'))
      } catch {}
    })

    // Mobile raw SB: relay decode-samples auth_input (≤5/s) + equipment — camera/held
    // for .me/ghost. Bytes already forwarded raw; this is parse-only.
    // fullBuffer on mob_equipment → heldRaw (PLAY patches rid, never re-encodes Item).
    let sbSampleN = 0
    player.on('sbSample', ({ name, params, fullBuffer }) => {
      try {
        const cam = extractCamera(name, params)
        if (cam && isSanePos(cam)) {
          noteViewerPos(cam, name)
          if (recording && writer) {
            const now = Date.now()
            if (now - lastCamAt >= camEvery) {
              lastCamAt = now
              writer.camera(cam)
              sbSampleN++
              if (sbSampleN === 1 || sbSampleN % 100 === 0) {
                console.log(`[record] cam sample #${sbSampleN} via ${name} ${cam.x?.toFixed?.(0)},${cam.y?.toFixed?.(0)},${cam.z?.toFixed?.(0)}`)
              }
            }
          }
        }
        if (
          name === 'mob_equipment' || name === 'player_hotbar' ||
          name === 'inventory_transaction' || name === 'player_auth_input' ||
          name === 'item_stack_request'
        ) {
          sbHeldProbe[name] = (sbHeldProbe[name] || 0) + 1
        }
        const held = extractHeldFromServerbound(name, params)
        if (name === 'mob_equipment' && fullBuffer?.length) {
          // RAW path does not need a successful Item parse — bytes are enough.
          const sample = held || {
            item: { network_id: 0 },
            slot: 0,
            selected_slot: 0,
            window_id: 'inventory',
            src: 'mob_equipment'
          }
          rememberEquipRaw(sample, fullBuffer)
          if (recording && writer) {
            if (held) writeHeldSample(held, fullBuffer)
            else {
              // Unparsed: still store RAW so PLAY can patch rid + sendBuffer
              try {
                writer.heldRaw(fullBuffer, {
                  n: 'mob_equipment',
                  p: { window_id: 'inventory', src: 'mob_equipment_unparsed' }
                })
                heldRawWritten++
                heldEventsWritten++
                if (heldRawWritten <= 5 || heldRawWritten % 25 === 0) {
                  console.log(
                    `[record] heldRaw #${heldRawWritten} UNPARSED len=${fullBuffer.length}`
                  )
                }
              } catch (e) {
                console.warn('[record] heldRaw unparsed failed', e.message)
              }
            }
          }
        } else if (held) {
          if (recording && writer) writeHeldSample(held, null)
        }
      } catch (e) {
        console.warn('[record] sbSample fail:', e?.message || e)
      }
    })

    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    if (expectReconnect) {
      expectReconnect = false
      if (writer && recording) {
        writer.marker('reconnect_hop', { hop })
        console.log('[record] Continued recording after transfer reconnect')
      } else {
        console.log('[record] Transfer reconnect accepted')
      }
    } else if (cfg.autoRecord === true) {
      openWriter(hop <= 1 ? 'connect' : 'connect_new')
    }

    let selfCaptured = false
    const captureSelf = () => {
      if (!writer || !recording || selfCaptured) return
      try {
        const self = buildSelfRecord(player)
        if (!self.skin) {
          console.warn('[record] Self skin not ready yet, will retry…')
          return
        }
        writer.self(self)
        selfCaptured = true
        console.log(`[record] Self identity: ${self.name} skin=yes bytes=${self.skin?.skin_data?.$bytes?.length || self.skin?.skin_data?.data?.length || '?'}`)
      } catch (e) {
        console.warn('[record] self capture failed', e.message)
      }
    }
    player.on('login', captureSelf)
    player.on('join', captureSelf)
    setTimeout(captureSelf, 1500)

    patchFlushForRecording(player, recordClientbound)

    player.on('rawClientbound', (buf, packetId) => {
      try {
        if (!buf?.length) return
        // Cache chunks ALWAYS (also mid-recording): the NEXT .start in the same
        // session needs terrain under wherever the player is by then, and chunks
        // for that area only streamed once — during the previous recording.
        if (packetId != null && packetId === player._chunkPacketId) {
          rememberRawChunk(buf)
        }
        // item_registry: once per join, RAW on mobile — must survive until .start
        if (
          packetId != null &&
          packetId === (player._itemRegistryPacketId ?? 162) &&
          !rawItemRegistryBuf
        ) {
          rememberRawItemRegistry(buf, player)
        }
        // Self armor: GamePE sends inventory_content(window=armor), not
        // mob_armor_equipment. Convert Item bytes → ghost-ready armor packet.
        if (
          packetId === PKT_INVENTORY_CONTENT &&
          peekInventoryWindowId(buf) === WIN_ARMOR
        ) {
          const built = inventoryArmorToMobArmor(buf, 1n) // rid patched again on PLAY
          if (built?.length) {
            lastArmorRaw = built
            if (recording && writer) {
              try {
                writer.heldRaw(built, {
                  n: 'mob_armor_equipment',
                  p: { src: 'inventory_armor' }
                })
                heldRawWritten++
                heldEventsWritten++
                if (heldRawWritten <= 5 || heldRawWritten % 20 === 0) {
                  console.log(`[record] heldRaw armor #${heldRawWritten} len=${built.length}`)
                }
              } catch (e) {
                console.warn('[record] heldRaw armor convert failed', e.message)
              }
            }
          }
        }
        // Mid-fight armor updates are often inventory_slot, not a full content dump.
        if (
          packetId === PKT_INVENTORY_SLOT &&
          peekInventoryWindowId(buf) === WIN_ARMOR
        ) {
          const built = inventorySlotArmorToMobArmor(buf, 1n, armorKitItems)
          if (built?.length) {
            lastArmorRaw = built
            if (recording && writer) {
              try {
                writer.heldRaw(built, {
                  n: 'mob_armor_equipment',
                  p: { src: 'inventory_slot_armor' }
                })
                heldRawWritten++
                heldEventsWritten++
                if (heldRawWritten <= 5 || heldRawWritten % 20 === 0) {
                  console.log(`[record] heldRaw armor-slot #${heldRawWritten} len=${built.length}`)
                }
              } catch (e) {
                console.warn('[record] heldRaw armor-slot failed', e.message)
              }
            }
          }
        }
        if (!recording || !writer) return
        if (player._skipRecordUntil && Date.now() < player._skipRecordUntil) return
        writer.rawClientbound(buf)
        if (!player._rawHeavyN) player._rawHeavyN = 0
        player._rawHeavyN++
        // Only log fat bodies — tiny move spam flooded hub.log
        if (buf.length >= 50000 && (player._rawHeavyN <= 8 || player._rawHeavyN % 25 === 0)) {
          console.log(`[record] raw-heavy #${player._rawHeavyN} len=${buf.length}`)
        }
      } catch (e) {
        console.warn(`[record] rawClientbound fail: ${e?.message || e}`)
      }
    })

    player.on('clientbound', ({ name, params }, des) => {
      try {
      player._cbN = (player._cbN || 0) + 1
      player._lastCbName = name
      player._lastCbAt = Date.now()
      try { player._liveDiag?.noteClientbound?.(name) } catch {}
      // Follow transfer: keep Minecraft on OUR proxy, retarget upstream
      if (name === 'transfer' && followTransfers) {
        // Hub injects transfer via readUpstream — keep destination as-is
        // (.live = leave replay / disconnect; do not rewrite to a different host)
        const hub = player._hubTransfer
        if (hub?.server_address) {
          params.server_address = String(hub.server_address)
          params.port = Number(hub.port) & 0xffff
          if (hub.reload_world !== undefined) params.reload_world = !!hub.reload_world
          player._hubTransfer = null
          console.log(`[record] Hub transfer (passthrough) → ${params.server_address}:${params.port}`)
          return
        }

        const realHost = params.server_address
        const realPort = Number(params.port)
        console.log(`[record] *** TRANSFER *** → ${realHost}:${realPort}`)

        overrideDest = { host: realHost, port: realPort }
        expectReconnect = true

        if (writer && recording) {
          writer.marker('transfer', { host: realHost, port: realPort, reload_world: params.reload_world })
        }

        // Rewrite so client reconnects through this proxy.
        // Different host string than join address when on loopback (see transferAdvHost).
        params.server_address = transferAdvHost
        params.port = advPort
        if (params.reload_world === undefined) params.reload_world = true
        console.log(`[record] Rewrote transfer → ${transferAdvHost}:${advPort} (join was ${advHost}:${advPort})`)

        // Still record the ORIGINAL transfer target as a mark; also record rewritten packet for playback skip
        recordClientbound('transfer', {
          server_address: realHost,
          port: realPort,
          reload_world: params.reload_world,
          _proxy_rewrite: true
        })
        // Let rewritten packet go to client (des not canceled)
        return
      }

      if (name === 'start_game') {
        cachedStartGame = params
        worldReady = true
        localRuntimeId = ridStr(params?.runtime_entity_id ?? params?.runtime_id)
        const patchedHint = posFromStartGame(params)
        if (patchedHint) noteViewerPos(patchedHint, 'start_game')
        const sp = params?.player_position
        const worldSp = params?.spawn_position
        console.log(
          `[record] start_game pos=${sp?.x},${sp?.y},${sp?.z}` +
          ` spawn=${worldSp?.x},${worldSp?.y},${worldSp?.z} dim=${params?.dimension}` +
          ` rid=${localRuntimeId || '?'}`
        )
        // Stock relay waits 500ms before sentStartGame — chunks in that window go to
        // chunkSendCache and only flush on a LATER packet. If GamePE pauses → deadlock
        // → infinite "searching for server". Release immediately.
        try {
          player.sentStartGame = true
          // Do NOT enable RAW_ENT yet — raw during chunk flood stalls join (infinite search).
          // RAW_ENT starts at play_status player_spawn below.
          if (Array.isArray(player.chunkSendCache) && player.chunkSendCache.length) {
            const n = player.chunkSendCache.length
            for (const entry of player.chunkSendCache) {
              try { player.queue('level_chunk', entry) } catch {}
            }
            player.chunkSendCache = []
            console.log(`[record] flushed ${n} cached level_chunk after start_game`)
          }
          try { player._tick?.() } catch {}
        } catch (e) {
          console.warn('[record] start_game unblock:', e.message)
        }
        try {
          const side = path.join(cfg.replaysDir, '_last_start_game.json')
          fs.writeFileSync(side, JSON.stringify(sanitize(params)))
        } catch (e) {
          console.warn('[record] Could not cache start_game sidecar:', e.message)
        }
        if (cfg.autoRecord === true && !recording) {
          openWriter('start_game')
        }
      }
      if (name === 'play_status') {
        console.log(`[record] play_status ${params?.status}`)
        if (params?.status === 'player_spawn' || params?.status === 'login_success') {
          player._allowRawEnt = true
          player._joinSpawned = true
          console.log('[record] join spawn OK — RAW_ENT enabled')
          // Offline-relay local skin fix: re-assert own appearance on the client UUID
          try { refreshLocalSkin(player) } catch {}
          setTimeout(() => { try { refreshLocalSkin(player) } catch {} }, 800)
        }
        try { player._tick?.() } catch {}
      }
      if (name === 'level_chunk') {
        if (!player._chunkN) player._chunkN = 0
        player._chunkN++
        if (player._chunkN <= 3 || player._chunkN % 50 === 0) {
          console.log(`[record] level_chunk #${player._chunkN}`)
        }
      }

      if (!recording)       rememberBootstrap(name, params)
      rememberPresence(name, params)

      // Self armor RAW (PC full-parse path). Mobile whitelist usually never
      // names this packet — hands still come from SB mob_equipment samples.
      if (name === 'mob_armor_equipment' && des?.fullBuffer?.length) {
        const rid = ridStr(params?.runtime_entity_id ?? params?.runtime_id)
        const me = localRuntimeId || ridStr(cachedStartGame?.runtime_entity_id)
        if (rid && me && rid === me) {
          lastArmorRaw = Buffer.from(des.fullBuffer)
          if (recording && writer) {
            try {
              writer.heldRaw(des.fullBuffer, {
                n: 'mob_armor_equipment',
                p: { src: 'cb_self_armor' }
              })
              heldRawWritten++
              heldEventsWritten++
              if (heldRawWritten <= 3 || heldRawWritten % 20 === 0) {
                console.log(`[record] heldRaw armor #${heldRawWritten} len=${des.fullBuffer.length}`)
              }
            } catch (e) {
              console.warn('[record] heldRaw armor failed', e.message)
            }
          }
        }
      }
      // PC: armor often arrives as inventory_slot — fold into RAW kit for ghost.
      if (
        name === 'inventory_slot' &&
        des?.fullBuffer?.length &&
        (params?.window_id === 'armor' || params?.window_id === 120 || params?.window_id === '120')
      ) {
        const built = inventorySlotArmorToMobArmor(des.fullBuffer, 1n, armorKitItems)
        if (built?.length) {
          lastArmorRaw = built
          if (recording && writer) {
            try {
              writer.heldRaw(built, {
                n: 'mob_armor_equipment',
                p: { src: 'inventory_slot_armor' }
              })
              heldRawWritten++
              heldEventsWritten++
              if (heldRawWritten <= 3 || heldRawWritten % 20 === 0) {
                console.log(`[record] heldRaw armor-slot #${heldRawWritten} len=${built.length}`)
              }
            } catch (e) {
              console.warn('[record] heldRaw armor-slot failed', e.message)
            }
          }
        }
      }
      // Track viewer pos from CB (mobile SB auth_input is raw — no camera samples)
      {
        const cam = extractCamera(name, params)
        if (cam && isSanePos(cam)) noteViewerPos(cam, name)
      }
      const skipRec =
        recording && writer && player._skipRecordUntil && Date.now() < player._skipRecordUntil
      // Fat bodies: raw bytes into the file — JSON.stringify of chunk/skin params stalls LIVE.
      if (
        !skipRec &&
        recording && writer && des?.fullBuffer &&
        des.fullBuffer.length > 16384 &&
        name !== 'transfer'
      ) {
        try { writer.rawClientbound(des.fullBuffer) } catch (e) {
          console.warn(`[record] raw record fail ${name}: ${e?.message || e}`)
        }
      } else if (!skipRec) {
        // Always store a sane start_game position in the file
        if (name === 'start_game' && recording && writer) {
          recordClientbound(name, patchStartGamePos(params))
        } else {
          recordClientbound(name, params)
        }
      }

      if (!skipRec && recording && writer && checkpointEveryMs > 0) {
        const now = Date.now()
        if (now - lastCheckpointAt >= checkpointEveryMs) {
          lastCheckpointAt = now
          try { writer.marker('checkpoint') } catch {}
        }
      }

      if (name === 'add_player') {
        console.log(`[record] add_player ${params?.username || '?'} rid=${params?.runtime_id}`)
      }
      if (name === 'player_list') {
        const recs = params?.records?.records || params?.records || []
        const n = Array.isArray(recs) ? recs.length : (recs?.length ?? '?')
        if (!player._plLogN) player._plLogN = 0
        player._plLogN++
        const big = typeof n === 'number' && n >= 8
        if (big || player._plLogN <= 8 || player._plLogN % 40 === 0) {
          console.log(`[record] player_list type=${params?.records?.type || params?.type} count≈${n}`)
        }
      }
      if (name === 'modal_form_request') {
        const raw = params?.data ?? params?.form_data
        console.log(`[record] modal_form_request id=${params?.form_id} dataLen=${raw == null ? 0 : String(raw).length}`)
      }
      if (name === 'change_dimension') {
        // GamePE hub/mode often hops via void (0,300,0) — that is NOT "left hub".
        const p = params?.position
        const x = Number(p?.x)
        const y = Number(p?.y)
        const z = Number(p?.z)
        const voidHop =
          Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) &&
          Math.abs(x) < 0.01 && Math.abs(y - 300) < 0.01 && Math.abs(z) < 0.01
        if (!voidHop) leftHubLobby = true
        if (voidHop) {
          try { player._liveDiag?.noteHop?.() } catch {}
          // World-reset burst (new start_game + player_list/remove_entity flood)
          // must NOT enter the replay — PLAY used to jump playhead to that
          // second start_game (= spawn at end, duration≈5s) and kick on the flood.
          player._skipRecordUntil = Date.now() + 4500
          console.log('[record] void hop — skipping ~4.5s of world-reset packets in recording')
        }
        console.log(`[record] *** change_dimension *** dim=${params?.dimension} pos=${JSON.stringify(params?.position)} respawn=${params?.respawn} leftHub=${leftHubLobby} voidHop=${voidHop}`)
      }
      if (name === 'move_player' && params?.mode && params.mode !== 'normal') {
        if (!player._mpResetN) player._mpResetN = 0
        player._mpResetN++
        if (player._mpResetN <= 8 || player._mpResetN % 40 === 0) {
          const p = params?.position
          console.log(`[record] move_player mode=${params.mode} #${player._mpResetN} pos=${p?.x},${p?.y},${p?.z}`)
        }
      }
      if (name === 'update_client_input_locks') {
        console.log(`[record] input_locks ${JSON.stringify(params).slice(0, 160)}`)
      }
      if (name === 'disconnect') {
        let msg = String(params?.message || params?.reason || '').slice(0, 200)
        if (/перезагружается|подключены к лобби|connected to (the )?lobby/i.test(msg)) {
          console.log(`[record] CB disconnect (GamePE mode drop): ${msg}`)
          msg = '§cGamePE закрыл режим (пишет «перезагрузка», но хаб жив).\n§7Зайди на LIVE снова и выбери режим.'
          try { params.message = msg } catch {}
        } else {
          console.log(`[record] CB disconnect: ${msg}`)
        }
        player._lastCbDisconnect = msg || 'disconnect'
      }

      // Deferred heavy path removed — see rawClientbound (no live parse).

      // RAW_ENT: jsp-raknet only. Native = re-encode via queue (PC path).
      const jspRaw =
        cfg.raknetBackend === 'jsp-raknet' &&
        des?.fullBuffer &&
        name !== 'transfer'
      const jspRawEnt = jspRaw && player._allowRawEnt === true
      if (jspRaw && (name === 'player_list' || (jspRawEnt && MOBILE_RAW_ENT.has(name)))) {
        des.canceled = true
        try {
          player.sendBuffer(Buffer.from(des.fullBuffer), false)
          if (
            name === 'player_list' ||
            name === 'change_dimension' ||
            name === 'modal_form_request' ||
            name === 'add_player' ||
            name === 'respawn'
          ) {
            try { player._tick?.() } catch {}
          }
          if (!player._rawEntN) player._rawEntN = 0
          player._rawEntN++
          if (player._rawEntN <= 20 || name === 'change_dimension' || name === 'modal_form_request') {
            console.log(`[record] raw-ent ${name} #${player._rawEntN} len=${des.fullBuffer.length}`)
          }
        } catch (e) {
          console.warn(`[record] raw-ent fail ${name}: ${e.message}`)
          try { player.queue(name, params) } catch {}
        }
      }
      if (jspRaw && !player._joinSpawned) {
        try { player._tick?.() } catch {}
      }
      } catch (e) {
        console.error(`[record] clientbound handler error ${name}:`, e?.message || e)
      }
    })

    if (player._aliveTimer) clearInterval(player._aliveTimer)
    // Don't spam alive logs during handshake — wait until login
    const startAlive = () => {
      if (player._aliveTimer) return
      player._aliveTimer = setInterval(() => {
        if (!player || player.status === 'disconnected') {
          clearInterval(player._aliveTimer)
          return
        }
        const ago = player._lastCbAt ? Date.now() - player._lastCbAt : -1
        const d = player._liveDiag?.state
        const sbAgo = d?.lastSbAt ? Date.now() - d.lastSbAt : -1
        console.log(
          `[record] alive up=${Boolean(player.upstream)} cb=${player._cbN || 0} ` +
          `rawEnt=${player._rawEntN || 0} chunks=${player._chunkN || 0} ` +
          `last=${player._lastCbName || '-'} ago=${ago}ms ` +
          `sbAgo=${sbAgo}ms lag=${d?.lagLastMs ?? '?'}(max ${d?.lagMaxMs ?? '?'}) ` +
          `maxPkt=${d?.maxPkt ?? 0} slow=${d?.slowN ?? 0}`
        )
      }, 8000)
    }
    player.once('login', startAlive)

    player.on('serverbound', ({ name, params }, des) => {
      try { player._liveDiag?.noteServerbound?.(name) } catch {}
      // Rate meter — diagnose "spam from client" kicks (auth_input / forms)
      if (!player._sbRate) {
        player._sbRate = { t0: Date.now(), n: 0, by: Object.create(null) }
      }
      const rate = player._sbRate
      rate.n++
      rate.by[name] = (rate.by[name] || 0) + 1
      const elapsed = Date.now() - rate.t0
      if (elapsed >= 1000) {
        const top = Object.entries(rate.by)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([k, v]) => `${k}:${v}`)
          .join(' ')
        console.log(`[record] sb/s≈${Math.round(rate.n * 1000 / elapsed)} n=${rate.n} ${top}`)
        player._sbRate = { t0: Date.now(), n: 0, by: Object.create(null) }
      }

      if (name === 'modal_form_response') {
        console.log(
          `[record] modal_form_response id=${params?.form_id} ` +
          `cancel=${params?.cancel ?? params?.cancelled} ` +
          `hasData=${params?.data != null || params?.form_response != null}`
        )
      }

      const chatRaw = name === 'text'
        ? params?.message
        : name === 'command_request'
          ? params?.command
          : null

      // In-place replay: .live must work even if play.js listeners missed the packet
      if (inPlacePlay && chatRaw && isLiveChatCommand(chatRaw)) {
        des.canceled = true
        console.log('[record] in-place .live from chat')
        if (typeof onInPlaceLive === 'function') {
          Promise.resolve(onInPlaceLive({ player })).catch((e) => {
            console.error('[record] onInPlaceLive failed', e)
            try {
              player.queue('text', systemText(`§c[Replay] .live: ${e.message}`))
            } catch {}
          })
        } else {
          try {
            player.queue('text', systemText('§c[Replay] .live = выход из просмотра · сейчас недоступен'))
          } catch {}
        }
        return
      }

      // During in-place replay, block record cmds; freecam cmds go to play.js
      if (inPlacePlay && chatRaw && parseRecCommand(chatRaw)) {
        des.canceled = true
        return
      }

      let command = null
      if (name === 'text') command = parseRecCommand(params?.message)
      if (name === 'command_request') command = parseRecCommand(params?.command)

      if (command) {
        des.canceled = true
        const say = (msg) => {
          try { player.queue('text', systemText(msg)) } catch {}
        }
        if (command.action === 'help') {
          sayLiveHelp(say, playHint)
          return
        }
        if (command.action === 'start') {
          if (recording) say('§e[Replay] Already recording')
          else {
            openWriter('manual_start', command.name)
            const label = path.basename(writer.filePath).replace(/\.mcreplay\.gz$/i, '')
            say(`§a[Replay] Запись §f${label}`)
            if (!cachedStartGame && !bootstrapBuf.some((p) => p.name === 'start_game')) {
              say('§e[Replay] Нет start_game — перезайди и снова §f.start')
            }
            console.log('[record] Manual start via chat')
          }
          return
        }
        if (command.action === 'stop') {
          const renameTo = command.name
          closeWriter('manual_stop', renameTo).then((stats) => {
            const label = stats ? path.basename(stats.path) : '?'
            say(`§a[Replay] Сохранено §f${label.replace(/\.mcreplay\.gz$/i, '')}`)
          })
          return
        }
        if (command.action === 'status') {
          const label = writer ? path.basename(writer.filePath) : ''
          say(
            recording
              ? `§a[Replay] Идёт запись §7${label.replace(/\.mcreplay\.gz$/i, '')}`
              : '§e[Replay] Не пишем — §f.start'
          )
          return
        }
        if (command.action === 'list') {
          const list = listReplays(cfg.replaysDir)
          if (!list.length) {
            say('§e[Replay] Пусто — §f.start')
            return
          }
          const names = list.slice(0, 8).map((r) => r.name.replace(/\.mcreplay\.gz$/i, ''))
          say(`§e[Replay] ${list.length}: §f${names.join('§7, §f')}${list.length > 8 ? ' §7…' : ''}`)
          return
        }
        if (command.action === 'play') {
          if (typeof onPlayCommand === 'function') {
            switchingAway = true
            Promise.resolve(onPlayCommand({
              player,
              name: command.name,
              resolvePlayFile,
              closeWriter,
              relay,
              cfg,
              version
            })).catch((e) => {
              switchingAway = false
              console.error('[record] .play failed', e)
              try {
                say(`§c[Replay] .play failed: ${e.message}`)
              } catch {}
            })
          } else {
            say('§e[Replay] Use §fstart.bat §e/ §fnode src/cli.js start §efor .play switch')
          }
          return
        }
        return
      }

      // Own hand: GamePE never clientbounds your mob_equipment. Prefer auth_input /
      // inventory_transaction held_item; also mob_equipment / player_hotbar if present.
      // When fullBuffer is present (PC path / sampled SB), store RAW for safe PLAY.
      if (
        name === 'mob_equipment' || name === 'player_hotbar' ||
        name === 'inventory_transaction' || name === 'player_auth_input' ||
        name === 'item_stack_request'
      ) {
        sbHeldProbe[name] = (sbHeldProbe[name] || 0) + 1
      }
      const held = extractHeldFromServerbound(name, params)
      if (held) {
        const raw =
          name === 'mob_equipment' && des?.fullBuffer?.length
            ? des.fullBuffer
            : null
        if (raw) rememberEquipRaw(held, raw)
        if (recording && writer) writeHeldSample(held, raw)
      }

      const cam = extractCamera(name, params)
      if (cam) {
        lastCamPos = cam
        if (recording && writer) {
          const now = Date.now()
          if (now - lastCamAt >= camEvery) {
            lastCamAt = now
            writer.camera(cam)
          }
        }
      }

      // jsp only: raw init packet (native = PC path)
      const mobileSb =
        cfg.raknetBackend === 'jsp-raknet' &&
        des?.fullBuffer &&
        player.upstream &&
        name === 'set_local_player_as_initialized'
      if (mobileSb) {
        des.canceled = true
        try {
          player.upstream.sendBuffer(Buffer.from(des.fullBuffer), false)
          console.log('[record] raw-sb set_local_player_as_initialized')
        } catch (e) {
          console.warn(`[record] raw-sb fail ${name}: ${e.message}`)
          des.canceled = false
        }
      }
    })

    player.on('close', () => {
      console.log('[record] Client disconnected')
      try { player._liveDiag?.dumpKick?.('client_disconnected') } catch {}
      try { player._liveDiag?.stop?.() } catch {}
      try { if (player._aliveTimer) clearInterval(player._aliveTimer) } catch {}
      // Upstream nick drop already handled in RecordingRelay.onOpenConnection
      if (livePlayer === player) {
        livePlayer = null
        worldReady = false
        inPlacePlay = false
        leftHubLobby = false
        handshakeBusy = false
      }
      if (switchingAway) {
        console.log('[record] Switch away — skip auto-save on disconnect')
        return
      }
      if (expectReconnect && recording) {
        console.log('[record] Waiting up to 90s for transfer reconnect…')
        reconnectTimer = setTimeout(() => {
          if (cfg.saveOnDisconnect !== false) {
            console.log('[record] Transfer reconnect timed out — saving')
            closeWriter('transfer_timeout')
          } else {
            console.log('[record] Transfer reconnect timed out — discard (saveOnDisconnect=false)')
            discardWriter('transfer_timeout')
          }
        }, 90000)
        return
      }
      // Default: save when leaving the game (unless saveOnDisconnect=false).
      if (cfg.saveOnDisconnect !== false) {
        closeWriter('disconnect')
      } else if (recording && writer) {
        console.log('[record] Disconnect — discard (saveOnDisconnect=false, use .stop to keep)')
        discardWriter('disconnect')
      }
    })
  })

  relay.on('join', () => {
    console.log('[record] Upstream session ready')
  })

  relay.on('error', (err) => console.error('[record] error', err))

  const shutdown = async () => {
    console.log('\n[record] Shutting down…')
    await closeWriter('shutdown')
    try { relay.close() } catch {}
    process.exit(0)
  }
  if (ownSignals) {
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }

  /** Strip GamePE actors from the client so replay does not mix with live world */
  const wipeLiveActorsFromClient = (player) => {
    let removed = 0
    const drop = (uid) => {
      if (uid == null) return
      try {
        player.write('remove_entity', { entity_id_self: asUniqueId(uid) })
        removed++
      } catch {}
    }
    for (const ap of knownPlayers.values()) {
      drop(ap.unique_id ?? ap.entity_unique_id)
    }
    for (const ent of knownEntities.values()) {
      drop(ent.entity_unique_id ?? ent.unique_id ?? ent.entity_id_self)
    }
    for (const it of knownItems.values()) {
      drop(it.entity_id_self ?? it.entity_unique_id)
    }
    const uuids = [...knownListRecords.keys()]
    if (uuids.length) {
      try {
        player.write('player_list', fixPlayerListParams({
          records: {
            type: 'remove',
            records: uuids.map((uuid) => ({ uuid }))
          }
        }))
      } catch {}
    }
    try { player.write('clientbound_close_form', {}) } catch {}
    try { player.write('set_title', { type: 'clear', text: '', fade_in_time: 0, stay_time: 0, fade_out_time: 0, xuid: '', platform_online_id: '' }) } catch {}
    console.log(`[record] Wiped ~${removed} live actors from client before replay`)
  }

  const detachForInPlacePlay = (player) => {
    inPlacePlay = true
    switchingAway = true

    // Drop any queued live packets so they cannot flush into the replay later
    try { player.downQ = [] } catch {}
    try { player.upQ = [] } catch {}
    try { player.sendQ = [] } catch {}

    // Relay with startRelaying=true + upstream=null silently queues chat into upQ.
    // Patch readPacket so chat/movement emit normally during in-place replay.
    try {
      if (player && !player._inPlaceReadPatched) {
        player._origReadPacket = player.readPacket.bind(player)
        player._origReadUpstream = player.readUpstream?.bind(player)
        player._inPlaceReadPatched = true
      }
      if (player?._origReadPacket) {
        player.readPacket = function inPlaceReadPacket (packet) {
          if (!inPlacePlay) {
            return player._origReadPacket(packet)
          }
          try {
            const des = this.server.deserializer.parsePacketBuffer(packet)
            // Replay bootstrap re-sends start_game → client re-initializes and
            // reports done. Without this, status stays 3 and play's spawn-wait
            // burns its full 8s timeout ("slow first teleport").
            if (des.data.name === 'set_local_player_as_initialized') {
              this.status = 4 // ClientStatus.Initialized
              this.emit('spawn')
            }
            this.emit('serverbound', des.data, des)
            if (!des.canceled) {
              this.emit(des.data.name, des.data.params)
              this.emit('packet', des)
            }
          } catch (e) {
            console.warn('[record] in-place readPacket:', e.message)
          }
        }
      }
      // Hard-drop any stray upstream bytes while replay owns the socket
      if (typeof player.readUpstream === 'function') {
        player.readUpstream = function inPlaceDropUpstream () {
          if (!inPlacePlay && player._origReadUpstream) {
            return player._origReadUpstream.apply(this, arguments)
          }
          // discard
        }
      }
    } catch (e) {
      console.warn('[record] readPacket patch failed:', e.message)
    }

    try {
      if (player && 'startRelaying' in player) player.startRelaying = false
    } catch {}
    try {
      const addr = player?.connection?.address
      const up = player?.upstream || (addr?.hash != null ? relay.upstreams.get(addr.hash) : null)
      if (up) {
        try { up.removeAllListeners('close') } catch {}
        try { up.removeAllListeners('error') } catch {}
        try { up.removeAllListeners('kick') } catch {}
        try { up.close() } catch {}
      }
      try { player.upstream = null } catch {}
      if (addr?.hash != null) relay.upstreams.delete(addr.hash)
    } catch (e) {
      console.warn('[record] detachForInPlacePlay:', e.message)
    }

    try { wipeLiveActorsFromClient(player) } catch (e) {
      console.warn('[record] wipeLiveActors:', e.message)
    }

    console.log('[record] Detached upstream for in-place replay (chat bridge on)')
  }

  /**
   * After in-place replay, Bedrock cannot reliably reload GamePE on the same
   * RakNet session (freeze / infinite terrain / ignored transfer).
   * .live = leave replay (disconnect); user joins LIVE again — no hot-return.
   */
  const resumeLive = async (player) => {
    if (!player) throw new Error('No player')

    try {
      if (player._origReadPacket) player.readPacket = player._origReadPacket
      if (player._origReadUpstream) player.readUpstream = player._origReadUpstream
    } catch {}

    inPlacePlay = false
    switchingAway = true

    try { player.downQ = [] } catch {}
    try { player.upQ = [] } catch {}
    try {
      const addr = player.connection?.address
      const up = player.upstream || (addr?.hash != null ? relay.upstreams.get(addr.hash) : null)
      if (up) {
        try { up.removeAllListeners('close') } catch {}
        try { up.removeAllListeners('error') } catch {}
        try { up.close() } catch {}
      }
      player.upstream = null
      if (addr?.hash != null) relay.upstreams.delete(addr.hash)
    } catch {}
    try { player.startRelaying = false } catch {}

    const tip = `${advHost}:${advPort}`
    console.log(`[record] .live → rejoin hint ${tip} (no mid-session GamePE resume)`)

    try {
      player.queue('text', systemText(`§e[Replay] Выход из просмотра · зайди на LIVE: §f${tip}`))
      if (typeof player._tick === 'function') player._tick()
    } catch {}

    await new Promise((r) => setTimeout(r, 400))

    try {
      player.disconnect(`§eВыход из просмотра\n§7Зайди на LIVE:\n§f${tip}`)
    } catch {}

    return { ok: true, method: 'rejoin-hint' }
  }

  return {
    relay,
    closeWriter,
    resolvePlayFile,
    get recording () { return recording },
    get writer () { return writer },
    get inPlacePlay () { return inPlacePlay },
    /** Minecraft joined LIVE proxy (may still be loading). */
    get clientLive () { return !!(livePlayer && !inPlacePlay) },
    get handshakeBusy () { return !!handshakeBusy },
    /** In-world after start_game — preferred for overlay “LIVE” chrome. */
    get overlayLive () { return !!(livePlayer && worldReady && !inPlacePlay) },
    get worldReady () { return worldReady },
    get overlayPlay () { return !!(livePlayer && inPlacePlay) },
    /**
     * LIVE world ready for overlay replay pick.
     * (GamePE void hops made change_dimension a bad "left hub" signal — allow anytime in LIVE.)
     */
    get hubLobby () { return !!(livePlayer && worldReady && !inPlacePlay) },
    get recordingElapsedMs () {
      if (!recording || !recordingStartedAt) return 0
      return Math.max(0, Date.now() - recordingStartedAt)
    },
    startManual (nameHint = null) {
      // Same rules as chat `.start` — do not require worldReady (overlay used to fail with not_in_world).
      if (!livePlayer) {
        return { ok: false, error: 'not_connected' }
      }
      if (inPlacePlay) return { ok: false, error: 'in_play' }
      if (recording) return { ok: true, already: true }
      openWriter('manual_start', nameHint)
      console.log('[record] Manual start via overlay/API')
      return { ok: true, recording: true, worldReady: !!worldReady }
    },
    async stopManual (nameHint = null) {
      if (!recording) return { ok: false, error: 'not_recording' }
      const stats = await closeWriter('manual_stop', nameHint)
      return { ok: true, ...(stats || {}) }
    },
    version,
    cfg,
    setSwitchingAway (v) { switchingAway = !!v },
    detachForInPlacePlay,
    resumeLive,
    shutdown
  }
}
