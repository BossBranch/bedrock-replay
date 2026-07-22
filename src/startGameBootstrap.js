/**
 * Minimal start_game for mid-session recordings that never captured one.
 * Enough for Bedrock to leave the loading / "Searching for server" screen.
 */

export function buildSyntheticStartGame ({
  spawnPos,
  runtimeId = 1n,
  entityUniqueId = -1n,
  version = '1.21.100',
  viewerMode = 'spectator'
} = {}) {
  const pos = spawnPos && Number.isFinite(spawnPos.x)
    ? { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z }
    : { x: 0, y: 80, z: 0 }
  const rid = toBig (runtimeId, 1n)
  const eid = toBig (entityUniqueId, -1n)

  return {
    entity_id: eid,
    runtime_entity_id: rid,
    player_gamemode: viewerMode === 'creative_noclip' ? 'creative' : 'spectator',
    player_position: { x: pos.x, y: pos.y, z: pos.z },
    rotation: { x: 0, y: 0 },
    seed: 0n,
    biome_type: 0,
    biome_name: 'plains',
    dimension: 'overworld',
    generator: 1,
    world_gamemode: 'survival',
    hardcore: false,
    difficulty: 1,
    spawn_position: {
      x: Math.floor(pos.x),
      y: Math.floor(pos.y),
      z: Math.floor(pos.z)
    },
    achievements_disabled: true,
    editor_world_type: 'not_editor',
    created_in_editor: false,
    exported_from_editor: false,
    day_cycle_stop_time: 0,
    edu_offer: 0,
    edu_features_enabled: false,
    edu_product_uuid: '',
    rain_level: 0,
    lightning_level: 0,
    has_confirmed_platform_locked_content: false,
    is_multiplayer: true,
    broadcast_to_lan: true,
    xbox_live_broadcast_mode: 0,
    platform_broadcast_mode: 0,
    enable_commands: true,
    is_texturepacks_required: false,
    gamerules: [],
    experiments: [],
    experiments_previously_used: false,
    bonus_chest: false,
    map_enabled: false,
    permission_level: 'operator',
    server_chunk_tick_range: 4,
    has_locked_behavior_pack: false,
    has_locked_resource_pack: false,
    is_from_locked_world_template: false,
    msa_gamertags_only: false,
    is_from_world_template: false,
    is_world_template_option_locked: false,
    only_spawn_v1_villagers: false,
    persona_disabled: false,
    custom_skins_disabled: false,
    emote_chat_muted: false,
    game_version: String(version || '1.21.100'),
    limited_world_width: 0,
    limited_world_length: 0,
    is_new_nether: true,
    edu_resource_uri: { button_name: '', link_uri: '' },
    experimental_gameplay_override: false,
    chat_restriction_level: 'none',
    disable_player_interactions: false,
    server_identifier: '',
    world_identifier: '',
    scenario_identifier: '',
    owner_identifier: '',
    level_id: 'bedrock-replay',
    world_name: 'Replay',
    premium_world_template_id: '00000000-0000-0000-0000-000000000000',
    is_trial: false,
    rewind_history_size: 0,
    server_authoritative_block_breaking: false,
    current_tick: 0n,
    enchantment_seed: 0,
    block_properties: [],
    multiplayer_correlation_id: '',
    server_authoritative_inventory: true,
    engine: String(version || '1.21.100'),
    property_data: { type: 'compound', name: '', value: {} },
    block_pallette_checksum: 0n,
    world_template_id: '00000000-0000-0000-0000-000000000000',
    client_side_generation: false,
    block_network_ids_are_hashes: true,
    tick_death_systems: false,
    server_controlled_sound: false
  }
}

function toBig (v, fallback) {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v))
  if (v && typeof v === 'object' && v.$bigint != null) return BigInt(v.$bigint)
  try {
    if (v != null) return BigInt(v)
  } catch {}
  return fallback
}
