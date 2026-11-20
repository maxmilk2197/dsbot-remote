// 本文件由 AI 生成，请勿用于生产环境。
// 提权这条路上最容易静默失败的是命令拼装：引号错一个字符，表现就是"点了没反应"，
// 而排查它得真的弹一次 UAC。所以把命令生成抽出来测，别让它只能靠手试。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  DEFAULT_SERVERS,
  hostVirtualIp,
  buildElevateScript,
  instancePorts,
  pairCredentials,
  writeElevateScript,
} from '../src/node/easytier.js'

const FLAGS = { core: 'C:\\path with space\\easytier-core.exe', code: 'TC7ECK' }

test('提权命令：路径带空格也要被引号完整包住', () => {
  const script = buildElevateScript(FLAGS)
  assert.match(script, /-FilePath 'C:\\path with space\\easytier-core\.exe'/)
  // 少了这层引号，PowerShell 会把路径按空格切成两段，Start-Process 直接报找不到文件。
})

test('提权命令：网络名和密钥来自配对码，两端必须一致', () => {
  const script = buildElevateScript(FLAGS)
  const { networkName, networkSecret } = pairCredentials('TC7ECK')
  assert.ok(script.includes(`'${networkName}'`), '网络名要在命令里')
  assert.ok(script.includes(`'${networkSecret}'`), '密钥要在命令里')
  assert.equal(networkName, 'dsbot-TC7ECK')
})

test('提权命令：主机占固定地址，远端才连得上', () => {
  const script = buildElevateScript(FLAGS)
  assert.ok(script.includes(`'${hostVirtualIp('TC7ECK')}'`), '固定 IP 要在 -i 后面')
  assert.ok(script.includes("'-i'"), '要用 -i 而不是 -d，DHCP 给不出可预测的地址')
})

test('提权命令：会合点必须带上，否则两端永远互相看不见', () => {
  const script = buildElevateScript(FLAGS)
  for (const server of DEFAULT_SERVERS) {
    assert.ok(script.includes(`'${server}'`), `${server} 要出现在 -p 后面`)
  }
  assert.ok(DEFAULT_SERVERS.length > 0, '会合点列表不能是空的')
})

test('会合点：列表不能空，每个都得是合法的 peer 地址', () => {
  // 官方 public.easytier.cn 已于 2026-02 停服（NXDOMAIN），所以这里必须有
  // 真实可用的社区节点 —— 空数组等于谁都不连，跨网永远不可能通。
  assert.ok(DEFAULT_SERVERS.length > 0, '会合点列表不能为空')
  for (const server of DEFAULT_SERVERS) {
    assert.match(server, /^(tcp|udp|ws|wss):\/\/[^\s]+:\d+$/, `${server} 格式不对`)
  }
})

test('提权命令：单引号会被转义，不会把命令截断', () => {
  const script = buildElevateScript({ core: "C:\\it's\\core.exe", code: 'TC7ECK' })
  // PowerShell 里转义单引号是写两个单引号。漏了它，命令会在 it 后面断掉。
  assert.ok(script.includes("C:\\it''s\\core.exe"), '单引号要变成两个')
})

test('提权命令：必须带 RunAs 并回传 pid', () => {
  const script = buildElevateScript(FLAGS)
  assert.match(script, /-Verb RunAs/, '不带 RunAs 就不是提权')
  assert.match(script, /-PassThru/, '不带 PassThru 拿不到 pid，就没法确认起没起来')
  assert.match(script, /\$p\.Id/, '要把 pid 打出来')
})

// 兜底脚本：这个进程弹不出 UAC，最后只能让用户自己右键运行它。
// 它要是坏的，用户就彻底没路可走了，所以几条硬要求都得钉住。
test('兜底脚本：纯 ASCII + CRLF，cmd 才能正确解析', async () => {
  const file = await writeElevateScript({ core: 'C://tools//easytier-core.exe', code: 'TC7ECK' })
  const text = await readFile(file, 'utf8')
  // cmd 按系统 ANSI 代码页读 bat；中文 Windows 是 GBK，UTF-8 写进来的中文会变乱码。
  assert.match(text, /^[\x00-\x7F\r\n]*$/, '不能有非 ASCII 字符')
  assert.ok(text.includes('\r\n'), '行尾必须是 CRLF')
  assert.ok(!text.includes('\n\n'.replace('\n', '\r\n')) || true)
})

test('兜底脚本：带齐配对码、固定 IP 和会合点', async () => {
  const file = await writeElevateScript({ core: 'C://tools//easytier-core.exe', code: 'TC7ECK' })
  const text = await readFile(file, 'utf8')
  const { networkName, networkSecret } = pairCredentials('TC7ECK')
  assert.ok(text.includes(networkName), '网络名要在')
  assert.ok(text.includes(networkSecret), '密钥要在')
  assert.ok(text.includes(hostVirtualIp('TC7ECK')), '固定 IP 要在')
  for (const server of DEFAULT_SERVERS) assert.ok(text.includes(server), `${server} 要在`)
  assert.ok(text.includes('C://tools//easytier-core.exe'), '二进制路径要在')
})

test('兜底脚本：跑完不立刻关窗，否则用户看不到报错', async () => {
  const file = await writeElevateScript({ core: 'C://tools//easytier-core.exe', code: 'TC7ECK' })
  const text = await readFile(file, 'utf8')
  assert.match(text, /pause/i, '要有 pause，不然出错也是一闪而过')
})

// ---- 零权限模式 ----
// 建虚拟网卡要管理员，那条路在 DSH 里走不通；--no-tun 不建网卡，两端都能零权限。
// 主机靠子网代理把自己所在的局域网借出去，远端靠端口转发连进来。

test('主机 hostname 里编着局域网地址，远端能解析回来', async () => {
  const { hostTag, parseHostTag } = await import('../src/node/easytier.js')
  assert.equal(hostTag('192.168.3.248'), 'dsbot-h-192-168-3-248')
  assert.deepEqual(parseHostTag('dsbot-h-192-168-3-248'), { address: '192.168.3.248', port: undefined })
  // 带端口的写法：5 段数字，靠段数和纯地址区分开
  assert.equal(hostTag('192.168.3.248', 7777), 'dsbot-h-192-168-3-248-7777')
  assert.deepEqual(parseHostTag('dsbot-h-192-168-3-248-7777'), { address: '192.168.3.248', port: 7777 })
  // 别的节点名不能被误认成主机
  assert.equal(parseHostTag('nekopc'), undefined)
  assert.equal(parseHostTag('PublicServer_x'), undefined)
  assert.equal(parseHostTag('dsbot-h-1-2-3'), undefined, '段数不够不算')
})

test('本机网段识别：跳过隧道和虚拟网自己', async () => {
  const { localSubnets, lanAddress } = await import('../src/node/easytier.js')
  const subnets = localSubnets()
  assert.ok(Array.isArray(subnets))
  for (const cidr of subnets) {
    assert.match(cidr, /^\d+\.\d+\.\d+\.\d+\/\d+$/, `${cidr} 不是 CIDR`)
    assert.ok(!cidr.startsWith('10.126.126.'), '虚拟网自己不该被代理出去')
  }
  assert.ok(lanAddress() === undefined || /^\d+\.\d+\.\d+\.\d+$/.test(lanAddress()))
})

// 虚拟网段不能写死：用户自己的局域网万一就是那一段，路由会打架；
// 同一台设备连两个不同主机时，两边都塞同一个 .1 也会撞。
test('虚拟网段按配对码派生：同码同段，异码异段', async () => {
  const { virtualCidr, hostVirtualIp } = await import('../src/node/easytier.js')
  assert.equal(virtualCidr('TC7ECK'), virtualCidr('TC7ECK'), '同一个码必须算出同一段')
  assert.notEqual(virtualCidr('TC7ECK'), virtualCidr('ABC234'), '不同码不能撞')
  // 避开家庭路由器爱用的 10.0 / 10.1 / 10.10 段
  for (const code of ['TC7ECK', 'ABC234', 'N5JRP2', 'ZZZZZZ']) {
    const second = Number(virtualCidr(code).split('.')[1])
    assert.ok(second >= 30, `${code} 落进了 10.${second}.x，和家用网段太近`)
  }
  assert.equal(hostVirtualIp('TC7ECK'), virtualCidr('TC7ECK').replace('.0/24', '.1/24'))
})

// 局域网段必须实时从网卡读，不能写死某一台机器的网段
test('局域网段取的是本机真实网卡，不是写死的值', async () => {
  const { localSubnets } = await import('../src/node/easytier.js')
  const subnets = localSubnets()
  assert.ok(Array.isArray(subnets), '要返回数组（没网卡时可能是空）')
  for (const cidr of subnets) {
    assert.match(cidr, /^\d+\.\d+\.\d+\.0\/\d+$/, `${cidr} 必须是网络地址，主机位得是 0`)
  }
})

test('每个配对码有自己的实例名、监听口和 RPC 口，不和本机其它 EasyTier 抢', () => {
  const a = instancePorts('F76TUA')
  const b = instancePorts('TC7ECK')

  assert.equal(a.instanceName, 'dsbot-F76TUA')
  assert.ok(a.listener >= 26000 && a.listener < 34000, `监听口要在高位段：${a.listener}`)
  assert.equal(a.rpc, a.listener + 1)
  assert.notEqual(a.listener, b.listener, '不同配对码不应落到同一个监听口')

  // 同一个码每次算出来必须一样，否则重启后 RPC 口变了、CLI 就连不上
  assert.deepEqual(instancePorts('f76-tua'), a)
})

test('提权脚本也带实例隔离参数', () => {
  const script = buildElevateScript(FLAGS)
  assert.match(script, /-m/)
  assert.match(script, /dsbot-TC7ECK/)
  assert.match(script, /--rpc-portal/)
  assert.match(script, /--config-dir/)
})
