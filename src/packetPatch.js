/**
 * Binary patch helpers for replaying equipment WITHOUT re-encoding Item payloads.
 * Bedrock 1.26 runtime_entity_id is unsigned varlong (NOT zigzag) after packet id.
 */

/** Read unsigned varint → [valueNumber, nextOffset] */
export function readVarIntAt (buf, off) {
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

/** Read unsigned varlong → [bigint, nextOffset] */
export function readVarLongAt (buf, off) {
  let result = 0n
  let shift = 0n
  let o = off
  while (o < buf.length) {
    const b = BigInt(buf[o++])
    result |= (b & 0x7fn) << shift
    if ((b & 0x80n) === 0n) return [result, o]
    shift += 7n
    if (shift > 70n) throw new Error('varlong overflow')
  }
  throw new Error('varlong eof')
}

/** Write unsigned varint (number) */
export function writeVarInt (n) {
  let v = n >>> 0
  const parts = []
  while (v >= 0x80) {
    parts.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  parts.push(v)
  return Buffer.from(parts)
}

/** Write unsigned varlong (bigint or number) */
export function writeVarLong (n) {
  let v = typeof n === 'bigint' ? n : BigInt(n)
  if (v < 0n) throw new Error('varlong negative')
  const parts = []
  while (v >= 0x80n) {
    parts.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  parts.push(Number(v))
  return Buffer.from(parts)
}

/**
 * Replace runtime_entity_id that sits right after the packet-id varint
 * (mob_equipment, mob_armor_equipment, …). Leaves the rest of the body intact
 * so Item bytes stay Minecraft-client-encoded.
 *
 * @param {Buffer} packetBuf full MCPE packet (id + payload)
 * @param {bigint|number} newRid
 * @returns {Buffer}
 */
export function replaceRuntimeEntityId (packetBuf, newRid) {
  if (!Buffer.isBuffer(packetBuf) || packetBuf.length < 2) {
    throw new Error('replaceRuntimeEntityId: bad buffer')
  }
  const [, afterId] = readVarIntAt(packetBuf, 0)
  const [, afterEnt] = readVarLongAt(packetBuf, afterId)
  return Buffer.concat([
    packetBuf.subarray(0, afterId),
    writeVarLong(newRid),
    packetBuf.subarray(afterEnt)
  ])
}

/** Empty ItemV4 wire bytes (1.26 — network_id=0), from GamePE mob_armor_equipment. */
export const EMPTY_ITEM_V4 = Buffer.from(
  '000000000000a6660a00000000000000000000',
  'hex'
)

/** Packet ids (1.26.30) */
export const PKT_MOB_ARMOR_EQUIPMENT = 32
export const PKT_INVENTORY_CONTENT = 49
export const PKT_INVENTORY_SLOT = 50
/** WindowIDVarint: armor */
export const WIN_ARMOR = 120

function readZigZag32At (buf, off) {
  const [u, next] = readVarIntAt(buf, off)
  const n = (u >>> 1) ^ -(u & 1)
  return [n, next]
}

function readByteArrayAt (buf, off) {
  const [len, o2] = readVarIntAt(buf, off)
  const end = o2 + len
  if (end > buf.length) throw new Error('bytearray eof')
  return [buf.subarray(o2, end), end]
}

/**
 * Slice one ItemV4 from wire (1.26). Returns [itemSlice, nextOffset].
 * @param {Buffer} buf
 * @param {number} off
 */
export function readItemV4At (buf, off) {
  const start = off
  if (off + 4 > buf.length) throw new Error('ItemV4 short')
  off += 2 // li16 network_id
  off += 2 // lu16 count
  ;[, off] = readVarIntAt(buf, off) // metadata
  if (off >= buf.length) throw new Error('ItemV4 option eof')
  const hasVariant = buf[off++]
  if (hasVariant) {
    // ItemV4NetIdVariant: varint type + zigzag32 id
    ;[, off] = readVarIntAt(buf, off)
    ;[, off] = readZigZag32At(buf, off)
  }
  ;[, off] = readVarIntAt(buf, off) // block_runtime_id
  ;[, off] = readByteArrayAt(buf, off) // extra_data
  return [buf.subarray(start, off), off]
}

/** Peek WindowIDVarint after packet id (inventory_content / inventory_slot). */
export function peekInventoryWindowId (packetBuf) {
  if (!Buffer.isBuffer(packetBuf) || packetBuf.length < 2) return null
  try {
    const [id, afterId] = readVarIntAt(packetBuf, 0)
    if (id !== PKT_INVENTORY_CONTENT && id !== PKT_INVENTORY_SLOT) return null
    const [win] = readVarIntAt(packetBuf, afterId)
    return win >>> 0
  } catch {
    return null
  }
}

/**
 * Convert CB inventory_content (window=armor) → mob_armor_equipment RAW.
 * GamePE sends the local player's armor this way (not mob_armor_equipment).
 * Item bytes are copied verbatim — no re-encode.
 *
 * @param {Buffer} invContentBuf
 * @param {bigint|number} ghostRid
 * @returns {Buffer|null}
 */
export function inventoryArmorToMobArmor (invContentBuf, ghostRid) {
  if (!Buffer.isBuffer(invContentBuf) || invContentBuf.length < 6) return null
  try {
    const [id, afterId] = readVarIntAt(invContentBuf, 0)
    if (id !== PKT_INVENTORY_CONTENT) return null
    const [win, afterWin] = readVarIntAt(invContentBuf, afterId)
    if ((win >>> 0) !== WIN_ARMOR) return null
    const [count, afterCount] = readVarIntAt(invContentBuf, afterWin)
    if (count < 4 || count > 5) return null
    const items = []
    let off = afterCount
    for (let i = 0; i < count; i++) {
      const [it, next] = readItemV4At(invContentBuf, off)
      items.push(it)
      off = next
    }
    while (items.length < 5) items.push(EMPTY_ITEM_V4)
    return Buffer.concat([
      writeVarInt(PKT_MOB_ARMOR_EQUIPMENT),
      writeVarLong(ghostRid),
      items[0],
      items[1],
      items[2],
      items[3],
      items[4]
    ])
  } catch {
    return null
  }
}
