// 本文件由 AI 生成，请勿用于生产环境。
/**
 * EasyTier 组网：把"两台机器 IP 可达"这件事外包出去
 * ============================================================================
 * 为什么是 EasyTier：它把 NAT 穿透 + 失败时走共享节点中转都做了，我们只需要一条
 * 普通 TCP 连接。没有它，跨网就得自己搭中继或让用户配端口映射。
 *
 * 约定：
 *   · 虚拟网名 = 配对码（6 位），虚拟网密码 = 由码派生 —— 用户只输一次码
 *   · `-d` 让 EasyTier 自动分配虚拟 IP（默认 10.126.126.0/24）
 *   · 不传 -p 时只在同一局域网内互相发现；跨网要共享节点（servers）
 *
 * 需要管理员权限（要建 TUN 网卡）。提不了权不静默失败，直接报错让人看见。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { ensureEasyTier, easyTierCacheDir, findEasyTierBinaries } from './easytier-fetch.js'

export const EASYTIER_DIR = join(homedir(), '.dsbot-remote', 'easytier')
// 二进制不再随仓库分发：第一次要跨网时按当前平台自动下载一份，缓存在
// ~/.dsh/bot/easytier/<版本>/<平台-架构>/。离线环境把解压好的目录给
// DSBOT_EASYTIER_DIR，那边优先用，不联网。
// 跨网必须有个"会合点"：两端不在同一张局域网时，得先在一个公共节点上互相发现。
//
// 官方那个 public.easytier.cn 已经在 2026 年 2 月停服（域名现在是 NXDOMAIN），
// 网上大量教程还写着它 —— 照抄就是连不上。下面这些是社区仍在跑的共享节点，
// 取自监控站 https://easytier.gd.nkbpal.cn/（会持续更新，失效了去那里换）。
//
// 一律写域名或 IP，不靠本地 DNS 猜：EasyTier 会同时连多个，哪个通用哪个。
export const DEFAULT_SERVERS = [
  'tcp://225284.xyz:11010',        // 深圳·专线，实测握手成功
  'tcp://et.sumight.top:11010',    // 上海 BGP
  'tcp://et.qdckw.top:11010',      // 低延迟
  'udp://us01.225284.xyz:11010',   // 美国，作备份
]

/**
 * 虚拟网段按配对码派生，不写死。
 *
 * 写死 10.126.126.0/24 有两个麻烦：用户自己的局域网万一正好是这一段，路由会打架；
 * 同一台设备连两个不同主机时，两边都塞 10.126.126.1，也会撞。
 * 用配对码算出来就自然错开了 —— 同一个码两端算出同一段，不同码互不干扰。
 * 避开 10.0 / 10.1 / 10.10 这些家用路由器爱用的段。
 */
export function virtualCidr(code) {
  const digest = createHash('sha256').update(`vnet:${String(code ?? '').trim().toUpperCase()}`).digest()
  const second = 30 + (digest[0] % 90)      // 10.30.x.x ~ 10.119.x.x
  const third = 1 + (digest[1] % 250)       // 避开 .0 和 .255
  return `10.${second}.${third}.0/24`
}

/** 主机在这个网段里占的固定地址（.1），远端走 DHCP 拿别的。 */
export function hostVirtualIp(code) {
  return `${virtualCidr(code).split('/')[0].replace(/\.0$/, '.1')}/24`
}

// 地址是否真的挂在本机某块网卡上。这是"网卡建出来了"唯一可信的证据 ——
// EasyTier 会把自己的配置回显到日志，拿日志判断等于自己骗自己。
export function hasLocalIp(address) {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.address === address) return true
    }
  }
  return false
}

const maskBits = (mask) => {
  const parts = String(mask ?? '').split('.').map(Number)
  if (parts.length !== 4 || parts.some(each => !Number.isInteger(each))) return 24
  let bits = 0
  for (const part of parts) {
    // 逐位数字符串比较省事：255 → 8 个 1，0 → 0 个 1。
    bits += part.toString(2).split('').filter(each => each === '1').length
  }
  return bits
}

// 192.168.3.248 + /24 → 192.168.3.0
// 子网代理要的是网络地址，直接把主机地址丢进去 EasyTier 会拒：
// "failed to parse proxy network: host part of address was not zero"。
export const toNetworkAddress = (address, bits) => {
  const parts = String(address).split('.').map(Number)
  if (parts.length !== 4 || parts.some(each => !Number.isInteger(each))) return address
  const value = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0
  const net = (value & mask) >>> 0
  return [(net >>> 24) & 255, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join('.')
}

/**
 * 本机所在的局域网段（CIDR）。主机用它们做子网代理，把"我这张网上的服务"
 * 借给虚拟网 —— 这样远端不用知道主机装了什么，只要连主机的局域网地址就行。
 *
 * 虚拟网卡、回环、Tailscale 这类都不算：它们是隧道，代理出去只会绕圈。
 */
export function localSubnets() {
  const out = []
  const skip = /^(lo|vEthernet|VirtualBox|VMware|Hyper-V|Tailscale|Meta|docker|br-|veth|tun|tap|et_)/i
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (skip.test(name)) continue
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal === true) continue
      if (entry.address.startsWith('169.254.')) continue   // 自动私有地址，没意义
      if (entry.address.startsWith('10.126.126.')) continue // 就是这个虚拟网本身
      const bits = maskBits(entry.netmask)
      out.push(`${toNetworkAddress(entry.address, bits)}/${bits}`)
    }
  }
  return out
}

/**
 * 本机在局域网里的地址（不是虚拟网地址）。主机把它编进 EasyTier 的 hostname，
 * 远端从 peer 列表里读出来就知道该往哪连 —— 这样两端都不需要预先知道对方地址。
 */
export function lanAddress() {
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (/^(lo|vEthernet|VirtualBox|VMware|Hyper-V|Tailscale|Meta|docker)/i.test(name)) continue
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal === true) continue
      if (entry.address.startsWith('169.254.') || entry.address.startsWith('10.126.126.')) continue
      return entry.address
    }
  }
  return undefined
}

/**
 * 主机的 hostname 里编着自己的局域网地址，远端从 peer 列表把它读出来。
 *
 * 为什么要绕这一圈：跨网时远端连不上主机，也就没法"先握手再问地址"。
 * 但两端都进了虚拟网之后，peer 列表是对彼此可见的 —— 主机把地址写在自己名字上，
 * 远端读一下就知道该往哪打。不需要任何一方有公网地址，也不需要中转服务器。
 */
export const hostTag = (address, port) =>
  `dsbot-h-${String(address).replace(/\./g, '-')}${Number(port) > 0 ? `-${Number(port)}` : ''}`

export function parseHostTag(hostname) {
  const token = String(hostname ?? '').trim()
  // 4 段数字 = 只有地址；5 段 = 地址 + 端口。段落数就能区分，不会混淆。
  const four = /^dsbot-h-(\d+)-(\d+)-(\d+)-(\d+)$/.exec(token)
  if (four !== null) return { address: `${four[1]}.${four[2]}.${four[3]}.${four[4]}`, port: undefined }
  const five = /^dsbot-h-(\d+)-(\d+)-(\d+)-(\d+)-(\d+)$/.exec(token)
  if (five !== null) {
    return { address: `${five[1]}.${five[2]}.${five[3]}.${five[4]}`, port: Number(five[5]) }
  }
  return undefined
}

/**
 * 轮询 peer 列表，等主机的地址出现。虚拟网刚起来时列表是空的，所以要等。
 * @returns {Promise<string|undefined>} 主机的局域网地址，比如 192.168.3.248
 */
export async function waitForHostPeer({ core, timeoutMs = 25_000, intervalMs = 1_500, onLog, rpcPortal, instanceName }) {
  const cli = join(dirname(core), isWindows ? 'easytier-cli.exe' : 'easytier-cli')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const output = await new Promise((resolve) => {
      let text = ''
      const child = spawn(cli, [
        ...(rpcPortal ? ['-p', `127.0.0.1:${rpcPortal}`] : []),
        ...(instanceName ? ['-n', instanceName] : []),
        'peer',
      ], { windowsHide: true, cwd: dirname(core) })
      child.stdout?.on('data', (chunk) => { text += chunk.toString('utf8') })
      child.stderr?.on('data', (chunk) => { text += chunk.toString('utf8') })
      child.on('error', () => resolve(''))
      child.on('exit', () => resolve(text))
    })
    // hostname 在表格的某一列里，直接全文找标记就够了。
    for (const token of output.split(/\s+/)) {
      const host = parseHostTag(token)
      if (host !== undefined) {
        onLog?.(`找到主机：${host.address}${host.port === undefined ? '' : `:${host.port}`}`)
        return host
      }
    }
    await new Promise(done => setTimeout(done, intervalMs))
  }
  return undefined
}

/**
 * 给正在跑的 EasyTier 加一条端口转发规则（远端用）。
 *
 * 远端零权限模式下没有虚拟网卡，本机程序连不到虚拟网里的任何地址，所以要在
 * 本机开一个真实端口，由 EasyTier 把它转进隧道。这条规则必须等知道主机地址
 * 之后才能加，而主机地址要进了虚拟网才看得到 —— 所以塞不进启动参数，
 * 只能用管理接口追加。
 */
export async function addPortForward({ core, protocol = 'tcp', bind, dst, timeoutMs = 15_000, rpcPortal, instanceName }) {
  const cli = join(dirname(core), isWindows ? 'easytier-cli.exe' : 'easytier-cli')
  const run = () => new Promise((resolve) => {
    let err = ''
    const child = spawn(cli, [
      ...(rpcPortal ? ['-p', `127.0.0.1:${rpcPortal}`] : []),
      ...(instanceName ? ['-n', instanceName] : []),
      'port-forward', 'add', protocol, bind, dst,
    ], {
      windowsHide: true, cwd: dirname(core),
    })
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', (chunk) => { err += chunk.toString('utf8') })
    child.on('error', (error) => resolve({ ok: false, error: error.message }))
    child.on('exit', (code_) => resolve({
      ok: code_ === 0,
      error: code_ === 0 ? undefined : (err.trim().split('\n').pop() || `退出码 ${code_}`),
    }))
  })

  // 实例刚起来时管理接口可能还没就绪，重试几次再放弃。
  const deadline = Date.now() + timeoutMs
  let last = { ok: false, error: '没跑起来' }
  while (Date.now() < deadline) {
    last = await run()
    if (last.ok) return last
    await new Promise(done => setTimeout(done, 1_000))
  }
  return last
}

const isWindows = process.platform === 'win32'

/**
 * 找一份能用的 EasyTier：
 *   1. 显式给的目录（测试 / 调用方指定）
 *   2. DSBOT_EASYTIER_DIR（离线安装）
 *   3. 自动下载的缓存
 *   4. ~/.dsbot-remote/easytier、常见安装目录、PATH
 *   5. 都没有 → 按平台下载一份（测试环境不联网）
 *
 * 下载失败会抛错，让界面看到"为什么跨网没起来"，而不是笼统的"没找到"。
 */
export async function findEasyTier(extraDirs = [], { download = true, onLog } = {}) {
  const deepDirs = [
    ...extraDirs,
    process.env.DSBOT_EASYTIER_DIR,
    easyTierCacheDir(),
    EASYTIER_DIR,
    join(homedir(), 'easytier'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'easytier') : undefined,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'easytier') : undefined,
  ].filter(Boolean)

  for (const dir of deepDirs) {
    const found = findEasyTierBinaries(dir)
    if (found !== undefined) return { ...found, source: 'local' }
  }
  // PATH 里只查当前目录，不往下翻 —— 那里目录太多了。
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const found = findEasyTierBinaries(dir, process.platform, { deep: false })
    if (found !== undefined) return { ...found, source: 'path' }
  }

  // 测试环境不联网：参数拼装另有专门的用例。
  if (!download || process.env.DSBOT_NODES_TEST === '1') return undefined
  return await ensureEasyTier({ onLog })
}

/** 列出本地目录里看起来像 EasyTier 的东西，给"我该放哪"的提示用。 */
export async function inspectEasyTierDir(dir = EASYTIER_DIR) {
  try {
    const names = await readdir(dir)
    return names.filter((name) => /easytier/i.test(name))
  } catch {
    return []
  }
}

/** 配对码 → EasyTier 的网名与密码。同一个码在两端派生出同一套。 */
/**
 * 和本机其它 EasyTier 错开。
 *
 * HMCL 的「陶瓦联机」也内置 EasyTier。默认实例名、默认监听口 11010、
 * 默认 RPC 15888 都是全局的 —— 两边一起跑就会互相踩。
 * 这里从配对码派生一组只属于我们的端口（26000-34000），并给实例起独立名字、
 * 独立配置目录，两边就能同时存在。
 */
export function instancePorts(code, role = 'host') {
  const normalized = String(code ?? '').replace(/[\s-]/g, '').toUpperCase()
  // 主机和加入端各算各的端口：同一台机器既当主机又去连别人时也不会撞。
  const digest = createHash('sha256').update(`dsbot-ports:${role}:${normalized}`).digest()
  const base = 26000 + (digest.readUInt16BE(0) % 2000) * 4
  return {
    listener: base,
    rpc: base + 1,
    instanceName: role === 'join' ? `dsbot-join-${normalized}` : `dsbot-${normalized}`,
    configDir: join(EASYTIER_DIR, 'instances', `${role}-${normalized}`),
  }
}

/**
 * 拼 EasyTier 启动参数（纯函数，单测直接验）。
 *
 * role=host：监听一个自己的高位端口，方便 P2P 直连；
 * role=join：--no-listener，只连出去。加入端再监听 11010 会和本机主机实例
 *           抢端口（os error 10048），EasyTier 会直接退出(1)。
 */
export function buildEasyTierArgs({
  code,
  servers = DEFAULT_SERVERS,
  ipv4,
  hostname,
  noTun = false,
  subnetProxy,
  role = 'host',
}) {
  const { networkName, networkSecret } = pairCredentials(code)
  const ports = instancePorts(code, role)
  const args = [
    // -i 和 -d 是二选一：给了固定地址就别再要 DHCP，两边同时给会打架。
    ...(typeof ipv4 === 'string' && ipv4 !== '' ? ['-i', ipv4] : ['-d']),
    '--network-name', networkName,
    '--network-secret', networkSecret,
    // 独立实例 / 独立配置：和 HMCL 的陶瓦联机（也是 EasyTier）共存。
    '-m', ports.instanceName,
    '--config-dir', ports.configDir,
    ...(role === 'join'
      ? ['--no-listener']
      : ['-l', `tcp://0.0.0.0:${ports.listener}`, '-l', `udp://0.0.0.0:${ports.listener}`]),
    '--rpc-portal', String(ports.rpc),
    ...(typeof hostname === 'string' && hostname !== '' ? ['--hostname', hostname] : []),
    ...(noTun ? ['--no-tun'] : []),
    ...(typeof subnetProxy === 'string' && subnetProxy !== '' ? ['-n', subnetProxy] : []),
    ...(servers.length ? servers.flatMap((server) => ['-p', server]) : []),
  ]
  return { ports, args }
}

// 进程退出时尽量把子进程带走：DSH 被关掉后留一个 EasyTier 在后台，
// 正是"关了 DSH 还是和陶瓦联机打架"的来源。
const children = new Set()
let exitHooked = false
function trackChild(child) {
  children.add(child)
  child.once('exit', () => children.delete(child))
  if (exitHooked) return
  exitHooked = true
  const killAll = () => { for (const each of children) { try { each.kill() } catch {} } }
  process.once('exit', killAll)
  process.once('SIGINT', killAll)
  process.once('SIGTERM', killAll)
}

// 上一次没退干净的实例：pid 文件里记着，起来之前先收掉。
// 必须按实例（角色 + 配对码）分开存 —— 全局一个文件的话，起加入端会把
// 正在跑的主机实例杀掉，跨网直接断。
function pidFile(ports) {
  return join(ports.configDir, 'current.pid')
}
function killPreviousInstance(ports) {
  try {
    const raw = JSON.parse(readFileSync(pidFile(ports), 'utf8'))
    const pid = Number(raw?.pid)
    const at = Number(raw?.at ?? 0)
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return
    if (Date.now() - at > 24 * 3600 * 1000) return
    try { process.kill(pid) } catch {}
  } catch {}
}
function rememberInstance(ports, pid) {
  try {
    mkdirSync(ports.configDir, { recursive: true })
    writeFileSync(pidFile(ports), JSON.stringify({ pid, at: Date.now() }))
  } catch {}
}
function forgetInstance(ports, pid) {
  try {
    const raw = JSON.parse(readFileSync(pidFile(ports), 'utf8'))
    if (Number(raw?.pid) === pid) unlinkSync(pidFile(ports))
  } catch {}
}

export function pairCredentials(code) {
  const normalized = String(code ?? '').replace(/[\s-]/g, '').toUpperCase()
  const secret = createHash('sha256').update(`dsbot-nodes:${normalized}`).digest('hex').slice(0, 24)
  return { networkName: `dsbot-${normalized}`, networkSecret: secret, code: normalized }
}

/**
 * 起一个 EasyTier 进程加入虚拟网。
 * @returns {Promise<{ child, stop, ready: Promise<{ ipv4?: string }> }>}
 */
export function startEasyTier({
  core,
  code,
  servers = DEFAULT_SERVERS,
  onLog,
  extraArgs = [],
  // 主机占一个固定地址，远端就能直接连它，不必知道对方 DHCP 到了哪个 IP。
  // 留空则走 DHCP（远端用）。
  ipv4,
  hostname,
  // 零权限模式：不建虚拟网卡。虚拟 IP 照样分配，但本机没有对应的网卡，
  // 本机程序不能直接访问那个地址 —— 主机靠子网代理、远端靠端口转发。
  noTun = false,
  // 把自己所在的局域网"借"给虚拟网（子网代理）。主机用这个让远端访问到它。
  subnetProxy,
  // host：监听自己的端口；join：--no-listener，只连出去。
  role = 'host',
}) {
  const built = buildEasyTierArgs({ code, servers, ipv4, hostname, noTun, subnetProxy, role })
  const ports = built.ports
  const args = [...built.args, ...extraArgs]

  // 上一轮没退干净的先收掉，再起新的 —— 否则两个同名实例会抢 RPC 口。
  killPreviousInstance(ports)
  try { mkdirSync(ports.configDir, { recursive: true }) } catch {}

  // cwd 必须跟着二进制走：EasyTier 要在自己旁边找 wintun.dll 建虚拟网卡。
  // 从别的目录拉起来它会报 Failed to create adapter —— 看着像没权限，其实是找不到 DLL。
  const child = spawn(core, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    cwd: dirname(core),
  })

  trackChild(child)
  if (child.pid !== undefined) rememberInstance(ports, child.pid)
  child.once('exit', () => { if (child.pid !== undefined) forgetInstance(ports, child.pid) })

  let output = ''
  const feed = (chunk) => {
    const text = chunk.toString('utf8')
    output += text
    if (output.length > 64_000) output = output.slice(-32_000)
    onLog?.(text.trimEnd())
  }
  child.stdout?.on('data', feed)
  child.stderr?.on('data', feed)

  const ready = new Promise((resolve, reject) => {
    const expected = typeof ipv4 === 'string' && ipv4 !== '' ? ipv4.split('/')[0] : null
    let settled = false
    let probe = null

    const timer = setTimeout(() => {
      fail(Object.assign(new Error('EasyTier 60 秒内没就绪'), {
        code: 'node/network-failed',
        details: output.slice(-2000),
      }))
    }, 60_000)

    const done = (addr) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (probe !== null) clearInterval(probe)
      resolve({ ipv4: addr })
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (probe !== null) clearInterval(probe)
      reject(error)
    }

    child.on('error', (error) => fail(Object.assign(new Error(`起不来 ${core}：${error.message}`), {
      code: 'node/network-failed',
    })))
    child.on('exit', (code_) => {
      if (code_ !== 0) {
        fail(Object.assign(new Error(`EasyTier 退出（${code_}）`), {
          code: 'node/network-failed',
          details: output.slice(-2000),
        }))
      }
    })

    // 以前这里只看日志里有没有 "ipv4 = x.x.x.x"。而 EasyTier 开机会把整份配置
    // 回显一遍（TOML 段里就有这一行），于是网卡根本没建出来也会被当成"已就绪"。
    // 实测就是这么骗过自己的。现在只认两条硬证据：
    //   1. 本机网卡列表里真的出现了这个地址；
    //   2. 出现的是失败日志 —— 立刻报错，别等 60 秒。
    if (noTun) {
      // 零权限模式本来就不建网卡，所以"地址有没有挂在网卡上"这个判据在这里失效。
      // 改看两件事：进程没崩、日志里出现了 listener（说明它真的开始工作了）。
      // 不用等 peer 连上 —— 会合点可能在重试，那不该算启动失败。
      const alive = setInterval(() => {
        if (settled) return
        if (/new listener added/i.test(output)) {
          clearInterval(alive)
          done(expected)
        }
      }, 300)
      alive.unref?.()
      setTimeout(() => { if (!settled) { clearInterval(alive); done(expected) } }, 8_000)
    } else if (expected !== null) {
      probe = setInterval(() => {
        if (hasLocalIp(expected)) done(expected)
      }, 400)
      probe.unref?.()
    } else {
      // DHCP 模式给不出确切地址：退一步等它稳下来。远端只需要能路由到主机，
      // 自己的地址无所谓，所以这里不苛求。
      setTimeout(() => { if (!settled) done(null) }, 4_000)
    }

    // tun device error err=rust tun error Failed to create adapter
    // instance stopped error=...Failed to create adapter
    const fatal = /Failed to create adapter|tun device error|instance stopped/i
    const watch = (text) => {
      if (!fatal.test(text)) return
      const line = String(text).split('\n').find(each => fatal.test(each)) ?? ''
      fail(Object.assign(
        new Error('虚拟网卡建不出来（EasyTier: Failed to create adapter）'),
        { code: 'node/network-failed', details: line.trim().slice(0, 300) },
      ))
    }
    child.stdout?.on('data', (chunk) => watch(chunk.toString('utf8')))
    child.stderr?.on('data', (chunk) => watch(chunk.toString('utf8')))
  })

  return {
    child,
    ready,
    output: () => output,
    stop: () => {
      try { child.kill() } catch {}
    },
  }
}

/**
 * 拼出提权启动的 PowerShell 命令。单独抽出来是为了能测 —— 这里的引号转义错
 * 一个字符，表现就是"点了没反应"，而排查它得真弹一次 UAC 才看得到。
 */
export function buildElevateScript({ core, code, servers = DEFAULT_SERVERS }) {
  const { networkName, networkSecret } = pairCredentials(code)
  const ports = instancePorts(code)
  const args = [
    '-i', hostVirtualIp(code),
    '--network-name', networkName,
    '--network-secret', networkSecret,
    '-m', ports.instanceName,
    '--config-dir', ports.configDir,
    '-l', `tcp://0.0.0.0:${ports.listener}`,
    '-l', `udp://0.0.0.0:${ports.listener}`,
    '--rpc-portal', String(ports.rpc),
    ...servers.flatMap(server => ['-p', server]),
  ]
  // 单引号包一层最省事：这些值都是 hex / dsbot-XXXX / URL，不含单引号。
  // 万一有，按 PowerShell 的规矩写成两个单引号。
  const quote = value => `'${String(value).replace(/'/g, "''")}'`
  return [
    `$p = Start-Process -FilePath ${quote(core)} -ArgumentList @(${args.map(quote).join(',')}) -Verb RunAs -PassThru`,
    'if ($p) { $p.Id }',
  ].join('; ')
}

/**
 * 生成一个「右键以管理员身份运行」的脚本，作为提权失败时的兜底。
 *
 * 为什么需要它：DSH 的 Node 进程不在交互式桌面会话里，`Start-Process -Verb RunAs`
 * 会一直死等一个永远不会出现的 UAC 确认。用户点按钮看到的就是"没反应"。
 * 而这个 .bat 由用户自己在资源管理器里右键运行 —— 那时候有桌面，提权一定成。
 */
export async function writeElevateScript({ core, code, servers = DEFAULT_SERVERS }) {
  const { networkName, networkSecret } = pairCredentials(code)
  const args = [
    '-i', hostVirtualIp(code),
    '--network-name', networkName,
    '--network-secret', networkSecret,
    ...servers.flatMap(server => ['-p', server]),
  ]
  const dir = join(homedir(), '.dsbot-remote')
  await mkdir(dir, { recursive: true }).catch(() => {})
  const file = join(dir, 'start-easytier-as-admin.bat')
  const body = [
    '@echo off',
    'chcp 437 >nul',
    // 内容全走 ASCII：cmd 按系统 ANSI 代码页解析 bat 文件，中文 Windows 是 GBK，
    // 用 UTF-8 写进来的中文会变成乱码（加 BOM 又会让第一行报"不是内部命令"）。
    // 命令行本身（路径 + 参数）本来就没中文，所以功能不受影响，提示交给界面去说。
    `title dsbot cross-network - ${code}`,
    'echo Starting cross-network helper (EasyTier).',
    'echo Keep this window open; closing it stops cross-network.',
    'echo.',
    `"${core}" ${args.map(each => (/\s/.test(each) ? `"${each}"` : each)).join(' ')}`,
    'echo.',
    'echo Exited.',
    'pause',
  ].join('\r\n')
  // bat 必须是 CRLF，否则 cmd 会把行尾的字符当命令的一部分。
  await writeFile(file, body, 'utf8')
  return file
}

/**
 * 用管理员权限起一条 EasyTier。Windows 会弹 UAC，用户点"是"才继续。
 * ---------------------------------------------------------------------------
 * 为什么单独做这一步：建 TUN 网卡要管理员，而 DSH 平时是普通权限启动的。
 * 让用户"以管理员身份重开 DSH"代价太大（正在干的活全断），所以只在需要跨网时
 * 单独把 EasyTier 提起来。它是独立进程，跑在 DSH 外面 —— 提权进程没法被普通权限
 * 的父进程管，所以这里只负责起、不负责停；活着没活着，靠 hasLocalIp 看网卡上
 * 有没有那个地址。
 *
 * @returns {Promise<{ ok: true, pid?: number } | { ok: false, error: string }>}
 */
export async function elevateEasyTier({ core, code, servers = DEFAULT_SERVERS }) {
  const script = buildElevateScript({ core, code, servers })
  const shellName = isWindows ? 'powershell.exe' : 'sh'

  return await new Promise((resolve) => {
    const child = spawn(shellName, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { windowsHide: true })

    let out = ''
    let err = ''
    child.stdout?.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk) => { err += chunk.toString('utf8') })

    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      // 15 秒还没退出就是挂住了：这个进程弹不出权限确认窗口（DSH 的 Node 不在
      // 交互式桌面会话里，UAC 永远等不到）。兜底脚本由调用方准备，这里只报告。
      resolve({ ok: false, error: '这个进程弹不出权限确认窗口' })
    }, 15_000)

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `起不来提权进程：${error.message}` })
    })
    child.on('exit', (code_) => {
      clearTimeout(timer)
      const pid = Number(out.trim())
      if (code_ === 0 && Number.isFinite(pid) && pid > 0) {
        resolve({ ok: true, pid })
        return
      }
      // 用户在 UAC 上点了"否"就是这个：报"操作已被用户取消"。
      const reason = /cancel|取消/i.test(err)
        ? '你在 UAC 窗口点了「否」'
        : (err.trim().split('\n')[0] || `退出码 ${code_}`)
      resolve({ ok: false, error: reason })
    })
  })
}
