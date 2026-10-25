/**
 * 无实例面板服务（`core/panel-service.ts`）冒烟：试验模式往返 + timeline 粒度参数。
 *
 * 这两条都是核实员实测出的「功能不生效」：
 *  - `setSettings` 绕过 `LAB_OVERRIDES` → 面板显示「试验模式运行中」但参数没压（假开关）
 *  - `timeline(id)` 不接 `granularity` → 粒度下拉无效
 * 另外覆盖 `loadState` 丢掉 `labBackup` 的那个坑（重启后关试验模式，参数停在 30 秒 / 99 次）。
 *
 * 跑法：`node scripts/smoke-panel-service.mjs`
 */
import { cpSync, mkdtempSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { assertNotRealHome } from './assert-temp-home.mjs'
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { createPanelService } from "../src/core/panel-service.ts"
import { loadState, saveState, statePath } from "../src/store.ts"
const home = mkdtempSync(join(tmpdir(), "ck-ps-"))
process.env.DSH_HOME = home

/** 护栏：任何会写盘的测试都不许落在真实 ~/.dsh（2026-10-19 事故）。 */
assertNotRealHome(statePath())
/**
 * 临时 home 里挂**一个真实的 cwd 会话目录**（junction）。
 *
 * 为什么必须：`snapshot()` 曾在 `rows.map` 里因 TDZ 抛异常，空库里循环体一次都不执行 →
 * 断言"不崩"照样通过。挂一条真会话，TDZ 才会被真的踩到。
 * 只挂**最小的那个 cwd 目录**，避免冒烟被大日志拖慢。
 */
try {
  const root = join(homedir(), ".dsh", "sessions")
  mkdirSync(join(home, "sessions"), { recursive: true })
  let best = null
  let bestSize = Infinity
  for (const d of readdirSync(root)) {
    const dir = join(root, d)
    let size = 0
    try {
      if (!statSync(dir).isDirectory()) continue
      for (const sub of readdirSync(dir)) {
        try { size += statSync(join(dir, sub, "session.v4.jsonl.zstd")).size } catch { /* 不是会话目录 */ }
      }
    } catch { continue }
    if (size > 0 && size < bestSize) { bestSize = size; best = d }
  }
  if (best !== null) cpSync(join(root, best), join(home, "sessions", best), { recursive: true })
} catch (e) { console.log('（挂真实会话失败，退化为空库）: ' + (e && e.message)) }
const out = []
const svc = createPanelService({ dshHome: home, warm: async () => ({ ok: true, message: "stub" }) })
const s = loadState(statePath())
saveState(s, statePath())
// ⚠️ 独立面板的**主数据接口**是 snapshot()：它曾因 TDZ（变量先使用后声明）整体抛 500，
// 而当时的断言只覆盖 settings/timeline，全绿也发现不了。
try {
  const snap = svc.snapshot()
  const rows = Array.isArray(snap.sessions) ? snap.sessions : []
  // 冒烟用临时 DSH_HOME（没有会话日志），只验「接口不抛异常、结构正确」
  out.push(["snapshot() 返回 sessions 数组（独立面板主数据接口）", Array.isArray(snap.sessions)])
  out.push(["snapshot() 有真实会话时能遍历每一行（TDZ 会在这里暴露）", rows.length > 0])
  const bad = rows.filter((r) => typeof r.gateCode !== "string")
  out.push(["snapshot() 每条都有 gateCode", bad.length === 0])
} catch (e) {
  console.log("snapshot 抛错: " + (e && e.message))
  out.push(["snapshot() 不抛异常", false])
}

const a = await svc.timeline("nope")
// 粒度：用一条真实会话不方便，改测 settings 的试验模式
out.push(["无真实会话时 timeline 返回 ok:false", a.ok === false])
svc.setSettings({ labMode: true })
const after = loadState(statePath())
out.push(["试验模式把 intervalSeconds 压到秒级", after.settings.intervalSeconds === 30])
out.push(["试验模式把 maxTouches 抬高", after.settings.maxTouches === 99])
svc.setSettings({ labMode: false })
const back = loadState(statePath())
out.push(["退出试验模式恢复原值", back.settings.intervalSeconds === 14400])
/**
 * 闲置上限（`idleLimitHours`）必须**真的落盘**：`applySettingsPatch` 是白名单式的，
 * 字段不加进名单就会被静默丢弃 —— 面板会显示「保存成功」，但重启回默认值。
 */
svc.setSettings({ idleLimitHours: 6 })
const idle = loadState(statePath())
out.push(["idleLimitHours 经 settings 接口真的写进 state.json", idle.settings.idleLimitHours === 6])
svc.setSettings({ idleLimitHours: 8 })
out.push(["idleLimitHours 能改回 8", loadState(statePath()).settings.idleLimitHours === 8])
/** 刚保过提示（`freshSeconds`）同样要真的落盘：白名单漏字段会被静默丢弃；0 = 关掉 fresh 必须允许。 */
svc.setSettings({ freshSeconds: 42 })
out.push(["freshSeconds 经 settings 接口真的写进 state.json", loadState(statePath()).settings.freshSeconds === 42])
svc.setSettings({ freshSeconds: 0 })
out.push(["freshSeconds = 0（关掉 fresh）被允许、不被夹成默认值", loadState(statePath()).settings.freshSeconds === 0])
svc.setSettings({ freshSeconds: 300 })
out.push(["freshSeconds 能改回 300", loadState(statePath()).settings.freshSeconds === 300])
let pass = 0
for (const [n, ok] of out) { console.log((ok ? "PASS" : "FAIL") + "  " + n); if (ok) pass++ }
console.log(pass === out.length ? "✅ panel-service 冒烟全绿" : "❌ 有失败")
process.exit(pass === out.length ? 0 : 1)
