// 本文件由 AI 生成，请勿用于生产环境。
// Wire constants. One place, because a mismatch here shows up as a silent
// hang three layers away: the link dropped a frame it could not parse.
export const PROTOCOL_VERSION = 1
// Versions this build still speaks. Bumping PROTOCOL_VERSION means a field was
// removed or a meaning changed; adding a field does not.
export const PROTOCOL_SUPPORTED = Object.freeze([1])

// The relay's own limits (link.js). Restated here so a payload is checked
// before it is fragmented into 48KB pieces that would never reassemble.
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024
export const SECURE_FRAGMENT_CHUNK_BYTES = 48 * 1024
// A text/file chunk from a node is smaller than the fragment size on purpose:
// one chunk stays one fragment, so a slow turn does not hold 48KB buffers.
export const TURN_CHUNK_BYTES = 16 * 1024
export const MAX_FILE_BYTES = 4 * 1024 * 1024
export const MAX_FILES_PER_TURN = 100
export const DEFAULT_TURN_DEADLINE_MS = 30 * 60_000
export const EXEC_TIMEOUT_MS = 30_000
export const EXEC_OUTPUT_LIMIT = 64 * 1024
export const PRESENCE_INTERVAL_MS = 15_000

// A refused turn costs a whole model call, so the deadline is checked by the
// host and the node separately.
export function checkProto(value) {
  if (value === undefined) {
    return { ok: false, code: 'node/proto-mismatch', message: 'missing proto' }
  }
  if (!Number.isInteger(value)) {
    return { ok: false, code: 'node/proto-mismatch', message: `proto must be an integer, got ${typeof value}` }
  }
  if (!PROTOCOL_SUPPORTED.includes(value)) {
    return {
      ok: false,
      code: 'node/proto-mismatch',
      message: `proto ${value} is not supported; this build speaks ${PROTOCOL_SUPPORTED.join(', ')}`,
    }
  }
  return { ok: true, proto: value }
}
