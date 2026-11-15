// 本文件由 AI 生成，请勿用于生产环境。
// 防多开：重复加载、热重载接管、context 卸载的宽限释放、跨模块副本共享注册表。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  claimInstance,
  flushPendingRelease,
  guardStats,
  releaseInstance,
  resetGuard,
} from '../src/host/nodes/guard.js'

test('同一模块实例被 apply 多次：只建一次，其余拦下并复用', () => {
  resetGuard()
  let built = 0
  const api = { id: 1 }
  const build = () => { built += 1; return { api, dispose: () => {} } }
  const a = claimInstance('m1', build)
  const b = claimInstance('m1', build)
  const c = claimInstance('m1', build)
  assert.equal(built, 1)
  assert.equal(a.reused, false)
  assert.equal(b.reused, true)
  assert.equal(c.reused, true)
  assert.equal(b.api, api)
  const s = guardStats()
  assert.equal(s.attempts, 3)
  assert.equal(s.blocked, 2)
  assert.equal(s.active, true)
  assert.equal(s.events.at(-1).kind, 'blocked')
})

test('热重载换模块：先拆旧实例再建新的，旧 context 迟到卸载不会带走新实例', () => {
  resetGuard()
  const order = []
  claimInstance('m1', () => ({ api: { v: 1 }, dispose: () => order.push('dispose-1') }))
  const second = claimInstance('m2', () => ({ api: { v: 2 }, dispose: () => order.push('dispose-2') }))
  assert.equal(second.reused, false)
  assert.equal(second.api.v, 2)
  assert.deepEqual(order, ['dispose-1'])
  assert.equal(guardStats().takeovers, 1)
  assert.equal(guardStats().owner.moduleId, 'm2')
  assert.equal(releaseInstance('m1'), false)
  assert.equal(guardStats().active, true)
  assert.equal(releaseInstance('m2'), true)
  assert.equal(flushPendingRelease(), true)
  assert.deepEqual(order, ['dispose-1', 'dispose-2'])
  assert.equal(guardStats().active, false)
})

test('context 卸载只登记待释放：宽限期内又被认领就取消，不拆实例', () => {
  resetGuard()
  const order = []
  claimInstance('m1', () => ({ api: { v: 1 }, dispose: () => order.push('dispose-1') }))
  assert.equal(releaseInstance('m1'), true)
  assert.equal(guardStats().pendingRelease, true)
  // 下一次 apply 立刻来了：必须复用，不能重建（否则又变成多份）。
  const again = claimInstance('m1', () => { throw new Error('不该重建') })
  assert.equal(again.reused, true)
  assert.equal(guardStats().pendingRelease, false)
  assert.deepEqual(order, [])
})

test('宽限期过了还没人用，才真的拆', () => {
  resetGuard()
  const order = []
  claimInstance('m1', () => ({ api: {}, dispose: () => order.push('dispose-1') }))
  releaseInstance('m1')
  assert.equal(flushPendingRelease(), true)
  assert.deepEqual(order, ['dispose-1'])
  assert.equal(guardStats().active, false)
})

test('build 抛错不留半份实例，下一次还能正常装', () => {
  resetGuard()
  assert.throws(() => claimInstance('mX', () => { throw new Error('boom') }), /boom/)
  assert.equal(guardStats().active, false)
  const ok = claimInstance('mX', () => ({ api: { ok: true }, dispose: () => {} }))
  assert.equal(ok.reused, false)
  assert.equal(ok.api.ok, true)
})

test('统计里能看出拦了几次、接管了几次', () => {
  resetGuard()
  claimInstance('m1', () => ({ api: {}, dispose: () => {} }))
  claimInstance('m1', () => ({ api: {}, dispose: () => {} }))
  claimInstance('m2', () => ({ api: {}, dispose: () => {} }))
  const s = guardStats()
  assert.equal(s.attempts, 3)
  assert.equal(s.blocked, 1)
  assert.equal(s.takeovers, 1)
  assert.equal(s.owner.pid, process.pid)
  assert.ok(s.events.some(event => event.kind === 'takeover' && event.replaced === 'm1'))
  resetGuard()
  assert.equal(guardStats().attempts, 0)
})

test('两个 ESM 模块副本共享同一份注册表（模拟热重载）', async () => {
  resetGuard()
  const copy = await import('../src/host/nodes/guard.js?reload=guard-test')
  copy.claimInstance('mA', () => ({ api: { v: 'A' }, dispose: () => {} }))
  const b = claimInstance('mB', () => ({ api: { v: 'B' }, dispose: () => {} }))
  assert.equal(b.reused, false)
  assert.equal(copy.guardStats().takeovers, 1)
  assert.equal(guardStats().owner.moduleId, 'mB')
  copy.resetGuard()
  assert.equal(guardStats().active, false)
})
