// 本文件由 AI 生成，请勿用于生产环境。
// The method table. Two sides in two runtimes must agree on names, direction
// and payload shape; this file is that agreement.
//
// `family: true` marks the ten business events the design settled on
// (DESIGN.md D4, PROTOCOL.md §3). `turn.cancel` is control, not a family member.
//
// direction: 'node→host' | 'host→node' | 'both'
// call: true means the sender waits for rpc.response / rpc.error.

export const METHODS = Object.freeze({
  'node.hello': {
    family: true,
    direction: 'node→host',
    call: true,
    summary: '上线握手：带上身份、能力、每个群的续传点',
    params: {
      required: { proto: 'integer', nodeName: 'string', botId: 'string', botName: 'string' },
      optional: { avatar: 'string', caps: 'array<string>', cursors: 'object' },
    },
    result: {
      required: { nodeId: 'string', hostName: 'string', proto: 'integer' },
      optional: { groups: 'array' },
    },
  },

  'node.presence': {
    family: true,
    direction: 'node→host',
    call: false,
    summary: '在线状态心跳（15s 一次），断线前最后一次是 offline',
    params: {
      required: { state: { type: 'string', enum: ['online', 'busy', 'offline'] } },
      optional: { since: 'number' },
    },
    result: null,
  },

  'group.snapshot': {
    family: true,
    direction: 'host→node',
    call: true,
    summary: '入群时的全量镜像：成员表 + 最近的行 + 游标',
    params: {
      required: {
        room: {
          type: 'object',
          fields: { required: { id: 'string', name: 'string' }, optional: { adminId: 'string' } },
        },
        lines: 'array',
        cursor: 'integer',
      },
      optional: {},
    },
    result: { required: { ok: 'boolean' }, optional: {} },
  },

  'group.line': {
    family: true,
    direction: 'host→node',
    call: false,
    summary: '增量镜像。只有 allowRemoteMember 打开的群才会收到',
    params: {
      required: { lines: 'array', cursor: 'integer' },
      optional: {},
    },
    result: null,
  },

  'turn.request': {
    family: true,
    direction: 'host→node',
    call: true,
    summary: '主机拼好整段 prompt，交给远程跑一轮',
    params: {
      required: { turnId: 'string', prompt: 'string' },
      optional: {
        tools: 'array',
        cwd: 'string',
        deadlineMs: 'integer',
        attachments: 'array',
        model: 'string',
      },
    },
    // The turn's answer does not come back in the response: it streams as
    // turn.event and closes with turn.result. The response only confirms start.
    result: { required: { accepted: 'boolean' }, optional: {} },
  },

  'turn.event': {
    family: true,
    direction: 'node→host',
    call: false,
    summary: '流式片段：delta / tool-call / tool-result / file',
    params: {
      required: {
        turnId: 'string',
        kind: { type: 'string', enum: ['delta', 'tool-call', 'tool-result', 'file'] },
      },
      optional: {
        text: 'string',
        callId: 'string',
        name: 'string',
        args: 'object',
        result: 'any',
        path: 'string',
        files: 'array',
        usage: 'object',
      },
    },
    result: null,
  },

  'turn.result': {
    family: true,
    direction: 'node→host',
    call: true,
    summary: '一轮的终态：ok / error / cancelled，附带产物文件',
    params: {
      required: { turnId: 'string', status: { type: 'string', enum: ['ok', 'error', 'cancelled'] } },
      optional: { text: 'string', files: 'array', usage: 'object', error: 'string' },
    },
    result: { required: { ok: 'boolean' }, optional: {} },
  },

  'node.post': {
    family: true,
    direction: 'node→host',
    call: true,
    summary: '主动插话。主机分配 seq 后落群；clientMsgId 保证幂等',
    params: {
      required: { groupId: 'string', text: 'string' },
      optional: { replyTo: 'string', clientMsgId: 'string' },
    },
    result: { required: { seq: 'integer' }, optional: { at: 'number' } },
  },

  'node.exec': {
    family: true,
    direction: 'host→node',
    call: true,
    summary: 'admin 下发白名单动作，审批在前一步完成',
    params: {
      required: {
        execId: 'string',
        action: { type: 'string', enum: ['read_file', 'list_dir', 'run_shell', 'push_file', 'env_info'] },
        args: 'object',
      },
      optional: { approvalId: 'string' },
    },
    result: {
      required: { execId: 'string', ok: 'boolean' },
      optional: { output: 'string', truncated: 'boolean', files: 'array' },
    },
  },

  'node.approval': {
    family: true,
    direction: 'both',
    call: true,
    summary: '需要人批的动作：主机下发，远程回 allow',
    params: {
      required: { approvalId: 'string', action: 'string' },
      optional: { detail: 'object', allow: 'boolean' },
    },
    result: { required: { allow: 'boolean' }, optional: {} },
  },
})

// Control traffic that is not one of the ten business events.
export const CONTROL_METHODS = Object.freeze({
  'turn.cancel': {
    direction: 'host→node',
    call: false,
    summary: '取消在途的一轮（用户点了停止，或主机要拉回本地模型）',
    params: { required: { turnId: 'string' }, optional: { reason: 'string' } },
    result: null,
  },
})

export const BUSINESS_METHODS = Object.freeze(Object.keys(METHODS).filter(name => METHODS[name].family === true))

export function methodOf(name) {
  return METHODS[name] ?? CONTROL_METHODS[name]
}

export function directionAllows(name, direction) {
  const spec = methodOf(name)
  if (spec === undefined) return false
  return spec.direction === 'both' || spec.direction === direction
}

// Names the given side may send.
export function outboundMethods(direction) {
  return [...Object.keys(METHODS), ...Object.keys(CONTROL_METHODS)].filter(name => directionAllows(name, direction))
}
