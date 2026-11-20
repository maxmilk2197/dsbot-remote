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
import { connectTcp } from '@dsbot/node-protocol/tcp'
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
  const rooms = {
    g1: { id: 'g1', name: '赚钱小组', members: ['chief'] },
    g2: { id: 'g2', name: '写代码', members: ['chief'] },
  }
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
  let ctrl
  try {
    // 加入端：主文件夹是它自己选的，握手时点名要进 g1。
    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('没等到主机回执')), 5_000)
      ctrl = servePeer(peer, {
        name: '手机',
        deviceId: 'dev-lab-1',
        cwd: workspace,
        wantedGroups: ['g1'],
        inbox: false,
        onHostInfo: (value) => { clearTimeout(timer); resolve(value) },
      })
    })

    // 1) 回执里有"可以进哪些群"：加入端就是靠这份列表弹框的。
    assert.deepEqual(info.available.map(group => group.id).sort(), ['g1', 'g2'])

    // 2) 握手时点名的 g1 已经被建出来了；没点过的 g2 不会自己进。
    const [node] = api.list()
    assert.equal(node.name, '手机')
    assert.equal(node.workspace, workspace, '主机要记住加入端选的主文件夹')
    await until(() => rt.state.rooms.g1.members.some(id => id !== 'chief'))
    assert.equal(rt.state.rooms.g2.members.length, 1)
    assert.equal(node.botId !== undefined, true)

    // 3) 连上之后补选 g2：回执说明进去了；不存在的群要明确被拒。
    const wanted = await ctrl.want(['g2', 'nope'])
    assert.deepEqual(wanted.bound.map(group => group.id), ['g2'])
    assert.deepEqual(wanted.refused.map(group => group.id), ['nope'])
    assert.equal(rt.state.rooms.g2.members.length, 2)

    // 4) 加入端直接说话：以它那个成员的身份落进群里。
    await ctrl.say('这边跑完了，三个测试全过', 'g2')
    assert.equal(posted.length, 1)
    assert.equal(posted[0].group, 'g2')
    assert.equal(posted[0].bot, node.botId)
    assert.equal(posted[0].text, '这边跑完了，三个测试全过')

    // 5) 主机浏览那台机器的工作区：根目录、以及用 args.cwd 钻进子目录。
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
  } finally {
    peer.close()
    await api.hosting.stop?.()
    await wait(50)
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})
