/**
 * **全仓「会被求值吃掉的转义」必须为 0**（模板字符串里的单反斜杠）。
 *
 * 为什么是一条独立测试而不是只写在 `panel-resize.test.mjs` 的 R12 里：
 * R12/R13 **只读 `src/panel.ts`**。真实事故有两处、两种表现：
 *  ① `panel.ts` 的 `PANEL_SRC` 写 `/\/` → 求值后 `//` → 内联 script 语法错 → 整页卡「加载中」；
 *  ② `cli/keepalive.mjs` 的 `HELP` 也是模板字符串，里面写反引号会让字符串提前结束 → 整文件语法崩（本轮踩过）。
 * 任何新文件、任何组的模板字符串都可能复现，所以这里扫**全仓**。
 *
 * 扫描器：`scripts/check-escapes.mjs`（自写词法器，能躲注释/字符串/正则，并处理 `${}` 嵌套）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { scanDir, scanText } from '../scripts/check-escapes.mjs'

const ROOT = join(import.meta.dirname, '..')

test('全仓（src/cli/scripts/tests）没有会被求值吃掉的模板转义', () => {
  const { files, hits } = scanDir(ROOT)
  assert.ok(files > 30, '扫描文件数太少，可能 walk 漏了目录：' + files)
  const eaten = hits.filter((h) => h.kind === 'EATEN' || h.kind === 'octal(非法)')
  assert.equal(
    eaten.length,
    0,
    '模板字符串里有会被吃掉的单反斜杠（写正则请用 \\\\，写换行用 \\n）：\n'
      + eaten.slice(0, 10).map((h) => `  ${h.file}:${h.line}  ${h.esc}   …${h.ctx.slice(0, 60)}…`).join('\n'),
  )
})

test('扫描器自检：故意写 \\\\. 必须被检出（否则这条网是空转的）', () => {
  /** 用 String.raw 构造「源码文本」，避免测试文件自己带上会被扫到的模板。 */
  const bad = 'const t = `' + String.raw`/a\.b/` + '`'
  const hits = scanText(bad, 'fixture.ts')
  assert.equal(hits.length, 1, '扫描器没检出 \\. —— 网失效')
  assert.equal(hits[0].kind, 'EATEN')
  assert.equal(hits[0].esc, String.raw`\.`)
})

test('扫描器自检：白名单转义不许误报（\\\\ \\n \\t \\u0001 \\x41 续行）', () => {
  const ok = 'const t = `' + String.raw`a\\b\n\t\u0001\x41` + '`'
  const hits = scanText(ok, 'fixture.ts')
  const eaten = hits.filter((h) => h.kind === 'EATEN')
  assert.equal(eaten.length, 0, '白名单转义被误杀：' + JSON.stringify(hits.map((h) => h.esc)))
})

test('扫描器自检：缺位的 \\u / \\x 也算 EATEN（\\user 会被吃成 user）', () => {
  const halfU = 'const t = `' + String.raw`\user` + '`'
  assert.equal(scanText(halfU, 'f').filter((h) => h.kind === 'EATEN').length, 1)
  const halfX = 'const t = `' + String.raw`\x4` + '`'
  assert.equal(scanText(halfX, 'f').filter((h) => h.kind === 'EATEN').length, 1)
})

test('扫描器自检：注释与普通字符串里的反斜杠不算（只判模板体）', () => {
  const code = [
    '// 注释里写 \\. 不该报',
    "const s = 'a\\.b'",
    'const r = /a\\.b/g',
  ].join('\n')
  assert.equal(scanText(code, 'f').length, 0)
})
