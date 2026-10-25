/**
 * **`refreshModelCatalog` 的调用时机** —— 防的是 `dshHome` 暂时性死区（TDZ）。
 *
 * ## 为什么必须用源码位置断言
 * 这个 bug 在单测里**测不出来**：`refreshModelCatalog` 本身是 async 箭头函数，
 * 同步段（读 `dshHome` 那段）在 `void refreshModelCatalog()` 那一刻就执行，
 * 抛的 `ReferenceError` 被函数体里的 `catch` 吞掉 —— 表现为 `offline` 恒为 `[]`、
 * 面板模型下拉只剩在线那 2 个。**只有真实例启动才会暴露**。
 *
 * 定位方式是 `readFileSync` + 下标比较，**不是 grep 字符串存在性**：
 * 断言的是「调用点位置 > 定义位置」这个**顺序关系**，把调用挪到前面就会红。
 *
 * 跑法：`node --test tests/tdz-catalog.test.mjs`
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SRC = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

/** `apply()` 的源码（从 `export function apply` 到文件尾就够，后面没有别的作用域）。 */
const APPLY_AT = SRC.search(/export\s+function\s+apply\s*\(/u)
const APPLY = APPLY_AT < 0 ? '' : SRC.slice(APPLY_AT)

/** 花括号配平切出 `refreshModelCatalog` 的函数体（按位置切会被函数体内的同名串截断）。 */
function catalogBodyOf(src) {
  const at = src.indexOf('const refreshModelCatalog = async (')
  if (at < 0) return ''
  const open = src.indexOf('{', src.indexOf('=>', at))
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(at, i + 1)
    }
  }
  return ''
}
const CATALOG_BODY = catalogBodyOf(APPLY)

test('T1 apply() 里必须能找到 apply 本体（防止切片失败导致后面全部空转）', () => {
  assert.ok(APPLY_AT > 0, 'src/index.ts 里找不到 `export function apply`')
  assert.ok(APPLY.length > 1000, 'apply() 切片太短，源码结构可能变了')
  assert.ok(APPLY.includes('const dshHome ='), 'apply() 切片里应能看到 dshHome 定义')
})

test('T2 void refreshModelCatalog(...) 必须在 const dshHome 之后（否则 TDZ）', () => {
  const callAt = APPLY.indexOf('void refreshModelCatalog(')
  const defAt = APPLY.indexOf('const dshHome =')
  assert.ok(defAt >= 0, 'apply() 里找不到 `const dshHome =`')
  assert.ok(callAt >= 0, 'apply() 里找不到 `void refreshModelCatalog(` —— 目录就永远不会填')
  assert.ok(
    callAt > defAt,
    `refreshModelCatalog 的调用点（偏移 ${callAt}）必须在 dshHome 定义（偏移 ${defAt}）之后，否则读 dshHome 会撞 TDZ`,
  )
})

test('T3 定时器那处调用也必须读同一个 dshHome（不能又传回外部变量）', () => {
  const timerAt = APPLY.indexOf('setInterval(() => { void refreshModelCatalog(')
  assert.ok(timerAt >= 0, '找不到 5 分钟刷新的 setInterval')
  const defAt = APPLY.indexOf('const dshHome =')
  assert.ok(timerAt > defAt, 'setInterval 那处调用也必须在 dshHome 定义之后')
  assert.ok(
    APPLY.slice(timerAt, timerAt + 120).includes('refreshModelCatalog(dshHome)'),
    'setInterval 里应显式传 dshHome',
  )
})

test('T4 refreshModelCatalog 必须收 home 参数，不能闭包读外层 dshHome', () => {
  assert.ok(CATALOG_BODY !== '', '切不出 refreshModelCatalog 的函数体')
  const decl = CATALOG_BODY.slice(0, CATALOG_BODY.indexOf('=>'))
  assert.ok(/\(\s*home\s*:\s*string\s*\)/u.test(decl), `签名应形如 (home: string)，实际：${decl}`)
  assert.ok(!CATALOG_BODY.includes('loadModelCatalog(dshHome)'), '函数体里不能再读外层 dshHome（TDZ 来源）')
  assert.ok(CATALOG_BODY.includes('loadModelCatalog(home)'), '函数体里应读入参 home')
})

test('T5 读配置失败必须记日志，不能静默 catch', () => {
  const at = CATALOG_BODY.indexOf('loadModelCatalog(home)')
  assert.ok(at > 0, '找不到 loadModelCatalog(home)')
  const guard = CATALOG_BODY.slice(at, at + 400)
  assert.ok(!/catch\s*\{\s*\/\*\s*配置读不了/u.test(guard), '读配置的 catch 不能是空的静默分支 —— TDZ 就是被它吞掉的')
  assert.ok(guard.includes('读 profile 配置的 provider 目录失败'), 'catch 里应 log 一条')
})
