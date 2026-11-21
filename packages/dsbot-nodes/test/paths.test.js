// 本文件由 AI 生成，请勿用于生产环境。
// 插件有自己的文件夹：记录、开关、日志、EasyTier 缓存都在 ~/.dsh/dsbot-nodes/。
// 老版本把它们放在 ds-bot 的 ~/.dsh/bot/ 里，第一次启动要搬过来 —— 搬丢一条
// 记录，那台机器就得重新配对。
process.env.DSBOT_NODES_TEST = '1'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('数据目录在 dsbot-nodes 下，不在 bot 下', async () => {
  const home = await mkdtemp(join(tmpdir(), 'paths-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { dataHome, logsDir, logFile, easyTierHome } = await import('../src/shared/paths.js')
    assert.equal(dataHome(), join(home, 'dsbot-nodes'))
    assert.equal(logsDir(), join(home, 'dsbot-nodes', 'logs'))
    assert.equal(logFile(), join(home, 'dsbot-nodes', 'logs', 'current.log'))
    assert.equal(easyTierHome(), join(home, 'dsbot-nodes', 'easytier'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('老目录里的记录、开关、日志都会搬过来', async () => {
  const home = await mkdtemp(join(tmpdir(), 'paths-migrate-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const bot = join(home, 'bot')
    await mkdir(bot, { recursive: true })
    await writeFile(join(bot, 'nodes.json'), '{"version":1,"nodes":{}}')
    await writeFile(join(bot, 'nodes-off'), '')
    await writeFile(join(bot, 'nodes-boot.log'), 'old run line\n')

    const { dataHome, previousLogFile, migrateLegacyData } = await import('../src/shared/paths.js')
    const lines = []
    migrateLegacyData(line => lines.push(line))

    assert.equal(await readFile(join(dataHome(), 'nodes.json'), 'utf8'), '{"version":1,"nodes":{}}')
    assert.equal(await readFile(join(dataHome(), 'nodes-off'), 'utf8'), '')
    assert.equal(await readFile(previousLogFile(), 'utf8'), 'old run line\n')
    // 原件搬走，不留两份各写各的
    const left = await readdir(bot)
    assert.deepEqual(left, [])
    assert.ok(lines.some(line => line.includes('nodes.json')))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})
