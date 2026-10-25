/**
 * S1 子代理保温：独立名额 `autoCountSubagent` + 「父代理在保温才纳入」+ 两池互不占位。
 *
 * 用户口径（逐字）：「子代理也保温——可在'自动候选'处单独设置自动策略保温条数——
 * 且根据父代理保温来决定加入哪些自动策略」。
 *
 * 判定顺序（`pickAutoCandidates`）：archived → gate → **子代理分流** → manual → untitled → never-seen。
 * 子代理分流三档：
 *   ① 子代理名额 <= 0            → `subagent`
 *   ② 父代理没在保温（显式 false）→ `subagent-parent-idle`
 *   ③ 进子代理池，超出名额       → `over-quota-subagent`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickAutoCandidates } from '../src/auto.ts'
import { decideCandidates } from '../src/core/candidates.ts'
import { DEFAULT_SETTINGS } from '../src/store.ts'
import { applySettingsPatch } from '../src/core/settings.ts'

const NOW = 1_800_000_000_000
const MIN = 60 * 1000

/**
 * 基础旋钮：全局开、普通名额 2、子代理名额 2。
 *
 * ⚠️ `allowSubagent` 是**总开关**（2026-10-25 真机修复）：关着时名额再大也一条不保。
 * 所以这里必须是 `true` —— 下面所有用例测的是「开关已开时名额怎么分」。
 */
const BASE = {
  enabled: true,
  count: 2,
  countSubagent: 2,
  maxIdleHours: 8,
  allowSubagent: true,
}

/** 造一个最小 State（只带判定用得到的字段）。 */
function freshState() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    ledger: {},
    /**
     * `State.sessions` 是**必需字段**（`Record<string, SessionPolicy>`）。
     * 旧副本这里写的是更老的字段名 `policies`，`policyOf()` 会在 `state.sessions[id]` 上崩。
     */
    sessions: {},
    pinnedSessions: [],
  }
}

/** 一条合格的自动候选（门禁放行 + 有标题 + 自动模式 + 见过活动）。 */
function cand(id, extra = {}) {
  return { id, lastActiveAt: NOW - MIN, gateOk: true, hasTitle: true, mode: 'auto', ...extra }
}

function judge(cands, settings = BASE) {
  return pickAutoCandidates(cands, settings , NOW)
}

function byId(ds, id) {
  const d = ds.find((x) => x.id === id)
  assert.ok(d, '判定里没有 ' + id)
  return d
}

/* ── 判据 1：countSubagent = 0 → 子代理不保 ───────────────────────────── */

test('countSubagent=0 → 子代理 reason=subagent，不占普通名额', () => {
  const ds = judge([
    cand('n1'),
    cand('s1', { isSubagent: true, parentWarm: true }),
  ], { ...BASE, countSubagent: 0 })

  assert.equal(byId(ds, 's1').picked, false)
  assert.equal(byId(ds, 's1').reason, 'subagent')
  assert.equal(byId(ds, 'n1').picked, true, '普通会话照常进')
})

test('countSubagent=0 且旧开关 allowSubagent=false → 仍是 subagent（保持旧行为）', () => {
  const ds = judge([cand('s1', { isSubagent: true, parentWarm: true })], {
    ...BASE, countSubagent: 0, allowSubagent: false,
  })
  assert.equal(byId(ds, 's1').reason, 'subagent')
})

/* ── 判据 2：名额 2、3 个子代理 → 取 2 条，第 3 条 over-quota-subagent ── */

test('countSubagent=2 + 3 个子代理（父都在保温）→ 取最近的 2 条，第 3 条 over-quota-subagent', () => {
  const ds = judge([
    cand('s-recent', { isSubagent: true, parentWarm: true, lastActiveAt: NOW - 1 * MIN }),
    cand('s-mid', { isSubagent: true, parentWarm: true, lastActiveAt: NOW - 5 * MIN }),
    cand('s-old', { isSubagent: true, parentWarm: true, lastActiveAt: NOW - 30 * MIN }),
  ])

  assert.equal(byId(ds, 's-recent').picked, true)
  assert.equal(byId(ds, 's-mid').picked, true)
  assert.equal(byId(ds, 's-old').picked, false)
  assert.equal(byId(ds, 's-old').reason, 'over-quota-subagent', '超出子代理名额要用专用 reason，不能复用 over-quota')
})

/* ── 判据 3：parentWarm=false → subagent-parent-idle，且不占名额 ──────── */

test('parentWarm=false → reason=subagent-parent-idle，且不吃子代理名额', () => {
  const ds = judge([
    // 这条最近活跃，但父代理没在保温 → 应被拦，且把名额让给下一条
    cand('s-idle', { isSubagent: true, parentWarm: false, lastActiveAt: NOW - 1 * MIN }),
    cand('s-ok', { isSubagent: true, parentWarm: true, lastActiveAt: NOW - 20 * MIN }),
  ], { ...BASE, countSubagent: 1 })

  assert.equal(byId(ds, 's-idle').picked, false)
  assert.equal(byId(ds, 's-idle').reason, 'subagent-parent-idle')
  assert.equal(byId(ds, 's-ok').picked, true, '父代理在保温的这条应拿到名额（idle 那条不占位）')
})

test('父会话不可判定（parentWarm 未传）→ 视为在保温，照常参与', () => {
  const ds = judge([cand('s-unknown', { isSubagent: true })], BASE)
  assert.equal(byId(ds, 's-unknown').picked, true, '拿不到父会话信息时应宁可多保')
  assert.equal(byId(ds, 's-unknown').reason, undefined)
})

/* ── 判据 4：两池互不占位 ─────────────────────────────────────────────── */

test('两个池互不占位：count=1 + countSubagent=1，1 普通 + 1 合格子代理 → 两条都进', () => {
  const ds = judge([
    cand('n1', { lastActiveAt: NOW - 1 * MIN }),
    cand('n2', { lastActiveAt: NOW - 2 * MIN }),
    cand('s1', { isSubagent: true, parentWarm: true, lastActiveAt: NOW - 3 * MIN }),
    cand('s2', { isSubagent: true, parentWarm: true, lastActiveAt: NOW - 4 * MIN }),
  ], { ...BASE, count: 1, countSubagent: 1 })

  assert.equal(byId(ds, 'n1').picked, true, '普通池第 1 名')
  assert.equal(byId(ds, 'n2').reason, 'over-quota', '普通池超额用 over-quota')
  assert.equal(byId(ds, 's1').picked, true, '子代理池第 1 名（不因普通池满而让位）')
  assert.equal(byId(ds, 's2').reason, 'over-quota-subagent', '子代理超额用 over-quota-subagent')
})

test('子代理不消耗普通名额：count=1 时 1 普通 + 2 子代理 → 普通 1 条 + 子代理 2 条（countSubagent=2）', () => {
  const ds = judge([
    cand('n1', { lastActiveAt: NOW - 1 * MIN }),
    cand('n2', { lastActiveAt: NOW - 2 * MIN }),
    cand('s1', { isSubagent: true, parentWarm: true, lastActiveAt: NOW - 3 * MIN }),
    cand('s2', { isSubagent: true, parentWarm: true, lastActiveAt: NOW - 4 * MIN }),
  ], { ...BASE, count: 1, countSubagent: 2 })

  assert.equal(ds.filter((d) => d.picked).length, 3, '应选出 1 普通 + 2 子代理')
  assert.equal(byId(ds, 'n2').reason, 'over-quota', '普通池仍只给 1 条')
})

test('名次连续：子代理排在普通会话之后，rank 不重复', () => {
  const ds = judge([
    cand('n1', { lastActiveAt: NOW - 1 * MIN }),
    cand('s1', { isSubagent: true, parentWarm: true, lastActiveAt: NOW - 2 * MIN }),
  ], { ...BASE, count: 1, countSubagent: 1 })

  assert.equal(byId(ds, 'n1').rank, 1)
  assert.equal(byId(ds, 's1').rank, 2, '子代理的 rank 应接在普通会话之后')
})

/* ── 判据 5：applySettingsPatch 白名单（防面板白存）───────────────────── */

test('applySettingsPatch(state, {autoCountSubagent:2}) → settings.autoCountSubagent === 2', () => {
  const st = freshState()
  const r = applySettingsPatch(st, { autoCountSubagent: 2 })
  assert.equal(r.error, undefined, '不该报错：' + r.error)
  assert.equal(st.settings.autoCountSubagent, 2, '白名单漏字段会让面板保存变成白存')
})

test('applySettingsPatch：负数夹到 0，非数字丢弃，字符串数字转数字', () => {
  const st = freshState()
  applySettingsPatch(st, { autoCountSubagent: -5 })
  assert.equal(st.settings.autoCountSubagent, 0, '负数应夹到下限 0')

  const st2 = freshState()
  applySettingsPatch(st2, { autoCountSubagent: 'abc' })
  assert.equal(st2.settings.autoCountSubagent, DEFAULT_SETTINGS.autoCountSubagent, '非数字应被丢弃（保持默认）')

  const st3 = freshState()
  applySettingsPatch(st3, { autoCountSubagent: '3' })
  assert.equal(st3.settings.autoCountSubagent, 3, '数字字符串应转成数字')
})

test('DEFAULT_SETTINGS.autoCountSubagent 默认 0（= 不保，保持旧行为）', () => {
  assert.equal(DEFAULT_SETTINGS.autoCountSubagent, 0)
})

/* ── 与旧开关的兼容 ───────────────────────────────────────────────────── */

test('只传旧开关 allowSubagent=true、不传 countSubagent → 保持旧行为（子代理不限名额纳入）', () => {
  const ds = pickAutoCandidates([
    cand('s1', { isSubagent: true }),
    cand('s2', { isSubagent: true }),
    cand('s3', { isSubagent: true }),
  ], { enabled: true, count: 2, maxIdleHours: 8, allowSubagent: true } , NOW)
  assert.equal(ds.filter((d) => d.picked).length, 3, '旧调用方不传新字段时不能被判成全不保')
})

test('countSubagent>0 但总开关 allowSubagent=false → 一条都不保（只填条数不能生效）', () => {
  const ds = judge([cand('s1', { isSubagent: true, parentWarm: true })], { ...BASE, allowSubagent: false })
  assert.equal(byId(ds, 's1').picked, false)
  assert.equal(byId(ds, 's1').reason, 'subagent')
})

/* ── 判定顺序：归档 / 门禁 / 手动 优先于子代理分流 ────────────────────── */

test('判定顺序：归档/门禁 优先于子代理分流', () => {
  const ds = judge([
    cand('s-arch', { isSubagent: true, parentWarm: true, archived: true }),
    cand('s-gate', { isSubagent: true, parentWarm: true, gateOk: false }),
  ])
  assert.equal(byId(ds, 's-arch').reason, 'archived')
  assert.equal(byId(ds, 's-gate').reason, 'gate')
})

test('判定顺序：子代理分流优先于 manual（mode=on 的子代理不该被说成手动指定）', () => {
  const ds = judge([cand('s-manual', { isSubagent: true, parentWarm: true, mode: 'on' })], {
    ...BASE, countSubagent: 0,
  })
  assert.equal(byId(ds, 's-manual').reason, 'subagent', '名额 0 时应报 subagent，而不是 manual')
})

/* ── parentId → parentWarm 真的接上了（不是恒 true）──────────────────── */

test('★ parentId 生效：父会话 tripped → 子代理 subagent-parent-idle；父会话 warm → 子代理进池', () => {
  // 用 decideCandidates（真实入口）而不是手工传 parentWarm —— 守的是「SessionRow.parentSession
  // 一路接到 CandidateRow.parentId，再算出 parentWarm」这条链路，防止退化成恒 true。
  const st = freshState()
  const mkRow = (id, extra = {}) => ({
    id, mtime: NOW - MIN, archived: false, origin: '', title: 't',
    lastActiveAt: NOW - MIN, lastRefreshAt: NOW - MIN, hasRoute: true, ...extra,
  })
  const auto = { ...BASE, count: 0, countSubagent: 2 }

  // 父会话 tripped → 不在保温
  const dIdle = decideCandidates(st, [
    mkRow('parent', { tripped: true }),
    mkRow('sub', { origin: 'subagent', parentId: 'parent' }),
  ], NOW, auto)
  assert.equal(dIdle.get('sub').reason, 'subagent-parent-idle', '父会话 tripped 时子代理不该进池')

  // 父会话 warm（门禁放行）
  const dWarm = decideCandidates(st, [
    mkRow('parent'),
    mkRow('sub', { origin: 'subagent', parentId: 'parent' }),
  ], NOW, auto)
  assert.equal(dWarm.get('sub').picked, true, '父会话 warm 时子代理应进子代理池')

  // 同一条子代理，只把 parentId 清空 → 结论必须变（证明 parentId 真在起作用）
  const dNoId = decideCandidates(st, [
    mkRow('parent', { tripped: true }),
    mkRow('sub', { origin: 'subagent', parentId: '' }),
  ], NOW, auto)
  assert.equal(dNoId.get('sub').picked, true, '拿不到父会话 id 时应视为在保温（宁可多保）')
  assert.notEqual(dIdle.get('sub').reason, dNoId.get('sub').reason, 'parentId 被忽略了')
})

test('★ parentSession 能从真实会话日志解析出来（用真实用户数据，无数据则跳过）', async () => {
  // 守的是 sessions.ts 的 parseMeta 有没有真的读 parentSession。
  // 若它没读，SessionRow.parentSession 恒空 → 调用方传的 parentId 恒空 → 「父代理在保温才保」
  // 退化成恒 true（本任务之前就是这个状态）。
  const { listSessions } = await import('../src/core/sessions.ts')
  const home = process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : ''
  let rows = []
  try { rows = listSessions(home, { headBytes: 64 * 1024 }) } catch { rows = [] }
  const subs = rows.filter((r) => r.origin === 'subagent')
  if (subs.length === 0) {
    // 没有真实子代理会话可比对（CI/新机器）——不算失败，但明确说出来
    console.log('[skip] 本机无 origin=subagent 的真实会话，跳过解析校验')
    return
  }
  const withParent = subs.filter((r) => typeof r.parentSession === 'string' && r.parentSession !== '')
  assert.ok(withParent.length > 0,
    `本机有 ${subs.length} 条子代理会话，但 parentSession 一条都没解析出来 —— parseMeta 漏读了日志头的 parentSession`)
})
