// 本文件由 AI 生成，请勿用于生产环境。
// 镜像群：手机上那台 ds-bot 里真的出现这个群，消息双向。
// 这块会往远端的 ds-bot 数据里写东西，所以每条规矩都要有测试盯着。
import assert from 'node:assert/strict'
import test from 'node:test'
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
