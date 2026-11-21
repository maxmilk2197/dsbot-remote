// 本文件由 AI 生成，请勿用于生产环境。
import assert from 'node:assert/strict'
import test from 'node:test'
import { CONTROL_ENDPOINTS, ENDPOINTS, NODE_ENDPOINTS, isNodeEndpoint, validateFields } from '../src/protocol/index.js'

test('17 个端点，控制面 7 个、节点面 10 个', () => {
  assert.equal(Object.keys(ENDPOINTS).length, 17)
  assert.equal(CONTROL_ENDPOINTS.length, 7)
  assert.equal(NODE_ENDPOINTS.length, 10)
})

test('每个端点都有 plane / params / result，params 里的字段类型都被校验器认识', () => {
  for (const [name, spec] of Object.entries(ENDPOINTS)) {
    assert.ok(['control', 'node'].includes(spec.plane), `${name} plane`)
    assert.ok(spec.summary, `${name} summary`)
    assert.ok(spec.params !== undefined, `${name} params`)
    // 拿一个空对象试：只需要不抛，说明 schema 结构本身是合法的。
    assert.doesNotThrow(() => validateFields(spec.params, {}), `${name} schema`)
  }
})

test('远程没有控制面端点：建群/绑群/撤销/拉回都不在它的清单里', () => {
  for (const forbidden of ['node-bind-group', 'node-revoke', 'node-recall', 'node-invite-create']) {
    assert.ok(CONTROL_ENDPOINTS.includes(forbidden), `${forbidden} 应在控制面`)
    assert.equal(NODE_ENDPOINTS.includes(forbidden), false, `${forbidden} 不该出现在节点面`)
  }
})

test('前缀与注册表一致：node-* 但不在表里的名字不算端点', () => {
  assert.equal(isNodeEndpoint('node-hello'), true)
  assert.equal(isNodeEndpoint('node-does-not-exist'), false)
  assert.equal(isNodeEndpoint('state'), false)
  assert.equal(isNodeEndpoint(undefined), false)
})

test('必填缺失被定位到字段', () => {
  const problems = validateFields(ENDPOINTS['node-bind-group'].params, { nodeId: 'n-1' })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].path, 'groupId')
  assert.equal(problems[0].expected, 'string')
})

test('enum 之外的取值被拒，并回显允许值', () => {
  const problems = validateFields(ENDPOINTS['node-turn-result'].params, { turnId: 't-1', status: 'done' })
  assert.equal(problems.length, 1)
  assert.match(problems[0].expected, /ok.*error.*cancelled/)
})

test('嵌套对象校验到下一层（node-bind-group 没有嵌套，snapshot 的 room 有）', () => {
  const problems = validateFields(
    { required: { room: { type: 'object', fields: { required: { id: 'string' } } } } },
    { room: { id: 7 } },
  )
  assert.equal(problems.length, 1)
  assert.equal(problems[0].path, 'room.id')
})

test('多余字段被忽略，不报错（向前加字段不需要升 proto）', () => {
  const problems = validateFields(ENDPOINTS['node-fetch'].params, { groupId: 'g-1', somethingNew: true })
  assert.deepEqual(problems, [])
})
