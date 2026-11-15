// 本文件由 AI 生成，请勿用于生产环境。
// 群绑定的接缝：不进群 = 这台机器白连；进错了 = 群里多一个不说话的人。
// 这里用假 rt 把"群"这件事压到最小：一个 members 数组 + 一个 updateRoom。
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bindNodeToGroup, forgetNode, proxyModel, unbindNodeFromGroup } from '../src/host/nodes/bind.js'
import { createNodeStore } from '../src/host/nodes/store.js'

let seq = 0

function fakeTeam({ rooms = [], bots = [] } = {}) {
  const state = {
    bots: Object.fromEntries(bots.map(bot => [bot.id, bot])),
    rooms: Object.fromEntries(rooms.map(room => [room.id, room])),
  }
  const calls = { created: [], updated: [], deleted: [], saved: 0, applied: [] }
  const rt = {
    state,
    warn: () => {},
    botOf: id => (id === undefined ? undefined : state.bots[id]),
    roomOf: id => (id === undefined ? undefined : state.rooms[id]),
    createBot: async (options) => {
      const id = `bot-${++seq}`
      const bot = { id, sessionId: id, name: options.name, role: options.role ?? '', createdAt: 1, capabilities: [] }
      // 真实 createBot 在没有模型时把欢迎语存起来不发；这里照抄这个行为，好断言它被删了。
      bot.kickoff = { text: '你好，我刚被造出来' }
      state.bots[id] = bot
      calls.created.push(options)
      return bot
    },
    updateRoom: async (groupId, patch) => {
      calls.updated.push({ groupId, patch })
      const room = state.rooms[groupId]
      for (const id of patch.add ?? []) if (!room.members.includes(id)) room.members.push(id)
      if (patch.remove !== undefined) room.members = room.members.filter(id => !patch.remove.includes(id))
      return room
    },
    applyModel: async (bot) => { calls.applied.push(bot.id) },
    deleteBot: async (id) => { calls.deleted.push(id); delete state.bots[id] },
    save: async () => { calls.saved += 1 },
  }
  return { rt, state, calls }
}

async function withStore(fn) {
  const home = await mkdtemp(join(tmpdir(), 'bind-'))
  const store = createNodeStore({ home, readOnly: () => undefined, warn: () => {}, now: Date.now })
  try {
    return await fn(store, home)
  } finally {
    // 落盘是后台串行的：等它排完再删目录，否则 save 会撞上已删的目录。
    await store.flush?.()
    await rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 40 })
  }
}

test('代理 Bot 的模型指向节点，欢迎语被扔掉', async () => {
  await withStore(async (store) => {
    const { rt, calls } = fakeTeam()
    const node = await store.add({ name: '写代码那台', deviceId: 'd-1' })

    const bot = await bindNodeToGroup({ rt, store, nodeId: node.id, groupId: 'g1', name: '写代码那台' }).catch(() => undefined)
    // 群不存在：先造群再试
    assert.equal(bot, undefined)
    assert.equal(calls.created.length, 0, '群不存在时不该留下一个 Bot')
  })
})

test('绑进群：模型是 node:id/default，成员里有它，节点记下群与 Bot', async () => {
  await withStore(async (store) => {
    const { rt, state } = fakeTeam({ rooms: [{ id: 'g1', name: '赚钱小组', members: ['bot-owner'] }] })
    const node = await store.add({ name: '写代码那台', deviceId: 'd-1' })

    const result = await bindNodeToGroup({ rt, store, nodeId: node.id, groupId: 'g1', name: '写代码那台' })

    assert.equal(result.created, true)
    assert.equal(result.botName, '写代码那台')
    assert.equal(state.bots[result.botId].model, proxyModel(node.id))
    assert.equal(state.bots[result.botId].model, `node:${node.id}/default`)
    assert.equal(state.bots[result.botId].kickoff, undefined)
    assert.deepEqual(state.rooms.g1.members, ['bot-owner', result.botId])

    const saved = store.node(node.id)
    assert.equal(saved.botId, result.botId)
    assert.deepEqual(saved.groups, ['g1'])
  })
})

test('群不存在：什么都不改', async () => {
  await withStore(async (store) => {
    const { rt, calls } = fakeTeam()
    const node = await store.add({ name: '写代码那台', deviceId: 'd-1' })

    await assert.rejects(
      () => bindNodeToGroup({ rt, store, nodeId: node.id, groupId: 'nope' }),
      error => error.code === 'node/not-found' && /没有这个群/.test(error.message),
    )
    assert.equal(calls.created.length, 0)
    assert.equal(store.node(node.id).botId, undefined)
  })
})

test('节点不存在：也什么都不改', async () => {
  await withStore(async (store) => {
    const { rt, calls } = fakeTeam({ rooms: [{ id: 'g1', name: '赚钱小组', members: [] }] })
    await assert.rejects(
      () => bindNodeToGroup({ rt, store, nodeId: 'n-ghost', groupId: 'g1' }),
      error => error.code === 'node/not-found' && /没有这个节点/.test(error.message),
    )
    assert.equal(calls.created.length, 0)
  })
})

test('再绑一次同一个群：复用原来的成员，群里不多出第二个人', async () => {
  await withStore(async (store) => {
    const { rt, state, calls } = fakeTeam({ rooms: [{ id: 'g1', name: '赚钱小组', members: [] }] })
    const node = await store.add({ name: '写代码那台', deviceId: 'd-1' })

    const first = await bindNodeToGroup({ rt, store, nodeId: node.id, groupId: 'g1' })
    const second = await bindNodeToGroup({ rt, store, nodeId: node.id, groupId: 'g1' })

    assert.equal(first.botId, second.botId)
    assert.equal(second.created, false)
    assert.equal(calls.created.length, 1)
    assert.deepEqual(state.rooms.g1.members, [first.botId])
  })
})

test('名字撞了：自动加序号，不让群里出现两个能 @ 到的人', async () => {
  await withStore(async (store) => {
    const { rt, state } = fakeTeam({
      rooms: [{ id: 'g1', name: '赚钱小组', members: [] }],
      bots: [{ id: 'bot-0', name: '写代码那台' }],
    })
    const node = await store.add({ name: '写代码那台', deviceId: 'd-1' })
    const result = await bindNodeToGroup({ rt, store, nodeId: node.id, groupId: 'g1' })
    assert.equal(result.botName, '写代码那台 2')
    assert.equal(state.bots[result.botId].name, '写代码那台 2')
  })
})

test('解绑：成员拿掉，节点不再记这个群；最后一个群才清掉 Bot', async () => {
  await withStore(async (store) => {
    const { rt, state } = fakeTeam({
      rooms: [
        { id: 'g1', name: '赚钱小组', members: [] },
        { id: 'g2', name: '眠冬与你', members: [] },
      ],
    })
    const node = await store.add({ name: '写代码那台', deviceId: 'd-1' })
    const { botId } = await bindNodeToGroup({ rt, store, nodeId: node.id, groupId: 'g1' })
    await bindNodeToGroup({ rt, store, nodeId: node.id, groupId: 'g2' })

    await unbindNodeFromGroup({ rt, store, nodeId: node.id, groupId: 'g1' })
    assert.deepEqual(state.rooms.g1.members, [])
    assert.deepEqual(store.node(node.id).groups, ['g2'])
    assert.equal(store.node(node.id).botId, botId, '还在 g2 里，Bot 留着')

    await unbindNodeFromGroup({ rt, store, nodeId: node.id, groupId: 'g2' })
    assert.deepEqual(state.rooms.g2.members, [])
    assert.equal(store.node(node.id).botId, undefined)
    assert.equal(state.bots[botId] !== undefined, true, 'Bot 本身不因解绑被删')
  })
})

test('彻底忘掉一台机器：离开所有群、删 Bot、节点记录消失', async () => {
  await withStore(async (store) => {
    const { rt, state, calls } = fakeTeam({ rooms: [{ id: 'g1', name: '赚钱小组', members: [] }] })
    const node = await store.add({ name: '写代码那台', deviceId: 'd-1' })
    const { botId } = await bindNodeToGroup({ rt, store, nodeId: node.id, groupId: 'g1' })

    const result = await forgetNode({ rt, store, nodeId: node.id })
    assert.equal(result.removed, true)
    assert.deepEqual(state.rooms.g1.members, [])
    assert.deepEqual(calls.deleted, [botId])
    assert.equal(store.node(node.id), undefined)
  })
})

// 群里同时站着"手机"和"手机 2"的那次事故：下拉没反馈，用户连点了两下，
// 两个请求同时读到 node.botId 还是空的，于是各建了一个。
test('群里已经有指向这台机器的 Bot：复用，不再造第二个', async () => {
  await withStore(async (store) => {
    const { rt, state, calls } = fakeTeam({
      rooms: [{ id: 'g1', name: '测试', members: ['bot-old'] }],
      bots: [{ id: 'bot-old', name: '手机' }],
    })
    const node = await store.add({ name: '手机', deviceId: 'd-1' })
    // nodes.json 里没记住 botId（被写空过），只能靠 model 认出来。
    state.bots['bot-old'].model = `node:${node.id}/default`

    const result = await bindNodeToGroup({ rt, store, nodeId: node.id, groupId: 'g1' })

    assert.equal(result.botId, 'bot-old')
    assert.equal(result.created, false, '复用的，不是新建的')
    assert.equal(calls.created.length, 0, '不该再建一个新 Bot')
    assert.deepEqual(state.rooms.g1.members, ['bot-old'], '群里还是一个人')
    assert.equal(store.node(node.id).botId, 'bot-old', '顺便把 id 记回来')
  })
})

test('群里有两个都指着这台机器的 Bot：留登记在案的，另一个收掉', async () => {
  await withStore(async (store) => {
    const { rt, state, calls } = fakeTeam({
      rooms: [{ id: 'g1', name: '测试', members: ['bot-good', 'bot-dup'] }],
      bots: [{ id: 'bot-good', name: '手机' }, { id: 'bot-dup', name: '手机 2' }],
    })
    const node = await store.add({ name: '手机', deviceId: 'd-1', botId: 'bot-good' })
    state.bots['bot-good'].model = `node:${node.id}/default`
    state.bots['bot-dup'].model = `node:${node.id}/default`

    await bindNodeToGroup({ rt, store, nodeId: node.id, groupId: 'g1' })

    assert.deepEqual(state.rooms.g1.members, ['bot-good'], '只留登记在案的那个')
    assert.deepEqual(calls.deleted, ['bot-dup'], '副本要删掉，不能留着占位置')
  })
})
