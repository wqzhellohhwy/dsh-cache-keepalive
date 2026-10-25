/**
 * 闸门：**离线 surface 复刻 vs DSH 官方实现，逐节点对比**。
 *
 * 这是「脱离 DSH」路线的验收标准 —— `src/core/surface.ts` 折叠出的节点序列，
 * 必须与 `@deepseek-ai/dsh-session` 的 `foldSurface` 完全一致，否则保温请求的前缀
 * 就会偏离真实请求，命中率塌掉。
 *
 * ## 官方包从哪找（零硬编码）
 * 按顺序：
 *  1. `--pkg <路径>` 参数
 *  2. 环境变量 `DSH_SESSION_PKG`
 *  3. **本包自己的 `node_modules`**（DSH 运行时包通常以 junction / 软链挂在这里，
 *     `existsSync` 会跟随链接，所以这一条在插件仓库内几乎总能命中）
 *  4. 从 `node_modules/@deepseek-ai` 下任一兄弟包的**真实路径**推断（junction 指向运行时根，
 *     兄弟包就在同一目录里）
 *  5. 从 `process.execPath` 所在目录向上逐级找（桌面版 DSH 里它就是 electron.exe）
 *  6. 从 `DSH_HOME` 向上逐级找
 * 全都找不到 → **跳过**（退出 0）：纯脱离环境里本来就没有 DSH 包，
 * 那时本闸门没有 ground truth，硬报错只会挡住正常使用。
 *
 * 跑法：`node scripts/check-surface-parity.mjs [--pkg <path>] [--verbose]`
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { foldSurface, foldRequestHeader, deriveEventMessage, messagesOf } from '../src/core/surface.ts'
import { decodeMultiFrame } from '../src/core/sessions.ts'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const REL = join('node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js')

/** 从某个起点向上逐级找目标文件。 */
function searchUp(start, rel, maxDepth = 8) {
  let dir = resolve(start)
  for (let i = 0; i < maxDepth; i += 1) {
    const candidate = join(dir, rel)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function locateOfficial(extraArg) {
  if (extraArg !== undefined && existsSync(extraArg)) return { path: extraArg, from: '--pkg' }
  const fromEnv = process.env.DSH_SESSION_PKG
  if (typeof fromEnv === 'string' && fromEnv !== '' && existsSync(fromEnv)) {
    return { path: fromEnv, from: 'DSH_SESSION_PKG' }
  }
  // 本包自己的 node_modules（运行时包常以 junction 挂在这里，existsSync 会跟随链接）
  const local = join(ROOT, REL)
  if (existsSync(local)) return { path: realpathSync(local), from: '本地 node_modules' }
  // 从兄弟包的真实路径推断：junction 指向运行时根，兄弟包就在同一目录
  const siblings = join(ROOT, 'node_modules', '@deepseek-ai')
  if (existsSync(siblings)) {
    for (const name of readdirSync(siblings)) {
      let real
      try { real = realpathSync(join(siblings, name)) } catch { continue }
      const candidate = join(dirname(real), 'dsh-session', 'lib', 'index.js')
      if (existsSync(candidate)) return { path: candidate, from: '兄弟包推断（' + name + '）' }
    }
  }
  // 从 node 可执行文件往上找（桌面版 DSH 里 process.execPath 就是它的 electron.exe）
  const fromExec = searchUp(dirname(process.execPath), REL)
  if (fromExec !== undefined) return { path: fromExec, from: 'process.execPath' }
  // 从 DSH 主目录往上找
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const fromHome = searchUp(dshHome, REL)
  if (fromHome !== undefined) return { path: fromHome, from: 'DSH_HOME' }
  return undefined
}

const argv = process.argv.slice(2)
const pkgArgIndex = argv.indexOf('--pkg')
const pkgArg = pkgArgIndex >= 0 ? argv[pkgArgIndex + 1] : undefined
const verbose = argv.includes('--verbose')

const located = locateOfficial(pkgArg)
if (located === undefined) {
  console.log('⚠️ 找不到 @deepseek-ai/dsh-session，跳过对比（纯脱离环境属正常）。')
  console.log('   要跑这个闸门，用 --pkg <.../dsh-session/lib/index.js> 或设 DSH_SESSION_PKG。')
  process.exit(0)
}

const official = await import('file:///' + located.path.replace(/\\/g, '/'))
if (typeof official.foldSurface !== 'function') {
  console.log('⚠️ 该模块没有导出 foldSurface，跳过。路径:', located.path)
  process.exit(0)
}

console.log(`官方实现: ${located.path}  （来自 ${located.from}）`)
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const sessionsRoot = join(home, 'sessions')
if (!existsSync(sessionsRoot)) {
  console.log('⚠️ 找不到会话目录', sessionsRoot, '—— 跳过')
  process.exit(0)
}

const logs = []
for (const proj of readdirSync(sessionsRoot)) {
  let entries
  try { entries = readdirSync(join(sessionsRoot, proj)) } catch { continue }
  for (const name of entries) {
    const f = join(sessionsRoot, proj, name, 'session.v4.jsonl.zstd')
    try { logs.push({ f, m: statSync(f).mtimeMs, id: name }) } catch { /* 非 v4 */ }
  }
}
logs.sort((a, b) => b.m - a.m)

let sameNodes = 0
let sameHeader = 0
let sameMessages = 0
const problems = []
let checked = 0

for (const { f, id } of logs) {
  let events = []
  try {
    const text = decodeMultiFrame(readFileSync(f)).text
    for (const line of text.split('\n')) {
      if (line === '') continue
      let e
      try { e = JSON.parse(line) } catch { continue }
      // 只留带 seq 的事件：日志首行是会话头，混进去会破坏 seq 连续性
      if (typeof e.seq === 'number') events.push(e)
    }
  } catch (e) {
    problems.push(`${id}: 解压失败 ${String(e?.message ?? e)}`)
    continue
  }
  if (events.length === 0) continue
  checked += 1

  let mine = null
  let mineErr = ''
  try { mine = foldSurface(events) } catch (e) { mineErr = String(e?.message ?? e) }

  let theirs = null
  let theirsErr = ''
  try { theirs = official.foldSurface(events) } catch (e) { theirsErr = String(e?.message ?? e) }

  if (mineErr !== '' || theirsErr !== '') {
    problems.push(`${id}: 本地${mineErr !== '' ? '抛错(' + mineErr.slice(0, 80) + ')' : 'ok'} / 官方${theirsErr !== '' ? '抛错(' + theirsErr.slice(0, 80) + ')' : 'ok'}`)
    continue
  }

  // ① 节点序列必须完全一致
  const a = JSON.stringify(mine.nodes)
  const b = JSON.stringify([...theirs.nodes])
  if (a === b) sameNodes += 1
  else problems.push(`${id}: nodes 不一致 本地 ${mine.nodes.length} / 官方 ${theirs.nodes.length}`)

  // ② 请求头规范化必须一致
  const mh = JSON.stringify(foldRequestHeader(events) ?? null)
  const th = JSON.stringify(official.foldRequestHeader(events) ?? null)
  if (mh === th) sameHeader += 1
  else problems.push(`${id}: request/header 不一致`)

  // ③ 消息推导：拿双方共同的前 200 个节点逐个比
  const limit = Math.min(mine.nodes.length, theirs.nodes.length, 200)
  let msgOk = true
  for (let i = 0; i < limit; i += 1) {
    const seq = mine.nodes[i]
    const ev = events[seq]
    const om = official.deriveEventMessage(ev, theirs.projectedMessages)
    const lm = deriveEventMessage(ev, mine.projectedMessages)
    if (JSON.stringify(om ?? null) !== JSON.stringify(lm ?? null)) {
      problems.push(`${id}: 第 ${i} 个节点（seq ${seq}）消息推导不一致`)
      msgOk = false
      break
    }
  }
  if (msgOk) sameMessages += 1

  // ④ 官方出现了投影消息而我们没有 → 说明该会话需要投影器
  if (theirs.projectedMessages.size > 0) {
    problems.push(`${id}: 官方有 ${theirs.projectedMessages.size} 条投影消息，本地为 0（这条会话需要消息投影器）`)
  }
}

console.log(`对比会话数: ${checked} / ${logs.length}`)
console.log(`  ① nodes 一致: ${sameNodes}`)
console.log(`  ② request/header 一致: ${sameHeader}`)
console.log(`  ③ 消息推导一致: ${sameMessages}`)
if (verbose) console.log(`  含 replace 的会话（replacements > 0）会额外打印在下面`)

// 抽一条有 replace 的会话打印细节，便于人工确认压缩场景被正确还原
if (verbose) {
  for (const { f, id } of logs) {
    let events = []
    try {
      const text = decodeMultiFrame(readFileSync(f)).text
      for (const line of text.split('\n')) {
        if (line === '') continue
        try { const e = JSON.parse(line); if (typeof e.seq === 'number') events.push(e) } catch { /* 坏行 */ }
      }
    } catch { continue }
    let fold = null
    try { fold = foldSurface(events) } catch { continue }
    if (fold.replacements === 0) continue
    const { messages } = messagesOf(events)
    console.log('')
    console.log(`样本（含 ${fold.replacements} 次 replace）: ${id}`)
    console.log(`  事件 ${events.length} → 节点 ${fold.nodes.length} → 消息 ${messages.length}`)
    break
  }
}

if (problems.length === 0) {
  console.log('')
  console.log('✅ 离线复刻与官方完全一致')
  process.exit(0)
}
console.log('')
console.log(`❌ ${problems.length} 处差异：`)
for (const p of problems.slice(0, 20)) console.log('   ' + p)
if (problems.length > 20) console.log(`   …还有 ${problems.length - 20} 条`)
process.exit(1)
