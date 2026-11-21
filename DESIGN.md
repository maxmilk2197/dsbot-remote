# DSBot Remote Nodes — 设计决议

> 七轮 grilling 的结论。每条决议都带「为什么」和「被否掉的选项」，因为否决理由才是后来者真正需要的东西。
> 基准版本：`ds-bot@0.3.6`（`C:\Users\nahid\.dsh\profiles\desktop\node_modules\ds-bot`）。

---

## 0. 一句话目标

让另一台电脑上的 DSH 里的一只 Bot，以**真正的群成员**身份加入本机 DS Bot 的群聊：被 @ 会回话、能自己说话、能把那台机器上的文件推到群里（落点 + 链接）、能被指向地执行白名单命令。

## 1. 事实基线（这些是查到的，不是假设）

| 事实 | 证据 |
| --- | --- |
| ds-bot 是 cordis 插件，44 个子模块统一 `install(rt)` | `index.js:63` `const MODULES = [...]`；`index.js:86` `for (const module of MODULES) module.install(rt)` |
| 插件的 home 是 `<DSH_HOME>/bot`，单写者锁 | `index.js:65-77`；`home-lock.js:1-3`；`bot/state.lock` = `{pid,host,token}` |
| Bot = 长活 DSH session（`bots[id] = {name,role,avatar,model,sessionId}`），`id` 就是 bot session id | `store.js:443` `botOf`、`:471` `chatOf`、`:472` `sessionOfRoom`；`state.json` 实测 10 个 bot |
| 群是插件自己的实体：`room.members`、`seq`、发言顺序、`admin`、审批卡片行 | `groups.js`（1900+ 行）；`groups.js:1881-1889` 行类型 `undefined`/`'approval'`/`'working'`/`'failed'` |
| 群提示词形如 `[Group chat …]`，一名成员一轮 | `prompt.js:20` |
| 客户端入口只有一个：`POST /api/bot`，`handle()` 是**闭包**，`:237` 是写死的 `switch (endpoint)` | `channel.js:231`、`:237`、`:844-855`；`constants.js:22` `ROUTE = '/api/bot'` |
| 包 exports 只开 `.` / `./client` / `./web-search` / `./package.json` | `package.json` → `exports` |
| 已有产品级出站 link：手机 App 走 `wss://relay.dsbot.app/v1/link`，只出站、端到端加密、配对码 | `phone.js:1-5`、`:14`；`link.js` 顶部常量 |
| link 协议：控制帧 11 种 + 消息 4 种（`rpc.request`/`rpc.response`/`rpc.error`/`event`），48KB 分片，4MB 消息上限 | `link.js` `controlFrameTypes` / `messageTypes` / `MAX_SECURE_MESSAGE_BYTES` |
| 已有「把 Bot 的模型路由换成外部执行器」的桥 | `local-agents/adapter.js` `LocalAgentAdapter`（`LlmAdapter` 子类）、`jsonrpc.js` `JsonRpcPeer`、`mcp.js` `LoopbackMcp` |
| 文本跨 session 时相对文件链接会被改绝对 | `links.js` `absoluteLinks()` |
| QQ 出站只能发纯文本 | `im/platforms/qq.js:214` `{content, msg_type:0, msg_id, msg_seq}` |
| 已有审计目录 | `src/host/ledger.js`（175 行），`~/.dsh/bot/ledger/` |

## 2. 核心决议

### D1 形态：远程节点是「一只代理 Bot + 一个远程执行器」
主机 `state.bots` 里有一条普通 bot 记录，`name/role/avatar` 从远程同步，**`model = "node:<nodeId>"`**。它的 turn 由远程 DSH 执行。

> 为什么：这条记录让 `groups.js`、`prompt.js`、`approvals.js`、`ledger.js` 全部不用改。`local-agents` 已经证明「换个 model route = 换个执行器」这条路是原生的。「主机可强制拉回」于是等于把 model 换回本地模型，一行配置。

被否：成员条目直接 `{nodeId}`（没有 bot 记录 → 群逻辑要加分支）；双条目同步（状态同步成本最高）。

### D2 传输：复用 phone link relay，不新建 relay
远程节点作为 link 上的**新设备角色 `node`**，出站长连 `wss://relay.dsbot.app/v1/link`，配对码换长期 token，帧格式沿用 `rpc.request/response/error/event`。

> 为什么：第 1 轮要的「出站长连 + 配对码 + 长期 token + JSON-RPC 报文」，`link.js` 已经全实现了，连分片（48KB）和消息上限（4MB）都有。自建 relay 等于把已存在的产品级组件重做一遍。

被否：ds-harness-remote 的 P2P（语义是「远程控制主机」，方向相反，且两端要多装一个插件）；自建 WebSocket relay。

### D3 主机侧必须 fork ds-bot（两个文件 + 一个 exports 条目）
`handle()` 是闭包、`switch (endpoint)` 写死、包 exports 没开 `link.js` → 外部插件拿不到分发权，也加不了 `node-*` 端点。

改动清单（严格限定，见 `PLAN.md`）：
1. `index.js`：`MODULES` 加 `nodes`。
2. `src/host/channel.js`：`handle()` 里 `node-*` 前缀早返回。
3. `package.json`：`exports` 加 `"./link.js": "./link.js"`（远程包要复用同一个协议实现）。

> 为什么：这是唯一能同时拿到「分发权」和「link 实现」的最小改动面。`UPSTREAM.md` 记基版号，升级时机械 rebase。

被否：外部插件 monkey-patch `ctx.connection.fetch.register`（依赖加载顺序与内部服务可写，上游一次重构就断）；退化成「远程客户端」（那就不是群成员了）。

### D4 群权威在主机，远程持只读镜像
`seq`、成员表、发言顺序、`admin`、审批卡片全在主机。远程只拿增量镜像，自己那一行由主机分配 `seq` 后回写。

> 为什么：联邦对等同步要向量时钟和冲突解，不是一个插件该干的活。

被否：双向对等同步；群归属各自节点。

### D5 进群：只能被邀请
远程不能建群、不能自己进群。主机用户在 Settings → Remote Nodes 里选群、选远程 Bot、建代理 Bot。

> 为什么：第 1 轮曾选「远程自增」，第 3 轮改判——联邦制下远程自增会让 `seq`/成员表分叉。

### D6 主动插话：允许，且**不限频**
用户明确选了「不限制」。

> ⚠️ 这一条是产品风险，已记录在案：两个远程成员同时开嗓时，群日志顺序由主机的 `seq` 决定，主机不做仲裁。若日后要加闸门，位置在 `nodes` module 的 `node-post` 入口（按 groupId 记滑动窗口），不动协议。

### D7 工具分两层
- **远程本地工具**（不上抛主机）：`read_file`、`write_file`、`list_dir`、`run_shell`、`push_file`。
- **主机 team tools 下行**（只这 4 个）：`message_bot`、`post_to_group`、`read_group_chat`、`list_bots`。

> 为什么：`create_group`/`update_group` 与 D5 冲突；`ask_user`/`show_view` 需要 host UI，远程没有。
> 实现位置：`LlmAdapter` 的 tool 定义表 —— 主机侧直接把工具 schema 交给 adapter，远程回的 `tool.call` 由 adapter 在主机执行（`local-agents/index.js:106-118` 的 `toolsFor` 白名单就是这个形状）。

### D8 执行：两条通道
1. 群里自然语言 → 远程 agent 自己决定用哪个本地工具（受远程 node 配置 + 主机 `room.permission` 映射管）。
2. 主机 admin 指令 → 主机工具 `node_exec` / `node_read_file` / `node_push_file`，走审批后才下发，远程只执行白名单动作：`read_file`、`list_dir`、`run_shell`、`push_file`、`env_info`。

`run_shell` 约束：`cwd` 默认 = 代表 Bot 的 session cwd（node 配置可覆盖）、默认 30s 超时、输出截 64KB、剥离含 `key|token|secret|password` 的环境变量。

被否：群成员说啥就执行啥（自由 shell 进群）；只允许主机下发（丢掉远程自己动手的价值）。

### D9 文件：固定 outbox + 绝对路径链接
- `remote → host`：远程分片上传到主机 `~/.dsh/bot/nodes/<nodeId>/outbox/`，主机在群消息里写**绝对路径 Markdown 链接**，`links.js` 原生支持这种跨 session 链接。
- `host → remote`：群成员附件先落主机 staging，`turn.request` 里带本地路径，远程直接读。

> 为什么：ds-bot 群里的「文件」本来就是路径链接，不是 IM 附件；`qq.js` 出站只有纯文本，真上传到 IM 平台做不到。

### D10 其余已定
| 项 | 决议 |
| --- | --- |
| 配对 | 主机制一次性码（6 位 / 5 分钟）→ 远程换长期 token，主机可单台撤销 |
| 线协议 | `rpc.request/response/error/event` 信封，`PROTOCOL_VERSION = 1`，不匹配直接拒 |
| 协议共享 | 一份实现，内联在 `packages/dsbot-nodes/src/protocol/`（信封 + 校验 + 传输）；不拆独立包，否则插件装不上 |
| 远程包 | `dsbot-remote`（DSH 插件，role=`node`），**同时装 ds-bot**（要用它的 bots/头像/记忆） |
| 远程模型 | 用远程 DSH 已配好的 provider（远程自备 key，主机不存 key） |
| 每群会话 | 远程侧 `groupId → sessionId` 持久映射，一群一会话 |
| 身份消歧 | 群里显示 bot 名，内部 `id` 带 `nodeId`；重名提示改名，不改则带后缀 |
| 离线 | 成员列表标离线；@ 它立刻回执「该成员离线」，**不补跑** |
| 失败 | 重试 1 次，仍在群里写 `kind:'failed'` 行（`groups.js` 已有该行类型） |
| 审计 | 进现有 `ledger.js`，新增 `node.pair / node.turn / node.exec / node.file / node.presence` |
| 主机 UI | Settings → Remote Nodes（配对码、节点列表、在线状态、撤销、强制拉回、绑定群） |
| v1 规模 | 一节点一群、一群一远程成员 |
| v1 不做 | 多节点多群、对称联邦（远程邀请主机）、远程建群、远程 Web 面板 |

## 3. 关键设计点：为什么 groups.js 一行都不用改

```
群里 @远程成员
   └─ groups.js 照常发起一轮 turn（它只知道“这是个 bot”）
        └─ bot.model = "node:abc"
             └─ nodes module 注册的 RemoteLlmAdapter 被调用
                  ├─ host→node  rpc  turn.request{prompt, tools, cwd, deadline}
                  ├─ node→host  rpc  turn.event{delta}         （流式回填）
                  ├─ node→host  rpc  tool.call{name, args}     （调用下行 team tools）
                  ├─ node→host  rpc  file.push{...}            （落到主机 outbox）
                  └─ node→host  rpc  turn.result{text, files}  （转成 LlmAdapter chunk）
             └─ groups.js 收到普通 chunk，按现有逻辑落群日志、分配 seq
```

`LlmAdapter` 的契约（从 `local-agents/adapter.js` 读出）：`block-start` / `text-delta` / `block-end` / `finish`。远程只要产出这四类 chunk，主机这一侧就完全不用知道「turn 是在另一台机器上跑的」。

## 4. 主要风险

| 风险 | 处置 |
| --- | --- |
| fork 后跟上游漂 | 改动锁在 3 处；`UPSTREAM.md` 记基版 `0.3.6`；每次升级只 rebase 这 3 处 |
| 长任务掉线 | 每 turn 一个 `cursor`，重连从 cursor 续传；turn 不因断线失败（上限 30 分钟） |
| 群日志流向另一台机器 | 群级开关 `allowRemoteMember`，**默认关**；关闭时远程收不到任何群行 |
| 远程不限频插话 | 已知并接受（D6）；闸门预留位置已写进 `PLAN.md` |
| relay 是第三方服务 | `relay.dsbot.app` 属 ds-bot 产品线；node 配置支持自填 server URL（`phone.js` 已有 `data.server` 先例） |

## 5. 群节奏 vs 远程 turn 期限（实测数字，必须对齐）

`groups.js` 的节奏常量（`constants.js`）：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `ROOM_REPLY_TIMEOUT_MS` | 240_000（4 分钟） | 一轮里等不到某成员，就记 `missed` 行放它走 |
| `ROOM_STEP_GAP_MS` | 30_000 | 同一成员连发的中间行合并成一条消息 |
| `ROOM_WORK_GRACE_MS` | 15_000 | 还在跑工具的成员，宽限这么久后轮照样往下走 |
| `ROOM_IDLE_RELAY_LIMIT` | 6 | 连续 6 条「收到/待命」类空转就暂停这个群 |
| `ROOM_LOG_MAX` | 60 | state 里只留最近 60 行，长行整文另存 `group-lines/<roomId>/<seq>.txt` |

**两套期限的关系（不是矛盾，是分层）**：

```
0 ──────── 4min ─────────────── 30min ──────────>
   turn 在跑        群里记 missed 行          远程 deadline
                    轮继续/结束               turn 丢弃 + 失败行
                    远程答完 → late reply 补上
```

- 4 分钟是**群不等你**：这一轮的形状已经不指望你了，`groups.js:102` 会写一行「没在 N 分钟内回答」。
- 30 分钟是**turn 别丢**：远程还在跑，重连后 `turn.result` 仍会到，主机当作 late reply 落群（`lateRoomReply:1660`）。
- 所以 R2 的「turn 不因断线失败」是被现成机制满足的，不需要新增逻辑；我们只需要**不去缩短** 30 分钟。

## 6. turn 的文本自动落群（决定 post_to_group 的定位）

`postStep:1731` → `postToRoom`：成员 turn 结束时产出的文本，**不需要调用任何工具**就会成为群里的一条发言（走 `rt.roomStepText` 的合并节奏）。因此：

- 我 adapter 的 `finish{kind:'stop'}` + 文本块 = 群里那条消息。这是主路径。
- `post_to_group` / `node.post` 只服务**轮外主动插话**（D6），不是说话的必需品。
- 空转护栏会作用于远程：只会回「收到/待命」的远程成员在 6 条后被暂停。远程的 system prompt 必须教它说实质内容，这条进 `dsbot-remote` 的 prompt 设计。
