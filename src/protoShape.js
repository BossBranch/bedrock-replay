/**
 * Version-dependent packet shapes for packets the hub BUILDS itself.
 *
 * Bedrock 1.26.40 reworked several structures the hub writes:
 *   - player_list: no packet-wide action/verified array; every record carries
 *     `type` (varint, 1=add 0=remove) plus `legacy_type` (u8, 0=add 1=remove)
 *   - entity metadata entries repeat the value type as a `legacy_type` byte
 *   - Skin: numeric arm size / colour / persona piece types, int tint colours,
 *     uuid pack ids, new `trusted` + `profile_hash` strings
 *
 * Builders across the code (ghost, viewer, seek reset, LIVE wipe) still speak
 * the pre-1.26.40 shape. Instead of forking each of them, `installOutgoingAdapter`
 * rewrites those few packets on the way out. The adapter is idempotent: packets
 * already in the active shape (recorded ones) pass through untouched.
 *
 * The active shape is read from minecraft-data for the hub runtime version, not
 * inferred from version numbers.
 */
import mcData from 'minecraft-data'

const shape = {
  version: null,
  listPerRecord: false,
  metaLegacyType: false,
  skinV2: false
}

/** @returns {typeof shape} */
export function configureProtocolShapes (version) {
  shape.version = version
  try {
    const types = mcData('bedrock_' + version)?.protocol?.types || {}
    shape.listPerRecord = !!types.PlayerRecord
    shape.metaLegacyType = JSON.stringify(types.MetadataDictionary || '').includes('"legacy_type"')
    const skin = types.Skin
    shape.skinV2 = Array.isArray(skin) && skin[0] === 'container' &&
      skin[1].some((f) => f?.name === 'profile_hash')
  } catch {}
  return { ...shape }
}

export function protocolShapes () {
  return { ...shape }
}

const META_TYPE_ORDINAL = {
  byte: 0, short: 1, int: 2, float: 3, string: 4, compound: 5, vec3i: 6, long: 7, vec3f: 8
}

/** Add `legacy_type` to metadata entries (1.26.40+) when a builder omitted it. */
export function fixMetadataList (list) {
  if (!shape.metaLegacyType || !Array.isArray(list)) return list
  let changed = false
  const out = list.map((e) => {
    if (!e || typeof e !== 'object' || e.legacy_type != null) return e
    const ord = typeof e.type === 'number' ? e.type : META_TYPE_ORDINAL[e.type]
    if (ord == null) return e
    changed = true
    return { ...e, legacy_type: ord }
  })
  return changed ? out : list
}

const PERSONA_PIECE_TYPES = new Set([
  'unknown', 'skeleton', 'body', 'skin', 'bottom', 'feet', 'dress', 'top', 'high_pants',
  'hands', 'outerwear', 'facial_hair', 'mouth', 'eyes', 'hair', 'hood', 'back',
  'face_accessory', 'head', 'legs', 'left_leg', 'right_leg', 'arms', 'left_arm',
  'right_arm', 'capes', 'classic_skin', 'emote', 'unsupported'
])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

/** '#AARRGGBB' / '#RRGGBB' / number → signed int32 (0 when unparsable) */
function colorToInt (c) {
  if (typeof c === 'number' && Number.isFinite(c)) return c | 0
  const hex = String(c ?? '').trim().replace(/^#/, '').replace(/^0x/i, '')
  if (!/^[0-9a-f]{1,8}$/i.test(hex)) return 0
  return parseInt(hex, 16) | 0
}

function pieceType (t) {
  if (typeof t === 'number') return t
  const s = String(t ?? '').toLowerCase().replace(/^persona_/, '')
  return PERSONA_PIECE_TYPES.has(s) ? s : 'unknown'
}

/** Coerce a (pre-1.26.40 shaped) Skin into the active codec's field types. */
export function adaptSkin (skin) {
  if (!shape.skinV2 || !skin || typeof skin !== 'object') return skin
  const arm = skin.arm_size === 0 || skin.arm_size === 'slim' ? 'slim' : 'wide'
  return {
    ...skin,
    arm_size: arm,
    skin_color: colorToInt(skin.skin_color),
    animations: Array.isArray(skin.animations)
      ? skin.animations.map((a) => ({
        ...a,
        animation_type: Number(a?.animation_type) || 0,
        animation_frames: Number(a?.animation_frames) || 0,
        expression_type: Number(a?.expression_type) || 0
      }))
      : [],
    personal_pieces: Array.isArray(skin.personal_pieces)
      ? skin.personal_pieces.map((p) => ({
        piece_id: String(p?.piece_id ?? ''),
        piece_type: pieceType(p?.piece_type),
        pack_id: UUID_RE.test(String(p?.pack_id ?? '')) ? String(p.pack_id) : ZERO_UUID,
        is_default_piece: !!p?.is_default_piece,
        product_id: String(p?.product_id ?? '')
      }))
      : [],
    piece_tint_colors: Array.isArray(skin.piece_tint_colors)
      ? skin.piece_tint_colors.map((t) => {
        const colors = (Array.isArray(t?.colors) ? t.colors : []).slice(0, 4).map(colorToInt)
        while (colors.length < 4) colors.push(0)
        return { piece_type: String(t?.piece_type ?? ''), colors }
      })
      : [],
    trusted: typeof skin.trusted === 'string' ? skin.trusted : String(skin.trusted ?? true),
    profile_hash: typeof skin.profile_hash === 'string' ? skin.profile_hash : ''
  }
}

function isAdd (t) {
  return t === 'add' || t === 0 || t === '0' || t === undefined
}

/**
 * Read player_list params of either shape.
 * @returns {{ type: 'add'|'remove', records: object[], perRecord: boolean }}
 */
export function readPlayerList (params) {
  const r = params?.records
  if (Array.isArray(r)) {
    const type = r.length && r[0]?.type === 'remove' ? 'remove' : 'add'
    return { type, records: r, perRecord: true }
  }
  const block = r && typeof r === 'object' && (r.records != null || r.type != null) ? r : params
  const recs = Array.isArray(block?.records) ? block.records : []
  return { type: isAdd(block?.type) ? 'add' : 'remove', records: recs, perRecord: false }
}

/** Build player_list params in the ACTIVE shape. */
export function makePlayerList (type, records) {
  const add = type === 'add'
  const recs = (records || []).filter(Boolean)
  if (shape.listPerRecord) {
    return {
      records: recs.map((rec) => {
        const out = { ...rec, type: add ? 'add' : 'remove', legacy_type: add ? 0 : 1 }
        if (add && out.skin_data) out.skin_data = adaptSkin(out.skin_data)
        return out
      })
    }
  }
  return {
    records: {
      type: add ? 'add' : 'remove',
      records_count: recs.length,
      records: recs.map((rec) => {
        const { type: _t, legacy_type: _l, ...rest } = rec
        return rest
      }),
      ...(add ? { verified: recs.map(() => true) } : {})
    }
  }
}

/** Rewrite one outgoing packet into the active shape (no-op when already fine). */
export function adaptOutgoing (name, params) {
  if (!params || typeof params !== 'object') return params
  switch (name) {
    case 'player_list': {
      const { type, records, perRecord } = readPlayerList(params)
      if (perRecord === shape.listPerRecord && !shape.listPerRecord) return params
      if (perRecord && shape.listPerRecord) {
        // Recorded / already new-shape: only fill gaps (legacy byte, skin fields)
        let changed = false
        const recs = records.map((rec) => {
          if (!rec || typeof rec !== 'object') return rec
          const add = rec.type !== 'remove'
          const needLegacy = rec.legacy_type == null
          const skin = add && rec.skin_data ? adaptSkin(rec.skin_data) : rec.skin_data
          if (!needLegacy && skin === rec.skin_data) return rec
          changed = true
          return { ...rec, ...(needLegacy ? { legacy_type: add ? 0 : 1 } : {}), skin_data: skin }
        })
        return changed ? { ...params, records: recs } : params
      }
      return makePlayerList(type, records)
    }
    case 'player_skin':
      return params.skin ? { ...params, skin: adaptSkin(params.skin) } : params
    case 'set_entity_data':
    case 'add_player':
    case 'add_entity':
    case 'add_item_entity': {
      const fixed = fixMetadataList(params.metadata)
      return fixed === params.metadata ? params : { ...params, metadata: fixed }
    }
    default:
      return params
  }
}

const ADAPT_NAMES = new Set(['player_list', 'player_skin', 'set_entity_data', 'add_player', 'add_entity', 'add_item_entity'])

/**
 * Wrap client.write / client.queue once so every hub-built packet leaves in
 * the active shape. RAW sendBuffer paths are untouched.
 */
export function installOutgoingAdapter (client) {
  if (!client || client._bsrShapeAdapter) return
  if (!shape.listPerRecord && !shape.metaLegacyType && !shape.skinV2) {
    client._bsrShapeAdapter = true
    return
  }
  for (const method of ['write', 'queue']) {
    const orig = client[method]
    if (typeof orig !== 'function') continue
    client[method] = function adaptedSend (name, params) {
      return orig.call(this, name, ADAPT_NAMES.has(name) ? adaptOutgoing(name, params) : params)
    }
  }
  client._bsrShapeAdapter = true
}
