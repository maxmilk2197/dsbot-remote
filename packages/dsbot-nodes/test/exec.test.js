// 本文件由 AI 生成，请勿用于生产环境。
// exec.js 自己的单测：以前它一条测试都没有，白名单和越界检查全靠人工点。
// 这里锁死三件事：工作区边界、动作白名单、以及"命令真的能跑"。
import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALLOWED_ACTIONS, execute, sanitizeEnv, withinRoot } from '../src/node/exec.js'
import { servePeer } from '../src/node/cli.js'

const workspace = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'exec-'))
  await writeFile(join(dir, 'a.txt'), 'hello')
  await mkdir(join(dir, 'sub'))
  await writeFile(join(dir, 'sub', 'b.txt'), 'inner')
  return dir
}

test('白名单只有五个动作', () => {
  assert.deepEqual([...ALLOWED_ACTIONS].sort(), ['env_info', 'list_dir', 'push_file', 'read_file', 'run_shell'])
})

test('sanitizeEnv：看起来像凭据的变量一律不传给子进程', () => {
  const kept = sanitizeEnv({ PATH: '/bin', API_KEY: 'x', GITHUB_TOKEN: 'y', MY_SECRET: 'z', HOME: '/root' })
  assert.deepEqual(kept, { PATH: '/bin', HOME: '/root' })
})

test('withinRoot：里面可以，隔壁前缀不算里面，绝对路径逃不出去', () => {
  assert.equal(withinRoot('/w/proj', 'a.txt'), true)
  assert.equal(withinRoot('/w/proj', '../proj-other/x'), false)
  assert.equal(withinRoot('/w/proj', '/etc/passwd'), false)
})

test('未知动作按失败回，不落进 env_info', async () => {
  const result = await execute({ action: 'rm_rf', args: {} }, { cwd: await workspace() })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'node/exec-denied')
})

test('read_file：能读，越界拒绝', async () => {
  const cwd = await workspace()
  try {
    const ok = await execute({ action: 'read_file', args: { path: 'a.txt' } }, { cwd })
    assert.equal(ok.ok, true)
    assert.equal(ok.output, 'hello')
    const denied = await execute({ action: 'read_file', args: { path: '../outside.txt' } }, { cwd })
    assert.equal(denied.ok, false)
    assert.match(denied.message, /不在工作目录/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('list_dir：子目录能进，列出来带类型', async () => {
  const cwd = await workspace()
  try {
    const listed = await execute({ action: 'list_dir', args: { path: 'sub' } }, { cwd })
    assert.equal(listed.ok, true)
    assert.match(listed.output, /b\.txt/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('push_file：回 files[]，落点是解析后的绝对路径', async () => {
  const cwd = await workspace()
  try {
    const pushed = await execute({ action: 'push_file', args: { path: 'a.txt' } }, { cwd })
    assert.equal(pushed.ok, true)
    assert.equal(pushed.files.length, 1)
    assert.equal(pushed.files[0].size, 5)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('run_shell：真跑一条命令，输出收得到', async () => {
  const cwd = await workspace()
  try {
    const ran = await execute({ action: 'run_shell', args: { command: 'echo exec-ok' } }, { cwd })
    assert.equal(ran.ok, true)
    assert.match(ran.output, /exec-ok/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

// ---- 审批：主机要跑命令，得机器主人先点头 -------------------------------

function fakePeer() {
  const peer = new EventEmitter()
  peer.sent = []
  peer.remote = 'test-peer'
  peer.send = frame => { peer.sent.push(frame); return true }
  peer.close = () => {}
  return peer
}

async function askApproval(allowShell, action = 'run_shell') {
  const peer = fakePeer()
  servePeer(peer, { name: 'n', deviceId: 'dev-x', cwd: process.cwd(), allowShell, inbox: false })
  peer.emit('frame', { id: 'ap-1', method: 'node.approval', params: { approvalId: 'ap-1', action, detail: { command: 'echo hi' } } })
  for (let i = 0; i < 40; i += 1) {
    const answered = peer.sent.find(frame => frame.id === 'ap-1')
    if (answered !== undefined) return answered.result
    await new Promise(done => setTimeout(done, 10))
  }
  return undefined
}

test('审批：没开 --allow-shell 时 run_shell 被拒', async () => {
  const answer = await askApproval(false)
  assert.equal(answer.allow, false)
  assert.match(String(answer.reason), /allow-shell/)
})

test('审批：开了 --allow-shell 才放行，读文件类不问', async () => {
  assert.equal((await askApproval(true)).allow, true)
  assert.equal((await askApproval(false, 'read_file')).allow, true)
})
