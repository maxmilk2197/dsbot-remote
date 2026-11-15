// 契约探针：拿宿主真实的 LlmAdapter 基类 + 真实的 BlockAssembler 去喂我们自己的 chunk。
// 这一步比单测硬：单测证明"我们按约定发"，这里证明"宿主按约定收得下"。
import { BlockAssembler, LlmAdapter, LlmError } from 'file:///D:/Dsh/resources/app/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
import { createAdapterClass } from './src/host/nodes/adapter.js'

const Adapter = createAdapterClass({ LlmAdapter, LlmError })

let turnId
const handlers = new Map()
const link = {
  on(endpoint, handler) {
    if (!handlers.has(endpoint)) handlers.set(endpoint, new Set())
    handlers.get(endpoint).add(handler)
    return () => handlers.get(endpoint).delete(handler)
  },
  async call(_method, params) {
    turnId = params.turnId
    return { accepted: true }
  },
  async send() {},
}
const emit = (endpoint, params) => {
  for (const handler of handlers.get(endpoint) ?? []) handler(params)
}

const adapter = new Adapter({
  linkFor: () => link,
  nodes: () => ({ 'n-1': { id: 'n-1', name: '写代码那台' } }),
  toolDefs: () => [],
  cwdFor: () => undefined,
  deadlineMs: 30_000,
})

console.log('providerInfo:', adapter.providerInfo('node:n-1'))
console.log('listModels:', adapter.listModels('node:n-1'))

const chunks = []
const stream = adapter.stream({
  sessionId: 's-1',
  provider: 'node:n-1',
  model: 'default',
  messages: [{ role: 'user', content: '帮我看一下首页的加载时间' }],
  signal: new AbortController().signal,
})

// async generator 是惰性的：要先开始消费，turn.request 才会发出去。
const drained = (async () => { for await (const chunk of stream) chunks.push(chunk) })()
await new Promise(resolve => setTimeout(resolve, 20))
console.log('turnId:', turnId, 'handlers:', [...handlers.keys()])
emit('turn.event', { turnId, kind: 'delta', text: '好的，' })
emit('turn.event', { turnId, kind: 'delta', text: '我看一下。' })
emit('turn.result', { turnId, status: 'ok', text: '好的，我看一下。' })

const timeout = new Promise(resolve => setTimeout(() => resolve('timeout'), 2000))
console.log('drain:', await Promise.race([drained.then(() => 'done'), timeout]))

console.log('chunks:', chunks.map(c => c.type === 'text-delta' ? `${c.type}(${c.text})` : c.type).join(' → '))

// 宿主的组装器：不合格的序列会在这里抛，或拼出半截 block。
const assembler = new BlockAssembler()
for (const chunk of chunks) assembler.push(chunk)
const partials = assembler.partials
console.log('blocks:', [...partials.values()].map(p => `${p.blockType}:${p.text ?? ''}`))
console.log('finish:', JSON.stringify(assembler._finish))
