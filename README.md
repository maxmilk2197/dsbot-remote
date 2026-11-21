# dsbot-remote

> [!WARNING]
> **本项目代码全部由 AI 生成。请勿在生产环境使用。**
>
> 它会在你的机器上执行命令、读写文件、把文件推到别的机器，并且能远程触发。三档验证状态见文末「成熟度」一节 —— 跑过的、写完了没跑的、根本没碰的，都列在那里。
>
> 自己承担风险。生产环境请用经过审计的替代方案，或者至少先把 §成熟度 里「根本没碰」那几条补完。

把**另一台电脑**变成 DS Bot 群聊里的一个成员：它在自己那台机器上跑模型、读自己的文件、执行自己的命令；主机这边只看到一条普通 Bot。

```
主机 DSH                         另一台电脑
┌──────────────────────┐        ┌──────────────────────────┐
│ ds-bot               │  TCP   │ dsbot-remote listen      │
│  └ dsbot-nodes ◄─────┼────────┼─ 自己的 DSH / 自己的命令 │
│      adapter("node:x")│ 信封   │  turn.request → 本地跑   │
│      群成员 = 代理 Bot │        │  turn.event  ← 流式回字  │
└──────────────────────┘        └──────────────────────────┘
```

## 它是什么，不是什么

- **是**：一台机器上的 Bot 加入**主机已有的群**，用那台机器的算力发言；主机可以通过白名单动作在它上面读文件、列目录、跑命令、写文件。
- **不是**：消息转发器。群里没有"复制粘贴"这一层——`groups.js` 看到的是一条普通 Bot，`bot.model` 指向 `node:<节点id>/default`，发言内容由那台机器产生。
- **ds-bot 只改一行**：`createRuntime` 里 `ctx.provide('bot', rt)`，把运行时挂成服务，外部插件才拿得到 `createBot` / `updateRoom` / `state.bots`。其余全部在 `dsbot-nodes` 里（推理过程见 [FORK.md](FORK.md)）。

## 装插件

在 DSH 的「添加插件」里粘仓库地址就行（命令行等价：`dsh plugin add` 或 `pnpm add`）：

```
https://github.com/maxmilk2197/dsbot-remote
```

仓库根就是插件包：`name: dsbot-remote`，带 `dsh.bundle.patch` 与 `dsh.client`，
`files` 里只打包 `packages/dsbot-nodes` 和根上的 `cordis.patch.yml`（tar 包约 166 KB），
所以装出来就是一个完整插件，不用再拼 `#path:`。

- **那台机器没装 git**：别用上面这条（pnpm 解析 git 说明符必须开子进程跑
  `git ls-remote`，没有 git 直接 `ERR_PNPM_GIT_RESOLVE_FAILED`）。改成粘打好的 tgz 链接，
  一样是「输入框里贴一行」：

  ```
  https://raw.githubusercontent.com/maxmilk2197/dsbot-remote/main/dist/dsbot-remote-0.1.3.tgz
  ```

  大陆网络 raw 不通时换 CDN 镜像：
  `https://cdn.jsdelivr.net/gh/maxmilk2197/dsbot-remote@main/dist/dsbot-remote-0.1.3.tgz`。
  两条都实测过：`pnpm add` 2 秒装完，入口、`dsh.bundle.patch` 都在。
- 上面那条 git 地址要求机器上有 `git`，装之前先跑
  `git ls-remote https://github.com/maxmilk2197/dsbot-remote` 确认能通。
- 没有 git 的机器，两条替代路：
  1. 拿打包好的 tgz（`pnpm pack` 出来的 `dsbot-remote-*.tgz` 或仓库里给的），输入框里填它的绝对路径，例如 `C:\Users\me\Downloads\dsbot-remote-0.1.2.tgz`；
  2. 整仓库拷过去，填插件子目录的绝对路径 `D:\dsbot-remote\packages\dsbot-nodes`（包名 `dsbot-nodes`，跟根包是同一份实现）。
- 子目录写法 `…/dsbot-remote#path:/packages/dsbot-nodes` 仍然有效，只是不再需要。
- **包名要和 `client.js` 注册的模块 id 对上**：web 启动时按 cordis 条目名（= 装出来的包名）
  去 `__ModuleLoader__` 里找模块，找不到就整机卡在
  `web boot: 1 entry did not activate / <包名>: import failed`。所以 `client.js` 里
  两个名字都注册了（`dsbot-nodes`、`dsbot-remote`），再改包名记得同步那里。
- 装完还要 ds-bot 那一行补丁，见 [FORK.md](FORK.md)；升级 ds-bot 会把它冲掉。

## 三步用起来

**1. 主机拿到配对码**

设置 → 远程节点，或者对任意 Bot 说一句「给我一个配对码」（`node_remote action=pair`）。
六个字符，屏幕上直接显示。

**2. 另一台机器输进去**

那台机器装同一个插件，打开 设置 → 远程节点，把这六个字符填进去。
不用填 IP、不用填端口、不用抄令牌 —— 码本身就是钥匙。

**3. 让它进群**

回到主机的设置页，在这台机器的卡片上选一个群。它的 Bot 立刻成为群成员；
之后它发言、推文件、被派活，都发生在它自己那台机器上。

## 两端跑什么

| 端 | 需要 | 怎么跑 |
| --- | --- | --- |
| 主机 | DSH + ds-bot + `dsbot-nodes` | 装插件启用；配对码在设置页 |
| 另一台（有界面） | DSH + 同一个插件 | 设置 → 远程节点 → 输入配对码 |
| 另一台（只有 Node） | **Node ≥ 20** | `npx dsbot-remote pair --code ABC234 --agent "dsh -p"` |

只有 Node 的那台也能用：`pair` 自己广播找主机，不需要知道地址。想让它发言就带
`--agent`（任何从 stdin 读、往 stdout 写的 CLI）；不带就只能被读文件、跑命令 —— 它不会
假装自己能说话，`turn.request` 直接回 `node/unsupported`。

不在同一个 WiFi 时，两边都打开 EasyTier（插件按平台自动下载，只下一次，设置页一个开关，命令行是
`--network`）。它负责让两台机器 IP 可达，配对码仍然是那把钥匙。


它会调 `node_remote` 工具（action=connect），握手成功后返回节点 id（`n-xxxxxxxx`）与那台机器能做哪些事。

**3. 让它进群**

> 让「写代码那台」进「赚钱小组」

`node_remote bind` 会建一条代理 Bot、把 `model` 指到 `node:n-xxxxxxxx/default`、加进 `room.members`。此后群里 @ 它，发言就在那台机器上跑。

**4. 用它干活**

> 让「写代码那台」看看 D:/work/package.json

走 `exec` 通道：`read_file` / `list_dir` / `run_shell` / `env_info` / `push_file`，30 秒超时，输出截 64KB，密钥环境变量在远端就被剥掉。

## 两个通道是分开的

| | agent 通道 | exec 通道 |
| --- | --- | --- |
| 谁发起 | 群里的一轮对话 | 主机主动调 `node.exec` |
| 在哪执行 | 远端自己的 DSH，用它自己的工具（`ops_bash`、MCP、任何插件） | 远端 `dsbot-remote` 进程内的白名单五个动作 |
| 主机能看到 | 只要回话内容 | 每次调用的返回（含退出码、输出） |
| 超时 | 10 分钟（一轮 turn） | 30 秒（一个动作） |
| 审批 | 无（远端自己的模型自己决定） | 群 admin / 主机用户批 |

**主机的工具表不会灌进远端。** `turn.request.tools` 是**追加**，远端原来那套工具一条不少；名字冲突时本地优先，主机来的四个群工具加前缀 `dsbot_`。远端 `caps` 没有 `mcp` 就只发纯文本 prompt。

## 一个节点一个群一个成员（v1 的边界）

- 一台机器可以在多个群里有代理 Bot（`node.groups` 是数组），但每个群只有一个成员身份——不会出现"同一台机器在群里有两个分身"。
- 远程**不能自己建群**，只能进主机已有的群。
- 多节点、对称联邦、远程 Web 面板：都不在 v1。

## 断线与重连

- 60 秒没有一帧就断（`IDLE_MS`）。
- 重连凭 `deviceId` 认出是同一台机器，沿用原来的节点记录与代理 Bot，不会在群里多出一个人。
- 断开时群里的代理 Bot 仍然在成员表里——它的下一次 turn 会失败并写一行失败记录，不会静默消失。

## 安全边界（说清楚，不含糊）

- 传输层**没有自己的加密**：v1 假设两端在 EasyTier / WireGuard / 局域网里可达。裸公网跑 TCP 等于明文。
- 口令是 `--token`，长度 < 8 直接拒；握手第一帧必须是 `{t:'hello',token}`，错了立刻断。
- `exec` 只能动 `--cwd` 允许的根（`read_file`/`push_file` 有目录穿越检查，`stay-in-root` 测试覆盖 `..` 与兄弟目录）。
- 远端进程的 `sanitizeEnv` 剥掉 `*_KEY`/`*_TOKEN`/`*_SECRET`/`PASSWORD` 一类变量，`env_info` 也不会吐它们。

## 包结构

| 包 | 作用 |
| --- | --- |
| 仓库根（`dsbot-remote`） | 插件入口壳：`dsh.bundle` + `dsh.client` + `exports` 指向 `packages/dsbot-nodes`，装的就是它 |
| `dsbot-nodes` | 主机侧 cordis 插件：连接管理、`node:` LLM adapter、群绑定、`node_remote` 工具；线协议（信封、方法表、错误码、校验、TCP 传输）内联在 `src/protocol/`，**零运行时依赖** |
| `dsbot-remote` | 远程侧 CLI：listen/connect、切帧、`exec` 白名单、agent 子进程 |

线协议原先单独成包（`@dsbot/node-protocol`），后来并进 `dsbot-nodes`：pnpm 默认
`blockExoticSubdeps` 不允许子依赖再指向 git 地址，拆包会让"粘仓库链接就装"直接失败。
现在这个插件**没有任何 dependencies**，装它不需要额外的包先到位。

## 测试

```bash
cd packages/dsbot-nodes  && node --test
cd packages/dsbot-remote && node --test
```

契约探针（用宿主真实的 `LlmAdapter` 与 `BlockAssembler` 验收 chunk 序列）：

```bash
node packages/dsbot-nodes/probe-contract.mjs
# chunks: block-start → text-delta → text-delta → block-end → finish
# blocks: [ 'text:好的，我看一下。' ]
# finish: {"kind":"stop"}
```

装车探针（真 cordis Context + 真 llm 服务，验证 `install(rt)` 与工具注册）：

```bash
node packages/dsbot-nodes/probe-install.mjs
# llm 服务: function | listProviders: function
# install 返回: connect,accept,list,node,resolveNode,call,linkFor,store,bind,unbind,forget,disconnect
# 工具注册: node_remote
```

端到端探针（真起一个远端进程、真跑 turn）：

```bash
node packages/dsbot-nodes/probe-turn.mjs
```

## 成熟度

**全部代码由 AI 生成，未经人工逐行审计。** 按证据分三档：

### 跑过、有输出

| 项 | 证据 |
| --- | --- |
| 协议层 | 28 测试（坏帧、超长帧、方向表、17 端点） |
| adapter 的 chunk 序列 | 13 测试 + `probe-contract` 用宿主真 `BlockAssembler` 收 |
| exec 白名单 | 13 测试（穿越、超时、64KB 截断、密钥剥离） |
| 文件落盘 | 10 测试（sha256 已知向量、Windows 设备名、重名） |
| 配对码广播 | 本机跑通 |
| exec / turn / 文件回传 | 端到端各跑通一次（本机自环） |
| 插件加载 | `nodes-boot.log` 四行 + `/api/nodes/status` |

### 写完了、一次都没跑

- **`join`（输入配对码加入别人的群）** —— 只验证了能 import
- **设置页的输入框** —— 没在浏览器里渲染过
- **adapter 在真 `groups.js` 里跑一轮** —— 没走过群聊的 turn 循环
- **turn 取消 / 断线重连** —— 单测过，真实没验

### 根本没碰

- **EasyTier 跨网**：非管理员权限，TUN 一个 IP 都没建出来，跨网**完全没有验证**
- **两台真机**：从头到尾都是 `127.0.0.1`
- **远程 `dsh -p` 真跑模型**：探针里的假模型只回字数
- **防火墙**：7777 / 47821 没加规则

**结论：不要在生产环境用。**

## 文档

- [DESIGN.md](DESIGN.md) —— 为什么这样切、十个决策、风险表
- [PROTOCOL.md](PROTOCOL.md) —— 信封、事件、端点、错误码
- [PLAN.md](PLAN.md) —— 文件级改动、阶段、验收
- [FORK.md](FORK.md) —— 为什么最终不用改 ds-bot 一行
- [DISCLAIMER.md](DISCLAIMER.md) —— AI 生成声明与使用限制

## EasyTier 自动下载

仓库**不再内置** EasyTier 二进制（每个平台约 30MB，放仓库里既臃肿又容易版本不一致）。第一次真正要跨网时，插件会按当前平台从 [EasyTier Releases](https://github.com/EasyTier/EasyTier/releases) 下载一次，解压后缓存在：

```
~/.dsh/bot/easytier/<版本>/<平台-架构>/
```

之后直接复用，不再联网。**没有它局域网内照常工作，只是跨不了网。**

每个配对码会派生自己的**实例名、监听端口（26000-34000）和配置目录**，所以它能和本机其它 EasyTier 同时运行 —— 包括 HMCL 的「陶瓦联机」。之前两边都用默认实例名和 11010/15888，才会互相踩。

下载走的是 GitHub。网络不通时用环境变量换镜像或手动安装：

| 变量 | 作用 |
|---|---|
| `DSBOT_EASYTIER_MIRROR` | 镜像前缀，例如 `https://ghfast.top/`，拼在 GitHub 地址前面 |
| `DSBOT_EASYTIER_URL` | 直接给一个 zip 地址，跳过拼装 |
| `DSBOT_EASYTIER_DIR` | 已经解压好的目录，优先使用，完全不下载 |
| `DSBOT_EASYTIER_VERSION` | 换版本，默认 `v2.6.4` |

手动安装就是下载对应平台的 zip，解压到上面那个缓存目录（或任意目录，然后把 `DSBOT_EASYTIER_DIR` 指过去）。

另外 EasyTier 要建 TUN 设备，**Windows 上需要管理员权限**，这一步本仓库从未验证过（见「成熟度 · 根本没碰」）。
