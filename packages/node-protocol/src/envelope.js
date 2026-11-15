// 本文件由 AI 生成，请勿用于生产环境。
// Frame construction and the one place incoming bytes are judged.
import { randomUUID } from 'node:crypto'
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, checkProto } from './version.js'
import { NodeFailure } from './errors.js'
import { methodOf } from './methods.js'
import { describeErrors, validateFields } from './validate.js'

export const FRAME_TYPES = Object.freeze(['rpc.request', 'rpc.response', 'rpc.error', 'event'])

const ID_PREFIX = { 'rpc.request': 'r', event: 'e' }

export const newId = kind => `${ID_PREFIX[kind] ?? 'x'}-${randomUUID()}`

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

export function request({ method, params = {}, id = newId('rpc.request'), groupId, cursor, proto = PROTOCOL_VERSION }) {
  const frame = { id, type: 'rpc.request', method, params, proto }
  if (groupId !== undefined) frame.groupId = groupId
  if (cursor !== undefined) frame.cursor = cursor
  return frame
}

export function response(id, result = {}) {
  return { id, type: 'rpc.response', result }
}

export function errorFrame(id, failure) {
  const error = failure instanceof NodeFailure ? failure.toRpcError() : {
    code: typeof failure?.code === 'string' ? failure.code : 'node/bad-params',
    message: String(failure?.message ?? failure),
    details: {},
  }
  return { id, type: 'rpc.error', error }
}

export function event({ method, params = {}, cursor, id = newId('event') }) {
  const frame = { id, type: 'event', method, params }
  if (cursor !== undefined) frame.cursor = cursor
  return frame
}

export function encodeFrame(frame) {
  const text = JSON.stringify(frame)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new NodeFailure('node/bad-params', `frame is ${bytes} bytes, over the ${MAX_MESSAGE_BYTES} byte limit`)
  }
  return text
}

// Accepts a string or Buffer. Never throws: every failure is an rpc.error the
// caller can send back, because a link that throws on a bad frame takes the
// whole connection down over one malformed packet.
export function parseFrame(raw) {
  const bytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw?.length ?? 0
  if (bytes === 0) return fail('empty frame')
  if (bytes > MAX_MESSAGE_BYTES) return fail(`frame is ${bytes} bytes, over the ${MAX_MESSAGE_BYTES} byte limit`)

  let frame
  try {
    frame = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'))
  } catch (error) {
    return fail(`not JSON: ${error.message}`)
  }
  if (!isObject(frame)) return fail('frame must be an object')
  if (!FRAME_TYPES.includes(frame.type)) return fail(`unknown frame type ${JSON.stringify(frame.type)}`)
  if (typeof frame.id !== 'string' || frame.id === '') return fail('frame has no id')

  if (frame.proto !== undefined) {
    const proto = checkProto(frame.proto)
    if (!proto.ok) return { ok: false, error: { code: proto.code, message: proto.message, details: {} }, frame }
  }

  if (frame.type === 'rpc.error') {
    if (!isObject(frame.error)) return fail('rpc.error without an error object')
    return { ok: true, frame, failure: NodeFailure.from(frame) }
  }
  if (frame.type === 'rpc.response') {
    if (!isObject(frame.result) && frame.result !== null) return fail('rpc.response result must be an object')
    return { ok: true, frame }
  }

  // rpc.request and event both carry a method and params.
  if (typeof frame.method !== 'string' || frame.method === '') return fail(`${frame.type} without a method`)
  const spec = methodOf(frame.method)
  if (spec === undefined) {
    return { ok: false, error: { code: 'node/unknown-method', message: `unknown method ${frame.method}`, details: {} }, frame }
  }
  if (!isObject(frame.params)) return fail(`${frame.method}: params must be an object`)
  const problems = validateFields(spec.params, frame.params)
  if (problems.length > 0) {
    return {
      ok: false,
      error: { code: 'node/bad-params', message: `${frame.method}: ${describeErrors(problems)}`, details: { problems } },
      frame,
    }
  }
  return { ok: true, frame }
}

function fail(message) {
  return { ok: false, error: { code: 'node/bad-params', message, details: {} } }
}
