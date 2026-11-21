// 本文件由 AI 生成，请勿用于生产环境。
// 把一台远程节点变成群里的一个成员。
//
// 这里一行都不碰 groups.js：远程成员在群里就是一个普通 Bot ——
//   state.bots[id].model = 'node:<id>/default'
// groups.js 轮到它发言时，用这个 model 去 ctx.llm 找 adapter，找到的是我们的
// RemoteLlmAdapter，于是这一轮被送到那台机器上跑，跑出来的字照常写进群。
//
// 所以"远程 Bot 进群"这件事，本质上只是两处数据：
//   1) 造一个 model 指向 node: 的 Bot
//   2) 把这个 Bot 的 id 放进 room.members
import { nodeIdOf, routeOf } from './adapter.js'
import { isAddressLike } from './naming.js'

export const proxyModel = nodeId => `${routeOf(nodeId)}/default`

// 名字不能撞车：群里 @ 谁靠名字认人，重名之后 @ 会把话递给两个人。
// exceptId：改名时要在"除自己以外"里找，否则自己那个名字永远算撞车。
const nameTaken = (rt, name, exceptId) =>
  Object.values(rt.state?.bots ?? {}).some(bot => bot?.name === name && (exceptId === undefined || bot?.id !== exceptId))

const uniqueName = (rt, wanted, exceptId) => {
  const base = String(wanted ?? '').trim().slice(0, 40) || '远程节点'
  if (!nameTaken(rt, base, exceptId)) return base
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base.slice(0, 37)} ${n}`
    if (!nameTaken(rt, candidate, exceptId)) return candidate
  }
  throw Object.assign(new Error(`群里已经有太多叫 ${base} 的 Bot 了`), { code: 'node/bad-params' })
}

/**
 * 造一个"代表远程节点"的 Bot。它不发欢迎语 —— 它的第一句话应该是群里那一轮。
 * pickModel 让 createBot 不要先挑一个本机模型，否则欢迎语会先在本机跑一轮。
 */
export async function createProxyBot({ rt, name, role = '', avatar }) {
  const cleanName = uniqueName(rt, name)
  const bot = await rt.createBot({
    name: cleanName,
    role: String(role ?? '').slice(0, 24),
    ...(avatar === undefined ? {} : { avatar }),
    // 不选模型 → createBot 把欢迎语存进 bot.kickoff 而不发送（buildBot 里的分支）。
    pickModel: true,
  })
  // 那句欢迎语是给"用户刚创建这个 Bot"写的，对代理 Bot 不成立。
  delete bot.kickoff
  return bot
}

/**
 * 把远程节点接进一个群。
 * 返回 { botId, botName, room, created } —— created 说明这次是不是新造了一个成员 Bot。
 */
export async function bindNodeToGroup({ rt, store, nodeId, groupId, name, role, avatar, cwd }) {
  const node = store.node(nodeId)
  if (node === undefined) throw Object.assign(new Error(`没有这个节点：${nodeId}`), { code: 'node/not-found' })
  // 没配 agent 的机器进了群也不能发言：它的每一轮都会以"跑不了 turn"收场。
  // 与其让群里多一个永远出错的成员，不如在这里把原因说清楚。
  if (Array.isArray(node.caps) && !node.caps.includes('agent')) {
    throw Object.assign(new Error(
      `${node.name} 没配 agent，进了群也不能发言。在它那台机器的「远程节点」里填一个 agent 命令（例如 dsh -p）再连一次。`,
    ), { code: 'node/no-agent' })
  }
  const room = rt.roomOf(groupId)
  if (room === undefined) throw Object.assign(new Error(`没有这个群：${groupId}`), { code: 'node/not-found' })
  if ((room.members ?? []).length >= 32) {
    throw Object.assign(new Error(`群 ${room.name} 的成员已经满了`), { code: 'node/denied' })
  }

  // 一台机器只代表一个成员：重绑时沿用原来那个 Bot，别在群里多出一个同名的人。
  // 先看 node 自己记着的那个；记着的丢了（nodes.json 被写空过、旧版本留下的副本），
  // 再退一步在群里找 model 指向这台机器的 Bot —— 只有后者能认出来"这就是我"。
  const existing = node.botId === undefined ? undefined : rt.botOf(node.botId)
  const twin = existing !== undefined
    ? undefined
    : (room.members ?? [])
      .map(id => rt.botOf(id))
      .find(bot => bot !== undefined && nodeIdOf(String(bot.model ?? '')) === nodeId)
  const bot = existing ?? twin ?? await createProxyBot({ rt, name: name ?? node.name, role, avatar })

  bot.model = proxyModel(nodeId)
  if (cwd !== undefined && cwd !== '') bot.workDir = cwd
  await rt.save()
  // 把模型写进它自己的 chat 与它已经在的各个群 Session；失败不致命，
  // 真正跑起来时 useSelectedModel 还会再看一眼 bot.model。
  await rt.applyModel?.(bot).catch(error => rt.warn?.('dsbot-nodes: applying %s failed: %s', bot.name, error))

  await rt.updateRoom(groupId, { add: [bot.id] })

  // 历史副本：同一个群里还有别的 Bot 也指着这台机器（并发点击的产物，或者
  // nodes.json 被写空前后各建过一次）。留现在这个，其余收掉 —— 否则群里会
  // 同时站着"手机"和"手机 2"，用户根本分不清哪个在干活。
  for (const memberId of [...(rt.roomOf(groupId)?.members ?? [])]) {
    if (memberId === bot.id) continue
    const other = rt.botOf(memberId)
    if (other === undefined || nodeIdOf(String(other.model ?? '')) !== nodeId) continue
    await rt.updateRoom(groupId, { remove: [memberId] })
      .catch(error => rt.warn?.('dsbot-nodes: dropping the duplicate %s failed: %s', other.name, error))
    await rt.deleteBot?.(memberId)
      .catch(error => rt.warn?.('dsbot-nodes: deleting the duplicate %s failed: %s', other.name, error))
    rt.warn?.('dsbot-nodes: 收掉重复的成员 %s（和 %s 指向同一台机器）', other.name, bot.name)
  }

  await store.update(nodeId, {
    botId: bot.id,
    botName: bot.name,
    groups: [...new Set([...(node.groups ?? []), groupId])],
  })
  await store.save?.()

  return { botId: bot.id, botName: bot.name, room, created: existing === undefined && twin === undefined }
}

/**
 * 把一个远程成员从群里拿掉。Bot 本身留着 —— 它可能还在别的群，
 * 也可能只是这台机器暂时不干活。
 */
export async function unbindNodeFromGroup({ rt, store, nodeId, groupId }) {
  const node = store.node(nodeId)
  if (node === undefined) throw Object.assign(new Error(`没有这个节点：${nodeId}`), { code: 'node/not-found' })
  const botId = node.botId
  if (botId !== undefined && rt.botOf(botId) !== undefined) {
    const room = rt.roomOf(groupId)
    if (room !== undefined && (room.members ?? []).includes(botId)) {
      await rt.updateRoom(groupId, { remove: [botId] })
    }
  }
  const groups = (node.groups ?? []).filter(id => id !== groupId)
  await store.update(nodeId, { groups, ...(groups.length === 0 ? { botId: undefined, botName: undefined } : {}) })
  await store.save?.()
  return { groups }
}

/** 这台机器彻底下线：从所有群移除成员、删掉 Bot、节点记录一起清。 */
export async function forgetNode({ rt, store, nodeId }) {
  const node = store.node(nodeId)
  if (node === undefined) return { removed: false }
  // 先记下 Bot：下面每解绑一个群，最后一个群会让 unbind 把 node.botId 清掉。
  const botId = node.botId
  for (const groupId of node.groups ?? []) {
    await unbindNodeFromGroup({ rt, store, nodeId, groupId }).catch(error =>
      rt.warn?.('dsbot-nodes: leaving %s failed: %s', groupId, error))
  }
  if (botId !== undefined && rt.botOf(botId) !== undefined) {
    await rt.deleteBot?.(botId).catch(error => rt.warn?.('dsbot-nodes: deleting %s failed: %s', botId, error))
  }
  await store.remove(nodeId)
  return { removed: true }
}

export { nodeIdOf }

/**
 * 老记录的名字还是 IP（`127.0.0.1`）或 `remote`：对方这次报了机器名，就把它改了。
 * 只改名，不动 model/groups —— 改的是群里显示的那几个字。
 */
export async function renameProxyBot({ rt, store, nodeId, force = false }) {
  const node = store.node(nodeId)
  if (node === undefined || node.botId === undefined) return { renamed: false }
  const bot = rt.botOf?.(node.botId)
  if (bot === undefined) return { renamed: false }
  // force：用户自己按了改名，名字是什么就改成什么（不再只看 IP 那种）。
  if (!force && !isAddressLike(bot.name)) return { renamed: false }
  const wanted = uniqueName(rt, node.name, bot.id)
  if (wanted === bot.name) {
    await store.update(nodeId, { botName: bot.name })
    return { renamed: false }
  }
  const from = bot.name
  bot.name = wanted
  await rt.save?.()
  await store.update(nodeId, { botName: wanted })
  await store.save?.()
  return { renamed: true, from, botName: wanted }
}
