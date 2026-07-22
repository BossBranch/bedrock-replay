/**
 * Soft client reset before catch-up seek — remove tracked entities, close forms.
 */

import { GHOST_UNIQUE_ID } from '../ghost.js'
import { asUniqueId } from '../packetFix.js'

/**
 * @param {object} client bedrock client
 * @param {{
 *   trackedRuntimeIds?: Iterable<any>,
 *   trackedUniqueIds?: Iterable<any>,
 *   keepGhost?: boolean,
 *   localRuntimeId?: any,
 *   say?: Function,
 *   closeForms?: Function,
 *   quiet?: boolean
 * }} opts
 */
export function softResetClient (client, opts = {}) {
  const {
    trackedUniqueIds = [],
    keepGhost = false,
    say = null,
    closeForms = null,
    quiet = false
  } = opts

  try { closeForms?.(client) } catch {}

  // Title/chat seek spam removed — plane reports result once

  for (const uid of trackedUniqueIds) {
    if (uid == null) continue
    const id = asUniqueId(uid)
    if (keepGhost && String(id) === String(GHOST_UNIQUE_ID)) continue
    try {
      client.write('remove_entity', { entity_id_self: id })
    } catch {}
  }

  return { ok: true }
}

export function clearSeekTitle (client) {
  try {
    client.write('set_title', {
      type: 'clear',
      text: '',
      fade_in_time: 0,
      stay_time: 0,
      fade_out_time: 0,
      xuid: '',
      platform_online_id: ''
    })
  } catch {}
}
