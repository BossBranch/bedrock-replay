import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { createGzip, createGunzip } from 'zlib'
import { finished } from 'stream/promises'

export const MAGIC = 'MCREPLAY1'

/** Packets that are session/crypto specific — never useful to replay as-is */
export const SKIP_RECORD_CLIENTBOUND = new Set([
  'server_to_client_handshake',
  'network_settings',
  'network_stack_latency'
])

/** Handled live by the play host instead of replaying from file */
export const SKIP_PLAY_CLIENTBOUND = new Set([
  'server_to_client_handshake',
  'network_settings',
  'network_stack_latency',
  'resource_packs_info',
  'resource_pack_stack',
  'resource_pack_data_info',
  'resource_pack_chunk_data',
  'resource_pack_chunk_request'
])

/** World / entity sounds — recorded and replayed unless playSounds=false / .mute */
export const SOUND_PACKETS = new Set([
  'level_sound_event',
  'level_sound_event_old',
  'level_sound_event_v2',
  'play_sound',
  'stop_sound'
])

function isBytes (v) {
  return Buffer.isBuffer(v) || v instanceof Uint8Array
}

/** Deep-sanitize packet params so JSON + gzip stay compact and round-tripable */
export function sanitize (value) {
  if (value == null) return value
  if (typeof value === 'bigint') return { $bigint: value.toString() }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value
  if (isBytes(value)) return { $bytes: Buffer.from(value).toString('base64') }
  if (Array.isArray(value)) return value.map(sanitize)
  if (typeof value === 'object') {
    if (value.type === 'Buffer' && Array.isArray(value.data)) {
      return { $bytes: Buffer.from(value.data).toString('base64') }
    }
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v)
    return out
  }
  return value
}

export function revive (value) {
  if (value == null) return value
  if (Array.isArray(value)) return value.map(revive)
  if (typeof value === 'object') {
    if (Object.keys(value).length === 1 && value.$bigint !== undefined) return BigInt(value.$bigint)
    if (Object.keys(value).length === 1 && value.$bytes !== undefined) return Buffer.from(value.$bytes, 'base64')
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = revive(v)
    return out
  }
  return value
}

export class ReplayWriter {
  /**
   * @param {string} filePath path ending in .mcreplay.gz
   * @param {object} header meta (version, destination, ...)
   */
  constructor (filePath, header) {
    this.filePath = filePath
    this.t0 = Date.now()
    this.count = 0
    this.camCount = 0
    /** @type {{ t: number, buf: Buffer }[]} */
    this._rawQ = []
    this._rawBusy = false
    this._rawDropped = 0
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    // Mobile: lighter gzip — level 6 + sync base64 of MB packets stalls RakNet (block-break lag).
    const gzLevel = process.env.BEDROCK_REPLAY_MOBILE === '1' ? 1 : 6
    this.gz = createGzip({ level: gzLevel })
    this.out = fs.createWriteStream(filePath)
    this.gz.pipe(this.out)
    this._writeObj({
      type: 'header',
      magic: MAGIC,
      createdAt: new Date().toISOString(),
      ...header
    })
  }

  _writeObj (obj) {
    this.gz.write(JSON.stringify(sanitize(obj)) + '\n')
  }

  /** Relative ms since recording start */
  now () {
    return Date.now() - this.t0
  }

  /** Clientbound (server -> player) game packet */
  clientbound (name, params) {
    if (SKIP_RECORD_CLIENTBOUND.has(name)) return
    this.count++
    this._writeObj({ type: 'pkt', t: this.now(), d: 'c', n: name, p: params })
  }

  /**
   * Heavy clientbound as raw game bytes (no protodef on live path).
   * Encode+write is async/budgeted — never block the relay tick (Android lag).
   * @param {{ noDrop?: boolean }} [opts] noDrop: bypass the 64-cap. The .start
   *   chunk-cache flush pushes 100+ bufs at once — capping it silently dropped
   *   the INNERMOST spawn chunks (cached first = shifted out first) and left
   *   a hole under the start point in every recording.
   */
  rawClientbound (buf, opts) {
    if (!buf?.length) return
    // Copy now — UDP buffer may be reused
    const copy = Buffer.isBuffer(buf) ? Buffer.from(buf) : Buffer.from(buf)
    // 256 (was 64): teleport chunk floods (~200 pkts) overflowed the queue and
    // punched holes in the recorded terrain at the destination
    if (!opts?.noDrop && this._rawQ.length >= 256) {
      this._rawQ.shift()
      this._rawDropped++
    }
    // opts.n: hint for loaders when offline decode fails (e.g. item_registry)
    const n = typeof opts?.n === 'string' && opts.n ? opts.n : 'raw'
    this._rawQ.push({ t: this.now(), buf: copy, n })
    this._pumpRaw()
  }

  _pumpRaw () {
    if (this._rawBusy) return
    this._rawBusy = true
    const step = () => {
      const t0 = Date.now()
      // ≤2ms of encode work per turn so RakNet ACKs stay alive
      while (this._rawQ.length && (Date.now() - t0) < 2) {
        const item = this._rawQ.shift()
        this.count++
        // Skip sanitize() — base64 string only; sanitize would re-walk it
        const nJson = JSON.stringify(item.n || 'raw')
        const line =
          `{"type":"pkt","t":${item.t},"d":"c","raw":1,"n":${nJson},"b":"${item.buf.toString('base64')}"}\n`
        try { this.gz.write(line) } catch {}
      }
      if (this._rawQ.length) setImmediate(step)
      else this._rawBusy = false
    }
    setImmediate(step)
  }

  async _flushRawQ () {
    while (this._rawQ.length || this._rawBusy) {
      if (this._rawQ.length && !this._rawBusy) this._pumpRaw()
      await new Promise((r) => setImmediate(r))
    }
    if (this._rawDropped) {
      console.warn(`[record] raw queue dropped ${this._rawDropped} pkt(s) under load`)
    }
  }

  /** Camera sample from local player movement */
  camera (sample) {
    this.camCount++
    this._writeObj({ type: 'cam', t: this.now(), p: sample })
  }

  /**
   * Local player's held hotbar item (from serverbound mob_equipment /
   * player_auth_input / inventory_transaction). Clientbound never echoes your
   * own hand — without this, ghost hand is always empty.
   *
   * Prefer heldRaw() when you have the original SB packet bytes — PLAY patches
   * entity id and sendBuffers without re-encoding Item.
   */
  held (sample) {
    this._writeObj({ type: 'held', t: this.now(), p: sample })
  }

  /**
   * RAW equipment packet (usually serverbound mob_equipment, or CB armor).
   * @param {Buffer} buf full MCPE packet
   * @param {{ n?: string, p?: object }} [meta]
   */
  heldRaw (buf, meta = {}) {
    if (!buf?.length) return
    const copy = Buffer.isBuffer(buf) ? Buffer.from(buf) : Buffer.from(buf)
    const n = typeof meta.n === 'string' && meta.n ? meta.n : 'mob_equipment'
    const p = meta.p && typeof meta.p === 'object' ? meta.p : {}
    // Skip sanitize on base64 body
    this.count++
    const nJson = JSON.stringify(n)
    const pJson = JSON.stringify(p)
    const line =
      `{"type":"held","t":${this.now()},"raw":1,"n":${nJson},"p":${pJson},"b":"${copy.toString('base64')}"}\n`
    try { this.gz.write(line) } catch {}
  }

  /** Recorder identity (name + skin) for ghost playback */
  self (data) {
    this._writeObj({ type: 'self', t: this.now(), ...data })
  }

  marker (name, extra = {}) {
    this._writeObj({ type: 'mark', t: this.now(), n: name, ...extra })
  }

  async close (extra = {}) {
    await this._flushRawQ()
    this._writeObj({
      type: 'footer',
      t: this.now(),
      packets: this.count,
      cameras: this.camCount,
      ...extra
    })
    this.gz.end()
    await finished(this.out)
    return {
      path: this.filePath,
      packets: this.count,
      cameras: this.camCount,
      durationMs: this.now()
    }
  }
}

/**
 * Read only the first JSON line (header) — for UI version labels when .meta.json is missing.
 * Old debug recordings often have version in the gz header but no sidecar.
 */
export async function peekReplayHeader (filePath) {
  const stream = filePath.endsWith('.gz')
    ? fs.createReadStream(filePath).pipe(createGunzip())
    : fs.createReadStream(filePath)
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const row = revive(JSON.parse(trimmed))
        if (row?.type === 'header') return row
      } catch {}
      return null
    }
  } finally {
    try { rl.close() } catch {}
    try { stream.destroy?.() } catch {}
  }
  return null
}

/**
 * Read a replay file. Yields revived objects in order.
 * Supports .mcreplay.gz and plain .mcreplay
 */
export async function * readReplay (filePath) {
  const stream = filePath.endsWith('.gz')
    ? fs.createReadStream(filePath).pipe(createGunzip())
    : fs.createReadStream(filePath)

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    yield revive(JSON.parse(trimmed))
  }
}

/**
 * Load full timeline into memory (tests / tools).
 * Play path uses loadTimelineStreaming in replayStream.js (spills heavy pkts).
 */
export async function loadTimeline (filePath) {
  const events = []
  let header = null
  let footer = null
  for await (const row of readReplay(filePath)) {
    if (row.type === 'header') header = row
    else if (row.type === 'footer') footer = row
    else events.push(row)
  }
  if (!header || header.magic !== MAGIC) {
    throw new Error('Invalid replay: bad/missing header')
  }
  return { header, footer, events }
}
