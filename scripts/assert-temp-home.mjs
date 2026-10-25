/**
 * 测试脚本护栏：**绝不允许写真实 home**。
 *
 * 事故（2026-10-19 23:11）：在别人的快照目录里跑测试时 `DSH_HOME` 没设 →
 * `statePath()` 落到真实 `~/.dsh` → 覆盖了用户的 `state.json`（账本 + 设置全丢）。
 *
 * 用法：任何会**写盘**的测试脚本，在 `statePath()` 之后、写之前调一次：
 *
 *     import { assertNotRealHome } from './assert-temp-home.mjs'
 *     assertNotRealHome(statePath())
 *
 * 命中真实 home → 打印诊断并 `exit 3`（跳过/失败要能区分，所以不用 1）。
 * 显式 `--allow-real`（或 `opts.allowReal`）可放行，但会打警告。
 */
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'

export function assertNotRealHome(statePath, opts = {}) {
  const realHome = resolve(homedir(), '.dsh')
  const target = resolve(String(statePath))
  const allowReal = opts.allowReal === true || process.argv.includes('--allow-real')
  if (allowReal) {
    console.warn('[guard] 已按 --allow-real 放行真实 home：' + target)
    return true
  }
  if (target === realHome || target.startsWith(realHome + sep)) {
    console.error('')
    console.error('❌ 拒绝执行：这个脚本会写**真实** home，测试必须用临时目录')
    console.error('   statePath = ' + target)
    console.error('   DSH_HOME  = ' + (process.env.DSH_HOME ?? '（未设 → 会落到真实 home）'))
    console.error('   正确做法：把 DSH_HOME 指到仓库下的 .tmp/ 或系统临时目录，例如')
    console.error('     DSH_HOME=<repo>/.tmp/try-1 node scripts/<脚本>.mjs')
    console.error('   确实要写真实 home 时才加 --allow-real。')
    console.error('')
    process.exit(3)
  }
  return true
}
