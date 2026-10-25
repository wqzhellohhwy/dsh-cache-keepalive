/**
 * 真实数据自检：拿磁盘上的真实会话日志验证「按轮聚合」与「按模型/时段计价」。
 * 不连 DSH、不发请求、不花钱。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readRounds, sumByTurn } from '../src/core/sessions.ts'
import { DEFAULT_PRICES, DEFAULT_TARIFF, effectivePrices, normalizeTariff, priceForModel } from '../src/econ.ts'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const root = join(home, 'sessions')

/** 收集全部会话日志，按 mtime 倒序取前 6 条。 */
const logs = []
for (const proj of readdirSync(root)) {
  let entries
  try { entries = readdirSync(join(root, proj)) } catch { continue }
  for (const name of entries) {
    const f = join(root, proj, name, 'session.v4.jsonl.zstd')
    try { logs.push({ f, m: statSync(f).mtimeMs }) } catch { /* 非 v4 */ }
  }
}
logs.sort((a, b) => b.m - a.m)
const top = logs.slice(0, 6)

let fail = 0
const say = (ok, msg) => { if (!ok) fail += 1; console.log((ok ? 'PASS  ' : 'FAIL  ') + msg) }

console.log(`磁盘会话日志共 ${logs.length} 个，抽最近 ${top.length} 个\n`)
for (const { f } of top) {
  const rounds = readRounds(f)
  if (rounds.length === 0) { console.log(`SKIP  ${f.split(/[\\/]/).slice(-2)[0]}（没有 usage 记录）`); continue }
  const turns = sumByTurn(rounds)
  const sum = (arr, k) => arr.reduce((s, x) => s + x[k], 0)
  const short = f.split(/[\\/]/).slice(-2)[0].slice(-12)
  const modelList = [...new Set(rounds.map((r) => r.model).filter((x) => x !== ''))]
  say(sum(turns, 'hitTokens') === sum(rounds, 'hitTokens'), `${short} 命中 token 合计一致（${sum(rounds, 'hitTokens')}）`)
  say(sum(turns, 'missTokens') === sum(rounds, 'missTokens'), `${short} 未命中 token 合计一致`)
  say(sum(turns, 'outputTokens') === sum(rounds, 'outputTokens'), `${short} 输出 token 合计一致`)
  say(turns.length <= rounds.length && turns.length > 0, `${short} 轮数 ${turns.length} ≤ 调用数 ${rounds.length}`)
  say(new Set(turns.map((t) => t.turn)).size === turns.length, `${short} 每轮只出现一次（聚合无重复）`)
  // 时间必须单调不减，否则时间轴会乱序
  let mono = true
  for (let i = 1; i < turns.length; i += 1) if (turns[i].time < turns[i - 1].time) mono = false
  say(mono, `${short} 聚合后按时间单调递增`)
  let multiStep = 0
  for (const t of turns) if (t.steps > 1) multiStep += 1
  console.log(`      ${short}: ${rounds.length} 次调用 → ${turns.length} 轮（其中 ${multiStep} 轮有多步），模型 ${modelList.join(',') || '（空）'}`)
}

// 模型价表在这些真实模型名上能不能命中
const seen = new Set()
for (const { f } of top) for (const r of readRounds(f)) if (r.model !== '') seen.add(r.model)
console.log(`\n真实模型名：${[...seen].join(', ') || '（无）'}`)
if (seen.size > 0) {
  // 表里的值必须与基准价**都不同**，否则「回落基准价」会被误判成「命中」
  const table = { 'deepseek-flash': { hit: 0.02, miss: 7, out: 9 } }
  for (const m of seen) {
    const hit = priceForModel(m, table, DEFAULT_PRICES).miss === 7
    console.log(`      ${m} → ${hit ? '命中模型价表' : '回落基准价'}`)
  }
}

// 时段表：一天 24 小时里高峰/空闲各占几小时
const t = normalizeTariff({ ...DEFAULT_TARIFF, enabled: true })
let peakMin = 0
for (let i = 0; i < 24 * 60; i += 1) {
  const ts = Date.UTC(2026, 9, 11, 0, 0) + i * 60_000
  const p = effectivePrices(DEFAULT_PRICES, 'deepseek-flash', {}, t, ts)
  if (p.factor === 2) peakMin += 1
}
say(peakMin === 16 * 60, `默认时段表：高峰占 ${peakMin / 60} 小时（应 16）`)
say(24 * 60 - peakMin === 8 * 60, `默认时段表：空闲占 ${(24 * 60 - peakMin) / 60} 小时（应 8）`)

console.log('')
console.log(fail === 0 ? '✅ 真实数据自检全绿' : `❌ ${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
