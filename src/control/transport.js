/**
 * Replay clock + event pump with pause / speed / seek-to.
 */

import { softResetClient, clearSeekTitle } from '../seek/reset.js'

function sleep (ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)))
}

export class ReplayTransport {
  /**
   * @param {{
   *   events: object[],
   *   seekIndex: object,
   *   client: object,
   *   onEvent: (ev: object, meta: { catchingUp: boolean }) => Promise<void>|void,
   *   getTracked?: () => { runtimeIds: any[], uniqueIds: any[] },
   *   onBeforeSeek?: () => void,
   *   onAfterSeek?: () => void,
   *   closeForms?: Function,
   *   say?: Function,
   *   localRuntimeId?: any,
   *   plane?: import('./plane.js').ControlPlane
   * }} opts
   */
  constructor (opts) {
    this.events = opts.events
    this.seekIndex = opts.seekIndex
    this.client = opts.client
    this.onEvent = opts.onEvent
    this.getTracked = opts.getTracked || (() => ({ runtimeIds: [], uniqueIds: [] }))
    this.onBeforeSeek = opts.onBeforeSeek || (() => {})
    this.onAfterSeek = opts.onAfterSeek || (() => {})
    this.closeForms = opts.closeForms
    this.say = opts.say
    this.localRuntimeId = opts.localRuntimeId
    this.plane = opts.plane

    this.index = opts.seekIndex.startIdx
    this._speed = opts.plane?.speed ?? 1
    this._paused = false
    this._baseMedia = 0
    this._wallAnchor = Date.now()
    this._running = false
    this._aborted = false
    this._seeking = false
    this._seekGen = 0
    this._queuedSeekMedia = null
    this._queuedResetCamera = false
    this._resetCamera = false
    this.onAbsorbStartGame = opts.onAbsorbStartGame || null
    /** If true, goto/seek must not re-pause after user already hit resume */
    this._resumeAfterSeek = false
    this._atEnd = false
  }

  mediaTime () {
    let t
    if (this._paused || this._seeking) t = this._baseMedia
    else t = this._baseMedia + (Date.now() - this._wallAnchor) * this._speed
    const dur = this.seekIndex.durationMs || 0
    if (dur > 0 && t > dur) t = dur
    return t
  }

  _snapClock () {
    if (!this._paused && !this._seeking) {
      this._baseMedia = this._baseMedia + (Date.now() - this._wallAnchor) * this._speed
    }
    const dur = this.seekIndex.durationMs || 0
    if (dur > 0 && this._baseMedia > dur) this._baseMedia = dur
    this._wallAnchor = Date.now()
  }

  _logCursor (tag) {
    const mt = this.mediaTime()
    const next = this.events[this.index]
    const nextMedia = next ? this.seekIndex.toMedia(next.t || 0) : null
    const delta = nextMedia != null ? (nextMedia - mt) : null
    console.log(
      `[transport] ${tag} media=${(mt / 1000).toFixed(2)}s idx=${this.index}/${this.events.length}` +
      ` paused=${this._paused} seeking=${this._seeking} speed=${this._speed}` +
      (next
        ? ` next=${next.type === 'pkt' ? next.n : next.type} Δ=${delta != null ? delta.toFixed(0) : '?'}ms`
        : ' next=END')
    )
  }

  onPause () {
    this._snapClock()
    this._paused = true
    this._resumeAfterSeek = false
  }

  onResume () {
    // At true end: resume must NOT free-run the clock (that inflated .seek -N)
    if (this.index >= this.events.length) {
      this._paused = true
      this._baseMedia = this.seekIndex.durationMs || this._baseMedia
      this._wallAnchor = Date.now()
      if (this.plane) {
        this.plane.paused = true
        this.plane.status = 'ended'
      }
      try { this.say?.('§e[Replay] Конец') } catch {}
      this._logCursor('resume-at-end(ignored)')
      return
    }
    this._resumeAfterSeek = true
    this._atEnd = false
    this._paused = false
    this._seeking = false
    this._wallAnchor = Date.now()
    if (this.index > this.events.length) this.index = this.events.length
    if (this.plane) {
      this.plane.paused = false
      this.plane.status = 'playing'
    }
    this._logCursor('resume')
  }

  onSpeed (speed) {
    this._snapClock()
    this._speed = speed
  }

  abort () {
    this._aborted = true
  }

  /**
   * .restart without moving freecam.
   * Zero client packets at restart time (no remove_entity / gamemode / titles).
   */
  /**
   * @param {{ pause?: boolean }} [opts] pause=true (default) leave paused at 0:00
   */
  async restartKeepCamera (opts = {}) {
    if (this._seeking) {
      return { ok: false, error: 'busy' }
    }
    const stayPaused = opts.pause !== false
    this._seekGen += 1
    this._seeking = true
    this._resumeAfterSeek = false
    this._resetCamera = false
    this._atEnd = false

    try {
      this._snapClock()
      this._paused = stayPaused
      this._baseMedia = 0
      this._wallAnchor = Date.now()

      if (this.plane) {
        this.plane.paused = stayPaused
        this.plane.status = stayPaused ? 'paused' : 'playing'
        this.plane.t = 0
      }

      // State-only reset — do not write anything to the client (keeps freecam rock-steady)
      this.onBeforeSeek({ resetCamera: false, liteRestart: true, silent: true })

      this.index = this.seekIndex.startIdx
      let skippedSg = 0
      while (this.index < this.events.length) {
        const ev = this.events[this.index]
        if (ev?.type === 'pkt' && ev.n === 'start_game') {
          // Update ids in memory only — never write start_game / spawnGhost
          if (typeof this.onAbsorbStartGame === 'function') {
            this.onAbsorbStartGame(ev)
          }
          this.index++
          skippedSg++
          continue
        }
        break
      }

      this.onAfterSeek({ resetCamera: false, liteRestart: true, silent: true })
      console.log(
        `[transport] restartKeepCamera t=0 idx=${this.index}/${this.events.length} ` +
        `skippedStartGame=${skippedSg} (no client packets)`
      )
      this._logCursor('restart keep-cam')
      return { ok: true }
    } finally {
      this._seeking = false
    }
  }

  /**
   * @param {number} mediaMs
   * @param {{ autoPause?: boolean, resetCamera?: boolean }} [opts]
   */
  async seekTo (mediaMs, opts = {}) {
    const targetMedia = Math.max(0, Math.min(this.seekIndex.durationMs || 0, mediaMs))
    if (this._seeking) {
      this._queuedSeekMedia = targetMedia
      this._queuedResetCamera = !!opts.resetCamera
      return
    }

    this._resumeAfterSeek = false
    this._snapClock()
    this._seeking = true
    this._seekGen += 1
    this._atEnd = false
    this._resetCamera = !!opts.resetCamera
    const myGen = this._seekGen
    // Freeze play loop immediately
    const autoPause = opts.autoPause !== false

    try {
      let goal = targetMedia
      let lastGoal = targetMedia
      let resetCam = this._resetCamera
      while (goal != null) {
        this._queuedSeekMedia = null
        lastGoal = goal
        this._resetCamera = resetCam
        await this._seekOnce(goal)
        if (this._seekGen !== myGen) return
        if (this._queuedSeekMedia != null) {
          goal = this._queuedSeekMedia
          resetCam = !!this._queuedResetCamera
          this._queuedResetCamera = false
        } else {
          goal = null
        }
      }
      this._baseMedia = lastGoal
      this._wallAnchor = Date.now()
      // index already at targetIdx+1 from _seekOnce — don't jump with resync that can desync
      this._logCursor('seek done')
    } finally {
      // If user already pressed resume during catch-up, honor that
      const shouldPause = autoPause && !this._resumeAfterSeek
      if (shouldPause) {
        this._paused = true
        if (this.plane) {
          this.plane.paused = true
          this.plane.status = 'paused'
          this.plane.seeking = false
        }
      } else {
        this._paused = false
        this._wallAnchor = Date.now()
        if (this.plane) {
          this.plane.paused = false
          this.plane.status = 'playing'
          this.plane.seeking = false
        }
      }
      this._seeking = false
      this._queuedSeekMedia = null
      this._queuedResetCamera = false
      if (shouldPause && this.plane) {
        try { this.plane._emit?.('pause') } catch {}
      }
    }
  }

  async _seekOnce (targetMedia) {
    const absT = this.seekIndex.toAbs(targetMedia)
    const targetIdx = this.seekIndex.findIndexAtAbs(absT)
    const anchor = this.seekIndex.findAnchorAtAbs(absT)

    const goingBack = targetMedia < this._baseMedia - 0.5
    const atStart = targetMedia <= 0.5
    const forwardSameRegion =
      !goingBack &&
      !atStart &&
      this.index <= targetIdx &&
      this.index >= anchor.i

    let fromIdx = anchor.i
    if (forwardSameRegion) {
      fromIdx = this.index
    } else {
      const tracked = this.getTracked()
      softResetClient(this.client, {
        trackedRuntimeIds: tracked.runtimeIds,
        trackedUniqueIds: tracked.uniqueIds,
        keepGhost: false,
        localRuntimeId: this.localRuntimeId,
        say: this.say,
        closeForms: this.closeForms,
        // keep-cam: no title spam; only strip entities — world chunks stay
        quiet: !this._resetCamera
      })
      this.onBeforeSeek({ resetCamera: !!this._resetCamera })
      // MUST replay from slice start — checkpoints are after the initial
      // add_player / add_item_entity flush, so catching up from a checkpoint
      // leaves the world empty (or with leftover untracked drops).
      fromIdx = this.seekIndex.startIdx
      console.log(
        `[transport] seek catch-up from slice_start idx=${fromIdx} → ${targetIdx}` +
        ` (anchor was ${anchor.kind}@${anchor.i})`
      )
    }

    this.index = fromIdx
    let burst = 0
    while (this.index <= targetIdx && this.index < this.events.length) {
      if (this.client.status === 0 || this._aborted) break
      await this.onEvent(this.events[this.index], {
        catchingUp: true,
        resetCamera: !!this._resetCamera,
        keepCamera: !this._resetCamera
      })
      this.index++
      burst++
      if (burst % 80 === 0) await sleep(0)
    }

    this._baseMedia = targetMedia
    this._wallAnchor = Date.now()
    this.index = Math.min(this.events.length, targetIdx + 1)
    clearSeekTitle(this.client)
    this.onAfterSeek({ resetCamera: !!this._resetCamera })
  }

  /** Bedrock kicks idle spectators — trickle CB packets while paused / at end. */
  _sendKeepalive () {
    const c = this.client
    if (!c || c.status === 0) return
    try {
      c.queue?.('network_stack_latency', {
        timestamp: Date.now(),
        from_server: true
      })
    } catch {}
    try {
      const t = Date.now()
      c.queue?.('tick_sync', { request_time: t, response_time: t })
    } catch {}
  }

  async _waitWhile (pred, intervalMs) {
    let lastKa = 0
    while (pred() && !this._aborted && this.client.status !== 0) {
      const now = Date.now()
      if (now - lastKa > 2000) {
        lastKa = now
        this._sendKeepalive()
      }
      await sleep(intervalMs)
    }
  }

  /**
   * Stays alive until disconnect — survives end-of-timeline + later seek/restart.
   */
  async run () {
    this._running = true
    this._aborted = false
    this._wallAnchor = Date.now()
    this._baseMedia = 0
    this.index = this.seekIndex.startIdx
    this.plane?.setStatus('playing')
    this._logCursor('run start')

    let lastBeat = Date.now()

    while (!this._aborted && this.client.status !== 0) {
      if (this._paused || this._seeking) {
        await this._waitWhile(() => this._paused || this._seeking, 40)
      }
      if (this._aborted || this.client.status === 0) break

      // End of timeline: wait for seek/restart instead of exiting
      if (this.index >= this.events.length) {
        this._atEnd = true
        this.plane?.setStatus('ended')
        // Pin clock to exact duration — never keep free-running past the end
        this._baseMedia = this.seekIndex.durationMs || this._baseMedia
        this._wallAnchor = Date.now()
        this._paused = true
        this._resumeAfterSeek = false
        if (this.plane) {
          this.plane.paused = true
          this.plane.status = 'ended'
          this.plane.t = this._baseMedia
        }
        console.log('[transport] reached end — paused. .restart / .seek to continue')
        await this._waitWhile(() => this.index >= this.events.length, 100)
        if (this._aborted || this.client.status === 0) break
        this._atEnd = false
        if (!this._paused) this.plane?.setStatus('playing')
        continue
      }

      const gen = this._seekGen
      const media = this.mediaTime()
      const absLimit = this.seekIndex.toAbs(media)
      let sentBurst = 0

      while (
        this.index < this.events.length &&
        (this.events[this.index].t || 0) <= absLimit + 0.5
      ) {
        if (this.client.status === 0 || this._aborted) break
        if (this._paused || this._seeking || this._seekGen !== gen) break

        const ev = this.events[this.index]
        await this.onEvent(ev, { catchingUp: false })
        this.index++
        sentBurst++
        // One cam per pump slice — bursting densified cams = teleport "обрывки".
        // Do NOT sleep here: wall clock still runs → artificial lag (= "slow jump" in .me).
        if (ev.type === 'cam') break
        if (sentBurst % 40 === 0) await sleep(0)
      }

      if (this._seekGen !== gen) continue
      if (this.client.status === 0 || this._aborted) break

      if (Date.now() - lastBeat > 3000 && !this._paused) {
        lastBeat = Date.now()
        this._logCursor('beat')
      }

      if (this.index >= this.events.length) continue

      const nextT = this.events[this.index].t || 0
      const nextMedia = this.seekIndex.toMedia(nextT)
      const wallWait = (nextMedia - this.mediaTime()) / Math.max(this._speed, 0.05)
      if (wallWait > 1) await sleep(Math.min(wallWait, 16))
      else await sleep(0)
    }

    return { aborted: this.client.status === 0 || this._aborted, index: this.index }
  }
}
