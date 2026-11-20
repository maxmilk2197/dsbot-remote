// 本文件由 AI 生成，请勿用于生产环境。
// EasyTier 自动下载：资源名映射、缓存布局、本地查找顺序。
// 不联网 —— 真下载由 ensureEasyTier 在运行期做，测试只验纯逻辑。
// 测试环境不联网下载
process.env.DSBOT_NODES_TEST = '1'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cliName,
  coreName,
  easyTierAssetName,
  easyTierAssetUrl,
  easyTierCacheDir,
  findEasyTierBinaries,
} from '../src/node/easytier-fetch.js'
import { findEasyTier } from '../src/node/easytier.js'

test('资源名按平台映射到官方 Release 的命名', () => {
  assert.equal(easyTierAssetName('v2.6.4', 'win32', 'x64'), 'easytier-windows-x86_64-v2.6.4.zip')
  assert.equal(easyTierAssetName('v2.6.4', 'win32', 'arm64'), 'easytier-windows-arm64-v2.6.4.zip')
  assert.equal(easyTierAssetName('v2.6.4', 'darwin', 'arm64'), 'easytier-macos-aarch64-v2.6.4.zip')
  assert.equal(easyTierAssetName('v2.6.4', 'linux', 'x64'), 'easytier-linux-x86_64-v2.6.4.zip')
  assert.equal(easyTierAssetName('v2.6.4', 'linux', 'arm64'), 'easytier-linux-aarch64-v2.6.4.zip')
  // 不认识的平台要如实返回 undefined，不能瞎拼一个地址去下载
  assert.equal(easyTierAssetName('v2.6.4', 'aix', 'ppc64'), undefined)
})

test('下载地址默认走 GitHub，镜像前缀可覆盖', () => {
  const old = process.env.DSBOT_EASYTIER_MIRROR
  const oldDirect = process.env.DSBOT_EASYTIER_URL
  delete process.env.DSBOT_EASYTIER_MIRROR
  delete process.env.DSBOT_EASYTIER_URL
  try {
    assert.equal(
      easyTierAssetUrl('v2.6.4', 'win32', 'x64'),
      'https://github.com/EasyTier/EasyTier/releases/download/v2.6.4/easytier-windows-x86_64-v2.6.4.zip',
    )
    process.env.DSBOT_EASYTIER_MIRROR = 'https://ghfast.top/'
    assert.equal(
      easyTierAssetUrl('v2.6.4', 'win32', 'x64'),
      'https://ghfast.top/https://github.com/EasyTier/EasyTier/releases/download/v2.6.4/easytier-windows-x86_64-v2.6.4.zip',
    )
    process.env.DSBOT_EASYTIER_URL = 'https://example.com/easytier.zip'
    assert.equal(easyTierAssetUrl('v2.6.4', 'win32', 'x64'), 'https://example.com/easytier.zip')
  } finally {
    if (old === undefined) delete process.env.DSBOT_EASYTIER_MIRROR
    else process.env.DSBOT_EASYTIER_MIRROR = old
    if (oldDirect === undefined) delete process.env.DSBOT_EASYTIER_URL
    else process.env.DSBOT_EASYTIER_URL = oldDirect
  }
})

test('缓存目录按版本和平台分开，不会互相覆盖', () => {
  const win = easyTierCacheDir('v9.9.9', 'win32', 'x64')
  const mac = easyTierCacheDir('v9.9.9', 'darwin', 'arm64')
  assert.match(win, /easytier[/\\]v9\.9\.9[/\\]win32-x64$/)
  assert.match(mac, /easytier[/\\]v9\.9\.9[/\\]darwin-arm64$/)
  assert.notEqual(win, mac)
})

test('解压目录多一层也能找到可执行文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'et-find-'))
  try {
    // 直接铺在根上
    await writeFile(join(root, coreName()), '')
    await writeFile(join(root, cliName()), '')
    assert.equal(findEasyTierBinaries(root)?.dir, root)

    // 多套一层版本目录
    const nested = join(root, 'easytier-v2.6.4')
    await mkdir(nested)
    await rm(join(root, coreName()))
    await rm(join(root, cliName()))
    await writeFile(join(nested, coreName()), '')
    assert.equal(findEasyTierBinaries(root)?.dir, nested)

    // PATH 扫描不往下翻：只查这一层
    assert.equal(findEasyTierBinaries(root, process.platform, { deep: false }), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('findEasyTier 优先用显式给的目录，测试环境不联网下载', async () => {
  const root = await mkdtemp(join(tmpdir(), 'et-local-'))
  try {
    await writeFile(join(root, coreName()), '')
    const found = await findEasyTier([root])
    assert.equal(found?.dir, root)
    assert.equal(found?.source, 'local')
    assert.equal(found?.core, join(root, coreName()))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
