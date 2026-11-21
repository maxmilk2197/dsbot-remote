// 本文件由 AI 生成，请勿用于生产环境。
// Bytes a remote node pushes, landing in a per-node outbox on the host.
//
// The remote controls `name`, so the name is the interesting part: it is reduced
// to a bare file name, stripped of anything Windows reserves, and never allowed
// to leave its own directory. Writes go through a `.part` file so an interrupted
// upload cannot look finished.
import { createHash } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { MAX_FILE_BYTES } from '../../protocol/version.js'

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i
const ILLEGAL = /[\u0000-\u001f<>:"|?*\u007f]/g
const NAME_MAX = 128

const fail = (code, message) => ({ ok: false, code, message })

// A node id becomes one directory name; anything with structure in it is hashed
// away rather than trusted.
export function safeSegment(value) {
  const raw = String(value ?? '')
  if (/^[\w.-]{1,64}$/.test(raw) && !raw.startsWith('.')) return raw
  return `x-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`
}

export function outboxDir(home, nodeId) {
  return join(resolve(home), 'nodes', safeSegment(nodeId), 'outbox')
}

// One layer only: no separators survive, no leading dots, no device names, and
// the extension is the part that gets kept when the stem has to be cut.
export function safeName(name) {
  const last = String(name ?? '').split(/[\\/]/).pop() ?? ''
  const cleaned = last.replace(ILLEGAL, '_').trim().replace(/^\.+/, '')
  if (cleaned === '') return ''
  const ext = extname(cleaned)
  let stem = ext === '' ? cleaned : cleaned.slice(0, -ext.length)
  stem = stem.replace(/^\.+/, '').trim()
  if (stem === '') stem = 'file'
  const suffix = ext.length > 16 ? '' : ext
  const room = NAME_MAX - suffix.length
  const cut = stem.length > room ? stem.slice(0, Math.max(room, 1)) : stem
  const candidate = `${cut}${suffix}`
  return RESERVED.test(candidate) ? `_${candidate}` : candidate
}

function withSuffix(name, index) {
  if (index === 0) return name
  const ext = extname(name)
  const stem = ext === '' ? name : name.slice(0, -ext.length)
  return `${stem}-${index}${ext}`
}

function uniquePath(dir, name) {
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = join(dir, withSuffix(name, index))
    if (!existsSync(candidate)) return candidate
  }
  return join(dir, `${Date.now()}-${name}`)
}

async function* chunksOf(data) {
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
    yield Buffer.from(data)
    return
  }
  if (typeof data === 'string') {
    yield Buffer.from(data, 'utf8')
    return
  }
  for await (const chunk of data ?? []) yield Buffer.from(chunk)
}

export async function acceptUpload({ home, nodeId, name, data, maxBytes = MAX_FILE_BYTES }) {
  const safe = safeName(name)
  if (safe === '') return fail('node/bad-params', '文件名不能为空')

  const dir = outboxDir(home, nodeId)
  await mkdir(dir, { recursive: true })

  const hash = createHash('sha256')
  const parts = []
  let bytes = 0
  for await (const chunk of chunksOf(data)) {
    bytes += chunk.length
    if (bytes > maxBytes) {
      return fail('node/file-too-big', `${bytes} 字节，超过单次上限 ${maxBytes}`)
    }
    hash.update(chunk)
    parts.push(chunk)
  }

  const target = uniquePath(dir, safe)
  const part = `${target}.part`
  try {
    await writeFile(part, Buffer.concat(parts))
    await rename(part, target)
  } catch (error) {
    await rm(part, { force: true })
    return fail('node/exec-failed', `写入 ${safe} 失败：${error.message}`)
  }

  return {
    ok: true,
    path: target,
    name: basename(target),
    bytes,
    sha256: hash.digest('hex'),
    renamed: basename(target) !== safe,
  }
}
