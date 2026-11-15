// 本文件由 AI 生成，请勿用于生产环境。
// 防多开：一个 DSH 进程里只允许存在一份 dsbot-nodes 实例。
//
// 模块级变量（let singleton = null）挡不住热重载：DSH 重新 import 时变量归零，
// 但旧实例开的 7777 监听、EasyTier 子进程、TCP peer 全都还活着，新实例再开一遍
// 就是两份。注册表挂在 globalThis 的 Symbol 上，跨模块实例、跨热重载都还在。
//
// 两类重复加载分开处理：
//   1. 同一个模块实例被 apply 多次（一次启动能调 6~7 次）→ 直接复用，拦下并计数；
//   2. 不同模块实例（热重载）→ 先把旧实例彻底拆掉，再装新的，绝不让两个监听并存。
//
// 还有一个坑：cordis 每装一次就 dispose 一次 sub context，卸载回调来得又密又早
// （nodes-boot.log 里 8 次 install 之间夹着 8 次卸载）。一卸载就拆实例，下一次
// apply 又得重建 —— 等于没防住。所以卸载只登记"待释放"，给一段宽限；期间有人
// 再来认领就取消，真的没人用了才拆。

const KEY = Symbol.for('dsbot-nodes.instance/v1')
const MAX_EVENTS = 12
const RELEASE_GRACE_MS = 8_000

function state() {
  if (globalThis[KEY] === undefined) {
    globalThis[KEY] = {
      owner: null,
      attempts: 0,
      blocked: 0,
      takeovers: 0,
      events: [],
      seq: 0,
      releaseTimer: null,
    }
  }
  return globalThis[KEY]
}

function note(s, kind, moduleId, extra = {}) {
  s.seq += 1
  s.events.push({ seq: s.seq, at: new Date().toISOString(), kind, moduleId, ...extra })
  if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS)
}

function detach(s, moduleId, log) {
  const current = s.owner
  if (current === null || current.moduleId !== moduleId) return false
  s.owner = null
  note(s, 'released', moduleId)
  log(`实例 ${moduleId} 已卸载`)
  try { current.dispose?.() } catch (error) { log(`卸载出错：${error?.message ?? error}`) }
  return true
}

// 每个模块实例一个 id。热重载换了模块 → id 换 → 走"接管"分支。
export function newModuleId() {
  return `m${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function guardStats() {
  const s = state()
  return {
    attempts: s.attempts,
    blocked: s.blocked,
    takeovers: s.takeovers,
    active: s.owner !== null,
    pendingRelease: s.releaseTimer !== null,
    owner: s.owner === null ? null : {
      moduleId: s.owner.moduleId,
      since: s.owner.since,
      pid: process.pid,
    },
    events: s.events.map(event => ({ ...event })),
  }
}

// build() 只在真要新建实例时调用，返回 { api, dispose }。
export function claimInstance(moduleId, build, log = () => {}) {
  const s = state()
  s.attempts += 1

  // 有人又来认领了：撤销上一次卸载留下的待释放计时。
  if (s.releaseTimer !== null) {
    clearTimeout(s.releaseTimer)
    s.releaseTimer = null
    log('撤销待释放：又有 context 来认领了')
  }

  // 同一模块实例重复 apply：不新建 store、不重开端口、不重复挂路由。
  if (s.owner !== null && s.owner.moduleId === moduleId) {
    s.blocked += 1
    note(s, 'blocked', moduleId)
    log(`重复加载被拦下（第 ${s.blocked} 次）：已有实例 ${moduleId}，直接复用`)
    return { api: s.owner.api, reused: true }
  }

  // 热重载：旧模块留下的实例必须先拆干净，否则两个 7777 会互相 EADDRINUSE。
  if (s.owner !== null) {
    const old = s.owner
    s.owner = null
    s.takeovers += 1
    note(s, 'takeover', moduleId, { replaced: old.moduleId })
    log(`热重载接管：先拆掉旧实例 ${old.moduleId}`)
    try { old.dispose?.() } catch (error) { log(`拆旧实例出错：${error?.message ?? error}`) }
  }

  let built
  try {
    built = build()
  } catch (error) {
    // 装失败不能留下"半份 owner"，否则后面所有 apply 都会被它挡住。
    note(s, 'failed', moduleId, { error: String(error?.message ?? error) })
    log(`实例没装起来：${error?.message ?? error}`)
    throw error
  }
  s.owner = { moduleId, api: built.api, dispose: built.dispose, since: Date.now() }
  note(s, 'created', moduleId)
  log(`实例就位 ${moduleId}（进程 ${process.pid}）`)
  return { api: built.api, reused: false }
}

// context 卸载时调：只登记待释放，不立刻拆。宽限期内有新 context 认领就作废。
export function releaseInstance(moduleId, log = () => {}) {
  const s = state()
  if (s.owner === null || s.owner.moduleId !== moduleId) return false
  note(s, 'release-pending', moduleId)
  if (s.releaseTimer !== null) clearTimeout(s.releaseTimer)
  s.releaseTimer = setTimeout(() => {
    s.releaseTimer = null
    detach(s, moduleId, log)
  }, RELEASE_GRACE_MS)
  s.releaseTimer.unref?.()
  return true
}

// 立刻执行待释放（测试与"确定不再用了"的收尾用）。
export function flushPendingRelease(log = () => {}) {
  const s = state()
  if (s.releaseTimer === null) return false
  clearTimeout(s.releaseTimer)
  s.releaseTimer = null
  const owner = s.owner
  if (owner === null) return false
  return detach(s, owner.moduleId, log)
}

export function resetGuard({ dispose = true } = {}) {
  const s = state()
  if (s.releaseTimer !== null) {
    clearTimeout(s.releaseTimer)
    s.releaseTimer = null
  }
  if (s.owner !== null && dispose) {
    try { s.owner.dispose?.() } catch {}
  }
  s.owner = null
  s.attempts = 0
  s.blocked = 0
  s.takeovers = 0
  s.events = []
  s.seq = 0
}
