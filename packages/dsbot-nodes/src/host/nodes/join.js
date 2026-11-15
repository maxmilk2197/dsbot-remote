// 本文件由 AI 生成，请勿用于生产环境。
// 设置页上那个「输入配对码」的框背后：在本进程里连过去，当节点那一侧。
//
// 和主机侧的 hosting.js 正好反过来：那边开端口等人来，这边广播找人过去。
// 两边共用同一份 node/ 实现，所以装上同一个插件，一台机器既能当主机也能被控。
import { findHost } from '@dsbot/node-protocol/discovery'
import { connectTcp } from '@dsbot/node-protocol/tcp'
import { parseAgentCommand } from '../../node/agent.js'
import { deviceIdentity, servePeer } from '../../node/cli.js'
import { HOST_VIRTUAL_IP, findEasyTier, pairCredentials, startEasyTier } from '../../node/easytier.js'
import { createMirror } from './mirror.js'

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

    try {
      // 先在局域网里喊一嗓子，谁认这个码谁应。
      let found
      try {
        found = await findHost({ code: clean })
      } catch (broadcastFailed) {
        // 广播只在同一张局域网里有效。找不到就是"对面不在这张网里"，
        // 不用让人回去翻参数 —— 直接进虚拟网，按主机的固定地址连。
        warn('局域网里没找到主机，改走跨网…')
        const core = await findEasyTier().catch(() => undefined)
        if (core === undefined) throw broadcastFailed
        info = { ...info, host: `虚拟网 ${pairCredentials(clean).networkName}` }
        vnet = startEasyTier({ core: core.core, code: clean, onLog: line => warn(`  [et] ${line}`) })
        const ready = await vnet.ready
        const target = HOST_VIRTUAL_IP.split('/')[0]
        found = { host: target, port: 7777, name: `虚拟网主机（本机 ${ready?.ipv4 ?? '?'}）` }
        warn(`虚拟网就绪（${ready?.ipv4 ?? '?'}）→ 连 ${target}:7777`)
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
