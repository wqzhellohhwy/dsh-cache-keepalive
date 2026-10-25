/**
 * 静态检查：谁在起 headless Chrome，是否绕过了统一入口。
 *
 * 规则：凡 `scripts/`、`tests/`、`cli/` 下的 .mjs/.cjs 同时满足
 *        ① 文本里出现 `--user-data-dir`
 *        ② 自己调用 spawn / execFile / exec 一类启动函数
 *       即判违规（白名单除外）。
 *
 * 只看「有没有 import chrome.mjs」是不够的：同一文件可以先 import 再自己 spawn 一个，
 * 入口形同虚设 —— 这种情况同样违规。
 *
 * 为什么不是「查命令行里有没有 OptimizationHints」：
 *   实测 Chrome 对重复 `--disable-features` 取最后一个。源码里写着 OptimizationHints，
 *   运行时被调用方后传的一条覆盖掉 → 保护失效且无报错。查文本会对此假 PASS。
 *
 * 用法：node scripts/check-probe-chrome.mjs [--root=<仓库根>]
 * 退出码：0 通过 / 1 有违规 / 2 参数错
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF_REL = 'scripts/check-probe-chrome.mjs'
const SCAN_DIRS = ['scripts', 'tests', 'cli']
const SKIP_DIRS = new Set(['node_modules', '.tmp', 'lib', '.git'])
const EXEMPT = new Set([
  // 历史文件，189 断言在守；它 4~7 秒就跑完，下载窗口内来不及落盘。
  // 若将来它运行时长超过 15 秒，必须先补 --disable-features=OptimizationHints 再豁免。
  'scripts/lab/ui-cols.mjs',
  'scripts/lab/chrome.mjs',
])

// 自己起 Chrome 的写法：spawn/execFile/exec 的参数里出现 --user-data-dir
const SPAWN_RE = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(/

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(join(dir, e.name), out)
    } else if (e.name.endsWith('.mjs') || e.name.endsWith('.cjs')) {
      out.push(join(dir, e.name))
    }
  }
  return out
}

function stripComments(src) {
  let out = ''
  let i = 0
  let quote = ''
  if (src.startsWith('#!')) i = src.indexOf('\n') + 1
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (quote) {
      out += c
      if (c === '\\') { out += n ?? ''; i += 2; continue }
      if (c === quote) quote = ''
      else if (c === '\n' && quote !== '`') quote = ''
      i++
      continue
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? src.length : end + 2
      out += ' '
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue }
    out += c
    i++
  }
  return out
}

/**
 * @param {string} root 仓库根
 * @returns {{ files: number, checked: number, exempt: number, violations: string[] }}
 */
export function scan(root) {
  const files = []
  for (const d of SCAN_DIRS) walk(join(root, d), files)

  let checked = 0
  let exempt = 0
  const violations = []

  for (const f of files) {
    const rel = relative(root, f).replace(/\\/g, '/')
    if (rel === SELF_REL) continue
    const raw = readFileSync(f, 'utf8')
    const src = stripComments(raw)
    if (!src.includes('--user-data-dir')) continue
    checked++

    if (EXEMPT.has(rel)) { exempt++; continue }

    const appearsInSpawn = src.split(SPAWN_RE).length > 1
    if (appearsInSpawn) violations.push(rel)
  }
  return { files: files.length, checked, exempt, violations }
}

function main() {
  const argv = process.argv.slice(2)
  const bad = argv.find(a => !a.startsWith('--root='))
  if (bad !== undefined) {
    console.log(`[check-probe-chrome] 未知参数：${bad}（只接受 --root=<仓库根>）`)
    return 2
  }
  const rootArg = argv.find(a => a.startsWith('--root='))
  const root = rootArg ? rootArg.slice(7) : join(dirname(fileURLToPath(import.meta.url)), '..')
  if (!existsSync(root)) {
    console.log(`[check-probe-chrome] --root 不存在：${root}`)
    return 2
  }

  const { files, checked, exempt, violations } = scan(root)
  console.log(`[check-probe-chrome] 扫描 ${files} 个脚本，${checked} 个传递 --user-data-dir（豁免 ${exempt}）`)

  if (violations.length > 0) {
    console.log('FAIL 以下脚本自己 spawn 并传 --user-data-dir：')
    for (const v of violations) console.log(`  ${v}`)
    console.log('  修法：import { launch, close } from \'<相对路径>/scripts/lab/chrome.mjs\'')
    console.log('        或命令行调 node scripts/lab/chrome.mjs --url <url> --json')
    console.log('  只 import 但自己另 spawn 一个同样算违规（入口形同虚设）')
    return 1
  }

  console.log('OK 所有起 Chrome 的地方都走了统一入口')
  return 0
}

if (process.argv[1] && process.argv[1].endsWith('check-probe-chrome.mjs')) {
  process.exit(main())
}
