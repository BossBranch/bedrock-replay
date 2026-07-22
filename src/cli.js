#!/usr/bin/env node
import { loadConfig, listReplays } from './config.js'
import { startHub } from './hub.js'
import { listSupportedBedrockVersions } from './version.js'
import { liveAddress, playAddress } from './transfer.js'

function usage () {
  const cfg = (() => { try { return loadConfig() } catch { return {} } })()
  const live = liveAddress(cfg)
  const play = playAddress(cfg)
  console.log(`
Bedrock Replay — dual-port hub (one process)

  LIVE  (record)  ${live.host}:${live.port}
  PLAY  (replay)  ${play.host}:${play.port}

Usage:
  node src/cli.js start               Both ports (recommended)
  node src/cli.js play [file]         Replay port only
  node src/cli.js list                List replays
  node src/cli.js versions            Supported Bedrock versions

Flow:
  1) Edit config.json (destination, version, advertiseHost)
  2) start.bat
  3) In Minecraft add server → LIVE address → .start → play
  4) Chat .play  → transfers you to PLAY port with that replay
  5) Chat .live  → leave replay (disconnect), then join LIVE again
`)
}

const args = process.argv.slice(2)
const cmd = args[0]

function getFlag (name, fallback) {
  const i = args.indexOf(name)
  if (i === -1) return fallback
  return args[i + 1] ?? fallback
}

async function main () {
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    usage()
    return
  }

  if (cmd === 'list') {
    const cfg = loadConfig()
    const list = listReplays(cfg.replaysDir)
    if (!list.length) {
      console.log('No replays yet.')
      return
    }
    for (const r of list) {
      console.log(`${r.name}\t${(r.size / 1024).toFixed(1)} KB\t${r.mtime.toISOString()}`)
    }
    return
  }

  if (cmd === 'versions') {
    const list = listSupportedBedrockVersions()
    console.log(`Supported bedrock_* versions (${list.length}):`)
    console.log(list.join(', '))
    console.log('\nSpectator viewer: >= 1.19.50  |  older: creative+noclip fallback')
    console.log('See docs/VERSIONS.md')
    return
  }

  if (cmd === 'start' || cmd === 'hub' || cmd === 'record') {
    const fileArg = getFlag('--file', null) ||
      args.slice(1).find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--file')
    await startHub({ mode: 'both', file: fileArg || undefined })
    return
  }

  if (cmd === 'play') {
    const speedRaw = getFlag('--speed', null)
    const speed = speedRaw != null ? Number(speedRaw) : undefined
    const follow = args.includes('--follow')
    const fileArg = args.slice(1).find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--speed')
    await startHub({
      mode: 'replay',
      file: fileArg,
      speed,
      follow: follow ? true : undefined
    })
    return
  }

  console.error(`Unknown command: ${cmd}`)
  usage()
  process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
