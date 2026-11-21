// 本文件由 AI 生成，请勿用于生产环境。
// ds-bot 自补：把 ctx.provide('bot', rt) 这一行自动打回 ds-bot。
//
// 为什么必须自动：这条补丁是外部插件拿到运行时的唯一入口，而 ds-bot 升级
// （DS Bot 设置页点【更新】、pnpm update）会把 node_modules 换回原版，补丁消失。
// 让用户每台机器手工改文件，等于每升级一次就坏一次。
//
// 做法：找到真正装着 createRuntime 的那个 .js（0.3.8 是 index.js；plugin.js 只是
// 一层 import 壳），文件里已有 provide('bot') 就不动；没有就插在锚点行之后，
// 先备份成 *.bak-dsbot-provide。改的是下次启动读到的源码 —— 本次启动如果
// ds-bot 已经 import 过，就要重启 DSH 才生效，日志会写清楚这一点。
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'

export const ANCHOR = "void rt.adoptLiveWork?.().catch(error => rt.warn?.('ds-bot: adopting the work still running failed: %s', error))"
const INSERT = "\n    ctx.provide('bot', rt)"
const MARKER = /provide\(\s*['"]bot['"]/

const skipped = () => process.env.DSBOT_NODES_SELFPATCH === '0' || process.env.DSBOT_NODES_TEST === '1'

export function dsbotPackageDir(dir) {
  if (typeof dir === 'string' && dir !== '') return dir
  const req = createRequire(import.meta.url)
  try { return dirname(req.resolve('ds-bot/package.json')) } catch {}
  try { return dirname(req.resolve('ds-bot')) } catch {}
  // 从 pnpm 的 .pnpm 沙盒里往上走，有时只到得了 profile 的 node_modules 而解析不到
  // 包（没装成依赖、用的是 file:/link: 装法）。退一步：直接去 profile 目录里找。
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  let profiles = []
  try { profiles = readdirSync(join(dshHome, 'profiles')) } catch { return undefined }
  for (const name of profiles) {
    const candidate = join(dshHome, 'profiles', name, 'node_modules', 'ds-bot')
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

// 包根下的 .js 才有 createRuntime；client.js 那种几 MB 的浏览器包不读。
function candidates(pkgDir) {
  const found = []
  let names = []
  try { names = readdirSync(pkgDir) } catch { return found }
  for (const name of names) {
    if (!name.endsWith('.js')) continue
    const file = join(pkgDir, name)
    try {
      if (!statSync(file).isFile() || statSync(file).size > 400 * 1024) continue
      const source = readFileSync(file, 'utf8')
      if (!source.includes('adoptLiveWork')) continue
      found.push({ file, source })
    } catch {}
  }
  return found
}

// 给日志用：报告**真正装着 createRuntime 的那份文件**有没有补丁。
// 只看入口会误报 —— 0.3.8 的入口 plugin.js 只有 744 字节，是一层 import 壳，
// 锚点和 provide 都在同目录的 index.js 里。
export function inspectDsbot({ dir } = {}) {
  const pkgDir = dsbotPackageDir(dir)
  if (pkgDir === undefined) return { dir: '', version: 'unknown', file: '', patched: false, text: 'ds-bot 解析不到' }
  let version = 'unknown'
  let main = ''
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    version = manifest.version ?? version
    main = typeof manifest.main === 'string' ? basename(manifest.main) : ''
  } catch {}
  const files = candidates(pkgDir)
  const impl = files.find(each => MARKER.test(each.source)) ?? files.find(each => each.source.includes(ANCHOR)) ?? files[0]
  const patched = files.some(each => MARKER.test(each.source))
  const name = impl === undefined ? '' : basename(impl.file)
  const where = impl === undefined
    ? `（${pkgDir} 下没找到含 createRuntime 的 .js）`
    : `（实现在 ${name}${main !== '' && main !== name ? `，入口 ${main}` : ''}）`
  return {
    dir: pkgDir,
    version,
    file: impl?.file ?? '',
    patched,
    text: `ds-bot v${version} ${patched ? "有 ctx.provide('bot', rt)" : "缺 ctx.provide('bot', rt)"}${where}`,
  }
}

export function ensureDsbotProvide({ dir } = {}) {
  if (skipped()) return { status: 'skipped', file: '', text: 'ds-bot 自补：跳过（测试或显式关闭）' }
  const pkgDir = dsbotPackageDir(dir)
  if (pkgDir === undefined) {
    return { status: 'missing', file: '', text: 'ds-bot 自补：找不到 ds-bot 包（插件不是装在 profile 的 node_modules 里？）' }
  }
  let version = 'unknown'
  try { version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version ?? version } catch {}
  const files = candidates(pkgDir)
  if (files.length === 0) {
    return { status: 'missing', file: pkgDir, text: `ds-bot v${version} 自补：包根下没找到含 createRuntime 的 .js（${pkgDir}）` }
  }
  const done = files.find(each => MARKER.test(each.source))
  if (done !== undefined) {
    return { status: 'ok', file: done.file, text: `ds-bot v${version} 自补：已在位（${basename(done.file)}）` }
  }
  const target = files.find(each => each.source.includes(ANCHOR))
  if (target === undefined) {
    return { status: 'unmatched', file: files[0].file, text: `ds-bot v${version} 自补：找到 ${files.map(each => basename(each.file)).join(' / ')}，但里面没有锚点行（版本改了写法）` }
  }
  try {
    const backup = target.file + '.bak-dsbot-provide'
    if (!existsSync(backup)) copyFileSync(target.file, backup)
    writeFileSync(target.file, target.source.replace(ANCHOR, ANCHOR + INSERT))
    return { status: 'patched', file: target.file, text: `ds-bot v${version} 自补：已写上 ctx.provide('bot', rt) → ${target.file}（重启 DSH 生效）` }
  } catch (error) {
    return { status: 'error', file: target.file, text: `ds-bot v${version} 自补失败（${error?.message ?? error}）：手动在 ${target.file} 的锚点行后加 ctx.provide('bot', rt)` }
  }
}
