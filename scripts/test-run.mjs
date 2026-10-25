/**
 * 安全跑测试的入口：`npm test`。
 *
 * ## 为什么存在
 * 直接 `node --test` 跑全仓时，`tests/chrome-real.test.mjs` 的失败路径会泄漏：
 * 每个用例起一个 headless Chrome（9 个进程）+ 一份 profile，断言失败就跳过 `close()`，
 * 于是 `.tmp` 一次涨十几到几十 MB、chrome 进程堆到几十个。实测 70 个残留目录 ×116MB
 * 把整机内存顶爆过两次。清理不能靠「记得清」，得让默认入口自己清。
 *
 * ## 做法
 * 1. 先清一遍旧残留（可能是上次中断留下的）；
 * 2. 跑 `node --test`（参数透传，例如 `node scripts/test-run.mjs tests/chrome-real.test.mjs`）；
 * 3. **无论成败**都清：删 `.tmp/ck-*` + 杀「命令行含本仓库路径的 chrome」；
 * 4. 把测试的退出码原样返回。
 *
 * 只杀命令行里含**本仓库路径**的 chrome —— 用户自己开的浏览器窗口不会被动。
 *
 * ## 显式逃逸口
 * `CK_NO_CLEAN=1 npm test` —— 跳过所有清理，仅用于排查「到底是哪一步在泄漏」。
 */
import { spawn, execFileSync } from 'node:child_process'
import { readdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, '.tmp')
const NO_CLEAN = process.env.CK_NO_CLEAN === '1'

/** 命令行里含本仓库路径的 chrome pid。 */
function chromePids() {
  try {
    const esc = ROOT.replace(/'/g, "''")
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | `
      + `Where-Object { $_.CommandLine -like '*${esc}*' } | ForEach-Object { $_.ProcessId }`,
    ], { encoding: 'utf8' })
    return out.split(/\s+/).filter(Boolean)
  } catch { return [] }
}

/** 删 .tmp/ck-*；删不掉（EPERM）就重试几轮，每轮先杀占用的 chrome。 */
function cleanTmp() {
  if (!existsSync(TMP)) return
  for (let round = 0; round < 3; round++) {
    let ck = []
    try {
      ck = readdirSync(TMP, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.startsWith('ck-'))
        .map(e => e.name)
    } catch { return }
    if (!ck.length) return
    for (const name of ck) {
      try { rmSync(join(TMP, name), { recursive: true, force: true }) } catch {}
    }
    // 还有残留 → 杀 chrome 再试
    const left = ck.filter(n => existsSync(join(TMP, n)))
    if (!left.length) return
    killChrome()
    const until = Date.now() + 600
    while (Date.now() < until) { /* 等句柄释放 */ }
  }
}

function killChrome() {
  const pids = chromePids()
  if (!pids.length) return 0
  // 逐个杀（不带 /T：实测启动器退出后树关系会断，逐个更可靠）
  const args = []
  for (const p of pids) args.push('/PID', p)
  try { execFileSync('taskkill.exe', [...args, '/F'], { stdio: 'ignore' }) } catch {}
  return pids.length
}

function report(phase) {
  let ck = 0
  try {
    ck = readdirSync(TMP, { withFileTypes: true }).filter(e => e.isDirectory() && e.name.startsWith('ck-')).length
  } catch {}
  const n = chromePids().length
  console.log(`[test-run] ${phase}：ck-* 目录 ${ck} 个，本仓库 chrome ${n} 个`)
}

if (!NO_CLEAN) {
  // 开工前先清，避免上次中断的残留干扰
  cleanTmp()
  killChrome()
}

const extra = process.argv.slice(2)
const args = ['--test', ...extra]
console.log(`[test-run] 执行: node ${args.join(' ')}`)
if (NO_CLEAN) console.log('[test-run] CK_NO_CLEAN=1 → 跑完不清理')

const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: ROOT })

function finish(code) {
  if (!NO_CLEAN) {
    cleanTmp()
    killChrome()
    report('收尾')
  }
  process.exit(code == null ? 1 : code)
}

child.on('error', (e) => {
  console.error('[test-run] 启动 node --test 失败:', e.message)
  finish(1)
})
child.on('exit', (code, signal) => {
  if (signal) console.error(`[test-run] 测试被信号 ${signal} 终止`)
  finish(code)
})
