/**
 * .me recipes. v0.2: only P0 (spectator baseline) and P1 (committed adventure+fly).
 */

import { hardResetMeDebug } from './meDebug.js'

export const ME_PATH_MAX = 1

/** Default .me — adventure + fly/noclip, FPV hands, no grounded. */
export const ME_COMMITTED_ME_PATH = {
  id: 'adventure_fly',
  pathId: 1,
  reason: 'adventure+fly, FPV hands'
}

export const ME_PATH_LABELS = [
  '0 baseline spectator',
  '1 adventure + fly ★ .me default'
]

export function clampMePath (n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return ME_COMMITTED_ME_PATH.pathId
  return Math.max(0, Math.min(ME_PATH_MAX, Math.trunc(x)))
}

function setGameType (client, gamemode) {
  client.write('set_player_game_type', { gamemode })
}

function setFly (viewer, client, entityUniqueId, { spectatorLayer = false } = {}) {
  viewer.writeAbilities(client, entityUniqueId, { spectatorLayer, grounded: false })
}

/**
 * @param {object} client
 * @param {{
 *   entityUniqueId: any,
 *   runtimeId: any,
 *   viewer: import('./viewer.js'),
 *   viewerMode: string,
 *   equipHeld?: Function
 * }} ctx
 * @param {number} pathId
 */
export function applyMePath (client, ctx, pathId) {
  const n = clampMePath(pathId)
  const { entityUniqueId, viewer, viewerMode } = ctx

  hardResetMeDebug(client, entityUniqueId, viewer, viewerMode)

  if (n === 0) {
    return { ok: true, path: n }
  }

  try {
    // P1 — committed .me
    setGameType(client, 'adventure')
    setFly(viewer, client, entityUniqueId, { spectatorLayer: false })
    ctx.equipHeld?.()
  } catch (e) {
    return { ok: false, path: n, error: e.message }
  }

  return { ok: true, path: n }
}

export function resetMePath (client, ctx) {
  try { ctx.viewer.setViewerInvisibility(client, ctx.runtimeId, 'remove') } catch {}
  hardResetMeDebug(client, ctx.entityUniqueId, ctx.viewer, ctx.viewerMode)
}
