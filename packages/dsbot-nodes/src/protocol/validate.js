// 本文件由 AI 生成，请勿用于生产环境。
// A deliberately small schema checker. The protocol has ~30 methods with flat
// parameter objects; pulling in a schema library for that would mean shipping
// a dependency to two runtimes that must agree byte for byte.
//
// A type is one of: 'string' | 'number' | 'integer' | 'boolean' | 'object' |
// 'array' | 'array<string>' | 'array<number>' | 'any', or an object
// { type, enum?, fields? } for enums and one level of nesting.
//
// A spec is { required?: {...}, optional?: {...} }.

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function matches(type, value) {
  if (type === 'any') return true
  if (typeof type === 'object' && type !== null) return matches(type.type ?? 'any', value)
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'object': return isPlainObject(value)
    case 'array': return Array.isArray(value)
    case 'array<string>': return Array.isArray(value) && value.every(entry => typeof entry === 'string')
    case 'array<number>': return Array.isArray(value) && value.every(entry => typeof entry === 'number' && Number.isFinite(entry))
    default: return false
  }
}

function nameOf(type) {
  if (typeof type === 'object' && type !== null) {
    if (Array.isArray(type.enum)) return type.enum.map(entry => JSON.stringify(entry)).join('|')
    return nameOf(type.type ?? 'any')
  }
  return String(type)
}

// Returns a list of { path, expected, got }. An empty list is a valid payload.
export function validateFields(spec, value, path = '') {
  const errors = []
  if (!isPlainObject(spec)) return errors
  if (!isPlainObject(value)) {
    if (value === undefined && !spec.required) return errors
    return [{ path: path === '' ? '$' : path, expected: 'object', got: typeOf(value) }]
  }
  const where = field => (path === '' ? field : `${path}.${field}`)
  for (const [field, type] of Object.entries(spec.required ?? {})) {
    if (value[field] === undefined) {
      errors.push({ path: where(field), expected: nameOf(type), got: 'undefined' })
      continue
    }
    errors.push(...checkField(type, value[field], where(field)))
  }
  for (const [field, type] of Object.entries(spec.optional ?? {})) {
    if (value[field] === undefined) continue
    errors.push(...checkField(type, value[field], where(field)))
  }
  return errors
}

function checkField(type, value, path) {
  const errors = []
  if (!matches(type, value)) {
    errors.push({ path, expected: nameOf(type), got: typeOf(value) })
    return errors
  }
  if (typeof type === 'object' && type !== null) {
    if (Array.isArray(type.enum) && !type.enum.includes(value)) {
      errors.push({ path, expected: nameOf(type), got: JSON.stringify(value) })
    }
    if (type.fields !== undefined) {
      errors.push(...validateFields(type.fields, value, path))
    }
  }
  return errors
}

export const isValid = (spec, value) => validateFields(spec, value).length === 0

// The message a `node/bad-params` error carries: the first problem in words,
// plus how many more there were. The full list rides in details.problems.
export function describeErrors(errors) {
  const [first] = errors
  if (first === undefined) return '参数不合法'
  const head = `${first.path} 期望 ${first.expected}，收到 ${first.got}`
  const more = errors.length - 1
  return more === 0 ? head : `${head}（另有 ${more} 处不合法）`
}
