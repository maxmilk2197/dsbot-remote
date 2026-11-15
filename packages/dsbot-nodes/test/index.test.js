// 本文件由 AI 生成，请勿用于生产环境。
// 接线：一台"远端"真的连上来，主机认下它，然后把 node:<id> 注册成 provider。
// 这里不测 chunk 语义（adapter.test.js 已测），只测"两端对上话"这件事。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listenTcp } from '@dsbot/node-protocol/tcp'
import { install } from '../src/host/nodes/index.js'

class FakeLlmAdapter { dispose() {} }
class FakeLlmError extends Error {
  constructor(message, code, extra) { super(message); this.code = code; this.extra = extra }
}

const makeRt = async () => {
  const home = await mkdtemp(join(tmpdir(), 'nodes-'))
  const registered = []
  const rt = {
    home,
    readOnly: () => false,
    warn: () => {},
    ctx: {
      effect: () => {},
      llm: {
        registerAdapter(routes, adapter) {
          const entry = { routes: [...routes], adapter }
          registered.push(entry)
          const registration = () => { entry.disposed = true }
          registration.replace = next => { entry.routes = [...next] }
          return registration
        },
      },
    },
  }
  return { rt, home, registered }
}

// 远端：连上就报身份，并回答 node.exec。
const startRemote = async ({ name, deviceId }) => {
  const seen = []
  const server = await listenTcp({
    port: 0,
    host: '127.0.0.1',
    token: 'secret-token-1',
    onConnection: (peer) => {
      peer.send({ id: 'hello-1', method: 'node.hello', params: { name, deviceId, caps: ['exec', 'push_file'] } })
      peer.on('frame', (frame) => {
        seen.push(frame)
        if (frame.method === 'node.exec') {
          peer.send({ id: frame.id, result: { stdout: `${frame.params?.action} ok` } })
        }
      })
    },
  })
  return { server, seen, url: `tcp://127.0.0.1:${server.port}` }
}

test('远端连上来：主机认下它、标在线、注册 node: 路由', async () => {
  const { rt, home, registered } = await makeRt()
  const api = install(rt)
  const remote = await startRemote({ name: '写代码那台', deviceId: 'dev-aaa' })
  try {
    const { nodeId } = await api.connect({ url: remote.url, token: 'secret-token-1' })
    assert.match(nodeId, /^n-[0-9a-f]{8}$/)

    const [node] = api.list()
    assert.equal(node.name, '写代码那台')
    assert.equal(node.status, 'online')
    assert.deepEqual(node.caps, ['exec', 'push_file'])

    // 路由是 node:<主机分配的 id>，不是远端自报的名字
    assert.deepEqual(registered.at(-1).routes, [`node:${nodeId}`])
  } finally {
    remote.server.close()
    await new Promise(done => setTimeout(done, 30))
    await rm(home, { recursive: true, force: true })
  }
})

test('主机发的 node.exec 能拿到远端的回答', async () => {
  const { rt, home } = await makeRt()
  const api = install(rt)
  const remote = await startRemote({ name: '远端', deviceId: 'dev-bbb' })
  try {
    const { nodeId } = await api.connect({ url: remote.url, token: 'secret-token-1' })
    const result = await api.call(nodeId, 'node.exec', { action: 'env_info' })
    assert.equal(result.stdout, 'env_info ok')
    assert.equal(remote.seen.at(-1).method, 'node.exec')
  } finally {
    remote.server.close()
    await new Promise(done => setTimeout(done, 30))
    await rm(home, { recursive: true, force: true })
  }
})

test('同一个 deviceId 再连一次是重连，不是第二台机器', async () => {
  const { rt, home } = await makeRt()
  const api = install(rt)
  const first = await startRemote({ name: '写代码那台', deviceId: 'dev-ccc' })
  const firstId = (await api.connect({ url: first.url, token: 'secret-token-1' })).nodeId
  first.server.close()

  const second = await startRemote({ name: '写代码那台', deviceId: 'dev-ccc' })
  try {
    const secondId = (await api.connect({ url: second.url, token: 'secret-token-1' })).nodeId
    assert.equal(secondId, firstId)
    assert.equal(api.list().length, 1)
  } finally {
    second.server.close()
    await new Promise(done => setTimeout(done, 30))
    await rm(home, { recursive: true, force: true })
  }
})

test('对面没报身份，握手超时就断，不会留一条僵尸连接', async () => {
  const { rt, home } = await makeRt()
  const api = install(rt)
  const server = await listenTcp({ port: 0, host: '127.0.0.1', token: 'secret-token-1' })
  try {
    await assert.rejects(
      api.connect({ url: `tcp://127.0.0.1:${server.port}`, token: 'secret-token-1', helloTimeoutMs: 400, timeoutMs: 2000 }),
      /没有发 node\.hello|握手/,
    )
    assert.equal(api.list().length, 0)
  } finally {
    server.close()
    await new Promise(done => setTimeout(done, 30))
    await rm(home, { recursive: true, force: true })
  }
})

test('token 不对连不上，什么都不会被记下来', async () => {
  const { rt, home } = await makeRt()
  const api = install(rt)
  const remote = await startRemote({ name: '远端', deviceId: 'dev-ddd' })
  try {
    await assert.rejects(api.connect({ url: remote.url, token: 'wrong-token-9' }), /unauthorized|拒绝/)
    assert.equal(api.list().length, 0)
  } finally {
    remote.server.close()
    await new Promise(done => setTimeout(done, 30))
    await rm(home, { recursive: true, force: true })
  }
})
