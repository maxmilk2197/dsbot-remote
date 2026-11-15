// 本文件由 AI 生成，请勿用于生产环境。
// The dispatcher is the shape every endpoint handler has to fit into, so the
// rules are tested here once instead of in each handler.
import assert from 'node:assert/strict'
import test from 'node:test'
import { request } from '@dsbot/node-protocol/envelope'
import { NodeFailure } from '@dsbot/node-protocol/errors'
import { createDispatcher } from '../src/host/nodes/endpoints.js'

const happy = {
  'node.hello': async params => ({ nodeId: 'n-1', hostName: '这台主机', proto: params.proto }),
  'turn.request': async params => ({ accepted: true, turnId: params.turnId }),
}

const dispatch = (handlers = happy) => createDispatcher({ handlers, receives: 'node→host' })

test('一个合法请求：handler 的返回值进 rpc.response', async () => {
  const frame = request({
    method: 'node.hello',
    params: { proto: 1, nodeName: '写代码那台', botId: 'b-1', botName: 'Codey' },
  })
  const answer = await dispatch()(frame)
  assert.equal(answer.type, 'rpc.response')
  assert.equal(answer.id, frame.id)
  assert.equal(answer.result.nodeId, 'n-1')
})

test('未知方法：拒绝，不是抛', async () => {
  const answer = await dispatch()(request({ method: 'node.nothing', params: {} }))
  assert.equal(answer.type, 'rpc.error')
  assert.equal(answer.error.code, 'node/unknown-method')
})

test('方向不对：主机这一侧收不到只该由它发出的方法', async () => {
  // group.line 是 host→node，主机侧不该"收到"它。
  const answer = await dispatch()(request({ method: 'group.line', params: {} }))
  assert.equal(answer.type, 'rpc.error')
  assert.equal(answer.error.code, 'node/unknown-method')
})

test('缺必填字段：拒绝，并指出是哪个字段', async () => {
  const answer = await dispatch()(request({ method: 'node.hello', params: { proto: 1 } }))
  assert.equal(answer.type, 'rpc.error')
  assert.equal(answer.error.code, 'node/bad-params')
  assert.match(answer.error.message, /nodeName|botId|botName/)
})

test('handler 抛 NodeFailure：错误码原样回给对面', async () => {
  const answer = await dispatch({
    'node.hello': async () => { throw new NodeFailure('node/unknown-node', '这个 token 不认') },
  })(request({ method: 'node.hello', params: { proto: 1, nodeName: 'a', botId: 'b', botName: 'c' } }))
  assert.equal(answer.type, 'rpc.error')
  assert.equal(answer.error.code, 'node/unknown-node')
  assert.match(answer.error.message, /不认/)
})

test('handler 抛普通 Error：不把栈甩给对面', async () => {
  const answer = await dispatch({
    'node.hello': async () => { throw new TypeError('cannot read properties of undefined') },
  })(request({ method: 'node.hello', params: { proto: 1, nodeName: 'a', botId: 'b', botName: 'c' } }))
  assert.equal(answer.type, 'rpc.error')
  assert.equal(answer.error.code.startsWith('node/'), true)
  assert.equal(answer.error.message.includes('at '), false, '不许带栈帧')
})

test('这张表里没有 handler：说明没实现，不是参数错', async () => {
  const answer = await dispatch({})(request({ method: 'node.hello', params: { proto: 1, nodeName: 'a', botId: 'b', botName: 'c' } }))
  assert.equal(answer.type, 'rpc.error')
  assert.equal(answer.error.code, 'node/unknown-method')
})

test('收到不是 request 的帧：说清楚，不当成崩溃', async () => {
  const answer = await dispatch()({ id: 'x-1', type: 'rpc.response', result: {} })
  assert.equal(answer.type, 'rpc.error')
  assert.equal(answer.error.code, 'node/bad-params')
  assert.equal(answer.id, 'x-1')
})

test('turn.cancel 是控制方法：节点这一侧收，照样校验它的参数', async () => {
  const answer = await createDispatcher({
    handlers: { 'turn.cancel': async params => ({ ok: true, turnId: params.turnId }) },
    receives: 'host→node',
  })(request({ method: 'turn.cancel', params: { turnId: 't-1' } }))
  assert.equal(answer.type, 'rpc.response')
  assert.equal(answer.result.ok, true)
})
