// 本文件由 AI 生成，请勿用于生产环境。
// 设置页上那个「输入配对码」的框背后：在本进程里连过去，当节点那一侧。
//
// 和主机侧的 hosting.js 正好反过来：那边开端口等人来，这边广播找人过去。
// 两边共用同一份 node/ 实现，所以装上同一个插件，一台机器既能当主机也能被控。
import { findHost } from '@dsbot/node-protocol/discovery'
import { connectTcp } from '@dsbot/node-protocol/tcp'
import { parseAgentCommand } from '../../node/agent.js'
import { deviceIdentity, servePeer } from '../../node/cli.js'

export function createJoiner({ home, rt, warn = () => {} }) {
  let peer = null
  let info = { running: false, code: null, host: null, since: null, error: null }
  // 主机群 id -> 本地镜像群 id。同一个群只建一次。
  const mirrors = new Map()
  let unwatch = null

  // ---- 镜像群 ----
  // 远端（手机上那台 DSH）本地也出现一个同名的群，消息按顺序写进去，
  // 用户在群里说话则转成 node.post 发回主机。只写日志，不触发本地 Bot 的轮次：
  // 群的 admin 留空，ds-bot 就不会把普通消息派给任何一个成员。
  // 群名要短，手机上群列表里一眼能认出来；主机地址太长了不放进名字。
  const mirrorName = (hostName, roomName) => `远程 · ${roomName ?? '群'}`

  async function ensureMirror(params) {
    if (rt === undefined) return undefined
    const hostRoomId = String(params.roomId ?? '')
    if (hostRoomId === '') return undefined
    const knownId = mirrors.get(hostRoomId)
    if (knownId !== undefined) {
      const knownRoom = rt.roomOf?.(knownId)
      if (knownRoom !== undefined) return knownRoom
      mirrors.delete(hostRoomId)
    }
    if (typeof rt.createRoom !== 'function') return undefined
    const wanted = mirrorName(info.host, params.roomName)
    // 重连之后内存里的映射没了：先按名字找回上次建的那个群，别一次一条地堆。
    const existing = Object.values(rt.state?.rooms ?? {}).find(room => room.name === wanted)
    if (existing !== undefined) {
      mirrors.set(hostRoomId, existing.id)
      return existing
    }
    const members = Object.keys(rt.state?.bots ?? {}).slice(0, 2)
    if (members.length < 2) {
      warn('镜像群建不了：本地至少要有两个 Bot（ds-bot 的群必须是两个成员起）')
      return undefined
    }
    const room = await rt.createRoom({
      members,
      name: wanted,
      // 关键：没有 admin 就没人会回应普通消息，镜像群不会自己吵起来。
      admin: null,
    })
    mirrors.set(hostRoomId, room.id)
    warn(`建好镜像群「${room.name}」`)
    return room
  }

  async function mirrorInto(params, lines) {
    const room = await ensureMirror(params)
    if (room === undefined) return
    for (const line of lines) {
      if (String(line.text ?? '') === '') continue
      // mirror 标记：下面 onRoomLine 靠它把"我们自己写进去的"和"用户真的说的"分开。
      rt.logRoom?.(room, {
        who: line.who ?? '',
        ...(line.botId === undefined ? {} : { botId: line.botId }),
        text: line.text,
        kind: line.kind,
        time: line.at,
        mirror: true,
      })
    }
    await rt.save?.()
  }

  // 用户在镜像群里说话 → 发回主机，由主机以这台机器的身份落进主机群。
  function watchMirror() {
    if (rt === undefined || typeof rt.onRoomLine !== 'function') return
    unwatch?.()
    unwatch = rt.onRoomLine((room, record) => {
      if (record?.mirror === true) return
      const hostRoomId = [...mirrors].find(([, local]) => local === room.id)?.[0]
      if (hostRoomId === undefined) return
      const text = String(record.text ?? '').trim()
      if (text === '' || peer === null) return
      peer.send({ method: 'node.post', params: { groupId: hostRoomId, text } })
      warn(`发到主机群：${text}`)
    })
  }

  function stop() {
    unwatch?.()
    unwatch = null
    if (peer !== null) {
      try { peer.close() } catch {}
      peer = null
    }
    info = { ...info, running: false }
  }

  async function start({ code, name, agent, cwd } = {}) {
    const clean = String(code ?? '').replace(/[\s-]/g, '').toUpperCase()
    if (clean.length < 6) {
      throw Object.assign(new Error('配对码是 6 位'), { code: 'node/bad-params' })
    }
    stop()
    info = { ...info, running: true, code: clean, error: null, host: null, since: Date.now() }

    try {
      // 先在局域网里喊一嗓子，谁认这个码谁应。
      const found = await findHost({ code: clean })
      const url = `tcp://${found.host}:${found.port}`
      peer = await connectTcp({ url, token: clean })
      const deviceId = await deviceIdentity(name)
      servePeer(peer, {
        name: name !== undefined && name !== '' ? name : (found.host ?? '这台机器'),
        deviceId,
        cwd: typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd(),
        agent: typeof agent === 'string' && agent !== '' ? parseAgentCommand(agent) : undefined,
        onGroupLine: (params, lines) => {
          void mirrorInto(params, lines).catch(error => warn(`镜像群写入失败：${error.message}`))
        },
      })
      info = { ...info, running: true, host: url }
      watchMirror()
      warn(`已连上主机 ${url}`)
      peer.on('close', () => {
        info = { ...info, running: false, error: '和主机断开了' }
        peer = null
      })
      return { ...info }
    } catch (error) {
      info = { ...info, running: false, error: error.message }
      throw error
    }
  }

  function status() {
    return { ...info }
  }

  return { start, stop, status }
}
