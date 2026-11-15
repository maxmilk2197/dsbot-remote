// 复现 Bot 的 connect 失败：真 cordis + 真 LlmRuntime，走 api.connect。
import { Context } from 'file:///D:/Dsh/resources/app/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'probe-connect-'))
const ctx = new Context()
ctx.plugin((await import('file:///D:/Dsh/resources/app/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js')).default)
const plugin = await import('./src/host/nodes/index.js')
const state = { bots: {}, rooms: {}, sessions: {} }
plugin.apply(ctx, {})
await new Promise(r => setTimeout(r, 150))
const rt = {
  ctx, dshHome: home, home, statePath: join(home, 'state.json'), teamTools: [], defaults: {},
  state, save: async () => {}, readOnly: () => undefined, warn: () => {},
  botOf: id => state.bots[id], roomOf: id => state.rooms[id],
}
// 直接调 install 拿 api（绕过依赖等待）
const api = plugin.install(rt)
try {
  const got = await api.connect({ url: 'tcp://127.0.0.1:7841', token: 'test-123456' })
  console.log('connect 成功:', JSON.stringify(got))
  console.log('list:', JSON.stringify(api.list()))
} catch (error) {
  console.log('connect 失败:', error.code ?? error.name, '|', error.message)
  console.log('stack:', String(error.stack).split('\n').slice(0, 4).join(' / '))
}
await rm(home, { recursive: true, force: true })
process.exit(0)
