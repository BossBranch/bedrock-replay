const JWT = require('jsonwebtoken')
const constants = require('./constants')
const debug = require('debug')('minecraft-protocol')
const crypto = require('crypto')

module.exports = (client, server, options) => {
  // https://web.archive.org/web/20180917171505if_/https://confluence.yawk.at/display/PEPROTOCOL/Game+Packets#GamePackets-Login

  const getDER = b64 => crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' })

  function normalizeToken (token) {
    return String(token || '').replace(/^MCToken\s+/i, '')
  }

  function extraFromPayload (payload) {
    return {
      displayName: payload.xname || payload.displayName || payload.extraData?.displayName || 'Player',
      identity: payload.identity || payload.extraData?.identity,
      XUID: payload.xid || payload.XUID || payload.xuid || payload.extraData?.XUID || '0',
      xuid: payload.xuid || payload.XUID || payload.xid || payload.extraData?.XUID || '0',
      PlayFabID: payload.pfbid || payload.playFabId || payload.PlayFabID || payload.extraData?.PlayFabID,
      PlayFabTitleID: payload.pfbtid || payload.playFabTitleId || payload.PlayFabTitleID || payload.extraData?.PlayFabTitleID
    }
  }

  /** 26.10+ TokenPayload / offline self-signed — decode, do not require Mojang signature */
  function parseTokenData (token) {
    const normalized = normalizeToken(token)
    let decoded
    if (options.offline) {
      decoded = JWT.decode(normalized)
    } else {
      try {
        const x5u = getX5U(normalized)
        decoded = JWT.verify(normalized, getDER(x5u), { algorithms: ['ES384', 'RS256'] })
      } catch {
        decoded = JWT.decode(normalized)
      }
    }
    if (!decoded || typeof decoded !== 'object') throw new Error('Invalid login token')
    const key = decoded.cpk || decoded.clientPublicKey || decoded.identityPublicKey
    return { key, data: { extraData: extraFromPayload(decoded) } }
  }

  function verifyAuth (chain, token) {
    // TokenPayload: empty chain + Token (online Xbox or offline self-signed)
    if ((!chain || chain.length === 0 || chain.every((entry) => !entry)) && token) {
      return parseTokenData(token)
    }

    if (!chain || chain.length === 0) throw new Error('Empty certificate chain')

    // Offline / proxied: single self-signed JWT
    if (chain.length === 1) {
      const decoded = JWT.decode(chain[0])
      if (!decoded) throw new Error('Invalid single-entry chain')
      const key = decoded.identityPublicKey || decoded.clientPublicKey || decoded.cpk
      const data = decoded.extraData
        ? { extraData: extraFromPayload({ ...decoded.extraData, ...decoded }) }
        : { extraData: extraFromPayload(decoded) }
      return { key, data }
    }

    // Legacy 3-JWT Xbox chain
    let data = {}
    let didVerify = false
    let pubKey = getDER(getX5U(chain[0]))
    let finalKey = null

    for (const jwt of chain) {
      const decoded = options.offline
        ? (JWT.decode(jwt) || {})
        : JWT.verify(jwt, pubKey, { algorithms: ['ES384'] })

      const x5u = getX5U(jwt)
      if (x5u === constants.PUBLIC_KEY && !data.extraData?.XUID) {
        didVerify = true
        debug('Verified client with mojang key', x5u)
      }

      if (decoded.identityPublicKey) {
        try { pubKey = getDER(decoded.identityPublicKey) } catch {}
      }
      finalKey = decoded.identityPublicKey || finalKey
      data = { ...data, ...decoded }
    }

    if (!didVerify && !options.offline) {
      client.disconnect('disconnectionScreen.notAuthenticated')
    }

    if (data.extraData) {
      data = { extraData: extraFromPayload({ ...data.extraData, ...data }) }
    }

    return { key: finalKey, data }
  }

  function verifySkin (publicKey, token) {
    if (!publicKey || options.offline) {
      const decoded = JWT.decode(token)
      if (!decoded) throw new Error('Invalid skin token')
      return decoded
    }
    const pubKey = getDER(publicKey)
    return JWT.verify(token, pubKey, { algorithms: ['ES384'] })
  }

  client.decodeLoginJWT = (authTokens, skinTokens, authToken = '') => {
    let { key, data } = verifyAuth(authTokens, authToken)
    // Encryption needs client ECDH pub key — fall back to skin JWT x5u
    if (!key && skinTokens) {
      try { key = getX5U(skinTokens) } catch {}
    }
    if (!key) throw new Error('Login missing client public key (cpk)')
    const skinData = verifySkin(key, skinTokens)
    return { key, userData: data, skinData }
  }

  client.encodeLoginJWT = (localChain, mojangChain) => {
    const chains = []
    chains.push(localChain)
    for (const c of mojangChain) chains.push(c)
    return chains
  }
}

function getX5U (token) {
  const [header] = token.split('.')
  const hdec = Buffer.from(header, 'base64').toString('utf-8')
  const hjson = JSON.parse(hdec)
  return hjson.x5u
}
