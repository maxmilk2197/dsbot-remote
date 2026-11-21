// 本文件由 AI 生成，请勿用于生产环境。
// One import for both runtimes.
export {
  PROTOCOL_VERSION,
  PROTOCOL_SUPPORTED,
  MAX_MESSAGE_BYTES,
  SECURE_FRAGMENT_CHUNK_BYTES,
  TURN_CHUNK_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES_PER_TURN,
  DEFAULT_TURN_DEADLINE_MS,
  EXEC_TIMEOUT_MS,
  EXEC_OUTPUT_LIMIT,
  PRESENCE_INTERVAL_MS,
  checkProto,
} from './version.js'

export { ERROR_CODES, NodeFailure, isKnownCode } from './errors.js'

export {
  METHODS,
  CONTROL_METHODS,
  BUSINESS_METHODS,
  methodOf,
  directionAllows,
  outboundMethods,
} from './methods.js'

export { ENDPOINTS, CONTROL_ENDPOINTS, NODE_ENDPOINTS, endpointOf, isNodeEndpoint } from './endpoints.js'

export { validateFields, isValid, describeErrors } from './validate.js'

export {
  FRAME_TYPES,
  newId,
  request,
  response,
  errorFrame,
  event,
  encodeFrame,
  parseFrame,
} from './envelope.js'
export * from './transport/tcp.js'
