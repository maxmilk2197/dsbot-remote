// 本文件由 AI 生成，请勿用于生产环境。
// The host's record of remote nodes. Kept in its own file rather than in the Bot
// team's state.json: nodes have their own devices, their own tokens and their own
// lifetime, and a node's file must not be able to corrupt the team's.
//
// Tokens are stored as hashes. The plaintext exists once, in the pairing reply.
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { NodeFailure } from '@dsbot/node-protocol/errors'

// No 0/O/1/I/L: a code is read off a screen and typed on another machine.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_LENGTH = 6
const PAIRING_TTL_MS = 10 * 60_000

export const hashToken = token => createHash('sha256').update(String(token ?? '')).digest('hex')

function newCode() {
  let out = ''
  for (let index = 0; index < CODE_LENGTH; index += 1) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

const empty = () => ({ version: 1, devices: [], nodes: {}, pairings: {}, host: { code: null, port: 7777 } })

export function createNodeStore({ home, readOnly = () => undefined, warn = () => {}, now = () => Date.now() }) {
  const file = join(home, 'nodes.json')
  let data = empty()
  let loaded = false

  // 读失败过就是 broken：此时任何写操作都会把磁盘上那份真的记录盖成空。
  let broken = null
  const writable = () => readOnly() === undefined && broken === null
  const guard = () => {
    if (broken !== null) {
      throw new NodeFailure('node/read-only', `nodes.json 读不出来，这次先不写：${broken.message}`)
    }
    if (writable()) return undefined
    throw new NodeFailure('node/read-only', readOnly())
  }

  async function load() {
    if (loaded) return data
    loaded = true
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      data = {
        version: 1,
        devices: Array.isArray(parsed?.devices) ? parsed.devices : [],
        nodes: parsed?.nodes && typeof parsed.nodes === 'object' ? parsed.nodes : {},
        pairings: parsed?.pairings && typeof parsed.pairings === 'object' ? parsed.pairings : {},
        host: parsed?.host && typeof parsed.host === 'object'
          ? { code: parsed.host.code ?? null, port: Number(parsed.host.port) || 7777 }
          : { code: null, port: 7777 },
      }
    } catch (error) {
      if (error.code === 'ENOENT') return data
      // 文件在、但读不懂（半个 JSON、被锁住、编码坏了）：这一次运行绝对不许写盘。
      // 空数据写回去就是把用户已经连过的机器全部抹掉 —— 而这只需要一次读盘抖动。
      broken = error
      warn(`nodes.json 读不出来（${error.message}）：这次不写盘，免得把已有记录盖掉`)
    }
    return data
  }

  let queue = Promise.resolve()
  function save() {
    // 读坏了就别写：见 load() 里 broken 的说明。
    if (broken !== null) return Promise.resolve()
    // 串行化：两次 save 共用同一个 .tmp 名，撞上了会互相把对方的 rename 弄没。
    const run = async () => {
    guard()
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    const payload = `${JSON.stringify(data, null, 2)}
`
    // 里面有 host.code 明文（配对码 = 网络密钥的种子），不该让同机别的用户读。
    await writeFile(tmp, payload, { mode: 0o600 })
    // Windows 上杀软/同步盘会短暂锁住刚写的文件，rename 报 EPERM。
    // 重试两次，还不行就直接覆盖写：内容一样，只是少了一次原子切换。
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(tmp, file)
        return
      } catch (error) {
        if (attempt >= 2) {
          await writeFile(file, payload, { mode: 0o600 })
          await rm(tmp, { force: true })
          return
        }
        warn(`nodes.json 落盘重试 ${attempt + 1}：${error.code ?? error.message}`)
        await new Promise(resolve => setTimeout(resolve, 15 * (attempt + 1)))
      }
    }
    }
    queue = queue.then(run, run)
    return queue
  }

  // Returns whether anything was actually dropped, so an expired code is cleaned
  // up on disk without every failed attempt paying for a write.
  const prunePairings = () => {
    const at = now()
    let changed = false
    for (const [code, pairing] of Object.entries(data.pairings)) {
      if (pairing.expiresAt <= at) {
        delete data.pairings[code]
        changed = true
      }
    }
    return changed
  }

  return {
    flush: () => queue,
    file,
    load,
    save,

    list() {
      return Object.values(data.nodes).sort((a, b) => a.createdAt - b.createdAt)
    },

    node(id) {
      return data.nodes[id]
    },

    async add({ name, botId, botName, deviceId, tokenHash, groups = [] }) {
      guard()
      await load()
      const id = `n-${randomBytes(4).toString('hex')}`
      const node = {
        id,
        name: String(name ?? '').slice(0, 64) || id,
        botId,
        botName: String(botName ?? '').slice(0, 64),
        deviceId,
        tokenHash,
        groups: [...groups],
        createdAt: now(),
        lastSeenAt: undefined,
        status: 'offline',
      }
      data.nodes[id] = node
      await save()
      return node
    },

    async update(id, patch) {
      guard()
      const node = data.nodes[id]
      if (node === undefined) return undefined
      Object.assign(node, patch)
      await save()
      return node
    },

    async remove(id) {
      guard()
      await load()
      const node = data.nodes[id]
      if (node === undefined) return undefined
      delete data.nodes[id]
      data.devices = data.devices.filter(device => device.deviceId !== node.deviceId)
      await save()
      return node
    },

    // A pairing code is opened by the host, shown to the user, and typed on the
    // other machine. It admits exactly one node and expires.
    async openPairing({ botId, groupId, ttlMs = PAIRING_TTL_MS }) {
      guard()
      await load()
      prunePairings()
      let code = newCode()
      while (data.pairings[code] !== undefined) code = newCode()
      const pairing = { code, botId, groupId, expiresAt: now() + ttlMs }
      data.pairings[code] = pairing
      await save()
      return pairing
    },

    // Consumes the code. Returns the pairing, or undefined when the code is
    // wrong, already used, or too old — the caller cannot tell which, and should
    // not: a probe must not learn whether a code ever existed.
    async redeemPairing(code, { deviceId } = {}) {
      guard()
      await load()
      const pruned = prunePairings()
      const key = String(code ?? '').toUpperCase().trim()
      const pairing = data.pairings[key]
      if (pairing === undefined) {
        if (pruned && writable()) await save()
        return undefined
      }
      if (deviceId !== undefined && !data.devices.some(device => device.deviceId === deviceId)) {
        data.devices.push({ deviceId, at: now() })
      }
      delete data.pairings[key]
      await save()
      return pairing
    },

    // Constant-time-ish: both sides are hex of the same length, and a mismatch
    // in any byte fails the whole comparison.
    authenticate(nodeId, token) {
      const node = data.nodes[nodeId]
      if (node === undefined || typeof token !== 'string' || token === '') return undefined
      const given = hashToken(token)
      const want = String(node.tokenHash ?? '')
      if (given.length !== want.length) return undefined
      let diff = 0
      for (let index = 0; index < given.length; index += 1) diff |= given.charCodeAt(index) ^ want.charCodeAt(index)
      return diff === 0 ? node : undefined
    },

    // 主机自己的配对码：远程输这个码就能找过来。换码 = 换一把新钥匙。
    async host() {
      await load()
      return { ...data.host }
    },

    async setHost(patch) {
      guard()
      await load()
      data.host = { ...data.host, ...patch }
      await save()
      return { ...data.host }
    },

    newCode,

    async touch(id, status) {
      const node = data.nodes[id]
      if (node === undefined) return undefined
      node.lastSeenAt = now()
      node.status = status
      if (writable()) await save()
      return node
    },
  }
}
