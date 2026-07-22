/**
 * Shared .me / freecam reset — clears sticky Bedrock camera + abilities.
 * Research ladder (.medebug L0–L6) removed in v0.2; committed path is mePaths P1.
 */

/**
 * Hard wipe of grounded / custom camera / gamemode.
 * Bedrock often keeps no_clip=false until abilities are pulsed twice.
 */
export function hardResetMeDebug (client, entityUniqueId, viewer, viewerMode) {
  try {
    client.write('camera_instruction', { clear: true })
  } catch {}
  try {
    client.write('camera_instruction', { clear: true, remove_target: true })
  } catch {}

  try {
    viewer.writeAbilities(client, entityUniqueId, {
      spectatorLayer: false,
      grounded: false
    })
  } catch {}

  try { viewer.forceViewerMode(client, entityUniqueId, viewerMode) } catch {}

  try {
    viewer.writeAbilities(client, entityUniqueId, {
      spectatorLayer: viewerMode === 'spectator',
      grounded: false
    })
  } catch {}

  try {
    client.write('set_player_game_type', {
      gamemode: viewerMode === 'creative_noclip' ? 'creative' : 'spectator'
    })
  } catch {}

  try {
    client.write('camera_instruction', { clear: true })
  } catch {}
}
