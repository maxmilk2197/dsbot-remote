# 为什么只需要改 ds-bot 一行

这份文档记录两次判断被推翻的过程。两次都推翻了「不用改」的结论，只不过第二次只差一行。

## 第一次：以为要 fork 两个文件（错，改多了）

R8 那轮的推理是：远程 Bot 要在 UI 里被看到 → 需要 `node-*` 端点 → 端点只能加在 `channel.js:237` 那个写死的 `switch` 上 → 必须改本体。

错在第 1 步。**远程 Bot 不是新物种**，它是 `state.bots` 里的一条普通记录，只是 `model` 指向 `node:<节点id>/default`。`groups.js` 判断"谁在群里"只看 `room.members` 与 `rt.botOf(id)`，轮到谁就拿谁的 `model` 去跑——它不关心那个 model 在哪台机器上。

所以端点、`room.members` 的新成员类型、群 UI 的改动，全都不需要。

## 第二次：以为能零 fork（错，差一行）

「既然只要写一条 bot 记录、往 `room.members` 里加个 id，那外部插件自己干就行了」——问题在于**谁来写**。

`ds-bot/index.js` 的形状是：

```js
export function apply(ctx, config = {}) { createRuntime(ctx, config) }

export function createRuntime(ctx, config = {}) {
  const rt = { ctx, config, dshHome, home, statePath, teamTools: [], defaults: {...} }
  for (const module of MODULES) module.install(rt)   // 44 个模块共用这一个 rt
  rt.syncScopedTools?.()
}
```

`rt` 是 `createRuntime` 的局部变量，44 个模块通过闭包共享它。`rt` 上有 `createBot`、`updateRoom`、`deleteBot`、`state.bots`、`teamTools`——**全在这里面**。

外部插件的 `apply(ctx)` 拿到的是 cordis 的 `ctx`，不是这个 `rt`。ds-bot 没有 `ctx.set(...)` 任何服务（`grep -n "ctx.set(\|ctx.provide(" src/host/*.js` 零命中），所以没有任何公开通道能摸到 `rt`。

**这就是那一行**：

```js
  // dsbot-remote 的唯一接缝
  ctx.provide('bot', rt)
  for (const module of MODULES) module.install(rt)
```

`ctx.provide('bot', rt)` 把运行时挂成 cordis 服务，外部插件写 `inject: ['llm', 'bot']` 就能在 `apply(ctx)` 里拿到 `ctx.bot`。这是 cordis 的标准扩展方式（`LlmRuntime` 也是这么把 `ctx.llm` 挂出来的）。

## 顺带纠正一个我自己犯的错

前面的版本里 `dsbot-nodes` 导出的是 `export function install(rt)`——那是我照着 ds-bot 内部模块的接口写的，**DSH 根本不调 `install`**。cordis 找的是 `apply`。所以那个版本即使装进 profile 也不会被加载，只会静默什么都不发生。

现在导出：

```js
export const inject = ['llm', 'bot']
export function apply(ctx, config = {}) { install(ctx.bot) }
export default { name, inject, apply }
```

`install(rt)` 保留为内部实现与测试入口。

## 一行之外，还依赖三处数据形状

不改代码不等于没有耦合。这三处变了我们会坏：

1. **`bot.model` 的写法**必须是 `provider/model`。`models.js:340 applyModel` 用 `splitRef` 拆，`models.js:251 resolveModel` 拿 `entry.ref` 全等匹配。所以 adapter 的 `listModels` 返回 `{provider: route, id: 'default'}`，`providerInfo(route).id` 必须等于 route。
2. **`room.members` 是 bot id 数组**，不是对象数组。
3. **`rt.createBot({pickModel:true})` 会留下 `bot.kickoff`**（"你好，我刚被造出来"）。代理 Bot 不该有这句，`bind.js` 里 `delete bot.kickoff`。

## 升级 ds-bot 之后

那一行会被覆盖。做完升级要重新加，然后跑：

```bash
node --test packages/dsbot-nodes/test/bind.test.js   # bot.model / room.members
node packages/dsbot-nodes/probe-contract.mjs          # chunk 契约
node packages/dsbot-nodes/probe-install.mjs           # apply(ctx) + ctx.bot
```

`probe-install.mjs` 会把 `ctx.provide('bot', rt)` 也做一遍，所以它同时也是"那一行还在不在"的检查。

## 什么时候需要改更多

- Settings → Nodes 页面：要 `node-*` 端点（`channel.js` 的 `switch`）
- 远端反向调主机：现在一律回 `node/unsupported`
- 远程自建群：v1 只允许加入已有群

## 与 `phone.js` 的关系

ds-bot 自带一条手机 App 的链路：手机只往外连 `wss://relay.dsbot.app/v1/link`，端到端加密，调同一批 `/api/bot` 端点。我们**没用它**：relay 服务端不在包里、设备角色校验未知；实测跨地区 `ping` 470ms、50% 丢包，一轮对话光往返就 2 秒以上。

v1 用 EasyTier / WireGuard 组网 + 自建 TCP 直连。两份代码互不干扰，状态文件也不同（`~/.dsh/bot/phone.json` vs `<home>/nodes.json`）。

## 升级 ds-bot 之后：那一行补丁会被冲掉

`ctx.provide('bot', rt)` 是 ds-bot 上游没有、由我们打上去的。**在 DS Bot 设置页点【更新】或 `pnpm update ds-bot` 会把 node_modules 换回原版，补丁消失**，症状是：

- 远程节点设置页显示「读不到状态: HTTP 404」「没在监听」，配对码是空的破折号；
- `~/.dsh/bot/nodes-boot.log` 里只有 `apply called` 和 `install deferred`，之后再没有 `deps ready`；
- 7777 端口没有监听（`hosting.start()` 根本没跑）。

现在用 pnpm 补丁固定住了（profile 目录）：

```yaml
# ~/.dsh/profiles/<profile>/pnpm-workspace.yaml
patchedDependencies:
  ds-bot@0.3.8: patches/ds-bot@0.3.8.patch
```

所以正常 `pnpm install` 会自动打回去。**唯一要管的是版本号**：升级到新版本（比如 0.3.9）时补丁文件对不上，需要重新生成：

```bash
cd ~/.dsh/profiles/<profile>
pnpm patch ds-bot@<新版本> --edit-dir .tmp-patch-ds-bot
# 在 .tmp-patch-ds-bot/index.js 的 createRuntime 里、return rt 之前加：
#   ctx.provide('bot', rt)
pnpm patch-commit .tmp-patch-ds-bot      # 会更新 pnpm-workspace.yaml + patches/
```

插件侧也加了兜底：装不上 45 秒后会往 nodes-boot.log 写一句「等不到 bot 服务」，指明是这行补丁。

## 从 GitHub 装：线协议为什么并进了插件

这个插件要能"粘仓库地址就装"（`…/dsbot-remote#path:/packages/dsbot-nodes`）。
为此线协议原来那个独立包 `@dsbot/node-protocol` 被**合进**
`packages/dsbot-nodes/src/protocol/`，插件现在 `"dependencies"` 是空的。

试过但不可行的两条路：

1. 子包依赖写 `file:../node-protocol` —— pnpm 会把 git 依赖的子目录先打成
   tarball 再装，tarball 里那条相对路径按**装机目录**解析（实测解析到
   `D:\Default\node-protocol`），报 `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`。
2. 改成 git 地址（`…/dsbot-remote#path:/packages/node-protocol`）—— pnpm 11
   默认开着 `blockExoticSubdeps`，子依赖里出现 git 说明符直接拒：
   `ERR_PNPM_EXOTIC_SUBDEP: Exotic dependency "@dsbot/node-protocol" (resolved via
   git-repository) is not allowed in subdependencies`。这个开关在**装机方**的 pnpm
   配置里，插件管不到。

所以现在只有一份实现：`packages/dsbot-nodes/src/protocol/`（`index.js` 汇总导出，
`transport/tcp.js` 与 `transport/discovery.js` 是传输层）。它的 34 个测试跟着搬到了
`packages/dsbot-nodes/test/protocol-*.test.js`，跑插件测试就一起跑。


## 两个 package.json：根是插件入口，子目录是同一份实现

- 根 `package.json`：`name: dsbot-remote`，`dsh.bundle.patch = ./cordis.patch.yml`，带 `dsh.client`，
  `exports` 指向 `packages/dsbot-nodes/*`，`files` 只打 `packages/dsbot-nodes` 与根上的补丁文件。
  「添加插件」里粘仓库地址时装的是它（tar 包约 166 KB）。
- `packages/dsbot-nodes/package.json`：`name: dsbot-nodes`，自带 `cordis.patch.yml`（`name: 'dsbot-nodes'`）。
  `#path:/packages/dsbot-nodes`、本地 `file:` 与 profile 的 symlink 用的是它。

两个 cordis 补丁各自写自己的包名 —— cordis 是按 `name` 去 node_modules 里 import 的，
名字对不上就只会在日志里留一句 entry not found，然后插件静悄悄不加载。
