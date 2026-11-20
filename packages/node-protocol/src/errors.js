// 本文件由 AI 生成，请勿用于生产环境。
// Every failure the protocol can report, with what the receiving side should do
// about it. `terminal` means the connection is not worth keeping.
export const ERROR_CODES = Object.freeze({
  'node/proto-mismatch': { message: '协议版本不匹配', retry: false, terminal: true },
  'node/bad-code': { message: '配对码错误或已过期', retry: false, terminal: false },
  'node/unknown-node': { message: '该节点的 token 已失效', retry: false, terminal: true },
  'node/superseded': { message: '该节点在别处重新连接了', retry: false, terminal: true },
  'node/offline': { message: '节点不在线', retry: false, terminal: false },
  'node/timeout': { message: '节点未在期限内响应', retry: true, terminal: false },
  'node/exec-denied': { message: '动作不在白名单或审批被拒', retry: false, terminal: false },
  'node/exec-failed': { message: '动作执行失败', retry: false, terminal: false },
  'node/exec-overflow': { message: '输出过长，已截断', retry: false, terminal: false },
  'node/file-too-big': { message: '文件超过单次上限', retry: false, terminal: false },
  'node/group-not-bound': { message: '该群未绑定此节点', retry: false, terminal: false },
  'node/read-only': { message: '群处于只读状态', retry: false, terminal: false },
  'node/unknown-method': { message: '未知方法', retry: false, terminal: false },
  'node/bad-params': { message: '参数不合法', retry: false, terminal: false },
  'node/cancelled': { message: '本轮已被取消', retry: false, terminal: false },
  // 下面这些是收发两端实际在用的码，之前只在代码里出现、不在表里：
  // 客户端拿 isKnownCode() 判就会当成"未知错误"直接放弃。
  'node/unsupported': { message: '这台机器还不支持这个操作', retry: false, terminal: false },
  'node/invalid-params': { message: '参数形状不对', retry: false, terminal: false },
  'node/denied': { message: '主机没有授权这个操作', retry: false, terminal: false },
  'node/not-bound': { message: '这台机器还没进任何群', retry: false, terminal: false },
  'node/not-found': { message: '找不到这台机器或这个群', retry: false, terminal: false },
  'node/starting': { message: '主机还在启动，稍等一下', retry: true, terminal: false },
  'node/agent-failed': { message: '本机 agent 跑挂了', retry: true, terminal: false },
  'node/hello-timeout': { message: '对面连上了但没报身份', retry: true, terminal: true },
})

export class NodeFailure extends Error {
  constructor(code, message, details = {}) {
    const known = ERROR_CODES[code]
    super(message ?? known?.message ?? code)
    this.name = 'NodeFailure'
    this.code = code
    this.details = details
    this.retry = known?.retry ?? false
    this.terminal = known?.terminal ?? false
  }

  // The `error` member of an rpc.error frame.
  toRpcError() {
    return { code: this.code, message: this.message, details: this.details }
  }

  static from(frame) {
    const error = frame?.error ?? {}
    return new NodeFailure(
      typeof error.code === 'string' ? error.code : 'node/bad-params',
      typeof error.message === 'string' ? error.message : undefined,
      error.details && typeof error.details === 'object' ? error.details : {},
    )
  }
}

export const isKnownCode = code => Object.hasOwn(ERROR_CODES, code)
