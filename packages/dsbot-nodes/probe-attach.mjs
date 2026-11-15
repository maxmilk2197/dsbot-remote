// 端到端：远端跑一轮，末尾 `@@attach` 指一个文件，主机收到 base64 并落盘。
// 这条链是"远程 Bot 推送自己电脑上的文件"的全部实现，值得真起来跑一遍。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectTcp } from '@dsbot/node-protocol/tcp'
import { acceptUpload } from './src/host/nodes/files.js'

const here = 'D:/Default/dsbot-remote/packages'
const bin = `${here}/dsbot-remote/bin/dsbot-remote.js`
const agent = `${here}/dsbot-remote/test/attach-agent.mjs`

const work = await mkdtemp(join(tmpdir(), 'attach-'))
const source = join(work, '报告.txt')
const body = '远程这台机器上的文件\n第二行\n'
await writeFile(source, body, 'utf8')

const port = 7811
const server = spawn(process.execPath, [
  bin, 'listen', '--port', String(port), '--token', 'attach-token-1',
  '--name', '写代码那台', '--cwd', work, '--agent', `node ${agent}`,
], { cwd: 'D:/Default', env: { ...process.env, ATTACH_TARGET: source } })

let serverOut = ''
const waitFor = (needle) => new Promise((resolve, reject) => {
  let buffer = ''
  const timer = setTimeout(() => reject(new Error(`等不到「${needle}」，已经收到：\n${buffer}`)), 8000)
  server.stdout.on('data', (chunk) => {
    serverOut += chunk.toString('utf8')
    const buffer = serverOut
    if (buffer.includes(needle)) { clearTimeout(timer); resolve() }
  })
  server.stderr.on('data', (chunk) => { buffer += chunk.toString('utf8'); process.stderr.write(`[远端] ${chunk}`) })
})

try {
  await waitFor('监听')
  const peer = await connectTcp({ url: `tcp://127.0.0.1:${port}`, token: 'attach-token-1', timeoutMs: 4000 })
  console.log('已连上')

  const frames = []
  peer.on('frame', frame => frames.push(frame))

  // 远端连上就自报家门，主机这边只读不答。
  await new Promise(resolve => setTimeout(resolve, 250))
  console.log('远端自报:', JSON.stringify(frames.find(f => f.method === 'node.hello')?.params))

  peer.send({ id: 't1', method: 'turn.request', params: { turnId: 't1', prompt: '把报告发我', tools: [], cwd: work, deadlineMs: 8000 } })

  const deadline = Date.now() + 8000
  let result
  while (Date.now() < deadline) {
    result = frames.find(f => f.method === 'turn.result' && f.params?.turnId === 't1')
    if (result !== undefined) break
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  if (result === undefined) {
    console.log('[远端输出]', serverOut)
    throw new Error(`没有收到 turn.result，收到：${JSON.stringify(frames).slice(0, 400)}`)
  }

  const params = result.params
  console.log('turn.result:', params.status, '| 文本含标记:', /\n\n@@attach /.test(params.text ?? ''))
  const file = params.files?.[0]
  console.log('带回文件:', file === undefined ? '（没有）' : `${file.name} ${file.size} 字节`)

  const bytes = Buffer.from(file.data, 'base64')
  const same = createHash('sha256').update(bytes).digest('hex') === createHash('sha256').update(body).digest('hex')
  console.log('内容一致:', same)

  // 主机侧落盘：和 index.js 里 onTurnFiles 走的是同一个函数。
  const home = await mkdtemp(join(tmpdir(), 'outbox-'))
  const saved = await acceptUpload({ home, nodeId: 'n-attach-1', name: file.name, data: bytes })
  console.log('落盘:', saved.ok, saved.path)
  console.log('读回来一致:', (await readFile(saved.path, 'utf8')) === body)

  peer.close()
  await rm(home, { recursive: true, force: true })
} finally {
  server.kill()
  await rm(work, { recursive: true, force: true })
}
