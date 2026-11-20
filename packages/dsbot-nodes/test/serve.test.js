// 本文件由 AI 生成，请勿用于生产环境。
// 加入端的帧分发：hello 回执里的群要交出去建镜像；group.snapshot 要能落进 mirror。
import assert from 'node:assert/strict'
import test from 'node:test'
import { servePeer } from '../src/node/cli.js'

function fakePeer() {
  const sent = []
  let onFrame
  return {
    sent,
    remote: 'test-peer',
    send: frame => { sent.push(frame); return true },
    on: (event, handler) => { if (event === 'frame') onFrame = handler },
    emit: async (frame) => { await onFrame?.(frame) },
  }
}

test('hello 回执里的群交给 onGroups：加入端不用等消息就能建群', async () => {
  const peer = fakePeer()
  const seen = []
  servePeer(peer, {
    name: '手机', deviceId: 'dev-1', cwd: '/tmp', inbox: false,
    onGroups: groups => { seen.push(groups) },
  })

  await peer.emit({
    id: 'hello',
    result: { proto: 1, ok: true, nodeId: 'n-1', groups: [{ id: 'g1', name: '测试' }] },
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(seen, [[{ id: 'g1', name: '测试' }]])
})

test('group.snapshot 转成镜像写入，并按协议回 ok', async () => {
  const peer = fakePeer()
  const calls = []
  servePeer(peer, {
    name: '手机', deviceId: 'dev-1', cwd: '/tmp', inbox: false,
    onGroupLine: (params, lines) => { calls.push({ params, lines }) },
  })

  await peer.emit({
    id: 'snap-1',
    method: 'group.snapshot',
    params: { room: { id: 'g1', name: '测试' }, lines: [{ text: '开干' }], cursor: 0 },
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].params.roomId, 'g1')
  assert.equal(calls[0].params.roomName, '测试')
  assert.equal(calls[0].lines.length, 1)
  assert.ok(peer.sent.some(frame => frame.id === 'snap-1' && frame.result?.ok === true))
})
