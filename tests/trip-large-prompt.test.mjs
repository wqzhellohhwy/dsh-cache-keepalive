/**
 * **大上下文熔断判定**：`tripVerdict` 的 `recovering` 状态。
 *
 * 背景（实测 `ba6eb37a`）：DeepSeek 的缓存覆盖按 **128K token 块**推进 ——
 * 两次保温 body 逐字节相同，命中从 266,240 涨到 394,240（增量 128,000），
 * 命中率 37.3% → 55.2%，**单点判据会把这条会话判成 tripped 并永久停保**，
 * 于是缓存永远长不回来（用户看到的就是 1.54% 被拉黑）。
 *
 * 判据分档：`prompt ≥ LARGE_PROMPT_TOKENS` 才看趋势；短会话保持严格单点。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LARGE_PROMPT_TOKENS, isTripped, tripVerdict } from '../src/store.ts'

const TH = 0.5
/** 高阈值场景：两条都低于它，但命中在上升 —— 这才是被单点判据冤枉的情形。 */
const TH_HIGH = 0.8

/** 一条自洽的账本条目：hit + miss + write === prompt。 */
const e = (over = {}) => ({
  at: 1_700_000_000_000,
  gapSeconds: 0, promptTokens: 0, hitTokens: 0, missTokens: 0, outputTokens: 1,
  cost: 0, hitRate: 0, ms: 1, touch: 1, cacheWriteTokens: 0, ...over,
})

/** 按 hit / miss 造一条（prompt 自动算，hitRate 自动算）。 */
const mk = (hit, miss, extra = {}) => {
  const prompt = hit + miss
  return e({ hitTokens: hit, missTokens: miss, promptTokens: prompt, hitRate: prompt === 0 ? 0 : hit / prompt, ...extra })
}

const stateOf = (ledger) => ({
  version: 1,
  settings: { ...DEFAULT },
  sessions: {}, pinnedSessions: [],
  ledger: { s: ledger },
})

const DEFAULT = {
  autoEnabled: false, autoCount: 2, autoCountSubagent: 0, autoAllowSubagent: false,
  intervalSeconds: 14400, idleLimitHours: 6, freshSeconds: 300,
  maxTouches: 9, maxTouchesTotal: 0, budgetPerSession: 0.5,
  prices: { hit: 0.02, miss: 1, out: 4 }, pricesByModel: {}, tariff: { enabled: false },
  circuitHitRate: 0.5,
}

test('大 prompt + 命中单调上升 → recovering（不熔断）', () => {
  /** 实测序列：266,240 → 394,240（+128,000，DeepSeek 一块） */
  const a = mk(266_240, 447_556)
  const b = mk(394_240, 319_556)
  assert.ok(a.promptTokens >= LARGE_PROMPT_TOKENS, '前提：这是大 prompt 会话')
  assert.equal(tripVerdict(stateOf([a, b]), 's', TH_HIGH), 'recovering')
  assert.equal(isTripped(stateOf([a, b]), 's', TH_HIGH), false, 'recovering 不算熔断')
})

test('大 prompt + 命中不升 → 仍 tripped（装配真坏的情况别放过）', () => {
  const a = mk(394_240, 319_556)
  const b = mk(350_000, 363_796)
  assert.equal(tripVerdict(stateOf([a, b]), 's', TH_HIGH), 'tripped')
})

test('大 prompt + 命中涨得太少（< 已命中的 10%）→ 仍 tripped（抖动不算趋势）', () => {
  const a = mk(394_240, 319_556)
  const b = mk(394_500, 319_296)
  assert.equal(tripVerdict(stateOf([a, b]), 's', TH_HIGH), 'tripped')
})

test('大 prompt + 只涨一块但不足 10% → 仍 tripped（增量太小）', () => {
  /** a = 100,000，涨 1,024（一块）但不足 10% → 不算趋势 */
  const a = mk(100_000, 200_000)
  const b = mk(101_024, 198_976)
  assert.ok(a.promptTokens >= LARGE_PROMPT_TOKENS)
  assert.equal(tripVerdict(stateOf([a, b]), 's', TH), 'tripped')
})

test('**短会话不放宽**：prompt 远小于分档线时，命中大涨也照旧 tripped', () => {
  /** 10,000 token 的会话：一次就能填满，命中从 500 涨到 800（+60%）不该被当成「在恢复」 */
  const a = mk(500, 9_500)
  const b = mk(800, 9_200)
  assert.ok(b.promptTokens < LARGE_PROMPT_TOKENS)
  assert.equal(tripVerdict(stateOf([a, b]), 's', TH), 'tripped', '短会话必须保持严格单点判据')
})

test('大 prompt + 命中率高 → ok（原有判据不受影响）', () => {
  const a = mk(266_240, 447_556)
  const b = mk(700_544, 181)
  assert.equal(tripVerdict(stateOf([a, b]), 's', TH), 'ok')
})

test('大 prompt + 只有一条账本 → 没有对照物，仍 tripped', () => {
  const only = mk(266_240, 447_556)
  assert.equal(tripVerdict(stateOf([only]), 's', TH), 'tripped')
})

test('大 prompt + cacheUnknown → ok（提供方没报命中数时不猜）', () => {
  const only = e({ hitTokens: 0, missTokens: 713_796, promptTokens: 713_796, hitRate: 0, cacheUnknown: true })
  assert.equal(tripVerdict(stateOf([only]), 's', TH), 'ok')
})

test('换模型仍优先于趋势（换池子不是「在恢复」）', () => {
  const a = mk(266_240, 447_556, { model: 'm-old' })
  const b = mk(394_240, 319_556, { model: 'm-new' })
  assert.equal(tripVerdict(stateOf([a, b]), 's', TH_HIGH), 'model-changed')
})
