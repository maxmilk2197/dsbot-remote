// 本文件由 AI 生成，请勿用于生产环境。
// 「这台机器叫什么」的规则：用户填的 > 对方的电脑名 > IP/remote 兜底。
import assert from 'node:assert/strict'
import test from 'node:test'
import { isAddressLike, machineNameOf, pickNodeName, shouldRename } from '../src/host/nodes/naming.js'

test('看着像地址的名字', () => {
  for (const name of ['127.0.0.1', '192.168.3.248', 'fe80::1', '[::1]', 'remote', '', '  ', 'd-1a2b3c4d', '虚拟网 → 10.1.1.9:7777', 'tcp://10.0.0.2:7777']) {
    assert.equal(isAddressLike(name), true, name)
  }
  for (const name of ['小美的电脑', 'MacBook-Pro', 'DESKTOP-7F2K', 'dsh-test']) {
    assert.equal(isAddressLike(name), false, name)
  }
})

test('机器名从 node.hello 的参数里取', () => {
  assert.equal(machineNameOf({ hostname: ' 小美的电脑 ' }), '小美的电脑')
  assert.equal(machineNameOf({ machine: 'DESKTOP-7F2K' }), 'DESKTOP-7F2K')
  assert.equal(machineNameOf({}), '')
  assert.equal(machineNameOf(undefined), '')
})

test('名字优先级：用户填的 > 电脑名 > 兜底', () => {
  assert.equal(pickNodeName({ reported: '手机', machine: '小美的电脑' }), '手机')
  assert.equal(pickNodeName({ reported: '', machine: '小美的电脑' }), '小美的电脑')
  assert.equal(pickNodeName({ reported: '127.0.0.1', machine: '小美的电脑' }), '小美的电脑')
  assert.equal(pickNodeName({ reported: '127.0.0.1', machine: '' }), '127.0.0.1')
  assert.equal(pickNodeName({ reported: '', machine: '' }), 'remote')
  assert.equal(pickNodeName({ reported: 'remote', machine: 'MacBook-Pro' }), 'MacBook-Pro')
})

test('老记录只把地址改成名字，不覆盖用户起的名', () => {
  assert.equal(shouldRename('127.0.0.1', '小美的电脑'), true)
  assert.equal(shouldRename('remote', '小美的电脑'), true)
  assert.equal(shouldRename('手机', '小美的电脑'), false)
  assert.equal(shouldRename('小美的电脑', '小美的电脑'), false)
  assert.equal(shouldRename('127.0.0.1', ''), false)
})
