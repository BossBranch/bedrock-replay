/**
 * Addresses for dual-port hub: live (record) + play (replay).
 */

/** Fixed Minecraft MOTD (§ codes: bold + color). Not user-editable. */
export const MOTD_LIVE = '§l§cЗАПИСЬ/LIVE'
export const MOTD_PLAY = '§l§aПРОСМОТР/REPLAY'

export function liveMotdOptions () {
  return { motd: MOTD_LIVE, levelName: 'LIVE' }
}

export function playMotdOptions () {
  return { motd: MOTD_PLAY, levelName: 'REPLAY' }
}

export function advertiseHost (cfg) {
  return cfg.advertiseHost || cfg.publicHost || '127.0.0.1'
}

/** Live / record proxy port (default 19132) */
export function livePort (cfg) {
  return Number(cfg.livePort ?? cfg.listenPort ?? 19132)
}

/** Replay viewer port (default 19133) */
export function playPort (cfg) {
  return Number(cfg.playPort ?? 19133)
}

export function liveAddress (cfg) {
  return { host: advertiseHost(cfg), port: livePort(cfg) }
}

export function playAddress (cfg) {
  return { host: advertiseHost(cfg), port: playPort(cfg) }
}

/** Fallback when transfer cannot be used — clear message, not a silent kick */
export function disconnectWithJoinHint (client, host, port, label = '') {
  const msg = `§e${label || 'Выход из просмотра · зайди на LIVE'}:\n§f${host}:${port}`
  try {
    client.disconnect(msg)
  } catch {
    try {
      client.write?.('disconnect', {
        hide_disconnect_screen: false,
        message: msg,
        filtered_message: ''
      })
    } catch {}
  }
  return { host, port }
}
