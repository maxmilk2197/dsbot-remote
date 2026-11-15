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
import { access, constants, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export const EASYTIER_DIR = join(homedir(), '.dsbot-remote', 'easytier')
/** 随包分发的 EasyTier（内置，用户不用另装）。目录按平台分：vendor/easytier/win32-x64/ */
export const VENDORED_DIR = join(
  import.meta.dirname, '..', 'vendor', 'easytier', `${process.platform}-${process.arch}`,
)
export const DEFAULT_SERVERS = []
export const VIRTUAL_CIDR = '10.126.126.0/24'

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
}) {
  const { networkName, networkSecret } = pairCredentials(code)
  const args = [
    '-d',
    '--network-name', networkName,
    '--network-secret', networkSecret,
    ...(servers.length ? servers.flatMap((server) => ['-p', server]) : []),
    ...extraArgs,
  ]

  const child = spawn(core, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

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
    const timer = setTimeout(() => {
      reject(Object.assign(new Error('EasyTier 60 秒内没起来（多半是没给管理员权限，TUN 建不出来）'), {
        code: 'node/network-failed',
        details: output.slice(-2000),
      }))
    }, 60_000)

    let settled = false
    const done = (ipv4) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ipv4 })
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
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

    const scan = (text) => {
      const match = text.match(/ipv4[^\d]{0,8}(\d+\.\d+\.\d+\.\d+)/i) ?? text.match(/(10\.126\.\d+\.\d+)/)
      if (match) done(match[1])
    }
    child.stdout?.on('data', (chunk) => scan(chunk.toString('utf8')))
    child.stderr?.on('data', (chunk) => scan(chunk.toString('utf8')))
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
