#!/usr/bin/env node
/**
 * **假 OpenAI 兼容网关**：把 DSH 真实发出的请求体原样录下来，回一个合法的最小响应。
 *
 * ## 为什么需要它（与 `scripts/fetchspy.mjs` 并存）
 * | | fetchspy | 假网关 |
 * |---|---|---|
 * | 改 DSH 代码路径 | 包装 `globalThis.fetch`（有干扰风险） | **不改**，只改 profile 的 `baseURL` |
 * | 计费 | 真实请求照发 | **零计费**（回假响应） |
 * | 落盘内容 | 经脱敏 | **完全原样**（可逐字节 diff） |
 *
 * ## 与知识库那份 `mock-gateway.cjs` 的区别
 * 那份**只回 SSE**。而**保温请求是 `stream:false`**，收到 `text/event-stream` 会解析失败。
 * 这里按请求里的 `stream` 字段分别回：
 * - `stream: true` → SSE（`data: {...}` 逐块 + `data: [DONE]`）
 * - 否则 → 普通 JSON `{choices:[{message:{content:'OK'}}], usage:{...}}`
 *
 * ## 用法
 * ```
 * node scripts/mock-gateway.mjs [--port 18888] [--out <dir>] [--quiet]
 * ```
 * 产出：`<out>/mock-<端口>.jsonl`，每行 `{url, method, body, at, stream}`
 * （`out` 默认 `<cwd>/.tmp/mock-<端口>/`）。**不脱敏** —— 这是取证工具，不是日志工具，
 * 所以只用于**临时 profile + 假 key** 的场景，别拿它去接真实 provider。
 *
 * 退出：`Ctrl+C`；端口占用会直接报错退出（code 1）。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1]
  const eq = argv.find((a) => a.startsWith(name + '='))
  return eq === undefined ? fallback : eq.slice(name.length + 1)
}
const port = Number(argOf('--port', '18888'))
const quiet = argv.includes('--quiet')
const outDir = resolve(argOf('--out', join(process.cwd(), '.tmp', `mock-${port}`)))
const logFile = join(outDir, `mock-${port}.jsonl`)

mkdirSync(outDir, { recursive: true })

const say = (s) => {
  if (!quiet) process.stdout.write(s + '\n')
}

/**
 * 一次请求的最小合法 usage。
 * 保温只要 `prompt_tokens` 非零就够（`warm-offline.ts` 用它算命中率）；
 * 给个固定值即可 —— 假网关的 usage 数字本来就不代表任何真实 token 数。
 */
const usageOf = () => ({ prompt_tokens: 1024, completion_tokens: 1, total_tokens: 1025 })

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => {
    body += c
  })
  req.on('end', () => {
    let parsed = {}
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = {}
    }
    const wantsStream = parsed?.stream === true
    /** **先落盘再回包**：即使后面回包出错，请求体也已经在文件里了。 */
    try {
      appendFileSync(logFile, JSON.stringify({
        url: req.url,
        method: req.method,
        stream: wantsStream,
        at: new Date().toISOString(),
        bytes: body.length,
        body,
      }) + '\n', 'utf8')
    } catch (e) {
      say(`[mock] 写日志失败：${String(e?.message ?? e)}`)
    }
    say(`[mock] ${req.method} ${req.url} ${wantsStream ? 'stream' : 'json'} ${body.length}B`)

    if (req.method !== 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
      return
    }
    const model = parsed?.model ?? 'mock-model'
    const usage = usageOf(parsed)

    if (!wantsStream) {
      /** **非流式**：保温请求走这条（`warmOffline` 会 `body.stream = false`）。 */
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'mock-cmpl',
        object: 'chat.completion',
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage,
      }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n')
    send({ id: 'mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })
    send({ id: 'mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

server.on('error', (e) => {
  process.stderr.write(`[mock] 启动失败：${String(e?.message ?? e)}\n`)
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  say(`[mock] 监听 http://127.0.0.1:${port}/v1`)
  say(`[mock] 记录到 ${logFile}`)
  say('[mock] ⚠️ 不脱敏：只用于临时 profile + 假 key，别接真实 provider')
})
