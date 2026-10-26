/**
 * **`delayMs` 必须有生产者，否则「CLI 晚 2 分钟」是空转。**
 *
 * 背景：`gate.ts` 读 `input.delayMs`（主会话门槛延后、子代理不吃），`gate-input.ts:220`
 * 是纯管道，但 2026-10-26 之前 **src 与 cli 侧都没有任何地方产出它** ——
 * `WARM_DELAY_MS` 在 cli 里 0 命中，现役对齐机制是 `loopAnchorDelayMs()`（`cli:403`，`LOOP_OFFSET_MS=90s`）。
 * 现在 cli 的 `gateInputForRow()` 把它接上了（`delayMs: LOOP_OFFSET_MS`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildGateInput } from '../src/core/gate-input.ts'
import { decideWarm } from '../src/gate.ts'
import { loadState } from '../src/store.ts'

const CLI = readFileSync(new URL('../cli/keepalive.mjs', import.meta.url), 'utf8')
const NOW = 1_700_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN

function stateOf() {
  const st = loadState('C:/definitely/not/here/state.json')
  Object.assign(st.settings, { intervalSeconds: 4 * 3600, idleLimitHours: 8, freshSeconds: 300 })
  return st
}

test('CLI 路径有生产者：gateInputForRow 里必须传 delayMs: LOOP_OFFSET_MS', () => {
  const at = CLI.indexOf('function gateInputForRow')
  assert.ok(at > 0, '找不到 gateInputForRow')
  const body = CLI.slice(at, at + 900)
  assert.ok(/delayMs:\s*LOOP_OFFSET_MS/u.test(body), 'gateInputForRow 必须把 LOOP_OFFSET_MS 作为 delayMs 传下去')
  const def = CLI.match(/const LOOP_OFFSET_MS = (\d[\d_]*)/u)
  assert.ok(def !== null, 'LOOP_OFFSET_MS 常量必须存在')
  const val = Number(def[1].replace(/_/g, ''))
  assert.equal(val, 90_000, 'LOOP_OFFSET_MS 应为 90 秒（插件上一拍 + 90s）')
})

test('管道通：buildGateInput 收到 delayMs 后原样带出（非 undefined）', () => {
  const st = stateOf()
  const g = buildGateInput(st, {
    id: 's', mtime: NOW - 4 * HOUR - MIN, hasRoute: true, tripped: false,
    lastActivityAt: NOW - 4 * HOUR - MIN, at: NOW, delayMs: 90_000,
  })
  assert.equal(g.delayMs, 90_000, 'delayMs 必须被管道带出')
})

test('行为：主会话带 90s 延后 → 门槛点后移；子代理不吃这段延后', () => {
  const st = stateOf()
  /** 距活动 4h01m：无延后应放行，带 90s 延后应仍在等 */
  const base = { id: 's', mtime: NOW - (4 * HOUR + MIN), hasRoute: true, tripped: false, lastActivityAt: NOW - (4 * HOUR + MIN), at: NOW }
  assert.equal(decideWarm(buildGateInput(st, { ...base, delayMs: 0 })).ok, true, '无延后：4h01m 应放行')
  const delayed = decideWarm(buildGateInput(st, { ...base, delayMs: 90_000 }))
  assert.equal(delayed.ok, false, '带 90s 延后：4h01m 还在等')
  assert.equal(delayed.code, 'too-soon')
  /** 子代理不吃延后（B5b 语义）：同一时刻应放行 */
  const sub = decideWarm(buildGateInput(st, { ...base, delayMs: 90_000, isSubagent: true }))
  assert.equal(sub.ok, true, '子代理不吃网页版/CLI 延后，过线即放行')
})
