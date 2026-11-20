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
