/**
 * Prune hub node_modules before PC electron-builder pack.
 * Same idea as Android assets prune — drop unused minecraft-data packs + build junk.
 *
 * Usage (from repo root or C:\\bsr-build):
 *   node tools/prune-for-pc-dist.mjs
 *   node tools/prune-for-pc-dist.mjs --root C:/bsr-build
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const argRoot = process.argv.find((a, i) => process.argv[i - 1] === '--root')
const ROOT = path.resolve(argRoot || path.join(__dirname, '..'))
const NM = path.join(ROOT, 'node_modules')

function rmrf (p) {
  if (!fs.existsSync(p)) return
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  } catch {
    if (process.platform === 'win32') {
      spawnSync('powershell.exe', [
        '-NoProfile', '-Command',
        `Remove-Item -LiteralPath '${p.replace(/'/g, "''")}' -Recurse -Force -ErrorAction SilentlyContinue`
      ], { stdio: 'ignore' })
    }
  }
}

function dirMB (p) {
  if (!fs.existsSync(p)) return 0
  let sum = 0
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name)
      let st
      try { st = fs.statSync(full) } catch { continue }
      if (st.isDirectory()) walk(full)
      else sum += st.size
    }
  }
  walk(p)
  return sum / (1024 * 1024)
}

if (!fs.existsSync(NM)) {
  console.error('No node_modules at', NM)
  process.exit(1)
}

console.log(`prune PC dist @ ${ROOT}`)
console.log(`node_modules before: ${dirMB(NM).toFixed(1)} MB`)

// Runtime does not need TypeScript (pulled in by jsp-raknet)
for (const junk of ['typescript', '@types']) {
  const p = path.join(NM, junk)
  if (fs.existsSync(p)) {
    console.log(`remove ${junk} (${dirMB(p).toFixed(1)} MB)`)
    rmrf(p)
  }
}

/**
 * Keep protocol packs we actually offer + dataPaths closure.
 * Wider than Android (PC version picker) but nowhere near full 370MB dump.
 */
function pruneMinecraftData () {
  const md = path.join(NM, 'minecraft-data', 'minecraft-data', 'data')
  if (!fs.existsSync(md)) {
    console.warn('minecraft-data missing, skip')
    return
  }
  const pathsFile = path.join(md, 'dataPaths.json')
  // Curated bases + dataPaths closure (same idea as Android pack)
  const targets = [
    '1.16.201',
    '1.17.0',
    '1.19.1', '1.19.10', '1.19.40', '1.19.50',
    '1.21.60', '1.21.70', '1.21.80', '1.21.100', '1.21.111',
    '1.26.30'
  ]
  const keepBedrock = new Set(['common', 'latest'])
  const keepPc = new Set(['common'])
  if (fs.existsSync(pathsFile)) {
    const dataPaths = JSON.parse(fs.readFileSync(pathsFile, 'utf8'))
    const bedrockKeys = Object.keys(dataPaths.bedrock || {})
    for (const t of targets) {
      // Exact or nearest lower base present in dataPaths
      let hit = bedrockKeys.includes(t) ? t : null
      if (!hit) {
        const lower = bedrockKeys
          .filter((k) => /^\d/.test(k) && k <= t)
          .sort()
          .at(-1)
        hit = lower || null
      }
      if (!hit) continue
      keepBedrock.add(hit)
      const entry = dataPaths.bedrock[hit]
      if (!entry) continue
      for (const ref of Object.values(entry)) {
        const s = String(ref)
        let m = s.match(/^bedrock\/([^/]+)$/)
        if (m) keepBedrock.add(m[1])
        m = s.match(/^pc\/([^/]+)$/)
        if (m) keepPc.add(m[1])
      }
    }
  } else {
    for (const t of targets) keepBedrock.add(t)
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
  if (fs.existsSync(bedrock)) {
    let removed = 0
    for (const name of fs.readdirSync(bedrock)) {
      if (!keepBedrock.has(name)) {
        rmrf(path.join(bedrock, name))
        removed++
      }
    }
    console.log(`minecraft-data bedrock: kept ${[...keepBedrock].sort().join(', ')}, removed ${removed}`)
  }
}

pruneMinecraftData()

console.log(`node_modules after: ${dirMB(NM).toFixed(1)} MB`)
console.log('OK')
