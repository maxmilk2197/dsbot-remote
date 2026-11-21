// 本文件由 AI 生成，请勿用于生产环境。
/**
 * 局域网配对发现（UDP 广播）—— 默认关闭
 * ============================================================================
 * 为什么默认关：上一版的问询包把配对码明文发到广播地址上。同网段任何人抓一个
 * UDP 包就拿到了配对码，而配对码同时是会话密钥的盐 —— 等于整条连接被人接管；
 * 广播本身也没有认证，谁都能抢先回一句 pair.ok 把对端引到自己的机器上。
 * 办公室、园区、咖啡馆这类"不可信局域网"里，这一条不能默认开着。
 *
 * 显式打开之后（--lan 或 DSBOT_NODES_LAN_DISCOVERY=1）：
 *   · 问询包里不再带配对码，只问"这张网里有 dsbot 主机吗"
 *   · 主机答 { name, port }，代价是同一张网的人知道"这里有个主机"
 *   · 码的校验全部留给 TCP 握手（X25519 + HMAC，且按来源限速）
 *
 * 流程：
 *   主机  listenDiscovery({ port, name }) → 绑 UDP 47821
 *   远程  findHost()                      → 广播 { magic, t:'pair' }
 *   主机  限速通过 → 回 { magic, t:'pair.ok', name, port }
 *   远程  拿 host+port，再用配对码走 TCP 握手
 */
import dgram from 'node:dgram'
import os from 'node:os'

export const DISCOVERY_PORT = 47821
export const DISCOVERY_MAGIC = 'dsbot-nodes/2'

/** 广播发现是不是被显式打开了。默认关。 */
export function discoveryEnabled(options = {}) {
  if (options.lan === true) return true
  return process.env.DSBOT_NODES_LAN_DISCOVERY === '1'
}

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

/**
 * 主机侧：应答配对问询。调用方负责判断要不要开（见 discoveryEnabled）。
 * @returns {Promise<{ close: () => void, port: number }>}
 */
export async function listenDiscovery({
  port,
  name = '',
  udpPort = DISCOVERY_PORT,
  onPair,
  warn,
}) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const attempts = new Map()

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

    try {
      socket.send(JSON.stringify({ magic: DISCOVERY_MAGIC, t: 'pair.ok', name, port }), rinfo.port, rinfo.address)
    } catch (error) {
      warn?.(`发现应答发送失败：${error.message}`)
    }
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
  timeoutMs = 4000,
  udpPort = DISCOVERY_PORT,
  onProbe,
}) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

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
      const payload = Buffer.from(JSON.stringify({ magic: DISCOVERY_MAGIC, t: 'pair' }))
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
      fail(Object.assign(new Error('这张网里没有机器应答（广播可能被防火墙吃了）'), { code: 'node/no-host' }))
    }, timeoutMs)
    timer.unref?.()
  })
}
