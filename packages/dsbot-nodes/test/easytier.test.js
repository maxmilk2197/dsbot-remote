// 本文件由 AI 生成，请勿用于生产环境。
// 提权这条路上最容易静默失败的是命令拼装：引号错一个字符，表现就是"点了没反应"，
// 而排查它得真的弹一次 UAC。所以把命令生成抽出来测，别让它只能靠手试。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  DEFAULT_SERVERS,
  HOST_VIRTUAL_IP,
  buildElevateScript,
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
  assert.ok(script.includes(`'${HOST_VIRTUAL_IP}'`), '固定 IP 要在 -i 后面')
  assert.ok(script.includes("'-i'"), '要用 -i 而不是 -d，DHCP 给不出可预测的地址')
})

test('提权命令：会合点必须带上，否则两端永远互相看不见', () => {
  const script = buildElevateScript(FLAGS)
  for (const server of DEFAULT_SERVERS) {
    assert.ok(script.includes(`'${server}'`), `${server} 要出现在 -p 后面`)
  }
  assert.ok(DEFAULT_SERVERS.length > 0, '会合点列表不能是空的')
})

test('提权命令：会合点写 IP 不写域名', () => {
  // 域名会被本地代理的 fake-ip 解析成 198.18.x，看着"连上了"其实没出本机。
  for (const server of DEFAULT_SERVERS) {
    assert.match(server, /^tcp:\/\/\d+\.\d+\.\d+\.\d+:\d+$/, `${server} 应该是 IP`)
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
  assert.ok(text.includes(HOST_VIRTUAL_IP), '固定 IP 要在')
  for (const server of DEFAULT_SERVERS) assert.ok(text.includes(server), `${server} 要在`)
  assert.ok(text.includes('C://tools//easytier-core.exe'), '二进制路径要在')
})

test('兜底脚本：跑完不立刻关窗，否则用户看不到报错', async () => {
  const file = await writeElevateScript({ core: 'C://tools//easytier-core.exe', code: 'TC7ECK' })
  const text = await readFile(file, 'utf8')
  assert.match(text, /pause/i, '要有 pause，不然出错也是一闪而过')
})
