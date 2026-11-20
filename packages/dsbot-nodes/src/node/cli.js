// 本文件由 AI 生成，请勿用于生产环境。
// 远端入口。两种跑法：
//   listen   开一个口子等主机来连（主线，NAT 后靠 EasyTier 给 IP）
//   connect  连到主机（调试用，反过来）
//
// 跑起来之后它就是一个"节点"：报身份、接主机发来的 node.exec、把结果发回去。
// 群里的发言不在这里 —— 那是主机拿这一轮 turn 的输出写进去的，见 README。
import { createHash } from 'node:crypto'
import net from 'node:net'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { arch, homedir, hostname, platform, userInfo } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connectTcp, listenTcp } from '@dsbot/node-protocol/tcp'
import { findHost, listenDiscovery } from '@dsbot/node-protocol/discovery'
import { findEasyTier, hostVirtualIp, pairCredentials, startEasyTier } from './easytier.js'
import { ALLOWED_ACTIONS, execute } from './exec.js'
import { parseAgentCommand, runAgent } from './agent.js'
import { runLocal } from './local-agent.js'

const HOME = join(homedir(), '.dsbot-remote')
const CAPS = ['exec', 'push_file']

const USAGE = `dsbot-remote <命令>

listen    等主机来连（主线；会给出一个配对码）
  --code <码>        6 位配对码，兼作口令；另一台机器用 pair --code 连过来
  --port <端口>      默认 7777
  --host <地址>      默认 0.0.0.0
  --token <口令>     不用配对码时的手动口令（至少 6 位）
  --name <名字>      群里显示的名字，默认主机名
  --cwd <目录>       run_shell 与相对路径的根，默认当前目录
  --agent "<命令>"   跑 turn 用的命令，prompt 走 stdin、回答取 stdout
                     例：--agent "dsh -p"   或   --agent "claude -p"

pair      输入配对码接上主机（日常只需要这条）
  --code <码>        6 位配对码，必需
  --to <ip:端口>     跳过广播，直连这台主机（不同网段、手机热点、广播被墙时用）
  --network          先加入 EasyTier 虚拟网（跨网络时用；同局域网可省）
  --name / --cwd / --agent   同上

connect   连到指定地址（调试用）
  --to <地址>        tcp://10.144.0.2:7777
  --token <口令>

version   打印版本
`

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i += 1 }
  }
  return out
}

const stamp = () => new Date().toISOString().slice(11, 19)
// 群消息按聊天那样打：不带我们自己的时间戳前缀，用消息自己的时间。
const chat = (line) => {
  const at = new Date(line?.at ?? Date.now())
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const who = String(line?.who ?? '').trim() || '有人'
  const body = String(line?.text ?? '').replace(/\r/g, '').split('\n').join('\n        ')
  process.stdout.write(`  ${clock} ${who}：${body}\n`)
}
const say = line => process.stdout.write(`${stamp()} ${line}\n`)

function fail(message) {
  process.stderr.write(`dsbot-remote: ${message}\n\n${USAGE}`)
  process.exit(2)
}

// 这台机器是谁：主机靠它判断"同一台重连"还是"新机器"。
// 有 device.json 就听它的。写不了盘的情况（手机 /opt/dsh 只读、容器、只读 home）
// 不能每次随机发一个 —— 那样每次连都是新身份，主机的设备列表里就会一次一条地
// 堆出"手机""手机测试""手机 2"。退到机器指纹：同一台机器永远同一个 id。
function machineFingerprint() {
  const parts = [hostname(), platform(), arch()]
  try { parts.push(userInfo().username) } catch { /* 取不到就不算它 */ }
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 10)
}

export async function deviceIdentity(name) {
  const file = join(HOME, 'device.json')
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'))
    if (typeof saved?.deviceId === 'string') return saved.deviceId
  } catch {
    // 第一次跑，或文件坏了：下面按指纹算一个，不拦路。
  }
  const deviceId = `d-${machineFingerprint()}`
  await mkdir(HOME, { recursive: true }).catch(() => {})
  await writeFile(file, JSON.stringify({ deviceId, name, createdAt: Date.now() }, null, 2), 'utf8').catch(() => {})
  return deviceId
}

// 一条连上来的主机：报身份，然后接活。
// 模型说"文件在这"的最简形式：单独一行 `@@attach D:/work/report.md`。
// 不扫目录、不猜"这一轮改了什么"——那两条都会把无关文件带进群。
const ATTACH_BYTES = 3 * 1024 * 1024

async function collectAttachments(text) {
  const found = []
  for (const match of String(text ?? '').matchAll(/^@@attach[ 	]+(.+)$/gm)) {
    const target = match[1].trim().replace(/^["'<]|["'>]$/g, '')
    if (target === '') continue
    try {
      const info = await stat(target)
      if (!info.isFile()) { say(`跳过 ${target}：不是文件`); continue }
      if (info.size > ATTACH_BYTES) { say(`跳过 ${target}：${info.size} 字节，超过 ${ATTACH_BYTES}`); continue }
      const data = await readFile(target)
      found.push({ name: basename(target), size: data.length, data: data.toString('base64') })
    } catch (error) {
      say(`跳过 ${target}：${error.message}`)
    }
  }
  return found
}

export function servePeer(peer, { name, deviceId, cwd, agent, local, llm, inbox = 7788, wantedGroups = [], onGroupLine, onGroups, onHostInfo }) {
  say(`主机已连上 ${peer.remote ?? '主机'}`)
  // 能说话 = 显式配了 agent 命令，或者这台 DSH 自己有模型可用。
  const canTurn = agent !== undefined || (local !== undefined && llm !== undefined)
  const caps = canTurn ? [...CAPS, 'agent'] : CAPS
  // 工作区：这台机器选定的主文件夹。握手就报给主机，主机据此浏览它的文件；
  // 之后换了也只需要一条心跳，不用重连。
  let workspace = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
  const wanted = Array.isArray(wantedGroups) ? wantedGroups.filter(each => typeof each === 'string' && each !== '') : []
  peer.send({
    id: 'hello',
    method: 'node.hello',
    params: {
      name, deviceId, caps, workspace,
      ...(wanted.length === 0 ? {} : { wantedGroups: wanted }),
    },
  })
  const turns = new Map()
  let groups = []
  let available = []
  let postSeq = 0
  // 发出去等回答的帧（node.post / node.wants）。带 id 的请求必须有回执，
  // 否则界面点了"进群"永远转圈。
  const waiting = new Map()

  const ask = (method, params, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    postSeq += 1
    const id = `ask-${postSeq}`
    const timer = setTimeout(() => {
      waiting.delete(id)
      reject(new Error(`${method} 超过 ${timeoutMs}ms 没有回答`))
    }, timeoutMs)
    timer.unref?.()
    waiting.set(id, { resolve, reject, timer })
    try {
      peer.send({ id, method, params })
    } catch (error) {
      clearTimeout(timer)
      waiting.delete(id)
      reject(error)
    }
  })

  // 心跳：15 秒一条。主机靠它区分"还活着但没说话"和"电脑睡了 / 进程没了"。
  // 少了这条，一条半死的 TCP 会让群里那条 Bot 一直显示"正在输入…"。
  let beat = null
  const startBeat = () => {
    if (beat !== null) return
    beat = setInterval(() => {
      try {
        peer.send({ method: 'node.presence', params: { state: 'online', workspace } })
      } catch {
        /* 断了就算了，close 会把它收掉 */
      }
    }, 15_000)
    beat.unref?.()
  }
  startBeat()

  // 往群里说一句话。主机侧走 node.post，以这台机器在群里的那个 Bot 的身份落进群，
  // 和主机自己发消息走同一条路。groupId 缺省时说给"我进的第一个群"。
  const postText = (text, groupId) => {
    const body = String(text ?? '').trim()
    if (body === '') return Promise.reject(new Error('要说什么？'))
    const group = groupId === undefined
      ? groups[0]
      : groups.find(each => each.id === groupId || each.name === groupId) ?? { id: groupId, name: groupId }
    if (group === undefined) return Promise.reject(new Error('还没进任何群'))
    return ask('node.post', { groupId: group.id, text: body }).then((result) => {
      say(`发到「${group.name}」：${body}`)
      return result
    })
  }

  // 给设置页用的三个口：说话、换工作区、申请进群。
  const controller = {
    say: (text, groupId) => postText(text, groupId),
    setWorkspace(dir) {
      const next = String(dir ?? '').trim()
      if (next !== '') workspace = next
      try { peer.send({ method: 'node.presence', params: { state: 'online', workspace } }) } catch {}
      say(`工作区 ${workspace}`)
      return { workspace }
    },
    want(ids) {
      const list = (Array.isArray(ids) ? ids : []).filter(each => typeof each === 'string' && each !== '')
      if (list.length === 0) return Promise.resolve({ ok: true, bound: [], refused: [] })
      return ask('node.wants', { groups: list }, 30_000)
    },
  }

  // 本地信箱：这台机器上的别的进程（另一个 agent、一个脚本、你自己）想说话，
  // 往 127.0.0.1:7788 写一行就行。只监听回环，外面的机器连不上。
  const startInbox = (port) => {
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8')
      let buffer = ''
      const drain = () => {
        let at = buffer.indexOf('\n')
        while (at >= 0) {
          const line = buffer.slice(0, at).trim()
          buffer = buffer.slice(at + 1)
          if (line !== '') postText(line).catch(error => say(`这句话没发出去：${error.message}`))
          at = buffer.indexOf('\n')
        }
      }
      socket.on('data', (chunk) => { buffer += chunk; drain() })
      socket.on('end', () => {
        const rest = buffer.trim()
        buffer = ''
        if (rest !== '') postText(rest).catch(error => say(`这句话没发出去：${error.message}`))
      })
      socket.on('error', () => {})
    })
    server.on('error', (error) => {
      if (port !== 0) { say(`${port} 端口被占了，换一个随机的`); startInbox(0); return }
      say(`本地信箱没起来：${error.message}`)
    })
    server.listen(port, '127.0.0.1', () => {
      say(`往群里说话：把一行字写到 127.0.0.1:${server.address().port}（不占终端）`)
    })
    server.unref?.()
  }
  if (inbox !== false && inbox !== null) startInbox(Number(inbox) || 0)

  peer.on('frame', async (frame) => {
    if (frame?.id === 'hello') {
      // 主机回执：它叫什么、这台机器已经进了哪些群、还有哪些群可以进。
      const result = frame.result ?? {}
      if (Array.isArray(result.groups)) {
        groups = result.groups
        if (groups.length > 0) say(`在群里：${groups.map(group => group.name).join('、')}`)
        // 加入端要把这些群在本地也建出来（镜像群），不然群列表里看不到。
        if (typeof onGroups === 'function') {
          Promise.resolve(onGroups(groups)).catch(error => say(`建镜像群失败：${error.message}`))
        }
      }
      if (Array.isArray(result.available)) {
        available = result.available
        if (available.length > 0) say(`主机那边有 ${available.length} 个群可以进：${available.map(group => group.name).join('、')}`)
      }
      if (frame.error !== undefined) say(`主机拒绝了握手：${frame.error.message ?? frame.error.code}`)
      if (typeof onHostInfo === 'function') {
        try {
          onHostInfo({
            hostName: String(result.hostName ?? ''),
            groups, available, nodeId: result.nodeId,
          })
        } catch (error) {
          say(`回调出错：${error.message}`)
        }
      }
      return
    }
    // 等着的请求有回答了（node.post / node.wants）：交给它。
    if (frame?.id !== undefined) {
      const waiter = waiting.get(frame.id)
      if (waiter !== undefined) {
        clearTimeout(waiter.timer)
        waiting.delete(frame.id)
        if (frame.error !== undefined) waiter.reject(new Error(frame.error.message ?? frame.error.code))
        else waiter.resolve(frame.result)
      }
    }
    // error 要说出来：发消息被拒的时候，日志里得有一句为什么。
    if (frame?.id !== undefined && frame.error !== undefined) {
      say(`主机说：${frame.error.message ?? frame.error.code}`)
      return
    }
    // 对前面某个请求的回答，这里没有别的等待中的请求，忽略。
    if (frame?.id !== undefined && frame.result !== undefined) return
    if (typeof frame?.method !== 'string') return

    // 群聊镜像：主机把群里的消息推过来，这里像正常群聊那样滚动打印。
    // 主机后来把这台机器拉进新群：只发一个空的 snapshot，让本地先把群建出来。
    if (frame.method === 'group.snapshot') {
      const params = frame.params ?? {}
      const room = params.room ?? {}
      const lines = Array.isArray(params.lines) ? params.lines : []
      if (typeof onGroupLine === 'function') {
        try { onGroupLine({ roomId: room.id, roomName: room.name, snapshot: true }, lines) } catch (error) {
          say(`镜像失败：${error.message}`)
        }
      }
      if (frame.id !== undefined) peer.send({ id: frame.id, result: { ok: true } })
      return
    }

    if (frame.method === 'group.line') {
      const params = frame.params ?? {}
      const lines = Array.isArray(params.lines) ? params.lines : []
      if (params.snapshot === true) {
        process.stdout.write(`  ── 「${params.roomName ?? '群'}」最近的 ${lines.length} 条 ──\n`)
      }
      for (const line of lines) chat(line)
      // 镜像（手机上真的建一个同名群）走这个回调；CLI 自己用就不传。
      if (typeof onGroupLine === 'function') {
        try { onGroupLine(params, lines) } catch (error) { say(`镜像失败：${error.message}`) }
      }
      return
    }

    if (frame.method === 'node.exec') {
      const action = frame.params?.action
      say(`执行 ${action}${frame.params?.args?.path ? ` ${frame.params.args.path}` : ''}`)
      const result = await execute(frame.params, { cwd })
      if (frame.id !== undefined) peer.send({ id: frame.id, result })
      return
    }

    if (frame.method === 'turn.request') {
      const { turnId, prompt, cwd: asked, deadlineMs } = frame.params ?? {}
      if (!canTurn) {
        if (frame.id !== undefined) {
          peer.send({ id: frame.id, error: { code: 'node/unsupported', message: '这台没配 agent，也找不到本机模型，跑不了 turn' } })
        }
        return
      }
      // 先回执：主机那边已经开了一轮，别让它等一个"收到"才动。
      if (frame.id !== undefined) peer.send({ id: frame.id, result: { accepted: true, turnId } })
      say(`跑一轮 ${turnId}（${String(prompt ?? '').length} 字）`)

      const controller = new AbortController()
      turns.set(turnId, controller)
      const onDelta = text => peer.send({ method: 'turn.event', params: { turnId, kind: 'delta', text } })
      // 优先用用户显式配的命令；没配就走这台 DSH 自己的模型（开箱即用那条路）。
      const result = agent !== undefined
        ? await runAgent({
          command: agent.command,
          args: agent.args,
          prompt,
          cwd: typeof asked === 'string' && asked !== '' ? asked : cwd,
          timeoutMs: Number(deadlineMs) > 0 ? Number(deadlineMs) : undefined,
          signal: controller.signal,
          onDelta,
        })
        : await runLocal({
          llm, provider: local.provider, model: local.model,
          prompt, timeoutMs: Number(deadlineMs) > 0 ? Number(deadlineMs) : undefined,
          signal: controller.signal, onDelta,
        })
      turns.delete(turnId)

      say(`一轮结束 ${turnId}：${result.ok ? 'ok' : result.code} ${String(result.text ?? '').length} 字`)
      // 这一轮要带出去的文件：模型把 `@@attach <路径>` 单独写一行，就是"这个文件给他看"。
      const files = await collectAttachments(result.text)
      if (files.length > 0) say(`带走 ${files.length} 个文件：${files.map(f => f.name).join('、')}`)
      peer.send({
        method: 'turn.result',
        params: {
          turnId,
          status: result.ok ? 'ok' : result.aborted ? 'cancelled' : 'failed',
          text: result.text,
          message: result.message,
          ...(files.length > 0 ? { files } : {}),
        },
      })
      return
    }

    if (frame.method === 'turn.cancel') {
      turns.get(frame.params?.turnId)?.abort()
      if (frame.id !== undefined) peer.send({ id: frame.id, result: { ok: true } })
      return
    }

    // 其余方法这台机器没有：明确拒绝，不假装在做。
    if (frame.id !== undefined) {
      peer.send({ id: frame.id, error: { code: 'node/unsupported', message: `这台还没接 ${frame.method}` } })
    }
  })

  peer.on('close', () => {
    if (beat !== null) clearInterval(beat)
    beat = null
    // 断线时还等着的请求必须有下落：不然界面上"进群"那一栏会一直转圈。
    for (const [, waiter] of waiting) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('和主机断开了'))
    }
    waiting.clear()
    say(`断开 ${peer.remote}`)
  })
  peer.on('bad-frame', error => say(`坏帧：${error.message}`))
  return controller
}

async function startListen(args) {
  const code = typeof args.code === 'string' ? args.code.replace(/[\s-]/g, '').toUpperCase() : undefined
  const token = code ?? (typeof args.token === 'string' ? args.token : process.env.DSBOT_NODE_TOKEN)
  if (token === undefined || token.length < 6) fail('listen 需要 --code（6 位配对码）或 --token（至少 6 位）')

  const name = typeof args.name === 'string' ? args.name : hostname()
  const cwd = typeof args.cwd === 'string' ? args.cwd : process.cwd()
  const deviceId = await deviceIdentity(name)
  const agent = parseAgentCommand(args.agent)

  const server = await listenTcp({
    port: Number(args.port ?? 7777),
    host: typeof args.host === 'string' ? args.host : '0.0.0.0',
    token,
    onConnection: peer => servePeer(peer, { name, deviceId, cwd, agent }),
  })

  let discovery
  if (code !== undefined) {
    discovery = await listenDiscovery({
      code,
      port: server.port,
      name,
      onPair: ip => say(`配对请求来自 ${ip}`),
      warn: say,
    })
    say(`配对码 ${code} —— 另一台机器运行：dsbot-remote pair --code ${code}`)
  }

  say(`监听 ${args.host ?? '0.0.0.0'}:${server.port}`)
  say(`我是 ${name}（${deviceId}），能做：${ALLOWED_ACTIONS.join('/')}${agent === undefined ? '（没配 --agent，跑不了 turn）' : `，turn 用：${agent.command} ${agent.args.join(' ')}`}`)
  say(`工作目录 ${cwd}`)

  const stop = () => {
    say('收工')
    discovery?.close()
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

/**
 * 一条命令接上主机：找码 → （可选）组网 → 连。
 * 用户只需要知道配对码。
 */
async function runPair(args) {
  const raw = typeof args.code === 'string' ? args.code : ''
  const code = raw.replace(/[\s-]/g, '').toUpperCase()
  if (code.length < 6) fail('pair 需要 --code（6 位配对码）')

  const name = typeof args.name === 'string' ? args.name : hostname()
  const cwd = typeof args.cwd === 'string' ? args.cwd : process.cwd()
  const deviceId = await deviceIdentity(name)
  const agent = parseAgentCommand(args.agent)

  let network
  // 进虚拟网。配对码就是网络名 + 密钥（见 pairCredentials），所以两端只要码一样
  // 就一定在同一个网里 —— 这是"跨网只需要一个码"的全部原理。
  const enterNetwork = async () => {
    if (network !== undefined) return network
    const found = await findEasyTier()
    if (found === undefined) {
      fail(`没找到 EasyTier（找过 ${EASYTIER_DIR} 和 PATH）。先装一份，或确认两台机器在同一局域网。`)
    }
    say(`加入虚拟网 ${pairCredentials(code).networkName} …`)
    network = startEasyTier({ core: found.core, code, onLog: line => say(`  [et] ${line}`) })
    const ready = await network.ready
    say(`虚拟网已就绪${ready.ipv4 ? `（${ready.ipv4}）` : ''}，主机在 ${hostVirtualIp(code).split('/')[0]}`)
    return network
  }

  if (args.network === true || args.network === 'true') await enterNetwork()

  try {
    let host
    if (typeof args.to === 'string' && args.to !== '') {
      // 不在同一个广播域时用这个：手机热点、跨网段、或者广播被防火墙吃了。
      const [rawHost, rawPort] = args.to.replace(/^tcp:\/\//, '').split(':')
      host = { host: rawHost, port: Number(rawPort) > 0 ? Number(rawPort) : 7777, name: rawHost }
      say(`直接连 ${host.host}:${host.port}（跳过广播）`)
    } else {
      say(`找配对码 ${code} 的主机…`)
      try {
        host = await findHost({ code, onProbe: address => say(`  询问 ${address}`) })
      } catch {
        // UDP 广播出不了局域网：找不到就说明对面不在这张网里（或者广播被防火墙吃了）。
        // 与其让人回去翻文档加参数，不如直接进虚拟网按主机的固定地址连。
        say('局域网里没找到，改走跨网…')
        await enterNetwork()
        const target = hostVirtualIp(code).split('/')[0]
        host = { host: target, port: 7777, name: '虚拟网主机' }
        say(`走虚拟网找 ${target}:7777`)
      }
    }
    say(`找到 ${host.name || '主机'} ${host.host}:${host.port}`)

    const peer = await connectTcp({ url: `tcp://${host.host}:${host.port}`, token: code })
    say('已连上')
    servePeer(peer, { name, deviceId, cwd, agent })

    const stop = () => {
      say('收工')
      try { peer.close() } catch {}
      network?.stop()
      process.exit(0)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  } catch (error) {
    network?.stop()
    fail(error.message)
  }
}

async function runConnect(args) {
  if (typeof args.to !== 'string') fail('connect 需要 --to tcp://host:port')
  const token = typeof args.token === 'string' ? args.token : process.env.DSBOT_NODE_TOKEN
  if (token === undefined) fail('connect 需要 --token')

  const name = typeof args.name === 'string' ? args.name : hostname()
  const deviceId = await deviceIdentity(name)
  const peer = await connectTcp({ url: args.to, token })
  servePeer(peer, { name, deviceId, cwd: typeof args.cwd === 'string' ? args.cwd : process.cwd() })
  process.on('SIGINT', () => { peer.close(); process.exit(0) })
}

export async function main(argv) {
  const [command, ...rest] = argv
  const args = parseArgs(rest)
  if (command === 'listen') await startListen(args)
  else if (command === 'connect') await runConnect(args)
  else if (command === 'pair') await runPair(args)
  else if (command === 'version') process.stdout.write('dsbot-remote 0.1.0\n')
  else fail(command === undefined ? '缺命令' : `不认识的命令：${command}`)
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) await main(process.argv.slice(2))
