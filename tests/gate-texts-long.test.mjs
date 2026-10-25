/**
 * 门禁文案「长闲置二档」单测 —— 纯函数，不联网、不写盘、不碰用户 state.json。
 * 跑法：`node --test tests/gate-texts-long.test.mjs`
 */
import { decideWarm } from '../src/gate.ts'
import {
  GATE_TEXTS, GATE_TEXTS_BY_KEY, LONG_IDLE_MINUTES, LONG_IDLE_MS,
  gateDetailOf, gateTextOf, hasLongTier,
} from '../src/core/gate-texts.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const NOW = 1_000 * HOUR

/** 门禁输入基线：一切正常，只是把闲置拉到指定分钟数。 */
function idleInput(idleMinutes, over = {}) {
  const idleMs = idleMinutes * MIN
  return {
    now: NOW,
    agentStatus: 'idle',
    lastActivityAt: NOW - idleMs,
    lastTouchAt: 0,
    touchCount: 0,
    touchCountTotal: 0,
    cumulativeCost: 0,
    tripped: false,
    hasRoute: true,
    intervalMs: 4 * HOUR,
    idleLimitMs: 8 * HOUR,
    freshMs: 5 * MIN,
    maxTouches: 9,
    maxTouchesTotal: 0,
    budget: 0.5,
    ...over,
  }
}

/** 保过的会话：距最后刷新指定分钟数 → 走 stale 分支。 */
function staleInput(idleMinutes) {
  const idleMs = idleMinutes * MIN
  return idleInput(idleMinutes, { lastTouchAt: NOW - idleMs, lastActivityAt: NOW - idleMs, touchCount: 1 })
}

const cases = []

cases.push(['LONG_IDLE_MINUTES === 9999 且 LONG_IDLE_MS 一致', () => {
  return LONG_IDLE_MINUTES === 9999 && LONG_IDLE_MS === 9999 * 60_000
}])

cases.push(['★ 边界：闲置 9999 分钟 → 常规档（long 不为 true）', () => {
  const d = decideWarm(idleInput(9999))
  return d.ok === false && d.code === 'cold-window-idle' && d.long !== true
}])

cases.push(['★ 边界：闲置 10000 分钟 → 长档（long === true）', () => {
  const d = decideWarm(idleInput(10000))
  return d.ok === false && d.code === 'cold-window-idle' && d.long === true
}])

cases.push(['★ stale 边界：距最后刷新 9999 分钟 → 常规；10000 分钟 → 长档', () => {
  const a = decideWarm(staleInput(9999))
  const b = decideWarm(staleInput(10000))
  return a.code === 'stale' && a.long !== true && b.code === 'stale' && b.long === true
}])

cases.push(['★ cold-window-idle 长档状态词与常规档不同', () => {
  const def = GATE_TEXTS_BY_KEY['cold-window-idle']
  return def !== undefined && hasLongTier(def) === true
    && gateTextOf(def, false) !== gateTextOf(def, true)
    && gateTextOf(def, true) === (def.textLong ?? def.text)
}])

cases.push(['★ stale 长档默认状态词 = 「断档过久」', () => {
  const def = GATE_TEXTS_BY_KEY['stale']
  return def !== undefined && gateTextOf(def, true) === '断档过久'
}])

cases.push(['★ 覆盖 {"stale:long": "自定义长档"} → 长档取自定义，常规档不受影响', () => {
  const def = GATE_TEXTS_BY_KEY['stale']
  const ov = { 'stale:long': '自定义长档' }
  return gateTextOf(def, true, ov) === '自定义长档'
    && gateTextOf(def, false, ov) === def.text
    && gateDetailOf(def, true, ov) === '自定义长档'
}])

cases.push(['★ 只覆盖 {"stale": "自定义常规"} → 长档**不回退**到自定义常规，取 textLong 默认', () => {
  const def = GATE_TEXTS_BY_KEY['stale']
  const ov = { stale: '自定义常规' }
  return gateTextOf(def, false, ov) === '自定义常规'
    && gateTextOf(def, true, ov) === (def.textLong ?? def.text)
    && gateTextOf(def, true, ov) !== '自定义常规'
}])

cases.push(['无长档的门禁码：long 档复用常规默认（textLong 未定义）', () => {
  const def = GATE_TEXTS_BY_KEY['budget']
  return def !== undefined && hasLongTier(def) === false
    && gateTextOf(def, true) === def.text
    && gateDetailOf(def, true) === def.detail
}])

cases.push(['每个门禁码都有 text / detail，key 唯一（面板逐项渲染的前提）', () => {
  const keys = GATE_TEXTS.map((d) => d.key)
  return new Set(keys).size === keys.length
    && GATE_TEXTS.every((d) => typeof d.text === 'string' && d.text !== '' && typeof d.detail === 'string')
}])

cases.push(['长档说明不报具体数字（5 位以上）且不残留占位符', () => {
  const one = (d) => d.ok === false && !d.detail.includes('{') && !/\d{5,}/.test(d.detail)
  return one(decideWarm(idleInput(10000))) && one(decideWarm(staleInput(10000)))
}])

let pass = 0
let fail = 0
const lines = []
for (const [name, fn] of cases) {
  let ok = false
  try {
    ok = fn() === true
  } catch (e) {
    lines.push(`     抛错：${e instanceof Error ? e.message : String(e)}`)
  }
  if (ok) pass++
  else fail++
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

console.log('=== 门禁文案长档测试 ===')
console.log(lines.join('\n'))
console.log('')
console.log(`通过 ${pass} / ${cases.length}` + (fail > 0 ? `   ❌ 失败 ${fail}` : '   ✅ 全绿'))
process.exit(fail > 0 ? 1 : 0)
