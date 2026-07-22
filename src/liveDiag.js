/**
 * LIVE session diagnostics — make the next kick self-explanatory in hub.log.
 * Answers: event-loop stall? mega copy? auth_input starved? upstream silent?
 */

export function createLiveDiag (label = 'live') {
  const state = {
    label,
    t0: Date.now(),
    /** @type {ReturnType<typeof setInterval> | null} */
    lagTimer: null,
    lagMaxMs: 0,
    lagLastMs: 0,
    lagOver50: 0,
    lagOver200: 0,
    // rolling 1s window (clientbound / upstream→client)
    winT0: Date.now(),
    winPkts: 0,
    winBytes: 0,
    winMaxLen: 0,
    winMaxMs: 0,
    winSlow: 0,
    // lifetime
    upPkts: 0,
    upBytes: 0,
    maxPkt: 0,
    maxHandlerMs: 0,
    slowN: 0,
    lastUpAt: 0,
    lastSbAt: 0,
    lastSbName: '',
    lastCbName: '',
    lastCbAt: 0,
    hopN: 0,
    lastHopAt: 0,
    quietUntil: 0,
    // last closed window snapshot (for kick summary)
    lastWin: null
  }

  const flushWin = (forceLog = false) => {
    const now = Date.now()
    const dt = Math.max(1, now - state.winT0)
    if (state.winPkts === 0 && !forceLog) {
      state.winT0 = now
      return
    }
    const snap = {
      dt,
      pkts: state.winPkts,
      bytes: state.winBytes,
      maxLen: state.winMaxLen,
      maxMs: state.winMaxMs,
      slow: state.winSlow,
      pps: Math.round(state.winPkts * 1000 / dt),
      MBps: +(state.winBytes / 1024 / 1024 * 1000 / dt).toFixed(2)
    }
    state.lastWin = snap
    const busy = snap.maxMs >= 25 || snap.maxLen >= 500000 || snap.MBps >= 8 || snap.slow > 0
    if (busy || forceLog) {
      console.log(
        `[DIAG] win ${snap.dt}ms pkts=${snap.pkts} pps≈${snap.pps} ` +
        `${snap.MBps}MB/s maxLen=${snap.maxLen} maxHandler=${snap.maxMs}ms slow=${snap.slow} ` +
        `lag=${state.lagLastMs}ms(max ${state.lagMaxMs})`
      )
    }
    state.winT0 = now
    state.winPkts = 0
    state.winBytes = 0
    state.winMaxLen = 0
    state.winMaxMs = 0
    state.winSlow = 0
  }

  const start = () => {
    if (state.lagTimer) return
    let expected = Date.now() + 250
    let lastLagLog = 0
    // Mobile hub.log is appendFileSync — spam makes handshake stall worse.
    const lagLogEveryMs = process.env.BEDROCK_REPLAY_MOBILE === '1' ? 2000 : 500
    const lagWarnMs = process.env.BEDROCK_REPLAY_MOBILE === '1' ? 400 : 200
    state.lagTimer = setInterval(() => {
      const now = Date.now()
      const lag = Math.max(0, now - expected)
      expected = now + 250
      state.lagLastMs = lag
      if (lag > state.lagMaxMs) state.lagMaxMs = lag
      if (lag >= 50) state.lagOver50++
      if (lag >= 200) state.lagOver200++
      if (lag >= lagWarnMs && now - lastLagLog >= lagLogEveryMs) {
        lastLagLog = now
        console.warn(`[DIAG] event-loop lag ${lag}ms (max ${state.lagMaxMs})`)
      }
      if (now - state.winT0 >= 1000) flushWin(false)
    }, 250)
    if (typeof state.lagTimer.unref === 'function') state.lagTimer.unref()
  }

  const stop = () => {
    if (state.lagTimer) {
      clearInterval(state.lagTimer)
      state.lagTimer = null
    }
    flushWin(false)
  }

  /** Call around upstream→client handling (ms spent in one readUpstream). */
  const noteUpstream = (len, handlerMs, meta = {}) => {
    const now = Date.now()
    const n = Number(len) || 0
    const ms = Math.max(0, Number(handlerMs) || 0)
    state.upPkts++
    state.upBytes += n
    state.lastUpAt = now
    if (n > state.maxPkt) state.maxPkt = n
    if (ms > state.maxHandlerMs) state.maxHandlerMs = ms
    state.winPkts++
    state.winBytes += n
    if (n > state.winMaxLen) state.winMaxLen = n
    if (ms > state.winMaxMs) state.winMaxMs = ms
    if (ms >= 25 || n >= 500000) {
      state.slowN++
      state.winSlow++
      console.warn(
        `[DIAG] SLOW up handler ${ms}ms len=${n}` +
        (meta.id != null ? ` id=${meta.id}` : '') +
        (meta.path ? ` path=${meta.path}` : '')
      )
    }
    if (now - state.winT0 >= 1000) flushWin(false)
  }

  const noteServerbound = (name) => {
    state.lastSbAt = Date.now()
    state.lastSbName = name || ''
  }

  const noteClientbound = (name) => {
    state.lastCbAt = Date.now()
    state.lastCbName = name || ''
  }

  const noteHop = () => {
    state.hopN++
    state.lastHopAt = Date.now()
    console.log(`[DIAG] hop #${state.hopN} — resetting lag window`)
    state.lagMaxMs = 0
    state.lagOver50 = 0
    state.lagOver200 = 0
    flushWin(true)
  }

  const noteQuiet = (until) => {
    state.quietUntil = Number(until) || 0
  }

  const classify = () => {
    const now = Date.now()
    const sbAgo = state.lastSbAt ? now - state.lastSbAt : -1
    const cbAgo = state.lastCbAt ? now - state.lastCbAt : -1
    const upAgo = state.lastUpAt ? now - state.lastUpAt : -1
    const hopAgo = state.lastHopAt ? now - state.lastHopAt : -1
    const quiet = state.quietUntil > now
    const win = state.lastWin

    let verdict = 'UNKNOWN'
    let why = 'no strong signal'

    if (state.lagMaxMs >= 200 || state.lagOver200 > 0) {
      verdict = 'EVENT_LOOP_STALL'
      why = `lagMax=${state.lagMaxMs}ms maxHandler=${state.maxHandlerMs}ms slowN=${state.slowN}`
    } else if (state.maxPkt >= 1000000 && state.maxHandlerMs >= 40 && hopAgo >= 0 && hopAgo < 3000) {
      verdict = 'MEGA_COPY_STALL'
      why = `maxPkt=${state.maxPkt} maxHandler=${state.maxHandlerMs}ms (near hop)`
    } else if (state.maxHandlerMs >= 80 && state.lagMaxMs >= 50) {
      verdict = 'EVENT_LOOP_STALL'
      why = `lagMax=${state.lagMaxMs}ms maxHandler=${state.maxHandlerMs}ms slowN=${state.slowN}`
    } else if (sbAgo > 1500 && (cbAgo >= 0 && cbAgo < 800 || upAgo >= 0 && upAgo < 800)) {
      verdict = 'SB_STARVED'
      why = `sbAgo=${sbAgo}ms while traffic still arriving (cbAgo=${cbAgo} upAgo=${upAgo}) — auth_input not reaching GamePE in time`
    } else if (upAgo > 2500 && sbAgo > 2500) {
      verdict = 'BOTH_SILENT'
      why = `no up/sb for >2.5s before close (upAgo=${upAgo} sbAgo=${sbAgo})`
    } else if (hopAgo >= 0 && hopAgo < 15000 && state.lagMaxMs < 100 && state.maxHandlerMs < 40) {
      verdict = 'REMOTE_OR_OTHER'
      why = `hop ${hopAgo}ms ago, loop looked OK (lagMax=${state.lagMaxMs}) — suspect remote drop or non-parse bottleneck`
    }

    if (quiet && verdict === 'SB_STARVED') {
      why += ' | dim-hop quiet was ON (we throttle auth_input)'
    }

    return {
      verdict,
      why,
      sbAgo,
      cbAgo,
      upAgo,
      hopAgo,
      quiet,
      win,
      lagMaxMs: state.lagMaxMs,
      maxPkt: state.maxPkt,
      maxHandlerMs: state.maxHandlerMs,
      slowN: state.slowN,
      upPkts: state.upPkts,
      hopN: state.hopN
    }
  }

  const dumpKick = (reason = 'disconnect') => {
    flushWin(true)
    const c = classify()
    console.error(
      `[DIAG] ===== KICK SUMMARY (${reason}) =====\n` +
      `[DIAG] verdict=${c.verdict}\n` +
      `[DIAG] why: ${c.why}\n` +
      `[DIAG] lagMax=${c.lagMaxMs}ms maxHandler=${c.maxHandlerMs}ms maxPkt=${c.maxPkt} slowN=${c.slowN} upPkts=${c.upPkts} hops=${c.hopN}\n` +
      `[DIAG] ago: sb=${c.sbAgo}ms (${state.lastSbName || '-'}) cb=${c.cbAgo}ms (${state.lastCbName || '-'}) up=${c.upAgo}ms hop=${c.hopAgo}ms quiet=${c.quiet}\n` +
      `[DIAG] lastWin: ${c.win ? `pkts=${c.win.pkts} ${c.win.MBps}MB/s maxLen=${c.win.maxLen} maxMs=${c.win.maxMs}` : 'none'}\n` +
      `[DIAG] ===============================`
    )
    return c
  }

  return {
    start,
    stop,
    noteUpstream,
    noteServerbound,
    noteClientbound,
    noteHop,
    noteQuiet,
    dumpKick,
    classify,
    state
  }
}
