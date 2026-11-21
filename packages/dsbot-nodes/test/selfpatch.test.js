import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ANCHOR, ensureDsbotProvide, inspectDsbot } from '../src/host/nodes/selfpatch.js'

function fakePackage({ name = 'index.js', source, version = '0.3.8', main = 'plugin.js' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-selfpatch-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ds-bot', version, main }))
  if (name !== null) writeFileSync(join(dir, name), source)
  return dir
}

const RUNTIME = `import { createRuntime } from './runtime.js'
export async function apply(ctx, config) {
  const rt = createRuntime(ctx, config)
  ${ANCHOR}
  return rt
}
`

const SHIM = `export async function apply(ctx, config) {
  const host = await import('./index.js')
  return host.apply(ctx, config)
}
`

test('自补：缺 provide 时插到锚点行后面，并留一份备份', () => {
  delete process.env.DSBOT_NODES_TEST
  const dir = fakePackage({ source: RUNTIME })
  const result = ensureDsbotProvide({ dir })
  assert.equal(result.status, 'patched')
  const patched = readFileSync(join(dir, 'index.js'), 'utf8')
  assert.ok(patched.includes(ANCHOR + "\n    ctx.provide('bot', rt)"))
  assert.equal(readFileSync(join(dir, 'index.js.bak-dsbot-provide'), 'utf8'), RUNTIME)
  process.env.DSBOT_NODES_TEST = '1'
})

test('自补：已经有那一行就不动文件', () => {
  delete process.env.DSBOT_NODES_TEST
  const dir = fakePackage({ source: RUNTIME + "\nctx.provide('bot', rt)\n" })
  const before = readFileSync(join(dir, 'index.js'), 'utf8')
  const result = ensureDsbotProvide({ dir })
  assert.equal(result.status, 'ok')
  assert.equal(readFileSync(join(dir, 'index.js'), 'utf8'), before)
  assert.equal(existsSync(join(dir, 'index.js.bak-dsbot-provide')), false)
  process.env.DSBOT_NODES_TEST = '1'
})

test('自补：找不到锚点就报 unmatched，不瞎改', () => {
  delete process.env.DSBOT_NODES_TEST
  // 有 createRuntime 的痕迹，但锚点那行写法变了（上游改了代码）
  const source = "const rt = createRuntime(ctx, config)\nvoid rt.adoptLiveWork?.()\n"
  const dir = fakePackage({ source })
  const result = ensureDsbotProvide({ dir })
  assert.equal(result.status, 'unmatched')
  assert.equal(readFileSync(join(dir, 'index.js'), 'utf8'), source)
  process.env.DSBOT_NODES_TEST = '1'
})

test('自补：测试环境默认跳过', () => {
  process.env.DSBOT_NODES_TEST = '1'
  const dir = fakePackage({ source: RUNTIME })
  const result = ensureDsbotProvide({ dir })
  assert.equal(result.status, 'skipped')
})

test('自补：解析不到 ds-bot 时退到 profile 目录里找', () => {
  delete process.env.DSBOT_NODES_TEST
  const home = mkdtempSync(join(tmpdir(), 'dsbot-home-'))
  const pkg = join(home, 'profiles', 'desktop', 'node_modules', 'ds-bot')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'ds-bot', version: '0.3.8', main: 'plugin.js' }))
  writeFileSync(join(pkg, 'index.js'), RUNTIME)
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const result = ensureDsbotProvide()
  assert.equal(result.status, 'patched')
  assert.ok(readFileSync(join(pkg, 'index.js'), 'utf8').includes("ctx.provide('bot', rt)"))
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
  process.env.DSBOT_NODES_TEST = '1'
})

test('自补：能顺着 plugin.js 壳点名真正的实现文件（不误报）', () => {
  delete process.env.DSBOT_NODES_TEST
  const dir = fakePackage({ source: RUNTIME })
  writeFileSync(join(dir, 'plugin.js'), SHIM)
  const info = inspectDsbot({ dir })
  assert.equal(info.version, '0.3.8')
  assert.match(info.text, /实现在 index\.js/)
  assert.match(info.text, /入口 plugin\.js/)
  assert.match(info.text, /缺 ctx\.provide/)
  process.env.DSBOT_NODES_TEST = '1'
})
