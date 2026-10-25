/**
 * 改价后的**历史保温花费**必须按当前价显示（离线面板链路）。
 *
 * 用户报障原文：「模型价格修改后，详情页以前的花费……还是根据以前的价格计算，
 * 而不是调整为新设定的价格。」
 *
 * 账本 `entry.cost` 是记账时的价快照，改价后它不会变（也不该变：预算/熔断要的是真实花过的钱）。
 * 所以**展示侧**必须逐笔 `recomputeCost` 重算 —— 列表花费、详情每笔、详情周期合计、周期统计
 * 「上次花费」「本期花费」都得同口径，否则同一会话在面板行和详情页会显示两个数。
 *
 * 断言：
 *  ① 详情里每条保温的花费 = 当前价手算值（且 ≠ 存储快照）；
 *  ② 面板行 `spend` == 详情 `summary.warmCost` == `costs().total`（三处同口径）；
 *  ③ 改价后 `timeline()` 的 TTL 缓存不能吐旧价（缓存键必须带价格指纹）；
 *  ④ 「上次花费」`last.cost` 改价后跟着变；
 *  ⑤ `cycleSpendDisplay` 跟着变，而判定用的 `cycleSpend` **一动不动**（熔断/预算不许被改价带偏）；
 *  ⑥ 详情浮层两个「本期」金额（`cycleWarmCost` 与 `cycleSpendDisplay`）同口径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { createPanelService } from '../src/core/panel-service.ts'
import { DEFAULT_SETTINGS, cycleSpendOf, loadState, spendOf } from '../src/store.ts'
import { DEFAULT_PRICES, DEFAULT_TARIFF, priceFingerprint, recomputeCost } from '../src/econ.ts'
import { spendAtCurrentPrices } from '../src/core/ledger-entry.ts'
import { PANEL_HTML } from '../src/panel.ts'
import { tmproot, tmpremove } from './_tmp.js'

const ID = 'session-price-1'
const LOG_NAME = 'session.v4.jsonl.zstd'
const T = 1_800_000_000_000
const MIN = 60_000
const MODEL = 'm-price'

/** 当前价（每百万 token）：命中 0.1 / 未命中 1 / 输出 2。 */
const PRICES = { hit: 0.1, miss: 1, out: 2 }

/** 一条账本：命中 500、未命中 500、输出 100 → 新价下 0.00075 元。 */
function entry(f) {
  const o = f || {}
  return {
    at: o.at ?? T - 10 * MIN,
    gapSeconds: 3600,
    promptTokens: 1000,
    hitTokens: 500,
    missTokens: 500,
    outputTokens: 100,
    /** **故意存一个明显错的旧价**：改价前按 1 元/百万算出来的是 0.0016 之类。 */
    cost: 0.0016,
    hitRate: 0.5,
    ms: 3000,
    touch: 0,
    model: MODEL,
    cycle: o.cycle ?? 1,
  }
}

function writeState(home, prices) {
  const dir = join(home, 'cache-keepalive')
  mkdirSync(dir, { recursive: true })
  const state = {
    version: 1,
    settings: {
      ...DEFAULT_SETTINGS,
      prices: { ...DEFAULT_PRICES },
      pricesByModel: { [MODEL]: { ...prices } },
      /** 关时段表：倍率恒 1，手算才可预期。 */
      tariff: { ...DEFAULT_TARIFF, enabled: false },
      timelineCacheMinutes: 10,
    },
    sessions: {},
    ledger: { [ID]: [entry({ at: T - 10 * MIN, cycle: 1 }), entry({ at: T - 5 * MIN, cycle: 2 })] },
  }
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state), 'utf8')
}

function writeSession(home) {
  const dir = join(home, 'sessions', 'proj-a', ID)
  mkdirSync(dir, { recursive: true })
  const text = [
    { type: 'session', seq: 0, time: T - 60 * MIN, id: ID, cwd: 'C:\\tmp', createdAt: T - 60 * MIN },
    { type: 'user/message', seq: 1, time: T - 50 * MIN },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n'
  writeFileSync(join(dir, LOG_NAME), zstdCompressSync(Buffer.from(text, 'utf8')))
  writeFileSync(join(home, 'cache-keepalive', 'sessions.meta.json'), JSON.stringify({
    at: T, version: 1, sig: 'x',
    items: {
      [ID]: {
        mtime: T - MIN, title: '改价回归', titleSource: 'user', archived: false, origin: '',
        projectKey: 'proj-a', dirName: ID, sizeBytes: 1, lastDialogAt: T - 50 * MIN,
      },
    },
  }), 'utf8')
}

const svcOf = (home) => createPanelService({ dshHome: home, warm: async () => ({ ok: true }), now: () => T })

/** 手算：500×0.1/1e6 + 500×1/1e6 + 100×2/1e6。 */
const EXPECT_ONE = (500 * PRICES.hit + 500 * PRICES.miss + 100 * PRICES.out) / 1e6

function setup(tag) {
  const home = tmproot(tag)
  writeState(home, PRICES)
  writeSession(home)
  return home
}

test('详情每笔保温花费 = 当前价手算值（不是账本里的旧价快照）', async () => {
  const home = setup('tl-price-warm')
  try {
    const d = await svcOf(home).timelineUncached(ID, 'step')
    const warms = d.items.filter((i) => i.kind === 'warm')
    assert.equal(warms.length, 2, '两条账本都要出现在详情里')
    for (const w of warms) {
      assert.equal(w.cost, EXPECT_ONE, '保温花费必须按当前价重算')
      assert.notEqual(w.cost, 0.0016, '不能沿用账本里的旧价快照')
    }
  } finally { tmpremove(home) }
})

test('面板行 spend == 详情 warmCost == 周期合计（三处同口径）', async () => {
  const home = setup('tl-price-consistency')
  try {
    const svc = svcOf(home)
    const row = (svc.snapshot().sessions ?? []).find((r) => r.id === ID)
    assert.ok(row !== undefined, '面板里要有这条会话')
    const d = await svc.timelineUncached(ID, 'step')
    const c = svc.costs(ID)
    assert.equal(row.spend, EXPECT_ONE * 2, '面板行花费按当前价')
    assert.equal(d.summary.warmCost, row.spend, '详情保温合计必须与面板行一致')
    assert.equal(c.total, row.spend, '周期统计合计必须与面板行一致')
    assert.equal(c.cycles.reduce((s, x) => s + x.cost, 0), row.spend, '各周期相加 == 合计')
    assert.equal(c.cycles.length, 2, '两个周期各一条')
    /** 预算口径不动：那是真实花过的钱。 */
    assert.equal(row.ledgerSpend, 0.0032, 'ledgerSpend 仍是存储值总和')
  } finally { tmpremove(home) }
})

test('改价后 timeline() 的 TTL 缓存不吐旧价（缓存键含价格指纹）', async () => {
  const home = setup('tl-price-cache')
  try {
    const svc = svcOf(home)
    const before = await svc.timeline(ID, 'step')
    assert.equal(before.summary.warmCost, EXPECT_ONE * 2, '改价前按旧价算')
    /** 价格翻倍后立刻再取：TTL 内若命中旧缓存就会拿到改价前的数。 */
    writeState(home, { hit: PRICES.hit * 2, miss: PRICES.miss * 2, out: PRICES.out * 2 })
    const after = await svc.timeline(ID, 'step')
    assert.equal(after.summary.warmCost, EXPECT_ONE * 4, '改价后必须重算，不能命中旧缓存')
  } finally { tmpremove(home) }
})

const stateFileOf = (home) => join(home, 'cache-keepalive', 'state.json')
const rowOf = (home) => (svcOf(home).snapshot().sessions ?? []).find((r) => r.id === ID)
const PRICES_X2 = { hit: PRICES.hit * 2, miss: PRICES.miss * 2, out: PRICES.out * 2 }

test('改价后「上次花费」（last.cost）按当前价重算', () => {
  const home = setup('tl-price-last')
  try {
    const before = rowOf(home)
    assert.ok(before.last !== undefined, '这条会话有账本，得有 last')
    assert.equal(before.last.cost, EXPECT_ONE, '改价前按当时价格算')
    writeState(home, PRICES_X2)
    const after = rowOf(home)
    assert.equal(after.last.cost, EXPECT_ONE * 2, '改价后「上次花费」必须跟着变')
    assert.notEqual(after.last.cost, 0.0016, '不能沿用账本快照')
  } finally { tmpremove(home) }
})

test('cycleSpendDisplay 跟着改价变，判定用的 cycleSpend 一动不动', () => {
  const home = setup('tl-price-cyclespend')
  try {
    const before = rowOf(home)
    assert.equal(before.cycleSpendDisplay, EXPECT_ONE, '展示口径 = 当前价逐笔重算')
    assert.equal(before.cycleSpend, 0.0016, '账本口径 = 存储快照（周期默认 1，只含第一条）')
    writeState(home, PRICES_X2)
    const after = rowOf(home)
    assert.equal(after.cycleSpendDisplay, EXPECT_ONE * 2, '展示口径随价格翻倍')
    assert.equal(after.cycleSpend, 0.0016, '判定口径不许被改价带偏')
  } finally { tmpremove(home) }
})

test('熔断 / 预算判定不因改价漂移（tripped、ledgerSpend、cycleSpendOf 三项恒等）', () => {
  const home = setup('tl-price-nodrift')
  try {
    const stBefore = loadState(stateFileOf(home))
    const spendBefore = cycleSpendOf(stBefore, ID)
    const before = rowOf(home)
    writeState(home, PRICES_X2)
    const after = rowOf(home)
    const spendAfter = cycleSpendOf(loadState(stateFileOf(home)), ID)
    assert.equal(spendAfter, spendBefore, 'cycleSpendOf 是预算/熔断入口，改价后必须一字不变')
    assert.equal(after.cycleSpend, before.cycleSpend, 'snapshot 的判定字段不许变')
    assert.equal(after.ledgerSpend, before.ledgerSpend, '真实花过的钱不许变')
    assert.equal(after.tripped, before.tripped, '熔断结果不许被改价翻掉')
    /** 反证：展示字段确实变了，否则上面几条恒等就是「什么都没算」的假绿。 */
    assert.notEqual(after.spend, before.spend, '展示花费必须变（证明改价真的生效了）')
  } finally { tmpremove(home) }
})

/** 从面板源码里抽一个顶格函数的完整文本（面板里顶层函数都顶格、体内一律缩进）。 */
function extractFn(name) {
  const lines = PANEL_HTML.split('\n')
  const start = lines.findIndex((l) => l.startsWith('function ' + name + '('))
  assert.ok(start >= 0, '面板源码里找不到函数：' + name)
  for (let i = start; i < lines.length; i++) {
    if (i > start && lines[i] === '}') return lines.slice(start, i + 1).join('\n')
  }
  assert.fail('函数未闭合：' + name)
}

test('详情浮层两个「本期」金额同口径（cycleWarmCost 与 cycleSpendDisplay 都是当前价）', async () => {
  const home = setup('tl-price-bubble')
  try {
    const svc = svcOf(home)
    const row = rowOf(home)
    const d = await svc.timelineUncached(ID, 'step')
    /** 周期默认 1 → 两处都只含第一条账本，金额必须相等（同价同 token）。 */
    assert.equal(row.cycleSpendDisplay, EXPECT_ONE, '浮层「本期 X 元」取展示字段')
    assert.equal(d.summary.cycleWarmCost, EXPECT_ONE, '浮层「本期 N 次 / 共 X 元」已是当前价')
    assert.equal(d.summary.cycleWarmCost, row.cycleSpendDisplay, '同一浮层两个本期金额必须同口径')

    /** 前端读取器：优先展示字段，老后端缺字段时回落账本值（不能显示 0）。 */
    const shown = new Function(extractFn('cycleSpendShown') + '\nreturn cycleSpendShown;')()
    assert.equal(shown({ cycleSpendDisplay: 0.75, cycleSpend: 1.6 }), 0.75, '有展示字段就用它')
    assert.equal(shown({ cycleSpend: 1.6 }), 1.6, '缺展示字段回落账本值')
    assert.equal(shown({}), 0, '两者都没有时给 0，不抛错')
  } finally { tmpremove(home) }
})

/* ── 唯一入口 spendAtCurrentPrices（三面同源）─────────────────────── */

/** 改动前 `buildRow` 里的内联 Σ，原样留一份作逐位比对基准。 */
const inlineSum = (entries, settings) => entries.reduce((s, e) => s + recomputeCost(e, settings).cost, 0)

test('spendAtCurrentPrices 与旧内联 Σ 逐位相等（回归安全）', () => {
  /** 时段表开着 + 多模型 + 一个 `model: undefined` + cacheWriteTokens：四种计价分支都走到。 */
  const settings = {
    ...DEFAULT_SETTINGS,
    prices: { ...PRICES },
    pricesByModel: {
      [MODEL]: { hit: 0.33, miss: 1.7, out: 9 },
      'prov/other-m': { hit: 1, miss: 2, out: 3 },
    },
    tariff: { ...DEFAULT_TARIFF, enabled: true },
  }
  const entries = [
    entry({ at: T - 30 * MIN }),
    { ...entry({ at: T - 20 * MIN }), model: 'other-m', hitTokens: 0, missTokens: 1234, outputTokens: 7 },
    { ...entry({ at: T - 10 * MIN }), model: undefined, cacheWriteTokens: 900 },
    entry({ at: T }),
  ]
  assert.equal(spendAtCurrentPrices(entries, settings).cost, inlineSum(entries, settings), '必须逐位相等')
  assert.equal(spendAtCurrentPrices([], settings).cost, 0, '空账本 → 0')
  assert.equal(
    spendAtCurrentPrices([entry({ at: T })], settings).cost,
    inlineSum([entry({ at: T })], settings),
    '单条也要一致（CLI「上次花费」用单元素数组）',
  )
})

test('改价后展示字段全变、判定字段全不变（含 spendOf / cycleSpendOf）', () => {
  const home = setup('tl-price-both-ways')
  try {
    const stateBefore = loadState(stateFileOf(home))
    const before = rowOf(home)
    writeState(home, PRICES_X2)
    const stateAfter = loadState(stateFileOf(home))
    const after = rowOf(home)
    /** 展示：三个位点都要跟着变。 */
    assert.equal(after.spend, before.spend * 2, 'buildRow.spend')
    assert.equal(after.cycleSpendDisplay, before.cycleSpendDisplay * 2, 'cycleSpendDisplay')
    assert.equal(after.last.cost, before.last.cost * 2, 'snapshot().last.cost')
    /** 判定：一个都不能动。 */
    assert.equal(after.cycleSpend, before.cycleSpend, 'cycleSpend（判定口径）')
    assert.equal(after.ledgerSpend, before.ledgerSpend, 'ledgerSpend')
    assert.equal(after.tripped, before.tripped, 'tripped')
    assert.equal(spendOf(stateAfter, ID), spendOf(stateBefore, ID), 'store.spendOf')
    assert.equal(cycleSpendOf(stateAfter, ID), cycleSpendOf(stateBefore, ID), 'store.cycleSpendOf')
  } finally { tmpremove(home) }
})

const SRC_FILES = ['src/index.ts', 'src/core/panel-service.ts', 'cli/keepalive.mjs']
const srcText = (rel) => readFileSync(fileURLToPath(new URL('../' + rel, import.meta.url)), 'utf8')

test('三面同源：展示求和只走 spendAtCurrentPrices，不许再手写 Σ', () => {
  for (const f of SRC_FILES) {
    const t = srcText(f)
    assert.ok(t.includes('spendAtCurrentPrices'), f + ' 必须走唯一入口')
    assert.ok(
      !/reduce\(\([A-Za-z, ]+\) => [A-Za-z]+ \+ recomputeCost\(/.test(t),
      f + ' 不许手写「逐笔 recomputeCost 求和」',
    )
    for (const line of t.split('\n')) {
      if (!line.includes('reduce(') || !/\be\.cost\b/.test(line)) continue
      /** 唯一允许累加存储值的地方：判定口径 `ledgerSpend`。 */
      assert.ok(line.includes('ledgerSpend'), f + ' 只有 ledgerSpend 可以累加账本快照：' + line.trim())
    }
  }
})

/* ── 价格指纹：两端共用同一份（插件宿主曾漏掉）──────────────────── */

const baseSettings = () => ({
  ...DEFAULT_SETTINGS,
  prices: { ...PRICES },
  pricesByModel: { [MODEL]: { ...PRICES } },
  tariff: { ...DEFAULT_TARIFF, enabled: true },
})

test('priceFingerprint 只跟「会改变金额」的三项走', () => {
  const base = baseSettings()
  const fp = priceFingerprint(base)
  assert.match(fp, /^[0-9a-f]{12}$/, '12 位十六进制')
  assert.equal(priceFingerprint({ ...base }), fp, '同一份设置 → 同一指纹（无随机性）')
  assert.notEqual(priceFingerprint({ ...base, prices: { ...PRICES, miss: 1.5 } }), fp, '基准价变 → 指纹变')
  assert.notEqual(
    priceFingerprint({ ...base, pricesByModel: { [MODEL]: { ...PRICES, out: 8 } } }), fp, '模型价表变 → 指纹变',
  )
  assert.notEqual(
    priceFingerprint({ ...base, tariff: { ...base.tariff, enabled: false } }), fp, '只改 tariff.enabled → 指纹变',
  )
  /** 与金额无关的设置不该进指纹：否则改个间隔就白丢一次时间轴缓存。 */
  assert.equal(priceFingerprint({ ...base, timelineCacheMinutes: 1 }), fp, 'TTL 变 → 指纹不变')
  assert.equal(priceFingerprint({ ...base, intervalSeconds: 60 }), fp, '间隔变 → 指纹不变')
  assert.equal(priceFingerprint({ ...base, maxTokens: 1234 }), fp, 'maxTokens 变 → 指纹不变')
})

test('两端时间轴缓存键都含价格指纹，且共用同一个函数（禁止各写一份）', () => {
  const idx = srcText('src/index.ts')
  const ps = srcText('src/core/panel-service.ts')
  /** ① 两处都调 priceFingerprint。 */
  assert.ok(idx.includes('priceFingerprint(state.settings)'), '插件侧时间轴缓存键必须带价格指纹')
  assert.ok(ps.includes('priceFingerprint(st.settings)'), '离线面板时间轴缓存键必须带价格指纹')
  /** ② 都从 econ 导入同一实现（而不是各自内联 sha256）。 */
  assert.ok(idx.includes('priceFingerprint') && idx.includes("from './econ.ts'"), '插件侧从 econ 取')
  assert.ok(ps.includes('priceFingerprint') && ps.includes("from '../econ.ts'"), '面板侧从 econ 取')
  assert.ok(!idx.includes("createHash('sha256')"), '插件侧不许再内联手写指纹')
  assert.ok(!ps.includes("createHash('sha256')"), '面板侧不许再内联手写指纹')
  /** ③ 键里必须真的拼上去：不许出现「算完没用」的假接线。 */
  for (const f of ['src/index.ts', 'src/core/panel-service.ts']) {
    const lines = srcText(f).split('\n')
    const at = lines.findIndex((l) => l.includes('granularityIn') && l.includes('led.length'))
    assert.ok(at >= 0, f + ' 找不到时间轴缓存键')
    const joined = [lines[at], lines[at + 1] ?? ''].join(' ')
    assert.ok(
      joined.includes('priceFp') || joined.includes('priceFingerprint('),
      f + ' 缓存键必须拼上价格指纹：' + lines[at].trim(),
    )
  }
})
