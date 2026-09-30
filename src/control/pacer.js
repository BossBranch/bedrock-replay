/**
 * Outbound byte-rate limiter for one PLAY connection.
 *
 * Counts real wire bytes at the RakNet sendReliable hook and lets the replay
 * pump `await pacer.wait()` whenever it runs ahead of the budget. Seek
 * catch-up, chunk preload and warp re-sends used to push thousands of packets
 * in one event-loop turn: jsp-raknet (Android) has no congestion control, so
 * the UDP socket overflowed, datagrams were lost and the client timed out
 * (kick); on PC the backlog stalled the client for seconds.
 *
 * Only the replay pump waits — LIVE relay traffic on the same socket (in-place
 * .play) is merely counted, never delayed.
 */

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/**
 * Budget in KB/s; config `playMaxKBps` (0 = unlimited). jsp-raknet (phones,
 * or forced on PC) has no congestion control — a headless jsp client already
 * choked at 8 MB/s bursts in tests, so it gets the phone budget.
 */
export function paceOptionsFromConfig (cfg = {}) {
  const mobile = process.env.BEDROCK_REPLAY_MOBILE === '1'
  const jsp = cfg.raknetBackend === 'jsp-raknet'
  const raw = cfg.playMaxKBps
  const kbps = raw == null || raw === '' || !Number.isFinite(Number(raw))
    ? (mobile || jsp ? 1536 : 8192)
    : Math.max(0, Number(raw))
  return {
    kbps,
    // ~1/6 s of budget may leave at once (spawn chunk batch, one big skin)
    burstKB: Math.max(128, Math.round(kbps / 6))
  }
}

export class SendPacer {
  /**
   * Hook (once) or reuse the pacer bound to this client's RakNet connection.
   * @param {object} client bedrock-protocol Player
   * @param {{ kbps: number, burstKB: number }} opts
   * @returns {SendPacer | null} null when the connection cannot be hooked
   */
  static attach (client, opts) {
    const conn = client?.connection
    if (!conn || typeof conn.sendReliable !== 'function') return null
    if (conn._bsrPacer) {
      conn._bsrPacer.configure(opts)
      conn._bsrPacer.client = client
      return conn._bsrPacer
    }
    const pacer = new SendPacer(client, opts)
    const orig = conn.sendReliable
    conn.sendReliable = function pacedSendReliable (buffer, immediate) {
      pacer.spend(buffer?.length || 0)
      return orig.call(this, buffer, immediate)
    }
    conn._bsrPacer = pacer
    return pacer
  }

  constructor (client, opts) {
    this.client = client
    this.bytes = 0
    this.waitedMs = 0
    this.configure(opts)
  }

  configure ({ kbps, burstKB } = {}) {
    this.unlimited = !(kbps > 0)
    this.ratePerMs = (kbps || 0) * 1024 / 1000
    this.burst = Math.max(1, (burstKB || 128) * 1024)
    this.tokens = this.burst
    this.last = Date.now()
  }

  _refill () {
    const now = Date.now()
    const dt = now - this.last
    this.last = now
    if (dt > 0) this.tokens = Math.min(this.burst, this.tokens + dt * this.ratePerMs)
  }

  spend (n) {
    this.bytes += n
    if (this.unlimited) return
    this._refill()
    this.tokens -= n
  }

  /** Cheap sync check for hot loops: only await wait() when this is true. */
  over () {
    if (this.unlimited) return false
    this._refill()
    return this.tokens < 0
  }

  async wait () {
    while (this.over()) {
      if (!this.client || this.client.status === 0) return
      const ms = Math.min(50, Math.max(1, Math.ceil(-this.tokens / this.ratePerMs)))
      this.waitedMs += ms
      await sleep(ms)
    }
  }
}
