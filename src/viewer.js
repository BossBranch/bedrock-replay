/**
 * Freecam viewer setup — spectator (1.19.50+) or creative + no_clip fallback.
 * .me FPV uses mePaths + abilities; invisibility helper kept for path reset.
 */

import {
  writeVarInt,
  writeVarLong,
  EMPTY_ITEM_V4,
  PKT_MOB_ARMOR_EQUIPMENT
} from './packetPatch.js'

/** Bedrock effect id — Invisibility */
const EFFECT_INVISIBILITY = 14

function emptyItem () {
  return { network_id: 0 }
}

function asRuntimeId (runtimeId) {
  if (runtimeId == null) return 0n
  if (typeof runtimeId === 'bigint') return runtimeId
  const n = Number(runtimeId)
  if (!Number.isFinite(n)) return 0n
  return BigInt(Math.trunc(n))
}

function flyFlags () {
  return {
    build: false,
    mine: false,
    doors_and_switches: false,
    open_containers: false,
    attack_players: false,
    attack_mobs: false,
    operator_commands: true,
    teleport: true,
    invulnerable: true,
    flying: true,
    may_fly: true,
    instant_build: false,
    lightning: false,
    fly_speed: true,
    walk_speed: true,
    muted: false,
    world_builder: false,
    no_clip: true,
    privileged_builder: false,
    vertical_fly_speed: true
  }
}

function flyEnabled () {
  return {
    flying: true,
    may_fly: true,
    no_clip: true,
    invulnerable: true,
    fly_speed: true,
    walk_speed: true,
    vertical_fly_speed: true,
    teleport: true,
    operator_commands: true
  }
}

export function writeAbilities (client, entityUniqueId, { spectatorLayer = false, grounded = false } = {}) {
  const flags = grounded
    ? {
        ...flyFlags(),
        flying: false,
        may_fly: false,
        no_clip: false
      }
    : flyFlags()
  const enabled = grounded
    ? {
        flying: false,
        may_fly: false,
        no_clip: false,
        invulnerable: true,
        fly_speed: false,
        // Lock walk — follow mode snaps pose; client must not stroll away
        walk_speed: false,
        vertical_fly_speed: false,
        teleport: true,
        operator_commands: true
      }
    : flyEnabled()
  const layer = {
    type: 'base',
    allowed: flags,
    enabled,
    fly_speed: grounded ? 0 : 0.15,
    vertical_fly_speed: grounded ? 1.0 : 1.0,
    walk_speed: grounded ? 0 : 0.1
  }
  const layers = [layer]
  if (spectatorLayer && !grounded) {
    layers.push({
      type: 'spectator',
      allowed: flags,
      enabled,
      fly_speed: 0.15,
      vertical_fly_speed: 1.0,
      walk_speed: 0.1
    })
  }
  client.write('update_abilities', {
    entity_unique_id: entityUniqueId ?? 0n,
    permission_level: 'operator',
    command_permission: 'operator',
    abilities: layers
  })
}

/**
 * Clear local armor (viewer FPV) without re-encoding Item via client.write —
 * on 1.26 that throws SizeOf / can kick (same family as ghost equip).
 */
export function clearLocalArmor (client, runtimeEntityId) {
  if (!client || runtimeEntityId == null) return
  try {
    const rid = asRuntimeId(runtimeEntityId)
    const buf = Buffer.concat([
      writeVarInt(PKT_MOB_ARMOR_EQUIPMENT),
      writeVarLong(rid),
      EMPTY_ITEM_V4,
      EMPTY_ITEM_V4,
      EMPTY_ITEM_V4,
      EMPTY_ITEM_V4,
      EMPTY_ITEM_V4
    ])
    if (typeof client.sendBuffer === 'function') {
      client.sendBuffer(buf, true)
      return
    }
    client.write('mob_armor_equipment', {
      runtime_entity_id: rid,
      helmet: emptyItem(),
      chestplate: emptyItem(),
      leggings: emptyItem(),
      boots: emptyItem(),
      body: emptyItem()
    })
  } catch (e) {
    console.warn('[viewer] clearLocalArmor failed', e.message)
  }
}

/**
 * Invisibility without potion particles.
 * @param {'add'|'update'|'remove'} eventId
 */
export function setViewerInvisibility (client, runtimeEntityId, eventId = 'add') {
  if (!client || runtimeEntityId == null) return
  try {
    client.write('mob_effect', {
      runtime_entity_id: asRuntimeId(runtimeEntityId),
      event_id: eventId,
      effect_id: EFFECT_INVISIBILITY,
      amplifier: 0,
      particles: false,
      // ~8 minutes; refreshed while possessing
      duration: eventId === 'remove' ? 0 : 10000,
      tick: 0n
    })
  } catch (e) {
    console.warn('[viewer] invisibility failed', e.message)
  }
  // Metadata backup — hide local body mesh if effect is ignored
  try {
    client.write('set_entity_data', {
      runtime_entity_id: asRuntimeId(runtimeEntityId),
      metadata: [
        {
          key: 'flags',
          type: 'long',
          value: {
            invisible: eventId !== 'remove',
            can_show_nametag: false,
            always_show_nametag: false,
            has_collision: false,
            affected_by_gravity: false,
            breathing: true
          }
        }
      ],
      properties: { ints: [], floats: [] },
      tick: 0n
    })
  } catch { /* optional */ }
}

/**
 * @param {object} client
 * @param {any} entityUniqueId
 * @param {'spectator'|'creative_noclip'} [mode]
 */
export function forceViewerMode (client, entityUniqueId, mode = 'spectator') {
  // Pre-spectator: adventure + fly/no_clip (not creative) — less grief than GM1
  const gamemode = mode === 'creative_noclip' ? 'adventure' : 'spectator'
  try {
    client.write('set_player_game_type', { gamemode })
  } catch (e) {
    console.warn('[viewer] set_player_game_type failed', e.message)
  }
  try {
    client.write('clientbound_close_form', {})
  } catch {}

  try {
    writeAbilities(client, entityUniqueId, { spectatorLayer: mode === 'spectator' })
  } catch (e) {
    console.warn('[viewer] update_abilities failed', e.message)
  }
}
