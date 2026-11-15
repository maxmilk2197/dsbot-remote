// 本文件由 AI 生成，请勿用于生产环境。
// 主机侧"等远程连过来"的那一半：开端口 + 应答局域网配对问询。
//
// 配对码是这把门钥匙的全部：远程只输 6 位码，既拿到地址（UDP 广播应答）又拿到
// 通关口令（码本身当 token）。换码 = rotate()，旧码立刻失效。
import { listenDiscovery } from '@dsbot/node-protocol/discovery'
import { listenTcp } from '@dsbot/node-protocol/tcp'
import { elevateEasyTier, findEasyTier, hasLocalIp, hostTag, hostVirtualIp, lanAddress, localSubnets, pairCredentials, startEasyTier, writeElevateScript } from '../../node/easytier.js'

export const DEFAULT_PORT = 7777

export function createHosting({
  store,
  attach,
  warn = () => {},
  hostName = 'DSH 主机',
  // 跨网开关。默认关：EasyTier 是个常驻子进程，一启动就占资源、还要连外部会合点，
  // 在 DSH 启动阶段跟其它插件的 RPC 抢时间 —— crash-2026-11-15T07-32-19 那次
  // 就是启动期 MeshCallError: Call deadline exceeded。先把主流程保稳，
  // 跨网做成用户自己要的时候才开（设置页有开关）。
  network = false,
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
    void startNetwork(chosen, server.port)
    return status()
  }

  // 进虚拟网。成了就多一条跨网的路，不成就只剩局域网 —— 都是能用的状态。
  async function startNetwork(code, port) {
    if (network === false || network === 'off') return
    // 测试里不起 EasyTier：它是个常驻子进程，会把测试进程一直挂到超时。
    // 网络这块由 easytier.test.js 单独测参数拼装，不需要真跑。
    if (process.env.NODE_TEST_CONTEXT !== undefined) return
    if (networkTried === code) return
    networkTried = code
    // 这两个要先读：virtual 初始化时要记下"本机在哪张网"，后面启动参数也要用。
    const lan = lanAddress()
    const subnets = localSubnets()
    virtual = { on: false, ipv4: null, name: pairCredentials(code).networkName, error: null, zeroTun: true, lan: lan ?? null, subnets }

    const found = await findEasyTier().catch(() => undefined)
    if (found === undefined) {
      virtual = { ...virtual, error: '没找到 EasyTier（不在这台机器上，也不在 PATH 里）' }
      warn(`dsbot-nodes: ${virtual.error} —— 跨网连不上，同局域网照常用`)
      return
    }

    // 零权限模式（默认走这条）：不建虚拟网卡，所以不需要管理员权限。
    // 主机把自己所在的局域网"借"给虚拟网（子网代理），远端连那个地址就行。
    // 代价是主机没有虚拟网卡 —— 判断"通没通"不能再看网卡，得看进程状态。
    let job
    try {
      job = startEasyTier({
        core: found.core,
        code,
        ipv4: hostVirtualIp(code),
        noTun: true,
        // 只代理第一张真实网卡：全代理会把虚拟网自己绕进去，而且多网卡时路由会打架。
        subnetProxy: subnets[0],
        // 地址和端口都编进名字：远端从 peer 列表读到就知道该往哪打。
        hostname: lan === undefined ? undefined : hostTag(lan, port),
      })
    } catch (error) {
      virtual = { ...virtual, error: `起不来：${error?.message ?? error}` }
      warn(`dsbot-nodes: EasyTier ${virtual.error}`)
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
      virtual = { ...virtual, on: true, ipv4: ready?.ipv4 ?? null, error: null }
      // 零权限模式下没有网卡可看，所以把"对面该连哪"直接写清楚。
      warn(`dsbot-nodes: 跨网已就绪${virtual.lan === null || virtual.lan === undefined ? '' : `，本机在局域网 ${virtual.lan}`}`
        + `${virtual.subnets?.[0] === undefined ? '' : `（子网代理 ${virtual.subnets[0]}）`} —— 对面输同一个配对码就行`)
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
      warn(`dsbot-nodes: 虚拟网没起来：${virtual.error}。跨网要它；同一个局域网里不受影响`)
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

  // 用户主动开跨网。默认关着（见 network 参数说明），点了才起 EasyTier。
  async function enableNetwork() {
    if (current === null) return { ok: false, error: '还没有开始监听，先有个配对码' }
    network = 'auto'
    networkTried = null
    await startNetwork(current.code, current.port)
    return { ok: virtual.on === true, ...status().network }
  }

  async function disableNetwork() {
    network = false
    try { vnet?.stop() } catch {}
    vnet = null
    virtual = { ...virtual, on: false, ipv4: null, error: null }
    return { ok: true, ...status().network }
  }

  // 用户点「用管理员权限启动」时走这里。
  // 单独把 EasyTier 提起来，不动 DSH —— 重启整个应用代价太大（正在跑的活全断）。
  // 提权进程跑在外面，本进程管不了它的生死，只能靠网卡上有没有那个地址判断。
  async function elevate() {
    if (current === null) return { ok: false, error: '还没有开始监听，先有个配对码' }
    const code = current.code
    const ip = hostVirtualIp(code).split('/')[0]

    // 普通权限那个实例已经证明建不出网卡了，先收掉，免得两个抢 TUN 名。
    try { vnet?.stop() } catch {}
    vnet = null

    const found = await findEasyTier().catch(() => undefined)
    if (found === undefined) return { ok: false, error: '没找到 EasyTier' }

    // 兜底脚本先备好，不等提权失败才做 —— 那条路九成走不通（这个进程弹不出 UAC），
    // 让用户干等 15 秒再告诉他"得自己点"是没道理的。
    const script = await writeElevateScript({ core: found.core, code }).catch(() => null)

    virtual = { ...virtual, on: false, ipv4: null, error: null }
    const raised = await elevateEasyTier({ core: found.core, code })
    if (raised.ok !== true) {
      virtual = { ...virtual, error: raised.error }
      return { ...raised, ...(script === null ? {} : { script }) }
    }

    // 等网卡真的出现。提权进程是异步起来的，点完确认到网卡就绪还有一两秒。
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (hasLocalIp(ip)) {
        virtual = { on: true, ipv4: ip, name: pairCredentials(code).networkName, error: null }
        warn(`dsbot-nodes: 虚拟网已就绪（管理员权限，${ip}）—— 对面输同一个码就能跨网连`)
        return { ok: true, ipv4: ip, pid: raised.pid }
      }
      await new Promise(done => setTimeout(done, 500))
    }
    const error = '权限拿到了，但 30 秒内没建出网卡（可能被安全软件拦了）'
    virtual = { ...virtual, on: false, error }
    return { ok: false, error, ...(script === null ? {} : { script }) }
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
      // 判定以网卡为准，不看内存里的开关 —— EasyTier 可能是插件起的、提权脚本起的、
      // 或者用户自己开的；只要 10.126.126.1 真的挂在本机，跨网就是通的。
      // 反过来进程一停网卡就没了，这里会立刻如实变回 false。
      network: {
        ...virtual,
        // TUN 模式看网卡（最可信）；零权限模式没有网卡，只能看进程还活着没。
        on: virtual.zeroTun === true
          ? virtual.on && vnet !== null && vnet.child?.exitCode === null
          : (virtual.on || hasLocalIp(virtual.ipv4 ?? hostVirtualIp(current?.code ?? '').split('/')[0])),
        name: virtual.name ?? (current === null ? null : pairCredentials(current.code).networkName),
        // 只要还没通就给按钮 —— 之前只在"缺管理员权限"时给，结果提权一失败
        // （error 变成别的话）按钮就消失了，用户连重试的机会都没有。
        // 唯一不给的情况是压根没找到 EasyTier，那提权也救不了。
        needsElevation: virtual.zeroTun === true
          ? false   // 零权限就能用，不需要提权
          : (!(virtual.on || hasLocalIp(virtual.ipv4 ?? hostVirtualIp(current?.code ?? '').split('/')[0]))
            && !/没找到 EasyTier/.test(virtual.error ?? '')),
      },
      // 已经在这个端口上的是哪台机器（给界面直接看）
      online: store.list().filter(node => node.status === 'online').map(node => ({
        id: node.id, name: node.name, botName: node.botName ?? '',
      })),
    }
  }

  return { start, stop, rotate, status, ensureCode, elevate, enableNetwork, disableNetwork }
}
