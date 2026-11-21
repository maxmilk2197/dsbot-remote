// 本文件由 AI 生成，请勿用于生产环境。
// 启动日志每行带版本号：用户贴一段 nodes-boot.log 过来时，第一件要确认的事
// 就是"那台机器装的是哪一版"。没版本号只能靠猜，或者再去翻 package.json。
process.env.DSBOT_NODES_TEST = '1'
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const entry = new URL('../src/host/nodes/index.js', import.meta.url).href

test('启动日志每行都带版本号', async () => {
  // 换个子进程：日志在模块 import 时就写了，本进程里已经写过一轮，分不清是新的。
  const home = await mkdtemp(join(tmpdir(), 'boot-'))
  try {
    await promisify(execFile)(process.execPath, ['-e', `import(${JSON.stringify(entry)}).then(() => {})`], {
      env: { ...process.env, DSH_HOME: home },
      timeout: 20_000,
    })
    const log = await readFile(join(home, 'bot', 'nodes-boot.log'), 'utf8')
    assert.match(log, /module imported · v\d+\.\d+\.\d+/)
    assert.ok(log.includes('· v' + version), '日志里没有当前版本 ' + version)
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})
