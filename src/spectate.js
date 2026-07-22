/**
 * Spectator camera — freecam / .me / .spec / .next.
 * .me default = mePaths P1 (adventure+fly). Optional `.mepath 0|1`.
 */

import { GHOST_RUNTIME_ID } from './ghost.js'
import {
  clampMePath,
  ME_PATH_LABELS,
  ME_PATH_MAX,
  ME_COMMITTED_ME_PATH
} from './mePaths.js'

function stripFmt (s) {
  return String(s || '').replace(/§./g, '').trim()
}

function normName (s) {
  return stripFmt(s).toLowerCase()
}

function lerpYaw (from, to, a) {
  const d = ((to - from + 540) % 360) - 180
  return from + d * a
}

/** Unit look vector from Bedrock pitch/yaw (degrees). */
function lookDir (pitch, yaw) {
  const p = (Number(pitch) || 0) * Math.PI / 180
  const y = (Number(yaw) || 0) * Math.PI / 180
  const cosP = Math.cos(p)
  return {
    x: -Math.sin(y) * cosP,
    y: -Math.sin(p),
    z: Math.cos(y) * cosP
  }
}

export class SpectateController {
  /**
   * @param {{
   *   sendLocalMove: Function,
   *   say: Function,
   *   setGhostVisible?: Function,
   *   setEntityVisible?: Function,
   *   onWatchStart?: Function,
   *   onWatchEnd?: Function,
   *   onMeEquipHeld?: Function,
   *   onMePathApply?: Function,
   *   onMePathReset?: Function
   * }} hooks
   * @param {{
   *   otherEyeOffset?: number,
   *   otherForwardOffset?: number,
   *   otherPitchBias?: number,
   *   otherYawBias?: number,
   *   tickMs?: number,
   *   smooth?: number,
   *   hideTargetOnFollow?: boolean,
   *   hideSelfOnPossess?: boolean
   * }} opts
   */
  constructor (hooks, opts = {}) {
    this.sendLocalMove = hooks.sendLocalMove
    this.say = hooks.say
    this.setGhostVisible = hooks.setGhostVisible || (() => {})
    this.setEntityVisible = hooks.setEntityVisible || (() => {})
    this.onWatchStart = hooks.onWatchStart || (() => {})
    this.onWatchEnd = hooks.onWatchEnd || (() => {})
    this.onMeEquipHeld = hooks.onMeEquipHeld || (() => {})
    this.onMePathApply = hooks.onMePathApply || (() => {})
    this.onMePathReset = hooks.onMePathReset || (() => {})
    this.otherEyeOffset = opts.otherEyeOffset ?? 0.10
    this.otherForwardOffset = opts.otherForwardOffset ?? 0.14
    this.otherPitchBias = opts.otherPitchBias ?? 0
    this.otherYawBias = opts.otherYawBias ?? 0
    this.hideTargetOnFollow = opts.hideTargetOnFollow ??
      (opts.hideSelfOnPossess !== false)
    this.tickMs = opts.tickMs ?? 16
    /** 0..1 per tick — .spec others only (config: spectateSmooth) */
    this.smooth = Math.min(1, Math.max(0.05, opts.smooth ?? 0.38))
    this.lookSmooth = Math.min(1, this.smooth * 2.6)
    /** false on pre-1.19.50 (adventure freecam only) */
    this.possessEnabled = opts.possessEnabled !== false
    /** @type {'free'|'follow'} */
    this.mode = 'free'
    this.targetKey = null
    /** @type {Map<string, object>} */
    this.entities = new Map()
    this._cycle = []
    this.cam = null
    this._timer = null
    this._ghostHidden = false
    this._hiddenRid = null
    this._hidePulse = 0
    this._lastSendAt = 0
    this.mePathId = ME_COMMITTED_ME_PATH.pathId
    this._meActive = false
  }

  upsert ({ key, name, runtimeId, uniqueId, uuid, x, y, z, pitch, yaw, head_yaw, isGhost = false }) {
    const prev = this.entities.get(key) || {}
    const ent = {
      key,
      name: name != null ? stripFmt(name) : (prev.name || key),
      runtimeId: runtimeId ?? prev.runtimeId,
      uniqueId: uniqueId ?? prev.uniqueId,
      uuid: uuid ?? prev.uuid,
      x: x ?? prev.x ?? 0,
      y: y ?? prev.y ?? 0,
      z: z ?? prev.z ?? 0,
      pitch: pitch ?? prev.pitch ?? 0,
      yaw: yaw ?? prev.yaw ?? 0,
      head_yaw: head_yaw ?? prev.head_yaw ?? yaw ?? prev.yaw ?? 0,
      isGhost: isGhost || prev.isGhost || false
    }
    this.entities.set(key, ent)
    this._rebuildCycle()
    // .me: lock cam 1:1 (EMA feels like slow-mo jumps)
    if (this.mode === 'follow' && this.targetKey === key && ent.isGhost) {
      const d = this._desiredFrom(ent)
      if (d) {
        this.cam = { ...d }
        try { this.sendLocalMove(this.cam) } catch {}
        this._lastSendAt = Date.now()
      }
    }
    return ent
  }

  removeByRuntime (runtimeId) {
    const rid = String(runtimeId)
    for (const [k, e] of this.entities) {
      if (String(e.runtimeId) === rid) {
        this.entities.delete(k)
        if (this.targetKey === k) {
          this.say('§e[Spec] Target left — holding last pose')
        }
        this._rebuildCycle()
        return
      }
    }
  }

  removeByUnique (uniqueId) {
    const uid = String(uniqueId)
    for (const [k, e] of this.entities) {
      if (String(e.uniqueId) === uid) {
        this.entities.delete(k)
        if (this.targetKey === k) {
          this.say('§e[Spec] Target left — holding last pose')
        }
        this._rebuildCycle()
        return
      }
    }
  }

  _rebuildCycle () {
    this._cycle = [...this.entities.values()]
      .filter((e) => e.name)
      .sort((a, b) => {
        if (a.isGhost && !b.isGhost) return -1
        if (!a.isGhost && b.isGhost) return 1
        return a.name.localeCompare(b.name)
      })
      .map((e) => e.key)
  }

  list () {
    return this._cycle.map((k) => this.entities.get(k)).filter(Boolean)
  }

  getMePathId () {
    return this.mePathId
  }

  /** P0 = spectator baseline, P1 = committed adventure+fly */
  setMePath (pathId, announce = true) {
    this.mePathId = clampMePath(pathId)
    if (announce) {
      this.say(`§e[Me] §f${ME_PATH_LABELS[this.mePathId]}`)
    }
    const ent = this.getTargetEntity()
    if (this.mode === 'follow' && ent?.isGhost) {
      try { this.onMePathReset() } catch {}
      this._activateMe()
      this.snapToTarget(true)
    }
    return this.mePathId
  }

  sayMePathList () {
    this.say(`§e[Me] сейчас §fP${this.mePathId}`)
    for (let i = 0; i <= ME_PATH_MAX; i++) {
      const mark = i === this.mePathId ? '§a>' : '§8 '
      this.say(`${mark} §f.mepath ${i} §7${ME_PATH_LABELS[i].replace(/^\d+\s/, '')}`)
    }
  }

  _activateMe () {
    this._meActive = true
    try { this.onMePathApply(this.mePathId) } catch {}
    if (this.mePathId > 0) {
      try { this.onMeEquipHeld() } catch {}
    }
  }

  _deactivateMe () {
    if (!this._meActive) {
      try { this.onMePathReset() } catch {}
      return
    }
    this._meActive = false
    try { this.onMePathReset() } catch {}
  }

  /**
   * .me (ghost): raw recorded cam.
   * Others: body + small eye/forward offsets.
   */
  _desiredFrom (t) {
    if (!t || t.x == null) return null

    if (t.isGhost) {
      return {
        x: t.x,
        y: t.y ?? 0,
        z: t.z,
        pitch: t.pitch ?? 0,
        yaw: t.yaw ?? 0,
        head_yaw: t.head_yaw ?? t.yaw ?? 0
      }
    }

    let pitch = (t.pitch ?? 0) + this.otherPitchBias
    let yaw = (t.head_yaw ?? t.yaw ?? 0) + this.otherYawBias
    const headYaw = t.head_yaw ?? yaw
    const eye = this.otherEyeOffset
    const f = this.otherForwardOffset
    const dir = lookDir(pitch, yaw)
    return {
      x: t.x + dir.x * f,
      y: (t.y ?? 0) + eye + dir.y * f,
      z: t.z + dir.z * f,
      pitch,
      yaw,
      head_yaw: headYaw
    }
  }

  _desired () {
    return this._desiredFrom(this.entities.get(this.targetKey))
  }

  _emitDisplay () {
    const d = this._desired()
    if (!d) {
      if (this.cam) {
        try { this.sendLocalMove(this.cam) } catch {}
      }
      return
    }
    const ent = this.getTargetEntity()
    if (ent?.isGhost) {
      this.cam = { ...d }
      try { this.sendLocalMove(this.cam) } catch {}
      this._lastSendAt = Date.now()
      return
    }
    if (!this.cam) {
      this.cam = { ...d }
      try { this.sendLocalMove(this.cam) } catch {}
      this._lastSendAt = Date.now()
      return
    }

    const a = this.smooth
    const la = this.lookSmooth
    this.cam = {
      x: this.cam.x + (d.x - this.cam.x) * a,
      y: this.cam.y + (d.y - this.cam.y) * a,
      z: this.cam.z + (d.z - this.cam.z) * a,
      pitch: this.cam.pitch + (d.pitch - this.cam.pitch) * la,
      yaw: lerpYaw(this.cam.yaw, d.yaw, la),
      head_yaw: lerpYaw(this.cam.head_yaw, d.head_yaw, la)
    }
    try { this.sendLocalMove(this.cam) } catch {}
    this._lastSendAt = Date.now()
  }

  /**
   * @param {boolean} [force] true = hard snap. false = only if drifted far.
   */
  snapToTarget (force = true) {
    if (this.mode !== 'follow') return
    const d = this._desired()
    if (!d) {
      if (this.cam) {
        try { this.sendLocalMove(this.cam) } catch {}
      }
      return
    }
    if (!force && this.cam) {
      const dx = d.x - this.cam.x
      const dy = d.y - this.cam.y
      const dz = d.z - this.cam.z
      if (dx * dx + dy * dy + dz * dz < 2.25) return
    }
    this.cam = { ...d }
    try { this.sendLocalMove(this.cam) } catch {}
    this._lastSendAt = Date.now()
  }

  getHiddenRuntimeId () {
    return this._hiddenRid
  }

  isPossessing () {
    // FPV item remap while on .me with P1 (not spectator baseline P0)
    return !!(
      this.mode === 'follow' &&
      this._meActive &&
      this.getTargetEntity()?.isGhost &&
      this.mePathId > 0
    )
  }

  isFollowing () {
    return this.mode === 'follow'
  }

  getTargetEntity () {
    if (!this.targetKey) return null
    return this.entities.get(this.targetKey) || null
  }

  _clearTargetHide () {
    if (this._hiddenRid != null) {
      try { this.setEntityVisible(this._hiddenRid, true) } catch {}
      this._hiddenRid = null
    }
    if (this._ghostHidden) {
      this._ghostHidden = false
      try { this.setGhostVisible(true) } catch {}
    }
  }

  _applyFollowHide (ent) {
    this._clearTargetHide()
    if (!this.hideTargetOnFollow || !ent) return

    if (ent.isGhost) {
      this._ghostHidden = true
      try { this.setGhostVisible(false) } catch {}
      return
    }

    if (ent.runtimeId == null) return
    this._hiddenRid = ent.runtimeId
    this._hidePulse = 0
    try { this.setEntityVisible(ent.runtimeId, false) } catch {}
  }

  _startLoop () {
    if (this._timer) return
    this._timer = setInterval(() => this._tick(), this.tickMs)
  }

  _stopLoop () {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    this.cam = null
  }

  _tick () {
    if (this.mode !== 'follow') return

    if (this._hiddenRid != null) {
      this._hidePulse++
      if (this._hidePulse === 1 || this._hidePulse % 12 === 0) {
        try { this.setEntityVisible(this._hiddenRid, false) } catch {}
      }
    }

    this._emitDisplay()
  }

  clearFollowOnly () {
    const wasFollow = this.mode === 'follow'
    const wasMe = wasFollow && this.getTargetEntity()?.isGhost
    this.mode = 'free'
    this.targetKey = null
    this._stopLoop()
    this._clearTargetHide()
    if (wasMe) this._deactivateMe()
    if (wasFollow) {
      try { this.onWatchEnd() } catch {}
    }
  }

  setFree (announce = true) {
    this.clearFollowOnly()
    if (announce) this.say('§a[Spec] Freecam')
  }

  followKey (key, announce = true) {
    if (!this.possessEnabled) return this._refusePossess()
    const ent = this.entities.get(key)
    if (!ent) {
      this.say('§c[Spec] Target not found')
      return false
    }

    const prev = this.getTargetEntity()
    if (prev?.isGhost && !ent.isGhost) this._deactivateMe()
    else if (this.mode === 'follow' && !ent.isGhost) {
      try { this.onWatchEnd() } catch {}
    }

    this.mode = 'follow'
    this.targetKey = key
    this.cam = null

    if (ent.isGhost) {
      this._applyFollowHide(ent)
      try { this.onWatchStart() } catch {}
      this._activateMe()
    } else {
      this._deactivateMe()
      try { this.onWatchStart() } catch {}
      this._applyFollowHide(ent)
    }

    this._startLoop()
    this.snapToTarget(true)
    if (announce) {
      if (ent.isGhost) {
        if (this.mePathId === ME_COMMITTED_ME_PATH.pathId) {
          this.say('§a[Spec] .me §7adventure+fly §fруки')
        } else {
          this.say(`§a[Spec] .me §7P${this.mePathId}`)
        }
        this.say('§7хотбар выкл при слежке за собой · §f.pause§7 (ещё раз — ▶) / веб')
      } else {
        this.say(`§a[Spec] Camera §f${ent.name} §7(locked)`)
      }
    }
    return true
  }

  _refusePossess () {
    this.say('§e[Replay] На этой версии только freecam · вселение (.me / .spec) недоступно')
    return false
  }

  followSelf () {
    if (!this.possessEnabled) return this._refusePossess()
    const ghost = [...this.entities.values()].find((e) => e.isGhost)
    if (ghost) return this.followKey(ghost.key)
    this.say('§c[Spec] Your ghost is not spawned yet')
    return false
  }

  followName (query) {
    if (!this.possessEnabled) return this._refusePossess()
    const q = normName(query)
    if (!q) {
      this.say('§e[Spec] Usage: .spec <name>')
      return false
    }
    if (q === 'me' || q === 'self' || q === 'ghost' || q === 'you') return this.followSelf()

    const list = this.list()
    const exact = list.find((e) => normName(e.name) === q)
    const partial = list.find((e) => normName(e.name).includes(q))
    const hit = exact || partial
    if (!hit) {
      this.say(`§c[Spec] No player matching "${query}"`)
      this.sayList()
      return false
    }
    return this.followKey(hit.key)
  }

  cycle (dir = 1) {
    if (!this.possessEnabled) return this._refusePossess()
    const keys = this._cycle
    if (!keys.length) {
      this.say('§c[Spec] No players to spectate yet')
      return false
    }
    let idx = keys.indexOf(this.targetKey)
    if (idx < 0) idx = dir > 0 ? -1 : 0
    idx = (idx + dir + keys.length) % keys.length
    return this.followKey(keys[idx])
  }

  sayList () {
    const list = this.list()
    if (!list.length) {
      this.say('§e[Spec] Nobody tracked yet')
      return
    }
    const names = list.map((e) => (e.isGhost ? `§b${e.name}§7*` : `§f${e.name}`)).join('§7, ')
    this.say(`§e[Spec] ${names}`)
    this.say('§7.me §8| §7.spec <nick> §8| §7.next §8| §7.free')
  }

  destroy () {
    this.clearFollowOnly()
  }

  handleChat (raw) {
    if (!raw || typeof raw !== 'string') return false
    let msg = raw.trim()
    if (msg.startsWith('/')) msg = msg.slice(1)
    const lower = msg.toLowerCase()

    if (lower === '.mepath' || lower === '.mp') {
      if (!this.possessEnabled) return this._refusePossess()
      this.sayMePathList()
      return true
    }
    const mp = msg.match(/^\.(?:mepath|mp)\s+(\d+)\s*$/i)
    if (mp) {
      if (!this.possessEnabled) return this._refusePossess()
      this.setMePath(Number(mp[1]), true)
      return true
    }

    if (lower === '.free' || lower === 'free' || lower === '.freecam') {
      this.setFree()
      return true
    }
    if (lower === '.me' || lower === '.self' || lower === '.ghost' || lower === 'me') {
      this.followSelf()
      return true
    }
    if (lower === '.next' || lower === 'next' || lower === '.n') {
      this.cycle(1)
      return true
    }
    if (lower === '.list' || lower === 'list' || lower === '.players') {
      if (!this.possessEnabled) {
        this.say('§e[Replay] Freecam only · вселение выкл на этой версии')
        return true
      }
      this.sayList()
      return true
    }
    if (lower === '.spec' || lower === '.sp' || lower === '.spectate') {
      if (!this.possessEnabled) return this._refusePossess()
      this.say('§e[Spec] §f.spec <name> §8| §f.me §8| §f.next §8| §f.free')
      this.sayList()
      return true
    }
    const m = msg.match(/^\.(?:spec|sp|spectate)\s+(.+)$/i)
    if (m) {
      this.followName(m[1].trim())
      return true
    }
    return false
  }
}

export function ridKey (runtimeId) {
  return `rid:${String(runtimeId)}`
}

export function ghostKey () {
  return `rid:${String(GHOST_RUNTIME_ID)}`
}
