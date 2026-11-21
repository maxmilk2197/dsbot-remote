// 本文件由 AI 生成，请勿用于生产环境。
// The adapter that makes a Bot on another machine look like a model to DS Bot.
//
// A Bot whose model is `node:<nodeId>` gets its turns from this class instead of
// a model API. Everything else — the loop, Sessions, tools, approvals, the group
// transcript — is the ordinary machinery, which is why groups.js needs no change.
//
// The class is built from a base rather than extending an import directly: the
// host loads the real LlmAdapter from @deepseek-ai/dsh-llm, and the tests load a
// fake one, so the chunk contract can be verified without a harness running.
import { randomUUID } from 'node:crypto'

export const ROUTE_PREFIX = 'node:'
export const DEFAULT_CONTEXT_WINDOW = 200_000
export const DEFAULT_TURN_DEADLINE_MS = 30 * 60_000
// The prompt carries the recent conversation, not all of it: the remote has its
// own memory of the group and the host would otherwise re-send everything.
const PROMPT_MESSAGES = 12
const PROMPT_BYTES = 24 * 1024

export const routeOf = nodeId => `${ROUTE_PREFIX}${nodeId}`
export const isNodeRoute = route => typeof route === 'string' && route.startsWith(ROUTE_PREFIX)
// `node:<id>` 和 `node:<id>/default`（proxyModel 带上下文后缀）都要能解析出 id，
// 否则按 model 反查节点永远查不到 —— 群成员表里就会站着两个都指着同一台机器的 Bot。
export const nodeIdOf = route => (isNodeRoute(route) ? route.slice(ROUTE_PREFIX.length).split('/')[0] : undefined)

// One queue per turn. Events arrive on the link's uplink endpoint and are pushed
// here; the generator pulls them. Closing resolves a waiter with a terminal
// item so an aborted turn does not hang on a promise nobody settles.
export class TurnMailbox {
  constructor() {
    this.items = []
    this.waiters = []
    this.closed = false
  }

  push(item) {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter(item)
    else this.items.push(item)
  }

  next() {
    if (this.items.length > 0) return Promise.resolve(this.items.shift())
    if (this.closed) return Promise.resolve({ kind: 'closed' })
    return new Promise(resolve => this.waiters.push(resolve))
  }

  close() {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ kind: 'closed' })
  }
}

// The prompt the remote receives: the team instructions once, then the recent
// conversation, oldest first, with the latest message always complete.
export function renderPrompt(messages, system = '') {
  const body = (messages ?? []).filter(message => message.role !== 'system')
  const latest = body.at(-1)
  const picked = []
  let used = 0
  let full = false
  for (const message of [...body].reverse()) {
    const whole = message === latest
    const text = textOf(message.content)
    const label = message.role === 'assistant' ? 'You' : message.role === 'tool' ? `Tool result (${message.toolCallId ?? 'call'})` : 'User'
    const line = `${label}: ${whole ? text : text.slice(0, 2_000)}`
    if (whole) {
      picked.unshift(line)
      used += line.length
      continue
    }
    full ||= picked.length >= PROMPT_MESSAGES || used + line.length > PROMPT_BYTES
    if (full) continue
    picked.unshift(line)
    used += line.length
  }
  const head = system.trim() === '' ? '' : `The team instructions for this conversation:\n${system.trim()}\n\n`
  if (picked.length === 0) return head.trim()
  return `${head}The conversation so far (oldest first):\n\n${picked.join('\n\n')}`
}

// Message content is either a string or an array of parts; only text matters
// here, and an image part is named so the remote knows one existed.
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => {
    if (typeof part === 'string') return part
    if (part?.type === 'text') return String(part.text ?? '')
    if (part?.type === 'image') return '[image]'
    return ''
  }).filter(text => text !== '').join('\n')
}

function titleChunk(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function digestChunks(messages) {
  const lines = []
  let used = 0
  for (const message of messages ?? []) {
    const text = textOf(message.content).replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const line = `${message.role}: ${text.slice(0, 300)}`
    if (used + line.length > 8 * 1024) break
    lines.push(line)
    used += line.length
  }
  const text = `[Earlier conversation, condensed]\n${lines.join('\n')}`
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

// deps: {
//   link,        // { call(method, params), send(method, params), on(endpoint, handler) → off }
//   nodes,       // () => ({ [nodeId]: { name, botId } })
//   toolDefs,    // (options) => [{ name, description, parameters }] to hand the remote
//   cwdFor,      // (sessionId) => string | undefined
//   audit,       // (kind, payload) => void
//   deadlineMs,  // optional override
// }
//
// `link.on` keys are the uplink *endpoint* names (`turn.event`) and
// `link.call` keys are the downlink *method* names (`turn.request`) — that is
// literally how the two directions arrive at the two runtimes.
export function createAdapterClass({ LlmAdapter, LlmError }) {
  return class RemoteLlmAdapter extends LlmAdapter {
    constructor(deps) {
      super()
      this.deps = deps
      this.disposed = false
      this.inflight = new Map()   // turnId -> mailbox
    }

    providerInfo(route) {
      const node = this.deps.nodes?.()[nodeIdOf(route)]
      return { id: route, name: node?.name ?? route }
    }

    providerRetryPolicy() { return undefined }
    imageRequestPricing() { return undefined }

    async listModels(route) {
      // 节点记录是懒加载的：DSH 刚起来就来问模型表时，store 还没读盘，
      // 这里会拿到"一台节点都没有"，于是 ds-bot 判定 bot.model 失联，
      // 在群里说一句"default 已经不可用了"。先等它读出来再回答。
      await this.deps.ready?.()
      const node = this.deps.nodes?.()[nodeIdOf(route)]
      if (node === undefined) return []
      // The remote runs its own model; the host cannot enumerate it without a
      // round trip, and a menu that hangs is worse than one honest entry.
      return [{ provider: route, id: 'default', name: `${node.name} 的本机模型` }]
    }

    async resolveModel(route, model) {
      await this.deps.ready?.()
      const node = this.deps.nodes?.()[nodeIdOf(route)]
      return {
        provider: route,
        id: model,
        name: model === 'default' ? `${node?.name ?? route} 的本机模型` : model,
        inputModalities: ['text'],
        context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
      }
    }

    async *stream(options) {
      if (this.disposed) throw new LlmError('the remote nodes adapter is disposed', 'NO_ADAPTER')
      if (options.purpose === 'session-title') {
        const first = (options.messages ?? []).find(message => message.role === 'user')
        const title = (textOf(first?.content).split('\n').find(line => line.trim() !== '') ?? 'Chat').trim()
        yield* titleChunk(title === '' ? 'Chat' : title)
        return
      }
      if (options.purpose === 'compaction') {
        yield* digestChunks(options.messages)
        return
      }

      const route = options.provider
      const nodeId = nodeIdOf(route)
      if (nodeId === undefined) throw new LlmError(`not a remote node route: ${route}`, 'NO_ADAPTER')
      if (options.sessionId === undefined) throw new LlmError('a remote node request needs a session', 'INVALID_REQUEST')
      // 群成员里还站着这台机器的 Bot，但节点记录已经没了（被删掉、nodes.json 丢过、
      // 或者换了台机器）。宿主原本会先说一句“no adapter registered for provider
      // node:xxxx”，用户完全看不懂；路由由 index.js 兜底留着，这里给人话。
      await this.deps.ready?.()
      if (this.deps.nodes?.()[nodeId] === undefined) {
        throw new LlmError(`这台机器（${nodeId}）已经不在「远程节点」列表里了：记录被删掉，或者它换了一台机器。去设置里的「远程节点」重新配对；用不上就把它从群里移出去。`, 'NODE_GONE')
      }

      const turnId = randomUUID()
      const mailbox = new TurnMailbox()
      // One adapter serves every node route, so the link is resolved per node.
      const link = this.deps.linkFor(nodeId)
      const offEvent = link.on('turn.event', (params) => {
        if (params.turnId === turnId) mailbox.push({ kind: 'event', event: params })
      })
      const offResult = link.on('turn.result', (params) => {
        if (params.turnId === turnId) mailbox.push({ kind: 'result', result: params })
      })
      // 那台机器掉线了：这条连接上再也不会有 turn.event / turn.result 了。
      // 不收尾的话，群里会一直显示"正在输入…"直到 30 分钟的 deadline ——
      // 用户看到的就是一条永远在打字的 Bot。断线是确定性的失败，当场结束这一轮。
      const offOffline = link.on('node.offline', () => mailbox.push({ kind: 'offline' }))
      this.inflight.set(turnId, mailbox)
      const deadlineMs = this.deps.deadlineMs ?? DEFAULT_TURN_DEADLINE_MS
      const deadline = setTimeout(() => mailbox.push({ kind: 'timeout' }), deadlineMs)
      // 这里**不能** unref：这一轮还没结束，事件循环就没理由空转退出。unref 之后
      // "等远程回答"这件事就不算 pendding 工作了，Node 会认为没事可做直接退出
      // （测试里表现为 ERR_TEST_FAILURE: event loop has already resolved）。
      // 清理在 finally 里，不会拖着进程。

      const system = (options.messages ?? [])
        .filter(message => message.role === 'system')
        .map(message => textOf(message.content))
        .join('\n')
      const prompt = renderPrompt(options.messages, system)
      const attachments = options.attachments ?? []

      // One abort promise for the whole turn, listeners removed in finally: the
      // per-event version that leaks a listener per chunk is a known trap.
      let abortReject
      const abortPromise = new Promise((_, reject) => { abortReject = reject })
      const onAbort = () => abortReject(options.signal?.reason ?? new Error('aborted'))
      if (options.signal?.aborted) onAbort()
      else options.signal?.addEventListener('abort', onAbort)

      let index = 0
      let textIndex = -1
      let textBuf = ''
      let streamed = 0
      const files = []
      const closeText = function* () {
        if (textIndex === -1) return
        yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textBuf } }
        textIndex = -1
        textBuf = ''
      }

      try {
        const started = await link.call('turn.request', {
          turnId,
          prompt,
          tools: this.deps.toolDefs?.(options) ?? [],
          cwd: this.deps.cwdFor?.(options.sessionId),
          deadlineMs,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(options.model !== undefined && options.model !== 'default' ? { model: options.model } : {}),
        })
        this.deps.audit?.('node.turn', { nodeId, turnId, sessionId: options.sessionId, accepted: started?.accepted !== false })

        for (;;) {
          const item = await Promise.race([mailbox.next(), abortPromise]).catch(error => ({ kind: 'abort', error }))

          if (item.kind === 'abort') {
            link.send('turn.cancel', { turnId, reason: 'the turn was stopped' }).catch(() => {})
            yield* closeText()
            yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'the turn was stopped' } } }
            return
          }
          if (item.kind === 'timeout') {
            link.send('turn.cancel', { turnId, reason: 'deadline' }).catch(() => {})
            throw new LlmError(`节点在 ${Math.round(deadlineMs / 60_000)} 分钟内没有回应`, 'NODE_TIMEOUT')
          }
          // 掉线：不看"有没有说过话"，直接把这一轮判死。半截的话先收尾，
          // 群里看到的是一条失败提示，而不是一个永远打字中的成员。
          if (item.kind === 'offline') {
            yield* closeText()
            throw new LlmError('那台机器掉线了，这一轮没法继续', 'NODE_OFFLINE')
          }
          if (item.kind === 'closed') break

          if (item.kind === 'event') {
            const event = item.event
            switch (event.kind) {
              case 'delta': {
                if (event.text === undefined || event.text === '') break
                if (textIndex === -1) {
                  yield { type: 'block-start', index: index++, blockType: 'text' }
                  textIndex = index - 1
                }
                textBuf += event.text
                streamed += event.text.length
                yield { type: 'text-delta', index: textIndex, text: event.text }
                break
              }
              case 'tool-call': {
                // The remote executes this through the node-tool-call endpoint;
                // the host shows the call but does not run a second loop, so the
                // turn continues after the block.
                yield* closeText()
                const at = index++
                const args = JSON.stringify(event.args ?? {})
                yield { type: 'block-start', index: at, blockType: 'tool-call' }
                yield { type: 'tool-call-delta', index: at, id: event.callId, name: event.name, argumentsDelta: args }
                yield { type: 'block-end', index: at, block: { type: 'tool-call', id: event.callId, name: event.name, arguments: args } }
                break
              }
              case 'file': {
                if (typeof event.path === 'string') files.push(event.path)
                break
              }
              case 'tool-result':
              default:
                break
            }
            continue
          }

          if (item.kind === 'result') {
            const result = item.result
            if (result.status !== 'ok') {
              yield* closeText()
              // 节点发的是 message，早期的主机只认 error —— 两个都读，
              // 否则群里永远只有一句“节点报告本轮失败（error）”，原因全丢了。
              const message = result.error ?? result.message ?? `节点报告本轮失败（${result.status}）`
              throw new LlmError(message, result.status === 'cancelled' ? 'NODE_CANCELLED' : 'NODE_TURN_FAILED')
            }
            // A node that answered in one piece instead of streaming still has
            // to produce a text block, or the chat shows an empty turn.
            if (streamed === 0 && typeof result.text === 'string' && result.text !== '') {
              yield { type: 'block-start', index: index++, blockType: 'text' }
              const at = index - 1
              textBuf = result.text
              streamed = result.text.length
              yield { type: 'text-delta', index: at, text: result.text }
              yield { type: 'block-end', index: at, block: { type: 'text', text: result.text } }
              textIndex = -1
              textBuf = ''
            } else {
              yield* closeText()
            }
            for (const path of result.files ?? []) if (!files.includes(path)) files.push(path)
            if (files.length > 0) {
              // 落盘是异步的：等它拿到绝对路径，再把链接作为这一轮的最后一段文本发出去。
              // 链接必须进群聊行里——单独发一条消息会打断发言顺序。
              const attachment = await this.deps.onTurnFiles?.({ nodeId, turnId, sessionId: options.sessionId, files, result })
              if (typeof attachment === 'string' && attachment !== '') {
                const at = index++
                yield { type: 'block-start', index: at, blockType: 'text' }
                yield { type: 'text-delta', index: at, text: attachment }
                yield { type: 'block-end', index: at, block: { type: 'text', text: attachment } }
              }
            }
            if (result.usage !== undefined) yield { type: 'usage', usage: result.usage }
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
          }
        }
        // The mailbox closed without a result: the link dropped mid-turn. The
        // turn is not failed yet — the node may reconnect and resend — but this
        // stream has to end, or the group waits forever.
        yield* closeText()
        throw new LlmError('连接在回答结束前断了', 'NODE_DISCONNECTED')
      } finally {
        clearTimeout(deadline)
        offEvent()
        offResult()
        offOffline()
        this.inflight.delete(turnId)
        options.signal?.removeEventListener('abort', onAbort)
      }
    }

    // The host wants this turn back (model switched to local, node revoked).
    cancelTurn(turnId, reason = 'the host cancelled the turn') {
      const mailbox = this.inflight.get(turnId)
      if (mailbox === undefined) return false
      // 以前这里推的是 { kind: 'closed' }，那是"连不上 / 被 dispose"的语义：
      // 循环会 break，整轮变成 NODE_DISCONNECTED，界面上显示成节点掉线。
      // 主机主动取消应当是一条 aborted 结束信号（顺带把 turn.cancel 发给节点）。
      mailbox.push({ kind: 'abort', error: Object.assign(new Error(reason), { code: 'ABORTED' }) })
      return true
    }

    async dispose() {
      this.disposed = true
      for (const mailbox of this.inflight.values()) mailbox.close()
      this.inflight.clear()
    }
  }
}
