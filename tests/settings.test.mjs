/**
 * 设置补丁的**事务性**（`applySettingsPatch`）—— 纯函数，直接构造 state 来测。
 *
 * 重点是退出试验模式这条路径上的两个陷阱：
 *  ① **备份不能在保存成功之前删**：整批被拒时必须连 `labBackup` 一起回滚，
 *     否则用户第二次退出会「成功」但参数永久停在 30 秒间隔 / 99 次上限（原值静默丢失）。
 *  ② 「恢复值非法 → 自动抬高闲置上限」那段必须**真的可达**，且要返回 `notice`（不许静默改）。
 */
import { applySettingsPatch, labRestoreBackup } from '../src/core/settings.ts'
import { DEFAULT_SETTINGS, LAB_OVERRIDES, loadState } from '../src/store.ts'

const cases = []

/** 干净的内存 state（不读盘、不写盘）。 */
function mkState() {
  const s = loadState('C:/definitely/not/here/state.json')
  // 一组"用户自己的值"，与 LAB_OVERRIDES 明显不同，便于逐字段核对还原
  s.settings.intervalSeconds = 14400
  s.settings.freshSeconds = 300
  s.settings.maxTouches = 9
  s.settings.circuitCooldownSeconds = 0
  s.settings.idleLimitHours = 8
  return s
}

// 1. 正常往返：进试验模式 → 退出 → 四个被覆盖项逐字段还原、labBackup 已清
cases.push(['进/退出试验模式 → 被覆盖的四项逐字段还原、labBackup 已删', () => {
  const s = mkState()
  const enter = applySettingsPatch(s, { labMode: true })
  const enteredOk = enter.labModeChanged === true && s.settings.labMode === true
    && s.settings.intervalSeconds === LAB_OVERRIDES.intervalSeconds
    && s.settings.maxTouches === LAB_OVERRIDES.maxTouches
    && s.labBackup !== undefined
  const back = applySettingsPatch(s, { labMode: false })
  return enteredOk && back.labModeChanged === true && back.error === undefined && back.notice === undefined
    && s.settings.labMode === false
    && s.settings.intervalSeconds === 14400
    && s.settings.freshSeconds === 300
    && s.settings.maxTouches === 9
    && s.settings.circuitCooldownSeconds === 0
    && s.labBackup === undefined
}])

// 2. 非法 labBackup：第一次退出必须**整批拒绝且备份仍在**（这是 R1 的核心断言）
cases.push(['★ 非法 labBackup → 第一次退出整批拒绝，labBackup 不能被吃掉', () => {
  const s = mkState()
  s.settings.labMode = true
  s.settings.intervalSeconds = LAB_OVERRIDES.intervalSeconds
  s.settings.freshSeconds = LAB_OVERRIDES.freshSeconds
  s.settings.maxTouches = LAB_OVERRIDES.maxTouches
  // 恢复值：间隔 9 小时，远超当前闲置上限 8 小时 → 关系校验必拒
  s.labBackup = { intervalSeconds: 9 * 3600, freshSeconds: 300, maxTouches: 9, circuitCooldownSeconds: 0 }
  // 但"加固"会把上限抬起来（notice 路径），所以要测"确实拒绝"的那个分支：
  // 显式带上非法 idleLimitHours，让加固不介入（用户自己在改上限）
  const out = applySettingsPatch(s, { labMode: false, idleLimitHours: 1 })
  return out.labModeChanged === false && typeof out.error === 'string'
    && s.settings.labMode === true                 // 回滚：还在试验模式
    && s.settings.intervalSeconds === LAB_OVERRIDES.intervalSeconds
    && s.labBackup !== undefined                    // ★ 备份必须还在
    && s.labBackup.intervalSeconds === 9 * 3600
}])

// 3. 非法 labBackup + 不显式改上限 → 加固生效：抬高上限、成功退出、**带 notice**、备份被清
cases.push(['★ 非法 labBackup + 未指定上限 → 自动抬高上限并返回 notice（不许静默）', () => {
  const s = mkState()
  s.settings.labMode = true
  s.settings.intervalSeconds = LAB_OVERRIDES.intervalSeconds
  s.settings.idleLimitHours = 8
  s.labBackup = { intervalSeconds: 9 * 3600, freshSeconds: 300, maxTouches: 9, circuitCooldownSeconds: 0 }
  const out = applySettingsPatch(s, { labMode: false })
  return out.labModeChanged === true && out.error === undefined
    && typeof out.notice === 'string' && out.notice.includes('闲置上限')
    && s.settings.labMode === false
    && s.settings.intervalSeconds === 9 * 3600
    && s.settings.idleLimitHours * 3600 > s.settings.intervalSeconds
    && s.labBackup === undefined
}])

// 4. 被拒之后再退一次：备份还在 → 第二次能正常还原（R1 的"丢用户设置"就是这一步）
cases.push(['★ 第一次被拒后第二次退出仍能还原原值（备份没丢）', () => {
  const s = mkState()
  s.settings.labMode = true
  s.settings.intervalSeconds = LAB_OVERRIDES.intervalSeconds
  s.labBackup = { intervalSeconds: 9 * 3600, freshSeconds: 300, maxTouches: 9, circuitCooldownSeconds: 0 }
  const first = applySettingsPatch(s, { labMode: false, idleLimitHours: 1 })
  if (first.error === undefined) return false
  // 用户把上限改到合法值（10 小时 > 9 小时）后再退
  const second = applySettingsPatch(s, { labMode: false, idleLimitHours: 10 })
  return second.labModeChanged === true && second.error === undefined
    && s.settings.labMode === false
    && s.settings.intervalSeconds === 9 * 3600
    && s.settings.freshSeconds === 300
    && s.settings.maxTouches === 9
    && s.settings.circuitCooldownSeconds === 0
    && s.labBackup === undefined
}])

// 5. 关系校验本身：非法配置整批拒绝且一个字段都不写
cases.push(['关系校验：间隔 > 上限 → 整批拒绝、一个字段都没写', () => {
  const s = mkState()
  const before = JSON.stringify({ ...s.settings, prices: undefined, tariff: undefined })
  const out = applySettingsPatch(s, { intervalSeconds: 9 * 3600, idleLimitHours: 8, maxTouches: 42 })
  const after = JSON.stringify({ ...s.settings, prices: undefined, tariff: undefined })
  return out.error !== undefined && out.labModeChanged === false
    && before === after && s.settings.maxTouches === 9
}])

// 6. 边界：正好相等也算非法（`>` 不是 `>=`）
cases.push(['关系校验边界：上限*3600 == 间隔 → 拒绝', () => {
  const s = mkState()
  const out = applySettingsPatch(s, { intervalSeconds: 8 * 3600, idleLimitHours: 8 })
  return out.error !== undefined && s.settings.intervalSeconds === 14400
}])

/* ── 试验模式的三条新入口 + 残留备份恢复 ─────────────────────────── */

// 7. 关闭态改白名单/预算：生效、**不产生 labBackup**、不动时间戳
cases.push(['关闭态改白名单/预算 → 生效且不产生 labBackup、不动时间戳', () => {
  const s = mkState()
  const out = applySettingsPatch(s, { labSessionAllow: ['s-1', 's-2'], labBudgetPerRun: 1.234 })
  if (out.error !== undefined) return false
  return s.settings.labSessionAllow.length === 2
    && s.settings.labSessionAllow[0] === 's-1'
    && s.settings.labBudgetPerRun === 1.23
    && s.labBackup === undefined
    && s.settings.labExpiresAt === 0
    && s.settings.labStartedAt === 0
    && s.settings.labMode === false
}])

// 8. 运行中改到期：labExpiresAt 变、labBackup 与 4 个被覆盖参数**不变**
cases.push(['运行中改到期 → 只改 labExpiresAt，备份与被覆盖参数不动', () => {
  const s = mkState()
  applySettingsPatch(s, { labMode: true })
  const backup0 = JSON.stringify(s.labBackup)
  const iv0 = s.settings.intervalSeconds
  const fresh0 = s.settings.freshSeconds
  const cd0 = s.settings.circuitCooldownSeconds
  const mt0 = s.settings.maxTouches
  const out = applySettingsPatch(s, { labExpiresAt: 1234567890 })
  if (out.error !== undefined) return false
  return s.settings.labExpiresAt === 1234567890
    && JSON.stringify(s.labBackup) === backup0
    && s.settings.intervalSeconds === iv0
    && s.settings.freshSeconds === fresh0
    && s.settings.circuitCooldownSeconds === cd0
    && s.settings.maxTouches === mt0
    && s.settings.labMode === true
}])

// 9. `{labMode:true, labExpiresAt:X}` 只走开启分支（不双写、labStartedAt 正常刷新）
cases.push(['{labMode:true, labExpiresAt} → 只走开启分支，不被到期分支双吃', () => {
  const s = mkState()
  const before = Date.now()
  const out = applySettingsPatch(s, { labMode: true, labExpiresAt: 999 })
  if (out.error !== undefined) return false
  return s.settings.labMode === true
    && s.settings.labExpiresAt === 999
    && s.settings.labStartedAt >= before
    && s.settings.intervalSeconds === LAB_OVERRIDES.intervalSeconds
    && s.labBackup !== undefined
}])

// 10. 非法值整批拒绝：一个字段都不写
cases.push(['非法白名单/预算 → 整批拒绝，一个字段都不写', () => {
  const s = mkState()
  const a = applySettingsPatch(s, { labSessionAllow: 'not-an-array', labBudgetPerRun: 5 })
  const b = applySettingsPatch(s, { labBudgetPerRun: NaN, labSessionAllow: ['x'] })
  return a.error !== undefined && b.error !== undefined
    && s.settings.labSessionAllow.length === 0
    && s.settings.labBudgetPerRun === DEFAULT_SETTINGS.labBudgetPerRun
}])

// 11. 白名单去空去重 + ≤500；预算两位小数
cases.push(['白名单去空去重/上限 500；预算四舍五入到分', () => {
  const s = mkState()
  const many = []
  for (let i = 0; i < 600; i++) many.push(' s-' + (i % 520) + ' ')
  many.push('', '   ')
  const out = applySettingsPatch(s, { labSessionAllow: many, labBudgetPerRun: 0.005 })
  if (out.error !== undefined) return false
  const uniq = new Set(s.settings.labSessionAllow)
  return s.settings.labSessionAllow.length === 500
    && uniq.size === 500
    && s.settings.labSessionAllow.indexOf('') < 0
    && s.settings.labSessionAllow[0] === 's-0'
    && s.settings.labBudgetPerRun === 0.01
}])

// 12. labRestoreBackup 五要点
cases.push(['labRestoreBackup：运行中拒绝 / 走校验 / 成功清时间戳 / 只认 4 键 / 删备份', () => {
  const s = mkState()
  // ① 运行中拒绝
  applySettingsPatch(s, { labMode: true })
  const running = labRestoreBackup(s)
  if (running.ok !== false || s.labBackup === undefined) return false
  // 模拟"上次退出失败 / 手改 state.json"的残留：labMode 已经是 false，但 labBackup 还在
  s.settings.labMode = false
  s.labBackup = { intervalSeconds: 7200, freshSeconds: 120, circuitCooldownSeconds: 30, maxTouches: 7, junkField: 1 }
  s.settings.labExpiresAt = 999
  s.settings.labStartedAt = 888
  const r = labRestoreBackup(s)
  // ② 走 applySettingsPatch（归一化后落地）  ④ 清时间戳  ⑤ 只认 4 键（junkField 不出现）  ③ 成功删备份
  return r.ok === true
    && Array.isArray(r.restored) && r.restored.length === 4
    && s.settings.intervalSeconds === 7200
    && s.settings.freshSeconds === 120
    && s.settings.circuitCooldownSeconds === 30
    && s.settings.maxTouches === 7
    && s.settings.labExpiresAt === 0
    && s.settings.labStartedAt === 0
    && s.labBackup === undefined
    && Object.prototype.hasOwnProperty.call(s.settings, 'junkField') === false
}])

// 13. labRestoreBackup 失败时**保留备份**（恢复出来的组合非法 → 整批拒绝）
cases.push(['labRestoreBackup：恢复值非法 → 失败且备份保留', () => {
  const s = mkState()
  s.settings.idleLimitHours = 1
  s.labBackup = { intervalSeconds: 7200, freshSeconds: 120, circuitCooldownSeconds: 30, maxTouches: 7 }
  const r = labRestoreBackup(s)
  return r.ok === false && r.error !== undefined
    && s.labBackup !== undefined
    && s.settings.intervalSeconds === 14400
}])

let pass = 0
let fail = 0
const lines = []
for (const [name, fn] of cases) {
  let ok = false
  let err = ''
  try {
    ok = fn() === true
  } catch (e) {
    err = ' 抛错: ' + (e && e.message ? e.message : String(e))
  }
  if (ok) pass++
  else fail++
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : err}`)
}

console.log('=== 设置补丁事务性测试 ===')
console.log(lines.join('\n'))
console.log('')
console.log(`通过 ${pass} / ${cases.length}` + (fail > 0 ? `   ❌ 失败 ${fail}` : '   ✅ 全绿'))
void DEFAULT_SETTINGS
process.exit(fail > 0 ? 1 : 0)
