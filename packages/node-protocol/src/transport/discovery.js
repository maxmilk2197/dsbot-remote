// 本文件由 AI 生成，请勿用于生产环境。
/**
 * 局域网配对发现（UDP 广播）
 * ============================================================================
 * 目的：让"输入配对码"这一个动作足够。远程不该知道 IP、端口、令牌。
 *
 * 流程：
 *   主机  listen({code})      → 绑 UDP 47821，等 pair 问询
 *   远程  findHost({code})    → 往广播地址发 { t:'pair', code }
 *   主机  码对 → 回 { t:'pair.ok', name, port }（**不回令牌**，码本身就是凭证）
 *   远程  拿 host+port → 用码当 token 走正常的 TCP 握手
 *
 * 为什么码能当令牌：TCP 层的 gate 校验的就是同一个码，多一条通路就多一个泄漏面。
 * 限速：同一 IP 每分钟 5 次，错了也照常回 reject（不泄露"码存在但不对"的时序差异）。
 */
import dgram from 'node:dgram'
import os from 'node:os'

export const DISCOVERY_PORT = 47821
export const DISCOVERY_MAGIC = 'dsbot-nodes/1'

/** 本机所有 IPv4 网卡的 /24 广播地址 + 全局广播。 */
export function broadcastAddresses() {
  const out = new Set(['255.255.255.255'])
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family !== 'IPv4' || nic.internal) continue
      const parts = nic.address.split('.')
      if (parts.length === 4) out.add(`${parts[0]}.${parts[1]}.${parts[2]}.255`)
    }
  }
  return [...out]
}

const normalize = (code) => String(code ?? '').replace(/[\s-]/g, '').toUpperCase()

/**
 * 主机侧：应答配对问询。
 * @returns {Promise<{ close: () => void, port: number }>}
 */
export async function listenDiscovery({
  code,
  port,
  name = '',
  udpPort = DISCOVERY_PORT,
  onPair,
  warn,
}) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const attempts = new Map()
  const wanted = normalize(code)

  socket.on('message', (buf, rinfo) => {
    let msg
    try {
      msg = JSON.parse(buf.toString('utf8'))
    } catch {
      return
    }
    if (msg?.magic !== DISCOVERY_MAGIC || msg.t !== 'pair') return

    const now = Date.now()
    const hits = (attempts.get(rinfo.address) ?? []).filter((at) => now - at < 60_000)
    if (hits.length >= 5) return
    hits.push(now)
    attempts.set(rinfo.address, hits)

    const reply = (body) => {
      try {
        socket.send(JSON.stringify({ magic: DISCOVERY_MAGIC, ...body }), rinfo.port, rinfo.address)
      } catch (error) {
        warn?.(`发现应答发送失败：${error.message}`)
      }
    }

    if (normalize(msg.code) !== wanted) {
      reply({ t: 'pair.reject' })
      return
    }
    reply({ t: 'pair.ok', name, port })
    onPair?.(rinfo.address)
  })

  socket.on('error', (error) => warn?.(`发现服务出错：${error.message}`))

  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(udpPort, () => {
      try {
        socket.setBroadcast(true)
      } catch {
        /* 某些平台不允许，退化成单播也能用 */
      }
      // 宿主里这个 socket 不该独自撑住进程（测试里更明显）。
      socket.unref?.()
      resolve()
    })
  })

  return { close: () => { try { socket.close() } catch {} }, port: udpPort }
}

/**
 * 远程侧：广播找主机。
 * @returns {Promise<{ host: string, port: number, name: string }>}
 */
export async function findHost({
  code,
  timeoutMs = 4000,
  udpPort = DISCOVERY_PORT,
  onProbe,
}) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const wanted = normalize(code)

  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try { socket.close() } catch {}
      resolve(value)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      try { socket.close() } catch {}
      reject(error)
    }

    socket.on('message', (buf, rinfo) => {
      let msg
      try {
        msg = JSON.parse(buf.toString('utf8'))
      } catch {
        return
      }
      if (msg?.magic !== DISCOVERY_MAGIC || msg.t !== 'pair.ok') return
      finish({ host: rinfo.address, port: msg.port, name: msg.name ?? '' })
    })
    socket.on('error', fail)

    socket.bind(() => {
      try {
        socket.setBroadcast(true)
      } catch {
        /* 见上 */
      }
      const payload = Buffer.from(JSON.stringify({ magic: DISCOVERY_MAGIC, t: 'pair', code: wanted }))
      for (const address of broadcastAddresses()) {
        onProbe?.(address)
        try {
          socket.send(payload, udpPort, address, () => {})
        } catch {
          /* 某个网卡发不出去不影响别的 */
        }
      }
    })

    const timer = setTimeout(() => {
      fail(Object.assign(new Error(`没有机器应答配对码 ${wanted}`), { code: 'node/no-host' }))
    }, timeoutMs)
    timer.unref?.()
  })
}
