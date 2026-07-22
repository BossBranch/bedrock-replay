/**
 * Android / nodejs-mobile loader for raknet-native.
 * Replaces upstream binding.js which expects desktop prebuild layout + bindings/.
 */
const fs = require('fs')
const path = require('path')

function archCandidates () {
  const a = process.arch
  if (a === 'arm64' || a === 'aarch64') return ['android-arm64', 'android-arm64-v8a']
  if (a === 'arm' || a === 'armv7l') return ['android-arm', 'android-armeabi-v7a']
  if (a === 'x64' || a === 'x86_64') return ['android-x64', 'android-x86_64']
  return [`android-${a}`]
}

function candidates () {
  const root = __dirname
  const out = []
  for (const dir of archCandidates()) {
    out.push(path.join(root, 'prebuilds', dir, 'node-raknet.node'))
  }
  // Fallback: any prebuilds/*/node-raknet.node matching android
  try {
    const pb = path.join(root, 'prebuilds')
    for (const name of fs.readdirSync(pb)) {
      if (!name.startsWith('android')) continue
      out.push(path.join(pb, name, 'node-raknet.node'))
    }
  } catch {}
  out.push(path.join(root, 'build', 'Release', 'node-raknet.node'))
  return out
}

let bindings = null
const tried = []
for (const p of candidates()) {
  tried.push(p)
  try {
    if (!fs.existsSync(p)) continue
    bindings = require(p)
    break
  } catch (e) {
    tried.push(String(e && e.message))
  }
}

if (!bindings) {
  const err = new Error(
    'raknet-native: no Android .node loaded. Tried:\n' + tried.join('\n')
  )
  err.code = 'RAKNET_NATIVE_MISSING'
  throw err
}

module.exports = bindings
