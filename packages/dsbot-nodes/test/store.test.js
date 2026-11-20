// 本文件由 AI 生成，请勿用于生产环境。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createNodeStore, hashToken } from '../src/host/nodes/store.js'

const home = () => mkdtempSync(join(tmpdir(), 'dsbot-nodes-'))

function storeAt(root, extra = {}) {
  return createNodeStore({ home: root, ...extra })
}

test('加一个节点：重新 load 之后还在，字段完整', async () => {
  const root = home()
  const first = storeAt(root)
  await first.load()
  const node = await first.add({
    name: '写代码那台', botId: 'b-1', botName: 'Codey', deviceId: 'd-1', tokenHash: hashToken('t'),
  })
  assert.equal(node.status, 'offline')
  assert.equal(node.groups.length, 0)

  const second = storeAt(root)
  await second.load()
  assert.equal(second.node(node.id).name, '写代码那台')
  assert.equal(second.list().length, 1)
})

test('配对码：开一次，redeem 一次，第二次就不认了', async () => {
  const root = home()
  const store = storeAt(root)
  await store.load()
  const pairing = await store.openPairing({ botId: 'b-1', groupId: 'g-1' })
  assert.match(pairing.code, /^[2-9A-HJKMNP-Z]{8}$/)

  const redeemed = await store.redeemPairing(pairing.code, { deviceId: 'd-1' })
  assert.equal(redeemed.botId, 'b-1')
  assert.equal(await store.redeemPairing(pairing.code, { deviceId: 'd-1' }), undefined)
})

test('配对码大小写与空格都能容忍（要手输的东西）', async () => {
  const root = home()
  const store = storeAt(root)
  await store.load()
  const { code } = await store.openPairing({ botId: 'b-1', groupId: 'g-1' })
  const redeemed = await store.redeemPairing(` ${code.toLowerCase()} `)
  assert.equal(redeemed.code, code)
})

test('过期的配对码不认，而且会被顺手清掉', async () => {
  const root = home()
  let clock = 1_000_000
  const store = storeAt(root, { now: () => clock })
  await store.load()
  const { code } = await store.openPairing({ botId: 'b-1', groupId: 'g-1', ttlMs: 1_000 })
  clock += 1_001
  assert.equal(await store.redeemPairing(code), undefined)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(store.file, 'utf8')).pairings), [])
})

test('token 校验：对了给节点，错一个字符就不给', async () => {
  const root = home()
  const store = storeAt(root)
  await store.load()
  const node = await store.add({ name: 'n', botId: 'b', deviceId: 'd', tokenHash: hashToken('secret-token') })
  assert.equal(store.authenticate(node.id, 'secret-token').id, node.id)
  assert.equal(store.authenticate(node.id, 'secret-tokeo'), undefined)
  assert.equal(store.authenticate(node.id, ''), undefined)
  assert.equal(store.authenticate('n-gone', 'secret-token'), undefined)
})

test('删节点：连它的设备记录一起删，不留能再连的入口', async () => {
  const root = home()
  const store = storeAt(root)
  await store.load()
  const { code } = await store.openPairing({ botId: 'b-1', groupId: 'g-1' })
  await store.redeemPairing(code, { deviceId: 'd-1' })
  const node = await store.add({ name: 'n', botId: 'b', deviceId: 'd-1', tokenHash: hashToken('t') })
  await store.remove(node.id)

  const raw = JSON.parse(readFileSync(store.file, 'utf8'))
  assert.deepEqual(raw.nodes, {})
  assert.deepEqual(raw.devices, [])
})

test('只读的主机：能读，不能写，报的是 read-only 而不是撞坏文件', async () => {
  const root = home()
  const store = storeAt(root, { readOnly: () => '另一个 dsh 正开着这份 Bot 团队' })
  await store.load()
  await assert.rejects(
    () => store.add({ name: 'n', botId: 'b', deviceId: 'd', tokenHash: hashToken('t') }),
    (error) => error.code === 'node/read-only',
  )
  assert.equal(store.list().length, 0)
})

test('文件坏了：报一句 warn，按空的算，不把主机带崩', async () => {
  const root = home()
  writeFileSync(join(root, 'nodes.json'), '{ 这不是 json')
  const warnings = []
  const store = storeAt(root, { warn: message => warnings.push(message) })
  await store.load()
  assert.equal(store.list().length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /nodes\.json/)
})

test('touch 记下最后一次在线时间与状态', async () => {
  const root = home()
  let clock = 500
  const store = storeAt(root, { now: () => clock })
  await store.load()
  const node = await store.add({ name: 'n', botId: 'b', deviceId: 'd', tokenHash: hashToken('t') })
  clock = 900
  const touched = await store.touch(node.id, 'online')
  assert.equal(touched.status, 'online')
  assert.equal(touched.lastSeenAt, 900)
})

// 一次读盘抖动不该等于"节点全丢"。
// 以前的写法：读不懂就当空的 → 下一次 save 把空数据写回去 → 用户连过的机器没了。
test('nodes.json 坏了就不许写：原文件一个字节都不动', async () => {
  const root = home()
  const file = join(root, 'nodes.json')
  writeFileSync(file, '{"version":1,"nodes":{', 'utf8')  // 半个 JSON
  const warnings = []
  const store = storeAt(root, { warn: (message) => warnings.push(String(message)) })

  await store.load()
  assert.deepEqual(store.list(), [])
  await assert.rejects(store.add({ name: '新的' }), /读不出来/)
  assert.equal(readFileSync(file, 'utf8'), '{"version":1,"nodes":{', '文本必须原样留着')
  assert.match(warnings.join('\n'), /不写盘/)
})
