// 本文件由 AI 生成，请勿用于生产环境。
// 两台机器之间的管子：TCP + 4 字节大端长度前缀 + UTF-8 JSON。
//
// 为什么不是 WebSocket：两端都是我们自己的代码，没有浏览器要迁就。WS 要握手、
// 要掩码、要 upgrade 头，换不来任何东西。TCP 已经给了有序可靠字节流，长度前缀
// 就够了。地址由 EasyTier（或局域网 / 公网 IP）提供，见 PLAN §12。
import net from 'node:net'
import { EventEmitter } from 'node:events'

const HEADER = 4
const MAX_FRAME_BYTES = 4 * 1024 * 1024
const IDLE_MS = 60_000

export class BadFrame extends Error {
  constructor(message) {
    super(message)
    this.name = 'BadFrame'
    this.code = 'node/bad-frame'
  }
}

export function encodeFrame(frame) {
  const body = Buffer.from(JSON.stringify(frame), 'utf8')
  if (body.length > MAX_FRAME_BYTES) throw new BadFrame(`frame of ${body.length} bytes is too large`)
  const head = Buffer.allocUnsafe(HEADER)
  head.writeUInt32BE(body.length, 0)
  return Buffer.concat([head, body])
}

// 半包与粘包都在这里处理：一次 data 事件可能带来 0.3 个帧或 3 个帧。
export class FrameReader {
  constructor(maxBytes = MAX_FRAME_BYTES) {
    this.maxBytes = maxBytes
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
      const text = this.pending.subarray(HEADER, HEADER + size).toString('utf8')
      this.pending = this.pending.subarray(HEADER + size)
      let frame
      try { frame = JSON.parse(text) } catch { throw new BadFrame('frame is not JSON') }
      frames.push(frame)
    }
    return frames
  }
}

class Peer extends EventEmitter {
  constructor(socket, idleMs = IDLE_MS) {
    super()
    this.socket = socket
    this.reader = new FrameReader()
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

  touch() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.close(), this.idleMs)
    this.timer.unref?.()
  }

  deliver(frame) {
    this.touch()
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
    this.socket.write(encodeFrame(frame))
    return true
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.timer)
    this.socket.destroy()
    this.finish()
  }

  finish() {
    if (this.done) return
    this.done = true
    this.closed = true
    clearTimeout(this.timer)
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
  const server = net.createServer((socket) => {
    const peer = new Peer(socket, idleMs)
    peers.add(peer)
    peer.on('close', () => peers.delete(peer))

    let authed = false
    peer.gate = (frame) => {
      if (authed) return true
      if (frame?.t === 'hello.error') { peer.close(); return false }
      if (frame?.t !== 'hello') { peer.close(); return false }
      if (frame.token !== token) {
        peer.send({ t: 'hello.error', code: 'node/unauthorized', message: '配对口令不对' })
        peer.close()
        return false
      }
      authed = true
      peer.send({ t: 'hello.ack', proto: 1 })
      onConnection?.(peer)
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

  const ack = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new BadFrame('握手超时：对面没有回 hello.ack')), timeoutMs)
    timer.unref?.()
    peer.gate = (frame) => {
      if (frame?.t === 'hello.ack') { clearTimeout(timer); resolve(frame); return false }
      if (frame?.t === 'hello.error') { clearTimeout(timer); reject(new BadFrame(`对面拒绝：${frame.code ?? 'unknown'}`)); return false }
      return true
    }
  })

  peer.send({ t: 'hello', proto: 1, token })
  await ack
  peer.gate = null
  return peer
}
