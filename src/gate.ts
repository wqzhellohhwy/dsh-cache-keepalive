/**
 * 保温门禁 —— 决定「这一刻该不该给这条会话发保温请求」。
 *
 * 抽成纯函数是为了能**不花一分钱**地验证每条规则。所有实测教训都固化成这里的一条判断。
 *
 * **时间口径只有一套**：`idleLimitMs`（默认 6 小时）。
 * 它同时管两件事，两件事共用同一条线，不再各设门槛：
 *  - 从未保过 → 闲置超过它就是 `cold-window-idle`（热窗口早过去了；
 *    实测凉 24 分钟首次保温命中率仅 3.17%，花费 ≈ 一次冷启动，纯白做）
 *  - 保过 → 距最后一次刷新（`max(上次保温, 最后活动)`）超过它 → `stale`
 *    （实测某会话断档 5.5 小时再保命中 0%，白烧 0.2759 元）
 *
 * ⚠️ **别给「保过」另设更小的门槛**：`since` 已经是 `max(上次真实对话, 上次保温)`，
 * 缓存刷新本来就来自这两者之一，同一个 `since` 用两套阈值在逻辑上说不通。
 * 保温间隔 `intervalMs` **独立**，只决定「多久保一次」，不参与任何门槛计算。
 *
 * 其余规则（**终局优先**：上限类判据一律排在「这次不行」之前）：
 *  - `archived`     会话已归档 → 不保（用户的显式处置，压过一切）
 *  - `tripped`      上次命中率塌了 → 立即停手（漏一次 = 50 次保温的钱）
 *  - `no-route`     会话还没路由过任何请求 → 拿不到 provider/model，无从保温
 *  - `prefix-changed` 日志尾部刚被压缩/goal 改写且其后没有真实请求 → 保了是付全量
 *  - `budget` / `max-touches` / `max-touches-total` 终局上限 → **先于** fresh / too-soon 判定
 *    （触顶就是这条会话不该再保，说成「等一会儿就好」会误导用户）
 *  - `fresh`        距上次保温不到 `freshMs`
 *  - `too-soon`     距上次保温/活动还不够一个间隔
 *
 * ⚠️ **不再拦截「正在跑回合」**：会话跑着也保（真回合自己会刷新缓存，
 * 我们的保温与它并行不冲突；多一次保温只是概率性重复，不会拉低命中）。
 */

import { GATE_DETAIL_DEFAULTS, GATE_TEXTS_BY_KEY, LONG_IDLE_MS, gateDetailOf, renderGateText } from './core/gate-texts.ts'

export type GateSkip =
  /** 会话正在跑回合。**保留类型但不再由 decideWarm 返回**（面板筛选表仍引用它）。 */
  | 'running'
  | 'no-route'
  | 'tripped'
  /** 保过，但距最后刷新超过闲置上限 —— 缓存大概率已断。 */
  | 'stale'
  /** 从未保温且活动时间未知。 */
  | 'cold-window'
  /** 从未保温且闲置超过闲置上限 —— 缓存大概率已断，门禁列标红。 */
  | 'cold-window-idle'
  | 'fresh'
  | 'too-soon'
  | 'budget'
  | 'max-touches'
  | 'max-touches-total'
  /** 会话已归档，不保温。 */
  | 'archived'
  /** 前缀被压缩/goal 改写过且没被真实请求重建 —— 保了就是付全量。 */
  | 'prefix-changed'

export interface GateInput {
  /** 当前时间（毫秒）。 */
  now: number
  /** agent 状态；`'running'` **不再拦截**（保留字段供展示/兼容）。 */
  agentStatus?: string
  /** 会话最后一条事件的时间（毫秒）；0 表示未知。 */
  lastActivityAt: number
  /** 上次保温时间（毫秒）；0 表示从未保过。 */
  lastTouchAt: number
  /** 连续保温次数（最近一次记录的 touch）。 */
  touchCount: number
  /** 累计保温次数（跨周期，不减清账基线）。 */
  touchCountTotal: number
  /** 该会话**本周期**累计花费（元）。 */
  cumulativeCost: number
  /** 是否已熔断。 */
  tripped: boolean
  /** 日志尾部刚发生「压缩 / goal 改写」且其后没有真实请求 → 缓存还是改写前的，保了是付全量。 */
  rewritten?: boolean
  /** 是否拿得到 provider/model。 */
  hasRoute: boolean
  /** 保温间隔（毫秒）——只管节奏，不参与门槛。 */
  intervalMs: number
  /**
   * 子代理专用保温间隔（毫秒）。**只在 `isSubagent === true` 时生效**，替代 `intervalMs`。
   *
   * 子代理寿命实测 59s / 86s / 127s / 314s …… 最长 2910s（1~50 分钟），
   * 用主会话的 4 小时间隔等于永远等不到窗口（进了候选也是 `too-soon`）。
   * 不传 = 沿用 `intervalMs`。
   */
  subagentIntervalMs?: number
  /**
   * 是否子代理会话。为 true 时**不吃 `delayMs`**：那个延后是给网页版给插件版让路的，
   * 子代理活不了那么久，加上去 120+120=240 秒照样错过。
   */
  isSubagent?: boolean
  /** 闲置上限（毫秒）：门禁与自动候选共用这一条线。**用于「从未保过」的冷窗口判定**。 */
  idleLimitMs: number
  /** 「刚保过」窗口（毫秒）：距上次保温小于它就是 `fresh`。`0` = 永不 fresh。 */
  freshMs: number
  /** 保温延后（毫秒）：网页版（CLI --serve）给插件版让路用，默认 0 = 不延迟。 */
  delayMs?: number

  /** 会话是否已归档。 */
  archived?: boolean
  /** 最大连续保温次数。 */
  maxTouches: number
  /** 累计次数上限（0 = 不限）。 */
  maxTouchesTotal: number
  /** 累计花费上限（元）。 */
  budget: number
  /** 改写原因的说明文案（由调用方给，便于在面板说清是压缩还是 goal）。 */
  rewriteDetail?: string
  /** 手动模式标记。**不再参与任何判定**（两条门槛已合并，保留字段仅为兼容调用方）。 */
  manual?: boolean
  /** 说明文案模板（来自 settings.gateDetail）；不传则用 gate-texts.ts 的默认值。 */
  texts?: Record<string, string>
}

export type GateDecision =
  | { ok: true; reason: 'warm' }
  /** `long` = 走的是**长档**文案（只有 `cold-window-idle` / `stale` 才有，闲置 > `LONG_IDLE_MINUTES`）。 */
  | { ok: false; code: GateSkip; detail: string; long?: boolean }

const minutes = (ms: number): string => `${Math.round(ms / 60000)} 分钟`
/** 秒级实验要用秒做单位，否则 5 秒窗口会显示成「0 分钟」。 */
const span = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : minutes(ms))

/** 判断这一刻该不该保温。纯函数：同样的输入永远给同样的结论。 */
export function decideWarm(input: GateInput): GateDecision {
  const {
    now, lastActivityAt, lastTouchAt, touchCount, touchCountTotal, cumulativeCost,
    tripped, hasRoute, intervalMs, idleLimitMs, freshMs, maxTouches, maxTouchesTotal, budget,
  } = input
  /**
   * 子代理：换短间隔 + **不吃网页版延后**。两处必须同时换 ——
   * 只换间隔的话，`--serve --auto`（`WARM_DELAY_MS=120000`）下门槛是 120+120=240 秒，
   * 而子代理多数活不到 240 秒，等于没修。
   */
  const isSubagent = input.isSubagent === true
  const subMs = Number(input.subagentIntervalMs)
  const effInterval = isSubagent && Number.isFinite(subMs) && subMs > 0 ? subMs : intervalMs
  const delay = isSubagent ? 0 : Math.max(0, Number(input.delayMs) || 0)
  /**
   * 渲染说明：`long` 为真时走**长档**（用户覆盖 `key:long` → `detailLong`），两档互不回退。
   * 没有定义的门禁码回落到老行为（用户覆盖 → 默认表），不影响任何现有文案。
   */
  const T = (key: string, vars?: Record<string, string>, long = false): string => {
    const def = GATE_TEXTS_BY_KEY[key]
    if (def === undefined) return renderGateText(input.texts?.[key] || GATE_DETAIL_DEFAULTS[key] || '', vars)
    return renderGateText(gateDetailOf(def, long, input.texts), vars)
  }

  // ── 一、硬拦截（与时间无关）─────────────────────────────────────────
  // 归档是用户的显式处置 → 最高优先级，压过熔断等一切理由
  if (input.archived === true) {
    return { ok: false, code: 'archived', detail: T('archived') }
  }
  if (tripped) {
    return { ok: false, code: 'tripped', detail: T('tripped') }
  }
  if (!hasRoute) {
    return { ok: false, code: 'no-route', detail: T('no-route') }
  }
  /**
   * **前缀被改写且没被真实请求重建** → 不保。压缩改历史中段、goal 改 system，两者都不进前缀指纹，
   * 只能靠日志事件判；保了等于替用户付一次冷启动。
   */
  if (input.rewritten === true) {
    return { ok: false, code: 'prefix-changed', detail: input.rewriteDetail ?? T('prefix-changed') }
  }
  /**
   * ── 二、**终局上限优先** ──────────────────────────────────────────
   * 超预算 / 次数用尽 = 这条会话**不该再保**；`fresh` / `too-soon` = **这次不行、以后行**。
   * 顺序反了会把「永远保不了」说成「等一会儿就好」——用户会一直等。
   */
  if (cumulativeCost >= budget) {
    return { ok: false, code: 'budget', detail: T('budget', { budget: String(budget) }) }
  }
  if (touchCount >= maxTouches) {
    return { ok: false, code: 'max-touches', detail: T('max-touches', { touch: String(touchCount), max: String(maxTouches) }) }
  }
  /** 累计上限（0 = 不限）：清账也绕不过去的总量。 */
  if (maxTouchesTotal > 0 && touchCountTotal >= maxTouchesTotal) {
    return {
      ok: false,
      code: 'max-touches-total',
      detail: T('max-touches-total', { touch: String(touchCountTotal), max: String(maxTouchesTotal) }),
    }
  }
  /**
   * 刷新时刻 = `max(上次保温, 最后活动)`。
   * ⚠️ 不能只看「距上次保温」：用户刚聊完时缓存是被**那次真实请求**刷新的，
   * 此时哪怕距上次保温已经很多小时，缓存也是热的、完全值得保。
   */
  const since = Math.max(lastTouchAt, lastActivityAt)
  const warmedBefore = lastTouchAt > 0
  // ── 三、时间判据 ──────────────────────────────────────────────────
  /**
   * 从未保过：必须能**确认它还是热的**，否则保温只会白付一次冷启动。
   * 活动时间未知（插件刚重启、老会话）→ 保守不发（实测凉会话照样放行是漏洞）。
   */
  if (!warmedBefore) {
    if (lastActivityAt === 0) {
      return { ok: false, code: 'cold-window', detail: T('cold-window') }
    }
    const idleFirst = now - lastActivityAt
    /** 闲置超过上限 → 拦截；再超过 `LONG_IDLE_MS` 就走**长档**（状态词变「闲置过久」）。 */
    if (idleFirst > idleLimitMs) {
      const long = idleFirst > LONG_IDLE_MS
      return {
        code: 'cold-window-idle',
        ok: false,
        ...(long ? { long: true } : {}),
        detail: T('cold-window-idle', { idle: span(idleFirst), window: span(idleLimitMs) }, long),
      }
    }
    /** 还没到间隔（含网页版的 2 分钟延后）→ 等一会儿再来。 */
    if (idleFirst < effInterval + delay) {
      return {
        code: 'too-soon',
        ok: false,
        detail: T('too-soon', {
          label: '上次对话',
          gap: span(idleFirst),
          interval: span(effInterval),
          remain: span(effInterval + delay - idleFirst),
        }),
      }
    }
  }
  /**
   * **距最后刷新超过门槛 → 缓存大概率早断了，别烧钱。**
   *
   * ⚠️ **必须排在 `too-soon` 之前**：`too-soon` 的含义是「缓存还热，等一会儿再保」，
   * 而这里已经判定「缓存断了」。先后颠倒会让「距刷新 3.5h（门槛 3h）但还没到 4h 间隔」
   * 报成 `too-soon` —— 用户看到「还差 30 分钟」，实际上再等半小时缓存早没了。
   *
   * 直接与门槛比，**不再掺间隔**：掺了间隔就会出现「间隔 4h + 门槛 4h 互相卡死」。
   *
   * 实测（3f0b 四条纯保温）：
   * ```
   * 04:15 cli   1.03%  间隔 4.04h，prompt 一字不差 ⇒ 缓存已失效
   * 09:43 panel 1.04%  间隔 5.47h
   * 09:57 cli  99.73%  间隔 0.23h
   * ```
   */
  if (warmedBefore && now - since > idleLimitMs) {
    const idleStale = now - since
    /** 断档超过 `LONG_IDLE_MS` → 长档（状态词变「断档过久」）。 */
    const long = idleStale > LONG_IDLE_MS
    return {
      code: 'stale',
      ok: false,
      ...(long ? { long: true } : {}),
      detail: T('stale', { since: span(idleStale), limit: span(idleLimitMs) }, long),
    }
  }
  /**
   * **刚保过**（`freshMs` 内）单独成一个状态：此时显示「已经保温」比「未到间隔」更准确。
   * 窗口一过自动变回 too-soon。`freshMs === 0` = 关掉这个状态。
   */
  if (warmedBefore && freshMs > 0 && now - lastTouchAt < freshMs) {
    return {
      ok: false,
      code: 'fresh',
      detail: T('fresh', { since: span(now - lastTouchAt), window: span(freshMs) }),
    }
  }
  // 到点了没
  if (warmedBefore && now - since < effInterval + delay) {
    const gap = now - since
    const remain = effInterval + delay - gap
    const sinceLabel = lastActivityAt > lastTouchAt ? '上次活动' : '上次保温'
    return {
      ok: false,
      code: 'too-soon',
      detail: T('too-soon', {
        label: sinceLabel,
        gap: span(gap),
        interval: span(effInterval),
        remain: span(remain),
      }),
    }
  }
  return { ok: true, reason: 'warm' }
}
