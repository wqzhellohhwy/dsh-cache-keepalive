#!/usr/bin/env node
/**
 * 虚拟环境入口：造世界 → 跑 16 条不变量 → `ck-lab/1` 报告。
 *
 *   node scripts/lab/run.mjs                    全量（默认基底）
 *   node scripts/lab/run.mjs --lab              叠加 LAB_OVERRIDES 再跑一遍
 *   node scripts/lab/run.mjs --json             机器读（stdout 只有一段 JSON）
 *   node scripts/lab/run.mjs --only=V3,V9       只跑指定不变量
 *   node scripts/lab/run.mjs --scenario=A2-B1-C0  单例复核（打印全字段与所有码，恒退出 0）
 *
 * 零花费、零网络、零 state.json：世界全在内存里建。
 * 退出码：0 无未知红 / 1 有未知红 / 2 环境错误。
 */
import { runAll, inspectScenario } from '../../src/core/lab/invariants.ts'
import { buildReport, exitCodeOf, renderHuman } from '../../src/core/lab/report.ts'

const argv = process.argv.slice(2)
const has = (flag) => argv.some((a) => a === flag || a.startsWith(flag + '='))
const valueOf = (flag) => {
  const hit = argv.find((a) => a.startsWith(flag + '='))
  return hit === undefined ? undefined : hit.slice(flag.length + 1)
}

try {
  const scenario = valueOf('--scenario')
  if (scenario !== undefined) {
    const out = inspectScenario(scenario, has('--lab'))
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
    process.exit(0)
  }

  const only = valueOf('--only')?.split(',').filter((s) => s.trim() !== '')
  const started = Date.now()
  const runs = runAll({ lab: has('--lab'), ...(only === undefined ? {} : { only }) })
  const report = buildReport(runs, { labMode: has('--lab'), elapsedMs: Date.now() - started })

  if (has('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    process.stdout.write(renderHuman(report, { verbose: has('--verbose') }) + '\n')
  }
  process.exit(exitCodeOf(report))
} catch (e) {
  process.stderr.write(`环境错误：${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
  process.exit(2)
}
