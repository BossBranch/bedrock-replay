/**
 * Memory-lean replay loading: heavy packet bodies live on a temp spill file;
 * the in-RAM timeline keeps stubs + small events (cam/held/mark/self/light pkts).
 * Sidecar .meta.json stores duration without scanning the whole gz.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { createRequire } from 'module'
import { MAGIC, readReplay, sanitize, revive } from './format.js'
import { resolveToSupportedVersion } from './version.js'

const require = createRequire(import.meta.url)
const { createDeserializer } = require('bedrock-protocol/src/transforms/serializer.js')

/** Spill packet params larger than this (JSON chars after sanitize). */
const SPILL_JSON_CHARS = 2048

/** Max revived heavy payloads kept in RAM at once. */
const SPILL_CACHE_MAX = 64

export function replayMetaPath (filePath) {
  const base = String(filePath || '').replace(/\.mcreplay\.gz$/i, '').replace(/\.mcreplay$/i, '')
  return `${base}.meta.json`
}

export function writeReplayMeta (filePath, meta = {}) {
  const out = {
    file: path.basename(filePath),
    updatedAt: new Date().toISOString(),
    ...meta
  }
  const p = replayMetaPath(filePath)
  fs.writeFileSync(p, JSON.stringify(out, null, 2) + '\n', 'utf8')
  return p
}

export function readReplayMeta (filePath) {
  const candidates = [replayMetaPath(filePath)]
  // Durable Documents dir may lack sidecars after migrate; fall back to internal data/replays
  try {
    const base = path.basename(String(filePath || ''))
    if (process.env.BEDROCK_REPLAY_DATA && base) {
      candidates.push(path.join(process.env.BEDROCK_REPLAY_DATA, 'replays', replayMetaPath(base)))
    }
  } catch {}
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (!raw || typeof raw !== 'object') continue
      return raw
    } catch { /* try next */ }
  }
  return null
}

function spillDir () {
  // Android / sandbox: os.tmpdir() is often not writable (/tmp → EACCES)
  const bases = [
    process.env.BEDROCK_REPLAY_DATA,
    process.env.BEDROCK_REPLAY_ROOT && path.join(process.env.BEDROCK_REPLAY_ROOT, 'data'),
    os.tmpdir()
  ].filter(Boolean)
  for (const base of bases) {
    const dir = path.join(base, 'bedrock-replay-spill')
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.accessSync(dir, fs.constants.W_OK)
      return dir
    } catch { /* try next */ }
  }
  throw new Error('No writable spill directory (set BEDROCK_REPLAY_DATA)')
}

class PayloadSpill {
  constructor () {
    const dir = spillDir()
    this.path = path.join(
      dir,
      `spill_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.bin`
    )
    this.fd = fs.openSync(this.path, 'w+')
    this.pos = 0
    this.cache = new Map()
    /** @type {number[]} */
    this.order = []
    this.bytes = 0
    this.count = 0
  }

  write (value) {
    const buf = Buffer.from(JSON.stringify(sanitize(value)), 'utf8')
    const hdr = Buffer.alloc(4)
    hdr.writeUInt32LE(buf.length, 0)
    const off = this.pos
    fs.writeSync(this.fd, hdr, 0, 4, off)
    fs.writeSync(this.fd, buf, 0, buf.length, off + 4)
    this.pos = off + 4 + buf.length
    this.bytes += buf.length
    this.count++
    return off
  }

  read (off) {
    if (this.cache.has(off)) {
      this._touch(off)
      return this.cache.get(off)
    }
    const hdr = Buffer.alloc(4)
    fs.readSync(this.fd, hdr, 0, 4, off)
    const len = hdr.readUInt32LE(0)
    if (len <= 0 || len > 64 * 1024 * 1024) {
      throw new Error(`bad spill length ${len} @${off}`)
    }
    const buf = Buffer.alloc(len)
    fs.readSync(this.fd, buf, 0, len, off + 4)
    const value = revive(JSON.parse(buf.toString('utf8')))
    this._put(off, value)
    return value
  }

  _touch (off) {
    const i = this.order.indexOf(off)
    if (i >= 0) this.order.splice(i, 1)
    this.order.push(off)
  }

  _put (off, value) {
    this.cache.set(off, value)
    this._touch(off)
    while (this.order.length > SPILL_CACHE_MAX) {
      const old = this.order.shift()
      this.cache.delete(old)
    }
  }

  close () {
    try { fs.closeSync(this.fd) } catch {}
    try { if (fs.existsSync(this.path)) fs.unlinkSync(this.path) } catch {}
    this.cache.clear()
    this.order = []
  }
}

function jsonSize (value) {
  try {
    return JSON.stringify(sanitize(value)).length
  } catch {
    return SPILL_JSON_CHARS + 1
  }
}

function makeSpilledPkt (row, spill, off) {
  return {
    type: row.type,
    t: row.t,
    d: row.d,
    n: row.n,
    get p () {
      return spill.read(off)
    },
    set p (v) {
      spill._put(off, v)
    },
    _spilled: true
  }
}

function makeDeserializer (version) {
  const v = resolveToSupportedVersion(version) || version || '1.21.100'
  try {
    return createDeserializer(v)
  } catch (e) {
    console.warn(`[replayStream] deserializer ${v} failed: ${e.message}`)
    try { return createDeserializer('1.21.100') } catch { return null }
  }
}

function decodeRawPkt (row, buf, deserializer) {
  if (!deserializer || !buf?.length) return null
  // item_registry: NEVER re-hydrate through JSON — sanitize/revive + client.write
  // corrupts network ids and Bedrock hard-crashes («Произошла ошибка»). Keep raw.
  if (row.n === 'item_registry') return null
  // inventory_*: keep RAW. Local armor is inventory_content(window=armor); if we
  // decode here we lose Item bytes and freecam suppresses the parsed packet →
  // ghost stays naked. PLAY converts armor RAW → mob_armor_equipment.
  if (row.n === 'inventory_content' || row.n === 'inventory_slot') return null
  try {
    const des = deserializer.parsePacketBuffer(buf)
    if (!des?.data?.name) return null
    // Same for late-decoded registries named only after parse
    if (des.data.name === 'item_registry') return null
    if (des.data.name === 'inventory_content' || des.data.name === 'inventory_slot') return null
    return {
      type: 'pkt',
      t: row.t,
      d: row.d || 'c',
      n: des.data.name,
      p: des.data.params
    }
  } catch {
    return null
  }
}

/**
 * Load replay timeline without keeping every heavy packet body in RAM.
 * Raw (whitelist-record) packets are decoded offline here — not on the LIVE path.
 * @returns {Promise<{ header, footer, events, spill, spilled, stats }>}
 */
export async function loadTimelineStreaming (filePath) {
  const spill = new PayloadSpill()
  const events = []
  let header = null
  let footer = null
  let spilled = 0
  let kept = 0
  let rawDecoded = 0
  let rawKept = 0
  let deserializer = null

  try {
    for await (const row of readReplay(filePath)) {
      if (row.type === 'header') {
        header = row
        deserializer = makeDeserializer(row.version)
        continue
      }
      if (row.type === 'footer') {
        footer = row
        continue
      }
      if (row.type === 'pkt' && row.raw && row.b != null) {
        const body = typeof row.b === 'string'
          ? row.b
          : (Buffer.isBuffer(row.b) ? row.b.toString('base64') : null)
        const buf = body ? Buffer.from(body, 'base64') : null
        const decoded = decodeRawPkt(row, buf, deserializer)
        if (decoded) {
          rawDecoded++
          if (decoded.p != null && jsonSize(decoded.p) > SPILL_JSON_CHARS) {
            const off = spill.write(decoded.p)
            events.push(makeSpilledPkt(decoded, spill, off))
            spilled++
          } else {
            events.push(decoded)
            kept++
          }
          continue
        }
        // Decode failed — keep raw for sendBuffer fallback in play.js
        rawKept++
        if (body && body.length > SPILL_JSON_CHARS) {
          const off = spill.write(body)
          events.push({
            type: row.type,
            t: row.t,
            d: row.d,
            raw: 1,
            n: row.n || 'raw',
            get b () {
              return spill.read(off)
            },
            _spilled: true
          })
          spilled++
        } else {
          events.push(row)
          kept++
        }
        continue
      }
      if (row.type === 'pkt' && row.d === 'c' && row.p != null && jsonSize(row.p) > SPILL_JSON_CHARS) {
        const off = spill.write(row.p)
        events.push(makeSpilledPkt(row, spill, off))
        spilled++
      } else {
        events.push(row)
        kept++
      }
    }
  } catch (e) {
    spill.close()
    throw e
  }

  if (!header || header.magic !== MAGIC) {
    spill.close()
    throw new Error('Invalid replay: bad/missing header')
  }

  console.log(
    `[replayStream] loaded events=${events.length} spilled=${spilled} inline=${kept}` +
    ` rawDecoded=${rawDecoded} rawKept=${rawKept}` +
    ` spillBytes≈${(spill.bytes / 1024 / 1024).toFixed(1)}MB cache≤${SPILL_CACHE_MAX}`
  )

  return {
    header,
    footer,
    events,
    spill,
    spilled,
    stats: { spilled, kept, spillBytes: spill.bytes, rawDecoded, rawKept }
  }
}
