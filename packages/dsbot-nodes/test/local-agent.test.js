// 开箱即用：加入端不填 agent 命令时，直接用这台 DSH 已配好的模型。
import assert from 'node:assert/strict'
import test from 'node:test'
import { pickLocalModel, runLocal } from '../src/node/local-agent.js'
import { servePeer } from '../src/node/cli.js'

const fakeLlm = ({ providers = [], models = {}, stream = async function* () {} } = {}) => ({
  listProviders: () => providers,
  listModels: async (provider) => models[provider] ?? [],
  stream,
})

test('选模型：账号模型优先，插件自己注册的 node: 节点不算本机模型', async () => {
  const llm = fakeLlm({
    providers: [{ id: 'node:n-1' }, { id: 'local-acp-x' }, { id: 'deepseek-account' }],
    models: {
      'node:n-1': [{ id: 'default', name: '远程' }],
      'local-acp-x': [{ id: 'hy4free', name: '本地 agent' }],
      'deepseek-account': [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }],
    },
  })
  const picked = await pickLocalModel(llm)
  assert.deepEqual(picked, { provider: 'deepseek-account', model: 'deepseek-flash', name: 'DeepSeek Flash' })
})

test('选模型：一个都没有就返回 undefined，不抛', async () => {
  assert.equal(await pickLocalModel(undefined), undefined)
  assert.equal(await pickLocalModel(fakeLlm()), undefined)
  assert.equal(await pickLocalModel(fakeLlm({ providers: [{ id: 'node:n-1' }] })), undefined)
})

test('跑一轮：text-delta 流式给出，全文收齐，finish 出错写明原因', async () => {
  const llm = fakeLlm({
    stream: async function* () {
      yield { type: 'text-delta', text: '你' }
      yield { type: 'text-delta', text: '好' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const deltas = []
  const ok = await runLocal({ llm, provider: 'p', model: 'm', prompt: 'hi', onDelta: t => deltas.push(t) })
  assert.equal(ok.ok, true)
  assert.equal(ok.text, '你好')
  assert.deepEqual(deltas, ['你', '好'])

  const bad = fakeLlm({
    stream: async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: '没登录' } } } },
  })
  const failed = await runLocal({ llm: bad, provider: 'p', model: 'm', prompt: 'hi' })
  assert.equal(failed.ok, false)
  assert.match(failed.message, /没登录/)
})

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

test('servePeer：没填 agent 命令但有本机模型，照样报名 agent 并能跑一轮', async () => {
  const peer = fakePeer()
  const llm = fakeLlm({
    stream: async function* () {
      yield { type: 'text-delta', text: '本机回答' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  servePeer(peer, {
    name: '手机', deviceId: 'dev-1', cwd: '/tmp', inbox: false,
    llm, local: { provider: 'deepseek-account', model: 'deepseek-flash', name: 'Flash' },
  })

  const hello = peer.sent.find(frame => frame.method === 'node.hello')
  assert.ok(hello.params.caps.includes('agent'))

  await peer.emit({ id: 't-1', method: 'turn.request', params: { turnId: 'turn-1', prompt: '在吗' } })
  assert.ok(peer.sent.some(frame => frame.id === 't-1' && frame.result?.accepted === true))
  const result = peer.sent.find(frame => frame.method === 'turn.result')
  assert.equal(result.params.status, 'ok')
  assert.equal(result.params.text, '本机回答')
})

test('servePeer：既没命令也没模型，明确回 unsupported 而不是静默', async () => {
  const peer = fakePeer()
  servePeer(peer, { name: '手机', deviceId: 'dev-1', cwd: '/tmp', inbox: false })
  const hello = peer.sent.find(frame => frame.method === 'node.hello')
  assert.equal(hello.params.caps.includes('agent'), false)

  await peer.emit({ id: 't-2', method: 'turn.request', params: { turnId: 'turn-2', prompt: '在吗' } })
  const reply = peer.sent.find(frame => frame.id === 't-2')
  assert.equal(reply.error.code, 'node/unsupported')
})
