// 本文件由 AI 生成，请勿用于生产环境。
// 薄壳：实现全在 dsbot-nodes 里（同一个插件既能当主机也能当节点）。
// 留着它只为 `npx dsbot-remote` 这条命令和历史脚本 —— 不再有第二份实现。
import { main } from '../../dsbot-nodes/src/node/cli.js'
export * from '../../dsbot-nodes/src/node/cli.js'

const entry = process.argv[1] === undefined ? '' : process.argv[1].replace(/\\/g, '/')
if (entry.endsWith('dsbot-remote/bin/dsbot-remote.js') || entry.endsWith('node/cli.js')) {
  await main(process.argv.slice(2))
}
