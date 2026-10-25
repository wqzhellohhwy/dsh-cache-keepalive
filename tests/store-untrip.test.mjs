import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmproot, tmpremove } from './_tmp.js'
import {
  DEFAULT_SETTINGS, cycleOf, cycleSpendOf, isTripped, ledgerOf, loadState, saveState, spendOf, tripVerdict,
  untripSession,
} from '../src/store.ts'
import { buildGateInput } from '../src/core/gate-input.ts'
import { decideWarm } from '../src/gate.ts'

/**
 * 解熔语义（契约 §A，v5）。
 *
 * 用户口径：「解熔删掉了保温记录和花费」是 bug。解熔应当 = 给熔断前那条低命中打一个「解熔」标记
 * （视同 100%），**记录与花费全部保留**；新保温落账后标记自动失效。
 *
 * ⚠️ v5 修订过的 A2 构造：`lastTouch=4h30m 前 / lastDialog=8h 前`。
 * 因为门禁的 `since = max(lastTouchAt, lastActivityAt)`：
 *  - touch 3h → since=3h < 4h 间隔 → `too-soon`（与解熔无关，测不出任何东西）；
 *  - touch 4.5h → since=4.5h 过间隔、< 8h 闲置上限 → 解熔前 `tripped` 是**唯一**变量。
 */

const TH = DEFAULT_SETTINGS.circuitHitRate
const HOUR = 3600_000
const MIN = 60_000

const entry = (o) => ({
  gapSeconds: 0,
  promptTokens: 1000,
  hitTokens: Math.round((o.hitRate ?? 1) * 1000),
  missTokens: 0,
  outputTokens: 1,
  cost: 0.01,
  hitRate: 1,
  ms: 100,
  touch: 1,
  cycle: 1,
  ...o,
})

function stateOf(led, settings = {}) {
  return { version: 1, settings: { ...DEFAULT_SETTINGS, ...settings }, sessions: {}, ledger: { s: led }, untripped: {} }
}

/** 一条低命中（会触发熔断）的历史账本。 */
const low = (at, o = {}) => entry({ at, hitRate: 0.0035, ...o })

test('A1 解熔后历史仍在：3 条账本、花费、「最后保温」全部保留', () => {
  const now = 100 * HOUR
  const led = [entry({ at: now - 3 * HOUR, hitRate: 0.999 }), entry({ at: now - 2 * HOUR, hitRate: 0.998 }), low(now - HOUR)]
  const st = stateOf(led)
  const spendBefore = spendOf(st, 's')
  const lastAtBefore = ledgerOf(st, 's').at(-1).at
  const cycleBefore = cycleOf(st, 's')

  untripSession(st, 's', now)

  assert.equal(ledgerOf(st, 's').length, 3, '解熔不能删记录')
  assert.equal(spendOf(st, 's'), spendBefore, '历史花费必须原样保留')
  assert.equal(ledgerOf(st, 's').at(-1).at, lastAtBefore, '「最后保温」不能变')
  assert.equal(cycleOf(st, 's'), cycleBefore, '解熔不动周期号（那是「清除计费」的事）')
  assert.equal(st.touchBase, undefined, '解熔不动 touchBase')
})

test('A1b 解熔标记要写进 state.json，重新 loadState 还在', () => {
  const dir = tmproot('untrip')
  try {
    const file = join(dir, 'state.json')
    const now = 100 * HOUR
    const st = stateOf([entry({ at: now - 3 * HOUR }), low(now - HOUR)])
    untripSession(st, 's', now)
    saveState(st, file)

    const back = loadState(file)
    assert.equal(back.untripped?.s, now, '解熔时刻必须落盘')
    assert.equal(ledgerOf(back, 's').length, 2, '账本也要原样落盘')
    assert.equal(tripVerdict(back, 's', TH), 'ok', '重新读盘后标记仍然生效')
  } finally {
    tmpremove(dir)
  }
})

test('A2 解熔绕过 tripped：touch 4h30m / dialog 8h，解熔前 tripped、解熔后 warm', () => {
  const now = 1000 * HOUR
  const at = now - 4.5 * HOUR
  const st = stateOf([low(at)])
  const gate = () => decideWarm(buildGateInput(st, {
    id: 's',
    mtime: now,
    hasRoute: true,
    tripped: isTripped(st, 's', TH, now - 8 * HOUR, now),
    /* 对话发生在 8 小时前（< 闲置上限 8h 的边界内），保温发生在 4.5 小时前。 */
    lastActivityAt: now - 8 * HOUR + MIN,
    at: now,
  }))

  assert.equal(isTripped(st, 's', TH, now - 8 * HOUR, now), true, '解熔前必须熔断')
  assert.equal(gate().ok, false)
  assert.equal(gate().code, 'tripped', '解熔前门禁应判 tripped')

  untripSession(st, 's', now)

  assert.equal(isTripped(st, 's', TH, now - 8 * HOUR, now), false, '解熔后不得再熔断')
  assert.deepEqual(gate(), { ok: true, reason: 'warm' }, '解熔后必须放行到 warm')
})

test('A2b 解熔只绕 tripped：预算 / 次数 / 闲置门槛一律照拦', () => {
  const now = 1000 * HOUR
  /** 解熔后的 state；`touch` 可按用例指定（默认 1，免得顺手踩到次数上限把结论掩盖掉）。 */
  const unTripped = (o = {}, settings = {}) => {
    const st = stateOf([low(now - 4.5 * HOUR, o)], settings)
    untripSession(st, 's', now)
    return st
  }
  const gateOf = (st, extra = {}) => decideWarm(buildGateInput(st, {
    id: 's', mtime: now, hasRoute: true, tripped: isTripped(st, 's', TH, 0, now),
    lastActivityAt: now - 8 * HOUR + MIN, at: now, ...extra,
  }))

  /** 预算走 settings（`buildGateInput` 用的是 `settings.budgetPerSession`，不是入参）。 */
  assert.equal(gateOf(unTripped({}, { budgetPerSession: 0 })).code, 'budget', '解熔不豁免预算')

  /** 次数：touch=9 已到默认上限 9 → 必须照拦。 */
  assert.equal(gateOf(unTripped({ touch: 9 })).code, 'max-touches', '解熔不豁免次数上限')

  /**
   * 对话已凉（> 8h 闲置上限）：解熔后**仍然保不了**。
   * 构造要让 `since = max(lastTouch, lastDialog)` 落在 (闲置上限, +∞)：
   * 保过 9.5h 前、对话 9h 前 → since=9h > 8h 上限 → `stale`。
   * （把对话拉到 9h 的同时 touch 也得跟着往后，否则 `now-since` 只有 4.5h → 先吃 `too-soon`。）
   */
  const coldSt = stateOf([low(now - 9.5 * HOUR)])
  untripSession(coldSt, 's', now)
  const cold = decideWarm(buildGateInput(coldSt, {
    id: 's', mtime: now, hasRoute: true, tripped: isTripped(coldSt, 's', TH, 0, now), lastActivityAt: now - 9 * HOUR, at: now,
  }))
  assert.equal(cold.code, 'stale', '解熔不豁免闲置门槛（4b01 那种会话解熔后仍保不了，已记 backlog）')

  assert.equal(gateOf(unTripped(), { archived: true }).code, 'archived', '解熔不豁免归档')
})

test('A3 解熔不动周期：花费口径不变，新周期只由 clearCost 开', () => {
  const now = 100 * HOUR
  const st = stateOf([entry({ at: now - 3 * HOUR, cost: 0.02, cycle: 1 }), low(now - HOUR, { cost: 0.5 })])
  untripSession(st, 's', now)
  assert.equal(cycleOf(st, 's'), 1, '解熔不换周期')
  assert.equal(cycleSpendOf(st, 's'), 0.52, '本周期花费应含解熔前那笔')
  assert.equal(spendOf(st, 's'), 0.52, '总花费不变')
})

test('A4 解熔后别人写新条目：新条目保留，且末条 at 更大 → 标记自然失效', () => {
  const dir = tmproot('untrip')
  try {
    const file = join(dir, 'state.json')
    const now = 100 * HOUR
    /** A 进程：磁盘上已有解熔标记。 */
    const a = stateOf([low(now - HOUR)])
    untripSession(a, 's', now)
    saveState(a, file)

    /** B 写者：磁盘上追加一条更晚的低命中（新的熔断证据）。 */
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    disk.ledger.s.push(low(now + HOUR))
    writeFileSync(file, JSON.stringify(disk), 'utf8')

    /** A 进程内存里还是旧的两条 → 再写一次盘，新条目必须被并进来。 */
    const mine = loadState(file)
    mine.ledger.s = [low(now - HOUR)]
    saveState(mine, file)

    const after = loadState(file)
    assert.equal(ledgerOf(after, 's').length, 2, '别人新增的条目不能被抹掉')
    assert.equal(after.untripped?.s, now, '解熔标记本身仍在')
    assert.equal(tripVerdict(after, 's', TH), 'tripped',
      '末条 at 已 > 解熔时刻 → 标记自然失效，新的低命中照常熔断')
  } finally {
    tmpremove(dir)
  }
})

test('A5 解熔后新保温到来，标记失效，恢复正常判定', () => {
  const now = 100 * HOUR
  const st = stateOf([low(now - HOUR)])
  untripSession(st, 's', now)
  assert.equal(tripVerdict(st, 's', TH), 'ok', '解熔后先放行')

  /** 新保温命中率高 → 正常 ok。 */
  st.ledger.s.push(entry({ at: now + MIN, hitRate: 0.999 }))
  assert.equal(tripVerdict(st, 's', TH), 'ok')

  /** 新保温又低命中 → 标记已失效（末条 at > 解熔时刻），必须重新熔断。 */
  st.ledger.s.push(low(now + 2 * MIN))
  assert.equal(tripVerdict(st, 's', TH), 'tripped', '解熔只放行一次，新证据来了照熔断')
})

test('A6 解熔标记脏值不影响判定：非数字 / 0 一律当没有', () => {
  const now = 100 * HOUR
  const st = stateOf([low(now - HOUR)])
  for (const bad of ['abc', null, 0, -1, NaN]) {
    st.untripped = { s: bad }
    assert.equal(tripVerdict(st, 's', TH), 'tripped', '脏值 ' + JSON.stringify(bad) + ' 不能当解熔标记')
  }
})
