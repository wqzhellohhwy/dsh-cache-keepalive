import assert from 'node:assert/strict'
import test from 'node:test'
import { decideWarm } from '../src/gate.ts'

test('G10 门禁：超长闲置只说「闲置过久，缓存大概率已断」+ 网页版 2 分钟延后', () => {
  const HOUR = 3600_000
  const T0 = 1000 * HOUR
  const base = (over = {}) => ({
    now: T0, agentStatus: 'idle', lastActivityAt: T0 - 4.5 * HOUR, lastTouchAt: 0,
    touchCount: 0, touchCountTotal: 0, cumulativeCost: 0, tripped: false, hasRoute: true,
    intervalMs: 4 * HOUR, idleLimitMs: 8 * HOUR, freshMs: 5 * 60_000,
    maxTouches: 9, maxTouchesTotal: 0, budget: 0.5, ...over,
  })

  // 闲置 15000 分钟（≈55 年）：不报数字，只给整句
  const hugeFirst = decideWarm(base({ lastActivityAt: T0 - 15000 * 60_000 }))
  assert.equal(hugeFirst.ok, false)
  assert.ok(hugeFirst.code === 'cold-window-idle', '超长闲置应判 cold-window-idle，实际 ' + String(hugeFirst.code))
  assert.ok(hugeFirst.detail.includes('闲置过久，缓存大概率已断'), '文案不对: ' + hugeFirst.detail)
  assert.equal(/\d{5,}/.test(hugeFirst.detail), false, '超长闲置不许再出现具体分钟数: ' + hugeFirst.detail)

  // 刚刚过线（8h01m）仍报具体数字
  const justOver = decideWarm(base({ lastActivityAt: T0 - (8 * HOUR + 60_000) }))
  assert.ok(justOver.code === 'cold-window-idle', '8h01m 应判 cold-window-idle')
  assert.ok(/\d+ 分钟/.test(justOver.detail) || /\d+ 小时/.test(justOver.detail), '未超 9999 分钟要报具体数字: ' + justOver.detail)

  // 保过的 stale 同样处理
  const hugeStale = decideWarm(base({ lastTouchAt: T0 - 15000 * 60_000, lastActivityAt: T0 - 15000 * 60_000, touchCount: 1 }))
  assert.ok(hugeStale.code === 'stale', '超长闲置（保过）应判 stale，实际 ' + String(hugeStale.code))
  assert.ok(hugeStale.detail.includes('闲置过久，缓存大概率已断'), 'stale 文案不对: ' + hugeStale.detail)

  // 网页版延后 2 分钟：4h01m 时插件版放行、网页版仍等
  const at401 = { lastActivityAt: T0 - (4 * HOUR + 60_000) }
  assert.equal(decideWarm(base(at401)).ok, true, '插件版（不延后）4h01m 应放行')
  const cli = decideWarm(base({ ...at401, delayMs: 2 * 60_000 }))
  assert.equal(cli.ok, false, '网页版（延后 2 分钟）4h01m 应还在等')
  assert.equal(cli.code, 'too-soon')
  // 4h05m 时网页版也放行
  assert.equal(decideWarm(base({ lastActivityAt: T0 - (4 * HOUR + 5 * 60_000), delayMs: 2 * 60_000 })).ok, true, '网页版 4h05m 应放行')
})

test('G11 缓存到期已并入闲置上限（cacheTtlSeconds 字段已删），保温间隔仍是 14400 秒', async () => {
  const { DEFAULT_SETTINGS } = await import('../src/store.ts')
  assert.equal(DEFAULT_SETTINGS.cacheTtlSeconds, undefined, 'cacheTtlSeconds 已合并掉，不能再出现')
  assert.equal(DEFAULT_SETTINGS.intervalSeconds, 4 * 3600, 'intervalSeconds 必须保持 14400（240 分钟）')
  assert.equal(DEFAULT_SETTINGS.idleLimitHours, 6, '闲置上限默认 6 小时（时间轴到期线也用它）')
})
