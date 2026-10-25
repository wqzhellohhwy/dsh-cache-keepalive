/**
 * **同一条会话同一时间只能有一次保温在飞**（跨进程互斥）。
 *
 * 复现的真实故障（`state.json` 的 ledger）：
 * ```
 * 40b9: 23:09:13 via=panel hit=84.5%  ms=25118
 *       23:09:15 via=cli   hit=100%   ms=29569   ← 2 秒后又一条，且两条请求大量重叠
 * 43e7: 23:15:00 via=panel
 *       23:15:51 via=cli                        ← 51 秒后又一条
 * ```
 *
 * 机制：手动点击（`warmViaPanel` → `via=panel`）与守护循环（`cmdOnce` → `via=cli`）
 * 是两条独立路径，各自 `loadState()` → 判门禁 → 发请求，竞态窗口内都放行。
 *
 * 修法：发请求前抢 state.json 里的 `inflight[id]`，记账后释放，超 60 秒过期自愈。
 *
 * 跑法：`node --test tests/warm-inflight.test.mjs`
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tmproot } from './_tmp.js'
import {
  DEFAULT_SETTINGS,
  INFLIGHT_TTL_MS,
  loadState,
  releaseInflight,
  saveState,
  sweepInflight,
  tryClaimInflight,
} from '../src/store.ts'

/** 造一份最小 state.json 并返回它的路径。 */
function freshState(dir) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'state.json')
  writeFileSync(file, JSON.stringify({ version: 1, settings: DEFAULT_SETTINGS, sessions: {}, ledger: {} }), 'utf8')
  return file
}

// ── 互斥语义 ────────────────────────────────────────────────
test('I1：同一会话第二次抢标记失败（这就是「保两次」被挡下的那一下）', () => {
  const s = { version: 1, settings: DEFAULT_SETTINGS, sessions: {}, ledger: {}, inflight: {} }
  assert.equal(tryClaimInflight(s, 'sess-A', 'panel'), true, '第一个入口抢到')
  assert.equal(tryClaimInflight(s, 'sess-A', 'cli'), false, '第二个入口（另一进程/另一路径）抢不到')
  assert.equal(s.inflight['sess-A'].by, 'panel', '标记记着是谁在保')
})

test('I2：不同会话互不阻塞', () => {
  const s = { version: 1, settings: DEFAULT_SETTINGS, sessions: {}, ledger: {}, inflight: {} }
  assert.equal(tryClaimInflight(s, 'sess-A', 'panel'), true)
  assert.equal(tryClaimInflight(s, 'sess-B', 'cli'), true, 'B 不受 A 影响')
})

test('I3：释放后可以再抢（记账完成 → 下一轮正常）', () => {
  const s = { version: 1, settings: DEFAULT_SETTINGS, sessions: {}, ledger: {}, inflight: {} }
  assert.equal(tryClaimInflight(s, 'sess-A', 'cli'), true)
  releaseInflight(s, 'sess-A')
  assert.equal(s.inflight['sess-A'], undefined, '标记已删除')
  assert.equal(tryClaimInflight(s, 'sess-A', 'cli'), true, '释放后能再抢')
})

test('I4：超过 60 秒视为过期（进程崩溃残留自愈）', () => {
  const s = { version: 1, settings: DEFAULT_SETTINGS, sessions: {}, ledger: {}, inflight: {} }
  const t0 = 1_000_000
  assert.equal(tryClaimInflight(s, 'sess-A', 'cli', t0), true)
  assert.equal(tryClaimInflight(s, 'sess-A', 'panel', t0 + INFLIGHT_TTL_MS - 1), false, '未到期限仍挡')
  assert.equal(tryClaimInflight(s, 'sess-A', 'panel', t0 + INFLIGHT_TTL_MS), true, '到期限放行（崩溃自愈）')
})

test('I5：sweepInflight 清掉过期项、保留未过期项', () => {
  const s = {
    version: 1,
    settings: DEFAULT_SETTINGS,
    sessions: {},
    ledger: {},
    inflight: { old: { at: 1000, by: 'cli' }, fresh: { at: 1000 + INFLIGHT_TTL_MS, by: 'panel' } },
  }
  const now = 1000 + INFLIGHT_TTL_MS + 1
  assert.equal(sweepInflight(s, now), 1, '只清掉一条')
  assert.equal(s.inflight.old, undefined)
  assert.ok(s.inflight.fresh !== undefined, '未过期的保留')
})

// ── 持久化：跨进程的关键 ─────────────────────────────────────
test('I6：抢到的标记会落盘，另一个进程 loadState 能看见', () => {
  const dir = tmproot('inflight')
  const file = freshState(dir)
  const a = loadState(file)
  assert.equal(tryClaimInflight(a, 'sess-A', 'panel'), true)
  saveState(a, file)

  const b = loadState(file)
  assert.ok(b.inflight['sess-A'] !== undefined, '另一个进程读到了标记')
  assert.equal(tryClaimInflight(b, 'sess-A', 'cli'), false, '它就抢不到了')
})

test('I7：loadState 丢弃过期标记（崩溃后重启不堵）', () => {
  const dir = tmproot('inflight')
  const file = freshState(dir)
  writeFileSync(file, JSON.stringify({
    version: 1,
    settings: DEFAULT_SETTINGS,
    sessions: {},
    ledger: {},
    inflight: {
      dead: { at: Date.now() - INFLIGHT_TTL_MS - 5000, by: 'cli' },
      alive: { at: Date.now(), by: 'panel' },
    },
  }), 'utf8')
  const s = loadState(file)
  assert.equal(s.inflight.dead, undefined, '过期标记被丢弃')
  assert.ok(s.inflight.alive !== undefined, '未过期的保留')
})

test('I8：脏数据不破 —— 结构不全的标记直接丢', () => {
  const dir = tmproot('inflight')
  const file = freshState(dir)
  writeFileSync(file, JSON.stringify({
    version: 1,
    settings: DEFAULT_SETTINGS,
    sessions: {},
    ledger: {},
    inflight: {
      noAt: { by: 'cli' },
      noBy: { at: Date.now() },
      nan: { at: 'x', by: 'cli' },
      ok: { at: Date.now(), by: 'panel' },
    },
  }), 'utf8')
  const s = loadState(file)
  assert.deepEqual(Object.keys(s.inflight), ['ok'], '只留下结构完整的那条')
})

test('I9：另一个进程写的标记不会被本进程整份覆盖抹掉', () => {
  const dir = tmproot('inflight')
  const file = freshState(dir)
  /**
   * 直接往磁盘上写一条「别人的」标记（模拟另一个进程，不经本进程的 HOLDING）。
   * 用 `now` 而不是极早时刻 —— 否则会被 `loadState` 的过期过滤丢掉，测不到合并逻辑。
   */
  writeFileSync(file, JSON.stringify({
    version: 1,
    settings: DEFAULT_SETTINGS,
    sessions: {},
    ledger: {},
    inflight: { 'sess-A': { at: Date.now(), by: 'cli' } },
  }), 'utf8')

  /** 本进程拿着「不知道 A」的快照去写盘。 */
  const b = loadState(file)
  b.inflight = {}
  saveState(b, file)

  const after = loadState(file)
  assert.ok(after.inflight['sess-A'] !== undefined, '别人写的标记不能被整份覆盖抹掉')
  assert.equal(after.inflight['sess-A'].by, 'cli')
})

// ── 并发复现：修前两条、修后一条 ──────────────────────────────
test('I10：两个入口并发 → 修前两条记录，修后只有一条', async () => {
  const dir = tmproot('inflight')
  const file = freshState(dir)

  /**
   * 模拟一次保温：`claim` 为 false 时不记账（= 修前行为）；
   * 为 true 时走「抢标记 → 干活 → 记账 → 释放」（= 修后行为）。
   */
  const warmOnce = async (by, useInflight) => {
    const s = loadState(file)
    if (useInflight) {
      if (!tryClaimInflight(s, 'sess-X', by)) return { recorded: false, why: '已有保温在飞' }
      saveState(s, file)
    }
    /** 模拟真实的网络往返：让两个入口真的重叠。 */
    await new Promise((r) => setTimeout(r, 40))
    const s2 = loadState(file)
    s2.ledger['sess-X'] = [...(s2.ledger['sess-X'] ?? []), { at: Date.now(), touch: 1, via: by }]
    if (useInflight) releaseInflight(s2, 'sess-X')
    saveState(s2, file)
    return { recorded: true }
  }

  /** ① 修前（不加 inflight）：两个入口都记账。 */
  const before = await Promise.all([warmOnce('panel', false), warmOnce('cli', false)])
  const beforeCount = loadState(file).ledger['sess-X'].length
  assert.equal(before.filter((r) => r.recorded).length, 2, '修前：两个入口都放了')
  assert.equal(beforeCount, 2, '修前：账本两条 —— 这就是用户看到的「保了两次」')

  /** ② 修后（加 inflight）：只许一条。 */
  writeFileSync(file, JSON.stringify({ version: 1, settings: DEFAULT_SETTINGS, sessions: {}, ledger: {} }), 'utf8')
  const after = await Promise.all([warmOnce('panel', true), warmOnce('cli', true)])
  const afterCount = loadState(file).ledger['sess-X'].length
  assert.equal(after.filter((r) => r.recorded).length, 1, '修后：只有一条被记账')
  assert.equal(afterCount, 1, '修后：账本只有一条')
  assert.equal(after.find((r) => !r.recorded)?.why, '已有保温在飞', '另一条报「已有保温在飞」')

  /** ③ 释放干净了：下一轮两个入口又能正常（不是被永久堵死）。 */
  const again = await warmOnce('panel', true)
  assert.equal(again.recorded, true, '释放后下一轮正常')
  assert.equal(loadState(file).ledger['sess-X'].length, 2)
})

test('I11：非并发场景零变化 —— 单入口保一次记一条', async () => {
  const dir = tmproot('inflight')
  const file = freshState(dir)
  const s = loadState(file)
  assert.equal(tryClaimInflight(s, 'sess-Y', 'cli'), true)
  saveState(s, file)
  const s2 = loadState(file)
  s2.ledger['sess-Y'] = [{ at: Date.now(), touch: 1, via: 'cli' }]
  releaseInflight(s2, 'sess-Y')
  saveState(s2, file)
  const fin = loadState(file)
  assert.equal(fin.ledger['sess-Y'].length, 1, '只有一条')
  assert.equal(fin.inflight['sess-Y'], undefined, '标记已清')
})

test('I12：state.json 里真的写了 inflight 字段（不是只在内存）', () => {
  const dir = tmproot('inflight')
  const file = freshState(dir)
  const s = loadState(file)
  tryClaimInflight(s, 'sess-Z', 'panel')
  saveState(s, file)
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(raw.inflight !== undefined, '磁盘上有 inflight 键')
  assert.equal(raw.inflight['sess-Z'].by, 'panel')
})

test('I13：**被门禁拒绝时绝不写盘**（抢占必须发生在门禁之后）', () => {
  /**
   * `check-guard` 的契约：「被拒后 state.json 未被改写」。
   * 早年把抢占放在 `/ping` 入口 → 被拒也 `saveState()` 一次 → mtime 变 → check-guard 红。
   * 这条守着那个回归：门禁拒绝的路径上不许调用 `tryClaimInflight`（它本身不改文件，
   * 但调用方会跟着写盘，所以判据是「源码里抢占在 spendGuard 之后」）。
   */
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  for (const fn of ['async function ping(', 'async function pingOffline(']) {
    const at = src.indexOf(fn)
    assert.ok(at > 0, `找不到 ${fn}`)
    const end = src.indexOf('\n  }', at)
    const body = src.slice(at, end < 0 ? at + 4000 : end)
    const guardAt = body.indexOf('spendGuard(')
    const claimAt = body.indexOf('claimPingInflight(')
    assert.ok(guardAt >= 0, `${fn} 里应有 spendGuard`)
    assert.ok(claimAt >= 0, `${fn} 里应有 claimPingInflight（否则跨进程互斥失效）`)
    assert.ok(
      claimAt > guardAt,
      `${fn}：抢占（偏移 ${claimAt}）必须在门禁（偏移 ${guardAt}）之后，否则被拒也会写 state.json`,
    )
  }
})
