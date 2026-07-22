/**
 * Download nodejs-mobile Android binaries into android/app/libnode/
 * node tools/download-libnode.mjs
 */
import fs from 'fs'
import path from 'path'
import https from 'https'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'android', 'app', 'libnode')
const VER = 'v18.20.4'
const URL = `https://github.com/nodejs-mobile/nodejs-mobile/releases/download/${VER}/nodejs-mobile-${VER}-android.zip`

function download (url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const go = (u, n = 0) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (n > 5) return reject(new Error('too many redirects'))
          return go(res.headers.location, n + 1)
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
      }).on('error', reject)
    }
    go(url)
  })
}

fs.mkdirSync(OUT, { recursive: true })
const zip = path.join(OUT, 'nodejs-mobile-android.zip')
console.log('Downloading', URL)
await download(URL, zip)
console.log('Extracting…')

const tmp = path.join(OUT, '_tmp')
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })

// Prefer PowerShell Expand-Archive on Windows
if (process.platform === 'win32') {
  execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force`
  ], { stdio: 'inherit' })
} else {
  execFileSync('unzip', ['-o', zip, '-d', tmp], { stdio: 'inherit' })
}

// Find bin/ + include/ inside extract
function findDir (root, name) {
  const stack = [root]
  while (stack.length) {
    const d = stack.pop()
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === name) return p
        stack.push(p)
      }
    }
  }
  return null
}

const bin = findDir(tmp, 'bin')
const include = findDir(tmp, 'include')
if (!bin) throw new Error('bin/ not found in zip')

fs.rmSync(path.join(OUT, 'bin'), { recursive: true, force: true })
fs.cpSync(bin, path.join(OUT, 'bin'), { recursive: true })
if (include) {
  fs.rmSync(path.join(OUT, 'include'), { recursive: true, force: true })
  fs.cpSync(include, path.join(OUT, 'include'), { recursive: true })
}

fs.rmSync(tmp, { recursive: true, force: true })
fs.unlinkSync(zip)

// Bundle libc++_shared.so next to libnode (required at runtime)
const ndkCandidates = [
  process.env.ANDROID_NDK_HOME,
  'C:/Android/Sdk/ndk/27.0.12077973',
  path.join(process.env.LOCALAPPDATA || '', 'Android/Sdk/ndk/27.0.12077973')
].filter(Boolean)
const abiMap = {
  'arm64-v8a': 'aarch64-linux-android',
  'armeabi-v7a': 'arm-linux-androideabi',
  x86_64: 'x86_64-linux-android'
}
let ndkRoot = ndkCandidates.find((p) => fs.existsSync(p))
if (ndkRoot) {
  const prebuilt = path.join(
    ndkRoot,
    'toolchains/llvm/prebuilt/windows-x86_64/sysroot/usr/lib'
  )
  for (const [abi, triple] of Object.entries(abiMap)) {
    const src = path.join(prebuilt, triple, 'libc++_shared.so')
    const destDir = path.join(OUT, 'bin', abi)
    if (fs.existsSync(src) && fs.existsSync(destDir)) {
      fs.copyFileSync(src, path.join(destDir, 'libc++_shared.so'))
      console.log('libc++_shared →', abi)
    }
  }
} else {
  console.warn('NDK not found — copy libc++_shared.so into app/libnode/bin/<abi>/ before build')
}

console.log('OK →', OUT)
console.log('Check:', path.join(OUT, 'bin', 'arm64-v8a', 'libnode.so'))
