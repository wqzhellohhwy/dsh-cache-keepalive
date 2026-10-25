/**
 * 前缀骤降（压缩 / 裁剪）判定测试 —— 不需要网络、不花钱。
 * 跑法：node tests/ttl.test.mjs
 *
 * `adaptInterval` 与 `ADAPT_*` 已由用户要求删除（见 `src/ttl.ts` 文件头与 `store.ts` 的
 * `delete merged.autoAdapt`），故只保留 `isCompactionDrop` 的用例。
 */
import { isCompactionDrop } from '../src/ttl.ts'

let pass = 0
let fail = 0
const lines = []

// ── 压缩检测 ──────────────────────────────────────────────────────────
const dropCases = [
  ['prompt 从 400k 掉到 60k → 判定为压缩', 400_000, 60_000, true],
  ['prompt 从 400k 掉到 200k（正好一半）→ 不算压缩', 400_000, 200_000, false],
  ['prompt 从 100k 长到 120k → 不算压缩', 100_000, 120_000, false],
  ['首次保温（无上一步）→ 不算压缩', 0, 82_000, false],
  ['本次为 0（异常）→ 不算压缩', 400_000, 0, false],
]
for (const [name, prev, cur, expect] of dropCases) {
  const got = isCompactionDrop(prev, cur)
  const ok = got === expect
  if (ok) pass++
  else fail++
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        期望 ${expect} 实际 ${got}`}`)
}

console.log('=== 前缀骤降判定测试 ===')
console.log(lines.join('\n'))
console.log('')
console.log(`通过 ${pass} / ${pass + fail}` + (fail > 0 ? `   ❌ 失败 ${fail}` : '   ✅ 全绿'))
process.exit(fail > 0 ? 1 : 0)
