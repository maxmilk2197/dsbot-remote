// 本文件由 AI 生成，请勿用于生产环境。
// 主机侧"等远程连过来"的那一半：开端口 + 应答局域网配对问询。
//
// 配对码是这把门钥匙的全部：远程只输 6 位码，既拿到地址（UDP 广播应答）又拿到
// 通关口令（码本身当 token）。换码 = rotate()，旧码立刻失效。
import { listenDiscovery } from '@dsbot/node-protocol/discovery'
import { listenTcp } from '@dsbot/node-protocol/tcp'

export const DEFAULT_PORT = 7777

export function createHosting({ store, attach, warn = () => {}, hostName = 'DSH 主机' }) {
  let current = null

  async function ensureCode() {
    const { code } = await store.host()
    if (typeof code === 'string' && code.length >= 6) return code
    const fresh = store.newCode()
    await store.setHost({ code: fresh })
    return fresh
  }

  async function start({ code, port } = {}) {
    await stop()
    const chosen = String(code ?? (await ensureCode())).replace(/[\s-]/g, '').toUpperCase()
    const saved = await store.host()
    const wantedPort = Number(port ?? saved.port ?? DEFAULT_PORT)

    const server = await listenTcp({
      port: wantedPort,
      host: '0.0.0.0',
      token: chosen,
      // 远端连上又立刻断开是家常便饭。这个回调的返回值没人接，任何 rejection
      // 都会变成宿主的 fatal error，所以这里必须自己兜住。
      onConnection: peer => {
        Promise.resolve(attach(peer)).catch(error => warn(`握手没成：${error?.message ?? error}`))
      },
    })

    const discovery = await listenDiscovery({
      code: chosen,
      port: server.port,
      name: hostName,
      onPair: address => warn(`配对请求来自 ${address}`),
      warn,
    })

    await store.setHost({ code: chosen, port: server.port })
    // 监听不该独自撑住进程：宿主常驻，但测试与 CLI 用完就能退。
    server.server?.unref?.()
    current = { code: chosen, port: server.port, server, discovery }
    warn(`等你来连：配对码 ${chosen}，端口 ${server.port}`)
    return status()
  }

  async function stop() {
    if (current === null) return
    try { current.discovery?.close() } catch {}
    try { current.server?.close() } catch {}
    current = null
  }

  // 换一把钥匙：旧码立刻作废（监听重开，新码当 token）。
  async function rotate() {
    const code = store.newCode()
    await store.setHost({ code })
    return await start({ code })
  }

  function status() {
    return {
      hosting: current !== null,
      code: current?.code ?? null,
      port: current?.port ?? null,
      // 已经在这个端口上的是哪台机器（给界面直接看）
      online: store.list().filter(node => node.status === 'online').map(node => ({
        id: node.id, name: node.name, botName: node.botName ?? '',
      })),
    }
  }

  return { start, stop, rotate, status, ensureCode }
}
