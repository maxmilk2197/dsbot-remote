// 本文件由 AI 生成，请勿用于生产环境。
// 远程主机实验：一台"主机"（真的 install + 真的监听）配一台"加入端"（真的 servePeer），
// 中间只隔一条 TCP。验的是这次新加的四件事：
//   1) 加入端报上来的 workspace 主机记得住，主机能借着它读那台机器的文件
//   2) 握手回执里带着"主机有哪些群"（available），加入端据此弹框
//   3) 选好的群走 node.wants 建成员，主机回 bound / refused
//   4) 加入端能直接以成员身份说话（node.post），主机这边落到群里
process.env.DSBOT_NODES_TEST = '1'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectTcp } from '../src/protocol/transport/tcp.js'
import { install, resetInstall } from '../src/host/nodes/index.js'
import { servePeer } from '../src/node/cli.js'

const wait = ms => new Promise(done => setTimeout(done, ms))

// 等一个条件成立。远端建成员是异步的（握手回执先发，bind 随后），
// 固定 sleep 要么慢要么飘，直接轮询到成立为止。
async function until(check, { timeoutMs = 4_000, stepMs = 20 } = {}) {
  const started = Date.now()
  for (;;) {
    if (await check()) return
    if (Date.now() - started > timeoutMs) throw new Error('等太久了，条件一直没成立')
    await wait(stepMs)
  }
}

// 一台主机该有的东西：两个群、造 Bot 的能力、把话落进群的能力。
function makeHostRt({ home, posted }) {
  process.env.DSBOT_NODES_HOME = home
  const rooms = {
    g1: { id: 'g1', name: '赚钱小组', members: ['chief'] },
    g2: { id: 'g2', name: '写代码', members: ['chief'] },
  }
  const bots = { chief: { id: 'chief', name: 'Chief' } }
  const listeners = new Set()
  // 人以「用户」身份说的话走这里（ds-bot 的 sendUser）。
  const users = []
  let seq = 0
  return {
    users,
    async sendUser({ sessionId, content }) {
      users.push({ sessionId, text: (content ?? []).map(part => part?.text ?? '').join('') })
    },
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
    onRoomLine: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    // 用户在主机群里说话：ds-bot 的 say() 就是这样通知订阅者的。
    emitLine(id, { who = 'Chief', text, botId }) {
      const room = rooms[id]
      room.seq = (room.seq ?? 0) + 1
      const record = { seq: room.seq, who, text, time: Date.now(), ...(botId === undefined ? {} : { botId }) }
      for (const listener of listeners) listener(room, record)
      return record
    },
    async groupLinesAfter() { return [] },
    async postToRoom(room, bot, text) { posted.push({ group: room.id, bot: bot.id, text }) },
    teamTools: [],
    ctx: {
      // 真的跑一遍：主机把 onRoomLine 的订阅放在 effect 里。
      effect: fn => fn(),
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

test('远程主机实验：工作区 / 选群回执 / node.wants / 直接发言，一条 TCP 全走一遍', async () => {
  resetInstall()
  const home = await mkdtemp(join(tmpdir(), 'host-'))
  const workspace = await mkdtemp(join(tmpdir(), 'ws-'))
  await writeFile(join(workspace, 'a.txt'), 'hello-from-workspace', 'utf8')
  await mkdir(join(workspace, 'sub'), { recursive: true })
  await writeFile(join(workspace, 'sub', 'b.txt'), 'inside-sub', 'utf8')

  const posted = []
  const rt = makeHostRt({ home, posted })
  const api = install(rt)
  const hosted = await api.hosting.start({ port: 0 })
  assert.ok(hosted.port > 0, '主机得先在某个端口上等')

  const peer = await connectTcp({ url: `tcp://127.0.0.1:${hosted.port}`, token: hosted.code })
  // 加入端收到的群消息：主机推过来的那一半靠它验。
  const got = []
  let ctrl
  try {
    // 加入端：主文件夹是它自己选的，握手时点名要进 g1。
    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('没等到主机回执')), 5_000)
      ctrl = servePeer(peer, {
        name: '手机',
        deviceId: 'dev-lab-1',
        cwd: workspace,
        wantedGroups: [],
        // 配了 agent 才有资格进群（没配的会被 bind 直接挡住）。
        agent: { command: 'node', args: ['-e', ''] },
        inbox: false,
        onGroupLine: (params, lines) => { got.push({ params, lines }) },
        onHostInfo: (value) => { clearTimeout(timer); resolve(value) },
      })
    })

    // 1) 主机还没授权任何群：一个群名都不该发给它（群名本身就是信息）。
    assert.deepEqual(info.available, [])

    const [node] = api.list()
    assert.equal(node.name, '手机')
    assert.equal(node.workspace, workspace, '主机要记住加入端选的主文件夹')

    // 2) 没授权就想进 g1：进不去，成员表一个字节都不变。
    const denied = await ctrl.want(['g1'])
    assert.deepEqual(denied.bound, [])
    assert.equal(denied.refused[0].reason, '主机没有授权这个群')
    assert.deepEqual(rt.state.rooms.g1.members, ['chief'])

    // 3) 主机授权 g1 之后：进得去，回执里也只多出 g1（不泄露 g2）。
    await api.allow({ nodeId: node.id, groups: ['g1'] })
    const granted = await ctrl.want(['g1'])
    assert.deepEqual(granted.bound.map(group => group.id), ['g1'])
    assert.deepEqual(granted.available.map(group => group.id), ['g1'])
    // 回执里带着成员名单：远端镜像群照着它摆替身，两边成员表才一致。
    assert.equal(granted.available[0].bots.some(bot => bot.id === 'chief' && bot.name === 'Chief'), true)
    await until(() => rt.state.rooms.g1.members.some(id => id !== 'chief'))
    assert.equal(rt.state.rooms.g2.members.length, 1, '没授权的 g2 不该自己进')
    assert.equal(node.botId !== undefined, true)

    // 4) 再授权 g2：补选成功；不存在的群要明确被拒。
    await api.allow({ nodeId: node.id, groups: ['g1', 'g2'] })
    const wanted = await ctrl.want(['g2', 'nope'])
    assert.deepEqual(wanted.bound.map(group => group.id), ['g2'])
    assert.deepEqual(wanted.refused.map(group => group.id), ['nope'])
    assert.equal(rt.state.rooms.g2.members.length, 2)

    // 5) 加入端直接说话：没带身份的是人，走用户入口，不被压成成员。
    await ctrl.say('这边跑完了，三个测试全过', 'g2')
    assert.equal(rt.users.length, 1, '人说的话要走 rt.sendUser')
    assert.equal(rt.users[0].sessionId, 'g2')
    assert.equal(rt.users[0].text, '这边跑完了，三个测试全过')
    assert.equal(posted.length, 0, '不该再以成员身份落群')

    // 5b) 带 botId 的转述：按那个成员的身份落群；编出来的身份明确拒绝，不换脸。
    const frames = []
    peer.on('frame', frame => frames.push(frame))
    peer.send({ id: 'rpc-1', method: 'node.post', params: { groupId: 'g1', botId: 'chief', text: '以 Chief 名义说' } })
    await until(() => posted.some(entry => entry.text === '以 Chief 名义说'))
    assert.equal(posted.at(-1).bot, 'chief', '带身份的转述要按那个成员落群')
    peer.send({ id: 'rpc-2', method: 'node.post', params: { groupId: 'g1', botId: 'nobody', text: '冒充一个不存在的人' } })
    await until(() => frames.some(frame => frame.id === 'rpc-2'))
    assert.equal(frames.find(frame => frame.id === 'rpc-2').error.code, 'node/not-found')

    // 6) 收回授权：立刻从群里拿掉，之后也不能再往那儿说话。
    await api.allow({ nodeId: node.id, groups: ['g1'] })
    assert.deepEqual(rt.state.rooms.g2.members, ['chief'])
    await assert.rejects(ctrl.say('还能说吗', 'g2'), (error) => /没有授权/.test(error.message))

    // 7) 主机浏览那台机器的工作区：根目录、以及用 args.cwd 钻进子目录。
    const root = await api.call(node.id, 'node.exec', { execId: 'fs-1', action: 'list_dir', args: { path: '.' } })
    assert.equal(root.ok, true)
    assert.match(String(root.output), /a\.txt/)
    assert.match(String(root.output), /sub\//)

    const read = await api.call(node.id, 'node.exec', { execId: 'fs-2', action: 'read_file', args: { path: 'a.txt' } })
    assert.equal(String(read.output), 'hello-from-workspace')

    const sub = await api.call(node.id, 'node.exec', { execId: 'fs-3', action: 'list_dir', args: { cwd: 'sub', path: '.' } })
    assert.match(String(sub.output), /b\.txt/)

    // 越界必须被拒：cwd 不能爬到工作区外面去。
    const escape = await api.call(node.id, 'node.exec', { execId: 'fs-4', action: 'list_dir', args: { cwd: '..', path: '.' } })
    assert.equal(escape.ok, false)
    assert.equal(escape.code, 'node/exec-denied')

    // 8) 主机 → 加入端：主机群里有人说了一句，得从这条 TCP 推过去。
    //    以前这段没有任何测试，单向不通时只能靠猜。
    rt.emitLine('g1', { who: 'Chief', text: '主机这边的回声' })
    // 握手时会先来一帧空的 snapshot，所以按文字找，不看"收到任意一帧"。
    const hitOf = () => got.find(entry => (entry.lines ?? []).some(line => line.text === '主机这边的回声'))
    await until(() => hitOf() !== undefined)
    const hit = hitOf()
    assert.equal(hit.params.room.id, 'g1')
    assert.ok(hit.params.cursor >= 1, '带上水位，加入端才知道断线后从哪补')
  } finally {
    peer.close()
    await api.hosting.stop?.()
    await wait(50)
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})
