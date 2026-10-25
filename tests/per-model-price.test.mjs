/**
 * per-model 计价 / 门槛单测 —— 纯函数，不联网、不写盘。
 * 跑法：`node --test tests/per-model-price.test.mjs`
 *
 * 两个真缺陷（用户「改价不生效、间隔 3 秒狂保」的根因）：
 *   A. `priceForModel` 不认 `provider/model` 形式的价表键 → 永远回落基准价（模型价 + per-model 峰谷开关全失效）
 *   B. per-model `intervalSeconds` 没有下限 → 用户填 3（以为是 3 小时）实际 3 秒
 */
import { readFileSync } from 'node:fs'
import { DEFAULT_TARIFF, effectivePrices, priceForModel, recomputeCost } from '../src/econ.ts'
import { pickAutoCandidates } from '../src/auto.ts'
import { PER_MODEL_INTERVAL_MIN_SEC, buildGateInput, effectiveLimitsOf } from '../src/core/gate-input.ts'
import { DEFAULT_SETTINGS } from '../src/store.ts'

const BASE = { hit: 0.02, miss: 1, out: 4 }
/** 用户真实价表（19388 的 state）。 */
const REAL_TABLE = {
  'deepseek-account/deepseek-flash': { hit: 0.02, miss: 2, out: 8 },
  'tokenrhythm/deepseek-v4.1-flash-1017': { hit: 0.02, miss: 8, out: 20, tariff: false, holiday: false },
}

const cases = []

cases.push(['A① priceForModel(model, table, base, provider) 命中 provider/model 键（不回落 base）', () => {
  const p = priceForModel('deepseek-v4.1-flash-1017', REAL_TABLE, BASE, 'tokenrhythm')
  return p.miss === 8 && p.out === 20 && p.tariff === false && p.holiday === false
}])

cases.push(['A② provider 不同 → 命中各自那条（deepseek-account/deepseek-flash）', () => {
  const p = priceForModel('deepseek-flash', REAL_TABLE, BASE, 'deepseek-account')
  return p.miss === 2 && p.out === 8
}])

cases.push(['A③ 不给 provider 也能靠**后缀匹配**命中（历史账本条目没存 provider）', () => {
  const p = priceForModel('deepseek-v4.1-flash-1017', REAL_TABLE, BASE)
  return p.miss === 8 && p.out === 20
}])

cases.push(['A④ 精确键优先于后缀匹配（同名模型不同 provider 各取各的）', () => {
  const table = {
    'a/deepseek-flash': { hit: 0.02, miss: 3, out: 9 },
    'b/deepseek-flash': { hit: 0.02, miss: 5, out: 11 },
  }
  const a = priceForModel('deepseek-flash', table, BASE, 'a')
  const b = priceForModel('deepseek-flash', table, BASE, 'b')
  return a.miss === 3 && b.miss === 5
}])

cases.push(['A⑤ 价表里没这个模型 → 回落基准价（不误命中别的）', () => {
  const p = priceForModel('totally-unknown-model', REAL_TABLE, BASE, 'nope')
  return p.miss === BASE.miss && p.out === BASE.out
}])

cases.push(['A⑥ 老兜底仍在：model 里包含价表键', () => {
  const table = { flash: { hit: 0.02, miss: 7, out: 21 } }
  const p = priceForModel('deepseek-flash-2026', table, BASE)
  return p.miss === 7
}])

cases.push(['B per-model tariff:false → 高峰时段 factor 仍为 1（不吃峰谷）', () => {
  /** 造一个「全天都是 ×2」的时段表，确保任何时刻都会命中。 */
  const tariff = {
    ...DEFAULT_TARIFF,
    enabled: true,
    holidayEnabled: false,
    slots: [{ id: 'all', label: '高峰', from: '00:00', to: '00:00', factor: 2 }],
  }
  const withProv = effectivePrices(BASE, 'deepseek-v4.1-flash-1017', REAL_TABLE, tariff, 1700000000000, 'tokenrhythm')
  return withProv.factor === 1 && withProv.prices.miss === 8
}])

cases.push(['B 对照：同一时段表下，**没有** per-model 覆盖的模型 factor 会变成 2', () => {
  const tariff = {
    ...DEFAULT_TARIFF,
    enabled: true,
    holidayEnabled: false,
    slots: [{ id: 'all', label: '高峰', from: '00:00', to: '00:00', factor: 2 }],
  }
  const p = effectivePrices(BASE, 'some-other-model', REAL_TABLE, tariff, 1700000000000)
  return p.factor === 2
}])

cases.push(['C per-model intervalSeconds=3 → 生效值被抬到下限 300 秒', () => {
  const settings = {
    intervalSeconds: 3600,
    idleLimitHours: 6,
    modelOverrides: { 'tokenrhythm/deepseek-v4.1-flash-1017': { intervalSeconds: 3, idleLimitHours: 6 } },
  }
  const lim = effectiveLimitsOf(settings, 'tokenrhythm', 'deepseek-v4.1-flash-1017')
  return PER_MODEL_INTERVAL_MIN_SEC === 300 && lim.intervalMs === 300_000 && lim.intervalOverridden === true
}])

cases.push(['C per-model intervalSeconds=1800（30 分钟）不受下限影响', () => {
  const settings = {
    intervalSeconds: 3600,
    idleLimitHours: 6,
    modelOverrides: { 'tokenrhythm/m': { intervalSeconds: 1800 } },
  }
  const lim = effectiveLimitsOf(settings, 'tokenrhythm', 'm')
  return lim.intervalMs === 1800_000
}])

cases.push(['C 没设 per-model 时用通用间隔（下限不误伤通用值）', () => {
  const settings = { intervalSeconds: 3600, idleLimitHours: 6 }
  const lim = effectiveLimitsOf(settings, 'p', 'm')
  return lim.intervalMs === 3600_000 && lim.intervalOverridden === false
}])

cases.push(['C 全局 labMode 的 30 秒间隔不被 per-model 下限牵连（没 per-model 覆盖就不走那个分支）', () => {
  const settings = { intervalSeconds: 30, idleLimitHours: 6 }
  const lim = effectiveLimitsOf(settings, 'p', 'm')
  return lim.intervalMs === 30_000
}])


cases.push(['D① 带斜杠的键 + provider 不带后缀 → 仍命中（后缀匹配不限是否含 /）', () => {
  const settings = {
    intervalSeconds: 14400,
    idleLimitHours: 8,
    modelOverrides: { 'tokenrhythm-title/deepseek-v4.1-flash-1017': { intervalSeconds: 10800 } },
  }
  const lim = effectiveLimitsOf(settings, 'tokenrhythm', 'deepseek-v4.1-flash-1017')
  return lim.intervalMs === 10_800_000
}])

cases.push(['D② 精确 provider/model 优先，不许串；只有裸名键时两者都命中', () => {
  const M = 'deepseek-v4.1-flash-1017'
  const two = {
    intervalSeconds: 14400,
    idleLimitHours: 8,
    modelOverrides: {
      ['tokenrhythm/' + M]: { intervalSeconds: 3600 },
      ['tokenrhythm-title/' + M]: { intervalSeconds: 7200 },
    },
  }
  const bare = { intervalSeconds: 14400, idleLimitHours: 8, modelOverrides: { [M]: { intervalSeconds: 5400 } } }
  return effectiveLimitsOf(two, 'tokenrhythm', M).intervalMs === 3_600_000
    && effectiveLimitsOf(two, 'tokenrhythm-title', M).intervalMs === 7_200_000
    && effectiveLimitsOf(bare, 'tokenrhythm', M).intervalMs === 5_400_000
    && effectiveLimitsOf(bare, 'tokenrhythm-title', M).intervalMs === 5_400_000
}])


cases.push(['E 面板列表的「间隔」列读的是 per-model 生效值（不是会话/全局裸值）', () => {
  const src = readFileSync(new URL('../src/core/panel-service.ts', import.meta.url), 'utf8')
  const at = src.indexOf('intervalSeconds: (() => {')
  if (at < 0) return false
  const body = src.slice(at, at + 900)
  return body.includes('effectiveLimitsOf(state.settings') && body.includes('readSessionModel(')
}])


cases.push(['F recomputeCost：展示按当前价重算，存储的 cost（预算口径）不变', () => {
  const entry = { model: 'deepseek-v4.1-flash-1017', hitTokens: 0, missTokens: 100000, cacheWriteTokens: 0, outputTokens: 1, at: 1_700_000_000_000, cost: 0.100004 }
  const before = { prices: { hit: 0.02, miss: 1, out: 4 }, pricesByModel: {}, tariff: { ...DEFAULT_TARIFF, enabled: false } }
  const after = { prices: before.prices, pricesByModel: { 'tokenrhythm/deepseek-v4.1-flash-1017': { hit: 0.02, miss: 8, out: 20 } }, tariff: before.tariff }
  const a = recomputeCost(entry, before).cost
  const b = recomputeCost(entry, after).cost
  return Math.abs(a - 0.100004) < 1e-9 && b > a * 7 && entry.cost === 0.100004
}])

cases.push(['G 两处「花费」展示都走 recomputeCost（列表/详情同口径）', () => {
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const ps = readFileSync(new URL('../src/core/panel-service.ts', import.meta.url), 'utf8')
  /**
   * ⚠️ 本条写于「唯一入口」重构**之前**（那时候列表花费是内联 `led.reduce(... recomputeCost ...)`）。
   * 后来 `timeline-warm-price.test.mjs` 的「三面同源」明令禁止内联 Σ，并要求走 `spendAtCurrentPrices`
   * —— 两代规范对撞，取**新规范**。意图不变：列表与详情必须是同一口径（当前价重算）。
   */
  return idx.includes('spend: spendAtCurrentPrices(led, state.settings).cost')
    && ps.includes('spend: spendAtCurrentPrices(led, state.settings).cost')
    && idx.includes('ledgerSpend: led.reduce((sum, e) => sum + e.cost, 0)')
    && idx.includes('cost: recomputeCost(w, state.settings).cost')
}])

cases.push(['H 详情标题与列表标题共用子代理清洗（三个 return 点都过 cleanTitleOf）', () => {
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const at = idx.indexOf('function titleOf(')
  if (at < 0) return false
  const body = idx.slice(at, at + 2000)
  const returns = body.match(/return /g)?.length ?? 0
  const cleaned = body.match(/return cleanTitleOf\(/g)?.length ?? 0
  return returns === 3 && cleaned === 3
}])


cases.push(['I readSessionModel 拿不到 model 时用账本末条兜底（两处都要有）', () => {
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const ps = readFileSync(new URL('../src/core/panel-service.ts', import.meta.url), 'utf8')
  return idx.includes('const model = m?.model ?? lastLed?.model')
    && idx.includes('effectiveLimitsOf(state.settings, m?.provider, model)')
    && ps.includes('const model = m?.model ?? lastLed?.model')
    && ps.includes('effectiveLimitsOf(state.settings, m?.provider, model)')
}])


cases.push(['J 轮合计的模型名：一轮内换过模型必须留空 + 给出清单（不许只取最后一笔）', () => {
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  return idx.includes('models: turnModels')
    && idx.includes("model: turnModels.length === 1 ? turnModels[0] : ''")
    && idx.includes('if (r.model !== \'\') cur.models.add(r.model)')
}])

cases.push(['K 单步/轮合计的金额都按各自 model 逐笔算（不许末条 model 乘总 token）', () => {
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const at = idx.indexOf('const turnAgg = new Map<')
  if (at < 0) return false
  const body = idx.slice(at, at + 900)
  return body.includes('s.prices, r.model, s.pricesByModel, s.tariff, r.time, r.provider')
}])


cases.push(['L buildGateInput 用账本末条 model 兜底 → 门禁间隔吃 per-model 覆盖（判定层不再回落全局）', () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    intervalSeconds: 14400,
    idleLimitHours: 8,
    modelOverrides: { 'tokenrhythm/deepseek-v4.1-flash-1017': { intervalSeconds: 10800 } },
  }
  const st = {
    version: 1, settings, sessions: {}, pinnedSessions: [],
    ledger: { s1: [{ at: 1, model: 'deepseek-v4.1-flash-1017', hitTokens: 0, missTokens: 1000, outputTokens: 1, cost: 0.01, touch: 1 }] },
  }
  /** 调用方拿不到 provider/model（真机 537/550 就是这样）→ 必须靠账本兜底。 */
  const g = buildGateInput(st, { id: 's1', mtime: 2, hasRoute: true, tripped: false, at: 3 })
  return g.intervalMs === 10_800_000
}])

cases.push(['L 反例：账本也没有 model → 仍回落全局 14400（不许瞎猜）', () => {
  const st = {
    version: 1,
    settings: { ...DEFAULT_SETTINGS, intervalSeconds: 14400, idleLimitHours: 8, modelOverrides: { 'x/y': { intervalSeconds: 10800 } } },
    sessions: {}, pinnedSessions: {},
    ledger: { s1: [{ at: 1, hitTokens: 0, missTokens: 1000, outputTokens: 1, cost: 0.01, touch: 1 }] },
  }
  const g = buildGateInput(st, { id: 's1', mtime: 2, hasRoute: true, tripped: false, at: 3 })
  return g.intervalMs === 14_400_000
}])


cases.push(['O 拿不到 provider 且多档后缀命中、值不一致 → 不猜，回落全局（两个函数同策略）', () => {
  const table = {
    'tokenrhythm-title/deepseek-v4.1-flash-1017': { hit: 0.02, miss: 6, out: 12 },
    'tokenrhythm181-title/deepseek-v4.1-flash-1017': { hit: 0.02, miss: 8, out: 20 },
  }
  const p = priceForModel('deepseek-v4.1-flash-1017', table, { hit: 0.02, miss: 1, out: 4 })
  const settings = { intervalSeconds: 14400, idleLimitHours: 8, modelOverrides: {
    'tokenrhythm-title/deepseek-v4.1-flash-1017': { intervalSeconds: 7500 },
    'tokenrhythm181-title/deepseek-v4.1-flash-1017': { intervalSeconds: 10800 },
  } }
  const lim = effectiveLimitsOf(settings, undefined, 'deepseek-v4.1-flash-1017')
  /** 价格回落基准；间隔回落全局 14400（不猜成 7500 或 10800）。 */
  return p.miss === 1 && lim.intervalMs === 14_400_000
}])

cases.push(['O 反过来：多档后缀命中但值完全一致 → 可以用（无歧义不算猜）', () => {
  const table = {
    'a/x': { hit: 0.02, miss: 8, out: 20 },
    'b/x': { hit: 0.02, miss: 8, out: 20 },
  }
  const settings = { intervalSeconds: 14400, idleLimitHours: 8, modelOverrides: { 'a/x': { intervalSeconds: 7500 }, 'b/x': { intervalSeconds: 7500 } } }
  return priceForModel('x', table, { hit: 0.02, miss: 1, out: 4 }).miss === 8
    && effectiveLimitsOf(settings, undefined, 'x').intervalMs === 7_500_000
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

console.log('=== per-model 计价 / 门槛 ===')
console.log(lines.join('\n'))
console.log('')
console.log(`通过 ${pass} / ${cases.length}` + (fail > 0 ? `   ❌ 失败 ${fail}` : '   ✅ 全绿'))
process.exit(fail > 0 ? 1 : 0)
