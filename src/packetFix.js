/**
 * Repair Bedrock packets that deserialize incompletely but must re-serialize on play.
 */

/** int64 as bigint — handles [high, low] pairs left by some codecs / JSON */
export function asUniqueId (v, fallback = 0n) {
  if (v == null) return fallback
  if (typeof v === 'bigint') return v
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v))
  if (typeof v === 'object' && v.$bigint != null) return BigInt(v.$bigint)
  if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number')) {
    return (BigInt(v[0] | 0) << 32n) | BigInt(v[1] >>> 0)
  }
  try {
    return BigInt(v)
  } catch {
    return fallback
  }
}

/**
 * player_list on 1.21+ needs records_count + verified[] or SizeOf crashes
 * and the packet is silently skipped → everyone looks like Steve.
 */
export function fixPlayerListParams (params) {
  if (!params || typeof params !== 'object') return params
  const wrapped = params.records && typeof params.records === 'object' &&
    (params.records.records != null || params.records.type != null)
  const block = wrapped ? { ...params.records } : { ...params }
  const type = block.type ?? 'add'
  const records = Array.isArray(block.records) ? block.records.map(fixListRecord) : []
  const recordsCount = records.length
  const verified = Array.isArray(block.verified) && block.verified.length === recordsCount
    ? block.verified
    : records.map(() => true)

  const fixed = {
    type,
    records_count: recordsCount,
    records,
    ...(type === 'add' || type === 0 || type === '0' ? { verified } : {})
  }

  if (wrapped) return { ...params, records: fixed }
  return fixed
}

function fixListRecord (rec) {
  if (!rec || typeof rec !== 'object') return rec
  const out = { ...rec }
  if (out.entity_unique_id != null) out.entity_unique_id = asUniqueId(out.entity_unique_id)
  if (out.xbox_user_id == null) out.xbox_user_id = ''
  else out.xbox_user_id = String(out.xbox_user_id)
  if (out.platform_chat_id == null) out.platform_chat_id = ''
  if (out.username == null) out.username = ''
  if (out.skin_data) out.skin_data = fixSkin(out.skin_data)
  return out
}

function fixSkinImage (img) {
  if (!img || typeof img !== 'object') return { width: 0, height: 0, data: Buffer.alloc(0) }
  const width = img.width || 0
  const height = img.height || 0
  let data = img.data
  if (!Buffer.isBuffer(data)) {
    if (data?.$bytes) data = Buffer.from(data.$bytes, 'base64')
    else if (Array.isArray(data)) data = Buffer.from(data)
    else data = Buffer.alloc(Math.max(0, width * height * 4))
  }
  return { width, height, data }
}

export function fixSkin (skin) {
  if (!skin || typeof skin !== 'object') return skin
  return {
    skin_id: String(skin.skin_id || 'skin'),
    play_fab_id: String(skin.play_fab_id || ''),
    skin_resource_pack: String(skin.skin_resource_pack || '{"geometry":{"default":"geometry.humanoid.custom"}}'),
    skin_data: fixSkinImage(skin.skin_data),
    animations: Array.isArray(skin.animations)
      ? skin.animations.map((a) => ({
        skin_image: fixSkinImage(a?.skin_image),
        animation_type: a?.animation_type ?? 0,
        animation_frames: a?.animation_frames ?? 0,
        expression_type: a?.expression_type ?? 0
      }))
      : [],
    cape_data: fixSkinImage(skin.cape_data),
    geometry_data: String(skin.geometry_data || ''),
    geometry_data_version: String(skin.geometry_data_version || ''),
    animation_data: String(skin.animation_data || ''),
    cape_id: String(skin.cape_id || ''),
    full_skin_id: String(skin.full_skin_id || skin.skin_id || 'skin'),
    arm_size: String(skin.arm_size || 'wide'),
    skin_color: String(skin.skin_color || '#0'),
    personal_pieces: Array.isArray(skin.personal_pieces) ? skin.personal_pieces : [],
    piece_tint_colors: Array.isArray(skin.piece_tint_colors) ? skin.piece_tint_colors : [],
    premium: !!skin.premium,
    persona: !!skin.persona,
    cape_on_classic: !!skin.cape_on_classic,
    primary_user: skin.primary_user !== false,
    overriding_player_appearance: skin.overriding_player_appearance !== false
  }
}

function asRuntimeId64 (v) {
  if (v == null) return v
  if (typeof v === 'bigint') return v
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v))
  if (typeof v === 'object' && v.$bigint != null) return BigInt(v.$bigint)
  try { return BigInt(v) } catch { return v }
}

/** Fix unique_id / entity ids on spawn packets before client.write */
export function fixActorIds (name, params) {
  if (!params || typeof params !== 'object') return params
  const p = { ...params }
  if (name === 'add_player') {
    if (p.unique_id != null) p.unique_id = asUniqueId(p.unique_id)
    if (p.runtime_id != null) p.runtime_id = asRuntimeId64(p.runtime_id)
  }
  if (name === 'add_entity' || name === 'add_item_entity') {
    if (p.entity_unique_id != null) p.entity_unique_id = asUniqueId(p.entity_unique_id)
    if (p.entity_id_self != null) p.entity_id_self = asUniqueId(p.entity_id_self)
    if (p.unique_id != null) p.unique_id = asUniqueId(p.unique_id)
    if (p.runtime_entity_id != null) p.runtime_entity_id = asRuntimeId64(p.runtime_entity_id)
    if (p.runtime_id != null) p.runtime_id = asRuntimeId64(p.runtime_id)
    // Ensure metadata serializes
    if (!Array.isArray(p.metadata)) p.metadata = []
    if (name === 'add_item_entity' && p.is_from_fishing == null) p.is_from_fishing = false
  }
  if (name === 'remove_entity' || name === 'take_item_entity') {
    if (p.entity_id_self != null) p.entity_id_self = asUniqueId(p.entity_id_self)
    if (p.runtime_entity_id != null) p.runtime_entity_id = asRuntimeId64(p.runtime_entity_id)
    if (p.runtime_id != null && typeof p.runtime_id !== 'bigint') {
      try { p.runtime_id = asUniqueId(p.runtime_id) } catch {}
    }
  }
  return p
}
