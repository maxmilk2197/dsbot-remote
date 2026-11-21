// 本文件由 AI 生成，请勿用于生产环境。
// 等不到 bot 服务时，设置页不该只剩一句 HTTP 404：至少要能读出"卡在哪一步"，
// 并且能点一下「立即挂载」再催一次。
process.env.DSBOT_NODES_TEST = '1'
process.env.DSBOT_NODES_DELAY_MS = '0'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const call = (handler, method, path) => new Promise((resolve, reject) => {
  const req = {
    method,
    url: path,
    headers: { host: '127.0.0.1:51234', 'content-type': 'application/json' },
    on() {},
    destroy() {},
  }
  const res = {
    statusCode: 0,
    setHeader() {},
    end(body) {
      try { resolve({ status: this.statusCode, body: JSON.parse(body) }) } catch (error) { reject(error) }
    },
  }
  Promise.resolve(handler(req, res)).catch(reject)
})

test('等不到 bot 服务时，状态口仍然可读，且能催一次挂载', async () => {
  const home = await mkdtemp(join(tmpdir(), 'early-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { apply, resetInstall } = await import('../src/host/nodes/index.js')
    resetInstall?.()
    const registered = []
    const ctx = {
      // 只给 webServer：拿不到 'bot'，走的正是"等不到服务"那条路。
      get: service => (service === 'webServer' ? { register: options => { registered.push(options); return () => {} } } : undefined),
      inject: () => {},
      effect: () => {},
    }
    apply(ctx, {})
    await new Promise(resolve => setTimeout(resolve, 50))
    const early = registered.find(each => each.path === '/api/nodes')
    assert.ok(early, '没挂上早期路由')

    const status = await call(early.handler, 'GET', '/api/nodes/status')
    assert.equal(status.status, 200)
    assert.equal(status.body.pending, true)
    assert.equal(status.body.hosting, false)
    assert.match(String(status.body.reason), /bot 服务|挂载/)

    const mount = await call(early.handler, 'POST', '/api/nodes/mount')
    assert.equal(mount.status, 200)
    assert.equal(mount.body.ok, true)
    assert.equal(mount.body.trying, true)

    // 早期路由只回答这两条，别的一律 503，不假装自己是完整接口。
    const other = await call(early.handler, 'GET', '/api/nodes/rotate')
    assert.equal(other.status, 503)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})
