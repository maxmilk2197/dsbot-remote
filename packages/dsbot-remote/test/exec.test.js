// 本文件由 AI 生成，请勿用于生产环境。
// S3: the only place this plugin runs something on the user's machine. Every
// case here is a rule from PLAN.md §4 — the tests exist so a later "just make it
// work" edit cannot quietly widen them.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { ALLOWED_ACTIONS, accepts, execute, sanitizeEnv, withinRoot } from '../src/exec.js'

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'dsbot-remote-'))
  writeFileSync(join(root, 'notes.txt'), '第一行\n第二行\n')
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'sub', 'inner.txt'), 'inner')
  return root
}

test('白名单只有五个动作，别的名字一律不认', () => {
  assert.deepEqual([...ALLOWED_ACTIONS].sort(), ['env_info', 'list_dir', 'push_file', 'read_file', 'run_shell'])
  assert.equal(accepts('read_file'), true)
  for (const action of ['write_file', 'delete_file', 'run_shell_root', 'install', '']) {
    assert.equal(accepts(action), false, `${action} 不该在白名单里`)
  }
})

test('读文件：正常路径返回内容', async () => {
  const root = workspace()
  const result = await execute({ action: 'read_file', args: { path: join(root, 'notes.txt') } }, { cwd: root })
  assert.equal(result.ok, true)
  assert.match(result.output, /第一行/)
})

test('读文件：跳出工作目录的相对路径被拒', async () => {
  const root = workspace()
  for (const path of ['../../secret.txt', '..\\..\\secret.txt', join(root, '..', 'outside.txt')]) {
    const result = await execute({ action: 'read_file', args: { path } }, { cwd: root })
    assert.equal(result.ok, false, `${path} 应被拒`)
    assert.equal(result.code, 'node/exec-denied')
  }
})

test('读文件：目录当文件读被拒，不是崩', async () => {
  const root = workspace()
  const result = await execute({ action: 'read_file', args: { path: root } }, { cwd: root })
  assert.equal(result.ok, false)
})

test('列目录：只列一层，路径同样受根目录约束', async () => {
  const root = workspace()
  const inside = await execute({ action: 'list_dir', args: { path: root } }, { cwd: root })
  assert.equal(inside.ok, true)
  assert.match(inside.output, /notes\.txt/)
  assert.match(inside.output, /sub/)

  const outside = await execute({ action: 'list_dir', args: { path: join(root, '..') } }, { cwd: root })
  assert.equal(outside.ok, false)
  assert.equal(outside.code, 'node/exec-denied')
})

test('run_shell：在给定 cwd 里跑，拿到 stdout', async () => {
  const root = workspace()
  const result = await execute(
    { action: 'run_shell', args: { command: `node -e "console.log(process.cwd())"` } },
    { cwd: root },
  )
  assert.equal(result.ok, true)
  assert.equal(resolve(result.output.trim()), resolve(root))
})

test('run_shell：超时被杀，并说明是超时', async () => {
  const started = Date.now()
  const result = await execute(
    { action: 'run_shell', args: { command: `node -e "setTimeout(()=>{}, 60000)"` } },
    { cwd: tmpdir(), timeoutMs: 120 },
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'node/timeout')
  assert.ok(Date.now() - started < 5_000, '不该等满 60 秒')
})

test('run_shell：输出被截到 64KB，并标 truncated', async () => {
  const result = await execute(
    { action: 'run_shell', args: { command: `node -e "process.stdout.write('x'.repeat(200000))"` } },
    { cwd: tmpdir(), timeoutMs: 10_000 },
  )
  assert.equal(result.ok, true)
  assert.equal(result.truncated, true)
  assert.equal(Buffer.byteLength(result.output, 'utf8'), 64 * 1024)
})

test('环境变量里的密钥不会漏进子进程', async () => {
  const scrubbed = sanitizeEnv({
    PATH: '/usr/bin',
    HOME: '/home/u',
    GITHUB_TOKEN: 'ghp_secret',
    OPENAI_API_KEY: 'sk-secret',
    DB_PASSWORD: 'hunter2',
    MY_SECRET_VALUE: 's',
    NORMAL_FLAG: '1',
  })
  assert.equal(scrubbed.PATH, '/usr/bin')
  assert.equal(scrubbed.HOME, '/home/u')
  assert.equal(scrubbed.NORMAL_FLAG, '1')
  for (const key of ['GITHUB_TOKEN', 'OPENAI_API_KEY', 'DB_PASSWORD', 'MY_SECRET_VALUE']) {
    assert.equal(scrubbed[key], undefined, `${key} 必须被剥掉`)
  }
})

test('env_info 不吐任何看起来像密钥的值', async () => {
  const result = await execute({ action: 'env_info', args: {} }, {
    cwd: tmpdir(),
    env: { PATH: '/usr/bin', API_KEY: 'sk-should-not-appear', NODE_VERSION: 'v24' },
  })
  assert.equal(result.ok, true)
  assert.equal(result.output.includes('sk-should-not-appear'), false)
  assert.match(result.output, /node|v24|platform/i)
})

test('push_file：文件不存在时给明确失败，不是抛', async () => {
  const root = workspace()
  const result = await execute({ action: 'push_file', args: { path: join(root, 'nope.csv') } }, { cwd: root })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'node/exec-failed')
  assert.ok(result.message !== '')
})

test('push_file：超出单次上限被拒', async () => {
  const root = workspace()
  const big = join(root, 'big.bin')
  writeFileSync(big, Buffer.alloc(1024))
  const result = await execute({ action: 'push_file', args: { path: big } }, { cwd: root, maxFileBytes: 512 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'node/file-too-big')
})

test('withinRoot：同前缀的兄弟目录不算在根目录里', () => {
  assert.equal(withinRoot('/work/proj', '/work/proj/a.txt'), true)
  assert.equal(withinRoot('/work/proj', '/work/proj-other/a.txt'), false)
  assert.equal(withinRoot('/work/proj', '/work/proj/../etc/passwd'), false)
})
