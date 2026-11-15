// 本文件由 AI 生成，请勿用于生产环境。
// 远端镜像群：让"加入别人群"的那台机器上，ds-bot 里真的出现这个群。
//
// 为什么不是随便造个 room：ds-bot 的群聊页面读的是 room.log，而写入它的正规入口
// 是 groups.js 的 logRoom ⇒ say()。say() 会 seq++、落 ledger、写 room.log、通知
// 监听器 —— 但它**不派轮次**，那才是我们要的：消息看得见，本地 Bot 不出声。
//
// 两条方向：
//   host→remote  rt.logRoom(room, { ..., mirror: true })
//   remote→host  用户在群里说话（rt.onRoomLine）→ node.post 回主机
// mirror 标记是这两条之间的分界线：没有它，自己写进去的行会被当成用户发言再发回去，
// 主机又推回来，转成死循环。

// 群名短一点：手机上的群列表里一眼能认出来，主机地址不往里塞。
export const mirrorName = roomName => `远程 · ${roomName || '群'}`

export function createMirror({ rt, warn = () => {} }) {
  const mirrors = new Map()   // 主机群 id -> 本地群 id
  const listeners = new Set()
  let peer = null

  const localRoom = id => (id === undefined ? undefined : rt.roomOf?.(id))
  const rooms = () => Object.values(rt.state?.rooms ?? {})

  /**
   * 找到（或建好）这个主机群在本地对应的群。
   * 一个群只建一次；重连之后内存里的映射没了，就按名字找回来。
   */
  async function ensure(params) {
    if (rt === undefined) return undefined
    const hostRoomId = String(params?.roomId ?? '')
    if (hostRoomId === '') return undefined

    const known = localRoom(mirrors.get(hostRoomId))
    if (known !== undefined) return known

    if (typeof rt.createRoom !== 'function') return undefined
    const wanted = mirrorName(params?.roomName)
    const existing = rooms().find(room => room.name === wanted)
    if (existing !== undefined) {
      mirrors.set(hostRoomId, existing.id)
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
      // 关键：没有 admin，ds-bot 就不会把普通消息派给任何成员。
      // 有 admin 的话，你在镜像群说一句话，本地 Bot 就会跑一轮，和主机重复回应。
      admin: null,
    })
    mirrors.set(hostRoomId, room.id)
    warn(`建好镜像群「${room.name}」`)
    return room
  }

  /** 把主机推来的消息写进镜像群。只写日志，不触发任何轮次。 */
  async function write(params, lines) {
    const room = await ensure(params)
    if (room === undefined) return { written: 0 }
    let written = 0
    for (const line of lines ?? []) {
      const text = String(line?.text ?? '')
      if (text === '') continue
      rt.logRoom?.(room, {
        who: line.who ?? '',
        ...(line.botId === undefined ? {} : { botId: line.botId }),
        text,
        ...(line.kind === undefined ? {} : { kind: line.kind }),
        time: line.at,
        mirror: true,
      })
      written += 1
    }
    await rt.save?.()
    return { written, room }
  }

  /** 用户在镜像群里说的话，转成 node.post 发回主机。 */
  function onLocalLine(room, record) {
    if (record?.mirror === true) return false
    if (peer === null) return false
    const hostRoomId = [...mirrors].find(([, local]) => local === room?.id)?.[0]
    if (hostRoomId === undefined) return false
    const text = String(record?.text ?? '').trim()
    if (text === '') return false
    peer.send({ method: 'node.post', params: { groupId: hostRoomId, text } })
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

  return { ensure, write, bind, stop, onLocalLine, mirrors }
}
