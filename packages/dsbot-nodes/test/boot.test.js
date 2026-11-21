// 本文件由 AI 生成，请勿用于生产环境。
// 版本号写在开头的横幅里，一行就够：以前每行都挂，二十行日志二十份噪音。
// 用户贴一段日志过来时，第一眼要看到的是"装的哪一版"。
// 日志放在插件自己的目录（~/.dsh/dsbot-nodes/logs/），不寄生在 ds-bot 的 ~/.dsh/bot/。
process.env.DSBOT_NODES_TEST = '1'
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const entry = new URL('../src/host/nodes/index.js', import.meta.url).href
const logsOf = home => join(home, 'dsbot-nodes', 'logs')

const bootOnce = home => promisify(execFile)(process.execPath, ['-e', `import(${JSON.stringify(entry)}).then(() => {})`], {
  env: { ...process.env, DSH_HOME: home },
  timeout: 20_000,
})

test('启动日志开头写版本与环境，且版本不再逐行重复', async () => {
  // 换个子进程：日志在模块 import 时就写了，本进程里已经写过一轮，分不清是新的。
  const home = await mkdtemp(join(tmpdir(), 'boot-'))
  try {
    await bootOnce(home)
    const log = await readFile(join(logsOf(home), 'current.log'), 'utf8')
    assert.ok(log.includes('=== dsbot-remote v' + version + ' ==='), '日志里没有当前版本 ' + version)
    assert.match(log, /env node=[\d.]+ platform=\w+ arch=\w+ pid=\d+/)
    assert.match(log, /data dir /)
    assert.match(log, /^\S+ log .*current\.log$/m)
    // 只在横幅里出现一次
    assert.equal(log.split('=== dsbot-remote v').length - 1, 1)
    assert.ok(!/ · v\d+\.\d+\.\d+$/m.test(log), '不该每行都追加版本号')
    // 不再往 ds-bot 的家目录里写
    const botDir = await readdir(join(home, 'bot')).catch(() => [])
    assert.deepEqual(botDir, [])
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

// 真跑起来的那次会写 "apply called"。探针进程（只 import、不 apply）没有这一行。
const markReal = async (home) => {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(join(logsOf(home), 'current.log'), 'apply called\n')
}

test('只留这一次和上一次：第三次启动后仍只有两个日志文件', async () => {
  const home = await mkdtemp(join(tmpdir(), 'boot-rotate-'))
  try {
    await bootOnce(home)
    const first = await readFile(join(logsOf(home), 'current.log'), 'utf8')
    await markReal(home)

    await bootOnce(home)
    const second = await readFile(join(logsOf(home), 'current.log'), 'utf8')
    const previous = await readFile(join(logsOf(home), 'previous.log'), 'utf8')
    assert.ok(previous.startsWith(first), '上一次的日志应该被完整保留')
    assert.notEqual(second, first)
    await markReal(home)

    // 目录里躺着的旧名字日志不该被算进"两份"里
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(logsOf(home), 'nodes-boot.log'), 'stale')
    await bootOnce(home)

    const files = (await readdir(logsOf(home))).sort()
    assert.deepEqual(files, ['current.log', 'previous.log'])
    assert.ok((await readFile(join(logsOf(home), 'previous.log'), 'utf8')).startsWith(second))
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('探针进程只 import 不 apply：不把上一次真日志挤成 previous', async () => {
  const home = await mkdtemp(join(tmpdir(), 'boot-probe-'))
  try {
    await bootOnce(home)
    // 造一份"上一次真跑"的日志，再来两个只 import 的探针
    const { writeFileSync, readFileSync } = await import('node:fs')
    writeFileSync(join(logsOf(home), 'current.log'), 'real run\napply called\n')
    await bootOnce(home)
    await bootOnce(home)
    const previous = readFileSync(join(logsOf(home), 'previous.log'), 'utf8')
    assert.ok(previous.includes('apply called'), '真日志应该还在 previous.log 里')
    assert.ok(!readFileSync(join(logsOf(home), 'current.log'), 'utf8').includes('apply called'))
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})
