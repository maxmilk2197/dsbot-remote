# Node Protocol v1

> 线上协议规范。实现只有一份：`packages/dsbot-nodes/src/protocol/`（主机插件与远程 CLI 都用它），不手写常量。

---

## 1. 分层

```
┌ 传输层 ──────────────────────────────────────────────┐
│ WebSocket → relay.dsbot.app /v1/link（复用 ds-bot link.js）│
│ 控制帧：hello / hello.ack / connect.request / …        │
│ 安全：secure.handshake（端到端），48KB 分片，4MB 上限     │
├ 应用层 ──────────────────────────────────────────────┤
│ 4 种消息：rpc.request / rpc.response / rpc.error / event │
│ 端点：/api/bot 上的 node-*（主机 fork 出的分支）          │
└──────────────────────────────────────────────────────┘
```

节点是 link 上的一台**新设备**，设备记录新增 `role: 'node'`（`phone.json` 里既有 `role: 'phone'` 形状）。

## 2. 信封

### 2.1 请求（node / host 任一方向）

```jsonc
{
  "id": "r-8f3a…",            // 发起方生成，响应必须原样带回
  "type": "rpc.request",
  "method": "node.hello",     // 见 §3 / §4
  "params": { },
  "proto": 1,                 // PROTOCOL_VERSION，不匹配立即 node.error/proto-mismatch
  "groupId": "g-…",           // 可选，群作用域方法必带
  "cursor": 42                // 可选，续传点（该 groupId 的 seq）
}
```

### 2.2 成功响应

```jsonc
{ "id": "r-8f3a…", "type": "rpc.response", "result": { } }
```

### 2.3 错误响应

```jsonc
{ "id": "r-8f3a…", "type": "rpc.error",
  "error": { "code": "node/exec-denied", "message": "…", "details": { } } }
```

### 2.4 事件（无 id、不期待响应，单向推送）

```jsonc
{ "id": "e-11c9…", "type": "event", "method": "node.turn.delta",
  "params": { "turnId": "t-…", "text": "先说" }, "cursor": 43 }
```

> **id 与送达**：`rpc.*` 由发起方等在途表里，超时即 `node/timeout`；`event` 丢了靠 `cursor` 重放，不重发。

## 3. 事件族（10 类，对应 R3 的决定）

| # | method | 方向 | 语义 |
| --- | --- | --- | --- |
| 1 | `node.hello` | node→host | 上线握手：`{nodeName, botId, botName, avatar, caps[], proto}` |
| 2 | `node.presence` | node→host | `{state: online\|busy\|offline, since}` |
| 3 | `group.snapshot` | host→node | 入群时全量：`{room:{id,name,adminId,members[]}, lines[], cursor}` |
| 4 | `group.line` | host→node | 增量：`{lines[], cursor}`（只有 `allowRemoteMember` 打开时发） |
| 5 | `turn.request` | host→node | `{turnId, prompt, tools[], cwd, deadlineMs, attachments[]}`。`tools` 是**追加**，不是全集：远程把它并进自己的工具集，自己那套（ops_bash、mcp、任意插件给的）一条不少 |
| 6 | `turn.event` | node→host | `{turnId, kind:'delta'\|'tool-call'\|'tool-result'\|'file', …}` |
| 7 | `turn.result` | node→host | `{turnId, status:'ok'\|'error'\|'cancelled', text, files[], usage}` |
| 8 | `node.post` | node→host | 主动插话：`{groupId, text, replyTo?}` → 主机分 `seq` 后落群 |
| 9 | `node.exec` | host→node | admin 下发：`{execId, action, args, approvalId}` |
| 10 | `node.approval` | 双向 | 主机要批：`{approvalId, action, detail}`；远程裁决回 `{allow}` |

## 4. 端点（`/api/bot` 上新增的 `node-*`）

`handle()` 里 `endpoint.startsWith('node-')` 早返回，不进原 switch。

### 4.1 控制面（Settings → Remote Nodes 用）

| endpoint | 入参 | 出参 |
| --- | --- | --- |
| `node-list` | — | `{nodes:[{nodeId,name,state,boundGroups,botId,lastSeen}]}` |
| `node-invite-create` | `{ttlMs?}` | `{code:'482913', expiresAt}` — 6 位数字，默认 5 分钟 |
| `node-revoke` | `{nodeId}` | `{ok}` — 撤销 token，断开连接 |
| `node-bind-group` | `{nodeId, groupId, botName?}` | `{ok, botId}` — 建代理 Bot、`model='node:<nodeId>'`、插进 `room.members` |
| `node-unbind` | `{nodeId, groupId}` | `{ok}` — 移出群，bot 记录保留（可重新绑） |
| `node-recall` | `{botId, model}` | `{ok}` — 强制拉回：把该 bot 的 model 换回本地模型 |
| `node-audit` | `{nodeId, since?, limit?}` | `{entries[]}` — 读 `ledger/` 里 `node.*` |

### 4.2 节点面（远程调用；远程不知道主机 UI）

| endpoint | 入参 | 出参 |
| --- | --- | --- |
| `node-hello` | `{proto, nodeName, botId, botName, avatar, caps}` | `{hostName, nodeId, proto}` |
| `node-fetch` | `{groupId, cursor?, limit?}` | `{lines[], cursor}` — 拉群镜像（D4 只读） |
| `node-post` | `{groupId, text, replyTo?, clientMsgId}` | `{seq, at}` — 幂等：同 `clientMsgId` 返回同一个 `seq` |
| `turn.result` | `{turnId, status, text, files[], usage}` | — |
| `node-turn-event` | `{turnId, kind, …}` | `{ok}` — 流式片段，主机即时转 chunk |
| `node-tool-call` | `{turnId, name, args, callId}` | `{result}` — 主机执行 team tool 后回值 |
| `node-file-push` | `{groupId, name, size, sha256, chunks:[b64]}` | `{path}` — 落 `outbox/`，返回绝对路径 |
| `node-approval-decision` | `{approvalId, allow}` | `{ok}` |
| `node-presence` | `{state}` | `{ok}` |
| `node-log` | `{level, text}` | `{ok}` — 进 ledger，便于事故回溯 |

> 远程**没有** `node-create-group`、`node-add-member`、`node-recall`、`node-exec-request` —— 需要主机审批的动作只能等主机下发（D5/D8）。

## 5. 认证与配对

```
主机：node-invite-create → code(6位) + 5min TTL，存 state.pendingCodes[]
远程：dsbot-remote pair 482913 --server wss://relay.dsbot.app/v1/link
      → connect.request{role:'node', code}  → 主机校验码
      → secure.handshake（X25519 + 对称密钥，link.js 现成）
      → 主机发 nodeId + 长期 token（存 phone.json devices[]，role:'node'）
      → 码作废；之后每次 hello 用 token，不再要码
```

- token 绑定 `nodeId` + 远程公钥；主机 `node-revoke` 删记录即可失效。
- 同一 `nodeId` 重复连接：踢旧留新，旧的收到 `error{code:'node/superseded'}`。
- `caps` 用于能力协商，实测值 `['exec','push_file','agent']`；缺 `agent` 的节点收到 `turn.request` 只会回 `node/unsupported`，不会假装在跑。

## 6. 游标与断线

- `cursor` = 该 `groupId` 上最后一条已收到的 `seq`。
- 主机侧每群维护 `seq`（既有 `groups.js` 分配），`node-fetch` 与 `group.line` 都带 `cursor`。
- 断线重连：`node-hello` 带 `{cursors:{groupId:seq}}`，主机补发差量；**不重发 turn**。
- turn 在途断线：主机保留 `turnId` 直到 `deadlineMs`（默认 30 分钟）；远程重连后可用 `node-turn-result` 补交；超时主机写 `kind:'failed'` 行（重试 1 次后，见 D10）。

## 7. 错误码

| code | 含义 | 处置 |
| --- | --- | --- |
| `node/proto-mismatch` | proto ≠ 1 | 断开，日志提示升级 |
| `node/bad-code` | 配对码错/过期 | 提示重出码 |
| `node/unknown-node` | token 的 nodeId 不存在 | 断开，要求重新配对 |
| `node/superseded` | 同 nodeId 新连接顶掉旧的 | 旧的断开 |
| `node/offline` | 目标节点不在线 | 群成员标离线，@ 时回执 |
| `node/timeout` | rpc 超时（turn 除外） | 重试 1 次 |
| `node/exec-denied` | 动作不在白名单 / 审批被拒 | 回群里一行说明 |
| `node/exec-overflow` | 输出 > 64KB | 截断 + 提示读完整文件 |
| `node/file-too-big` | > 4MB 或 > 100 文件 | 拒绝并回执 |
| `node/group-not-bound` | 该群没绑这个节点 | 丢掉消息，日志 |
| `node/read-only` | 群被设为只读 | 拒绝 `node-post` |

## 8. 兼容策略

- `proto` 只在**加字段**时不动；删字段/改语义才升到 2，且主机同时接受 1 和 2 一个版本周期。
- 未知 `method` 一律 `rpc.error{node/unknown-method}`，不静默丢。
- `src/protocol/index.js` 导出：`PROTOCOL_VERSION`、`METHODS`、`ENDPOINTS`、`ERROR_CODES`、`parseFrame()`、`encodeFrame()`、`validate(method, params)`。

## 附件：远端文件进群的唯一路径

`turn.result.files[]` 是**对象**数组，不是路径字符串：

```json
{ "name": "报告.txt", "size": 41, "data": "<base64>" }
```

单帧上限 4MB，base64 膨胀 1/3 —— 实际能吃下约 **3MB** 的源文件。更大的文件不进这条路，改用 `node.exec` 的 `push_file` 直接写，或让远端把文件切小。

**远端怎么知道带哪个**：模型输出里**单独一行**写

```
@@attach D:/work/报告.txt
```

远端扫这几行、读文件、base64 附上，正文里那行原样保留（主机不改写模型说的话）。不扫目录、不猜"这一轮改了什么"——那两条都会把构建产物和临时文件一并带进群。

**主机收到后**：落盘到 `<home>/outbox/<nodeId>/<名字>`（流式 sha256、`.part` + rename 原子写、重名加序号、剥路径段与 Windows 设备名），然后把 `[名字](绝对路径)` 拼成**这一轮的最后一段文本**发出去。

为什么不另发一条消息：`groups.js` 的一个 round 只认一条 turn 的输出，另起一条会打乱发言顺序与 @ 的解析。链接必须落在同一行流里。
