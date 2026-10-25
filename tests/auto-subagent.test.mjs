/**
 * 子代理保温「失效」—— 判据见 `.tmp/contract-4tasks.md` §任务 B（B1~B7 + B8/B9 的库内那一半）。
 *
 * 真因（Lead 实测）：`autoAllowSubagent=true` 时子代理**确实进了候选**，
 * 但选中那一刻门禁判 `too-soon` —— 主会话间隔 4 小时，子代理寿命只有 1~50 分钟，
 * 等不到窗口就结束了。修法三条：
 *   ① 子代理用 `subagentIntervalSeconds`（默认 120 秒）
 *   ② 子代理**不吃**网页版延后（`delayMs` 归零）—— 只改间隔的话 `--serve --auto` 下门槛是 240 秒
 *   ③ 候选判定里子代理排在 `mode` 之前（否则 `mode='on'` 的子代理报 `manual` 而不是 `subagent`）
 *
 * 跑法：`node --test tests/auto-subagent.test.mjs`（不需要网络、不花钱、不碰真实 home）
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { pickAutoCandidates } from '../src/auto.ts'
import { decideCandidates } from '../src/core/candidates.ts'
import { buildGateInput, subagentIntervalMsOf } from '../src/core/gate-input.ts'
import { decideWarm } from '../src/gate.ts'
import { DEFAULT_SETTINGS, loadState } from '../src/store.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const NOW = 1_700_000_000_000
/** 网页版（`cli/keepalive.mjs --serve --auto`）真实传的延后。 */
const WARM_DELAY_MS = 2 * MIN

/** 一份干净的内存 State（不读盘、不写盘）。 */
function freshState(settings = {}) {
  const state = loadState('C:/definitely/not/here/state.json')
  Object.assign(state.settings, { intervalSeconds: 4 * 3600, idleLimitHours: 8, freshSeconds: 300 }, settings)
  return state
}

/** 门禁输入的完整底稿：除 `intervalMs` 之外的默认值都在这里，用例只覆盖关心的字段。 */
function gateBase(state, over = {}) {
  return {
    now: NOW,
    agentStatus: 'idle',
    lastActivityAt: NOW - 2 * MIN,
    lastTouchAt: 0,
    touchCount: 0,
    touchCountTotal: 0,
    cumulativeCost: 0,
    tripped: false,
    hasRoute: true,
    intervalMs: state.settings.intervalSeconds * 1000,
    subagentIntervalMs: subagentIntervalMsOf(state),
    idleLimitMs: 8 * HOUR,
    freshMs: 5 * MIN,
    maxTouches: 9,
    maxTouchesTotal: 0,
    budget: 0.5,
    ...over,
  }
}

const AUTO_ON = { enabled: true, count: 3, maxIdleHours: 8, allowSubagent: true }

// ── B1 子代理与主会话**同源**间隔（不再有独立短间隔） ────────────────
test('B1 子代理与主会话同源：间隔 4 小时时，2 分钟前活动仍 too-soon', () => {
  const state = freshState()
  const input = gateBase(state, { isSubagent: true, delayMs: WARM_DELAY_MS })
  /** 子代理不再有 120 秒的独立间隔 → 与主会话同一门槛，2 分钟前活动必然在间隔内。 */
  assert.equal(input.subagentIntervalMs, input.intervalMs, 'subagentIntervalMs 必须恒等于 intervalMs')
  const got = decideWarm(input)
  assert.equal(got.ok, false, '子代理不再享有短间隔，应 too-soon：' + JSON.stringify(got))
  assert.equal(got.code, 'too-soon')
  // 对照：普通会话同一时刻 code 一致（间隔同源；remain 会差 2 分钟延后，所以只比 code）
  assert.equal(decideWarm({ ...input, isSubagent: false }).code, got.code)
})

test('B1b 子代理间隔**来自 effectiveLimitsOf**（含 per-model 覆盖），且 subagentIntervalSeconds 已被旁路', () => {
  /** 用户「间隔 7500 秒」的会话：子代理与主会话都吃这一档。 */
  const overrides = { 'tokenrhythm/x': { intervalSeconds: 7500 } }
  const state = freshState({ modelOverrides: overrides })
  const opts = { id: 's1', mtime: NOW, hasRoute: true, tripped: false, isSubagent: true, provider: 'tokenrhythm-title', model: 'x', at: NOW }
  const g = buildGateInput(state, opts)
  assert.equal(g.intervalMs, 7_500_000, '主会话间隔应命中 per-model 7500')
  assert.equal(g.subagentIntervalMs, 7_500_000, '子代理间隔必须与主会话同源（不是 120 秒）')
  /** **旁路证明**：把 subagentIntervalSeconds 改成 999999 也不影响生效间隔。 */
  const g2 = buildGateInput(freshState({ modelOverrides: overrides, subagentIntervalSeconds: 999999 }), opts)
  assert.equal(g2.subagentIntervalMs, 7_500_000, 'subagentIntervalSeconds 改变不得影响生效间隔（判定层已不读它）')
  assert.equal(g2.intervalMs, g.intervalMs)
  /** 没有 per-model 覆盖时，子代理同样吃全局间隔。 */
  const g3 = buildGateInput(freshState({ subagentIntervalSeconds: 999999 }), opts)
  assert.equal(g3.subagentIntervalMs, 4 * 3600 * 1000, '无覆盖时子代理间隔 = 全局 intervalSeconds')
})

test('B1c 「保过」路径同样用**同源**间隔（不因短间隔提前放行）', () => {
  const state = freshState()
  /** 距上次保温 126 分钟：interval 4h（14400s）时仍在间隔内 → too-soon。 */
  const warmed = gateBase(state, {
    isSubagent: true, lastTouchAt: NOW - 126 * MIN, lastActivityAt: NOW - 126 * MIN,
    touchCount: 1, touchCountTotal: 1,
  })
  assert.equal(warmed.subagentIntervalMs, warmed.intervalMs, '保过路径也用同一个间隔')
  assert.equal(decideWarm(warmed).code, 'too-soon', '间隔 4 小时时 126 分钟仍在间隔内')
  /** 换成 per-model 7500 秒（同源传入）→ 同样 126 分钟应放行。 */
  const noz = gateBase(state, {
    isSubagent: true, intervalMs: 7_500_000, subagentIntervalMs: 7_500_000,
    lastTouchAt: NOW - 126 * MIN, lastActivityAt: NOW - 126 * MIN, touchCount: 1, touchCountTotal: 1,
  })
  assert.equal(decideWarm(noz).ok, true, '间隔 7500 秒时 126 分钟应放行')
  // 3 分钟时两条都是 fresh（与子代理无关的既有窗口）
  const freshSub = gateBase(state, {
    isSubagent: true, lastTouchAt: NOW - 3 * MIN, lastActivityAt: NOW - 3 * MIN, touchCount: 1, touchCountTotal: 1,
  })
  assert.equal(decideWarm(freshSub).code, 'fresh')
  assert.equal(decideWarm({ ...freshSub, isSubagent: false }).code, 'fresh')
})

// ── B2 普通会话不受影响 ──────────────────────────────────────────────
test('B2 普通会话：对话在 2 分钟前 → 仍 too-soon（间隔 4 小时）', () => {
  const state = freshState()
  const got = decideWarm(gateBase(state, { isSubagent: false }))
  assert.equal(got.ok, false)
  assert.equal(got.code, 'too-soon')
  assert.match(got.detail, /间隔 240 分钟/, '间隔文案必须是主会话的 4 小时口径')
})

test('B2b 不传 isSubagent 的调用方行为完全不变（缺省 = 普通会话）', () => {
  const state = freshState()
  const base = gateBase(state)
  delete base.isSubagent
  const got = decideWarm(base)
  assert.equal(got.code, 'too-soon')
  // 与显式 false 逐字相同
  assert.deepEqual(got, decideWarm({ ...base, isSubagent: false }))
})

// ── B3 闸门关掉时不保 ────────────────────────────────────────────────
test('B3 autoAllowSubagent=false + 子代理 → 不进候选（reason=subagent）', () => {
  const cands = [{ id: 'sub', lastActiveAt: NOW - 5 * MIN, gateOk: true, isSubagent: true }]
  for (const mode of [undefined, 'auto', 'on', 'off']) {
    const off = pickAutoCandidates(
      [{ ...cands[0], ...(mode === undefined ? {} : { mode }) }],
      { ...AUTO_ON, allowSubagent: false },
      NOW,
    )
    const d = off.find((x) => x.id === 'sub')
    assert.equal(d.picked, false, `mode=${String(mode)} 时不该进候选`)
    assert.equal(d.reason, 'subagent', `mode=${String(mode)} 时报的原因应是 subagent，实际 ${d.reason}`)
  }
})

// ── B4 / B8 / B9 判定顺序：子代理排在 mode 之前 ──────────────────────
test('B4+B8 mode=on 的子代理 + 闸门关 → 库里报 subagent（不再是 manual）', () => {
  const d = pickAutoCandidates(
    [{ id: 'forced-sub', lastActiveAt: NOW - MIN, gateOk: true, isSubagent: true, mode: 'on' }],
    { ...AUTO_ON, allowSubagent: false },
    NOW,
  ).find((x) => x.id === 'forced-sub')
  assert.equal(d.reason, 'subagent', '子代理判定必须排在 mode 之前，否则回落到 manual')
  assert.equal(d.picked, false)
})

test('B9 mode=on 的子代理 + 闸门开 → **不进自动池**（走 tick 强制路径，不占自动名额）', () => {
  /**
   * ⚠️ 契约 v5 修订：`mode='on'` 是「手动强制开」，它走 tick 的 `targets` 强制路径，
   * **本来就不该进自动池**（进池会白占 `count` 名额，把手动指定和自动托管混为一谈）。
   * tick 层「`allowSubagent=true` 时 targets 含它」由 impl-a 的 `tick-subagent-filter.test.mjs` 守。
   */
  const d = pickAutoCandidates(
    [{ id: 'forced-sub', lastActiveAt: NOW - MIN, gateOk: true, isSubagent: true, mode: 'on' }],
    AUTO_ON,
    NOW,
  ).find((x) => x.id === 'forced-sub')
  assert.equal(d.picked, false, '手动强制开的会话不该占自动名额')
  assert.equal(d.reason, 'manual', 'reason 必须是 manual（不是 subagent，也不是 gate）')
  // 闸门开时「子代理 + mode=auto」才是自动池该收的形态
  const auto = pickAutoCandidates(
    [{ id: 'auto-sub', lastActiveAt: NOW - MIN, gateOk: true, isSubagent: true, mode: 'auto' }],
    AUTO_ON,
    NOW,
  ).find((x) => x.id === 'auto-sub')
  assert.equal(auto.picked, true, 'allowSubagent=true 时 mode=auto 的子代理应进池')
  // 普通会话的 manual 判定没被波及
  const m = pickAutoCandidates(
    [{ id: 'forced', lastActiveAt: NOW - MIN, gateOk: true, mode: 'on' }], AUTO_ON, NOW,
  ).find((x) => x.id === 'forced')
  assert.equal(m.reason, 'manual')
})

test('B4b 判定顺序仍是 archived → gate → subagent → manual（前一个赢）', () => {
  const judge = (c) => pickAutoCandidates([{ id: 'x', lastActiveAt: NOW - MIN, ...c }], { ...AUTO_ON, allowSubagent: false }, NOW)[0]
  assert.equal(judge({ isSubagent: true, archived: true, gateOk: false }).reason, 'archived')
  assert.equal(judge({ isSubagent: true, gateOk: false }).reason, 'gate')
  assert.equal(judge({ isSubagent: true, gateOk: true, mode: 'on' }).reason, 'subagent')
  assert.equal(judge({ gateOk: true, mode: 'on' }).reason, 'manual')
})

// ── B5 用户环境实测（关键）：带网页版 2 分钟延后 ──────────────────────
test('★ B5 子代理不再有短间隔特例：2 分钟前活动同样 too-soon（与主会话同源）', () => {
  const state = freshState()
  const got = decideWarm(gateBase(state, { isSubagent: true, delayMs: WARM_DELAY_MS }))
  assert.equal(got.ok, false, '子代理不享短间隔，应 too-soon：' + JSON.stringify(got))
  assert.equal(got.code, 'too-soon')
  /** 真正的「子代理特例」只剩「不吃延后」，由 B5b 守。 */
  const asNormal = decideWarm(gateBase(state, { isSubagent: false, delayMs: WARM_DELAY_MS }))
  assert.equal(asNormal.code, 'too-soon')
})

test('B5b 子代理仍然**不吃网页版延后**（interval 到点即放行，主会话同刻仍在等）', () => {
  const state = freshState()
  /** 用 per-model 7500 秒当间隔：7501 秒（刚好过线）子代理应放行，即便带了 2 分钟延后。 */
  const over = {
    intervalMs: 7_500_000, subagentIntervalMs: 7_500_000,
    delayMs: WARM_DELAY_MS, lastActivityAt: NOW - 7_501_000,
  }
  assert.equal(decideWarm(gateBase(state, { ...over, isSubagent: true })).ok, true, '子代理不吃延后 → 过线即放行')
  const asNormal = decideWarm(gateBase(state, { ...over, isSubagent: false }))
  assert.equal(asNormal.ok, false, '主会话同一刻仍在延后期内')
  assert.equal(asNormal.code, 'too-soon')
})

// ── B6 普通会话的 delay 行为不变 ─────────────────────────────────────
test('B6 普通会话 + delayMs=120000：4h01m 仍 too-soon、4h03m 放行', () => {
  const state = freshState()
  const at401 = decideWarm(gateBase(state, { delayMs: WARM_DELAY_MS, lastActivityAt: NOW - (4 * HOUR + MIN) }))
  assert.equal(at401.ok, false)
  assert.equal(at401.code, 'too-soon')
  const at403 = decideWarm(gateBase(state, { delayMs: WARM_DELAY_MS, lastActivityAt: NOW - (4 * HOUR + 3 * MIN) }))
  assert.equal(at403.ok, true)
})

// ── B7 CLI 与插件结论逐条一致 ────────────────────────────────────────
// ⚠️ 两条链路必须喂**同一个 delayMs**：`decideCandidates`（面板/CLI 共用）历史上就不传 `delayMs`
// （`src/core/candidates.ts` 的 `buildGateInput` 参数里没有它，基线 `6906c4c` 即如此）——
// 它只负责「谁是候选」，真正的 2 分钟让路由调用方（`cli/keepalive.mjs` 的 `delayMs`）再做一次。
// 所以拿「传了 delay」的手工链路去和「没传 delay」的库函数比，本身就是错的：
// 这里手工链路同样不传 delay，比的才是同一件事。
test('★ B7 同一批数据：(built gate → decideWarm → gateAccepts → pickAutoCandidates) 与 decideCandidates 逐条相同', () => {
  const state = freshState()
  const rows = [
    { id: 'sub-recent', mtime: NOW - 2 * MIN, archived: false, origin: 'subagent', title: '子甲' },
    { id: 'sub-warmed', mtime: NOW - 9 * MIN, archived: false, origin: 'subagent', title: '子乙' },
    { id: 'sub-old', mtime: NOW - 30 * MIN, archived: false, origin: 'subagent', title: '子丙' },
    { id: 'normal-recent', mtime: NOW - 2 * MIN, archived: false, origin: '', title: '主甲' },
    { id: 'normal-mid', mtime: NOW - 30 * MIN, archived: false, origin: '', title: '主丙' },
    { id: 'normal-old', mtime: NOW - 5 * HOUR, archived: false, origin: '', title: '主乙' },
  ]
  state.ledger['sub-warmed'] = [{ at: NOW - 9 * MIN, touch: 1 }]
  const got = decideCandidates(state, rows, NOW, AUTO_ON)
  /** 手工链路：与 `core/candidates.ts` 独立地再算一遍（三处调用方拿到的是同一份输入，同样不传 delayMs）。 */
  const pool = rows.map((row) => {
    const isSubagent = row.origin === 'subagent'
    const g = decideWarm(buildGateInput(state, {
      id: row.id, mtime: row.mtime, hasRoute: true, tripped: false, archived: false,
      agentStatus: 'idle', lastActivityAt: row.mtime, isSubagent, at: NOW,
    }))
    return {
      id: row.id,
      lastActiveAt: row.mtime,
      mode: undefined,
      hasTitle: true,
      isSubagent,
      archived: false,
      gateOk: g.ok === true || g.code === 'fresh' || g.code === 'too-soon',
    }
  })
  const want = new Map(pickAutoCandidates(pool, AUTO_ON, NOW).map((d) => [d.id, d]))
  assert.equal(got.size, want.size)
  for (const [id, w] of want) {
    const g = got.get(id)
    assert.ok(g !== undefined, 'decideCandidates 少了 ' + id)
    assert.equal(g.picked, w.picked, id + ' picked 不一致')
    assert.equal(g.rank, w.rank, id + ' rank 不一致')
    assert.equal(g.reason ?? '', w.reason ?? '', id + ' reason 不一致')
  }
  // 顺带钉住结论本身，避免「两边都错」也判过
  assert.equal(want.get('sub-recent').picked, true, '2 分钟前的子代理应进候选')
  assert.equal(want.get('sub-warmed').picked, true, '9 分钟前保过的子代理应进候选')
  /**
   * **子代理与普通会话是两个独立名额池**（S1 起）：
   * `AUTO_ON` 只传了旧开关 `allowSubagent:true`、没传 `countSubagent` → 按兼容口径
   * 「不限名额」，所以闸门放行的 3 条子代理全进，且**不吃** `count=3` 的普通会话名额。
   * 因此普通会话里门禁 warm 的 3 条也全进 —— `normal-old` 不再是 `over-quota`。
   */
  assert.equal(want.get('normal-old').picked, true, '子代理走独立名额，不占普通会话的 count')
  assert.equal(want.get('sub-old').picked, true, '子代理池独立于 count=3，闸门放行即进')
  /**
   * 普通会话的 2 分钟延迟由调用方（`cli/keepalive.mjs` 的 `delayMs`）加，**不在本函数里**。
   * 所以这里不带 delay 时它只是 `too-soon`，而 `too-soon` 按 `gateAccepts` 口径**仍占名额** ——
   * 这正是「保过的会话在间隔内必然 too-soon、不能因此丢名额」的既有语义（`auto.test.mjs` 用例 7 同理）。
   * 真带 delay 时它会被拦到点后再保，行为见 B6。
   */
  assert.equal(want.get('normal-recent').picked, true, '普通会话 too-soon 仍占名额（间隔内是常态，不是该让位的理由）')
})

test('B7b decideCandidates 传了 isSubagent：不传则子代理回落到主会话间隔（证明这一位是必需的）', async () => {
  const state = freshState()
  const rows = [{ id: 'sub', mtime: NOW - 2 * MIN, archived: false, origin: 'subagent', title: '子' }]
  const withFlag = decideCandidates(state, rows, NOW, AUTO_ON).get('sub')
  assert.equal(withFlag.picked, true)
  // 模拟「调用方漏传」：手工构造不带 isSubagent 的门禁输入
  const g = decideWarm(buildGateInput(state, {
    id: 'sub', mtime: NOW - 2 * MIN, hasRoute: true, tripped: false, archived: false,
    agentStatus: 'idle', lastActivityAt: NOW - 2 * MIN, at: NOW,
  }))
  assert.equal(g.code, 'too-soon', '漏传 isSubagent 时子代理必须仍被判 too-soon（这就是原 bug）')
})
