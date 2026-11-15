// 装车探针：用宿主真的 cordis Context + 真的 llm 服务去跑 install(rt)。
// 单测里的 ctx.llm 是个假对象，这里是真的 LlmRuntime —— 它会在注册时校验
// providerInfo 的形状、route 的唯一性，以及 adapter 是不是真的 LlmAdapter 实例。
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { apply, install } from './src/host/nodes/index.js'

const ctx = new Context()
const registered = []
ctx.tools = {
  register(definition) {
    registered.push(definition.name)
    return () => {}
  },
}

ctx.plugin(LlmRuntime)
await new Promise(resolve => setTimeout(resolve, 200))

if (ctx.llm === undefined) {
  console.log('宿主 llm 服务没起来 —— LlmRuntime 还依赖别的服务，探针到此为止')
  process.exit(2)
}
console.log('llm 服务:', typeof ctx.llm.registerAdapter, '| listProviders:', typeof ctx.llm.listProviders)

const home = await mkdtemp(join(tmpdir(), 'install-'))
const state = { bots: {}, rooms: { g1: { id: 'g1', name: '赚钱小组', members: [] } } }

const rt = {
  ctx,
  state,
  home,
  warn: (...args) => console.log('[warn]', ...args.map(String)),
  readOnly: () => undefined,
  roomOf: id => state.rooms[id],
  botOf: id => (id === undefined ? undefined : state.bots[id]),
}

// ds-bot 在 createRuntime 里做的事：把运行时挂成服务。宿主调的是 apply(ctx)。
ctx.provide('bot', rt)
apply(ctx)
// apply 现在只做运行时订阅：等子 fiber 起来，install 才会真的跑。
await new Promise(resolve => setTimeout(resolve, 120))
const api = rt.nodesApi
if (api === undefined) { console.log('install 没跑：deps 没就绪'); process.exit(3) }
console.log('install 返回:', Object.keys(api).join(','))
console.log('工具注册:', registered.join(',') || '（没有）')

// 一个节点上线后，route 要能进 llm 的 provider 表。
const node = await api.store.add({ name: '写代码那台', deviceId: 'd-probe-1' })
console.log('节点:', node.id)

// syncRoutes 只在连接/断线时跑；这里直接调一次注册路径，等价于"一台机器连上了"。
api.store.update(node.id, { status: 'online', caps: ['exec'] })
const providers = await ctx.llm.listProviders?.()
console.log('provider 表:', Array.isArray(providers) ? providers.map(p => p.id ?? p).join(',') : typeof providers)

// 能不能像 ds-bot 那样按 ref 解析出一条模型（这是建代理 Bot 成功的判据）。
if (typeof ctx.llm.resolveModel === 'function') {
  try {
    const hit = await ctx.llm.resolveModel(`node:${node.id}/default`)
    console.log('resolveModel:', JSON.stringify(hit))
  } catch (error) {
    console.log('resolveModel 失败:', error.message)
  }
}

await api.store.flush?.()
for (let i = 0; i < 3; i += 1) {
  try { await rm(home, { recursive: true, force: true }); break } catch { await new Promise(r => setTimeout(r, 50)) }
}
