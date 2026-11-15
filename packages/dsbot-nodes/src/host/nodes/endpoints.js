// 本文件由 AI 生成，请勿用于生产环境。
// One request in, one frame out. The dispatcher owns the rules that must hold
// for every method (known name, right direction, params that match the table);
// the handlers own the work. Keeping the rules here is what lets a handler stay
// a few lines and what keeps both runtimes honest.
//
// `receives` is the arrow this side sits on: the host side receives `node→host`,
// the node side receives `host→node`. Saying it as an arrow rather than a side
// name is deliberate — every method in the table is already declared that way.
import { errorFrame, response } from '@dsbot/node-protocol/envelope'
import { NodeFailure, isKnownCode } from '@dsbot/node-protocol/errors'
import { directionAllows, methodOf } from '@dsbot/node-protocol/methods'
import { describeErrors, validateFields } from '@dsbot/node-protocol/validate'

const deny = (code, message) => new NodeFailure(code, message)

// Anything a handler throws becomes a frame. A typed failure keeps its code; a
// bare error is an execution failure, and its stack stays on this machine.
function asFailure(error) {
  if (error instanceof NodeFailure) return error
  if (typeof error?.code === 'string' && isKnownCode(error.code)) {
    return new NodeFailure(error.code, error.message, error.details)
  }
  const message = String(error?.message ?? error ?? '未知错误')
  return new NodeFailure('node/exec-failed', message.slice(0, 400))
}

export function createDispatcher({ handlers, receives }) {
  return async function dispatch(frame) {
    if (frame?.type !== 'rpc.request') {
      return errorFrame(frame?.id, deny('node/bad-params', `只接 rpc.request，收到 ${frame?.type}`))
    }
    const id = frame.id
    const method = frame.method
    const spec = methodOf(method)

    if (spec === undefined) return errorFrame(id, deny('node/unknown-method', `未知方法 ${method}`))
    if (!directionAllows(method, receives)) {
      return errorFrame(id, deny('node/unknown-method', `${method} 不该由 ${receives} 这一侧接收`))
    }
    if (spec.params !== undefined) {
      const problems = validateFields(spec.params, frame.params ?? {})
      if (problems.length > 0) return errorFrame(id, deny('node/bad-params', describeErrors(problems)))
    }

    const handler = handlers[method]
    if (handler === undefined) {
      return errorFrame(id, deny('node/unknown-method', `${method} 在这台机器上没有实现`))
    }
    try {
      return response(id, (await handler(frame.params ?? {}, frame)) ?? {})
    } catch (error) {
      return errorFrame(id, asFailure(error))
    }
  }
}

// A one-way frame (`call: false`) has nobody waiting for its reply, so a failure
// becomes a warn line instead of a frame the peer will never read.
export function settleOneWay(dispatch, frame, warn = () => {}) {
  return dispatch(frame).then((answer) => {
    if (answer?.type === 'rpc.error') warn(`${frame.method}: ${answer.error.code} ${answer.error.message}`)
    return answer
  })
}
