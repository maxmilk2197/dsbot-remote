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
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { bindNodeToGroup, forgetNode, unbindNodeFromGroup } from './bind.js'
import { createAdapterClass, nodeIdOf, routeOf } from './adapter.js'
import { acceptUpload } from './files.js'
import { createNodeStore } from './store.js'
import { createHosting } from './hosting.js'
import { createJoiner } from './join.js'
import { connectTcp } from '@dsbot/node-protocol/tcp'
import { claimInstance, guardStats, newModuleId, releaseInstance, resetGuard } from './guard.js'

export const name = 'dsbot-nodes'
export const inject = []

const HELLO_TIMEOUT_MS = 8_000
const CALL_TIMEOUT_MS = 60_000

// 装车自证：三个点各写一行，卡在哪一段一眼就能看出来
// （模块 import 了没有 / apply 被调了没有 / install 拿没拿到运行时）。
// 插件的家目录：启动日志、紧急开关都放这儿。
function botHome() {
  return process.env.DSH_HOME ? join(process.env.DSH_HOME, 'bot') : join(homedir(), '.dsh', 'bot')
}

function bootNote(text) {
  try {
    const base = botHome()
    mkdirSync(base, { recursive: true })
    appendFileSync(join(base, 'nodes-boot.log'), `${new Date().toISOString()} ${text}
`)
  } catch {}
}

bootNote('module imported')

// DSH 会把同一个插件装进好几个上下文：日志里一次热重载能看到 install 连跑七遍。
// 每遍都新建一个 store、抢一次 7777、往 teamTools 里推一份工具、挂一份路由 ——
// 于是界面有的口读到这份数据、有的口读到那份，表现就是"列表是空的、下拉也是空的"；
// 更糟的是两份 store 各自写盘，能把节点记录写没。
//
// 防多开放在 guard.js：注册表挂在 globalThis，跨模块实例、跨热重载都在。
// 同一个模块实例被 apply 多次 → 直接复用（拦下，不新建）；
// 热重载换掉整个模块 → 先拆旧实例再装新的，绝不让两个 7777 监听并存。
// 模块级变量做不到这件事：热重载会把它连同整个模块换掉，而旧实例开的端口还在。
const MODULE_ID = newModuleId()
bootNote(`module loaded (${MODULE_ID})`)

export function install(rt) {
  const claimed = claimInstance(MODULE_ID, () => installOnce(rt), message => bootNote(`guard ${message}`))
  // 复用时也让这个 runtime 看得到 api：DSH 有些路径读 rt.nodesApi。
  if (claimed.reused) rt.nodesApi = claimed.api
  return claimed.api
}

// 测试用：让每个用例都能拿到干净的实例。
//
// 注意：DSH 在每次 apply 前后会调用插件导出的 reset* 函数（nodes-boot.log 里
// 每 100ms 一次 resetInstall）。生产环境必须什么都不做 —— 否则防多开刚建好的
// 实例会被立刻清掉，下一次 apply 又重建一份，等于白防。
export function resetInstall() {
  // 只认我们自己设的开关。NODE_TEST_CONTEXT 在 DSH 宿主里也有值，
  // 用它做判断会把生产环境也放进来（trace 里 resetGuard 就是这么被调的）。
  if (process.env.DSBOT_NODES_TEST !== '1') return
  resetGuard()
}

function installOnce(rt) {
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
  const binding = new Map()    // `${nodeId}\u0000${groupId}` -> 正在跑的 bind
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

  // 加入端在握手/弹窗里点好的群，主机替它建成员。api 要等这一段跑完才存在，
  // 所以先记在内存里，installOnce 末尾补跑 —— 握手可能发生在那之前。
  let autoBind = null
  // wantsGroups 同理：加入端连上之后弹窗选了群，再发一条 node.wants 过来。
  let wantsGroups = null
  const pendingAutoBind = new Map()
  const requestAutoBind = (nodeId, groups) => {
    const ids = [...new Set((groups ?? []).filter(id => typeof id === 'string' && id !== ''))]
    if (ids.length === 0) return
    if (autoBind === null) {
      pendingAutoBind.set(nodeId, [...new Set([...(pendingAutoBind.get(nodeId) ?? []), ...ids])])
      return
    }
    void autoBind(nodeId, ids).catch(error =>
      warn('dsbot-nodes: 替 %s 建群成员失败：%s', nodeId, error?.message ?? error))
  }

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
        // 探路：加入端在弹"选群组"的框之前，只想问一句"你这儿有哪些群"，不该
        // 在主机上留下一条"连过又断了"的记录。回完就断，store 一个字节都不写。
        if (params.probe === true) {
          if (frame.id !== undefined) {
            peer.send({
              id: frame.id,
              result: {
                proto: 1, ok: true, hostName: 'DSH 主机',
                groups: [], available: listGroups(rt), probe: true,
              },
            })
          }
          peer.close()
          resolve({ nodeId: null, probe: true, groups: listGroups(rt), hostName: 'DSH 主机' })
          return
        }
        let record = store.list().find(node => deviceId !== '' && node.deviceId === deviceId)
        record = record === undefined
          ? await store.add({ name: String(params.name ?? '') || 'remote', ...(deviceId === '' ? {} : { deviceId }) })
          : await store.update(record.id, { name: String(params.name ?? record.name) })
        const nodeId = record.id
        // workspace 是那台机器自己选的主文件夹。空着就不覆盖已有记录 ——
        // Object.assign 会把 undefined 写上去，落盘时整条字段就没了。
        const workspace = String(params.workspace ?? '').trim()
        await store.update(nodeId, {
          status: 'online',
          lastSeenAt: Date.now(),
          caps: Array.isArray(params.caps) ? params.caps : [],
          ...(workspace === '' ? {} : { workspace: workspace.slice(0, 400) }),
        })

        // 回执里只给它**自己进了的**群，不是全部群。
        // 给全部的话，远端拿第一个就去发消息 —— 发到它根本不在的群里，主机只能拒，
        // 而那条拒绝以前连日志都没有，看着就是"消息发出去了但群里没有"。
        // available 是另一回事：它要用来弹"选个群"的框，所以全都给。
        if (frame.id !== undefined) {
          const mine = (record.groups ?? [])
            .map(id => rt.roomOf?.(id))
            .filter(room => room !== undefined)
            .map(room => ({ id: room.id, name: room.name || room.id }))
          peer.send({ id: frame.id, result: { proto: 1, ok: true, nodeId, groups: mine, available: listGroups(rt) } })
        }

        peers.set(nodeId, peer)
        peer.lastFrameAt = Date.now()
        const drop = () => {
          if (peers.get(nodeId) !== peer) return
          peers.delete(nodeId)
          // 写盘失败不能变成 unhandledRejection：断线时目录可能已经被删了。
          store.update(nodeId, { status: 'offline', lastSeenAt: Date.now() })
            .catch(error => warn('dsbot-nodes: marking %s offline failed: %s', nodeId, error))
          emit(nodeId, 'node.offline', { nodeId })
        }
        peer.on('frame', (incoming) => {
          peer.lastFrameAt = Date.now()
          handleFrame(nodeId, incoming)
        })
        peer.on('close', drop)
        peer.on('bad-frame', error => warn('dsbot-nodes: %s sent a bad frame: %s', nodeId, error))
        peer.on('listener-error', error => warn('dsbot-nodes: %s 的帧处理出错：%s', nodeId, error))
        syncRoutes()
        emit(nodeId, 'node.online', { nodeId, name: record?.name ?? nodeId })
        // 连上就把最近的群消息铺给它：手机那边要"像正常群聊那样"，一进来就得有上下文，
        // 不能只从下一句开始。放在回执之后异步做，不拖慢握手。
        void sendRecentLines(peer, record).catch(error =>
          warn('dsbot-nodes: 给 %s 补群消息失败：%s', nodeId, error?.message ?? error))
        // 它连上时点了"进这些群"：握手一成功就替它建成员。
        // autoBind 要等 api 建好才有，没建好先记着，installOnce 末尾补跑。
        const wanted = Array.isArray(params.wantedGroups) ? params.wantedGroups.filter(id => typeof id === 'string') : []
        if (wanted.length > 0) requestAutoBind(nodeId, wanted)
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

  // 群聊镜像：让远端像正常群聊一样看到消息流。
  // 只读推送，不写远端任何东西 —— 远端的发言仍然走 node.post 回来。
  const LINE_TAIL = 15

  const lineOf = record => ({
    seq: record.seq,
    who: record.who ?? (record.botId === undefined ? '' : rt.botOf?.(record.botId)?.name ?? ''),
    botId: record.botId,
    text: String(record.text ?? ''),
    at: record.time ?? Date.now(),
    kind: record.kind,
  })

  const sendRecentLines = async (peer, record) => {
    if (typeof rt.groupLinesAfter !== 'function') return
    for (const groupId of record.groups ?? []) {
      const room = rt.roomOf?.(groupId)
      if (room === undefined) continue
      const all = await rt.groupLinesAfter(groupId, 0).catch(() => [])
      const tail = (all ?? []).slice(-LINE_TAIL).map(lineOf).filter(line => line.text !== '')
      // 空的群也要发：加入端靠这条消息把群在本地建出来，不然群列表里看不到。
      peer.send({
        method: 'group.snapshot',
        params: { room: { id: room.id, name: room.name || room.id }, lines: tail, cursor: 0 },
      })
    }
  }

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
      // 带上地址：下次再出问题，至少要能从日志看出是哪台机器、哪个 IP 没握上手。
      warn('dsbot-nodes: %s 没握上手：%s', peer?.remote ?? '远端', error?.message ?? error)
      return { nodeId: null, record: null, failed: error }
    },
  )

  // ---- 入站帧 ----

  // 远端主动插话：以它在群里那个 Bot 的身份把这句话写进群。
  // 和主机自己发消息走同一条路（rt.postToRoom），所以群里的轮次、@、存档都一致。
  const postFromNode = async (nodeId, frame) => {
    const peer = peers.get(nodeId)
    const answer = payload => { if (frame.id !== undefined) peer?.send({ id: frame.id, ...payload }) }
    // 被拒也要留痕：之前这里全是静默的 answer({error})，于是"消息发出去了但群里没有"
    // 只能靠猜。
    const refuse = (code, message) => {
      warn('dsbot-nodes: %s 想说话但没成：%s（%s）', nodeId, message, code)
      answer({ error: { code, message } })
    }
    const node = store.node(nodeId)
    const bot = node?.botId === undefined ? undefined : rt.botOf?.(node.botId)
    if (bot === undefined) {
      refuse('node/not-bound', '这台机器还没进任何群')
      return
    }
    const params = frame.params ?? {}
    const wanted = String(params.groupId ?? '').trim()
    // 没指定群就用它进的第一个群：远端多半只知道"我在某个群"，不知道 id。
    const room = wanted === ''
      ? (node.groups ?? []).map(id => rt.roomOf?.(id)).find(Boolean)
      : rt.roomOf?.(wanted)
    if (room === undefined) {
      refuse('node/not-found', `没有这个群：${wanted || '（它不在任何群里）'}`)
      return
    }
    if (!(room.members ?? []).includes(bot.id)) {
      refuse('node/denied', `这台机器不在「${room.name}」里`)
      return
    }
    const text = String(params.text ?? '').trim()
    if (text === '') {
      refuse('node/bad-params', '要说什么？')
      return
    }
    if (typeof rt.postToRoom !== 'function') {
      refuse('node/unsupported', '这个版本的 ds-bot 不支持代发')
      return
    }
    await rt.postToRoom(room, bot, text)
    answer({ result: { ok: true, groupId: room.id, at: Date.now() } })
    warn('dsbot-nodes: %s 在「%s」说了一句', bot.name ?? nodeId, room.name)
  }

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
    // node.post 是唯一一个远端主动发起、主机必须理会的：它在群里说一句话。
    // 其余方法仍然拒绝 —— 远端不该能读群、建群、加成员。
    if (frame.method === 'node.post') {
      void postFromNode(nodeId, frame).catch(error =>
        warn('dsbot-nodes: %s 说话失败：%s', nodeId, error?.message ?? error))
      return
    }
    // 加入端申请进群（连上之后在弹窗里选的）。回执带回哪些进去了、哪些被拒，
    // 界面据此把没进去的群标出来，而不是"选了但没反应"。
    if (frame.method === 'node.wants') {
      if (wantsGroups === null) {
        if (frame.id !== undefined) {
          peers.get(nodeId)?.send({ id: frame.id, error: { code: 'node/starting', message: '主机还在启动，稍等一下再试' } })
        }
        return
      }
      void wantsGroups(nodeId, frame).catch(error =>
        warn('dsbot-nodes: %s 申请进群失败：%s', nodeId, error?.message ?? error))
      return
    }
    // 心跳里带着工作区：加入端换了主文件夹，主机这边不用等重连就知道。
    if (frame.method === 'node.presence') {
      const workspace = String(frame.params?.workspace ?? '').trim()
      if (workspace !== '') {
        store.update(nodeId, { workspace: workspace.slice(0, 400), lastSeenAt: Date.now() })
          .catch(error => warn('dsbot-nodes: 记 %s 的工作区失败：%s', nodeId, error))
      }
    }
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
    // 审计只用来事后回溯，绝不能因为它把一轮弄挂。ds-bot 的 rt.ledger 是个
    // 对象（open/append/record/search…），不是函数 —— 以前写成 rt.ledger?.(…)
    // 会当场抛 "rt.ledger is not a function"，整轮断在这里，群里就是那句
    // "手机 停下来了：rt.ledger is not a function"。
    audit: (event, data) => {
      try {
        warn('dsbot-nodes: %s %s', event, JSON.stringify(data ?? {}).slice(0, 300))
      } catch { /* 日志写不出去也不能影响这一轮 */ }
    },
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

  // 心跳看门狗：对面 15 秒一条 node.presence，75 秒一帧都没有就当它掉了。
  // 电脑合盖、进程被杀、网线拔掉这几种情况 TCP 不会立刻断，光等 close 会让群里
  // 那条 Bot 一直"正在输入…"。按掉线处理 → 关连接 → 在途的轮次当场收尾。
  const STALE_MS = 75_000
  const watchdog = setInterval(() => {
    const now = Date.now()
    for (const [nodeId, peer] of peers) {
      if (peer.closed === true) continue
      const at = Number(peer.lastFrameAt ?? 0)
      if (at === 0) continue
      if (now - at <= STALE_MS) continue
      warn('dsbot-nodes: %s 已经 %d 秒没有心跳，按掉线处理', nodeId, Math.round((now - at) / 1000))
      try { peer.close() } catch {}
    }
  }, 20_000)
  watchdog.unref?.()

  // 自愈：节点删了，它的代理 Bot 还留在群里。那种 Bot 的 model 指向一个已经不存在
  // 的 node，谁也用不了它，但它还占着成员位置、还能被 @ 到，界面上看着就像多了一个
  // 莫名其妙的"手机""手机测试"。每次加载扫一遍，把这种孤儿收掉。
  // 启动时看一眼群里的远程成员，只报告、不动手。
  //
  // 这里原本会自动删：节点不存在的算孤儿，同群重复的只留一个。第一次跑就把
  // 用户正在用的「手机」删了 —— nodes.json 被写空过，谁"登记在案"完全不可信，
  // 照着它删等于拿运气赌用户的数据。删群成员是不可逆的，留一个重复项只是难看，
  // 所以现在只写日志，清理由用户在界面点。
  const sweepOrphans = async () => {
    // 必须先等盘读完：store 是懒加载的，list() 在 load 之前返回空数组 ——
    // 那样"已知节点"是空集合，所有远程成员都会被报成孤儿。
    await store.load()
    const known = new Set(store.list().map(node => node.id))
    for (const room of Object.values(rt.state?.rooms ?? {})) {
      const byNode = new Map()   // nodeId -> [成员名]
      for (const memberId of [...(room.members ?? [])]) {
        const bot = rt.botOf?.(memberId)
        if (bot === undefined) continue
        const target = nodeIdOf(String(bot.model ?? ''))
        if (target === undefined) continue
        if (!known.has(target)) {
          warn('dsbot-nodes: 「%s」里的 %s 指向已不存在的节点 %s —— 留着不动，确认不要了再在设置页移除',
            room.name, bot.name ?? memberId, target)
          continue
        }
        byNode.set(target, [...(byNode.get(target) ?? []), bot.name ?? memberId])
      }
      for (const [target, names] of byNode) {
        if (names.length > 1) {
          warn('dsbot-nodes: 「%s」里有 %s 都指向同一台机器（%s），留哪个由你决定',
            room.name, names.join('、'), target)
        }
      }
    }
  }
  void sweepOrphans().catch(error => warn('dsbot-nodes: 扫孤儿成员失败：%s', error?.message ?? error))

  // 群里有动静就推给绑在它上面的远端。snapshot 之后走的都是这条。
  if (typeof rt.onRoomLine === 'function' && typeof ctx.effect === 'function') {
    ctx.effect(() => rt.onRoomLine((room, record) => {
      const line = lineOf(record)
      if (line.text === '') return
      for (const [nodeId, peer] of peers) {
        const node = store.node(nodeId)
        if (node === undefined || !(node.groups ?? []).includes(room.id)) continue
        if (peer.closed === true) continue
        // 它自己刚说的话不用推回去（它当场就打印过了），免得每条都出现两遍。
        if (line.botId !== undefined && line.botId === node.botId) continue
        try {
          peer.send({ method: 'group.line', params: { roomId: room.id, roomName: room.name, lines: [line] } })
        } catch (error) {
          warn('dsbot-nodes: 推群消息给 %s 失败：%s', nodeId, error?.message ?? error)
        }
      }
    }))
  }

  // 反过来的那一半：这台机器也可以"加入别人的群"。
  const joiner = createJoiner({ home: rt.home, rt, warn: message => warn(message) })

  // 真正的清理只由 guard 决定何时执行。context 卸载时不能自己直接停：
  // 热重载里旧 context 的卸载可能晚于新实例就位，一停就把新实例也带走了。
  const dispose = () => {
    clearInterval(watchdog)
    for (const peer of peers.values()) peer.close()
    peers.clear()
    // stop() 里关监听是同步的；返回的 promise 不该变成未处理的 rejection。
    void hosting.stop().catch?.(() => {})
    for (const [, waiter] of waiters) clearTimeout(waiter.timer)
    waiters.clear()
    adapter.dispose()
    if (typeof registration === 'function') registration()
    const routes = routeState()
    if (routes.current?.api === api) routes.current = null
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => releaseInstance(MODULE_ID, message => bootNote(`guard ${message}`)))
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
    // 两次点击同时进来时，两边都会读到"这台机器还没有 Bot"，于是各建一个 ——
    // 群里就多出一个"手机 2"。同一台机器同一个群，重复的请求合成一次。
    bind: args => {
      const key = `${args.nodeId}\u0000${args.groupId}`
      const running = binding.get(key)
      if (running !== undefined) return running
      const job = bindNodeToGroup({ rt, store, ...args })
        .then((result) => {
          // 刚进群就把最近的群消息推过去：那台机器上的镜像群是靠这个才建出来的，
          // 不推的话它要等到群里下一句话才知道自己进来了。
          const peer = peers.get(args.nodeId)
          const node = store.node(args.nodeId)
          if (peer !== undefined && node !== undefined) {
            void sendRecentLines(peer, node).catch(error =>
              warn('dsbot-nodes: 推群消息给 %s 失败：%s', args.nodeId, error?.message ?? error))
          }
          return result
        })
        .finally(() => binding.delete(key))
      binding.set(key, job)
      return job
    },
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
    // 加入端的三个动作，走设置页那几个口：
    //   say         —— 以它自己那个成员的身份往主机的某个群说一句
    //   want        —— 连上之后补选群（弹窗里点的那几个）
    //   setWorkspace —— 换主文件夹，主机那边下一次心跳就知道
    say: (text, groupId) => joiner.say(text, groupId),
    want: groups => joiner.want(groups),
    setWorkspace: dir => joiner.setWorkspace(dir),
    disconnect(nodeId) {
      const peer = peers.get(nodeId)
      if (peer === undefined) return false
      peer.close()
      return true
    },
  }
  // 握手时点好的群 + 连上之后弹窗里补点的群，都走这一条：建成员、推最近消息。
  autoBind = async (nodeId, groups) => {
    const node = store.node(nodeId)
    if (node === undefined) return
    for (const wanted of groups) {
      const room = rt.roomOf?.(wanted)
        ?? Object.values(rt.state?.rooms ?? {}).find(each => each.name === wanted)
      if (room === undefined) {
        warn('dsbot-nodes: 加入端想进的群不存在：%s', wanted)
        continue
      }
      try {
        await api.bind({ nodeId, groupId: room.id, name: node.name })
      } catch (error) {
        warn('dsbot-nodes: 把 %s 放进「%s」失败：%s', node.name, room.name, error?.message ?? error)
      }
    }
  }
  wantsGroups = async (nodeId, frame) => {
    const peer = peers.get(nodeId)
    const answer = payload => { if (frame.id !== undefined) peer?.send({ id: frame.id, ...payload }) }
    const node = store.node(nodeId)
    if (node === undefined) {
      answer({ error: { code: 'node/not-found', message: '主机这边没有这台机器的记录' } })
      return
    }
    const asked = Array.isArray(frame.params?.groups) ? frame.params.groups : []
    const bound = []
    const refused = []
    for (const wanted of asked) {
      if (typeof wanted !== 'string' || wanted === '') continue
      const room = rt.roomOf?.(wanted)
        ?? Object.values(rt.state?.rooms ?? {}).find(each => each.name === wanted)
      if (room === undefined) {
        refused.push({ id: wanted, reason: '没有这个群' })
        continue
      }
      try {
        const result = await api.bind({ nodeId, groupId: room.id, name: node.name })
        bound.push({ id: room.id, name: room.name || room.id, botId: result.botId })
      } catch (error) {
        refused.push({ id: room.id, name: room.name || room.id, reason: error?.message ?? String(error) })
      }
    }
    answer({ result: { ok: true, bound, refused } })
  }
  // 握手发生在 api 建好之前：那会儿记下的群现在补建。
  for (const [nodeId, groups] of pendingAutoBind) {
    pendingAutoBind.delete(nodeId)
    void autoBind(nodeId, groups)
  }

  rt.nodesApi = api
  registerTool(rt, api, resolveNode)
  registerRoutes(rt, api, hosting)
  return { api, dispose }
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

// 群列表只有一处真源：ds-bot 的 state.rooms。名字缺失时退回 id，不让界面出现空选项。
const listGroups = (rt) => {
  const rooms = rt.state?.rooms
  if (rooms === undefined || rooms === null) return []
  return Object.values(rooms).map(room => ({
    id: room.id,
    name: room.name || room.id,
    members: (room.members ?? []).length,
  }))
}

// 设置页读的就是这几个口：状态、换码、绑定、解绑。全走 JSON，不靠 HTML 表单。
// 路由全进程只挂一次。
//
// 热重载换模块时，旧实例挂在 webServer 上的 handler 不会立刻消失；新模块再挂
// 同一个前缀就会 duplicate prefix route "/api/nodes"，设置页从此读到旧实例的
// 数据。把"当前实例"放进全局注册表，handler 每次请求现取；挂载只做一次。
const ROUTE_KEY = Symbol.for('dsbot-nodes.routes/v1')

function routeState() {
  if (globalThis[ROUTE_KEY] === undefined) {
    globalThis[ROUTE_KEY] = { mounted: false, unregister: null, current: null }
  }
  return globalThis[ROUTE_KEY]
}

function registerRoutes(rt, api, hosting) {
  const ctx = rt.ctx
  // 已挂载的 handler 从这里拿"现在是哪一份实例"。
  routeState().current = { rt, api, hosting }

  const handler = async (req, res) => {
    const current = routeState().current
    if (current === null) return sendJson(res, 503, { ok: false, error: '插件还没就绪' })
    const { rt, api, hosting } = current
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '')
    try {
      // store 是懒加载的，list()/node() 在 load 之前是空的。界面问得太早时，
      // 不能让它看到"一台机器都没有"。
      await api.store?.load?.()
      if (req.method === 'GET' && path === '/api/nodes/guard') {
        return sendJson(res, 200, { ok: true, ...guardStats() })
      }
      if (req.method === 'GET' && path === '/api/nodes/status') {
        return sendJson(res, 200, {
          ok: true,
          ...hosting.status(),
          // 界面能直接看到"拦下了几次重复加载"，不用翻日志猜。
          guard: guardStats(),
          nodes: api.list().map(node => ({
            id: node.id,
            name: node.name,
            botName: node.botName ?? '',
            status: node.status ?? 'offline',
            caps: node.caps ?? [],
            // 那台机器选的主文件夹。主机靠它知道"它的工作区在哪"，
            // 也靠它给"浏览工作区"定根目录。
            workspace: node.workspace ?? '',
            groups: (node.groups ?? []).map(id => {
              const room = rt.roomOf?.(id)
              return { id, name: room?.name ?? id }
            }),
            lastSeenAt: node.lastSeenAt ?? null,
          })),
          // 群列表跟着状态一起给：界面只要一次请求，少一个"另一个口挂了就整页空白"
          // 的失败点。之前它单独走 /groups，那个口一出问题下拉就是空的。
          groups: listGroups(rt),
          join: api.joinStatus(),
        })
      }
      if (req.method === 'POST' && path === '/api/nodes/rename') {
        const body = await readBody(req)
        const node = api.resolveNode(body.node)
        const name = String(body.name ?? '').trim().slice(0, 40)
        if (name === '') return sendJson(res, 400, { ok: false, error: '名字不能是空的' })
        await api.store.update(node.id, { name })
        return sendJson(res, 200, { ok: true, name })
      }
      if (req.method === 'POST' && path === '/api/nodes/join') {
        const body = await readBody(req)
        return sendJson(res, 200, {
          ok: true,
          join: await api.join({
            code: body.code, name: body.name, agent: body.agent, cwd: body.cwd,
            groups: body.groups,
          }),
        })
      }
      if (req.method === 'POST' && path === '/api/nodes/leave') {
        return sendJson(res, 200, { ok: true, join: api.leave() })
      }
      // 弹窗里点的那几个群：交给主机去建成员，回执说明哪些进去了、哪些被拒。
      if (req.method === 'POST' && path === '/api/nodes/join/wants') {
        const body = await readBody(req)
        const groups = Array.isArray(body.groups) ? body.groups.filter(each => typeof each === 'string') : []
        return sendJson(res, 200, { ok: true, ...(await api.want(groups)) })
      }
      // 换主文件夹：不用重连，下一次心跳主机就知道。
      if (req.method === 'POST' && path === '/api/nodes/join/workspace') {
        const body = await readBody(req)
        return sendJson(res, 200, { ok: true, join: await api.setWorkspace(body.path) })
      }
      // 加入端直接往主机的群里说话：落群走的是它自己那个成员身份。
      if (req.method === 'POST' && path === '/api/nodes/say') {
        const body = await readBody(req)
        const text = String(body.text ?? '').trim()
        if (text === '') return sendJson(res, 400, { ok: false, error: '要说什么？' })
        return sendJson(res, 200, { ok: true, ...(await api.say(text, body.group)) })
      }
      // 选主文件夹用：只列本机目录，只读。不列隐藏目录，免得一屏 .git。
      if (req.method === 'GET' && path === '/api/nodes/dirs') {
        const wanted = url.searchParams.get('path') ?? ''
        let base
        try {
          base = wanted === '' ? homedir() : resolve(wanted)
        } catch {
          return sendJson(res, 400, { ok: false, error: '这个路径不合法' })
        }
        const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
        const dirs = entries
          .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
          .map(entry => entry.name)
          .sort((a, b) => a.localeCompare(b))
        const parent = dirname(base)
        return sendJson(res, 200, { ok: true, path: base, parent: parent === base ? null : parent, dirs })
      }
      // 主机浏览那台机器的工作区：只是在它那儿跑 list_dir / read_file。
      if (req.method === 'POST' && path === '/api/nodes/fs') {
        const body = await readBody(req)
        const node = api.resolveNode(body.node)
        const action = body.op === 'read' ? 'read_file' : 'list_dir'
        const result = await api.call(node.id, 'node.exec', {
          execId: `fs-${Date.now()}`,
          action,
          args: { path: String(body.path ?? '.') },
        }, { timeoutMs: 35_000 })
        if (result?.ok === false) {
          return sendJson(res, 200, { ok: false, error: result.message ?? result.code, workspace: node.workspace ?? '' })
        }
        return sendJson(res, 200, {
          ok: true,
          output: String(result?.output ?? ''),
          truncated: result?.truncated === true,
          workspace: node.workspace ?? '',
        })
      }
      if (req.method === 'POST' && path === '/api/nodes/rotate') {
        return sendJson(res, 200, { ok: true, ...(await hosting.rotate()) })
      }
      // 提权：建虚拟网卡要管理员，但重启整个 DSH 代价太大。
      // 这里只把 EasyTier 单独提起来，UAC 会弹窗，用户点"是"才成。
      if (req.method === 'POST' && path === '/api/nodes/elevate') {
        const result = await hosting.elevate()
        // 一律回 200：失败时也要把兜底脚本路径带到界面。
        // 用 4xx 的话前端 asJson 会先抛错，那条路径就丢了 —— 用户只会看到
        // 一个错误弹层，而真正该做的事（右键跑脚本）反而没告诉他。
        return sendJson(res, 200, result)
      }
      if (req.method === 'GET' && path === '/api/nodes/groups') {
        return sendJson(res, 200, { ok: true, groups: listGroups(rt) })
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
  //
  // 这里必须用"此刻仍然有效的那个 context"来建 effect。注入回调拿到的 sub 是
  // 就绪时刻的 context，而外层 ctx 到那时可能已经被热重载换掉了 —— 在失效的
  // context 上建 effect 会抛 `cannot create effect on inactive context`，
  // 它顺着 DSH 的启动流程冒上去，会把整个宿主带崩（crash-2026-11-15T07-24-53）。
  // 所以：谁给的 context 就用谁的；万一还是失败，只记一句，绝不往外抛。
  const mount = (server) => {
    if (server?.register === undefined) {
      rt.warn?.('dsbot-nodes: 拿不到 webServer，设置页会连不上')
      return
    }
    const routes = routeState()
    // 已经挂过了：handler 会现取 current，不需要再挂一份。
    if (routes.mounted) return
    try {
      const off = server.register({ kind: 'prefix', path: '/api/nodes', handler })
      routes.mounted = true
      routes.unregister = typeof off === 'function' ? off : null
    } catch (error) {
      const message = String(error?.message ?? error)
      if (/duplicate prefix/i.test(message)) {
        // 旧版本实例的路由还占着这个前缀。不重复挂，也不装作挂上了。
        routes.mounted = true
        rt.warn?.('dsbot-nodes: 路由被旧实例占用，这次不重复挂；重启 DSH 后恢复')
        return
      }
      rt.warn?.(`dsbot-nodes: 设置页接口没挂上（${message}），不影响跨网和群功能`)
    }
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
    // 热重载时新模块会再注册一遍；同名工具只留最后一份，别让工具表越攒越长。
    const at = rt.teamTools.findIndex(each => each?.name === tool.name)
    if (at >= 0) rt.teamTools[at] = tool
    else rt.teamTools.push(tool)
    return
  }
  ctx.effect(() => ctx.tools.register(tool))
}

// 标准 cordis 插件形态：DSH 调的是 apply(ctx)，不是 install(rt)。
// rt 由 ds-bot 提供（它在 createRuntime 里 ctx.provide('bot', rt)），
// 所以 inject 里必须声明 'bot'——没有它，我们拿到的是自己那份空运行时。
// 冷启动先让路：DSH 的 load 阶段有一条带 deadline 的 meshcall 调用，超时就是
// "fatal load failure"，宿主直接退出。插件在这期间抢服务、开监听、注册 provider，
// 谁慢一点都可能把那条调用拖过期限。
//
// 这几次崩溃都发生在启动后十几秒，紧跟 model listing / cline 目录拉取之后：
// 那时 llm 服务正忙，install 里的 registerAdapter 正好挤在同一个窗口。把安装挪到
// 启动完成之后，关键路径上就只剩一次模块 import —— 快，而且不碰任何服务。
//
// 排查时可以 DSBOT_NODES_DELAY_MS=0 恢复即时安装。
const STARTUP_DELAY_MS = 20_000

// 紧急开关：~/.dsh/bot/nodes-off 存在就完全不装。删掉文件、重启即恢复。
function isDisabled() {
  try { return existsSync(join(botHome(), 'nodes-off')) } catch { return false }
}

export function apply(ctx, config = {}) {
  bootNote(`apply called (${MODULE_ID})`)
  if (isDisabled()) {
    bootNote('disabled by nodes-off')
    return
  }

  // 顶层 inject 里不写 'bot'：服务还没来时 cordis 连 apply 都不调，出问题只能看到
  // "什么都没发生"。改成运行时订阅——先证明插件活着，再等 ds-bot 把 runtime 挂上来。
  const attach = () => {
    ctx.inject(['bot', 'llm'], (sub) => {
      bootNote('deps ready')
      // 插件自己出问题可以少个功能，但绝不能把整个 DSH 带走。
      // 之前这里没兜：cordis 在某些时序下给出的 context 已经失效，install 里建
      // effect 会抛 cannot create effect on inactive context，一路冒到 DSH 的
      // 启动流程，宿主直接判定启动失败（crash-2026-11-15T07-24-53）。
      try {
        install(sub.bot)
      } catch (error) {
        warnOnce(`dsbot-nodes 装不起来（${error?.message ?? error}）—— 插件功能不可用，DSH 继续跑`)
      }
    })
  }

  const delay = Math.max(0, Number(process.env.DSBOT_NODES_DELAY_MS ?? STARTUP_DELAY_MS))
  if (delay === 0) {
    try {
      attach()
    } catch (error) {
      warnOnce(`dsbot-nodes 订阅失败（${error?.message ?? error}）—— 插件功能不可用，DSH 继续跑`)
    }
    return
  }

  bootNote(`install deferred ${delay}ms（避开 DSH 启动期）`)
  const timer = setTimeout(() => {
    try {
      attach()
    } catch (error) {
      warnOnce(`dsbot-nodes 延迟安装失败（${error?.message ?? error}）—— 插件功能不可用，DSH 继续跑`)
    }
  }, delay)
  timer.unref?.()
  // context 卸载时别留一个孤零零的定时器。
  try {
    ctx.effect?.(() => () => clearTimeout(timer))
  } catch {}
}

// 插件没接上时给一句话，而不是静默什么都不做。
let warned = false
function warnOnce(message) {
  if (warned) return
  warned = true
  console.warn(message)
}

export default { name, inject, apply }
