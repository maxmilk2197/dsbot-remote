// 本文件由 AI 生成，请勿用于生产环境。
// 远端"Agent"：把一轮 turn 交给这台机器自己的命令行去跑。
//
// 不做 ACP、不做 MCP、不猜任何协议 —— 只约定一件事：
//   prompt 从 stdin 进去，回答从 stdout 出来。
// 这样 `claude -p`、`codex exec`、`dsh -p`、自家脚本都能接，换模型不用改这里。
//
// 它的输出就是这一轮 Bot 在群里说的话（主机那边的 groups.js 负责写进群），
// 所以这里唯一的 KPI 是"把 stdout 原样、按顺序、不丢字地送回去"。
import { spawn } from 'node:child_process'
import { sanitizeEnv } from './exec.js'

export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60_000

// "--agent 'dsh -p'" 这种写法要能拆成命令 + 参数，引号里的空格不算分隔。
export function parseAgentCommand(text) {
  const source = String(text ?? '').trim()
  if (source === '') return undefined
  const parts = []
  let current = ''
  let quote = ''
  for (const char of source) {
    if (quote !== '') {
      if (char === quote) quote = ''
      else current += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (/\s/.test(char)) {
      if (current !== '') { parts.push(current); current = '' }
      continue
    }
    current += char
  }
  if (current !== '') parts.push(current)
  if (parts.length === 0) return undefined
  const [command, ...args] = parts
  return { command, args }
}

// Windows 上 shell:true 会隔一层 cmd.exe，只杀子进程会留下握着管道的孙进程，
// close 永远不来 —— 超时就变成卡死。这里按进程树杀。
const stopTree = (child) => {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch { /* 已经没了 */ }
    return
  }
  try { child.kill('SIGKILL') } catch { /* 已经没了 */ }
}

/**
 * 跑一轮。onDelta 逐块收到 stdout（流式，边跑边发），resolve 时给出全文。
 * 失败不抛：远端要让主机知道"这一轮怎么了"，而不是让连接断掉。
 */
export function runAgent({
  command,
  args = [],
  prompt,
  cwd,
  env,
  timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
  onDelta,
  onStderr,
  signal,
} = {}) {
  if (typeof command !== 'string' || command === '') {
    return Promise.resolve({ ok: false, code: 'node/bad-params', text: '', message: '没有配置 agent 命令' })
  }

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: sanitizeEnv(env),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
    })

    let text = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      timedOut = true
      stopTree(child)
    }, timeoutMs)
    timer.unref?.()

    const onAbort = () => {
      aborted = true
      stopTree(child)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      text += chunk
      try { onDelta?.(chunk) } catch { /* 下游出错不该打断这一轮 */ }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000)
      try { onStderr?.(chunk) } catch { /* 同上 */ }
    })

    child.on('error', (error) => {
      finish({ ok: false, code: 'node/agent-failed', text, stderr, message: `起不来 ${command}：${error.message}` })
    })

    // 'exit' 比 'close' 早，且不受管道没关影响：超时被杀时 close 可能永远不来。
    child.on('exit', (code, signalName) => {
      setTimeout(() => finish({
        ok: !timedOut && !aborted && code === 0,
        code: timedOut ? 'node/timeout' : aborted ? 'node/cancelled' : code === 0 ? undefined : 'node/agent-failed',
        text,
        stderr,
        exitCode: code,
        signal: signalName,
        timedOut,
        aborted,
        message: timedOut
          ? `超过 ${Math.round(timeoutMs / 1000)} 秒没跑完`
          : aborted
            ? '被主机叫停'
            : code === 0 ? undefined : `退出码 ${code}`,
      }), 60)
    })

    try {
      child.stdin.end(String(prompt ?? ''))
    } catch (error) {
      finish({ ok: false, code: 'node/agent-failed', text, stderr, message: `写 stdin 失败：${error.message}` })
    }
  })
}
