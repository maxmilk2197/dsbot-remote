// 本文件由 AI 生成，请勿用于生产环境。
// 主机侧"等远程连过来"的那一半：开端口 + 应答局域网配对问询。
//
// 配对码是这把门钥匙的全部：远程只输 6 位码，既拿到地址（UDP 广播应答）又拿到
// 通关口令（码本身当 token）。换码 = rotate()，旧码立刻失效。
import { listenDiscovery } from '@dsbot/node-protocol/discovery'
import { listenTcp } from '@dsbot/node-protocol/tcp'
import { HOST_VIRTUAL_IP, elevateEasyTier, findEasyTier, hasLocalIp, pairCredentials, startEasyTier } from '../../node/easytier.js'

export const DEFAULT_PORT = 7777

export function createHosting({
  store,
  attach,
  warn = () => {},
  hostName = 'DSH 主机',
  // 跨网靠它：配对码既当口令又当 EasyTier 的网络名/密钥，两端进同一个虚拟网。
  // 默认就起 —— 用户要的是"输个码就通"，不该还得自己点一下开。同局域网多这一层
  // 没坏处；起不来（非管理员建不了 TUN）就退回局域网，不挡监听。
  network = 'auto',
}) {
  let current = null
  // 虚拟网的现状：on 表示进程活着，ipv4 是它在虚拟网里的地址（要告诉对面）。
  let virtual = { on: false, ipv4: null, name: null, error: null }
  let vnet = null
  // 起失败过就别反复试：每次失败都拉一个进程、写一堆日志，没用。
  let networkTried = null

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
    // 虚拟网放在后面异步起：起不来也不能耽误局域网这条道。
    void startNetwork(chosen)
    return status()
  }

  // 进虚拟网。成了就多一条跨网的路，不成就只剩局域网 —— 都是能用的状态。
  async function startNetwork(code) {
    if (network === false || network === 'off') return
    if (networkTried === code) return
    networkTried = code
    virtual = { on: false, ipv4: null, name: pairCredentials(code).networkName, error: null }

    const found = await findEasyTier().catch(() => undefined)
    if (found === undefined) {
      virtual = { ...virtual, error: '没找到 EasyTier（不在这台机器上，也不在 PATH 里）' }
      warn('dsbot-nodes: %s —— 跨网连不上，同局域网照常用', virtual.error)
      return
    }

    let job
    try {
      // 固定地址：远端不必猜主机 DHCP 到了哪，永远连 HOST_VIRTUAL_IP。
      job = startEasyTier({ core: found.core, code, ipv4: HOST_VIRTUAL_IP })
    } catch (error) {
      virtual = { ...virtual, error: `起不来：${error?.message ?? error}` }
      warn('dsbot-nodes: EasyTier %s', virtual.error)
      return
    }
    vnet = job
    // 先把进程记在 status 里，界面能看到"正在进虚拟网"；再等它真正就绪。
    try {
      const ready = await job.ready
      if (current === null || current.code !== code) {
        // 等的这段时间里换了码或者停了：这个进程已经没意义了。
        try { job.stop() } catch {}
        return
      }
      virtual = { on: true, ipv4: ready?.ipv4 ?? null, name: virtual.name, error: null }
      warn('dsbot-nodes: 虚拟网已就绪%s —— 对面用同一个码、加 --network 就能跨网连',
        virtual.ipv4 === null ? '' : `（${virtual.ipv4}）`)
    } catch (error) {
      try { job.stop() } catch {}
      vnet = null
      const message = String(error?.message ?? error)
      // 两条原因完全不同，提示也得不同 —— 一句笼统的"没起来"帮不上任何忙。
      //   1. 建不出虚拟网卡：Windows 上这是没给管理员权限（wintun 要提权）；
      //   2. 连不上会合点：多半是本机的代理软件接管了流量（TUN/增强模式把
      //      11010 这种非常规端口塞进了代理，对面根本没收到握手）。
      const hint = /Failed to create adapter|tun device/i.test(message)
        ? '要用管理员身份运行 DSH 才能建虚拟网卡'
        : '连不上会合节点 —— 如果开着代理软件（Clash 等）的 TUN/增强模式，关掉它，或给 39.108.52.138、8.148.29.206 加直连规则'
      virtual = { ...virtual, on: false, error: `${message}（${hint}）` }
      warn('dsbot-nodes: 虚拟网没起来：%s。跨网要它；同一个局域网里不受影响', virtual.error)
    }
  }

  async function stop() {
    if (current === null && vnet === null) return
    try { vnet?.stop() } catch {}
    vnet = null
    virtual = { on: false, ipv4: null, name: null, error: null }
    if (current === null) return
    try { current.discovery?.close() } catch {}
    try { current.server?.close() } catch {}
    current = null
  }

  // 用户点「用管理员权限启动」时走这里。
  // 单独把 EasyTier 提起来，不动 DSH —— 重启整个应用代价太大（正在跑的活全断）。
  // 提权进程跑在外面，本进程管不了它的生死，只能靠网卡上有没有那个地址判断。
  async function elevate() {
    if (current === null) return { ok: false, error: '还没有开始监听，先有个配对码' }
    const code = current.code
    const ip = HOST_VIRTUAL_IP.split('/')[0]

    // 普通权限那个实例已经证明建不出网卡了，先收掉，免得两个抢 TUN 名。
    try { vnet?.stop() } catch {}
    vnet = null

    const found = await findEasyTier().catch(() => undefined)
    if (found === undefined) return { ok: false, error: '没找到 EasyTier' }

    virtual = { ...virtual, on: false, ipv4: null, error: null }
    const raised = await elevateEasyTier({ core: found.core, code })
    if (raised.ok !== true) {
      virtual = { ...virtual, error: raised.error }
      return raised
    }

    // 等网卡真的出现。提权进程是异步起来的，UAC 点完到网卡就绪还有一两秒。
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (hasLocalIp(ip)) {
        virtual = { on: true, ipv4: ip, name: pairCredentials(code).networkName, error: null }
        warn('dsbot-nodes: 虚拟网已就绪（管理员权限，%s）—— 对面输同一个码就能跨网连', ip)
        return { ok: true, ipv4: ip, pid: raised.pid }
      }
      await new Promise(done => setTimeout(done, 500))
    }
    const error = '提权进程起来了，但 30 秒内没建出网卡（可能被安全软件拦了）'
    virtual = { ...virtual, on: false, error }
    return { ok: false, error }
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
      // 跨网这条路的状态：on=true 表示两端进同一个虚拟网了。
      // error 非空就是起不来，界面要把它显示出来。
      network: {
        ...virtual,
        name: virtual.name ?? (current === null ? null : pairCredentials(current.code).networkName),
        // 只有"缺管理员权限"这一种失败，设置页才该显示提权按钮 ——
        // 代理拦截、找不到二进制这些提权也解决不了，给了按钮只会误导。
        needsElevation: virtual.on !== true && /管理员|Failed to create adapter/i.test(virtual.error ?? ''),
      },
      // 已经在这个端口上的是哪台机器（给界面直接看）
      online: store.list().filter(node => node.status === 'online').map(node => ({
        id: node.id, name: node.name, botName: node.botName ?? '',
      })),
    }
  }

  return { start, stop, rotate, status, ensureCode, elevate }
}
