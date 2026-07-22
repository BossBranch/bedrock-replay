/**
 * Bedrock version support + viewer-mode policy.
 * Adjacent patches with the same protocol id are treated as compatible.
 */

import mcData from 'minecraft-data'
import bedrock from 'bedrock-protocol'
import { normalizeVersion } from './config.js'

/** Official Bedrock spectator (no experimental toggle) */
export const SPECTATOR_SINCE = '1.19.50'

/** Oldest freecam-capable floor we expose (minecraft-data has 1.16.201+) */
export const FREECAM_SINCE = '1.16.201'

/** .me / .spec / .next only with real spectator (≥ 1.19.50) */
export function possessEnabledForVersion (version) {
  const v = normalizeVersion(version) || '0.0.0'
  return compareSemver(v, SPECTATOR_SINCE) >= 0
}

export function compareSemver (a, b) {
  const pa = String(normalizeVersion(a) || '0.0.0').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(normalizeVersion(b) || '0.0.0').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1
    if (pa[i] > pb[i]) return 1
  }
  return 0
}

export function isBedrockVersionSupported (version) {
  const v = normalizeVersion(version)
  if (!v) return false
  try {
    const d = mcData('bedrock_' + v)
    return !!(d && d.protocol)
  } catch {
    return false
  }
}

/** Numeric Bedrock protocol id from minecraft-data (e.g. 975 for 1.26.20). */
export function protocolIdForVersion (version) {
  const v = normalizeVersion(version)
  if (!v) return null
  const base = isBedrockVersionSupported(v) ? v : resolveToSupportedVersion(v)
  if (!base) return null
  try {
    const d = mcData('bedrock_' + base)
    const id = d?.version?.version
    return Number.isFinite(Number(id)) ? Number(id) : null
  } catch {
    return null
  }
}

/**
 * Same label, or same protocol id (after mapping unknown patches to nearest data).
 */
export function versionsCompatible (a, b) {
  const va = normalizeVersion(a)
  const vb = normalizeVersion(b)
  if (!va || !vb) return false
  if (va === vb) return true
  const baseA = resolveToSupportedVersion(va) || va
  const baseB = resolveToSupportedVersion(vb) || vb
  if (baseA === baseB) return true
  const pa = protocolIdForVersion(baseA)
  const pb = protocolIdForVersion(baseB)
  return pa != null && pb != null && pa === pb
}

/**
 * Map an arbitrary client version onto a minecraft-data protocol base.
 * Always prefer the highest supported base that is ≤ client (never jump newer).
 * e.g. 1.21.123 → 1.21.120 (not 1.21.124); 1.26.22 → 1.26.20.
 */
export function resolveToSupportedVersion (wanted) {
  const v = normalizeVersion(wanted)
  if (!v) return null
  if (isBedrockVersionSupported(v)) return v

  const all = listSupportedBedrockVersions()
  if (!all.length) return null

  const [maj, min] = v.split('.').map((x) => parseInt(x, 10) || 0)
  const sameLine = all.filter((x) => {
    const p = x.split('.').map((n) => parseInt(n, 10) || 0)
    return p[0] === maj && p[1] === min
  })
  const pool = sameLine.length ? sameLine : all

  // Floor: newest supported ≤ client
  const floor = pool.filter((c) => compareSemver(c, v) <= 0)
  if (floor.length) return floor[floor.length - 1]

  // Only if nothing older exists — nearest newer (should be rare)
  const above = pool.filter((c) => compareSemver(c, v) > 0)
  return above[0] || null
}

function semverNumeric (v) {
  const p = String(normalizeVersion(v) || '0.0.0').split('.').map((x) => parseInt(x, 10) || 0)
  return (p[0] || 0) * 1_000_000 + (p[1] || 0) * 1_000 + (p[2] || 0)
}

/**
 * @returns {'spectator'|'creative_noclip'}
 */
export function viewerModeForVersion (version) {
  const v = normalizeVersion(version) || '0.0.0'
  return compareSemver(v, SPECTATOR_SINCE) >= 0 ? 'spectator' : 'creative_noclip'
}

export function listSupportedBedrockVersions () {
  try {
    const list = mcData.versions?.bedrock || []
    const versions = list
      .map((row) => normalizeVersion(row.minecraftVersion || row.version || row))
      .filter(Boolean)
    // Only versions that actually load (Android prune may drop folders)
    const uniq = [...new Set(versions)].filter((v) => {
      try {
        const d = mcData('bedrock_' + v)
        return !!(d && d.protocol)
      } catch {
        return false
      }
    })
    uniq.sort(compareSemver)
    return uniq
  } catch {
    return []
  }
}

/**
 * Resolve protocol version for listen/proxy.
 * - config.version / version:"auto"
 * - destination ping (warning or auto pick)
 * - unknown patch → nearest supported on same line
 */
export async function resolveRuntimeVersion (cfg) {
  const raw = cfg.version
  const wantAuto = raw === 'auto' || cfg.autoVersion === true
  let configured = normalizeVersion(wantAuto ? null : raw) || '1.26.30'
  const dest = cfg.destination

  let pinged = null
  // Mobile: fixed client version — skip dest ping so :19132 advertises ASAP
  // (users often join Minecraft while hub is still starting → “server not found”).
  const skipDestPing =
    process.env.BEDROCK_REPLAY_MOBILE === '1' && !wantAuto
  if (dest?.host && !skipDestPing) {
    try {
      const ad = await bedrock.ping({ host: dest.host, port: dest.port || 19132 })
      pinged = normalizeVersion(ad.version)
      console.log(`[version] client/config=${wantAuto ? 'auto' : configured}  server_ping=${ad.version || '?'}  motd=${ad.motd || ''}`)
      if (wantAuto && pinged) {
        if (isBedrockVersionSupported(pinged)) {
          configured = pinged
          console.log(`[version] auto → ${configured} (from destination ping)`)
        } else {
          const mapped = resolveToSupportedVersion(pinged)
          if (mapped) {
            configured = mapped
            console.log(`[version] auto ping ${pinged} not in data → ${mapped}`)
          }
        }
      } else if (pinged && pinged !== configured) {
        if (versionsCompatible(pinged, configured) ||
            (resolveToSupportedVersion(pinged) === configured)) {
          console.log(`[version] ping ${pinged} ~ runtime ${configured} (compatible)`)
        } else {
          console.warn(`[version] WARNING: ping version (${pinged}) != runtime (${configured}).`)
          console.warn('[version] Runtime must match YOUR Minecraft client. See docs/VERSIONS.md')
        }
      }
    } catch (e) {
      console.warn(`[version] ping ${dest.host}:${dest.port} failed (${e.message}). Using ${configured}`)
    }
  } else if (skipDestPing) {
    console.log(`[version] mobile fixed version=${configured} — skip dest ping (faster listen)`)
  }

  if (!isBedrockVersionSupported(configured)) {
    const mapped = resolveToSupportedVersion(configured)
    if (mapped && isBedrockVersionSupported(mapped)) {
      console.warn(`[version] "${configured}" not in minecraft-data → using ${mapped}`)
      configured = mapped
    } else {
      const sample = listSupportedBedrockVersions().slice(-8).join(', ')
      throw new Error(
        `Unsupported Bedrock version "${configured}" for current bedrock-protocol/minecraft-data. ` +
        `Set config.version to your client version. Recent: ${sample || 'see docs/VERSIONS.md'}`
      )
    }
  }

  const viewerMode = viewerModeForVersion(configured)
  const proto = protocolIdForVersion(configured)
  // Show the client's label in RakNet MOTD (e.g. 1.26.33) while codecs stay on protocol base
  let advertiseVersion = configured
  if (!wantAuto && normalizeVersion(raw)) advertiseVersion = normalizeVersion(raw)
  else if (wantAuto && pinged) advertiseVersion = pinged

  console.log(
    `[version] runtime=${configured} protocol=${proto ?? '?'} ` +
    `advertise=${advertiseVersion} viewerMode=${viewerMode}`
  )
  return { version: configured, viewerMode, pinged, protocol: proto, advertiseVersion }
}

/**
 * Bedrock kicks with "host uses outdated version" when:
 *   - MOTD version string is older than the client, or
 *   - client protocol_version > server protocolVersion (failed_spawn).
 * Hotfixes (1.26.31–33) often share protocol 1001 with 1.26.30 but still need the newer label
 * and a tolerant login check until minecraft-data ships a named pack.
 */
export function applyBedrockVersionCompat (server, { advertiseVersion, protocolBase } = {}) {
  if (!server) return
  const adv = normalizeVersion(advertiseVersion) || normalizeVersion(protocolBase)
  const proto =
    server.options?.protocolVersion ??
    protocolIdForVersion(protocolBase) ??
    protocolIdForVersion(adv)

  if (server.advertisement) {
    if (proto != null) server.advertisement.protocol = proto
    if (adv) server.advertisement.version = adv
    console.log(
      `[version] MOTD version=${server.advertisement.version} protocol=${server.advertisement.protocol}`
    )
  }

  server.on('connect', (player) => {
    const orig = player.handleClientProtocolVersion?.bind(player)
    if (!orig) return
    player.handleClientProtocolVersion = (clientVersion) => {
      const ours = player.server?.options?.protocolVersion
      console.log(
        `[version] login clientProtocol=${clientVersion} serverProtocol=${ours} ` +
        `motd=${player.server?.advertisement?.version}`
      )
      if (ours != null && Number(clientVersion) > Number(ours)) {
        // Same-line hotfixes: allow through; codecs remain on protocolBase
        console.warn(
          `[version] client protocol ${clientVersion} > server ${ours} — allowing hotfix client`
        )
        return true
      }
      return orig(clientVersion)
    }
  })
}

/**
 * UI version rows (same model as PC launcher).
 * @param {string[]} clientLabels wiki/client labels (≥ FREECAM_SINCE)
 * @param {{ unreliable?: string[] }} [opts]
 * @returns {{ value: string, base: string, stable: boolean, noPossess: boolean }[]}
 */
export function buildClientVersionEntries (clientLabels, opts = {}) {
  const unreliable = new Set((opts.unreliable || []).map(normalizeVersion).filter(Boolean))
  const bases = listSupportedBedrockVersions()
    .filter((v) => compareSemver(v, FREECAM_SINCE) >= 0)

  /** @type {{ value: string, base: string, stable: boolean, noPossess: boolean }[]} */
  const entries = []
  const seen = new Set()
  for (const c of clientLabels || []) {
    const v = normalizeVersion(c)
    if (!v || seen.has(v)) continue
    if (compareSemver(v, FREECAM_SINCE) < 0) continue
    if (unreliable.has(v)) continue
    const base = resolveToSupportedVersion(v)
    if (!base || !isBedrockVersionSupported(base)) continue
    seen.add(v)
    const noPossess = compareSemver(v, SPECTATOR_SINCE) < 0
    entries.push({ value: v, base, stable: v === base && !noPossess, noPossess })
  }
  for (const b of bases) {
    if (seen.has(b)) continue
    seen.add(b)
    const noPossess = compareSemver(b, SPECTATOR_SINCE) < 0
    entries.push({ value: b, base: b, stable: !noPossess, noPossess })
  }
  entries.sort((a, b) => compareSemver(b.value, a.value))
  return entries
}
