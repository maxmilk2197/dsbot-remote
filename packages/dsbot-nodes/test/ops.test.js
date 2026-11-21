// 本文件由 AI 生成，请勿用于生产环境。
// 基础操作的端到端验收：一台真的主机（install + 真监听）配一台真的加入端（servePeer），
// 中间只隔一条 TCP。每个用例验一个用户会直接点到的动作：
//   ① 配对进群  ② 群里发言  ③ 收回授权  ④ 浏览/读文件  ⑤ 附件回传  ⑥ 执行命令  ⑦ 遗忘  ⑧ 换码
// 口径：断言只看对外的结果（群里的成员表、落盘的文件、帧的返回），不碰内部结构。
process.env.DSBOT_NODES_TEST = '1'
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { connectTcp } from '@dsbot/node-protocol/tcp'
import { install, resetInstall } from '../src/host/nodes/index.js'
import { servePeer } from '../src/node/cli.js'

const wait = ms => new Promise(done => setTimeout(done, ms))

async function until(check, { timeoutMs = 6_000, stepMs = 25 } = {}) {
  const started = Date.now()
  for (;;) {
    if (await check()) return
    if (Date.now() - started > timeoutMs) throw new Error('等太久了，条件一直没成立')
    await wait(stepMs)
  }
}

function makeHostRt({ home, posted }) {
  const rooms = { g1: { id: 'g1', name: '赚钱小组', members: ['chief'] } }
  const bots = { chief: { id: 'chief', name: 'Chief' } }
  let seq = 0
  return {
    home,
    readOnly: () => false,
    warn: () => {},
    state: { rooms, bots },
    roomOf: id => rooms[id],
    botOf: id => bots[id],
    async createBot({ name }) {
      seq += 1
      const bot = { id: `b-${seq}`, name }
      bots[bot.id] = bot
      return bot
    },
    async updateRoom(id, { add = [], remove = [] } = {}) {
      const room = rooms[id]
      if (room === undefined) throw new Error(`没有这个群：${id}`)
      room.members = [...new Set([...room.members.filter(each => !remove.includes(each)), ...add])]
      return room
    },
    async save() {},
    async applyModel() {},
    onRoomLine: () => () => {},
    async groupLinesAfter() { return [] },
    async postToRoom(room, bot, text) { posted.push({ group: room.id, bot: bot.id, text }) },
    teamTools: [],
    ctx: {
      effect: () => {},
      llm: {
        registerAdapter() {
          const registration = () => {}
          registration.replace = () => {}
          return registration
        },
      },
    },
  }
}

// 一条完整链路：主机起监听，节点连上来并选好工作区。用完一律拆干净。
async function withPair(fn, { agent, name = '手机' } = {}) {
  resetInstall()
  const home = await mkdtemp(join(tmpdir(), 'ops-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'ops-ws-'))
  await writeFile(join(workspace, 'a.txt'), 'hello-from-workspace', 'utf8')
  await mkdir(join(workspace, 'sub'), { recursive: true })
  await writeFile(join(workspace, 'sub', 'b.txt'), 'inside-sub', 'utf8')

  // 加入端默认配一个"会说话的 agent"：没配 agent 的节点进不了群（bind 会挡住），
  // 而这条链路正是要验的。脚本只做两件事：读空 stdin，然后把工作区里的 a.txt 带走。
  // 路径用绝对路径 —— 附件那一行是模型写的，相对路径会落到测试进程的 cwd 上。
  const attachPath = join(workspace, 'a.txt')
  const turnScript = join(workspace, 'turn.js')
  await writeFile(turnScript, [
    "let seen = ''",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', chunk => { seen += chunk })",
    "process.stdin.on('end', () => {",
    "  console.log('这一轮跑完了')",
    `  console.log(${JSON.stringify('@@attach ' + attachPath)})`,
    "})",
    '',
  ].join('\n'), 'utf8')
  // 命令用裸 'node'：agent 是 shell:true 起的，绝对路径里的空格会被 cmd.exe 拆开。
  const agentCommand = agent ?? { command: 'node', args: [turnScript] }

  const posted = []
  const rt = makeHostRt({ home, posted })
  const api = install(rt)
  const hosted = await api.hosting.start({ port: 0 })
  assert.ok(hosted.port > 0)

  const peer = await connectTcp({ url: `tcp://127.0.0.1:${hosted.port}`, token: hosted.code })
  let ctrl
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('没等到主机回执')), 5_000)
      ctrl = servePeer(peer, {
        name,
        deviceId: 'dev-ops-1',
        cwd: workspace,
        wantedGroups: [],
        agent: agentCommand,
        inbox: false,
        onHostInfo: value => { clearTimeout(timer); resolve(value) },
      })
    })
    const [node] = api.list()
    assert.equal(node.workspace, workspace)
    await fn({ api, ctrl, node, posted, peer, rt, workspace, home, hosted })
  } finally {
    try { peer.close() } catch {}
    try { await api.hosting.stop?.() } catch {}
    await rm(home, { recursive: true, force: true }).catch(() => {})
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  }
}

test('① 配对 + ② 发言：授权后进群，说一句落到群里', async () => {
  await withPair(async ({ api, ctrl, node, posted, rt }) => {
    assert.equal(api.list().length, 1, '主机要认得这台机器')
    const denied = await ctrl.want(['g1'])
    assert.deepEqual(denied.bound, [], '没授权就进不去')

    await api.allow({ nodeId: node.id, groups: ['g1'] })
    const granted = await ctrl.want(['g1'])
    assert.deepEqual(granted.bound.map(group => group.id), ['g1'])
    await until(() => rt.state.rooms.g1.members.some(id => id !== 'chief'))

    await ctrl.say('这边跑完了', 'g1')
    assert.equal(posted.length, 1)
    assert.equal(posted[0].bot, node.botId)
    assert.equal(posted[0].text, '这边跑完了')
  })
})

test('③ 收回授权：成员被移出群，之后不能再说话', async () => {
  await withPair(async ({ api, ctrl, node, rt }) => {
    await api.allow({ nodeId: node.id, groups: ['g1'] })
    await ctrl.want(['g1'])
    await until(() => rt.state.rooms.g1.members.some(id => id !== 'chief'))

    await api.allow({ nodeId: node.id, groups: [] })
    assert.deepEqual(rt.state.rooms.g1.members, ['chief'], '收回授权要立刻把人请出去')
    await assert.rejects(ctrl.say('还能说吗', 'g1'), error => /没有授权|还没进任何群/.test(error.message))
  })
})

test('④ 浏览与读文件：能进子目录，爬不到工作区外面', async () => {
  await withPair(async ({ api, node }) => {
    const root = await api.call(node.id, 'node.exec', { execId: 'fs-1', action: 'list_dir', args: { path: '.' } })
    assert.equal(root.ok, true)
    assert.match(String(root.output), /a\.txt/)

    const read = await api.call(node.id, 'node.exec', { execId: 'fs-2', action: 'read_file', args: { path: 'a.txt' } })
    assert.equal(String(read.output), 'hello-from-workspace')

    const sub = await api.call(node.id, 'node.exec', { execId: 'fs-3', action: 'list_dir', args: { cwd: 'sub', path: '.' } })
    assert.match(String(sub.output), /b\.txt/)

    const escape = await api.call(node.id, 'node.exec', { execId: 'fs-4', action: 'list_dir', args: { cwd: '..', path: '.' } })
    assert.equal(escape.ok, false)
    assert.equal(escape.code, 'node/exec-denied')
  })
})

test('⑥ 执行命令：真有输出；越界与未知动作都被拒', async () => {
  await withPair(async ({ api, node }) => {
    const ran = await api.call(node.id, 'node.exec', {
      execId: 'sh-1', action: 'run_shell', args: { command: 'node -e "console.log(6*7)"' },
    })
    assert.equal(ran.ok, true, String(ran.message ?? ''))
    assert.match(String(ran.output), /42/)

    const escape = await api.call(node.id, 'node.exec', { execId: 'sh-2', action: 'run_shell', args: { command: 'node -e "1"', cwd: '..' } })
    assert.equal(escape.ok, false)

    const unknown = await api.call(node.id, 'node.exec', { execId: 'sh-3', action: 'rm_rf', args: {} })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.code, 'node/exec-denied')
  })
})

test('⑤ 附件回传：模型写 @@attach，节点把文件当载荷带回去', async () => {
  // 这一层验的是节点侧：agent 的 stdout 里出现 @@attach <绝对路径>，
  // turn.result 的 files 里就要有它的名字和 base64 内容。落盘那一步在主机侧，
  // 由 files.test.js 的 acceptUpload 盖住；中间的桥是 adapter.js 的 onTurnFiles。
  await withPair(async ({ api, node }) => {
    const link = api.linkFor(node.id)
    const arrived = new Promise(resolve => link.on('turn.result', params => resolve(params)))
    const accepted = await api.call(node.id, 'turn.request', { turnId: 't-1', prompt: '跑一下' })
    assert.equal(accepted?.accepted, true)

    const params = await Promise.race([arrived, new Promise((_, reject) => setTimeout(() => reject(new Error('等太久了：turn.result 没回来')), 20_000))])
    assert.equal(params.turnId, 't-1')
    assert.equal(params.status, 'ok', String(params.message ?? ''))
    assert.equal(params.files?.length, 1, '要带一个附件回来')
    assert.equal(params.files[0].name, 'a.txt')
    assert.equal(Buffer.from(String(params.files[0].data), 'base64').toString('utf8'), 'hello-from-workspace')
  })
})

test('⑨ 协议形状：hello 带回主机名，带 id 的事件不报 unsupported', async () => {
  await withPair(async ({ hosted }) => {
    const raw = await connectTcp({ url: `tcp://127.0.0.1:${hosted.port}`, token: hosted.code })
    const frames = []
    raw.on('frame', frame => frames.push(frame))
    raw.send({ id: 'h1', method: 'node.hello', params: { proto: 1, nodeName: '探针', botId: 'b-probe', botName: '探针', deviceId: 'dev-probe' } })
    await until(() => frames.some(frame => frame.id === 'h1'))
    const hello = frames.find(frame => frame.id === 'h1')
    assert.equal(hello.result?.hostName, 'DSH 主机', '加入端要靠它显示"连到了哪台机器"')
    assert.ok(hello.result?.nodeId, '要给出节点 id')

    // 事件类方法按协议带 id 发：主机可以说不处理，但不能说"不接"。
    raw.send({ id: 'r1', method: 'node.presence', params: { state: 'online' } })
    await until(() => frames.some(frame => frame.id === 'r1'))
    const reply = frames.find(frame => frame.id === 'r1')
    assert.equal(reply.error, undefined, JSON.stringify(reply.error ?? {}))
    assert.equal(reply.result?.ok, true)
    raw.close()
  })
})

test('⑩ 端口被占也能起来：自动挪档位', async () => {
  // 真实场景：同一台机器上另一个 DSH 实例或没退干净的旧进程占着 7777。
  // 以前整个远程功能直接起不来，现在往后挪一格，端口由广播告诉对端。
  resetInstall()
  const home = await mkdtemp(join(tmpdir(), 'ops-port-'))
  const blocker = createServer()
  await new Promise(resolve => blocker.listen(0, '0.0.0.0', resolve))
  const busy = blocker.address().port
  try {
    const api = install(makeHostRt({ home, posted: [] }))
    const hosted = await api.hosting.start({ port: busy })
    assert.notEqual(hosted.port, busy, '要挪开被占的端口')
    assert.ok(hosted.port > 0)
    const peer = await connectTcp({ url: `tcp://127.0.0.1:${hosted.port}`, token: hosted.code })
    assert.ok(peer, '挪过去之后仍然连得上')
    peer.close()
    await api.hosting.stop?.()
  } finally {
    blocker.close()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('⑧ 换码：新码能连，旧码立刻失效', async () => {
  await withPair(async ({ api, hosted }) => {
    const before = hosted.code
    const rotated = await api.rotate()
    assert.ok(typeof rotated.code === 'string' && rotated.code.length >= 6)
    assert.notEqual(rotated.code, before, '换码必须真的换掉')

    await assert.rejects(
      connectTcp({ url: `tcp://127.0.0.1:${rotated.port ?? hosted.port}`, token: before, timeoutMs: 3_000 }),
      error => /口令|unauthorized|配对码|error/i.test(String(error.message ?? error)),
      '旧码必须连不上',
    )
    const again = await connectTcp({ url: `tcp://127.0.0.1:${rotated.port ?? hosted.port}`, token: rotated.code, timeoutMs: 3_000 })
    again.close()
  })
})

test('⑦ 遗忘：节点从列表消失，之后派活会被拒', async () => {
  await withPair(async ({ api, node }) => {
    await api.forget({ nodeId: node.id })
    assert.equal(api.list().length, 0)
    await assert.rejects(api.call(node.id, 'node.exec', { execId: 'x', action: 'list_dir', args: { path: '.' } }))
  })
})

test('⑪ 名字：没填就用对方的电脑名', async () => {
  await withPair(async ({ node }) => {
    assert.equal(node.name, hostname(), '对方没报名字时用它的电脑名')
  }, { name: '' })
})

test('⑫ 名字：报上来的是 IP 就用电脑名顶掉，群里的成员也跟着叫这个名字', async () => {
  await withPair(async ({ api, ctrl, node, rt }) => {
    assert.equal(node.name, hostname(), 'IP 那种名字要换成电脑名')
    await api.allow({ nodeId: node.id, groups: ['g1'] })
    await ctrl.want(['g1'])
    await until(() => node.botId !== undefined)
    const bot = rt.botOf(api.list()[0].botId)
    assert.equal(bot.name, hostname(), '群里那个成员也该叫电脑名')
  }, { name: '127.0.0.1' })
})

test('⑬ 同一台机器重连：记录要留在"在线"，旧连接要断掉', async () => {
  await withPair(async ({ api, peer, hosted, workspace }) => {
    assert.equal(api.list()[0].status, 'online')
    const second = await connectTcp({ url: `tcp://127.0.0.1:${hosted.port}`, token: hosted.code })
    try {
      servePeer(second, {
        name: '手机',
        deviceId: 'dev-ops-1',
        cwd: workspace,
        inbox: false,
        agent: { command: 'node', args: ['-e', '1'] },
      })
      // 旧连接会被主机主动断掉 —— 这是"重连被认出来"的判据。
      await until(() => peer.closed === true)
      await wait(300)
      assert.equal(api.list().length, 1, '同一台机器不该多出一条记录')
      assert.equal(api.list()[0].status, 'online', '重连之后不能把新连接记成离线')
    } finally {
      try { second.close() } catch {}
    }
  })
})

test('⑭ 节点中途掉线：在途的调用当场失败，不干等 60 秒', async () => {
  await withPair(async ({ api, node, peer }) => {
    const started = Date.now()
    const pending = api.call(node.id, 'node.exec', {
      execId: 'slow-1',
      action: 'run_shell',
      args: { command: 'node -e "setTimeout(() => {}, 1500)"' },
    })
    pending.catch(() => {})
    await wait(300)
    peer.close()
    await assert.rejects(pending, error => /掉线|offline/.test(String(error.message ?? '') + String(error.code ?? '')))
    assert.ok(Date.now() - started < 5_000, '不该等到 60 秒的调用超时')
  })
})
