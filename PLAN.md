# 实施计划

> 审这份时重点看两处：**§2 的三个改动点**（决定 fork 成本）与 **§6 的五步验收**（决定"做完"的定义）。

---

## 1. 仓库布局

```
dsbot-remote/                     （工作目录，设计文档所在）
├ DESIGN.md  PROTOCOL.md  PLAN.md
├ packages/
│  ├ node-protocol/               @dsbot/node-protocol  线协议单一事实源
│  │  ├ src/{version,methods,endpoints,errors,envelope,validate}.ts
│  │  └ test/{envelope,validate}.test.ts
│  ├ dsbot-nodes/                 主机侧（最终合进 ds-bot fork）
│  │  └ src/host/nodes/{index,store,invite,adapter,members,files,audit,endpoints}.js
│  └ dsbot-remote/                远程侧 DSH 插件（role=node）
│     ├ src/{index,link,agent,exec,files,presence,config}.js
│     └ bin/dsbot-remote.js       pair / status / revoke 子命令
└ UPSTREAM.md                     ds-bot 基版 0.3.6 + 三处改动 diff 记录
```

## 2. 主机 fork：只改三处

### 2.1 `ds-bot/index.js`
```js
// :63  MODULES 数组尾加一项
import * as nodes from './src/host/nodes/index.js'
// ...
const MODULES = [ /* …44 个… */, nodes ]
```
`nodes` 需要 `rt` 里的 `ctx/state/save`，与其它 module 同签名 `install(rt)`。

### 2.2 `ds-bot/src/host/channel.js`
在 `handle()`（:231）里、`switch (endpoint)`（:237）**之前**加：
```js
if (endpoint.startsWith('node-')) {
  if (rt.nodes === undefined) return fail('nodes module not installed', 'bot/internal')
  return rt.nodes.handle(endpoint, body, signal)   // 自带 ok/fail 包装
}
```
> 必须在 `rt.refresh()` / `readOnly` 检查之后，这样 `node-*` 也受只读模式与既有 revision 语义约束。

### 2.3 `ds-bot/package.json`
```json
"exports": { ".":"./index.js", "./client":"./client.js",
             "./web-search":"./web-search.js",
             "./link.js":"./link.js",            // ← 新增：远程包复用同一份 link 实现
             "./package.json":"./package.json" }
```

**不改**：`groups.js`、`prompt.js`、`store.js`、`approvals.js`、`ledger.js`、`client.js`（Nodes 页走 `node-list` 等端点，前端只加一个视图）。

## 3. 主机 nodes module（合进 fork）

| 文件 | 职责 |
| --- | --- |
| `index.js` | `install(rt)`；建 `rt.nodes`；挂 `RemoteLlmAdapter` 到 llm 路由表；启动 `HostLink`（`phone.js` 同款，但设备表过滤 `role:'node'`） |
| `store.js` | `state.nodes[nodeId] = {name, botId, token, pubkey, groups[], caps, lastSeen}`；随 `state.json` 一起走既有 `home-lock` 单写者 |
| `invite.js` | 6 位码生成/校验/过期；换 token；`node-revoke` |
| `adapter.js` | **核心**。`class RemoteLlmAdapter extends LlmAdapter`，实现 `LocalAgentAdapter` 同款 chunk 契约：`block-start` → `text-delta` → `block-end` → `finish` |
| `members.js` | 绑群：建 bot 记录（`store.js` 的 `createBot` 同款字段）+ 插 `room.members` + 设 `model='node:<id>'`；解绑；`node-recall` |
| `files.js` | 落 `~/.dsh/bot/nodes/<nodeId>/outbox/`；sha256 校验；生成绝对路径 Markdown 链接（`links.js` 同款语义） |
| `audit.js` | 往 `ledger/` 写 `node.pair/turn/exec/file/presence` |
| `endpoints.js` | §4 的 17 个 endpoint 实现表 |

### 3.1 `adapter.js` 的执行序（决定成败的一段）

```
run(turn):
  turnId = uuid()
  rpc turn.request{turnId, prompt, tools: toolsFor(room), cwd: bot.sessionCwd, deadlineMs}
  while 帧未 finish:
    turn.event{delta}     → yield {type:'text-delta', index, text}
    turn.event{tool-call} → 本地执行 team tool（message_bot/post_to_group/read_group_chat/list_bots），
                            结果以 turn.event{tool-result} 回远程
    turn.event{file}      → 记入 files[]（真正的字节走 node-file-push，独立端点）
  turn.result{status,text,files} → yield {type:'block-end'} + {type:'finish', reason}
  失败：重试 1 次 → 仍失败 → 抛错（groups.js 落 `kind:'failed'` 行）
```

## 4. 远程 `dsbot-remote`（DSH 插件，role=node）

| 文件 | 职责 |
| --- | --- |
| `index.js` | cordis 插件；`inject=['llm','tools','sessions','workspaceRegistry','connection']`；读取本机 ds-bot 的 bots 列表选「代表我」的那只 |
| `link.js` | 用 `ds-bot/link.js` 建 `NodeLink`（出站、hello、token、ping）；断线指数退避（1s→30s 封顶） |
| `agent.js` | 收 `turn.request` → 在远程跑一轮本地 session（用远程 DSH 已配的 provider）→ 流式回 `turn.event` |
| `exec.js` | 白名单 `read_file/list_dir/run_shell/push_file/env_info`；cwd 默认代表 Bot 的 session cwd；30s 超时；输出截 64KB；剥离 `*_KEY|*_TOKEN|*_SECRET|*PASSWORD*` |
| `files.js` | 读本地文件分片（48KB）→ `node-file-push` |
| `presence.js` | online/busy/offline 心跳（15s），断线前最后一次标 offline |
| `config.js` | `~/.dsh/bot/remote-node.json`：`{server, token, nodeId, representBotId, workDir, caps}` |

远程**必须同时装 ds-bot**（头像/记忆/模型都来自它）；`dsbot-remote` 只做连接与执行，不复制 bot 状态。

## 5. 分阶段

| 阶段 | 内容 | 完成判据 |
| --- | --- | --- |
| P0 | `@dsbot/node-protocol`：常量、信封、校验、错误码 | `pnpm test` 绿；两端 import 同一个包 |
| P1 | link 打通：配对码 → token → 长连 → ping/pong 稳定 10 分钟 | 主机 `node-list` 看到节点 online |
| P2 | 绑群 + `turn.request/result` 纯文本一问一答 | 群里 @ 它，它用自己的模型回话，`seq` 正常递增 |
| P3 | 流式 + 工具调用（`post_to_group` / `read_group_chat`）+ 主动插话 | 它能自己读群、自己发一条 |
| P4 | 文件：远程 push → outbox → 群内绝对链接；反向附件转路径 | 双向各验一次 |
| P5 | admin：`node_exec` 走审批 → 远程白名单执行 → 审计 | 拒一次（越权）与准一次（白名单）都有记录 |
| P6 | `node-recall` 强制拉回、离线回执、`kind:'failed'` 行、断线续传 | §6 五步全过 |

## 6. 五步端到端验收（做完的定义）

1. **配对**：B 机 `dsbot-remote pair <code>`，A 机 Nodes 页节点变 online，`node-audit` 有 `node.pair`。
2. **进群**：A 机选群 + 选 B 机的 Bot → 群成员列表出现它，头像/名字来自 B 机。
3. **对话**：群里 @ 它 → 用 B 机的模型回话；B 机断网 → 成员标离线，@ 时立刻回执、不补跑。
4. **文件**：让它「把 B 机那个 CSV 发过来」→ 群消息里出现 `[data.csv](C:\Users\…\outbox\data.csv)`，文件真实存在、sha256 对得上。
5. **执行**：`node_exec run_shell "dir"` → 审批卡出现在群/主机 → 批 → 返回截断到 64KB 的输出 → `node-audit` 有 `node.exec`；再发一条不在白名单的 → `node/exec-denied`。

## 7. 不做（v1 硬边界）

多节点多群 / 对称联邦（远程邀请主机）/ 远程建群或加成员 / 远程 Web 面板 / 远程直连 IM 平台 / 传输层自建 relay / 远程访问主机 shell（方向相反）。

## 8. 回滚

- 主机：删 `MODULES` 里那一项 + `channel.js` 的早返回 + `exports` 一条 → 完全回到上游行为；`state.nodes` 留着不读，不影响既有 10 个 bot。
- 远程：卸载 `dsbot-remote`，ds-bot 原样可用。
- 绑定关系：`node-recall` 把 model 换回本地模型，群历史不动。

## 8. 解绑之后那条会话怎么办

上游**只有归档，没有删除**，这是实测的：

| 位置 | 行为 |
| --- | --- |
| `groups.js:390` | `rt.createSession(`${member.name} · ${room.name}`, …)` —— 列表里 `成员 · 群名` 那条的来路 |
| `groups.js:396` | 成员离开/被删时，`archiveSession(id, { stopActivity: true })` |
| `roster.js:805` `deleteRoom(id)` | 删群：先 `dropGroupSession` 每个成员、删 `state.rooms[id]`，最后仍只是 `archiveSession(sessionOfRoom(room), { stopActivity: true })` |

所以 `node-unbind` 做三件事就够，不用自己写清理：

1. 从 `room.members` 移除该 `nodeId` 的代理 bot
2. `dropGroupSession(room, botId)`
3. `archiveSession(群会话 id, { stopActivity: true })`（复用第 2 步上游已有的调用）

**副作用（上游行为，不是本插件引入的）**：`远程Bot · 群名` 会被归档而不是消失，界面上仍然看得见、也删不掉。要它真消失，得在 ds-bot 本体里加一个「彻底删除会话」，那是另一件事——记 `ENHANCEMENT-1`，v1 不做。

## 9. 传输的真实形状（读了 link.js 之后修正）

`link.js` 的模型是**单向**的，这一点在第 4 版设计里写错了：

| 类 | 位置 | 能力 |
| --- | --- | --- |
| `HostLink` | `link.js:7509` | `handle(method, params, {deviceId, signal})` 收请求；`emit(event, data)` **广播给所有 ready 设备**；`disconnect(deviceId)` |
| `RpcClient` | `link.js:8129` | `call(method, params, {signal})` 发请求并等回复；`onEvent`；`onClose` |

手机只调主机，所以 `HostLink` 不需要"主动 call 某个设备"——**它没有**。而我们的方向正好相反：主机发起 turn，节点执行。

`emit` 不能用：它是广播，群里的话会同时送到所有手机 App 上。这不是性能问题，是隐私问题。

**结论：v1 用「主机定向发事件 + 节点回传 RPC」**

```
主机 → 节点   HostLink.send(deviceId, event, data)     单向，无 ack
节点 → 主机   RpcClient.call('node.turn.event', …)     有 ack / 有错误码
```

需要在 `link.js` 加一个方法（约 12 行，复用现有 tunnel 与 `sendSecure`）：

```js
/** One device only — `emit` reaches every phone, and a group's talk is not theirs to see. */
send(deviceId, event, data) {
  const message = encodeMessage(createMessage('event', { event, data }))
  for (const tunnel of this.tunnels.values()) {
    if (tunnel.stage !== 'ready' || tunnel.deviceId !== deviceId) continue
    void this.sendSecure(tunnel, message).catch(() => this.dropTunnel(tunnel, 'SEND_FAILED'))
  }
}
```

代价：`turn.request` 从"有 ack 的 RPC"降级为"单向事件"，派发失败只能靠节点 TTL 与重发兜底。接受这个代价，因为反向（节点回传）保留了完整的 ack 与错误码，真正的错误都在那一侧。

fork 改动由此变成 **4 处**，每处都极小：`index.js` 的 `MODULES`、`channel.js` 的 `node-*` 分派、`link.js` 的 `send`、`phone.js` 的 `handle` 分支（若与 phone 共用连接）。

## 10. 远程端到底跑什么（依赖矩阵）

前提修正：**`dsbot-remote` 不 import `ds-bot` 的任何文件**。`ds-bot` 只在主机侧。远程机器上装了什么插件、装的是哪个版本，不影响它能不能接上。

| 远程有什么 | 启动方式 | 能做 |
| --- | --- | --- |
| 只有 Node ≥ 20 | `npx dsbot-remote@latest connect --code ABC234 --name 写代码那台` | exec / push_file / 文件转发；群里的发言由主机模型代跑 |
| 有 DSH（任意版本、任意插件集） | `dsh plugin add dsbot-remote` 后在 Settings → Nodes 里填码 | 上面全部 + 用远程自己的模型跑群对话 |
| 有 DSH + 同版本 ds-bot | 同上 | 上面全部 + 复用既有 Bot 的 cwd 与身份（可选，不是必需） |

**不靠版本对齐，靠能力协商。** `node.hello` 带 `caps`，主机按 `caps` 派发，缺什么就不派什么：

```json
{ "proto": 1, "nodeName": "写代码那台", "botName": "Codey",
  "caps": ["agent", "exec", "push_file", "mcp"] }
```

- `agent` —— 能自己跑一轮（有 DSH 或自带运行时）
- `exec` / `push_file` —— 两个执行动作
- `local-bot` —— 本机有 ds-bot，可复用某个 Bot 的 cwd 与显示名
- `mcp` —— 能把本地 MCP 工具集报上来

主机侧对缺能力的方法回 `node/unsupported`，并在群里留一行可见的说明，而不是让一轮对话静默失败。

**协议版本只做一件事**：主版本不同就 `node/proto-mismatch`（terminal），不做向下兼容——两端都是我们自己发的包，兼容层没有第二个消费者。

## 11. 远程的工具集归远程管

主机不知道、也不列举远端有哪些工具。远端的工具来自它自己的 DSH profile（`ops_bash`、`ops_grep`、MCP 服务器、任何第三方插件），主机没有资格也没有办法替它决定。

所以 `turn.request.tools` 是**追加**语义，只带四件跟群有关的事：

| 主机下发 | 谁执行 | 怎么执行 |
| --- | --- | --- |
| `post_to_group` / `read_group_chat` / `message_bot` / `list_bots` | 主机 | 远端把这四个当 MCP 工具挂上，调用时走 RPC 回主机，主机鉴权后执行 |
| `ops_bash`、`ops_read`、任意本地工具 | 远程 | 远程自己的 DSH 决定，主机看不到调用细节，也不需要 |

合并规则：

- 名字冲突时**本地优先**，主机那四个加前缀 `dsbot_`（`dsbot_post_to_group`）。
- 远端没有 MCP 能力（`caps` 里没 `mcp`）时，主机只发文本 prompt，群工具不可用——它仍能在群里说话，只是不能主动读群记录。
- 远端工具比主机少，不报错也不降级协商：agent 自己会发现没有那个工具。

这条和 `node.exec` 是两条互不相干的通道：

- **agent 通道**：远端 agent 用它自己的 `ops_bash` 干活，权限归它自己的 profile。主机不审批、不记录细节。
- **exec 通道**：主机主动调 `node.exec`，走五动作白名单 + 审批 + 30s 超时 + 64KB 截断。只有这一条受主机管。

两条通道同时存在是对的：群里的对话归远端 agent 自己跑，主机需要"帮我看一眼那台机器上的某个文件"时才用 exec。

## 12. 传输层：TCP + 长度前缀（已落地）

不碰 `relay.dsbot.app`。两台机器由 EasyTier 提供 IP 可达，我们只管在自己的端口上说话：

```
[4 字节大端长度][UTF-8 JSON]
```

`packages/dsbot-remote/src/transport/tcp.js`：

| 导出 | 作用 |
| --- | --- |
| `encodeFrame(frame)` | 编码，超过 4MB 直接抛 |
| `FrameReader` | 处理半包与粘包；长度字段超限立刻抛，不尝试分配 |
| `listenTcp({port, host, token, onConnection})` | 远端开口子；第一帧必须是 `hello` + token，错了发 `hello.error` 后断开 |
| `connectTcp({url, token, timeoutMs})` | 主机连过去；握手成功才 resolve |
| `parseTcpUrl(url)` | `tcp://10.144.0.2:7777` 或 `10.144.0.2:7777` |

传输层帧与协议帧是两件事：

- 传输层：`{t:'hello'}` / `{t:'hello.ack'}` / `{t:'hello.error'}` / `{t:'ping'}` / `{t:'pong'}`
- 握手之后：`@dsbot/node-protocol` 的 `request` / `response` / `error` / `event` 信封原样进出

ping/pong 在 `Peer.deliver` 里就地消化，不会出现在上层的 `frame` 事件里；60 秒没有帧就断开。

**v1 不加密传输层。** EasyTier 自带链路加密（AES-GCM / WireGuard 模式），再叠一层 Noise 是把密钥管理重复一遍。跨公网直连且没有 EasyTier 时，才需要补 Noise IK——那时加在 `Peer` 与协议层之间，不改上面的代码。

## 13. 本机可跑的最小闭环（已验证）

```bash
# 终端 A：远端
node bin/dsbot-remote.js listen --port 7794 --token demo-token-123

# 终端 B：主机
node bin/dsbot-remote.js connect --to tcp://127.0.0.1:7794 --token demo-token-123
```

实际输出：

```
03:34:23 已连上 tcp://127.0.0.1:7794
03:34:23 <- {"t":"demo.reply","got":"remote is here"}
```

同一份代码换成 EasyTier 的虚拟 IP 就是跨地区链路，一行不用改。


## 14. 实施状态

### 已完成（有测试或探针兜底）

| 块 | 文件 | 证据 |
| --- | --- | --- |
| 协议 | `packages/node-protocol/src/{version,errors,validate,methods,endpoints,envelope,index}.js` | 18 测试（信封往返、坏帧、方法表、方向表、17 端点） |
| 传输 | `packages/node-protocol/src/transport/tcp.js` | 10 测试 + 本机双向实跑 |
| 主机 adapter | `packages/dsbot-nodes/src/host/nodes/adapter.js` | 13 测试 + **契约探针**（宿主真 `LlmAdapter`/`BlockAssembler` 收下我们的 chunk） |
| 主机接线 | `packages/dsbot-nodes/src/host/nodes/index.js` | 5 测试（认节点、exec 往返、重连复用、握手超时、口令错） |
| 群绑定 | `packages/dsbot-nodes/src/host/nodes/bind.js` | 8 测试（建代理 Bot、撞名、重绑复用、解绑、忘掉） |
| 存储 | `store.js` | 9 测试（配对码、一次性、过期、只读） |
| 文件收 | `files.js` | 10 测试（流式 sha256、原子落盘、重名、设备名、穿越） |
| 端点分发 | `endpoints.js` | 10 测试（方向、未知方法、参数校验、错误映射） |
| 远端 exec | `packages/dsbot-remote/src/exec.js` | 13 测试（五动作、穿越、超时、截断、剥密钥） |
| 远端 agent | `packages/dsbot-remote/src/agent.js` | 端到端探针（真子进程、流式两段） |
| 远端 CLI | `packages/dsbot-remote/src/cli.js` | `listen`/`connect`/`version` 实跑 |
| 文件进群 | 远端 `@@attach` → `turn.result.files` → `acceptUpload` → 链接接在话尾 | `probe-attach.mjs` 端到端（sha256 一致、落盘读回一致） |
| 装车 | `install(rt)` 在真 cordis Context + 真 `LlmRuntime` 下跑通 | `probe-install.mjs`：工具 `node_remote` 注册成功 |

合计 **96 测试**（node-protocol 28 + dsbot-nodes 54 + dsbot-remote 13） + 2 个端到端探针。

### 没做（写在这里，不假装有）

1. **Settings → Nodes 页面**：要有 `node-*` 端点才能让前端取数，v1 靠 `node_remote` 工具代替。
2. **远程审批 UI**：exec 通道目前是"主机调就执行"，没有审批卡片。R5 定的审批链没有实现。
3. **多节点/对称联邦/远程建群**：不在 v1。
4. **TLS**：v1 靠 EasyTier 的链路加密，传输层自身不加密。

### 怎么装到主机（已经装进这台机器了）

DSH 的插件挂载有**三个硬条件**，缺一个就静默不加载（不报错、不崩，只是什么都不发生）：

1. 包自己带 `cordis.patch.yml`，且条目写在 `insert:` 里
2. 包的 `package.json` 声明 `dsh.bundle.patch`
3. 包名进 profile 的 `dsh.profile.bundles`

```yaml
# packages/dsbot-nodes/cordis.patch.yml
- insert:
    - id: dsbot-nodes
      name: 'dsbot-nodes'
```

```json
// packages/dsbot-nodes/package.json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

**不要往 profile 的 `cordis.patch.yml` 顶层加 `- id: dsbot-nodes`**。那一层是"按 id 覆盖已有条目"，条目不存在时只打印 `patch: entry "dsbot-nodes" not found` 然后跳过——这台机器上的 `hindsight` 和 `dsh-purge` 的 5 个 `redteam-*` 条目都是这么失效的。

这台机器的现状：

| 位置 | 内容 |
| --- | --- |
| `profiles/desktop/node_modules/dsbot-nodes` | junction → `D:\Default\dsbot-remote\packages\dsbot-nodes` |
| `profiles/desktop/node_modules/@dsbot/node-protocol` | junction → 协议包 |
| `packages/*/node_modules/@deepseek-ai/{dsh-llm,dsh-tools,cordis}` | junction → 宿主包（本地开发用） |
| `profiles/desktop/package.json` 的 `dsh.profile.bundles` | `dsbot-nodes` 紧跟在 `ds-bot` 后面 |
| ds-bot `index.js:89` | `ctx.provide('bot', rt)` |

验证（不用重启就能确认条目进树）：

```bash
cd ~/.dsh/profiles/desktop && node -e "
import('file:///D:/Dsh/resources/app/dsh/node_modules/@deepseek-ai/dsh/lib/dump-config-DYSXukkc.js')
  .then(m => m.runDumpConfig('desktop', false, [], undefined))" | grep -A2 dsbot-nodes
```

应该看到 `# == dsbot-nodes` / `- id: dsbot-nodes`。

重启后看 `~/.dsh/bot/nodes-boot.log`：三个观测点分别是 `module imported`、`apply called`、`install`。

回滚：从 `dsh.profile.bundles` 删掉 `dsbot-nodes`，`rm profiles/desktop/node_modules/dsbot-nodes`。

正式分发时不要用 junction：把 `@dsbot/node-protocol` 作为依赖发布（`"@dsbot/node-protocol": "^0.1.0"`），代码里已经是包名 import。

### 升级 ds-bot 后的检查清单

改完 `ds-bot` 版本，跑这三条，任何一条红了就说明我们踩的那三个形状变了：

```bash
node --test packages/dsbot-nodes/test/bind.test.js     # bot.model / room.members
node packages/dsbot-nodes/probe-contract.mjs            # chunk 契约
node packages/dsbot-nodes/probe-turn.mjs                # 端到端
```
