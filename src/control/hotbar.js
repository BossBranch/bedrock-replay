/**
 * Spectator hotbar controls:
 *
 * FREECAM + .spec (other players)
 *   1 pause · 2–4 speed · 5/6 seek · 7 next · 8 restart · 9 idle park
 *   (.me — chat only; first .next is self/ghost)
 *   Mouse wheel ignored.
 *
 * .me (self follow / possessing)
 *   Hotbar keys DISABLED — real FPV hand stays intact.
 *   Use chat (.pause / .speed) or the web UI.
 */

export const HOTBAR_ACTIONS = [
  { slot: 0, name: '§eПауза', action: 'togglePause' },
  { slot: 1, name: '§c×0.5', action: 'speed', value: 0.5 },
  { slot: 2, name: '§a×1', action: 'speed', value: 1 },
  { slot: 3, name: '§a×2', action: 'speed', value: 2 },
  { slot: 4, name: '§7−10с', action: 'seek', value: -10000 },
  { slot: 5, name: '§7+10с', action: 'seek', value: 10000 },
  { slot: 6, name: '§dСлед. игрок', action: 'next' },
  { slot: 7, name: '§eРестарт', action: 'restart' }
  // slot 8 = idle park only (.me → chat)
]

/** Empty idle park so 1–8 can re-fire (not an action key) */
export const IDLE_PARK_SLOT = 8

const OBJECTIVE = 'bsr_ctrl'
const COALESCE_MS = 120
const SLOT_ECHO_MS = 120
const WHEEL_STEP_MS = 220
const WHEEL_SETTLE_MS = 380

function clampSlot (n) {
  return Math.max(0, Math.min(8, Number(n) || 0))
}

export function hideControlLegend (client) {
  try {
    client.write('remove_objective', { objective_name: OBJECTIVE })
  } catch {}
}

export function giveControlHotbar (client, _opts = {}) {
  hideControlLegend(client)
}

function runAction (act, plane, hooks = {}) {
  if (!act) return false
  const { spec, say } = hooks
  const speak = say || (() => {})

  if (act.action === 'togglePause') {
    plane.togglePause()
    speak(plane.paused ? '§e[Replay] Пауза' : '§a[Replay] ▶')
    return true
  }
  if (act.action === 'speed') {
    const r = plane.setSpeed(act.value)
    speak(r.ok ? `§a[Replay] §f${r.speed}x` : `§c[Replay] ${r.error}`)
    return true
  }
  if (act.action === 'seek') {
    plane.seek(act.value).then((r) => {
      if (!r.ok) speak(`§c[Replay] ${r.error}`)
    })
    return true
  }
  if (act.action === 'next') {
    if (spec && spec.possessEnabled === false) {
      speak('§e[Replay] На этой версии только freecam · вселение выкл')
      return true
    }
    spec?.cycle?.(1)
    return true
  }
  if (act.action === 'restart') {
    // Keep freecam — same as .restart (not .restart0)
    plane.setAnnounce?.(speak)
    plane.restart({ resetCamera: false }).catch((e) => {
      speak(`§c[Replay] ${e.message || e}`)
    })
    return true
  }
  return false
}

export function forceHotbarSlot (client, slot = 0, _item = null) {
  const s = clampSlot(slot)
  // Slot select only — inventory_slot Item re-encode SizeOf-kicks on 1.26.
  try {
    client.write('player_hotbar', {
      selected_slot: s,
      window_id: 'inventory',
      select_slot: true
    })
  } catch {}
}

function actionForSlot (slot) {
  return HOTBAR_ACTIONS.find((a) => a.slot === slot) || null
}

/**
 * @returns {{
 *   suppressEcho: (ms?: number) => void,
 *   suppressSlot: (slot: number, ms?: number) => void,
 *   noteSelection: (slot: number) => void,
 *   parkIdle: () => void,
 *   detach: () => void
 * }}
 */
export function attachSpectatorHotbar (client, plane, hooks = {}) {
  let lastFireAt = 0
  let lastFireSlot = -1
  let suppressAllUntil = 0
  const suppressSlotUntil = Array.from({ length: 9 }, () => 0)
  let lastKnownSlot = null
  let lastStepAt = 0
  let wheelSettleTimer = null

  const following = () => !!hooks.spec?.isFollowing?.()
  const possessing = () => !!hooks.spec?.isPossessing?.()
  /** Freecam-style controls: empty bar + park on 9 (also .spec others) */
  const useParkLayout = () => !possessing()

  const suppressEcho = (ms = SLOT_ECHO_MS) => {
    suppressAllUntil = Math.max(suppressAllUntil, Date.now() + Math.max(0, ms))
  }

  const suppressSlot = (slot, ms = SLOT_ECHO_MS) => {
    const s = clampSlot(slot)
    suppressSlotUntil[s] = Math.max(suppressSlotUntil[s], Date.now() + Math.max(0, ms))
  }

  const noteSelection = (slot) => {
    lastKnownSlot = clampSlot(slot)
  }

  const clearWheelSettle = () => {
    if (wheelSettleTimer) {
      clearTimeout(wheelSettleTimer)
      wheelSettleTimer = null
    }
  }

  /** Freecam/.spec → empty+slot9. .me → real hand. */
  const parkIdle = () => {
    if (hooks.controlsEnabled === false) return
    if (typeof hooks.restoreInventory === 'function') {
      try {
        hooks.restoreInventory({
          mode: useParkLayout() ? 'park' : 'hand',
          parkSlot: IDLE_PARK_SLOT
        })
      } catch (e) {
        console.warn('[hotbar] restore failed', e.message)
      }
    } else if (useParkLayout()) {
      noteSelection(IDLE_PARK_SLOT)
      suppressSlot(IDLE_PARK_SLOT, SLOT_ECHO_MS)
      try { forceHotbarSlot(client, IDLE_PARK_SLOT, null) } catch {}
    }
  }

  const scheduleWheelSettle = () => {
    clearWheelSettle()
    wheelSettleTimer = setTimeout(() => {
      wheelSettleTimer = null
      parkIdle()
    }, WHEEL_SETTLE_MS)
  }

  const onUserSlot = (rawSlot, reason) => {
    if (hooks.controlsEnabled === false) return
    // .me: never treat hotbar as controls (keeps real FPV hand)
    if (possessing()) {
      const slot = clampSlot(rawSlot)
      lastKnownSlot = slot
      lastStepAt = Date.now()
      return
    }

    const slot = clampSlot(rawSlot)
    const now = Date.now()
    const parkLayout = useParkLayout()

    if (now < suppressAllUntil) return
    if (now < suppressSlotUntil[slot]) return

    if (lastKnownSlot == null) {
      lastKnownSlot = slot
      lastStepAt = now
      console.log(`[hotbar] learn slot ${slot + 1} via ${reason} (no action)`)
      return
    }

    if (slot === lastKnownSlot) return

    const delta = Math.abs(slot - lastKnownSlot)
    const dt = now - lastStepAt

    // Wheel: rapid ±1. Leaving idle(9) by ±1 = key 8 — allow.
    if (
      delta === 1 &&
      dt < WHEEL_STEP_MS &&
      !(parkLayout && lastKnownSlot === IDLE_PARK_SLOT)
    ) {
      lastKnownSlot = slot
      lastStepAt = now
      console.log(`[hotbar] wheel → slot ${slot + 1} (ignored)`)
      scheduleWheelSettle()
      return
    }

    const def = actionForSlot(slot)
    if (!def) {
      lastKnownSlot = slot
      lastStepAt = now
      return
    }

    if (slot === lastFireSlot && now - lastFireAt < COALESCE_MS) {
      lastKnownSlot = slot
      lastStepAt = now
      return
    }

    clearWheelSettle()
    lastKnownSlot = slot
    lastStepAt = now
    lastFireAt = now
    lastFireSlot = slot
    console.log(`[hotbar] key ${slot + 1} via ${reason} → ${def.action}${following() ? ' (spec)' : ''}`)
    runAction(def, plane, hooks)

    // Freecam / .spec: park empty 9
    if (typeof hooks.restoreInventory === 'function') {
      try {
        hooks.restoreInventory({ mode: 'park', parkSlot: IDLE_PARK_SLOT })
      } catch (e) {
        console.warn('[hotbar] restore failed', e.message)
      }
    }
    lastStepAt = Date.now()
  }

  const onEquip = (p) => {
    if (p?.window_id === 'offhand' || p?.window_id === 119) return
    const slot = p?.selected_slot != null
      ? Number(p.selected_slot)
      : (p?.hotbar_slot != null ? Number(p.hotbar_slot) : (p?.slot != null ? Number(p.slot) : null))
    if (slot == null || !Number.isFinite(slot)) return
    onUserSlot(slot, 'equip')
  }

  const onHotbar = (p) => {
    if (p?.selected_slot == null) return
    onUserSlot(Number(p.selected_slot) || 0, 'hotbar')
  }

  client.on('mob_equipment', onEquip)
  client.on('player_hotbar', onHotbar)

  setTimeout(parkIdle, 80)
  setTimeout(parkIdle, 450)
  setTimeout(() => { try { hideControlLegend(client) } catch {} }, 400)

  const detach = () => {
    clearWheelSettle()
    try { client.off('mob_equipment', onEquip) } catch {}
    try { client.off('player_hotbar', onHotbar) } catch {}
    try { hideControlLegend(client) } catch {}
  }
  client.on('close', detach)

  return { suppressEcho, suppressSlot, noteSelection, parkIdle, detach }
}

/** @deprecated */
export function attachHotbarControls (client, plane, hooks = {}) {
  return attachSpectatorHotbar(client, plane, {
    ...hooks,
    controlsEnabled: hooks.controlsEnabled !== false
  }).detach
}

/** @deprecated */
export function attachFollowHotbarLock () {
  return () => {}
}
