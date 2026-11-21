// 本文件由 AI 生成，请勿用于生产环境。
// S5: 两台机器之间的管子。粘包、半包、坏帧、口令错、对面挂掉。
// 这些是"跨地区跑一整轮"之前必须确定的事 —— 帧边界错了，上面所有协议都白搭。
import assert from 'node:assert/strict'
import test from 'node:test'
import net from 'node:net'
import { once } from 'node:events'
import { BadFrame, FrameReader, Peer, connectTcp, encodeFrame, listenTcp, parseTcpUrl } from '../src/transport/tcp.js'

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
      /node\/unauthorized|拒绝|配对码/,
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

// 一条连接上的 bug 不该升级成"整个应用退出"。
// tcp.js 的 data / close 监听是跑在 net 的事件循环里的：监听器抛出来的异常会变成
// uncaughtException，宿主直接没了。这里确认它只上报，管子还能继续用。
test('帧监听器抛错：只上报 listener-error，连接还能用', async () => {
  const reported = []
  const server = await listenTcp({
    port: 0,
    host: '127.0.0.1',
    token: 'boom-token-1',
    onConnection: (peer) => {
      peer.on('listener-error', (error) => reported.push(error.message))
      peer.on('frame', (frame) => {
        if (frame.method === 'boom') throw new Error('handler boom')
        peer.send({ id: frame.id, result: { echo: frame.method } })
      })
    },
  })
  const client = await connectTcp({ url: `tcp://127.0.0.1:${server.port}`, token: 'boom-token-1' })
  try {
    const answered = new Promise((resolve) => {
      client.on('frame', (frame) => { if (frame.id === 'second') resolve(frame) })
    })
    client.send({ id: 'first', method: 'boom' })
    client.send({ id: 'second', method: 'still-alive' })

    const frame = await answered
    assert.deepEqual(frame.result, { echo: 'still-alive' })
    assert.deepEqual(reported, ['handler boom'])
    assert.equal(client.closed, false)
  } finally {
    client.close()
    server.close()
  }
})

// 空闲的管子会自杀：idleMs 到点就 close，而没人主动发帧。
// 实测就是"连上 60 秒后自己断开"。心跳必须在协议层，两端都要有。
test('空闲连接靠心跳活着，不会被自己掐死', async () => {
  const server = await listenTcp({ port: 0, host: '127.0.0.1', token: 'beat-token-1', idleMs: 300 })
  const client = await connectTcp({ url: `tcp://127.0.0.1:${server.port}`, token: 'beat-token-1', idleMs: 300 })
  const closed = []
  client.on('close', () => closed.push(Date.now()))
  try {
    // 四个 idle 周期，一个业务帧都没有。
    await new Promise(done => setTimeout(done, 1200))
    assert.equal(closed.length, 0, '空闲不该断线')
    assert.equal(client.closed, false)
  } finally {
    client.close()
    server.close()
  }
})

test('装上密钥之后，线路上抓不到明文（AES-256-GCM）', async () => {
  const key = Buffer.alloc(32, 7)
  const got = []
  const server = net.createServer(socket => {
    const peer = new Peer(socket)
    peer.setCipher(key)
    peer.on('frame', frame => got.push(frame))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const socket = net.connect(server.address().port, '127.0.0.1')
  const chunks = []
  socket.on('data', buf => chunks.push(buf))
  await once(socket, 'connect')
  const peer = new Peer(socket)
  peer.setCipher(key)
  try {
    peer.send({ method: 'group.line', text: 'sesame-plaintext' })
    await new Promise(done => setTimeout(done, 150))
    const raw = Buffer.concat(chunks).toString('utf8')
    assert.equal(raw.includes('sesame-plaintext'), false, '线上不该出现消息正文')
    assert.equal(raw.includes('group.line'), false, '方法名也不该是明文')
    assert.equal(got.length, 1)
    assert.equal(got[0].text, 'sesame-plaintext')
  } finally {
    peer.close()
    socket.destroy()
    server.close()
  }
})

test('对面直接断线（拉黑 / 没起来）：握手立刻报错，不等 5 秒超时', async () => {
  const server = net.createServer(socket => socket.destroy())
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const started = Date.now()
  try {
    await assert.rejects(
      connectTcp({ url: `tcp://127.0.0.1:${server.address().port}`, token: 'ABCDEFGH', timeoutMs: 5_000 }),
      error => /断了|口令|拒绝/.test(String(error.message ?? '')),
    )
    assert.ok(Date.now() - started < 2_000, '不该等满 timeoutMs 才报')
  } finally {
    server.close()
  }
})

test('单帧超限：send 回 false 而不抛（抛出去就是宿主的 fatal）', async () => {
  const server = net.createServer(() => {})
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const socket = net.connect(server.address().port, '127.0.0.1')
  await once(socket, 'connect')
  const peer = new Peer(socket)
  const errors = []
  peer.on('listener-error', error => errors.push(error.message))
  try {
    const sent = peer.send({ text: 'x'.repeat(9 * 1024 * 1024) })
    assert.equal(sent, false)
    assert.equal(errors.length, 1)
    assert.match(errors[0], /too large/)
  } finally {
    peer.close()
    socket.destroy()
    server.close()
  }
})
