const { Client } = require('./client')
const { Server } = require('./server')
const { Player } = require('./serverPlayer')
const { realmAuthenticate } = require('./client/auth')
const debug = globalThis.isElectron ? console.debug : require('debug')('minecraft-protocol')
const { varint: [readVarInt] } = require('protodef').types

const debugging = false // Do re-encoding tests

/** Proxy must parse these (logic / rewrite). Everything else = bytes through. */
const PARSE_NAMES = new Set([
  'play_status',
  'disconnect',
  'text',
  'start_game',
  'change_dimension',
  'transfer',
  'modal_form_request',
  // Tiny; needed so mid-session .start can patch spawn off GamePE's 0,0,0 placeholder
  'network_chunk_publisher_update',
  'set_spawn_position',
  'respawn'
])

/** Serverbound: only chat/commands need parse for .start/.stop/.play — rest = raw to GamePE. */
const SB_PARSE_NAMES = new Set([
  'text',
  'command_request',
  // Tiny, once per (re)spawn — without it in-place .play never learns the
  // client finished loading (status stuck at 3, spawn-wait always fails)
  'set_local_player_as_initialized'
])

/** Hold until start_game (same as stock relay chunk gate). */
const HOLD_BEFORE_START_NAMES = new Set([
  'level_chunk',
  'subchunk',
  'network_chunk_publisher_update'
])

function packetIdMaps (version) {
  // Keep in sync with PARSE_NAMES — used when advertise version isn't in minecraft-data (e.g. 1.26.33)
  const fallbackParse = new Set([2, 5, 9, 11, 43, 45, 61, 85, 100, 121])
  const fallbackHold = new Set([58, 174, 121])
  const fallbackSb = new Set([9, 77])
  const candidates = []
  if (version) candidates.push(String(version))
  const parts = String(version || '').split('.')
  if (parts.length >= 2) {
    candidates.push(`${parts[0]}.${parts[1]}.30`)
    candidates.push(`${parts[0]}.${parts[1]}.0`)
  }
  candidates.push('1.26.30', '1.21.100')
  const seen = new Set()
  for (const ver of candidates) {
    if (!ver || seen.has(ver)) continue
    seen.add(ver)
    try {
      const md = require('minecraft-data')('bedrock_' + ver)
      if (!md?.protocol) continue
      const mappings = md.protocol.types.mcpe_packet[1].find((f) => f.name === 'name').type[1].mappings
      const parse = new Set()
      const hold = new Set()
      const sbParse = new Set()
      const sbSample = new Set()
      let chunkId = 58
      let authInputId = 144
      let itemRegistryId = 162
      let mobEquipmentId = 31
      for (const [id, name] of Object.entries(mappings)) {
        const n = Number(id)
        if (PARSE_NAMES.has(name)) parse.add(n)
        if (HOLD_BEFORE_START_NAMES.has(name)) hold.add(n)
        if (SB_PARSE_NAMES.has(name)) sbParse.add(n)
        if (name === 'level_chunk') chunkId = n
        if (name === 'player_auth_input') authInputId = n
        if (name === 'item_registry') itemRegistryId = n
        if (name === 'mob_equipment') mobEquipmentId = n
        // Rare + tiny — decode-only for held-item capture (raw still forwarded)
        if (name === 'mob_equipment' || name === 'player_hotbar' || name === 'inventory_transaction') sbSample.add(n)
      }
      if (parse.size) {
        return {
          parse,
          hold: hold.size ? hold : fallbackHold,
          sbParse: sbParse.size ? sbParse : fallbackSb,
          chunkId,
          authInputId,
          itemRegistryId,
          mobEquipmentId,
          sbSample
        }
      }
    } catch {}
  }
  return {
    parse: fallbackParse,
    hold: fallbackHold,
    sbParse: fallbackSb,
    chunkId: 58,
    authInputId: 144,
    itemRegistryId: 162,
    mobEquipmentId: 31,
    sbSample: new Set([30, 31, 48]) // inventory_transaction, mob_equipment, player_hotbar
  }
}

function readPacketId (buf) {
  return readVarInt(buf, 0).value
}

class RelayPlayer extends Player {
  constructor (server, conn) {
    super(server, conn)

    this.startRelaying = false
    this.once('join', () => { // The client has joined our proxy
      this.flushDownQueue() // Send queued packets from the upstream backend
      this.startRelaying = true
    })
    this.downQ = []
    this.upQ = []
    this.upInLog = (...msg) => console.debug('* Backend -> Proxy', ...msg)
    this.upOutLog = (...msg) => console.debug('* Proxy -> Backend', ...msg)
    this.downInLog = (...msg) => console.debug('* Client -> Proxy', ...msg)
    this.downOutLog = (...msg) => console.debug('* Proxy -> Client', ...msg)

    if (!server.options.logging) {
      this.upInLog = () => { }
      this.upOutLog = () => { }
      this.downInLog = () => { }
      this.downOutLog = () => { }
    }

    this.outLog = this.downOutLog
    this.inLog = this.downInLog
    this.chunkSendCache = []
    this.rawHoldQ = []
    this.sentStartGame = false
    this.respawnPacket = []
    this._rawFwdN = 0
    this._sbRawN = 0
    const ver = server?.options?.version || '1.21.100'
    const maps = packetIdMaps(ver)
    this._parseIds = maps.parse
    this._holdIds = maps.hold
    this._sbParseIds = maps.sbParse
    this._chunkPacketId = maps.chunkId
    this._authInputId = maps.authInputId
    this._itemRegistryPacketId = maps.itemRegistryId
    this._mobEquipmentId = maps.mobEquipmentId ?? 31
    this._sbSampleIds = maps.sbSample
    this._lastAuthDecodeAt = 0
    this._whitelistParse = process.env.BEDROCK_REPLAY_MOBILE === '1'
    if (this._whitelistParse) {
      console.log(
        `[relay] whitelist-parse on (cb=${[...this._parseIds].join(',')} ` +
        `sb=${[...this._sbParseIds].join(',')} hold=${[...this._holdIds].join(',')}` +
        ` item_registry=${this._itemRegistryPacketId}` +
        ` sbSample=${[...this._sbSampleIds].join(',')} mob_eq=${this._mobEquipmentId})`
      )
    }
  }

  _emitRawRecord (copy, packetId) {
    setImmediate(() => {
      if (!this.startRelaying || this.status === 'disconnected') return
      this.emit('rawClientbound', copy, packetId)
    })
  }

  _rawForward (copy, packetId) {
    try {
      this.sendBuffer(copy, false)
      if (copy.length > 200000) try { this._tick?.() } catch {}
    } catch (e) {
      console.warn('[relay] raw-forward fail', e?.message || e)
    }
    this._rawFwdN++
    if (copy.length > 500000 || this._rawFwdN <= 3 || this._rawFwdN % 500 === 0) {
      console.log(`[relay] whitelist-raw #${this._rawFwdN} id=${packetId ?? '?'} len=${copy.length}`)
    }
    this._emitRawRecord(copy, packetId)
  }

  _flushRawHold () {
    if (!this.rawHoldQ.length) return
    const q = this.rawHoldQ
    this.rawHoldQ = []
    for (const buf of q) {
      try {
        this.sendBuffer(buf, false)
      } catch (e) {
        console.warn('[relay] raw-hold flush fail', e?.message || e)
      }
    }
    try { this._tick?.() } catch {}
    console.log(`[relay] flushed ${q.length} held packets after start_game`)
  }

  // Called when we get a packet from backend server (Backend -> PROXY -> Client)
  readUpstream (packet) {
    const _t0 = Date.now()
    let _diagId = null
    let _diagPath = 'parse'
    try {
      this._readUpstreamInner(packet, (id, path) => {
        _diagId = id
        if (path) _diagPath = path
      })
    } finally {
      const ms = Date.now() - _t0
      const len = packet?.length || 0
      try {
        this.emit('diagUpstream', { len, ms, id: _diagId, path: _diagPath })
      } catch {}
    }
  }

  _readUpstreamInner (packet, mark = () => {}) {
    if (!this.startRelaying) {
      this.upInLog('Client not ready, queueing packet until join')
      this.downQ.push(packet)
      return
    }

    // Mobile: parse only whitelist IDs. Everything else = copy → client + raw record.
    // Avoids parse+re-encode of chunk/skin floods that stall RakNet on phones.
    if (this._whitelistParse) {
      const copy = Buffer.from(packet)
      let packetId = -1
      try {
        packetId = readPacketId(copy)
      } catch {
        mark(-1, 'raw-badid')
        this._rawForward(copy, -1)
        return
      }
      mark(packetId, null)

      if (!this._parseIds.has(packetId)) {
        if (!this.sentStartGame && this._holdIds.has(packetId)) {
          mark(packetId, 'hold')
          this.rawHoldQ.push(copy)
          this._emitRawRecord(copy, packetId)
          return
        }
        mark(packetId, 'raw')
        this._rawForward(copy, packetId)
        return
      }
      mark(packetId, 'parse')
      // Whitelisted: fall through to full parse using `copy` (not reused UDP buf)
      packet = copy
    }

    let des
    try {
      des = this.server.deserializer.parsePacketBuffer(packet)
    } catch (e) {
      try { this.server.deserializer.dumpFailedBuffer(packet, this.connection.address) } catch {}
      console.error('[relay] upstream parse fail', e?.message || e, 'len=', packet?.length, 'head=', packet?.slice?.(0, 8)?.toString?.('hex'))
      // Still deliver bytes to Minecraft — dropping unknown packets freezes GamePE hub
      try {
        if (this.startRelaying) {
          try { this._tick?.() } catch {}
          // Copy: RakNet may reuse the UDP buffer
          const copy = Buffer.isBuffer(packet) && this._whitelistParse ? packet : Buffer.from(packet)
          this.sendBuffer(copy, false)
          try { this._tick?.() } catch {}
          console.warn('[relay] raw-forwarded unparsed packet len=', packet?.length)
          this._emitRawRecord(copy)
        }
      } catch (e2) {
        console.error('[relay] raw forward after parse fail', e2?.message || e2)
      }
      if (!this.options.omitParseErrors) {
        this.disconnect('Server packet parse error')
      }
      return
    }
    const name = des.data.name
    const params = des.data.params
    this.upInLog('->', name, params)

    if (name === 'play_status' && params.status === 'login_success') return // Already sent this, this needs to be sent ASAP or client will disconnect

    if (debugging) { // some packet encode/decode testing stuff
      this.server.deserializer.verify(des, this.server.serializer)
    }

    this.emit('clientbound', des.data, des)

    if (!des.canceled) {
      if (name === 'start_game') {
        // Immediate: 500ms delay deadlocks when chunks arrive then GamePE waits for client
        this.sentStartGame = true
      } else if (name === 'level_chunk' && !this.sentStartGame) {
        this.chunkSendCache.push(params)
        return
      }

      this.queue(name, params)
    }

    if (this.sentStartGame) {
      if (this.chunkSendCache.length > 0) {
        for (const entry of this.chunkSendCache) {
          this.queue('level_chunk', entry)
        }
        this.chunkSendCache = []
      }
      this._flushRawHold()
    }
  }

  // Send queued packets to the connected client
  flushDownQueue () {
    this.downOutLog('Flushing downstream queue')
    for (const packet of this.downQ) {
      if (this._whitelistParse) {
        try {
          const copy = Buffer.from(packet)
          this.sendBuffer(copy, false)
          // These pre-join packets include the very first spawn chunks —
          // without this the recording has a hole right under the start point.
          let packetId = -1
          try { packetId = readPacketId(copy) } catch {}
          this._emitRawRecord(copy, packetId)
        } catch (e) {
          console.warn('[relay] flushDown raw fail', e?.message || e)
        }
        continue
      }
      const des = this.server.deserializer.parsePacketBuffer(packet)
      this.write(des.data.name, des.data.params)
    }
    this.downQ = []
  }

  // Send queued packets to the backend upstream server from the client
  flushUpQueue () {
    this.upOutLog('Flushing upstream queue')
    for (const e of this.upQ) { // Send the queue
      if (this._whitelistParse) {
        try {
          this.upstream.sendBuffer(Buffer.from(e), false)
        } catch (err) {
          console.warn('[relay] flushUp raw fail', err?.message || err)
        }
        continue
      }
      const des = this.server.deserializer.parsePacketBuffer(e)
      if (des.data.name === 'client_cache_status') {
        // Currently not working, force off the chunk cache
      } else {
        this.upstream.write(des.data.name, des.data.params)
      }
    }
    this.upQ = []
  }

  // Called when the server gets a packet from the downstream player (Client -> PROXY -> Backend)
  readPacket (packet) {
    // The downstream client conn is established & we got a packet to send to upstream server
    if (this.startRelaying) {
      // Upstream is still connecting/handshaking
      if (!this.upstream) {
        this.downInLog('Got downstream connected packet but upstream is not connected yet, added to q')
        this.upQ.push(Buffer.from(packet))
        return
      }

      // Send queued packets
      this.flushUpQueue()
      this.downInLog('recv', packet)

      // Mobile: raw-forward all input except chat/commands (proxy .start/.stop).
      // Re-encoding auth_input / inventory_transaction on phone → GamePE kicks.
      if (this._whitelistParse) {
        const copy = Buffer.from(packet)
        let packetId = -1
        try {
          packetId = readPacketId(copy)
        } catch {
          packetId = -1
        }
        if (!this._sbParseIds.has(packetId)) {
          try {
            this.upstream.sendBuffer(copy, false)
          } catch (e) {
            console.warn('[relay] sb raw-forward fail', e?.message || e)
          }
          this._sbRawN++
          if (this._sbRawN <= 3 || this._sbRawN % 500 === 0) {
            console.log(`[relay] whitelist-sb-raw #${this._sbRawN} id=${packetId} len=${copy.length}`)
          }
          try {
            this.emit('diagServerbound', { len: copy.length, id: packetId, path: 'raw' })
          } catch {}
          // Decode-only camera/held sampling (bytes already forwarded above).
          // auth_input floods 20/s — sample ≤20/s (5/s looked robotic on playback);
          // equipment packets are rare, decode all.
          try {
            const isAuth = packetId === this._authInputId
            const now = isAuth ? Date.now() : 0
            if ((isAuth && now - this._lastAuthDecodeAt >= 50) || this._sbSampleIds.has(packetId)) {
              if (isAuth) this._lastAuthDecodeAt = now
              try {
                const des = this.server.deserializer.parsePacketBuffer(copy)
                if (des?.data?.name) {
                  // Attach original bytes so record can store RAW equip (Item stays
                  // client-encoded — re-encode via client.write kicks Bedrock).
                  this.emit('sbSample', { ...des.data, fullBuffer: copy })
                }
              } catch (e) {
                // Item codec often fails on 1.26 — still keep RAW mob_equipment
                // so PLAY can patch runtime_entity_id without re-encoding.
                if (packetId === this._mobEquipmentId) {
                  this._sbEquipParseFailN = (this._sbEquipParseFailN || 0) + 1
                  if (this._sbEquipParseFailN <= 5 || this._sbEquipParseFailN % 25 === 0) {
                    console.warn(
                      `[relay] mob_equipment sample parse fail #${this._sbEquipParseFailN}: ` +
                      `${e?.message || e} — keeping RAW ${copy.length}B`
                    )
                  }
                  this.emit('sbSample', {
                    name: 'mob_equipment',
                    params: null,
                    fullBuffer: copy,
                    parseError: true
                  })
                }
              }
            }
          } catch {}
          return
        }
        packet = copy
      }

      let des
      try {
        des = this.server.deserializer.parsePacketBuffer(packet)
      } catch (e) {
        console.error('[relay] serverbound parse fail', e?.message || e, 'len=', packet?.length)
        // Keep GamePE session alive — drop = silent client = kick
        try {
          this.upstream.sendBuffer(Buffer.from(packet), false)
          console.warn('[relay] raw-forwarded unparsed serverbound len=', packet?.length)
        } catch (e2) {
          console.error('[relay] serverbound raw forward fail', e2?.message || e2)
        }
        return
      }

      if (debugging) { // some packet encode/decode testing stuff
        this.server.deserializer.verify(des, this.server.serializer)
      }

      this.emit('serverbound', des.data, des)
      if (des.canceled) return

      switch (des.data.name) {
        case 'client_cache_status':
          // Force the chunk cache off.
          this.upstream.queue('client_cache_status', { enabled: this.enableChunkCaching })
          break
        case 'set_local_player_as_initialized':
          this.status = 3
        // falls through
        default:
          // Emit the packet as-is back to the upstream server
          this.downInLog('Relaying', des.data)
          // Prefer original bytes when available (no re-encode drift)
          if (des.fullBuffer && this._whitelistParse) {
            try {
              this.upstream.sendBuffer(Buffer.from(des.fullBuffer), false)
              break
            } catch {}
          }
          this.upstream.queue(des.data.name, des.data.params)
      }
    } else {
      super.readPacket(packet)
    }
  }

  close (reason) {
    this.upstream?.close(reason)
    super.close(reason)
  }
}

class Relay extends Server {
  /**
   * Creates a new non-transparent proxy connection to a destination server
   * @param {Options} options
   */
  constructor (options) {
    super(options)
    this.RelayPlayer = options.relayPlayer || RelayPlayer
    this.forceSingle = options.forceSingle
    this.upstreams = new Map()
    this.conLog = debug
    this.enableChunkCaching = options.enableChunkCaching
  }

  // Called after a new player joins our proxy. We first create a new Client to connect to
  // the remote server. Then we listen to some events and proxy them over. The queue and
  // flushing logic is more of an accessory to make sure the server or client recieves
  // a packet, no matter what state it's in. For example, if the client wants to send a
  // packet to the server but it's not connected, it will add to the queue and send as soon
  // as a connection with the server is established.
  async openUpstreamConnection (ds, clientAddr) {
    const options = {
      authTitle: this.options.authTitle,
      flow: this.options.flow,
      deviceType: this.options.deviceType,
      offline: this.options.destination.offline ?? this.options.offline,
      username: this.options.offline ? ds.profile.name : ds.profile.xuid,
      version: this.options.version,
      realms: this.options.destination.realms,
      host: this.options.destination.host,
      port: this.options.destination.port,
      batchingInterval: this.options.batchingInterval,
      onMsaCode: (code) => {
        if (this.options.onMsaCode) {
          this.options.onMsaCode(code, ds)
        } else {
          ds.disconnect("It's your first time joining. Please sign in and reconnect to join this server:\n\n" + code.message)
        }
      },
      profilesFolder: this.options.profilesFolder,
      backend: this.options.backend,
      autoInitPlayer: false
    }

    if (this.options.destination.realms) {
      await realmAuthenticate(options)
    }

    const client = new Client(options)
    // Set the login payload unless `noLoginForward` option
    if (!client.noLoginForward) client.options.skinData = ds.skinData
    client.ping().then(pongData => {
      client.connect()
    }).catch(err => {
      this.emit('error', err)
    })
    this.conLog('Connecting to', options.host, options.port)
    client.outLog = ds.upOutLog
    client.inLog = ds.upInLog
    client.once('join', () => {
      // Tell the server to disable chunk cache for this connection as a client.
      // Wait a bit for the server to ack and process, the continue with proxying
      // otherwise the player can get stuck in an empty world.
      client.write('client_cache_status', { enabled: this.enableChunkCaching })
      ds.upstream = client
      ds.flushUpQueue()
      this.conLog('Connected to upstream server')
      client.readPacket = (packet) => ds.readUpstream(packet)

      this.emit('join', /* client connected to proxy */ ds, /* backend server */ client)
    })
    client.on('error', (err) => {
      ds.disconnect('Server error: ' + err.message)
      debug(clientAddr, 'was disconnected because of error', err)
      this.upstreams.delete(clientAddr.hash)
    })
    client.on('close', (reason) => {
      ds.disconnect('Backend server closed connection')
      this.upstreams.delete(clientAddr.hash)
    })

    this.upstreams.set(clientAddr.hash, client)
  }

  // Close a connection to a remote backend server.
  closeUpstreamConnection (clientAddr) {
    const up = this.upstreams.get(clientAddr.hash)
    if (!up) throw Error(`unable to close non-open connection ${clientAddr.hash}`)
    up.close()
    this.upstreams.delete(clientAddr.hash)
    this.conLog('closed upstream connection', clientAddr)
  }

  // Called when a new player connects to our proxy server. Once the player has authenticated,
  // we can open an upstream connection to the backend server.
  onOpenConnection = (conn) => {
    if (this.forceSingle && this.clientCount > 0) {
      this.conLog('dropping connection as single client relay', conn)
      conn.close()
    } else {
      this.clientCount++
      const player = new this.RelayPlayer(this, conn)
      this.conLog('New connection from', conn.address)
      this.clients[conn.address] = player
      this.emit('connect', player)
      player.on('login', () => {
        this.openUpstreamConnection(player, conn.address)
      })
      player.on('close', (reason) => {
        this.conLog('player disconnected', conn.address, reason)
        this.clientCount--
        delete this.clients[conn.address]
      })
    }
  }

  // When our server is closed, make sure to kick all of the connected clients and run emitters.
  close (...a) {
    for (const [, v] of this.upstreams) {
      v.close(...a)
    }
    super.close(...a)
  }
}

// Too many things called 'Proxy' ;)
module.exports = { Relay }
