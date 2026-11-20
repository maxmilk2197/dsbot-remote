// 本文件由 AI 生成，请勿用于生产环境。
// 局域网广播默认关：办公/园区这类不可信局域网里，它会把"这里有台主机"告诉整张网。
import assert from 'node:assert/strict'
import test from 'node:test'
import { discoveryEnabled } from '../src/transport/discovery.js'

test('局域网广播默认关，要显式打开', () => {
  const before = process.env.DSBOT_NODES_LAN_DISCOVERY
  try {
    delete process.env.DSBOT_NODES_LAN_DISCOVERY
    assert.equal(discoveryEnabled(), false)
    assert.equal(discoveryEnabled({ lan: true }), true)
    process.env.DSBOT_NODES_LAN_DISCOVERY = '1'
    assert.equal(discoveryEnabled(), true)
  } finally {
    if (before === undefined) delete process.env.DSBOT_NODES_LAN_DISCOVERY
    else process.env.DSBOT_NODES_LAN_DISCOVERY = before
  }
})
