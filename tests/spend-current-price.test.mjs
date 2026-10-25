/**
 * **改价后花费/预算按现价重算**（用户报障原话：「子代理莫名显示『超预算』…这是 bug 需修复」）。
 *
 * 两条独立的裂缝，同一个根因「账本 `entry.cost` 是记账时的价快照」：
 *  ① **判定**：门禁预算读 `cycleSpendOf`（快照 Σ）→ 曾把模型价调高跑一段再调回来，那批账永远停在 24 元，
 *     出现「面板显示 0.099 元、门禁说已达 20 元上限」。现判定统一走 `cycleSpendAtCurrentPrices`。
 *  ② **展示**：列表花费 / 上次花费 / 本周期花费 / 详情每笔保温 都直接读快照，改价后不跟着变。
 *     现全部走 `recomputeCost` / `spendAtCurrentPrices`。
 *
 * 判定用的账本事实函数（`cycleSpendOf` / `spendOf` / `cycleStatsOf`）**一个字都不许改**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { createPanelService } from '../src/core/panel-service.ts'
import { buildGateInput } from '../src/core/gate-input.ts'
import { decideWarm } from '../src/gate.ts'
import { pickAutoCandidates } from '../src/auto.ts'
import { spendAtCurrentPrices } from '../src/core/ledger-entry.ts'
import { DEFAULT_PRICES, DEFAULT_TARIFF, priceFingerprint } from '../src/econ.ts'
import {
  DEFAULT_SETTINGS, cycleSpendAtCurrentPrices, cycleSpendOf, loadState, spendOf,
} from '../src/store.ts'
import { tmproot, tmpremove } from './_tmp.js'

const MIN = 60_000
const HOUR = 60 * MIN
const ID = 'session-price-1'
const MODEL = 'm-price'
/** 当前价：命中 0.1 / 未命中 1 / 输出 2（元每百万 token）。 */
const LOW = { hit: 0.1, miss: 1, out: 2 }
/** 当年被调高的价。 */
const HIGH = { hit: 900, miss: 900, out: 900 }

/** 一条账本：命中 500 / 未命中 500 / 输出 100。现价下 = 0.00075 元。 */
function entry(at, storedCost, cycle) {
  return {
    at, gapSeconds: 3600, promptTokens: 1000, hitTokens: 500, missTokens: 500, outputTokens: 100,
    cost: storedCost, hitRate: 0.5, ms: 3000, touch: 1, model: MODEL, cycle: cycle ?? 1,
  }
}
const EXPECT_ONE = (500 * LOW.hit + 500 * LOW.miss + 100 * LOW.out) / 1e6

function mkState(f) {
  const o = f || {}
  return {
    version: 1,
    settings: {
      ...DEFAULT_SETTINGS,
      budgetPerSession: 20,
      ...(o.settings || {}),
      prices: { ...LOW },
      pricesByModel: { [MODEL]: { ...(o.modelPrices || LOW) } },
      tariff: { ...DEFAULT_TARIFF, enabled: false },
    },
    sessions: {},
    ledger: { s: o.entries ?? [] },
    ...(o.extra || {}),
  }
}

const gateOf = (st, f) => decideWarm(buildGateInput(st, {
  id: 's', mtime: 1_700_000_000_000, hasRoute: true, tripped: false, at: 1_700_000_000_000, ...(f || {}),
}))

/* ── ① 价格指纹：只跟会改变金额的三项 ─────────────────────────────── */

test('priceFingerprint 对 prices/pricesByModel/tariff 敏感，对无关设置不敏感', () => {
  const base = mkState({ entries: [] }).settings
  const fp = priceFingerprint(base)
  assert.match(fp, /^[0-9a-f]{12}$/, '12 位十六进制')
  assert.equal(priceFingerprint({ ...base }), fp, '同一份设置 → 同一指纹')
  assert.notEqual(priceFingerprint({ ...base, prices: { ...LOW, miss: 1.5 } }), fp, '基准价变 → 指纹变')
  assert.notEqual(
    priceFingerprint({ ...base, pricesByModel: { [MODEL]: { ...LOW, out: 8 } } }), fp, '模型价表变 → 指纹变',
  )
  assert.notEqual(
    priceFingerprint({ ...base, tariff: { ...base.tariff, enabled: true } }), fp, '只改 tariff.enabled → 指纹变',
  )
  for (const k of ['intervalSeconds', 'timelineCacheMinutes', 'maxTokens', 'budgetPerSession']) {
    assert.equal(
      priceFingerprint({ ...base, [k]: Number(base[k] ?? 0) + 123 }), fp,
      '与金额无关的设置不该进指纹：' + k,
    )
  }
})

/* ── ② 展示口径：改价后三处变、判定三处不变 ────────────────────────── */

function writeHome(tag, prices) {
  const home = tmproot(tag)
  const now = Date.now()
  const dir = join(home, 'sessions', 'proj-a', ID)
  mkdirSync(dir, { recursive: true })
  const text = [
    { type: 'session', seq: 0, time: now - 30 * MIN, id: ID, cwd: 'C:\\tmp', createdAt: now - 30 * MIN },
    { type: 'user/message', seq: 1, time: now - 20 * MIN },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n'
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(text, 'utf8')))
  const stDir = join(home, 'cache-keepalive')
  mkdirSync(stDir, { recursive: true })
  writeFileSync(join(stDir, 'state.json'), JSON.stringify({
    version: 1,
    settings: {
      ...DEFAULT_SETTINGS,
      budgetPerSession: 20,
      prices: { ...prices },
      pricesByModel: { [MODEL]: { ...prices } },
      tariff: { ...DEFAULT_TARIFF, enabled: false },
      timelineCacheMinutes: 10,
    },
    sessions: {},
    ledger: { [ID]: [entry(now - 10 * MIN, 0.0016, 1), entry(now - 5 * MIN, 0.0016, 2)] },
  }), 'utf8')
  writeFileSync(join(stDir, 'sessions.meta.json'), JSON.stringify({
    at: now, version: 1, sig: 'x',
    items: {
      [ID]: {
        mtime: now - MIN, title: '改价', titleSource: 'user', archived: false, origin: '',
        projectKey: 'proj-a', dirName: ID, sizeBytes: 1, lastDialogAt: now - 20 * MIN,
      },
    },
  }), 'utf8')
  return { home, now }
}

const svcOf = (home, now) => createPanelService({ dshHome: home, warm: async () => ({ ok: true }), now: () => now })
const rowOf = (home, now) => svcOf(home, now).snapshot().sessions.find((r) => r.id === ID)

test('改价后 buildRow.spend / last.cost / cycleSpendDisplay 变，cycleSpendOf / spendOf / tripped 不变', () => {
  const a = writeHome('sp-price-a', LOW)
  const b = writeHome('sp-price-b', { hit: LOW.hit * 2, miss: LOW.miss * 2, out: LOW.out * 2 })
  try {
    const ra = rowOf(a.home, a.now)
    const rb = rowOf(b.home, b.now)
    assert.ok(ra !== undefined && rb !== undefined, '两条会话都要出现在快照里')
    /** 展示：翻倍。 */
    assert.equal(ra.spend, EXPECT_ONE * 2, '两条账本按现价')
    assert.equal(rb.spend, EXPECT_ONE * 4, '价格翻倍 → 花费翻倍')
    assert.equal(rb.last.cost, EXPECT_ONE * 2, '上次花费按现价')
    assert.equal(ra.last.cost, EXPECT_ONE)
    /** 周期默认 1 → 只有第一条；第二条是 cycle=2。 */
    assert.equal(ra.cycleSpendDisplay, EXPECT_ONE, '本周期展示口径')
    assert.equal(rb.cycleSpendDisplay, EXPECT_ONE * 2)
    /** 判定：账本事实，一分不动。 */
    assert.equal(ra.cycleSpend, 0.0016)
    assert.equal(rb.cycleSpend, 0.0016, 'cycleSpend 是账本快照，改价不许影响它')
    const sa = loadState(join(a.home, 'cache-keepalive', 'state.json'))
    const sb = loadState(join(b.home, 'cache-keepalive', 'state.json'))
    assert.equal(spendOf(sb, ID), spendOf(sa, ID), 'spendOf 不变')
    assert.equal(cycleSpendOf(sb, ID), cycleSpendOf(sa, ID), 'cycleSpendOf 不变')
    assert.equal(rb.tripped, ra.tripped, '熔断结论不变')
    assert.equal(rb.ledgerSpend, ra.ledgerSpend, '真实花过的钱不变')
  } finally { tmpremove(a.home); tmpremove(b.home) }
})

test('展示口径同源：面板行 spend == 详情 warmCost == 各笔之和', async () => {
  const x = writeHome('sp-same', LOW)
  try {
    const svc = svcOf(x.home, x.now)
    const row = rowOf(x.home, x.now)
    const d = await svc.timelineUncached(ID, 'step')
    const warms = d.items.filter((i) => i.kind === 'warm')
    assert.equal(warms.length, 2, '两条账本都要出现在详情里')
    for (const w of warms) assert.equal(w.cost, EXPECT_ONE, '每笔按现价')
    assert.equal(d.summary.warmCost, row.spend, '详情保温合计 == 面板行花费')
    assert.equal(d.summary.totalCost, d.summary.roundCost + d.summary.warmCost, 'summary 自洽')
    assert.equal(d.summary.cycleWarmCost, row.cycleSpendDisplay, '浮层「本期」两处同口径')
  } finally { tmpremove(x.home) }
})

test('时间轴 TTL 缓存带价格指纹：改价后立刻再取不会吐旧价', async () => {
  const x = writeHome('sp-cache', LOW)
  try {
    const svc = svcOf(x.home, x.now)
    const before = await svc.timeline(ID, 'step')
    assert.equal(before.summary.warmCost, EXPECT_ONE * 2)
    /** 直接改盘上的价格（模拟「工具/另一个进程/手改 state.json」改价）。 */
    const file = join(x.home, 'cache-keepalive', 'state.json')
    const st = JSON.parse(readFileSync(file, 'utf8'))
    const doubled = { hit: LOW.hit * 2, miss: LOW.miss * 2, out: LOW.out * 2 }
    st.settings.prices = { ...doubled }
    st.settings.pricesByModel = { [MODEL]: { ...doubled } }
    writeFileSync(file, JSON.stringify(st), 'utf8')
    const after = await svc.timeline(ID, 'step')
    assert.equal(after.summary.warmCost, EXPECT_ONE * 4, '改价后必须重算，不能命中旧缓存')
  } finally { tmpremove(x.home) }
})

/* ── ③ 判定口径：预算按现价（真机 verify-a 形态）──────────────────── */

const bigBook = (per) => Array.from({ length: 51 }, (_, i) => entry(1_700_000_000_000 - (51 - i) * MIN, per, 1))

test('高价位历史账 + 现价低 → 门禁不判 budget（显示与判定同口径）', () => {
  /** 51 条，每条存储 24.14/51 ≈ 0.4733 元（当年高价记下的）。 */
  const st = mkState({ entries: bigBook(24.14 / 51) })
  const stored = cycleSpendOf(st, 's')
  const current = cycleSpendAtCurrentPrices(st, st.settings, 's')
  assert.ok(Math.abs(stored - 24.14) < 0.01, '账本快照仍是 24.14 元')
  assert.ok(current < 0.1, '现价只有几分钱，实际 ' + current)
  const g = gateOf(st)
  assert.notEqual(g.code, 'budget', '不许再说「超预算」')
  const gi = buildGateInput(st, { id: 's', mtime: 1_700_000_000_000, hasRoute: true, tripped: false })
  assert.equal(gi.cumulativeCost, current, '门禁拿到的预算数字与展示口径同源')
})

test('现价本身确实超 20 元 → 仍判 budget（没把熔断废掉）', () => {
  const st = mkState({ entries: bigBook(24.14 / 51), modelPrices: HIGH })
  assert.ok(cycleSpendAtCurrentPrices(st, st.settings, 's') > 20, '现价确实超限')
  assert.equal(gateOf(st).code, 'budget', '该熔还得熔')
})

test('cycleSpendAtCurrentPrices 与 cycleSpendOf 取同一批条目，且下限 0', () => {
  const st = mkState({ entries: [entry(1_700_000_000_000 - MIN, 0.5, 1), entry(1_700_000_000_000, 0.5, 1)] })
  st.cycles = { s: 2 }
  /** 两条都在 cycle=1，当前周期 2 → 一条都不计入。 */
  assert.equal(cycleSpendOf(st, 's'), 0)
  assert.equal(cycleSpendAtCurrentPrices(st, st.settings, 's'), 0)
  /** 在途花费若被写成负数，也不该把预算算成「已花 −100 元」。 */
  const neg = mkState({ entries: [] })
  neg.labPending = [{ id: 'x', sessionId: 's', worst: -100, at: 1_700_000_000_000, status: 'unknown' }]
  assert.equal(cycleSpendAtCurrentPrices(neg, neg.settings, 's'), 0, '下限 0，不许负')
  assert.ok(cycleSpendOf(neg, 's') < 0, '对照：旧函数会给出负数')
})

/* ── ④ 子代理总开关：关着就必须先短路 ─────────────────────────────── */

test('autoAllowSubagent=false 时子代理不入候选（autoCountSubagent 再大也不放行）', () => {
  const cands = [
    { id: 'main', lastActiveAt: 1_700_000_000_000 - HOUR, gateOk: true, isSubagent: false },
    { id: 'sub', lastActiveAt: 1_700_000_000_000 - MIN, gateOk: true, isSubagent: true },
  ]
  const settings = { enabled: true, count: 5, maxIdleHours: 2, allowSubagent: false, autoCountSubagent: 5 }
  const out = new Map(pickAutoCandidates(cands, settings, 1_700_000_000_000).map((d) => [d.id, d]))
  assert.equal(out.get('sub').picked, false, '开关关着，子代理不许入候选')
  assert.equal(out.get('sub').reason, 'subagent', '理由要照实说是「子代理」')
  assert.equal(out.get('main').picked, true, '普通会话不受影响')

  const on = new Map(pickAutoCandidates(cands, { ...settings, allowSubagent: true }, 1_700_000_000_000)
    .map((d) => [d.id, d]))
  assert.equal(on.get('sub').picked, true, '打开开关后子代理可以入候选')
})
