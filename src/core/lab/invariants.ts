/**
 * 16 条机检不变量（V1~V16）。
 *
 * 每条返回 `CaseResult[]`：一条用例一个结论。**判定一律调真代码**，本文件只做断言与取证。
 * 已知红清单见 `scripts/lab/EXPECTED.md`，名单在 `KNOWN_RED`（当前为空 = 全绿是门）。
 */
import { readFileSync } from 'node:fs'
import { GATE_TEXTS } from '../gate-texts.ts'
import { gateAccepts } from '../../auto.ts'
import type { CandidateDecision } from '../../auto.ts'
import { BREAK_CIRCUIT_HIT_RATE, maxTouchesHard } from '../../econ.ts'
import {
  DEFAULT_SETTINGS, LAB_OVERRIDES, beginNewCycle, clearLedger, cycleOf, cycleSpendOf,
  isTripped, ledgerOf, policyOf, spendOf, touchCountOf, tripVerdict, type Settings, type State,
} from '../../store.ts'
import { applySettingsPatch } from '../settings.ts'
import { WINDOW_POINTS, evaluate, spanText } from './warm-window.ts'
import { intervalOf, idleLimitMsOf, freshMsOf } from '../gate-input.ts'
import {
  A_IDS, B_IDS, C_IDS, HOUR, MIN, T0, addSession, baseSettings, decisionsOf, gateOf,
  gridScenarios, makeScenario, propScenarios, rowOf, type Scenario, type Surface,
} from './world.ts'

export interface CaseResult {
  case: string
  suite: string
  ok: boolean
  expected: string
  actual: string
  witness: unknown
  repro: string
  hint: string
}

export interface LabContext {
  lab: boolean
  settings: Settings
  grid: Scenario[]
  props: Scenario[]
  codes: Set<string>
  reasons: Set<string>
}

/** 运行时应有、且 `decideWarm` 该返回的门禁码（**取自文案表**，不取 `GateSkip` 类型 —— 它曾漏 `prefix-changed`）。 */
export const NON_GATE_TEXT_KEYS = ['running', 'no-agent', 'image']
export const RUNTIME_CODES = GATE_TEXTS.map((d) => d.key).filter((k) => !NON_GATE_TEXT_KEYS.includes(k))

/** 已知红：当前代码的真实缺陷，等后续处置；**清单同步在 `scripts/lab/EXPECTED.md`**。 */
export const KNOWN_RED = new Set<string>([])

const codeOf = (g: { ok: boolean; code?: string }): string => (g.ok ? 'warm' : String(g.code))
const reasonOf = (d: CandidateDecision): string => (d.picked ? 'picked' : String(d.reason))

function mk(
  suite: string, name: string, ok: boolean,
  expected: string, actual: string, hint: string, witness: unknown,
): CaseResult {
  return {
    case: `${suite}/${name}`, suite, ok, expected, actual, witness, hint,
    repro: `node scripts/lab/run.mjs --only=${suite}`,
  }
}

const witnessOf = (sc: Scenario, extra: unknown = {}): unknown => ({
  scenario: sc.id, now: sc.now,
  a: sc.a, b: sc.b, c: sc.c,
  settings: {
    intervalSeconds: sc.state.settings.intervalSeconds,
    idleLimitHours: sc.state.settings.idleLimitHours,
    freshSeconds: sc.state.settings.freshSeconds,
    autoCount: sc.state.settings.autoCount,
    budgetPerSession: sc.state.settings.budgetPerSession,
    maxTouches: sc.state.settings.maxTouches,
    maxTouchesTotal: sc.state.settings.maxTouchesTotal,
    circuitCooldownSeconds: sc.state.settings.circuitCooldownSeconds,
  },
  sessions: sc.sessions.map((s) => ({ id: s.id, mtime: s.mtime, memActiveAt: s.memActiveAt, title: s.title, archived: s.archived, hasRoute: s.hasRoute })),
  ledger: Object.fromEntries(Object.entries(sc.state.ledger).map(([k, v]) => [k, v.map((e) => ({ at: e.at, hit: e.hitTokens, miss: e.missTokens, write: e.cacheWriteTokens ?? 0, touch: e.touch, cycle: e.cycle, cost: e.cost }))])),
  ...((extra as object) ?? {}),
})

/** 全景扫描：造出尽可能多的码与候选理由（V9 用）。 */
export function collectCoverage(ctx: LabContext): void {
  const add = (g: { ok: boolean; code?: string }): void => { ctx.codes.add(codeOf(g)) }
  const addReasons = (sc: Scenario, opts = {}): void => {
    for (const d of decisionsOf(sc, opts).values()) ctx.reasons.add(reasonOf(d))
  }
  for (const sc of ctx.grid) {
    for (const surface of ['plugin', 'panel', 'cli'] as Surface[]) add(gateOf(sc, surface))
    addReasons(sc)
  }
  for (const sc of ctx.props) {
    add(gateOf(sc, 'plugin'))
    addReasons(sc)
  }
  // never-seen：磁盘活动时间未知（mtime=0）但账本在（且不熔断）→ 门禁放行、候选嫌"没见过"
  const neverSeen = makeScenario({ a: 'A3', b: 'B3', mtime: 0, settings: ctx.settings })
  add(gateOf(neverSeen, 'plugin'))
  addReasons(neverSeen)
  // over-quota：名额只有 1，却有两条够格
  const quota = makeScenario({ a: 'A1', b: 'B0', settings: { ...ctx.settings, autoCount: 1 } })
  addSession(quota, 'session-b', 5 * MIN)
  addReasons(quota)
  // auto-disabled：全局开关关掉
  const off = makeScenario({ a: 'A1', b: 'B0', settings: { ...ctx.settings, autoEnabled: false } })
  addReasons(off)
}

export function buildContext(lab: boolean): LabContext {
  const settings = baseSettings(lab)
  const ctx: LabContext = {
    lab, settings,
    grid: gridScenarios(settings),
    props: propScenarios(settings),
    codes: new Set(),
    reasons: new Set(),
  }
  collectCoverage(ctx)
  return ctx
}

// ── V1 三面同源 ──────────────────────────────────────────────────────
function checkV1(ctx: LabContext): CaseResult[] {
  const out: CaseResult[] = []
  for (const sc of ctx.props) {
    const p = codeOf(gateOf(sc, 'plugin'))
    const pa = codeOf(gateOf(sc, 'panel'))
    const cl = codeOf(gateOf(sc, 'cli'))
    const accepts = (c: string): boolean => c === 'warm' || c === 'fresh' || c === 'too-soon'
    const hasRouteDiff = sc.sessions[0].hasRoute === false && p === 'no-route'
    const ok = (accepts(p) === accepts(pa) || hasRouteDiff) && accepts(pa) === accepts(cl)
    out.push(mk('V1', sc.id, ok,
      '三面 gateAccepts 一致（白名单：plugin 的 no-route 由乐观 hasRoute 造成）',
      `plugin=${p} panel=${pa} cli=${cl}`, '同一条会话不能一面说能保、另一面说不能', witnessOf(sc)))
  }
  return out
}

// ── V2 门禁拒绝的绝不入候选 ───────────────────────────────────────────
function checkV2(ctx: LabContext): CaseResult[] {
  const out: CaseResult[] = []
  for (const sc of [...ctx.grid, ...ctx.props]) {
    const g = gateOf(sc, 'plugin')
    const accept = gateAccepts(g)
    const expectedAccept = g.ok || g.code === 'fresh' || g.code === 'too-soon'
    const d = decisionsOf(sc).get(sc.sessions[0].id)
    const ok = accept === expectedAccept && (d === undefined || !d.picked || accept)
    out.push(mk('V2', sc.id, ok,
      'gateAccepts 口径自洽，且 picked ⇒ gateAccepts=true',
      `code=${codeOf(g)} accept=${accept} picked=${d?.picked === true} reason=${d ? reasonOf(d) : 'n/a'}`,
      '门禁拒绝的会话不得占用自动名额', witnessOf(sc)))
  }
  return out
}

// ── V3 终局优先 ──────────────────────────────────────────────────────
function checkV3(ctx: LabContext): CaseResult[] {
  const cases: [string, Scenario, string][] = [
    ['budget', makeScenario({ a: 'A4', b: 'B8', settings: ctx.settings }), 'budget'],
    ['max-touches', makeScenario({ a: 'A4', b: 'B6', settings: ctx.settings }), 'max-touches'],
    ['max-touches-total', makeScenario({ a: 'A4', b: 'B7', settings: ctx.settings }), 'max-touches-total'],
  ]
  return cases.map(([name, sc, want]) => {
    const g = gateOf(sc, 'plugin')
    return mk('V3', name, codeOf(g) === want,
      `${want}（too-soon 区间内也必须报终局码）`, codeOf(g),
      '终局上限被 too-soon 遮蔽 = 「永远保不了」被说成「等一会儿就好」，名额被死会话占住', witnessOf(sc))
  })
}

// ── V4 候选排序按最近活跃降序 ─────────────────────────────────────────
function checkV4(): CaseResult[] {
  const out: CaseResult[] = []
  const cases: [string, number[]][] = [['triple', [4 * HOUR, 30 * MIN, 90 * MIN]], ['quint', [HOUR, 2 * HOUR, 30 * MIN, 3 * HOUR, 45 * MIN]]]
  for (const [name, offsets] of cases) {
    const sc = makeScenario({ a: 'A3', b: 'B0' })
    offsets.forEach((off, i) => { if (i > 0) addSession(sc, `session-${i}`, off) })
    const d = decisionsOf(sc, { count: 3 })
    const picked = [...d.values()].filter((x) => x.picked)
    const byActive = sc.sessions.slice().sort((a, b) => b.mtime - a.mtime)
    const wantIds = byActive.slice(0, 3).map((s) => s.id).join(',')
    const gotIds = picked.slice().sort((a, b) => a.rank - b.rank).map((x) => x.id).join(',')
    const ranks = picked.map((x) => x.rank).sort((a, b) => a - b).join(',')
    out.push(mk('V4', name, gotIds === wantIds && ranks === '1,2,3',
      `按最近活跃降序取前 3：${wantIds}`, `${gotIds}（rank=${ranks}）`,
      '排序基准必须是 lastActiveAt 降序（最近活跃优先），不许改成「快凉了优先」', witnessOf(sc)))
  }
  return out
}

// ── V5 归档最高优先且不入候选 ─────────────────────────────────────────
function checkV5(ctx: LabContext): CaseResult[] {
  const out: CaseResult[] = []
  const sc = makeScenario({ a: 'A1', b: 'B2', c: 'C1', settings: ctx.settings })
  sc.sessions[0].hasRoute = false
  const g = gateOf(sc, 'plugin')
  const d = decisionsOf(sc).get(sc.sessions[0].id)
  out.push(mk('V5', 'priority', !g.ok && g.code === 'archived', 'archived（压过 tripped 与 no-route）', codeOf(g),
    '归档是用户的显式处置，必须排在最前', witnessOf(sc)))
  out.push(mk('V5', 'not-candidate', d !== undefined && !d.picked, 'picked=false', `picked=${d?.picked}`,
    '归档会话不得占用自动名额', witnessOf(sc)))
  out.push(mk('V5', 'reason', d !== undefined && d.reason === 'archived', "reason='archived'", `reason=${d?.reason}`,
    '归档的 reason 不能被说成「门禁拦截」', witnessOf(sc)))
  return out
}

// ── V6 prefix-changed 可产生且不入候选 ────────────────────────────────
function checkV6(ctx: LabContext): CaseResult[] {
  const sc = makeScenario({ a: 'A1', b: 'B0', c: 'C7', settings: ctx.settings })
  const g = gateOf(sc, 'plugin')
  const d = decisionsOf(sc).get(sc.sessions[0].id)
  return [
    mk('V6', 'reachable', !g.ok && g.code === 'prefix-changed', 'prefix-changed', codeOf(g),
      '前缀刚被改写且无真实请求 → 保了就是付全量', witnessOf(sc)),
    mk('V6', 'not-candidate', d !== undefined && !d.picked, 'picked=false', `picked=${d?.picked}`,
      '改写过前缀的会话不该占名额', witnessOf(sc)),
  ]
}

// ── V7 终局码与 autoCount 解耦 ────────────────────────────────────────
function checkV7(ctx: LabContext): CaseResult[] {
  const out: CaseResult[] = []
  for (const count of [0, 1, 5]) {
    const sc = makeScenario({ a: 'A4', b: 'B8', settings: { ...ctx.settings, autoCount: count } })
    const g = gateOf(sc, 'plugin')
    const d = decisionsOf(sc).get(sc.sessions[0].id)
    out.push(mk('V7', `autoCount-${count}`, codeOf(g) === 'budget' && d?.picked === false,
      'budget 且 picked=false', `${codeOf(g)} picked=${d?.picked}`,
      '名额多少不得改变「这条会话已触上限」的结论', witnessOf(sc)))
  }
  return out
}

// ── V8 清账 / 换周期语义 ──────────────────────────────────────────────
function checkV8(ctx: LabContext): CaseResult[] {
  const out: CaseResult[] = []
  const sc = makeScenario({ a: 'A3', b: 'B6', settings: ctx.settings })
  const id = sc.sessions[0].id
  const beforeSpend = spendOf(sc.state, id)
  const beforeTotal = ledgerOf(sc.state, id).slice(-1)[0]?.touch ?? 0
  const beforeCycle = cycleOf(sc.state, id)
  beginNewCycle(sc.state, id)
  out.push(mk('V8', 'cycle-plus-one', cycleOf(sc.state, id) === beforeCycle + 1,
    `cycle=${beforeCycle + 1}`, `cycle=${cycleOf(sc.state, id)}`, '清账后必须开新周期', witnessOf(sc)))
  out.push(mk('V8', 'cycle-spend-reset', cycleSpendOf(sc.state, id) === 0,
    '本周期花费 0', `cycleSpend=${cycleSpendOf(sc.state, id)}`, '清账后本周期花费必须归零', witnessOf(sc)))
  out.push(mk('V8', 'total-spend-kept', spendOf(sc.state, id) === beforeSpend,
    `累计花费保留 ${beforeSpend}`, `累计=${spendOf(sc.state, id)}`, '清账不得抹掉历史账单', witnessOf(sc)))
  out.push(mk('V8', 'touch-count-reset', touchCountOf(sc.state, id) === 0 && beforeTotal > 0,
    '本周期次数归零', `touchCount=${touchCountOf(sc.state, id)}`, '清账后「本期次数」必须从 0 重新数', witnessOf(sc)))
  const sc2 = makeScenario({ a: 'A3', b: 'B6', settings: ctx.settings })
  clearLedger(sc2.state, sc2.sessions[0].id)
  out.push(mk('V8', 'clear-ledger', ledgerOf(sc2.state, sc2.sessions[0].id).length === 0 && touchCountOf(sc2.state, sc2.sessions[0].id) === 0,
    '账本清空、次数 0', `len=${ledgerOf(sc2.state, sc2.sessions[0].id).length}`, '解除熔断/压缩重置必须真清空', witnessOf(sc2)))
  return out
}

// ── V9 码全集双向比对 + 候选理由覆盖 ──────────────────────────────────
function checkV9(ctx: LabContext): CaseResult[] {
  const missing = RUNTIME_CODES.filter((c) => !ctx.codes.has(c))
  const extra = [...ctx.codes].filter((c) => !RUNTIME_CODES.includes(c))
  /** 8 个候选理由（`too-idle` 已删：它与门禁 `cold-window-idle`/`stale` 同判据，永远被 `gate` 截走）。 */
  const allReasons = ['auto-disabled', 'gate', 'archived', 'manual', 'untitled', 'subagent', 'never-seen', 'over-quota']
  const missingReasons = allReasons.filter((r) => !ctx.reasons.has(r))
  return [
    mk('V9', 'gate-codes', missing.length === 0 && extra.length === 0,
      `可达集合 == 文案表全集（${RUNTIME_CODES.length} 个）`,
      `缺=${JSON.stringify(missing)} 多=${JSON.stringify(extra)}`,
      '缺 = 造不出场景或码被上层遮蔽；多 = 文案表缺 key；类型里漏码（GateSkip 曾漏 prefix-changed）',
      { codes: [...ctx.codes].sort() }),
    mk('V9', 'reasons', missingReasons.length === 0,
      `${allReasons.length} 个候选理由各自可达`, `不可达=${JSON.stringify(missingReasons)}`,
      '任何理由不可达 = 死码：面板会留一条永远看不到的文案，且它掩盖了本应由门禁负责的判定',
      { reasons: [...ctx.reasons].sort() }),
  ]
}

// ── V10 纯函数无副作用 ────────────────────────────────────────────────
function checkV10(ctx: LabContext): CaseResult[] {
  const out: CaseResult[] = []
  for (const sc of [ctx.grid[10], ctx.props[3]]) {
    const before = JSON.stringify(sc.state)
    const g1 = JSON.stringify(gateOf(sc, 'plugin'))
    const g2 = JSON.stringify(gateOf(sc, 'plugin'))
    const d1 = JSON.stringify([...decisionsOf(sc).values()])
    const d2 = JSON.stringify([...decisionsOf(sc).values()])
    out.push(mk('V10', sc.id, g1 === g2 && d1 === d2 && JSON.stringify(sc.state) === before,
      '两次调用结果全等且 state 未变', g1 === g2 ? (d1 === d2 ? `state_changed=${JSON.stringify(sc.state) !== before}` : 'decisions 不一致') : 'gate 不一致',
      '判定里偷偷写 state 会导致面板轮询改账、并发乱账', witnessOf(sc)))
  }
  return out
}

// ── V11 账本自洽 ──────────────────────────────────────────────────────
function checkV11(ctx: LabContext): CaseResult[] {
  const out: CaseResult[] = []
  const bad: string[] = []
  for (const sc of [...ctx.grid, ...ctx.props]) {
    for (const [id, list] of Object.entries(sc.state.ledger)) {
      for (const e of list) {
        const sum = e.hitTokens + e.missTokens + (e.cacheWriteTokens ?? 0)
        if (sum !== e.promptTokens) bad.push(`${sc.id}:prompt ${sum}!=${e.promptTokens}`)
        if (!(e.cost > 0)) bad.push(`${sc.id}:cost<=0`)
        if (e.hitRate < 0 || e.hitRate > 1) bad.push(`${sc.id}:hitRate 越界`)
        const cur = cycleOf(sc.state, id)
        const want = list.reduce((s, x) => s + ((x.cycle ?? 1) === cur ? x.cost : 0), 0)
        if (Math.abs(cycleSpendOf(sc.state, id) - want) > 1e-12) bad.push(`${sc.id}:cycleSpend 口径`)
        const last = list.slice(-1)[0]
        if (last !== undefined) {
          const base = sc.state.touchBase?.[id] ?? 0
          if (touchCountOf(sc.state, id) !== Math.max(0, last.touch - base)) bad.push(`${sc.id}:touchCount 口径`)
        }
      }
    }
  }
  out.push(mk('V11', 'ledger-self-consistent', bad.length === 0,
    'hit+miss+write==prompt、cost>0、hitRate∈[0,1]、cycleSpend/touchCount 口径一致', bad.slice(0, 5).join(' | ') || 'ok',
    '账本不自洽会让 tripVerdict 把 rearmed 判成 tripped、让预算更晚触顶', { checked: ctx.grid.length + ctx.props.length }))
  const hard = maxTouchesHard()
  out.push(mk('V11', 'hard-cap-sane', hard >= 1 && Number.isFinite(hard), '次数硬上限 ≥1', `maxTouchesHard=${hard}`,
    '按默认价 w/r=50 → 硬上限 49；算出 0 或 NaN 说明计价被改坏', { hard }))
  return out
}

// ── V12 熔断一致性 ────────────────────────────────────────────────────
function checkV12(ctx: LabContext): CaseResult[] {
  const out: CaseResult[] = []
  // 显式关掉冷却：试验模式默认 60 秒冷却会把 A1 锚点（180 秒前）的熔断解除掉
  const trippedSc = makeScenario({ a: 'A1', b: 'B2', settings: { ...ctx.settings, circuitCooldownSeconds: 0 } })
  const id = trippedSc.sessions[0].id
  const v = tripVerdict(trippedSc.state, id, BREAK_CIRCUIT_HIT_RATE)
  const g = gateOf(trippedSc, 'plugin')
  out.push(mk('V12', 'tripped', v === 'tripped' && codeOf(g) === 'tripped', 'tripVerdict=tripped 且门禁=tripped',
    `verdict=${v} gate=${codeOf(g)}`, '连续两次低命中必须停手', witnessOf(trippedSc)))
  const rearmedSc = makeScenario({ a: 'A1', b: 'B3', settings: ctx.settings })
  const v2 = tripVerdict(rearmedSc.state, rearmedSc.sessions[0].id, BREAK_CIRCUIT_HIT_RATE)
  const g2 = gateOf(rearmedSc, 'plugin')
  out.push(mk('V12', 'rearmed', v2 === 'rearmed' && codeOf(g2) !== 'tripped', 'tripVerdict=rearmed 且门禁≠tripped',
    `verdict=${v2} gate=${codeOf(g2)}`, '低命中但已重建大量缓存 → 下一轮必命中，不该熔断', witnessOf(rearmedSc)))
  const cdSc = makeScenario({ a: 'A1', b: 'B2', settings: { ...ctx.settings, circuitCooldownSeconds: 60 } })
  const cdId = cdSc.sessions[0].id
  out.push(mk('V12', 'cooldown-off', isTripped(cdSc.state, cdId, BREAK_CIRCUIT_HIT_RATE, 0, T0) === false,
    '冷却到点后不再熔断', `isTripped=${isTripped(cdSc.state, cdId, BREAK_CIRCUIT_HIT_RATE, 0, T0)}`,
    '没有冷却通道会把一条旧的低命中永久拉黑（只能手动解除）', witnessOf(cdSc)))
  const alwaysSc = makeScenario({ a: 'A1', b: 'B2', settings: { ...ctx.settings, circuitCooldownSeconds: 0 } })
  const aId = alwaysSc.sessions[0].id
  out.push(mk('V12', 'cooldown-disabled', isTripped(alwaysSc.state, aId, BREAK_CIRCUIT_HIT_RATE, 0, T0) === true,
    '冷却=0 时仍然熔断', `isTripped=${isTripped(alwaysSc.state, aId, BREAK_CIRCUIT_HIT_RATE, 0, T0)}`,
    'circuitCooldownSeconds=0 的语义是「不自动恢复」', witnessOf(alwaysSc)))
  return out
}


// ── V13 间隔与闲置上限的关系 ──────────────────────────────────────────
function checkV13(ctx: LabContext): CaseResult[] {
  const out: CaseResult[] = []
  const pairs: [number, number][] = [[60, 8], [4 * 3600, 8], [6 * 3600, 6], [300, 0.5]]
  const violations: string[] = []
  for (const [intervalSeconds, idleLimitHours] of pairs) {
    const sc = makeScenario({ a: 'A1', b: 'B0', settings: { ...ctx.settings, intervalSeconds, idleLimitHours } })
    const intervalMs = intervalOf(sc.state, policyOf(sc.state, sc.sessions[0].id))
    const idleMs = idleLimitMsOf(sc.state)
    if (intervalMs > idleMs) violations.push(`interval=${intervalSeconds}s > idle=${idleLimitHours}h`)
  }
  out.push(mk('V13', 'interval-below-limit', violations.length === 0,
    'interval < idleLimit 恒成立（合法配置）', violations.join(' | ') || 'ok',
    '间隔 ≥ 闲置上限时两段判据相接，会话保过一次就永远保不上', { pairs }))
  /**
   * **非法配置必须被后端拒绝**（P1b 治本）。判据是「保存路径拒绝 + 一个字段都不写」，
   * 不是「非法配置下仍要有 warm 时刻」—— 后者描述的是症状，成因已被拦在门外。
   */
  const illegal = { intervalSeconds: 9 * 3600, idleLimitHours: 8 }
  const st: State = { version: 1, settings: { ...DEFAULT_SETTINGS }, sessions: {}, ledger: {}, pinnedSessions: [] }
  const before = JSON.stringify(st.settings)
  const res = applySettingsPatch(st, { ...illegal })
  const rejected = typeof res.error === 'string' && res.error !== ''
  const unchanged = JSON.stringify(st.settings) === before
  out.push(mk('V13', 'reject-illegal-pair', rejected && unchanged,
    '一次改两个字段（间隔 9h + 上限 8h）→ 整批拒绝、settings 一个字都不写',
    `error=${rejected ? '有' : '无'} settingsChanged=${!unchanged}`, 
    '后端不拦就能写出「保过一次永久锁死」的配置（CLI / agent 工具 / 手改 state.json 都能绕前端）',
    { patch: illegal, error: res.error ?? null }))
  const st2: State = { version: 1, settings: { ...DEFAULT_SETTINGS }, sessions: {}, ledger: {}, pinnedSessions: [] }
  const before2 = JSON.stringify(st2.settings)
  const res2 = applySettingsPatch(st2, { intervalSeconds: 9 * 3600 })
  out.push(mk('V13', 'reject-single-field', typeof res2.error === 'string' && res2.error !== ''
    && JSON.stringify(st2.settings) === before2,
    '只改间隔到 9h（上限仍是默认 8h）也必须拒 —— 按合并后的值判',
    `error=${typeof res2.error === 'string' ? '有' : '无'}`,
    '只按补丁内字段判会放过「单改一个字段造成的冲突」',
    { patch: { intervalSeconds: 9 * 3600 }, error: res2.error ?? null }))
  return out
}

// ── V14 面板字段组合自洽 ──────────────────────────────────────────────
function checkV14(ctx: LabContext): CaseResult[] {
  const bad: string[] = []
  for (const sc of [...ctx.grid, ...ctx.props]) {
    for (const d of decisionsOf(sc).values()) {
      if (d.picked && d.reason !== undefined) bad.push(`${sc.id}:${d.id} picked 却带 reason=${d.reason}`)
      if (!d.picked && d.reason === undefined) bad.push(`${sc.id}:${d.id} 未入选却无 reason`)
    }
  }
  const gateOkButNotPicked: string[] = []
  for (const sc of [...ctx.grid, ...ctx.props]) {
    const g = gateOf(sc, 'plugin')
    if (!gateAccepts(g)) continue
    const d = decisionsOf(sc).get(sc.sessions[0].id)
    if (d !== undefined && !d.picked && d.reason === undefined) gateOkButNotPicked.push(sc.id)
  }
  return [
    mk('V14', 'picked-reason', bad.length === 0, 'picked ⇒ 无 reason；未入选 ⇒ 有 reason', bad.slice(0, 5).join(' | ') || 'ok',
      '「已加入保温」又带原因 = 面板自相矛盾', {}),
    mk('V14', 'gateok-not-picked', gateOkButNotPicked.length === 0,
      'gateOk 但未入选时必须给出原因（否则不得声称"会保"）', gateOkButNotPicked.slice(0, 5).join(' | ') || 'ok',
      '门禁放行却不在候选、又没原因 → 用户会以为下一轮就会保', {}),
  ]
}

// ── V15 假旋钮必须有「仅显示」标注 ────────────────────────────────────
/**
 * `cacheTtlSeconds` 只画时间轴到期线、不参与判定（设计如此，不是缺陷）。
 * 不变量改成：**只要它不影响判定，面板就必须有说明文字** —— 否则用户会以为调它有用。
 */
const TTL_NOTICE = '不参与保温判定'

function checkV15(ctx: LabContext): CaseResult[] {
  const base = makeScenario({ a: 'A3', b: 'B0', settings: { ...ctx.settings, cacheTtlSeconds: 4 * 3600 } })
  const other = makeScenario({ a: 'A3', b: 'B0', settings: { ...ctx.settings, cacheTtlSeconds: 48 * 3600 } })
  const same = codeOf(gateOf(base, 'plugin')) === codeOf(gateOf(other, 'plugin'))
    && JSON.stringify([...decisionsOf(base).values()]) === JSON.stringify([...decisionsOf(other).values()])
  const panelSrc = readFileSync(new URL('../../panel.ts', import.meta.url), 'utf8')
  const labeled = panelSrc.includes(TTL_NOTICE)
  return [mk('V15', 'cacheTtl-labeled', labeled || !same,
    same
      ? `cacheTtlSeconds 不影响判定 → 面板必须标注「${TTL_NOTICE}」`
      : 'cacheTtlSeconds 已参与判定（真旋钮，不需要标注）',
    `影响判定=${!same} 面板有标注=${labeled}`,
    '假旋钮不标注 = 用户以为调它能改行为；标注后它就是「仅显示」字段，不再算缺陷',
    { baseTtl: 4 * 3600, otherTtl: 48 * 3600, notice: TTL_NOTICE })]
}

// ── V16 试验模式可逆 ─────────────────────────────────────────────────
function checkV16(): CaseResult[] {
  const keys = ['intervalSeconds', 'freshSeconds', 'circuitCooldownSeconds', 'maxTouches'] as const
  const st: State = { version: 1, settings: { ...DEFAULT_SETTINGS }, sessions: {}, ledger: {}, pinnedSessions: [] }
  const before = keys.map((k) => st.settings[k])
  applySettingsPatch(st, { labMode: true })
  const during = keys.map((k) => st.settings[k])
  const applied = keys.every((k, i) => (LAB_OVERRIDES as Record<string, number>)[k] === during[i])
    && st.labBackup !== undefined
  const backup = st.labBackup
  applySettingsPatch(st, { labMode: false })
  const after = keys.map((k) => st.settings[k])
  const restored = keys.every((k, i) => before[i] === after[i]) && st.labBackup === undefined
  return [
    mk('V16', 'apply', applied && backup !== undefined,
      `进试验模式后四项被覆盖为 ${JSON.stringify(LAB_OVERRIDES)}`,
      `during=${JSON.stringify(during)} backup=${backup === undefined ? '无' : JSON.stringify(backup)}`,
      'labBackup 不存就永远关不掉试验模式，参数停在 30s 疯狂烧钱', { before, during }),
    mk('V16', 'restore', restored,
      `退出后四项逐字段还原：${JSON.stringify(before)}`,
      `after=${JSON.stringify(after)} labBackup=${st.labBackup === undefined ? '已删' : '残留'}`,
      '还原不精确 = 假开关', { before, after }),
  ]
}

export interface SuiteDef {
  id: string
  name: string
  check: (ctx: LabContext) => CaseResult[]
}

/**
 * **V17：立即保温窗口**（间隔 4h ~ 闲置上限 8h）。
 *
 * 用户原话：「找一条最后对话在 4~8 小时之间的会话 —— 没有。应该有测试工具，虚构一条」。
 * 真实环境里几乎不可能正好有一条落在窗口内，而这条窗口正是「立即保温」唯一该成功的区间：
 * 小于间隔 → `too-soon`（缓存还热）；大于闲置上限 → `cold-window-idle`（缓存大概率已断）。
 * 网页版路径多 2 分钟延迟，下边界被推到「间隔 + 2 分钟」。
 *
 * 用**生产默认设置**（不继承 `ctx.settings` 的 `LAB_OVERRIDES`：那是 30 秒试验节奏，边界完全变样）。
 */
function checkV17(): CaseResult[] {
  const out: CaseResult[] = []
  for (const p of WINDOW_POINTS) {
    const r = evaluate(p)
    const where = p.delayMs === 0 ? '插件' : '网页(+2min)'
    out.push(mk('V17', `win-${spanText(p.idleMs)}-${p.delayMs === 0 ? 'plugin' : 'web'}`, r.code === p.expect,
      `${where} 路径、最后对话 ${spanText(p.idleMs)} 前 → ${p.expect}`,
      `实际 ${r.code}（${r.decision.detail ?? ''}）`,
      p.expect === 'warm'
        ? '窗口内必须放行，否则「立即保温」永远点不动'
        : '窗口外必须拦，否则白付一次冷启动',
      { point: p, code: r.code, detail: r.decision.detail ?? '' }))
  }
  return out
}

export const SUITES: SuiteDef[] = [
  { id: 'V1', name: '三面同源', check: checkV1 },
  { id: 'V2', name: '拒绝不入候选', check: checkV2 },
  { id: 'V3', name: '终局优先', check: checkV3 },
  { id: 'V4', name: '候选排序最近活跃优先', check: checkV4 },
  { id: 'V5', name: '归档最高优先', check: checkV5 },
  { id: 'V6', name: '前缀改写可产生且不入候选', check: checkV6 },
  { id: 'V7', name: '终局码与名额解耦', check: checkV7 },
  { id: 'V8', name: '清账与换周期', check: checkV8 },
  { id: 'V9', name: '门禁码全集与候选理由覆盖', check: checkV9 },
  { id: 'V10', name: '纯函数无副作用', check: checkV10 },
  { id: 'V11', name: '账本自洽', check: checkV11 },
  { id: 'V12', name: '熔断一致性', check: checkV12 },
  { id: 'V13', name: '间隔与闲置上限关系', check: checkV13 },
  { id: 'V14', name: '面板字段组合自洽', check: checkV14 },
  { id: 'V15', name: '假旋钮检测', check: checkV15 },
  { id: 'V16', name: '试验模式可逆', check: checkV16 },
  { id: 'V17', name: '立即保温窗口（4~8 小时）', check: checkV17 },
]

export interface SuiteRun {
  id: string
  name: string
  cases: CaseResult[]
}

/** 跑全部（或 `--only` 指定的）不变量。 */
export function runAll(opts: { lab: boolean; only?: string[] } = { lab: false }): SuiteRun[] {
  const ctx = buildContext(opts.lab)
  const want = opts.only === undefined || opts.only.length === 0
    ? undefined
    : new Set(opts.only.map((s) => s.trim().toUpperCase()).filter((s) => s !== ''))
  const runs: SuiteRun[] = []
  for (const suite of SUITES) {
    if (want !== undefined && !want.has(suite.id)) continue
    runs.push({ id: suite.id, name: suite.name, cases: suite.check(ctx) })
  }
  return runs
}

/** 单例复核：打印该场景的全部码与关键字段。 */
export function inspectScenario(scenarioId: string, lab: boolean): Record<string, unknown> {
  const settings = baseSettings(lab)
  const parts = scenarioId.split('-')
  const a = A_IDS.find((x) => x === parts[0]) ?? 'A1'
  const b = B_IDS.find((x) => x === parts[1]) ?? 'B0'
  const c = C_IDS.find((x) => x === parts[2]) ?? 'C0'
  const sc = makeScenario({ a, b, c, settings })
  const gates = Object.fromEntries((['plugin', 'panel', 'cli'] as Surface[]).map((s) => {
    const g = gateOf(sc, s)
    return [s, { code: codeOf(g), detail: g.ok ? '' : g.detail }]
  }))
  return {
    scenario: sc.id,
    witness: witnessOf(sc),
    gates,
    candidates: [...decisionsOf(sc).values()].map((d) => ({ id: d.id, picked: d.picked, rank: d.rank, reason: d.reason ?? null })),
    freshMs: freshMsOf(sc.state),
    intervalMs: intervalOf(sc.state, policyOf(sc.state, sc.sessions[0].id)),
    idleLimitMs: idleLimitMsOf(sc.state),
    rows: sc.sessions.map((_, i) => rowOf(sc, i)),
  }
}
