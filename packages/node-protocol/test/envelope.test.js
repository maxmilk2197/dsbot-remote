// 本文件由 AI 生成，请勿用于生产环境。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUSINESS_METHODS,
  METHODS,
  PROTOCOL_VERSION,
  encodeFrame,
  event,
  parseFrame,
  request,
  response,
  errorFrame,
  NodeFailure,
  outboundMethods,
  directionAllows,
} from '../src/index.js'

test('十个业务事件，名字与方向都在', () => {
  assert.equal(BUSINESS_METHODS.length, 10)
  for (const name of BUSINESS_METHODS) {
    const spec = METHODS[name]
    assert.ok(['node→host', 'host→node', 'both'].includes(spec.direction), `${name} direction`)
    assert.ok(spec.params !== undefined, `${name} params`)
  }
  // 第 10 类必须是 approval：它是"人类批一下"的唯一出口。
  assert.ok(BUSINESS_METHODS.includes('node.approval'))
})

test('request 往返：编码后能被对端解析回来', () => {
  const frame = request({ method: 'turn.request', params: { turnId: 't-1', prompt: '你好' }, groupId: 'g-1', cursor: 7 })
  assert.equal(frame.proto, PROTOCOL_VERSION)
  const parsed = parseFrame(encodeFrame(frame))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.frame.method, 'turn.request')
  assert.equal(parsed.frame.params.prompt, '你好')
  assert.equal(parsed.frame.cursor, 7)
})

test('response 与 error 的形状', () => {
  const ok = parseFrame(encodeFrame(response('r-1', { accepted: true })))
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.frame.result, { accepted: true })

  const bad = parseFrame(encodeFrame(errorFrame('r-2', new NodeFailure('node/offline'))))
  assert.equal(bad.ok, true)
  assert.equal(bad.failure.code, 'node/offline')
  assert.equal(bad.failure.retry, false)
})

test('event 不需要 proto，也不期待响应', () => {
  const frame = event({ method: 'turn.event', params: { turnId: 't-1', kind: 'delta', text: '先' }, cursor: 8 })
  assert.equal(frame.proto, undefined)
  const parsed = parseFrame(encodeFrame(frame))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.frame.params.kind, 'delta')
})

test('坏帧被逐条拒绝，且每种都有明确的错误码', () => {
  assert.equal(parseFrame('').error.code, 'node/bad-params')
  assert.equal(parseFrame('{oops').error.code, 'node/bad-params')
  assert.equal(parseFrame('[]').error.code, 'node/bad-params')
  assert.equal(parseFrame(JSON.stringify({ type: 'noise', id: 'x' })).error.code, 'node/bad-params')
  assert.equal(parseFrame(JSON.stringify({ type: 'rpc.request', method: 'x.y', params: {}, id: '' })).error.code, 'node/bad-params')
  assert.equal(
    parseFrame(JSON.stringify({ type: 'rpc.request', id: 'r-1', method: 'turn.nope', params: {}, proto: 1 })).error.code,
    'node/unknown-method',
  )
})

test('proto 不匹配被拒，且是 terminal', () => {
  const frame = { ...request({ method: 'node.hello', params: { proto: 99, nodeName: 'b', botId: 'x', botName: 'B' } }), proto: 99 }
  const parsed = parseFrame(JSON.stringify(frame))
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error.code, 'node/proto-mismatch')
  assert.equal(new NodeFailure('node/proto-mismatch').terminal, true)
})

test('缺必填字段时错误里带路径与类型', () => {
  const parsed = parseFrame(JSON.stringify({
    type: 'rpc.request', id: 'r-1', method: 'turn.request', params: { turnId: 5 }, proto: 1,
  }))
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error.code, 'node/bad-params')
  assert.match(parsed.error.message, /turnId/)
  assert.match(parsed.error.message, /另有 1 处/)
  const paths = parsed.error.details.problems.map(problem => problem.path)
  assert.ok(paths.includes('prompt'))
  assert.ok(paths.includes('turnId'))
})

test('超长帧在解析前就被拒（不先 JSON.parse 一个 4MB 的垃圾）', () => {
  const huge = 'x'.repeat(4 * 1024 * 1024 + 1)
  const parsed = parseFrame(JSON.stringify({ type: 'event', id: 'e-1', method: 'node.presence', params: { state: 'online' }, pad: huge }))
  assert.equal(parsed.ok, false)
  assert.match(parsed.error.message, /over the/)
})

test('方向表：远程发不出主机专属方法，主机发不出远程专属方法', () => {
  assert.equal(directionAllows('node.exec', 'host→node'), true)
  assert.equal(directionAllows('node.exec', 'node→host'), false)
  assert.equal(directionAllows('node.post', 'node→host'), true)
  assert.equal(directionAllows('node.post', 'host→node'), false)
  assert.equal(directionAllows('node.approval', 'node→host'), true)
  assert.equal(directionAllows('node.approval', 'host→node'), true)
  assert.equal(directionAllows('turn.cancel', 'host→node'), true)
})

test('两端的方法清单都不为空，且各自包含自己的入口', () => {
  const fromNode = outboundMethods('node→host')
  const fromHost = outboundMethods('host→node')
  assert.ok(fromNode.includes('node.hello'))
  assert.ok(fromNode.includes('node.post'))
  assert.ok(fromHost.includes('turn.request'))
  assert.ok(fromHost.includes('group.line'))
  assert.equal(fromNode.includes('node.exec'), false)
})
