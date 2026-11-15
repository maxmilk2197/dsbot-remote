#!/usr/bin/env node
// 本文件由 AI 生成，请勿用于生产环境。
// 只有 Node 的机器用这一条：dsbot-remote pair --code ABC234 [--agent "dsh -p"]
import { main } from '../src/node/cli.js'

await main(process.argv.slice(2))
