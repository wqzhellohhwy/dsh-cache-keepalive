/**
 * 计价测试：模型价表 / 峰谷时段 / 节假日 / 按轮聚合。
 * 跑法：node tests/econ.test.mjs
 *
 * 全部是纯函数，不打网络、不花钱、不读磁盘。
 */
import {
  DEFAULT_PRICES,
  DEFAULT_TARIFF,
  HOLIDAYS_DEFAULT,
  costAt,
  costOf,
  effectivePrices,
  hitRate,
  promptTokens,
  normalizePriceTable,
  normalizeTariff,
  parseHm,
  priceForModel,
  scalePrices,
  tariffFactorAt,
  zoneClock,
} from '../src/econ.ts'
import { sumByTurn } from '../src/core/sessions.ts'

/** 把 UTC 时刻换成"北京时间某日某点"，避免依赖本机时区。 */
const beijing = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi)

const cases = []

// ── 时段表 ────────────────────────────────────────────────────
cases.push(['parseHm 解析合法/非法', () => {
  return parseHm('08:30') === 510 && parseHm('0:05') === 5 && parseHm('23:59') === 1439
    && parseHm('24:00') === -1 && parseHm('8:60') === -1 && parseHm('abc') === -1 && parseHm(830) === -1
}])

cases.push(['zoneClock 按目标时区取日期与分钟', () => {
  const c = zoneClock(beijing(2026, 10, 11, 9, 5), 'Asia/Shanghai')
  return c.date === '2026-10-11' && c.minutes === 9 * 60 + 5
}])

cases.push(['默认时段表：北京时间 08:00 是空闲（倍率 1）', () => {
  return tariffFactorAt(DEFAULT_TARIFF, beijing(2026, 10, 11, 8, 0)).factor === 1
}])

cases.push(['默认时段表：北京时间 08:30 起是高峰（倍率 2）', () => {
  const r = tariffFactorAt(DEFAULT_TARIFF, beijing(2026, 10, 11, 8, 30))
  return r.factor === 2 && r.label === '高峰时段1'
}])

cases.push(['默认时段表：18:00→00:30 是空闲段（00:10 与 23:00 都空闲）', () => {
  return tariffFactorAt(DEFAULT_TARIFF, beijing(2026, 10, 12, 0, 10)).factor === 1
    && tariffFactorAt(DEFAULT_TARIFF, beijing(2026, 10, 11, 23, 0)).factor === 1
}])

cases.push(['默认时段表：12:00→14:30 是空闲段（用户口径：只有高峰1/高峰2）', () => {
  return tariffFactorAt(DEFAULT_TARIFF, beijing(2026, 10, 11, 12, 0)).factor === 1
}])

cases.push(['时段表按顺序先命中先用', () => {
  const t = normalizeTariff({
    enabled: true,
    timeZone: 'Asia/Shanghai',
    slots: [
      { id: 'a', label: '先', from: '09:00', to: '10:00', factor: 3 },
      { id: 'b', label: '后', from: '00:00', to: '00:00', factor: 9 },
    ],
    holidays: [],
  })
  return tariffFactorAt(t, beijing(2026, 10, 11, 9, 30)).factor === 3
    // 第二格是全天（from === to），但只在前一格没命中时才生效
    && tariffFactorAt(t, beijing(2026, 10, 11, 20, 0)).factor === 9
}])

cases.push(['都不命中 → 倍率 1', () => {
  const t = normalizeTariff({
    enabled: true, timeZone: 'Asia/Shanghai',
    slots: [{ id: 'a', label: 'x', from: '09:00', to: '10:00', factor: 3 }], holidays: [],
  })
  return tariffFactorAt(t, beijing(2026, 10, 11, 15, 0)).factor === 1
}])

// ── 节假日 ────────────────────────────────────────────────────
cases.push(['节假日表默认关闭 → 假日当天照时段表算', () => {
  const r = tariffFactorAt(DEFAULT_TARIFF, beijing(2026, 2, 17, 9, 0))
  return r.factor === 2 && r.holiday === undefined
}])

cases.push(['打开节假日 → 覆盖时段表（不叠乘）', () => {
  const t = normalizeTariff({
    enabled: true, timeZone: 'Asia/Shanghai',
    slots: [{ id: 'p', label: '高峰', from: '00:00', to: '00:00', factor: 2 }],
    holidayEnabled: true, holidayFactor: 1.5,
    holidays: [{ date: '2026-02-17', name: '春节' }],
  })
  const r = tariffFactorAt(t, beijing(2026, 2, 17, 12, 0))
  // 覆盖 = 1.5，而不是 2 × 1.5
  return r.factor === 1.5 && r.holiday === '春节' && r.label === '节假日'
}])

cases.push(['非节假日不受节假日倍率影响', () => {
  const t = normalizeTariff({
    enabled: true, timeZone: 'Asia/Shanghai',
    slots: [{ id: 'p', label: '全天', from: '00:00', to: '00:00', factor: 2 }],
    holidayEnabled: true, holidayFactor: 1.5,
    holidays: [{ date: '2026-02-17', name: '春节' }],
  })
  return tariffFactorAt(t, beijing(2026, 2, 18, 12, 0)).factor === 2
}])

cases.push(['默认节假日表 33 天，日期只有月-日（不带年份）', () => {
  if (HOLIDAYS_DEFAULT.length !== 33) return false
  const seen = new Set()
  for (const h of HOLIDAYS_DEFAULT) {
    if (!/^\d{2}-\d{2}$/.test(h.date)) return false
    if (seen.has(h.date)) return false
    seen.add(h.date)
    if (h.name === '') return false
  }
  return seen.has('02-17') && seen.has('10-01') && seen.has('01-01')
}])

cases.push(['节假日表跨年通用：MM-DD 表在任意年份的该日都命中', () => {
  const t = normalizeTariff({
    enabled: true, timeZone: 'Asia/Shanghai',
    slots: [{ id: 'p', label: '全天', from: '00:00', to: '00:00', factor: 2 }],
    holidayEnabled: true, holidayFactor: 1.5,
    holidays: [{ date: '02-17', name: '春节' }],
  })
  return tariffFactorAt(t, beijing(2026, 2, 17, 12, 0)).factor === 1.5
    && tariffFactorAt(t, beijing(2031, 2, 17, 12, 0)).factor === 1.5
    && tariffFactorAt(t, beijing(2031, 2, 18, 12, 0)).factor === 2
}])

cases.push(['旧数据里的 YYYY-MM-DD 自动截成 MM-DD（不丢已存的表）', () => {
  const t = normalizeTariff({
    enabled: true, timeZone: 'Asia/Shanghai',
    slots: [], holidayEnabled: true, holidayFactor: 3,
    holidays: [{ date: '2026-02-17', name: '春节' }],
  })
  return t.holidays.length === 1 && t.holidays[0].date === '02-17'
    && tariffFactorAt(t, beijing(2030, 2, 17, 12, 0)).factor === 3
}])

cases.push(['非法节假日日期被丢弃：格式错、越界的月/日、带时间', () => {
  const t = normalizeTariff({
    holidays: [
      { date: '2-17', name: 'a' },        // 缺前导零
      { date: '02-17 12:00', name: 'b' }, // 带时间
      { date: '13-40', name: 'c' },       // 13 月 40 日
      { date: '12-32', name: 'd' },       // 12 月 32 日
      { date: '02-30', name: 'e' },       // 2 月 30 日
      { date: '00-00', name: 'f' },       // 0 月 0 日
      { date: '02-17', name: 'ok' },      // 合法
    ],
  })
  return t.holidays.length === 1 && t.holidays[0].name === 'ok'
}])

cases.push(['模型级「不吃峰谷」：该模型恒基准价，其它模型照吃', () => {
  const table = normalizePriceTable({
    'a-model': { hit: 1, miss: 10, out: 100, tariff: false },
    'b-model': { hit: 1, miss: 10, out: 100 },
  })
  const t = normalizeTariff({
    enabled: true, timeZone: 'Asia/Shanghai',
    slots: [{ id: 'p', label: '全天', from: '00:00', to: '00:00', factor: 2 }],
    holidayEnabled: false, holidays: [],
  })
  const at = beijing(2026, 10, 11, 12, 0)
  const a = effectivePrices(DEFAULT_PRICES, 'a-model', table, t, at)
  const b = effectivePrices(DEFAULT_PRICES, 'b-model', table, t, at)
  return a.factor === 1 && a.prices.miss === 10 && b.factor === 2 && b.prices.miss === 20
}])

cases.push(['模型级「不吃节假日」：节假日当天该模型仍按时段表', () => {
  const table = normalizePriceTable({ 'a-model': { hit: 1, miss: 10, out: 100, holiday: false } })
  const t = normalizeTariff({
    enabled: true, timeZone: 'Asia/Shanghai',
    slots: [{ id: 'p', label: '全天', from: '00:00', to: '00:00', factor: 2 }],
    holidayEnabled: true, holidayFactor: 5, holidays: [{ date: '02-17', name: '春节' }],
  })
  const at = beijing(2026, 2, 17, 12, 0)
  const a = effectivePrices(DEFAULT_PRICES, 'a-model', table, t, at)
  const plain = effectivePrices(DEFAULT_PRICES, 'zzz', normalizePriceTable({ 'zzz': { hit: 1, miss: 10, out: 100 } }), t, at)
  return a.factor === 2 && plain.factor === 5
}])

cases.push(['模型开关缺省为启用（老数据只有三个价，照样吃峰谷）', () => {
  const table = normalizePriceTable({ 'a-model': { hit: 1, miss: 10, out: 100 } })
  const t = normalizeTariff({
    enabled: true, timeZone: 'Asia/Shanghai',
    slots: [{ id: 'p', label: '全天', from: '00:00', to: '00:00', factor: 3 }],
    holidayEnabled: false, holidays: [],
  })
  const a = effectivePrices(DEFAULT_PRICES, 'a-model', table, t, beijing(2026, 10, 11, 12, 0))
  return a.factor === 3 && a.prices.hit === 3
}])

cases.push(['全局关掉时段表 → 模型开关再开也不生效（逐层收紧）', () => {
  const table = normalizePriceTable({ 'a-model': { hit: 1, miss: 10, out: 100 } })
  const t = normalizeTariff({
    enabled: false, timeZone: 'Asia/Shanghai',
    slots: [{ id: 'p', label: '全天', from: '00:00', to: '00:00', factor: 3 }],
    holidayEnabled: true, holidayFactor: 9, holidays: [{ date: '02-17', name: '春节' }],
  })
  const a = effectivePrices(DEFAULT_PRICES, 'a-model', table, t, beijing(2026, 2, 17, 12, 0))
  return a.factor === 1 && a.prices.hit === 1
}])

// ── 口径：三个输入字段互斥（input / read / write 相加 = prompt 总长）─────
cases.push(['hitRate 分母含新建缓存（否则重建型低命中会被算成高命中）', () => {
  const u = { cacheReadTokens: 100000, cacheWriteTokens: 50000, inputTokens: 194 }
  return promptTokens(u) === 150194 && Math.abs(hitRate(u) - 100000 / 150194) < 1e-9
}])

cases.push(['全 miss 但新建了缓存 → 命中率 0，且 prompt 含新建量', () => {
  const u = { cacheReadTokens: 0, cacheWriteTokens: 207554, inputTokens: 0 }
  return promptTokens(u) === 207554 && hitRate(u) === 0
}])

cases.push(['costOf 把新建缓存按未命中价计（DeepSeek 口径）', () => {
  const u = { cacheReadTokens: 1000, cacheWriteTokens: 2000, inputTokens: 500, outputTokens: 10 }
  const p = { hit: 0.02, miss: 1, out: 4 }
  const want = (1000 * 0.02 + (2000 + 500) * 1 + 10 * 4) / 1e6
  return Math.abs(costOf(u, p) - want) < 1e-12
}])

// ── 模型价表 ──────────────────────────────────────────────────
cases.push(['priceForModel：精确命中优先', () => {
  const table = { 'deepseek-flash': { hit: 1, miss: 2, out: 3 } }
  return priceForModel('deepseek-flash', table, DEFAULT_PRICES).hit === 1
}])

cases.push(['priceForModel：模型名含表键时命中（带版本后缀）', () => {
  const table = { 'deepseek-flash': { hit: 1, miss: 2, out: 3 } }
  return priceForModel('deepseek-flash-2026', table, DEFAULT_PRICES).miss === 2
}])

cases.push(['priceForModel：多个键都包含时取最长（不被短键吞掉）', () => {
  const table = {
    deepseek: { hit: 9, miss: 9, out: 9 },
    'deepseek-reasoner': { hit: 1, miss: 2, out: 3 },
  }
  return priceForModel('deepseek-reasoner', table, DEFAULT_PRICES).hit === 1
}])

cases.push(['priceForModel：查不到回落基准价', () => {
  return priceForModel('unknown-model', { 'x-model': { hit: 9, miss: 9, out: 9 } }, DEFAULT_PRICES).hit === DEFAULT_PRICES.hit
}])

cases.push(['priceForModel：空模型名/无表 → 基准价', () => {
  return priceForModel('', {}, DEFAULT_PRICES).out === DEFAULT_PRICES.out
    && priceForModel(undefined, {}, DEFAULT_PRICES).out === DEFAULT_PRICES.out
}])

cases.push(['normalizePriceTable 丢空键、脏值归一化', () => {
  const t = normalizePriceTable({ '  ': { hit: 1 }, 'DeepSeek-Flash': { hit: 0, miss: 2, out: 3 }, bad: null })
  return Object.keys(t).length === 1
    && t['deepseek-flash'].hit === DEFAULT_PRICES.hit   // 0 被挡回默认
    && t['deepseek-flash'].miss === 2
}])

cases.push(['scalePrices 非法倍率按 1 处理', () => {
  const a = scalePrices({ hit: 1, miss: 2, out: 3 }, 2)
  const b = scalePrices({ hit: 1, miss: 2, out: 3 }, Number.NaN)
  return a.hit === 2 && a.miss === 4 && a.out === 6 && b.hit === 1
}])

// ── 组合：模型价 × 时段倍率 ───────────────────────────────────
cases.push(['effectivePrices：时段表关掉时只查模型价', () => {
  const t = normalizeTariff({ ...DEFAULT_TARIFF, enabled: false })
  const r = effectivePrices(DEFAULT_PRICES, 'deepseek-flash', { 'deepseek-flash': { hit: 5, miss: 5, out: 5 } }, t, beijing(2026, 10, 11, 12, 0))
  return r.prices.hit === 5 && r.factor === 1
}])

cases.push(['effectivePrices：时段表开着时乘倍率', () => {
  const t = normalizeTariff({ ...DEFAULT_TARIFF, enabled: true })
  const r = effectivePrices(DEFAULT_PRICES, 'deepseek-flash', { 'deepseek-flash': { hit: 1, miss: 2, out: 4 } }, t, beijing(2026, 10, 11, 9, 0))
  // 北京 09:00 = 高峰 ×2
  return r.factor === 2 && r.prices.hit === 2 && r.prices.miss === 4 && r.prices.out === 8
}])

cases.push(['costAt：跨时段的一轮必须逐笔求和，不能用轮首倍率乘整轮', () => {
  const t = normalizeTariff({ ...DEFAULT_TARIFF, enabled: true })
  // 100k 命中 token、命中价 0.02/百万 = 0.002 元；高峰 ×2 = 0.004 元
  const a = costAt({ cacheReadTokens: 100_000 }, DEFAULT_PRICES, 'deepseek-flash', {}, t, beijing(2026, 10, 11, 8, 20))
  const b = costAt({ cacheReadTokens: 100_000 }, DEFAULT_PRICES, 'deepseek-flash', {}, t, beijing(2026, 10, 11, 8, 40))
  // 轮首（08:20 空闲）倍率乘整轮 token —— 这就是被修掉的那个算法
  const wrong = costAt({ cacheReadTokens: 200_000 }, DEFAULT_PRICES, 'deepseek-flash', {}, t, beijing(2026, 10, 11, 8, 20))
  return Math.abs(a.cost - 0.002) < 1e-9 && Math.abs(b.cost - 0.004) < 1e-9
    && Math.abs(a.cost + b.cost - 0.006) < 1e-9
    && Math.abs(wrong.cost - 0.004) < 1e-9
}])

cases.push(['costAt：与时序表关掉时的基准价一致', () => {
  const off = normalizeTariff({ ...DEFAULT_TARIFF, enabled: false })
  const c = costAt({ cacheReadTokens: 1_000_000, inputTokens: 1_000_000, outputTokens: 1_000_000 },
    DEFAULT_PRICES, '', {}, off, beijing(2026, 10, 11, 12, 0))
  return Math.abs(c.cost - (0.02 + 1 + 4)) < 1e-9 && c.factor === 1
}])

// ── 按轮聚合 ──────────────────────────────────────────────────
const round = (turn, step, time, hit, miss, out, model = 'deepseek-flash') => ({
  seq: 0, time, turn, step, provider: 'deepseek-official', model,
  hitTokens: hit, missTokens: miss, outputTokens: out, totalTokens: hit + miss + out,
})

cases.push(['sumByTurn：同一轮多步合并为一项', () => {
  const turns = sumByTurn([
    round(1, 1, 1000, 100, 10, 5),
    round(1, 2, 2000, 500, 0, 3),
    round(2, 1, 3000, 900, 0, 8),
  ])
  return turns.length === 2
    && turns[0].turn === 1 && turns[0].steps === 2
    && turns[0].hitTokens === 600 && turns[0].missTokens === 10 && turns[0].outputTokens === 8
    && turns[0].time === 1000 && turns[0].endTime === 2000
    && turns[1].turn === 2 && turns[1].steps === 1
}])

cases.push(['sumByTurn：按时间排序，与输入顺序无关', () => {
  const turns = sumByTurn([
    round(2, 1, 9000, 1, 0, 0),
    round(1, 1, 1000, 1, 0, 0),
  ])
  return turns[0].turn === 1 && turns[1].turn === 2
}])

cases.push(['sumByTurn：模型取最后一笔非空（整轮换模型时）', () => {
  const turns = sumByTurn([
    round(1, 1, 1000, 1, 0, 0, 'deepseek-flash'),
    round(1, 2, 2000, 1, 0, 0, 'deepseek-reasoner'),
  ])
  return turns[0].model === 'deepseek-reasoner'
}])

cases.push(['sumByTurn：空输入返回空数组', () => {
  return sumByTurn([]).length === 0
}])

let pass = 0
let fail = 0
const lines = []
for (const [name, fn] of cases) {
  let ok = false
  let err = ''
  try {
    ok = fn() === true
  } catch (e) {
    err = ' 抛错: ' + (e && e.message ? e.message : String(e))
  }
  if (ok) pass++
  else fail++
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : err}`)
}

console.log('=== 计价 / 时段 / 聚合测试 ===')
console.log(lines.join('\n'))
console.log('')
console.log(`通过 ${pass} / ${cases.length}` + (fail > 0 ? `   ❌ 失败 ${fail}` : '   ✅ 全绿'))
process.exit(fail > 0 ? 1 : 0)
