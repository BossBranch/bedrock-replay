/**
 * Time index + seek anchors for seamless catch-up replay.
 *
 * Only reads `t` / `type` / `n` — safe with spilled packet bodies
 * (see loadTimelineStreaming): seek catch-up loads `.p` on demand.
 */

/**
 * @param {Array<{ t?: number, type?: string, n?: string }>} events absolute-t events (full queue or slice with original t)
 * @param {number} startIdx index in events where playback starts
 */
export function buildSeekIndex (events, startIdx = 0) {
  const anchors = []
  for (let i = startIdx; i < events.length; i++) {
    const e = events[i]
    if (!e) continue
    if (e.type === 'pkt' && e.n === 'start_game') {
      anchors.push({ i, t: e.t || 0, kind: 'start_game' })
    } else if (e.type === 'mark' && (e.n === 'checkpoint' || e.n === 'after_transfer' || e.n === 'transfer')) {
      // transfer itself is weak; checkpoint / after_transfer are better
      if (e.n === 'transfer') continue
      anchors.push({ i, t: e.t || 0, kind: e.n })
    }
  }
  // Always include start as anchor
  if (!anchors.length || anchors[0].i !== startIdx) {
    anchors.unshift({ i: startIdx, t: events[startIdx]?.t || 0, kind: 'slice_start' })
  }
  anchors.sort((a, b) => a.t - b.t || a.i - b.i)
  // Dedupe same index
  const uniq = []
  const seen = new Set()
  for (const a of anchors) {
    if (seen.has(a.i)) continue
    seen.add(a.i)
    uniq.push(a)
  }

  const t0 = events[startIdx]?.t || 0
  const tEnd = events.length ? (events[events.length - 1].t || t0) : t0

  return {
    startIdx,
    t0,
    tEnd,
    durationMs: Math.max(0, tEnd - t0),
    anchors: uniq,
    /** Absolute event time → media ms from slice start */
    toMedia (absT) {
      return Math.max(0, (absT || 0) - t0)
    },
    /** Media ms → absolute event time */
    toAbs (mediaMs) {
      return t0 + Math.max(0, mediaMs || 0)
    },
    findIndexAtAbs (absT) {
      // last event with t <= absT in [startIdx, end)
      let lo = startIdx
      let hi = events.length - 1
      let ans = startIdx
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const t = events[mid]?.t ?? 0
        if (t <= absT) {
          ans = mid
          lo = mid + 1
        } else hi = mid - 1
      }
      return ans
    },
    findIndexAtMedia (mediaMs) {
      return this.findIndexAtAbs(this.toAbs(mediaMs))
    },
    /** Nearest anchor with t <= absT (and i <= targetIdx ideally) */
    findAnchorAtAbs (absT) {
      let best = uniq[0]
      for (const a of uniq) {
        if (a.t <= absT) best = a
        else break
      }
      return best
    }
  }
}
