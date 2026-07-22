/**
 * Apply vendored patches to node_modules after npm install.
 * Shared by PC (postinstall) and Android prepare.
 *
 * Bedrock 1.26+ TokenPayload / offline login — without this, real clients
 * get "Server authentication error" on the hub (PC and Android).
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

function copyPatch (relFrom, relTo) {
  const src = path.join(ROOT, 'tools', 'patches', relFrom)
  const dest = path.join(ROOT, relTo)
  if (!fs.existsSync(src)) {
    console.warn('[patch-deps] missing', relFrom)
    return false
  }
  if (!fs.existsSync(path.dirname(dest))) {
    console.warn('[patch-deps] skip (no dest dir)', relTo)
    return false
  }
  fs.copyFileSync(src, dest)
  console.log('[patch-deps]', relFrom, '→', relTo)
  return true
}

function patchBedrockProtocolAuth () {
  const base = 'node_modules/bedrock-protocol/src'
  copyPatch('bedrock-protocol/loginVerify.js', path.join(base, 'handshake/loginVerify.js'))
  copyPatch('bedrock-protocol/serverPlayer.js', path.join(base, 'serverPlayer.js'))
  copyPatch('bedrock-protocol/keyExchange.js', path.join(base, 'handshake/keyExchange.js'))
  copyPatch('bedrock-protocol/connection.js', path.join(base, 'connection.js'))
  copyPatch('bedrock-protocol/framer.js', path.join(base, 'transforms/framer.js'))
  // Same relay behavior on PC + Android (immediate start_game, safe parse fail)
  copyPatch('bedrock-protocol/relay.js', path.join(base, 'relay.js'))
}

patchBedrockProtocolAuth()
console.log('[patch-deps] done')
