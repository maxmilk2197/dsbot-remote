import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install } from './src/host/nodes/index.js'

const home = await mkdtemp(join(tmpdir(), 'turn-'))
const rt = {
  home,
  readOnly: () => false,
  warn: (...a) => console.error('warn:', ...a),
  ctx: { effect: () => {}, llm: { registerAdapter: () => { const f = () => {}; f.replace = () => {}; return f } } },
}
const api = install(rt)
const { nodeId } = await api.connect({ url: 'tcp://127.0.0.1:7797', token: 'turn-token-1' })
console.log('节点        :', nodeId, api.list()[0].caps.join(','))

const link = api.linkFor(nodeId)
const events = []
let settle
const resultPromise = new Promise(resolve => { settle = resolve })
link.on('turn.event', params => events.push(params))
link.on('turn.result', params => settle(params))

const started = await api.call(nodeId, 'turn.request', {
  turnId: 't1',
  prompt: '你在群里，帮我看一下这个需求：把首页的加载时间压到 1 秒内',
  tools: [],
  cwd: 'D:/Default',
  deadlineMs: 20000,
})
console.log('回执        :', JSON.stringify(started))

const result = await Promise.race([resultPromise, new Promise(r => setTimeout(() => r({ status: 'timeout' }), 15000))])
console.log('流式事件    :', events.length, '段 ->', JSON.stringify(events.map(e => e.text)))
console.log('拼起来      :', JSON.stringify(events.map(e => e.text).join('')))
console.log('结果        :', result.status, JSON.stringify(result.text))
process.exit(0)
