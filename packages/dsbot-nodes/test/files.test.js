// 本文件由 AI 生成，请勿用于生产环境。
// S4: bytes a remote node pushes land in a per-node outbox on the host. The file
// name is attacker-controlled in the only sense that matters here — the remote can
// send anything — so this seam is why a `..` cannot walk out of the outbox.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { acceptUpload, outboxDir, safeName } from '../src/host/nodes/files.js'

const HELLO = Buffer.from('hello')
// 独立事实：sha256("hello") 的已知值，不是用同一段代码算出来的。
const HELLO_SHA = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'

const home = () => mkdtempSync(join(tmpdir(), 'dsbot-outbox-'))

test('收一个文件：落进该节点的 outbox，sha256 与内容都对得上', async () => {
  const root = home()
  const result = await acceptUpload({ home: root, nodeId: 'n-1', name: 'report.csv', data: HELLO })
  assert.equal(result.ok, true)
  assert.equal(result.sha256, HELLO_SHA)
  assert.equal(result.bytes, 5)
  assert.equal(result.path, resolve(outboxDir(root, 'n-1'), 'report.csv'))
  assert.equal(readFileSync(result.path).toString(), 'hello')
})

test('名字里的路径被剥掉：../../etc/passwd 只能在 outbox 里叫 passwd', async () => {
  const root = home()
  for (const name of ['../../etc/passwd', '..\\..\\Windows\\win.ini', '/etc/shadow', 'a/../../b.txt']) {
    const result = await acceptUpload({ home: root, nodeId: 'n-1', name, data: HELLO })
    assert.equal(result.ok, true, `${name} 应被接受但改名为安全的`)
    assert.equal(result.path.startsWith(outboxDir(root, 'n-1')), true, `${name} 逃出 outbox 了`)
    assert.equal(result.path.includes('..'), false)
  }
  assert.deepEqual(readdirSync(outboxDir(root, 'n-1')).sort(), ['b.txt', 'passwd', 'shadow', 'win.ini'])
})

test('Windows 设备名被改名，不能用来写设备', () => {
  for (const name of ['CON', 'con.txt', 'PRN', 'NUL', 'COM1', 'LPT9.log']) {
    const safe = safeName(name)
    assert.notEqual(safe.toLowerCase().replace(/^\d+$/, ''), name.toLowerCase())
    assert.equal(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(safe), false, `${name} -> ${safe} 仍是设备名`)
  }
})

test('空名字、纯点号、超长名字都给一个能用的名字', () => {
  assert.equal(safeName(''), '')
  assert.equal(safeName('...'), '')
  const long = `${'a'.repeat(300)}.txt`
  const safe = safeName(long)
  assert.ok(safe.length <= 128, `名字长度 ${safe.length}`)
  assert.ok(safe.endsWith('.txt'), '扩展名要保住')
})

test('超出单次上限被拒，且不留残文件', async () => {
  const root = home()
  const result = await acceptUpload({ home: root, nodeId: 'n-1', name: 'big.bin', data: Buffer.alloc(2048), maxBytes: 1024 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'node/file-too-big')
  assert.deepEqual(readdirSync(outboxDir(root, 'n-1')), [])
})

test('重名不覆盖：第二个变成 -1，原文件内容不动', async () => {
  const root = home()
  const first = await acceptUpload({ home: root, nodeId: 'n-1', name: 'a.txt', data: Buffer.from('one') })
  const second = await acceptUpload({ home: root, nodeId: 'n-1', name: 'a.txt', data: Buffer.from('two') })
  const third = await acceptUpload({ home: root, nodeId: 'n-1', name: 'a.txt', data: Buffer.from('three') })
  assert.equal(first.name, 'a.txt')
  assert.equal(second.name, 'a-1.txt')
  assert.equal(third.name, 'a-2.txt')
  assert.equal(readFileSync(first.path).toString(), 'one')
})

test('不同节点各用各的 outbox，同名互不干扰', async () => {
  const root = home()
  const a = await acceptUpload({ home: root, nodeId: 'n-a', name: 'x.txt', data: Buffer.from('A') })
  const b = await acceptUpload({ home: root, nodeId: 'n-b', name: 'x.txt', data: Buffer.from('B') })
  assert.notEqual(a.path, b.path)
  assert.equal(readFileSync(a.path).toString(), 'A')
  assert.equal(readFileSync(b.path).toString(), 'B')
})

test('节点 id 带路径也不能跳到别的目录', async () => {
  const root = home()
  const result = await acceptUpload({ home: root, nodeId: '../../escape', name: 'x.txt', data: HELLO })
  assert.equal(result.ok, true)
  assert.equal(result.path.startsWith(resolve(root, 'nodes')), true)
})

test('分块流入同样算得出 sha256（不必先拼成一整块再写）', async () => {
  const root = home()
  async function* pieces() {
    yield Buffer.from('he')
    yield Buffer.from('ll')
    yield Buffer.from('o')
  }
  const result = await acceptUpload({ home: root, nodeId: 'n-1', name: 'split.txt', data: pieces() })
  assert.equal(result.sha256, HELLO_SHA)
  assert.equal(result.bytes, 5)
})

test('已有同名但内容是空文件时也要让位，不当成没冲突', async () => {
  const root = home()
  mkdirSync(outboxDir(root, 'n-1'), { recursive: true })
  writeFileSync(join(outboxDir(root, 'n-1'), 'z.txt'), '')
  const result = await acceptUpload({ home: root, nodeId: 'n-1', name: 'z.txt', data: HELLO })
  assert.equal(result.name, 'z-1.txt')
})
