/**
 * **「立即保温」窗口验证**（`--lab idle`）：虚构「最后对话 N 小时前」的会话，走真实门禁判定。
 *
 * 为什么需要它（用户原话）：「找一条最后对话在 4~8 小时之间的会话——没有。应该有测试工具，虚构一条」。
 * 真实环境里几乎不可能正好有一条落在窗口内的会话，而**这条窗口正是「立即保温」唯一该成功的区间**：
 *   - 距最后对话 < 间隔（默认 4h）→ `too-soon`（缓存还热，白保）
 *   - 距最后对话 > 闲置上限（默认 8h）→ `cold-window-idle`（缓存大概率已断，白保）
 *   - 两者之间 → **放行**
 *
 * 网页版多一个 2 分钟延迟（`delayMs`），所以它的下边界是「间隔 + 2 分钟」。
 *
 * 判定一律调真代码（`buildGateInput` + `decideWarm`），本文件只负责造点和排版。
 * 纯内存、零 IO、零网络、零花费 —— 不碰真实 `~/.dsh`。
 */
import { DEFAULT_SETTINGS, type State } from '../../store.ts'
import { buildGateInput } from '../gate-input.ts'
import { decideWarm, type GateDecision } from '../../gate.ts'

export const MIN = 60_000
export const HOUR = 60 * MIN

/** 网页版比插件版多等的 2 分钟（`b4ba782`：网页版路径有 2 分钟延后）。 */
export const WEB_DELAY_MS = 2 * MIN

/** 生产默认：间隔 4 小时、闲置上限 8 小时、fresh 5 分钟（**不用 `LAB_OVERRIDES`**，那是试验模式的 30 秒节奏）。 */
export const WINDOW_SETTINGS = {
  ...DEFAULT_SETTINGS,
  intervalSeconds: 4 * 3600,
  idleLimitHours: 8,
  freshSeconds: 5 * 60,
}

export interface WindowPoint {
  /** 距「最后对话」多久。 */
  idleMs: number
  /** 0 = 插件版路径；`WEB_DELAY_MS` = 网页版路径。 */
  delayMs: number
  expect: 'warm' | 'too-soon' | 'cold-window-idle'
}

/** 5 个插件版边界点 + 2 个网页版点（验证 2 分钟延迟真的把下边界推后了）。 */
export const WINDOW_POINTS: WindowPoint[] = [
  { idleMs: 4 * HOUR - MIN, delayMs: 0, expect: 'too-soon' },
  { idleMs: 4 * HOUR + MIN, delayMs: 0, expect: 'warm' },
  { idleMs: 5 * HOUR, delayMs: 0, expect: 'warm' },
  { idleMs: 8 * HOUR - MIN, delayMs: 0, expect: 'warm' },
  { idleMs: 8 * HOUR + MIN, delayMs: 0, expect: 'cold-window-idle' },
  { idleMs: 4 * HOUR + MIN, delayMs: WEB_DELAY_MS, expect: 'too-soon' },
  { idleMs: 4 * HOUR + 3 * MIN, delayMs: WEB_DELAY_MS, expect: 'warm' },
]

const SESSION_ID = 'session-warmwindow'

/** 造一条「最后对话 = now - idleMs、从没保过」的会话状态（空账本 → 走「未保过」分支）。 */
export function stateOf(settings: typeof WINDOW_SETTINGS = WINDOW_SETTINGS): State {
  return {
    version: 1,
    settings: { ...settings },
    sessions: { [SESSION_ID]: { mode: 'auto' } },
    ledger: {},
    touchBase: {},
    cycles: { [SESSION_ID]: 1 },
    pinnedSessions: [],
  } as State
}

/** 对单个点跑真实门禁。 */
export function evaluate(point: WindowPoint, settings: typeof WINDOW_SETTINGS = WINDOW_SETTINGS): {
  decision: GateDecision
  code: string
  idleMs: number
  delayMs: number
} {
  const now = 1000 * HOUR
  const state = stateOf(settings)
  const lastActivityAt = now - point.idleMs
  const decision = decideWarm(buildGateInput(state, {
    id: SESSION_ID,
    mtime: lastActivityAt,
    lastActivityAt,
    hasRoute: true,
    tripped: false,
    archived: false,
    agentStatus: 'idle',
    at: now,
    delayMs: point.delayMs,
  }))
  return { decision, code: decision.ok ? 'warm' : String(decision.code), idleMs: point.idleMs, delayMs: point.delayMs }
}

/** 把毫秒排成 `4h01m` / `3h59m` / `5m` 这种一眼看懂的形式。 */
export function spanText(ms: number): string {
  const total = Math.round(ms / MIN)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}m`
}
