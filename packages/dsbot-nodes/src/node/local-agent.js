// 本文件由 AI 生成，请勿用于生产环境。
// 加入端的"默认 agent"：不填命令时，直接用这台 DSH 自己已经配好的模型。
//
// 为什么要这个：让用户装完插件、输个配对码就能在群里说话，而不是先去
// 别的机器装 CLI、再回来填一句 `dsh -p`。两端都是 DSH，模型本来就有，
// 只要把它接过来就行 —— ctx.llm 是 DSH 的模型总线，listProviders/listModels
// 能问出这台机器能用谁，stream 跑一轮。
//
// 用户显式填了 agent 命令时走 node/agent.js 的 stdin/stdout 路线，这里不参与。

// 选模型的偏好：账号态的官方模型优先，本地 ACP/第三方排后面。
// 都不是硬要求 —— 只是"开箱即用"时挑一个最能跑的，用户在设置页可以覆盖。
const rank = (provider) => {
  const id = String(provider?.id ?? '')
  if (id.startsWith('node:')) return -1 // 插件自己注册的远程节点，不是本机模型
  if (id.includes('deepseek-account')) return 90
  if (id.includes('deepseek')) return 80
  if (id.includes('local-acp')) return 20
  return 50
}

/**
 * 从 ctx.llm 里挑一个可用的本机模型。失败不抛：没模型就退回"只能干活不说话"，
 * 让设置页照实显示，而不是让连接整个失败。
 * @returns {Promise<{provider:string, model:string, name:string}|undefined>}
 */
export async function pickLocalModel(llm) {
  if (llm === null || llm === undefined || typeof llm.listProviders !== 'function') return undefined
  let providers = []
  try {
    providers = llm.listProviders() ?? []
  } catch {
    return undefined
  }
  const candidates = providers
    .filter(p => typeof p?.id === 'string' && rank(p) >= 0)
    .sort((a, b) => rank(b) - rank(a))
  for (const provider of candidates) {
    try {
      const models = await llm.listModels(provider.id)
      const first = Array.isArray(models) ? models.find(m => typeof m?.id === 'string') : undefined
      if (first === undefined) continue
      return { provider: provider.id, model: first.id, name: first.name || first.id }
    } catch {
      // 这个 provider 问不通（没登录、网络失败），试下一个。
    }
  }
  return undefined
}

/**
 * 用本机 DSH 的模型跑一轮。约定和 node/agent.js 一样：
 * onDelta 逐块收到文字，resolve 时给出全文，失败不抛而是给出 code/message。
 */
export async function runLocal({ llm, provider, model, prompt, onDelta, signal, timeoutMs } = {}) {
  if (llm === null || llm === undefined || typeof llm.stream !== 'function') {
    return { ok: false, code: 'node/bad-params', text: '', message: '这台 DSH 没有可用的模型服务' }
  }
  let text = ''
  let timer
  const controller = new AbortController()
  try {
    // ctx.llm.stream 自己不设超时；主机那边给多少时间，这里就守多少。
    // 外部 signal（主机点停止/掉线）已经能打断，这里补的是"对面一直不出字"。
    if (Number(timeoutMs) > 0) {
      timer = setTimeout(() => controller.abort(), Number(timeoutMs))
      timer.unref?.()
    }
    const forwardAbort = () => controller.abort()
    if (signal !== null && signal !== undefined) {
      if (signal.aborted === true) controller.abort()
      else signal.addEventListener('abort', forwardAbort, { once: true })
    }

    const options = {
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: String(prompt ?? '') }] }],
      purpose: 'dsbot-nodes/turn',
      signal: controller.signal,
    }
    for await (const chunk of llm.stream(options)) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        try { onDelta?.(chunk.text) } catch { /* 下游出错不该打断这一轮 */ }
      }
      if (chunk?.type === 'finish') {
        const reason = chunk.reason ?? {}
        if (reason.kind === 'error') {
          const failure = reason.failure ?? {}
          return { ok: false, code: 'node/agent-failed', text, message: failure.message ?? '本机模型这一轮出错了' }
        }
        if (reason.kind === 'aborted') {
          return { ok: false, code: 'node/cancelled', text, message: '这一轮被叫停了' }
        }
      }
    }
    return { ok: true, text }
  } catch (error) {
    return { ok: false, code: 'node/agent-failed', text, message: error?.message ?? String(error) }
  } finally {
    clearTimeout(timer)
  }
}
