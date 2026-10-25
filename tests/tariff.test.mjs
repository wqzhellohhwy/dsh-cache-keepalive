/**
 * 峰谷时段表 / 节假日表的行为锁定 —— 不需要网络、不花钱。
 *
 * 用户关心的三个问题，每条都有用例：
 * 1. 默认时段是**两段高峰**（8:30-12:00、14:30-18:00），其余空闲
 * 2. `enabled=false` → 一律基准价
 * 3. **空 slots / 时段没覆盖某时刻 → 静默按 1.0 倍**（安全降级，不是报错、不崩）
 *
 * 跑法：`node --test tests/tariff.test.mjs`
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  costAt,
  DEFAULT_PRICES,
  DEFAULT_TARIFF,
  effectivePrices,
  tariffFactorAt,
  tariffSlotAt,
} from '../src/econ.ts'

/** Asia/Shanghai = UTC+8；2026-10-24 是周六（避开工时外的节假日）。 */
const at = (h, m) => Date.UTC(2026, 9, 24, h - 8, m, 0)
const on = { ...DEFAULT_TARIFF, enabled: true }
const noTable = {}
const noHoliday = { ...on, holidays: [] }

test('T1：默认 slots 是 5 段（两段高峰 + 三段空闲）', () => {
  assert.equal(DEFAULT_TARIFF.slots.length, 5)
  assert.deepEqual(DEFAULT_TARIFF.slots.map((s) => s.from + '-' + s.to), [
    '00:30-08:30', '08:30-12:00', '12:00-14:30', '14:30-18:00', '18:00-00:30',
  ])
  assert.deepEqual(DEFAULT_TARIFF.slots.map((s) => s.factor), [1, 2, 1, 2, 1])
})

test('T2：高峰1 的边界（08:30 进、12:00 出）', () => {
  assert.equal(tariffSlotAt(noHoliday, at(8, 29)).slot?.factor ?? 1, 1)
  assert.equal(tariffSlotAt(noHoliday, at(8, 30)).slot?.factor, 2)
  assert.equal(tariffSlotAt(noHoliday, at(11, 59)).slot?.factor, 2)
  assert.equal(tariffSlotAt(noHoliday, at(12, 0)).slot?.factor, 1)
})

test('T3：高峰2 的边界（14:30 进、18:00 出）', () => {
  assert.equal(tariffSlotAt(noHoliday, at(14, 29)).slot?.factor ?? 1, 1)
  assert.equal(tariffSlotAt(noHoliday, at(14, 30)).slot?.factor, 2)
  assert.equal(tariffSlotAt(noHoliday, at(17, 59)).slot?.factor, 2)
  assert.equal(tariffSlotAt(noHoliday, at(18, 0)).slot?.factor, 1)
})

test('T4：跨零点那段（18:00-00:30）在两侧都命中', () => {
  assert.equal(tariffSlotAt(noHoliday, at(23, 59)).slot?.id, 'off-peak-3')
  assert.equal(tariffSlotAt(noHoliday, at(0, 0)).slot?.id, 'off-peak-3')
  assert.equal(tariffSlotAt(noHoliday, at(0, 29)).slot?.id, 'off-peak-3')
  /** 00:30 已进入第一段空闲（另一个 slot），factor 相同但 id 不同 */
  assert.equal(tariffSlotAt(noHoliday, at(0, 30)).slot?.id, 'off-peak-1')
})

test('T5：**空 slots → 静默按 1.0 倍**（安全降级，不报错不崩）', () => {
  const r = tariffFactorAt({ ...on, slots: [] }, at(10, 0))
  assert.equal(r.factor, 1)
  assert.equal(r.label, '基准')
})

test('T6：**时段没覆盖某时刻 → 静默按 1.0 倍**', () => {
  /** 只留高峰1，10:00 命中；20:00 没被任何时段覆盖。 */
  const only = { ...on, holidays: [], slots: [{ id: 'p1', label: '高峰1', from: '08:30', to: '12:00', factor: 2 }] }
  assert.equal(tariffFactorAt(only, at(10, 0)).factor, 2)
  assert.equal(tariffFactorAt(only, at(20, 0)).factor, 1, '未覆盖时段按 1.0')
})

test('T7：`enabled=false` → 一律基准价（走成本函数验证）', () => {
  const off = { ...DEFAULT_TARIFF, enabled: false }
  const r = costAt({ inputTokens: 1_000_000 }, DEFAULT_PRICES, 'm', noTable, off, at(10, 0))
  assert.equal(r.factor, 1)
  assert.equal(r.label, '基准')
})

test('T8：`enabled=true` 且 10:00 → 成本用 2 倍（走成本函数验证）', () => {
  const p = effectivePrices(DEFAULT_PRICES, 'm', noTable, noHoliday, at(10, 0))
  assert.equal(p.factor, 2)
  assert.equal(p.label, '高峰时段1')
  assert.equal(p.prices.miss, DEFAULT_PRICES.miss * 2)
})

test('T9：节假日覆盖时段、不叠乘', () => {
  const t = {
    ...on,
    holidayEnabled: true,
    holidayFactor: 0.5,
    holidays: [{ date: '10-24', name: '测试节' }],
  }
  const r = tariffFactorAt(t, at(10, 0))
  assert.equal(r.factor, 0.5, '节假日覆盖时段（10:00 本是高峰 2 倍）')
  assert.equal(r.label, '节假日')
})

test('T10：模型自己关掉 tariff → 不吃倍率（另一个仍可生效）', () => {
  const table = { m1: { hit: 1, miss: 1, out: 1, tariff: false } }
  const p = effectivePrices(DEFAULT_PRICES, 'm1', table, noHoliday, at(10, 0))
  assert.equal(p.factor, 1, '模型 tariff=false 时不吃时段倍率')
})
