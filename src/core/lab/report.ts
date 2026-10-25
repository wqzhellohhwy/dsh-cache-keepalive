/**
 * 报告组装 —— `ck-lab/1`（机器读）+ 人读摘要。
 *
 * 失败分两类计数：`knownRed`（已登记在 `scripts/lab/EXPECTED.md` 的当前代码缺陷，不阻断 CI）
 * 与 `unknownRed`（新出现的、必须当场查的）。**退出码只看 `unknownRed`**。
 */
import { KNOWN_RED, type CaseResult, type SuiteRun } from './invariants.ts'

export const SCHEMA = 'ck-lab/1'

export interface SuiteSummary {
  id: string
  name: string
  total: number
  pass: number
  fail: number
  knownRed: number
  failures: CaseResult[]
}

export interface LabReport {
  version: string
  schema: string
  labMode: boolean
  zeroCost: boolean
  elapsedMs: number
  total: number
  pass: number
  fail: number
  knownRed: number
  unknownRed: number
  suites: SuiteSummary[]
}

export function buildReport(runs: SuiteRun[], opts: { labMode: boolean; elapsedMs: number }): LabReport {
  const suites: SuiteSummary[] = runs.map((run) => {
    const failures = run.cases.filter((c) => !c.ok)
    return {
      id: run.id,
      name: run.name,
      total: run.cases.length,
      pass: run.cases.length - failures.length,
      fail: failures.length,
      knownRed: failures.filter((c) => KNOWN_RED.has(c.case)).length,
      failures,
    }
  })
  const total = suites.reduce((s, x) => s + x.total, 0)
  const fail = suites.reduce((s, x) => s + x.fail, 0)
  const knownRed = suites.reduce((s, x) => s + x.knownRed, 0)
  return {
    version: SCHEMA,
    schema: SCHEMA,
    labMode: opts.labMode,
    zeroCost: true,
    elapsedMs: Math.round(opts.elapsedMs),
    total,
    pass: total - fail,
    fail,
    knownRed,
    unknownRed: fail - knownRed,
    suites,
  }
}

/** 退出码：只剩已知红 → 0；有未知红 → 1。 */
export function exitCodeOf(report: LabReport): number {
  return report.unknownRed > 0 ? 1 : 0
}

export function renderHuman(report: LabReport, opts: { verbose?: boolean } = {}): string {
  const lines: string[] = []
  lines.push(`ck-lab/1  labMode=${report.labMode}  ${report.elapsedMs}ms  零花费`)
  for (const s of report.suites) {
    const tag = s.fail === 0 ? 'ok  ' : s.knownRed === s.fail ? 'KNOWN' : 'FAIL'
    lines.push(`${tag.padEnd(5)} ${s.id.padEnd(4)} ${s.name}  ${s.pass}/${s.total}`)
    for (const f of s.failures) {
      const known = KNOWN_RED.has(f.case) ? ' [已知红]' : ''
      lines.push(`        ${f.case}${known}`)
      lines.push(`          期望 ${f.expected}`)
      lines.push(`          实际 ${f.actual}`)
      if (opts.verbose === true) lines.push(`          证据 ${JSON.stringify(f.witness)}`)
    }
  }
  lines.push('')
  lines.push(`合计 ${report.total} 例：通过 ${report.pass}，失败 ${report.fail}（已知红 ${report.knownRed} / 未知红 ${report.unknownRed}）`)
  if (report.unknownRed === 0 && report.knownRed > 0) {
    lines.push('已知红清单见 scripts/lab/EXPECTED.md —— 不修生产代码，等 P1b/P2 处置。')
  }
  return lines.join('\n')
}
