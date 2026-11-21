// 本文件由 AI 生成，请勿用于生产环境。
/**
 * EasyTier 按需下载
 * ============================================================================
 * 仓库不再内置 33MB 的二进制：第一次真正要跨网时，按当前平台从官方 Release
 * 下载一次，缓存在 ~/.dsh/dsbot-nodes/easytier/<版本>/<平台-架构>/，之后直接复用。
 *
 * 三个可调的环境变量（都不需要改代码）：
 *   DSBOT_EASYTIER_DIR     已经手动装好的目录，优先用它，不下载
 *   DSBOT_EASYTIER_MIRROR  镜像前缀，例如 https://ghfast.top/（拼在 GitHub 地址前）
 *   DSBOT_EASYTIER_URL     直接给一个 zip 地址，跳过拼装
 *   DSBOT_EASYTIER_VERSION 换版本，默认下面的 EASYTIER_VERSION
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, createWriteStream, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dataHome } from '../shared/paths.js'
import { join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const EASYTIER_VERSION = process.env.DSBOT_EASYTIER_VERSION || 'v2.6.4'

const RELEASE_BASE = 'https://github.com/EasyTier/EasyTier/releases/download'

// 官方 Release 的资源名不是 Node 的 platform-arch：这里做一次映射。
const SLUGS = {
  'win32-x64': 'windows-x86_64',
  'win32-arm64': 'windows-arm64',
  'win32-ia32': 'windows-i686',
  'darwin-x64': 'macos-x86_64',
  'darwin-arm64': 'macos-aarch64',
  'linux-x64': 'linux-x86_64',
  'linux-arm64': 'linux-aarch64',
  'linux-arm': 'linux-arm',
  'linux-ia32': 'linux-x86',
}

export const isWindows = process.platform === 'win32'
export const coreName = (platform = process.platform) =>
  platform === 'win32' ? 'easytier-core.exe' : 'easytier-core'
export const cliName = (platform = process.platform) =>
  platform === 'win32' ? 'easytier-cli.exe' : 'easytier-cli'

export function platformSlug(platform = process.platform, arch = process.arch) {
  return SLUGS[`${platform}-${arch}`]
}

export function easyTierAssetName(version = EASYTIER_VERSION, platform = process.platform, arch = process.arch) {
  const slug = platformSlug(platform, arch)
  return slug === undefined ? undefined : `easytier-${slug}-${version}.zip`
}

export function easyTierAssetUrl(version = EASYTIER_VERSION, platform = process.platform, arch = process.arch) {
  const direct = String(process.env.DSBOT_EASYTIER_URL ?? '').trim()
  if (direct !== '') return direct
  const name = easyTierAssetName(version, platform, arch)
  if (name === undefined) return undefined
  const full = `${RELEASE_BASE}/${version}/${name}`
  const mirror = String(process.env.DSBOT_EASYTIER_MIRROR ?? '').trim()
  return mirror === '' ? full : `${mirror.replace(/\/+$/, '')}/${full}`
}

/** 缓存根目录：跟 DSH 的其它数据放一起，卸载插件也不会误删。 */
// 这段代码最终要执行一个从网上下来的二进制，所以两件事必须记账：
//   1. 只认 https（DSBOT_EASYTIER_ALLOW_HTTP=1 才放开，给离线内网留口子）；
//   2. 下载后把包和 core 的 sha256 写下来，下次复用缓存前先验一遍 ——
//      缓存里被换掉的 core 等于一份别人塞进来的可执行文件。
const SHA_FILE = 'sha256.json'

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readManifest(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, SHA_FILE), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function writeManifest(dir, entry) {
  try {
    writeFileSync(join(dir, SHA_FILE), JSON.stringify(entry, null, 2))
  } catch {}
}

export function easyTierCacheRoot() {
  return join(dataHome(), 'easytier')
}

export function easyTierCacheDir(version = EASYTIER_VERSION, platform = process.platform, arch = process.arch) {
  return join(easyTierCacheRoot(), version, `${platform}-${arch}`)
}

// 有些环境把 rmSync 接管成"移到回收站"，失败时会抛错。清理是收尾动作，
// 不该因为它把已经成功的下载判成失败。
function quietRemove(path, options = {}) {
  try { rmSync(path, { force: true, ...options }) } catch {}
}

function isFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

/**
 * 在目录（以及它的一层子目录）里找可执行文件。
 * 官方 zip 有时直接铺在根上，有时会多套一层版本目录，两种都认。
 */
export function findEasyTierBinaries(dir, platform = process.platform, { deep = true } = {}) {
  if (typeof dir !== 'string' || dir === '') return undefined
  const core = coreName(platform)
  const cli = cliName(platform)
  const probe = (candidate) => {
    const corePath = join(candidate, core)
    if (!isFile(corePath)) return undefined
    const cliPath = join(candidate, cli)
    return { core: corePath, cli: isFile(cliPath) ? cliPath : undefined, dir: candidate }
  }
  const direct = probe(dir)
  if (direct !== undefined) return direct
  if (!deep) return undefined
  try {
    for (const entry of readdirSync(dir)) {
      const sub = join(dir, entry)
      try { if (!statSync(sub).isDirectory()) continue } catch { continue }
      const found = probe(sub)
      if (found !== undefined) return found
    }
  } catch {}
  return undefined
}

// 系统代理：Node 的 fetch 不会自动读 Clash/系统设置，下载走 curl 更省事。
// 顺序是显式变量 → 标准环境变量 → Windows 注册表 → 常见本地端口。
function proxyCandidates() {
  const list = []
  const push = (value) => {
    const raw = String(value ?? '').trim()
    if (raw === '') return
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
    if (!list.includes(url)) list.push(url)
  }
  push(process.env.DSBOT_EASYTIER_PROXY)
  push(process.env.HTTPS_PROXY || process.env.https_proxy)
  push(process.env.HTTP_PROXY || process.env.http_proxy)
  push(process.env.ALL_PROXY || process.env.all_proxy)
  // Clash Verge / Clash / v2ray 的默认混合口
  for (const port of [7897, 7890, 10809]) push(`http://127.0.0.1:${port}`)
  return list
}

function hasCurl() {
  return new Promise((resolve) => {
    const child = spawn('curl', ['--version'], { windowsHide: true })
    child.on('error', () => resolve(false))
    child.on('exit', code => resolve(code === 0))
  })
}

function downloadWithCurl(url, zip, proxy, onLog) {
  return new Promise((resolve) => {
    const args = [
      '-L', '--fail', '--silent', '--show-error',
      '--connect-timeout', '15', '--max-time', '240',
      // 速度掉到 20KB/s 以下持续 30 秒就换下一条路，别干等
      '--speed-limit', '20480', '--speed-time', '30',
      '-o', zip, url,
    ]
    if (proxy !== undefined) args.unshift('--proxy', proxy)

    let stderr = ''
    let lastLogged = 0
    const child = spawn('curl', args, { windowsHide: true })
    const timer = setInterval(() => {
      try {
        const size = statSync(zip).size
        if (size - lastLogged >= 4 * 1024 * 1024) {
          lastLogged = size
          onLog(`已下载 ${(size / 1048576).toFixed(1)} MB`)
        }
      } catch {}
    }, 700)
    timer.unref?.()
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => { clearInterval(timer); resolve({ ok: false, error: error.message }) })
    child.on('exit', (code) => {
      clearInterval(timer)
      resolve({
        ok: code === 0,
        error: code === 0 ? undefined : (stderr.trim().split('\n').pop() || `curl 退出码 ${code}`),
      })
    })
  })
}

function run(command, args) {
  return new Promise((resolve) => {
    let stderr = ''
    const child = spawn(command, args, { windowsHide: true })
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', chunk => { stderr += chunk.toString('utf8') })
    child.on('error', error => resolve({ ok: false, error: error.message }))
    child.on('exit', code => resolve({
      ok: code === 0,
      error: code === 0 ? undefined : (stderr.trim().split('\n').pop() || `退出码 ${code}`),
    }))
  })
}

// Windows 10 自带 bsdtar，能直接解 zip；老系统退回 PowerShell。
async function extract(zip, dest) {
  if (isWindows) {
    const tar = await run('tar', ['-xf', zip, '-C', dest])
    if (tar.ok) return
    const quote = value => `'${String(value).replace(/'/g, "''")}'`
    const ps = await run('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(dest)} -Force`,
    ])
    if (ps.ok) return
    throw new Error(`解压失败：${tar.error ?? ps.error}`)
  }
  const unzip = await run('unzip', ['-q', '-o', zip, '-d', dest])
  if (unzip.ok) return
  const tar = await run('tar', ['-xf', zip, '-C', dest])
  if (tar.ok) return
  throw new Error(`解压失败：${unzip.error ?? tar.error}`)
}

async function download({ version, onLog, force }) {
  const dir = easyTierCacheDir(version)
  if (!force) {
    const cached = findEasyTierBinaries(dir)
    if (cached !== undefined) {
      const manifest = readManifest(dir)
      if (manifest === undefined || typeof manifest.core !== 'string') {
        return { ...cached, source: 'cache', version }
      }
      let actual = ''
      try { actual = sha256File(cached.core) } catch { actual = '' }
      if (actual === manifest.core) return { ...cached, source: 'cache', version }
      onLog('缓存里的 EasyTier 和记账的哈希对不上，当作不可信，重新下一份')
      quietRemove(dir, { recursive: true })
    }
  }

  const url = easyTierAssetUrl(version)
  if (url === undefined) {
    throw new Error(`EasyTier 没有 ${process.platform}-${process.arch} 的官方包，请手动安装并设置 DSBOT_EASYTIER_DIR`)
  }

  let parsedUrl
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new Error('EasyTier 的下载地址不是一个 URL：' + url)
  }
  if (parsedUrl.protocol !== 'https:' && process.env.DSBOT_EASYTIER_ALLOW_HTTP !== '1') {
    throw new Error('拒绝从非 https 地址下载 EasyTier（' + parsedUrl.protocol + '）：' + url)
  }

  mkdirSync(dir, { recursive: true })
  // 两个进程可能同时第一次跨网（热重载 + 用户手动重启）。各下各的、
  // 各解各的，最后只把文件落到同一个缓存目录，谁也写不坏谁。
  const stamp = `${process.pid}-${Date.now()}`
  const zip = join(dir, `.download-${stamp}.zip`)
  const stage = join(dir, `.stage-${stamp}`)
  onLog(`没找到 EasyTier，开始下载 ${version}（约 30MB，只下一次）`)

  // curl 能自动走系统代理；没有 curl 的机器退回 fetch（不认系统代理，但能直连）。
  let lastError
  if (await hasCurl()) {
    const routes = [undefined, ...proxyCandidates()]
    for (const proxy of routes) {
      quietRemove(zip)
      onLog(proxy === undefined ? '开始下载（直连）' : `开始下载（代理 ${proxy}）`)
      const result = await downloadWithCurl(url, zip, proxy, onLog)
      if (result.ok) { lastError = undefined; break }
      lastError = result.error
      onLog(`这条不通：${result.error}`)
    }
    if (lastError !== undefined) {
      quietRemove(zip)
      throw new Error(
        `下载失败（直连和代理都试过了）：${lastError}。`
        + `可以设置 DSBOT_EASYTIER_MIRROR 走镜像，或手动解压到 ${dir}`,
      )
    }
  } else {
    let response
    try {
      response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) })
    } catch (error) {
      throw new Error(`下载失败（${error?.message ?? error}）。可以手动解压到 ${dir}`)
    }
    if (!response.ok || response.body === null) {
      throw new Error(`下载失败：HTTP ${response.status} ${response.statusText ?? ''}`.trim())
    }
    const body = Readable.fromWeb(response.body)
    let received = 0
    let lastLogged = 0
    body.on('data', (chunk) => {
      received += chunk.length
      if (received - lastLogged >= 4 * 1024 * 1024) {
        lastLogged = received
        onLog(`已下载 ${(received / 1048576).toFixed(1)} MB`)
      }
    })
    try {
      await pipeline(body, createWriteStream(zip))
    } catch (error) {
      quietRemove(zip)
      throw new Error(`下载中断：${error?.message ?? error}`)
    }
  }

  // 包本身也记一笔：设了 DSBOT_EASYTIER_SHA256 就当成硬约束比对，
  // 没设就只记录，至少事后能查出"哪一次换的包"。
  const zipSha256 = sha256File(zip)
  const pinned = String(process.env.DSBOT_EASYTIER_SHA256 ?? '').trim().toLowerCase()
  if (pinned !== '' && pinned !== zipSha256) {
    quietRemove(zip)
    throw new Error('EasyTier 包的 sha256 和 DSBOT_EASYTIER_SHA256 不一致：' + zipSha256)
  }

  onLog('下载完成，正在解压')
  try {
    mkdirSync(stage, { recursive: true })
    await extract(zip, stage)
  } catch (error) {
    quietRemove(zip)
    quietRemove(stage, { recursive: true })
    throw new Error(`解压失败：${error?.message ?? error}`)
  }
  quietRemove(zip)

  const staged = findEasyTierBinaries(stage)
  // zip-slip：解压出来的 core 必须还在 stage 里面，不然下一步的 cpSync
  // 会把写到外面的东西搬进缓存目录。
  const stageRoot = resolve(stage)
  if (staged !== undefined) {
    const target = resolve(staged.core)
    if (target !== stageRoot && !target.startsWith(stageRoot + sep)) {
      quietRemove(stage, { recursive: true })
      throw new Error('解压出来的路径跑到了临时目录外面：' + target)
    }
  }
  if (staged === undefined) {
    quietRemove(stage, { recursive: true })
    throw new Error(`解压后没找到 ${coreName()}，目录：${stage}`)
  }
  // 整个目录一起搬：wintun.dll / Packet.dll 这些也得跟着走。
  try {
    for (const entry of readdirSync(staged.dir)) {
      cpSync(join(staged.dir, entry), join(dir, entry), { recursive: true, force: true })
    }
  } finally {
    quietRemove(stage, { recursive: true })
  }

  const found = findEasyTierBinaries(dir)
  if (found === undefined) {
    throw new Error(`解压后没找到 ${coreName()}，目录：${dir}`)
  }
  if (!isWindows) {
    try {
      chmodSync(found.core, 0o755)
      if (found.cli !== undefined) chmodSync(found.cli, 0o755)
    } catch {}
  }
  writeManifest(dir, {
    version,
    asset: easyTierAssetName(version),
    url,
    zipSha256,
    core: sha256File(found.core),
    at: new Date().toISOString(),
  })
  onLog('EasyTier 就绪：' + found.core)
  return { ...found, source: 'download', version }
}

let pending = null

/** 确保本地有一份可用的 EasyTier；并发调用共用同一次下载。 */
export function ensureEasyTier({ version = EASYTIER_VERSION, onLog = () => {}, force = false } = {}) {
  if (pending !== null && pending.version === version) return pending.promise
  const promise = download({ version, onLog, force })
    .finally(() => { if (pending !== null && pending.promise === promise) pending = null })
  pending = { version, promise }
  return promise
}
