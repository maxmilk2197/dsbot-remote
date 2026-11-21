// 设置页是把 React 直接当函数库用的（没有 JSX），组件一律走 h(组件, props)。
// 一旦写成 ChatBox({...}) 直接调用，它内部的 useState/useEffect 会被算到
// 调用方 Panel 头上：join.running 由 false 变 true 时 Panel 的 hook 数量突然变多，
// React 抛 #310「Rendered more hooks than during the previous render」，整页白屏。
// 这条用例用源码扫描把这个坑钉住，不依赖浏览器。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const COMPONENTS = ['Panel', 'ChatBox', 'NodeCard', 'JoinDialog', 'FolderPicker']

test('组件只通过 h() 渲染，不能当普通函数直接调用', () => {
  const offenders = []
  for (const name of COMPONENTS) {
    const pattern = new RegExp('(?<![\\w.$])' + name + '\\(\\{', 'g')
    for (const match of source.matchAll(pattern)) {
      const before = source.slice(Math.max(0, match.index - 12), match.index)
      if (/function\s+$/.test(before)) continue // 函数声明本身不算调用
      const line = source.slice(0, match.index).split('\n').length
      offenders.push(name + ' @ line ' + line)
    }
  }
  assert.deepEqual(offenders, [], '组件被直接调用会打乱 hook 顺序：' + offenders.join(', '))
})

test('ChatBox 用 h(ChatBox, {...}) 渲染', () => {
  assert.match(source, /h\(ChatBox, \{ join, act \}\)/)
})

// 404 只说明"路由没挂上"，得直接指向真正的原因和要看的日志。
test('404 时给出可执行的解释', () => {
  assert.match(source, /const statusErrorText = /)
  assert.match(source, /setError\(statusErrorText\(e\)\)/)
  assert.match(source, /等不到 bot 服务/)
})

// 缺 EasyTier 时得给一个「下载 / 重试」，不能只留一句静态的「正在进虚拟网…」。
test('EasyTier 没准备好时给出下载 / 重试入口', () => {
  assert.match(source, /const et = state\?\.easytier/)
  assert.match(source, /etBusy \|\| etTrouble/)
  assert.match(source, /jpost\('\/network'\)/)
  assert.match(source, /EasyTier（跨网用的组件）/)
})

// 「进哪个群？用哪个文件夹？」只对一条连接自动弹一次。
// 以前每次进设置页 Panel 重新挂载、autoOpened 归零，就又弹一遍 —— 这里把
// 「按连接认一次 + 记住已弹过」两件事钉在源码上。
test('自动弹框按连接记一次，不会每次进设置页都弹出', () => {
  assert.match(source, /const AUTO_OPEN_KEY = 'dsbot-nodes:join-auto-opened'/)
  assert.match(source, /let autoOpenedFor = null/)
  assert.match(source, /const stamp = String\(join\.since/)
  assert.match(source, /autoOpenedFor === stamp \|\| seen === stamp/)
  // 已经进过群的机器不再自动弹（想改还有按钮）
  assert.match(source, /if \(\(join\.groups \?\? \[\]\)\.length > 0\)/)
  assert.match(source, /localStorage\.getItem\(AUTO_OPEN_KEY\)/)
  assert.match(source, /localStorage\.setItem\(AUTO_OPEN_KEY, stamp\)/)
  // 只认 running 就弹的旧写法不能再回来
  assert.doesNotMatch(source, /if \(join\?\.running === true\) \{\s*\n\s*setDialog\(true\)/)
})
