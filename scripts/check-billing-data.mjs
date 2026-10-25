/**
 * **计价链路的数据验证**：自造假会话/假时间/假模型，跑真实计价函数，看钱数是否对得上。
 *
 * 为什么单独一个脚本：`tests/econ.test.mjs` 只验纯函数；这里要验「设置 → 计价 → 记账 → 面板」整条链
 * 是不是真的按用户配的表和开关算钱（含模型级开关、无年份节假日、跨零点时段）。
 * 全程不联网、不花钱：只调纯函数，账本写在临时 DSH_HOME 里。
 */
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const {
  DEFAULT_PRICES, costAt, effectivePrices, normalizePriceTable, normalizeTariff,
} = await import('../src/econ.ts')
const { loadState, appendLedger, saveState, policyOf } = await import('../src/store.ts')
const { recordWarm } = await import('../src/core/panel-service.ts')

let failed = 0
const say = (ok, msg, extra) => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}${ok || extra === undefined ? '' : '\n      ' + String(extra).slice(0, 300)}`)
}

const home = fs.mkdtempSync(join(tmpdir(), 'ck-billing-'))
process.env.DSH_HOME = home

/** 北京时间某日某点 → epoch（不依赖本机时区）。 */
const bj = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi)

/** 假 usage：prompt 10000（命中 9000 + 未命 1000），输出 100。 */
const U = { cacheReadTokens: 9000, inputTokens: 1000, outputTokens: 100 }

const table = normalizePriceTable({
  // A：三个价与基准不同，且**不吃峰谷**
  'model-a': { hit: 0.01, miss: 2, out: 8, tariff: false },
  // B：吃峰谷与节假日
  'model-b': { hit: 0.01, miss: 2, out: 8 },
  // C：吃峰谷，但不吃节假日
  'model-c': { hit: 0.01, miss: 2, out: 8, holiday: false },
})
const tariff = normalizeTariff({
  enabled: true,
  timeZone: 'Asia/Shanghai',
  slots: [
    { id: 'off', label: '空闲', from: '00:00', to: '08:00', factor: 1 },
    { id: 'peak', label: '高峰', from: '08:00', to: '00:00', factor: 3 },
  ],
  holidayEnabled: true,
  holidayFactor: 5,
  holidays: [{ date: '02-17', name: '春节' }],
})

const noon = bj(2026, 10, 11, 12, 0)
const midnight = bj(2026, 10, 11, 3, 0)
const holiday = bj(2031, 2, 17, 12, 0)   // 故意用不同年份，验证「表里没年份也能命中」
const workday = bj(2031, 2, 18, 12, 0)

/** 手算：乘了倍率的三价。 */
const money = (p, u = U) => (u.cacheReadTokens * p.hit + u.inputTokens * p.miss + u.outputTokens * p.out) / 1e6

// ① 模型级「不吃峰谷」
{
  const a = costAt(U, DEFAULT_PRICES, 'model-a', table, tariff, noon)
  say(Math.abs(a.cost - money({ hit: 0.01, miss: 2, out: 8 })) < 1e-12, 'model-a 不吃峰谷 → 按自己的三价算（factor=1）', a.cost + ' / ' + a.factor)
  const b = costAt(U, DEFAULT_PRICES, 'model-b', table, tariff, noon)
  say(Math.abs(b.cost - money({ hit: 0.03, miss: 6, out: 24 })) < 1e-12, 'model-b 吃峰谷 ×3', b.cost + ' / ' + b.factor)
}

// ② 时段边界与跨零点
{
  const off = costAt(U, DEFAULT_PRICES, 'model-b', table, tariff, midnight)
  say(off.factor === 1 && Math.abs(off.cost - money({ hit: 0.01, miss: 2, out: 8 })) < 1e-12, '03:00 落在空闲档 ×1', off.factor)
  const cross = normalizeTariff({
    enabled: true, timeZone: 'Asia/Shanghai',
    slots: [{ id: 'night', label: '夜间', from: '23:00', to: '07:00', factor: 4 }],
    holidays: [],
  })
  const at2330 = costAt(U, DEFAULT_PRICES, 'model-b', table, cross, bj(2026, 10, 11, 23, 30))
  const at0130 = costAt(U, DEFAULT_PRICES, 'model-b', table, cross, bj(2026, 10, 12, 1, 30))
  const at1200 = costAt(U, DEFAULT_PRICES, 'model-b', table, cross, bj(2026, 10, 12, 12, 0))
  say(at2330.factor === 4 && at0130.factor === 4 && at1200.factor === 1, '跨零点时段 23:00→07:00 两头都命中', [at2330.factor, at0130.factor, at1200.factor].join('/'))
}

// ③ 无年份节假日 + 模型级「不吃节假日」
{
  const b = costAt(U, DEFAULT_PRICES, 'model-b', table, tariff, holiday)
  say(b.factor === 5 && Math.abs(b.cost - money({ hit: 0.05, miss: 10, out: 40 })) < 1e-12, '2031-02-17 命中 02-17 的春节（×5）', b.cost + ' / ' + b.factor)
  const c = costAt(U, DEFAULT_PRICES, 'model-c', table, tariff, holiday)
  say(c.factor === 3, 'model-c 不吃节假日 → 回落到时段价 ×3', c.factor)
  const w = costAt(U, DEFAULT_PRICES, 'model-b', table, tariff, workday)
  say(w.factor === 3, '非节假日 → 时段价 ×3', w.factor)
}

// ④ 查不到的模型回落基准价
{
  const x = costAt(U, DEFAULT_PRICES, 'unknown-model', table, tariff, midnight)
  say(x.factor === 1 && Math.abs(x.cost - money(DEFAULT_PRICES)) < 1e-12, '未知模型回落基准价', x.cost)
}

// ⑤ 记账落库：recordWarm 把当时的模型/倍率/金额写进账本
{
  const state = loadState()
  state.settings.pricesByModel = table
  state.settings.tariff = tariff
  state.sessions['session-x'] = { mode: 'on' }
  const e = recordWarm({ state, id: 'session-x', usage: U, ms: 0, via: 'panel', model: 'model-b', intervalMs: 1000 })
  const raw = fs.readFileSync(join(home, 'cache-keepalive', 'state.json'), 'utf8')
  const onDisk = JSON.parse(raw).ledger['session-x'][0]
  say(Math.abs(e.cost - money({ hit: 0.03, miss: 6, out: 24 })) < 1e-12, 'recordWarm 按 model-b ×3 记金额', e.cost)
  say(e.factor === 3 && e.factorLabel === '高峰', '账本记下倍率与标签', e.factor + '/' + e.factorLabel)
  say(onDisk !== undefined && Math.abs(onDisk.cost - e.cost) < 1e-12, '金额已落盘', onDisk && onDisk.cost)
}

// ⑥ 面板两口径：本周期花费 / 全部次数
{
  const state = loadState()
  const led = state.ledger['session-x'] || []
  const cycle = (state.cycles || {})['session-x'] || 1
  const cycleCount = led.filter((e) => (e.cycle ?? 1) === cycle).length
  say(led.length === 1 && cycleCount === 1, '账本 1 条、当前周期 1 条（面板两个口径都取自这里）', led.length + '/' + cycleCount)
}

console.log('')
console.log(failed === 0 ? '✅ 计价链路数据验证全绿' : `❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
