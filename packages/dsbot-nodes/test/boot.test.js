// 本文件由 AI 生成，请勿用于生产环境。
// 启动日志每行带版本号：用户贴一段日志过来时，第一件要确认的事就是"那台机器装的是
// 哪一版"。没版本号只能靠猜，或者再去翻 package.json。
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

test('启动日志每行都带版本号，并写清运行环境', async () => {
  // 换个子进程：日志在模块 import 时就写了，本进程里已经写过一轮，分不清是新的。
  const home = await mkdtemp(join(tmpdir(), 'boot-'))
  try {
    await bootOnce(home)
    const log = await readFile(join(logsOf(home), 'current.log'), 'utf8')
    assert.match(log, /module imported · v\d+\.\d+\.\d+/)
    assert.ok(log.includes('· v' + version), '日志里没有当前版本 ' + version)
    assert.match(log, /env node=\d+/)
    assert.match(log, /data dir /)
    // 不再往 ds-bot 的家目录里写
    const botDir = await readdir(join(home, 'bot')).catch(() => [])
    assert.deepEqual(botDir, [])
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('只留这一次和上一次：第三次启动后仍只有两个日志文件', async () => {
  const home = await mkdtemp(join(tmpdir(), 'boot-rotate-'))
  try {
    await bootOnce(home)
    const first = await readFile(join(logsOf(home), 'current.log'), 'utf8')

    await bootOnce(home)
    const second = await readFile(join(logsOf(home), 'current.log'), 'utf8')
    const previous = await readFile(join(logsOf(home), 'previous.log'), 'utf8')
    assert.equal(previous, first, '上一次的日志应该被完整保留')
    assert.notEqual(second, first)

    // 目录里躺着的旧名字日志不该被算进"两份"里
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(logsOf(home), 'nodes-boot.log'), 'stale')
    await bootOnce(home)

    const files = (await readdir(logsOf(home))).sort()
    assert.deepEqual(files, ['current.log', 'previous.log'])
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})
