/**
 * Build android/app/src/main/assets/nodejs-project for the APK.
 * Run from repo root: node tools/prepare-android-node.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'nodejs-project')

function rmrf (p) {
  if (!fs.existsSync(p)) return
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    if (process.platform === 'win32') {
      spawnSync('powershell.exe', [
        '-NoProfile', '-Command',
        `Remove-Item -LiteralPath '${p.replace(/'/g, "''")}' -Recurse -Force -ErrorAction SilentlyContinue`
      ], { stdio: 'ignore' })
    }
  }
  if (fs.existsSync(p)) {
    // last resort
    try { fs.rmSync(p, { recursive: true, force: true }) } catch (e) {
      console.warn('rmrf incomplete:', p, e.message)
    }
  }
}

function copyDir (src, dest, { filter } = {}) {
  fs.mkdirSync(dest, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    if (filter && !filter(name, path.join(src, name))) continue
    const from = path.join(src, name)
    const to = path.join(dest, name)
    const st = fs.statSync(from)
    if (st.isDirectory()) copyDir(from, to, { filter })
    else fs.copyFileSync(from, to)
  }
}

rmrf(OUT)
fs.mkdirSync(OUT, { recursive: true })

const pkg = {
  name: 'bedrock-replay-android',
  version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
  private: true,
  type: 'module',
  main: 'src/mobileMain.js',
  engines: { node: '>=18' },
  dependencies: {
    'bedrock-protocol': '^3.57.0',
    'jsp-raknet': '^2.1.3'
  }
}
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

copyDir(path.join(ROOT, 'src'), path.join(OUT, 'src'), {
  filter: (name) => name !== 'selftest.js'
})
fs.copyFileSync(
  path.join(ROOT, 'config.example.json'),
  path.join(OUT, 'config.example.json')
)
{
  const dataSrc = path.join(ROOT, 'data', 'bedrock-client-versions.json')
  const dataOut = path.join(OUT, 'data')
  if (fs.existsSync(dataSrc)) {
    fs.mkdirSync(dataOut, { recursive: true })
    fs.copyFileSync(dataSrc, path.join(dataOut, 'bedrock-client-versions.json'))
  }
}

// Prefer pure-JS raknet; skip native compile scripts
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npm = spawnSync(
  npmCmd,
  ['install', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'],
  {
    cwd: OUT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, npm_config_production: 'true' }
  }
)
const nm = path.join(OUT, 'node_modules', 'bedrock-protocol')
if (!fs.existsSync(nm)) {
  console.error('npm install failed — bedrock-protocol missing', npm.status, npm.error)
  process.exit(1)
}

const prebuildRoot = path.join(ROOT, 'android', 'native-prebuilds', 'raknet-native')
const hasAndroidNative = fs.existsSync(path.join(prebuildRoot, 'android-arm64', 'node-raknet.node'))

/**
 * Ship raknet-native JS + our NDK-built .node (not npm desktop prebuilds).
 */
function installAndroidRaknetNative () {
  const src = path.join(ROOT, 'node_modules', 'raknet-native')
  const dest = path.join(OUT, 'node_modules', 'raknet-native')
  if (!fs.existsSync(src)) {
    console.warn('raknet-native not in repo node_modules — skip native pack')
    return false
  }
  rmrf(dest)
  fs.mkdirSync(dest, { recursive: true })
  for (const name of ['package.json', 'index.js', 'index.d.ts', 'binding.js']) {
    const from = path.join(src, name)
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dest, name))
  }
  // JS wrapper API (Client/Server) — required by index.js
  const libSrc = path.join(src, 'lib')
  if (fs.existsSync(libSrc)) {
    copyDir(libSrc, path.join(dest, 'lib'), {
      filter: (name) => !name.endsWith('.ts') && !name.endsWith('.map')
    })
  }
  // Minimal helpers (debug dep may be missing — binding replaced below)
  fs.mkdirSync(path.join(dest, 'helpers'), { recursive: true })
  const bp = path.join(src, 'helpers', 'buildPath.js')
  if (fs.existsSync(bp)) fs.copyFileSync(bp, path.join(dest, 'helpers', 'buildPath.js'))

  // Android-aware loader
  fs.copyFileSync(
    path.join(ROOT, 'tools', 'android-raknet-binding.js'),
    path.join(dest, 'binding.js')
  )

  // Only our Android prebuilds (drop win/linux/mac)
  const pbOut = path.join(dest, 'prebuilds')
  fs.mkdirSync(pbOut, { recursive: true })
  for (const abiDir of fs.readdirSync(prebuildRoot)) {
    const nodeFile = path.join(prebuildRoot, abiDir, 'node-raknet.node')
    if (!fs.existsSync(nodeFile)) continue
    const d = path.join(pbOut, abiDir)
    fs.mkdirSync(d, { recursive: true })
    fs.copyFileSync(nodeFile, path.join(d, 'node-raknet.node'))
    console.log('packed native prebuild', abiDir, `(${(fs.statSync(nodeFile).size / 1024 / 1024).toFixed(2)} MB)`)
  }
  return true
}

if (hasAndroidNative) {
  console.log('Android raknet-native prebuild found — packing into assets')
  // Drop wrong-ABI transitive copies, then install ours
  for (const bad of ['raknet-native', 'raknet-node']) {
    const p = path.join(OUT, 'node_modules', bad)
    if (fs.existsSync(p)) rmrf(p)
  }
  installAndroidRaknetNative()
} else {
  console.log('No android/native-prebuilds — forcing jsp-raknet only')
  for (const bad of ['raknet-native', 'raknet-node']) {
    const p = path.join(OUT, 'node_modules', bad)
    if (fs.existsSync(p)) {
      console.log('removing', bad)
      rmrf(p)
    }
  }
}

/** Android aapt merges assets and treats path.gz ≈ path — strip junk that collides. */
function pruneForAndroidAssets (dir) {
  if (!fs.existsSync(dir)) return
  const skipDirs = new Set([
    'test', 'tests', 'docs', 'doc', 'example', 'examples', 'sample', 'samples',
    '.github', 'coverage', '__tests__', 'benchmark', 'benchmarks'
  ])
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    let st
    try { st = fs.statSync(full) } catch { continue }
    if (st.isDirectory()) {
      if (skipDirs.has(name) || name.startsWith('.')) {
        rmrf(full)
        continue
      }
      pruneForAndroidAssets(full)
      continue
    }
    // aapt: foo + foo.gz → Duplicate resources
    if (name.endsWith('.gz') || name.endsWith('.md') || name.endsWith('.ts') ||
        name.endsWith('.map') || name === 'LICENSE' || name.startsWith('LICENSE.')) {
      try { fs.unlinkSync(full) } catch {}
    }
  }
}
console.log('pruning assets-incompatible files…')
pruneForAndroidAssets(path.join(OUT, 'node_modules'))

/**
 * Drop unused protocol packs — but keep dataPaths dependency closure.
 * e.g. bedrock/1.26.30 → blocks from 1.26.10, biomes from 1.21.60, materials from pc/1.17.
 */
function pruneMinecraftData () {
  const md = path.join(OUT, 'node_modules', 'minecraft-data', 'minecraft-data', 'data')
  const pathsFile = path.join(md, 'dataPaths.json')
  const targets = [
    '1.16.201',
    '1.19.40', '1.19.50',
    '1.21.100', '1.21.111',
    '1.26.30'
  ]
  const keepBedrock = new Set(['common', 'latest', ...targets])
  const keepPc = new Set(['common'])
  if (fs.existsSync(pathsFile)) {
    const dataPaths = JSON.parse(fs.readFileSync(pathsFile, 'utf8'))
    for (const t of targets) {
      const entry = dataPaths.bedrock?.[t]
      if (!entry) continue
      for (const ref of Object.values(entry)) {
        const s = String(ref)
        let m = s.match(/^bedrock\/([^/]+)$/)
        if (m) keepBedrock.add(m[1])
        m = s.match(/^pc\/([^/]+)$/)
        if (m) keepPc.add(m[1])
      }
    }
  }

  const pc = path.join(md, 'pc')
  if (fs.existsSync(pc)) {
    let removed = 0
    for (const name of fs.readdirSync(pc)) {
      if (!keepPc.has(name)) {
        rmrf(path.join(pc, name))
        removed++
      }
    }
    console.log(`minecraft-data pc: kept ${[...keepPc].join(', ')}, removed ${removed}`)
  }

  const bedrock = path.join(md, 'bedrock')
  if (!fs.existsSync(bedrock)) return
  let removed = 0
  for (const name of fs.readdirSync(bedrock)) {
    if (!keepBedrock.has(name)) {
      rmrf(path.join(bedrock, name))
      removed++
    }
  }
  console.log(`minecraft-data bedrock: kept ${[...keepBedrock].sort().join(', ')}, removed ${removed}`)
}
pruneMinecraftData()

// Default bedrock-protocol to native when we shipped .node; else keep jsp force-patch
const bpSrc = path.join(OUT, 'node_modules', 'bedrock-protocol', 'src')
if (!hasAndroidNative) {
  for (const rel of ['options.js', 'createClient.js']) {
    const f = path.join(bpSrc, rel)
    if (!fs.existsSync(f)) continue
    let text = fs.readFileSync(f, 'utf8')
    text = text
      .replace(/raknetBackend:\s*'raknet-native'/g, "raknetBackend: 'jsp-raknet'")
      .replace(/require\('\.\/rak'\)\('raknet-native'\)/g, "require('./rak')('jsp-raknet')")
    fs.writeFileSync(f, text)
    console.log('patched', rel, '→ jsp-raknet')
  }
} else {
  console.log('keeping bedrock-protocol defaults (raknet-native)')
}

// jsp-raknet: RakNet 11 + cookies + DNS resolve (needed for public Bedrock servers)
function patchJspRaknet () {
  const patchRoot = path.join(ROOT, 'tools', 'patches', 'jsp-raknet')
  const destRoot = path.join(OUT, 'node_modules', 'jsp-raknet')
  const files = [
    'js/Client.js',
    'js/Server.js',
    'js/protocol/OpenConnectionReply1.js',
    'js/protocol/OpenConnectionRequest2.js'
  ]
  for (const rel of files) {
    const src = path.join(patchRoot, rel)
    const dest = path.join(destRoot, rel)
    if (fs.existsSync(src) && fs.existsSync(path.dirname(dest))) {
      fs.copyFileSync(src, dest)
      console.log('patched jsp-raknet', rel)
    }
  }
}
patchJspRaknet()

// Offline / 1.26 TokenPayload login + relay parity with PC postinstall
{
  const bpPatches = [
    ['loginVerify.js', 'handshake/loginVerify.js'],
    ['serverPlayer.js', 'serverPlayer.js'],
    ['keyExchange.js', 'handshake/keyExchange.js'],
    ['connection.js', 'connection.js'],
    ['framer.js', 'transforms/framer.js'],
    ['relay.js', 'relay.js']
  ]
  for (const [file, rel] of bpPatches) {
    const src = path.join(ROOT, 'tools', 'patches', 'bedrock-protocol', file)
    const dest = path.join(OUT, 'node_modules', 'bedrock-protocol', 'src', rel)
    if (fs.existsSync(src) && fs.existsSync(path.dirname(dest))) {
      fs.copyFileSync(src, dest)
      console.log('patched bedrock-protocol', rel)
    }
  }
}

function dirSizeMb (dir) {
  let sum = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name)
      const st = fs.statSync(p)
      if (st.isDirectory()) stack.push(p)
      else sum += st.size
    }
  }
  return (sum / (1024 * 1024)).toFixed(1)
}

console.log('OK →', OUT, `(${dirSizeMb(OUT)} MB)`)
