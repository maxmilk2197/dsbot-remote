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
