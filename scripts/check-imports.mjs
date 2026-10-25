/**
 * 闸门：**漏掉的导入**。
 *
 * 为什么要有这一个（2026-10-17 实测教训）：在 `index.ts` 里调用了 `econ.ts` 新增的 `costAt`，
 * 但忘了加进 import 列表。三条既有闸门**全绿**却照挂：
 *  - `node --check` 只查语法，不查标识符绑定
 *  - `node --test` 的五套测试没有一个 import `src/index.ts`（它依赖 DSH 运行时）
 *  - `check-real-data.mjs` 只 import econ
 * 实际后果：面板一点时间轴就 500（`ReferenceError: costAt is not defined`），一条数据都看不到。
 *
 * 做法（不需要 TypeScript）：把每个模块的**导出名**收集起来，再看引用方文件里
 * 「用到了某个兄弟模块的导出名，却既没 import 它、本地也没同名声明」→ 报出来。
 *
 * 跑法：`node scripts/check-imports.mjs`（退出码 0 = 无问题）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCAN_DIRS = ['src', 'cli']

/** 递归收集 .ts / .tsx / .mjs 文件。 */
function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'lib' || e.name === '.tmp') continue
      walk(p, out)
    } else if (/\.(ts|tsx|mjs)$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

/**
 * 抹掉注释与字符串（**保留换行**，行号才不会错位）。
 * 不做完美词法分析 —— 目标只是让「注释里提到的名字」不参与判断。
 */
function strip(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i += 1 }
      continue
    }
    if (c === '/' && c2 === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i += 1 }
      out += '  '
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      out += ' '
      i += 1
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { out += '  '; i += 2; continue }
        out += src[i] === '\n' ? '\n' : ' '
        i += 1
      }
      out += ' '
      i += 1
      continue
    }
    out += c
    i += 1
  }
  return out
}

/** 收集一个模块的导出名。 */
function exportsOf(code) {
  const names = new Set()
  const patterns = [
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+class\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+interface\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+type\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+enum\s+([A-Za-z_$][\w$]*)/g,
  ]
  for (const re of patterns) {
    for (const m of code.matchAll(re)) names.add(m[1])
  }
  // export { a, b as c }
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim()
      if (seg === '') continue
      const as = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(seg)
      names.add(as !== null ? as[1] : seg.split(/\s+/)[0])
    }
  }
  return names
}

/** 收集本文件的「本地声明」名（含参数与解构，宁多收不漏收）。 */
function localsOf(code) {
  const names = new Set()
  for (const re of [
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /\binterface\s+([A-Za-z_$][\w$]*)/g,
    /\btype\s+([A-Za-z_$][\w$]*)/g,
    /\benum\s+([A-Za-z_$][\w$]*)/g,
  ]) {
    for (const m of code.matchAll(re)) names.add(m[1])
  }
  // 函数参数（粗收）：(`a`, `b: T`, `c = 1`) 之类的形参名
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?::[^={;]+)?=>/g)) {
    for (const part of m[1].split(',')) {
      const id = /^\s*([A-Za-z_$][\w$]*)/.exec(part)
      if (id !== null) names.add(id[1])
    }
  }
  for (const m of code.matchAll(/\bfunction\s*[A-Za-z_$]*\s*\(([^)]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const id = /^\s*([A-Za-z_$][\w$]*)/.exec(part)
      if (id !== null) names.add(id[1])
    }
  }
  // catch / for-of / 解构
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const id = /^\s*([A-Za-z_$][\w$]*)/.exec(part)
      if (id !== null) names.add(id[1])
    }
  }
  /**
   * 接口 / 类型字面量里的**成员签名**（`  setPolicy(id: string): ...`）。
   * 它们看起来和调用一模一样，收进 locals 才不会被当成「漏导入」误报。
   * 末尾的 `{` 覆盖**对象字面量的方法简写**（`      setSettings(patch) {`），
   * 那既没有返回类型也没有 `?`，只靠前两种会漏。
   */
  for (const m of code.matchAll(/^[ \t]{2,}([A-Za-z_$][\w$]*)\??\s*\([^)]*\)\s*(?::|\?|\{)/gm)) names.add(m[1])
  /**
   * 下面三种是**误报源**（核实员在沙箱里实测过），但当前仓库里没有实例 —— 先收着，免得以后误伤：
   * ① 数组解构 `const [a, b] = ...`（上面只认 `const {`）
   * ② 对象方法简写的形参 `m(ledgerOf: T) { ... }`（没有 function 关键字、没有返回类型）
   * ③ 无括号箭头形参 `x => ...`
   */
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]/g)) {
    for (const part of m[1].split(',')) {
      const id = /^\s*([A-Za-z_$][\w$]*)/.exec(part)
      if (id !== null) names.add(id[1])
    }
  }
  for (const m of code.matchAll(/\(\s*([A-Za-z_$][\w$]*)\s*:/g)) names.add(m[1])
  for (const m of code.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1])
  return names
}

const files = []
for (const d of SCAN_DIRS) walk(join(ROOT, d), files)

const info = new Map()
for (const f of files) {
  const raw = readFileSync(f, 'utf8')
  const code = strip(raw)
  info.set(f, { raw, code, exports: exportsOf(code), locals: localsOf(code) })
}

let problems = 0
for (const [file, me] of info) {
  // 本文件「已经 import 进来的名字」
  const imported = new Set()
  for (const m of me.code.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim()
      if (seg === '') continue
      const as = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(seg)
      imported.add(as !== null ? as[1] : seg.split(/\s+/)[0])
    }
  }
  for (const m of me.code.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) imported.add(m[1])
  // 动态 import 解构：const { a, b } = await import(...)
  for (const m of me.code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import/g)) {
    for (const part of m[1].split(',')) {
      const id = /^\s*([A-Za-z_$][\w$]*)/.exec(part)
      if (id !== null) imported.add(id[1])
    }
  }

  for (const [other, them] of info) {
    if (other === file) continue
    for (const name of them.exports) {
      if (name === 'default' || name.length < 3) continue
      if (imported.has(name) || me.locals.has(name)) continue
      const re = new RegExp('(^|[^.\\w$])' + name.replace(/\$/g, '\\$') + '\\s*[({<]', 'g')
      const hit = re.exec(me.code)
      if (hit === null) continue
      const line = me.code.slice(0, hit.index).split('\n').length
      const srcLine = me.raw.split('\n')[line - 1] ?? ''
      console.log(`${relative(ROOT, file)}:${line}  用到 ${name}（由 ${relative(ROOT, other)} 导出），本文件既没 import 也没本地声明`)
      console.log(`    ${srcLine.trim()}`)
      problems += 1
    }
  }
}

console.log('')
if (problems === 0) {
  console.log('✅ 未发现漏掉的导入')
  process.exit(0)
}
console.log(`❌ ${problems} 处疑似漏掉的导入`)
process.exit(1)
