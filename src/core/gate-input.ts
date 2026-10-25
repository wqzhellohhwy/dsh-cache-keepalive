/**
 * 门禁输入的唯一构造 —— 插件 tick / 插件面板 / 独立 CLI **共用这一份**。
 *
 * 为什么必须共用：门禁字段过去在三处各写一遍，口径一漂就出现「同一条会话，
 * 面板说能保、CLI 说不能保」。已踩过的三种漂移：
 *  - 次数用 `touchCountOf()`（减 `touchBase`）还是累计 `touch`；
 *  - 预算用当前周期 `cycleSpendOf()` 还是全账本 `led.reduce()`；
 *
 * 只把**纯 state + 会话 id/最后活动时间**能算的部分放这里；只有活会话才有的信息
 * （`agent.status`、真实路由、内存里的活动时间）由调用方通过 `opts` 覆盖。
 */
import type { GateInput } from '../gate.ts'
import { cycleSpendAtCurrentPrices, DEFAULT_SETTINGS, ledgerOf, policyOf, touchCountOf, type State } from '../store.ts'

export interface BuildGateInputOptions {
  /** 会话 id。 */
  id: string
  /** 日志 mtime（没有活会话时的最后活动时间兜底）。 */
  mtime: number
  /** 有没有可用路由（装配前乐观 `true`，装配后用真实 provider/model）。 */
  hasRoute: boolean
  /** 是否处于熔断（调用方算）。 */
  tripped: boolean
  /** 活会话的状态；不传按 `idle`。`'running'` 不再影响门禁结论。 */
  agentStatus?: 'running' | 'idle'
  /** 最后活动时间；不传按 `mtime`。插件侧有内存活动时间，传进来覆盖。 */
  lastActivityAt?: number
  /** 会话是否已归档（归档不保）。 */
  archived?: boolean
  /** 日志尾部是否有「压缩/goal 改写且其后无真实请求」。 */
  rewritten?: boolean
  /** 改写原因的说明文案。 */
  rewriteDetail?: string
  /** 判定时刻。 */
  at?: number
/** 保温延后（毫秒）：网页版给插件版让路时传 120000，默认 0。 */
  delayMs?: number
  /**
   * 是否子代理会话（日志头 `origin === 'subagent'`）。
   *
   * **三个调用方都要传**（tick / `/ping`、面板服务、CLI），漏传则子代理仍按主会话的
   * 4 小时间隔判 —— 子代理活不到那么久，进了候选也是 `too-soon`（即「子代理也算」看着失效）。
   */
  isSubagent?: boolean
  /**
   * 会话的 provider / model —— 用来查 `settings.modelOverrides`（按模型自定义门槛）。
   * **不传就只用通用值**（不报错）。
   */
  provider?: string
  model?: string
}

/**
 * 该会话该用的间隔（毫秒）：`policy.intervalSeconds` 优先，其次 `settings.intervalSeconds`。
 *
 * 运行时下限 **1 秒**（不是 60 秒）：试验模式要 30 秒间隔，被抬成 60 秒就等于秒级实验失效。
 */
export function intervalOf(state: State, policy: { intervalSeconds?: number }): number {
  const base = policy.intervalSeconds ?? state.settings.intervalSeconds
  return Math.max(1, Number(base) || 60) * 1000
}

/** 闲置上限（毫秒）：门禁与自动候选共用这一条线。最小 1 分钟，脏值回落默认 8 小时。 */
export function idleLimitMsOf(state: State): number {
  const h = Number(state.settings.idleLimitHours)
  const hours = Number.isFinite(h) && h > 0 ? h : DEFAULT_SETTINGS.idleLimitHours
  return Math.max(60_000, hours * 3600_000)
}

/**
 * **按 `provider/model` 算出这条会话该用的时间门槛** —— 唯一判定点。
 *
 * 优先级（`settings.modelOverrides[`${provider}/${model}`]`）：
 * ```
 * 模型设了值（> 0） → 用模型的
 * 模型留空 / 缺字段  → 用通用的 idleLimitHours / intervalSeconds
 * 模型填 0          → 该模型**不保温**（`disabled: true`）
 * ```
 *
 * ## 为什么「填 0 = 不保温」
 * 0 小时闲置上限或 0 秒间隔在语义上没有别的解释；「想关掉某个模型」比「设一个极小值」更明确。
 *
 * @param settings 设置
 * @param provider 会话的 provider（`request/header.config.provider`）
 * @param model 会话的 model
 * @returns `{ idleLimitMs, intervalMs, disabled }`
 */
export function effectiveLimitsOf(
  settings: State['settings'],
  provider: string | undefined,
  model: string | undefined,
): { idleLimitMs: number; intervalMs: number; disabled: boolean; intervalOverridden: boolean } {
  const key = typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== ''
    ? `${provider}/${model}`
    : undefined
  /**
   * **两级匹配**：
   * 1. 精确 `provider/model`
   * 2. 键里不含 `/` 时按**模型名**匹配（面板「模型价表」只有模型名，没有 provider）
   *
   * ⚠️ 不能只做 1：面板存的键是 `deepseek-v4.1-flash-1017`，而判定侧拿的是
   * `tokenrhythm-title/deepseek-v4.1-flash-1017` —— 只比精确就永远命不中。
   */
  const overrides = settings.modelOverrides ?? {}
  let override = key === undefined ? undefined : overrides[key]
  if (override === undefined && typeof model === 'string' && model !== '') {
    const byModel = Object.keys(overrides).filter((k) => !k.includes('/') && (k === model || key?.endsWith('/' + k) === true))
    /** 多个命中时取最长的键（与价格表「最长包含」同思路）。 */
    byModel.sort((a, b) => b.length - a.length)
    if (byModel.length > 0) override = overrides[byModel[0]]
  }

  /** 通用值。 */
  const baseIdleHours = Number(settings.idleLimitHours)
  const baseIdleMs = Math.max(60_000, (Number.isFinite(baseIdleHours) && baseIdleHours > 0 ? baseIdleHours : DEFAULT_SETTINGS.idleLimitHours) * 3600_000)
  const baseIntervalSec = Number(settings.intervalSeconds)
  const baseIntervalMs = Math.max(1, Number(baseIntervalSec) || 60) * 1000

  if (override === undefined) return { idleLimitMs: baseIdleMs, intervalMs: baseIntervalMs, disabled: false, intervalOverridden: false }

  /** 0 = 关掉这个模型。 */
  const ovIdle = override.idleLimitHours
  const ovInterval = override.intervalSeconds
  if (ovIdle === 0 || ovInterval === 0) return { idleLimitMs: 0, intervalMs: 0, disabled: true, intervalOverridden: true }

  const idleHours = typeof ovIdle === 'number' && Number.isFinite(ovIdle) && ovIdle > 0 ? ovIdle : null
  const intervalSec = typeof ovInterval === 'number' && Number.isFinite(ovInterval) && ovInterval > 0 ? ovInterval : null

  return {
    idleLimitMs: idleHours === null ? baseIdleMs : Math.max(60_000, idleHours * 3600_000),
    intervalMs: intervalSec === null ? baseIntervalMs : Math.max(1, intervalSec) * 1000,
    disabled: false,
    /** 模型没设间隔时，调用方应回落到**会话策略**（`policy.intervalSeconds`）而不是通用值。 */
    intervalOverridden: intervalSec !== null,
  }
}


/** 「刚保过」窗口（毫秒）：最小 0（= 永不 fresh），脏值回落默认 300 秒。 */
export function freshMsOf(state: State): number {
  const sec = Number(state.settings.freshSeconds)
  const n = Number.isFinite(sec) && sec >= 0 ? sec : DEFAULT_SETTINGS.freshSeconds
  return Math.max(0, Math.round(n * 1000))
}

/**
 * 子代理专用间隔（毫秒）：`settings.subagentIntervalSeconds`，脏值回落默认 120 秒。
 *
 * 子代理寿命实测 59s / 86s / 127s / 314s …… 最长 2910s；用主会话的 4 小时间隔
 * 等于永远等不到窗口（这就是「子代理也算」看着失效的真因）。最小 1 秒，与 `intervalOf` 同口径。
 */
export function subagentIntervalMsOf(state: State): number {
  const sec = Number(state.settings.subagentIntervalSeconds)
  const n = Number.isFinite(sec) && sec > 0 ? sec : (DEFAULT_SETTINGS.subagentIntervalSeconds ?? 120)
  return Math.max(1, Math.round(n * 1000))
}

/** 组装门禁输入。 */
export function buildGateInput(state: State, opts: BuildGateInputOptions): GateInput {
  const policy = policyOf(state, opts.id)
  const led = ledgerOf(state, opts.id)
  const last = led[led.length - 1]
  /**
   * **按模型自定义门槛**：`provider/model` 有覆盖就用覆盖值（唯一判定点 `effectiveLimitsOf`）。
   *
   * 覆盖里填 `0` = 「该模型不保温」：`idleLimitMs` 置 0 让 `idleFirst > idleLimitMs` 立刻成立
   * ⇒ 判 `cold-window-idle` 跳过；`intervalMs` 也置 0，免得先被 `too-soon` 拦住。
   */
  const limits = effectiveLimitsOf(state.settings, opts.provider, opts.model)
  /**
   * 间隔的优先级：**模型覆盖 > 会话策略（`policy.intervalSeconds`）> 通用**。
   * `effectiveLimitsOf` 已按两级匹配算出覆盖值；**`disabled` 时它返回 0**，
   * 但「0 秒间隔」和「没设」要区分 —— 所以这里用它是否 `> 0` 判断有没有生效。
   */
  const intervalMs = limits.disabled ? 0 : limits.intervalOverridden ? limits.intervalMs : intervalOf(state, policy)
  return {
    now: opts.at ?? Date.now(),
    agentStatus: opts.agentStatus ?? 'idle',
    lastActivityAt: opts.lastActivityAt ?? opts.mtime,
    lastTouchAt: last?.at ?? 0,
    /** 本周期次数（已减清账基线），与 `cumulativeCost` 同口径。 */
    touchCount: touchCountOf(state, opts.id),
    /** 累计次数（跨周期）——「累计上限」用它，清账也绕不过去。 */
    touchCountTotal: last?.touch ?? 0,
    /** 预算按**当前周期**算：清除计费就是重新开始。 */
    cumulativeCost: cycleSpendAtCurrentPrices(state, state.settings, opts.id),
    tripped: opts.tripped,
    rewritten: opts.rewritten === true,
    rewriteDetail: opts.rewriteDetail,
    hasRoute: opts.hasRoute,
    intervalMs,
    /** 只在子代理时生效（`decideWarm` 判 `isSubagent`）；普通会话不看它，给出去零成本。 */
    subagentIntervalMs: subagentIntervalMsOf(state),
    isSubagent: opts.isSubagent === true,
    idleLimitMs: limits.idleLimitMs,
    freshMs: freshMsOf(state),
    delayMs: opts.delayMs ?? 0,
    archived: opts.archived === true,
    maxTouches: policy.maxTouches ?? state.settings.maxTouches,
    maxTouchesTotal: state.settings.maxTouchesTotal ?? 0,
    budget: state.settings.budgetPerSession,
    manual: false,
    texts: state.settings.gateDetail,
  }
}

