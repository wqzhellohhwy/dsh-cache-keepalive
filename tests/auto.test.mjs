/**
 * 自动候选筛选测试 —— 不需要网络、不花钱。
 * 跑法：node tests/auto.test.mjs
 */
import { pickAutoCandidates, autoCandidateIds, gateAccepts } from '../src/auto.ts'
import { decideCandidates } from '../src/core/candidates.ts'
import { buildGateInput } from '../src/core/gate-input.ts'
import { decideWarm } from '../src/gate.ts'
import { ledgerOf, loadState, policyOf } from '../src/store.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const NOW = 1_700_000_000_000

/** 默认设置：`gateOk` 单独给，避免每条用例都写一遍。 */
const SET = { enabled: true, count: 2, maxIdleHours: 2 }

/**
 * 一份**干净的内存 State**（不读盘、不写盘）：`loadState()` 指向不存在的文件时返回默认态。
 * 供 `decideCandidates()` 与门禁构造用。
 */
function freshState() {
  return loadState('C:/definitely/not/here/state.json')
}

/** 把结果转成 id → decision 便于断言。 */
function judge(cands, settings = SET, now = NOW) {
  const out = new Map()
  for (const d of pickAutoCandidates(cands, settings, now)) out.set(d.id, d)
  return out
}

const cases = []

// 1. 先门禁后自动：门禁不认的即使刚活动过也不入候选
cases.push(['gateOk=false 的会话即使最近活跃也不入候选(reason gate)', () => {
  const r = judge([
    { id: 'rejected', lastActiveAt: NOW - MIN, gateOk: false },
    { id: 'ok', lastActiveAt: NOW - 60 * MIN, gateOk: true },
  ], { enabled: true, count: 1, maxIdleHours: 2 })
  return r.get('rejected').picked === false && r.get('rejected').reason === 'gate'
    && r.get('ok').picked === true && r.get('ok').rank === 1
}])

// 2. 门禁认的都在名额内 → 全部入选，名次按最近活动排
cases.push(['gateOk=true 且都在名额内 → 全部入选', () => {
  const r = judge([
    { id: 'a', lastActiveAt: NOW - 10 * MIN, gateOk: true },
    { id: 'b', lastActiveAt: NOW - 30 * MIN, gateOk: true },
  ])
  return r.get('a').picked === true && r.get('a').rank === 1
    && r.get('b').picked === true && r.get('b').rank === 2
}])

// 3. 排序仍按 lastActiveAt 降序（最近活跃优先，不是「快凉了优先」）
cases.push(['候选排序按 lastActiveAt 降序（最近活跃优先）', () => {
  const r = judge([
    { id: 'oldest', lastActiveAt: NOW - 100 * MIN, gateOk: true },
    { id: 'newest', lastActiveAt: NOW - 1 * MIN, gateOk: true },
    { id: 'middle', lastActiveAt: NOW - 50 * MIN, gateOk: true },
  ], { enabled: true, count: 3, maxIdleHours: 4 })
  return r.get('newest').rank === 1 && r.get('middle').rank === 2 && r.get('oldest').rank === 3
}])

// 3b. 排序**只看最后活动**，不看最后刷新 —— 两条时间基准不同向时必须按活动排。
//     若有人把排序改成按 lastRefreshAt，本条会 FAIL（『不许改成快凉了优先/按刷新排』）。
cases.push(['★ 排序按最后活动（不按最后刷新）：活动 1h 前(+1h 前保过) 排在 活动 5h 前(1 分钟前保过) 之前', () => {
  const r = judge([
    // 活动更近，但没有近期保温
    { id: 'recently-active', lastActiveAt: NOW - 1 * HOUR, lastRefreshAt: NOW - 1 * HOUR, gateOk: true },
    // 活动很久以前，但 1 分钟前刚保过
    { id: 'recently-warmed', lastActiveAt: NOW - 5 * HOUR, lastRefreshAt: NOW - 1 * MIN, gateOk: true },
  ], { enabled: true, count: 1, maxIdleHours: 8 })
  return r.get('recently-active').picked === true && r.get('recently-active').rank === 1
    && r.get('recently-warmed').picked === false && r.get('recently-warmed').reason === 'over-quota'
}])

// 4. 已归档 → reason archived，且不占名额
cases.push(['archived=true → 不入候选(reason archived)，且不占名额', () => {
  const r = judge([
    { id: 'archived-newest', lastActiveAt: NOW - MIN, gateOk: true, archived: true },
    { id: 'live', lastActiveAt: NOW - 60 * MIN, gateOk: true },
  ], { enabled: true, count: 1, maxIdleHours: 2 })
  return r.get('archived-newest').picked === false && r.get('archived-newest').reason === 'archived'
    && r.get('live').picked === true && r.get('live').rank === 1
}])

// 5. 子代理默认排除；allowSubagent=true 时纳入
cases.push(['子代理默认排除，allowSubagent=true 时纳入', () => {
  const cands = [{ id: 'sub', lastActiveAt: NOW - 5 * MIN, gateOk: true, isSubagent: true }]
  const off = judge(cands, { enabled: true, count: 2, maxIdleHours: 2, allowSubagent: false })
  const on = judge(cands, { enabled: true, count: 2, maxIdleHours: 2, allowSubagent: true })
  return off.get('sub').picked === false && off.get('sub').reason === 'subagent'
    && on.get('sub').picked === true
}])

// 6. 名额限制：count=2 时前 2 入选，第 3 条 over-quota
cases.push(['名额限制 → 只取前 N 条，其余 over-quota', () => {
  const r = judge([
    { id: 'old', lastActiveAt: NOW - 100 * MIN, gateOk: true },
    { id: 'new', lastActiveAt: NOW - 1 * MIN, gateOk: true },
    { id: 'mid', lastActiveAt: NOW - 50 * MIN, gateOk: true },
  ])
  return r.get('new').rank === 1 && r.get('mid').rank === 2
    && r.get('old').picked === false && r.get('old').reason === 'over-quota'
}])

// 7. 已在我的保温节奏上（too-soon / fresh）仍占名额 —— 否则名额会随节奏滚动、保费翻倍
cases.push(['门禁认 too-soon/fresh（已在保温节奏上）→ 仍占名额', () => {
  // 模拟：too-soon = 保过、距上次保温 10 分钟还没到一个间隔
  const tooSoon = gateAccepts({ ok: false, code: 'too-soon' })
  const fresh = gateAccepts({ ok: false, code: 'fresh' })
  const stale = gateAccepts({ ok: false, code: 'stale' })
  const archived = gateAccepts({ ok: false, code: 'archived' })
  const warm = gateAccepts({ ok: true })
  const r = judge([
    { id: 'kept', lastActiveAt: NOW - 1 * MIN, gateOk: tooSoon },
    { id: 'due', lastActiveAt: NOW - 30 * MIN, gateOk: warm },
    { id: 'cold', lastActiveAt: NOW - 2 * MIN, gateOk: stale },
  ], { enabled: true, count: 1, maxIdleHours: 2 })
  return tooSoon === true && fresh === true && warm === true
    && stale === false && archived === false
    && r.get('kept').picked === true && r.get('kept').rank === 1
    && r.get('due').picked === false && r.get('due').reason === 'over-quota'
    && r.get('cold').reason === 'gate'
}])

// 8. 门禁资格位未传 → 一律让出名额（防止调用方漏传后静默全选）
cases.push(['gateOk 未传 → 视为门禁不认(reason gate)', () => {
  const r = judge([{ id: 'x', lastActiveAt: NOW - MIN }])
  return r.get('x').picked === false && r.get('x').reason === 'gate'
}])

// 9. 闲置上限**不在本层判**：超出上限的会话由门禁截走（reason='gate'），
//    本层再判一遍会得到完全相同的结论 → 那就是死码（曾经的 `too-idle`，P1c 已删）。
cases.push(['★ 闲置超上限但门禁放行（极端打桩）→ 不再有 too-idle，照常进候选', () => {
  const r = judge([
    { id: 'fresh', lastActiveAt: NOW - 5 * MIN, gateOk: true },
    { id: 'stale', lastActiveAt: NOW - 3 * HOUR, gateOk: true },
  ])
  return r.get('fresh').picked === true && r.get('stale').picked === true
    && r.get('stale').reason === undefined
}])

// 9b. 「凉没凉」看**最后刷新**（max(活动, 保温)）—— 现在由门禁负责，本层不看时间。
//     用户报障：手动保过两次的会话，日志 13h 没动，但 3 分钟前刚保过 → 应进候选。
cases.push(['★ 最后活动 13h 前、但 3 分钟前刚保过 → 进候选（门禁已放行，本层不看时间）', () => {
  const r = judge([{
    id: 'manually-warmed', lastActiveAt: NOW - 13 * HOUR, lastRefreshAt: NOW - 3 * MIN,
    gateOk: true, hasTitle: true, isSubagent: false, mode: 'auto',
  }], { enabled: true, count: 2, maxIdleHours: 8 })
  return r.get('manually-warmed').picked === true && r.get('manually-warmed').reason === undefined
}])

// 9c. 反向（原 too-idle 场景）→ 门禁在 `gateOk` 那一步已经把它截成 reason='gate'
cases.push(['★ 最后刷新也是 13h 前（超上限）→ 被门禁拦，reason=gate（不再是 too-idle）', () => {
  const r = judge([{
    id: 'cold', lastActiveAt: NOW - 13 * HOUR, lastRefreshAt: NOW - 13 * HOUR,
    gateOk: false, hasTitle: true, isSubagent: false, mode: 'auto',
  }], { enabled: true, count: 2, maxIdleHours: 8 })
  return r.get('cold').picked === false && r.get('cold').reason === 'gate'
}])

// 10. 活动时间未知（插件没见过它跑回合）→ never-seen
cases.push(['活动时间未知 → 不入选(never-seen)', () => {
  const r = judge([{ id: 'x', lastActiveAt: 0, gateOk: true }])
  return r.get('x').picked === false && r.get('x').reason === 'never-seen'
}])

// 11. 自动策略关闭 → 全部 auto-disabled
cases.push(['自动策略关闭 → 全部不入选', () => {
  const r = judge([{ id: 'a', lastActiveAt: NOW - MIN, gateOk: true }], { ...SET, enabled: false })
  return r.get('a').picked === false && r.get('a').reason === 'auto-disabled'
}])

// 12. count=0 → 全部超配额
cases.push(['保 0 条 → 全部不入选', () => {
  const r = judge([{ id: 'a', lastActiveAt: NOW - MIN, gateOk: true }], { ...SET, count: 0 })
  return r.get('a').picked === false && r.get('a').reason === 'over-quota'
}])

// 13. 边界：正好等于 maxIdleHours → 仍算候选（用的是 > 判定）
cases.push(['刚好卡在 maxIdleHours 上 → 仍入选', () => {
  const r = judge([{ id: 'edge', lastActiveAt: NOW - 2 * HOUR, gateOk: true }])
  return r.get('edge').picked === true
}])

// 14. autoCandidateIds 便捷函数与逐个判定一致
cases.push(['autoCandidateIds 与逐个判定一致', () => {
  const cands = [
    { id: 'a', lastActiveAt: NOW - MIN, gateOk: true },
    // 闲置超上限的会话门禁已判 false（本层不再重复判闲置）
    { id: 'b', lastActiveAt: NOW - 9 * HOUR, gateOk: false },
    { id: 'c', lastActiveAt: 0, gateOk: true },
    { id: 'd', lastActiveAt: NOW - MIN, gateOk: false },
  ]
  const ids = autoCandidateIds(cands, SET, NOW)
  const r = judge(cands)
  return ids.has('a') && !ids.has('b') && !ids.has('c') && !ids.has('d')
    && ids.size === [...r.values()].filter((d) => d.picked).length
}])

// 15. 手动指定（强制开 / 关闭）不占自动名额
cases.push(['手动指定 mode=on/off → 不纳入自动候选，且不占名额', () => {
  const r = judge([
    // 这条最近活动过，若按老逻辑会抢走 #1 名额
    { id: 'forced', lastActiveAt: NOW - MIN, mode: 'on', gateOk: true },
    { id: 'closed', lastActiveAt: NOW - 2 * MIN, mode: 'off', gateOk: true },
    { id: 'normal', lastActiveAt: NOW - 60 * MIN, mode: 'auto', gateOk: true },
  ], { enabled: true, count: 1, maxIdleHours: 2 })
  return r.get('forced').picked === false && r.get('forced').reason === 'manual'
    && r.get('closed').picked === false && r.get('closed').reason === 'manual'
    // 名额让给了普通会话（count=1 也能选上）
    && r.get('normal').picked === true && r.get('normal').rank === 1
}])

// 16. 无标题的新对话不纳入自动托管
cases.push(['无标题的新对话 → 不纳入自动候选，且不占名额', () => {
  const r = judge([
    { id: 'untitled-new', lastActiveAt: NOW - MIN, hasTitle: false, gateOk: true },
    { id: 'named', lastActiveAt: NOW - 60 * MIN, hasTitle: true, gateOk: true },
  ], { enabled: true, count: 1, maxIdleHours: 2 })
  return r.get('untitled-new').picked === false && r.get('untitled-new').reason === 'untitled'
    && r.get('named').picked === true
}])

// 17. 判定顺序：归档 → 门禁 → 手动，前面的赢
cases.push(['判定顺序 archived > gate > manual', () => {
  const r = judge([
    // 归档会话的门禁码恒为 archived → gateOk 恒 false；仍必须报 archived（否则面板说成"门禁拦着"）
    { id: 'archived-and-gate-rejected', lastActiveAt: NOW - MIN, gateOk: false, archived: true },
    { id: 'gate-rejected', lastActiveAt: NOW - MIN, gateOk: false },
    { id: 'archived-and-manual', lastActiveAt: NOW - MIN, gateOk: true, archived: true, mode: 'on' },
    { id: 'manual', lastActiveAt: NOW - MIN, gateOk: true, mode: 'off' },
  ])
  return r.get('archived-and-gate-rejected').reason === 'archived'
    && r.get('archived-and-gate-rejected').picked === false
    && r.get('gate-rejected').reason === 'gate'
    && r.get('archived-and-manual').reason === 'archived'
    && r.get('manual').reason === 'manual'
}])

// 18. 归档会话即使 gateOk=false 也报 archived（面板文案不能显示成"门禁拦着"）
cases.push(['归档 + gateOk=false → reason archived（不显示成门禁拦着）', () => {
  const r = judge([{ id: 'arc', lastActiveAt: NOW - 1, gateOk: false, archived: true }])
  return r.get('arc').picked === false && r.get('arc').reason === 'archived'
}])

// ── 三面同源（core/candidates.ts）─────────────────────────────────────
// 注意：`decideCandidates(state, rows, now, auto)` 的 `now` 只用于候选之名次/闲置判定；
// **门禁的 `now` 走 `buildGateInput()` 的 `Date.now()`**（与生产一致，调用方传的也是 Date.now()）。
// 所以这两条用例的时间点必须相对**真实当下**构造，不能用上面那个固定 NOW。
const TS = Date.now()

// 19. decideCandidates() 必须与「手工拼 buildGateInput + decideWarm + gateAccepts + pickAutoCandidates」逐条一致
cases.push(['★ decideCandidates 与手工链路逐条一致（三面同源的基础）', () => {
  const state = freshState()
  state.settings.idleLimitHours = 8
  // 一条保过的会话（账本末条 3 分钟前），其余没保过
  state.ledger['warmed-recently'] = [{ at: TS - 3 * MIN, touch: 1 }]
  const rows = [
    { id: 'recent', mtime: TS - 10 * MIN, archived: false, origin: '', title: '甲' },
    { id: 'warmed-recently', mtime: TS - 13 * HOUR, archived: false, origin: '', title: '乙' },
    { id: 'cold', mtime: TS - 13 * HOUR, archived: false, origin: '', title: '丙' },
    { id: 'untitled', mtime: TS - MIN, archived: false, origin: '', title: '' },
    { id: 'archived', mtime: TS - MIN, archived: true, origin: '', title: '丁' },
    { id: 'sub', mtime: TS - MIN, archived: false, origin: 'subagent', title: '戊' },
    { id: 'tripped', mtime: TS - MIN, archived: false, origin: '', title: '己', tripped: true },
    { id: 'no-route', mtime: TS - 5 * HOUR, archived: false, origin: '', title: '庚', hasRoute: false },
    { id: 'rewritten', mtime: TS - 5 * HOUR, archived: false, origin: '', title: '辛', rewritten: { detail: '压缩' } },
  ]
  const auto = { enabled: true, count: 3, maxIdleHours: 8, allowSubagent: false }
  const got = decideCandidates(state, rows, TS, auto)
  // 手工链路：完全按 candidates.ts 的规则再算一遍（独立实现，便于抓口径漂移）
  const pool = rows.map((row) => {
    const lastActiveAt = row.lastActiveAt ?? row.mtime
    const lastRefreshAt = row.lastRefreshAt ?? Math.max(lastActiveAt, ledgerOf(state, row.id).slice(-1)[0]?.at ?? 0)
    const g = decideWarm(buildGateInput(state, {
      id: row.id, mtime: row.mtime, hasRoute: row.hasRoute ?? true, tripped: row.tripped ?? false,
      archived: row.archived, agentStatus: 'idle', lastActivityAt: lastActiveAt,
      rewritten: row.rewritten !== undefined, rewriteDetail: row.rewritten?.detail,
    }))
    return {
      id: row.id, lastActiveAt, lastRefreshAt, mode: policyOf(state, row.id).mode,
      hasTitle: row.title !== '', isSubagent: row.origin === 'subagent',
      archived: row.archived, gateOk: gateAccepts(g),
    }
  })
  const want = new Map(pickAutoCandidates(pool, auto, TS).map((d) => [d.id, d]))
  if (got.size !== want.size) return false
  for (const [id, w] of want) {
    const g = got.get(id)
    if (g === undefined) return false
    if (g.picked !== w.picked || g.rank !== w.rank || (g.reason ?? '') !== (w.reason ?? '')) return false
  }
  // 顺带断言几处关键结论，避免"两边都错"也判过
  // 注：`cold`（13h 前活动、没保过）被判 `gate` —— 门禁的 `cold-window-idle` / `stale`
  // 用的是同一个闲置上限，本层不再重复判（`too-idle` 已删）。
  return got.get('recent').picked === true
    && got.get('warmed-recently').picked === true
    && got.get('cold').reason === 'gate'
    && got.get('archived').reason === 'archived'
    && got.get('sub').reason === 'subagent'
    && got.get('untitled').reason === 'untitled'
    && got.get('tripped').reason === 'gate'
    && got.get('no-route').reason === 'gate'
    && got.get('rewritten').reason === 'gate'
}])

// 20. 三面口径：同一份事实下，插件视角（内存活动）与面板/CLI 视角（磁盘 mtime）不得一个真一个假；
//     唯一允许的差异是「插件有更新的内存活动 → 只会更宽松」，绝不允许反向。
cases.push(['★ 三面 gateAccepts 不互相矛盾（差异只允许"插件更宽松"）', () => {
  const state = freshState()
  state.settings.idleLimitHours = 8
  state.settings.intervalSeconds = 4 * 3600
  const probe = (row, lastActiveOverride) => {
    const lastActiveAt = lastActiveOverride ?? row.mtime
    const g = decideWarm(buildGateInput(state, {
      id: row.id, mtime: row.mtime, hasRoute: true, tripped: row.tripped === true,
      archived: row.archived === true, agentStatus: 'idle', lastActivityAt: lastActiveAt,
    }))
    return gateAccepts(g)
  }
  // A. 三面拿到同一事实（无更新的内存活动）→ 必须三项一致为真
  const a = { id: 'a', mtime: TS - 20 * MIN, tripped: false, archived: false }
  const aPanel = probe(a)
  const aCli = probe(a)
  const aPlugin = probe(a, a.mtime)
  // B. 插件有更新的内存活动（白名单差异）→ 插件真、面板假，且方向只能是这样
  const b = { id: 'b', mtime: TS - 13 * HOUR, tripped: false, archived: false }
  const bPanel = probe(b)
  const bPlugin = probe(b, TS - MIN)
  // C. 熔断是硬事实 → 三面必须都假
  const c = { id: 'c', mtime: TS - 20 * MIN, tripped: true, archived: false }
  const cAll = probe(c) || probe(c, NOW - MIN)
  return aPanel === true && aCli === true && aPlugin === true
    && bPanel === false && bPlugin === true   // 只允许这种方向
    && cAll === false
}])

// 21. 双时钟：`decideCandidates` 的 `now` 必须**同时**喂门禁与名次。
//     冻结时钟（2023）下，账本末条「冻结前 4.5h」（过间隔 4h、未超闲置上限 8h）→ 必须 picked。
//     若 candidates.ts 的 buildGateInput 漏传 `at: now`，门禁会按真实时间算 → 距刷新三年 → stale → reason=gate。
cases.push(['★ 双时钟：冻结时钟下门禁与名次用同一个 now（漏传 at 会变 reason=gate）', () => {
  const FROZEN = Date.UTC(2023, 0, 1, 12, 0, 0)
  const state = freshState()
  state.settings.idleLimitHours = 8
  state.settings.intervalSeconds = 4 * 3600
  state.settings.freshSeconds = 300
  state.ledger['frozen'] = [{ at: FROZEN - 4.5 * HOUR, touch: 3, hitRate: 0.99 }]
  const rows = [{ id: 'frozen', mtime: FROZEN - 5 * HOUR, archived: false, origin: '', title: '冻结时钟样本' }]
  const d = decideCandidates(state, rows, FROZEN, { enabled: true, count: 2, maxIdleHours: 8, allowSubagent: false })
    .get('frozen')
  // 对照：同一个 gateInput 不传 at（模拟修复前）→ 门禁按真实时间算，必须是 stale（证明本用例抓得住）
  const withoutAt = decideWarm(buildGateInput(state, {
    id: 'frozen', mtime: FROZEN - 5 * HOUR, hasRoute: true, tripped: false, archived: false,
    agentStatus: 'idle', lastActivityAt: FROZEN - 5 * HOUR,
  }))
  const withAt = decideWarm(buildGateInput(state, {
    id: 'frozen', mtime: FROZEN - 5 * HOUR, hasRoute: true, tripped: false, archived: false,
    agentStatus: 'idle', lastActivityAt: FROZEN - 5 * HOUR, at: FROZEN,
  }))
  return withAt.ok === true && withoutAt.ok === false
    && d.picked === true && d.rank === 1 && d.reason === undefined
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

console.log('=== 自动候选测试 ===')
console.log(lines.join('\n'))
console.log('')
console.log(`通过 ${pass} / ${cases.length}` + (fail > 0 ? `   ❌ 失败 ${fail}` : '   ✅ 全绿'))
process.exit(fail > 0 ? 1 : 0)
