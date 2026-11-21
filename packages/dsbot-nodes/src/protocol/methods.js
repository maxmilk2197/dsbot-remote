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
    summary: '上线握手：带上身份、能力、工作区、每个群的续传点',
    params: {
      required: { proto: 'integer', nodeName: 'string', botId: 'string', botName: 'string' },
      optional: {
        avatar: 'string',
        caps: 'array<string>',
        cursors: 'object',
        // 这台机器选定的主文件夹（绝对路径）。主机靠它知道"它的工作区在哪"，
        // 也让主机的设置页能直接浏览这台机器的文件。
        workspace: 'string',
        // 只问不连：主机回一份主机名 + 全部群就散伙，不建记录、不登记在线。
        probe: 'boolean',
      },
    },
    result: {
      required: { nodeId: 'string', hostName: 'string', proto: 'integer' },
      // groups 是"它自己已经进了的群"；available 是"主机上有哪些群可以进"。
      // 加入端靠 available 弹那个选群组的框。
      optional: { groups: 'array', available: 'array', hostId: 'string' },
    },
  },

  'node.presence': {
    family: true,
    direction: 'node→host',
    call: false,
    summary: '在线状态心跳（15s 一次），断线前最后一次是 offline',
    params: {
      required: { state: { type: 'string', enum: ['online', 'busy', 'offline'] } },
      // workspace 跟心跳一起报：加入端换了主文件夹，主机这边下一次心跳就知道，
      // 不用重连。
      optional: { since: 'number', workspace: 'string' },
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
      // hostId：两台主机可能有同名群，远端靠它给镜像群定身份。
      optional: { hostId: 'string' },
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
      optional: { hostId: 'string', roomId: 'string', roomName: 'string', room: 'object' },
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
      optional: { text: 'string', files: 'array', usage: 'object', error: 'string', message: 'string' },
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
  // 加入端在弹窗里选好群之后申请进群。它是控制流而非那十个业务事件之一：
  // 本身不发言、不同步聊天，只是让主机替它建成员。
  'node.wants': {
    direction: 'node→host',
    call: true,
    summary: '加入端申请进群：按主机给的群列表逐个建成员',
    params: {
      required: { groups: 'array<string>' },
      optional: {},
    },
    result: {
      required: { ok: 'boolean' },
      // bound 是已经进成功的群；refused 是主机拒了的（不存在 / 没权限），
      // 加入端据此在弹窗里标出来，而不是静默"选了但没进去"。
      optional: { bound: 'array', refused: 'array' },
    },
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
