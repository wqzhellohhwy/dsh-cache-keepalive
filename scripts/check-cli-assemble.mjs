/**
 * 闸门：**全库装配 + 序列化能不能跑通**（离线、不联网、不花钱）。
 *
 * 对磁盘上每一个会话跑一遍 `assembleSession`，再跑一遍 `serializeForApi`，统计：
 *  - 成功 / 失败（失败会打印原因 —— 失败说明那条会话保不了，必须知道为什么）
 *  - **请求体形状**：每条消息的 role 合法、content 是数组、**每个块都有 `type`**
 *  - 未闭合 `tool_use` 的数量（> 0 会被 `repairUnclosedToolUse` 删掉，代价是断裂点之后失配）
 *  - 含位置替换（压缩/剪枝）的会话数、请求体规模分布
 *
 * ⚠️ 形状检查为什么必须有：曾经 `wire.ts` 把历史 system 快照当成 content 块塞进 content 数组，
 * 请求体变成 `{role:'system',content:[{role:'system',content:[…]}]}` —— 一直到真发请求才
 * 吃 422（`messages[3].content: missing field 'type'`）。这一步离线就能抓住。
 *
 * 退出码：有任何装配失败或形状异常 → 1。断裂与替换只报告，不算失败（它们是数据本身的状态）。
 *
 * 跑法：`node scripts/check-cli-assemble.mjs [--limit N] [--verbose]`
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { assembleSession } from '../src/core/assemble.ts'
import { serializeForApi } from '../src/core/wire.ts'

const argv = process.argv.slice(2)
const limitIdx = argv.indexOf('--limit')
const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) || 0 : 0
const verbose = argv.includes('--verbose')

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const sessionsRoot = join(home, 'sessions')
if (!existsSync(sessionsRoot)) {
  console.log('⚠️ 找不到会话目录', sessionsRoot, '—— 跳过（脱离部署且无历史日志时属正常）')
  process.exit(0)
}

const logs = []
for (const proj of readdirSync(sessionsRoot)) {
  let entries
  try { entries = readdirSync(join(sessionsRoot, proj)) } catch { continue }
  for (const name of entries) {
    const f = join(sessionsRoot, proj, name, 'session.v4.jsonl.zstd')
    try { logs.push({ f, m: statSync(f).mtimeMs, id: name }) } catch { /* 非 v4 */ }
  }
}
logs.sort((a, b) => b.m - a.m)
const targets = limit > 0 ? logs.slice(0, limit) : logs

const PROMPT = 'Reply with exactly: OK'
const ALLOWED_ROLES = new Set(['user', 'assistant', 'system'])
let ok = 0
let failed = 0
let withReplace = 0
let withRemovedCalls = 0
let totalRemoved = 0
let totalMessages = 0
let totalBytes = 0
let badShape = 0
const failures = []
const shapeProblems = []
const heaviest = []

/** 校验序列化后的请求体形状 —— 这一步能离线抓住 422。 */
function checkShape(body, id) {
  const problems = []
  if (!Array.isArray(body.messages)) {
    problems.push('messages 不是数组')
    return problems
  }
  body.messages.forEach((m, i) => {
    if (!ALLOWED_ROLES.has(m?.role)) problems.push(`messages[${i}].role=${JSON.stringify(m?.role)}`)
    if (!Array.isArray(m?.content)) {
      problems.push(`messages[${i}].content 不是数组`)
      return
    }
    m.content.forEach((b, k) => {
      if (b === null || typeof b !== 'object') problems.push(`messages[${i}].content[${k}] 不是对象`)
      else if (typeof b.type !== 'string') problems.push(`messages[${i}].content[${k}] 缺 type`)
    })
  })
  if (typeof body.model !== 'string') problems.push('model 缺失')
  if (typeof body.max_tokens !== 'number') problems.push('max_tokens 缺失')
  return problems.map((p) => `${id}: ${p}`)
}

for (const { f, id } of targets) {
  let result
  try {
    result = assembleSession(f, PROMPT)
  } catch (e) {
    failed += 1
    failures.push(`${id}: 装配抛错 ${String(e?.message ?? e)}`)
    continue
  }
  if (result.error !== undefined) {
    failed += 1
    failures.push(`${id}: ${result.error}`)
    continue
  }
  ok += 1
  totalMessages += result.stats.messages
  if (result.stats.replacements > 0) withReplace += 1
  if (result.stats.removedToolCalls > 0) {
    withRemovedCalls += 1
    totalRemoved += result.stats.removedToolCalls
  }

  // 序列化 + 形状校验
  let body
  try {
    body = serializeForApi(result.messages, {
      model: result.config?.model ?? 'deepseek-flash',
      maxTokens: 1,
      ...(result.system === undefined ? {} : { system: result.system }),
      ...(result.tools.length === 0 ? {} : { tools: result.tools, declaredNames: new Set(result.tools.map((t) => t.name)) }),
      ...(result.config?.reasoningEffort === undefined ? {} : { reasoningEffort: result.config.reasoningEffort }),
    })
  } catch (e) {
    badShape += 1
    shapeProblems.push(`${id}: 序列化抛错 ${String(e?.message ?? e)}`)
    continue
  }
  const problems = checkShape(body, id)
  if (problems.length > 0) {
    badShape += 1
    shapeProblems.push(...problems.slice(0, 3))
  }

  const bytes = JSON.stringify(body).length
  totalBytes += bytes
  heaviest.push({ id, bytes, messages: result.stats.messages, replacements: result.stats.replacements })
}

heaviest.sort((a, b) => b.bytes - a.bytes)

console.log(`会话总数: ${targets.length}`)
console.log(`① 装配成功: ${ok}   失败: ${failed}`)
console.log(`② 序列化形状异常: ${badShape}`)
console.log(`③ 含位置替换（压缩/剪枝）: ${withReplace}`)
console.log(`④ 含未闭合 tool_use 的会话: ${withRemovedCalls}   合计删除块数: ${totalRemoved}`)
console.log(`⑤ 平均消息数: ${ok > 0 ? Math.round(totalMessages / ok) : 0}   `
  + `平均请求体: ${ok > 0 ? (totalBytes / ok / 1048576).toFixed(2) : '0'} MB   `
  + `合计: ${(totalBytes / 1048576).toFixed(1)} MB`)

if (verbose && heaviest.length > 0) {
  console.log('')
  console.log('最大的 5 条：')
  for (const h of heaviest.slice(0, 5)) {
    console.log(`   ${String(h.id).slice(-12)}  ${(h.bytes / 1048576).toFixed(2)} MB  ${h.messages} 条消息  replace ${h.replacements}`)
  }
}

const problems = [...failures.map((x) => '装配失败 ' + x), ...shapeProblems]
if (problems.length > 0) {
  console.log('')
  console.log(`❌ ${problems.length} 个问题：`)
  for (const x of problems.slice(0, 15)) console.log('   ' + x)
  if (problems.length > 15) console.log(`   …还有 ${problems.length - 15} 条`)
  process.exit(1)
}
console.log('')
console.log('✅ 全部会话都能离线装配且请求体形状合法')
process.exit(0)
