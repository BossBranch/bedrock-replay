const { ClientStatus, Connection } = require('./connection')
const Options = require('./options')
const { serialize, isDebug } = require('./datatypes/util')
const { KeyExchange } = require('./handshake/keyExchange')
const Login = require('./handshake/login')
const LoginVerify = require('./handshake/loginVerify')
const debug = require('debug')('minecraft-protocol')

class Player extends Connection {
  constructor (server, connection) {
    super()
    this.server = server
    this.features = server.features
    this.serializer = server.serializer
    this.deserializer = server.deserializer
    this.connection = connection
    this.options = server.options

    KeyExchange(this, server, server.options)
    Login(this, server, server.options)
    LoginVerify(this, server, server.options)

    this.startQueue()
    this.status = ClientStatus.Authenticating

    if (isDebug) {
      this.inLog = (...args) => debug('-> S', ...args)
      this.outLog = (...args) => debug('<- S', ...args)
    }

    this.batchHeader = this.server.batchHeader
    // Compression is server-wide
    this.compressionAlgorithm = this.server.compressionAlgorithm
    this.compressionLevel = this.server.compressionLevel
    this.compressionThreshold = this.server.compressionThreshold
    this.compressionHeader = this.server.compressionHeader

    this._sentNetworkSettings = false // 1.19.30+
  }

  getUserData () {
    return this.userData
  }

  sendNetworkSettings () {
    const body = {
      compression_threshold: this.server.compressionThreshold,
      compression_algorithm: this.server.compressionAlgorithm,
      client_throttle: false,
      client_throttle_threshold: 0,
      client_throttle_scalar: 0
    }
    // Always send NS uncompressed — even on retry (client may not have compression yet)
    const sendUncompressed = () => {
      const was = this.compressionReady
      this.compressionReady = false
      try {
        this.write('network_settings', body)
        try { this._tick?.() } catch {}
      } finally {
        this.compressionReady = was
      }
    }
    sendUncompressed()
    this._sentNetworkSettings = true
    this.compressionReady = true
    console.log(
      `[auth] network_settings sent thresh=${this.server.compressionThreshold} ` +
      `alg=${this.server.compressionAlgorithm} — waiting for login`
    )
    // UDP loss → client never sends login → infinite loading. Resend a few times.
    if (this._nsRetryTimer) {
      try { clearInterval(this._nsRetryTimer) } catch {}
    }
    let tries = 0
    this._nsRetryTimer = setInterval(() => {
      if (this.profile || this.status === ClientStatus.Disconnected) {
        clearInterval(this._nsRetryTimer)
        this._nsRetryTimer = null
        return
      }
      tries++
      if (tries > 10) {
        clearInterval(this._nsRetryTimer)
        this._nsRetryTimer = null
        console.warn('[auth] still no login after network_settings retries')
        return
      }
      console.warn(`[auth] resend network_settings #${tries} (no login yet)`)
      sendUncompressed()
      this.compressionReady = true
    }, 400)
    try {
      if (typeof this._nsRetryTimer.unref === 'function') this._nsRetryTimer.unref()
    } catch {}
  }

  handleClientProtocolVersion (clientVersion) {
    if (this.server.options.protocolVersion) {
      if (this.server.options.protocolVersion < clientVersion) {
        this.sendDisconnectStatus('failed_spawn') // client too new
        return false
      }
    } else if (clientVersion < Options.MIN_VERSION) {
      this.sendDisconnectStatus('failed_client') // client too old
      return false
    }
    return true
  }

  onLogin (packet) {
    const body = packet.data
    this.emit('loggingIn', body)

    const clientVer = body.params.protocol_version
    if (!this.handleClientProtocolVersion(clientVer)) {
      return
    }

    // Parse login data (1.26+ TokenPayload: Certificate may be "")
    const tokens = body.params.tokens
    try {
      const skinChain = tokens.client
      const authChain = JSON.parse(tokens.identity)
      const authToken = authChain.Token || ''
      let chain
      if (authChain.Certificate && String(authChain.Certificate).trim()) {
        chain = JSON.parse(authChain.Certificate).chain
      } else if (authChain.chain) {
        chain = authChain.chain
      } else if (authToken) {
        // TokenPayload — offline self-signed or online OIDC (hub uses offline:true)
        chain = []
      } else {
        throw new Error('Invalid login packet: missing chain, Certificate, or Token')
      }
      var { key, userData, skinData } = this.decodeLoginJWT(chain, skinChain, authToken) // eslint-disable-line
    } catch (e) {
      console.warn('[auth] login failed:', e?.message || e)
      debug(this.address, e)
      this.disconnect('Server authentication error')
      return
    }

    // Handshake must not throw — uncaught abort leaves Minecraft on "connecting"
    try {
      this.emit('server.client_handshake', { key })
    } catch (e) {
      console.warn('[auth] encryption handshake failed:', e?.message || e)
      try { this.disconnect('Encryption handshake failed:\n' + (e?.message || e)) } catch {}
      return
    }

    this.userData = userData.extraData
    this.skinData = skinData
    this.profile = {
      name: userData.extraData?.displayName,
      uuid: userData.extraData?.identity,
      xuid: userData.extraData?.xuid || userData.extraData?.XUID
    }
    this.version = clientVer
    this.emit('login', { user: userData.extraData }) // emit events for user
    if (this._nsRetryTimer) {
      try { clearInterval(this._nsRetryTimer) } catch {}
      this._nsRetryTimer = null
    }
  }

  /**
   * Disconnects a client before it has joined
   * @param {string} playStatus
   */
  sendDisconnectStatus (playStatus) {
    if (this.status === ClientStatus.Disconnected) return
    this.write('play_status', { status: playStatus })
    this.close('kick')
  }

  /**
   * Disconnects a client
   */
  disconnect (reason = 'Server closed', hide = false) {
    if (this.status === ClientStatus.Disconnected) return
    this.write('disconnect', {
      hide_disconnect_screen: hide,
      message: reason,
      filtered_message: ''
    })
    this.server.conLog('Kicked ', this.connection?.address, reason)
    setTimeout(() => this.close('kick'), 100) // Allow time for message to be recieved.
  }

  // After sending Server to Client Handshake, this handles the client's
  // Client to Server handshake response. This indicates successful encryption
  onHandshake () {
    // https://wiki.vg/Bedrock_Protocol#Play_Status
    this.write('play_status', { status: 'login_success' })
    this.status = ClientStatus.Initializing
    this.emit('join')
  }

  close (reason) {
    if (this._nsRetryTimer) {
      try { clearInterval(this._nsRetryTimer) } catch {}
      this._nsRetryTimer = null
    }
    if (this.status !== ClientStatus.Disconnected) {
      this.emit('close') // Emit close once
      if (!reason) this.inLog?.('Client closed connection', this.connection?.address)
    }
    this.q = []
    this.q2 = []
    clearInterval(this.loop)
    this.connection?.close()
    this.removeAllListeners()
    this.status = ClientStatus.Disconnected
  }

  readPacket (packet) {
    try {
      var des = this.server.deserializer.parsePacketBuffer(packet) // eslint-disable-line
    } catch (e) {
      console.warn('[auth] packet parse fail:', e?.message || e)
      this.disconnect('Server error')
      debug('Dropping packet from', this.connection.address, e)
      return
    }

    this.inLog?.(des.data.name, serialize(des.data.params))

    switch (des.data.name) {
      // This is the first packet on 1.19.30 & above
      case 'request_network_settings':
        if (this.handleClientProtocolVersion(des.data.params.client_protocol)) {
          this.sendNetworkSettings()
          this.compressionLevel = this.server.compressionLevel
        }
        return
      // Below 1.19.30, this is the first packet.
      case 'login':
        console.log('[auth] login packet received, parsing…')
        try {
          this.onLogin(des)
        } catch (e) {
          console.warn('[auth] onLogin threw:', e?.message || e)
          try { this.disconnect('Login error:\n' + (e?.message || e)) } catch {}
        }
        if (!this._sentNetworkSettings) this.sendNetworkSettings()
        return
      case 'client_to_server_handshake':
        // Emit the 'join' event
        this.onHandshake()
        break
      case 'set_local_player_as_initialized':
        this.status = ClientStatus.Initialized
        this.inLog?.('Server client spawned')
        // Emit the 'spawn' event
        this.emit('spawn')
        break
      default:
        if (this.status === ClientStatus.Disconnected || this.status === ClientStatus.Authenticating) {
          console.log(`[auth] pre-login packet ignored: ${des.data.name}`)
          this.inLog?.('ignoring', des.data.name)
          return
        }
    }
    this.emit(des.data.name, des.data.params)
    this.emit('packet', des)
  }
}

module.exports = { Player }
