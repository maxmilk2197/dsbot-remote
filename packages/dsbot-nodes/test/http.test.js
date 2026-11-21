// 本文件由 AI 生成，请勿用于生产环境。
// 设置页的接口挂在 DSH 的 web server 上：任何网页都能对着 127.0.0.1 发 no-cors POST。
// 这组用例把入口那道闸门钉死在真 HTTP 上：同源、Host、content-type、配对码默认不下发。
process.env.DSBOT_NODES_TEST = '1'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install, redactCode, resetInstall } from '../src/host/nodes/index.js'

const makeRt = async () => {
  resetInstall()
  // 路由是进程级的：第一个用例挂上之后 routeState().mounted 就是 true，
  // 后面每个用例都得把它清回 false，否则会以为"没挂上"。
  globalThis[Symbol.for('dsbot-nodes.routes/v1')] = { mounted: false, unregister: null, current: null }
  const home = await mkdtemp(join(tmpdir(), 'http-'))
  const captured = { handler: null }
  const rt = {
    home,
    readOnly: () => false,
    warn: () => {},
    ctx: {
      effect: () => {},
      llm: { registerAdapter: () => () => {} },
      webServer: { register: route => { captured.handler = route.handler; return () => {} } },
    },
  }
  return { rt, home, captured }
}

const withRoutes = async (fn) => {
  const { rt, home, captured } = await makeRt()
  const installed = install(rt)
  assert.equal(typeof captured.handler, 'function', '路由没挂上')
  const server = createServer((req, res) => { void captured.handler(req, res) })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    return await fn({ base: `http://127.0.0.1:${port}`, port })
  } finally {
    await new Promise(done => server.close(done))
    // 插件自己还有异步尾巴（store 落盘、hosting 收尾）：先让它停，再删目录。
    try { await installed?.dispose?.() } catch {}
    // Windows 上刚关掉的文件偶尔还占着句柄，rm 会报 ENOTEMPTY；重试几次就好。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { await rm(home, { recursive: true, force: true }); break } catch { await new Promise(done => setTimeout(done, 50)) }
    }
  }
}

const json = async (base, path, body, headers = {}) => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  })
  return { status: response.status, body: await response.json() }
}

// Host 头 fetch 不让改，只能走底层 request。
const rawGet = (port, path, headers) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, res => {
    let raw = ''
    res.on('data', chunk => { raw += chunk })
    res.on('end', () => resolve({ status: res.statusCode, body: raw }))
  })
  req.on('error', reject)
  req.end()
})

test('配对码默认不下发：redactCode 只在 reveal 时保留', () => {
  const state = { hosting: true, code: 'J9THU3F8' }
  const hidden = redactCode(state, false)
  assert.equal(hidden.code, undefined)
  assert.equal(hidden.codeHidden, true)
  const shown = redactCode(state, true)
  assert.equal(shown.code, 'J9THU3F8')
  assert.equal(shown.codeVisible, true)
  // 原始对象不能被改掉：别处还要用它
  assert.equal(state.code, 'J9THU3F8')
  // 没起来的时候没有 code，也就没有 codeHidden
  assert.deepEqual(redactCode({ hosting: false }, false), { hosting: false })
})

test('状态口在真 HTTP 上能读', async () => {
  await withRoutes(async ({ base }) => {
    const plain = await fetch(base + '/api/nodes/status').then(async r => ({ status: r.status, body: await r.json() }))
    assert.equal(plain.status, 200)
    assert.equal(plain.body.ok, true)
  })
})

// 跨网组件缺没缺，界面得知道 —— 以前只能看日志，页面永远停在「正在进虚拟网…」。
test('状态里带 EasyTier 组件的现状', async () => {
  await withRoutes(async ({ base }) => {
    const body = await fetch(base + '/api/nodes/status').then(r => r.json())
    assert.equal(typeof body.easytier, 'object')
    assert.ok(['unknown', 'checking', 'downloading', 'ready', 'missing', 'error'].includes(body.easytier.state))
    assert.equal(typeof body.easytier.dir, 'string')
    assert.equal(typeof body.easytier.version, 'string')
  })
})

test('「下载 / 重试」打的那个口通着', async () => {
  await withRoutes(async ({ base }) => {
    const result = await json(base, '/api/nodes/network', {})
    assert.equal(result.status, 200)
    assert.equal(typeof result.body, 'object')
  })
})

test('外站 Origin 被挡：本机页面才准改设置', async () => {
  await withRoutes(async ({ base }) => {
    const response = await fetch(base + '/api/nodes/status', { headers: { origin: 'https://evil.example' } })
    assert.equal(response.status, 403)
    assert.match(String((await response.json()).error), /Origin/)
  })
})

test('Sec-Fetch-Site: cross-site 被挡', async () => {
  await withRoutes(async ({ base }) => {
    const response = await fetch(base + '/api/nodes/status', { headers: { 'sec-fetch-site': 'cross-site' } })
    assert.equal(response.status, 403)
  })
})

test('Host 不是本机名字：挡掉 DNS rebinding', async () => {
  await withRoutes(async ({ port }) => {
    const evil = await rawGet(port, '/api/nodes/status', { host: 'evil.example' })
    assert.equal(evil.status, 403)
    const ok = await rawGet(port, '/api/nodes/status', { host: `127.0.0.1:${port}` })
    assert.equal(ok.status, 200)
  })
})

test('POST 不收 text/plain：no-cors 的"简单请求"进不来', async () => {
  await withRoutes(async ({ base }) => {
    const response = await fetch(base + '/api/nodes/rename', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"name":"x"}',
    })
    assert.equal(response.status, 415)
  })
})

test('带 agent 的加入必须 confirm: true，否则拦在 spawn 之前', async () => {
  await withRoutes(async ({ base }) => {
    const denied = await json(base, '/api/nodes/join', { code: 'ABCDEFGH', agent: 'node -e ""' })
    assert.equal(denied.status, 403)
    assert.match(String(denied.body.error), /confirm/)
    const tooLong = await json(base, '/api/nodes/join', { code: 'ABCDEFGH', agent: 'x'.repeat(201), confirm: true })
    assert.equal(tooLong.status, 400)
  })
})

test('web server 换了（DSH 重启 web 服务）：路由要重挂到新实例上', async () => {
  resetInstall()
  globalThis[Symbol.for('dsbot-nodes.routes/v1')] = undefined
  const home = await mkdtemp(join(tmpdir(), 'http-swap-'))
  const makeServer = () => {
    const cap = { handler: null, unregistered: 0 }
    return {
      cap,
      server: { register: route => { cap.handler = route.handler; return () => { cap.unregistered += 1 } } },
    }
  }
  const rtFor = server => ({
    home,
    readOnly: () => false,
    warn: () => {},
    ctx: { effect: () => {}, llm: { registerAdapter: () => () => {} }, webServer: server },
  })
  const first = makeServer()
  const a = install(rtFor(first.server))
  try {
    assert.equal(typeof first.cap.handler, 'function', '第一台 web server 没挂上')
    resetInstall()
    const second = makeServer()
    const b = install(rtFor(second.server))
    assert.equal(typeof second.cap.handler, 'function', '换了 web server 之后没重挂：设置页会一直 404')
    assert.equal(first.cap.unregistered, 1, '旧 server 上的注册没有撤销')
    await b?.dispose?.()
  } finally {
    try { await a?.dispose?.() } catch {}
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { await rm(home, { recursive: true, force: true }); break } catch { await new Promise(done => setTimeout(done, 50)) }
    }
  }
})

test('同源 JSON POST 能过闸门（不该被 403/415 误伤）', async () => {
  await withRoutes(async ({ base }) => {
    const left = await json(base, '/api/nodes/leave', {})
    assert.equal(left.status, 200)
    assert.equal(left.body.ok, true)
  })
})
