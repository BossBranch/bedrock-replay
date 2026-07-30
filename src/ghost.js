/**
 * Visible "you" ghost — smooth move_entity path + reliable skin.
 */

import { randomUUID } from 'crypto'
import mcData from 'minecraft-data'
import { sanitize, revive } from './format.js'

/** Fits in 32-bit ids where needed */
export const GHOST_RUNTIME_ID = 100000001
export const GHOST_UNIQUE_ID = 100000001n

function clone (o) {
  return revive(sanitize(o))
}

function emptyItem () {
  return { network_id: 0 }
}

function asArmorRid (runtimeId) {
  if (typeof runtimeId === 'bigint') return runtimeId
  const n = Number(runtimeId)
  if (!Number.isFinite(n)) return null
  return BigInt(Math.trunc(n))
}

/**
 * Clear armor via client.write with empty items — the PROVEN-SAFE family
 * (clearGhostHands does the same for mob_equipment on every session).
 * The old RAW path concatenated EMPTY_ITEM_V4 (19-byte GamePE-era blob), but a
 * vanilla client parses an empty item as a single 0x00 byte — the remaining
 * ~90 bytes were trailing garbage and the client disconnected instantly.
 * That was THE .me/.spec kick. Empty items don't re-encode anything real.
 */
function sendEmptyArmorRaw (client, runtimeId) {
  const rid = asArmorRid(runtimeId)
  if (rid == null) return
  client.write('mob_armor_equipment', {
    runtime_entity_id: rid,
    helmet: emptyItem(),
    chestplate: emptyItem(),
    leggings: emptyItem(),
    boots: emptyItem(),
    body: emptyItem()
  })
}

/** Strip every armor piece (possess FPV — chestplate/helmet must not clip the lens). */
export function withAllArmorCleared (armorParams) {
  return {
    ...(armorParams || {}),
    helmet: emptyItem(),
    chestplate: emptyItem(),
    leggings: emptyItem(),
    boots: emptyItem(),
    body: emptyItem()
  }
}

export function writeArmorEquipment (client, runtimeId, armor, { clearHelmet = false, clearAll = false } = {}) {
  if (!client || runtimeId == null) return
  const src = armor || {}
  // Avoid sending empty stubs with no prior armor — bad Item payloads can disconnect the client
  const hasAny = !!(src.helmet || src.chestplate || src.leggings || src.boots || src.body)
  if (!hasAny && !clearHelmet && !clearAll) return
  if (!hasAny && (clearHelmet || clearAll)) {
    // Still push empties when forcibly clearing a known equipped player
    if (!clearAll) return
  }
  try {
    const rid = asArmorRid(runtimeId)
    if (rid == null) return
    // Never re-encode Item via client.write for clears — SizeOf / kick on 1.26.
    if (clearAll || (!hasAny && clearHelmet)) {
      sendEmptyArmorRaw(client, rid)
      return
    }
    // Applying remembered armor: also unsafe to re-encode on 1.26.
    // Prefer leave entity without client.write restore (RAW path owns ghost armor).
    if (hasAny) {
      console.warn('[ghost] skip armor re-encode (use RAW path)')
      return
    }
  } catch (e) {
    console.warn('[ghost] armor write failed:', e.message)
  }
}

function baseAbilities () {
  const flags = {
    build: false, mine: false, doors_and_switches: false, open_containers: false,
    attack_players: false, attack_mobs: false, operator_commands: false, teleport: false,
    invulnerable: true, flying: false, may_fly: false, instant_build: false, lightning: false,
    fly_speed: true, walk_speed: true, muted: false, world_builder: false, no_clip: false,
    privileged_builder: false, vertical_fly_speed: true
  }
  return [{
    type: 'base',
    allowed: flags,
    enabled: { walk_speed: true, fly_speed: true, invulnerable: true, vertical_fly_speed: true },
    fly_speed: 0.05,
    vertical_fly_speed: 1,
    walk_speed: 0.1
  }]
}

function imgFromB64 (b64, hintW, hintH) {
  if (!b64 || typeof b64 !== 'string' || b64.length < 8) {
    return { width: 0, height: 0, data: Buffer.alloc(0) }
  }
  const data = Buffer.from(b64, 'base64')
  let width = hintW || 64
  let height = hintH || 64
  if (data.length === 64 * 32 * 4) { width = 64; height = 32 }
  else if (data.length === 128 * 128 * 4) { width = 128; height = 128 }
  else if (data.length === 64 * 64 * 4) { width = 64; height = 64 }
  else if (hintW && hintH) { width = hintW; height = hintH }
  return { width, height, data }
}

function mapPersonaPieces (pieces) {
  if (!Array.isArray(pieces)) return []
  return pieces.map((p) => ({
    piece_id: p.PieceId || p.piece_id || '',
    piece_type: p.PieceType || p.piece_type || '',
    pack_id: p.PackId || p.pack_id || '',
    is_default_piece: !!(p.IsDefault ?? p.is_default_piece),
    product_id: p.ProductId || p.product_id || ''
  }))
}

function mapPieceTints (tints) {
  if (!Array.isArray(tints)) return []
  return tints.map((t) => ({
    piece_type: t.PieceType || t.piece_type || '',
    colors: t.Colors || t.colors || []
  }))
}

/** Always-valid Steve skin from minecraft-data (guarantees a visible model). */
export function defaultProtocolSkin (version = '1.21.100') {
  try {
    const d = mcData('bedrock_' + version)
    if (d?.defaultSkin) {
      const s = skinFromLogin(d.defaultSkin)
      if (s) return normalizeSkin(s)
    }
  } catch {}
  return normalizeSkin({
    skin_id: 'Steve',
    play_fab_id: '',
    skin_resource_pack: '{"geometry":{"default":"geometry.humanoid.custom"}}',
    skin_data: { width: 64, height: 64, data: Buffer.alloc(64 * 64 * 4, 200) },
    animations: [],
    cape_data: { width: 0, height: 0, data: Buffer.alloc(0) },
    geometry_data: '',
    geometry_data_version: '',
    animation_data: '',
    cape_id: '',
    full_skin_id: 'Steve',
    arm_size: 'wide',
    skin_color: '#0',
    personal_pieces: [],
    piece_tint_colors: [],
    premium: false,
    persona: false,
    cape_on_classic: false,
    primary_user: true,
    overriding_player_appearance: true
  })
}

/**
 * Convert client login JWT skin (PascalCase) → protocol Skin.
 */
export function skinFromLogin (skinData) {
  if (!skinData || typeof skinData !== 'object') return null
  try {
    const w = skinData.SkinImageWidth || skinData.skinImageWidth
    const h = skinData.SkinImageHeight || skinData.skinImageHeight
    const skinImage = imgFromB64(skinData.SkinData, w, h)
    const persona = mapPersonaPieces(skinData.PersonaPieces)
    const hasBitmap = skinImage.data.length > 0
    const hasPersona = persona.length > 0
    if (!hasBitmap && !hasPersona) return null

    let patch = skinData.SkinResourcePatch
    if (typeof patch !== 'string' || !patch.length) {
      patch = '{"geometry":{"default":"geometry.humanoid.custom"}}'
    }

    return {
      skin_id: skinData.SkinId || 'ghost_skin',
      play_fab_id: skinData.PlayFabId || '',
      skin_resource_pack: patch,
      skin_data: hasBitmap ? skinImage : { width: 64, height: 64, data: Buffer.alloc(64 * 64 * 4, 180) },
      animations: Array.isArray(skinData.AnimatedImageData)
        ? skinData.AnimatedImageData.map((a) => ({
          skin_image: imgFromB64(a.Image),
          animation_type: a.Type ?? a.AnimationType ?? 0,
          animation_frames: a.Frames ?? 0,
          expression_type: a.AnimationExpression ?? 0
        }))
        : [],
      cape_data: imgFromB64(skinData.CapeData || '', skinData.CapeImageWidth, skinData.CapeImageHeight),
      geometry_data: skinData.SkinGeometryData || '',
      geometry_data_version: skinData.SkinGeometryDataEngineVersion || '',
      animation_data: skinData.SkinAnimationData || '',
      cape_id: skinData.CapeId || '',
      full_skin_id: skinData.SkinId || 'ghost_skin',
      arm_size: skinData.ArmSize || 'wide',
      skin_color: skinData.SkinColor || '#0',
      personal_pieces: persona,
      piece_tint_colors: mapPieceTints(skinData.PieceTintColors),
      premium: !!skinData.PremiumSkin,
      persona: !!skinData.PersonaSkin || hasPersona,
      cape_on_classic: !!skinData.CapeOnClassicSkin,
      primary_user: true,
      overriding_player_appearance: true
    }
  } catch (e) {
    console.warn('[ghost] skinFromLogin failed', e.message)
    return null
  }
}

/**
 * Build best skin for ghost.
 * Priority (as requested): recorded self from the replay file → login → Steve.
 */
export function resolveGhostSkin ({ recordedSelf, client, version }) {
  if (recordedSelf?.skin) {
    const skin = normalizeSkin(clone(recordedSelf.skin))
    if (skin) return { skin, source: 'recorded' }
  }
  const login = skinFromLogin(client?.skinData)
  if (login) {
    const bitmap = login.skin_data?.data?.length || 0
    const persona = login.personal_pieces?.length || 0
    if (bitmap > 1000 || persona > 0) {
      return { skin: normalizeSkin(login), source: 'login' }
    }
  }
  return { skin: normalizeSkin(defaultProtocolSkin(version)), source: 'steve_fallback' }
}

/** Ensure every Skin field the codec needs is present (no undefined). */
function cleanGeometryData (raw) {
  if (raw == null) return ''
  const s = String(raw).trim()
  if (!s || s === 'null' || s === 'undefined' || s === '{}') return ''
  return String(raw)
}

export function normalizeSkin (skin) {
  if (!skin || typeof skin !== 'object') return null
  const geom = cleanGeometryData(skin.geometry_data)
  const pack = skin.skin_resource_pack || '{"geometry":{"default":"geometry.humanoid.custom"}}'
  const out = {
    skin_id: skin.skin_id || 'ghost',
    play_fab_id: skin.play_fab_id || '',
    skin_resource_pack: pack,
    skin_data: {
      width: skin.skin_data?.width || 64,
      height: skin.skin_data?.height || 64,
      data: (() => {
        const d = skin.skin_data?.data
        if (Buffer.isBuffer(d)) return d
        if (d?.type === 'Buffer' && Array.isArray(d.data)) return Buffer.from(d.data)
        if (d?.$bytes) return Buffer.from(d.$bytes)
        if (Array.isArray(d)) return Buffer.from(d)
        return Buffer.alloc((skin.skin_data?.width || 64) * (skin.skin_data?.height || 64) * 4, 180)
      })()
    },
    animations: Array.isArray(skin.animations)
      ? skin.animations.map((a) => ({
        skin_image: {
          width: a.skin_image?.width || 0,
          height: a.skin_image?.height || 0,
          data: Buffer.isBuffer(a.skin_image?.data) ? a.skin_image.data : Buffer.alloc(0)
        },
        animation_type: a.animation_type ?? 0,
        animation_frames: a.animation_frames ?? 0,
        expression_type: a.expression_type ?? 0
      }))
      : [],
    cape_data: {
      width: skin.cape_data?.width || 0,
      height: skin.cape_data?.height || 0,
      data: Buffer.isBuffer(skin.cape_data?.data) ? skin.cape_data.data : Buffer.alloc(0)
    },
    // GamePE often stores the literal "null\n" — client rejects that on local player_skin
    geometry_data: geom,
    geometry_data_version: cleanGeometryData(skin.geometry_data_version) === ''
      ? (geom ? '1.12.0' : '')
      : String(skin.geometry_data_version || ''),
    animation_data: skin.animation_data || '',
    cape_id: skin.cape_id || '',
    full_skin_id: skin.full_skin_id || skin.skin_id || 'ghost',
    arm_size: skin.arm_size || 'wide',
    skin_color: skin.skin_color || '#0',
    personal_pieces: Array.isArray(skin.personal_pieces)
      ? skin.personal_pieces.map((p) => ({
        piece_id: p.piece_id || '',
        piece_type: p.piece_type || '',
        pack_id: p.pack_id || '',
        is_default_piece: !!p.is_default_piece,
        product_id: p.product_id || ''
      }))
      : [],
    piece_tint_colors: Array.isArray(skin.piece_tint_colors)
      ? skin.piece_tint_colors.map((t) => ({
        piece_type: t.piece_type || '',
        colors: Array.isArray(t.colors) ? t.colors.map(String) : []
      }))
      : [],
    premium: !!skin.premium,
    persona: !!skin.persona,
    cape_on_classic: !!skin.cape_on_classic,
    primary_user: true,
    overriding_player_appearance: true
  }
  return out
}

export function buildSelfRecord (player) {
  const name = player?.profile?.name || player?.username || 'You'
  const uuid = player?.profile?.uuid || randomUUID()
  const xuid = String(player?.profile?.xuid || '0')
  const skin = skinFromLogin(player?.skinData)
  return { name, uuid, xuid, skin: skin ? sanitize(skin) : null }
}

export function loadSelfFromEvents (events) {
  for (const e of events) {
    if (e.type === 'self' && e.name) {
      return {
        name: e.name,
        uuid: e.uuid || randomUUID(),
        xuid: e.xuid || '0',
        skin: e.skin || null
      }
    }
  }
  return null
}

export function findAddPlayerTemplate (events, fromIndex = 0) {
  for (let i = fromIndex; i < events.length; i++) {
    const e = events[i]
    if (e.type === 'pkt' && e.n === 'add_player' && e.p) return clone(e.p)
  }
  return null
}

function ghostMetadata (username, templateMeta) {
  const flags = templateMeta?.find?.((m) => m.key === 'flags')
  const meta = []
  if (flags) {
    const f = clone(flags)
    if (f.value && typeof f.value === 'object') {
      f.value.can_show_nametag = true
      f.value.always_show_nametag = true
      f.value.invisible = false
    }
    meta.push(f)
  } else {
    meta.push({
      key: 'flags',
      type: 'long',
      value: {
        can_show_nametag: true,
        always_show_nametag: true,
        has_collision: true,
        affected_by_gravity: true,
        breathing: true,
        can_climb: true,
        invisible: false
      }
    })
  }
  meta.push({ key: 'nametag', type: 'string', value: username })
  meta.push({ key: 'always_show_nametag', type: 'byte', value: 1 })
  meta.push({ key: 'boundingbox_width', type: 'float', value: 0.6 })
  meta.push({ key: 'boundingbox_height', type: 'float', value: 1.8 })
  return meta
}

export function buildGhostPackets (opts) {
  const { client, position, addTemplate, recordedSelf, version } = opts
  const username =
    recordedSelf?.name ||
    client?.profile?.name ||
    client?.username ||
    'You'

  const uuid = randomUUID()
  const pos = position || { x: 0, y: 80, z: 0 }
  const { skin, source: skinSource } = resolveGhostSkin({ recordedSelf, client, version })

  const playerList = {
    records: {
      type: 'add',
      records_count: 1,
      records: [{
        uuid,
        entity_unique_id: GHOST_UNIQUE_ID,
        username,
        xbox_user_id: String(recordedSelf?.xuid || client?.profile?.xuid || '0'),
        platform_chat_id: '',
        build_platform: 7,
        skin_data: skin,
        is_teacher: false,
        is_host: false,
        is_subclient: false,
        player_color: -1
      }],
      // REQUIRED on 1.21+ — without this SizeOf crashes on undefined.length
      verified: [true]
    }
  }

  const addPlayer = {
    uuid,
    username,
    runtime_id: BigInt(GHOST_RUNTIME_ID),
    platform_chat_id: '',
    position: { x: pos.x, y: pos.y, z: pos.z },
    velocity: { x: 0, y: 0, z: 0 },
    pitch: 0,
    yaw: 0,
    head_yaw: 0,
    held_item: emptyItem(),
    gamemode: 'survival',
    metadata: ghostMetadata(username, addTemplate?.metadata),
    properties: { ints: [], floats: [] },
    unique_id: GHOST_UNIQUE_ID,
    permission_level: 'member',
    command_permission: 'normal',
    abilities: baseAbilities(),
    links: [],
    device_id: '',
    device_os: 'Win10'
  }

  const playerSkin = {
    uuid,
    skin,
    skin_name: username,
    old_skin_name: '',
    is_verified: true
  }

  return { playerList, addPlayer, playerSkin, username, uuid, skinSource }
}

/**
 * Smooth ghost motion with CORRECT head look.
 *
 * Do NOT use move_entity byterot with signed pitch/yaw:
 * writeUint8(-45) wraps to 211 → looks like nonsense rotation
 * (user only saw "looking down" because positive pitch survived).
 *
 * move_player uses float degrees — same as player_auth_input recording.
 */
export function ghostMovePackets (cam, tick = 0n) {
  const pitch = Number(cam.pitch) || 0
  const yaw = Number(cam.yaw) || 0
  const head = Number(cam.head_yaw ?? cam.yaw) || 0

  return [{
    name: 'move_player',
    params: {
      runtime_id: GHOST_RUNTIME_ID,
      position: { x: cam.x, y: cam.y, z: cam.z },
      pitch,
      yaw,
      head_yaw: head,
      // normal = interpolate on client (not teleport snaps)
      mode: 'normal',
      on_ground: true,
      ridden_runtime_id: 0,
      tick
    }
  }]
}

/** Build flags metadata to show/hide an entity body (FPV possess). */
export function visibilityMetadata (visible) {
  return [
    {
      key: 'flags',
      type: 'long',
      value: {
        can_show_nametag: !!visible,
        always_show_nametag: !!visible,
        has_collision: true,
        affected_by_gravity: true,
        breathing: true,
        can_climb: true,
        invisible: !visible
      }
    },
    { key: 'always_show_nametag', type: 'byte', value: visible ? 1 : 0 }
  ]
}

/** Force invisible + no nametag onto an existing set_entity_data params (copy). */
export function forceEntityInvisibleParams (params) {
  if (!params) return params
  const meta = Array.isArray(params.metadata) ? params.metadata.map((m) => {
    if (!m || m.key !== 'flags') return m
    const value = (m.value && typeof m.value === 'object')
      ? { ...m.value, invisible: true, can_show_nametag: false, always_show_nametag: false }
      : {
          invisible: true,
          can_show_nametag: false,
          always_show_nametag: false,
          has_collision: true,
          affected_by_gravity: true,
          breathing: true,
          can_climb: true
        }
    return { ...m, value }
  }) : []
  const hasFlags = meta.some((m) => m?.key === 'flags')
  if (!hasFlags) meta.push(...visibilityMetadata(false))
  else {
    const hasTag = meta.some((m) => m?.key === 'always_show_nametag')
    if (!hasTag) meta.push({ key: 'always_show_nametag', type: 'byte', value: 0 })
  }
  return { ...params, metadata: meta }
}

/** Hide/show any player entity by runtime id (spectate FPV). */
export function setEntityVisible (client, runtimeId, visible) {
  if (!client || runtimeId == null) return
  try {
    const rid = typeof runtimeId === 'bigint' ? runtimeId : BigInt(runtimeId)
    client.write('set_entity_data', {
      runtime_entity_id: rid,
      metadata: visibilityMetadata(visible),
      properties: { ints: [], floats: [] },
      tick: 0n
    })
  } catch {}
}

/** Force other players' nametags on/off (config showPlayerNames). */
export function nametagMetadata (username, show) {
  if (!show) {
    return [
      {
        key: 'flags',
        type: 'long',
        value: {
          can_show_nametag: false,
          always_show_nametag: false,
          has_collision: true,
          affected_by_gravity: true,
          breathing: true,
          can_climb: true
        }
      },
      { key: 'always_show_nametag', type: 'byte', value: 0 }
    ]
  }
  const meta = [
    {
      key: 'flags',
      type: 'long',
      value: {
        can_show_nametag: true,
        always_show_nametag: true,
        has_collision: true,
        affected_by_gravity: true,
        breathing: true,
        can_climb: true
      }
    },
    { key: 'always_show_nametag', type: 'byte', value: 1 }
  ]
  if (username) meta.push({ key: 'nametag', type: 'string', value: String(username) })
  return meta
}

export function setPlayerNametag (client, runtimeId, username, show) {
  if (!client || runtimeId == null) return
  try {
    const rid = typeof runtimeId === 'bigint' ? runtimeId : BigInt(runtimeId)
    client.write('set_entity_data', {
      runtime_entity_id: rid,
      metadata: nametagMetadata(username, show),
      properties: { ints: [], floats: [] },
      tick: 0n
    })
  } catch {}
}

/** Hide/show ghost body for first-person possess (.me) — like real FPV, no head mesh. */
export function setGhostVisible (client, visible) {
  setEntityVisible(client, GHOST_RUNTIME_ID, visible)
}

function lerp (a, b, u) {
  return a + (b - a) * u
}

/** Shortest-path lerp for yaw/head_yaw (degrees, any range). */
function lerpYaw (a, b, u) {
  let d = ((b - a + 540) % 360) - 180
  return a + d * u
}

function isSaneCamPos (p) {
  if (!p) return false
  const { x, y, z } = p
  if (![x, y, z].every((n) => typeof n === 'number' && Number.isFinite(n))) return false
  return Math.abs(x) + Math.abs(y) + Math.abs(z) > 8
}

/**
 * Densify cam samples. Pitch uses linear lerp (signed -90..90).
 * Yaw uses shortest-path lerp. Skips void 0,0,0 samples so we don't
 * invent a fake gap while the player was loading.
 */
export function densifyCamEvents (events, stepMs = 50) {
  const cams = events.filter((e) => e.type === 'cam' && isSaneCamPos(e.p))
  if (cams.length < 2) {
    // still drop insane cams from the timeline
    const rest = events.filter((e) => e.type !== 'cam' || isSaneCamPos(e.p))
    return rest.sort((a, b) => a.t - b.t)
  }

  const dense = []
  for (let i = 0; i < cams.length - 1; i++) {
    const a = cams[i]
    const b = cams[i + 1]
    dense.push(a)
    const dt = b.t - a.t
    // Fill down to ~stepMs (16 → ~60 Hz). Skip only if already denser.
    if (dt <= stepMs) continue
    // Teleport gap — do NOT glide through it. Interpolating a warp paints a
    // fake 200+ m/step slide and re-triggers freecam-follow on every step.
    {
      const dx = b.p.x - a.p.x
      const dy = b.p.y - a.p.y
      const dz = b.p.z - a.p.z
      if (dx * dx + dy * dy + dz * dz > 24 * 24) continue
    }
    const n = Math.min(120, Math.max(1, Math.floor(dt / stepMs)))
    for (let k = 1; k < n; k++) {
      const u = k / n
      dense.push({
        type: 'cam',
        t: a.t + dt * u,
        p: {
          x: lerp(a.p.x, b.p.x, u),
          y: lerp(a.p.y, b.p.y, u),
          z: lerp(a.p.z, b.p.z, u),
          // pitch is signed — NEVER use yaw-style wrap
          pitch: lerp(a.p.pitch ?? 0, b.p.pitch ?? 0, u),
          yaw: lerpYaw(a.p.yaw ?? 0, b.p.yaw ?? 0, u),
          head_yaw: lerpYaw(a.p.head_yaw ?? a.p.yaw ?? 0, b.p.head_yaw ?? b.p.yaw ?? 0, u)
        },
        _interp: true
      })
    }
  }
  dense.push(cams[cams.length - 1])

  const rest = events.filter((e) => e.type !== 'cam')
  return [...rest, ...dense].sort((a, b) => a.t - b.t)
}
