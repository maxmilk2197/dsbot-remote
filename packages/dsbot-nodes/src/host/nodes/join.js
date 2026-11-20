// 本文件由 AI 生成，请勿用于生产环境。
// 设置页上那个「输入配对码」的框背后：在本进程里连过去，当节点那一侧。
//
// 和主机侧的 hosting.js 正好反过来：那边开端口等人来，这边广播找人过去。
// 两边共用同一份 node/ 实现，所以装上同一个插件，一台机器既能当主机也能被控。
import { findHost } from '@dsbot/node-protocol/discovery'
import { connectTcp } from '@dsbot/node-protocol/tcp'
import { parseAgentCommand } from '../../node/agent.js'
import { deviceIdentity, servePeer } from '../../node/cli.js'
import net from 'node:net'
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

export function createJoiner({ home, rt, warn = () => {} }) {
  let peer = null
  let info = { running: false, code: null, host: null, since: null, error: null }
  // 手机/另一台机器上的 ds-bot 里也出现这个群，消息双向（见 mirror.js）。
  const mirror = createMirror({ rt, warn })
  // 跨网用的虚拟网：广播出不了局域网，靠它把两台机器放进同一张网里。
  let vnet = null

  function stopNetwork() {
    try { vnet?.stop() } catch {}
    vnet = null
  }

  function stop() {
    mirror.stop()
    stopNetwork()
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
    // 加入端自己的端口和实例名。跨网分支里的 waitForHostPeer / addPortForward
    // 一开始就要用，必须在这里声明 —— 放到分支后面会 TDZ：
    // Cannot access 'ports' before initialization。
    const ports = instancePorts(clean, 'join')

    try {
      // 先在局域网里喊一嗓子，谁认这个码谁应。
      let found
      try {
        found = await findHost({ code: clean })
      } catch (broadcastFailed) {
        // 广播只在同一张局域网里有效。找不到就是"对面不在这张网里"，
        // 不用让人回去翻参数 —— 直接进虚拟网，按主机的固定地址连。
        warn('局域网里没找到主机，改走跨网…')
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
      servePeer(peer, {
        name: name !== undefined && name !== '' ? name : (found.host ?? '这台机器'),
        deviceId,
        cwd: typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd(),
        agent: typeof agent === 'string' && agent !== '' ? parseAgentCommand(agent) : undefined,
        onGroupLine: (params, lines) => {
          void mirror.write(params, lines).catch(error => warn(`镜像群写入失败：${error.message}`))
        },
        // 连上就把对方给的那些群在本地建出来，不用等第一条消息。
        onGroups: groups => mirror.ensureAll(groups),
      })
      info = { ...info, running: true, host: url }
      mirror.bind(peer)
      warn(`已连上主机 ${url}`)
      peer.on('close', () => {
        info = { ...info, running: false, error: '和主机断开了' }
        peer = null
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
    return { ...info }
  }

  return { start, stop, status }
}
