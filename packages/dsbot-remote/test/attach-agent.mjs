// 假模型：说一句话，然后用 `@@attach` 指一个真实文件。
// 用来验证"远端把文件带回来"这条链——不需要真的模型。
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const prompt = Buffer.concat(chunks).toString('utf8')
const target = process.env.ATTACH_TARGET ?? ''

process.stdout.write('好了，文件在这。')
await new Promise(resolve => setTimeout(resolve, 30))
process.stdout.write(`\n\n@@attach ${target}\n`)
