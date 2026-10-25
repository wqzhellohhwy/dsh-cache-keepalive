/**
 * **时间门槛**的判定 —— 不需要网络、不花钱。
 *
 * 用户拍板的方案（2026-10-24）：
 * ```
 * since = now - max(上次真实对话, 上次保温)
 * since > idleLimitHours → 跳过（不管保没保过）
 * ```
 * **理由**：缓存刷新 = 真实对话 OR 保温，两者都算 ⇒ 判断「缓存还活着吗」就该看这一个 `since`。
 * ⚠️ **别再给「保过」另设更小的门槛**（曾经搞过 `refreshLimitHours`=3h，逻辑上说不通）。
 *
 * 跑法：`node --test tests/settings-limit.test.mjs`
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/store.ts'
import { effectiveLimitsOf } from '../src/core/gate-input.ts'
import { decideWarm } from '../src/gate.ts'

const HOUR = 3600_000
const MIN = 60_000

/** 最小 settings 对象。 */
const S = (over = {}) => ({ ...DEFAULT_SETTINGS, ...over })

// ── T1~T5：按 provider/model 自定义 ─────────────────────────────
test('T1：通用 idleLimitHours=6，模型无覆盖 → 用 6h', () => {
  const r = effectiveLimitsOf(S({ idleLimitHours: 6 }), 'p', 'm')
  assert.equal(r.idleLimitMs, 6 * HOUR)
  assert.equal(r.disabled, false)
})

test('T2：通用 6h，模型设 3h → 用 3h', () => {
  const r = effectiveLimitsOf(S({ idleLimitHours: 6, modelOverrides: { 'p/m': { idleLimitHours: 3 } } }), 'p', 'm')
  assert.equal(r.idleLimitMs, 3 * HOUR)
})

test('T3：模型设 0 → 该模型不保温（disabled）', () => {
  for (const ov of [{ idleLimitHours: 0 }, { intervalSeconds: 0 }]) {
    const r = effectiveLimitsOf(S({ modelOverrides: { 'p/m': ov } }), 'p', 'm')
    assert.equal(r.disabled, true, `覆盖 ${JSON.stringify(ov)} 应判 disabled`)
  }
})

test('T4：通用 interval=4h，模型设 1h → 用 1h', () => {
  const r = effectiveLimitsOf(S({ intervalSeconds: 4 * 3600, modelOverrides: { 'p/m': { intervalSeconds: 3600 } } }), 'p', 'm')
  assert.equal(r.intervalMs, 3600_000)
})

test('T5：模型留空（缺字段）→ 继承通用', () => {
  const r = effectiveLimitsOf(S({ idleLimitHours: 6, intervalSeconds: 4 * 3600, modelOverrides: { 'p/m': {} } }), 'p', 'm')
  assert.equal(r.idleLimitMs, 6 * HOUR)
  assert.equal(r.intervalMs, 4 * 3600_000)
})

test('T5b：只设一个字段 → 另一个继承通用', () => {
  const r = effectiveLimitsOf(S({ idleLimitHours: 6, intervalSeconds: 7200, modelOverrides: { 'p/m': { idleLimitHours: 2 } } }), 'p', 'm')
  assert.equal(r.idleLimitMs, 2 * HOUR, '设了的用模型的')
  assert.equal(r.intervalMs, 7200_000, '没设的继承通用')
})

test('T5c：provider/model 缺失 → 只用通用（不报错）', () => {
  const r = effectiveLimitsOf(S({ idleLimitHours: 6, modelOverrides: { 'p/m': { idleLimitHours: 1 } } }), undefined, undefined)
  assert.equal(r.idleLimitMs, 6 * HOUR)
})

// ── T6：旧 state.json 里的 refreshLimitHours 被忽略 ──────────────
test('T6：旧 state.json 有 refreshLimitHours → 加载不报错且有默认值', () => {
  const raw = { ...DEFAULT_SETTINGS, refreshLimitHours: 3 }
  const s = normalizeSettings(raw)
  assert.equal(s.refreshLimitHours, undefined, 'refreshLimitHours 必须被忽略（字段已删）')
  assert.equal(typeof s.idleLimitHours, 'number')
  assert.equal(s.idleLimitHours, 6, 'idleLimitHours 默认 6')
})

// ── T7/T8：同一个 idleLimitMs 管两种情形 ─────────────────────────
/** 最小 GateInput。 */
const gate = (over = {}) => ({
  now: 1000 * HOUR,
  agentStatus: 'idle',
  lastActivityAt: 1000 * HOUR - 3 * MIN,
  lastTouchAt: 0,
  touchCount: 0,
  touchCountTotal: 0,
  cumulativeCost: 0,
  tripped: false,
  hasRoute: true,
  intervalMs: 1 * HOUR,
  idleLimitMs: 6 * HOUR,
  freshMs: 0,
  maxTouches: 9,
  maxTouchesTotal: 0,
  budget: 100, // 足够大，避免 budget 拦住
  ...over,
})

test('T7：since > 6h → stale（不管保没保过）', () => {
  const now = 1000 * HOUR
  /** 保过的：上次保温 7h 前 */
  const warmed = decideWarm(gate({ now, lastTouchAt: now - 7 * HOUR, lastActivityAt: now - 7 * HOUR, touchCount: 1 }))
  assert.equal(warmed.ok, false)
  assert.equal(warmed.code, 'stale')
  /** 没保过的：闲置 7h → cold-window-idle（同一条线） */
  const cold = decideWarm(gate({ now, lastActivityAt: now - 7 * HOUR }))
  assert.equal(cold.ok, false)
  assert.equal(cold.code, 'cold-window-idle')
})

test('T8：since = 5h（< 6h 且过了间隔）→ 放行', () => {
  const now = 1000 * HOUR
  const d = decideWarm(gate({ now, lastTouchAt: now - 5 * HOUR, lastActivityAt: now - 5 * HOUR, touchCount: 1 }))
  assert.equal(d.ok, true)
})
