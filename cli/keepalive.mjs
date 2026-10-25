#!/usr/bin/env node
/**
 * dsh-cache-keepalive —— **独立 CLI**（脱离 DSH 本体也能用）。
 *
 * 本文件是「插件半边」的对等实现：**不启动 DSH、不依赖任何 DSH 插件 API**，
 * 直接读磁盘上的会话日志、离线装配出与真实请求逐字节同源的请求体，然后直连提供方 API 保温。
 *
 * ## 它能干什么
 *   --list                    列出所有会话（标题 / 大小 / 最后活动 / 保温状态）
 *   --dry-run <id>            **只装配不发请求**（自检：看装配出的 system/tools/messages 规模）
 *   --once <id>               对某会话立刻保温一次（真实调用，产生花费）
 *   --loop                    守护循环：按策略自动挑候选并保温（每 60 秒一拍，固定晚插件 90 秒起拍）
 *
 * ## 为什么能脱离 DSH 还保持字节级同源
关键三件事，全部离线复刻、**零 DSH 依赖**：
 *   ① **多帧 zstd 解码**      —— Node 内置 zstd 只解第一帧，见 `core/sessions.ts`
 *   ② **surface / 请求头装配** —— 见 `core/surface.ts`（复刻 `foldSurface` /
 *      `foldRequestHeader` / `deriveEventMessage`，已用本机全部会话与官方实现逐节点比对一致）
 *   ③ **toolHistory**         —— DSH 内部类未导出，见 `core/toolhistory.ts` 的复刻
 *
 * ## 认证
 * 按顺序取：环境变量 `DEEPSEEK_API_KEY` → `$DSH_HOME/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
/**
 * 花钱门禁（**必须在任何 await import 之前**）。
 *
 * 会向 provider 发真实请求的模式：`--once` / `--loop` / `--serve --auto`。
 * 默认拒绝发送；确认后加 `--yes-i-will-pay`（或设 `CK_YES_I_WILL_PAY=1`）。
 * 不花钱的模式（`--dry-run` / `--list` / `--status` / `--lab ...`）不拦。
 * `--lab live` 有自己的 `--yes`，与本开关无关。
 *
 * 这里不用 parseArgs()：它读 DEFAULT_TICK（const，在后面），提前调用会踩 TDZ。
 */
{
  const raw = process.argv.slice(2)
  const has = (x) => raw.includes(x)
  const payMode = has('--once') || has('--loop') || (has('--serve') && has('--auto'))
  const paid = has('--yes-i-will-pay') || process.env.CK_YES_I_WILL_PAY === '1'
  if (payMode && !paid) {
    console.error('拒绝发送：--once / --loop / --serve --auto 会向 provider 发真实请求（花钱）。')
    console.error('确认要付钱后加 --yes-i-will-pay 重跑（或设 CK_YES_I_WILL_PAY=1）。')
    console.error('只想看装配结果、不花钱：node cli/keepalive.mjs --dry-run <id>')
    process.exit(3)
  }
}

/**
 * `--lab`：虚拟不变量实验（**必须放在最前面**）。
 *
 * 两个原因：
 *  - 本文件后面那一大堆 `await import(...)` 与末尾的 `process.exit` 是给保温命令用的，
 *    `--lab` 只要 `src/core/lab/*`（零副作用），提前拦掉最省事；
 *  - `--json` 要求 **stdout 只有一段 `ck-lab/1` JSON**，所有进度/告警必须走 stderr。
 *
 * 子命令：`run`（默认）/ `list` / `doctor`；选项：`--only=V3,V9`、`--json`、`--verbose`。
 * 退出码：`unknownRed > 0 → 1`（已知红不阻断，否则 CI 会因那 3 条已登记缺陷永久红）；环境错误 → 2。
 */
if (process.argv.slice(2).some((a) => a === '--lab' || a.startsWith('--lab='))) {
  const rest = process.argv.slice(2)
  const has = (f) => rest.some((a) => a === f || a.startsWith(f + '='))
  const valueOf = (f) => {
    const hit = rest.find((a) => a.startsWith(f + '='))
    return hit === undefined ? undefined : hit.slice(f.length + 1)
  }
  const labArg = rest.find((a) => a === '--lab' || a.startsWith('--lab='))
  /**
   * 子命令两种写法都支持：`--lab list`（空格）与 `--lab=list`（等号）。
   * 空格形式下，紧跟的非 `--` 开头参数就是子命令；没有则默认 `run`。
   */
  const next = rest[rest.indexOf(labArg) + 1]
  const sub = labArg.includes('=')
    ? labArg.slice(labArg.indexOf('=') + 1)
    : (next !== undefined && !next.startsWith('--') ? next : 'run')
  const json = has('--json')
  /** `--json` 时人类读的东西一律 stderr，保证 stdout 干净。 */
  const log = (...xs) => { if (json) console.error(...xs); else console.log(...xs) }
  const emit = (s) => { process.stdout.write(s + '\n') }

  try {
    const { runAll, SUITES, KNOWN_RED } = await import(pathToUrl(join(SRC, 'core', 'lab', 'invariants.ts')))
    const { SCHEMA, buildReport, exitCodeOf, renderHuman } = await import(pathToUrl(join(SRC, 'core', 'lab', 'report.ts')))

    if (sub === 'list') {
      const rows = SUITES.map((s) => ({ id: s.id, name: s.name }))
      const known = [...KNOWN_RED]
      if (json) emit(JSON.stringify({ schema: SCHEMA, suites: rows, knownRed: known }, null, 2))
      else {
        log('虚拟不变量清单（ck-lab/1）：')
        for (const r of rows) log(`  ${r.id.padEnd(4)} ${r.name}`)
        log(`\n已登记已知红（不阻断退出码，见 scripts/lab/EXPECTED.md）：${known.length} 条`)
        for (const k of known) log(`  ${k}`)
      }
      process.exit(0)
    }

    if (sub === 'doctor') {
      const { existsSync, statSync } = await import('node:fs')
      const zlib = await import('node:zlib')
      const { loadState, statePath, LAB_OVERRIDES } = await import(pathToUrl(join(SRC, 'store.ts')))
      const file = statePath()
      const snap = () => {
        try {
          const st = statSync(file)
          return `${st.mtimeMs}:${st.size}`
        } catch { return 'absent' }
      }
      const before = snap()
      const st = existsSync(file) ? loadState(file) : undefined
      const after = snap()
      const major = Number(process.versions.node.split('.')[0])
      const checks = [
        { id: 'node', ok: major >= 22, detail: `Node ${process.versions.node}（zstd 内置需 ≥ 22，本插件离线解压要用）` },
        { id: 'zstd', ok: typeof zlib.zstdDecompressSync === 'function', detail: 'node:zlib.zstdDecompressSync 可用（多帧解压靠它）' },
        {
          id: 'labMode',
          ok: true,
          detail: st === undefined
            ? 'state.json 不存在（按默认设置跑，等价 labMode=off 基底）'
            : `labMode=${st.settings.labMode === true ? 'on' : 'off'}；LAB_OVERRIDES 会压 intervalSeconds=${LAB_OVERRIDES.intervalSeconds} / freshSeconds=${LAB_OVERRIDES.freshSeconds} / circuitCooldownSeconds=${LAB_OVERRIDES.circuitCooldownSeconds} / maxTouches=${LAB_OVERRIDES.maxTouches}`,
        },
        {
          id: 'stateUntouched',
          ok: before === after,
          detail: `用户 state.json ${before === 'absent' ? '不存在' : '存在'}，读取前后标记 ${before} → ${after}`,
        },
        { id: 'zeroCost', ok: true, detail: '虚拟环境不联网、不发请求、不写 state.json / runtime.json' },
      ]
      if (json) emit(JSON.stringify({ schema: SCHEMA, checks }, null, 2))
      else {
        log('虚拟实验环境自检：')
        for (const c of checks) log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.id.padEnd(14)} ${c.detail}`)
      }
      process.exit(checks.every((c) => c.ok) ? 0 : 1)
    }

    if (sub === 'live') {
      /**
       * `--lab live`：只**登记**，不做任何真实动作 —— 样本体检 / 建沙箱 / 执行全在 `runPendingLive()`。
       * 原因：本块在文件顶部执行，此刻 `assembleSession` / `loadState` 等模块级 const 仍是 TDZ。
       */
      const { join: jn } = await import('node:path')
      const { homedir: hd } = await import('node:os')
      const userHome = jn(hd(), '.dsh')
      const activeHome = process.env.DSH_HOME || userHome
      const runId = valueOf('--run-id') ?? `run-${new Date().toISOString().slice(0, 10)}`
      globalThis.__CK_PENDING_LIVE__ = {
        runId,
        userHome,
        activeHome,
        configFrom: valueOf('--config-from') || activeHome,
        arm: has('--arm'),
        fakeSend: has('--fake-send'),
        yes: has('--yes'),
        json,
      }
      /** 不 exit：让模块继续加载，末尾（所有 import 完成后）执行 `runPendingLive()`。 */
    }
    if (sub === 'report') {
      /**
       * `--lab report [--run=<runId>] [--json]`：读 `.tmp/lab/<runId>/runs/*.jsonl` 汇总。
       * **只读，不清理**。无 `--run` 时取最近一次。
       */
      const { existsSync: rex, readdirSync: rrd, readFileSync: rrf, statSync: rst } = await import('node:fs')
      const { join: rjn } = await import('node:path')
      const labRoot = rjn(HERE, '..', '.tmp', 'lab')
      const runArg = valueOf('--run')
      let runDir = ''
      if (runArg !== undefined && runArg !== '') runDir = rjn(labRoot, runArg)
      else if (rex(labRoot)) {
        const candidates = rrd(labRoot)
          .map((n) => {
            try { return { n, m: rst(rjn(labRoot, n)).mtimeMs } } catch { return { n, m: 0 } }
          })
          .sort((a, b) => b.m - a.m)
        runDir = candidates[0] === undefined ? '' : rjn(labRoot, candidates[0].n)
      }
      const runsDir = runDir === '' ? '' : rjn(runDir, 'runs')
      const files = runsDir !== '' && rex(runsDir) ? rrd(runsDir).filter((x) => x.endsWith('.jsonl')) : []
      if (files.length === 0) {
        process.stderr.write(`没有实验记录（找的是 ${runDir || labRoot}/runs/*.jsonl）\n`)
        process.exit(1)
      }
      const events = []
      for (const file of files) {
        for (const line of rrf(rjn(runsDir, file), 'utf8').split('\n')) {
          if (line.trim() === '') continue
          try { events.push(JSON.parse(line)) } catch { /* 半截行忽略 */ }
        }
      }
      const start = events.find((e) => e.event === 'run-start')
      const pendings = events.filter((e) => e.event === 'pending')
      const updates = events.filter((e) => e.event === 'update')
      const done = updates.filter((u) => u.status === 'done')
      const failed = updates.filter((u) => u.status === 'failed')
      const unknown = failed.filter((u) => u.unknownCost === true)
      const actualCost = done.reduce((s, u) => s + (Number(u.cost) || 0), 0)
      const unknownCost = unknown.reduce((s, u) => s + (Number(u.chargedWorst) || 0), 0)
      const reserved = pendings.reduce((s, p) => s + (Number(p.worst) || 0), 0)
      const avgHit = done.length === 0 ? 0 : done.reduce((s, u) => s + (Number(u.hitRate) || 0), 0) / done.length
      const perLine = pendings.map((p) => {
        const upd = updates.find((u) => u.id === p.id)
        return {
          id: p.sessionId,
          status: upd === undefined ? 'pending' : (upd.status === 'done' ? 'done' : 'failed'),
          worst: Number(p.worst) || 0,
          cost: upd === undefined ? null : (upd.status === 'done' ? Number(upd.cost) || 0 : (upd.unknownCost ? Number(upd.chargedWorst) || 0 : 0)),
          hitRate: upd === undefined ? null : (Number(upd.hitRate) || 0),
          error: upd === undefined ? null : (upd.error ?? null),
        }
      })
      const summary = {
        schema: 'ck-lab/1',
        kind: 'run-report',
        run: runDir.split(/[\\/]/).pop(),
        files: files.length,
        allow: start === undefined ? 0 : (start.allow ?? []).length,
        skipped: start === undefined ? 0 : (start.skipped ?? []).length,
        ran: pendings.length,
        done: done.length,
        failed: failed.length,
        unknownCost: unknown.length,
        actualCost,
        unknownCostCharged: unknownCost,
        totalCost: actualCost + unknownCost,
        reserved,
        reserveVsActual: (actualCost + unknownCost) === 0 ? null : reserved / (actualCost + unknownCost),
        avgHitRate: avgHit,
        rows: perLine,
      }
      if (json) emit(JSON.stringify(summary, null, 2))
      else {
        log('=== --lab report（只读）===')
        log(`运行：${summary.run}  ｜ JSONL 文件 ${summary.files} 个`)
        log(`白名单 ${summary.allow} 条 ｜ 跳过 ${summary.skipped} 条 ｜ 实际尝试 ${summary.ran} 条`)
        log(`成功 ${summary.done} ／ 失败 ${summary.failed}（其中未知花费 ${summary.unknownCost}）`)
        log(`实际花费 ${summary.actualCost.toFixed(6)} 元 ｜ 未知按 worst 计 ${summary.unknownCostCharged.toFixed(6)} 元`
          + ` ｜ 合计 ${summary.totalCost.toFixed(6)} 元`)
        log(`最坏预留合计 ${summary.reserved.toFixed(6)} 元` + (summary.reserveVsActual === null
          ? ''
          : ` ｜ 预留 / 实际 = ${summary.reserveVsActual.toFixed(2)}×`))
        log(`平均命中率 ${(avgHit * 100).toFixed(2)}%`)
        log('')
        for (const r of perLine) {
          const mark = r.status === 'done' ? '✅' : r.status === 'failed' ? '⛔' : '…'
          log(`  ${mark} ${String(r.id).slice(-12)}  预留 ${r.worst.toFixed(6)}`
            + (r.cost === null ? '  未结算' : `  实花 ${r.cost.toFixed(6)}`) 
            + (r.hitRate === null ? '' : `  命中 ${(r.hitRate * 100).toFixed(1)}%`)
            + (r.error === null ? '' : `  ${r.error}`))
        }
        log('')
        log('零请求：只读 JSONL，不发请求、不改任何文件。')
      }
      process.exit(0)
    }

    if (sub === 'verify') {
      /**
       * **G8 防遗留**（只读，不自动清理）：试验模式退出是否干净。
       * 有遗留 → exit 1，列出具体项；干净 → exit 0。
       */
      const { existsSync, readdirSync, statSync } = await import('node:fs')
      const { join: vjn } = await import('node:path')
      const { homedir: vhd } = await import('node:os')
      const { loadState: vLoad, statePath: vPath } = await import(pathToUrl(join(SRC, 'store.ts')))
      const vHome = process.env.DSH_HOME || vjn(vhd(), '.dsh')
      const vFile = vPath()
      const vSt = existsSync(vFile) ? vLoad(vFile) : undefined
      const items = []
      if (vSt !== undefined) {
        if (vSt.settings.labMode === true) items.push({ id: 'labMode', ok: false, detail: '试验模式仍是开启状态（会以 30 秒间隔持续花钱）' })
        else items.push({ id: 'labMode', ok: true, detail: '已退出' })
        if ((vSt.settings.labExpiresAt ?? 0) > 0) items.push({ id: 'labExpiresAt', ok: false, detail: `仍残留 ${new Date(vSt.settings.labExpiresAt).toLocaleString()}` })
        else items.push({ id: 'labExpiresAt', ok: true, detail: '已清' })
        if (vSt.labBackup !== undefined) items.push({ id: 'labBackup', ok: false, detail: '仍残留（上次退出失败，参数可能没还原）' })
        else items.push({ id: 'labBackup', ok: true, detail: '已清' })
        const allow = Array.isArray(vSt.settings.labSessionAllow) ? vSt.settings.labSessionAllow : []
        items.push({
          id: 'allowlist',
          ok: allow.length === 0,
          detail: allow.length === 0 ? '无残留' : `仍有 ${allow.length} 条：${allow.join(', ')}`,
        })
      } else {
        items.push({ id: 'state', ok: true, detail: '没有 state.json（等价未开试验）' })
      }
      /** 影子 home 残留（`.tmp/lab/*`）。 */
      const labRoot = vjn(HERE, '..', '.tmp', 'lab')
      let residue = []
      try {
        residue = readdirSync(labRoot).map((n) => {
          const p = vjn(labRoot, n)
          let size = 0
          try { size = statSync(p).size } catch { size = 0 }
          return { path: p, size }
        })
      } catch { residue = [] }
      items.push({
        id: 'shadowResidue',
        ok: residue.length === 0,
        detail: residue.length === 0
          ? `无残留（${labRoot}）`
          : `${residue.length} 个残留：` + residue.map((r) => r.path).join('、'),
      })
      const bad = items.filter((i) => !i.ok)
      if (json) {
        emit(JSON.stringify({ schema: SCHEMA, ok: bad.length === 0, dshHome: vHome, items }, null, 2))
      } else {
        log('=== --lab verify（只读，不自动清理）===')
        log(`DSH_HOME：${vHome}`)
        for (const i of items) log(`  ${i.ok ? 'ok  ' : 'LEAK'} ${i.id.padEnd(14)} ${i.detail}`)
        log(bad.length === 0 ? '\n无遗留 ✅' : `\n发现 ${bad.length} 项遗留 ❌（清理请手工处理，本命令不改任何东西）`)
      }
      process.exit(bad.length === 0 ? 0 : 1)
    }

    if (sub !== 'run') {
      /** `live --yes` 已登记待办 → 不报错、也不跑 run 分支，让模块继续加载到末尾执行 `runPendingLive`。 */
      if (globalThis.__CK_PENDING_LIVE__ === undefined) {
        log(`未知的 --lab 子命令：${sub}（可用：run / list / doctor / live / verify / report）`)
        process.exit(2)
      }
    } else {
      const only = valueOf('--only')?.split(',').map((s) => s.trim()).filter((s) => s !== '')
      const started = Date.now()
      // 基底固定为"非 lab 模式"（与 scripts/lab/run.mjs 默认一致）；要验试验模式基底请用那个脚本的 `--lab`
      const runs = runAll({ lab: false, ...(only === undefined ? {} : { only }) })
      const report = buildReport(runs, { labMode: false, elapsedMs: Date.now() - started })
      if (json) emit(JSON.stringify(report, null, 2))
      else log(renderHuman(report, { verbose: has('--verbose') }))
      process.exit(exitCodeOf(report))
    }
  } catch (e) {
    process.stderr.write(`lab 环境错误：${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
    process.exit(2)
  }
}

const { listSessions, readRounds, DEFAULT_HEAD_BYTES } = await import(pathToUrl(join(SRC, 'core', 'sessions.ts')))
const { assembleSession, refuseForImages } = await import(pathToUrl(join(SRC, 'core', 'assemble.ts')))
const { readRuntime } = await import(pathToUrl(join(SRC, 'core', 'panel-service.ts')))
const { providerRefusal, warmOffline } = await import(pathToUrl(join(SRC, 'core', 'warm-offline.ts')))
const { loadProviders } = await import(pathToUrl(join(SRC, 'core', 'providers.ts')))
const { readAttachment } = await import(pathToUrl(join(SRC, 'core', 'attachments.ts')))
const { serializeForApi } = await import(pathToUrl(join(SRC, 'core', 'wire.ts')))
const { decideWarm } = await import(pathToUrl(join(SRC, 'gate.ts')))
const { decideCandidates } = await import(pathToUrl(join(SRC, 'core', 'candidates.ts')))
const { buildGateInput } = await import(pathToUrl(join(SRC, 'core', 'gate-input.ts')))
const { costAt, hitRate, normalizePrices, priceForModel, promptTokens, scalePrices, BREAK_CIRCUIT_HIT_RATE } = await import(pathToUrl(join(SRC, 'econ.ts')))
const {
  loadState, saveState, appendLedger, policyOf, ledgerOf, statePath, isTripped,
  cycleOf, cycleSpendOf, touchCountOf, withStateLock,
} =
  await import(pathToUrl(join(SRC, 'store.ts')))
const { labVerdict, labAllowsForward, worstCostOf, promptTokensEstimate, runLabAttempts, stripPricePatch } = await import(pathToUrl(join(SRC, 'core', 'lab', 'guard.ts')))
const { labExpireIfDue } = await import(pathToUrl(join(SRC, 'core', 'settings.ts')))
const { readSessionMeta, metaToRow } = await import(pathToUrl(join(SRC, 'core', 'session-meta.ts')))

function pathToUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/')
}


const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const API_ROOT = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic'
/** 保温请求的输出上限：1 个 token，防跑飞。 */
const WARM_MAX_TOKENS = 1
/** 守护循环的拍间隔（秒）：只扫描 + 过门禁，真正发不发请求由门禁决定。 */
const DEFAULT_TICK = 60
/** 保温请求超时（毫秒）：**必须真用** —— 没有它，一个永不返回的连接会让守护循环永久挂住。 */
const WARM_TIMEOUT_MS = Number(process.env.CK_WARM_TIMEOUT_MS) || 30_000

/**
 * 守护循环**固定晚插件 90 秒起拍**（远小于门禁的 4 小时间隔，足够让插件先记账）。
 *
 * 为什么：插件 tick 与 CLI 守护循环都是 60 秒一拍，起拍同刻就会「两边同一秒各判一次、
 * 两边都通过门禁」→ 同一条会话被保两次（核验员实测：账本 2 条、多花 0.000194 元、窗口 110ms）。
 * **偏移量必须不是拍间隔（60 秒）的整数倍** —— 120 秒 = 2×60 与插件拍**同相位**，
 * 两边会在同一时刻各判一次（都读旧账本 → 都过门禁 → 都发请求），防撞等于没做。
 * 取 90 秒：90 mod 60 = 30，相位恒差 30 秒，落在插件两拍正中间，且足够让插件先写完账本。
 * ⚠️ 后人改这个数时别再改回 60 的倍数。
 * **不引入新机制**，纯靠已有的门禁。
 */
const LOOP_OFFSET_MS = 90_000
/** 锚点新鲜度：runtime.json 的 updatedAt 超过这个年龄就认为插件没在跑（回落成「启动后等满偏移量」）。 */
const LOOP_ANCHOR_MAX_AGE_MS = 10 * 60_000

/**
 * 起拍前要等多久（毫秒）。
 *
 * 有锚点（插件 runtime.json 的 updatedAt，每拍刷新）→ 对齐到「插件上一拍 + 90 秒」之后；
 * 没锚点 / 锚点过期（插件停了或刚重启）→ 直接等满 90 秒。
 */
function loopAnchorDelayMs() {
  try {
    const f = join(DSH_HOME, 'cache-keepalive', 'runtime.json')
    if (!existsSync(f)) return LOOP_OFFSET_MS
    const j = JSON.parse(readFileSync(f, 'utf8'))
    const at = Number(j?.updatedAt)
    if (!Number.isFinite(at) || at <= 0) return LOOP_OFFSET_MS
    const age = Date.now() - at
    if (age < 0 || age > LOOP_ANCHOR_MAX_AGE_MS) return LOOP_OFFSET_MS
    return Math.max(0, LOOP_OFFSET_MS - age)
  } catch {
    return LOOP_OFFSET_MS
  }
}

/**
 * 会话清单：**优先读插件写的元数据缓存**（`sessions.meta.json`，免扫盘）。
 *
 * 缓存缺失 / 过期（>5 分钟）/ 解析失败 → 一律回落 `listSessions()` 自己扫。
 * 缓存里没有 `logFile`，按目录约定拼出来后还要 `existsSync` 验一下（被删的会话不该复活）。
 */
/**
 * 会话清单缓存（P1-2 / P1-3）：`meta` 文件没变就复用，且建 `id→row` 供 O(1) 直查。
 *
 * 之前每次调用都重建 416 条（每条一次 `existsSync`）≈ 52ms，`--loop` 一条候选付一次。
 */
let rowsCache = { sig: "", rows: [], byId: new Map() }

/**
 * **只对「缓存里拼不出路径」的那几条**在磁盘上按目录名找一遍，不整份重扫（P1-3）。
 *
 * 原来 `missing > 0` 就整份 `listSessions()`（137ms → 3672ms，27×）。
 */
function findRowsByDirNames(ids) {
  const want = new Set(ids)
  const out = []
  const root = join(DSH_HOME, "sessions")
  let pkDirs = []
  try { pkDirs = readdirSync(root) } catch { return out }
  for (const pk of pkDirs) {
    let names = []
    try { names = readdirSync(join(root, pk)) } catch { continue }
    for (const n of names) {
      if (!want.has(n)) continue
      const dir = join(root, pk, n)
      const logFile = join(dir, "session.v4.jsonl.zstd")
      try {
        const st = statSync(logFile)
        out.push({
          id: n, projectKey: pk, dir, logFile, title: "", titleSource: "none", cwd: "", createdAt: 0,
          mtime: st.mtimeMs, sizeBytes: st.size, archived: false, pinned: false, origin: "",
        })
        want.delete(n)
      } catch { /* 没有日志文件就跳过 */ }
    }
  }
  return out
}

function loadRows() {
  const meta = readSessionMeta(DSH_HOME)
  if (meta !== undefined) {
    const ids = Object.keys(meta.items)
    /** 缓存键用 `at`（插件每拍刷新）+ 条数：内容变了才重建。 */
    const sig = String(meta.at) + "|" + ids.length
    if (sig === rowsCache.sig) return rowsCache.rows
    const rows = []
    const missing = []
    for (const [id, it] of Object.entries(meta.items)) {
      const row = metaToRow(DSH_HOME, id, it)
      if (existsSync(row.logFile)) rows.push(row)
      else missing.push(id)
    }
    if (rows.length > 0) {
      /** 少量失效 → 局部找；大量失效（>50）才整份重扫。 */
      if (missing.length > 0) {
        if (missing.length <= 50) {
          for (const r of findRowsByDirNames(missing)) rows.push(r)
        } else {
      /** 回落扫盘也要填缓存：`findSession` 依赖 `rowsCache.byId`（否则直查恒空）。 */
      rowsCache = { sig: "", rows: listSessions(DSH_HOME, { headBytes: DEFAULT_HEAD_BYTES }), byId: new Map() }
      rowsCache.byId = new Map(rowsCache.rows.map((r) => [r.id, r]))
      return rowsCache.rows
        }
      }
      rows.sort((a, b) => b.mtime - a.mtime)
      rowsCache = { sig, rows, byId: new Map(rows.map((r) => [r.id, r])) }
      return rows
    }
  }
      /** 回落扫盘也要填缓存：`findSession` 依赖 `rowsCache.byId`（否则直查恒空）。 */
      rowsCache = { sig: "", rows: listSessions(DSH_HOME, { headBytes: DEFAULT_HEAD_BYTES }), byId: new Map() }
      rowsCache.byId = new Map(rowsCache.rows.map((r) => [r.id, r]))
      return rowsCache.rows
}

/** 读 API Key。 */
function loadApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  const f = join(DSH_HOME, '.credentials.yaml')
  if (!existsSync(f)) return undefined
  const text = readFileSync(f, 'utf8')
  // 极简 YAML 取值：refs: 段下的 DEEPSEEK_API_KEY
  const m = /^\s*DEEPSEEK_API_KEY:\s*(.+?)\s*$/mu.exec(text)
  return m === null ? undefined : m[1].replace(/^["']|["']$/gu, '')
}

/**
 * 离线装配一次保温请求 —— 实现在 `src/core/assemble.ts`（纯 Node，零 DSH 依赖）。
 *
 * 这里只是薄包装：把「失败原因」统一成 `{ error }` 形状，并保证
 * `plan.tools` 永远是数组（`warm()` 直接读它）。
 *
 * @param logFile 会话日志路径
 * @param prompt 保温问题
 * @returns 装配结果；失败时带 `error`
 */
async function assemble(logFile, prompt) {
  const result = assembleSession(logFile, prompt)
  if (result.error !== undefined) return { error: result.error, stats: result.stats }
  return result
}

/**
 * 统计这次装配里的图片块：能读到字节的有几个、读不到的有几个。
 *
 * 为什么必须区分：**读得到就内联进去，前缀与真实请求逐字节一致**（实测命中 99.9%）；
 * 读不到才需要警告「从那里之后会失配」。以前两种情况共用一句「离线没有图片字节」，
 * 于是明明内联成功了也弹警告，用户以为有问题。
 */
function imageReport(plan) {
  let blocks = 0
  let inlined = 0
  let missing = 0
  for (const m of plan.messages) {
    for (const b of m.content ?? []) {
      if (b.type !== 'image') continue
      blocks += 1
      const att = b.attachment ?? {}
      if (readAttachment(DSH_HOME, att.attachmentId, att.mediaType) !== undefined) inlined += 1
      else missing += 1
    }
  }
  return { blocks, inlined, missing, firstAt: plan.stats.firstImageAt }
}

/** 发一次保温请求。 */
async function warm(plan, apiKey) {
  /**
   * 必须经 `serializeForApi`：DSH 内部的块名与 API 变体名不同
   * （`reasoning` → `thinking`、`tool-call` → `tool_use`），直发会吃 422。
   * 插件半边不需要这一步 —— DSH 的 adapter 替它做了。
   */
  const body = serializeForApi(plan.messages, {
    model: plan.config?.model ?? 'deepseek-flash',
    maxTokens: WARM_MAX_TOKENS,
    ...(plan.system === undefined ? {} : { system: plan.system }),
    ...(plan.tools === undefined ? {} : { tools: plan.tools, declaredNames: new Set(plan.tools.map((t) => t.name)) }),
    ...(plan.config?.reasoningEffort === undefined ? {} : { reasoningEffort: plan.config.reasoningEffort }),
    /** **图片必须内联真实字节**：读得到就逐字节一致；读不到才降级成占位文本（那时前缀会从那之后失配）。 */
    resolveImage: (att) => readAttachment(DSH_HOME, att.attachmentId, att.mediaType),
  })
  body.stream = false   // CLI 用非流式，拿完整 JSON 更简单

  const t0 = Date.now()
  /** 超时必须**兜住**：`AbortSignal.timeout` 抛 TimeoutError，不接就是整个 `--once` 崩掉。 */
  let res
  try {
    res = await fetch(API_ROOT + '/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(WARM_TIMEOUT_MS),
      body: JSON.stringify(body),
    })
  } catch (e) {
    const name = e && e.name ? String(e.name) : ""
    const msg = name === "TimeoutError" ? "请求超时（" + Math.round(WARM_TIMEOUT_MS / 1000) + " 秒）" : String((e && e.message) || e)
    return { ok: false, error: msg }
  }
  const ms = Date.now() - t0
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}` }
  }
  const u = json.usage ?? {}
  /**
   * ⚠️ **API 用 snake_case，DSH 内部用 camelCase** —— 直接当 camelCase 读会全是 0。
   * 映射后 `inputTokens` = 未命中、`cacheReadTokens` = 命中（与插件侧口径一致）。
   */
  const usage = {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  }
  usage.totalTokens = usage.inputTokens + usage.cacheReadTokens + usage.outputTokens
  return { ok: true, ms, usage, raw: json }
}

/** 把一次结果记账。**计价与插件侧同一入口**（模型价表 × 峰谷倍率），否则账本花费会偏低。 */
function record(id, usage, ms, prompt, via, model, intervalMs) {
  // 锁用 `store.withStateLock`（与插件共用同一把）；锁内重读 → 追加 → 写
  return withStateLock(statePath(), () => {
    const fresh = loadState()
    const s = fresh.settings
    const c = costAt(
      usage,
      normalizePrices(s.prices),
      model,
      s.pricesByModel ?? {},
      s.tariff ?? {},
      Date.now() - ms,
    )
    const hit = usage.cacheReadTokens ?? 0
    const miss = usage.inputTokens ?? 0
    const total = promptTokens(usage)
    const prev = ledgerOf(fresh, id).slice(-1)[0]
    const gapSeconds = prev === undefined ? 0 : Math.round((Date.now() - prev.at) / 1000)
    /**
     * 连续次数与插件侧**同一条规则**：断档小于 3 个间隔才累加，否则重置为 1。
     * 无脑 `+1` 会让会话在第 `maxTouches` 次之后被 `max-touches` 永久拦死 ——
     * 插件遇到断档本来会重置，CLI 不重置就成了两套行为（核实员实测指出）。
     */
    const touch = prev !== undefined && intervalMs > 0 && gapSeconds < (intervalMs / 1000) * 3
      ? prev.touch + 1
      : 1
    const entry = {
      at: Date.now(),
      gapSeconds,
      promptTokens: total,
      hitTokens: hit,
      missTokens: miss,
      outputTokens: usage.outputTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      cost: c.cost,
      hitRate: hitRate(usage),
      cacheUnknown: usage.cacheKnown === false ? true : undefined,
      ms,
      touch,
      /** 周期号：不写的话「本期花费 / 本期次数」永远统计不到 CLI 记的账。 */
      cycle: cycleOf(fresh, id),
      via,
      model: model ?? '',
      factor: c.factor,
      factorLabel: c.label,
    }
    appendLedger(fresh, id, entry)
    saveState(fresh, statePath())
    return { entry, cost: c.cost, hitRate: entry.hitRate, state: fresh }
  })
}

/**
 * 用账本里记下的 `model` + `factor` 重建当时那套单价 ——
 * 「冷启动要多少」与「保温花了多少」必须同口径，否则时段表一开杠杆就差一个倍率。
 */
function entryPrices(state, entry) {
  const s = state.settings
  return scalePrices(priceForModel(entry.model ?? '', s.pricesByModel ?? {}, normalizePrices(s.prices)), entry.factor ?? 1)
}

function yuan(v) {
  return (v < 0.01 ? v.toFixed(5) : v.toFixed(4)) + ' 元'
}

/**
 * 这条会话当前该用的间隔（毫秒）—— 与插件侧 `effectiveIntervalSeconds()` / `core/gate-input.ts:intervalOf()` 同口径：
 * `policy.intervalSeconds` 优先，其次 `settings.intervalSeconds`（自适应已删，不再有 `adaptedSeconds`）。
 *
 * 下限 **1 秒**（试验模式是 30 秒，压不了）；`Number(sec) || 60` 只兜脏值（0/NaN → 60 秒），
 * 免得「每 1 秒保一次」。
 */
function intervalMsOf(state, policy) {
  const base = policy?.intervalSeconds ?? state.settings.intervalSeconds
  return Math.max(1, Number(base) || 60) * 1000
}

/** 门禁输入 —— 直接复用 `src/core/gate-input.ts`，与插件侧 / 面板逐项同口径。 */
function gateInputForRow(state, row, hasRoute, at = Date.now(), extra = {}) {
  return buildGateInput(state, {
    id: row.id,
    mtime: row.mtime,
    archived: row.archived === true,
    hasRoute,
    tripped: trippedNow(state, row.id, row.mtime),
    at,
    ...extra,
  })
}

/**
 * 是否真在熔断 —— 与插件侧 `trippedNow()` 同口径：常量阈值 + 最后活动时间。
 * 用各自定义的 `0.5` 或漏掉宽限，会让「面板能保、CLI 不能保」。
 */
function trippedNow(state, id, lastActivityAt) {
  return isTripped(state, id, BREAK_CIRCUIT_HIT_RATE, lastActivityAt)
}

/** `--list`：列会话。 */
async function cmdList() {
  const state = loadState()
  const rows = loadRows()
  const prices = normalizePrices(state.settings.prices)
  console.log(`共 ${rows.length} 个会话（DSH_HOME=${DSH_HOME}）\n`)
  console.log('标题'.padEnd(28) + '最后活动'.padEnd(18) + '大小'.padStart(8) + '保温'.padStart(6) + '花费'.padStart(11) + '  模式')
  console.log('-'.repeat(92))
  for (const r of rows.slice(0, 40)) {
    const led = ledgerOf(state, r.id)
    const spend = led.reduce((s, e) => s + e.cost, 0)
    const mode = policyOf(state, r.id).mode
    const tripped = isTripped(state, r.id, BREAK_CIRCUIT_HIT_RATE, r.mtime) ? '熔断' : ''
    console.log(
      (r.title || '(无标题)').slice(0, 26).padEnd(28)
      + new Date(r.mtime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).padEnd(18)
      + (r.sizeBytes / 1048576).toFixed(1).padStart(7) + 'M'
      + String(led.length).padStart(6)
      + yuan(spend).padStart(11)
      + '  ' + mode + (tripped ? ' ⛔' + tripped : ''),
    )
  }
  if (rows.length > 40) console.log(`… 还有 ${rows.length - 40} 条（此处只列前 40）`)
  console.log(`\n单价：命中 ${prices.hit} / 未命中 ${prices.miss} / 输出 ${prices.out}（元/百万 token）`)
}

/** 找会话。 */
function findSession(idOrPrefix) {
  loadRows()   // 确保缓存就绪（同一拍内只构建一次）
  /** 精确 id → **O(1)**（P1-2）；前缀/包含只在没命中时才线性扫。 */
  const hit = rowsCache.byId.get(idOrPrefix)
  if (hit !== undefined) return hit
  const all = rowsCache.rows
  return all.find((r) => r.id.endsWith(idOrPrefix)) ?? all.find((r) => r.id.includes(idOrPrefix))
}

/** `--dry-run`：只装配。 */
async function cmdDryRun(id) {
  const row = findSession(id)
  if (row === undefined) {
    console.log('找不到会话:', id)
    return 1
  }
  const prompt = loadState().settings.prompt
  const plan = await assemble(row.logFile, prompt)
  if (plan.error !== undefined) {
    console.log('装配失败:', plan.error)
    return 1
  }
  const sysMsg = plan.messages.find((m) => m.role === 'system')
  console.log('会话:', row.id)
  console.log('标题:', row.title || '(无标题)')
  console.log('日志:', (row.sizeBytes / 1048576).toFixed(1) + 'MB')
  console.log('')
  console.log('① 事件数        :', plan.stats.events)
  console.log('② surface 节点  :', plan.stats.nodes)
  console.log('③ 装配消息数    :', plan.stats.messages, '（含末尾追加的保温问题）')
  console.log('④ system        :', plan.system !== undefined ? 'header.system' : (sysMsg !== undefined ? 'messages[0]（' + JSON.stringify(sysMsg.content).length + ' 字符）' : '无'))
  console.log('⑤ tools         :', plan.tools ? plan.tools.length + ' 个' : '无')
  console.log('⑥ toolHistory   : tools=' + plan.toolHistory.tools.length + '  updates=' + plan.toolHistory.updates.length)
  console.log('⑦ config        :', JSON.stringify(plan.config))
  const bytes = JSON.stringify({ tools: plan.tools, messages: plan.messages }).length
  console.log('⑧ 请求体估算    :', (bytes / 1048576).toFixed(2), 'MB（约', Math.round(bytes / 3.6), 'token）')

  // ⑨ tool_use / tool_result 配对检查 —— API 的硬性要求，断了就 400
  let pending = new Set()
  let broken = 0
  const breaks = []
  for (let i = 0; i < plan.messages.length; i += 1) {
    const m = plan.messages[i]
    if (m.role === 'assistant') {
      const calls = (m.content ?? []).filter((b) => b.type === 'tool-call')
      pending = new Set(calls.map((b) => b.id))
    } else if (m.role === 'tool') {
      if (!pending.delete(m.toolCallId)) broken += 1
    } else if (m.role === 'user' || m.role === 'system' || m.role === 'developer') {
      if (pending.size > 0) {
        breaks.push(`[${i}] ${m.role} 之前有 ${pending.size} 个未闭合 tool_use`)
        broken += pending.size
        pending = new Set()
      }
    }
  }
  console.log('⑨ tool 配对      : 未闭合 =', broken + pending.size, breaks.length > 0 ? '  前 3 处：' + breaks.slice(0, 3).join(' | ') : '（全部配对 ✅）')

  // ⑩ 消息指纹 —— 与插件侧 `deriveMessages()` 的指纹逐条对比，用来定位分叉点
  const fp = plan.messages.map((m, i) =>
    `${i}|${m.role}|${(m.content ?? []).map((b) => b.type).join('+')}|${JSON.stringify(m.content).length}`)
  console.log('⑩ 前 12 条指纹   :')
  for (const l of fp.slice(0, 12)) console.log('    ' + l)
  console.log('    后 6 条：')
  for (const l of fp.slice(-6)) console.log('    ' + l)
  const firstByRole = {}
  plan.messages.forEach((m, i) => {
    const r = m.role ?? '?'
    firstByRole[r] = firstByRole[r] ?? []
    if (firstByRole[r].length < 12) firstByRole[r].push(i)
  })
  console.log('    各 role 首次出现序号（前 12）：', JSON.stringify(firstByRole))

  /**
   * ⑪ 工具面稳定性诊断。
   *
   * 缓存锚点是「system + tools + messages」整串；**工具面一抖，锚点就漂**。
   * `history.tools` 是当前基线，`header.tools` 是最后一次真实请求的 assembly 快照 ——
   * 后者明显小于前者，说明这条会话的工具面被反复改动过，命中率大概率偏低。
   *
   * 这不是实现缺陷：知识文档实测「删工具那一轮未命中 ≈ 已积累的对话量」，
   * 属缓存机制本身的硬边界。CLI 的价值在于**提前告诉你别在这条会话上白花钱**。
   */
  const baseTools = plan.toolHistory.tools.length
  const wireCount = plan.tools.length
  const headerCount = plan.headerToolCount
  const updates = plan.toolHistory.updates.length
  console.log('⑪ 工具面稳定性   : 基线 history.tools=' + baseTools + '  wire.tools=' + wireCount
    + '  最后一轮 assembly=' + headerCount + '  更新次数=' + updates)
  if (headerCount > 0 && baseTools > headerCount * 1.2) {
    console.log('    ⚠️ 该会话工具面被反复改动过（基线比最后一轮多 ' + (baseTools - headerCount) + ' 个）。')
    console.log('       缓存锚点会随工具面漂移，命中率可能明显偏低 —— 这是缓存机制的硬边界，不是装配错误。')
    console.log('       建议：要么先在 DSH 里给它发一句话刷新工具面，要么换一条工具面稳定的会话。')
  } else {
    console.log('    ✅ 工具面稳定，命中率应该正常')
  }
  console.log('⑫ 压缩/剪枝      : replace ' + plan.stats.replacements + ' 次' +
    (plan.stats.removedToolCalls > 0 ? '，修掉未闭合 tool_use ' + plan.stats.removedToolCalls + ' 处' : ''))
  if (plan.stats.imageBlocks > 0) {
    const pct = Math.round(plan.stats.firstImageAt * 100)
    console.log('    ⚠️ 含图片 ' + plan.stats.imageBlocks + ' 块，第一个在 ' + pct + '% 处。')
    console.log('       离线装配拿不到图片字节，会降级成一句占位文本 → **从那条消息之后的前缀全部失配**。')
    if (pct < 50) console.log('       位置太靠前，这条会话离线保温基本不划算 —— 建议在 DSH 里聊一句再保。')
    else console.log('       位置靠后，前面的大段前缀仍能命中，影响有限。')
  } else {
    console.log('    ✅ 不含图片')
  }
  // 打印断裂点附近的 role 序列，便于判断是表面被裁过还是序列化丢了东西
  if (breaks.length > 0) {
    const idx = Number(/^\[(\d+)\]/u.exec(breaks[0])?.[1] ?? 0)
    const around = []
    for (let i = Math.max(0, idx - 4); i < Math.min(plan.messages.length, idx + 3); i += 1) {
      const m = plan.messages[i]
      around.push(`${i}:${m.role}(${(m.content ?? []).map((b) => b.type).join('+')})`)
    }
    console.log('   断裂点附近     :', around.join('  '))
  }
  console.log('')
  console.log('✅ 装配成功（未发请求、未花钱）')
  return 0
}

/**
 * **准备**一次保温：找会话 → 读 key → 装配 → 过门禁 → 过安全阀。
 *
 * 抽出来是因为三个入口都要走同一条路：`--once`、守护循环、面板的「立刻保温」。
 * 返回 `{ ok:true, ... }` 或 `{ ok:false, code, detail }` —— `code` 直接当门禁码用。
 */
/**
 * 已打开的会话交给 **DSH 实例自己**保。
 *
 * 为什么不自己干：DSH 的 llm 适配器按 provider 配置选端点/协议/key，任何 provider 都能保；
 * 而且活会话有现成的 deriveMessages()，不必解压整份日志 —— 又快又准。
 * 实例没响应 / 说保不了 → 返回 undefined，调用方继续走本地离线路径。
 */
async function tryForwardToDsh(id, force, state) {
  /**
   * **G5 禁转发硬闸**：`labMode===true` 时绝不把请求转发给 DSH 实例。
   *
   * 沙箱里本没有 `runtime.json` 所以自然不转发；但**误把 `DSH_HOME` 指到真实 home** 时，
   * `readRuntime()` 会读到用户实例的端口 → 请求直接打到 3084/3080，既花钱又不可控。
   * 这条闸不看有没有 runtime，只看 labMode —— 试验模式一律走本地 `warmOffline()`。
   */
  if (!labAllowsForward(state)) {
    console.log('[' + new Date().toLocaleTimeString() + '] 试验模式：禁止转发到 DSH 实例（只走本地直连），'
      + '防止误把请求发到用户正在跑的实例')
    return undefined
  }
  const rt = readRuntime()
  const list = Array.isArray(rt?.instances) ? rt.instances : []
  for (const ins of list) {
    const port = Number(ins?.port)
    if (!Number.isFinite(port) || port <= 0) continue
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/api/cache-keepalive/ping', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, force: force === true, via: 'cli' }),
        signal: AbortSignal.timeout(3000),
      })
      const d = await res.json()
      if (d && d.ok === true) {
        return { ok: true, code: 'dsh', detail: (d.message || '已由 DSH 实例保温') + '（实例 ' + port + '）' }
      }
      // 实例明确说不行 → 本地离线还有机会，继续往下走
    } catch {
      // 实例没起 / 端口不通 —— 试下一个
    }
  }
  return undefined
}

async function prepareWarm(id, opts = {}) {
  const state = loadState()
  const row = findSession(id)
  if (row === undefined) return { ok: false, code: 'no-session', detail: '找不到会话：' + id }
  const policy = policyOf(state, row.id)
  const intervalMs = intervalMsOf(state, policy)
  /**
   * **`budget` 与 `max-touches` 是上限制**：不论谁触发都要拦（与插件侧 `/ping` 同口径）。
   * 其余四条（间隔 / 断档 / 冷窗 / 熔断）只在自动路径与不带 `--force` 的 `--once` 里生效。
   * 实测反例（2026-10-18）：守护循环每 60 秒一拍，每拍都过门禁 —— 但转发给实例的那一步
   * 走的是实例的 `/ping`，它当时不看门禁，于是同一条会话被连保 196 次、花 0.97 元。
   * 所以门禁**必须在转发之前**，否则等于没有门禁。
   */
  const relaxed = opts.skipGate === true || opts.force === true
  const led = ledgerOf(state, row.id)
  const last = led[led.length - 1]
  /** 次数分「本期」与「累计」两条，与插件侧 `spendGuard()` 同口径：清账只重置本期。 */
  const touchCycle = touchCountOf(state, row.id)
  const touchTotal = last?.touch ?? 0
  const spent = cycleSpendOf(state, row.id)
  const maxTouches = policy.maxTouches ?? state.settings.maxTouches
  const maxTouchesTotal = state.settings.maxTouchesTotal ?? 0
  /**
   * 门禁参数与插件侧 `gateInputFor()` 逐项对齐 —— 两边的结论必须一致，
   * 否则同一会话在插件里保、在 CLI 里不保，用户会以为插件坏了。
   * `hasRoute` 这里先乐观当 true：真正的路由要装配后才看得到，
   * 装配失败会在下面以 `assemble` / `provider` 报出来（不会白花钱）。
   */
  const gateOf = (hasRoute, extra) => decideWarm(gateInputForRow(state, row, hasRoute, Date.now(), extra))
  /** 门禁判定 → 返回体。硬上限一律拒；软判断在 `relaxed` 时放行。 */
  const blockedBy = (decision) => {
    /**
     * ⚠️ **硬上限独立判，不看 `decision.code`**：`decideWarm` 先返回 `fresh` / `too-soon`
     * （「刚保过」比「次数尽」更贴近当下），`relaxed` 一放行，硬上限就永远轮不到 ——
     * 实测 `--force` 时照样转发给实例又保了一次。
     */
    const overBudget = spent >= state.settings.budgetPerSession
    const overCycle = touchCycle >= maxTouches
    const overTotal = maxTouchesTotal > 0 && touchTotal >= maxTouchesTotal
    if (overBudget || overCycle || overTotal) {
      return {
        ok: false,
        code: overBudget ? 'budget' : (overCycle ? 'max-touches' : 'max-touches-total'),
        detail: '保温已触发上限，本次不发请求（没花钱）：'
          + `本期已保 ${touchCycle} 次 / 上限 ${maxTouches} 次，`
          + `累计已保 ${touchTotal} 次 / 上限 ${maxTouchesTotal > 0 ? maxTouchesTotal : '不限'}，`
          + `本期花费 ${yuan(spent)} / 上限 ${yuan(state.settings.budgetPerSession)}。`,
      }
    }
    if (decision.ok) return undefined
    if (relaxed) return undefined
    return { ok: false, code: decision.code, detail: decision.detail }
  }
  const quickSkip = blockedBy(gateOf(true))
  if (quickSkip !== undefined) return quickSkip
  /**
   * 已打开 / 历史都先问实例：它能用该会话真实路由发（支持任意 provider），且不用解压日志。
   * **必须在门禁之后** —— 转发走实例的 `/ping`，那一步自己不发请求也记账，
   * 放在门禁前面就等于守护循环每拍都真保一次（2026-10-18 实测事故）。
   */
  const forwarded = await tryForwardToDsh(row.id, opts.force, state)
  if (forwarded !== undefined) return forwarded
  const prompt = policy.prompt ?? state.settings.prompt
  const plan = await assemble(row.logFile, prompt)
  if (plan.error !== undefined) return { ok: false, code: 'assemble', detail: '装配失败：' + plan.error }
  /**
   * **提供方检查**（与 `warm-offline.ts` 共用）：非 DeepSeek 的会话发到 DeepSeek 端点
   * 不是 400 就是沉默按未命中计费 —— 实测白烧过 0.0979 元（`provider=tokenrhythm133`）。
   */
  /**
   * **第三方 provider 不该被「只能直连 DeepSeek」拒掉**：只要 profile 里配了它（baseURL + apiKeyEnv），
   * 本地也能保 —— 走 `warmOffline()` 的 OpenAI 兼容直连。以前这里不看配置一律拒绝，
   * 于是 tokenrhythm / dots 这类会话在独立面板点保温只会看到一句误导的提示。
   */
  const providerName = plan.config?.provider
  const third = typeof providerName === 'string' ? loadProviders(DSH_HOME).get(providerName) : undefined
  const useThird = third !== undefined && third.apiKey !== undefined
  /** 第三方用自己的 key，**不加载 DeepSeek 的 key**；否则第三方会话会被 DeepSeek key 检查拦掉。 */
  const apiKey = useThird ? undefined : loadApiKey()
  if (!useThird) {
    /**
     * 顺序固定：**配了但缺 key** → 没配（只能直连 DeepSeek）→ DeepSeek 缺 key。
     * 三者修法完全不同，报错句一旦串了就会把用户指到错的地方。
     */
    if (third !== undefined) {
      return {
        ok: false,
        code: 'provider',
        detail: '提供方 ' + providerName + ' 已配置（' + third.baseURL + '），但没读到它的 API Key：'
          + '检查 $DSH_HOME/.credentials.yaml 的 refs 段有没有 ' + (third.apiKeyEnv ?? '对应变量'),
      }
    }
    const refusal = providerRefusal(providerName)
    if (refusal !== undefined) return { ok: false, code: 'provider', detail: refusal }
    if (apiKey === undefined) {
      return {
        ok: false,
        code: 'no-key',
        detail: '找不到 API Key（设 DEEPSEEK_API_KEY，或写进 ' + join(DSH_HOME, '.credentials.yaml') + ' 的 refs 段）',
      }
    }
  }
  /** 装配后有真实路由了，再判一次（`hasRoute` 与 `running` 之外的门禁结论不该变，但保持同一条路）。 */
  /**
   * 装配后才知道「日志尾部是否刚被压缩/goal 改写」——这时能准确判断：
   * 改写之后若没有真实请求，服务端缓存还是改写前的，保了等于替用户付一次冷启动。
   */
  const fullSkip = blockedBy(gateOf(
    plan.config?.provider !== undefined && plan.config?.model !== undefined,
    plan.rewrite === undefined ? {} : { rewritten: true, rewriteDetail: plan.rewrite.detail },
  ))
  if (fullSkip !== undefined) return fullSkip
  /**
   * **安全阀：含图片且位置靠前的会话，默认不保。**
   *
   * 离线拿不到图片字节，装配出的前缀会与真实请求不同。这时保温不只是「白花钱」——
   * 它会把一份**错误的前缀**写进提供方缓存，等于用错的锚点挤掉对的锚点；
   * 用户之后在 DSH 里继续这条会话，反而要从图片那里开始按未命中价重算。
   *
   * 阈值 30%：实测 14a53ec6 的图片在 15% 处，对着 DSH 建立的缓存只命中 97.1%
   * （差的那 2.9% 正是被降级的图片段）；图片在末尾附近的会话影响可忽略。
   */
  /**
   * 图片只在**真读不到字节**时才拦（读得到就内联，前缀逐字节一致，没理由拒）。
   * 位置靠前（`firstImageAt < 0.9`）只是"影响大"的判据，仍要求 `missing > 0`。
   */
  const imgs = imageReport(plan)
  if (imgs.missing > 0 && refuseForImages(plan.stats, opts.force === true)) {
    return {
      ok: false,
      code: 'image',
      detail: `含 ${imgs.blocks} 个图片块，第一个在 ${Math.round(imgs.firstAt * 100)}% 处，其中 ${imgs.missing} 个`
        + '从附件库读不到字节 —— 保了会把错误的前缀写进缓存、挤掉对的',
    }
  }
  return { ok: true, state, row, plan, apiKey, prompt, policy, intervalMs, third: useThird }
}

/** 门禁/准备失败时的可读提示（`--once` 与面板共用）。 */
function describeSkip(r) {
  if (r.code === 'no-session' || r.code === 'no-key' || r.code === 'assemble') return r.detail
  if (r.code === 'image') return r.detail + '（想强制就加 --force）'
  if (r.code === 'provider') return r.detail
  return `跳过 [${r.code}] ${r.detail}`
}

/**
 * 上一次 `cmdOnce` 的失败归属：`'config'` = 重试也不会好（会话/装配/模型/HTTP），
 * `'gate'` = 只是这次不行（间隔/断档/预算/熔断）。**不要用返回值判断** ——
 * 返回 1 的既可能是 too-soon，也可能是模型下线，混在一起会让退避把正常会话也冻住。
 */
let lastFailKind = '';

/**
 * 发一次保温请求。**第三方 provider 走 `warmOffline()`**（它按 OpenAI 协议直连，
 * 用自己的 key 与 baseURL），其余走本地 Anthropic 直连。
 * 两条路的返回都归一成 `{ ok, usage, ms, model, raw?, error? }`。
 *
 * **试验护栏在这里**：这是 CLI 全部发请求路径的唯一汇聚点，`labVerdict()` 不通过就不发。
 * 非试验模式下 `labVerdict()` 第一条就放行 —— 生产行为零变化。
 */
async function sendWarm(r) {
  /**
   * **G2 预留 + 三道护栏**：用与插件 `ping()` **同一个** `worstCostOf()` 算本次最坏花费，
   * 再交给同一个 `labVerdict()` 判。非试验模式下 `labVerdict()` 第一条就放行。
   */
  const worst = worstCostOf(
    promptTokensEstimate(r.plan.request, ledgerOf(r.state, r.row.id).slice(-1)[0]?.promptTokens ?? 0),
    WARM_MAX_TOKENS,
    r.state.settings.prices,
  )
  const lg = labVerdict(r.state, r.row.id, ledgerOf(r.state, r.row.id), worst)
  if (!lg.ok) {
    return { ok: false, ms: 0, model: r.plan.config?.model, error: `试验护栏拦截（${lg.step}）：${lg.why}` }
  }
  if (r.third === true) {
    const out = await warmOffline({
      logFile: r.row.logFile,
      prompt: r.prompt,
      dshHome: DSH_HOME,
      maxTokens: WARM_MAX_TOKENS,
      refuseImages: true,
    })
    return {
      ok: out.ok === true && out.usage !== undefined,
      usage: out.usage,
      ms: out.ms ?? 0,
      model: out.model ?? r.plan.config?.model,
      raw: out.raw,
      error: out.error,
    }
  }
  const out = await warm(r.plan, r.apiKey)
  return { ...out, model: r.plan.config?.model }
}

/** `--once`：保温一次。`quiet` 用于守护循环（只打一行结论）。 */
async function cmdOnce(id, opts = {}) {
  const quiet = opts.quiet === true
  const say = (s) => { if (!quiet) console.log(s) }
  const r = await prepareWarm(id, opts)
  if (!r.ok) {
    /**
     * 失败归属：**配置类**（会话/装配/模型/HTTP，重试也不会好）vs **门禁类**（只是这次不行）。
     * 循环靠它决定要不要退避 —— 不能只看返回值，返回值 1 两种都可能是。
     */
    lastFailKind = (r.code === 'too-soon' || r.code === 'stale' || r.code === 'cold-window'
      || r.code === 'budget' || r.code === 'max-touches' || r.code === 'tripped'
      || r.code === 'running') ? 'gate' : 'config'
    // 提供方不支持属于数据/配置问题（同一份日志每次都拒）→ 计入 config，走 30 分钟退避
    // 图片拒绝是**日志内容决定的**（同一份日志每次都拒）→ 归 config，走 30 分钟退避
    if (r.code === 'no-session' || r.code === 'no-key' || r.code === 'assemble') {
      console.log(r.detail)
    } else {
      console.log(`[${new Date().toLocaleTimeString()}] ${String(id).slice(-12)} ${describeSkip(r)}`)
      /**
       * 只有「`--force` 真能改变结果」的码才提示它：
       * `provider` / `no-key` / `no-session` / `assemble` 是配置或数据问题，force 无效；
       * 用户已经带了 `--force` 时更不该再劝他加。
       */
      const forceHelpful = opts.force !== true
        && r.code !== 'image' && r.code !== 'budget' && r.code !== 'max-touches'
        && r.code !== 'provider' && r.code !== 'no-key' && r.code !== 'no-session' && r.code !== 'assemble'
      if (!quiet && forceHelpful) console.log('（想强制就加 --force）')
    }
    return 1
  }
  /**
   * 转发给实例成功时**没有 `plan`**（实例自己装配）—— 早先这里直接往下读
   * `plan.stats`，守护循环第一拍就抛 `Cannot read properties of undefined (reading 'stats')`。
   * 而那时的 `/ping` 已经真的发了请求、记了账，所以是「报错 + 仍然花钱」。
   */
  if (r.code === 'dsh') {
    lastFailKind = ''
    console.log(`[${new Date().toLocaleTimeString()}] ${String(id).slice(-12)} ${r.detail}`)
    return 0
  }
  lastFailKind = ''
  const { state, row, plan, apiKey, prompt, policy, intervalMs } = r
  if (quiet) {
    // 循环里只关心「本拍有没有真的动手」，详细原因不刷屏
  }
  say('保温中…（' + plan.stats.messages + ' 条消息 / ' + (plan.tools?.length ?? 0) + ' 个工具）')
  // 含图片时先说清「内联成功了」还是「读不到、之后会失配」
  if (plan.stats.imageBlocks > 0 && !quiet) {
    const ir = imageReport(plan)
    const where = Math.round(ir.firstAt * 100) + '% 处'
    if (ir.missing === 0) {
      console.log(`ℹ️ 含 ${ir.blocks} 个图片块（第一个在 ${where}）：已从附件库读到字节并原样内联，前缀与真实请求一致。`)
    } else {
      console.log(`⚠️ 含 ${ir.blocks} 个图片块（第一个在 ${where}）：其中 ${ir.missing} 个读不到字节，`
        + '那条之后的前缀会失配，命中率会偏低。')
    }
  }
  const out = await sendWarm(r)
  if (!out.ok) {
    lastFailKind = 'config'
    console.log('失败:', out.error)
    return 1
  }
  const { entry, cost } = record(row.id, out.usage, out.ms, prompt, 'cli', out.model ?? plan.config?.model, intervalMsOf(state, policy))
  if (quiet) {
    console.log(`[${new Date().toLocaleTimeString()}] ${String(row.id).slice(-12)} 保温 ${(entry.hitRate * 100).toFixed(1)}%`
      + ` ${entry.hitTokens}/${entry.promptTokens} tok ${yuan(cost)} 第${entry.touch}次`)
  } else {
    console.log('')
    console.log('✅ 保温完成')
    if (out.raw !== undefined) console.log('  原始响应:', JSON.stringify(out.raw).slice(0, 500))
    console.log('  命中率  :', (entry.hitRate * 100).toFixed(1) + '%')
    console.log('  命中/总 :', entry.hitTokens + ' / ' + entry.promptTokens + ' tok')
    console.log('  花费    :', yuan(cost) + (entry.factor !== undefined && entry.factor !== 1 ? '（' + (entry.factorLabel || '时段') + ' ×' + entry.factor + '）' : ''))
    console.log('  耗时    :', out.ms + 'ms')
    const cold = plan.stats.messages > 0 ? entry.promptTokens * (entryPrices(state, entry).miss / 1e6) : 0
    console.log('  杠杆    :', (cold / Math.max(cost, 1e-12)).toFixed(1) + ' 倍（若冷启动要 ' + yuan(cold) + '）')
  }
  return 0
}

/**
 * 挑出这一拍该处理的会话。
 *
 * **自动候选的判定不在本文件里做** —— 统一走 `src/core/candidates.ts:decideCandidates()`
 * （与插件 tick / 无实例面板同一份实现），这里只负责两件本文件独有的事：
 *  - `mode=on` 归 `forced` 组（用户显式要，不看标题/闲置/名额）；`mode=off` 跳过；
 *  - 每拍取 `forced + 自动候选里的前 autoCount 条`。
 *
 * 与改造前的差异（**以库函数为准**，行为等价）：
 *  - 归档 / 子代理 / 无标题 / 闲置 / 门禁这几条过滤原来在这里各写一遍，现在由库函数判；
 *    `forced` 组仍保留 archived + 子代理 的前置跳过（与改造前逐条一致）。
 *  - 闲置判据、门禁口径、`gateOk` 语义全部由库函数给，本文件不再自带副本。
 *  - **没有任何"最近被写过就跳过"的过滤**：用户明确要求「会话正在跑也要保」。
 *    真正挡住重复保温的是门禁的 `too-soon`（真实活动会把 `lastActivityAt` 推到当下）。
 *
 * ⚠️ **标题过滤只对 `auto` 生效**：`listSessions` 只读日志头 256KB，标题事件落在后面的大会话
 * 会读到空标题（本机实测有这种会话）；`mode=on` 也走标题过滤就会让这类会话永远保不了。
 *
 * @param state 当前状态（`autoEnabled=false` 只影响 auto 候选，不影响强制开）
 * @param rows 磁盘会话清单
 * @param now 当前时间
 */
function pickLoopCandidates(state, rows, now) {
  const s = state.settings
  const decisions = decideCandidates(
    state,
    rows.map((r) => ({
      id: r.id,
      mtime: r.mtime,
      archived: r.archived === true,
      origin: r.origin ?? '',
      title: r.title,
      /** 与改造前同口径：CLI 自己算熔断。 */
      tripped: trippedNow(state, r.id, r.mtime),
    })),
    now,
    {
      enabled: s.autoEnabled,
      count: s.autoCount,
      maxIdleHours: s.idleLimitHours,
      allowSubagent: s.autoAllowSubagent,
    },
  )
  const forced = []
  const auto = []
  for (const r of rows) {
    /** 归档：直接查库结论（库判定链最前，`mode=on` 也会给 `archived`），不再自己判。 */
    if (decisions.get(r.id)?.reason === 'archived') continue
    /**
     * 子代理：**必须自己滤** —— 库在 `mode=on` 时给的是 `manual`（subagent 排在 manual 之后），
     * 查库拿不到 subagent，所以这条是库外的第二份实现，改库时同步。
     */
    if (r.origin === 'subagent' && s.autoAllowSubagent !== true) continue
    const policy = policyOf(state, r.id)
    if (policy.mode === 'off') continue
    if (policy.mode === 'on') { forced.push(r); continue }
    if (decisions.get(r.id)?.picked === true) auto.push(r)
  }
  forced.sort((a, b) => b.mtime - a.mtime)
  auto.sort((a, b) => b.mtime - a.mtime)
  // 库里的 `pickAutoCandidates` 已按 `autoCount` 截断过，这里不再 slice
  return [...forced, ...auto]
}

/**
 * `--loop`：守护循环（**脱离 DSH 之后唯一的自动保温入口**）。
 *
 * 每一拍只做「挑候选 → 串行逐个过一次门禁」，不 sleep 到下一个 4 小时 ——
 * 因为每个会话的间隔不同（有的自适应成了 5 小时、有的被用户设成 1 小时），
 * 由门禁的 `too-soon` 决定该不该真发请求。tick 默认 60 秒，代价只有一次目录扫描。
 */
async function cmdLoop(tickSec) {
  console.log(`守护循环启动：每 ${tickSec} 秒一拍（Ctrl+C 退出）`)
  console.log('说明：每拍只扫描 + 过门禁；真正发请求由「间隔 / 断档 / 预算 / 熔断」四条共同决定。')
  console.log('⏱ CLI 守护循环固定晚插件 90 秒起拍，用来避免两边同时保同一条会话。')
  /** 起拍对齐：晚了才能让插件先保、CLI 那一拍吃 too-soon（见 LOOP_OFFSET_MS 注释）。 */
  const waitMs = loopAnchorDelayMs()
  if (waitMs > 0) {
    console.log(`⏱ 等待 ${Math.round(waitMs / 1000)} 秒后开始第一拍…`)
    await new Promise((r) => setTimeout(r, waitMs))
  } else {
    console.log('⏱ 插件上一拍距今已超过 90 秒（或没有锚点），立即开始第一拍')
  }
  /** 上一拍的「自动策略状态」，只在**变化时**打印一次（否则每 60 秒刷一行）。 */
  let lastDisabled = null
  /** 配置类失败后的静默期：sessionId → 可以再试的时刻。 */
  const skipUntil = new Map()
  for (;;) {
    try {
      const state = loadState()
      /** **到期自愈**：试验模式到点自动退出并按 `labBackup` 还原（CLI 每拍查一次）。 */
      const expired = labExpireIfDue(state)
      if (expired !== undefined) {
        console.log('[' + new Date().toLocaleTimeString() + '] ' + expired.message)
        if (expired.restored) saveState(state)
      }
      /**
       * ⚠️ **`autoEnabled=false` 不等于「全停」** —— 它只清空 auto 候选池，
       * 用户显式设成「强制开」的会话照保（与插件侧 tick 一致：那里只跳过
       * `mode==='auto' && !picked` 的会话）。
       * 曾经在这里整轮空转，结果「关掉自动策略 + 设几条强制开」时 CLI 一条都不保。
       */
      const rows = loadRows()
      const cands = pickLoopCandidates(state, rows, Date.now())
      const disabled = state.settings.autoEnabled !== true
      if (disabled !== lastDisabled) {
        console.log(disabled
          ? '[' + new Date().toLocaleTimeString() + '] 自动策略已关闭：只保「强制开」的会话'
          : '[' + new Date().toLocaleTimeString() + '] 自动策略已开启：按候选池保温')
        lastDisabled = disabled
      }
      for (const c of cands) {
        // 退避：配置类失败（模型下线 / 日志损坏 / HTTP 错）重试也不会好，30 分钟内不再碰
        if ((skipUntil.get(c.id) ?? 0) > Date.now()) continue
        // 串行：一条一条来，避免同时压 API、也避免账本写冲突
        await cmdOnce(c.id, { quiet: true })
        if (lastFailKind === 'config') skipUntil.set(c.id, Date.now() + 30 * 60_000)
      }
    } catch (e) {
      console.error('[' + new Date().toLocaleTimeString() + '] 循环出错:', e instanceof Error ? e.message : String(e))
    }
    await new Promise((r) => setTimeout(r, tickSec * 1000))
  }
}

/**
 * 探测端口上**已经在跑的本程序**。
 *
 * 判据不是「端口能不能连」—— 端口可能被别的程序占着。必须拿到本服务的招牌：
 * `GET /api/cache-keepalive/state` 返回 `{ok:true, state:{sessions:[…]}}`。
 *
 * **只探 `startPort` 这一个端口（span 默认 1）**：本程序端口固定，不再 19388..19407 全段探测。
 * 全段探测的代价是每个端口一次 1.2s 超时（最坏 24s 才起得来），而端口固定后全段探测
 * 唯一的作用是「发现一个跑在别的端口上的旧实例」—— 那种情况已由显式 `--port` 负责，不再猜。
 *
 * @param startPort 要探的端口
 * @param span 往后试几个（默认 1；只有排查历史部署时才显式传大）
 * @returns 已在跑的端口号；没有则 0
 */
async function findRunningServe(startPort, span = 1) {
  for (let i = 0; i < span; i += 1) {
    const port = startPort + i
    /** 偶发超时要重试一次：判错的代价是「明明自己在跑，却报端口被别的程序占用」。 */
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        /**
         * 探 `/health`（几字节，不扫会话）而**不是** `/state` —— 后者响应体随会话数增长
         * （447 条 = 347KB，冷启动首字节 861ms、偶发 >1.2s），拿它当招牌会把「自己在跑」
         * 误判成「端口被别的程序占用」。
         *
         * **旧版本没有 `/health`**：它的 404 应答体是 `not found: /api/cache-keepalive/health`，
         * 仍含 `cache-keepalive` 字样 → 一样认得出，兼容不停机。
         */
        const res = await fetch(`http://127.0.0.1:${port}/api/cache-keepalive/health`, {
          signal: AbortSignal.timeout(2000),
        })
        const head = await readHead(res, 200)
        if (head.includes('cache-keepalive')) return port
        break
      } catch {
        /* 没在跑、不是本服务、或偶发超时 → 再试一次 */
      }
    }
  }
  return 0
}

/** 只读响应体开头 `n` 个字符就取消（用于廉价识别招牌，别把大 body 全下载）。 */
async function readHead(res, n) {
  const reader = res.body?.getReader()
  if (reader === undefined) return ''
  try {
    const { value } = await reader.read()
    return value === undefined ? '' : new TextDecoder().decode(value.subarray(0, n))
  } finally {
    try { await reader.cancel() } catch { /* 已结束或已关闭 */ }
  }
}

/** 用系统默认浏览器打开一个地址。 */
async function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]]
  try {
    const { spawn } = await import('node:child_process')
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
  } catch (e) {
    console.log('（自动打开浏览器失败，请手动访问上面的地址：' + String(e?.message ?? e) + '）')
  }
}

/**
 * **无实例面板**：不依赖任何 DSH 实例，自己起一个 HTTP 服务把面板跑起来。
 *
 * 复用同一份 `PANEL_HTML` 与同一批 `routes.ts` 处理器 —— 一行前端都不用改，
 * 差别只在数据源：`createPanelService()` 从磁盘 + `state.json` + `runtime.json` 算。
 *
 * **发现已有实例就直接用它**（不再起第二个）：本程序是单实例服务，
 * 重复执行 `--serve` 应该是「打开已经在跑的那个」，而不是报端口占用或另起一份
 * （另起会让两个进程同时保温同一批会话）。
 *
 * @param port 监听端口（**固定**：默认 19388，被占用即报错；要换只能显式 `--port N`）
 * @param open 是否在系统默认浏览器里打开
 * @param withLoop 是否同时跑守护循环（**默认 false**：`--serve` 只提供面板，自动保温要 `--auto`）
 */
async function cmdServe(port, open, withLoop, tickSec) {
  // ① 先看有没有已在跑的自己（只探这一个端口，见 findRunningServe）
  const running = await findRunningServe(port)
  if (running > 0) {
    const url = `http://127.0.0.1:${running}/api/cache-keepalive/panel`
    console.log('')
    console.log(`  已有一个实例在跑（端口 ${running}）—— 不再重复启动`)
    console.log(`  面板    ${url}`)
    console.log('')
    console.log('  想重启它：先关掉那个进程（任务管理器 / Ctrl+C），再执行一次本命令')
    console.log('  （如果刚更新过插件代码，旧进程跑的还是旧代码 —— 必须重启才会生效）')
    console.log('')
    if (open) await openBrowser(url)
    /**
     * **被进程管理器托管时不能退出**：pm2 的 `autorestart:true` 会把「退出」判成进程掉了，
     * 于是重启 → 又探测到已有实例 → 再退出，把 `max_restarts` 打满后进 error 状态。
     * 这里改成只打日志、保持存活（面板由另一份提供，本进程不监听端口）。
     */
    if (process.env.pm_id !== undefined || process.env.PM2_HOME !== undefined) {
      console.log('  （pm2 托管中：保持进程存活，不重复监听端口；面板由上面那个实例提供）')
      console.log('')
      return new Promise(() => {})
    }
    return 0
  }
  const http = await import('node:http')
  const { makeRoutes } = await import(pathToUrl(join(SRC, 'routes.ts')))
  const { createPanelService } = await import(pathToUrl(join(SRC, 'core', 'panel-service.ts')))

  /** 面板「立刻保温」走这里：复用 `prepareWarm` + `warm` + `record`，与命令行完全同一条路。 */
  const warmViaPanel = async (id, force) => {
    // 手动点击：跳过门禁，但**图片安全阀照旧生效**（force 才放行图片）
    const r = await prepareWarm(id, { skipGate: true, force: force === true })
    if (!r.ok) return { ok: false, error: describeSkip(r) }
    /** 已由 DSH 实例转发保温：**没有 plan**，直接报结果（早先这里往下读 `plan.messages` 会崩）。 */
    if (r.code === 'dsh') return { ok: true, message: r.detail }
    const { state, row, plan, prompt, policy, intervalMs } = r
    const out = await sendWarm(r)
    if (!out.ok) return { ok: false, error: out.error }
    const { entry, cost } = record(row.id, out.usage, out.ms, prompt, 'panel', out.model ?? plan.config?.model, intervalMs)
    void state; void policy
    return {
      ok: true,
      message: `保温完成：命中率 ${(entry.hitRate * 100).toFixed(1)}%，花费 ${yuan(cost)}，第${entry.touch}次`,
    }
  }

  const service = createPanelService({ dshHome: DSH_HOME, warm: warmViaPanel, loopEnabled: withLoop })
  const routes = makeRoutes(service)

  /** 把 `WebRoute[]`（`kind: exact|prefix`）适配到原生 http。 */
  const server = http.createServer((req, res) => {
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? '127.0.0.1')).pathname
    } catch {
      /* 坏 URL 当作根 */
    }
    for (const route of routes) {
      const hit = route.kind === 'exact' ? pathname === route.path : pathname.startsWith(route.path)
      if (!hit) continue
      try {
        route.handler(req, res)
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('handler error: ' + String(e?.message ?? e))
      }
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found: ' + pathname + '\n\n面板地址：/api/cache-keepalive/panel')
  })

  /**
   * **固定端口：只监听这一个，占用就报错**（不再静默 +1）。
   *
   * 为什么去掉自动 +1：日志/文档里说 19388，实际却落在 19389，用户与脚本都会找不到面板；
   * pm2 版与手动版并存时更会出现「两个都在跑、谁也不知道另一个在哪」。
   * 要换端口必须**显式** `--port N` —— 命令行里写的端口就是实际端口。
   */
  const listenErr = await new Promise((resolve) => {
    const onErr = (e) => { server.removeListener('listening', onOk); resolve(e) }
    const onOk = () => { server.removeListener('error', onErr); resolve(null) }
    server.once('error', onErr)
    server.once('listening', onOk)
    server.listen(port, '127.0.0.1')
  })
  if (listenErr !== null) {
    const code = listenErr?.code ?? ''
    console.error('')
    if (code === 'EADDRINUSE') {
      console.error(`❌ 端口 ${port} 已被占用。本程序固定用这一个端口，不会自动换。`)
      console.error('   注意：若占用者**是本程序**的另一份，上面的「已有实例」检查应该已经拦住了；')
      console.error('   走到这里说明占用者是别的程序。两种做法：')
      console.error(`     ① 查占用者并关掉：netstat -ano | findstr :${port}   然后 taskkill /PID <pid> /F`)
      console.error(`     ② 显式换端口：--port ${port + 1}（只有显式指定才会换，不再自动 +1）`)
    } else {
      console.error(`❌ 无法监听 127.0.0.1:${port}（${code} ${listenErr?.message ?? ''}）`)
      console.error('   端口可能被保留/权限不足。换端口请显式 --port N。')
    }
    console.error('')
    return 1
  }
  const bound = port

  const url = `http://127.0.0.1:${bound}/api/cache-keepalive/panel`
  console.log('')
  console.log('  缓存保温 · 无实例面板已启动（不依赖任何 DSH 实例）')
  console.log(`  面板    ${url}`)
  console.log(`  端口    ${bound}（固定；被占用即报错，要换端口请显式 --port N）`)
  console.log(`  状态    ${statePath()}`)
  console.log(`  会话    ${join(DSH_HOME, 'sessions')}`)
  /** 三种模式一句话对清楚：用户看启动日志就知道自己开的是哪一种。 */
  console.log(`  模式    ${withLoop ? '面板 + 守护循环（--serve --auto）' : '仅面板（--serve；不自保温）'}`)
  console.log(`  守护    ${withLoop ? `⚠️ 开（每 ${tickSec} 秒一拍，会花真钱）` : '关（默认只提供面板，要自动保温加 --auto）'}`)
  console.log('')
  console.log('  Ctrl+C 退出')
  console.log('')

  if (withLoop) {
    console.log('  ╔══════════════════════════════════════════════════════════════╗')
    console.log('  ║ ⚠️  自动保温已开启：将按策略在真实 home 上花真实费用          ║')
    console.log('  ║     每 ' + tickSec + ' 秒一拍，门禁过了就真发请求（真扣钱）' + ' '.repeat(Math.max(0, 22 - String(tickSec).length)) + '║')
    console.log('  ║     只想看面板：Ctrl+C 后用 --serve（不带 --auto）重开        ║')
    console.log('  ╚══════════════════════════════════════════════════════════════╝')
    console.log('')
  }
  if (open) await openBrowser(url)

  if (withLoop) {
    // 与 `--serve` 同进程：先起服务，再进守护循环（不阻塞 HTTP）
    void cmdLoop(tickSec).catch((e) => console.error('守护循环退出：', e?.message ?? e))
  }
  // 保持进程活着
  return new Promise(() => {})
}

/** `--status`：一眼看全现状（独立部署时排查用）。 */
function cmdStatus() {
  const state = loadState()
  const s = state.settings
  const rows = loadRows()
  const now = Date.now()
  const cands = pickLoopCandidates(state, rows, now)
  console.log('缓存保温 · 独立 CLI 状态')
  console.log(`  状态文件    ${statePath()}`)
  console.log(`  会话目录    ${join(DSH_HOME, 'sessions')}（${rows.length} 条）`)
  console.log(`  自动策略    ${s.autoEnabled ? '开' : '关'}   保 ${s.autoCount} 条   只保闲置 < ${s.idleLimitHours} 小时`)
  console.log(`  默认间隔    ${s.intervalSeconds} 秒   闲置上限 ${s.idleLimitHours} 小时   次数上限 ${s.maxTouches}   单会话预算 ${s.budgetPerSession} 元`)
  console.log(`  保温问题    ${s.prompt}`)
  const p = normalizePrices(s.prices)
  console.log(`  单价        命中 ${p.hit} / 未命中 ${p.miss} / 输出 ${p.out}（元/百万）`)
  if (s.tariff?.enabled) console.log(`  时段表      开（${s.tariff.timeZone}，${s.tariff.slots.length} 段）`)
  console.log(`  本拍候选    ${cands.length} 条`)
  for (const r of cands.slice(0, 20)) {
    const led = ledgerOf(state, r.id)
    const last = led[led.length - 1]
    const policy = policyOf(state, r.id)
    console.log(`    ${String(r.id).slice(-12)}  ${policy.mode.padEnd(4)}  闲置 ${Math.round((now - r.mtime) / 60000)} 分`
      + `(刷新 ${Math.round((now - Math.max(r.mtime, last?.at ?? 0)) / 60000)} 分)`
      + (last === undefined ? '  还没保过' : `  上次命中 ${(last.hitRate * 100).toFixed(1)}%  第${last.touch}次  花费 ${yuan(last.cost)}`)
      + `  间隔 ${Math.round(intervalMsOf(state, policy) / 60000)} 分`)
  }
  const totalCost = Object.values(state.ledger).flat().reduce((sum, e) => sum + (e.cost ?? 0), 0)
  const totalTouches = Object.values(state.ledger).flat().length
  console.log(`  累计        ${totalTouches} 次  共 ${yuan(totalCost)}`)
}

/** 极简参数解析。 */
function parseArgs(argv) {
  const out = {
    mode: undefined, id: undefined, force: false, interval: DEFAULT_TICK,
    /** `loop` 默认 **false**：`--serve` 只提供面板。要自动保温必须显式 `--serve --auto`。 */
    port: 19388, open: false, loop: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--list') out.mode = 'list'
    else if (a === '--status') out.mode = 'status'
    else if (a === '--serve') out.mode = 'serve'
    else if (a === '--dry-run') { out.mode = 'dry'; out.id = argv[++i] }
    else if (a === '--once') { out.mode = 'once'; out.id = argv[++i] }
    else if (a === '--loop') out.mode = 'loop'
    else if (a === '--force') out.force = true
    else if (a === '--open') out.open = true
    else if (a === '--no-loop') out.loop = false
    else if (a === '--auto') out.loop = true
    // --auto 才开守护；--no-loop 保留兼容（默认已经是关的）
    else if (a === '--port') {
      /** **非法端口必须报错**：早先 `--port abc` 会静默回落到 19388，用户以为换了端口其实没换。 */
      const raw = argv[++i]
      const v = Number(raw)
      if (raw === undefined || raw === '' || !Number.isInteger(v) || v < 1 || v > 65535) {
        console.error(`--port 需要一个 1~65535 的整数（收到 "${raw ?? ''}"）`)
        process.exit(1)
      }
      out.port = v
    }
    else if (a === '--interval') out.interval = Number(argv[++i]) || DEFAULT_TICK
    // 等号写法也要认（曾经 `--interval=600` 被静默忽略，拍间隔仍是 60）。
    else if (a.startsWith('--interval=')) out.interval = Number(a.slice('--interval='.length)) || DEFAULT_TICK
    else if (a.startsWith('--') && a.indexOf('=') > 0) {
        /** 其它未支持的等号写法：**报错并退出**（只 console.error 的话退出码仍是 0，脚本里 `|| exit 1` 感知不到）。 */
      console.error(`未知参数 ${a}（等号写法只支持 --interval=N；其余请用空格，如 --once <id>）`)
        process.exit(1)
    }
    else if (a === '--help' || a === '-h') out.mode = 'help'
  }
  return out
}

const HELP = `dsh-cache-keepalive 独立 CLI（**不依赖 DSH 运行时、也不需要任何实例在跑**）

三种模式（互斥；命令里出现哪个就是哪个）：

  --serve              起无实例面板。**端口固定 19388**，被占用即报错退出（不自动换端口）
  --serve --auto       面板 + 守护循环同进程（**会在真实 home 上花真钱，需 --yes-i-will-pay**）
  --loop               只跑守护循环，无面板（默认每 60 秒一拍；固定晚插件 90 秒起拍以免两边同时保同一条）
  --once <id>          只对一条会话立刻保温一次（**花钱，需 --yes-i-will-pay**）

  node cli/keepalive.mjs --serve                只起面板（默认 19388；**默认不自动保温**）
  node cli/keepalive.mjs --serve --open         同上，并自动用默认浏览器打开面板
  node cli/keepalive.mjs --serve --auto --yes-i-will-pay   面板 + 守护循环（会真花钱，启动会打警告框；缺付费确认直接 exit 3）
  node cli/keepalive.mjs --serve --no-loop      同上（兼容旧写法，等价于不带 --auto）
  node cli/keepalive.mjs --serve --port 19400   显式换端口（**只有它会换**；19388 被占也用它）
  node cli/keepalive.mjs --loop [--interval 秒] 只跑守护循环（无 UI；**花钱，需 --yes-i-will-pay**）
  node cli/keepalive.mjs --status               一眼看全现状（候选、上次命中、累计花费）
  node cli/keepalive.mjs --list                 列出会话与保温状态
  node cli/keepalive.mjs --dry-run <id>         只装配不发请求（自检，不花钱）
  node cli/keepalive.mjs --once <id>            立刻保温一次（真实调用）
  node cli/keepalive.mjs --once <id> --force    跳过门禁与图片安全阀强制保温

虚拟检查（零花费、零网络、不写 state.json / runtime.json）：
  node cli/keepalive.mjs --lab run              跑全部不变量（默认子命令），115 例
  node cli/keepalive.mjs --lab list             列不变量清单与已登记已知红
  node cli/keepalive.mjs --lab doctor           环境自检（Node / zstd / labMode 基底 / state.json 未被写）
  node cli/keepalive.mjs --lab verify           实验退出后有无遗留（只读，不自动清理）
  node cli/keepalive.mjs --lab live             真跑前体检（只读；加 --yes 才真发请求）
  node cli/keepalive.mjs --lab run --only=V3,V9 只跑指定不变量
  node cli/keepalive.mjs --lab run --json       stdout 只输出一段 ck-lab/1 JSON（日志全走 stderr）
  退出码：有未知红 → 1；只有已知红 → 0；环境错误 → 2

环境变量：
  DSH_HOME            DSH 主目录（默认 ~/.dsh）；会话日志在 $DSH_HOME/sessions
  DEEPSEEK_API_KEY    API Key（缺省时读 $DSH_HOME/.credentials.yaml 的 refs 段）
  DEEPSEEK_BASE_URL   API 根（默认 https://api.deepseek.com/anthropic）

说明：<id> 支持完整 id、尾号或任意片段。

它管的是**磁盘上的全部会话**（不只是某个实例进程里的）：直接从会话日志离线装配前缀，
所以不需要「激活」，也不占 DSH 内存。任意实例在跑或不在跑都不影响它。

守护循环的判定逻辑：
  · 总开关 settings.autoEnabled（只影响自动候选，强制开的会话照保）
  · 候选 = 强制开（mode=on）∪ 自动候选（mode=auto 且门禁认、闲置 ≤ idleLimitHours，取前 autoCount 条）
  · 跳过 mode=off / 已归档 / 无标题（仅 auto）/ 子代理（除非 autoAllowSubagent）
  · **不因"日志刚被写过 / 正在跑回合"跳过**：跑着也保（门禁的 too-soon 会挡住重复保温）
  · 真正发不发请求由门禁决定：闲置上限（门禁与自动共用）/ 保温间隔（含自适应）/ 预算 / 连续次数 / 熔断

建议先跑 --dry-run：
  它会报告装配规模、tool 配对、工具面稳定性、压缩次数、图片位置。
`

/**
 * `--lab live` 的真实实现（模块初始化完成后才跑，避免 TDZ）。
 *
 * 顺序：**样本体检（只读）→ 报告 →（--yes）D2/G0/建沙箱/灌配置+读回/会话校验/precheck →（arm）执行**。
 * 体检不发任何请求：只 `listSessions` + `assembleSession`（读日志）+ `decideWarm`（纯函数）。
 */
async function runPendingLive(p) {
  const { join: jn, resolve: rsv } = await import('node:path')
  const { existsSync, lstatSync, realpathSync, readdirSync, appendFileSync, mkdirSync } = await import('node:fs')
  const storeMod = await import(pathToUrl(join(SRC, 'store.ts')))
  const guard = await import(pathToUrl(join(SRC, 'core', 'lab', 'guard.ts')))
  const { labExpireIfDue } = await import(pathToUrl(join(SRC, 'core', 'settings.ts')))
  const { makeShadowHome } = await import(pathToUrl(join(SRC, 'core', 'lab', 'live.ts')))
  const { listSessions } = await import(pathToUrl(join(SRC, 'core', 'sessions.ts')))
  const { assembleSession } = await import(pathToUrl(join(SRC, 'core', 'assemble.ts')))
  const { buildGateInput } = await import(pathToUrl(join(SRC, 'core', 'gate-input.ts')))
  const { decideWarm } = await import(pathToUrl(join(SRC, 'gate.ts')))
  const { costOf } = await import(pathToUrl(join(SRC, 'econ.ts')))
  const say = (x) => console.log(x)
  const now = Date.now()

  /** ① 配置源（`--config-from` 或当前 home）—— 只读，不写。 */
  const cfgStateFile = jn(p.configFrom, 'cache-keepalive', 'state.json')
  const st = existsSync(cfgStateFile) ? storeMod.loadState(cfgStateFile) : undefined
  let expiredNote
  if (st !== undefined) {
    const ex = labExpireIfDue(st)
    if (ex !== undefined) expiredNote = ex.message
  }
  const settings = st?.settings ?? {}
  const allow = Array.isArray(settings.labSessionAllow) ? settings.labSessionAllow : []
  const budget = Number(settings.labBudgetPerRun ?? 0.5)
  const startedAt = Number(settings.labStartedAt ?? 0)
  const idleMs = Math.max(60_000, Number(settings.idleLimitHours ?? 8) * 3_600_000)
  /** 沙箱视角：账本为空（真跑时沙箱 state 就是空的）→ 门禁按「从没保过」判。 */
  const sandboxView = st === undefined ? undefined : { ...st, ledger: {} }

  /** ② 会话来自**真实 home**（沙箱的 sessions 是 junction 到它，二者同源）。 */
  const sessionsHome = p.userHome
  const rows = allow.length > 0 ? listSessions(sessionsHome) : []
  const byId = new Map(rows.map((r) => [r.id, r]))
  const lastPromptOf = (id) => st?.ledger?.[id]?.slice(-1)[0]?.promptTokens ?? 0

  /** ③ 逐条体检（只读：不联网、不写盘）。 */
  const health = []
  for (const id of allow) {
    const row = byId.get(id)
    const base = { id, prompt: lastPromptOf(id) }
    if (row === undefined) {
      health.push({ ...base, ok: false, why: '磁盘上无此会话（sessions 里找不到）' })
      continue
    }
    if (!(row.mtime > 0)) {
      health.push({ ...base, ok: false, why: '活动时间未知（日志 mtime=0）→ 会 cold-window' })
      continue
    }
    const ageMs = now - row.mtime
    const ageH = (ageMs / 3_600_000).toFixed(1)
    const idleH = (idleMs / 3_600_000).toFixed(1)
    let provider = ''
    let model = ''
    let asmErr = ''
    try {
      const asm = await assembleSession(row.logFile, settings.prompt ?? 'Reply with exactly: OK')
      if (asm.error !== undefined) asmErr = String(asm.error)
      provider = String(asm.config?.provider ?? '')
      model = String(asm.config?.model ?? '')
    } catch (e) {
      asmErr = e instanceof Error ? e.message : String(e)
    }
    let gateCode = 'n/a'
    if (sandboxView !== undefined) {
      const g = decideWarm(buildGateInput(sandboxView, {
        id, mtime: row.mtime, hasRoute: true, tripped: false,
        archived: row.archived === true, lastActivityAt: row.mtime, at: now,
      }))
      gateCode = g.ok ? 'warm' : String(g.code)
    }
    const prompt = base.prompt > 0 ? base.prompt : 50_000
    const worst = costOf({ inputTokens: prompt, outputTokens: 1 })
    const h = { ...base, provider, model, gateCode, ageH, worst, promptUsed: prompt }
    if (ageMs > idleMs) {
      health.push({ ...h, ok: false, why: `闲置 ${ageH}h > 门槛 ${idleH}h → 沙箱账本空会判 cold-window-idle（${gateCode}）` })
    } else if (provider === '') {
      health.push({ ...h, ok: false, why: `装配不出 provider/model${asmErr === '' ? '' : '：' + asmErr}` })
    } else if (!provider.toLowerCase().startsWith('deepseek')) {
      health.push({ ...h, ok: false, why: `第三方 provider（${provider}/${model}）→ warmOffline 不认，会 prepare: provider` })
    } else if (gateCode !== 'warm') {
      health.push({ ...h, ok: false, why: `门禁不出 warm（${gateCode}）→ 真跑会被 prepare 拦` })
    } else {
      health.push({ ...h, ok: true, why: '可跑' })
    }
  }
  const runnable = health.filter((h) => h.ok)
  const blocked = health.filter((h) => !h.ok)

  /** ④ 报告。 */
  const shadowDir = jn(HERE, '..', '.tmp', 'lab', p.runId)
  const precheck = []
  if (st === undefined) precheck.push(`配置源没有 state.json（${cfgStateFile}）`)
  else {
    if (settings.labMode !== true) precheck.push('labMode=off（必须先开试验模式）')
    if (allow.length === 0) precheck.push('labSessionAllow 为空（拒绝一切保温）')
    const ledger = Object.values(st.ledger ?? {}).flat()
    const over = guard.labOverBudget(st, ledger, startedAt)
    if (over.over) precheck.push(`本轮已花 ${guard.labYuan(over.spent)} 触顶 ${guard.labYuan(over.budget)}`)
  }
  /** **M2**：`--yes` 若没给 `--config-from`，配置来源会落成影子 home（新目录、白名单空）→ 明确说出来，别让人猜。 */
  const shadowRoot = jn(HERE, '..', '.tmp', 'lab')
  if (rsv(p.configFrom).startsWith(rsv(shadowRoot))) {
    precheck.push(`配置来源落在影子 home 里（${p.configFrom}）→ --yes 必须用 --config-from=<真实配置 home>`)
  }
  const report = {
    schema: 'ck-lab/1',
    mode: p.yes ? 'live' : 'dry-run',
    zeroCost: true,
    userHome: p.userHome,
    configFrom: p.configFrom,
    shadowHome: shadowDir,
    allow,
    budget,
    expiresAt: Number(settings.labExpiresAt ?? 0),
    idleLimitHours: Number(settings.idleLimitHours ?? 8),
    health: health.map((h) => ({
      id: h.id, ok: h.ok, why: h.why, provider: h.provider ?? '', model: h.model ?? '',
      ageHours: h.ageH ?? null, gateCode: h.gateCode ?? 'n/a', worst: h.worst ?? null,
    })),
    runnable: runnable.length,
    blocked: blocked.length,
    precheck,
    ...(expiredNote === undefined ? {} : { expiredNote }),
  }
  if (p.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  else {
    const log = (x) => console.log(x)
    log('=== --lab live（' + report.mode + '，零请求）===')
    if (expiredNote !== undefined) log('⚠️ ' + expiredNote)
    log(`用户真实 home（红线）：${p.userHome}`)
    log(`配置来源：${p.configFrom}`)
    log(`影子 home（拟建）：${shadowDir}`)
    log(`  真跑时须设 DSH_HOME=${jn(shadowDir, 'home')}（G0 硬断言）`)
    log(`白名单（labSessionAllow）：${allow.length} 条${allow.length === 0 ? '（空 = 拒绝一切）' : ''}`)
    for (const a of allow) log(`  · ${a}`)
    log(`预算（labBudgetPerRun）：${guard.labYuan(budget)}；闲置门槛：${report.idleLimitHours} 小时`)
    log(`到期（labExpiresAt）：${report.expiresAt > 0 ? new Date(report.expiresAt).toLocaleString() : '未设置'}`)
    log('')
    log('样本体检（只读：不联网 / 不写盘）')
    if (health.length === 0) log('  （白名单为空，无样本可体检）')
    for (const h of health) {
      if (h.ok) {
        log(`  ✅ ${String(h.id).slice(-12)}  ${h.provider}/${h.model}  闲置 ${h.ageH}h  门禁 ${h.gateCode}  预估最坏 ${guard.labYuan(h.worst)}`)
      } else {
        log(`  ⛔ ${String(h.id).slice(-12)}  ${h.why}`)
      }
    }
    log('')
    log(`汇总：可跑 ${runnable.length} 条 / 不可跑 ${blocked.length} 条` + (blocked.length > 0 ? '（先修样本再 arm）' : ''))
    log(`--yes 预检：${precheck.length === 0 ? '全部通过' : '会被拦住 → ' + precheck.join('；')}`)
    log('零请求：本命令只做只读扫描与算术，不调用任何网络函数、不发保温请求。')
  }

  /** ⑤ dry-run：有坏样本 → exit 1（提示先修样本），否则 0。 */
  if (!p.yes) process.exit(blocked.length > 0 ? 1 : 0)

  /** **M1**：没有任何可跑样本 → 不建目录、不灌配置，直接给出准确原因（原来会被读回校验抢先报成"落盘失败"）。 */
  if (runnable.length === 0) {
    process.stderr.write('拒绝执行：白名单里没有一条可跑样本（见上面的体检原因）→ 先修样本再 --yes\n')
    process.exit(3)
  }

  /** ⑥ --yes：D2 前置 → G0 字面 → 建沙箱 → 灌配置+读回 → sessions 校验 → G0 realpath → precheck。 */
  const shadowHomeAbs = rsv(jn(shadowDir, 'home'))
  const linkLike = (x) => { try { return lstatSync(x).isSymbolicLink() } catch { return false } }
  const linked = [shadowDir, jn(shadowDir, 'home')].filter(linkLike)
  if (linked.length > 0) {
    process.stderr.write('D2 前置检查失败（拒绝执行，零写盘）：影子路径是链接 → ' + linked.join('、') + '\n')
    process.exit(3)
  }
  const envHome = process.env.DSH_HOME
  const g0 = []
  if (envHome === undefined || envHome === '') g0.push('DSH_HOME 未设置（必须指向影子 home）')
  else {
    const envAbs = rsv(envHome)
    if (envAbs !== shadowHomeAbs) g0.push(`DSH_HOME=${envAbs} 不等于影子 home ${shadowHomeAbs}`)
    if (envAbs === rsv(p.userHome)) g0.push('DSH_HOME 指向真实 home（红线）')
  }
  if (g0.length > 0) {
    process.stderr.write('G0 路径断言失败（拒绝执行，且未创建任何目录）：' + g0.join('；') + '\n')
    process.exit(3)
  }
  let sh
  try {
    sh = await makeShadowHome({ runId: p.runId, baseDir: jn(HERE, '..', '.tmp', 'lab'), realDshHome: sessionsHome })
  } catch (e) {
    process.stderr.write('影子 home 创建失败（拒绝执行）：' + (e instanceof Error ? e.message : String(e)) + '\n')
    process.exit(3)
  }
  if (!p.json) {
    say('')
    say('影子 home 已创建：' + sh.dir)
    say(sh.note)
  }

  const shadowStateFile = jn(sh.dshHome, 'cache-keepalive', 'state.json')
  const shSt = storeMod.loadState(shadowStateFile)
  storeMod.setSettings(shSt, {
    labMode: true,
    labSessionAllow: runnable.map((h) => h.id),
    labBudgetPerRun: budget,
    labStartedAt: startedAt > 0 ? startedAt : Date.now(),
    labExpiresAt: Number(settings.labExpiresAt ?? 0),
  })
  storeMod.saveState(shSt, shadowStateFile)
  const back = storeMod.loadState(shadowStateFile)
  if (back.settings.labMode !== true
    || !Array.isArray(back.settings.labSessionAllow) || back.settings.labSessionAllow.length === 0
    || !(Number(back.settings.labStartedAt) > 0)) {
    sh.dispose()
    process.stderr.write('沙箱配置落盘校验失败（已清理影子 home）：' + JSON.stringify({ labMode: back.settings.labMode, allow: back.settings.labSessionAllow }) + '\n')
    process.exit(3)
  }
  if (!p.json) say(`已把试验配置灌进沙箱并读回校验：labMode=true / 白名单 ${back.settings.labSessionAllow.length} 条（只含可跑样本）`)

  const sessLink = jn(sh.dshHome, 'sessions')
  let sessCount = -1
  let sessReal = ''
  try {
    sessReal = realpathSync(sessLink)
    sessCount = readdirSync(sessLink).length
  } catch { sessCount = -1 }
  const sessTarget = (() => { try { return realpathSync(jn(sessionsHome, 'sessions')) } catch { return jn(sessionsHome, 'sessions') } })()
  if (sessCount <= 0 || sessReal !== sessTarget) {
    sh.dispose()
    process.stderr.write(`沙箱 sessions 校验失败（已清理影子 home）：列出 ${sessCount} 项，实际指向 ${sessReal || '(读不到)'}，期望 ${sessTarget}\n`)
    process.exit(3)
  }
  if (!p.json) say(`沙箱 sessions 校验：→ ${sessReal}（列出 ${sessCount} 个项目目录）`)

  const realOf = (x) => { try { return realpathSync(x) } catch { return rsv(x) } }
  if (realOf(envHome) !== realOf(sh.dshHome) || realOf(envHome) === realOf(p.userHome)) {
    sh.dispose()
    process.stderr.write('G0 realpath 复核失败（已清理刚建的影子 home）：realpath(DSH_HOME)=' + realOf(envHome) + '\n')
    process.exit(3)
  }
  if (precheck.length > 0) {
    sh.dispose()
    process.stderr.write('拒绝执行：' + precheck.join('；') + '\n')
    process.exit(3)
  }
  if (!p.arm) {
    if (!p.json) {
      say('')
      say('执行器已就绪（未 arm，未调用）；真跑需 `--arm`。本次零请求。')
      say(`影子 home 已建：${sh.dir}`)
    }
    process.exit(0)
  }

  /** ⑦ arm：取 key（只在内存）→ 只跑可跑样本。 */
  const { loadApiKey } = await import(pathToUrl(join(SRC, 'core', 'warm-offline.ts')))
  const key = loadApiKey(p.configFrom)
  if (key === undefined || key.trim() === '') {
    sh.dispose()
    process.stderr.write(`找不到 API Key（来源 ${p.configFrom}/.credentials.yaml 或环境变量）→ 拒绝执行\n`)
    process.exit(3)
  }
  process.env.DEEPSEEK_API_KEY = key
  if (!p.json) say('API Key：已读入进程内存（不落盘、不进 JSONL/日志）')
  const runsDir = jn(sh.dir, 'runs')
  mkdirSync(runsDir, { recursive: true })
  const jsonl = jn(runsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)
  const append = (row) => appendFileSync(jsonl, JSON.stringify(row) + '\n', 'utf8')
  append({ event: 'run-start', allow: back.settings.labSessionAllow, skipped: blocked.map((h) => h.id), at: Date.now() })
  const { stripped } = guard.stripPricePatch({})
  if (stripped.length > 0) append({ event: 'g6-ignored', keys: stripped, at: Date.now() })
  if (!p.json) {
    say('')
    say(`⚠️ --arm：开始执行（只跑可跑样本 ${runnable.length} 条；跳过 ${blocked.length} 条）`)
  }
  const res = await guard.runLabAttempts({
    arm: true,
    allow: runnable.map((h) => h.id),
    append,
    getState: () => storeMod.loadState(),
    prepare: async (id) => {
      const state = storeMod.loadState()
      const r = await prepareWarm(id, p.fakeSend ? { force: true, skipGate: true } : {})
      if (!r.ok) return { ok: false, id, code: r.code, detail: r.detail }
      const lastP = storeMod.ledgerOf(state, id).slice(-1)[0]?.promptTokens ?? 0
      const promptEst = Math.max(guard.promptTokensEstimate(r.plan?.request, lastP), lastP, 50_000)
      return { ok: true, id, worst: guard.worstCostOf(promptEst, 1, state.settings.prices), r }
    },
    send: p.fakeSend
      /** `--fake-send` 的假 usage 按 50k 未命中计（≈0.05 元），让预算截断能被真实验证到。 */
      ? async () => ({ ok: true, usage: { inputTokens: 50_000, outputTokens: 1 }, ms: 1, model: 'fake' })
      : async (prep) => sendWarm(prep.r),
    record: (prep, out) => {
      const { entry } = record(prep.r.row.id, out.usage, out.ms, prep.r.prompt, 'cli', out.model ?? prep.r.plan.config?.model, intervalMsOf(storeMod.loadState(), prep.r.policy))
      return { cost: entry.cost, hitRate: entry.hitRate, promptTokens: entry.promptTokens }
    },
  })
  if (!p.json) {
    say('')
    for (const r of res.results) {
      say(`  ${String(r.id).slice(-12)}  ${r.ok ? '✅ 成功 ' + guard.labYuan(r.cost ?? 0) : '⛔ ' + (r.why ?? '失败')}`)
    }
    say(`JSONL 留证：${jsonl}`)
  }
  if (res.aborted !== undefined) {
    if (!p.json) say('中止：' + res.aborted)
    process.exit(1)
  }
  process.exit(0)
}

if (globalThis.__CK_PENDING_LIVE__ !== undefined) {
  await runPendingLive(globalThis.__CK_PENDING_LIVE__)
}

const args = parseArgs(process.argv.slice(2))

let code = 0

try {
  if (args.mode === 'list') await cmdList()
  else if (args.mode === 'status') cmdStatus()
  else if (args.mode === 'serve') code = await cmdServe(args.port, args.open, args.loop, args.interval)
  else if (args.mode === 'dry') code = await cmdDryRun(args.id)
  else if (args.mode === 'once') code = await cmdOnce(args.id, { force: args.force })
  else if (args.mode === 'loop') await cmdLoop(args.interval)
  else console.log(HELP)
} catch (e) {
  console.error('出错:', e instanceof Error ? e.message : String(e))
  code = 1
}
/**
 * 退出前先把 fetch 的连接池关掉。
 *
 * `warmOffline()` 用 `fetch`（undici）拿 OpenAI 兼容响应；直接 `process.exit` 时
 * keep-alive 的 socket 还挂着，Windows 上会触发
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 并让退出码变 1 —— 明明保温成功了。
 */
try {
  const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')]
  if (dispatcher !== undefined && typeof dispatcher.close === 'function') await dispatcher.close()
} catch { /* 没有 undici 或已关闭，忽略 */ }
process.exit(code)
