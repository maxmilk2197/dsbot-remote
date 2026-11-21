// 本文件由 AI 生成，请勿用于生产环境。
// 日志只留两份，但"每个进程轮转一次"会把真启动的日志挤掉：DSH 启动时还有几个
// 短命进程会 import 插件（读清单、探 bundle），它们各轮一遍就让 current.log
// 变成上一个探针的输出。判据是"current.log 里那个 pid 还活着吗"。
process.env.DSBOT_NODES_TEST = '1'
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pathsUrl = new URL('../src/shared/paths.js', import.meta.url).href

test('写日志的那个进程还活着：不轮转，接着往后写', async () => {
  const home = await mkdtemp(join(tmpdir(), 'paths-rotate-'))
  try {
    const logs = join(home, 'dsbot-nodes', 'logs')
    await mkdir(logs, { recursive: true })
    const current = join(logs, 'current.log')
    // pid 用测试进程自己的：它一定活着，且和子进程不是同一个。
    await writeFile(current, `2026-01-01T00:00:00.000Z === dsbot-remote v0.1.3 ===\n env node=v22 platform=win32 arch=x64 pid=${process.pid}\n真启动的证据 deps ready\n`)

    const script = `
      const { rotateLogsOnce, appendLog } = await import(${JSON.stringify(pathsUrl)})
      rotateLogsOnce()
      appendLog('探针写的一行')
    `
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, DSH_HOME: home, DSBOT_NODES_TEST: '1' },
      stdio: 'pipe',
    })

    const text = await readFile(current, 'utf8')
    assert.ok(text.includes('真启动的证据 deps ready'), '原来那次启动的日志还在')
    assert.ok(text.includes('探针写的一行'), '新的一行接着写在后面')
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})
