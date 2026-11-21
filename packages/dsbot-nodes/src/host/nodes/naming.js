// 本文件由 AI 生成，请勿用于生产环境。
// "这台机器叫什么"：一台远程机器在设置页和群里显示的名字。
//
// 以前这条路会漏成 IP：加入端没填名字时退到 found.host，于是群里站着
// 一个叫 127.0.0.1 的成员，没人想 @ 一个 IP。现在两段兜底：
//   1) 节点自己报的 hostname（node.hello 里带上）—— 对方的电脑名；
//   2) 实在没有才退到 deviceId，最后才是 remote。
// 用户显式填了名字就永远用他的。

// 看着像地址的名字：IPv4、带冒号的 IPv6、带协议头的 URL、内部转发名、设备指纹。
const ADDRESSY = [
  /^(?:\d{1,3}\.){3}\d{1,3}$/,
  /^\[?[0-9a-fA-F]*:[0-9a-fA-F:]+\]?$/,
  /^tcp:\/\//i,
  /^虚拟网/,
  /^d-[0-9a-f]{6,}$/i,
]

export function isAddressLike(name) {
  const text = String(name ?? '').trim()
  if (text === '' || text === 'remote') return true
  return ADDRESSY.some(pattern => pattern.test(text))
}

/** node.hello 里带过来的机器名（老版本节点没这个字段）。 */
export function machineNameOf(params) {
  const raw = params?.hostname ?? params?.machine ?? ''
  return String(raw ?? '').trim().slice(0, 64)
}

/**
 * 记录里该写什么名字。
 * 顺序：用户填的名字 → 对方的电脑名 → 用户填的（哪怕像地址）→ remote。
 */
export function pickNodeName({ reported, machine } = {}) {
  const said = String(reported ?? '').trim().slice(0, 64)
  const box = String(machine ?? '').trim().slice(0, 64)
  if (said !== '' && !isAddressLike(said)) return said
  if (box !== '' && !isAddressLike(box)) return box
  if (said !== '') return said
  return 'remote'
}

/** 老记录（名字还是 127.0.0.1 / remote）要不要按新报上来的名字改。 */
export function shouldRename(current, next) {
  const now = String(current ?? '').trim()
  const wanted = String(next ?? '').trim()
  if (wanted === '' || wanted === now) return false
  return isAddressLike(now) && !isAddressLike(wanted)
}
