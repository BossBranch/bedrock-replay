/**
 * Apply vendored patches to node_modules after npm install.
 * Shared by PC (postinstall) and Android prepare.
 *
 * Bedrock 1.26+ TokenPayload / offline login — without this, real clients
 * get "Server authentication error" on the hub (PC and Android).
 *
 * The patches are WHOLE-FILE copies made against one exact bedrock-protocol
 * release. Copying them over a different release silently mixes old and new
 * internals (3.58+ rewrote auth/keyExchange) and breaks joins, so we refuse
 * to patch anything but BEDROCK_PROTOCOL_VERSION.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/** bedrock-protocol release the files in tools/patches/bedrock-protocol target */
export const BEDROCK_PROTOCOL_VERSION = '3.57.0'

/** [patch file in tools/patches/bedrock-protocol, dest under bedrock-protocol/src] */
export const BEDROCK_PROTOCOL_PATCHES = [
  ['loginVerify.js', 'handshake/loginVerify.js'],
  ['serverPlayer.js', 'serverPlayer.js'],
  ['keyExchange.js', 'handshake/keyExchange.js'],
  ['connection.js', 'connection.js'],
  ['framer.js', 'transforms/framer.js'],
  // Same relay behavior on PC + Android (immediate start_game, safe parse fail)
  ['relay.js', 'relay.js'],
  // Backport from bedrock-protocol 3.58–3.60: maybeIncompleteArray /
  // optionalOnRemaining (needed by 1.26.40+ protocol data) and the
  // enum_size_based_on_values_len off-by-one (available_commands with exactly
  // 256/65536 enum values was mis-encoded).
  ['compiler-minecraft.js', 'datatypes/compiler-minecraft.js'],
  ['minecraft.js', 'datatypes/minecraft.js']
]

/**
 * @param {string} nodeModules absolute path of the node_modules to patch
 * @returns {number} files patched
 */
export function applyBedrockProtocolPatches (nodeModules) {
  const bpRoot = path.join(nodeModules, 'bedrock-protocol')
  const pkgFile = path.join(bpRoot, 'package.json')
  if (!fs.existsSync(pkgFile)) {
    console.warn('[patch-deps] bedrock-protocol not installed — skip')
    return 0
  }
  const installed = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version
  if (installed !== BEDROCK_PROTOCOL_VERSION) {
    throw new Error(
      `[patch-deps] bedrock-protocol ${installed} installed, patches target ${BEDROCK_PROTOCOL_VERSION}. ` +
      'Pin "bedrock-protocol" to that exact version (package.json) or re-port tools/patches first.'
    )
  }
  let n = 0
  for (const [file, rel] of BEDROCK_PROTOCOL_PATCHES) {
    const src = path.join(ROOT, 'tools', 'patches', 'bedrock-protocol', file)
    const dest = path.join(bpRoot, 'src', rel)
    if (!fs.existsSync(src)) throw new Error(`[patch-deps] missing patch ${file}`)
    if (!fs.existsSync(path.dirname(dest))) throw new Error(`[patch-deps] missing dest dir for ${rel}`)
    fs.copyFileSync(src, dest)
    console.log('[patch-deps]', file, '→', path.relative(nodeModules, dest))
    n++
  }
  return n
}

const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const isMain = !!process.argv[1] && samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))
if (isMain) {
  try {
    applyBedrockProtocolPatches(path.join(ROOT, 'node_modules'))
    console.log('[patch-deps] done')
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
