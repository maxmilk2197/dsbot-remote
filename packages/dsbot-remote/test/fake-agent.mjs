// 一个假模型：把 prompt 原样读进来，分两段吐出去。
// 用来验证"远端 turn 的 stdout 会变成主机的流式文本"，不依赖任何真模型。
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  const head = input.trim().slice(0, 40)
  process.stdout.write(`收到了 ${input.length} 字。`)
  setTimeout(() => process.stdout.write(`开头是「${head}」`), 40)
})
