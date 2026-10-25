/**
 * 预算判定必须按**当前价格**算（用户报障：「子代理莫名显示『超预算』」）。
 *
 * 根因：展示早就改成「逐笔按当前价重算」，但判定一直读账本快照 `entry.cost`。
 * 真机 `verify-a`：51 条账本存储 Σ 24.14 元（当年把模型价调高时记下的），
 * 按现价只有 0.099 元 —— 面板显示 0.099 元，门禁却说已达 20 元上限。
 *
 * 现在判定统一走 `cycleSpendAtCurrentPrices()`（与 `cycleSpendOf` 同批条目，只把「读快照」换成「重算」）。
 * 双向语义：价格调高时历史折算变高 → 可能新熔；调低 → 可能解熔。两者都是预期。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { buildGateInput } from '../src/core/gate-input.ts'
import { decideWarm } from '../src/gate.ts'
import { createPanelService } from '../src/core/panel-service.ts'
import {
  DEFAULT_SETTINGS, cycleSpendAtCurrentPrices, cycleSpendOf, ledgerOf,
} from '../src/store.ts'
import { tmproot, tmpremove } from './_tmp.js'

const NOW = 1_800_000_000_000
const HOUR = 3600_000
const MIN = 60_000
const MODEL = 'm-budget'
const srcText = (rel) => readFileSync(fileURLToPath(new URL('../' + rel, import.meta.url)), 'utf8')
/** 当年被调高的价：命中 1000 元/百万 —— 51 条 × 1000 命中 token ≈ 51 元级。 */
const HIGH = { hit: 900, miss: 900, out: 900 }
/** 调回来以后的现价。 */
const LOW = { hit: 0.02, miss: 1, out: 4 }

/** 一条账本：存储金额是**高价位**记下的，token 很小。 */
function entry(at, storedCost) {
  return {
    at, gapSeconds: 3600, promptTokens: 1000, hitTokens: 1000, missTokens: 0, outputTokens: 0,
    cost: storedCost, hitRate: 1, ms: 2000, touch: 1, model: MODEL, cycle: 1,
  }
}

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
      tariff: { ...DEFAULT_SETTINGS.tariff, enabled: false },
    },
    sessions: {},
    ledger: { s: o.entries ?? [] },
    ...(o.extra || {}),
  }
}

/** 51 条，每条存储 24.14/51 ≈ 0.4733 元（真机 verify-a 的形态）。 */
const bigBook = () => Array.from({ length: 51 }, (_, i) => entry(NOW - (51 - i) * MIN, 24.14 / 51))

const gateOf = (st, extra) => decideWarm(buildGateInput(st, {
  id: 's',
  mtime: NOW - 2 * HOUR,
  hasRoute: true,
  tripped: false,
  lastActivityAt: NOW - 2 * HOUR,
  at: NOW,
  ...(extra || {}),
}))

test('高价位历史账 + 现价低 → 不超预算（真机 verify-a 形态）', () => {
  const st = mkState({ entries: bigBook() })
  const stored = cycleSpendOf(st, 's')
  const now = cycleSpendAtCurrentPrices(st, st.settings, 's')
  assert.ok(Math.abs(stored - 24.14) < 0.01, '账本快照仍是 24.14 元级')
  assert.ok(now < 0.01, '按现价只有几分钱，实际 ' + now)
  const g = gateOf(st)
  assert.notEqual(g.code, 'budget', '不许再说「超预算」（显示 0.099 元却说已达 20 元上限 = 自相矛盾）')
  assert.equal(buildGateInput(st, { id: 's', mtime: NOW, hasRoute: true, tripped: false, at: NOW }).cumulativeCost, now,
    '门禁拿到的预算数字必须与展示口径同源')
})

test('现价本身确实超 20 元 → 仍判 budget（熔断没被废掉）', () => {
  /** 同样的 token，但把现价调到 1000 元/百万：51 条 × 1000 token × 1000/1e6 = 51 元。 */
  const st = mkState({ entries: bigBook(), modelPrices: HIGH })
  assert.ok(cycleSpendAtCurrentPrices(st, st.settings, 's') > 20, '现价下确实超预算')
  assert.equal(gateOf(st).code, 'budget', '该熔还是得熔')
})

test('只算本周期 + 结果下限 0（清账基线不会算出负数）', () => {
  const st = mkState({ entries: [entry(NOW - MIN, 0.5), entry(NOW - 2 * MIN, 0.5)] })
  st.cycles = { s: 2 }
  /** 两条都在 cycle=1，当前周期 2 → 一条都不计入。 */
  assert.equal(cycleSpendOf(st, 's'), 0, '账本口径同样不计旧周期')
  assert.equal(cycleSpendAtCurrentPrices(st, st.settings, 's'), 0, '现价口径也不计旧周期')
  /** 在途花费若被写成负数，也不该把预算算成「已花 −100 元」。 */
  const neg = mkState({ entries: [] })
  neg.labPending = [{ id: 'x', sessionId: 's', worst: -100, at: NOW, status: 'unknown' }]
  assert.equal(cycleSpendAtCurrentPrices(neg, neg.settings, 's'), 0, '下限 0，不许负')
  assert.ok(cycleSpendOf(neg, 's') < 0, '对照：旧函数会给出负数（所以新函数才要夹 0）')
})

test('账本条目与 cycleSpendOf 同批：条数口径一致', () => {
  const st = mkState({ entries: [...bigBook(), { ...entry(NOW - MIN, 1), cycle: 2 }] })
  st.cycles = { s: 2 }
  /** 当前周期 2 只有最后那条 → 两个函数取同一批（都只有 1 条）。 */
  assert.equal(ledgerOf(st, 's').filter((e) => (e.cycle ?? 1) === 2).length, 1)
  assert.ok(cycleSpendOf(st, 's') > 0)
  assert.ok(cycleSpendAtCurrentPrices(st, st.settings, 's') > 0)
})

test('三面同源：预算一律走 cycleSpendAtCurrentPrices，不许各自读账本快照', () => {
  const files = ['src/core/gate-input.ts', 'src/index.ts', 'cli/keepalive.mjs']
  for (const f of files) {
    const t = srcText(f)
    for (const line of t.split('\n')) {
      const trimmed = line.trim()
      /** 注释里提到旧函数名是正常的（那是历史说明），只看可执行代码。 */
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
      if (!/cycleSpendOf\(/.test(line)) continue
      /** 唯一允许：展示字段 `cycleSpend:`（账本口径保留给外部消费者）。 */
      assert.ok(
        /cycleSpend:\s*cycleSpendOf\(/.test(line),
        f + ' 判定里不许再用账本快照，只有展示字段 cycleSpend 可以：' + trimmed,
      )
    }
  }
  assert.ok(srcText('src/core/gate-input.ts').includes('cumulativeCost: cycleSpendAtCurrentPrices('),
    '门禁预算必须走现价入口（三面共用 buildGateInput，改这一处即全通）')
})

/* ── 行为：离线面板三面同源（走 buildGateInput，判定与展示同口径）────── */

const PID = 'session-budget-1'

test('离线面板：高价位历史账 → 门禁不再判 budget，且展示与判定同口径', () => {
  const home = tmproot('budget-panel')
  try {
    const now = Date.now()
    const dir = join(home, 'sessions', 'proj-a', PID)
    mkdirSync(dir, { recursive: true })
    const text = [
      { type: 'session', seq: 0, time: now - 5 * MIN, id: PID, cwd: 'C:\\tmp', createdAt: now - 5 * MIN },
      { type: 'user/message', seq: 1, time: now - MIN },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n'
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(text, 'utf8')))
    const stDir = join(home, 'cache-keepalive')
    mkdirSync(stDir, { recursive: true })
    writeFileSync(join(stDir, 'state.json'), JSON.stringify({
      version: 1,
      settings: {
        ...DEFAULT_SETTINGS,
        budgetPerSession: 20,
        prices: { ...LOW },
        pricesByModel: { [MODEL]: { ...LOW } },
        tariff: { ...DEFAULT_SETTINGS.tariff, enabled: false },
      },
      sessions: {},
      ledger: { [PID]: bigBook() },
    }), 'utf8')
    writeFileSync(join(stDir, 'sessions.meta.json'), JSON.stringify({
      at: now, version: 1, sig: 'x',
      items: {
        [PID]: {
          mtime: now - MIN, title: '预算', titleSource: 'user', archived: false, origin: '',
          projectKey: 'proj-a', dirName: PID, sizeBytes: 1, lastDialogAt: now - MIN,
        },
      },
    }), 'utf8')

    const row = createPanelService({ dshHome: home, warm: async () => ({ ok: true }), now: () => now })
      .snapshot().sessions.find((r) => r.id === PID)
    assert.ok(row !== undefined, '面板里要有这条会话')
    assert.ok(row.cycleSpend > 20, '账本口径确实超 20（旧行为会判 budget）')
    assert.ok(row.cycleSpendDisplay < 0.01, '展示口径只有几分钱')
    assert.notEqual(row.gateCode, 'budget', '面板门禁也不许再判超预算')
  } finally { tmpremove(home) }
})
