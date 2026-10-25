/**
 * 虚拟环境世界构造 —— **纯内存 `State` 字面量**，零 IO、零网络、零 `state.json`。
 *
 * 两条建模铁律（踩过）：
 * 1. **`mtime` 必须与账本末条 `at` 对齐**：门禁的时间基准是 `since = max(lastTouchAt, lastActivityAt)`，
 *    两者不一致时 `mtime` 会顶住 `since`，所有场景退化成 `too-soon`。
 * 2. **账本条目必须自洽**：`hit + miss + write === prompt`，否则 `tripVerdict` 把 `rearmed` 判成 `tripped`。
 *
 * 只造世界，不做判定 —— 判定一律调真代码（`buildGateInput` / `decideWarm` / `decideCandidates`）。
 */
import { BREAK_CIRCUIT_HIT_RATE, costOf } from '../../econ.ts'
import { DEFAULT_SETTINGS, LAB_OVERRIDES, isTripped, type LedgerEntry, type SessionPolicy, type Settings, type State } from '../../store.ts'
import { decideWarm, type GateDecision } from '../../gate.ts'
import { buildGateInput } from '../gate-input.ts'
import { decideCandidates, type CandidateRow } from '../candidates.ts'
import type { CandidateDecision } from '../../auto.ts'

export const MIN = 60_000
export const HOUR = 60 * MIN
export const T0 = 1000 * HOUR

/** 会话属性（8 档，单独维度）。 */
export const C_IDS = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'] as const
export const C_NAMES: Record<string, string> = {
  C0: '普通', C1: '归档', C2: '子代理', C3: '无标题',
  C4: '手动 on', C5: '手动 off', C6: '无路由', C7: '前缀被改写',
}

/** 时间态（7 档）。 */
export const A_IDS = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6'] as const
export const A_NAMES: Record<string, string> = {
  A0: '活动时间未知', A1: '刚活动、未保过', A2: 'fresh 窗口内', A3: '正好一个间隔',
  A4: '间隔差 1 分钟', A5: '逼近闲置上限', A6: '超闲置上限',
}

/** 账本形态（9 档）。 */
export const B_IDS = ['B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8'] as const
export const B_NAMES: Record<string, string> = {
  B0: '空账本', B1: '1 条低命中', B2: '2 条连续低命中', B3: '低命中后重建(rearmed)',
  B4: '清账', B5: '换周期', B6: '本周期次数触顶', B7: '累计次数触顶', B8: '预算触顶',
}

/** A 档的时间锚点（= `now` 到「最后活动/最后保温」的绝对时刻）。 */
export function anchorOf(a: string, s: Settings): number {
  const intervalMs = Math.max(1, s.intervalSeconds) * 1000
  const idleMs = Math.max(1, s.idleLimitHours) * HOUR
  const freshMs = Math.max(0, s.freshSeconds) * 1000
  switch (a) {
    case 'A0': return 0
    case 'A1': return T0 - 3 * MIN
    case 'A2': return T0 - Math.max(1, Math.min(freshMs / 2 || 1, 3 * MIN))
    case 'A3': return T0 - intervalMs
    case 'A4': return T0 - Math.max(1, intervalMs - Math.min(MIN, Math.floor(intervalMs / 2)))
    case 'A5': return T0 - Math.max(1, idleMs - MIN)
    case 'A6': return T0 - (idleMs + MIN)
    default: throw new Error(`未知 A 档: ${a}`)
  }
}

interface EntrySpec {
  at: number
  hitRate?: number
  writeRate?: number
  prompt?: number
  touch?: number
  cycle?: number
  cacheUnknown?: boolean
}

/** 造一条**自洽**账本（`miss` 由 `prompt - hit - write` 反算，`cost` 用真计价）。 */
export function makeEntry(spec: EntrySpec): LedgerEntry {
  const prompt = spec.prompt ?? 400_000
  const write = Math.round(prompt * (spec.writeRate ?? 0))
  const hit = Math.round(prompt * (spec.hitRate ?? 1))
  const miss = Math.max(0, prompt - hit - write)
  const usage = { cacheReadTokens: hit, inputTokens: miss, cacheWriteTokens: write, outputTokens: 1 }
  return {
    at: spec.at,
    gapSeconds: 0,
    promptTokens: hit + miss + write,
    hitTokens: hit,
    missTokens: miss,
    outputTokens: 1,
    cost: costOf(usage),
    hitRate: hit / (hit + miss + write),
    ms: 1,
    touch: spec.touch ?? 1,
    via: 'auto',
    cacheWriteTokens: write,
    ...(spec.cacheUnknown === true ? { cacheUnknown: true } : {}),
    ...(spec.cycle !== undefined ? { cycle: spec.cycle } : {}),
  }
}

const BIG = 10_000_000
const NORMAL = 400_000

interface LedgerShape {
  entries: LedgerEntry[]
  touchBase: number
  cycles: number
  patch: Partial<Settings>
}

/** B 档 → 账本形态。`at` 与 A 档锚点对齐（铁律 1）。 */
export function ledgerShapeOf(b: string, at: number): LedgerShape {
  const base: LedgerShape = { entries: [], touchBase: 0, cycles: 1, patch: {} }
  switch (b) {
    case 'B0': return base
    case 'B1':
      return { ...base, entries: [makeEntry({ at, hitRate: 0.05, prompt: NORMAL, touch: 1 })] }
    case 'B2':
      return {
        ...base,
        entries: [
          makeEntry({ at: at - 5 * MIN, hitRate: 0.05, prompt: NORMAL, touch: 1 }),
          makeEntry({ at, hitRate: 0.05, prompt: NORMAL, touch: 2 }),
        ],
      }
    case 'B3':
      return { ...base, entries: [makeEntry({ at, hitRate: 0.05, writeRate: 0.6, prompt: NORMAL, touch: 1 })] }
    /** 清账：账本清空、基线停在 196（`beginNewCycle` 的 `touchBase` 语义）。 */
    case 'B4':
      return { ...base, touchBase: 196 }
    /** 换周期：历史账本全在 `cycle:1`，当前周期 2 → 本周期花费 0、累计保留。 */
    case 'B5':
      return {
        ...base, cycles: 2, touchBase: 6,
        entries: [
          makeEntry({ at: at - 5 * MIN, hitRate: 0.95, prompt: BIG, touch: 5, cycle: 1 }),
          makeEntry({ at, hitRate: 0.95, prompt: BIG, touch: 6, cycle: 1 }),
        ],
      }
    /** 本周期次数触顶：`touch - touchBase = maxTouches(9)`。上限写死，避免被试验模式的 99 掩盖。 */
    case 'B6':
      return { ...base, patch: { maxTouches: 9 }, entries: [makeEntry({ at, hitRate: 0.95, prompt: NORMAL, touch: 9 })] }
    /** 累计触顶：`maxTouches=99` 让「本期」这一支不先命中。 */
    case 'B7':
      return {
        ...base, patch: { maxTouches: 99, maxTouchesTotal: 5 },
        entries: [makeEntry({ at, hitRate: 0.95, prompt: NORMAL, touch: 9 })],
      }
    /** 预算触顶：单条大 prompt 即 0.69 元 ≥ 0.5，且命中率 0.95 → 不熔断。 */
    case 'B8':
      return { ...base, entries: [makeEntry({ at, hitRate: 0.95, prompt: BIG, touch: 1 })] }
    default:
      throw new Error(`未知 B 档: ${b}`)
  }
}

export interface SessionScenario {
  id: string
  mtime: number
  memActiveAt: number
  title: string | null
  origin: string
  archived: boolean
  hasRoute: boolean
  rewritten?: { detail: string }
}

export interface Scenario {
  id: string
  a: string
  b: string
  c: string
  now: number
  state: State
  sessions: SessionScenario[]
}

export interface ScenarioSpec {
  a?: string
  b?: string
  c?: string
  id?: string
  sessionId?: string
  settings?: Partial<Settings>
  /** 显式覆盖磁盘最后活动（要表达「账本很旧但刚聊过」时用）。 */
  mtime?: number
}

function sessionOf(c: string, id: string, mtime: number): SessionScenario {
  return {
    id,
    mtime,
    memActiveAt: 0,
    title: c === 'C3' ? '' : `标题 ${id}`,
    origin: c === 'C2' ? 'subagent' : 'main',
    archived: c === 'C1',
    hasRoute: c !== 'C6',
    ...(c === 'C7' ? { rewritten: { detail: '日志尾部刚压缩，其后无真实请求' } } : {}),
  }
}

function policyOfC(c: string): SessionPolicy {
  if (c === 'C4') return { mode: 'on' }
  if (c === 'C5') return { mode: 'off' }
  return { mode: 'auto' }
}

/** 造一个单会话场景。`mtime` 默认 = 账本末条 `at`（铁律 1），A0 取 0。 */
export function makeScenario(spec: ScenarioSpec = {}): Scenario {
  const a = spec.a ?? 'A1'
  const b = spec.b ?? 'B0'
  const c = spec.c ?? 'C0'
  const id = spec.sessionId ?? 'session-a'
  const settings: Settings = { ...DEFAULT_SETTINGS, ...spec.settings }
  const at = anchorOf(a, settings)
  const shape = ledgerShapeOf(b, at)
  const st: State = {
    version: 1,
    settings: { ...settings, ...shape.patch },
    sessions: { [id]: policyOfC(c) },
    ledger: { [id]: shape.entries },
    cycles: { [id]: shape.cycles },
    touchBase: { [id]: shape.touchBase },
    pinnedSessions: [],
  }
  const mtime = spec.mtime ?? (a === 'A0' ? 0 : at)
  return {
    id: spec.id ?? `${a}-${b}-${c}`,
    a, b, c,
    now: T0,
    state: st,
    sessions: [sessionOf(c, id, mtime)],
  }
}

/** 追加一条会话（多会话排序/名额场景）。`activeOffset` = 距 now 的毫秒差。 */
export function addSession(sc: Scenario, id: string, activeOffset: number, opts: Partial<SessionScenario> = {}): Scenario {
  const mtime = T0 - activeOffset
  sc.state.sessions[id] = { mode: 'auto' }
  sc.state.ledger[id] = []
  sc.state.cycles = { ...(sc.state.cycles ?? {}), [id]: 1 }
  sc.state.touchBase = { ...(sc.state.touchBase ?? {}), [id]: 0 }
  sc.sessions.push({
    id, mtime, memActiveAt: 0, title: `标题 ${id}`, origin: 'main',
    archived: false, hasRoute: true, ...opts,
  })
  return sc
}

/** 全 A×B 交叉（63 例，C 固定 C0）。 */
export function gridScenarios(settings: Partial<Settings> = {}): Scenario[] {
  const out: Scenario[] = []
  for (const a of A_IDS) for (const b of B_IDS) out.push(makeScenario({ a, b, c: 'C0', settings }))
  return out
}

/** 属性 8 例（A 固定 A1、B 固定 B0）。 */
export function propScenarios(settings: Partial<Settings> = {}): Scenario[] {
  return C_IDS.map((c) => makeScenario({ a: 'A1', b: 'B0', c, settings }))
}

export interface BaseSettingsOptions {
  lab: boolean
}

export function baseSettings(lab: boolean): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS }
  if (lab) Object.assign(s, LAB_OVERRIDES, { labMode: true })
  return s
}

export type Surface = 'plugin' | 'panel' | 'cli'

/** 三面口径（`plugin` 用真实 `hasRoute` + 内存活动时间；面板/CLI 乐观 `hasRoute` + 磁盘 `mtime`）。 */
export function gateOf(sc: Scenario, surface: Surface, index = 0): GateDecision {
  const s = sc.sessions[index]
  const lastActivityAt = surface === 'plugin' ? Math.max(s.memActiveAt, s.mtime) : s.mtime
  return decideWarm(buildGateInput(sc.state, {
    id: s.id,
    mtime: s.mtime,
    hasRoute: surface === 'plugin' ? s.hasRoute : true,
    tripped: trippedAt(sc.state, s.id, lastActivityAt, sc.now),
    archived: s.archived,
    agentStatus: 'idle',
    lastActivityAt,
    rewritten: s.rewritten !== undefined,
    rewriteDetail: s.rewritten?.detail,
    at: sc.now,
  }))
}

/** 熔断三件套同口径（面板 / CLI 的那一套：先宽限、再 isTripped）。 */
export function trippedAt(state: State, id: string, lastActiveAt: number, now: number): boolean {
  return isTripped(state, id, BREAK_CIRCUIT_HIT_RATE, lastActiveAt, now)
}

export function rowOf(sc: Scenario, index = 0, surface: Surface = 'plugin'): CandidateRow {
  const s = sc.sessions[index]
  const lastActiveAt = surface === 'plugin' ? Math.max(s.memActiveAt, s.mtime) : s.mtime
  return {
    id: s.id,
    mtime: s.mtime,
    archived: s.archived,
    origin: s.origin,
    title: s.title ?? '',
    ...(surface === 'plugin' ? { lastActiveAt } : {}),
    hasRoute: surface === 'plugin' ? s.hasRoute : true,
    /** 与 `gateOf` 同源：候选侧的熔断口径不能自己另算一遍（曾漂过）。 */
    tripped: trippedAt(sc.state, s.id, lastActiveAt, sc.now),
    ...(s.rewritten !== undefined ? { rewritten: s.rewritten } : {}),
  }
}

export interface AutoOptions {
  enabled?: boolean
  count?: number
  allowSubagent?: boolean
}

export function autoOf(sc: Scenario, opts: AutoOptions = {}) {
  return {
    enabled: opts.enabled ?? sc.state.settings.autoEnabled,
    count: opts.count ?? sc.state.settings.autoCount,
    maxIdleHours: sc.state.settings.idleLimitHours,
    allowSubagent: opts.allowSubagent ?? sc.state.settings.autoAllowSubagent,
  }
}

/** 候选决策（三面同源：一律走 `decideCandidates`）。 */
export function decisionsOf(sc: Scenario, opts: AutoOptions = {}, surface: Surface = 'plugin'): Map<string, CandidateDecision> {
  return decideCandidates(
    sc.state,
    sc.sessions.map((_, i) => rowOf(sc, i, surface)),
    sc.now,
    autoOf(sc, opts),
  )
}

