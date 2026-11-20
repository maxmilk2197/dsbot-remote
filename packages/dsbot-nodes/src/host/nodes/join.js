// 本文件由 AI 生成，请勿用于生产环境。
// 设置页上那个「输入配对码」的框背后：在本进程里连过去，当节点那一侧。
//
// 和主机侧的 hosting.js 正好反过来：那边开端口等人来，这边广播找人过去。
// 两边共用同一份 node/ 实现，所以装上同一个插件，一台机器既能当主机也能被控。
import { findHost } from '@dsbot/node-protocol/discovery'
import { connectTcp } from '@dsbot/node-protocol/tcp'
import { parseAgentCommand } from '../../node/agent.js'
import { pickLocalModel } from '../../node/local-agent.js'
import { deviceIdentity, servePeer } from '../../node/cli.js'
import net from 'node:net'
import { hostname } from 'node:os'
import { addPortForward, findEasyTier, instancePorts, pairCredentials, startEasyTier, waitForHostPeer } from '../../node/easytier.js'
import { createMirror } from './mirror.js'

// 端口转发要在本机开一个真实端口，挑一个没人用的。
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.unref()
  server.on('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => resolve(port))
  })
})

export function createJoiner({ home, rt, llm, warn = () => {} }) {
  let peer = null
  // servePeer 返回的那套控制柄：说话、换工作区、申请进群。
  let ctrl = null
  let info = {
    running: false, code: null, host: null, since: null, error: null,
    hostName: '', workspace: '', groups: [], available: [], agent: false, agentLabel: '',
  }
  // 手机/另一台机器上的 ds-bot 里也出现这个群，消息双向（见 mirror.js）。
  const mirror = createMirror({ rt, warn, home })
  // 跨网用的虚拟网：广播出不了局域网，靠它把两台机器放进同一张网里。
  let vnet = null

  function stopNetwork() {
    try { vnet?.stop() } catch {}
    vnet = null
  }

  function stop() {
    mirror.stop()
    stopNetwork()
    ctrl = null
    if (peer !== null) {
      try { peer.close() } catch {}
      peer = null
    }
    info = { ...info, running: false }
  }

  async function start({ code, name, agent, cwd, groups: wanted } = {}) {
    const clean = String(code ?? '').replace(/[\s-]/g, '').toUpperCase()
    if (clean.length < 6) {
      throw Object.assign(new Error('配对码位数不对（6–8 位）'), { code: 'node/bad-params' })
    }
    stop()
    // 主文件夹：这台机器自己选的根，主机浏览、run_shell、相对路径都从这儿算。
    const workspace = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
    const wantedGroups = Array.isArray(wanted) ? wanted.filter(each => typeof each === 'string' && each !== '') : []
    // 开箱即用：没填命令就用这台 DSH 自己配好的模型。
    // 用户显式填了命令就以它为准（比如要连另一台机器上的 CLI）。
    const commandAgent = typeof agent === 'string' && agent.trim() !== '' ? parseAgentCommand(agent) : undefined
    const local = commandAgent === undefined ? await pickLocalModel(llm) : undefined
    if (local !== undefined) warn(`本机模型：${local.name}（${local.provider}/${local.model}）`)
    info = {
      ...info, running: true, code: clean, error: null, host: null, since: Date.now(),
      hostName: '', workspace, groups: [], available: [],
      agent: commandAgent !== undefined || local !== undefined,
      agentLabel: commandAgent !== undefined
        ? `${commandAgent.command}${commandAgent.args.length === 0 ? '' : ' ' + commandAgent.args.join(' ')}`
        : (local?.name ?? ''),
    }
    // 加入端自己的端口和实例名。跨网分支里的 waitForHostPeer / addPortForward
    // 一开始就要用，必须在这里声明 —— 放到分支后面会 TDZ：
    // Cannot access 'ports' before initialization。
    const ports = instancePorts(clean, 'join')

    try {
      // 先在局域网里喊一嗓子，谁认这个码谁应。
      let found
      try {
        // 广播默认关：它会把"这里有台主机"告诉整张网，办公网里默认不该发。
        if (process.env.DSBOT_NODES_LAN_DISCOVERY !== '1') {
          throw Object.assign(new Error('没开局域网广播'), { code: 'node/no-host' })
        }
        found = await findHost()
      } catch (broadcastFailed) {
        // 广播只在同一张局域网里有效。找不到就是"对面不在这张网里"，
        // 不用让人回去翻参数 —— 直接进虚拟网，按主机的固定地址连。
        warn(process.env.DSBOT_NODES_LAN_DISCOVERY === '1' ? '局域网里没找到主机，改走跨网…' : '没开局域网广播，直接走跨网…')
        const core = await findEasyTier([], { onLog: line => warn(`  ${line}`) }).catch(() => undefined)
        if (core === undefined) throw broadcastFailed
        info = { ...info, host: `虚拟网 ${pairCredentials(clean).networkName}` }
        // 零权限：不建虚拟网卡（那要管理员），所以本机程序连不到虚拟网里的地址。
        // 靠端口转发把隧道里的目标映射到本机一个真实端口。
        vnet = startEasyTier({
          core: core.core, code: clean, noTun: true, role: 'join',
          onLog: line => warn(`  [et] ${line}`),
        })
        const ready = await vnet.ready
        // 主机把"我在这张局域网的哪个地址、哪个端口"写在自己的 hostname 上，
        // 进了虚拟网就能从 peer 列表读到 —— 两端谁都不需要预先知道对方地址。
        const target = await waitForHostPeer({ core: core.core, rpcPortal: ports.rpc, instanceName: ports.instanceName, onLog: line => warn(`  ${line}`) })
        if (target === undefined) {
          throw new Error('进了虚拟网，但没等到主机 —— 主机的跨网可能没开，或者配对码不一样')
        }
        const hostPort = target.port ?? 7777
        const localPort = await freePort()
        const forwarded = await addPortForward({
          core: core.core, rpcPortal: ports.rpc, instanceName: ports.instanceName,
          bind: `127.0.0.1:${localPort}`, dst: `${target.address}:${hostPort}`,
        })
        if (forwarded.ok !== true) throw new Error(`端口转发没加上：${forwarded.error}`)
        found = { host: '127.0.0.1', port: localPort, name: `虚拟网 → ${target.address}:${hostPort}` }
        warn(`虚拟网就绪（${ready?.ipv4 ?? '?'}）→ 127.0.0.1:${localPort} 转 ${target.address}:${hostPort}`)
      }
      const url = `tcp://${found.host}:${found.port}`
      peer = await connectTcp({ url, token: clean })
      const deviceId = await deviceIdentity(name)
      // 握手前先把进度文件读出来：node.hello 里要带续传点，晚一步读就只能
      // 让主机从头补一遍（虽然 seq 去重能兜住，但白传一段历史）。
      await mirror.load().catch(() => {})
      ctrl = servePeer(peer, {
        // 群里显示的名字：用户没填就用这台机器的名字。
        // 以前退到 found.host，局域网里就成了"127.0.0.1"—— 群里没人想 @ 一个 IP。
        name: name !== undefined && name !== '' ? name : hostname(),
        deviceId,
        cwd: workspace,
        wantedGroups,
        agent: commandAgent,
        local,
        llm,
        // 握手时带上"每个群已经收到哪儿"，主机只补缺口。
        cursors: () => mirror.cursors(),
        onGroupLine: (params, lines) => {
          void mirror.write(params, lines).catch(error => warn(`镜像群写入失败：${error.message}`))
        },
        // 连上就把对方给的那些群在本地建出来，不用等第一条消息。
        onGroups: (groups) => {
          info = { ...info, groups }
          return mirror.ensureAll(groups)
        },
        // 主机回了它叫什么、有哪些群可以进 —— 设置页的弹窗就靠这个列表。
        onHostInfo: (hostInfo) => {
          // 先记住是哪台主机：镜像群的身份和去重水位都按它分开记。
          mirror.setHost(hostInfo?.hostId)
          info = {
            ...info,
            hostName: String(hostInfo?.hostName ?? ''),
            available: Array.isArray(hostInfo?.available) ? hostInfo.available : [],
            groups: Array.isArray(hostInfo?.groups) ? hostInfo.groups : info.groups,
          }
        },
      })
      info = { ...info, running: true, host: url }
      mirror.bind(peer)
      warn(`已连上主机 ${url}`)
      peer.on('close', () => {
        info = { ...info, running: false, error: '和主机断开了' }
        peer = null
        ctrl = null
      })
      return { ...info }
    } catch (error) {
      // 连不上就把虚拟网也撤掉：留着一个没人用的 TUN 只会碍事。
      stopNetwork()
      info = { ...info, running: false, error: error.message }
      throw error
    }
  }

  function status() {
    return { ...info, groups: [...(info.groups ?? [])], available: [...(info.available ?? [])] }
  }

  const offline = () => Object.assign(new Error('还没连上主机'), { code: 'node/offline' })

  // 以这台机器在群里那个成员的身份说一句。没连上就明说，不静默丢。
  async function say(text, groupId) {
    if (ctrl === null) throw offline()
    const result = await ctrl.say(text, typeof groupId === 'string' && groupId !== '' ? groupId : undefined)
    return { result, join: status() }
  }

  // 换主文件夹：下一次心跳主机就收到，不用重连。
  function setWorkspace(dir) {
    if (ctrl === null) throw offline()
    const next = ctrl.setWorkspace(String(dir ?? '').trim())
    info = { ...info, workspace: next.workspace }
    return status()
  }

  // 弹窗里点的那几个群：交给主机建成员，回执说清哪些进去了、哪些没成。
  // 主机只认它授权过的群 —— 没授权的会出现在 refused 里，理由写"没授权"。
  async function want(groups) {
    if (ctrl === null) throw offline()
    const result = await ctrl.want(groups)
    if (Array.isArray(result?.available)) {
      info = { ...info, available: result.available }
    }
    return {
      bound: Array.isArray(result?.bound) ? result.bound : [],
      refused: Array.isArray(result?.refused) ? result.refused : [],
      join: status(),
    }
  }

  // 只问不建：主机那边刚给这台机器加了授权，不用重连，问一句就能刷新列表。
  function refresh() {
    return want([])
  }

  return { start, stop, status, say, setWorkspace, want, refresh }
}
