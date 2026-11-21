// 本文件由 AI 生成，请勿用于生产环境。
// 远端镜像群：让"加入别人群"的那台机器上，ds-bot 里真的出现这个群。
//
// 为什么不是随便造个 room：ds-bot 的群聊页面读的是 room.log，而写入它的正规入口
// 是 groups.js 的 logRoom ⇒ say()。say() 会 seq++、落 ledger、写 room.log、通知
// 监听器 —— 但它**不派轮次**，那才是我们要的：消息看得见，本地 Bot 不出声。
//
// 两条方向：
//   host→remote  rt.logRoom(room, { ..., seq, mirror: true })
//   remote→host  用户在群里说话（rt.onRoomLine）→ node.post 回主机
// mirror 标记是这两条之间的分界线：没有它，自己写进去的行会被当成用户发言再发回去，
// 主机又推回来，转成死循环。
//
// 重连时主机会先把最近一段历史用 group.snapshot 重发一遍。以前这里无条件
// logRoom，每重连一次群里就多一份重复历史。现在每条都带主机的 seq，按群记水位：
// 不比水位新的直接跳过，水位也回给主机（node.hello.cursors），主机据此只补缺口。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join as joinPath } from 'node:path'

// 群名短一点：手机上的群列表里一眼能认出来，主机地址不往里塞。
export const mirrorName = roomName => `远程 · ${roomName || '群'}`

const STATE_FILE = 'mirror-state.json'

export function createMirror({ rt, warn = () => {}, home } = {}) {
  const mirrors = new Map()   // `${hostId}|${主机群 id}` -> 本地群 id（同名群靠主机区分）
  const listeners = new Set()
  // `${hostId}|${主机群 id}` -> { roomId, name, seq }
  // seq 是这个群已经落到本地的最大序号：重连时挡掉重复行，也用来告诉主机从哪接着要。
  // bots：主机那边的 Bot id → 本地替身的 id。镜像群的成员表要长得和主机一样，
  // 所以每个主机成员在本地都要有一个名字相同的 Bot（没有就借同名的，再没有才造）。
  const state = { version: 1, hostId: '', rooms: {}, bots: {} }
  const file = typeof home === 'string' && home !== '' ? joinPath(home, STATE_FILE) : null
  let peer = null
  let hostId = 'host'
  let loaded = null

  const localRoom = id => (id === undefined ? undefined : rt?.roomOf?.(id))
  const rooms = () => Object.values(rt?.state?.rooms ?? {})
  const keyOf = hostRoomId => `${hostId}|${hostRoomId}`

  // 镜像群的记号：写入 room.mirror = true 之后，ds-bot 的 openingCall（插件启动时自补）
  // 见到它就不叫任何成员 —— 镜像群只是镜子，说话的是主机那边的人。
  function markMirror(room) {
    if (room === undefined || room.mirror === true) return false
    room.mirror = true
    return true
  }

  // 本机刚发回主机的那句话：主机会把它当用户消息写进主机群，再推回来一条一模一样的。
  // 20 秒内同文只吞一次，免得把别人真的重复发言也吃掉。
  const sentTexts = []
  function rememberSent(text) {
    sentTexts.push({ text, at: Date.now() })
    while (sentTexts.length > 20) sentTexts.shift()
  }
  function takeSent(text) {
    const now = Date.now()
    const index = sentTexts.findIndex(each => each.text === text && now - each.at < 20_000)
    if (index < 0) return false
    sentTexts.splice(index, 1)
    return true
  }

  async function load() {
    if (loaded !== null) return loaded
    loaded = (async () => {
      if (file === null) return
      try {
        const raw = JSON.parse(await readFile(file, 'utf8'))
        if (raw !== null && typeof raw === 'object' && typeof raw.hostId === 'string') state.hostId = raw.hostId.slice(0, 64)
        if (raw !== null && typeof raw === 'object' && raw.bots !== null && typeof raw.bots === 'object') {
          for (const [key, id] of Object.entries(raw.bots)) {
            if (typeof id === 'string' && id !== '') state.bots[key] = id
          }
        }
        if (raw !== null && typeof raw === 'object' && raw.rooms !== null && typeof raw.rooms === 'object') {
          for (const [key, entry] of Object.entries(raw.rooms)) {
            if (entry === null || typeof entry !== 'object') continue
            const roomId = String(entry.roomId ?? '')
            if (roomId === '') continue
            const seq = Number(entry.seq)
            state.rooms[key] = {
              roomId,
              name: String(entry.name ?? ''),
              seq: Number.isFinite(seq) && seq > 0 ? seq : 0,
            }
            // 进度文件里的群如果本地还在，直接登记回来：重启之后用户先在镜像群说一句话，
            // 那句也要能回传，不能等主机先推一条才认识这个群。
            const found = localRoom(roomId)
            if (found !== undefined) {
              mirrors.set(key, found.id)
              markMirror(found)
            }
          }
        }
      } catch (error) {
        // 文件不存在是正常的（第一次跑）；真读坏了只提示一句，不能把镜像整个停掉。
        if (error?.code !== 'ENOENT') warn(`镜像进度读不出来（${error.message}），按空的算`)
      }
    })()
    return loaded
  }

  async function save() {
    if (file === null) return
    try {
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, file)
    } catch (error) {
      warn(`镜像进度没写下去：${error.message}`)
    }
  }

  /** 主机是谁：两台主机可能有同名群，镜像群靠这个区分，不靠群名。 */
  function setHost(next) {
    const clean = String(next ?? '').trim()
    if (clean !== '') hostId = state.hostId = clean.slice(0, 64)
  }

  /**
   * 找到（或建好）这个主机群在本地对应的群。
   * 一个群只建一次；重连 / 重启之后先按进度文件里的 roomId 找，再按名字认领。
   */
  const pending = new Map()   // key -> 正在建的 Promise

  async function ensure(params) {
    if (rt === undefined) return undefined
    const roomObj = params?.room ?? {}
    const hostRoomId = String(params?.roomId ?? roomObj.id ?? '')
    if (hostRoomId === '') return undefined
    await load()

    const key = keyOf(hostRoomId)
    const known = localRoom(mirrors.get(key) ?? state.rooms[key]?.roomId)
    if (known !== undefined) {
      mirrors.set(key, known.id)
      markMirror(known)
      return known
    }
    // hello 回执和 group.snapshot 可能同时触发同一个群，不能建出两个。
    const inflight = pending.get(key)
    if (inflight !== undefined) return inflight

    const job = (async () => {
      if (typeof rt.createRoom !== 'function') return undefined
      const base = mirrorName(params?.roomName ?? roomObj.name)
      // 别的 host 已经用掉的名字不能再认领：两台机器的「工作」是两个群。
      const taken = new Set()
      for (const [otherKey, entry] of Object.entries(state.rooms)) {
        if (otherKey === key) continue
        taken.add(entry.roomId)
      }
      const claimedName = name => rooms().some(room => room.name === name && taken.has(room.id))
      let wanted = base
      if (claimedName(wanted)) {
        wanted = `${base} · ${hostId.slice(0, 4)}`
        if (claimedName(wanted)) wanted = `${base} · ${hostId.slice(0, 8)}`
      }
      // 升级前建的群没有进度记录：名字对得上、又没被别的主机占，就认作自己的。
      const existing = rooms().find(room => room.name === wanted && !taken.has(room.id))
      if (existing !== undefined) {
        mirrors.set(key, existing.id)
        markMirror(existing)
        state.rooms[key] = { roomId: existing.id, name: existing.name, seq: state.rooms[key]?.seq ?? 0 }
        await save()
        return existing
      }

      // ds-bot 的群规定至少两个 Bot 成员。少一个就只能报一句，不能硬造 ——
      // 造出来的群在界面上是坏的，比没有更糟。
      const members = Object.keys(rt.state?.bots ?? {}).slice(0, 2)
      if (members.length < 2) {
        warn('镜像群建不了：本地至少要有两个 Bot（ds-bot 的群两个成员起）')
        return undefined
      }
      const room = await rt.createRoom({
        members,
        name: wanted,
        // 建群时不带 admin：建群过程中不派活。真正的「不许成员说话」靠下面这行
        // room.mirror = true —— 插件启动时会给 ds-bot 的 openingCall 打补丁，见到它就
        // 返回空名单。以前以为 admin:null 就不会派活，其实正好相反：没有 admin 时
        // 所有成员都会答，于是镜像群里的替身 Bot 用自己的模型替主机的人发言。
        admin: null,
      })
      mirrors.set(key, room.id)
      markMirror(room)
      state.rooms[key] = { roomId: room.id, name: room.name ?? wanted, seq: state.rooms[key]?.seq ?? 0 }
      await save()
      warn(`建好镜像群「${room.name}」`)
      return room
    })()
    pending.set(key, job)
    try { return await job } finally { pending.delete(key) }
  }

  /** 主机某个成员在本地对应的替身 Bot：优先同名，其次新建。 */
  async function standInFor(hostBotId, name) {
    const key = `${hostId}|${hostBotId}`
    const knownId = state.bots[key]
    if (knownId !== undefined) {
      const known = rt.botOf?.(knownId)
      if (known !== undefined) {
        // 主机那边改名了，这边跟着改 —— 否则成员表又对不上。
        if (known.name !== name) known.name = name.slice(0, 40)
        return knownId
      }
      delete state.bots[key]
    }
    // 本地已经有同名的 Bot 就直接用：镜像群要的是"名单看起来一样"，
    // 不必为每个主机成员再养一个从不说话的复制品。
    const sameName = Object.values(rt.state?.bots ?? {}).find(bot => bot?.name === name)
    if (sameName !== undefined) {
      state.bots[key] = sameName.id
      return sameName.id
    }
    if (typeof rt.createBot !== 'function') return undefined
    const created = await rt.createBot({ name: name.slice(0, 40), pickModel: true })
    delete created.kickoff
    state.bots[key] = created.id
    return created.id
  }

  /**
   * 把镜像群的成员表对齐主机：主机群里有哪些 Bot，这边就摆哪些替身。
   * 以前这里随手挑前两个本地 Bot，远端看到的是「Chief / 新 Bot」——
   * 和主机群里的人完全不是一回事。
   */
  async function syncMembers(room, bots) {
    if (room === undefined || !Array.isArray(bots) || bots.length === 0) return
    const wanted = []
    for (const each of bots) {
      const hostBotId = String(each?.id ?? '')
      const name = String(each?.name ?? '').trim()
      if (hostBotId === '' || name === '') continue
      // 造替身要选模型、写盘，可能失败。一个成员没造出来不该让整条推送一起丢掉 ——
      // 少一个人也比群消息一条都写不进去强。
      let local
      try {
        local = await standInFor(hostBotId, name)
      } catch (error) {
        warn(`镜像群的那个成员没造出来（${name}）：${error?.message ?? error}`)
      }
      if (local !== undefined && !wanted.includes(local)) wanted.push(local)
    }
    if (wanted.length === 0) return
    const current = room.members ?? []
    const add = wanted.filter(id => !current.includes(id))
    // ds-bot 的群至少要有两个成员：主机群本来就够，但只剩一个时宁可留着旧的。
    const remove = wanted.length >= 2 ? current.filter(id => !wanted.includes(id)) : []
    if (add.length === 0 && remove.length === 0) return
    try {
      await rt.updateRoom?.(room.id, { add, remove })
      if (add.length > 0 || remove.length > 0) {
        warn(`镜像群「${room.name}」成员对齐主机：${wanted.length} 人${add.length > 0 ? `，新增 ${add.length}` : ''}${remove.length > 0 ? `，移出 ${remove.length}` : ''}`)
      }
      await save()
    } catch (error) {
      warn(`镜像群成员同步失败：${error.message}`)
    }
  }

  /** 把主机推来的消息写进镜像群。只写日志，不触发任何轮次。 */
  async function write(params, lines) {
    const room = await ensure(params)
    if (room === undefined) return { written: 0 }
    const marked = markMirror(room)
    // 每条推送都带一遍成员表：主机那边加了人，这边下一次就跟着变。
    await syncMembers(room, params?.bots)
    const roomObj = params?.room ?? {}
    const hostRoomId = String(params?.roomId ?? roomObj.id ?? '')
    const key = keyOf(hostRoomId)
    const entry = state.rooms[key] ?? (state.rooms[key] = { roomId: room.id, name: room.name ?? '', seq: 0 })
    let written = 0
    let stale = 0
    for (const line of lines ?? []) {
      const text = String(line?.text ?? '')
      if (text === '') continue
      // 自己刚从这边发出去的话被主机推回来了：跳过，群里不多一份。
      if (line?.botId === undefined && line?.kind === undefined && takeSent(text.trim())) { stale += 1; continue }
      const seq = Number(line?.seq)
      const sequenced = Number.isFinite(seq) && seq > 0
      // 快照会把最后一段重发一遍：序号不比水位新的，本地已经有了。
      if (sequenced && seq <= entry.seq) { stale += 1; continue }
      rt.logRoom?.(room, {
        who: line.who ?? '',
        ...(line.botId === undefined ? {} : { botId: line.botId }),
        text,
        ...(line.kind === undefined ? {} : { kind: line.kind }),
        ...(sequenced ? { seq } : {}),
        time: line.at,
        mirror: true,
      })
      if (sequenced) entry.seq = seq
      written += 1
    }
    await rt.save?.()
    if (written > 0 || marked) await save()
    // 这几个数字是排「主机发的消息没到」用的：收到几条、写进去几条、水位在哪。
    return { written, room, received: (lines ?? []).length, stale, level: entry.seq }
  }

  /** 各个主机群已经收到哪儿了：握手时带给主机，让它只补缺口。 */
  function cursors() {
    const out = {}
    for (const [key, entry] of Object.entries(state.rooms)) {
      // 只报上次那台主机的水位：换一台主机时群 id 可能撞车，报错了会让它少发一段。
      if (state.hostId !== '' && !key.startsWith(`${state.hostId}|`)) continue
      const hostRoomId = key.slice(key.indexOf('|') + 1)
      if (hostRoomId === '' || !Number.isFinite(entry.seq) || entry.seq <= 0) continue
      out[hostRoomId] = entry.seq
    }
    return out
  }

  /** 用户在镜像群里说的话，转成 node.post 发回主机。 */
  function onLocalLine(room, record) {
    if (record?.mirror === true) return false
    if (peer === null) return false
    // 只转「人」的话。镜像群里的替身 Bot 不开口（见 markMirror）；主机 Bot 说过的话
    // 已经由主机推过来了，再回传就是自己跟自己说话。kind 行是状态（working/done/notice），
    // 也不属于对话。
    if (record?.botId !== undefined) return false
    if (record?.kind !== undefined) return false
    const hit = [...mirrors].find(([, local]) => local === room?.id)
    // key 是 `${hostId}|${主机群 id}`：回给主机的是后半段。
    const hostRoomId = hit === undefined ? undefined : hit[0].slice(hit[0].indexOf('|') + 1)
    if (hostRoomId === undefined) return false
    const text = String(record?.text ?? '').trim()
    if (text === '') return false
    peer.send({ method: 'node.post', params: { groupId: hostRoomId, text } })
    rememberSent(text)
    warn(`发到主机群：${text}`)
    return true
  }

  function bind(nextPeer) {
    peer = nextPeer
    if (typeof rt?.onRoomLine !== 'function') return
    const listener = (room, record) => {
      try { onLocalLine(room, record) } catch (error) { warn(`镜像群回传失败：${error.message}`) }
    }
    const off = rt.onRoomLine(listener)
    if (typeof off === 'function') listeners.add(off)
  }

  function stop() {
    for (const off of listeners) {
      try { off() } catch { /* 已经摘掉了 */ }
    }
    listeners.clear()
    peer = null
  }

  /**
   * 连上主机时先把它给的群都建出来，不用等第一条消息。
   * hello 回执里只有这台机器真正进了的群，不会把无关的群灌进来。
   */
  async function ensureAll(groups) {
    let made = 0
    for (const group of groups ?? []) {
      if (group === null || group === undefined) continue
      const id = String(group.id ?? group.roomId ?? '')
      if (id === '') continue
      const room = await ensure({ roomId: id, roomName: group.name ?? group.roomName })
      if (room !== undefined) {
        if (markMirror(room)) await save()
        await syncMembers(room, group.bots)
        made += 1
      }
    }
    return made
  }

  return { ensure, ensureAll, write, bind, stop, onLocalLine, mirrors, cursors, setHost, load }
}
