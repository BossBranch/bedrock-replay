import path from 'path'
import { randomUUID } from 'crypto'
import bedrock from 'bedrock-protocol'
import { loadConfig, listReplays, normalizeVersion } from './config.js'
import {
  resolveRuntimeVersion,
  viewerModeForVersion,
  versionsCompatible,
  possessEnabledForVersion,
  applyBedrockVersionCompat
} from './version.js'
import * as viewer from './viewer.js'
import {
  forceViewerMode,
  clearLocalArmor
} from './viewer.js'
import {
  ME_PATH_LABELS,
  ME_COMMITTED_ME_PATH
} from './mePaths.js'
import { playMotdOptions } from './transfer.js'
import { SKIP_PLAY_CLIENTBOUND, SOUND_PACKETS, revive } from './format.js'
import { loadTimelineStreaming } from './replayStream.js'
import {
  buildGhostPackets,
  findAddPlayerTemplate,
  ghostMovePackets,
  loadSelfFromEvents,
  densifyCamEvents,
  GHOST_RUNTIME_ID,
  GHOST_UNIQUE_ID,
  setGhostVisible,
  setEntityVisible,
  setPlayerNametag,
  forceEntityInvisibleParams,
  withAllArmorCleared,
  writeArmorEquipment,
  normalizeSkin
} from './ghost.js'
import { SpectateController, ridKey, ghostKey } from './spectate.js'
import { ControlPlane } from './control/plane.js'
import { ReplayTransport } from './control/transport.js'
import { startControlServer } from './control/web.js'
import {
  giveControlHotbar,
  attachSpectatorHotbar,
  forceHotbarSlot,
  IDLE_PARK_SLOT
} from './control/hotbar.js'
import { buildSeekIndex } from './seek/index.js'
import fs from 'fs'
import { buildSyntheticStartGame } from './startGameBootstrap.js'
import { fixPlayerListParams, fixActorIds, fixSkin, asUniqueId } from './packetFix.js'
import { replaceRuntimeEntityId, inventoryArmorToMobArmor, peekInventoryWindowId, readVarIntAt, PKT_INVENTORY_CONTENT, PKT_INVENTORY_SLOT, WIN_ARMOR } from './packetPatch.js'

function loadCachedStartGame (replaysDir) {
  try {
    const p = path.join(replaysDir, '_last_start_game.json')
    if (!fs.existsSync(p)) return null
    return revive(JSON.parse(fs.readFileSync(p, 'utf8')))
  } catch {
    return null
  }
}

function sleep (ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)))
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

/** Pull chat string from Bedrock text / command_request shapes */
function extractChatRaw (p) {
  if (p == null) return ''
  if (typeof p === 'string') return p
  const candidates = [
    p.message,
    p.command,
    p.raw_text,
    p.msg,
    typeof p.message === 'object' ? p.message?.message : null,
    p.parameters?.message,
    p.parameters?.command
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c
  }
  return ''
}

/** UI packets that must never control the spectator viewer */
export const SUPPRESS_UI_PACKETS = new Set([
  'modal_form_request',
  'npc_dialogue',
  'npc_dialogue_request',
  'open_sign',
  'container_open',
  'server_settings_response',
  'show_profile',
  'transfer',
  'toast_request'
])

/**
 * During keep-camera catch-up (.restart / seek without .restart0) never write these.
 * Re-sending start_game / chunks / gamemode snaps Bedrock freecam to spawn.
 */
export const KEEP_CAM_CATCHUP_BLOCK = new Set([
  'start_game',
  'set_player_game_type',
  'update_abilities',
  'client_cheat_ability',
  'adventure_settings',
  'update_client_input_locks',
  'respawn',
  'set_spawn_position',
  'camera_instruction',
  'camera',
  'change_dimension',
  'correct_player_move_prediction',
  'network_chunk_publisher_update',
  'motion_prediction_hints',
  'player_fog',
  'set_health',
  'death_info',
  'level_chunk',
  'subchunk',
  'update_block',
  'update_subchunk_blocks',
  'level_event',
  'level_event_generic',
  'biome_definition_list',
  'dimension_data',
  'item_registry',
  'creative_content',
  'crafting_data',
  'available_commands',
  'chunk_radius_update',
  'network_settings',
  'play_status',
  'resource_packs_info',
  'resource_pack_stack',
  'game_rules_changed',
  'set_title',
  'set_hud'
])

/**
 * After .restart + freecam move + ▶ : still block spawn-yank packets, but allow
 * world updates (chunks/blocks). Full KEEP_CAM_CATCHUP_BLOCK is catch-up only.
 */
export const SPAWN_YANK_BLOCK = new Set([
  'start_game',
  'set_player_game_type',
  'update_player_game_type',
  'update_abilities',
  'client_cheat_ability',
  'adventure_settings',
  'update_client_input_locks',
  'respawn',
  'set_spawn_position',
  'camera_instruction',
  'camera',
  'change_dimension',
  'correct_player_move_prediction',
  'motion_prediction_hints',
  'player_fog',
  'set_health',
  'death_info',
  'play_status',
  'resource_packs_info',
  'resource_pack_stack'
])

/** Sent out-of-order before the clock when recording has no start_game */
const WORLD_PRELOAD_PACKETS = new Set([
  'network_chunk_publisher_update',
  'level_chunk',
  'subchunk',
  'update_block',
  'update_subchunk_blocks',
  'set_time'
])

/** Big welcome / server titles from the recording */
export const SUPPRESS_TITLE_PACKETS = new Set([
  'set_title'
])

/** Recording HUD tweaks that can hide crosshair / mess freecam UI */
export const SUPPRESS_HUD_PACKETS = new Set([
  'set_hud'
])

/** Server chat / tips from the recording — off by default for clean video */
export const SUPPRESS_CHAT_PACKETS = new Set([
  'text',
  'whisper',
  'say',
  'toast_request'
])

/**
 * Right-side server sidebar (scoreboard) — GamePE etc.
 * Not the bottom hotbar (inventory slots).
 */
export const SUPPRESS_SIDEBAR_PACKETS = new Set([
  'set_display_objective',
  'set_score',
  'set_scoreboard_identity',
  'remove_objective'
])

/** Player locator bar waypoints (newer Bedrock) */
export const SUPPRESS_LOCATOR_PACKETS = new Set([
  'locator_bar'
])

/** Bottom inventory hotbar spam from recording */
export const SUPPRESS_INVENTORY_PACKETS = new Set([
  'inventory_slot',
  'inventory_content',
  'player_hotbar',
  'creative_content',
  'inventory_transaction',
  'mob_equipment'
])

function emptyItem () {
  return { network_id: 0 }
}

/**
 * Recorded GamePE inventory_* often deserialize container_id as anvil_input (u8=0).
 * Re-sending that applies to the wrong container — looks like "inventory broken".
 */
function containerForInvWindow (windowId, slot = null, isContent = false) {
  const w = windowId
  const ws = typeof w === 'string' ? w.toLowerCase() : w
  if (ws === 'armor' || ws === 6 || ws === '6') return { container_id: 'armor' }
  if (ws === 'offhand' || ws === 119 || ws === '119') return { container_id: 'offhand' }
  if (ws === 'ui' || ws === 124 || ws === '124') return { container_id: 'cursor' }
  if (isContent) return { container_id: 'hotbar_and_inventory' }
  const s = Number(slot)
  if (Number.isFinite(s) && s >= 0 && s <= 8) return { container_id: 'hotbar' }
  if (Number.isFinite(s) && s >= 9) return { container_id: 'inventory' }
  return { container_id: 'inventory' }
}

function fixInventoryParams (name, params) {
  if (!params || (name !== 'inventory_slot' && name !== 'inventory_content')) return params
  const isContent = name === 'inventory_content'
  return {
    ...params,
    container: containerForInvWindow(params.window_id, params.slot, isContent),
    storage_item:
      params.storage_item && params.storage_item.network_id != null
        ? params.storage_item
        : emptyItem()
  }
}

/** Force classic humanoid skin — client often rejects persona leftovers on local player_skin. */
function classicizeSkin (skin) {
  const n = normalizeSkin(skin)
  if (!n) return null
  const id = `replay-${randomUUID()}`
  return {
    ...n,
    skin_id: id,
    full_skin_id: id,
    play_fab_id: '',
    skin_resource_pack: '{"geometry":{"default":"geometry.humanoid.custom"}}',
    geometry_data: '',
    geometry_data_version: '',
    animation_data: '',
    animations: [],
    personal_pieces: [],
    piece_tint_colors: [],
    premium: false,
    persona: false,
    cape_on_classic: false,
    primary_user: true,
    overriding_player_appearance: true
  }
}

function asMobRuntimeId (rid) {
  if (rid == null) return 0n
  if (typeof rid === 'bigint') return rid
  const n = Number(rid)
  if (!Number.isFinite(n)) return 0n
  return BigInt(Math.trunc(n))
}

function isOffhandWindow (win) {
  return win === 'offhand' || win === 119
}

/** Match clientbound equipment item shape. Keep minimal — forcing has_stack_id
 *  previously crashed Bedrock on ghost equip (kick at deferred main=41). */
function normalizeEquipItem (item) {
  if (!item?.network_id) return emptyItem()
  const nid = Number(item.network_id)
  if (!Number.isFinite(nid) || nid <= 0) return emptyItem()
  const out = { network_id: nid }
  if (item.count != null) out.count = item.count
  if (item.metadata != null) out.metadata = item.metadata
  if (item.block_runtime_id != null) out.block_runtime_id = item.block_runtime_id
  if (item.extra != null) out.extra = item.extra
  // Pass through stack_id only if the source already had it (GamePE CB shape)
  if (item.has_stack_id != null && item.has_stack_id !== 0 && item.has_stack_id !== false) {
    out.has_stack_id = item.has_stack_id
    if (item.stack_id != null) out.stack_id = item.stack_id
  }
  return out
}

/**
 * FPV hand: slot select + RAW (sendLocalEquipRaw).
 * Do NOT stuff synthetic inventory_slot — that kicks PC.
 * Recorded inventory_* from the timeline is forwarded while possessing.
 */
function equipLocalHeld (client, _localRid, held) {
  if (!client || !held) return false
  if (isOffhandWindow(held.window_id)) return false
  const slot = Math.max(0, Math.min(8, Number(held.selected_slot ?? held.slot ?? 0) || 0))
  try {
    client.write('player_hotbar', {
      selected_slot: slot,
      window_id: 'inventory',
      select_slot: true
    })
    return true
  } catch (e) {
    console.warn('[play] FPV player_hotbar failed', e.message)
    return false
  }
}

function equipLocalOffhand (_client, _held) {
  return false
}

/**
 * Patch recorded mob_equipment / armor RAW → local viewer rid and send.
 * Same SizeOf-safe family as ghost RAW (verbatim Item bytes).
 */
function sendLocalEquipRaw (client, packetBuf, localRid, label = 'fpv') {
  if (!client || !packetBuf?.length || localRid == null) return false
  try {
    const patched = replaceRuntimeEntityId(packetBuf, localRid)
    if (typeof client.sendBuffer === 'function') {
      client.sendBuffer(patched, true)
    } else {
      throw new Error('no sendBuffer')
    }
    return true
  } catch (e) {
    console.warn(`[play] FPV RAW ${label} failed`, e.message)
    return false
  }
}

/** Wipe spectator hotbar without Item payloads (slot park only). */
function clearSpectatorHotbar (client) {
  try {
    client.write('player_hotbar', {
      selected_slot: IDLE_PARK_SLOT,
      window_id: 'inventory',
      select_slot: true
    })
  } catch {}
}

const LOCATOR_BAR_OFF = {
  name: 'locatorBar',
  editable: false,
  type: 'bool',
  value: false
}

/** Force-hide player locator bar (bottom strip that replaces compass on newer Bedrock). */
function disableLocatorBar (client) {
  try {
    client.write('game_rules_changed', { rules: [LOCATOR_BAR_OFF] })
  } catch (e) {
    console.warn('[play] locatorBar gamerule failed:', e.message)
  }
}

/** Ensure start_game / game_rules_changed never re-enable the locator bar. */
function forceLocatorBarOffInRules (rules) {
  if (!Array.isArray(rules)) return [LOCATOR_BAR_OFF]
  let found = false
  const out = rules.map((r) => {
    if (r && typeof r === 'object' && String(r.name).toLowerCase() === 'locatorbar') {
      found = true
      return { ...r, ...LOCATOR_BAR_OFF }
    }
    return r
  })
  if (!found) out.push(LOCATOR_BAR_OFF)
  return out
}

/** Strip locator colours from player_list (copy — do not mutate timeline). */
function scrubPlayerListLocator (params) {
  if (!params?.records) return params
  const wrapped = params.records?.records != null
  const raw = wrapped ? params.records.records : params.records
  if (!Array.isArray(raw)) return params
  const copied = raw.map((r) => {
    if (!r || typeof r !== 'object') return r
    return { ...r, player_color: -1 }
  })
  if (wrapped) {
    return { ...params, records: { ...params.records, records: copied } }
  }
  return { ...params, records: copied }
}

/**
 * Drop the recorder's own tab-list row. Mid-session files put you in player_list
 * under a GamePE uuid that is NOT the PLAY login uuid — same display name as the
 * local viewer + ghost. That triple identity survives freecam but SizeOf/kicks
 * the moment .me flips gamemode/abilities.
 */
function scrubRecorderFromPlayerList (params, nameHints = []) {
  if (!params?.records) return params
  const wrapped = params.records?.records != null
  const block = wrapped ? params.records : params
  const raw = block?.records
  if (!Array.isArray(raw) || !raw.length) return params
  const type = block.type
  if (!(type === 'add' || type === 0 || type === '0')) return params
  const deny = new Set(
    nameHints
      .filter(Boolean)
      .map((n) => String(n).replace(/§./g, '').trim().toLowerCase())
      .filter(Boolean)
  )
  if (!deny.size) return params
  const filtered = raw.filter((r) => {
    const un = String(r?.username || '').replace(/§./g, '').trim().toLowerCase()
    return !un || !deny.has(un)
  })
  if (filtered.length === raw.length) return params
  console.log(
    `[play] scrubbed recorder from player_list (${raw.length}→${filtered.length})`
  )
  const nextBlock = {
    ...block,
    records: filtered,
    records_count: filtered.length,
    verified: filtered.map(() => true)
  }
  if (wrapped) return { ...params, records: nextBlock }
  return { ...params, records: nextBlock }
}

function buildMovePlayer (runtimeId, cam, tick = 0n, { onGround = true } = {}) {
  // Always teleport during replay drive — mode:normal lets the client fight look/pos
  // ("direction detached"). on_ground flag still marks possess as standing.
  return {
    runtime_id: runtimeId,
    position: { x: cam.x, y: cam.y, z: cam.z },
    pitch: cam.pitch ?? 0,
    yaw: cam.yaw ?? 0,
    head_yaw: cam.head_yaw ?? cam.yaw ?? 0,
    mode: 'teleport',
    on_ground: onGround,
    ridden_runtime_id: 0,
    teleport: { cause: 'command', source_entity_type: 0 },
    tick
  }
}

function fromByteRotDegrees (d) {
  let x = Number(d)
  if (!Number.isFinite(x)) return 0
  // protodef byterot decodes to [0, 360); convert to signed for look
  if (x > 180) x -= 360
  return x
}

function toNumId (id) {
  if (typeof id === 'bigint') {
    const n = Number(id)
    return Number.isSafeInteger(n) ? n : id
  }
  if (id && typeof id === 'object' && id.$bigint) return toNumId(BigInt(id.$bigint))
  return id
}

/** Reject void/loading placeholders like 0,0,0 */
function isSanePos (p) {
  if (!p) return false
  const { x, y, z } = p
  if (![x, y, z].every((n) => typeof n === 'number' && Number.isFinite(n))) return false
  // origin / near-origin is almost always a loading placeholder on these servers
  return Math.abs(x) + Math.abs(y) + Math.abs(z) > 8
}

function unlockInput (client, position) {
  // IMPORTANT: this packet includes a position. Sending 0,0,0 repeatedly
  // teleports/freezes the viewer in the void. Only send with a sane pos.
  if (!isSanePos(position)) return
  try {
    client.write('update_client_input_locks', {
      locks: 0,
      position: { x: position.x, y: position.y, z: position.z }
    })
  } catch (e) {
    console.warn('[play] unlock input failed', e.message)
  }
}

function closeForms (client) {
  try {
    client.write('clientbound_close_form', {})
  } catch {}
}

async function waitPackResponse (client, ms = 1500) {
  await new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    client.once('resource_pack_client_response', () => {
      clearTimeout(t)
      resolve()
    })
  })
}

async function sendEmptyResourcePacks (client) {
  client.queue('resource_packs_info', {
    must_accept: false,
    has_addons: false,
    has_scripts: false,
    disable_vibrant_visuals: false,
    world_template: { uuid: '00000000-0000-0000-0000-000000000000', version: '' },
    texture_packs: []
  })
  await waitPackResponse(client, 1500)

  client.queue('resource_pack_stack', {
    must_accept: false,
    behavior_packs: [],
    resource_packs: [],
    game_version: '',
    experiments: [],
    experiments_previously_used: false,
    has_editor_packs: false
  })
  await waitPackResponse(client, 1500)
}

async function waitClientSpawn (client, ms = 8000) {
  if (client?.status === 4) return true
  return await new Promise((resolve) => {
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try { clearTimeout(t) } catch {}
      try { client.removeListener?.('spawn', onSpawn) } catch {}
      resolve(ok)
    }
    const onSpawn = () => finish(true)
    const t = setTimeout(() => finish(client?.status === 4), ms)
    try { client.once('spawn', onSpawn) } catch { finish(false) }
  })
}

function buildPlayQueue (events) {
  return events
    .filter((e) => e.type === 'pkt' || e.type === 'cam' || e.type === 'mark' || e.type === 'held')
    .sort((a, b) => a.t - b.t)
}

function applyGhostHeld (client, held) {
  if (!client || !held) return false
  const off = isOffhandWindow(held.window_id)
  const item = held.item?.network_id ? normalizeEquipItem(held.item) : emptyItem()
  const slot = off
    ? 1
    : Math.max(0, Math.min(8, Number(held.selected_slot ?? held.slot ?? 0) || 0))
  const selected = off ? 0 : slot
  try {
    client.write('mob_equipment', {
      runtime_entity_id: asMobRuntimeId(GHOST_RUNTIME_ID),
      item,
      slot,
      selected_slot: selected,
      window_id: off ? 'offhand' : 'inventory'
    })
    return true
  } catch (e) {
    console.warn('[play] ghost held failed', e.message)
    return false
  }
}

/**
 * Patch runtime_entity_id → ghost and send original Item bytes (no re-encode).
 * Only safe path for non-empty ghost hands/armor after the 1.0.63 baseline.
 */
function sendGhostEquipRaw (client, packetBuf, label = 'equip') {
  if (!client || !packetBuf?.length) return false
  try {
    const patched = replaceRuntimeEntityId(packetBuf, GHOST_RUNTIME_ID)
    if (typeof client.sendBuffer === 'function') {
      client.sendBuffer(patched, true)
    } else {
      throw new Error('no sendBuffer')
    }
    return true
  } catch (e) {
    console.warn(`[play] ghost RAW ${label} failed`, e.message)
    return false
  }
}

/**
 * Prefer the start_game with a real spawn (not 0,0,0 lobby placeholder).
 * Mid-session void hops (GamePE) inject a SECOND start_game near the end —
 * that must NOT become the playhead (spawn-at-end + duration=last 5s).
 */
function pickStartIndex (queue, mode = 'auto') {
  const starts = []
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].type === 'pkt' && queue[i].n === 'start_game') starts.push(i)
  }
  if (!starts.length) return -1
  if (mode === 'first') return starts[0]

  const transferIdx = queue.findIndex(
    (e) =>
      (e.type === 'mark' && e.n === 'transfer') ||
      (e.type === 'pkt' && e.n === 'transfer')
  )

  let candidates = starts
  if ((mode === 'after_transfer' || mode === 'auto') && transferIdx >= 0) {
    const after = starts.filter((i) => i > transferIdx)
    if (after.length) candidates = after
  } else if (mode === 'after_transfer' && starts.length > 1) {
    // Explicit after_transfer only — drop pre-transfer lobby start_game
    candidates = starts.slice(1)
  }
  // auto without transfer: keep ALL starts; pick earliest SANE one so a
  // mid-recording void-hop start_game cannot steal the playhead.

  const sane = candidates.filter((i) => isSanePos(queue[i].p?.player_position))
  if (sane.length) {
    if (mode === 'auto' && transferIdx < 0) return sane[0] // earliest
    return sane[sane.length - 1] // after_transfer: latest sane after hop
  }
  return candidates[0]
}

/**
 * Mid-session recordings (.start after world join) have no start_game.
 * Bootstrap from first camera / move_player + the play-server's local entity ids.
 */
function resolvePlaybackStart (queue, startMode, client) {
  const startIdx = pickStartIndex(queue, startMode)

  // Recorded chunk grid — spawn MUST land on a recorded chunk or Bedrock
  // freezes the player in the void ("loading terrain") forever.
  const chunkKeys = new Set()
  for (const e of queue) {
    if (e.type !== 'pkt' || e.n !== 'level_chunk') continue
    try {
      const p = e.p
      if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) chunkKeys.add(`${p.x},${p.z}`)
    } catch {}
  }
  const chunkList = [...chunkKeys].map((s) => {
    const [x, z] = s.split(',').map(Number)
    return { x, z }
  })
  /** Chebyshev distance (in chunks) from pos to nearest recorded chunk */
  const nearestChunk = (pos) => {
    if (!isSanePos(pos) || !chunkList.length) return { d: Infinity, chunk: null }
    const cx = Math.floor(pos.x / 16)
    const cz = Math.floor(pos.z / 16)
    let best = null
    let bestD = Infinity
    for (const c of chunkList) {
      const d = Math.max(Math.abs(c.x - cx), Math.abs(c.z - cz))
      if (d < bestD) {
        bestD = d
        best = c
        if (d === 0) break
      }
    }
    return { d: bestD, chunk: best }
  }

  const from = startIdx >= 0 ? startIdx : 0
  const startT = queue[from]?.t ?? 0
  const candidates = []
  const startGame = startIdx >= 0 ? queue[startIdx] : null
  if (startGame && isSanePos(startGame.p?.player_position)) {
    candidates.push({ pos: { ...startGame.p.player_position }, why: 'start_game' })
  }
  // Only EARLY publisher updates (≤5s from start) — later ones point at
  // wherever the player teleported to mid-recording, not the beginning.
  for (const e of queue.slice(from)) {
    if ((e.t ?? 0) - startT > 5000) break
    if (e.type === 'pkt' && e.n === 'network_chunk_publisher_update' && isSanePos(e.p?.coordinates)) {
      candidates.push({ pos: { ...e.p.coordinates }, why: `publisher t=${e.t}` })
    }
  }
  const saneCam = queue.slice(from).find((e) => e.type === 'cam' && isSanePos(e.p))
  if (saneCam) candidates.push({ pos: { ...saneCam.p }, why: 'camera' })
  const mv = queue.slice(from).find(
    (e) => e.type === 'pkt' && e.n === 'move_player' && isSanePos(e.p?.position)
  )
  if (mv) candidates.push({ pos: { ...mv.p.position }, why: 'move_player' })
  if (startGame && isSanePos(startGame.p?.spawn_position)) {
    candidates.push({ pos: { ...startGame.p.spawn_position }, why: 'spawn_position' })
  }

  // Candidate PRIORITY beats chunk proximity: start_game 48 blocks off a
  // recorded chunk must win over a move_player from the END of the recording
  // that happens to sit on one. Walk candidates in order; the first within
  // 8 chunks of recorded terrain wins (snapped onto it if not exactly on).
  let spawnPos = null
  let why = ''
  for (const c of candidates) {
    const n = nearestChunk(c.pos)
    if (n.d === 0) {
      spawnPos = c.pos
      why = c.why + '+chunk'
      break
    }
    if (n.d <= 8 && n.chunk) {
      spawnPos = {
        x: n.chunk.x * 16 + 8,
        y: Math.max(c.pos.y ?? 80, 70) + 10,
        z: n.chunk.z * 16 + 8
      }
      why = `${c.why}→snapped to chunk ${n.chunk.x},${n.chunk.z} (d=${n.d})`
      break
    }
  }
  if (!spawnPos && candidates.length) {
    // Nobody near terrain — take whoever is least far, or give up to first.
    let bestC = null
    let bestN = null
    for (const c of candidates) {
      const n = nearestChunk(c.pos)
      if (!n.chunk) continue
      if (!bestN || n.d < bestN.d) {
        bestN = n
        bestC = c
      }
    }
    if (bestN?.chunk) {
      spawnPos = {
        x: bestN.chunk.x * 16 + 8,
        y: Math.max(bestC.pos.y ?? 80, 70) + 10,
        z: bestN.chunk.z * 16 + 8
      }
      why = `${bestC.why}→snapped to chunk ${bestN.chunk.x},${bestN.chunk.z} (d=${bestN.d})`
    } else {
      spawnPos = candidates[0].pos
      why = candidates[0].why + ' (no chunks in file!)'
    }
  }
  if (spawnPos) console.log(`[play] spawn via ${why} → ${spawnPos.x},${spawnPos.y},${spawnPos.z} (grid ${chunkKeys.size} chunks)`)

  if (startIdx >= 0) {
    return {
      startIdx,
      missingStartGame: false,
      runtimeId: toNumId(startGame.p?.runtime_entity_id ?? startGame.p?.runtime_id ?? 1),
      entityUniqueId: startGame.p?.entity_id ?? 0n,
      spawnPos
    }
  }

  const sgd = client?.startGameData
  return {
    startIdx: 0,
    missingStartGame: true,
    runtimeId: toNumId(sgd?.runtime_entity_id ?? client?.entityId ?? 1),
    entityUniqueId: sgd?.entity_id ?? 0n,
    spawnPos
  }
}

/**
 * Mid-session recordings get chunks late (~5s+). Flooding entities into void
 * before that often disconnects Bedrock — preload world packets first.
 * @param {{ maxChunks?: number, skip?: Set<object> }} [opts]
 * @returns {Promise<{ preloaded: Set<object>, chunks: number }>}
 */
async function preloadWorldPackets (queue, writePkt, spawnPos, opts = {}) {
  const maxChunks = opts.maxChunks == null ? Infinity : opts.maxChunks
  const skip = opts.skip || new Set()
  const pubs = []
  const chunks = []
  const other = []
  for (const ev of queue) {
    if (skip.has(ev)) continue
    if (ev.type !== 'pkt' || ev.d !== 'c') continue
    if (!WORLD_PRELOAD_PACKETS.has(ev.n)) continue
    if (ev.n === 'network_chunk_publisher_update') pubs.push(ev)
    else if (ev.n === 'level_chunk' || ev.n === 'subchunk') chunks.push(ev)
    else other.push(ev)
  }

  const preloaded = new Set()
  let chunkCount = 0
  let written = 0

  if (isSanePos(spawnPos) && !pubs.length) {
    writePkt('network_chunk_publisher_update', {
      coordinates: {
        x: Math.floor(spawnPos.x),
        y: Math.floor(spawnPos.y),
        z: Math.floor(spawnPos.z)
      },
      radius: 96,
      saved_chunks: []
    })
  }

  const chunkBudget = Math.max(0, maxChunks)
  // Nearest-to-spawn first: with a small budget (seed=24) file order may not
  // include the chunk under the viewer's feet at all.
  if (isSanePos(spawnPos) && chunks.length > chunkBudget) {
    const scx = Math.floor(spawnPos.x / 16)
    const scz = Math.floor(spawnPos.z / 16)
    chunks.sort((a, b) => {
      const da = Math.max(Math.abs((a.p?.x ?? 0) - scx), Math.abs((a.p?.z ?? 0) - scz))
      const db = Math.max(Math.abs((b.p?.x ?? 0) - scx), Math.abs((b.p?.z ?? 0) - scz))
      return da - db
    })
  }
  const chunkSlice = chunks.slice(0, chunkBudget)
  for (const ev of [...pubs, ...chunkSlice, ...other]) {
    if (!writePkt(ev.n, ev.p)) continue
    preloaded.add(ev)
    written++
    if (ev.n === 'level_chunk' || ev.n === 'subchunk') chunkCount++
    if (written % 8 === 0) await sleep(1)
  }

  return { preloaded, chunks: chunkCount }
}

export async function startPlay (opts = {}) {
  const cfg = loadConfig(opts.configPath)
  const ownSignals = opts.ownSignals !== false
  const onRequestLive = opts.onRequestLive || null
  let switchingToLive = false
  /** @type {import('./control/transport.js').ReplayTransport | null} */
  let activeTransport = null
  let controlServer = null
  /** @type {ReturnType<typeof bedrock.createServer> | null} */
  let server = null

  const closePlay = ({ exitProcess = false } = {}) => {
    try { if (activeTransport) activeTransport._aborted = true } catch {}
    try { controlServer?.close() } catch {}
    try { server?.close() } catch {}
    if (exitProcess) process.exit(0)
  }

  const resolveFilePath = (raw) => {
    if (!raw) return null
    if (path.isAbsolute(raw)) return raw
    let rel = raw
    if (!/\.mcreplay\.gz$/i.test(rel)) rel = `${rel}.mcreplay.gz`
    return path.join(cfg.replaysDir, rel)
  }

  /** Current replay file — hub calls setActiveFile() on .play */
  let activeFilePath = resolveFilePath(opts.file)
  if (!activeFilePath) {
    const list = listReplays(cfg.replaysDir)
    if (list.length) activeFilePath = list[0].path
  }

  const runtime = opts.version
    ? {
        version: normalizeVersion(opts.version),
        viewerMode: opts.viewerMode || viewerModeForVersion(opts.version)
      }
    : await resolveRuntimeVersion(cfg)
  const version = runtime.version || normalizeVersion(cfg.version) || '1.21.100'
  const viewerMode = opts.viewerMode || runtime.viewerMode || viewerModeForVersion(version)
  const speed = opts.speed ?? cfg.playSpeed ?? 1.0
  const followRecording = opts.follow ?? cfg.playFollowRecording ?? false
  const suppressUi = cfg.suppressServerUi !== false
  const startMode = opts.startMode || cfg.playStartMode || 'auto'
  const showSelfGhost = cfg.showSelfGhost !== false
  const playShowChat = cfg.playShowChat === true
  const playShowSidebar = cfg.playShowSidebar === true
  const controlHotbar = cfg.controlHotbar === true
  const showPlayerNames = cfg.showPlayerNames !== false
  let playSounds = cfg.playSounds !== false
  const allowEmpty = opts.allowEmpty === true
  const playListenPort = Number(opts.port ?? cfg.playPort ?? 19133)

  const possessOk = possessEnabledForVersion(version)
  console.log(`[play] host ready version=${version} viewerMode=${viewerMode} possess=${possessOk} port=${playListenPort}`)
  console.log(`[play] active file=${activeFilePath ? path.basename(activeFilePath) : '(none yet)'}`)
  console.log(
    `[play] Chat: .help | .live | .pause .seek` +
    (possessOk ? ' .me .spec …' : ' · freecam only (no .me/.spec)')
  )

  const pauseOnSeek = cfg.pauseOnSeek === true ||
    cfg.seekPaused === true ||
    cfg.restartPaused === true
  const plane = new ControlPlane({
    speed,
    durationMs: 0,
    fileName: activeFilePath ? path.basename(activeFilePath) : '—',
    muted: !playSounds,
    // One config: pause after seek AND restart (default off)
    restartPaused: pauseOnSeek,
    seekPaused: pauseOnSeek,
    possessEnabled: possessOk
  })

  const applyActiveFile = (raw) => {
    const next = resolveFilePath(raw) || (raw && path.isAbsolute(raw) ? raw : null)
    if (!next) return false
    try {
      if (!fs.existsSync(next)) return false
    } catch {
      return false
    }
    activeFilePath = next
    const base = path.basename(next)
    try { plane.setFileName(base) } catch { plane.fileName = base }
    console.log(`[play] active file → ${base}`)
    if (activeClient && activeTransport) {
      try { activeTransport.abort() } catch {}
    }
    playing = false
    activeClient = null
    try { plane.setStatus('idle') } catch {}
    return true
  }

  if (cfg.controlUi !== false) {
    try {
      controlServer = startControlServer(plane, {
        port: cfg.controlPort ?? 18765,
        host: cfg.controlHost || '0.0.0.0',
        setActiveFile: applyActiveFile,
        getActiveFile: () => activeFilePath
      })
    } catch (e) {
      console.warn('[play] control UI failed to start:', e.message)
    }
  }

  const listenHost = cfg.listenHost || '0.0.0.0'

  server = new bedrock.Server({
    host: listenHost,
    port: playListenPort,
    version,
    offline: cfg.offline !== false,
    maxPlayers: 1,
    batchingInterval: 5,
    ...(cfg.raknetBackend === 'jsp-raknet'
      ? { raknetBackend: 'jsp-raknet', useNativeRaknet: false }
      : {}),
    motd: playMotdOptions()
  })
  applyBedrockVersionCompat(server, {
    protocolBase: version,
    advertiseVersion: opts.advertiseVersion || normalizeVersion(cfg.version) || version
  })
  server.on('error', (err) => console.error('[play] server error', err))

  try {
    await server.listen()
  } catch (e) {
    try { controlServer?.close() } catch {}
    try { await server.close?.('listen failed') } catch {}
    throw new Error(`Play failed to bind ${listenHost}:${playListenPort} — ${e.message}`)
  }

  console.log(`[play] Listening OK on ${listenHost}:${playListenPort}`)
  try {
    const ad = server.advertisement
    console.log(`[play] MOTD="${ad?.motd || '?'}" level=${ad?.levelName || '?'}`)
  } catch {}
  try {
    // Kick forensics: 21 = client left on purpose, 22 = RakNet timeout/lost
    server.raknet?.raknet?.on?.('closeConnection', (conn, id) => {
      console.log(`[play] raknet close id=${id} (21=client left, 22=connection lost) addr=${conn?.address ?? '?'}`)
    })
  } catch {}

  let playing = false
  /** @type {object | null} */
  let activeClient = null
  /** @type {null | (() => boolean)} */
  let sessionSnapFreecamHome = null

  /**
   * Run replay for a client that already completed login.
   * Used by PLAY port (on join) and LIVE hub in-place (.play without transfer).
   */
  const beginReplaySession = async (client, sessionOpts = {}) => {
      const requestLive = sessionOpts.onRequestLive !== undefined
        ? sessionOpts.onRequestLive
        : onRequestLive
      const inPlace = sessionOpts.inPlace === true

      if (playing) {
        if (inPlace) {
          console.warn('[play] already playing — aborting previous session')
          try { activeTransport?.abort() } catch {}
          await sleep(150)
          playing = false
          activeClient = null
        } else {
          client.disconnect('Replay already running')
          return
        }
      }

      const filePath = activeFilePath
      if (!filePath) {
        const msg = allowEmpty
          ? 'Сначала нужна запись.\nЗайди на LIVE (19132) → в чате .start → потом .play\nИли открой готовый файл реплея.'
          : 'Нет файла реплея. Сначала запиши на LIVE (.start).'
        if (inPlace) {
          try { client.queue('text', systemText(`§c[Replay] ${msg.replace(/\n/g, ' — ')}`)) } catch {}
          return
        }
        client.disconnect(msg)
        return
      }

      playing = true
      activeClient = client
      switchingToLive = false
      console.log(`[play] ${inPlace ? 'In-place on LIVE' : 'Handshake OK'} — loading ${path.basename(filePath)}`)
      console.log(
        `[play] local identity uuid=${client.profile?.uuid || client.uuid || '?'} ` +
        `name=${client.profile?.name || client.username || '?'}`
      )

      let queue
      let startIdx
      let seekIndex
      let spawnPos
      let runtimeId
      let entityUniqueId
      let addTemplate
      let recordedSelf
      let missingStartGame = false
      /**
       * Light chunk index (cx,cz → event) for warp re-sends. Bedrock DISCARDS
       * chunks outside the publisher radius, so terrain sent once at bootstrap
       * is gone by the time a recorded teleport pulls the viewer 2000m away.
       * @type {Array<{x: number, z: number, ev: object}>}
       */
      let chunkEvIndex = []
      /** Hoisted: defined in the load block below, CALLED from bootstrap much
       *  later — a const inside try{} was invisible there (silent ReferenceError
       *  in try/catch → item_registry never injected → «Произошла ошибка»). */
      let injectItemRegistryCache = () => false
      let itemRegistryInjected = false

      /** @type {{ close: () => void } | null} */
      let payloadSpill = null
      try {
        const loaded = await loadTimelineStreaming(filePath)
        payloadSpill = loaded.spill
        const { header, footer, events } = loaded
        const fileVer = header?.version ? normalizeVersion(header.version) : null
        const playVer = normalizeVersion(version)
        if (fileVer && playVer && !versionsCompatible(fileVer, playVer)) {
          const msg =
            `Версия не совпадает: запись ${fileVer}, сейчас ${playVer}. ` +
            `Смени версию в настройках на ${fileVer} (или перезапиши на текущей).`
          console.warn(`[play] refuse: file=${fileVer} hub=${playVer}`)
          playing = false
          activeClient = null
          try { payloadSpill?.close() } catch {}
          payloadSpill = null
          if (inPlace) {
            try { client.queue('text', systemText(`§c[Replay] ${msg}`)) } catch {}
          } else {
            try { client.disconnect(msg) } catch {}
          }
          return
        }
        if (fileVer && playVer && fileVer !== playVer && versionsCompatible(fileVer, playVer)) {
          console.log(`[play] version labels differ (${fileVer} ~ ${playVer}) but same protocol — OK`)
        }
        if (!fileVer) {
          console.warn('[play] Replay header has no version — playing anyway (old file?)')
        }
        if (footer) {
          console.log(`[play] packets=${footer.packets} cameras=${footer.cameras} duration=${((footer.t || 0) / 1000).toFixed(1)}s`)
        }

        const queueRaw = buildPlayQueue(events)
        // Ghost body only — densified cams interpolated pos+look cause dolly-zoom on .me
        queue = densifyCamEvents(queueRaw, 16)
        if (!queue.length) {
          playing = false
          activeClient = null
          try { payloadSpill?.close() } catch {}
          payloadSpill = null
          client.disconnect('Replay file is empty')
          return
        }

        chunkEvIndex = []
        for (const e of queue) {
          if (e.type === 'pkt' && e.n === 'level_chunk' && Number.isFinite(e.p?.x) && Number.isFinite(e.p?.z)) {
            chunkEvIndex.push({ x: e.p.x, z: e.p.z, ev: e })
          }
        }

        const boot = resolvePlaybackStart(queue, startMode, client)
        startIdx = boot.startIdx
        runtimeId = boot.runtimeId
        entityUniqueId = boot.entityUniqueId
        spawnPos = boot.spawnPos
        missingStartGame = boot.missingStartGame
        if (missingStartGame) {
          console.warn(
            '[play] No start_game in file (mid-session .start) — bootstrapping from camera + play-server entity'
          )
        }
        addTemplate = findAddPlayerTemplate(queue, startIdx) || findAddPlayerTemplate(queue, 0)
        recordedSelf = loadSelfFromEvents(events)
        // Seek uses t/type/n only — heavy pkt bodies stay on spill until catch-up touches them
        seekIndex = buildSeekIndex(queue, startIdx)

        const hasItemRegistry = queue.some((e) => e.type === 'pkt' && e.n === 'item_registry')
        itemRegistryInjected = false
        injectItemRegistryCache = () => {
          if (itemRegistryInjected) return false
          // Prefer RAW bytes from a recent LIVE join (exact GamePE palette).
          // JSON re-encode was a fallback and often mismatched network ids →
          // client crash on add_item_entity / inventory («Произошла ошибка»).
          const dirs = [
            process.env.BEDROCK_REPLAY_DATA ? path.join(process.env.BEDROCK_REPLAY_DATA, 'replays') : null,
            cfg.replaysDir || path.join(process.cwd(), 'replays')
          ].filter(Boolean)
          const binCandidates = []
          const jsonCandidates = []
          for (const d of dirs) {
            binCandidates.push(path.join(d, 'item_registry_cache.bin'))
            binCandidates.push(path.join(d, '.item_registry_cache.bin'))
            jsonCandidates.push(path.join(d, 'item_registry_cache.json'))
            jsonCandidates.push(path.join(d, '.item_registry_cache.json'))
          }
          let lastErr = null
          for (const binPath of binCandidates) {
            let buf = null
            try {
              buf = fs.readFileSync(binPath)
            } catch (e) {
              lastErr = `${binPath}: ${e.code || e.message}`
              continue
            }
            if (!buf?.length || buf.length < 16) {
              lastErr = `${binPath}: empty/bad`
              continue
            }
            try {
              // Best-effort shield palette for later serializer writes
              try {
                const des = client.deserializer?.parsePacketBuffer?.(buf)
                const states = des?.data?.params?.itemstates
                if (Array.isArray(states) && states.length) {
                  client.updateItemPalette?.(states)
                }
              } catch {}
              // immediate=true: write() sends now; queued sendBuffer arrives AFTER
              // ghost equipment and crashes the client on unknown network ids.
              if (typeof client.sendBuffer === 'function') {
                client.sendBuffer(buf, true)
              } else {
                throw new Error('no sendBuffer')
              }
            } catch (e) {
              lastErr = `${binPath}: send ${e.message}`
              continue
            }
            itemRegistryInjected = true
            console.log(`[play] Injected item_registry RAW cache (${buf.length}B) from ${binPath}`)
            return true
          }
          for (const cachePath of jsonCandidates) {
            let states = null
            try {
              const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
              states = revive(raw.itemstates)
            } catch (e) {
              lastErr = `${cachePath}: ${e.code || e.message}`
              continue
            }
            if (!Array.isArray(states) || !states.length) {
              lastErr = `${cachePath}: empty/bad`
              continue
            }
            try {
              client.write('item_registry', { itemstates: states })
            } catch (e) {
              console.warn('[play] item_registry write failed', e.message)
              return false
            }
            itemRegistryInjected = true
            console.log(`[play] Injected item_registry JSON cache (${states.length} items) from ${cachePath}`)
            return true
          }
          console.warn(`[play] item_registry cache unavailable (${lastErr || 'no candidates'})`)
          return false
        }
        if (!hasItemRegistry) {
          console.warn(
            '[play] No item_registry in replay — will try RAW/JSON cache after start_game. ' +
            'Best fix: rejoin LIVE once (captures palette) then re-record.'
          )
        }

        try { plane.setFileName(path.basename(filePath)) } catch { plane.fileName = path.basename(filePath) }
        plane.setDuration(seekIndex.durationMs)
        console.log(`[play] ready duration=${(seekIndex.durationMs / 1000).toFixed(1)}s spawn=${spawnPos ? `${spawnPos.x},${spawnPos.y},${spawnPos.z}` : '?'}${missingStartGame ? ' (no start_game)' : ''}`)
      } catch (e) {
        playing = false
        activeClient = null
        console.error('[play] load failed', e)
        try { payloadSpill?.close() } catch {}
        payloadSpill = null
        try { client.disconnect('Failed to load replay: ' + e.message) } catch {}
        return
      }

      // Fresh PLAY join needs packs; in-place client already past that phase
      if (!inPlace) {
        try {
          await sendEmptyResourcePacks(client)
        } catch (e) {
          console.warn('[play] resource pack handshake:', e.message)
        }
      } else {
        try { closeForms(client) } catch {}
      }

      const say = (msg) => {
        try { client.queue('text', systemText(msg)) } catch {}
      }
      try { plane.setAnnounce(say) } catch {}

      // Keep chat quiet — one line on start; details via .help
      say(`§a[Replay] ${path.basename(filePath).replace(/\.mcreplay\.gz$/i, '')}`)

      let localMoveTick = 0n
      let tick = 0n
      /** Last known freecam from real viewer flight (auth_input) — never spawn unless restart0 */
      let freecamPos = isSanePos(spawnPos) ? { ...spawnPos, pitch: 0, yaw: 0, head_yaw: 0 } : null
      /** Locked during seek; used to restore after start_game / resume */
      let seekCamLock = null
      let freecamFrozen = false
      let freecamFrozenAt = 0
      let keepCamThroughResume = false
      let restoreCamTimers = []
      let lastPublisherAt = 0
      let lastPublisherPos = null
      /** Recorded-self track — big jumps teleport the freecam along */
      let lastGhostCamPos = null
      let lastChunkResendAt = 0
      let lastChunkResendPos = null
      let chunkResendBusy = false
      /** Chunks already delivered — re-blasting the same payload flickers the world. */
      const deliveredChunkKeys = new Set()
      const chunkKey = (x, z) => `${x},${z}`
      const noteChunkDelivered = (p) => {
        if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) {
          deliveredChunkKeys.add(chunkKey(p.x, p.z))
        }
      }

      // NEVER burst these: 100+ chunks ≈ 7MB in one tick floods RakNet on the
      // phone — packets drop ("chunks won't load") and the client times out
      // and kicks itself ~10s later. Feet first (sync), then paced outer ring.
      const resendChunksNear = (pos, radiusChunks = 5, cap = 64) => {
        if (!isSanePos(pos) || !chunkEvIndex.length || chunkResendBusy) return
        const now = Date.now()
        if (lastChunkResendPos) {
          const dx = pos.x - lastChunkResendPos.x
          const dz = pos.z - lastChunkResendPos.z
          if (dx * dx + dz * dz < 64 * 64 && now - lastChunkResendAt < 6000) return
        }
        lastChunkResendAt = now
        lastChunkResendPos = { x: pos.x, y: pos.y, z: pos.z }
        const cx = Math.floor(pos.x / 16)
        const cz = Math.floor(pos.z / 16)
        const near = []
        for (const c of chunkEvIndex) {
          const d = Math.max(Math.abs(c.x - cx), Math.abs(c.z - cz))
          if (d > radiusChunks) continue
          if (deliveredChunkKeys.has(chunkKey(c.x, c.z))) continue
          near.push({ d, ev: c.ev })
        }
        near.sort((a, b) => a.d - b.d)
        const batch = near.slice(0, cap)
        if (!batch.length) return
        const CORE = 16
        let n = 0
        for (const { ev } of batch.slice(0, CORE)) {
          if (client.status === 0) break
          try {
            client.write('level_chunk', ev.p)
            noteChunkDelivered(ev.p)
            n++
          } catch {}
        }
        const rest = batch.slice(CORE)
        if (!rest.length) {
          if (n) console.log(`[play] re-sent ${n} chunks around ${Math.floor(pos.x)},${Math.floor(pos.z)} (core)`)
          return
        }
        chunkResendBusy = true
        ;(async () => {
          try {
            for (const { ev } of rest) {
              if (client.status === 0) break
              try {
                client.write('level_chunk', ev.p)
                noteChunkDelivered(ev.p)
                n++
              } catch {}
              if (n % 4 === 0) await sleep(25)
            }
          } finally {
            chunkResendBusy = false
          }
          if (n) console.log(`[play] re-sent ${n} chunks around ${Math.floor(pos.x)},${Math.floor(pos.z)} (core+paced)`)
        })()
      }

      const publishChunksAround = (pos) => {
        if (!isSanePos(pos)) return
        const now = Date.now()
        if (lastPublisherPos && isSanePos(lastPublisherPos)) {
          const dx = pos.x - lastPublisherPos.x
          const dy = pos.y - lastPublisherPos.y
          const dz = pos.z - lastPublisherPos.z
          if (dx * dx + dy * dy + dz * dz < 48 * 48 && now - lastPublisherAt < 1500) return
        }
        lastPublisherAt = now
        lastPublisherPos = { x: pos.x, y: pos.y, z: pos.z }
        try {
          client.write('network_chunk_publisher_update', {
            coordinates: {
              x: Math.floor(pos.x),
              y: Math.floor(pos.y),
              z: Math.floor(pos.z)
            },
            radius: 128,
            saved_chunks: []
          })
        } catch {}
      }

      const snapFreecamHome = (why = 'spawn') => {
        freecamFrozen = false
        freecamFrozenAt = 0
        keepCamThroughResume = false
        clearRestoreCamTimers()
        const home = isSanePos(spawnPos)
          ? { ...spawnPos, pitch: 0, yaw: freecamPos?.yaw ?? 0, head_yaw: freecamPos?.head_yaw ?? 0 }
          : (isSanePos(freecamPos) ? { ...freecamPos } : null)
        if (!home) {
          say('§c[Replay] Нет точки спавна')
          return false
        }
        freecamPos = { ...home }
        seekCamLock = { ...home }
        try {
          tick += 1n
          client.write('move_player', buildMovePlayer(runtimeId, freecamPos, tick))
        } catch {}
        try { forceViewerMode(client, entityUniqueId, viewerMode) } catch {}
        unlockInput(client, freecamPos)
        publishChunksAround(freecamPos)
        resendChunksNear(freecamPos)
        say(`§a[Replay] Камера → спавн §7(.${why})`)
        console.log(`[play] freecam home (${why})`)
        return true
      }
      sessionSnapFreecamHome = () => snapFreecamHome('api')

      // ▶ after .restart (+ optional freecam move): keep spawn-yank blocked at current pos
      plane._onBeforeResume = () => {
        if (isSanePos(freecamPos)) {
          seekCamLock = { ...freecamPos }
          keepCamThroughResume = true
        }
      }

      const clearRestoreCamTimers = () => {
        for (const t of restoreCamTimers) clearTimeout(t)
        restoreCamTimers = []
      }

      const rememberFreecam = (pos, look = {}) => {
        if (freecamFrozen || transport?._seeking) return
        if (!isSanePos(pos)) return
        freecamPos = {
          x: pos.x,
          y: pos.y,
          z: pos.z,
          pitch: look.pitch ?? freecamPos?.pitch ?? 0,
          yaw: look.yaw ?? freecamPos?.yaw ?? 0,
          head_yaw: look.head_yaw ?? look.yaw ?? freecamPos?.head_yaw ?? 0
        }
        publishChunksAround(freecamPos)
      }

      const camToRestore = () => {
        if (seekCamLock && isSanePos(seekCamLock)) return seekCamLock
        if (isSanePos(freecamPos)) return freecamPos
        return null
      }

      const restoreFreecam = () => {
        const cam = camToRestore()
        if (!cam) return
        freecamPos = { ...cam }
        try {
          tick += 1n
          client.write('move_player', buildMovePlayer(runtimeId, freecamPos, tick))
        } catch {}
        unlockInput(client, freecamPos)
      }

      const pulseRestoreFreecam = () => {
        clearRestoreCamTimers()
        const delays = [0, 50, 120, 250, 500, 900]
        for (const d of delays) {
          restoreCamTimers.push(setTimeout(() => {
            if (client.status === 0) return
            restoreFreecam()
          }, d))
        }
        restoreCamTimers.push(setTimeout(() => {
          freecamFrozen = false
          freecamFrozenAt = 0
        }, 1000))
      }

      const onViewerMove = (p) => {
        // Safety: never leave freecam frozen forever (seek glitch / stuck void)
        if (freecamFrozen && freecamFrozenAt > 0 && Date.now() - freecamFrozenAt > 2500) {
          freecamFrozen = false
          freecamFrozenAt = 0
          try { forceViewerMode(client, entityUniqueId, viewerMode) } catch {}
          if (isSanePos(freecamPos)) unlockInput(client, freecamPos)
          console.log('[play] freecamFrozen auto-cleared')
        }
        if (freecamFrozen || transport?._seeking) return
        // Follow locked: only hard-correct big walk-away (soft snaps every tick = обрывки)
        if (spec?.mode === 'follow') {
          try { spec.snapToTarget(false) } catch {}
          return
        }
        // auth_input: position + pitch/yaw at top level
        const pos = p?.position || (p?.x != null ? p : null)
        if (!pos) return
        const look = {
          pitch: p.pitch,
          yaw: p.yaw,
          head_yaw: p.head_yaw ?? p.yaw
        }

        // keepCamThroughResume: after .restart / keep-cam seek, spawn-yank packets
        // stay blocked even if the viewer flies — otherwise ▶ after moving snaps to spawn.
        // On real flight: refresh the lock to the new freecam pos (do NOT clear the flag).
        if (keepCamThroughResume) {
          const lock = (seekCamLock && isSanePos(seekCamLock)) ? seekCamLock : freecamPos
          if (isSanePos(lock) && isSanePos(pos)) {
            const dx = pos.x - lock.x
            const dy = pos.y - lock.y
            const dz = pos.z - lock.z
            if (dx * dx + dy * dy + dz * dz < 0.12) {
              // look-only / jitter — keep lock xyz, update look
              if (freecamPos) {
                freecamPos = {
                  ...freecamPos,
                  pitch: look.pitch ?? freecamPos.pitch ?? 0,
                  yaw: look.yaw ?? freecamPos.yaw ?? 0,
                  head_yaw: look.head_yaw ?? freecamPos.head_yaw ?? 0
                }
              }
              return
            }
          }
          rememberFreecam(pos, look)
          if (isSanePos(freecamPos)) seekCamLock = { ...freecamPos }
          keepViewerTerrain(pos)
          return
        }

        rememberFreecam(pos, look)
        keepViewerTerrain(pos)
      }
      // Viewer flew far from the last publisher point — move the publisher with
      // him and re-send recorded chunks so manual flight never ends in a void
      // (void sit = freeze and, on some clients, a self-disconnect "kick").
      let lastTerrainKeepPos = null
      const keepViewerTerrain = (pos) => {
        if (!isSanePos(pos)) return
        if (!lastTerrainKeepPos) {
          // First sample = spawn area, already preloaded — just remember it.
          lastTerrainKeepPos = { x: pos.x, z: pos.z }
          return
        }
        const dx = pos.x - lastTerrainKeepPos.x
        const dz = pos.z - lastTerrainKeepPos.z
        if (dx * dx + dz * dz < 96 * 96) return
        lastTerrainKeepPos = { x: pos.x, z: pos.z }
        publishChunksAround(pos)
        // Soft refill only — already-delivered chunks are skipped (anti-flicker).
        resendChunksNear(pos, 4, 24)
      }
      client.on('player_auth_input', onViewerMove)
      client.on('move_player', onViewerMove)

      let ghostTick = 0n
      let sent = 0
      let skippedUi = 0
      let playersAdded = 0
      let chunksSent = 0
      let lastT = 0
      let spectatorReady = false
      let ghostSpawned = false
      /** Last skin pushed onto the ghost — re-assert after .free unhide */
      let ghostSkinRef = null
      let ghostSkinName = ''
      let ghostUuid = null
      /** Full player_list add pkt for ghost — needed to restore skin after unhide */
      let ghostListPkt = null

      const reassertGhostSkin = (why = '') => {
        if (client?.status === 0 || !ghostSpawned || !ghostUuid || !ghostSkinRef) return false
        try {
          const skin = { ...ghostSkinRef }
          try {
            const id = `ghost-${Date.now().toString(36)}`
            skin.skin_id = id
            skin.full_skin_id = id
          } catch {}
          ghostSkinRef = skin
          const list = fixPlayerListParams(
            ghostListPkt || {
              records: {
                type: 'add',
                records_count: 1,
                records: [{
                  uuid: ghostUuid,
                  entity_unique_id: GHOST_UNIQUE_ID,
                  username: ghostSkinName || ghostName || 'You',
                  xbox_user_id: String(recordedSelf?.xuid || client?.profile?.xuid || '0'),
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
            }
          )
          try {
            const rec = list?.records?.records?.[0]
            if (rec) rec.skin_data = skin
          } catch {}
          ghostListPkt = list
          client.write('player_list', list)
          client.write('player_skin', {
            uuid: ghostUuid,
            skin,
            skin_name: ghostSkinName || 'You',
            old_skin_name: '',
            is_verified: true
          })
          if (why) console.log(`[play] ghost skin reassert (${why})`)
          return true
        } catch (e) {
          console.warn('[play] ghost skin reassert failed', e.message)
          return false
        }
      }
      /** uuid → Skin from player_list / add_player */
      const skinsByUuid = new Map()
      /** lowercase username → Skin (uuid often 00000000 on GamePE) */
      const skinsByName = new Map()
      /** rid → uuid (for possess skin copy) */
      const uuidByRid = new Map()
      /** rid → last add_player params (re-spawn after possess erase) */
      const addPlayerByRid = new Map()
      /** Last mob_armor_equipment per runtime id */
      const armorByRid = new Map()
      /** Last RAW equip packets for ghost (patched at send time) */
      let lastGhostHeldRawMain = null
      let lastGhostHeldRawOff = null
      let lastGhostArmorRaw = null
      let ghostRawEquipN = 0
      /** Last main-hand / offhand equipment per runtime id */
      const heldByRid = new Map()
      const offhandByRid = new Map()
      /** Last recorded inventory for .me flush (packets often fire before .me). */
      let lastMeInvContent = null
      let lastMeOffhandContent = null
      const lastMeArmorSlots = new Map()
      const lastMeInvSlots = new Map()
      let lastMeHotbarSelect = null

      const noteRecordedInventory = (name, params) => {
        if (!params) return
        const w = params.window_id
        if (name === 'inventory_content') {
          if (w === 'inventory' || w === 0 || w === '0') lastMeInvContent = params
          else if (isOffhandWindow(w)) lastMeOffhandContent = params
        } else if (name === 'inventory_slot') {
          const slot = Number(params.slot)
          if (w === 'armor' || w === 6 || w === '6') lastMeArmorSlots.set(slot, params)
          else if (w === 'inventory' || w === 0 || w === '0') lastMeInvSlots.set(slot, params)
          else if (isOffhandWindow(w)) {
            lastMeOffhandContent = {
              window_id: 'offhand',
              input: [params.item || emptyItem()],
              container: { container_id: 'offhand' },
              storage_item: emptyItem()
            }
          }
        } else if (name === 'player_hotbar') {
          lastMeHotbarSelect = params
        }
      }

      const flushMeInventory = () => {
        if (clientDead()) return
        const send = (name, raw) => {
          if (!raw) return
          try {
            client.write(name, fixInventoryParams(name, raw))
          } catch (e) {
            console.warn(`[play] .me inv ${name} failed`, e.message)
          }
        }
        send('inventory_content', lastMeInvContent)
        send('inventory_content', lastMeOffhandContent)
        for (const p of lastMeArmorSlots.values()) send('inventory_slot', p)
        for (const p of lastMeInvSlots.values()) send('inventory_slot', p)
        if (lastMeHotbarSelect) {
          try { client.write('player_hotbar', lastMeHotbarSelect) } catch {}
        }
        console.log(
          `[play] .me inv flush content=${!!lastMeInvContent} ` +
          `slots=${lastMeInvSlots.size} armor=${lastMeArmorSlots.size}`
        )
      }
      /** Runtime ids of OTHER players (add_player) — not the recorder */
      const otherPlayerRids = new Set()
      /**
       * Recorder ("me") runtime ids from the recording session.
       * Ghost uses GHOST_RUNTIME_ID; equipment packets use the original GamePE rid.
       */
      const recordedMeRids = new Set([toNumId(GHOST_RUNTIME_ID)])
      try {
        const sgRid = toNumId(
          queue.find((e) => e.type === 'pkt' && e.n === 'start_game')?.p?.runtime_entity_id
        )
        if (sgRid != null) recordedMeRids.add(sgRid)
      } catch {}
      /** Recorder state mirrored onto .me FPV */
      let meGameMode = 'survival'
      let meHealth = 20
      let meAttributes = null
      const noteMeGameMode = (gm) => {
        if (gm == null || gm === '') return
        const s = String(gm).toLowerCase()
        if (s.includes('creat') || s === '1') meGameMode = 'creative'
        else if (s.includes('advent') || s === '2') meGameMode = 'adventure'
        else meGameMode = 'survival'
      }
      /** Currently erased FPV target rid (world body removed) */
      let erasedPossessRid = null
      /** @type {import('./spectate.js').SpectateController | null} */
      let spec = null

      const rememberSkin = (uuid, skin, username = null) => {
        if (!skin) return
        // Prefer protocol fixSkin (same as player_list) — normalizeSkin can strip persona bits
        const norm = fixSkin(skin) || normalizeSkin(skin)
        if (!norm) return
        if (uuid != null) skinsByUuid.set(String(uuid), norm)
        if (username) skinsByName.set(String(username).replace(/§./g, '').trim().toLowerCase(), norm)
      }

      /** uuid → last player_list add record (re-push before add_player if needed) */
      const listRecByUuid = new Map()

      const preloadSkinsFromQueue = (evts) => {
        let n = 0
        for (const ev of evts) {
          if (ev?.type !== 'pkt' || ev.n !== 'player_list' || !ev.p) continue
          const block = ev.p.records || ev.p
          const recs = block?.records
          if (!Array.isArray(recs)) continue
          if (!(block.type === 'add' || block.type === 0 || block.type === '0')) continue
          for (const rec of recs) {
            if (!rec) continue
            const skin = rec.skin_data || rec.skin
            if (!skin) continue
            rememberSkin(rec.uuid, skin, rec.username)
            n++
          }
        }
        console.log(`[play] preloaded ${n} skins (${skinsByUuid.size} uuid, ${skinsByName.size} name)`)
      }
      try { preloadSkinsFromQueue(queue) } catch (e) {
        console.warn('[play] skin preload failed', e.message)
      }
      try {
        for (const ev of queue) {
          if (ev?.type !== 'pkt') continue
          if (
            ev.n === 'inventory_content' ||
            ev.n === 'inventory_slot' ||
            ev.n === 'player_hotbar'
          ) {
            noteRecordedInventory(ev.n, ev.p)
          }
        }
        console.log(
          `[play] preloaded .me inv content=${!!lastMeInvContent} ` +
          `slots=${lastMeInvSlots.size} armor=${lastMeArmorSlots.size}`
        )
      } catch (e) {
        console.warn('[play] inv preload failed', e.message)
      }

      // Seed other players + recorder hand from `held` events (serverbound capture)
      try {
        for (const ev of queue) {
          if (ev?.type === 'pkt' && ev.n === 'add_player' && ev.p?.runtime_id != null) {
            otherPlayerRids.add(toNumId(ev.p.runtime_id))
          }
        }
        let heldN = 0
        let offN = 0
        let rawN = 0
        let armorFromInv = 0
        for (const ev of queue) {
          if (ev?.type === 'held') {
            heldN++
            if (ev.raw && ev.b != null) {
              const body = ev.b
              const buf = Buffer.isBuffer(body)
                ? body
                : Buffer.from(typeof body === 'string' ? body : '', 'base64')
              if (buf.length) {
                rawN++
                if (ev.n === 'mob_armor_equipment') lastGhostArmorRaw = buf
                else if (isOffhandWindow(ev.p?.window_id)) lastGhostHeldRawOff = buf
                else lastGhostHeldRawMain = buf
              }
            }
            if (ev.p) {
              if (isOffhandWindow(ev.p.window_id)) {
                offN++
                offhandByRid.set(toNumId(GHOST_RUNTIME_ID), { ...ev.p })
              } else if (ev.n !== 'mob_armor_equipment') {
                heldByRid.set(toNumId(GHOST_RUNTIME_ID), { ...ev.p })
              }
            }
            continue
          }
          // Existing recordings: armor lives in RAW inventory_content (window=armor)
          if (ev?.type === 'pkt' && ev.raw && ev.b != null) {
            const body = ev.b
            const buf = Buffer.isBuffer(body)
              ? body
              : Buffer.from(typeof body === 'string' ? body : '', 'base64')
            if (!buf.length) continue
            try {
              const [pid] = readVarIntAt(buf, 0)
              if (pid === PKT_INVENTORY_CONTENT && peekInventoryWindowId(buf) === WIN_ARMOR) {
                const built = inventoryArmorToMobArmor(buf, GHOST_RUNTIME_ID)
                if (built?.length) {
                  lastGhostArmorRaw = built
                  armorFromInv++
                }
              }
            } catch {}
          }
        }
        if (armorFromInv) {
          console.log(`[play] seeded ghost armor from ${armorFromInv} inventory_content(armor) RAW`)
        }
        if (heldN) {
          const seed = heldByRid.get(toNumId(GHOST_RUNTIME_ID))
          const off = offhandByRid.get(toNumId(GHOST_RUNTIME_ID))
          console.log(
            `[play] seeded ghost hand from ${heldN} held-events ` +
            `(raw=${rawN}) main=${seed?.item?.network_id || seed?.network_id || 0} ` +
            `offhand=${off?.item?.network_id || off?.network_id || 0} (off events=${offN})`
          )
        } else {
          console.warn(
            '[play] No held-events in replay — your hand was never recorded. ' +
            'Re-record with a current build and switch an item once. Other players still show items.'
          )
        }
      } catch (e) {
        console.warn('[play] held preload failed', e.message)
      }

      const applyPossessVisuals = (runtimeId, visible) => {
        setEntityVisible(client, runtimeId, visible)
        const key = toNumId(runtimeId)
        if (!visible) {
          // Strip armor on hidden target — clips spectator cam (was the good path)
          writeArmorEquipment(client, runtimeId, {}, { clearAll: true })
          return
        }
        const last = armorByRid.get(key) || {}
        writeArmorEquipment(client, runtimeId, last, { clearHelmet: false })
      }

      /** Remove world copy so only invisible local + their items remain. */
      const erasePossessTarget = () => {
        const ent = spec?.getTargetEntity?.()
        if (!ent || ent.isGhost) {
          if (ent?.isGhost) applyPossessVisuals(GHOST_RUNTIME_ID, false)
          return
        }
        const rid = toNumId(ent.runtimeId)
        const cached = rid != null ? addPlayerByRid.get(rid) : null
        const uid = ent.uniqueId ?? cached?.unique_id
        if (rid != null) {
          erasedPossessRid = rid
          applyPossessVisuals(rid, false)
        }
        if (uid != null) {
          try {
            client.write('remove_entity', { entity_id_self: asUniqueId(uid) })
            console.log(`[play] FPV erase world body rid=${rid} uid=${uid}`)
          } catch (e) {
            console.warn('[play] FPV erase failed', e.message)
          }
        } else {
          console.warn(`[play] FPV erase: no uniqueId for rid=${rid} — hidden only`)
        }
      }

      const restorePossessTarget = () => {
        if (erasedPossessRid == null) return
        const rid = erasedPossessRid
        erasedPossessRid = null
        const cached = addPlayerByRid.get(rid)
        if (!cached) {
          console.warn(`[play] FPV restore: no cached add_player for rid=${rid}`)
          return
        }
        try {
          writePkt('add_player', cached)
          const armor = armorByRid.get(rid)
          if (armor) writeArmorEquipment(client, rid, armor, {})
          const uuid = cached.uuid != null ? String(cached.uuid) : uuidByRid.get(rid)
          const skin = uuid != null ? skinsByUuid.get(uuid) : null
          if (skin && uuid) {
            client.write('player_skin', {
              uuid,
              skin,
              skin_name: cached.username || '',
              old_skin_name: '',
              is_verified: true
            })
          }
          console.log(`[play] FPV restore world body rid=${rid}`)
        } catch (e) {
          console.warn('[play] FPV restore failed', e.message)
        }
      }

      const listLocalUuids = () => {
        const out = []
        const add = (u) => {
          if (u == null || u === '') return
          const s = String(u)
          if (!out.includes(s)) out.push(s)
        }
        // Only the joining client's identity — recordedSelf.uuid can collide with
        // tab-list rows and leave other bodies as Steve after .me.
        add(client.profile?.uuid)
        add(client.uuid)
        add(client.profile?.identity)
        add(client.profile?.extraData?.identity)
        add(client.identity)
        console.log(
          `[play] FPV local identity candidates: ${out.join(' | ') || '(none)'} ` +
          `name=${client.profile?.name || client.username || '?'}`
        )
        return out
      }

      const pushLocalSkin = (ready, displayName) => {
        const uuids = listLocalUuids()
        if (!uuids.length) {
          console.warn('[play] FPV skin: no local uuid candidates')
          return false
        }
        const name = displayName || client.profile?.name || client.username || 'You'
        const localUid = asUniqueId(entityUniqueId)
        // If this is already the ghost's working skin, push AS-IS (re-fixSkin
        // was shrinking tab_fix 256² → 64² Steve-looking FPV).
        const hasBitmap = (() => {
          const d = ready?.skin_data?.data
          if (Buffer.isBuffer(d)) return d.length >= 1000
          if (d?.$bytes) return d.$bytes.length >= 1000
          if (Array.isArray(d)) return d.length >= 1000
          return false
        })()
        const skin = hasBitmap
          ? { ...ready }
          : (fixSkin(ready) || classicizeSkin(ready))
        if (!skin) return false
        // Bust client skin cache so .me doesn't keep login Steve
        try {
          const id = `fpv-${Date.now().toString(36)}`
          skin.skin_id = id
          skin.full_skin_id = id
        } catch {}
        let any = false
        for (const localUuid of uuids) {
          try {
            client.write('player_list', {
              records: {
                type: 'add',
                records_count: 1,
                records: [{
                  uuid: localUuid,
                  entity_unique_id: localUid,
                  username: name,
                  xbox_user_id: String(client.profile?.xuid || recordedSelf?.xuid || '0'),
                  platform_chat_id: '',
                  build_platform: 7,
                  skin_data: skin,
                  is_teacher: false,
                  is_host: false,
                  is_subclient: false,
                  player_color: -1
                }],
                verified: [false]
              }
            })
          } catch (e) {
            console.warn('[play] FPV player_list skin failed', e.message)
          }
          for (const verified of [false, true]) {
            try {
              client.write('player_skin', {
                uuid: localUuid,
                skin,
                skin_name: name,
                old_skin_name: '',
                is_verified: verified
              })
              any = true
            } catch (e) {
              console.warn('[play] FPV player_skin failed', e.message)
            }
          }
        }
        const blen = (() => {
          const d = skin.skin_data?.data
          if (Buffer.isBuffer(d)) return d.length
          if (d?.$bytes) return d.$bytes.length
          if (Array.isArray(d)) return d.length
          return 0
        })()
        console.log(
          `[play] FPV skin push → uuids=${uuids.length} bytes=${blen} ` +
          `arm=${skin.arm_size} persona=${!!skin.persona} asis=${hasBitmap} ok=${any}`
        )
        return any
      }

      const rememberHeld = (rid, pkt) => {
        if (rid == null || !pkt) return
        const win = pkt.window_id
        if (isOffhandWindow(win)) {
          offhandByRid.set(rid, { ...pkt, window_id: 'offhand', slot: 1, selected_slot: 0 })
          return
        }
        const nid = pkt.item?.network_id
        if (!nid) {
          if (win === 'inventory' || win === 0 || win == null) heldByRid.set(rid, { ...pkt })
          return
        }
        heldByRid.set(rid, { ...pkt })
      }

      /** Equipment for recorder: ghost id, start_game id, or rid never seen as other add_player */
      const isRecordedMeEquipment = (rid, pkt) => {
        if (rid == null) return false
        if (recordedMeRids.has(rid)) return true
        if (otherPlayerRids.has(rid)) return false
        const win = pkt?.window_id
        // Local player is not add_player'd to themselves — equipment for unknown player rid = me
        if (isOffhandWindow(win) || win === 'inventory' || win === 0 || win == null || win === 'ui') {
          recordedMeRids.add(rid)
          return true
        }
        return false
      }

      const pickMeHeld = () => {
        for (const rid of recordedMeRids) {
          const h = heldByRid.get(rid)
          if (h?.item?.network_id) return h
        }
        const g = heldByRid.get(toNumId(GHOST_RUNTIME_ID))
        if (g?.item?.network_id) return g
        return null
      }

      const pickMeOffhand = () => {
        for (const rid of recordedMeRids) {
          const h = offhandByRid.get(rid)
          if (h) return h
        }
        return offhandByRid.get(toNumId(GHOST_RUNTIME_ID)) || null
      }

      /** Empty ghost hands — kills the remote TPV tool that stacks over .me FPV. */
      const clearGhostHands = () => {
        if (!ghostSpawned) return
        // Empty nid=0 is OK via write (1.0.63 baseline); never re-encode real items.
        applyGhostHeld(client, {
          item: emptyItem(),
          slot: 0,
          selected_slot: 0,
          window_id: 'inventory'
        })
        applyGhostHeld(client, {
          item: emptyItem(),
          slot: 1,
          selected_slot: 0,
          window_id: 'offhand'
        })
      }

      const applyGhostHands = () => {
        if (!ghostSpawned) return
        // .me = client FPV only. Never keep a remote tool on the ghost body.
        if (spec?.isPossessing?.()) {
          clearGhostHands()
          return
        }
        // Prefer RAW (client-encoded Item). JSON maps alone must NOT client.write.
        let sent = 0
        if (lastGhostHeldRawMain) {
          if (sendGhostEquipRaw(client, lastGhostHeldRawMain, 'main')) sent++
        } else {
          applyGhostHeld(client, {
            item: emptyItem(),
            slot: 0,
            selected_slot: 0,
            window_id: 'inventory'
          })
        }
        if (lastGhostHeldRawOff) {
          if (sendGhostEquipRaw(client, lastGhostHeldRawOff, 'off')) sent++
        } else {
          applyGhostHeld(client, {
            item: emptyItem(),
            slot: 1,
            selected_slot: 0,
            window_id: 'offhand'
          })
        }
        if (lastGhostArmorRaw) {
          if (sendGhostEquipRaw(client, lastGhostArmorRaw, 'armor')) sent++
        }
        if (sent && ghostRawEquipN < 5) {
          console.log(`[play] ghost RAW re-apply sent=${sent}`)
        }
      }

      // .me: P1 adventure+fly (default). Optional .mepath 0|1
      /** Suppress hotbar key handler while we push inventory (not a user 1–9 press) */
      let suppressHotbarSlot = (_slot, _ms) => {}
      let noteHotbarSelection = (_slot) => {}
      const equipMeHeld = () => {
        try {
          const held = pickMeHeld()
          const heldSlot = Math.max(0, Math.min(8, Number(held?.selected_slot ?? held?.slot ?? 0) || 0))
          if (controlHotbar) {
            suppressHotbarSlot(heldSlot, 120)
            noteHotbarSelection(heldSlot)
          }
          let rawOk = false
          if (lastGhostHeldRawMain) {
            rawOk = sendLocalEquipRaw(client, lastGhostHeldRawMain, runtimeId, 'main')
          }
          equipLocalHeld(client, runtimeId, held || { selected_slot: heldSlot })
          if (lastGhostHeldRawOff) {
            sendLocalEquipRaw(client, lastGhostHeldRawOff, runtimeId, 'off')
          }
          console.log(
            `[play] .me FPV hand nid=${held?.item?.network_id ?? 0} slot=${heldSlot + 1}` +
            (rawOk ? ' raw=1' : ' raw=0')
          )
          if (controlHotbar) {
            noteHotbarSelection(heldSlot)
            suppressHotbarSlot(heldSlot, 120)
          }
        } catch (e) {
          console.warn('[play] me equip held failed', e.message)
        }
      }
      const snapMeCam = () => {
        const cam = spec?.cam
        if (!cam) return
        try {
          localMoveTick += 1n
          const rid = typeof runtimeId === 'bigint' ? Number(runtimeId) : runtimeId
          client.write('move_player', buildMovePlayer(rid, cam, localMoveTick, {
            onGround: false
          }))
          unlockInput(client, cam)
        } catch {}
      }
      /** set after attachSpectatorHotbar — used to re-park on .spec / .free */
      let hotbarCtl = null
      // FPV hand: RAW + player_hotbar; recorded inventory_* forwarded while possessing.
      // Do not stuff synthetic inventory_slot (that path kicked on PC).

      /**
       * Pause envelope for .me enter / .free leave. The release recipe is fine on
       * its own, but interleaved with the live replay stream (move_entity storms)
       * the gamemode flip crashes real clients. Flip in silence, resume after.
       */
      let meHoldPause = false
      let meResumeTimer = null
      /** status may not be 0 yet inside the 'close' event — track explicitly */
      let viewerGone = false
      client.once('close', () => { viewerGone = true })
      const clientDead = () => viewerGone || client?.status === 0
      const mePauseReplay = () => {
        try {
          if (plane && !plane.paused && typeof plane.togglePause === 'function') {
            plane.togglePause()
            if (plane.paused) meHoldPause = true
          }
        } catch {}
      }
      const meResumeReplay = (delayMs = 750) => {
        if (!meHoldPause) return
        meHoldPause = false
        if (meResumeTimer) clearTimeout(meResumeTimer)
        meResumeTimer = setTimeout(() => {
          meResumeTimer = null
          try {
            if (clientDead()) return
            if (plane?.paused && typeof plane.togglePause === 'function') {
              plane.togglePause()
            }
          } catch {}
        }, delayMs)
      }

      spec = new SpectateController({
        say,
        setGhostVisible: (visible) => {
          setGhostVisible(client, visible)
          if (visible) {
            // player_list + player_skin — bare player_skin after invis left Steve
            reassertGhostSkin('unhide')
            setTimeout(() => {
              if (clientDead() || spec?.isPossessing?.()) return
              reassertGhostSkin('unhide+300')
              try { applyGhostHands() } catch {}
            }, 300)
          } else {
            try { clearGhostHands() } catch {}
            // Clear only — never re-encode remembered armor onto the ghost
            writeArmorEquipment(client, GHOST_RUNTIME_ID, {}, { clearAll: true })
          }
        },
        setEntityVisible: (runtimeId, visible) => applyPossessVisuals(runtimeId, visible),
        onWatchStart: () => {
          if (clientDead()) return
          try {
            // NO gamemode flip here at all. Entering .spec/.me the client is
            // already in viewer mode (or onMePathApply/Reset does the one
            // needed flip). Redundant spectator re-flips + close_form on a
            // busy world are exactly the burst that kicked real clients.
            const targetingGhost = !!spec?.getTargetEntity?.()?.isGhost
            if (!targetingGhost) {
              clearSpectatorHotbar(client)
            }
            clearLocalArmor(client, runtimeId)
            // .spec others: same empty+park-9 layout as freecam so key 1 works
            if (controlHotbar && !targetingGhost) {
              setTimeout(() => { try { hotbarCtl?.parkIdle?.() } catch {} }, 30)
            }
          } catch (e) {
            console.warn('[play] watch start failed', e.message)
          }
        },
        onWatchEnd: () => {
          if (clientDead()) return
          // No gamemode flip: .spec never left viewer mode, and leaving .me is
          // onMePathReset's single flip. Extra re-flips kicked real clients.
          if (controlHotbar) {
            setTimeout(() => { try { hotbarCtl?.parkIdle?.() } catch {} }, 30)
          }
        },
        onMeEnterBegin: () => { mePauseReplay() },
        onMeEquipHeld: () => { equipMeHeld() },
        onMePathApply: (pathId) => {
          if (clientDead()) return
          // Single-flip enter: adventure + fly + FPV hand. NO hardResetMeDebug —
          // its camera/gamemode ladder is 2 extra flips that crash busy clients.
          const n = Number(pathId) || 0
          let r = { ok: true, path: n }
          try {
            if (n <= 0) {
              forceViewerMode(client, entityUniqueId, viewerMode)
            } else {
              client.write('set_player_game_type', { gamemode: 'adventure' })
              viewer.writeAbilities(client, entityUniqueId, {
                spectatorLayer: false,
                grounded: false
              })
              // Skin + hotbar AFTER the flip settles — same-tick push left FPV as Steve
              // and inventory_slot in the enter burst kicked. RAW equip is safe now.
              equipMeHeld()
              const pushFpv = () => {
                if (clientDead() || !spec?.isPossessing?.()) return
                try {
                  let ready = ghostSkinRef || recordedSelf?.skin
                  if (!ready) {
                    const nm = String(
                      recordedSelf?.name || ghostName || client?.profile?.name || ''
                    ).replace(/§./g, '').trim().toLowerCase()
                    const tab = nm ? skinsByName.get(nm) : null
                    if (tab) ready = tab
                  }
                  if (ready) pushLocalSkin(ready, recordedSelf?.name || ghostName)
                } catch (e) {
                  console.warn('[play] FPV skin push failed', e.message)
                }
                try { flushMeInventory() } catch {}
                try { equipMeHeld() } catch {}
              }
              setTimeout(pushFpv, 120)
              setTimeout(pushFpv, 400)
            }
          } catch (e) {
            r = { ok: false, path: n, error: e.message }
          }
          const tag = n === ME_COMMITTED_ME_PATH.pathId ? ' ★default' : ''
          console.log(`[me] apply P${n}${tag} ok=${r.ok} single-flip ${ME_PATH_LABELS[n] || ''}`)
          if (!r.ok) say(`§c[Me] fail: ${r.error || '?'}`)
          snapMeCam()
          meResumeReplay(750)
        },
        onMePathReset: () => {
          if (clientDead()) return
          // Single-flip leave: camera clear + one spectator flip. No hardReset
          // ladder, no invisibility pulse — those doubled the flips and kicked.
          mePauseReplay()
          try { client.write('camera_instruction', { clear: true }) } catch {}
          try {
            // forceViewerMode = game_type + close_form + abilities in one shot
            forceViewerMode(client, entityUniqueId, viewerMode)
          } catch (e) {
            console.warn('[me] reset failed', e.message)
          }
          try {
            clearSpectatorHotbar(client)
            clearLocalArmor(client, runtimeId)
          } catch {}
          snapMeCam()
          // Ghost was unhidden before this reset; forceViewerMode can wipe its skin.
          setTimeout(() => {
            if (clientDead()) return
            reassertGhostSkin('after-free')
            try { applyGhostHands() } catch {}
          }, 150)
          setTimeout(() => {
            if (clientDead()) return
            reassertGhostSkin('after-free+500')
          }, 500)
          setTimeout(() => {
            if (clientDead()) return
            reassertGhostSkin('after-free+1200')
          }, 1200)
          console.log('[me] reset single-flip → freecam')
          meResumeReplay(750)
        },
        sendLocalMove: (cam) => {
          localMoveTick += 1n
          if (!freecamFrozen && spec?.mode !== 'follow') rememberFreecam(cam, cam)
          const rid = typeof runtimeId === 'bigint' ? Number(runtimeId) : runtimeId
          try {
            client.write('move_player', buildMovePlayer(rid, cam, localMoveTick, {
              onGround: false
            }))
          } catch {}
        }
      }, {
        otherEyeOffset: cfg.spectateOtherEyeOffset ?? 0.10,
        otherForwardOffset: cfg.spectateOtherForwardOffset ?? 0.14,
        otherPitchBias: cfg.spectateOtherPitchBias ?? 0,
        otherYawBias: cfg.spectateOtherYawBias ?? 0,
        hideSelfOnPossess: cfg.spectateHideSelfOnPossess !== false,
        tickMs: cfg.spectateTickMs ?? 16,
        smooth: cfg.spectateSmooth ?? 0.38,
        possessEnabled: possessEnabledForVersion(version)
      })

      const applyViewerOrPossess = () => {
        // In .me re-assert via the SAME single-flip hook — applyMePath's
        // hardReset ladder is exactly what kicks real clients mid-stream.
        if (spec?.mode === 'follow' && spec.getTargetEntity?.()?.isGhost) {
          try { spec.onMePathApply(spec.getMePathId?.() ?? 0) } catch {}
          return
        }
        try {
          forceViewerMode(client, entityUniqueId, viewerMode)
        } catch {}
      }

      const onSpecClose = () => { try { spec.destroy() } catch {} }
      client.on('close', onSpecClose)

      const onChat = (pktOrRaw) => {
        const text = extractChatRaw(pktOrRaw)
        if (!text) return false
        console.log(`[play] chat: ${JSON.stringify(text)}`)
        const raw = text.trim().replace(/^\//, '').replace(/[\u200b\u200c\u200d\ufeff]/g, '')
        const lower = raw.toLowerCase()
        if (
          lower === '.live' || lower === 'live' ||
          lower === '.back' || lower === 'back' ||
          lower === '.real' || lower === '.server'
        ) {
          if (switchingToLive) return true
          if (typeof requestLive !== 'function') {
            say('§e[Replay] .live = выход из просмотра · зайди на LIVE снова')
            return true
          }
          switchingToLive = true
          // .live UX handled by hub/record — no extra chat spam here
          try { activeTransport?.abort() } catch {}
          Promise.resolve((async () => {
            await sleep(250)
            await requestLive({
              client,
              inPlace,
              close: () => closePlay({ exitProcess: false })
            })
          })()).catch((e) => {
            switchingToLive = false
            console.error('[play] .live failed', e)
            say(`§c[Replay] .live failed: ${e.message}`)
          })
          return true
        }
        if (
          lower === '.spawn' || lower === 'spawn' ||
          lower === '.home' || lower === 'home' ||
          lower === '.here' || lower === '.camhome'
        ) {
          try { spec?.setFree?.() } catch {}
          snapFreecamHome(lower.replace(/^\./, '') || 'spawn')
          return true
        }
        if (plane.handleChat(text, say)) return true
        if (spec.handleChat(text)) return true
        if (raw === '.' || (raw.startsWith('.') && !raw.includes(' '))) {
          if (raw !== '.' && raw !== '.h' && raw !== '.help') say(`§c[Replay] Unknown: §f${raw}`)
          plane.sayCommands(say)
          return true
        }
        return false
      }
      const onText = (p) => { onChat(p) }
      const onCommand = (p) => { onChat(p) }
      client.on('text', onText)
      client.on('command_request', onCommand)

      // 1–8 controls. Freecam + .spec: empty bar, park on 9. .me: restore real hand.
      hotbarCtl = attachSpectatorHotbar(client, plane, {
        spec,
        say,
        controlsEnabled: controlHotbar,
        restoreInventory: (opts = {}) => {
          // .me only: real tool in hand. Freecam + .spec others: empty + park on 9.
          const mode =
            opts.mode ||
            (spec?.isPossessing?.() ? 'hand' : 'park')
          if (mode === 'hand' && spec?.isPossessing?.()) {
            equipMeHeld()
            return
          }
          const park = Math.max(
            0,
            Math.min(8, Number(opts.parkSlot ?? IDLE_PARK_SLOT) || IDLE_PARK_SLOT)
          )
          try { clearSpectatorHotbar(client) } catch {}
          noteHotbarSelection(park)
          suppressHotbarSlot(park, 120)
          forceHotbarSlot(client, park, null)
          noteHotbarSelection(park)
          suppressHotbarSlot(park, 120)
        }
      })
      suppressHotbarSlot = (slot, ms) => {
        try { hotbarCtl.suppressSlot?.(slot, ms) } catch {}
      }
      noteHotbarSelection = (slot) => {
        try { hotbarCtl.noteSelection?.(slot) } catch {}
      }

      if (controlHotbar) {
        try { giveControlHotbar(client, { runtimeEntityId: runtimeId, version }) } catch {}
        // Park off slot 0 under suppress — otherwise first key 1 sends nothing
        try { hotbarCtl.parkIdle?.() } catch {}
      } else {
        try { clearSpectatorHotbar(client) } catch {}
      }

      const onTickSync = (pkt) => {
        try {
          client.queue('tick_sync', {
            request_time: pkt.request_time,
            response_time: pkt.request_time
          })
        } catch {}
      }
      client.on('tick_sync', onTickSync)

      // ── Kick forensics ─────────────────────────────────────────────────
      // The phone client DISCONNECTS ITSELF (graceful raknet notification)
      // seconds after a warp. Keep a tail of its last serverbound packets and
      // dump it on close; packet_violation_warning = client complaining about
      // a malformed clientbound packet right before it bails.
      const sbTail = []
      const sbT0 = Date.now()
      let lastAuthInputAt = 0
      const onAnySb = (des) => {
        const n = des?.data?.name
        if (!n) return
        if (n === 'player_auth_input') { lastAuthInputAt = Date.now(); return }
        if (n === 'tick_sync') return
        sbTail.push(`${((Date.now() - sbT0) / 1000).toFixed(1)}s ${n}`)
        if (sbTail.length > 40) sbTail.shift()
        if (n === 'packet_violation_warning') {
          try {
            console.warn('[play] CLIENT VIOLATION:', JSON.stringify(des.data.params))
          } catch {}
        }
      }
      client.on('packet', onAnySb)
      // Clientbound tail: the LAST packets WE sent before the client bailed —
      // if a specific replayed packet kills the client, its name is here.
      const cbTail = []
      const noteCb = (name) => {
        const last = cbTail[cbTail.length - 1]
        if (last && last.n === name) { last.c++; last.t = Date.now(); return }
        cbTail.push({ n: name, c: 1, t: Date.now() })
        if (cbTail.length > 48) cbTail.shift()
      }
      try {
        const origWrite = client.write.bind(client)
        const origQueue = client.queue.bind(client)
        client.write = (name, params) => { noteCb(name); return origWrite(name, params) }
        client.queue = (name, params) => { noteCb('q:' + name); return origQueue(name, params) }
      } catch (e) {
        console.warn('[play] cb tail hook failed', e.message)
      }
      // Client lost fly (falls, spams request_ability 20/s) — answer instantly
      // with spectator+fly instead of waiting for the next timed re-assert.
      let lastAbilityReassertAt = 0
      const onRequestAbility = () => {
        const now = Date.now()
        if (now - lastAbilityReassertAt < 1500) return
        lastAbilityReassertAt = now
        try { forceViewerMode(client, entityUniqueId, viewerMode) } catch {}
        if (isSanePos(freecamPos)) unlockInput(client, freecamPos)
        console.log('[play] request_ability from client — re-asserted spectator/fly')
      }
      client.on('request_ability', onRequestAbility)
      const onForensicClose = () => {
        const authAgo = lastAuthInputAt ? `${((Date.now() - lastAuthInputAt) / 1000).toFixed(1)}s ago` : 'never'
        console.log(`[play] client close — last auth_input ${authAgo}; sb tail: ${sbTail.slice(-25).join(' | ') || '(none)'}`)
        const now = Date.now()
        const cb = cbTail.map((e) => `${((now - e.t) / 1000).toFixed(1)}s ${e.n}${e.c > 1 ? 'x' + e.c : ''}`).join(' | ')
        console.log(`[play] cb tail (ago): ${cb || '(none)'}`)
      }
      client.on('close', onForensicClose)

      const detachSessionListeners = () => {
        try { client.off('player_auth_input', onViewerMove) } catch {}
        try { client.off('move_player', onViewerMove) } catch {}
        try { client.off('text', onText) } catch {}
        try { client.off('command_request', onCommand) } catch {}
        try { client.off('tick_sync', onTickSync) } catch {}
        try { client.off('packet', onAnySb) } catch {}
        try { client.off('request_ability', onRequestAbility) } catch {}
        try { client.off('close', onForensicClose) } catch {}
        try { client.off('close', onSpecClose) } catch {}
        try { spec.destroy() } catch {}
        try { clearRestoreCamTimers() } catch {}
      }

      let ghostName = recordedSelf?.name || client?.profile?.name || 'You'
      /** @type {Set<any>} */
      const trackedUnique = new Set()
      /** @type {Set<any>} */
      const trackedRuntime = new Set()
      /** @type {import('./control/transport.js').ReplayTransport | null} */
      let transport = null
      /** World packets already burst-sent for mid-session replays */
      let preloadedWorld = new Set()
      /** Bootstrap already sent start_game + chunks — do NOT send start_game again (wipes world). */
      let worldBootstrapped = false
      /** Wall-clock: block re-encoded ghost equip until client has settled. */
      let ghostEquipReadyAt = 0
      /** Absolute media-t: after a skipped mid-file start_game (void-hop reset),
       *  drop the following player_list/remove_entity flood that kicks Bedrock. */
      let worldResetSuppressUntilT = -1
      /** First skipped start_game is the one we already bootstrapped — must NOT
       *  suppress its follow-on player_list/add_player (join roster). Only later
       *  mid-file start_game skips (void-hop) arm WORLD_RESET_SUPPRESS. */
      let bootstrappedStartGameConsumed = false
      const WORLD_RESET_SUPPRESS = new Set([
        'player_list',
        'remove_entity',
        'add_player',
        'player_skin',
        'mob_effect',
        'inventory_content',
        'inventory_slot',
        'mob_equipment',
        'mob_armor_equipment',
        'update_attributes',
        'set_score',
        'set_display_objective',
        'remove_objective',
        'boss_event',
        'stop_sound',
        'biome_definition_list',
        'available_entity_identifiers',
        'creative_content',
        'crafting_data',
        'item_registry',
        'level_event',
        'level_event_generic',
        'set_time',
        'game_rules_changed',
        'set_player_game_type',
        'update_player_game_type',
        'update_abilities',
        'update_client_input_locks',
        'clientbound_close_form',
        'play_status'
      ])

      /** GamePE void-hop / dimension-reset placeholder — never follow freecam here.
       *  Only the high-Y hop (≈0,300,0). Ground at 0,74,0 is a real /spawn on
       *  many hubs — treating all x≈0,z≈0 as void skipped legitimate teleports. */
      const isVoidishPos = (p) => {
        if (!p) return true
        const x = Number(p.x)
        const y = Number(p.y)
        const z = Number(p.z)
        if (![x, y, z].every(Number.isFinite)) return true
        if (y >= 280 && Math.abs(x) < 32 && Math.abs(z) < 32) return true
        if (Math.abs(y - 300) < 8 && Math.abs(x) < 48 && Math.abs(z) < 48) return true
        return false
      }

      const writePkt = (name, params) => {
        try {
          client.write(name, params)
          sent++
          return true
        } catch (e) {
          try {
            client.queue(name, params)
            sent++
            return true
          } catch (e2) {
            console.warn(`[play] skip packet ${name}: ${e2.message}`)
            return false
          }
        }
      }

      const trackFromPacket = (name, params) => {
        if (name === 'add_player') {
          const rid = params.runtime_id
          const uid = asUniqueId(params.unique_id)
          const key = ridKey(rid)
          trackedUnique.add(uid)
          if (rid != null) {
            const nrid = toNumId(rid)
            trackedRuntime.add(rid)
            otherPlayerRids.add(nrid)
            recordedMeRids.delete(nrid) // was mis-tagged before add_player arrived
          }
          if (params.uuid != null && rid != null) {
            uuidByRid.set(toNumId(rid), String(params.uuid))
          }
          if (rid != null) addPlayerByRid.set(toNumId(rid), { ...params })
          if (params.skin) rememberSkin(params.uuid, params.skin, params.username)
          // held_item on add_player (other players) — ignore for .me
          spec.upsert({
            key,
            name: params.username,
            runtimeId: rid,
            uniqueId: uid,
            uuid: params.uuid != null ? String(params.uuid) : undefined,
            x: params.position?.x,
            y: params.position?.y,
            z: params.position?.z,
            pitch: params.pitch,
            yaw: params.yaw,
            head_yaw: params.head_yaw
          })
        } else if (name === 'add_entity' || name === 'add_item_entity') {
          const rid = params.runtime_id ?? params.runtime_entity_id
          const uid = asUniqueId(
            params.entity_unique_id ?? params.unique_id ?? params.entity_id_self
          )
          trackedUnique.add(uid)
          if (rid != null) trackedRuntime.add(rid)
        } else if (name === 'move_player') {
          const rid = params.runtime_id
          if (toNumId(rid) === toNumId(runtimeId)) return
          if (toNumId(rid) === GHOST_RUNTIME_ID) return
          const key = ridKey(rid)
          if (!spec.entities.has(key)) {
            spec.upsert({ key, name: `Player-${rid}`, runtimeId: rid })
          }
          spec.upsert({
            key,
            runtimeId: rid,
            x: params.position?.x,
            y: params.position?.y,
            z: params.position?.z,
            pitch: params.pitch,
            yaw: params.yaw,
            head_yaw: params.head_yaw
          })
        } else if (name === 'move_entity') {
          const rid = params.runtime_entity_id
          if (toNumId(rid) === GHOST_RUNTIME_ID) return
          const key = ridKey(rid)
          if (!spec.entities.has(key)) return
          // GamePE move_entity pitch is inverted vs player look (down↔up).
          // Negate so "looking at armor from above" stays looking down in FPV.
          const pitch = -fromByteRotDegrees(params.rotation?.pitch)
          spec.upsert({
            key,
            runtimeId: rid,
            x: params.position?.x,
            y: params.position?.y,
            z: params.position?.z,
            pitch,
            yaw: fromByteRotDegrees(params.rotation?.yaw),
            head_yaw: fromByteRotDegrees(params.rotation?.head_yaw)
          })
        } else if (name === 'remove_entity' || name === 'take_item_entity') {
          const uid = asUniqueId(params.entity_id_self ?? params.target)
          // Set delete needs same key type we inserted
          trackedUnique.delete(uid)
          for (const x of [...trackedUnique]) {
            if (asUniqueId(x) === uid) trackedUnique.delete(x)
          }
          if (name === 'remove_entity') spec.removeByUnique(uid)
        }
      }

      const spawnGhost = (at) => {
        if (!showSelfGhost || ghostSpawned) return
        try {
          const built = buildGhostPackets({
            client,
            position: at || spawnPos,
            addTemplate,
            recordedSelf,
            version
          })
          // Ghost-only skin polish: files without `self` often get blank/persona
          // login on the remote body. Classic tab-list bitmap is display-only —
          // NEVER written into recordedSelf (that path kicked .me).
          try {
            const candidates = [
              built.username,
              recordedSelf?.name,
              client?.profile?.name,
              client?.username
            ]
            let tab = null
            let matched = ''
            for (const raw of candidates) {
              const uname = String(raw || '').replace(/§./g, '').trim().toLowerCase()
              if (!uname) continue
              const hit = skinsByName.get(uname)
              if (hit) {
                tab = hit
                matched = uname
                break
              }
            }
            const bitmapLen = (() => {
              const d = built.playerSkin?.skin?.skin_data?.data
              if (Buffer.isBuffer(d)) return d.length
              if (d?.$bytes) return d.$bytes.length
              if (Array.isArray(d)) return d.length
              return 0
            })()
            // Prefer tab whenever present — login often is 64² Steve (len≥1000)
            // and previously skipped tab_fix.
            if (tab) {
              const skin = fixSkin(tab)
              if (skin) {
                if (built.playerList?.records?.records?.[0]) {
                  built.playerList.records.records[0].skin_data = skin
                }
                if (built.playerSkin) built.playerSkin.skin = skin
                if (built.addPlayer) built.addPlayer.skin = skin
                built.skinSource = 'tab_fix'
                console.log(`[play] ghost skin ← tab_fix (${matched || '?'}) bytes~${bitmapLen}`)
              }
            }
          } catch {}
          ghostSkinRef = built.playerSkin?.skin || built.addPlayer?.skin || null
          ghostSkinName = built.username || ghostName
          ghostUuid = built.uuid || built.playerSkin?.uuid || built.addPlayer?.uuid || null
          ghostListPkt = built.playerList || null
          // Never put a real network_id on add_player / mob_equipment at spawn.
          // Even with a valid item_registry, our re-encoded equip item can crash
          // Bedrock («Произошла ошибка») within a second of join.
          try {
            if (built.addPlayer) built.addPlayer.held_item = emptyItem()
          } catch {}
          if (!writePkt('player_list', built.playerList)) {
            throw new Error('player_list write failed')
          }
          if (!writePkt('add_player', built.addPlayer)) {
            throw new Error('add_player write failed')
          }
          try {
            client.write('player_skin', built.playerSkin)
          } catch (e) {
            console.warn('[play] player_skin failed', e.message)
          }
          ghostSpawned = true
          ghostName = built.username
          trackedUnique.add(GHOST_UNIQUE_ID)
          trackedRuntime.add(GHOST_RUNTIME_ID)
          spec.upsert({
            key: ghostKey(),
            name: built.username,
            runtimeId: GHOST_RUNTIME_ID,
            uniqueId: GHOST_UNIQUE_ID,
            x: at?.x ?? spawnPos?.x,
            y: at?.y ?? spawnPos?.y,
            z: at?.z ?? spawnPos?.z,
            pitch: 0,
            yaw: 0,
            head_yaw: 0,
            isGhost: true
          })
          console.log(`[play] Ghost "${built.username}" skin=${built.skinSource} rid=${GHOST_RUNTIME_ID}`)
          // Empty hands first (safe write). Real items only via RAW sendBuffer after settle.
          try {
            applyGhostHeld(client, {
              item: emptyItem(),
              slot: 0,
              selected_slot: 0,
              window_id: 'inventory'
            })
            const settleMs = itemRegistryInjected ? 500 : 1600
            ghostEquipReadyAt = Date.now() + settleMs
            console.log(
              `[play] ghost hands on spawn main=0; RAW equip after ${settleMs}ms ` +
              `(hasMain=${!!lastGhostHeldRawMain} hasOff=${!!lastGhostHeldRawOff} hasArmor=${!!lastGhostArmorRaw})`
            )
            setTimeout(() => {
              try { applyGhostHands() } catch {}
            }, settleMs + 50)
          } catch (e) {
            console.warn('[play] ghost hand on spawn failed', e.message)
          }
        } catch (e) {
          console.warn('[play] ghost spawn failed:', e.message)
        }
      }

      const handleEvent = async (ev, meta = {}) => {
        const catchingUp = !!meta.catchingUp
        const resetCamera = !!meta.resetCamera || !!transport?._resetCamera

        if (ev.type === 'mark') {
          if (ev.n === 'transfer') {
            if (!catchingUp) console.log(`[play] (mark) transfer → ${ev.host || '?'}:${ev.port || '?'}`)
            closeForms(client)
          }
          return
        }

        if (ev.type === 'self') return

        // Recorder's own hand / offhand / armor (serverbound RAW or JSON samples)
        if (ev.type === 'held') {
          const gid = toNumId(GHOST_RUNTIME_ID)
          const possessing = !!spec?.isPossessing?.()
          const isArmor = ev.n === 'mob_armor_equipment'
          const offhand = !isArmor && isOffhandWindow(ev.p?.window_id)

          if (ev.p) {
            if (isArmor) {
              // metadata only — real apply is RAW below
            } else if (offhand) {
              offhandByRid.set(gid, { ...ev.p, window_id: 'offhand' })
            } else {
              heldByRid.set(gid, { ...ev.p })
            }
          }

          if (ev.raw && ev.b != null) {
            const body = ev.b
            const buf = Buffer.isBuffer(body)
              ? body
              : Buffer.from(typeof body === 'string' ? body : '', 'base64')
            if (buf.length) {
              if (isArmor) lastGhostArmorRaw = buf
              else if (offhand) lastGhostHeldRawOff = buf
              else lastGhostHeldRawMain = buf

              if (possessing && !isArmor) {
                // lastGhostHeldRaw* already updated above — equipMeHeld sends RAW→local
                if (offhand) {
                  sendLocalEquipRaw(client, buf, runtimeId, 'off')
                } else {
                  equipMeHeld()
                }
              } else if (ghostSpawned && !possessing && Date.now() >= ghostEquipReadyAt) {
                const label = isArmor ? 'armor' : (offhand ? 'off' : 'main')
                if (sendGhostEquipRaw(client, buf, label)) {
                  ghostRawEquipN++
                  if (ghostRawEquipN <= 5 || ghostRawEquipN % 25 === 0) {
                    console.log(`[play] ghost RAW ${label} #${ghostRawEquipN} len=${buf.length}`)
                  }
                }
              }
            }
          } else if (possessing && ev.p) {
            // JSON-only held (auth_input etc.) — local FPV only, never onto ghost
            if (offhand) {
              equipLocalOffhand(client, ev.p)
            } else {
              equipMeHeld()
            }
          }
          // Non-raw + freecam: maps updated above; do NOT client.write onto ghost
          lastT = ev.t
          return
        }

        if (ev.type === 'cam') {
          if (!isSanePos(ev.p)) return

          // Recorded self teleported far (warp/command) — pull the viewer along,
          // otherwise he's left behind in unloaded chunks watching nothing.
          if (!catchingUp && !followRecording && !spec?.isPossessing?.() && spec?.mode !== 'follow') {
            const prev = lastGhostCamPos
            lastGhostCamPos = { x: ev.p.x, y: ev.p.y, z: ev.p.z }
            if (prev) {
              const dx = ev.p.x - prev.x
              const dy = ev.p.y - prev.y
              const dz = ev.p.z - prev.z
              if (dx * dx + dy * dy + dz * dz > 64 * 64) {
                // Never drag freecam into GamePE void-hop / 0,0 — that dumps the
                // viewer in unloaded void and finishes with a self-kick.
                if (isVoidishPos(ev.p)) {
                  console.log(
                    `[play] recorded self warped ${Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz))}m ` +
                    `to voidish ${ev.p.x|0},${ev.p.y|0},${ev.p.z|0} — freecam stays put`
                  )
                } else {
                freecamPos = {
                  x: ev.p.x,
                  y: (ev.p.y ?? 0) + 6,
                  z: ev.p.z,
                  pitch: 35,
                  yaw: ev.p.yaw ?? 0,
                  head_yaw: ev.p.head_yaw ?? ev.p.yaw ?? 0
                }
                // TELEPORT FIRST, then terrain. Sending publisher_update for the
                // destination while the client is still at the old pos makes
                // Bedrock CULL the current world → void → self-kick (1.0.50
                // regression). Move, then tell it where the chunks are.
                try {
                  tick += 1n
                  client.write('move_player', buildMovePlayer(runtimeId, freecamPos, tick))
                } catch {}
                try { forceViewerMode(client, entityUniqueId, viewerMode) } catch {}
                unlockInput(client, freecamPos)
                publishChunksAround(freecamPos)
                resendChunksNear(freecamPos)
                try { lastTerrainKeepPos = { x: freecamPos.x, z: freecamPos.z } } catch {}
                // Client also CULLED the ghost entity along with those chunks —
                // respawn the body at the new spot (add_player again).
                if (ghostSpawned) {
                  try { client.write('remove_entity', { entity_id_self: GHOST_UNIQUE_ID }) } catch {}
                  try { spec.removeByUnique?.(GHOST_UNIQUE_ID) } catch {}
                  ghostSpawned = false
                }
                // Re-assert spectator+fly shortly after: the warp/teleport can
                // knock the client out of fly (it starts spamming request_ability
                // 20/s and falls). Same double-tap the bootstrap uses.
                setTimeout(() => {
                  try { forceViewerMode(client, entityUniqueId, viewerMode) } catch {}
                  unlockInput(client, freecamPos)
                }, 500)
                console.log(`[play] recorded self warped ${Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz))}m — freecam follows`)
                }
              }
            }
          } else {
            lastGhostCamPos = { x: ev.p.x, y: ev.p.y, z: ev.p.z }
          }

          if (showSelfGhost) {
            if (!ghostSpawned) spawnGhost(ev.p)
            if (ghostSpawned) {
              ghostTick += 1n
              const pkts = ghostMovePackets(ev.p, ghostTick)
              for (const pkt of pkts) {
                try {
                  client.write(pkt.name, pkt.params)
                } catch (e) {
                  if (ghostTick < 5n) console.warn(`[play] ghost ${pkt.name} failed`, e.message)
                }
              }
              spec.upsert({
                key: ghostKey(),
                name: ghostName,
                runtimeId: GHOST_RUNTIME_ID,
                uniqueId: GHOST_UNIQUE_ID,
                x: ev.p.x,
                y: ev.p.y,
                z: ev.p.z,
                pitch: ev.p.pitch,
                yaw: ev.p.yaw,
                head_yaw: ev.p.head_yaw,
                isGhost: true
              })
            }
          }

          if (followRecording && !catchingUp) {
            try {
              tick += 1n
              client.write('move_player', buildMovePlayer(runtimeId, {
                x: ev.p.x,
                y: (ev.p.y ?? 0) + (cfg.spectateEyeOffset ?? 0.22),
                z: ev.p.z,
                pitch: ev.p.pitch,
                yaw: ev.p.yaw,
                head_yaw: ev.p.head_yaw
              }, tick))
            } catch (e) {
              if (sent < 5) console.warn('[play] cam inject failed', e.message)
            }
          }
          return
        }

        if (ev.type !== 'pkt' || ev.d !== 'c') return

        // Raw heavy clientbound (skins / tab list): bytes as recorded — no re-encode.
        if (ev.raw) {
          if (preloadedWorld.has(ev)) {
            lastT = ev.t
            return
          }
          if (
            worldResetSuppressUntilT >= 0 &&
            (ev.t ?? 0) <= worldResetSuppressUntilT &&
            (WORLD_RESET_SUPPRESS.has(ev.n) || ev.n === 'raw' || ev.n === 'item_registry')
          ) {
            lastT = ev.t
            return
          }
          // During freecam, never re-apply a mid-file item_registry (world reset).
          if (ev.n === 'item_registry' && worldBootstrapped) {
            lastT = ev.t
            return
          }
          try {
            const body = ev.b
            const buf = Buffer.isBuffer(body)
              ? body
              : Buffer.from(typeof body === 'string' ? body : '', 'base64')
            if (!buf.length) return

            // Local player armor arrives as inventory_content(window=armor), not
            // mob_armor_equipment. Freecam: convert → ghost RAW. .me: forward to viewer.
            try {
              const [pid] = readVarIntAt(buf, 0)
              if (pid === PKT_INVENTORY_CONTENT || pid === PKT_INVENTORY_SLOT) {
                const win = peekInventoryWindowId(buf)
                const possessing = !!spec?.isPossessing?.()
                if (win === WIN_ARMOR) {
                  if (pid === PKT_INVENTORY_CONTENT && !possessing) {
                    const built = inventoryArmorToMobArmor(buf, GHOST_RUNTIME_ID)
                    if (built?.length) {
                      lastGhostArmorRaw = built
                      if (ghostSpawned && Date.now() >= ghostEquipReadyAt) {
                        if (sendGhostEquipRaw(client, built, 'armor')) {
                          ghostRawEquipN++
                          if (ghostRawEquipN <= 5 || ghostRawEquipN % 25 === 0) {
                            console.log(`[play] ghost RAW armor #${ghostRawEquipN} len=${built.length}`)
                          }
                        }
                      }
                    }
                    lastT = ev.t
                    return
                  }
                  if (!possessing) {
                    lastT = ev.t
                    return
                  }
                  // .me: fall through → sendBuffer armor inventory to FPV viewer
                } else if (!possessing) {
                  // Freecam/.spec: never feed non-armor inventory RAW to viewer
                  lastT = ev.t
                  return
                }
                // .me: fall through → sendBuffer recorded inventory RAW
              }
            } catch {}

            if (typeof client.sendBuffer === 'function') {
              client.sendBuffer(buf, false)
            } else {
              throw new Error('no sendBuffer')
            }
            sent++
            lastT = ev.t
            if (!catchingUp && (sent <= 3 || sent % 200 === 0)) {
              console.log(`[play] raw-heavy len=${buf.length} t=${(ev.t / 1000).toFixed(1)}s`)
            }
          } catch (e) {
            console.warn(`[play] raw send fail: ${e?.message || e}`)
          }
          return
        }

        if (SKIP_PLAY_CLIENTBOUND.has(ev.n)) return
        if (preloadedWorld.has(ev)) {
          lastT = ev.t
          return
        }
        if (
          worldResetSuppressUntilT >= 0 &&
          (ev.t ?? 0) <= worldResetSuppressUntilT &&
          WORLD_RESET_SUPPRESS.has(ev.n)
        ) {
          lastT = ev.t
          return
        }
        // Freecam/.spec: never apply inventory_* to the VIEWER.
        // .me: forward recorded inventory_* (pre-1.1 phone path) — not creative.
        if (
          ev.n === 'inventory_content' ||
          ev.n === 'inventory_slot' ||
          ev.n === 'player_hotbar'
        ) {
          noteRecordedInventory(ev.n, ev.p)
        }
        if (
          !catchingUp &&
          !followRecording &&
          (ev.n === 'inventory_content' ||
            ev.n === 'inventory_slot' ||
            ev.n === 'creative_content')
        ) {
          if (
            ev.n === 'creative_content' ||
            !spec?.isPossessing?.()
          ) {
            lastT = ev.t
            return
          }
        }
        if (ev.n === 'play_status' && ev.p?.status === 'login_success') return
        if (ev.n === 'disconnect') return
        if ((!playSounds || plane?.muted) && SOUND_PACKETS.has(ev.n)) {
          lastT = ev.t
          return
        }

        // Catch-up: block full bootstrap. Post-.restart (even after freecam move):
        // block only spawn-yank so ▶ does not teleport to recording spawn.
        const keepCamera = catchingUp && !resetCamera
        const protectFreecam = keepCamera || (!!keepCamThroughResume && !resetCamera)
        const protectBlock = keepCamera ? KEEP_CAM_CATCHUP_BLOCK : SPAWN_YANK_BLOCK

        if (protectFreecam && protectBlock.has(ev.n)) {
          if (ev.n === 'start_game') {
            runtimeId = toNumId(ev.p?.runtime_entity_id ?? runtimeId)
            entityUniqueId = ev.p?.entity_id ?? entityUniqueId
            if (transport) transport.localRuntimeId = runtimeId
            if (!spectatorReady) {
              spectatorReady = true
              if (isSanePos(spawnPos) && !ghostSpawned) spawnGhost(spawnPos)
            }
            if (keepCamera) console.log('[play] start_game skipped (keep camera)')
          }
          lastT = ev.t
          return
        }
        if (protectFreecam) {
          const rid = toNumId(ev.p?.runtime_id ?? ev.p?.runtime_entity_id)
          if (
            rid === toNumId(runtimeId) &&
            (ev.n === 'move_player' || ev.n === 'set_entity_motion' ||
             ev.n === 'update_attributes' || ev.n === 'set_entity_data' ||
             ev.n === 'mob_effect' || ev.n === 'mob_equipment')
          ) {
            lastT = ev.t
            return
          }
        }

          if (suppressUi && SUPPRESS_UI_PACKETS.has(ev.n)) {
            skippedUi++
            if (ev.n === 'modal_form_request') closeForms(client)
            return
          }

          if (SUPPRESS_TITLE_PACKETS.has(ev.n)) {
            skippedUi++
            return
          }

          if (SUPPRESS_HUD_PACKETS.has(ev.n)) {
            skippedUi++
            return
          }

          if (!playShowChat && SUPPRESS_CHAT_PACKETS.has(ev.n)) {
            skippedUi++
            return
          }

          // Right-side scoreboard from recording (tip legend removed — no conflict)
          if (!playShowSidebar && SUPPRESS_SIDEBAR_PACKETS.has(ev.n)) {
            skippedUi++
            return
          }

          if (SUPPRESS_LOCATOR_PACKETS.has(ev.n)) {
            skippedUi++
            return
          }

          // Freecam/.spec: block recorded inventory spam.
          // .me: forward inventory_slot/content/player_hotbar (old phone path).
          if (SUPPRESS_INVENTORY_PACKETS.has(ev.n)) {
            if (ev.n === 'mob_equipment') {
              const rid = toNumId(ev.p?.runtime_entity_id)
              if (rid != null) rememberHeld(rid, ev.p)
              const forMe = isRecordedMeEquipment(rid, ev.p)
              if (!forMe) {
                // Other players' hands — let packet through as-is below
              } else {
                rememberHeld(toNumId(GHOST_RUNTIME_ID), ev.p)
                const possessing = !!spec?.isPossessing?.()
                if (possessing) {
                  // .me: FPV hand select + RAW; ghost stays empty-handed
                  if (isOffhandWindow(ev.p?.window_id)) {
                    equipLocalOffhand(client, ev.p)
                  } else {
                    equipMeHeld()
                  }
                } else if (ghostSpawned) {
                  // Never client.write re-encoded gear onto the ghost — kicks.
                  // Remember for a future RAW remap path; keep hands empty.
                  lastT = ev.t
                  return
                }
                lastT = ev.t
                return
              }
            } else if (
              spec?.isPossessing?.() &&
              (ev.n === 'inventory_slot' ||
                ev.n === 'inventory_content' ||
                ev.n === 'player_hotbar')
            ) {
              // fall through → client.write recorded packet to FPV viewer
            } else {
              skippedUi++
              return
            }
          }

        if (ev.n === 'update_client_input_locks') {
          lastT = ev.t
          return
        }

        if (ev.n === 'set_player_game_type' || ev.n === 'update_player_game_type') {
          noteMeGameMode(ev.p?.gamemode ?? ev.p?.game_type ?? ev.p?.player_gamemode)
          // Re-sending gamemode snaps freecam to server spawn
          if ((spectatorReady || protectFreecam) && !resetCamera) {
            lastT = ev.t
            return
          }
          writePkt('set_player_game_type', {
            gamemode: viewerMode === 'creative_noclip' ? 'adventure' : 'spectator'
          })
          lastT = ev.t
          return
        }

        if (ev.n === 'set_health') {
          if (ev.p?.health != null) meHealth = Number(ev.p.health) || meHealth
          lastT = ev.t
          return
        }

        if (ev.n === 'update_abilities' || ev.n === 'client_cheat_ability') {
          lastT = ev.t
          return
        }

        // Never yank freecam with recording teleports (also after restart→resume)
        if (!followRecording) {
          if (
            ev.n === 'respawn' ||
            ev.n === 'set_spawn_position' ||
            ev.n === 'camera_instruction' ||
            ev.n === 'change_dimension'
          ) {
            // Void-hop / dimension reset often ships biome_definition_list +
            // player_list flood BEFORE the second start_game — arm suppress now.
            if (ev.n === 'change_dimension') {
              worldResetSuppressUntilT = Math.max(worldResetSuppressUntilT, (ev.t ?? 0) + 5000)
              if (!catchingUp) {
                console.log('[play] change_dimension skipped — suppressing world-reset burst')
              }
            }
            lastT = ev.t
            return
          }
          // Recorded publisher coords follow the recorded player — if freecam
          // is elsewhere that culls our terrain. Retarget below after params=.
          if (ev.n === 'correct_player_move_prediction') return
          if (ev.n === 'motion_prediction_hints') {
            lastT = ev.t
            return
          }
          if (ev.n === 'move_player') {
            const rid = toNumId(ev.p?.runtime_id)
            if (rid === toNumId(runtimeId) || rid === toNumId(GHOST_RUNTIME_ID)) return
          }
          if (ev.n === 'set_entity_motion') {
            const rid = toNumId(ev.p?.runtime_entity_id ?? ev.p?.runtime_id)
            if (rid === toNumId(runtimeId)) return
          }
        }

        let params = ev.p

        if (ev.n === 'inventory_slot' || ev.n === 'inventory_content') {
          params = fixInventoryParams(ev.n, params)
        }

        // Recorder combat/status FX share start_game runtime id with the spectator.
        // Freecam: drop on the local camera body (do NOT remap onto ghost — that
        // poisoned metadata and kicked .me). .me: keep animate/entity_event so
        // FPV arms swing; set_entity_data/mob_effect still dropped (invis/flags).
        if (!followRecording) {
          const rid = toNumId(params?.runtime_entity_id ?? params?.runtime_id)
          if (rid === toNumId(runtimeId)) {
            const possessing = !!spec?.isPossessing?.()
            if (ev.n === 'set_entity_data' || ev.n === 'mob_effect') {
              lastT = ev.t
              return
            }
            if (ev.n === 'entity_event') {
              if (!possessing) {
                lastT = ev.t
                return
              }
              // .me: fall through — remap onto local below via already-local rid
            }
            if (ev.n === 'animate') {
              if (!possessing) {
                lastT = ev.t
                return
              }
              // .me: fall through to possess remap (swing + other arm anims)
            }
          }
        }

        // Freecam owns the chunk radius — rewrite recorded publisher to viewer pos
        // so a far teleport in the recording never empties the world under us.
        if (
          !followRecording &&
          ev.n === 'network_chunk_publisher_update' &&
          isSanePos(freecamPos)
        ) {
          params = {
            ...(ev.p || {}),
            coordinates: {
              x: Math.floor(freecamPos.x),
              y: Math.floor(freecamPos.y),
              z: Math.floor(freecamPos.z)
            },
            radius: ev.p?.radius ?? 128,
            saved_chunks: ev.p?.saved_chunks ?? []
          }
          lastPublisherPos = { x: freecamPos.x, y: freecamPos.y, z: freecamPos.z }
          lastPublisherAt = Date.now()
        }

        if (ev.n === 'player_list') {
          params = fixPlayerListParams(
            scrubRecorderFromPlayerList(
              scrubPlayerListLocator(ev.p),
              [
                client?.profile?.name,
                client?.username,
                recordedSelf?.name,
                ghostName
              ]
            )
          )
          const block = params?.records || params
          const recs = block?.records
          if (Array.isArray(recs) && (block.type === 'add' || block.type === 0 || block.type === '0')) {
            for (const rec of recs) {
              if (!rec) continue
              if (rec.uuid != null) listRecByUuid.set(String(rec.uuid), { ...rec })
              if (rec?.skin_data || rec?.skin) {
                rememberSkin(rec.uuid, rec.skin_data || rec.skin, rec.username)
              }
            }
          }
        } else if (
          ev.n === 'add_player' ||
          ev.n === 'add_entity' ||
          ev.n === 'add_item_entity' ||
          ev.n === 'remove_entity' ||
          ev.n === 'take_item_entity'
        ) {
          params = fixActorIds(ev.n, params)
        }

        // Bedrock: add_player is invisible unless UUID is already in player_list
        if (ev.n === 'add_player' && params?.uuid != null) {
          const u = String(params.uuid)
          const rec = listRecByUuid.get(u)
          const skin = skinsByUuid.get(u) || rec?.skin_data || params.skin
          if (skin || rec) {
            try {
              const row = {
                uuid: params.uuid,
                entity_unique_id: rec?.entity_unique_id ?? params.unique_id ?? 0n,
                username: params.username || rec?.username || '',
                xbox_user_id: rec?.xbox_user_id != null ? String(rec.xbox_user_id) : '',
                platform_chat_id: rec?.platform_chat_id || '',
                build_platform: rec?.build_platform ?? 0,
                skin_data: fixSkin(skin || rec?.skin_data),
                is_teacher: !!rec?.is_teacher,
                is_host: !!rec?.is_host,
                is_subclient: !!rec?.is_subclient,
                is_customer: !!rec?.is_customer
              }
              const one = fixPlayerListParams({
                records: {
                  type: 'add',
                  records_count: 1,
                  records: [row],
                  verified: [true]
                }
              })
              writePkt('player_list', one)
            } catch (e) {
              console.warn('[play] ensure player_list failed', e.message)
            }
          }
        }

        if (ev.n === 'game_rules_changed') {
          params = {
            ...ev.p,
            rules: forceLocatorBarOffInRules(ev.p?.rules)
          }
        }

        if (ev.n === 'start_game') {
          runtimeId = toNumId(ev.p?.runtime_entity_id ?? runtimeId)
          entityUniqueId = ev.p?.entity_id ?? entityUniqueId
          if (transport) transport.localRuntimeId = runtimeId
          noteMeGameMode(ev.p?.player_gamemode ?? ev.p?.player_game_type)

          // Second start_game after bootstrap wipes preloaded chunks → void forever
          if (worldBootstrapped && !resetCamera) {
            if (!catchingUp) console.log('[play] start_game skipped (already bootstrapped — keep chunks)')
            if (bootstrappedStartGameConsumed) {
              // Void-hop / mode reset: next ~4s of media is a toxic player_list /
              // remove_entity storm — suppress so freecam survives the hop.
              worldResetSuppressUntilT = Math.max(worldResetSuppressUntilT, (ev.t ?? 0) + 4000)
            } else {
              // Join roster lives right after this packet — do not suppress.
              bootstrappedStartGameConsumed = true
            }
            if (!spectatorReady) {
              forceViewerMode(client, entityUniqueId, viewerMode)
              unlockInput(client, spawnPos)
              spectatorReady = true
            }
            lastT = ev.t
            return
          }

          params = {
            ...ev.p,
            player_gamemode: viewerMode === 'creative_noclip' ? 'adventure' : 'spectator',
            gamerules: forceLocatorBarOffInRules(ev.p?.gamerules)
          }
          if (params.limited_world_width != null) params.limited_world_width = 0
          if (params.limited_world_length != null) params.limited_world_length = 0
          if (isSanePos(spawnPos) && !isSanePos(params.player_position)) {
            params.player_position = { ...spawnPos }
          } else if (isSanePos(params.player_position)) {
            spawnPos = params.player_position
          }
          if (catchingUp && resetCamera && isSanePos(spawnPos)) {
            freecamPos = { ...spawnPos, pitch: 0, yaw: 0, head_yaw: 0 }
            seekCamLock = { ...freecamPos }
            params = {
              ...params,
              player_position: { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z }
            }
          }
          if (!catchingUp) {
            console.log(`[play] start_game → pos ${params.player_position?.x}, ${params.player_position?.y}, ${params.player_position?.z}`)
          }
        }

        if (ev.n === 'set_entity_data') {
          const hideRid = toNumId(spec.getHiddenRuntimeId?.())
          const rid = toNumId(params?.runtime_entity_id ?? params?.runtime_id)
          if (hideRid != null && rid === hideRid) {
            params = forceEntityInvisibleParams(params)
          }
        }

        if (ev.n === 'mob_armor_equipment') {
          const rid = toNumId(params?.runtime_entity_id)
          if (rid != null) {
            const piece = {
              helmet: params.helmet,
              chestplate: params.chestplate,
              leggings: params.leggings,
              boots: params.boots,
              body: params.body
            }
            armorByRid.set(rid, piece)
            // Recorder local id / ghost → same kit for .me
            if (rid === toNumId(runtimeId) || rid === toNumId(GHOST_RUNTIME_ID)) {
              armorByRid.set(toNumId(GHOST_RUNTIME_ID), piece)
            }
          }
          const hideRid = toNumId(spec.getHiddenRuntimeId?.())
          if (hideRid != null && rid === hideRid && !spec?.isPossessing?.()) {
            // Other-player spectator cam — keep armor stripped
            params = withAllArmorCleared(params)
          } else if (
            !followRecording &&
            !spec?.isPossessing?.() &&
            (rid === toNumId(runtimeId) || rid === toNumId(GHOST_RUNTIME_ID))
          ) {
            // Remember armor for later; do not client.write it onto the ghost
            // (same re-encode crash as hands). Drop viewer-targeted packet.
            lastT = ev.t
            return
          }
        }

        if (ev.n === 'update_attributes') {
          const rid = toNumId(params?.runtime_entity_id)
          if (rid === toNumId(runtimeId) || rid === toNumId(GHOST_RUNTIME_ID)) {
            meAttributes = {
              attributes: params.attributes,
              tick: params.tick
            }
            const hp = params.attributes?.find?.(
              (a) => String(a?.name || a?.key || '').includes('health')
            )
            if (hp?.current != null) meHealth = Number(hp.current) || meHealth
            else if (hp?.value != null) meHealth = Number(hp.value) || meHealth
          }
          if (spec?.isPossessing?.() && rid === toNumId(runtimeId)) {
            // already local
          } else if (spec?.isPossessing?.() && rid === toNumId(GHOST_RUNTIME_ID)) {
            params = {
              ...params,
              runtime_entity_id: typeof runtimeId === 'bigint' ? runtimeId : BigInt(toNumId(runtimeId))
            }
          } else if (rid === toNumId(runtimeId) && !followRecording) {
            // Don't let recorded attributes fight freecam
            lastT = ev.t
            return
          }
        }

        if (ev.n === 'mob_equipment') {
          const rid = toNumId(params?.runtime_entity_id)
          if (rid === toNumId(runtimeId) || rid === toNumId(GHOST_RUNTIME_ID)) {
            rememberHeld(toNumId(GHOST_RUNTIME_ID), params)
          }
        }

        // .me: replay arm anims onto local FPV body (swing + use + etc.)
        if (ev.n === 'animate' && spec?.isPossessing?.()) {
          const rid = toNumId(params?.runtime_entity_id)
          if (rid === toNumId(GHOST_RUNTIME_ID) || rid === toNumId(runtimeId)) {
            params = {
              ...params,
              runtime_entity_id: typeof runtimeId === 'bigint' ? runtimeId : BigInt(toNumId(runtimeId))
            }
          }
        }

        if (ev.n === 'entity_event' && spec?.isPossessing?.()) {
          const rid = toNumId(params?.runtime_entity_id ?? params?.runtime_id)
          if (rid === toNumId(GHOST_RUNTIME_ID) || rid === toNumId(runtimeId)) {
            params = {
              ...params,
              runtime_entity_id: typeof runtimeId === 'bigint' ? runtimeId : BigInt(toNumId(runtimeId))
            }
          }
        }

        if (ev.n === 'add_player') {
          const rid = toNumId(params?.runtime_id)
          if (rid != null) addPlayerByRid.set(rid, { ...params })
          if (params?.skin) rememberSkin(params.uuid, params.skin, params.username)
          const hideRid = toNumId(spec.getHiddenRuntimeId?.())
          if (hideRid != null && rid === hideRid) {
            params = forceEntityInvisibleParams(params)
          }
        }

        // Local move already filtered above when !followRecording

        if (!writePkt(ev.n, params)) {
          if (ev.n === 'add_item_entity' || ev.n === 'add_player') {
            console.warn(`[play] WRITE FAIL ${ev.n}`, ev.p?.item?.network_id ?? ev.p?.username)
          }
          return
        }
        lastT = ev.t
        trackFromPacket(ev.n, params)

        // GamePE never CB-rebroadcasts your own swing_arm (Replay 1: 0 self animates).
        // AttackStrong / Attack / Bow near the recorder are the only reliable cue —
        // synthesize local FPV arm swing while in .me.
        if (
          ev.n === 'level_sound_event' &&
          spec?.isPossessing?.() &&
          !catchingUp
        ) {
          const sid = String(params?.sound_id ?? params?.sound_name ?? '')
          if (/^Attack/i.test(sid) || sid === 'Bow') {
            const pos = params?.position
            const cam = spec?.cam || lastGhostCamPos
            let near = true
            if (pos && cam && Number.isFinite(pos.x) && Number.isFinite(cam.x)) {
              const dx = pos.x - cam.x
              const dy = (pos.y ?? 0) - (cam.y ?? 0)
              const dz = pos.z - cam.z
              near = dx * dx + dy * dy + dz * dz < 36 // 6 blocks
            }
            if (near) {
              try {
                const rid = typeof runtimeId === 'bigint' ? runtimeId : BigInt(toNumId(runtimeId) || 0)
                client.write('animate', {
                  action_id: 'swing_arm',
                  runtime_entity_id: rid
                })
              } catch {}
            }
          }
        }

        if (ev.n === 'level_chunk') {
          chunksSent++
          noteChunkDelivered(params)
        }
        if (ev.n === 'add_item_entity') {
          if (!catchingUp && sent % 200 === 0) {
            console.log(`[play] add_item_entity nid=${params?.item?.network_id} at ${params?.position?.x?.toFixed?.(1)}`)
          }
        }
        if (ev.n === 'add_player') {
          playersAdded++
          if (!catchingUp && (playersAdded <= 5 || playersAdded % 10 === 0)) {
            console.log(`[play] add_player #${playersAdded} ${params?.username || '?'}`)
          }
          const skin = params?.uuid != null ? skinsByUuid.get(String(params.uuid)) : null
          if (skin) {
            try {
              client.write('player_skin', {
                uuid: params.uuid,
                skin: fixSkin(skin),
                skin_name: params.username || '',
                old_skin_name: '',
                is_verified: true
              })
            } catch (e) {
              if (playersAdded <= 3) console.warn('[play] player_skin failed', e.message)
            }
          } else if (!catchingUp && playersAdded <= 8) {
            console.warn(`[play] add_player without skin cache: ${params?.username}`)
          }
          // Other players' nametags (config showPlayerNames, default on)
          const nameRid = toNumId(params?.runtime_id)
          if (nameRid != null && nameRid !== toNumId(GHOST_RUNTIME_ID)) {
            try {
              setPlayerNametag(client, nameRid, params?.username, showPlayerNames)
            } catch {}
          }
        }

        if (!catchingUp && (sent === 1 || sent % 500 === 0)) {
          console.log(`[play] sent ${sent}  t=${(ev.t / 1000).toFixed(1)}s  last=${ev.n} chunks=${chunksSent} players=${playersAdded} ghost=${ghostSpawned}`)
        }

        if (ev.n === 'start_game' && !spectatorReady) {
          forceViewerMode(client, entityUniqueId, viewerMode)
          disableLocatorBar(client)
          if (!catchingUp) unlockInput(client, spawnPos)
          else if (resetCamera) restoreFreecam()
          spectatorReady = true
          try { injectItemRegistryCache() } catch {}
          if (isSanePos(spawnPos)) spawnGhost(spawnPos)
          if (controlHotbar) {
            try { giveControlHotbar(client, { runtimeEntityId: runtimeId, version }) } catch (e) {
              console.warn('[play] hotbar inject failed:', e.message)
            }
            try { hotbarCtl.parkIdle?.() } catch {}
          } else if (!spec?.isPossessing?.()) {
            try { clearSpectatorHotbar(client) } catch {}
          }
        }

        if (ev.n === 'level_chunk' && chunksSent === 5 && spectatorReady) {
          // keep-cam (.restart / seek): never forceViewerMode / unlockInput(spawn) — snaps freecam
          if (!protectFreecam) {
            applyViewerOrPossess()
            disableLocatorBar(client)
          }
          if (!catchingUp && !protectFreecam) {
            unlockInput(client, spawnPos)
            if (!ghostSpawned && isSanePos(spawnPos)) spawnGhost(spawnPos)
            if (controlHotbar) {
              try { giveControlHotbar(client, { runtimeEntityId: runtimeId, version }) } catch {}
              try { hotbarCtl.parkIdle?.() } catch {}
            } else if (!spec?.isPossessing?.()) {
              try { clearSpectatorHotbar(client) } catch {}
            } else {
              try { equipMeHeld() } catch {}
            }
          }
        }
      }

      // Mid-session recordings: no start_game → stuck on «Поиск сервера».
      // In-place .play: client still has the LIVE GamePE world — must hard-reset
      // with start_game or live actors/chunks mix into the recording.
      // Normal PLAY join WITH start_game in file: still must preload chunks —
      // otherwise spawn lands at hub coords while level_chunk only arrives ~15s+ in.
      {
        if (missingStartGame) {
          runtimeId = 1n
          entityUniqueId = -1n
        }

        let sg = null
        // Prefer start_game already in the play queue (after_transfer / file)
        for (let i = startIdx; i < Math.min(queue.length, startIdx + 80); i++) {
          const ev = queue[i]
          if (ev?.type === 'pkt' && ev.n === 'start_game' && ev.p) {
            sg = {
              ...ev.p,
              runtime_entity_id: runtimeId ?? ev.p.runtime_entity_id,
              entity_id: entityUniqueId ?? ev.p.entity_id,
              player_gamemode: viewerMode === 'creative_noclip' ? 'adventure' : 'spectator'
            }
            if (isSanePos(spawnPos)) {
              sg.player_position = { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z }
            }
            // GamePE limited_world_* around hub spawn freezes freecam in the void
            if (sg.limited_world_width != null) sg.limited_world_width = 0
            if (sg.limited_world_length != null) sg.limited_world_length = 0
            console.log('[play] Bootstrap start_game from replay queue')
            break
          }
        }
        if (!sg) {
          const cachedSg = loadCachedStartGame(cfg.replaysDir)
          if (cachedSg) {
            sg = {
              ...cachedSg,
              runtime_entity_id: runtimeId,
              entity_id: entityUniqueId,
              player_gamemode: viewerMode === 'creative_noclip' ? 'adventure' : 'spectator'
            }
            if (isSanePos(spawnPos)) {
              sg.player_position = { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z }
              sg.spawn_position = {
                x: Math.floor(spawnPos.x),
                y: Math.floor(spawnPos.y),
                z: Math.floor(spawnPos.z)
              }
            }
            if (sg.limited_world_width != null) sg.limited_world_width = 0
            if (sg.limited_world_length != null) sg.limited_world_length = 0
            console.log('[play] Using cached _last_start_game.json for bootstrap')
          } else {
            sg = buildSyntheticStartGame({
              spawnPos,
              runtimeId,
              entityUniqueId,
              version,
              viewerMode
            })
            console.log('[play] Using synthetic start_game for bootstrap')
          }
        }

        console.log(`[play] Sending start_game + seed chunks + player_spawn…${inPlace ? ' (in-place wipe)' : ''}`)
        if (!writePkt('start_game', sg)) {
          console.error('[play] FATAL: start_game write failed — client will stick on searching')
        }
        // Palette MUST arrive before ghost equipment / ground items.
        // ALWAYS prefer exact GamePE bytes (file RAW or .bin cache). Never
        // client.write() a JSON-revived registry — that was killing the client
        // within seconds of spawn (auth_input gone, sendReliable -3).
        let registryFromFile = false
        try {
          for (const ev of queue) {
            if (ev.type !== 'pkt' || ev.d !== 'c' || ev.n !== 'item_registry') continue
            if (ev.raw && ev.b != null) {
              const body = ev.b
              const buf = Buffer.isBuffer(body)
                ? body
                : Buffer.from(typeof body === 'string' ? body : '', 'base64')
              if (buf.length) {
                try {
                  const des = client.deserializer?.parsePacketBuffer?.(buf)
                  const states = des?.data?.params?.itemstates
                  if (Array.isArray(states) && states.length) client.updateItemPalette?.(states)
                } catch {}
                // MUST be immediate: write() for chunks/ghost is sync; queued
                // sendBuffer(false) arrives AFTER mob_equipment → client crash.
                if (typeof client.sendBuffer === 'function') client.sendBuffer(buf, true)
                else throw new Error('no sendBuffer')
                registryFromFile = true
                preloadedWorld.add(ev)
                itemRegistryInjected = true
                console.log(`[play] Bootstrap item_registry from replay RAW (${buf.length}B)`)
                break
              }
            }
          }
        } catch (e) {
          console.warn('[play] bootstrap item_registry from file failed', e.message)
        }
        if (!registryFromFile) {
          try { registryFromFile = !!injectItemRegistryCache() } catch {}
        }
        if (!registryFromFile) {
          console.warn('[play] No RAW item_registry available — item packets may crash the client')
        }
        try {
          client.queue('chunk_radius_update', { chunk_radius: 8 })
        } catch (e) {
          console.warn('[play] chunk_radius_update:', e.message)
        }

        if (isSanePos(spawnPos)) {
          try {
            writePkt('network_chunk_publisher_update', {
              coordinates: {
                x: Math.floor(spawnPos.x),
                y: Math.floor(spawnPos.y),
                z: Math.floor(spawnPos.z)
              },
              radius: 96,
              saved_chunks: []
            })
          } catch {}
        }

        // Seed a few chunks so Bedrock can leave status=3 (Initializing)
        const seed = await preloadWorldPackets(queue, writePkt, spawnPos, { maxChunks: 24 })
        preloadedWorld = seed.preloaded
        chunksSent = seed.chunks
        console.log(`[play] Seeded ${seed.chunks} level_chunk before spawn`)

        if (!writePkt('play_status', { status: 'player_spawn' })) {
          console.error('[play] FATAL: player_spawn write failed')
        } else {
          console.log('[play] player_spawn sent — waiting for client spawn…')
        }
        const spawned = await waitClientSpawn(client, 8000)
        console.log(`[play] client status=${client.status} (4=spawned) ok=${spawned}`)

        // Rest of world after client init — keep this SMALL on mobile.
        // Dumping 300+ level_chunk right after spawn floods RakNet → sendReliable -3
        // and the client is already gone while the hub keeps "playing".
        const pre = await preloadWorldPackets(queue, writePkt, spawnPos, {
          skip: preloadedWorld,
          maxChunks: 48
        })
        for (const ev of pre.preloaded) preloadedWorld.add(ev)
        chunksSent += pre.chunks
        worldBootstrapped = true
        console.log(`[play] Preloaded +${pre.chunks} level_chunk (total ${chunksSent}, set ${preloadedWorld.size})`)

        if (isSanePos(spawnPos)) {
          try {
            tick += 1n
            client.write('move_player', buildMovePlayer(runtimeId, spawnPos, tick))
          } catch {}
        }
        forceViewerMode(client, entityUniqueId, viewerMode)
        disableLocatorBar(client)
        unlockInput(client, spawnPos)
        setTimeout(() => {
          try {
            forceViewerMode(client, entityUniqueId, viewerMode)
            unlockInput(client, isSanePos(freecamPos) ? freecamPos : spawnPos)
          } catch {}
        }, 400)
        spectatorReady = true
        // Delay ghost: skin + add_player right on spawn races the client leaving
        // status=3→4 and correlates with instant sendReliable -3 on mobile.
        setTimeout(() => {
          if (clientDead()) return
          if (isSanePos(spawnPos)) spawnGhost(spawnPos)
        }, 1200)
        if (controlHotbar) {
          try { giveControlHotbar(client, { runtimeEntityId: runtimeId, version }) } catch (e) {
            console.warn('[play] hotbar inject failed:', e.message)
          }
          try { hotbarCtl.parkIdle?.() } catch {}
        } else {
          try { clearSpectatorHotbar(client) } catch {}
        }
      }

      transport = new ReplayTransport({
        events: queue,
        seekIndex,
        client,
        plane,
        localRuntimeId: runtimeId,
        say,
        closeForms,
        getTracked: () => ({
          runtimeIds: [...trackedRuntime],
          uniqueIds: [...trackedUnique]
        }),
        onAbsorbStartGame: (ev) => {
          runtimeId = toNumId(ev.p?.runtime_entity_id ?? runtimeId)
          entityUniqueId = ev.p?.entity_id ?? entityUniqueId
          if (transport) transport.localRuntimeId = runtimeId
          // no spawnGhost / no client writes
        },
        onBeforeSeek: ({ resetCamera, liteRestart, silent } = {}) => {
          if (!silent) {
            freecamFrozen = true
            freecamFrozenAt = Date.now()
            clearRestoreCamTimers()
          }
          keepCamThroughResume = !resetCamera
          if (resetCamera && isSanePos(spawnPos)) {
            seekCamLock = { ...spawnPos, pitch: 0, yaw: 0, head_yaw: 0 }
            freecamPos = { ...seekCamLock }
          } else if (isSanePos(freecamPos)) {
            seekCamLock = { ...freecamPos }
          } else {
            seekCamLock = null
          }
          console.log(`[play] seek keepCam=${!resetCamera} resetCamera=${!!resetCamera} lite=${!!liteRestart} silent=${!!silent}`)

          if (silent || liteRestart) {
            // Soft state only — keep ghost + chunks + current freecam/spectate.
            // Do NOT clearFollowOnly (unhide packets) and do NOT wipe entities.
            playersAdded = 0
            return
          }

          ghostSpawned = false
          ghostTick = 0n
          playersAdded = 0
          chunksSent = 0
          spectatorReady = false
          trackedUnique.clear()
          trackedRuntime.clear()
          armorByRid.clear()
          heldByRid.clear()
          offhandByRid.clear()
          skinsByUuid.clear()
          skinsByName.clear()
          uuidByRid.clear()
          addPlayerByRid.clear()
          erasedPossessRid = null
          try { preloadSkinsFromQueue(queue) } catch {}
          try { spec.clearFollowOnly() } catch {}
          try { spec.entities.clear(); spec._rebuildCycle?.() } catch {}
        },
        onAfterSeek: ({ resetCamera, liteRestart, silent } = {}) => {
          // Seek may land the timeline in a different area — refresh terrain
          // around wherever the camera is (client dropped out-of-radius chunks)
          if (isSanePos(freecamPos)) {
            publishChunksAround(freecamPos)
            resendChunksNear(freecamPos)
          }
          if (resetCamera && isSanePos(spawnPos)) {
            seekCamLock = { ...spawnPos, pitch: 0, yaw: 0, head_yaw: 0 }
            keepCamThroughResume = false
            freecamPos = { ...seekCamLock }
            forceViewerMode(client, entityUniqueId, viewerMode)
            disableLocatorBar(client)
            pulseRestoreFreecam()
          } else if (!silent) {
            freecamFrozen = false
            freecamFrozenAt = 0
            clearRestoreCamTimers()
            console.log(`[play] afterSeek keep-cam lite=${!!liteRestart}`)
          } else {
            console.log('[play] afterSeek silent lite restart — camera untouched')
          }
          if (!liteRestart && !silent) {
            if (controlHotbar) {
              try { giveControlHotbar(client, { runtimeEntityId: runtimeId, version }) } catch {}
              try { hotbarCtl.parkIdle?.() } catch {}
            } else {
              try { clearSpectatorHotbar(client) } catch {}
            }
          }
        },
        onEvent: handleEvent
      })
      plane.bindTransport(transport)
      activeTransport = transport

      let result = { aborted: false }
      try {
        result = await transport.run()
      } catch (e) {
        console.error('[play] transport error', e)
        result = { aborted: true }
      } finally {
        try { detachSessionListeners() } catch {}
        playing = false
        if (activeClient === client) activeClient = null
        activeTransport = null
        try {
          plane.setStatus('idle')
          plane.paused = false
          plane.seeking = false
        } catch {}
        try { payloadSpill?.close() } catch {}
        payloadSpill = null
      }

      if (result.aborted) {
        if (switchingToLive) {
          console.log('[play] Playback stopped (.live) — client stays on LIVE socket')
        } else if (client.status === 0) {
          console.log('[play] Client disconnected during playback')
        } else {
          console.log('[play] Playback aborted (client still connected)')
        }
      } else {
        console.log(`[play] Finished. packets=${sent} chunks=${chunksSent} players=${playersAdded} ui_skipped=${skippedUi}`)
        try {
          forceViewerMode(client, entityUniqueId, viewerMode)
          say('§e[Replay] Конец · §f.live §7= выход из просмотра')
        } catch {}
      }
  }

  server.on('connect', (client) => {
    if (client.options) client.options.batchingInterval = 5
    console.log(`[play] Client connected ${client.connection?.address}`)

    client.on('join', () => { beginReplaySession(client) })

    const clearPlayClient = (why) => {
      console.log(`[play] Client left (${why})`)
      playing = false
      try { activeTransport?.abort() } catch {}
      if (activeClient === client) activeClient = null
      activeTransport = null
      try {
        plane.setStatus('idle')
        plane.paused = false
        plane.seeking = false
      } catch {}
    }

    client.on('close', () => clearPlayClient('close'))
    client.on('error', () => clearPlayClient('error'))
  })

  server.on('error', (err) => console.error('[play] error', err))

  const shutdown = () => {
    console.log('\n[play] Shutting down…')
    closePlay({ exitProcess: true })
  }
  if (ownSignals) {
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }

  return {
    server,
    plane,
    controlServer,
    shutdown,
    close: closePlay,
    version,
    viewerMode,
    get hasClient () {
      return !!(activeClient && activeClient.status !== 0 && activeClient.status !== 'disconnected')
    },
    get overlayPlay () {
      return !!(playing && activeClient && activeClient.status !== 0 && activeClient.status !== 'disconnected')
    },
    getActiveFile: () => activeFilePath,
    setActiveFile (raw) {
      return applyActiveFile(raw)
    },
    snapFreecamHome () {
      try {
        return !!sessionSnapFreecamHome?.()
      } catch {
        return false
      }
    },
    /**
     * Abort current playback without disconnecting the client.
     * @param {{ reason?: 'live'|'replace'|string }} [opts]
     */
    abortActive (opts = {}) {
      if (opts.reason === 'live') switchingToLive = true
      try { activeTransport?.abort() } catch {}
    },
    /**
     * Start replay on an already-joined client (LIVE hub .play — no port transfer).
     * @param {object} client
     * @param {{ inPlace?: boolean, onRequestLive?: Function }} [sessionOpts]
     */
    attachClient (client, sessionOpts = {}) {
      if (client?.options) client.options.batchingInterval = 5
      return beginReplaySession(client, { inPlace: true, ...sessionOpts })
    }
  }
}
