// 本文件由 AI 生成，请勿用于生产环境。
// 附件预算：单文件 3MiB、整轮 5MiB。超了不是发不出去，而是"整帧被安静丢掉"——
// 因为 send() 遇到超限只回 false。这两个上限就是防这件事的。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectAttachments } from '../src/node/cli.js'

const MiB = 1024 * 1024

test('整轮附件按总量封顶：第三个 2MiB 被跳过', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'attach-'))
  try {
    for (const name of ['a.bin', 'b.bin', 'c.bin']) {
      await writeFile(join(dir, name), Buffer.alloc(2 * MiB, 7))
    }
    const files = await collectAttachments(
      ['@@attach ' + join(dir, 'a.bin'), '@@attach ' + join(dir, 'b.bin'), '@@attach ' + join(dir, 'c.bin')].join('\n'),
      dir,
    )
    assert.equal(files.length, 2, '5MiB 上限内只装得下两个 2MiB')
    assert.deepEqual(files.map(f => f.name), ['a.bin', 'b.bin'])
    const raw = files.reduce((sum, f) => sum + (f.data.length * 3) / 4, 0)
    assert.ok(raw <= 5 * MiB, '解出来的原始字节不超过预算')
    // base64 + JSON 外壳之后仍要留在 8MiB 帧上限内。
    const wire = files.reduce((sum, f) => sum + f.data.length, 0)
    assert.ok(wire < 7 * MiB, '线上字节数留出外壳余量')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('工作区之外的文件不带走（哪怕模型写了绝对路径）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'attach-'))
  const outside = await mkdtemp(join(tmpdir(), 'outside-'))
  try {
    await writeFile(join(dir, 'inside.txt'), 'inside')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    const files = await collectAttachments(
      ['@@attach ' + join(dir, 'inside.txt'), '@@attach ' + join(outside, 'secret.txt')].join('\n'),
      dir,
    )
    assert.deepEqual(files.map(f => f.name), ['inside.txt'])
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
