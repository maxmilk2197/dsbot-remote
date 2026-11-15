// 本文件由 AI 生成，请勿用于生产环境。
// S5: 两台机器之间的管子。粘包、半包、坏帧、口令错、对面挂掉。
// 这些是"跨地区跑一整轮"之前必须确定的事 —— 帧边界错了，上面所有协议都白搭。
import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { BadFrame, FrameReader, connectTcp, encodeFrame, listenTcp, parseTcpUrl } from '../src/transport/tcp.js'

test('一帧编码后能读回来，中文不丢', () => {
  const frame = { t: 'msg', text: '写代码那台已上线', n: 42 }
  const reader = new FrameReader()
  assert.deepEqual(reader.push(encodeFrame(frame)), [frame])
})

test('半包：一次只给三分之一个帧', () => {
  const bytes = encodeFrame({ t: 'a', text: 'x'.repeat(200) })
  const reader = new FrameReader()
  assert.deepEqual(reader.push(bytes.subarray(0, 10)), [])
  assert.deepEqual(reader.push(bytes.subarray(10, 100)), [])
  const rest = reader.push(bytes.subarray(100))
  assert.equal(rest.length, 1)
  assert.equal(rest[0].text.length, 200)
})

test('粘包：一次给三个帧', () => {
  const reader = new FrameReader()
  const bytes = Buffer.concat([encodeFrame({ t: 'a' }), encodeFrame({ t: 'b' }), encodeFrame({ t: 'c' })])
  assert.deepEqual(reader.push(bytes).map((f) => f.t), ['a', 'b', 'c'])
})

test('声明的长度超过上限就抛，不尝试分配', () => {
  const header = Buffer.alloc(4)
  header.writeUInt32BE(9 * 1024 * 1024, 0)
  assert.throws(() => new FrameReader().push(header), BadFrame)
})

test('帧体不是 JSON 就抛', () => {
  const body = Buffer.from('{not json', 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  assert.throws(() => new FrameReader().push(Buffer.concat([header, body])), BadFrame)
})

test('地址解析：带不带 tcp:// 都行', () => {
  assert.deepEqual(parseTcpUrl('tcp://10.144.0.2:7777'), { host: '10.144.0.2', port: 7777 })
  assert.deepEqual(parseTcpUrl('127.0.0.1:7777'), { host: '127.0.0.1', port: 7777 })
  assert.throws(() => parseTcpUrl('nonsense'), BadFrame)
})

test('握手成功后双向收发', async () => {
  const got = []
  const server = await listenTcp({
    port: 0,
    host: '127.0.0.1',
    token: 'pair-token-1',
    onConnection: (peer) => peer.on('frame', (frame) => { got.push(frame); peer.send({ t: 'echo', n: frame.n }) }),
  })
  try {
    const client = await connectTcp({ url: `tcp://127.0.0.1:${server.port}`, token: 'pair-token-1' })
    const echoed = once(client, 'frame')
    client.send({ t: 'msg', n: 7 })
    const [frame] = await echoed
    assert.equal(frame.t, 'echo')
    assert.equal(frame.n, 7)
    assert.equal(got[0].n, 7)
    client.close()
  } finally {
    server.close()
  }
})

test('口令不对会被读成拒绝，而不是挂在那里', async () => {
  const server = await listenTcp({ port: 0, host: '127.0.0.1', token: 'right-token' })
  try {
    await assert.rejects(
      connectTcp({ url: `tcp://127.0.0.1:${server.port}`, token: 'wrong-token', timeoutMs: 2000 }),
      /node\/unauthorized|拒绝/,
    )
  } finally {
    server.close()
  }
})

test('服务端关掉，客户端收到 close', async () => {
  const server = await listenTcp({ port: 0, host: '127.0.0.1', token: 'closing-token' })
  const client = await connectTcp({ url: `tcp://127.0.0.1:${server.port}`, token: 'closing-token' })
  const closed = once(client, 'close')
  server.close()
  await closed
  assert.equal(client.closed, true)
})

test('连不上的地址会在超时内 reject', async () => {
  await assert.rejects(
    connectTcp({ url: 'tcp://127.0.0.1:1', token: 'whatever-1', timeoutMs: 800 }),
    (error) => error.code === 'ECONNREFUSED' || error.name === 'BadFrame',
  )
})
