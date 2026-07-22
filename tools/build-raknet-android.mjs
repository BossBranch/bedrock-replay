/**
 * Cross-compile raknet-native for nodejs-mobile (Android NDK + libnode headers).
 *
 * Usage (repo root):
 *   node tools/build-raknet-android.mjs
 *   node tools/build-raknet-android.mjs --abi arm64-v8a
 *   node tools/build-raknet-android.mjs --abi all
 *
 * Env:
 *   ANDROID_NDK_HOME / ANDROID_NDK / ANDROID_SDK_ROOT
 *   ANDROID_PLATFORM (default android-26, matches app minSdk)
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const ABI_MAP = {
  'arm64-v8a': { prebuild: 'android-arm64', arch: 'arm64' },
  'armeabi-v7a': { prebuild: 'android-arm', arch: 'arm' },
  x86_64: { prebuild: 'android-x64', arch: 'x64' }
}

function die (msg) {
  console.error(msg)
  process.exit(1)
}

function findNdk () {
  const candidates = [
    process.env.ANDROID_NDK_HOME,
    process.env.ANDROID_NDK,
    process.env.NDK_HOME,
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, 'ndk'),
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'ndk'),
    'C:\\Android\\Sdk\\ndk',
    path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'ndk')
  ].filter(Boolean)

  for (const c of candidates) {
    if (!fs.existsSync(c)) continue
    if (fs.existsSync(path.join(c, 'build', 'cmake', 'android.toolchain.cmake'))) return c
    // SDK ndk/<version>/
    try {
      const vers = fs.readdirSync(c)
        .map((n) => path.join(c, n))
        .filter((p) => fs.existsSync(path.join(p, 'build', 'cmake', 'android.toolchain.cmake')))
        .sort()
      if (vers.length) return vers[vers.length - 1]
    } catch {}
  }
  return null
}

function parseArgs (argv) {
  const out = { abis: ['arm64-v8a'], clean: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--abi' && argv[i + 1]) {
      const v = argv[++i]
      out.abis = v === 'all' ? Object.keys(ABI_MAP) : v.split(',').map((s) => s.trim())
    } else if (a === '--clean') out.clean = true
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node tools/build-raknet-android.mjs [--abi arm64-v8a|all] [--clean]`)
      process.exit(0)
    }
  }
  return out
}

function which (cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null
}

function findNinja () {
  const fromPath = which('ninja')
  if (fromPath) return fromPath
  const sdkRoots = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    'C:\\Android\\Sdk',
    path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk')
  ].filter(Boolean)
  for (const sdk of sdkRoots) {
    const cmakeRoot = path.join(sdk, 'cmake')
    if (!fs.existsSync(cmakeRoot)) continue
    for (const ver of fs.readdirSync(cmakeRoot).sort().reverse()) {
      const n = path.join(cmakeRoot, ver, 'bin', 'ninja.exe')
      if (fs.existsSync(n)) return n
    }
  }
  return null
}

/** Shallow-ish recursive copy; skips bulky dirs via skip(name). */
function mirrorDir (src, dest, { skip } = {}) {
  fs.mkdirSync(dest, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    if (skip && skip(name)) continue
    const from = path.join(src, name)
    const to = path.join(dest, name)
    const st = fs.statSync(from)
    if (st.isDirectory()) mirrorDir(from, to, { skip })
    else fs.copyFileSync(from, to)
  }
}

/** Upstream RakNet assumes ancient Android Bionic headers. */
function applyAndroidRaknetFixes (srcRoot) {
  const fileList = path.join(srcRoot, 'raknet', 'Source', 'FileList.cpp')
  if (!fs.existsSync(fileList)) {
    console.warn('WARN: FileList.cpp missing at', fileList)
    return
  }
  let text = fs.readFileSync(fileList, 'utf8')
  if (/#include\s*<asm\/io\.h>/.test(text)) {
    text = text.replace(
      /(#if\s+defined\(ANDROID\)\r?\n)#include\s*<asm\/io\.h>/,
      '$1// Android NDK: no <asm/io.h>\n#include <unistd.h>'
    )
    fs.writeFileSync(fileList, text)
    console.log('Patched FileList.cpp (asm/io.h → unistd.h)')
  } else {
    console.log('FileList.cpp already without asm/io.h')
  }

  // Android: pthread is in libc — do not link -lpthread
  const rakCMake = path.join(srcRoot, 'raknet', 'CMakeLists.txt')
  if (fs.existsSync(rakCMake)) {
    let cm = fs.readFileSync(rakCMake, 'utf8')
    const needle = 'set(RAKNET_LIBRARY_LIBS pthread)'
    const repl = 'if(ANDROID)\n\tset(RAKNET_LIBRARY_LIBS "")\nelse()\n\tset(RAKNET_LIBRARY_LIBS pthread)\nendif()'
    if (cm.includes(needle) && !cm.includes('if(ANDROID)')) {
      cm = cm.replace(needle, repl)
      fs.writeFileSync(rakCMake, cm)
      console.log('Patched raknet/CMakeLists.txt (no -lpthread on Android)')
    }
  }
}

const args = parseArgs(process.argv.slice(2))
const ndk = findNdk()
if (!ndk) die('Android NDK not found. Set ANDROID_NDK_HOME.')

const platform = process.env.ANDROID_PLATFORM || 'android-26'
const libnodeRoot = path.join(ROOT, 'android', 'app', 'libnode')
const nodeInc = path.join(libnodeRoot, 'include', 'node')
if (!fs.existsSync(path.join(nodeInc, 'node_api.h'))) {
  die(`Missing node headers at ${nodeInc}\nRun: npm run android:libnode`)
}

const srcPkg =
  fs.existsSync(path.join(ROOT, 'node_modules', 'raknet-native', 'CMakeLists.txt'))
    ? path.join(ROOT, 'node_modules', 'raknet-native')
    : path.join(ROOT, '_diag', 'raknet-android-spike', 'node-raknet-native')

if (!fs.existsSync(path.join(srcPkg, 'CMakeLists.txt'))) {
  die(`raknet-native sources not found under node_modules or _diag spike`)
}

// Ensure node-addon-api is resolvable from srcPkg
const napiPkg = path.join(srcPkg, 'node_modules', 'node-addon-api')
if (!fs.existsSync(napiPkg)) {
  console.log('Installing node-addon-api in', srcPkg)
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const r = spawnSync(npm, ['install', 'node-addon-api@^7', '--no-audit', '--no-fund'], {
    cwd: srcPkg,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (r.status !== 0) die('npm install node-addon-api failed')
}

const cmake = which('cmake')
if (!cmake) die('cmake not on PATH')

const ninja = findNinja()
if (!ninja) die('ninja.exe not found (install Android SDK CMake package)')

const outRoot = path.join(ROOT, 'android', 'native-prebuilds', 'raknet-native')
// Prefer ASCII path — NDK/CMake choke on Cyrillic user dirs on Windows
const asciiRoot = process.env.BEDROCK_RAKNET_BUILD_ROOT || 'C:\\dev\\bedrock-raknet-android'
const buildRoot = path.join(asciiRoot, 'cmake-build')
const workSrc = path.join(asciiRoot, 'src-raknet-native')
fs.mkdirSync(outRoot, { recursive: true })
fs.mkdirSync(buildRoot, { recursive: true })

// Mirror sources + node headers to ASCII tree when ROOT has non-ASCII
const needsMirror = /[^\x00-\x7F]/.test(ROOT) || process.env.BEDROCK_RAKNET_FORCE_MIRROR === '1'
let cmakeSrc = srcPkg
let cmakeNodeInc = nodeInc
let cmakeLibnodeRoot = libnodeRoot
if (needsMirror) {
  console.log('Mirroring sources to ASCII path:', asciiRoot)
  mirrorDir(srcPkg, workSrc, {
    skip: (name) => name === 'node_modules' || name === 'prebuilds' || name === 'test' || name === '.git'
  })
  // Keep node-addon-api for execute_process in CMakeLists
  const napiSrc = path.join(srcPkg, 'node_modules', 'node-addon-api')
  const napiDst = path.join(workSrc, 'node_modules', 'node-addon-api')
  if (fs.existsSync(napiSrc)) mirrorDir(napiSrc, napiDst)
  const mirroredLibnode = path.join(asciiRoot, 'libnode')
  mirrorDir(libnodeRoot, mirroredLibnode)
  cmakeSrc = workSrc
  cmakeNodeInc = path.join(mirroredLibnode, 'include', 'node')
  cmakeLibnodeRoot = mirroredLibnode
}

applyAndroidRaknetFixes(cmakeSrc)

const toolchain = path.join(ndk, 'build', 'cmake', 'android.toolchain.cmake')
console.log('NDK:', ndk)
console.log('Platform:', platform)
console.log('Sources:', cmakeSrc)
console.log('Node includes:', cmakeNodeInc)
console.log('Generator: Ninja @', ninja)
console.log('ABIs:', args.abis.join(', '))

for (const abi of args.abis) {
  const meta = ABI_MAP[abi]
  if (!meta) die(`Unknown ABI: ${abi}`)

  const buildDir = path.join(buildRoot, abi)
  if (args.clean && fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true, force: true })
  }
  fs.mkdirSync(buildDir, { recursive: true })

  const libnodeSo = path.join(cmakeLibnodeRoot, 'bin', abi, 'libnode.so')
  if (!fs.existsSync(libnodeSo)) {
    console.warn(`WARN: ${libnodeSo} missing — linking with unresolved symbols`)
  }

  // cmake-js compatibility vars used by raknet-native CMakeLists.txt
  const cmakeArgs = [
    '-G', 'Ninja',
    '-S', cmakeSrc,
    '-B', buildDir,
    `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`,
    `-DCMAKE_MAKE_PROGRAM=${ninja}`,
    `-DANDROID_ABI=${abi}`,
    `-DANDROID_PLATFORM=${platform}`,
    '-DANDROID_STL=c++_shared',
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_JS_INC=${cmakeNodeInc}`,
    '-DCMAKE_JS_SRC=',
    // Link against shipped libnode so N-API symbols resolve at load time
    ...(fs.existsSync(libnodeSo) ? [`-DCMAKE_JS_LIB=${libnodeSo}`] : ['-DCMAKE_JS_LIB=']),
    '-DRAKNET_ENABLE_SAMPLES=OFF',
    '-DRAKNET_ENABLE_DLL=OFF',
    '-DRAKNET_ENABLE_STATIC=ON',
    // Android: RakNet wants pthread; NDK provides it via libc
    '-DCMAKE_CXX_FLAGS=-fPIC -DANDROID -DNAPI_VERSION=6',
    '-DCMAKE_C_FLAGS=-fPIC -DANDROID'
  ]

  console.log(`\n=== Configure ${abi} ===`)
  let r = spawnSync(cmake, cmakeArgs, { stdio: 'inherit', shell: false })
  if (r.status !== 0) die(`cmake configure failed for ${abi}`)

  console.log(`\n=== Build ${abi} ===`)
  const jobs = Math.max(2, os.cpus()?.length || 4)
  r = spawnSync(cmake, ['--build', buildDir, '--config', 'Release', '-j', String(jobs)], {
    stdio: 'inherit',
    shell: false
  })
  if (r.status !== 0) die(`cmake build failed for ${abi}`)

  const built = findBuiltNode(buildDir)
  if (!built) die(`Built .node/.so not found under ${buildDir}`)

  const destDir = path.join(outRoot, meta.prebuild)
  fs.mkdirSync(destDir, { recursive: true })
  const dest = path.join(destDir, 'node-raknet.node')
  fs.copyFileSync(built, dest)
  console.log(`OK ${abi} → ${dest} (${fs.statSync(dest).size} bytes)`)
}

console.log('\nDone. Next: npm run android:prepare (will pack prebuilds) then rebuild APK.')

function findBuiltNode (buildDir) {
  const names = ['node-raknet.node', 'libnode-raknet.so', 'node-raknet.so']
  const stack = [buildDir]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'CMakeFiles' || e.name === '.cmake') continue
        stack.push(full)
      } else if (names.includes(e.name) || (e.name.startsWith('node-raknet') && (e.name.endsWith('.node') || e.name.endsWith('.so')))) {
        return full
      }
    }
  }
  return null
}
