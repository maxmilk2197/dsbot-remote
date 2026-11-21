// 本文件由 AI 生成，请勿用于生产环境。
// 两台机器之间的管子：TCP + 4 字节大端长度前缀 + UTF-8 JSON。
//
// 为什么不是 WebSocket：两端都是我们自己的代码，没有浏览器要迁就。WS 要握手、
// 要掩码、要 upgrade 头，换不来任何东西。TCP 已经给了有序可靠字节流，长度前缀
// 就够了。地址由 EasyTier（或局域网 / 公网 IP）提供，见 PLAN §12。
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

const HEADER = 4
// 8MiB：一帧可能装着 base64 过的 4MiB 文件（5.33MiB）+ JSON 外壳。
// 4MiB 的时候附件从 3MiB 起就编码不出来，而这发生在 await 之后的续体里，
// 抛出去就是未处理的 rejection —— 直接把进程带走。
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const IDLE_MS = 60_000
// 对端收得太慢时，socket.write 的队列会在用户态无限长。超过这个数就断：
// 半开连接留着只会换一种方式把主机吃光。
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024
// 认证后的帧速率上限（每秒，允许两倍突发）。4MiB 的 JSON.parse 在主线程上跑，
// 一个被控节点刷帧就能把主机的事件循环占满。
const FRAME_RATE = 60

export class BadFrame extends Error {
  constructor(message) {
    super(message)
    this.name = 'BadFrame'
    this.code = 'node/bad-frame'
  }
}

// 握手：配对码不上线，改成"用配对码当预共享密钥的 ECDH + HMAC"。
// 以前 hello 帧里直接带 token，同网段任何人抓一个包就拿到了口令；改成：
//   两端各生成一把一次性 X25519，DH 出共享密钥，再用 sha256(配对码) 当 HKDF salt
//   推出会话密钥，主机先拿 HMAC(key,'host') 自证，节点回 HMAC(key,'node')。
// 抓包的人没有配对码，推不出会话密钥，也答不出任何一个 HMAC。
// 3：握完之后整条连接走 AES-256-GCM。2 的帧是明文，同网段谁都能读、能改。
export const HANDSHAKE_PROTO = 3

function newKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const x = publicKey.export({ format: 'jwk' }).x
  return { privateKey, publicB64: Buffer.from(x, 'base64url').toString('base64') }
}

function importPublic(b64) {
  const text = String(b64 ?? '')
  if (text === '') throw new BadFrame('握手缺少公钥')
  const raw = Buffer.from(text, 'base64')
  if (raw.length !== 32) throw new BadFrame('握手公钥长度不对')
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') }, format: 'jwk' })
}

// 配对码只进 salt，不直接当密钥：换码等于换会话密钥，旧连接也就断了。
function sessionKey(shared, code, nodeNonce, hostNonce) {
  const salt = createHash('sha256').update(String(code)).digest()
  const info = Buffer.from(`dsbot-nodes/${HANDSHAKE_PROTO}|${nodeNonce}|${hostNonce}`, 'utf8')
  return Buffer.from(hkdfSync('sha256', shared, salt, info, 32))
}

const prove = (key, label) => createHmac('sha256', key).update(label).digest('base64')

function proofMatches(key, label, got) {
  const want = Buffer.from(prove(key, label), 'utf8')
  const have = Buffer.from(String(got ?? ''), 'utf8')
  return want.length === have.length && have.length > 0 && timingSafeEqual(want, have)
}

// 帧体：明文时就是 JSON，加密时是 iv(12) || tag(16) || 密文。
// 长度前缀始终是明文的，否则连"这一帧多长"都读不出来。
export function encodeFrame(frame) {
  const body = Buffer.from(JSON.stringify(frame), 'utf8')
  if (body.length > MAX_FRAME_BYTES) throw new BadFrame(`frame of ${body.length} bytes is too large`)
  const head = Buffer.allocUnsafe(HEADER)
  head.writeUInt32BE(body.length, 0)
  return Buffer.concat([head, body])
}

// 半包与粘包都在这里处理：一次 data 事件可能带来 0.3 个帧或 3 个帧。
const jsonOf = body => {
  try { return JSON.parse(body.toString('utf8')) } catch { throw new BadFrame('frame is not JSON') }
}

export class FrameReader {
  constructor(maxBytes = MAX_FRAME_BYTES, decode = jsonOf) {
    this.maxBytes = maxBytes
    this.decode = decode
    this.pending = Buffer.alloc(0)
  }

  push(chunk) {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    const frames = []
    for (;;) {
      if (this.pending.length < HEADER) break
      const size = this.pending.readUInt32BE(0)
      if (size > this.maxBytes) throw new BadFrame(`frame of ${size} bytes exceeds ${this.maxBytes}`)
      if (this.pending.length < HEADER + size) break
      const body = this.pending.subarray(HEADER, HEADER + size)
      this.pending = this.pending.subarray(HEADER + size)
      frames.push(this.decode(body))
    }
    return frames
  }
}

export class Peer extends EventEmitter {
  constructor(socket, idleMs = IDLE_MS) {
    super()
    this.socket = socket
    // 会话密钥一装上，之后收发都是密文（握手帧除外）。
    this.cipherKey = null
    this.reader = new FrameReader(MAX_FRAME_BYTES, body => this.open(body))
    this.frameWindow = Date.now()
    this.frameCount = 0
    this.idleMs = idleMs
    this.gate = null
    this.closed = false
    this.done = false
    this.remote = `${socket.remoteAddress}:${socket.remotePort}`
    // 帧可能在有人监听之前就到了：对端连上（或我们连上）的第一件事就是发 hello，
    // 而调用方是先 await 连接、再注册监听。丢掉这一帧就会让握手永远等下去。
    this.backlog = []

    socket.on('data', (chunk) => {
      let frames
      try { frames = this.reader.push(chunk) } catch (error) {
        // 坏帧是不可恢复的：这一条连接已经没有可信边界了。
        this.safeEmit('bad-frame', error)
        this.close()
        return
      }
      for (const frame of frames) this.deliver(frame)
    })
    socket.on('error', (error) => this.safeEmit('socket-error', error))
    socket.on('close', () => this.finish())
    this.touch()
    // 心跳。空闲超时到点就 close，而这条管子大部分时间是没业务的：主机在等人
    // 说话，远端在等派活。谁都不发帧 → 两端都把对方判成死连接（实测正好 60 秒
    // 断一次，看着像"连上了又自己掉线"）。协议里本来就有 ping/pong，只是从来
    // 没人发。三分之一个 idle 发一次，留三倍余量，丢一两个包也不至于误杀。
    this.beat = setInterval(() => {
      if (!this.closed) this.send({ t: 'ping' })
    }, Math.max(50, Math.floor(idleMs / 3)))
    this.beat.unref?.()
  }

  emit(event, ...args) {
    if (event === 'frame' && super.listenerCount('frame') === 0) {
      this.backlog.push(args[0])
      if (this.backlog.length > 64) this.backlog.shift()
      return false
    }
    return super.emit(event, ...args)
  }

  on(event, handler) {
    super.on(event, handler)
    if (event === 'frame' && this.backlog.length > 0) {
      for (const frame of this.backlog.splice(0)) handler(frame)
    }
    return this
  }

  /** 握手算出的会话密钥：装上之后双向都是 AES-256-GCM。 */
  setCipher(key) {
    if (key !== null && key !== undefined) this.cipherKey = Buffer.from(key)
  }

  seal(frame) {
    const body = Buffer.from(JSON.stringify(frame), 'utf8')
    if (this.cipherKey === null) {
      if (body.length > MAX_FRAME_BYTES) throw new BadFrame(`frame of ${body.length} bytes is too large`)
      const head = Buffer.allocUnsafe(HEADER)
      head.writeUInt32BE(body.length, 0)
      return Buffer.concat([head, body])
    }
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.cipherKey, iv)
    const sealed = Buffer.concat([cipher.update(body), cipher.final()])
    const payload = Buffer.concat([iv, cipher.getAuthTag(), sealed])
    if (payload.length > MAX_FRAME_BYTES) throw new BadFrame(`frame of ${payload.length} bytes is too large`)
    const head = Buffer.allocUnsafe(HEADER)
    head.writeUInt32BE(payload.length, 0)
    return Buffer.concat([head, payload])
  }

  open(body) {
    if (this.cipherKey === null) return jsonOf(body)
    if (body.length < 28) throw new BadFrame('加密帧太短')
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.cipherKey, body.subarray(0, 12))
      decipher.setAuthTag(body.subarray(12, 28))
      const plain = Buffer.concat([decipher.update(body.subarray(28)), decipher.final()])
      return jsonOf(plain)
    } catch (error) {
      throw new BadFrame(`帧解不开：${error?.message ?? error}`)
    }
  }

  touch() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.close(), this.idleMs)
    this.timer.unref?.()
  }

  deliver(frame) {
    this.touch()
    const now = Date.now()
    if (now - this.frameWindow >= 1000) {
      this.frameWindow = now
      this.frameCount = 0
    }
    this.frameCount += 1
    if (this.frameCount > FRAME_RATE * 2) {
      this.report(new BadFrame(`帧太密（超过 ${FRAME_RATE * 2} 帧/秒），断开`))
      this.close()
      return
    }
    if (frame?.t === 'ping') { this.send({ t: 'pong' }); return }
    if (frame?.t === 'pong') return
    // 这里是在 socket 的 data 事件里跑的。监听器（gate 也好，上层 handler 也好）
    // 只要抛一次，异常就会顺着 net 的事件循环一路冒到进程顶层 —— 对宿主来说就是
    // 一条连接上的一个 bug 直接结束整个应用。连接本身还能用，所以只上报不打断。
    try {
      if (this.gate !== null && this.gate(frame) === false) return
      this.emit('frame', frame)
    } catch (error) {
      this.report(error)
    }
  }

  // 'listener-error' 是旁路：没有人听就算了，绝不因为它再抛一次。
  report(error) {
    try { this.emit('listener-error', error) } catch {}
  }

  // 在任何"由 socket 事件驱动"的地方发事件都用这个：监听器抛错不外泄。
  safeEmit(event, ...args) {
    try {
      this.emit(event, ...args)
    } catch (error) {
      this.report(error)
    }
  }

  send(frame) {
    if (this.closed) return false
    let bytes
    try {
      bytes = this.seal(frame)
    } catch (error) {
      // 编码失败（通常是单帧超限）绝不能往外抛：调用点多半在 await 之后，
      // 抛出去就是未处理的 rejection，宿主直接退进程。
      this.report(error)
      return false
    }
    try {
      this.socket.write(bytes)
    } catch (error) {
      this.report(error)
      this.close()
      return false
    }
    if (this.socket.writableLength > MAX_BUFFERED_BYTES) {
      this.report(new BadFrame('对端收得太慢，发送积压超过上限'))
      this.close()
      return false
    }
    return true
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.timer)
    clearInterval(this.beat)
    this.socket.destroy()
    this.finish()
  }

  finish() {
    if (this.done) return
    this.done = true
    this.closed = true
    clearTimeout(this.timer)
    clearInterval(this.beat)
    // 这条是在 socket 的 close 事件里同步跑的。close 监听器里抛出来的错会变成
    // uncaughtException —— 宿主只看到"某条连接断了"就把整个进程退掉。断线本该是
    // 最平常的一件坏事，不能让它带上进程。
    try {
      this.emit('close')
    } catch (error) {
      this.report(error)
    }
  }
}

export function parseTcpUrl(url) {
  const text = String(url).trim().replace(/^tcp:\/\//i, '')
  const at = text.lastIndexOf(':')
  if (at <= 0) throw new BadFrame(`not a tcp address: ${url}`)
  const port = Number(text.slice(at + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new BadFrame(`bad port in ${url}`)
  return { host: text.slice(0, at).replace(/^\[|\]$/g, ''), port }
}

// 远端侧：开一个口子等主机来连。第一个帧必须是 hello + token，过不了就断。
export async function listenTcp({ port = 0, host = '0.0.0.0', token, onConnection, onFrame, idleMs = IDLE_MS }) {
  if (typeof token !== 'string' || token.length < 6) throw new BadFrame('a listen token needs at least 6 characters')
  const peers = new Set()
  // 猜口令要有成本：同一个来源 60 秒内错 5 次，关 60 秒小黑屋。
  // 6 位码只有 30 bit，没有这一层，网上随便一个脚本几分钟就能撞开。
  const failures = new Map()
  // 一个人换地址的成本决定了限速该怎么记账：IPv6 的 /64 里随便换地址，
  // 按单个地址关小黑屋等于没关；IPv4 按地址就是按人。
  const bucketOf = (address) => {
    const text = String(address ?? '').replace(/^::ffff:/, '')
    if (!text.includes(':')) return text
    const hextets = text.split(':').filter(part => part !== '')
    return `${hextets.slice(0, 4).join(':') || '::'}/64`
  }
  const attemptState = (address) => {
    const now = Date.now()
    const state = failures.get(address) ?? { count: 0, blockedUntil: 0, windowStart: now }
    if (now - state.windowStart > 60_000) {
      state.count = 0
      state.windowStart = now
    }
    return state
  }
  const server = net.createServer((socket) => {
    const state = attemptState(bucketOf(socket.remoteAddress))
    if (state.blockedUntil > Date.now()) {
      socket.destroy()
      return
    }
    const peer = new Peer(socket, idleMs)
    peers.add(peer)
    peer.on('close', () => peers.delete(peer))

    let authed = false
    const refuse = (code, message) => {
      const now = Date.now()
      state.count += 1
      if (state.count >= 5) state.blockedUntil = now + 60_000
      failures.set(bucketOf(socket.remoteAddress), state)
      // 表不能无限长：过期条目顺手收掉，别让人用无限源地址把内存撑爆。
      if (failures.size > 512) {
        const now2 = Date.now()
        for (const [key, each] of failures) {
          if (each.blockedUntil < now2 && now2 - each.windowStart > 60_000) failures.delete(key)
        }
      }
      try { peer.send({ t: 'hello.error', code, message }) } catch {}
      peer.close()
    }

    peer.gate = (frame) => {
      if (authed) return true
      if (frame?.t === 'hello.error') { peer.close(); return false }
      if (frame?.t !== 'hello') { peer.close(); return false }

      let nodePublic
      let nodeNonce
      try {
        if (frame.proto !== undefined && frame.proto !== HANDSHAKE_PROTO) throw new BadFrame(`握手版本不对（对面说 ${frame.proto}，这边是 ${HANDSHAKE_PROTO}）`)
        nodeNonce = String(frame.nonce ?? '')
        if (nodeNonce === '' || nodeNonce.length > 128) throw new BadFrame('握手 nonce 不对')
        nodePublic = importPublic(frame.pub)
      } catch (error) {
        refuse('node/bad-handshake', error?.message ?? '握手格式不对')
        return false
      }

      const { privateKey, publicB64 } = newKeypair()
      const hostNonce = randomBytes(16).toString('base64')
      let key
      try {
        key = sessionKey(diffieHellman({ privateKey, publicKey: nodePublic }), token, nodeNonce, hostNonce)
      } catch (error) {
        refuse('node/bad-handshake', error?.message ?? '握手算不出密钥')
        return false
      }

      peer.send({ t: 'hello.challenge', proto: HANDSHAKE_PROTO, nonce: hostNonce, pub: publicB64, proof: prove(key, 'host') })
      // 下一个帧必须是节点对挑战的回应；口令不对的人在这里过不去。
      peer.gate = (answer) => {
        if (authed) return true
        if (answer?.t !== 'hello.auth') {
          refuse('node/bad-handshake', '挑战之后必须回 hello.auth')
          return false
        }
        // 从这一帧起改为密文：证书错也要能读出来，所以先装密钥再验。
        peer.setCipher(key)
        if (!proofMatches(key, 'node', answer.proof)) {
          refuse('node/unauthorized', '配对口令不对')
          return false
        }
        authed = true
        failures.delete(bucketOf(socket.remoteAddress))
        peer.send({ t: 'hello.ack', proto: HANDSHAKE_PROTO })
        onConnection?.(peer)
        return false
      }
      return false
    }
    if (onFrame !== undefined) peer.on('frame', onFrame)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })

  return {
    server,
    port: server.address().port,
    peers: () => [...peers],
    close: () => {
      for (const peer of peers) peer.close()
      peers.clear()
      server.close()
    },
  }
}

// 主机侧：连过去。握手成功才 resolve，失败一律 reject（调用方决定是否换地址重试）。
export async function connectTcp({ url, token, timeoutMs = 5000, idleMs = IDLE_MS }) {
  const { host, port } = parseTcpUrl(url)
  const socket = net.connect({ host, port })
  const peer = new Peer(socket, idleMs)

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new BadFrame(`连接 ${host}:${port} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    timer.unref?.()
    socket.once('connect', () => { clearTimeout(timer); resolve() })
    socket.once('error', (error) => { clearTimeout(timer); reject(error) })
  })

  const { privateKey, publicB64 } = newKeypair()
  const nodeNonce = randomBytes(16).toString('base64')

  let challengeSeen = false
  // 我们自己主动关的连接：关之前已经 reject 过更具体的理由，别让下面的
  // close 监听把话术盖成一句含糊的"连接断了"。
  let intentional = false
  const ack = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new BadFrame('握手超时：对面没有回 hello.ack')), timeoutMs)
    timer.unref?.()
    // 对面把我们拉黑（小黑屋直接 destroy）或中途挂了：不等满 timeout 才报，
    // 而且要报得像回事。重复 reject 是空操作，所以这里不用成对拆监听。
    peer.once('close', () => {
      if (intentional) return
      clearTimeout(timer)
      reject(new BadFrame('对面把连接断了（口令不对被拉黑，或对面没起来）'))
    })
    peer.gate = (frame) => {
      if (frame?.t === 'hello.error') {
        clearTimeout(timer)
        reject(new BadFrame(`对面拒绝：${frame.code ?? 'unknown'}`))
        return false
      }
      if (frame?.t === 'hello.challenge' && !challengeSeen) {
        challengeSeen = true
        if (frame.proto !== undefined && frame.proto !== HANDSHAKE_PROTO) {
          clearTimeout(timer)
          reject(new BadFrame(`握手版本不对（对面说 ${frame.proto}，这边是 ${HANDSHAKE_PROTO}）`))
          return false
        }
        let key
        try {
          const hostPublic = importPublic(frame.pub)
          key = sessionKey(
            diffieHellman({ privateKey, publicKey: hostPublic }),
            token,
            nodeNonce,
            String(frame.nonce ?? ''))
        } catch (error) {
          clearTimeout(timer)
          reject(error instanceof BadFrame ? error : new BadFrame(`握手失败：${error?.message ?? error}`))
          return false
        }
        // 先验主机：答不出 HMAC(key,'host') 的就不是拿着同一个配对码的主机，
        // 局域网里随便哪个设备回一句 pair.ok 也骗不过这一步。
        if (!proofMatches(key, 'host', frame.proof)) {
          clearTimeout(timer)
          intentional = true
          try { peer.send({ t: 'hello.error', code: 'node/unauthorized', message: '对面证明不了自己知道配对码' }) } catch {}
          peer.close()
          reject(new BadFrame('对面证明不了自己知道配对码：可能不是主机'))
          return false
        }
        peer.send({ t: 'hello.auth', proof: prove(key, 'node') })
        // 已经把自己的证明发出去了：从这里开始按密文收发（对端的 ack / error 都是密文）。
        peer.setCipher(key)
        return false
      }
      if (frame?.t === 'hello.ack') {
        clearTimeout(timer)
        resolve(frame)
        return false
      }
      return true
    }
  })

  try {
    peer.send({ t: 'hello', proto: HANDSHAKE_PROTO, nonce: nodeNonce, pub: publicB64 })
    await ack
  } catch (error) {
    // 握手没成：socket 不关会一直挂到 idleMs（60 秒）。换地址重试几次就是一把
    // 死连接，而它们还占着对端的握手状态。
    try { peer.close() } catch {}
    throw error
  }
  peer.gate = null
  return peer
}
