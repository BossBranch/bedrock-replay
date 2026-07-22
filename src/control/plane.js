/**
 * Shared playback control state — chat / items / web all call into this.
 */

export class ControlPlane {
  /**
   * @param {{ speed?: number, durationMs?: number, fileName?: string }} opts
   */
  constructor (opts = {}) {
    this.speed = Number.isFinite(opts.speed) && opts.speed > 0 ? opts.speed : 1
    this.paused = false
    this.t = 0
    this.durationMs = opts.durationMs ?? 0
    this.fileName = opts.fileName || ''
    this.status = 'idle' // idle | playing | paused | seeking | ended
    this.seeking = false
    /** Mute recorded world sounds (.mute / playSounds config) */
    this.muted = opts.muted === true
    /**
     * After .restart / .restart0: stay paused (true) or auto-play (false, default).
     * Config: restartPaused
     */
    this.restartPaused = opts.restartPaused === true
    /**
     * After seek / ±N: stay paused (true) or keep playing (false, default).
     * Config: seekPaused
     */
    this.seekPaused = opts.seekPaused === true
    /** .me / .spec available (false on pre-1.19.50 freecam-only) */
    this.possessEnabled = opts.possessEnabled !== false
    /** Optional chat announcer (set by play session) */
    this._announce = typeof opts.announce === 'function' ? opts.announce : null
    /** @type {Set<Function>} */
    this._listeners = new Set()
    /** Bound by play session */
    this._transport = null
    /** Coalesce spam: only latest pending goto while a seek runs */
    this._pendingGoto = null
    this._pendingResetCamera = false
    /** Absolute media time the in-flight seek is heading to */
    this._activeSeekTarget = null
  }

  setAnnounce (fn) {
    this._announce = typeof fn === 'function' ? fn : null
  }

  _sayRestartResult (ok, err) {
    const say = this._announce
    if (!say) return
    if (!ok) {
      say(`§c[Replay] ${err || 'restart failed'}`)
      return
    }
    if (this.paused) {
      say('§e[Replay] §f0:00 §7пауза — нажми §f1§7 или §f.pause§7 / ▶')
    } else {
      say('§a[Replay] §f0:00 ▶')
    }
  }

  bindTransport (transport) {
    this._transport = transport
  }

  subscribe (fn) {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  _emit (reason = 'update') {
    const snap = this.snapshot()
    for (const fn of this._listeners) {
      try { fn(snap, reason) } catch {}
    }
  }

  snapshot () {
    const mediaT = this._transport?.mediaTime?.() ?? this.t
    this.t = mediaT
    return {
      paused: this.paused,
      speed: this.speed,
      t: mediaT,
      durationMs: this.durationMs,
      fileName: this.fileName,
      status: this.seeking ? 'seeking' : (this.paused ? 'paused' : this.status),
      seeking: this.seeking,
      muted: !!this.muted
    }
  }

  setMuted (muted) {
    this.muted = !!muted
    this._emit('mute')
    return this.snapshot()
  }

  setFileName (name) {
    this.fileName = name || ''
    this._emit('file')
    return this.snapshot()
  }

  setStatus (status) {
    this.status = status
    this._emit('status')
  }

  setDuration (ms) {
    this.durationMs = Math.max(0, ms || 0)
    this._emit('duration')
  }

  pause () {
    this.paused = true
    this.status = 'paused'
    this._transport?.onPause?.()
    this._emit('pause')
    return this.snapshot()
  }

  resume () {
    // Play session can re-arm freecam protect so ▶ after .restart+move doesn't snap to spawn
    try { this._onBeforeResume?.() } catch {}
    // If a seek is in flight, only mark "play when done" — never clear _seeking
    // (that used to let run() pump in parallel with catch-up).
    if (this._transport?._seeking) {
      this._transport._resumeAfterSeek = true
      this.paused = false
      this.status = 'playing'
      this._emit('resume')
      const s = this.snapshot()
      console.log(`[control] resume-after-seek queued t=${(s.t / 1000).toFixed(2)}s`)
      return s
    }
    this.paused = false
    this.status = 'playing'
    this.seeking = false
    this._transport?.onResume?.()
    this._emit('resume')
    const s = this.snapshot()
    console.log(`[control] resume paused=${s.paused} t=${(s.t / 1000).toFixed(2)}s`)
    return s
  }

  togglePause () {
    return this.paused ? this.resume() : this.pause()
  }

  /**
   * Jump to start of replay. Keeps freecam angle by default.
   * @param {{ resetCamera?: boolean }} [opts] resetCamera=true → teleport to spawn (.restart0)
   */
  async restart (opts = {}) {
    const stayPaused = opts.paused != null ? !!opts.paused : this.restartPaused
    if (opts.resetCamera) {
      const r = await this.goto(0, { resetCamera: true, autoPause: stayPaused })
      if (r?.ok && !stayPaused) this.resume()
      else if (r?.ok && stayPaused && !this.paused) this.pause()
      this._sayRestartResult(!!r?.ok, r?.error)
      return r
    }
    // Dedicated path — MUST NOT use seek catch-up (that snaps Bedrock freecam)
    if (!this._transport?.restartKeepCamera) {
      const r = await this.goto(0, { resetCamera: false, autoPause: stayPaused })
      if (r?.ok && !stayPaused) this.resume()
      else if (r?.ok && stayPaused && !this.paused) this.pause()
      this._sayRestartResult(!!r?.ok, r?.error)
      return r
    }
    this.seeking = true
    this._emit('seek_start')
    try {
      const r = await this._transport.restartKeepCamera({ pause: stayPaused })
      this.seeking = false
      this.t = 0
      if (stayPaused) {
        this.paused = true
        this.status = 'paused'
        this._transport._paused = true
      } else {
        this.resume()
      }
      this._emit('seek_end')
      const out = { ok: true, ...this.snapshot(), ...(r || {}) }
      this._sayRestartResult(true)
      return out
    } catch (e) {
      this.seeking = false
      this._emit('seek_error')
      const out = { ok: false, error: e.message || String(e), ...this.snapshot() }
      this._sayRestartResult(false, out.error)
      return out
    }
  }

  /** Restart + snap freecam to recording spawn. */
  async restart0 () {
    return this.restart({ resetCamera: true })
  }

  setSpeed (n) {
    const v = Number(n)
    if (!Number.isFinite(v) || v <= 0) return { ok: false, error: 'speed must be > 0', ...this.snapshot() }
    const clamped = Math.min(64, Math.max(0.05, v))
    this.speed = clamped
    this._transport?.onSpeed?.(clamped)
    this._emit('speed')
    return { ok: true, ...this.snapshot() }
  }

  async seek (deltaMs) {
    // Relative seeks stack on pending/active target; clamp to duration so end-inflation can't skew
    const dur = this.durationMs || 0
    const raw = this._pendingGoto != null
      ? this._pendingGoto
      : (this._activeSeekTarget != null
          ? this._activeSeekTarget
          : (this._transport?.mediaTime?.() ?? this.t))
    const cur = dur > 0 ? Math.min(raw, dur) : raw
    const delta = Number(deltaMs || 0)
    const target = cur + delta
    console.log(
      `[control] seek ${delta >= 0 ? '+' : ''}${(delta / 1000).toFixed(2)}s: ` +
      `${(cur / 1000).toFixed(2)}s → ${(Math.max(0, Math.min(dur || target, target)) / 1000).toFixed(2)}s`
    )
    return this.goto(target)
  }

  /**
   * Jump to media time.
   * @param {number} ms
   * @param {{ resetCamera?: boolean, autoPause?: boolean }} [opts]
   */
  async goto (ms, opts = {}) {
    if (!this._transport?.seekTo) {
      return { ok: false, error: 'seek not ready', ...this.snapshot() }
    }
    const clamp = (v) => Math.max(0, Math.min(this.durationMs || Number.MAX_SAFE_INTEGER, Number(v) || 0))
    const target = clamp(ms)
    const resetCamera = !!opts.resetCamera
    const autoPause = opts.autoPause != null ? !!opts.autoPause : this.seekPaused

    if (this.seeking) {
      this._pendingGoto = target
      this._pendingResetCamera = resetCamera
      return { ok: true, queued: true, ...this.snapshot() }
    }

    this.seeking = true
    this._emit('seek_start')
    try {
      let next = target
      let nextReset = resetCamera
      while (next != null) {
        this._pendingGoto = null
        const useReset = nextReset
        this._pendingResetCamera = false
        nextReset = false
        this._activeSeekTarget = next
        await this._transport.seekTo(next, {
          autoPause,
          resetCamera: useReset
        })
        this.t = next
        if (this._pendingGoto != null) {
          next = clamp(this._pendingGoto)
          nextReset = !!this._pendingResetCamera
        } else {
          next = null
        }
      }
      this._activeSeekTarget = null
      this.seeking = false
      // Sync from transport — do NOT force pause if user already resumed
      this.paused = !!this._transport._paused
      this.status = this.paused ? 'paused' : 'playing'
      this._emit('seek_end')
      return { ok: true, pausedForAngle: this.paused, ...this.snapshot() }
    } catch (e) {
      this._pendingGoto = null
      this._pendingResetCamera = false
      this._activeSeekTarget = null
      this.seeking = false
      this._emit('seek_error')
      return { ok: false, error: e.message || String(e), ...this.snapshot() }
    }
  }

  /**
   * Compact RU help. Triggered by `.` / `.help` / `.h`
   */
  sayCommands (say = () => {}) {
    say('§e[Replay] §f.pause §7(ещё раз — ▶) §8· §f.seek ±N §8· §f.goto M:SS §8· §f.speed N')
    if (this.possessEnabled) {
      say('§e[Replay] §f.me §8· §f.spec §8· §f.next §8· §f.free §8· §f.spawn §8· §f.restart')
      say('§e[Replay] §f.me §7adventure+fly §8· §f.mepath 0|1')
    } else {
      say('§e[Replay] §f.free §8· §f.spawn §8· §f.restart §7· только freecam (вселение выкл)')
    }
    say('§e[Replay] §f.live §7= выход из просмотра (потом зайди на LIVE)')
  }

  /**
   * Parse playback chat commands (not spectate).
   * @returns {boolean} true if handled
   */
  handleChat (raw, say = () => {}) {
    if (!raw || typeof raw !== 'string') return false
    let msg = raw.trim()
    if (msg.startsWith('/')) msg = msg.slice(1)
    // strip zero-width / weird spaces Bedrock sometimes adds
    msg = msg.replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim()
    const lower = msg.toLowerCase()

    // "." alone, .h, .help
    if (
      lower === '.' ||
      lower === '.h' ||
      lower === '.help' ||
      lower === 'help' ||
      lower === '.?' ||
      lower === '.commands' ||
      lower === '.cmds'
    ) {
      this.sayCommands(say)
      return true
    }

    if (
      lower === '.pause' || lower === 'pause' ||
      lower === '.пауза' || lower === 'пауза' ||
      lower === '.toggle' || lower === '.p'
    ) {
      this.togglePause()
      const s = this.snapshot()
      if (this.paused) {
        say(`§e[Replay] Пауза §f${fmtTime(s.t)}`)
        console.log(`[control] pause t=${(s.t / 1000).toFixed(2)}s`)
      } else {
        say('§a[Replay] ▶')
        console.log(`[control] play t=${(s.t / 1000).toFixed(2)}s`)
      }
      return true
    }

    if (
      lower === '.live' || lower === 'live' ||
      lower === '.back' || lower === 'back' ||
      lower === '.real' || lower === '.server'
    ) {
      // Handled by play.js / hub (return to live proxy) — mark as known
      return false
    }

    if (
      lower === '.restart0' || lower === 'restart0' ||
      lower === '.restartspawn' || lower === '.restartcam'
    ) {
      // Message via plane._announce / _sayRestartResult
      this.setAnnounce(say)
      this.restart0()
      return true
    }

    if (
      lower === '.restart' || lower === 'restart' ||
      lower === '.fromstart' || lower === '.begin' ||
      lower === '.сначала' || lower === 'сначала'
    ) {
      this.setAnnounce(say)
      this.restart({ resetCamera: false })
      return true
    }

    const speedM = lower.match(/^\.(?:speed|spd|s)\s+([\d.]+)$/)
    if (speedM) {
      const r = this.setSpeed(speedM[1])
      say(r.ok ? `§a[Replay] §f${r.speed}x` : `§c[Replay] ${r.error}`)
      return true
    }
    if (lower === '.speed' || lower === '.spd') {
      say(`§e[Replay] §f${this.speed}x`)
      return true
    }

    const seekM = lower.match(/^\.(?:seek|skip)\s+([+-]?\d+(?:\.\d+)?)\s*(s|ms|m)?$/)
    if (seekM) {
      let v = Number(seekM[1])
      const unit = seekM[2] || 's'
      if (unit === 'm') v *= 60000
      else if (unit === 'ms') { /* already ms */ }
      else v *= 1000
      this.seek(v).then((r) => {
        if (r.queued) return
        if (r.ok) say(`§a[Replay] §f${fmtTime(r.t)}${r.paused ? ' §7пауза' : ''}`)
        else say(`§c[Replay] ${r.error}`)
      })
      return true
    }

    const gotoM = lower.match(/^\.(?:goto|gt)\s+(.+)$/)
    if (gotoM) {
      const ms = parseTimeArg(gotoM[1])
      if (ms == null) {
        say('§c[Replay] .goto 1:23')
        return true
      }
      this.goto(ms).then((r) => {
        if (r.queued) return
        if (r.ok) say(`§a[Replay] §f${fmtTime(r.t)}${r.paused ? ' §7пауза' : ''}`)
        else say(`§c[Replay] ${r.error}`)
      })
      return true
    }

    if (lower === '.time' || lower === '.t' || lower === '.now') {
      const s = this.snapshot()
      say(`§e[Replay] §f${fmtTime(s.t)}§7/§f${fmtTime(s.durationMs)} §7${s.speed}x${s.paused ? ' §c❚❚' : ''}`)
      return true
    }

    return false
  }
}

export function fmtTime (ms) {
  const t = Math.max(0, Math.floor(Number(ms) || 0) / 1000)
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  const frac = Math.floor((Number(ms) || 0) % 1000 / 100)
  return `${m}:${String(s).padStart(2, '0')}.${frac}`
}

/** "90", "90s", "1:23", "1:23.5" → ms */
export function parseTimeArg (raw) {
  if (raw == null) return null
  const s = String(raw).trim().toLowerCase()
  if (!s) return null
  if (/^\d+(\.\d+)?ms$/.test(s)) return Number(s.replace('ms', ''))
  if (/^\d+(\.\d+)?s$/.test(s)) return Number(s.replace('s', '')) * 1000
  if (/^\d+(\.\d+)?m$/.test(s)) return Number(s.replace('m', '')) * 60000
  const colon = s.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/)
  if (colon) {
    const min = Number(colon[1])
    const sec = Number(colon[2])
    const frac = colon[3] ? Number(`0.${colon[3]}`) : 0
    return (min * 60 + sec + frac) * 1000
  }
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000
  return null
}
