// 本文件由 AI 生成，请勿用于生产环境。
// 插件自己的数据目录。
//
// 以前这些文件散在 ~/.dsh/bot/ 里 —— 那是 ds-bot 的家。升级 ds-bot、清宿主缓存、
// 维护 profile 时，别人家的清理动作会顺手把配对记录和日志带走；配对记录一丢，
// 每台机器都要重新配对。所以给插件自己一个文件夹：
//
//   ~/.dsh/dsbot-nodes/
//     nodes.json            节点与配对记录
//     nodes-off             紧急开关
//     logs/current.log      这一次运行的日志
//     logs/previous.log     上一次运行的日志（只留两份，更早的自动删）
//     easytier/             EasyTier 的下载缓存
//
// DSBOT_NODES_HOME 可以整体搬走（测试和绿色版用）。
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, renameSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const LOG_KEY = Symbol.for('dsbot-nodes.log/v1')

export function dataHome() {
  const explicit = String(process.env.DSBOT_NODES_HOME ?? '').trim()
  if (explicit !== '') return resolve(explicit)
  return join(process.env.DSH_HOME ? process.env.DSH_HOME : join(homedir(), '.dsh'), 'dsbot-nodes')
}

export const logsDir = () => join(dataHome(), 'logs')
export const logFile = () => join(logsDir(), 'current.log')
export const previousLogFile = () => join(logsDir(), 'previous.log')
export const easyTierHome = () => join(dataHome(), 'easytier')

// 老位置。只在搬家时读它，平时一个字节都不碰。
function legacyBotHome() {
  return process.env.DSH_HOME ? join(process.env.DSH_HOME, 'bot') : join(homedir(), '.dsh', 'bot')
}

// current.log 开头的 pid：谁在写这份日志。
function bannerPid() {
  try {
    const head = readFileSync(logFile(), 'utf8').slice(0, 500)
    const hit = /\bpid=(\d+)/.exec(head)
    return hit === null ? null : Number(hit[1])
  } catch {
    return null
  }
}

const pidAlive = pid => {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

// 每个进程只轮转一次：第一次写日志时把 current.log 挪成 previous.log，
// 然后开一份新的 current.log。全程只有两个文件，不需要按大小切、也不留历史。
//
// 但"每个进程轮一次"不够：DSH 启动时还有几个短命进程会 import 插件（读清单、
// 探 bundle），它们各自轮一遍，就把真正那次启动的日志（含 deps ready / 路由
// 挂载）挤成 previous.log，然后再被下一个探针挤掉。所以先看 current.log 里
// 那个 pid 还活着没有：活着就不是"上一次运行"，接着往后写。
export function rotateLogsOnce({ force = false } = {}) {
  const state = globalThis[LOG_KEY] ?? (globalThis[LOG_KEY] = { rotated: false })
  if (state.rotated && !force) return
  state.rotated = true
  try {
    const owner = existsSync(logFile()) ? bannerPid() : null
    if (!force && owner !== null && owner !== process.pid && pidAlive(owner)) return
  } catch {}
  try {
    mkdirSync(logsDir(), { recursive: true })
    // 探针进程（DSH 启动时 import 一遍插件就退出）只写横幅和 module 行，从来没走到
    // apply。它们每次启动都轮转一次，会把真正的上一次运行挤成 previous 再挤掉。
    // 判据很简单：这份 current.log 里没有 "apply called" 就不是一次真启动，直接丢弃。
    if (existsSync(logFile()) && readFileSync(logFile(), 'utf8').includes('apply called')) {
      rmSync(previousLogFile(), { force: true })
      renameSync(logFile(), previousLogFile())
    }
    writeFileSync(logFile(), '')
    // 目录里如果还有旧名字的日志（手工拷进来的、老版本留下的），一并清掉，
    // 免得"只留两份"被绕过。
    for (const name of readdirSync(logsDir())) {
      if (name === 'current.log' || name === 'previous.log') continue
      if (/^nodes-boot.*\.log$/i.test(name)) rmSync(join(logsDir(), name), { force: true })
    }
  } catch {}
}

export function appendLog(line) {
  rotateLogsOnce()
  try {
    // 目录可能不在：轮转只跑一次，但 DSBOT_NODES_HOME 换了之后仍可能写新路径。
    mkdirSync(logsDir(), { recursive: true })
    appendFileSync(logFile(), line.endsWith('\n') ? line : line + '\n')
  } catch {}
}

// 从 ~/.dsh/bot 搬到新目录。先 copy 成功再删原件：搬丢一条记录就得重新配对。
export function migrateLegacyData(note = () => {}) {
  const from = legacyBotHome()
  if (resolve(from) === resolve(dataHome())) return []
  const moved = []
  const move = (source, target, label) => {
    try {
      if (!existsSync(source) || existsSync(target)) return
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(source, target)
      rmSync(source, { force: true })
      moved.push(label)
      note(`migrated ${label}: ${source} → ${target}`)
    } catch (error) {
      note(`migrate ${label} 失败: ${error?.message ?? error}`)
    }
  }
  move(join(from, 'nodes.json'), join(dataHome(), 'nodes.json'), 'nodes.json')
  move(join(from, 'nodes-off'), join(dataHome(), 'nodes-off'), 'nodes-off')
  // 上一份日志搬成"上一次"，第一次启动就能和旧版本对照。
  move(join(from, 'nodes-boot.log'), previousLogFile(), 'nodes-boot.log')
  return moved
}
