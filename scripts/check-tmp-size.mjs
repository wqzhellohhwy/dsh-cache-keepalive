/**
 * 静态检查：仓库 .tmp 是否超预算。
 *
 * 阈值 200MB。实测一轮完整回归（node --test + --lab run + ui-cols）只涨 4~7MB，
 * 20 倍余量不误报；而事故量级是 18GB，能在爆掉 90 倍前发现。
 *
 * ⚠️ **跑全套 `node --test` 之后本项常会红**：`tests/chrome-real.test.mjs` 每条用例会往仓库
 * `.tmp/ck-real-*` 与 `.tmp/ck-ch-*` 留约 100MB（headless chrome 的 user-data-dir），
 * 且**进程未必退出**（占着文件删不掉）。这与交付代码无关，是**顺序污染**。
 * 看本项结论前先：① 结束 `--user-data-dir` 指向本仓库 `.tmp` 的 chrome 进程；
 * ② 按 [KB]\DSH工具集\tmp-junction-safe-clean.md 的方式清掉 `.tmp/ck-*`。
 * 单独跑 `node scripts/check-tmp-size.mjs` 才是干净信号。
 *
 * 为什么单列这个检查：18GB 是「没人看」才长起来的。它不依赖任何 Chrome 参数正确性，
 * 即使 chrome.mjs 全错也照样能兜住。
 *
 * 用法：node scripts/check-tmp-size.mjs [--limit=MB] [--root=<仓库根>]
 * 退出码：0 未超 / 1 超预算 / 2 参数错
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_LIMIT_MB = 200

/**
 * `existsSync` 对**任何** stat 错误都返回 false —— 包括杀软/索引器瞬时占用造成的
 * `EPERM` / `EBUSY` / `EACCES`。实测：新建目录后紧接着探测，约 **1/44 次**误判为「不存在」，
 * 于是 `--root` 明明在也报「--root 不存在」并 exit 2，把「超限应 exit 1」的用例打成 flaky。
 * 这里对**可重试错误**短退让重试，只有确认是「真不存在」（ENOENT）才判 false。
 */
function pathExists(p) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (existsSync(p)) return true
    try {
      statSync(p)
      return true
    } catch (error) {
      const code = error && error.code
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'UNKNOWN') {
        const until = Date.now() + 10 * (attempt + 1)
        while (Date.now() < until) { /* 退让重试 */ }
        continue
      }
      return false
    }
  }
  return false
}

function measure(dir) {
  let bytes = 0
  let files = 0
  const walk = d => {
    let ents
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = join(d, e.name)
      try {
        if (e.isDirectory()) walk(p)
        else { bytes += statSync(p).size; files++ }
      } catch {}
    }
  }
  walk(dir)
  return { bytes, files }
}

/**
 * 单遍遍历 .tmp：每个顶层子目录只走一次，顺带汇总出总量。
 * @param {string} tmp .tmp 绝对路径
 */
export /**
 * 数「命令行含本仓库路径」的 headless chrome 进程。
 * 只匹配本项目路径，绝不把用户自己的浏览器算进来。
 * 取不到就返回 0（诊断信息不该让检查本身失败）。
 */
function countHeadlessChrome() {
  try {
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '\\')
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | `
      + `Where-Object { $_.CommandLine -like '*${repo}*' }).Count`,
    ], { encoding: 'utf8' })
    return Number(out.trim()) || 0
  } catch { return 0 }
}

export function measureTmp(tmp) {  const tops = []
  let bytes = 0
  let files = 0
  for (const e of readdirSync(tmp, { withFileTypes: true })) {
    const p = join(tmp, e.name)
    if (e.isDirectory()) {
      const m = measure(p)
      tops.push({ name: e.name, ...m })
      bytes += m.bytes
      files += m.files
    } else {
      try { bytes += statSync(p).size; files++ } catch {}
    }
  }
  tops.sort((a, b) => b.bytes - a.bytes)
  return { bytes, files, tops }
}

function main() {
  const argv = process.argv.slice(2)
  const bad = argv.find(a => !a.startsWith('--limit=') && !a.startsWith('--root='))
  if (bad !== undefined) {
    console.log(`[check-tmp-size] 未知参数：${bad}（只接受 --limit=<MB> 与 --root=<仓库根>）`)
    return 2
  }

  const limitArg = argv.find(a => a.startsWith('--limit='))
  const LIMIT_MB = limitArg ? Number(limitArg.slice(8)) : DEFAULT_LIMIT_MB
  if (!Number.isFinite(LIMIT_MB) || LIMIT_MB <= 0) {
    console.log('[check-tmp-size] --limit 必须是正数（MB）')
    return 2
  }

  const rootArg = argv.find(a => a.startsWith('--root='))
  const root = rootArg ? rootArg.slice(7) : join(dirname(fileURLToPath(import.meta.url)), '..')
  if (!pathExists(root)) {
    console.log(`[check-tmp-size] --root 不存在：${root}`)
    return 2
  }

  const TMP = join(root, '.tmp')
  if (!pathExists(TMP)) {
    console.log('[check-tmp-size] .tmp 不存在，无需检查')
    return 0
  }

  const total = measureTmp(TMP)
  const totalMB = total.bytes / 1048576

  console.log(`[check-tmp-size] .tmp = ${totalMB.toFixed(2)}MB / ${total.files} 文件（阈值 ${LIMIT_MB}MB）`)
  console.log('  最大 5 个子目录：')
  for (const t of total.tops.slice(0, 5)) {
    console.log(`    ${t.name.padEnd(38)} ${(t.bytes / 1048576).toFixed(2).padStart(8)}MB  ${t.files} 文件`)
  }

  if (totalMB > LIMIT_MB) {
    console.log(`FAIL .tmp 超预算 ${(totalMB - LIMIT_MB).toFixed(2)}MB`)
    // 一眼定位「是不是 chrome-real 的失败路径泄漏」：占用的 chrome + 最大的 .tmp 子目录
    console.log(`  占用中的 headless chrome: ${countHeadlessChrome()} 个`)
    console.log('  最大 .tmp 目录: ' + total.tops.slice(0, 5)
      .map(t => `${t.name}(${(t.bytes / 1048576).toFixed(1)}MB)`).join(', '))
    const ck = total.tops.filter(t => t.name.startsWith('ck-')).length
    if (ck > 0) {
      console.log(`  其中 ck-* 目录 ${ck} 个 —— 这种目录是测试的临时根，残留说明有测试没清干净`)
    }
    console.log('  提示：全仓 node --test 会因 chrome-real 的失败路径泄漏约 116MB/次 + 大量 chrome 进程；')
    console.log('        跑完先清 ck-* 与 chrome，再跑 check-tmp-size（或直接用 npm test，它自带清理）。')
    console.log('  修法：先断 junction 再删 —— 见 [KB]\\DSH工具集\\tmp-junction-safe-clean.md')
    console.log('        或 pwsh -File [KB]\\可复用工具\\补丁与取证\\tmp-junction-safe-clean\\clean-tmp.ps1 -Repo <仓库>')
    return 1
  }

  console.log('OK 在预算内')
  return 0
}

if (process.argv[1] && process.argv[1].endsWith('check-tmp-size.mjs')) {
  process.exit(main())
}
