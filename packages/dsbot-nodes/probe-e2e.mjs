import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install } from './src/host/nodes/index.js'

const home = await mkdtemp(join(tmpdir(), 'e2e-'))
const registered = []
const rt = {
  home,
  readOnly: () => false,
  warn: (...a) => console.error('warn:', ...a),
  ctx: { effect: () => {}, llm: { registerAdapter(routes, adapter) {
    const e = { routes: [...routes], adapter }
    registered.push(e)
    const f = () => {}
    f.replace = next => { e.routes = [...next] }
    return f
  } } },
}
const api = install(rt)
const { nodeId } = await api.connect({ url: 'tcp://127.0.0.1:7795', token: 'e2e-token-123' })
const node = api.list()[0]
console.log('nodeId    :', nodeId)
console.log('name      :', node.name)
console.log('status    :', node.status)
console.log('caps      :', node.caps.join(','))
console.log('routes    :', registered.at(-1).routes.join(','))
const env = await api.call(nodeId, 'node.exec', { action: 'env_info' })
console.log('env_info  :', env.ok, String(env.output ?? '').split('\n')[0])
const sh = await api.call(nodeId, 'node.exec', { action: 'run_shell', args: { command: 'echo hello-from-remote && node -v' } })
console.log('run_shell :', sh.ok, JSON.stringify(String(sh.output ?? '').trim()))
process.exit(0)
