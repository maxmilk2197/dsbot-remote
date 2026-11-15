// 本文件由 AI 生成，请勿用于生产环境。
// What a remote node will actually run on the owner's machine. Five actions,
// nothing else. Every branch here is one of the rules in PLAN.md §4, and
// test/exec.test.js exists so a later edit cannot widen them by accident.
import { spawn } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { EXEC_OUTPUT_LIMIT, EXEC_TIMEOUT_MS, MAX_FILE_BYTES } from '@dsbot/node-protocol/version'

export const ALLOWED_ACTIONS = Object.freeze(['read_file', 'list_dir', 'run_shell', 'push_file', 'env_info'])

export const accepts = action => ALLOWED_ACTIONS.includes(action)

// A key whose name suggests a credential never reaches a child process. The
// pattern is deliberately broad: a false positive costs an agent one env var,
// a false negative leaks someone's token into a shell history.
const SECRET_KEY = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|AUTH|COOKIE|SESSION|PRIVATE|SIGNATURE)(?:_|$)|API_?KEY|ACCESS_?KEY|CLIENT_?SECRET/i

export function sanitizeEnv(env = process.env) {
  const kept = {}
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_KEY.test(key)) continue
    kept[key] = value
  }
  return kept
}

// A path is inside the root only if walking up from it lands on the root. A
// sibling whose name merely starts with the root's ("proj-other") is outside.
export function withinRoot(root, target) {
  const base = resolve(root)
  const full = resolve(base, String(target ?? ''))
  const rel = relative(base, full)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const failed = (code, message) => ({ ok: false, code, message })

// Beyond the workspace root only a file that the bot's own session cwd holds is
// readable; everything else is a refusal, not an error.
async function filePath(action, args, cwd) {
  const target = args?.path
  if (typeof target !== 'string' || target === '') return { error: failed('node/exec-denied', `${action}: 缺少 path`) }
  if (!withinRoot(cwd, target)) {
    return { error: failed('node/exec-denied', `${action}: ${target} 不在工作目录 ${cwd} 之内`) }
  }
  return { path: resolve(cwd, target) }
}

export async function execute(request, context = {}) {
  const action = request?.action
  const args = request?.args ?? {}
  const cwd = resolve(context.cwd ?? process.cwd())
  const limit = context.outputLimit ?? EXEC_OUTPUT_LIMIT
  const timeoutMs = context.timeoutMs ?? EXEC_TIMEOUT_MS
  const maxFileBytes = context.maxFileBytes ?? MAX_FILE_BYTES

  if (!accepts(action)) return failed('node/exec-denied', `${JSON.stringify(action)} 不在白名单里`)

  switch (action) {
    case 'read_file': {
      const located = await filePath(action, args, cwd)
      if (located.error !== undefined) return located.error
      let info
      try {
        info = await stat(located.path)
      } catch (error) {
        return failed('node/exec-failed', `${action}: ${error.code === 'ENOENT' ? '文件不存在' : error.message}`)
      }
      if (!info.isFile()) return failed('node/exec-denied', `${action}: ${args.path} 是目录，不是文件`)
      const tooBig = info.size > maxFileBytes
      const text = await readFile(located.path, 'utf8').catch(error => {
        throw Object.assign(new Error(`${action}: ${error.message}`), { execCode: 'node/exec-failed' })
      })
      return tooBig
        ? { ok: true, output: Buffer.from(text, 'utf8').subarray(0, maxFileBytes).toString('utf8'), truncated: true, message: `文件 ${info.size} 字节，只读了前 ${maxFileBytes}` }
        : { ok: true, output: text }
    }

    case 'list_dir': {
      const located = await filePath(action, args, cwd)
      if (located.error !== undefined) return located.error
      let entries
      try {
        entries = await readdir(located.path, { withFileTypes: true })
      } catch (error) {
        return failed('node/exec-failed', `${action}: ${error.code === 'ENOENT' ? '目录不存在' : error.message}`)
      }
      const lines = []
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory()) {
          lines.push(`${entry.name}/`)
          continue
        }
        const size = await stat(join(located.path, entry.name)).then(info => info.size).catch(() => undefined)
        lines.push(size === undefined ? entry.name : `${entry.name}\t${size}`)
      }
      const output = lines.join('\n')
      return Buffer.byteLength(output, 'utf8') > limit
        ? { ok: true, output: Buffer.from(output, 'utf8').subarray(0, limit).toString('utf8'), truncated: true }
        : { ok: true, output }
    }

    case 'run_shell': {
      const command = args?.command
      if (typeof command !== 'string' || command.trim() === '') {
        return failed('node/exec-denied', `${action}: 缺少 command`)
      }
      return runShell(command, { cwd, limit, timeoutMs, env: context.env })
    }

    case 'push_file': {
      const located = await filePath(action, args, cwd)
      if (located.error !== undefined) return located.error
      let info
      try {
        info = await stat(located.path)
      } catch {
        return failed('node/exec-failed', `${action}: 文件不存在`)
      }
      if (!info.isFile()) return failed('node/exec-denied', `${action}: ${args.path} 是目录，不是文件`)
      if (info.size > maxFileBytes) {
        return failed('node/file-too-big', `${action}: ${info.size} 字节，超过单次上限 ${maxFileBytes}`)
      }
      return { ok: true, output: `${args.path}\t${info.size}`, files: [{ path: located.path, size: info.size }] }
    }

    case 'env_info':
    default: {
      // Reported without values: the point is "which machine is this", not
      // "what is in its environment".
      const parts = [
        `platform ${process.platform} ${process.arch}`,
        `node ${process.version}`,
        `cwd ${cwd}`,
        `shell ${process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : process.env.SHELL ?? '/bin/sh'}`,
      ]
      if (context.env?.NODE_VERSION !== undefined) parts.push(`reported node ${context.env.NODE_VERSION}`)
      return { ok: true, output: parts.join('\n') }
    }
  }
}

// A child that runs too long or talks too much is killed; both are reported as
// a completed call rather than an exception, because the caller is a model turn
// that has to keep going.
function runShell(command, { cwd, limit, timeoutMs, env }) {
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: sanitizeEnv(env ?? process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise(failed('node/exec-failed', `${command}: ${error.message}`))
      return
    }

    const chunks = []
    let bytes = 0
    let truncated = false
    let timedOut = false
    let settled = false

    // On Windows `shell: true` puts cmd.exe between us and the real process, so
    // killing the child alone leaves the grandchild holding the pipes and `close`
    // never fires. taskkill /T takes the tree.
    const stop = () => {
      if (process.platform === 'win32' && child.pid !== undefined) {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        } catch { /* already gone */ }
        return
      }
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    timer.unref?.()

    const collect = (chunk) => {
      if (truncated) return
      const room = limit - bytes
      if (chunk.length >= room) {
        chunks.push(chunk.subarray(0, room))
        bytes = limit
        truncated = true
        stop()
        return
      }
      chunks.push(chunk)
      bytes += chunk.length
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const output = Buffer.concat(chunks).subarray(0, limit).toString('utf8')
      if (timedOut) {
        resolvePromise({ ok: false, code: 'node/timeout', output, message: `${command} 超过 ${timeoutMs}ms 被中止` })
        return
      }
      if (truncated) {
        resolvePromise({ ok: true, output, truncated: true, message: `输出超过 ${limit} 字节，已截断` })
        return
      }
      if (code === 0) {
        resolvePromise({ ok: true, output })
        return
      }
      resolvePromise({
        ok: false,
        code: 'node/exec-failed',
        output,
        message: `${command} 退出码 ${code ?? signal}`,
      })
    }

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(failed('node/exec-failed', `${command}: ${error.message}`))
    })
    // `close` waits for the stdio to drain; when a tree was killed the survivor's
    // pipes can keep it from ever firing, so `exit` gets its own short path.
    child.on('exit', (code, signal) => { setTimeout(() => finish(code, signal), 100) })
    child.on('close', (code, signal) => finish(code, signal))
  })
}
