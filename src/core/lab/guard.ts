/**
 * 试验模式的**成本护栏**（三道硬闸）。
 *
 * 关键约束：**只在 `labMode === true` 时生效**。非试验模式下 `labVerdict()` 恒放行，
 * 生产路径行为逐字节不变 —— 这条用单测钉死（`tests/lab-guard.test.mjs`）。
 *
 * 为什么必须放代码路径里而不是只放设置：设置谁都能改（面板 / agent / CLI / 手改 state.json），
 * 护栏必须是「发请求前的硬判」，改设置也绕不过去。
 */
import { labPendingWorstOf, type LedgerEntry, type State } from '../../store.ts'
import type { Prices } from '../../econ.ts'

export interface LabVerdict {
  ok: boolean
  /** 拦在哪一步：`mode`（非试验，放行）/ `allowlist` / `budget` / `reserve`（单次最坏花费放不下）。 */
  step: 'mode' | 'allowlist' | 'budget' | 'reserve'
  why: string
}

/**
 * **单次最坏花费（元）**：全未命中 + 输出打满。
 *
 * `(promptTokens + maxTokens) * miss / 1e6` —— 这是「这一次请求最多能从你钱包里拿多少」，
 * 护栏必须在**发请求前**用它预留，否则「本轮最多 0.5 元」只是空话：
 * 一次 693k 全未命中 = 0.693 元，一次就冲破。
 */
export function worstCostOf(promptTokens: number, maxTokens: number, prices: Prices): number {
  const p = Number.isFinite(promptTokens) && promptTokens > 0 ? promptTokens : 0
  const m = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 0
  const miss = Number.isFinite(prices.miss) && prices.miss > 0 ? prices.miss : 0
  return (p + m) * miss / 1e6
}

/**
 * 发请求前**估** prompt token（护栏要保守 = 估高）。
 *
 * 口径：序列化后长度 / 3。中文约 1 字 1 token（UTF-8 3 字节）、英文约 4 字符 1 token，
 * 除以 3 对中文准、对英文偏**高**，偏保守正合适。与账本末条的真实 `promptTokens` 取较大者。
 */
export function promptTokensEstimate(serialized: unknown, lastPromptTokens = 0): number {
  let bytes = 0
  try {
    const s = typeof serialized === 'string' ? serialized : JSON.stringify(serialized)
    bytes = s === undefined ? 0 : s.length
  } catch {
    bytes = 0
  }
  return Math.max(Math.round(bytes / 3), Number.isFinite(lastPromptTokens) ? lastPromptTokens : 0, 0)
}

/** 粗口径文本（面板 / CLI / 日志共用）。 */
export function labYuan(n: number): string {
  return `${n.toFixed(4)} 元`
}

/**
 * 第一道：必须 `labMode === true` **且**会话在 `labSessionAllow` 里。
 *
 * 非试验模式 → 恒放行（`step: 'mode'`），调用方据此零成本短路。
 */
export function labAllowed(state: State, sessionId: string): LabVerdict {
  const s = state.settings
  if (s.labMode !== true) return { ok: true, step: 'mode', why: '非试验模式：不做试验护栏拦截' }
  const allow = Array.isArray(s.labSessionAllow) ? s.labSessionAllow : []
  if (allow.length === 0) {
    return { ok: false, step: 'allowlist', why: '试验模式未配置白名单（settings.labSessionAllow 为空）→ 拒绝一切保温' }
  }
  if (!allow.includes(sessionId)) {
    return { ok: false, step: 'allowlist', why: `会话不在试验白名单里（白名单 ${allow.length} 条）→ 拒绝` }
  }
  return { ok: true, step: 'allowlist', why: '会话在白名单里' }
}

/**
 * 本轮试验已花（元）：账本里 `at >= sinceAt` 的条目累加。
 *
 * `sinceAt <= 0` = **没有进行中的试验** → 本轮花费 **0**（不是「全部账本」）。
 * 用全部账本会让历史花费一路把预算顶死，试验永远开不起来。
 */
export function labSpendOf(ledger: readonly LedgerEntry[] | undefined, sinceAt: number): number {
  if (sinceAt <= 0 || ledger === undefined || ledger.length === 0) return 0
  return ledger.reduce((sum, e) => (e.at >= sinceAt ? sum + e.cost : sum), 0)
}

/**
 * 第二道：本轮总花费是否触顶。
 *
 * `budget <= 0` 视为**不限**（但仍受每会话 `budgetPerSession` 约束，那一层在 `spendGuard()`）。
 */
export function labOverBudget(
  state: State,
  ledger: readonly LedgerEntry[] | undefined,
  sinceAt: number,
  sessionId?: string,
): {
  over: boolean
  spent: number
  budget: number
} {
  const budget = Number(state.settings.labBudgetPerRun)
  /**
   * **本轮预算是「跨会话合计」** —— 必须用**全部会话**的账本，不能用传入的单会话账本：
   * 否则「5 条各花 0.05、预算 0.11」会每条都只看自己（0）→ 全部放行，实际超 4 倍。
   * 传入的 `ledger` 只在 state 里没账本时作兜底。
   */
  const all = state.ledger !== undefined && Object.keys(state.ledger).length > 0
    ? Object.values(state.ledger).flat()
    : (ledger ?? [])
  /** 在途/未知花费（G10）必须算进「已花」，否则连续请求会超预算；非试验模式恒 0。 */
  const spent = labSpendOf(all, sinceAt) + labPendingWorstOf(state, sessionId)
  if (!Number.isFinite(budget) || budget <= 0) return { over: false, spent, budget }
  return { over: spent >= budget, spent, budget }
}

/**
 * **G5 禁转发**：试验模式下**绝不**把保温请求转发给 DSH 实例。
 *
 * 沙箱里本没有 `runtime.json` 所以自然不转发；但误把 `DSH_HOME` 指到真实 home 时，
 * `readRuntime()` 会读到用户实例端口 → 请求直接打到 3084/3080，既花钱又不可控。
 * 这条闸不看有没有 runtime，只看 `labMode`。
 */
export function labAllowsForward(state: State | undefined): boolean {
  return state?.settings?.labMode !== true
}

/**
 * **G6：禁改价表**。执行器不接受任何 `prices` / `pricesByModel` / `tariff` 补丁 ——
 * 实验里改单价会让 `w/r`、次数上限、预算判定同时失真，且改完忘恢复会长期误导面板。
 * 返回剥离后的 patch 与被剥掉的键名（键名可以进日志，值绝不进）。
 */
export function stripPricePatch(patch: Record<string, unknown>): { patch: Record<string, unknown>; stripped: string[] } {
  const out: Record<string, unknown> = {}
  const stripped: string[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'prices' || k === 'pricesByModel' || k === 'tariff') stripped.push(k)
    else out[k] = v
  }
  return { patch: out, stripped }
}

export interface LabPrepOk {
  ok: true
  id: string
  /** 本次请求的最坏花费（元）。 */
  worst: number
  [k: string]: unknown
}
export interface LabPrepFail { ok: false; id: string; code: string; detail?: string }

export interface LabSendResult {
  ok: boolean
  usage?: Record<string, unknown>
  ms?: number
  model?: string
  error?: string
  /** 失败归属：`config`（重试也不会好）/ `gate`（只是这次不行）。缺省按 `ok === false` 视为 `gate`。 */
  failKind?: 'config' | 'gate'
}

export interface LabExecDeps {
  /** 必须显式为 true 才会真跑；否则第一行就返回。 */
  arm: boolean
  allow: readonly string[]
  /** JSONL 逐行落盘（注入，保持本模块零 IO）。**不得写入 key**。 */
  append: (row: Record<string, unknown>) => void
  getState: () => State
  prepare: (id: string) => Promise<LabPrepOk | LabPrepFail>
  send: (prep: LabPrepOk) => Promise<LabSendResult>
  record: (prep: LabPrepOk, out: LabSendResult) => { cost: number; hitRate: number; promptTokens: number }
  /** 连续几次 config 类失败即中止（G7）。默认 2。 */
  maxConfigFails?: number
  now?: () => number
}

export interface LabExecResult {
  armed: boolean
  /** 被 G7 中止的原因（未中止则无此字段）。 */
  aborted?: string
  results: { id: string; ok: boolean; why?: string; cost?: number }[]
}

let execSeq = 0

/**
 * **真跑执行器**（G10 原子预留账 + G7 失败即停 + G6 禁改价表）。
 *
 * 每笔请求：先写 `pending`（含 worstCost）→ 发 → 写 `update` 行（成功→实际 cost；
 * 无 usage/失败→ `unknown-cost`，按 worst 计入本轮花费）。因此「已花」= 账本 + 在途 worst。
 *
 * ⚠️ 未 arm 时**第一行就返回**，不读 state、不调 prepare、不写盘。
 * ⚠️ `append` 收到的一切内容都**不得包含 API key**。
 */
export async function runLabAttempts(deps: LabExecDeps): Promise<LabExecResult> {
  if (deps.arm !== true) return { armed: false, results: [] }
  const now = deps.now ?? (() => Date.now())
  const maxConfigFails = deps.maxConfigFails ?? 2
  const results: LabExecResult['results'] = []
  let configFails = 0
  /** 在途最坏花费：`labVerdict` 判预算时必须加进「已花」，否则连续请求会冲破上限。 */
  let inFlightWorst = 0

  for (const id of deps.allow) {
    if (configFails >= maxConfigFails) {
      const aborted = `G7 连续 ${configFails} 次配置类失败 → 中止本轮（剩余 ${deps.allow.length - results.length} 条未跑）`
      deps.append({ event: 'abort', reason: aborted, at: now() })
      return { armed: true, aborted, results }
    }
    const prep = await deps.prepare(id)
    if (prep.ok !== true) {
      /** 门禁/次数类失败不是「配置问题」，不计入 G7。 */
      const kind = prep.code === 'no-key' || prep.code === 'assemble' || prep.code === 'provider' ? 'config' : 'gate'
      if (kind === 'config') configFails += 1
      results.push({ id, ok: false, why: `prepare: ${prep.code}` })
      deps.append({ event: 'prepare', id, ok: false, code: prep.code, failKind: kind, at: now() })
      continue
    }
    const state = deps.getState()
    const lg = labVerdict(state, id, state.ledger?.[id] ?? [], prep.worst + inFlightWorst)
    if (!lg.ok) {
      results.push({ id, ok: false, why: `护栏: ${lg.step}` })
      deps.append({ event: 'reserve', id, ok: false, step: lg.step, why: lg.why, worst: prep.worst, at: now() })
      continue
    }
    /** G10：**发请求前**先落 pending（含 worst）——钱可能已经花了但没有 usage。 */
    execSeq += 1
    const recId = `${now()}-${execSeq}`
    deps.append({ event: 'pending', id: recId, sessionId: id, worst: prep.worst, at: now() })
    inFlightWorst += prep.worst
    let out
    try {
      out = await deps.send(prep)
    } catch (e) {
      out = { ok: false, error: e instanceof Error ? e.message : String(e), failKind: 'config' }
    } finally {
      inFlightWorst -= prep.worst
    }
    if (out.ok === true && out.usage !== undefined) {
      const e = deps.record(prep, out)
      deps.append({ event: 'update', id: recId, status: 'done', cost: e.cost, hitRate: e.hitRate, promptTokens: e.promptTokens, at: now() })
      results.push({ id, ok: true, cost: e.cost })
      configFails = 0
      continue
    }
    /** 没有 usage / 失败：**钱可能已花** → 按 worst 记为 unknown-cost（G10 的核心）。 */
    const kind = out.failKind ?? 'gate'
    if (kind === 'config') configFails += 1
    deps.append({
      event: 'update', id: recId, status: 'failed', failKind: kind,
      unknownCost: out.usage === undefined, chargedWorst: prep.worst, error: out.error ?? 'no-usage', at: now(),
    })
    results.push({ id, ok: false, why: out.error ?? '没有 usage（已按 worst 计入本轮花费）' })
  }
  return { armed: true, results }
}

/**
 * 三道（+单次预留）合一：**发请求前的唯一入口**（插件 `ping()` 与其离线分支、CLI `sendWarm()` 都调它）。
 *
 * 顺序固定：非试验短路 → 白名单 → 本轮预算 → **单次最坏花费预留**。
 * 非试验模式在第一条就返回，不产生任何附带计算（生产行为零变化）。
 *
 * @param worst 本次请求的最坏花费（`worstCostOf()` 的结果）。不传 = 只做「已花 ≥ 上限」判定（dry-run 用）。
 */
export function labVerdict(
  state: State,
  sessionId: string,
  ledger: readonly LedgerEntry[] | undefined,
  worst?: number,
): LabVerdict {
  if (state.settings.labMode !== true) return { ok: true, step: 'mode', why: '非试验模式' }
  const allow = labAllowed(state, sessionId)
  if (!allow.ok) return allow
  const b = labOverBudget(state, ledger, state.settings.labStartedAt ?? 0)
  if (b.over) {
    return { ok: false, step: 'budget', why: `本轮试验已花 ${labYuan(b.spent)} / 上限 ${labYuan(b.budget)} → 拒绝` }
  }
  /**
   * **单次最坏花费预留**：`已花 + worst > min(每会话预算, 本轮预算)` 就不发。
   * 两个预算任一为 0 视为「不限」；两个都不限 → 只显示已花。
   */
  if (worst !== undefined && Number.isFinite(worst) && worst >= 0) {
    const labCap = b.budget > 0 ? b.budget : Number.POSITIVE_INFINITY
    const perSession = Number(state.settings.budgetPerSession)
    const perCap = Number.isFinite(perSession) && perSession > 0 ? perSession : Number.POSITIVE_INFINITY
    const cap = Math.min(labCap, perCap)
    if (cap !== Number.POSITIVE_INFINITY && b.spent + worst > cap) {
      return {
        ok: false,
        step: 'reserve',
        why: `本次最坏要花 ${labYuan(worst)}，已花 ${labYuan(b.spent)} + 最坏 = ${labYuan(b.spent + worst)}`
          + ` 超过可用上限 ${labYuan(cap)}（剩余 ${labYuan(Math.max(0, cap - b.spent))}）→ 拒绝`,
      }
    }
    return {
      ok: true,
      step: 'reserve',
      why: `预留通过：已花 ${labYuan(b.spent)} + 本次最坏 ${labYuan(worst)}`
        + ` ≤ ${cap === Number.POSITIVE_INFINITY ? '不限' : labYuan(cap)}`,
    }
  }
  return { ok: true, step: 'budget', why: `本轮已花 ${labYuan(b.spent)} / 上限 ${b.budget > 0 ? labYuan(b.budget) : '不限'}` }
}
