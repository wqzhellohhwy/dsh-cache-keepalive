/**
 * **模板字符串转义扫描器**：找出「会被求值吃掉」的单反斜杠转义。
 *
 * 为什么需要（2026-10-20 真实事故 ×2）：
 *  - `src/panel.ts` 的 `PANEL_SRC` 是模板字符串，源码写 `/\/` 求值后变成 `//` → 内联 script 语法错误
 *    → 整页卡在「加载中」；
 *  - `cli/keepalive.mjs` 的 `HELP` 也是模板字符串，里面写反引号会让字符串提前结束 → 整文件语法崩。
 *
 * 判定依据是 **JS 规范里模板字符串的转义规则**：白名单之外的单反斜杠会被「吃掉」
 * （`\.` → `.`、`\s` → `s`、`\p` → `p`…），改掉原意却**语法合法**，所以只靠 `new Function` 编译抓不到。
 *
 * 白名单（求值后确定、不算事故）：`\\` `\n` `\t` `\r` `\v` `\f` `\b` `\0` `\xHH` `\uHHHH` 续行。
 * 其余一律 `EATEN`。
 *
 * 用法：`node scripts/check-escapes.mjs [根目录] [--json]`（默认根 = 仓库根）
 * 退出码：有 EATEN → 1（其它类别只统计，不阻断）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 目录跳过：`.tmp` 是各组的临时区，`lib` 是构建产物（旧代码，不该参与源码检查）。 */
const SKIP = new Set(['node_modules', '.git', '.tmp', 'lib', '.output', 'dist'])

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(e.name)) out.push(p)
  }
  return out
}

/** 转义分类（只判模板体内部的反斜杠）。 */
export function escapeKind(ch) {
  if (ch === '\\') return 'doubled'
  if ('ntrvfb0'.includes(ch)) return 'control'
  if (ch === 'x') return 'hex'
  if (ch === 'u') return 'unicode'
  if ('1234567'.includes(ch)) return 'octal(非法)'
  if (ch === '\n' || ch === '\r') return 'lineContinuation'
  return 'EATEN'
}

function consumeRegexFlags(text, i) {
  while (i < text.length && /[a-z]/.test(text[i])) i += 1
  return i
}
const canEndValue = (c) => /[A-Za-z0-9_$)\]]/.test(c)

/**
 * 扫一段源码，返回所有模板体 `{ start, end, raw }`。
 *
 * 自写词法器（无外部依赖）：要躲开注释、单/双引号字符串、正则字面量，
 * 还要正确处理 `${ … }` 嵌套（表达式里可以再套模板）。
 */
export function scanTemplates(text) {
  const out = []
  const stack = []
  let mode = 'code'
  let braceDepth = 0
  let prevSig = ''
  let prevWord = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    const c2 = text[i + 1]
    if (mode === 'lineComment') {
      if (c === '\n') mode = 'code'
      i += 1
      continue
    }
    if (mode === 'blockComment') {
      if (c === '*' && c2 === '/') { mode = 'code'; i += 2; continue }
      i += 1
      continue
    }
    if (mode === 'single' || mode === 'double') {
      if (c === '\\') { i += 2; continue }
      if ((mode === 'single' && c === "'") || (mode === 'double' && c === '"')) { mode = 'code'; prevSig = c }
      i += 1
      continue
    }
    if (mode === 'regex') {
      if (c === '\\') { i += 2; continue }
      if (c === '[') { mode = 'regexClass'; i += 1; continue }
      if (c === '/') { mode = 'code'; prevSig = '/'; i = consumeRegexFlags(text, i + 1); continue }
      if (c === '\n') { mode = 'code'; i += 1; continue }
      i += 1
      continue
    }
    if (mode === 'regexClass') {
      if (c === '\\') { i += 2; continue }
      if (c === ']') mode = 'regex'
      i += 1
      continue
    }
    if (mode === 'template') {
      if (c === '\\') { i += 2; continue }
      if (c === '`') {
        const cur = stack.pop()
        out.push({ start: cur.start, end: i, raw: text.slice(cur.start, i), rawTagged: cur.rawTagged === true })
        mode = stack.length > 0 ? 'template' : 'code'
        prevSig = '`'
        i += 1
        continue
      }
      if (c === '$' && c2 === '{') {
        out.push({ start: stack[stack.length - 1].start, end: i, raw: text.slice(stack[stack.length - 1].start, i), rawTagged: stack[stack.length - 1].rawTagged === true })
        stack[stack.length - 1] = { start: -1, end: i }
        mode = 'code'
        braceDepth = 0
        i += 2
        continue
      }
      i += 1
      continue
    }
    // code
    if (c === '/' && c2 === '/') { mode = 'lineComment'; i += 2; continue }
    if (c === '/' && c2 === '*') { mode = 'blockComment'; i += 2; continue }
    if (c === "'") { mode = 'single'; i += 1; continue }
    if (c === '"') { mode = 'double'; i += 1; continue }
    if (c === '`') {
      /**
       * **`String.raw` 之类的标签模板不做转义处理**，扫它只会误报：
       * `String.raw` 里的 `\.` 求值后仍是字面 `\.`，属于有意写法。
       * 判据：反引号前面紧邻 `.raw` 就跳过该模板体的转义检查（本仓库只有测试用它构造 fixture）。
       */
      const before = text.slice(Math.max(0, i - 12), i)
      stack.push({ start: i + 1, end: -1, rawTagged: /\.raw\s*$/.test(before) })
      mode = 'template'
      i += 1
      continue
    }
    if (c === '{') { braceDepth += 1; i += 1; prevSig = c; continue }
    if (c === '}') {
      if (stack.length > 0 && braceDepth === 0 && stack[stack.length - 1].start < 0) {
        stack[stack.length - 1] = { start: i + 1, end: -1 }
        mode = 'template'
        i += 1
        continue
      }
      braceDepth -= 1
      i += 1
      prevSig = c
      continue
    }
    if (c === '/') {
      if (canEndValue(prevSig)) { i += 1; continue }
      mode = 'regex'
      i += 1
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j += 1
      prevWord = text.slice(i, j)
      prevSig = 'a'
      i = j
      continue
    }
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < n && /[0-9a-fA-FxX_.]/.test(text[j])) j += 1
      prevSig = '0'
      i = j
      continue
    }
    if (!/\s/.test(c)) prevSig = c
    i += 1
  }
  void prevWord
  return out.filter((x) => x.start >= 0 && x.end >= x.start)
}

/**
 * 扫一段源码文本，返回命中列表。
 * @param {string} text 源码
 * @param {string} label 报告用文件名
 */
export function scanText(text, label) {
  const hits = []
  for (const t of scanTemplates(text)) {
    /** `String.raw` 标签模板：里头的反斜杠求值后原样保留，不算事故。 */
    if (t.rawTagged === true) continue
    const raw = t.raw
    for (let k = 0; k < raw.length; k += 1) {
      if (raw[k] !== '\\') continue
      const next = raw[k + 1]
      const kind = escapeKind(next)
      /** `\x` / `\u` 后面必须跟够十六进制位，否则一样会被吃掉（`\user` → `user`）。 */
      let realKind = kind
      if (kind === 'hex' && !/^\\x[0-9a-fA-F]{2}/.test(raw.slice(k, k + 4))) realKind = 'EATEN'
      if (kind === 'unicode' && !/^\\u[0-9a-fA-F]{4}/.test(raw.slice(k, k + 6))) realKind = 'EATEN'
      hits.push({
        file: label,
        line: text.slice(0, t.start + k).split('\n').length,
        esc: '\\' + (next === '\n' ? '⏎' : String(next)),
        kind: realKind,
        ctx: raw.slice(Math.max(0, k - 40), k + 30).replace(/\n/g, '⏎'),
      })
      if (next === '\\') k += 1
    }
  }
  return hits
}

/** 扫整个目录（跳过 `.tmp` / `node_modules` / `lib` / `.git`）。 */
export function scanDir(root) {
  const files = walk(resolve(root))
  const hits = []
  for (const f of files) {
    let text
    try { text = readFileSync(f, 'utf8') } catch { continue }
    hits.push(...scanText(text, relative(resolve(root), f)))
  }
  return { files: files.length, hits }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const root = process.argv[2] !== undefined && !process.argv[2].startsWith('--')
    ? process.argv[2]
    : join(fileURLToPath(import.meta.url), '..', '..')
  const json = process.argv.includes('--json')
  const { files, hits } = scanDir(root)
  const eaten = hits.filter((h) => h.kind === 'EATEN' || h.kind === 'octal(非法)')
  const byKind = {}
  for (const h of hits) byKind[h.kind] = (byKind[h.kind] ?? 0) + 1
  if (json) {
    process.stdout.write(JSON.stringify({ files, byKind, eaten }, null, 1) + '\n')
  } else {
    process.stdout.write(`扫描 ${files} 个文件；转义分类 ${JSON.stringify(byKind)}\n`)
    for (const h of eaten.slice(0, 40)) {
      process.stdout.write(`  EATEN ${h.file}:${h.line}  ${h.esc}  …${h.ctx.slice(0, 60)}…\n`)
    }
    process.stdout.write(eaten.length === 0 ? '✅ 无「会被吃掉的转义」\n' : `❌ ${eaten.length} 处会被吃掉\n`)
  }
  process.exit(eaten.length === 0 ? 0 : 1)
}
