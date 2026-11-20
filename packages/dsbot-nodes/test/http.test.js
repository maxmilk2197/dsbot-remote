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
  install(rt)
  assert.equal(typeof captured.handler, 'function', '路由没挂上')
  const server = createServer((req, res) => { void captured.handler(req, res) })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    return await fn({ base: `http://127.0.0.1:${port}`, port })
  } finally {
    await new Promise(done => server.close(done))
    await rm(home, { recursive: true, force: true })
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

test('同源 JSON POST 能过闸门（不该被 403/415 误伤）', async () => {
  await withRoutes(async ({ base }) => {
    const left = await json(base, '/api/nodes/leave', {})
    assert.equal(left.status, 200)
    assert.equal(left.body.ok, true)
  })
})
