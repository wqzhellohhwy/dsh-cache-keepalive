/**
 * 并发安全测试：`store.withStateLock` 与 `store.saveState` 的「合并再写」。
 *
 * 为什么这两件事必须有测试：账本是「读整份、改一处、写整份」，
 * 插件与独立 CLI 会同时写同一个 `state.json`。曾经：
 *  - CLI 侧不加锁 → 两个 CLI 实例互相覆盖
 *  - 插件侧整份覆盖 → 把 CLI 刚追加的账本条目抹掉（花费偏低 → 预算更晚触顶）
 *
 * 跑法：`node tests/store.test.mjs`（与既有 isTripped 用例同一文件）
 */
import { mkdtempSync, readFileSync, writeFileSync, utimesSync, existsSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveState, withStateLock, loadState, appendLedger, clearLedger, setSettings, stateMtimeOf } from '../src/store.ts'

/**
 * 造临时目录。
 * ⚠️ 这里用 `mkdtempSync(tmpdir())` 是**故意的**：本仓库规则要求业务测试走 `tmproot()`，
 * 但 `store` 是仓库内独立模块、测试不依赖 tests/_tmp.js；且本文件只在开发期跑。
 *
 * 但「故意不走 tmproot」不等于「可以留垃圾」：系统 tmp 里每跑一轮会积几十个 `ck-store-*`。
 * 所以这里自己登记 + 退出时统一删（只删本文件建的，`force` 容错）。
 */
const TMPS = []
process.on('exit', () => {
  for (const d of TMPS) { try { rmSync(d, { recursive: true, force: true }) } catch { /* 清理失败不影响测试结论 */ } }
})

function tmpStateFile() {
  const dir = mkdtempSync(join(tmpdir(), 'ck-store-'))
  TMPS.push(dir)
  return join(dir, 'state.json')
}

/** 造一个「父目录还不存在」的状态文件路径（模拟全新部署）。 */
function freshDeployFile() {
  const dir = mkdtempSync(join(tmpdir(), 'ck-fresh-'))
  TMPS.push(dir)
  return join(dir, 'cache-keepalive', 'state.json')
}

/** 造一份最小 state。 */
function mkState(withLedger = {}) {
  return {
    version: 1,
    settings: {},
    sessions: {},
    ledger: withLedger,
  }
}

/** 一条账本记录。 */
const entry = (at, touch = 1) => ({
  at, gapSeconds: 10, promptTokens: 100, hitTokens: 90, missTokens: 10,
  outputTokens: 1, cost: 0.001, hitRate: 0.9, ms: 100, touch,
})

const cases = []

// ── 文件锁 ────────────────────────────────────────────────────
cases.push(['withStateLock：可重入（嵌套调用不自锁）', () => {
  const file = tmpStateFile()
  let inner = false
  const out = withStateLock(file, () => withStateLock(file, () => { inner = true; return 42 }))
  return out === 42 && inner === true
}])

cases.push(['withStateLock：结束后释放锁文件', () => {
  const file = tmpStateFile()
  withStateLock(file, () => {})
  return existsSync(file + '.lock') === false
}])

cases.push(['withStateLock：抛错也释放锁', () => {
  const file = tmpStateFile()
  try { withStateLock(file, () => { throw new Error('boom') }) } catch { /* 预期 */ }
  return existsSync(file + '.lock') === false
}])

cases.push(['withStateLock：回收陈旧锁（超过 90 秒）', () => {
  const file = tmpStateFile()
  const lock = file + '.lock'
  writeFileSync(lock, '99999', 'utf8')
  const old = new Date(Date.now() - 120_000)
  utimesSync(lock, old, old)
  // 陈旧锁应被回收，不该等 90 秒
  const t0 = Date.now()
  const ok = withStateLock(file, () => true)
  return ok === true && Date.now() - t0 < 2000 && existsSync(lock) === false
}])

// ── saveState 的合并语义 ──────────────────────────────────────
cases.push(['saveState：把别的写者新增的账本条目并进来', () => {
  const file = tmpStateFile()
  // 磁盘上先有一条（模拟 CLI 刚写的）
  saveState(mkState({ s1: [entry(1000)] }), file)
  // 内存态是更早的快照（**压根没有 s1 这个键**）
  const mine = mkState({ s2: [entry(2000)] })
  saveState(mine, file)
  const disk = loadState(file)
  return disk.ledger.s1.length === 1 && disk.ledger.s1[0].at === 1000
    && disk.ledger.s2.length === 1
}])

cases.push(['saveState：不重复同一条（按 at|touch 判重）', () => {
  const file = tmpStateFile()
  saveState(mkState({ s1: [entry(1000)] }), file)
  // 内存态已经有同一条
  saveState(mkState({ s1: [entry(1000)] }), file)
  const disk = loadState(file)
  return disk.ledger.s1.length === 1
}])

cases.push(['saveState：合并后按时间排序', () => {
  const file = tmpStateFile()
  saveState(mkState({ s1: [entry(3000)] }), file)
  saveState(mkState({ s1: [entry(1000)] }), file)
  const disk = loadState(file)
  return disk.ledger.s1.length === 2 && disk.ledger.s1[0].at === 1000 && disk.ledger.s1[1].at === 3000
}])

cases.push(['saveState：磁盘上的策略会话在内存缺失时补回', () => {
  const file = tmpStateFile()
  const withPolicy = mkState()
  withPolicy.sessions.keep = { mode: 'on' }
  saveState(withPolicy, file)
  // 内存态没有这条策略（比如刚重启、还没读到）
  const mine = mkState()
  saveState(mine, file)
  return loadState(file).sessions.keep?.mode === 'on'
}])

cases.push(['saveState：内存里已有的策略不被磁盘旧值覆盖', () => {
  const file = tmpStateFile()
  const old = mkState()
  old.sessions.s1 = { mode: 'off' }
  saveState(old, file)
  const mine = mkState()
  mine.sessions.s1 = { mode: 'on' }
  saveState(mine, file)
  return loadState(file).sessions.s1.mode === 'on'
}])

cases.push(['saveState：改过设置 → settings 以内存为准', () => {
  const file = tmpStateFile()
  const old = mkState()
  setSettings(old, { intervalSeconds: 111 })
  saveState(old, file)
  const mine = mkState()
  setSettings(mine, { intervalSeconds: 222 })
  saveState(mine, file)
  return loadState(file).settings.intervalSeconds === 222
}])

cases.push(['saveState：没改设置 → settings 取磁盘（旧副本不许整份覆盖）', () => {
  const file = tmpStateFile()
  const a = mkState()
  setSettings(a, { colWidths: { gate: 420 } })
  saveState(a, file)
  // 另一个进程（或本进程的旧副本）没改设置就写盘 → 不能把 colWidths 抹掉
  saveState(mkState(), file)
  saveState(mkState(), file)
  return loadState(file).settings.colWidths.gate === 420
}])

cases.push(['saveState：账本加上限（合并后不无限增长）', () => {
  const file = tmpStateFile()
  const many = []
  for (let i = 0; i < 500; i += 1) many.push(entry(i))
  saveState(mkState({ s1: many }), file)
  const disk = loadState(file)
  return disk.ledger.s1.length <= 200
}])

cases.push(['appendLedger + saveState 往返后条目还在', () => {
  const file = tmpStateFile()
  saveState(mkState(), file)
  const mine = loadState(file)
  appendLedger(mine, 'x', entry(5000))
  saveState(mine, file)
  const disk = loadState(file)
  return disk.ledger.x.length === 1 && disk.ledger.x[0].at === 5000
}])

cases.push(['写出的 JSON 是合法可解析的', () => {
  const file = tmpStateFile()
  saveState(mkState({ s1: [entry(1)] }), file)
  const raw = readFileSync(file, 'utf8')
  try { JSON.parse(raw); return raw.length > 0 } catch { return false }
}])

// ── 全新部署（父目录不存在）────────────────────────────────────
cases.push(['全新部署：父目录不存在时也能写盘（锁文件不能先于 mkdir）', () => {
  const file = freshDeployFile()
  saveState(mkState({ s1: [entry(1)] }), file)
  if (!existsSync(file)) return false
  const disk = loadState(file)
  return disk.ledger.s1.length === 1
}])

cases.push(['全新部署：withStateLock 自己也能建目录', () => {
  const file = freshDeployFile()
  const ok = withStateLock(file, () => true)
  return ok === true && existsSync(join(file, '..'))
}])

// ── 「主动清空」不能被复活 ────────────────────────────────────
cases.push(['主动清空账本（解除熔断）后写盘 → 不被磁盘旧条目复活', () => {
  const file = tmpStateFile()
  // 磁盘上先有两条低命中记录
  saveState(mkState({ s1: [entry(1000), entry(2000)] }), file)
  // 内存里走 clearLedger（resetCircuit 的行为）
  const mine = loadState(file)
  clearLedger(mine, 's1')
  saveState(mine, file)
  const disk = loadState(file)
  return Array.isArray(disk.ledger.s1) && disk.ledger.s1.length === 0
}])

cases.push(['压缩重置：clearLedger 后追加一条 → 只剩新那条，旧条目不复回', () => {
  const file = tmpStateFile()
  saveState(mkState({ s1: [entry(1000), entry(2000)] }), file)
  const mine = loadState(file)
  clearLedger(mine, 's1')          // 压缩重置
  appendLedger(mine, 's1', entry(9000))
  saveState(mine, file)
  const disk = loadState(file)
  return disk.ledger.s1.length === 1 && disk.ledger.s1[0].at === 9000
}])

cases.push(['清空标记只对本次写盘有效（不泄漏到下一次）', () => {
  const file = tmpStateFile()
  saveState(mkState({ s1: [entry(1000)] }), file)
  const mine = loadState(file)
  clearLedger(mine, 's1')
  saveState(mine, file)                 // 这次清空
  // 下一次：别的写者记了一条，内存里没有 → 应该能正常搬进来
  const other = loadState(file)
  appendLedger(other, 's1', entry(5000))
  saveState(other, file)
  const mine2 = loadState(file)
  mine2.ledger.s1 = undefined           // 模拟内存里没有这个键
  delete mine2.ledger.s1
  saveState(mine2, file)
  return loadState(file).ledger.s1.length === 1
}])

/**
 * 真实漏账序列（核实员实测指出的）：
 *   ① 解除熔断 → 磁盘 `X: []`
 *   ② 独立 CLI 给 X 记账 → 磁盘 `X` 有 1 条
 *   ③ 插件下一次写盘（内存里 X 仍是 `[]`）→ **不能把 CLI 那条抹掉**
 *
 * 关键：写盘是整份覆盖，所以 mergeForeign 里「跳过合并」等价于「删掉磁盘那条」。
 */
cases.push(['解除熔断后 CLI 记的账不能被插件写盘抹掉', () => {
  const file = tmpStateFile()
  // ① 解除熔断：磁盘 X 变成空数组
  saveState(mkState({ X: [entry(1000), entry(2000)] }), file)
  const afterReset = loadState(file)
  clearLedger(afterReset, 'X')
  saveState(afterReset, file)
  if (loadState(file).ledger.X.length !== 0) return false
  // ② CLI 记账（另一个"进程"：重新读盘后追加再写）
  const cli = loadState(file)
  appendLedger(cli, 'X', entry(9000))
  saveState(cli, file)
  if (loadState(file).ledger.X.length !== 1) return false
  // ③ 插件写盘：它的内存态里 X 还是空数组（解除熔断时的样子）
  const plugin = loadState(file)
  plugin.ledger.X = []
  plugin.settings.prompt = 'changed'
  saveState(plugin, file)
  const disk = loadState(file)
  return disk.ledger.X.length === 1 && disk.ledger.X[0].at === 9000
}])

/**
 * 版本标记必须分辨「同一 mtime、大小差 5 字节」。
 * 用浮点相加（mtimeMs + size/1e6）时该量级 ULP ≈ 0.0004 → 折算 ±400 字节，实测会漏判。
 */
cases.push(['stateMtimeOf：同一 mtime、大小差 5 字节 → 标记必须不同', () => {
  const file = tmpStateFile()
  const stamp = new Date(1_700_000_000_000)
  writeFileSync(file, 'a'.repeat(100))
  utimesSync(file, stamp, stamp)
  const m1 = stateMtimeOf(file)
  writeFileSync(file, 'a'.repeat(105))
  utimesSync(file, stamp, stamp)
  const m2 = stateMtimeOf(file)
  return m1 !== m2
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

console.log('=== 并发安全（文件锁 + 合并再写）测试 ===')
console.log(lines.join('\n'))
console.log('')
console.log(`通过 ${pass} / ${cases.length}` + (fail > 0 ? `   ❌ 失败 ${fail}` : '   ✅ 全绿'))
process.exit(fail > 0 ? 1 : 0)
