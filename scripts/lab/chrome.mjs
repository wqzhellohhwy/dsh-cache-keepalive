/**
 * headless Chrome 统一启动入口。
 *
 * ## 为什么存在
 * 探针脚本各自拼 `--user-data-dir=<一次性目录>`，Chrome 启动 15 秒后自动下载优化指南组件
 * （42.93MB model_store + crx + shader，约 49MB/档案），仓库 `.tmp` 曾因此涨到 18GB。
 *
 * 实测（Chrome 151，about:blank，每组独立目录）：
 *   两行旧旗（--disable-component-update + --disable-background-networking） 49.34MB / 8 个 model
 *   无参数                                                                  49.41MB / 8 个
 *   --disable-features=OptimizationGuideModelDownloading 单独               49.42MB / 8 个
 *   --disable-features=OptimizationHints                                    6.38MB / 0 个  ← 唯一有效
 *
 * ## 必须知道的坑
 * - `--disable-features` 重复传递时 Chrome **取最后一个**，不是合并。本模块强制合并为唯一一条，
 *   并拒绝调用方自带该参数（否则保护被静默覆盖，而静态检查仍看到字样 → 假 PASS）。
 * - `DevToolsActivePort` 第二行是**浏览器级**端点，只能发 `Target.*` / `Browser.*`；
 *   操作 DOM 必须用 `pageWs()` 拿页面级端点。在浏览器级端点上发 `Runtime.evaluate` 报
 *   `-32601 'Runtime.evaluate' wasn't found`。
 * - `/json/list` 的**首个 target 不是 page**（实测出现过 `background_page` 与 `other`），
 *   必须按 `type === 'page'` 过滤。
 * - Chrome 退出后文件句柄不立即可删，`rmSync` 前 4 次可能 EPERM，需要退避重试。
 * - `tasklist` 输出不含命令行，不能用来判断某路径是否被占用；用目录名里的 pid + `process.kill(pid, 0)`。
 *
 * 用法：
 *   import { launch, close } from './chrome.mjs'
 *   const h = await launch(); const ws = await h.pageWs(); ... await close(h)
 *
 *   # 或命令行（给 .tmp 下的一次性探针用，无需关心相对路径）
 *   node scripts/lab/chrome.mjs --url file:///x.html --json
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const TMP_WARN_BYTES = 200 * 1024 * 1024
const ORPHAN_GRACE_MS = 30 * 1000
const PORT_TIMEOUT_MS = 15000
const FETCH_TIMEOUT_MS = 2000

// /json/list 打桩文件：测试用它代替真实 HTTP，验证 type 过滤而不必起浏览器
const LIST_FILE = 'json-list.json'

const BASE_ARGS = [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-sync', '--no-pings', '--mute-audio',
  '--remote-allow-origins=*',
]

// 会破坏隔离或保护语义，禁止经 extraArgs 注入
const FORBIDDEN = [
  '--user-data-dir', '--remote-debugging-port', '--headless',
  '--disable-features', '--enable-features',
]

const FORBIDDEN_FEATURE_RE = /^[A-Za-z][A-Za-z0-9_]*$/

const sleep = ms => new Promise(r => setTimeout(r, ms))

const EDGE_CANDS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

function chromeCandidates(allowEdge) {
  return [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ...(allowEdge ? EDGE_CANDS : []),
  ]
}

function findChrome(allowEdge, cands = chromeCandidates(allowEdge)) {
  const hit = cands.find(p => existsSync(p))
  if (!hit) {
    throw new Error(allowEdge
      ? '找不到 Chrome 或 Edge'
      : '找不到 Chrome（Edge 请显式传 allowEdge: true —— 实测 Edge 上 OptimizationHints 只减半不减到 6MB，不能当等价兜底）')
  }
  return hit
}

function dirBytes(dir) {
  let n = 0
  const walk = d => {
    let ents
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = join(d, e.name)
      try {
        if (e.isDirectory()) walk(p)
        else n += statSync(p).size
      } catch {}
    }
  }
  walk(dir)
  return n
}

function warnIfTmpHuge(tmp) {
  if (!existsSync(tmp)) return
  const n = dirBytes(tmp)
  if (n > TMP_WARN_BYTES) {
    console.warn(`[chrome.mjs] 警告：.tmp 已 ${(n / 1048576).toFixed(1)}MB（阈值 ${TMP_WARN_BYTES / 1048576}MB）`)
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

// rename 探锁：能被抢走锁 ⇒ 没有活进程持有（0ms，不依赖 tasklist/CimInstance）
function udIsFree(dir) {
  const probe = dir + '.probing'
  try {
    renameSync(dir, probe)
    renameSync(probe, dir)
    return true
  } catch {
    try { if (existsSync(probe) && !existsSync(dir)) renameSync(probe, dir) } catch {}
    return false
  }
}

function gcOrphans(lab, graceMs = ORPHAN_GRACE_MS) {
  if (!existsSync(lab)) return []
  const now = Date.now()
  const removed = []
  for (const name of readdirSync(lab)) {
    if (!name.startsWith('ud-')) continue
    const dir = join(lab, name)
    // 目录名自带 pid：ud-<pid>-<rand>
    const m = /^ud-(\d+)-/.exec(name)
    if (m && pidAlive(Number(m[1]))) continue
    let st
    try { st = statSync(dir) } catch { continue }
    // Windows 的 mtime 精度高于 Date.now()（亚毫秒），刚建的目录 now - mtimeMs 可能为负（实测 -9.2ms）。
    // 年龄不可能为负，钳到 0；否则 graceMs=0（本意「完全不宽限」）会因负差值被判成「还在宽限期」而失效。
    const age = Math.max(0, now - st.mtimeMs)
    if (age < graceMs) continue
    if (!udIsFree(dir)) continue
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); removed.push(name) } catch {}
  }
  return removed
}

async function probeVersion(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    return r.ok
  } catch { return false }
}

async function waitForPort(ud, timeoutMs = PORT_TIMEOUT_MS) {
  const f = join(ud, 'DevToolsActivePort')
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(f)) {
      let lines
      try { lines = readFileSync(f, 'utf8').split('\n').map(s => s.trim()).filter(Boolean) } catch { lines = [] }
      if (lines.length >= 2 && Number(lines[0]) > 0 && lines[1].startsWith('/devtools/')) {
        const port = Number(lines[0])
        if (await probeVersion(port)) return { port, browserPath: lines[1] }
      }
    }
    await sleep(50)
  }
  throw new Error(`DevToolsActivePort 超时：${f}`)
}

async function listTargets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  return r.json()
}

/**
 * 取排序后的 target 列表：可操作的 page 在前（file:/data:/about: 最优先）。
 * @param {{ httpBase: string, listFile?: string }} src  listFile 给了就读它代替 HTTP（测试用）
 */
export async function fetchTargets(src) {
  let list = []
  if (src.listFile) {
    try { list = JSON.parse(readFileSync(src.listFile, 'utf8')) } catch { list = [] }
  } else {
    try { list = await listTargets(new URL(src.httpBase).port) } catch { list = [] }
  }
  const rank = t => (t.type === 'page' ? (/^(file|data|about):/.test(t.url || '') ? 0 : 1) : 2)
  return [...list].sort((a, b) => rank(a) - rank(b))
}

/**
 * @param {object} opts
 * @param {string}   [opts.url='about:blank']
 * @param {string[]} [opts.extraArgs=[]]       额外命令行参数（禁 user-data-dir / remote-debugging-port / headless / *-features）
 * @param {string[]} [opts.extraFeatures=[]]   追加到 --disable-features 的 feature 名
 * @param {boolean}  [opts.allowEdge=false]    允许回落到 Edge（不等价，见 findChrome）
 * @param {string}   [opts.root]               仓库根（缺省为本文件上两级）；测试用来指向独立目录
 * @param {string}   [opts.chromePath]         直接指定浏览器 exe（缺省 findChrome 探测）
 * @param {object}   [opts.pageWsOpts]         透传给 pageWsOf 的选项（仅测试注入 listFile）
 */
export async function launch(opts = {}) {
  const {
    url = 'about:blank',
    extraArgs = [],
    extraFeatures = [],
    allowEdge = false,
    root = process.env.CK_CHROME_ROOT || REPO_ROOT,
    chromePath: chromePathOpt,
    pageWsOpts = {},
  } = opts

  if (typeof url !== 'string' || url.startsWith('--')) {
    throw new Error(`url 非法：${url}（以 -- 开头会被 Chrome 当成开关）`)
  }
  if (!Array.isArray(extraArgs)) throw new Error(`extraArgs 必须是数组：${extraArgs}`)
  if (!Array.isArray(extraFeatures)) throw new Error(`extraFeatures 必须是数组：${extraFeatures}`)
  for (const a of extraArgs) {
    if (typeof a !== 'string' || !a.startsWith('--')) throw new Error(`extraArgs 只接受开关：${a}`)
    const bad = FORBIDDEN.find(f => a === f || a.startsWith(f + '='))
    if (bad) throw new Error(`extraArgs 不许包含 ${bad}（feature 请用 extraFeatures，其余由本模块托管）`)
  }
  for (const f of extraFeatures) {
    if (typeof f !== 'string' || !FORBIDDEN_FEATURE_RE.test(f)) throw new Error(`extraFeatures 项非法：${f}`)
  }

  const tmp = join(resolve(root), '.tmp')
  const lab = join(tmp, 'lab-chrome')

  const chromePath = chromePathOpt || findChrome(allowEdge)

  mkdirSync(lab, { recursive: true })
  let orphans = []
  try { orphans = gcOrphans(lab) } catch {}
  try { warnIfTmpHuge(tmp) } catch {}

  const ud = join(lab, `ud-${process.pid}-${randomBytes(4).toString('hex')}`)
  mkdirSync(ud, { recursive: true })

  const features = [...new Set(['OptimizationHints', ...extraFeatures])]
  const args = [
    ...BASE_ARGS,
    `--user-data-dir=${ud}`,
    '--remote-debugging-port=0',
    `--disable-features=${features.join(',')}`,
    ...extraArgs,
    url,
  ]

  const nDisable = args.filter(a => a.startsWith('--disable-features')).length
  if (nDisable !== 1) throw new Error(`内部错误：--disable-features 出现 ${nDisable} 次`)

  const child = spawn(chromePath, args, { stdio: 'ignore' })
  child.on('error', () => {})

  const handles = []
  let finished = false
  const detach = () => {
    finished = true
    for (const [ev, fn] of handles) process.removeListener(ev, fn)
  }
  // SIGINT 监听会取消 Node 默认退出行为，必须自己杀干净再退出。
  // onSignal 里能做同步 killTree + rmSync（实测有效）。
  const onSignal = (code) => {
    if (finished) return
    detach()
    killTree(child.pid)
    try { rmSync(ud, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch {}
    process.exit(code)
  }
  // 注意：`exit` 阶段**不能**再起子进程。实测 `execFileSync('taskkill')` 在 exit 里
  // 耗时 85ms 后抛异常（事件循环已停），所以这里只做能同步完成的 killTree 尝试，
  // 且它不可靠 —— 真正的清理必须由调用方 close() 完成，不能指望这条监听器。
  const onExit = () => {
    if (finished) return
    finished = true
    try { killTree(child.pid) } catch {}
  }
  handles.push(['exit', onExit], ['SIGINT', () => onSignal(130)], ['SIGTERM', () => onSignal(143)])
  for (const [ev, fn] of handles) process.once(ev, fn)

  let port, browserPath
  try {
    ({ port, browserPath } = await waitForPort(ud))
  } catch (e) {
    detach()
    killTree(child.pid)
    await sleep(300)
    try { rmSync(ud, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch {}
    throw e
  }

  const httpBase = `http://127.0.0.1:${port}`
  const browserWsUrl = `ws://127.0.0.1:${port}${browserPath}`

  return {
    child,
    pid: child.pid,
    port,
    ud,
    lab,
    chromePath,
    args,
    orphans,
    httpBase,
    // 浏览器级端点：只能发 Target.* / Browser.*；操作 DOM 请用 pageWs()
    browserWsUrl,
    // pageWsOpts 仅供测试注入打桩 list；生产调用不传
    async pageWs() { return await pageWsOf(httpBase, pageWsOpts) },
    _detach: detach,
  }
}

export async function pageWsOf(httpBase, opts = {}) {
  const { listFile, timeoutMs = 15000 } = opts
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const page = (await fetchTargets({ httpBase, listFile })).find(t => t.type === 'page' && t.webSocketDebuggerUrl)
    if (page) return page.webSocketDebuggerUrl
    if (listFile) break
    await sleep(50)
  }
  throw new Error(`找不到 type=page 的 target（${httpBase}/json/list）`)
}

function killTree(pid) {
  if (!pid) return
  try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
}

/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */
function killByUserDataDir(ud) {
  if (!ud) return 0
  let pids = []
  try {
    // PowerShell 单引号字符串里，单引号要双写
    const esc = ud.replace(/'/g, "''")
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | `
      + `Where-Object { $_.CommandLine -like '*${esc}*' } | ForEach-Object { $_.ProcessId }`,
    ], { encoding: 'utf8' })
    pids = out.split(/\s+/).filter(Boolean)
  } catch { return 0 }
  if (!pids.length) return 0
  // 逐个杀，不带 /T：这些 pid 本来就是同一棵树的成员，树关系已断时逐个更可靠
  const args = []
  for (const p of pids) args.push('/PID', p)
  try { execFileSync('taskkill.exe', [...args, '/F'], { stdio: 'ignore' }) } catch {}
  return pids.length
}

export { killByUserDataDir }

/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


/**
 * 按 `--user-data-dir=<ud>` 精确查出所有 chrome 进程并逐个杀掉，返回杀到的数量。
 *
 * **为什么必须有这个**：`taskkill /PID <child.pid> /T` 只杀 Node `spawn()` 出来的「启动器」进程；
 * 真正的 Chrome 主进程是它的**子进程**，pid 不是同一个。启动器先退出后 `/T` 的父子关系断裂，
 * 主进程和它的 crashpad/gpu/utility/renderer 子进程全部活下来并占住 profile 目录
 * → `rmSync(ud)` 一直 EPERM → ud 删不掉。
 *
 * 实测一次 launch 的进程树：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 *
 * 只匹配本 ud 的绝对路径，绝不会碰到用户自己的浏览器窗口。
 */


export async function close(handle) {
  if (!handle) return
  try { if (typeof handle._detach === 'function') handle._detach() } catch {}

  const ud = handle.ud

  // ① 先按 pid 树杀一遍（快路径）
  killTree(handle.child && handle.child.pid)
  // child.kill() 只杀启动器，Windows 上子进程仍可能持有 profile
  await sleep(200)
  // ② 启动器退出后树关系已断，按 ud 精确补刀 —— 这是 close() 能真正清干净的关键
  //    注意：起一次 powershell 实测约 3.4 秒，所以只查一次，不在重试循环里反复调
  const killed = killByUserDataDir(ud)

  // ③ 删目录：句柄释放有一小段窗口（实测 EPERM），退避重试
  //    这里不再重复查进程（太贵）；多数情况下第 ② 步已经杀净
  for (let i = 0; i < 10; i++) {
    if (!existsSync(ud)) return
    try { rmSync(ud, { recursive: true, force: true }) } catch {}
    if (!existsSync(ud)) return
    await sleep(150)
  }
  // 还没删掉：说明又有进程起来了，做最后一次精确补刀
  if (killed >= 0) killByUserDataDir(ud)
  for (let i = 0; i < 5; i++) {
    if (!existsSync(ud)) return
    try { rmSync(ud, { recursive: true, force: true }) } catch {}
    if (!existsSync(ud)) return
    await sleep(200)
  }
  // 清理失败不应把「探针成功」变成「探针失败」，留给下次 gcOrphans
  console.warn(`[chrome.mjs] 警告：profile 目录删不掉，已留给 gcOrphans 收拾：${ud}`)
}

export { findChrome, chromeCandidates, dirBytes, gcOrphans, waitForPort, pidAlive, LIST_FILE }

export default { launch, close }

/* ── 命令行形态：给 .tmp 下的一次性探针用 ───────────────────────────────── */
if (process.argv[1] && process.argv[1].endsWith('chrome.mjs')) {
  const argv = process.argv.slice(2)
  const urlArg = (argv.find(a => a.startsWith('--url=')) || '').slice(6)
    || (argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'about:blank')
  const asJson = argv.includes('--json')
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法: node scripts/lab/chrome.mjs --url <url> [--json]')
    console.log('输出 JSON: {"pid":..,"port":..,"httpBase":..,"browserWsUrl":..,"pageWsUrl":..,"ud":..}')
    console.log('退出后进程仍在，请自行 taskkill /PID <pid> /T /F 并删除 ud')
    process.exit(0)
  }
  const h = await launch({ url: urlArg })
  const pageWsUrl = await h.pageWs()
  const out = {
    pid: h.child.pid,
    port: h.port,
    httpBase: h.httpBase,
    browserWsUrl: h.browserWsUrl,
    pageWsUrl,
    ud: h.ud,
  }
  console.log(asJson ? JSON.stringify(out) : JSON.stringify(out, null, 2))
}