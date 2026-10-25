/**
 * **ctx 桩冒烟**：用最小假 ctx 真的调一次 `apply()`，再调注册出来的工具。
 *
 * 为什么必须做：本轮按行号批量删了大量代码，而
 *  - `node --check` 只查语法
 *  - `check-imports` 只查跨模块导入
 * 两者都查不出「同文件里删了定义、却还留着调用」——那会以 `ReferenceError` 在运行时炸。
 * 这个桩把 `apply()` 与 `status/settings/timeline` 三条最复杂的路径真跑一遍。
 */
import { mkdtempSync } from 'node:fs'
import { assertNotRealHome } from './assert-temp-home.mjs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const { apply } = await import('../src/index.ts')

/** 收集注册的工具，便于冒烟调用。 */
const tools = new Map()
/** 收集 interval / effect，便于清理。 */
const disposers = []

const fakeLogger = { info: (m) => { if (process.env.SMOKE_VERBOSE) console.log('[log]', m) }, warn() {}, error() {} }

/** 一个什么都不做的服务桩。 */
/** 最小活会话桩：让 gateInputFor() 真的跑起来（它是 tick / 面板最常走的路径）。 */
const fakeAgent = {
  status: 'idle',
  session: {
    id: 'session-fake-00000000-0000-0000-0000-000000000001',
    requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
  },
}

const fakeCtx = {
  logger: fakeLogger,
  on() { return () => {} },
  get(name) {
    if (name === 'agents') return { list: () => [fakeAgent] }
    if (name === 'profileContext') return { name: 'smoke' }
    if (name === 'webServer') return { port: 19999, register: () => () => {}, tapIndex: () => () => {} }
    if (name === 'sessionProjections') return { stateOf: () => undefined }
    if (name === 'sessionController') return { resolveAgent: async () => {} }
    return undefined
  },
  tools: {
    register(tool) {
      tools.set(tool.name, tool)
      return () => tools.delete(tool.name)
    },
    schemas() { return [] },
  },
  setInterval(fn, ms) {
    void fn; void ms
    return () => {}
  },
  setInterval$: undefined,
  effect(fn) {
    const d = fn()
    const dispose = typeof d === 'function' ? d : () => {}
    disposers.push(dispose)
    return dispose
  },
  inject(_deps, cb) {
    // 模拟 webServer 注入：直接调回调，传一个带 webServer 的子 ctx
    try { cb(fakeCtx) } catch (e) { console.log('  inject 回调抛错:', e?.message ?? e) }
    return () => {}
  },
  llm: { stream: async function* () { yield { type: 'usage', usage: {} } } },
}

/**
 * 默认用**临时** DSH_HOME：闸门不能改用户的真实 `state.json`。
 * 临时 home 里没有会话日志，所以 snapshot 是空的 —— 它验的是「代码路径不炸」，
 * 不是「数据对不对」（后者由 check-cli-assemble / check-real-data 负责）。
 * 想拿真实数据跑：`--real`。
 */
const useReal = process.argv.includes('--real')
if (!useReal) {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'ck-smoke-'))
} else {
  process.env.DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
}

let failed = 0
const say = (ok, msg, extra) => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}${ok || extra === undefined ? '' : '\n      ' + String(extra).slice(0, 400)}`)
}

// ① apply 不抛错
try {
  apply(fakeCtx, { tickMs: 60_000 })
  say(true, 'apply() 跑通（无 ReferenceError）')
} catch (e) {
  say(false, 'apply() 抛错', e?.stack ?? e)
}

// ② 注册出来的工具
say(tools.has('cache_keepalive'), `注册了 cache_keepalive（共 ${tools.size} 个：${[...tools.keys()].join(',')}）`)

const exec = async (name, args) => {
  const tool = tools.get(name)
  if (tool === undefined) return { __missing: true }
  try {
    return await tool.execute(args, { agent: undefined })
  } catch (e) {
    return { __error: e?.stack ?? String(e) }
  }
}

const brief = (r) => {
  if (r === undefined || r === null) return '(空)'
  if (r.__error !== undefined) return 'ERROR ' + r.__error
  const text = String(r.text ?? '')
  return text.split('\n').slice(0, 3).join(' ⏎ ')
}

// ③ statusReport（覆盖 snapshot / candidatePool / 自动候选 / 门禁）
{
  const r = await exec('cache_keepalive', { action: 'status' })
  say(r.__error === undefined, 'cache_keepalive status 跑通', r.__error)
  if (r.__error === undefined) console.log('      ' + brief(r))
}

// ④ settingsReport
{
  const r = await exec('cache_lab', { action: 'settings' })
  say(r.__error === undefined, 'cache_lab settings 跑通', r.__error)
  if (r.__error === undefined) console.log('      ' + brief(r))
}

// ⑤ sessionsReport
{
  const r = await exec('cache_lab', { action: 'sessions' })
  say(r.__error === undefined, 'cache_lab sessions 跑通', r.__error)
}

// ⑥ timeline（覆盖 timelineOf + sumByTurn + costAt 三处聚合）
{
  const r = await exec('cache_lab', { action: 'timeline', sessionId: '1f64b53f' })
  const ok = r.__error === undefined && (useReal ? !String(r.text ?? '').startsWith('timeline 需要') : true)
  say(ok, 'cache_lab timeline 跑通（step 粒度）', r.__error)
  const r2 = await exec('cache_lab', { action: 'timeline', sessionId: '1f64b53f', granularity: 'both' })
  say(r2.__error === undefined, 'cache_lab timeline 跑通（both 粒度）', r2.__error)
}

// ⑦ set-settings 往返（覆盖 applySettings 的新字段，不该出现 autoActivate 残留）
{
  const r = await exec('cache_lab', { action: 'set-settings', costScope: 'total' })
  say(r.__error === undefined, 'cache_lab set-settings 跑通', r.__error)
  const r2 = await exec('cache_lab', { action: 'set-settings', costScope: 'cycle' })
  say(r2.__error === undefined, '恢复 costScope=cycle', r2.__error)
}

// ⑧ help 与 lab
{
  const r = await exec('cache_lab', { action: 'help' })
  say(r.__error === undefined, 'cache_lab help 跑通', r.__error)
  const r2 = await exec('cache_keepalive', { action: 'on', sessionId: 'nope-xyz' })
  say(r2.__error === undefined, '对不存在会话执行 on 不抛错', r2.__error)
}

// ⑨ 离线保温：错路径要明确报错、不能崩
{
  const { warmOffline } = await import('../src/core/warm-offline.ts')
  const r1 = await warmOffline({ logFile: 'C:/definitely/not/here.zstd', prompt: 'x', dshHome: process.env.DSH_HOME })
  // 顺序：先装配，再判 provider/key（第三方 provider 用自己的 key，不该先要 DeepSeek 的 key）
  say(r1.ok === false && String(r1.error ?? '').includes('装配失败'), 'warmOffline 日志不存在时先报装配失败', r1.error)
  const r2 = await warmOffline({ logFile: 'C:/definitely/not/here.zstd', prompt: 'x', apiKey: 'fake', dshHome: process.env.DSH_HOME })
  say(r2.ok === false && String(r2.error ?? '').includes('装配失败'), 'warmOffline 日志不存在时报装配失败', r2.error)
  /**
   * **直连分支缺 key 必须明确报错**（第三方走自己的 key，不该报这句）。
   * 只在临时 home 下测：真实 home 有 credentials，测不到缺 key。
   */
  if (!useReal) {
    const { listSessions } = await import('../src/core/sessions.ts')
    const { assembleSession } = await import('../src/core/assemble.ts')
    let picked
    try {
      for (const row of listSessions(join(homedir(), '.dsh'), { headBytes: 64 * 1024 }).slice(0, 20)) {
        const a2 = assembleSession(row.logFile, 'x')
        if (/deepseek/i.test(String(a2.config?.provider ?? ''))) { picked = row; break }
      }
    } catch { /* 没有真实会话就跳过这条 */ }
    if (picked === undefined) {
      console.log('SKIP  本机找不到 deepseek 官方会话，直连缺 key 分支未测')
    } else {
      const r3 = await warmOffline({ logFile: picked.logFile, prompt: 'x', dshHome: process.env.DSH_HOME })
      say(r3.ok === false && String(r3.error ?? '').includes('API Key'), 'warmOffline 直连 DeepSeek 缺 key 时明确报错', r3.error)
    }
  }
}

/**
 * ⑩ 另一个进程记的账，插件内存态必须看得见。
 *
 * 真事故：连续保温最后一次 89.1% 一直不进面板详情 —— 插件进程内存持有一份 `state`，
 * 独立 CLI 是另一个进程，它写的账本插件永远看不到。`syncState()` 就是修这个的。
 */
{
  const { statePath, loadState, appendLedger, saveState } = await import('../src/store.ts')

/** 护栏：任何会写盘的测试都不许落在真实 ~/.dsh（2026-10-19 事故）。 */
assertNotRealHome(statePath())
  const file = statePath()
  const id = 'session-fake-00000000-0000-0000-0000-000000000001'
  const ext = loadState(file)
  appendLedger(ext, id, {
    at: Date.now(), gapSeconds: 60, promptTokens: 430736, hitTokens: 383000,
    missTokens: 47736, outputTokens: 1, cacheWriteTokens: 0, cost: 0.0547,
    hitRate: 0.891, ms: 557, touch: 3, via: 'panel', model: 'deepseek-flash', cycle: 2,
  })
  saveState(ext, file)
  const r = await exec('cache_lab', { action: 'sessions' })
  say(String(r.text ?? '').includes('89.1%'), '外部进程写入的账本（89.1%）在插件快照里可见', r.text)
  await exec('cache_lab', { action: 'set-settings', costScope: 'cycle' })
  const after = loadState(file)
  say((after.ledger[id] ?? []).length === 1, '插件写盘后外部账本条目没被覆盖')
}

/**
 * ⑫ `cache_lab action=experiment`：虚拟不变量检查（零花费、不联网、不写盘）。
 * 断言：返回人读摘要（含 通过/已知红/未知红 与复现命令），且**不是**整段 JSON、不含 `"suites"`。
 */
{
  const r = await exec('cache_lab', { action: 'experiment', spec: '{"only":["V3"]}' })
  const text = String(r.text ?? '')
  say(r.__error === undefined, 'cache_lab experiment 跑通（spec 只跑 V3）', r.__error)
  say(text.includes('ck-lab/1') && text.includes('V3'), 'experiment 返回摘要含 schema 与 V3', text)
  say(text.includes('复现：node cli/keepalive.mjs --lab run --only=V3'), 'experiment 摘要给出复现命令', text)
  say(!text.includes('"suites"'), 'experiment 返回人读摘要而不是整段 JSON', text)
  const bad = await exec('cache_lab', { action: 'experiment', spec: '{不是JSON' })
  say(String(bad.text ?? '').includes('不是合法 JSON'), 'spec 非法时给可读报错（不抛）', bad.text)
}

/**
 * ⑬ 退出试验模式的事务性（**插件长驻 state 这条路径**，R1 就在这里丢过用户设置）。
 *
 * 旧缺陷：`delete state.labBackup` 在关系校验之前 → 第一次退出被拒、备份已没了；
 * 第二次退出「成功」但参数永久停在 30s / 99 次（原值静默丢失）。
 * 这里用 `cache_lab set-settings` 真的走两遍：先造非法 labBackup（间隔 9h > 上限 8h），
 * 断言第 1 次被拒且参数没变；再把上限抬到 10h 退出，断言四项逐字段还原。
 */
{
  const { statePath, loadState, saveState } = await import('../src/store.ts')
  const file = statePath()
  const st = loadState(file)
  // 进入试验模式（记下原值），再人为把备份改成非法
  const beforeInterval = st.settings.intervalSeconds
  const beforeFresh = st.settings.freshSeconds
  const beforeTouches = st.settings.maxTouches
  await exec('cache_lab', { action: 'set-settings', labMode: true })
  const labbed = loadState(file)
  labbed.labBackup = { intervalSeconds: 9 * 3600, freshSeconds: 300, maxTouches: 9, circuitCooldownSeconds: 0 }
  labbed.settings.idleLimitHours = 8
  saveState(labbed, file)

  const first = await exec('cache_lab', { action: 'set-settings', labMode: false, idleLimitHours: 1 })
  const afterFirst = loadState(file)
  say(String(first.text ?? '').includes('本次保存整批未生效'), '第 1 次退出（备份非法）被整批拒绝', first.text)
  say(afterFirst.settings.labMode === true && afterFirst.labBackup?.intervalSeconds === 9 * 3600,
    '★ 被拒后 labMode 仍为 true 且 labBackup 仍在（不再丢用户设置）',
    `labMode=${afterFirst.settings.labMode} labBackup=${JSON.stringify(afterFirst.labBackup)}`)

  const second = await exec('cache_lab', { action: 'set-settings', labMode: false, idleLimitHours: 10 })
  const afterSecond = loadState(file)
  say(String(second.text ?? '').includes('已更新'), '第 2 次退出（上限抬到 10h）成功', second.text)
  say(afterSecond.settings.labMode === false && afterSecond.labBackup === undefined
    && afterSecond.settings.intervalSeconds === 9 * 3600
    && afterSecond.settings.freshSeconds === 300
    && afterSecond.settings.maxTouches === 9,
    '★ 退出后参数逐字段还原（间隔/fresh/次数 回到备份值），labBackup 已清',
    `interval=${afterSecond.settings.intervalSeconds} fresh=${afterSecond.settings.freshSeconds} maxTouches=${afterSecond.settings.maxTouches} labBackup=${JSON.stringify(afterSecond.labBackup)}`)

  // 收尾：把环境恢复成进入本段之前的样子，别污染后面的断言
  await exec('cache_lab', { action: 'set-settings', intervalSeconds: beforeInterval, freshSeconds: beforeFresh, maxTouches: beforeTouches, idleLimitHours: 8 })
}

/**
 * ⑪ 熔断会话必须被判成「不入选（gate）」——**候选判定只走 `core/candidates.ts`** 的行为样本。
 *
 * 为什么需要：核验员做过变异 —— 把 `src/index.ts` 的候选池改回手写 `gateOk` 后全套脚本全绿逃逸。
 * 这里造一条真熔断（连续两条低命中（宽限功能已删，熔断直接生效）），
 * 断言 `cache_keepalive status` 的输出是 `自动候选=否(gate)`：手写链路若漏传 `tripped`，
 * 会把它误判成入选（输出变成 `自动候选=是(#n)`）。
 */
{
  const { statePath, loadState, appendLedger, saveState } = await import('../src/store.ts')
  const file = statePath()
  const id = 'session-fake-00000000-0000-0000-0000-000000000001'
  const ext = loadState(file)
  for (const at of [Date.now() - 120_000, Date.now() - 60_000]) {
    appendLedger(ext, id, {
      at, gapSeconds: 60, promptTokens: 100_000, hitTokens: 1_000,
      missTokens: 99_000, outputTokens: 1, cacheWriteTokens: 0, cost: 0.099,
      hitRate: 0.01, ms: 500, touch: 1, via: 'panel', model: 'deepseek-flash', cycle: 1,
    })
  }
  saveState(ext, file)
  const r = await exec('cache_keepalive', { action: 'status' })
  const text = String(r.text ?? '')
  say(text.includes('自动候选=否(gate)'), '熔断会话的候选结论是「否(gate)」（候选判定走库函数，没漏 tripped）', text)
  await exec('cache_lab', { action: 'set-settings', costScope: 'cycle' })
}

for (const d of disposers) { try { d() } catch { /* 清理失败无所谓 */ } }
console.log('')
console.log(failed === 0 ? '✅ ctx 桩冒烟全绿' : `❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
