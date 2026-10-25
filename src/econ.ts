/**
 * 保温经济学 —— 价目**可配置**（面板可改），默认 deepseek-flash 官方空闲档。
 *
 *   缓存命中输入 0.02 / 百万     未命中输入 1.0 / 百万     输出 4.0 / 百万
 *
 * 由此 `w/r = 50` → 一次冷启动 = 50 次保温，所有判据都从这两个比值来。
 * 高峰档全部 ×2、比值不变，故默认只用空闲档单价，结论与时段无关。
 *
 * ⚠️ 换模型 / 换档位 / 官方调价时**直接在面板改单价**即可 ——
 * `w/r`、次数上限、盈亏平衡概率等派生结论都会跟着变，不必改代码。
 */
import { createHash } from 'node:crypto'

/** 单价（元 / 百万 token）。 */
export interface Prices {
  /** 缓存命中输入。 */
  hit: number
  /** 未命中输入（= 冷启动重算的单价）。 */
  miss: number
  /** 输出。 */
  out: number
}

/** 默认价：deepseek-flash 官方空闲档。 */
export const DEFAULT_PRICES: Prices = { hit: 0.02, miss: 1, out: 4 }

/** 允许的最小单价（挡住 0，避免除零）。 */
export const PRICE_MIN = 0.0001

/** 允许的最大单价（挡住手滑填出天文数字）。 */
export const PRICE_MAX = 1000

/**
 * 归一化一份价格：非有限值、≤0、越界一律回落到默认。
 * @param input 用户给的部分价格（可能来自面板、工具或旧状态文件）。
 */
export function normalizePrices(input?: Partial<Prices> | null): Prices {
  const pick = (v: unknown, dflt: number): number => {
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) return dflt
    return Math.min(PRICE_MAX, Math.max(PRICE_MIN, n))
  }
  return {
    hit: pick(input?.hit, DEFAULT_PRICES.hit),
    miss: pick(input?.miss, DEFAULT_PRICES.miss),
    out: pick(input?.out, DEFAULT_PRICES.out),
  }
}

export interface Usage {
  /** 未命中的输入（Anthropic 的 `input_tokens`、DSH 的 `inputTokens`）。 */
  inputTokens?: number
  /** 命中缓存。
   *
  * ⚠️ **三个输入字段互斥**（DSH `TokenUsage` 与 Anthropic 同口径）：
   * `inputTokens + cacheReadTokens + cacheWriteTokens` = prompt 总长。
   * 早先的 `hitRate` 只拿 `read/(read+input)` 当分母，把「新建缓存」漏了 →
   * `read=100000 / write=50000` 会算成 100%（真实 66.7%），「重建型低命中」根本判不出来。
   */
  cacheReadTokens?: number
  /** 本次新建缓存的 token（Anthropic `cache_creation_input_tokens`；OpenAI 兼容端点通常没有）。 */
  cacheWriteTokens?: number
  outputTokens?: number
}

/**
 * 一次调用的实际花费（元）。
 *
 * **新建缓存按未命中价计**：DeepSeek 的口径就是「写进去按 miss 计、之后读到才算 hit」；
 * 早先漏了 `cacheWriteTokens`，每次重建缓存的那笔都会少算（面板花费偏低、预算更晚才触顶）。
 */
export function costOf(u: Usage, prices: Prices = DEFAULT_PRICES): number {
  return (u.cacheReadTokens ?? 0) * (prices.hit / 1e6)
    + ((u.inputTokens ?? 0) + (u.cacheWriteTokens ?? 0)) * (prices.miss / 1e6)
    + (u.outputTokens ?? 0) * (prices.out / 1e6)
}

/** 该次请求的 prompt 总长（命中 + 未命中 + 新建缓存）。 */
export function promptTokens(u: Usage): number {
  return (u.cacheReadTokens ?? 0) + (u.inputTokens ?? 0) + (u.cacheWriteTokens ?? 0)
}

/** 命中率：命中 / 总 prompt（含新建缓存；三者互斥，见 `Usage` 注释）。 */
export function hitRate(u: Usage): number {
  const total = promptTokens(u)
  return total === 0 ? 0 : (u.cacheReadTokens ?? 0) / total
}

/** `w/r`：一次冷启动相当于多少次保温（默认 50）。 */
export function warmOverRestart(prices: Prices = DEFAULT_PRICES): number {
  return prices.miss / prices.hit
}

/**
 * 次数上限：保温次数累计超过「一次冷启动」就不如让它冷掉。
 * `n·r < w` → `n < w/r`。
 */
export function maxTouchesHard(prices: Prices = DEFAULT_PRICES): number {
  return Math.max(1, Math.floor(warmOverRestart(prices)) - 1)
}

/** 该 prompt 若冷启动要花多少钱（元）—— 这就是保温要省下的东西。 */
export function coldStartCost(tokens: number, prices: Prices = DEFAULT_PRICES): number {
  return tokens * (prices.miss / 1e6)
}

/** 保 `tokens` 长前缀一次的花费（元）。 */
export function warmCost(tokens: number, prices: Prices = DEFAULT_PRICES): number {
  return tokens * (prices.hit / 1e6)
}

/**
 * 期望净收益（元）。`p` = 你认为这条会话还会被继续用的概率（0~1）。
 *
 *   net(p) = p·(R − c) − n·c
 *
 * R = 冷启动成本，c = 单次保温成本，n = 保温次数。
 */
export function expectedNet(
  p: number,
  tokens: number,
  n: number,
  prices: Prices = DEFAULT_PRICES,
): number {
  const c = warmCost(tokens, prices)
  const R = coldStartCost(tokens, prices)
  return p * (R - c) - n * c
}

/** 盈亏平衡的恢复概率 `p* = n·c / (R − c)`。 */
export function breakEvenProbability(
  tokens: number,
  n: number,
  prices: Prices = DEFAULT_PRICES,
): number {
  const c = warmCost(tokens, prices)
  const R = coldStartCost(tokens, prices)
  const denom = R - c
  if (denom <= 0) return 1
  return Math.min(1, (n * c) / denom)
}

/** 命中率塌到这个线以下即熔断（一次漏 = 50 次的钱，必须立刻停手）。 */
export const BREAK_CIRCUIT_HIT_RATE = 0.5

/** 按倍率缩放一份价格（峰谷时段 / 节假日）。非法倍率按 1 处理。 */
export function scalePrices(p: Prices, factor: number): Prices {
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1
  return { hit: p.hit * f, miss: p.miss * f, out: p.out * f }
}

/**
 * 模型单价 = 基准三价 + **该模型自己的两个开关**。
 *
 * 为什么开关要按模型：同一账号下不同模型走的计费口径可能不同（有的只有基准价、
 * 有的按时段打折），全局一个开关会连坐。缺省两项都 `true`（沿用全局开关）。
 */
export interface ModelPrices extends Prices {
  /** 该模型是否吃峰谷时段倍率（缺省 true；全局 `tariff.enabled` 关掉时一律不吃）。 */
  tariff?: boolean
  /** 该模型是否吃节假日倍率（缺省 true；全局 `tariff.holidayEnabled` 关掉时一律不吃）。 */
  holiday?: boolean
}

/** 模型价表：键是模型名（如 `deepseek-flash`），值是该模型的单价与开关。 */
export type PriceTable = Record<string, ModelPrices>

/** 归一化模型价表：丢掉空键/脏值，每项都过一遍 `normalizePrices`，开关只认显式 false。 */
export function normalizePriceTable(input: unknown): PriceTable {
  const out: PriceTable = {}
  if (input === null || typeof input !== 'object') return out
  for (const [rawKey, val] of Object.entries(input as Record<string, unknown>)) {
    const key = rawKey.trim().toLowerCase()
    if (key === '') continue
    if (val === null || typeof val !== 'object') continue
    const src = val as Partial<ModelPrices>
    const one: ModelPrices = normalizePrices(src)
    if (src.tariff === false) one.tariff = false
    if (src.holiday === false) one.holiday = false
    out[key] = one
  }
  return out
}

/**
 * 按模型名查价。
 *
 * 匹配顺序：精确名 → 最长包含（模型名含表键，如 `deepseek-flash-2026` 命中 `deepseek-flash`）
 * → 基准价兜底。取最长包含是为了避免 `deepseek` 这种短键把 `deepseek-reasoner` 也吞掉。
 */
export function priceForModel(model: string | undefined, table: PriceTable, fallback: Prices = DEFAULT_PRICES): ModelPrices {
  const name = (model ?? '').trim().toLowerCase()
  if (name === '') return fallback
  if (table[name] !== undefined) return table[name]
  let best = ''
  for (const key of Object.keys(table)) {
    if (key !== '' && name.includes(key) && key.length > best.length) best = key
  }
  return best === '' ? fallback : table[best]
}

/** 峰谷时段表里的一格。`from > to` 表示跨零点（如 23:00 → 07:00）。 */
export interface TariffSlot {
  /** 稳定 id（面板增删行用，与 React 无关）。 */
  id: string
  /** 展示名，如「高峰时段」。 */
  label: string
  /** 起始 `HH:MM`。 */
  from: string
  /** 结束 `HH:MM`（不含）。 */
  to: string
  /** 该时段的价倍率。 */
  factor: number
}

/** 节假日一天。**只认月-日，不含年份** —— 同一张表每年通用。 */
export interface Holiday {
  /** `MM-DD`。 */
  date: string
  /** 名称，如「春节」。 */
  name: string
}

/**
 * 峰谷时段表 + 节假日表。
 *
 * 语义：**基准价（`Prices`）对应倍率 1**，命中某时段就按该时段的 `factor` 乘上去。
 * 所以默认给的两格是「空闲 1 倍 / 高峰 2 倍」——基准价按 DeepSeek 的空闲档填，
 * 沿用文件头「高峰档全部 ×2、比值不变」那一条。
 */
export interface Tariff {
  /** 总开关；关掉时价格恒为基准价，时段表仅作参考。 */
  enabled: boolean
  /** 判定用的时区（IANA 名，如 `Asia/Shanghai`）。 */
  timeZone: string
  /** 时段表：**按顺序先命中先用**，全都不命中则倍率 1。 */
  slots: TariffSlot[]
  /** 节假日表。 */
  holidays: Holiday[]
  /** 节假日当天是否启用独立倍率。 */
  holidayEnabled: boolean
  /** 节假日当天的倍率（覆盖时段表，不叠乘）。 */
  holidayFactor: number
}

/**
 * 国务院放假安排（国办发明电〔2025〕7 号，只取放假日期，不含调休上班日）。
 * **只写月-日**：同一张表每年通用，跨年不用改。
 */
export const HOLIDAYS_DEFAULT: Holiday[] = [
  { date: '01-01', name: '元旦' }, { date: '01-02', name: '元旦' }, { date: '01-03', name: '元旦' },
  { date: '02-15', name: '春节' }, { date: '02-16', name: '春节' }, { date: '02-17', name: '春节' },
  { date: '02-18', name: '春节' }, { date: '02-19', name: '春节' }, { date: '02-20', name: '春节' },
  { date: '02-21', name: '春节' }, { date: '02-22', name: '春节' }, { date: '02-23', name: '春节' },
  { date: '04-04', name: '清明' }, { date: '04-05', name: '清明' }, { date: '04-06', name: '清明' },
  { date: '05-01', name: '劳动节' }, { date: '05-02', name: '劳动节' }, { date: '05-03', name: '劳动节' },
  { date: '05-04', name: '劳动节' }, { date: '05-05', name: '劳动节' },
  { date: '06-19', name: '端午' }, { date: '06-20', name: '端午' }, { date: '06-21', name: '端午' },
  { date: '09-25', name: '中秋' }, { date: '09-26', name: '中秋' }, { date: '09-27', name: '中秋' },
  { date: '10-01', name: '国庆' }, { date: '10-02', name: '国庆' }, { date: '10-03', name: '国庆' },
  { date: '10-04', name: '国庆' }, { date: '10-05', name: '国庆' }, { date: '10-06', name: '国庆' },
  { date: '10-07', name: '国庆' },
]

/** 默认时段表与节假日表（总开关默认关，避免默默改掉用户已核对的成本）。 */
/**
 * 默认峰谷时段（用户指定）：**两段高峰**，其余空闲。
 *
 * ```
 * 00:30 → 08:30  空闲 ×1
 * 08:30 → 12:00  高峰1 ×2
 * 12:00 → 14:30  空闲 ×1
 * 14:30 → 18:00  高峰2 ×2
 * 18:00 → 00:30  空闲 ×1     ← 跨零点
 * ```
 *
 * `enabled` 默认 **false**：不打开就一律按基准价（`tariffFactorAt` 直接返回 1）。
 * 打开后**没被任何时段覆盖的时刻也按 1.0 倍**（安全降级，见 `tariffFactorAt`）。
 */
export const DEFAULT_TARIFF: Tariff = {
  enabled: false,
  timeZone: 'Asia/Shanghai',
  slots: [
    { id: 'off-peak-1', label: '空闲时段', from: '00:30', to: '08:30', factor: 1 },
    { id: 'peak-1', label: '高峰时段1', from: '08:30', to: '12:00', factor: 2 },
    { id: 'off-peak-2', label: '空闲时段', from: '12:00', to: '14:30', factor: 1 },
    { id: 'peak-2', label: '高峰时段2', from: '14:30', to: '18:00', factor: 2 },
    /** 跨零点：`to` 小于 `from` 表示「到次日」。 */
    { id: 'off-peak-3', label: '空闲时段', from: '18:00', to: '00:30', factor: 1 },
  ],
  holidayEnabled: false,
  holidayFactor: 1,
  holidays: HOLIDAYS_DEFAULT,
}

/** 倍率合法范围。 */
const FACTOR_MIN = 0.01
const FACTOR_MAX = 100

function normalizeFactor(v: unknown, dflt: number): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return dflt
  return Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, n))
}

/** `HH:MM` → 分钟数；非法返回 -1。 */
export function parseHm(s: unknown): number {
  if (typeof s !== 'string') return -1
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (m === null) return -1
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return -1
  return h * 60 + mi
}

/** 归一化时段表：丢掉非法 `from/to`，倍率夹到合法区间，id 缺失时补一个。 */
export function normalizeTariff(input?: Partial<Tariff> | null): Tariff {
  const src = input ?? {}
  const slots: TariffSlot[] = []
  const rawSlots = Array.isArray(src.slots) ? src.slots : DEFAULT_TARIFF.slots
  rawSlots.forEach((raw, index) => {
    const from = parseHm(raw?.from)
    const to = parseHm(raw?.to)
    if (from < 0 || to < 0) return
    slots.push({
      id: typeof raw?.id === 'string' && raw.id !== '' ? raw.id : 'slot-' + index,
      label: typeof raw?.label === 'string' && raw.label !== '' ? raw.label : '时段' + (index + 1),
      from: String(raw?.from),
      to: String(raw?.to),
      factor: normalizeFactor(raw?.factor, 1),
    })
  })
  const holidays: Holiday[] = []
  const rawHolidays = Array.isArray(src.holidays) ? src.holidays : DEFAULT_TARIFF.holidays
  for (const h of rawHolidays) {
    /** 只认 `MM-DD`；旧数据里的 `YYYY-MM-DD` 自动截掉年份（不丢用户已存的表）。 */
    const raw = typeof h?.date === 'string' ? h.date.trim() : ''
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw.slice(5) : raw
    /** 除了格式，还要校验月/日范围：`13-40` `02-30` `00-00` 这类永远命中不了，别让它进表。 */
    const md = /^(\d{2})-(\d{2})$/.exec(date)
    if (md === null) continue
    const mo = Number(md[1])
    const day = Number(md[2])
    if (mo < 1 || mo > 12) continue
    /** 按月份校验天数（基准取闰年 2024，好让「02-29」这种真实存在的一天也能进表）。 */
    if (day < 1 || day > new Date(Date.UTC(2024, mo, 0)).getUTCDate()) continue
    holidays.push({ date, name: typeof h?.name === 'string' ? h.name : '' })
  }
  holidays.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return {
    enabled: src.enabled === true,
    timeZone: typeof src.timeZone === 'string' && src.timeZone !== '' ? src.timeZone : DEFAULT_TARIFF.timeZone,
    slots,
    holidays,
    holidayEnabled: src.holidayEnabled === true,
    holidayFactor: normalizeFactor(src.holidayFactor, 1),
  }
}

const ZONE_FMT = new Map<string, Intl.DateTimeFormat>()

/** 取某个时刻在指定时区里的本地日期与分钟数（0~1439）。 */
export function zoneClock(epochMs: number, timeZone: string): { date: string; minutes: number } {
  const ms = Number.isFinite(epochMs) ? epochMs : Date.now()
  let fmt = ZONE_FMT.get(timeZone)
  if (fmt === undefined) {
    const opts: Intl.DateTimeFormatOptions = {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }
    try {
      fmt = new Intl.DateTimeFormat('en-CA', { ...opts, timeZone })
    } catch {
      fmt = new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: 'UTC' })
    }
    ZONE_FMT.set(timeZone, fmt)
  }
  const bag: Record<string, string> = {}
  for (const part of fmt.formatToParts(ms)) {
    if (part.type !== 'literal') bag[part.type] = part.value
  }
  const date = (bag['year'] ?? '1970') + '-' + (bag['month'] ?? '01') + '-' + (bag['day'] ?? '01')
  const minutes = Number(bag['hour'] ?? '0') * 60 + Number(bag['minute'] ?? '0')
  return { date, minutes }
}

/** 某时刻落在哪个时段（返回命中的那一格；都不命中返回 undefined）。 */
export function tariffSlotAt(tariff: Tariff, epochMs: number): { slot?: TariffSlot; clock: { date: string; minutes: number } } {
  const clock = zoneClock(epochMs, tariff.timeZone)
  for (const slot of tariff.slots) {
    const from = parseHm(slot.from)
    const to = parseHm(slot.to)
    if (from < 0 || to < 0) continue
    const inside = from === to
      ? true
      : from < to
        ? clock.minutes >= from && clock.minutes < to
        : clock.minutes >= from || clock.minutes < to
    if (inside) return { slot, clock }
  }
  return { clock }
}

/** 某时刻生效的价倍率。节假日优先（覆盖时段表，不叠乘）。 */
export function tariffFactorAt(
  tariff: Tariff,
  epochMs: number,
  use?: { slots?: boolean; holiday?: boolean },
): { factor: number; label: string; holiday?: string } {
  const wantSlots = use?.slots !== false
  const wantHoliday = use?.holiday !== false
  const { slot, clock } = wantSlots ? tariffSlotAt(tariff, epochMs) : { slot: undefined, clock: zoneClock(epochMs, tariff.timeZone) }
  if (wantHoliday && tariff.holidayEnabled) {
    /** 节假日表只存 `MM-DD`，时钟给的是 `YYYY-MM-DD` → 比后 5 位。 */
    const md = clock.date.slice(-5)
    const hit = tariff.holidays.find((h) => h.date === md)
    if (hit !== undefined) {
      return { factor: tariff.holidayFactor, label: '节假日', holiday: hit.name }
    }
  }
  if (slot !== undefined) return { factor: slot.factor, label: slot.label }
  return { factor: 1, label: '基准' }
}

/**
 * 某模型在某时刻的实付单价（模型价表 × 时段/节假日倍率）。
 *
 * 三层开关，**逐层收紧**：
 * ① 全局 `tariff.enabled` 关 → 一律基准价；
 * ② 模型自己的 `tariff/holiday` 为 `false` → 该模型不吃这一项（另一个仍可生效）；
 * ③ 全局 `holidayEnabled` 关 → 节假日那一项对该模型也不生效。
 */
export function effectivePrices(
  base: Prices,
  model: string | undefined,
  table: PriceTable,
  tariff: Tariff,
  epochMs: number,
): { prices: Prices; factor: number; label: string; model: string; holiday?: string } {
  const byModel = priceForModel(model, table, base)
  if (!tariff.enabled) {
    return { prices: byModel, factor: 1, label: '基准', model: model ?? '' }
  }
  const t = tariffFactorAt(tariff, epochMs, { slots: byModel.tariff !== false, holiday: byModel.holiday !== false })
  return { prices: scalePrices(byModel, t.factor), factor: t.factor, label: t.label, model: model ?? '', holiday: t.holiday }
}

/**
 * **一笔调用的实付花费**（含模型价与时段倍率）。
 *
 * 时间轴与账本都走这个入口，保证三者同一口径：单步明细、整轮合计、面板顶部汇总。
 * 整轮合计必须**逐笔调用它再求和**，不能拿轮首时刻的倍率乘整轮 token。
 */
export function costAt(
  u: Usage,
  base: Prices,
  model: string | undefined,
  table: PriceTable,
  tariff: Tariff,
  epochMs: number,
): { cost: number; factor: number; label: string } {
  const p = effectivePrices(base, model, table, tariff, epochMs)
  return { cost: costOf(u, p.prices), factor: p.factor, label: p.label }
}

/** 重算一笔账的成本所需的最小结构与设置面（避免 econ 反向依赖 store）。 */
export interface RecomputeEntry {
  model?: string
  hitTokens: number
  missTokens: number
  cacheWriteTokens?: number
  outputTokens: number
  /** 那笔发生的时刻（时段倍率按它判，不用 now）。 */
  at: number
  /** 会话 provider（当前 `costAt` 尚不吃它，保留字段供上层传递）。 */
  provider?: string
}
export interface RecomputeSettings {
  prices: Prices
  pricesByModel: PriceTable
  tariff: Tariff
}

/**
 * **按当前价格重算一笔历史账的成本** —— 只给**展示**用。
 *
 * `LedgerEntry.cost` 是记账当时的价格快照：改价后历史数据不会变（用户报障「旧的数据没变」）。
 * 展示（列表花费 / 详情每笔 / 顶部汇总）改调它；**预算 / 熔断 / 上限判断仍必须用存储的 `cost`**
 * —— 那是真实花过的钱，不能被改价影响。
 */
export function recomputeCost(e: RecomputeEntry, settings: RecomputeSettings): { cost: number; factor: number; label: string } {
  return costAt(
    {
      cacheReadTokens: e.hitTokens,
      inputTokens: e.missTokens,
      cacheWriteTokens: e.cacheWriteTokens ?? 0,
      outputTokens: e.outputTokens,
    },
    settings.prices ?? DEFAULT_PRICES,
    e.model,
    settings.pricesByModel ?? {},
    settings.tariff ?? DEFAULT_TARIFF,
    e.at,
  )
}

/**
 * **价格指纹**：时间轴缓存键的一部分，只覆盖「会改变金额」的三项（基准价 / 模型价表 / 时段表）。
 *
 * 为什么必须有：账本 `entry.cost` 是记账快照、展示按当前价重算 —— 缓存键若不含价格，
 * 改价后 `timelineCacheMinutes`（默认 10 分钟）内详情仍吐旧价。改价入口有多条
 * （工具 set-settings / 手改 state.json / 另一个进程），不能指望 `applySettings()` 一定被调到。
 * 其它设置（间隔、TTL 本身…）改了不影响金额，**不进**指纹 —— 否则改个间隔就白丢一次缓存。
 */
export function priceFingerprint(settings: RecomputeSettings): string {
  return createHash('sha256')
    .update(JSON.stringify({ p: settings.prices ?? {}, m: settings.pricesByModel ?? {}, t: settings.tariff ?? {} }))
    .digest('hex')
    .slice(0, 12)
}
