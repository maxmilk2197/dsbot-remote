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
import { access, constants, mkdir, readdir, writeFile } from 'node:fs/promises'
import { homedir, networkInterfaces } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

export const EASYTIER_DIR = join(homedir(), '.dsbot-remote', 'easytier')
/** 随包分发的 EasyTier（内置，用户不用另装）。目录按平台分：vendor/easytier/win32-x64/ */
const VENDOR_PLATFORM = `${process.platform}-${process.arch}`
// 内置 EasyTier 应该跟着主包走：<dsbot-nodes>/vendor/easytier/<平台-架构>/
export const VENDORED_DIR = join(
  import.meta.dirname, '..', '..', 'vendor', 'easytier', VENDOR_PLATFORM,
)
// 老布局：二进制早先是放在 dsbot-remote 包里的（体积大，不进 git，本地放）。
// 两种都认，免得用户按旧说明摆好了却被告知"没找到 EasyTier"。
const LEGACY_VENDORED_DIR = join(
  import.meta.dirname, '..', '..', '..', 'dsbot-remote', 'vendor', 'easytier', VENDOR_PLATFORM,
)
// 跨网必须有个"会合点"：两端不在同一张局域网时，得先在一个公共节点上互相发现。
// 不填 -p 的话 EasyTier 谁都不连，两台机器各自建好网卡却永远看不见对方。
//
// 官方那个 public.easytier.cn 已经在 2026 年 2 月停服（域名现在是 NXDOMAIN），
// 网上大量教程还写着它 —— 照抄就是连不上。这里用社区仍在跑的共享节点，并且
// 一律写 IP 不写域名：域名会被本地代理的 fake-ip 解析成 198.18.x，看着"连上了"
// 其实根本没出本机。
export const DEFAULT_SERVERS = [
  'tcp://39.108.52.138:11010',
  'tcp://8.148.29.206:11010',
]
export const VIRTUAL_CIDR = '10.126.126.0/24'
// 主机在这个网里占的固定地址。远端走 DHCP 随便拿一个，但连的永远是 .1 ——
// 否则远端根本不知道该往哪打（虚拟网里没有 UDP 广播，找不到主机）。
export const HOST_VIRTUAL_IP = '10.126.126.1/24'

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

const isWindows = process.platform === 'win32'
const CORE_BIN = isWindows ? 'easytier-core.exe' : 'easytier-core'
const CLI_BIN = isWindows ? 'easytier-cli.exe' : 'easytier-cli'

async function executable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 在常见位置找 EasyTier。找不到返回 undefined（调用方负责提示用户）。 */
export async function findEasyTier(extraDirs = []) {
  const dirs = [
    VENDORED_DIR,
    LEGACY_VENDORED_DIR,
    ...extraDirs,
    EASYTIER_DIR,
    join(homedir(), 'easytier'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'easytier') : undefined,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'easytier') : undefined,
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean),
  ].filter(Boolean)

  for (const dir of dirs) {
    const core = join(dir, CORE_BIN)
    if (await executable(core)) {
      const cli = join(dir, CLI_BIN)
      return { core, cli: (await executable(cli)) ? cli : undefined, dir }
    }
  }
  return undefined
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
}) {
  const { networkName, networkSecret } = pairCredentials(code)
  const args = [
    // -i 和 -d 是二选一：给了固定地址就别再要 DHCP，两边同时给会打架。
    ...(typeof ipv4 === 'string' && ipv4 !== '' ? ['-i', ipv4] : ['-d']),
    '--network-name', networkName,
    '--network-secret', networkSecret,
    ...(typeof hostname === 'string' && hostname !== '' ? ['--hostname', hostname] : []),
    ...(servers.length ? servers.flatMap((server) => ['-p', server]) : []),
    ...extraArgs,
  ]

  // cwd 必须跟着二进制走：EasyTier 要在自己旁边找 wintun.dll 建虚拟网卡。
  // 从别的目录拉起来它会报 Failed to create adapter —— 看着像没权限，其实是找不到 DLL。
  const child = spawn(core, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    cwd: dirname(core),
  })

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
    if (expected !== null) {
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
  const args = [
    '-i', HOST_VIRTUAL_IP,
    '--network-name', networkName,
    '--network-secret', networkSecret,
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
    '-i', HOST_VIRTUAL_IP,
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
