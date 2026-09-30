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
  protocolIdForVersion,
  versionForProtocolId
} from './version.js'
import { configureProtocolShapes, adaptOutgoing, readPlayerList } from './protoShape.js'
import { configureItemLayoutForVersion } from './packetPatch.js'
import { SendPacer } from './control/pacer.js'
import { createRequire } from 'module'
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

// 1.26.40+ protocols: mapping by protocol id, not by label floor
for (const [label, base] of [['1.26.44', '1.26.40'], ['1.26.45', '1.26.45'], ['1.26.52', '1.26.51'], ['1.26.33', '1.26.30']]) {
  if (resolveToSupportedVersion(label) !== base) {
    throw new Error(`expected ${label} → ${base}, got ${resolveToSupportedVersion(label)}`)
  }
}
if (versionForProtocolId(2193) !== '1.26.51') throw new Error('protocol 2193 → 1.26.51')
if (versionForProtocolId(123456) !== null) throw new Error('unknown protocol → null')

// Hub-built packets must survive the 1.26.51 codec with their content intact
{
  const require = createRequire(import.meta.url)
  const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer.js')
  const v = '1.26.51'
  configureProtocolShapes(v)
  if (configureItemLayoutForVersion(v) !== false) throw new Error('1.26.51 ItemV4 stack_id is a bare zigzag32')
  const ser = createSerializer(v)
  const des = createDeserializer(v)
  const roundtrip = (name, params) =>
    des.parsePacketBuffer(ser.createPacketBuffer({ name, params: adaptOutgoing(name, params) })).data.params
  const legacyList = {
    records: {
      type: 'remove',
      records_count: 1,
      records: [{ uuid: '11111111-2222-3333-4444-555555555555' }]
    }
  }
  const back = readPlayerList(roundtrip('player_list', legacyList))
  if (back.records.length !== 1 || back.records[0].type !== 'remove' || back.records[0].legacy_type !== 1) {
    throw new Error('player_list remove lost on 1.26.51')
  }
  const meta = roundtrip('set_entity_data', {
    runtime_entity_id: 2n,
    metadata: [{ key: 'always_show_nametag', type: 'byte', value: 1 }],
    properties: { ints: [], floats: [] },
    tick: 0n
  }).metadata
  if (meta[0]?.legacy_type !== 0) throw new Error('metadata legacy_type not set on 1.26.51')
  configureProtocolShapes('1.26.30')
  configureItemLayoutForVersion('1.26.30')
}

// Pacer: over budget → wait() blocks until tokens refill
{
  const sent = []
  const fake = { status: 4, connection: { sendReliable: (b) => sent.push(b.length) } }
  const pacer = SendPacer.attach(fake, { kbps: 1000, burstKB: 16 })
  fake.connection.sendReliable(Buffer.alloc(64 * 1024))
  if (!pacer.over()) throw new Error('pacer should be over budget')
  const t0 = Date.now()
  await pacer.wait()
  if (Date.now() - t0 < 30) throw new Error('pacer did not wait')
  if (sent[0] !== 65536 || SendPacer.attach(fake, { kbps: 0 }) !== pacer || pacer.over()) {
    throw new Error('pacer hook / reuse / unlimited failed')
  }
}

// Raw backlog: a 1000-packet flood is recorded without drops
{
  const flood = path.join(dir, '_floodtest.mcreplay.gz')
  const w3 = new ReplayWriter(flood, { version: '1.21.100' })
  for (let i = 0; i < 1000; i++) w3.rawClientbound(Buffer.from([0xfe, i & 0xff, 1, 2, 3]))
  const st3 = await w3.close({ reason: 'test' })
  if (w3._rawDropped || st3.packets !== 1000) throw new Error(`raw flood dropped ${w3._rawDropped}`)
  fs.unlinkSync(flood)
}

fs.unlinkSync(file)
console.log('selftest OK')
