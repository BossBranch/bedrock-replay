import fs from 'fs'
import path from 'path'
import { ReplayWriter, loadTimeline, sanitize, revive, SOUND_PACKETS, SKIP_PLAY_CLIENTBOUND, SKIP_RECORD_CLIENTBOUND } from './format.js'
import { loadTimelineStreaming, writeReplayMeta, readReplayMeta, replayMetaPath } from './replayStream.js'
import {
  compareSemver,
  viewerModeForVersion,
  isBedrockVersionSupported,
  SPECTATOR_SINCE,
  FREECAM_SINCE,
  possessEnabledForVersion,
  versionsCompatible,
  resolveToSupportedVersion,
  protocolIdForVersion
} from './version.js'
import { fileURLToPath } from 'url'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'replays')
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, '_selftest.mcreplay.gz')

const sample = {
  hello: 'world',
  buf: Buffer.from('abc'),
  big: 1234567890123456789n,
  nested: { arr: [1, Buffer.from([1, 2, 3])] }
}

const round = revive(JSON.parse(JSON.stringify(sanitize(sample))))
if (Buffer.from(round.buf).toString() !== 'abc') throw new Error('buffer roundtrip failed')
if (round.big !== 1234567890123456789n) throw new Error('bigint roundtrip failed')

const w = new ReplayWriter(file, { version: '1.21.100', destination: { host: 'x', port: 1 } })
w.clientbound('text', { type: 'system', needs_translation: false, message: 'hi', xuid: '', platform_chat_id: '', filtered_message: '' })
w.camera({ x: 1, y: 2, z: 3, pitch: 0, yaw: 90, head_yaw: 90 })
w.clientbound('start_game', { runtime_entity_id: 1n, foo: Buffer.from('chunk') })
w.clientbound('level_sound_event', { sound_id: 1, position: { x: 1, y: 2, z: 3 }, extra_data: -1, entity_type: '', is_baby_mob: false, is_global: false })
w.clientbound('play_sound', { name: 'random.pop', coordinates: { x: 1, y: 2, z: 3 }, volume: 1, pitch: 1 })
w.rawClientbound(Buffer.from([0xfe, 0x01, 0x02, 0x03, 0x04]))
await w.close({ reason: 'test' })

const { header, events } = await loadTimeline(file)
if (header.version !== '1.21.100') throw new Error('bad header')
if (!events.some((e) => e.type === 'pkt' && e.n === 'start_game')) throw new Error('missing start_game')
if (!events.some((e) => e.type === 'cam')) throw new Error('missing cam')
if (!events.some((e) => e.type === 'pkt' && e.n === 'level_sound_event')) throw new Error('missing level_sound_event')
if (!events.some((e) => e.type === 'pkt' && e.n === 'play_sound')) throw new Error('missing play_sound')
const rawEv = events.find((e) => e.type === 'pkt' && e.raw)
if (!rawEv || Buffer.from(rawEv.b, 'base64').length !== 5) throw new Error('rawClientbound roundtrip failed')

for (const n of SOUND_PACKETS) {
  if (SKIP_RECORD_CLIENTBOUND.has(n) || SKIP_PLAY_CLIENTBOUND.has(n)) {
    throw new Error(`sound packet ${n} must not be in SKIP_* lists`)
  }
}

if (viewerModeForVersion('1.19.50') !== 'spectator') throw new Error('spectator since 1.19.50')
if (viewerModeForVersion('1.19.40') !== 'creative_noclip') throw new Error('fallback below spectator')
if (viewerModeForVersion('1.16.201') !== 'creative_noclip') throw new Error('1.16 freecam mode')
if (possessEnabledForVersion('1.19.50') !== true) throw new Error('possess on spectator')
if (possessEnabledForVersion('1.19.40') !== false) throw new Error('no possess below spectator')
if (compareSemver('1.21.100', SPECTATOR_SINCE) < 0) throw new Error('semver compare')
if (compareSemver(FREECAM_SINCE, '1.16.200') < 0) throw new Error('freecam floor')
if (!isBedrockVersionSupported('1.21.100')) throw new Error('1.21.100 should be supported')
if (!isBedrockVersionSupported('1.16.201')) throw new Error('1.16.201 should be supported')
if (!versionsCompatible('1.26.20', '1.26.20')) throw new Error('same version compatible')
if (!versionsCompatible('1.26.22', '1.26.20')) throw new Error('1.26.22 ~ 1.26.20 should match')
if (versionsCompatible('1.26.20', '1.26.30')) throw new Error('different protocol must not match')
if (resolveToSupportedVersion('1.26.22') !== '1.26.20') {
  throw new Error(`expected 1.26.22 → 1.26.20, got ${resolveToSupportedVersion('1.26.22')}`)
}
if (resolveToSupportedVersion('1.21.123') !== '1.21.120') {
  throw new Error(`expected 1.21.123 → 1.21.120 (not newer), got ${resolveToSupportedVersion('1.21.123')}`)
}
if (protocolIdForVersion('1.26.20') !== 975) throw new Error('1.26.20 protocol id')
if (protocolIdForVersion('1.26.22') !== 975) throw new Error('1.26.22 should map to protocol 975')

// Spill + sidecar meta
const fat = path.join(dir, '_spilltest.mcreplay.gz')
const w2 = new ReplayWriter(fat, { version: '1.21.100' })
w2.clientbound('text', { type: 'system', needs_translation: false, message: 'hi', xuid: '', platform_chat_id: '', filtered_message: '' })
w2.clientbound('level_chunk', { payload: 'x'.repeat(5000) })
const st2 = await w2.close({ reason: 'test' })
writeReplayMeta(fat, { durationMs: st2.durationMs, packets: st2.packets, version: '1.21.100' })
const side = readReplayMeta(fat)
if (!side || side.durationMs == null) throw new Error('meta missing')
const streamed = await loadTimelineStreaming(fat)
if (streamed.spilled < 1) throw new Error('expected spilled chunk')
const chunk = streamed.events.find((e) => e.n === 'level_chunk')
if (!chunk?._spilled || chunk.p?.payload?.length !== 5000) throw new Error('spill roundtrip failed')
streamed.spill.close()
fs.unlinkSync(fat)
try { fs.unlinkSync(replayMetaPath(fat)) } catch {}

fs.unlinkSync(file)
console.log('selftest OK')
