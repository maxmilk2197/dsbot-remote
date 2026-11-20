// 本文件由 AI 生成，请勿用于生产环境。
// 镜像群：手机上那台 ds-bot 里真的出现这个群，消息双向。
// 这块会往远端的 ds-bot 数据里写东西，所以每条规矩都要有测试盯着。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMirror, mirrorName } from '../src/host/nodes/mirror.js'

function fakeRt({ bots = 2, rooms = [] } = {}) {
  const state = { bots: {}, rooms: {} }
  for (let index = 0; index < bots; index += 1) state.bots[`b${index}`] = { id: `b${index}`, name: `Bot${index}` }
  for (const room of rooms) state.rooms[room.id] = room
  const calls = { created: [], logged: [], saved: 0 }
  const listeners = new Set()
  const rt = {
    state,
    roomOf: id => state.rooms[id],
    createRoom: async ({ members, name, admin }) => {
      calls.created.push({ members, name, admin })
      const room = { id: `room-${calls.created.length}`, name, members: [...members], admin: admin ?? null, seq: 0, log: [] }
      state.rooms[room.id] = room
      return room
    },
    logRoom: (room, line) => {
      room.seq += 1
      calls.logged.push({ roomId: room.id, line: { ...line, seq: room.seq } })
      room.log = [...room.log, line]
    },
    onRoomLine: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    save: async () => { calls.saved += 1 },
  }
  const emitLine = (room, record) => { for (const listener of listeners) listener(room, record) }
  return { rt, state, calls, emitLine }
}

const fakePeer = () => {
  const sent = []
  return { sent, send: frame => { sent.push(frame); return true } }
}

test('主机推来一条消息：本地建同名群，写进去，且不派活给本地 Bot', async () => {
  const { rt, calls } = fakeRt()
  const mirror = createMirror({ rt })

  const result = await mirror.write({ roomId: 'host-1', roomName: '测试' }, [{ who: 'Chief', text: '开干' }])

  assert.equal(calls.created.length, 1, '应该建了一个群')
  assert.equal(calls.created[0].name, mirrorName('测试'))
  assert.equal(calls.created[0].admin, null, '没有 admin，普通消息才不会派给成员')
  assert.equal(result.written, 1)
  assert.deepEqual(calls.logged[0].line.mirror, true, '写进去的行要带 mirror 标记')
  assert.equal(calls.logged[0].line.who, 'Chief')
})

test('同一个群再推：复用，不会一次一条地堆群', async () => {
  const { rt, calls } = fakeRt()
  const mirror = createMirror({ rt })

  await mirror.write({ roomId: 'host-1', roomName: '测试' }, [{ who: 'Chief', text: '一' }])
  await mirror.write({ roomId: 'host-1', roomName: '测试' }, [{ who: '你', text: '二' }])

  assert.equal(calls.created.length, 1)
  assert.equal(calls.logged.length, 2)
  assert.equal(calls.logged[1].line.text, '二')
})

test('断线重连后：按名字认出上次建的那个群', async () => {
  const { rt, calls } = fakeRt({
    rooms: [{ id: 'room-old', name: mirrorName('测试'), members: ['b0', 'b1'], admin: null, seq: 0, log: [] }],
  })
  const mirror = createMirror({ rt })

  const room = await mirror.ensure({ roomId: 'host-1', roomName: '测试' })

  assert.equal(room.id, 'room-old')
  assert.equal(calls.created.length, 0, '不该再建一个')
})

test('用户在镜像群里说话：转成 node.post 回主机', async () => {
  const { rt, calls, emitLine } = fakeRt()
  const mirror = createMirror({ rt })
  const peer = fakePeer()
  mirror.bind(peer)
  const room = await mirror.ensure({ roomId: 'host-1', roomName: '测试' })

  emitLine(room, { who: '你', text: '  在吗  ' })

  assert.equal(peer.sent.length, 1)
  assert.equal(peer.sent[0].method, 'node.post')
  assert.deepEqual(peer.sent[0].params, { groupId: 'host-1', text: '在吗' })
  assert.equal(calls.logged.length, 0, '回传不该再往本地写一遍')
})

test('我们自己写进去的行不会被当成用户发言（否则就是死循环）', async () => {
  const { rt, emitLine } = fakeRt()
  const mirror = createMirror({ rt })
  const peer = fakePeer()
  mirror.bind(peer)
  const room = await mirror.ensure({ roomId: 'host-1', roomName: '测试' })

  emitLine(room, { who: 'Chief', text: '开干', mirror: true })
  emitLine(room, { who: 'Chief', text: '另一句', mirror: true })

  assert.deepEqual(peer.sent, [], '主机推来的消息不能再发回主机')
})

test('本地 Bot 不足两个：不硬造群，只报一句', async () => {
  const { rt, calls } = fakeRt({ bots: 1 })
  const warnings = []
  const mirror = createMirror({ rt, warn: message => warnings.push(String(message)) })

  const result = await mirror.write({ roomId: 'host-1', roomName: '测试' }, [{ who: 'Chief', text: '开干' }])

  assert.equal(result.written, 0)
  assert.equal(calls.created.length, 0)
  assert.match(warnings.join('\n'), /至少要有两个 Bot/)
})

test('不是镜像群的发言不往外发（别把本地别的群搅进来）', async () => {
  const { rt, state, emitLine } = fakeRt()
  const mirror = createMirror({ rt })
  const peer = fakePeer()
  mirror.bind(peer)
  await mirror.ensure({ roomId: 'host-1', roomName: '测试' })

  state.rooms.local = { id: 'local', name: '本地的群', members: ['b0'], seq: 0, log: [] }
  emitLine(state.rooms.local, { who: '你', text: '本地聊天' })

  assert.deepEqual(peer.sent, [])
})

test('连上主机时按群列表批量建镜像群，不用等第一条消息', async () => {
  const { rt, calls } = fakeRt()
  const mirror = createMirror({ rt })

  const made = await mirror.ensureAll([
    { id: 'host-1', name: '测试' },
    { id: 'host-2', name: '写代码' },
  ])

  assert.equal(made, 2)
  assert.equal(calls.created.length, 2)
  assert.deepEqual(calls.created.map(each => each.name), [mirrorName('测试'), mirrorName('写代码')])
  assert.deepEqual(calls.logged, [], '建群本身不写消息')
})

test('hello 回执和 snapshot 同时到：同一个群只建一次', async () => {
  const { rt, calls } = fakeRt()
  const mirror = createMirror({ rt })

  const [a, b] = await Promise.all([
    mirror.ensure({ roomId: 'host-1', roomName: '测试' }),
    mirror.ensure({ roomId: 'host-1', roomName: '测试' }),
  ])

  assert.equal(calls.created.length, 1, '并发 ensure 不能建出两个群')
  assert.equal(a.id, b.id)
})

test('同一段历史重发两次：按 seq 只写一遍，水位回给主机', async () => {
  const { rt, calls } = fakeRt()
  const mirror = createMirror({ rt })
  const lines = [
    { seq: 7, who: 'Chief', text: '一' },
    { seq: 8, who: 'Chief', text: '二' },
  ]

  await mirror.write({ roomId: 'host-1', roomName: '测试' }, lines)
  // 重连：主机把最后一段又发了一遍（seq 一样），外加一条新的。
  await mirror.write({ roomId: 'host-1', roomName: '测试' }, [...lines, { seq: 9, who: 'Chief', text: '三' }])

  assert.deepEqual(calls.logged.map(each => each.line.text), ['一', '二', '三'], '重复的 seq 不该再写一遍')
  assert.deepEqual(mirror.cursors(), { 'host-1': 9 }, '握手时要知道每个群收到第几条')
})

test('两台主机有同名群：镜像群分开，不合成一个', async () => {
  const { rt, calls } = fakeRt()
  const mirror = createMirror({ rt })

  mirror.setHost('aaaa1111')
  const one = await mirror.ensure({ roomId: 'host-1', roomName: '工作' })
  mirror.setHost('bbbb2222')
  const two = await mirror.ensure({ roomId: 'host-1', roomName: '工作' })

  assert.notEqual(one.id, two.id, '不同主机的同名群必须是两个本地群')
  assert.equal(calls.created.length, 2)
  assert.equal(calls.created[0].name, mirrorName('工作'))
  assert.match(calls.created[1].name, /^远程 · 工作 · bbbb$/)
})

test('重启后按进度文件找回同一个群，水位也还在', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsbot-mirror-'))
  try {
    const first = fakeRt()
    const before = createMirror({ rt: first.rt, home: dir })
    before.setHost('host-a')
    await before.write({ roomId: 'host-1', roomName: '测试' }, [{ seq: 3, who: 'Chief', text: '之前' }])

    // 新进程：同一个 home，room 还在 rt 里。
    const second = fakeRt({ rooms: Object.values(first.state.rooms) })
    const after = createMirror({ rt: second.rt, home: dir })
    after.setHost('host-a')
    await after.load()

    assert.deepEqual(after.cursors(), { 'host-1': 3 }, '水位从盘上读回来')
    const room = await after.ensure({ roomId: 'host-1', roomName: '测试' })
    assert.equal(room.id, 'room-1', '找回来的还是上次那个群')
    assert.equal(second.calls.created.length, 0, '不该再建一个')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
