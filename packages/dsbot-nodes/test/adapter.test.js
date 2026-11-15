// 本文件由 AI 生成，请勿用于生产环境。
// S2: the chunk sequence a remote turn produces. This is the seam that decides
// whether groups.js needs a change: if the sequence equals what LocalAgentAdapter
// emits, the group code cannot tell the difference.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createAdapterClass, renderPrompt, TurnMailbox } from '../src/host/nodes/adapter.js'

class FakeLlmAdapter { }
class FakeLlmError extends Error {
  constructor(message, code, extra = {}) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.extra = extra
  }
}

const Adapter = createAdapterClass({ LlmAdapter: FakeLlmAdapter, LlmError: FakeLlmError })

// A link whose uplink handlers the test drives directly. `call` resolves after
// the script has pushed its events, so the mailbox already holds them — the
// same ordering a real link produces (events arrive before the rpc response).
function fakeLink(script = {}) {
  const handlers = new Map()
  const sent = []
  const link = {
    sent,
    on(endpoint, handler) {
      const list = handlers.get(endpoint) ?? []
      list.push(handler)
      handlers.set(endpoint, list)
      return () => {
        const current = handlers.get(endpoint) ?? []
        const at = current.indexOf(handler)
        if (at !== -1) current.splice(at, 1)
      }
    },
    emit(endpoint, params) {
      for (const handler of [...(handlers.get(endpoint) ?? [])]) handler(params)
    },
    async call(method, params) {
      sent.push({ method, params })
      return (await script.start?.(params, link)) ?? { accepted: true }
    },
    async send(method, params) {
      sent.push({ method, params })
    },
  }
  return link
}

function makeAdapter(link, extra = {}) {
  return new Adapter({
    linkFor: () => link,
    nodes: () => ({ 'n-1': { name: '写代码那台', botId: 'b-1' } }),
    toolDefs: () => [{ name: 'post_to_group', description: '在群里发一句' }],
    cwdFor: () => String.raw`C:\work\proj`,
    audit: () => {},
    ...extra,
  })
}

async function collect(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

const turnOptions = (overrides = {}) => ({
  provider: 'node:n-1',
  model: 'default',
  sessionId: 's-1',
  messages: [
    { role: 'system', content: '你是群里的成员，说话短。' },
    { role: 'user', content: '帮我看下 D:\\work\\proj 里的测试挂了没' },
  ],
  ...overrides,
})

test('纯文本一轮：block-start / text-delta* / block-end / finish(stop)', async () => {
  const link = fakeLink({
    start: (params, self) => {
      self.emit('turn.event', { turnId: params.turnId, kind: 'delta', text: '先说' })
      self.emit('turn.event', { turnId: params.turnId, kind: 'delta', text: '一句，' })
      self.emit('turn.event', { turnId: params.turnId, kind: 'delta', text: '测试是绿的' })
      self.emit('turn.result', { turnId: params.turnId, status: 'ok' })
    },
  })
  const chunks = await collect(makeAdapter(link), turnOptions())

  assert.deepEqual(chunks.map(chunk => chunk.type), [
    'block-start', 'text-delta', 'text-delta', 'text-delta', 'block-end', 'finish',
  ])
  assert.equal(chunks[0].blockType, 'text')
  assert.equal(chunks[0].index, 0)
  assert.equal(chunks[4].block.text, '先说一句，测试是绿的')
  assert.equal(chunks[4].index, 0)
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('turn.request 带的是拼好的 prompt、工具表和 cwd', async () => {
  const link = fakeLink({
    start: (params, self) => {
      self.emit('turn.result', { turnId: params.turnId, status: 'ok', text: '好' })
    },
  })
  await collect(makeAdapter(link), turnOptions())

  const request = link.sent.find(entry => entry.method === 'turn.request')
  assert.ok(request, '必须发出 turn.request')
  assert.match(request.params.prompt, /团队指令|The team instructions/)
  assert.match(request.params.prompt, /帮我看下 D:\\work\\proj 里的测试挂了没/)
  assert.deepEqual(request.params.tools.map(tool => tool.name), ['post_to_group'])
  assert.equal(request.params.cwd, String.raw`C:\work\proj`)
  assert.equal(typeof request.params.turnId, 'string')
  assert.ok(request.params.deadlineMs > 0)
})

test('工具调用出现在文本中间：先关文本块，再出三件套，然后开新文本块', async () => {
  const link = fakeLink({
    start: (params, self) => {
      self.emit('turn.event', { turnId: params.turnId, kind: 'delta', text: '我看一下。' })
      self.emit('turn.event', {
        turnId: params.turnId, kind: 'tool-call', callId: 'c-1', name: 'post_to_group', args: { text: '在跑测试' },
      })
      self.emit('turn.event', { turnId: params.turnId, kind: 'delta', text: '绿的。' })
      self.emit('turn.result', { turnId: params.turnId, status: 'ok' })
    },
  })
  const chunks = await collect(makeAdapter(link), turnOptions())

  assert.deepEqual(chunks.map(chunk => `${chunk.type}${chunk.blockType ? `:${chunk.blockType}` : ''}`), [
    'block-start:text',
    'text-delta',
    'block-end',
    'block-start:tool-call',
    'tool-call-delta',
    'block-end',
    'block-start:text',
    'text-delta',
    'block-end',
    'finish',
  ])
  // 两个文本块各用各的 index，工具块夹在中间。
  assert.equal(chunks[0].index, 0)
  assert.equal(chunks[3].index, 1)
  assert.equal(chunks[6].index, 2)
  assert.equal(chunks[4].name, 'post_to_group')
  assert.equal(chunks[5].block.id, 'c-1')
  // 一轮里只有一个 finish，而且不是 tool-calls：远程自己跑循环。
  assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('远程一次给完整文本也能变成合法的块序列（不产生空轮次）', async () => {
  const link = fakeLink({
    start: (params, self) => {
      self.emit('turn.result', { turnId: params.turnId, status: 'ok', text: '一句话答完' })
    },
  })
  const chunks = await collect(makeAdapter(link), turnOptions())
  assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish'])
  assert.equal(chunks[1].text, '一句话答完')
})

test('失败的一轮：文本块被关掉，抛 LlmError 且带 NODE_TURN_FAILED', async () => {
  const link = fakeLink({
    start: (params, self) => {
      self.emit('turn.event', { turnId: params.turnId, kind: 'delta', text: '写到一半' })
      self.emit('turn.result', { turnId: params.turnId, status: 'error', error: '远程的模型额度用完了' })
    },
  })
  const adapter = makeAdapter(link)
  const chunks = []
  await assert.rejects(async () => {
    for await (const chunk of adapter.stream(turnOptions())) chunks.push(chunk)
  }, (error) => {
    assert.equal(error.code, 'NODE_TURN_FAILED')
    assert.match(error.message, /额度/)
    return true
  })
  // 已经吐出去的东西必须收干净，否则群里留着一个永不闭合的块。
  assert.equal(chunks.at(-1).type, 'block-end')
})

test('取消：发 turn.cancel，以 finish(aborted) 收尾，不抛', async () => {
  const link = fakeLink({
    start: (params, self) => {
      self.emit('turn.event', { turnId: params.turnId, kind: 'delta', text: '开始' })
      // 结果故意不来：这一轮等着被取消。
    },
  })
  const controller = new AbortController()
  const adapter = makeAdapter(link)
  const iterator = adapter.stream(turnOptions({ signal: controller.signal }))

  const first = await iterator.next()
  assert.equal(first.value.type, 'block-start')
  const second = await iterator.next()
  assert.equal(second.value.type, 'text-delta')

  controller.abort()
  const rest = []
  for (;;) {
    const step = await iterator.next()
    if (step.done) break
    rest.push(step.value)
  }
  assert.equal(rest.at(-1).type, 'finish')
  assert.equal(rest.at(-1).reason.kind, 'aborted')
  assert.ok(link.sent.some(entry => entry.method === 'turn.cancel'))
})

test('节点一直不回：超时抛 NODE_TIMEOUT，并通知它别干了', async () => {
  const link = fakeLink({ start: () => ({ accepted: true }) })
  const adapter = makeAdapter(link, { deadlineMs: 20 })
  await assert.rejects(
    collect(adapter, turnOptions()),
    (error) => error.code === 'NODE_TIMEOUT',
  )
  assert.ok(link.sent.some(entry => entry.method === 'turn.cancel'))
})

test('标题请求不碰网络：标题是本地从第一条用户消息里截的', async () => {
  const link = fakeLink({ start: () => assert.fail('标题不该打到节点上') })
  const chunks = await collect(makeAdapter(link), turnOptions({ purpose: 'session-title' }))
  assert.equal(link.sent.length, 0)
  assert.equal(chunks[1].text, '帮我看下 D:\\work\\proj 里的测试挂了没'.slice(0, 60))
})

test('压缩请求也不碰网络，给的是本地摘要', async () => {
  const link = fakeLink({ start: () => assert.fail('压缩不该打到节点上') })
  const chunks = await collect(makeAdapter(link), turnOptions({ purpose: 'compaction' }))
  assert.equal(link.sent.length, 0)
  assert.match(chunks[1].text, /Earlier conversation, condensed/)
})

test('文件路径被带回主机（真字节走 node-file-push，不在这条流里）', async () => {
  const seen = []
  const link = fakeLink({
    start: (params, self) => {
      self.emit('turn.event', { turnId: params.turnId, kind: 'file', path: String.raw`C:\work\proj\report.csv` })
      self.emit('turn.event', { turnId: params.turnId, kind: 'delta', text: '报告发你了' })
      self.emit('turn.result', { turnId: params.turnId, status: 'ok' })
    },
  })
  const adapter = makeAdapter(link, { onTurnFiles: payload => seen.push(payload) })
  await collect(adapter, turnOptions())
  assert.deepEqual(seen[0].files, [String.raw`C:\work\proj\report.csv`])
})

test('落盘回来的链接接在这一轮话后面，另开一个文本块而不是另起一轮', async () => {
  const link = fakeLink({
    start: (params, self) => {
      self.emit('turn.event', { turnId: params.turnId, kind: 'delta', text: '报告发你了' })
      self.emit('turn.result', {
        turnId: params.turnId,
        status: 'ok',
        files: [{ name: '报告.txt', data: 'aGVsbG8=' }],
      })
    },
  })
  const adapter = makeAdapter(link, { onTurnFiles: () => '\n\n[报告.txt](D:/out/报告.txt)' })
  const chunks = await collect(adapter, turnOptions())

  const texts = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert.equal(texts, '报告发你了\n\n[报告.txt](D:/out/报告.txt)')
  assert.equal(chunks.filter(chunk => chunk.type === 'block-start').length, 2, '两个文本块')
  const last = chunks.at(-1)
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.kind, 'stop')

  // 回调拿得到原始文件对象：落盘要看名字与字节，而不是一条已经拼好的路径。
  assert.equal(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text.includes('报告.txt')), true)
})

test('providerInfo / listModels 说得出一台节点，且不假装知道它的模型', async () => {
  const adapter = makeAdapter(fakeLink())
  assert.deepEqual(adapter.providerInfo('node:n-1'), { id: 'node:n-1', name: '写代码那台' })
  assert.equal(adapter.providerInfo('node:gone').name, 'node:gone')
  const models = await adapter.listModels('node:n-1')
  assert.equal(models.length, 1)
  assert.equal(models[0].id, 'default')
  assert.deepEqual(await adapter.listModels('node:gone'), [])
})

test('renderPrompt：最新一条完整，旧消息被截，系统指令只出现一次', () => {
  const long = 'x'.repeat(5_000)
  const prompt = renderPrompt([
    { role: 'system', content: '系统指令' },
    { role: 'user', content: long },
    { role: 'assistant', content: '好' },
    { role: 'user', content: '最后这句' },
  ], '系统指令')
  assert.equal(prompt.match(/系统指令/g).length, 1)
  assert.ok(prompt.includes('最后这句'))
  assert.ok(prompt.indexOf('User: 有好'.slice(0, 1)) !== -1)
  // 5,000 字的那条被截到 2,000
  assert.equal(prompt.includes('x'.repeat(2_001)), false)
  assert.equal(prompt.includes('x'.repeat(2_000)), true)
})

test('邮箱：关掉后 next 立刻返回 closed，迟到的事件不再堆积', async () => {
  const mailbox = new TurnMailbox()
  mailbox.push({ kind: 'x' })
  assert.deepEqual(await mailbox.next(), { kind: 'x' })
  mailbox.close()
  assert.deepEqual(await mailbox.next(), { kind: 'closed' })
  mailbox.push({ kind: 'late' })
  assert.deepEqual(await mailbox.next(), { kind: 'closed' })
})
