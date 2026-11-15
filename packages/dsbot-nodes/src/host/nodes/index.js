// 本文件由 AI 生成，请勿用于生产环境。
// 主机侧接线：把另一台机器上的 Bot 变成 DS Bot 里的一条 Bot。
//
// 这个模块不做"消息转发"。它只做三件事：
//   1. 管 TCP 连接 —— 谁在线、谁断了、断线后怎么重连
//   2. 把 `node:<id>` 注册成一个 LLM provider（chunk 语义交给 adapter.js）
//   3. 把两边的帧对上 —— request/response 配对，event 分发
//
// 群的发言顺序、审批、转录仍然由 groups.js 全权处理：它看到的就是一条普通 Bot，
// 只不过这条 Bot 的 model 指向另一台机器。这是 DESIGN §3 的结论，也是这里
// 一行都不碰 groups.js 的原因。
// 宿主的真实类。测试与"还没装宿主"的环境里退化成替身：adapter 只要求这两个
// 名字存在，chunk 契约由 adapter.test.js 用假基类单独验证。
let LlmAdapter
let LlmError
try {
  ({ LlmAdapter, LlmError } = await import('@deepseek-ai/dsh-llm'))
} catch {
  LlmAdapter = class {}
  LlmError = class extends Error {
    constructor(message, code, extra) {
      super(message)
      this.code = code
      this.extra = extra
    }
  }
}
// 工具表。宿主里它是真的 defineTool；单测里没有宿主，退化成恒等函数 ——
// 这里只用到它把参数表原样带上，没有别的语义。
let defineTool
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'))
} catch {
  defineTool = definition => definition
}
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bindNodeToGroup, forgetNode, unbindNodeFromGroup } from './bind.js'
import { createAdapterClass, routeOf } from './adapter.js'
import { acceptUpload } from './files.js'
import { createNodeStore } from './store.js'
import { createHosting } from './hosting.js'
import { createJoiner } from './join.js'
import { connectTcp } from '@dsbot/node-protocol/tcp'

export const name = 'dsbot-nodes'
export const inject = []

const HELLO_TIMEOUT_MS = 8_000
const CALL_TIMEOUT_MS = 60_000

// 装车自证：三个点各写一行，卡在哪一段一眼就能看出来
// （模块 import 了没有 / apply 被调了没有 / install 拿没拿到运行时）。
function bootNote(text) {
  try {
    const base = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'bot') : join(homedir(), '.dsh', 'bot')
    mkdirSync(base, { recursive: true })
    appendFileSync(join(base, 'nodes-boot.log'), `${new Date().toISOString()} ${text}
`)
  } catch {}
}

bootNote('module imported')

export function install(rt) {
  bootNote('install')

  const { ctx } = rt
  const warn = typeof rt.warn === 'function' ? rt.warn : () => {}

  // 约定（store.js:32）：readOnly() 返回 undefined 表示可写，返回原因字符串表示只读。
  // 传成 false 会被当成"只读"，然后所有写操作都抛 node/read-only。
  const store = createNodeStore({
    home: rt.home,
    readOnly: () => {
      const reason = typeof rt.readOnly === 'function' ? rt.readOnly() : undefined
      // store 的约定是"undefined 才可写"，而 rt.readOnly() 这边可能是布尔：
      // false 要翻成 undefined，否则整台机器被当成只读。
      if (reason === undefined || reason === false) return undefined
      if (reason === true) return '只读'
      return reason
    },
    warn,
  })
  const peers = new Map()      // nodeId -> peer（一条长活 TCP）
  const waiters = new Map()    // 帧 id -> {resolve, reject, timer}
  const listeners = new Map()  // `${nodeId}\u0000${endpoint}` -> Set<handler>
  let counter = 0

  const keyOf = (nodeId, endpoint) => `${nodeId}\u0000${endpoint}`
  const nextId = () => `h${(counter += 1)}`

  const emit = (nodeId, endpoint, params) => {
    const set = listeners.get(keyOf(nodeId, endpoint))
    if (set === undefined) return
    for (const handler of set) {
      try { handler(params) } catch (error) { warn('dsbot-nodes: %s handler failed: %s', endpoint, error) }
    }
  }

  const sendFrame = (nodeId, frame) => {
    const peer = peers.get(nodeId)
    if (peer === undefined || peer.closed === true) {
      throw new LlmError(`远程节点 ${nodeId} 不在线`, 'node/offline')
    }
    peer.send(frame)
  }

  // 主机发起、等回答。turn.request 不等（它是一轮，结果走事件），node.exec 等。
  const callNode = (nodeId, method, params, { timeoutMs = CALL_TIMEOUT_MS } = {}) => {
    const id = nextId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id)
        reject(new LlmError(`${method} 超过 ${timeoutMs}ms 没有回答`, 'node/timeout'))
      }, timeoutMs)
      timer.unref?.()
      waiters.set(id, { resolve, reject, timer })
      try {
        sendFrame(nodeId, { id, method, params })
      } catch (error) {
        clearTimeout(timer)
        waiters.delete(id)
        reject(error)
      }
    })
  }

  // adapter 只认这三个方法：on（收上行）、call（发下行并等）、send（发下行不等）。
  const linkFor = nodeId => ({
    on(endpoint, handler) {
      const key = keyOf(nodeId, endpoint)
      const set = listeners.get(key) ?? new Set()
      set.add(handler)
      listeners.set(key, set)
      return () => set.delete(handler)
    },
    call(method, params) {
      return callNode(nodeId, method, params)
    },
    send(method, params) {
      // 同步抛要比 reject 危险得多：调用方写的是 `link.send(...).catch(...)`，
      // 只有 reject 才接得住。节点在轮次中途掉线时 sendFrame 恰好会抛。
      try {
        sendFrame(nodeId, { id: nextId(), method, params })
        return Promise.resolve()
      } catch (error) {
        return Promise.reject(error)
      }
    },
  })

  // ---- 连接 ----

  // 握手：对面连上（或我们连上）之后先发一条 `node.hello`，主机记下它是谁。
  // 拿到 hello 之前不认这条连接 —— 一个连上来但不报身份的 socket 没有意义。
  //
  // 这里有个坑值得单独说：远端"连上 TCP、口令对、然后没发 hello 就断"是常态
  // （进程刚起就被杀、网络抖一下、手机上切后台）。主机侧这条路径的通知人是
  // 监听器的回调，没人会去 await 它 —— 所以必须保证：
  //   1) 握手成功之后要把 close 监听摘掉，不能留着一个会 reject 的尾巴；
  //   2) Promise 只能结一次；
  //   3) reject 出去的错一定要有人接（见 acceptPeer / hosting）。
  // 少任何一条，一条断线就是一次 fatal load failure（crash-2026-11-15）。
  const attach = (peer, helloTimeoutMs = HELLO_TIMEOUT_MS) => new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn, value) => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      peer.off('frame', onFrame)
      peer.off('close', onClose)
      fn(value)
      return true
    }

    const timer = setTimeout(() => {
      peer.close()
      settle(reject, new LlmError('对面连上了但没有发 node.hello', 'node/hello-timeout'))
    }, helloTimeoutMs)
    timer.unref?.()

    const onClose = () => settle(reject, new LlmError('连接在握手前就断了', 'node/offline'))

    const onFrame = async (frame) => {
      if (frame?.method !== 'node.hello') return
      if (settled) return
      // 先落定再干活：后面每个 await 都可能让这条连接在这期间断掉。
      settled = true
      clearTimeout(timer)
      peer.off('frame', onFrame)
      peer.off('close', onClose)
      try {
        // 节点 id 由主机分配（store 生成 n-xxxxxxxx），远端只报自己的 deviceId 与名字。
        // 同一个 deviceId 再连上来是重连，不是新机器。
        const params = frame.params ?? {}
        const deviceId = String(params.deviceId ?? '').trim()
        let record = store.list().find(node => deviceId !== '' && node.deviceId === deviceId)
        record = record === undefined
          ? await store.add({ name: String(params.name ?? '') || 'remote', ...(deviceId === '' ? {} : { deviceId }) })
          : await store.update(record.id, { name: String(params.name ?? record.name) })
        const nodeId = record.id
        await store.update(nodeId, {
          status: 'online',
          lastSeenAt: Date.now(),
          caps: Array.isArray(params.caps) ? params.caps : [],
        })

        if (frame.id !== undefined) peer.send({ id: frame.id, result: { proto: 1, ok: true, nodeId } })

        peers.set(nodeId, peer)
        const drop = () => {
          if (peers.get(nodeId) !== peer) return
          peers.delete(nodeId)
          // 写盘失败不能变成 unhandledRejection：断线时目录可能已经被删了。
          store.update(nodeId, { status: 'offline', lastSeenAt: Date.now() })
            .catch(error => warn('dsbot-nodes: marking %s offline failed: %s', nodeId, error))
          emit(nodeId, 'node.offline', { nodeId })
        }
        peer.on('frame', incoming => handleFrame(nodeId, incoming))
        peer.on('close', drop)
        peer.on('bad-frame', error => warn('dsbot-nodes: %s sent a bad frame: %s', nodeId, error))
        peer.on('listener-error', error => warn('dsbot-nodes: %s 的帧处理出错：%s', nodeId, error))
        syncRoutes()
        emit(nodeId, 'node.online', { nodeId, name: record?.name ?? nodeId })
        // 上面几个 await 里对面可能就断了。close 早就发完了，我们的监听挂得太晚 ——
        // 不补这一刀，这台机器会被记成永远在线。
        if (peer.closed === true) drop()
        resolve({ nodeId, record })
      } catch (error) {
        // 记不下这台机器就别留着这条连接：半死不活的状态比断开更难查。
        peer.close()
        reject(error instanceof LlmError ? error : new LlmError(`认不出这台机器：${error?.message ?? error}`, 'node/failed'))
      }
    }

    // close 先挂：frame 的注册会同步 flush backlog，可能当场就把 onFrame 跑完。
    peer.on('close', onClose)
    peer.on('frame', onFrame)
  })

  const connectNode = async ({ url, token, timeoutMs = HELLO_TIMEOUT_MS + 2_000, helloTimeoutMs = HELLO_TIMEOUT_MS } = {}) => {
    if (typeof url !== 'string' || url === '') throw new LlmError('缺 url', 'node/bad-params')
    if (typeof token !== 'string' || token === '') throw new LlmError('缺 token', 'node/bad-params')
    const peer = await connectTcp({ url, token, timeoutMs })
    return attach(peer, helloTimeoutMs)
  }

  // 远端连进来（主机 listen）时用这个：peer 已经由 transport 层验过 token。
  // 这条路（主机监听、界面按钮）没人 await 返回值，reject 一旦漏出去，DSH 宿主会
  // 当成 fatal load failure 直接退进程 —— 对方手机切个后台就能把主机的 DSH 关掉。
  // 所以失败在这里压成一句 warn，结果里带 failed 供界面显示。
  const acceptPeer = peer => attach(peer).then(
    value => value,
    error => {
      warn('dsbot-nodes: 远端没握上手：%s', error?.message ?? error)
      return { nodeId: null, record: null, failed: error }
    },
  )

  // ---- 入站帧 ----

  const handleFrame = (nodeId, frame) => {
    if (frame === null || typeof frame !== 'object') return
    // response / error：配对上之前的 call
    if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
      const waiter = waiters.get(frame.id)
      if (waiter === undefined) return
      clearTimeout(waiter.timer)
      waiters.delete(frame.id)
      if (frame.error !== undefined) {
        waiter.reject(new LlmError(frame.error.message ?? '远程报错', frame.error.code ?? 'node/failed', frame.error))
      } else {
        waiter.resolve(frame.result)
      }
      return
    }
    if (typeof frame.method !== 'string') return
    // v1 不让远端主动调主机的方法：它要读群、发消息，走的是主机下发的工具，
    // 那些工具的实现在主机这边，远端调不到。收到就明确拒绝，不假装成功。
    if (frame.id !== undefined) {
      const peer = peers.get(nodeId)
      peer?.send({ id: frame.id, error: { code: 'node/unsupported', message: `主机不接 ${frame.method}` } })
      return
    }
    emit(nodeId, frame.method, frame.params)
  }

  // ---- provider 注册 ----

  const Adapter = createAdapterClass({ LlmAdapter, LlmError })
  const adapter = new Adapter({
    linkFor,
    nodes: () => Object.fromEntries(store.list().map(node => [node.id, node])),
    toolDefs: () => [],
    cwdFor: () => undefined,
    deadlineMs: 30 * 60_000,
    audit: (event, data) => rt.ledger?.(event, data),
    // 远端在轮末报回来的文件落到 <home>/outbox/<nodeId>/，路径拼成链接接在这轮话的后面。
    // 不另发一条消息：那会打乱群里的发言顺序。
    async onTurnFiles({ nodeId, files }) {
      const links = []
      for (const file of files) {
        if (typeof file === 'string') { links.push(file); continue }
        const name = String(file?.name ?? '').trim()
        if (name === '') continue
        const data = typeof file.data === 'string' ? Buffer.from(file.data, 'base64') : file.data
        if (data === undefined) continue
        const saved = await acceptUpload({ home: rt.home, nodeId, name, data })
        if (saved.ok !== true) { warn('dsbot-nodes: 落盘 %s 失败：%s', name, saved.message); continue }
        links.push(`[${saved.name}](${saved.path})`)
      }
      return links.length === 0 ? '' : `

${links.join(' ')}`
    },
  })

  let registration
  const syncRoutes = () => {
    const routes = store.list().map(node => routeOf(node.id))
    // 一条路由都没有时不去注册：宿主会以 INVALID_ADAPTER 拒掉空列表。
    if (routes.length === 0 && registration === undefined) return
    try {
      registration = registration === undefined
        ? ctx.llm.registerAdapter(routes, adapter)
        : (registration.replace?.(routes), registration)
    } catch (error) {
      warn('dsbot-nodes: registering %s failed: %s', routes.join(','), error)
    }
  }
  syncRoutes()

  // 主机自己的那一半：开端口、给配对码、应答局域网问询。装上就已经在等，
  // 用户只需要把码报给另一台机器。端口被占或被防火墙拦只报一句，不影响别的。
  const hosting = createHosting({
    store,
    attach: peer => acceptPeer(peer),
    warn: message => warn(message),
    hostName: 'DSH 主机',
  })
  void hosting.start().catch(error => warn(`远程节点监听没起来：${error.message}`))

  // 反过来的那一半：这台机器也可以"加入别人的群"。
  const joiner = createJoiner({ home: rt.home, warn: message => warn(message) })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const peer of peers.values()) peer.close()
      peers.clear()
      void hosting.stop()
      for (const [, waiter] of waiters) clearTimeout(waiter.timer)
      waiters.clear()
      adapter.dispose()
      if (typeof registration === 'function') registration()
    })
  }

  // 节点可以用 id 也可以用名字：用户在聊天里说的是"写代码那台"。
  const resolveNode = text => {
    const wanted = String(text ?? '').trim()
    if (wanted === '') throw Object.assign(new Error('要指定哪台机器'), { code: 'node/bad-params' })
    const all = store.list()
    const hit = all.find(node => node.id === wanted) ?? all.find(node => node.botName === wanted)
      ?? all.find(node => node.name === wanted)
    if (hit === undefined) {
      const known = all.map(node => `${node.name}(${node.id})`).join('、') || '还没有任何机器连过'
      throw Object.assign(new Error(`没有这台机器：${wanted}。已知：${known}`), { code: 'node/not-found' })
    }
    return hit
  }

  // 给工具与测试用的入口。工具在下面注册，这里只出能力。
  const api = {
    connect: connectNode,
    accept: acceptPeer,
    list: () => store.list(),
    node: id => store.node(id),
    resolveNode,
    call: callNode,
    linkFor,
    store,
    bind: args => bindNodeToGroup({ rt, store, ...args }),
    unbind: args => unbindNodeFromGroup({ rt, store, ...args }),
    forget: args => forgetNode({ rt, store, ...args }),
    // 配对码：界面与工具共用同一份状态。
    hosting,
    pair: args => hosting.start(args ?? {}),
    rotate: () => hosting.rotate(),
    // 这台机器加入别人的群：输入对方的码，起一个节点侧子进程。
    join: args => joiner.start(args ?? {}),
    leave: () => {
      joiner.stop()
      return joiner.status()
    },
    joinStatus: () => joiner.status(),
    disconnect(nodeId) {
      const peer = peers.get(nodeId)
      if (peer === undefined) return false
      peer.close()
      return true
    },
  }
  rt.nodesApi = api
  registerTool(rt, api, resolveNode)
  registerRoutes(rt, api, hosting)
  return api
}

const sendJson = (res, status, body) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

const readBody = req => new Promise((resolve) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk
    if (raw.length > 64_000) req.destroy()
  })
  req.on('end', () => {
    try { resolve(raw === '' ? {} : JSON.parse(raw)) } catch { resolve({}) }
  })
  req.on('error', () => resolve({}))
})

// 设置页读的就是这几个口：状态、换码、绑定、解绑。全走 JSON，不靠 HTML 表单。
function registerRoutes(rt, api, hosting) {
  const ctx = rt.ctx
  if (typeof ctx.effect !== 'function') return

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '')
    try {
      if (req.method === 'GET' && path === '/api/nodes/status') {
        return sendJson(res, 200, {
          ok: true,
          ...hosting.status(),
          nodes: api.list().map(node => ({
            id: node.id,
            name: node.name,
            botName: node.botName ?? '',
            status: node.status ?? 'offline',
            caps: node.caps ?? [],
            groups: node.groups ?? [],
            lastSeenAt: node.lastSeenAt ?? null,
          })),
          join: api.joinStatus(),
        })
      }
      if (req.method === 'POST' && path === '/api/nodes/join') {
        const body = await readBody(req)
        return sendJson(res, 200, {
          ok: true,
          join: await api.join({ code: body.code, name: body.name, agent: body.agent, cwd: body.cwd }),
        })
      }
      if (req.method === 'POST' && path === '/api/nodes/leave') {
        return sendJson(res, 200, { ok: true, join: api.leave() })
      }
      if (req.method === 'POST' && path === '/api/nodes/rotate') {
        return sendJson(res, 200, { ok: true, ...(await hosting.rotate()) })
      }
      if (req.method === 'GET' && path === '/api/nodes/groups') {
        const rooms = Object.values(rt.state?.rooms ?? {})
        return sendJson(res, 200, {
          ok: true,
          groups: rooms.map(room => ({
            id: room.id,
            name: room.name,
            members: (room.members ?? []).length,
          })),
        })
      }
      if (req.method === 'POST' && path === '/api/nodes/bind') {
        const body = await readBody(req)
        if (typeof body.node !== 'string' || typeof body.group !== 'string') {
          return sendJson(res, 400, { ok: false, error: '要给 node 与 group' })
        }
        const node = api.resolveNode(body.node)
        const result = await api.bind({ nodeId: node.id, groupId: body.group })
        return sendJson(res, 200, { ok: true, botId: result.botId, botName: result.botName })
      }
      if (req.method === 'POST' && path === '/api/nodes/unbind') {
        const body = await readBody(req)
        const node = api.resolveNode(body.node)
        const group = typeof body.group === 'string' ? body.group : undefined
        const target = group ?? (node.groups ?? [])[0]
        if (target === undefined) return sendJson(res, 400, { ok: false, error: '这台机器还没进群' })
        await api.unbind({ nodeId: node.id, groupId: target })
        return sendJson(res, 200, { ok: true })
      }
      if (req.method === 'POST' && path === '/api/nodes/forget') {
        const body = await readBody(req)
        const node = api.resolveNode(body.node)
        await api.forget({ nodeId: node.id })
        return sendJson(res, 200, { ok: true })
      }
      return sendJson(res, 404, { ok: false, error: `没有这个口：${path}` })
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: error?.message ?? String(error), code: error?.code })
    }
  }

  // webServer 未必已经就位：拿得到就直接挂，拿不到等它出现再挂。
  const mount = (server) => {
    if (server?.register === undefined) {
      rt.warn?.('dsbot-nodes: 拿不到 webServer，设置页会连不上')
      return
    }
    ctx.effect(() => server.register({ kind: 'prefix', path: '/api/nodes', handler }))
  }
  const ready = ctx.get?.('webServer') ?? ctx.webServer
  if (ready?.register !== undefined) {
    mount(ready)
    return
  }
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], sub => mount(sub.get?.('webServer') ?? sub.webServer))
      return
    } catch {
      /* 退到下面 */
    }
  }
  mount(undefined)
}

// 一个工具，多个动作。拆成七个工具会让模型的工具表变长，而这七件事都围绕"哪台机器"。
function registerTool(rt, api, resolveNode) {
  const { ctx } = rt
  // ds-bot 的每个工具都是 `rt.teamTools.push(...)`：它在每个 Bot 组装工具表时
  // 逐条注册到那个 Bot 的 ctx.tools 上。往根 ctx 注册是另一条路——根上未必有
  // tools 服务，而且那样只有 Main Bot 看得见。
  const viaTeam = Array.isArray(rt.teamTools)
  if (!viaTeam && ctx?.tools?.register === undefined) return
  const tool = defineTool({
    name: 'node_remote',
    description: [
      'Work with Remote Nodes: other computers whose Bot joins a group chat here.',
      'pair — show the pairing code the other machine types (this is the normal first step).',
      'list — who is connected. connect — attach to a machine waiting at a tcp:// address with its token.',
      'bind — put that machine into a group as a member (it then answers there with its own model).',
      'unbind — take it out of one group. forget — remove the machine entirely.',
      'exec — run one of its allowed actions (read_file / list_dir / run_shell / env_info / push_file).',
    ].join(' '),
    parameters: {
      action: { type: 'string', required: true, description: 'pair | list | connect | bind | unbind | forget | exec' },
      node: { type: 'string', description: 'Which machine: its id or its name (as shown by list)' },
      group: { type: 'string', description: 'Which group: its name or id — bind and unbind' },
      url: { type: 'string', description: 'connect: tcp://host:port the machine is listening on' },
      token: { type: 'string', description: 'connect: the token the machine was started with' },
      name: { type: 'string', description: 'bind: the name this member shows in the group' },
      command: { type: 'string', description: 'exec: read_file | list_dir | run_shell | env_info | push_file' },
      path: { type: 'string', description: 'exec: file or folder on that machine' },
      cwd: { type: 'string', description: 'exec run_shell: working folder' },
      content: { type: 'string', description: 'exec run_shell: the command line' },
      text: { type: 'string', description: 'exec push_file: file contents' },
      to: { type: 'string', description: 'exec push_file: destination path' },
    },
    // 工具返回值一律是一句话。宿主必须知道怎么把一句话渲染出来 —— 少了 render
    // 这里会在 defineTool 内部直接读 undefined.render 崩掉。
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const action = String(args.action ?? '').trim()
      try {
        if (action === 'pair') {
          const state = await api.hosting.start()
          return `配对码 ${state.code}（端口 ${state.port}）。在另一台装了同一个插件的机器上输入这个码就能连过来。`
        }
        if (action === 'list') {
          const nodes = api.list()
          if (nodes.length === 0) return '还没有任何机器连过来。先拿到配对码（action=pair），再到另一台机器上输入它。'
          return nodes.map(node => [
            `${node.name} (${node.id})`,
            node.status === 'online' ? '在线' : '离线',
            node.botName === undefined ? '未进群' : `群里叫 ${node.botName}`,
            `能做 ${(node.caps ?? []).join('/') || '未上报'}`,
          ].join('｜')).join('\n')
        }
        if (action === 'connect') {
          if (args.url === undefined) return 'connect 需要 url，形如 tcp://10.144.0.3:7777'
          const { nodeId, node } = await api.connect({ url: args.url, token: args.token })
          return `连上了：${node.name}（${nodeId}），能做 ${(node.caps ?? []).join('/')}`
        }
        if (action === 'bind') {
          const node = resolveNode(args.node)
          const group = String(args.group ?? '').trim()
          if (group === '') {
            const rooms = Object.values(rt.state?.rooms ?? {}).map(room => `${room.name}(${room.id})`)
            return `bind 需要 group。现有群：${rooms.join('、') || '还没有群'}`
          }
          const room = rt.roomOf(group) ?? Object.values(rt.state?.rooms ?? {}).find(each => each.name === group)
          if (room === undefined) return `没有这个群：${group}`
          const result = await api.bind({ nodeId: node.id, groupId: room.id, name: args.name ?? node.name })
          return result.created
            ? `${result.botName} 已经进了「${room.name}」，它在群里说的话由 ${node.name} 那台机器跑。`
            : `${result.botName} 本来就在「${room.name}」里，模型已指回 ${node.name}。`
        }
        if (action === 'unbind') {
          const node = resolveNode(args.node)
          const room = rt.roomOf(args.group) ?? Object.values(rt.state?.rooms ?? {}).find(each => each.name === args.group)
          if (room === undefined) return `没有这个群：${args.group}`
          const { groups } = await api.unbind({ nodeId: node.id, groupId: room.id })
          return `${node.name} 已经离开「${room.name}」${groups.length === 0 ? '，它现在不在任何群里。' : `，还在 ${groups.length} 个群里。`}`
        }
        if (action === 'forget') {
          const node = resolveNode(args.node)
          await api.forget({ nodeId: node.id })
          return `${node.name} 已经断开并从所有群里移除了。`
        }
        if (action === 'exec') {
          const node = resolveNode(args.node)
          const command = String(args.command ?? '').trim()
          const allowed = ['read_file', 'list_dir', 'run_shell', 'env_info', 'push_file']
          if (!allowed.includes(command)) return `exec 只做 ${allowed.join(' / ')}，不做 ${command || '（空）'}`
          const params = { command, path: args.path, cwd: args.cwd, content: args.content, text: args.text, to: args.to }
          const result = await api.call(node.id, 'node.exec', params, { timeoutMs: 35_000 })
          const parts = [result.ok === false ? `失败：${result.message ?? result.code}` : '成功']
          if (result.output !== undefined) parts.push(String(result.output))
          if (result.entry !== undefined) parts.push(JSON.stringify(result.entry))
          if (result.path !== undefined) parts.push(`落在 ${result.path}`)
          return parts.join('\n')
        }
        return `不认识的 action：${action || '（空）'}`
      } catch (error) {
        // 工具里抛错会变成红色的失败卡片；这里换成一句话，模型还能继续往下走。
        return `${action} 没做成：${error?.message ?? error}`
      }
    },
  })
  if (viaTeam) {
    rt.teamTools.push(tool)
    return
  }
  ctx.effect(() => ctx.tools.register(tool))
}

// 标准 cordis 插件形态：DSH 调的是 apply(ctx)，不是 install(rt)。
// rt 由 ds-bot 提供（它在 createRuntime 里 ctx.provide('bot', rt)），
// 所以 inject 里必须声明 'bot'——没有它，我们拿到的是自己那份空运行时。
export function apply(ctx, config = {}) {
  bootNote('apply called')
  // 顶层 inject 里不写 'bot'：服务还没来时 cordis 连 apply 都不调，出问题只能看到
  // "什么都没发生"。改成运行时订阅——先证明插件活着，再等 ds-bot 把 runtime 挂上来。
  ctx.inject(['bot', 'llm'], (sub) => {
    bootNote('deps ready')
    install(sub.bot)
  })
}

// 插件没接上时给一句话，而不是静默什么都不做。
let warned = false
function warnOnce(message) {
  if (warned) return
  warned = true
  console.warn(message)
}

export default { name, inject, apply }
