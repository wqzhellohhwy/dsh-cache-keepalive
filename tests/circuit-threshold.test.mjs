import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, loadState, statePath } from '../src/store.ts'
import { applySettingsPatch } from '../src/core/settings.ts'

/**
 * 熔断阈值 `circuitHitRate` 的边界。
 *
 * 为什么必须测：`Number(true)` = 1、`Number(null)` = 0 —— 用 `Number()` 强转会把脏值
 * 「强转成合法值」（实测 `true` → 0.9 最严 → 正常波动被判熔断停保；`null` → 0.05 最松 → 持续烧钱）。
 * 所以口径必须是：**非数字回落默认 0.5**、**数字但越界落到边界**（负数/0 → 0.05，>0.95 → 0.95）。
 */
const DIR = join(process.cwd(), '.tmp', 't-circthr')
mkdirSync(DIR, { recursive: true })
const FILE = join(DIR, 'state.json')
const fresh = (settings) => {
  writeFileSync(FILE, JSON.stringify({
    version: 1, settings, sessions: {}, ledger: {}, touchBase: {}, cycles: {}, pinnedSessions: [], labPending: [],
  }), 'utf8')
  return loadState(FILE)
}

test('normalizeSettings：非数字脏值一律回落默认 0.5（不被 Number() 强转）', () => {
  for (const bad of [true, false, null, [], {}, 'abc', '0.9', NaN]) {
    const st = fresh({ circuitHitRate: bad })
    assert.equal(st.settings.circuitHitRate, DEFAULT_SETTINGS.circuitHitRate,
      '脏值 ' + JSON.stringify(bad) + ' 必须回落 0.5，实际 ' + st.settings.circuitHitRate)
  }
})

test('normalizeSettings：数字越界落到边界（负数/0 → 0.05，>0.9 → 0.9）', () => {
  assert.equal(fresh({ circuitHitRate: -1 }).settings.circuitHitRate, 0.05, '-1 应落到下界 0.05')
  assert.equal(fresh({ circuitHitRate: 0 }).settings.circuitHitRate, 0.05, '0 应落到下界 0.05')
  assert.equal(fresh({ circuitHitRate: 0.001 }).settings.circuitHitRate, 0.05, '0.001 应落到下界 0.05')
  assert.equal(fresh({ circuitHitRate: 5 }).settings.circuitHitRate, 0.95, '5 应落到上界 0.95')
  assert.equal(fresh({ circuitHitRate: 0.9 }).settings.circuitHitRate, 0.9, '0.9 边界保留')
  assert.equal(fresh({ circuitHitRate: 0.05 }).settings.circuitHitRate, 0.05, '0.05 边界保留')
  assert.equal(fresh({ circuitHitRate: 0.7 }).settings.circuitHitRate, 0.7, '中间值原样保留')
})

test('老 state 没有这个键 → 默认 0.5', () => {
  assert.equal(fresh({}).settings.circuitHitRate, DEFAULT_SETTINGS.circuitHitRate)
})

test('applySettingsPatch：非数字整批拒绝（不写任何字段）', () => {
  for (const bad of [true, false, null, [], 'abc']) {
    const st = fresh({ circuitHitRate: 0.5, autoCount: 2 })
    const r = applySettingsPatch(st, { circuitHitRate: bad, autoCount: 5 })
    assert.ok(r.error !== undefined, '脏值 ' + JSON.stringify(bad) + ' 必须被拒')
    assert.equal(st.settings.autoCount, 2, '整批拒绝：同批的 autoCount 也不能写')
    assert.equal(st.settings.circuitHitRate, 0.5, '整批拒绝：阈值保持原值')
  }
})

test('applySettingsPatch：数字越界落到边界（负数/0 → 0.05）', () => {
  for (const [given, want] of [[-1, 0.05], [0, 0.05], [5, 0.95], [0.3, 0.3]]) {
    const st = fresh({ circuitHitRate: 0.5 })
    const r = applySettingsPatch(st, { circuitHitRate: given })
    assert.equal(r.error, undefined, '数字 ' + given + ' 不该被拒')
    assert.equal(st.settings.circuitHitRate, want, '传 ' + given + ' 应得 ' + want)
  }
})

test('阈值抬高 → 冷却自动置 600 并给 notice；降阈值不动冷却', () => {
  const up = fresh({ circuitHitRate: 0.5, circuitCooldownSeconds: 0 })
  const r1 = applySettingsPatch(up, { circuitHitRate: 0.7 })
  assert.equal(up.settings.circuitCooldownSeconds, 600, '0.5→0.7 应自动置 600')
  assert.ok(r1.notice !== undefined && r1.notice.includes('600'), '必须给 notice：' + r1.notice)

  const down = fresh({ circuitHitRate: 0.5, circuitCooldownSeconds: 0 })
  applySettingsPatch(down, { circuitHitRate: 0.3 })
  assert.equal(down.settings.circuitCooldownSeconds, 0, '降阈值不该动冷却')

  const explicit = fresh({ circuitHitRate: 0.5, circuitCooldownSeconds: 60 })
  applySettingsPatch(explicit, { circuitHitRate: 0.7 })
  assert.equal(explicit.settings.circuitCooldownSeconds, 60, '用户显式设的冷却值不能被覆盖')
})

test('两个死设置：老 state 里的键被 normalize 删掉', () => {
  const st = fresh({ panelOpenMode: 'sidebar', cycleResetOnTrip: true })
  assert.equal('panelOpenMode' in st.settings, false, 'panelOpenMode 必须被删')
  assert.equal('cycleResetOnTrip' in st.settings, false, 'cycleResetOnTrip 必须被删')
})

test('清理', () => {
  rmSync(DIR, { recursive: true, force: true })
  void statePath
})
