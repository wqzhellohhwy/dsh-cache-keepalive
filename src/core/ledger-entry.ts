/**
 * **账本条目的唯一构造点**。
 *
 * 为什么必须有这个工厂（踩过两次）：
 *  - `markItem` 双路径分叉出过「剪掉历史对话 · 工具面未确认」的错文案；
 *  - `rewriteFp` / `fingerprint` 这类「判定基准字段」只要一边漏写，另一侧读到的就是 `undefined`
 *    → 判定落 `unknown` 静默放行（保护失效，**不报错**，跑几天才发现多花了钱）。
 *
 * 所以：**谁发请求谁就调它**，字段集合只在这里定义。
 * `check-guard` 有源码断言：`cli/keepalive.mjs` 与 `src/core/panel-service.ts` 都不许出现 `rewriteFp:` 字面量。
 *
 * 注意工厂只负责「组装字段」，**不负责算 touch/gap/价格** —— 那些各侧口径不同（有账本、有 settings）。
 */
import type { LedgerEntry } from '../store.ts'
import { recomputeCost, type RecomputeSettings } from '../econ.ts'

export interface LedgerEntryInput {
  /** 记账时刻（毫秒）。 */
  at: number
  /** 距上一次保温的秒数（无上一条则 0）。 */
  gapSeconds: number
  /** 本次请求的 prompt 总 token（命中 + 未命中 + 新建缓存）。 */
  promptTokens: number
  hitTokens: number
  missTokens: number
  outputTokens: number
  cacheWriteTokens?: number
  cost: number
  hitRate: number
  /** 提供方没报命中数时要标出来，否则会被当成 0 命中去熔断。 */
  cacheUnknown?: boolean
  ms: number
  /** 连续保温次数（断档超过 3 个间隔则重置为 1）。 */
  touch: number
  cycle: number
  via: string
  model: string
  factor?: number
  factorLabel?: string
  /** 内容指纹（tools+messages 前 8 条的哈希）。判定基准。 */
  fingerprint?: string
  /** 改写指纹（`kind:sub:seq` / 无改写为空串）。判定基准。 */
  rewriteFp?: string
  /** 这一条是不是离线装配保的（面板据此显示「自动·离线」）。 */
  offline?: boolean
}

export function buildLedgerEntry(input: LedgerEntryInput): LedgerEntry {
  const entry: LedgerEntry = {
    at: input.at,
    gapSeconds: input.gapSeconds,
    promptTokens: input.promptTokens,
    hitTokens: input.hitTokens,
    missTokens: input.missTokens,
    outputTokens: input.outputTokens,
    cacheWriteTokens: input.cacheWriteTokens ?? 0,
    cost: input.cost,
    hitRate: input.hitRate,
    ms: input.ms,
    touch: input.touch,
    cycle: input.cycle,
    via: input.via,
    model: input.model,
    factor: input.factor,
    factorLabel: input.factorLabel,
  }
  if (input.cacheUnknown === true) entry.cacheUnknown = true
  if (typeof input.fingerprint === 'string' && input.fingerprint !== '') entry.fingerprint = input.fingerprint
  /** `''` 是**合法值**（= 此刻没有改写），必须落账：漏写就退化成 `unknown`，判定失去基准。 */
  if (typeof input.rewriteFp === 'string') entry.rewriteFp = input.rewriteFp
  if (input.offline === true) entry.offline = true
  return entry
}

/**
 * **展示花费的唯一入口**：逐笔按当前价重算后求和。
 *
 * 账本 `entry.cost` 是记账时的价快照 —— 改价后**展示**必须跟着变，而**判定**（预算 / 熔断 /
 * `store.ts` 的 `spendOf`·`cycleSpendOf`）必须继续用存储值。三面（插件 snapshot / 离线面板
 * `buildRow` / CLI `--list`）都走这里，别各自手写 Σ：任一处漏改就是「同一会话两个金额」。
 *
 * 不在循环里 `normalizePrices`：价格在 `loadState` 时就归一化过，`recomputeCost` 内部也不再归一
 * （面板侧只在时间轴入口显式归一一次）。
 */
export function spendAtCurrentPrices(entries: readonly LedgerEntry[], settings: RecomputeSettings): { cost: number } {
  let sum = 0
  for (const e of entries) sum += recomputeCost(e, settings).cost
  return { cost: sum }
}
