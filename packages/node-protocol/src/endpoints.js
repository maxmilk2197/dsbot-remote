// 本文件由 AI 生成，请勿用于生产环境。
// The 17 `node-*` endpoints on POST /api/bot. Two planes share the prefix:
//
//   control — what Settings → Remote Nodes calls (a human is present).
//   node    — what the remote itself calls over the link (no human present).
//
// The remote has no control-plane endpoint on purpose (DESIGN.md D5): it cannot
// create a group, add a member, or bind itself.

const NODE_ID = 'string'
const GROUP_ID = 'string'

export const ENDPOINTS = Object.freeze({
  // --- control plane ------------------------------------------------------
  'node-list': {
    plane: 'control',
    summary: '节点列表与在线状态',
    params: { required: {}, optional: {} },
    result: { required: { nodes: 'array' }, optional: {} },
  },
  'node-invite-create': {
    plane: 'control',
    summary: '出一个 6 位一次性配对码（默认 5 分钟）',
    params: { required: {}, optional: { ttlMs: 'integer' } },
    result: { required: { code: 'string', expiresAt: 'number' }, optional: {} },
  },
  'node-revoke': {
    plane: 'control',
    summary: '撤销节点的 token 并断开',
    params: { required: { nodeId: NODE_ID }, optional: {} },
    result: { required: { ok: 'boolean' }, optional: {} },
  },
  'node-bind-group': {
    plane: 'control',
    summary: '建代理 Bot、设 model=node:<id>、插进群成员',
    params: { required: { nodeId: NODE_ID, groupId: GROUP_ID }, optional: { botName: 'string' } },
    result: { required: { ok: 'boolean', botId: 'string' }, optional: {} },
  },
  'node-unbind': {
    plane: 'control',
    summary: '把节点移出群，bot 记录保留',
    params: { required: { nodeId: NODE_ID, groupId: GROUP_ID }, optional: {} },
    result: { required: { ok: 'boolean' }, optional: {} },
  },
  'node-recall': {
    plane: 'control',
    summary: '强制拉回：把代理 Bot 的 model 换回本地模型',
    params: { required: { botId: 'string', model: 'string' }, optional: {} },
    result: { required: { ok: 'boolean' }, optional: {} },
  },
  'node-audit': {
    plane: 'control',
    summary: '读 node.* 审计记录',
    params: { required: {}, optional: { nodeId: NODE_ID, since: 'number', limit: 'integer' } },
    result: { required: { entries: 'array' }, optional: {} },
  },

  // --- node plane ---------------------------------------------------------
  'node-hello': {
    plane: 'node',
    summary: 'link 上的握手入口',
    params: {
      required: { proto: 'integer', nodeName: 'string', botId: 'string', botName: 'string' },
      optional: { avatar: 'string', caps: 'array<string>', cursors: 'object' },
    },
    result: { required: { nodeId: 'string', hostName: 'string', proto: 'integer' }, optional: { groups: 'array' } },
  },
  'node-fetch': {
    plane: 'node',
    summary: '拉群镜像（只读）',
    params: { required: { groupId: GROUP_ID }, optional: { cursor: 'integer', limit: 'integer' } },
    result: { required: { lines: 'array', cursor: 'integer' }, optional: {} },
  },
  'node-post': {
    plane: 'node',
    summary: '主动插话，主机分 seq',
    params: { required: { groupId: GROUP_ID, text: 'string' }, optional: { replyTo: 'string', clientMsgId: 'string' } },
    result: { required: { seq: 'integer' }, optional: { at: 'number' } },
  },
  'node-turn-result': {
    plane: 'node',
    summary: '一轮的终态回执',
    params: {
      required: { turnId: 'string', status: { type: 'string', enum: ['ok', 'error', 'cancelled'] } },
      optional: { text: 'string', files: 'array', usage: 'object', error: 'string' },
    },
    result: { required: { ok: 'boolean' }, optional: {} },
  },
  'node-turn-event': {
    plane: 'node',
    summary: '流式片段（delta / tool-call / tool-result / file）',
    params: {
      required: { turnId: 'string', kind: { type: 'string', enum: ['delta', 'tool-call', 'tool-result', 'file'] } },
      optional: { text: 'string', callId: 'string', name: 'string', args: 'object', result: 'any', path: 'string', files: 'array' },
    },
    result: { required: { ok: 'boolean' }, optional: {} },
  },
  'node-tool-call': {
    plane: 'node',
    summary: '请主机执行一个下行 team tool（同步等结果）',
    params: {
      required: { turnId: 'string', name: 'string', callId: 'string' },
      optional: { args: 'object' },
    },
    result: { required: {}, optional: { result: 'any', isError: 'boolean' } },
  },
  'node-file-push': {
    plane: 'node',
    summary: '分片上传到主机 outbox，返回绝对路径',
    params: {
      required: { groupId: GROUP_ID, name: 'string', size: 'integer', sha256: 'string' },
      optional: { chunks: 'array<string>', final: 'boolean', transferId: 'string' },
    },
    result: { required: { path: 'string' }, optional: { complete: 'boolean' } },
  },
  'node-approval-decision': {
    plane: 'node',
    summary: '远程对审批的裁决',
    params: { required: { approvalId: 'string', allow: 'boolean' }, optional: {} },
    result: { required: { ok: 'boolean' }, optional: {} },
  },
  'node-presence': {
    plane: 'node',
    summary: '在线状态心跳',
    params: { required: { state: { type: 'string', enum: ['online', 'busy', 'offline'] } }, optional: { since: 'number' } },
    result: { required: { ok: 'boolean' }, optional: {} },
  },
  'node-log': {
    plane: 'node',
    summary: '写一条 node.* 审计（事故回溯用）',
    params: { required: { level: { type: 'string', enum: ['info', 'warn', 'error'] }, text: 'string' }, optional: {} },
    result: { required: { ok: 'boolean' }, optional: {} },
  },
})

export const CONTROL_ENDPOINTS = Object.freeze(Object.keys(ENDPOINTS).filter(name => ENDPOINTS[name].plane === 'control'))
export const NODE_ENDPOINTS = Object.freeze(Object.keys(ENDPOINTS).filter(name => ENDPOINTS[name].plane === 'node'))

export const endpointOf = name => ENDPOINTS[name]

export function isNodeEndpoint(name) {
  return typeof name === 'string' && name.startsWith('node-') && Object.hasOwn(ENDPOINTS, name)
}
