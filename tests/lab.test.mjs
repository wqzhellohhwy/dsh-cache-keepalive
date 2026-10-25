/**
 * 试验护栏 + 影子 home + 到期自愈的单测 —— 零花费、不发请求、不碰用户 state.json。
 * 跑法：`node --test tests/lab.test.mjs`
 *
 * 临时目录：与 `tests/store-lock.test.mjs` 同样在仓库 `.tmp/` 下自建自删（本仓库没有 `tests/_tmp.js`）。
 */
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendLabPending, cycleSpendOf, DEFAULT_SETTINGS, labPendingWorstOf, loadState, saveState, setSettings, settleLabPending,
} from '../src/store.ts'
import { applySettingsPatch, labExpireIfDue } from '../src/core/settings.ts'
import {
  labAllowed, labAllowsForward, labOverBudget, labSpendOf, labVerdict, runLabAttempts, stripPricePatch, worstCostOf,
} from '../src/core/lab/guard.ts'
import { makeShadowHome, shadowResidue } from '../src/core/lab/live.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WORK = join(HERE, '..', '.tmp')

function mkState(over = {}) {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS, ...over },
    sessions: {},
    ledger: {},
    pinnedSessions: [],
  }
}

function entry(at, cost) {
  return {
    at, gapSeconds: 0, promptTokens: 400000, hitTokens: 400000, missTokens: 0, outputTokens: 1,
    cost, hitRate: 1, ms: 1, touch: 1,
  }
}

const cases = []

/** ① 非试验模式：护栏必须恒放行（生产行为零变化）。 */
cases.push(['★ 非试验模式 labVerdict 恒放行（labMode=false，空账本）', () => {
  const st = mkState()
  const v = labVerdict(st, 'any-session', [])
  return v.ok === true && v.step === 'mode'
}])

cases.push(['★ 非试验模式 + 超预算数字也不拦（护栏只在 labMode 生效）', () => {
  const st = mkState({ labBudgetPerRun: 0, labStartedAt: 1 })
  const v = labVerdict(st, 'any', [entry(Date.now(), 999)])
  return v.ok === true && v.step === 'mode'
}])

/** ② 试验模式 + 空白名单 → 拒绝一切。 */
cases.push(['试验模式 + 空白名单 → 拒绝（allowlist）', () => {
  const st = mkState({ labMode: true, labSessionAllow: [] })
  const v = labVerdict(st, 's1', [])
  return v.ok === false && v.step === 'allowlist'
}])

cases.push(['试验模式 + 白名单外会话 → 拒绝', () => {
  const st = mkState({ labMode: true, labSessionAllow: ['s1'] })
  const v = labAllowed(st, 's2')
  return v.ok === false && v.step === 'allowlist'
}])

cases.push(['试验模式 + 白名单内会话 → 放行', () => {
  const st = mkState({ labMode: true, labSessionAllow: ['s1'] })
  const v = labVerdict(st, 's1', [])
  return v.ok === true && v.step === 'budget'
}])

/** ③ 本轮花费与预算。 */
cases.push(['labSpendOf：sinceAt<=0（没有进行中的试验）→ 本轮 0，不看历史账本', () => {
  const led = [entry(1000, 9.9), entry(2000, 9.9)]
  return labSpendOf(led, 0) === 0
}])

cases.push(['labSpendOf：只累加 at >= sinceAt 的条目', () => {
  const led = [entry(1000, 1), entry(5000, 2), entry(9000, 4)]
  return labSpendOf(led, 3000) === 6
}])

cases.push(['labOverBudget：本轮花费 ≥ 上限 → 触顶', () => {
  const st = mkState({ labBudgetPerRun: 0.5, labMode: true })
  const r = labOverBudget(st, [entry(5000, 0.6)], 1000)
  return r.over === true && Math.abs(r.spent - 0.6) < 1e-9 && r.budget === 0.5
}])

cases.push(['labOverBudget：上限 0 = 不限', () => {
  const st = mkState({ labBudgetPerRun: 0 })
  const r = labOverBudget(st, [entry(5000, 99)], 1000)
  return r.over === false
}])

cases.push(['试验模式 + 白名单内但本轮超预算 → 拒绝（budget）', () => {
  const st = mkState({ labMode: true, labSessionAllow: ['s1'], labBudgetPerRun: 0.5, labStartedAt: 1000 })
  const v = labVerdict(st, 's1', [entry(5000, 0.6)])
  return v.ok === false && v.step === 'budget'
}])

/** ④ 到期自愈。 */
cases.push(['★ 到期自愈：labExpiresAt 已过 → 自动退出并还原参数', () => {
  const st = mkState()
  const before = { intervalSeconds: st.settings.intervalSeconds, freshSeconds: st.settings.freshSeconds }
  applySettingsPatch(st, { labMode: true })
  if (st.settings.intervalSeconds !== 30) return false
  st.settings.labExpiresAt = Date.now() - 1000
  const r = labExpireIfDue(st, Date.now())
  return r !== undefined && r.restored === true
    && st.settings.labMode === false
    && st.settings.intervalSeconds === before.intervalSeconds
    && st.settings.freshSeconds === before.freshSeconds
    && st.settings.labExpiresAt === 0
    && st.labBackup === undefined
}])

cases.push(['到期自愈：还没到点 → 不处理（返回 undefined）', () => {
  const st = mkState()
  applySettingsPatch(st, { labMode: true })
  st.settings.labExpiresAt = Date.now() + 60_000
  return labExpireIfDue(st, Date.now()) === undefined && st.settings.labMode === true
}])

cases.push(['进试验模式自动设 2 小时到期 + 本轮起点', () => {
  const st = mkState()
  const t0 = Date.now()
  applySettingsPatch(st, { labMode: true })
  return st.settings.labExpiresAt >= t0 + 2 * 3600_000 - 5000
    && st.settings.labExpiresAt <= Date.now() + 2 * 3600_000 + 5000
    && typeof st.settings.labStartedAt === 'number' && st.settings.labStartedAt >= t0
}])

/** ⑤ 影子 home 建 / 删（全程用自造假真实 home，绝不碰用户目录）。 */
function fakeRealHome(tag) {
  const real = join(WORK, `lab-test-real-${tag}`)
  mkdirSync(join(real, 'sessions'), { recursive: true })
  mkdirSync(join(real, 'attachments', 'v1'), { recursive: true })
  writeFileSync(join(real, 'sessions', 'keep.txt'), 'real-session-bytes', 'utf8')
  writeFileSync(join(real, 'attachments', 'v1', 'a.bin'), 'img', 'utf8')
  return real
}

let shadowOk = false
let shadowDetail = ''
const realHome = fakeRealHome('A')
const shadowBase = join(WORK, 'lab-test-shadow')
try {
  const sh = await makeShadowHome({ runId: 'run-1', baseDir: shadowBase, realDshHome: realHome })
  const stFile = join(sh.dshHome, 'cache-keepalive', 'state.json')
  const stJson = JSON.parse(readFileSync(stFile, 'utf8'))
  const sessionsLink = join(sh.dshHome, 'sessions')
  const attLink = join(sh.dshHome, 'attachments')
  const checks = {
    sessionsIsLink: lstatSync(sessionsLink).isSymbolicLink(),
    attachmentsIsLink: lstatSync(attLink).isSymbolicLink(),
    stateFresh: stJson.ledger !== undefined && Object.keys(stJson.ledger).length === 0
      && Object.keys(stJson.sessions).length === 0,
    noRuntime: !existsSync(join(sh.dshHome, 'cache-keepalive', 'runtime.json')),
    noteMentionsAccountLevel: sh.note.includes('账号级'),
    readsRealSessions: readFileSync(join(sessionsLink, 'keep.txt'), 'utf8') === 'real-session-bytes',
  }
  sh.dispose()
  const afterDispose = {
    dirGone: shadowResidue(sh.dir).length === 0,
    realSessionsIntact: readFileSync(join(realHome, 'sessions', 'keep.txt'), 'utf8') === 'real-session-bytes',
    realAttachmentsIntact: existsSync(join(realHome, 'attachments', 'v1', 'a.bin')),
  }
  shadowOk = Object.values(checks).every(Boolean) && Object.values(afterDispose).every(Boolean)
  shadowDetail = JSON.stringify({ ...checks, ...afterDispose })
} catch (e) {
  shadowDetail = e instanceof Error ? e.message : String(e)
}
cases.push(['★ 影子 home：junction/全新 state/无 runtime/说明含账号级 + dispose 后无残留且真实目录完好', () => shadowOk])
if (!shadowOk) console.log('   影子 home 细节：' + shadowDetail)

cases.push(['影子 home 幂等：同名 runId 再建一次不报错', () => {
  return (async () => {
    const sh = await makeShadowHome({ runId: 'run-2', baseDir: shadowBase, realDshHome: realHome })
    const again = await makeShadowHome({ runId: 'run-2', baseDir: shadowBase, realDshHome: realHome })
    again.dispose()
    sh.dispose()
    return shadowResidue(sh.dir).length === 0
  })()
}])

/** ⑥ 零请求：护栏判定 + 影子 home 建立/销毁全程不得碰网络（`fetch` 计数桩）。 */
cases.push(['★ 护栏 + 影子 home 全程零网络调用（fetch 桩计数 0）', () => {
  return (async () => {
    const orig = globalThis.fetch
    let calls = 0
    globalThis.fetch = () => { calls += 1; return Promise.reject(new Error('不该发请求')) }
    try {
      const st = mkState({ labMode: true, labSessionAllow: ['s1'], labBudgetPerRun: 0.5, labStartedAt: 1 })
      labVerdict(st, 's1', [entry(2, 0.1)])
      labOverBudget(st, [entry(2, 0.1)], 1)
      const sh = await makeShadowHome({ runId: 'run-net', baseDir: shadowBase, realDshHome: realHome })
      sh.dispose()
    } finally {
      globalThis.fetch = orig
    }
    return calls === 0
  })()
}])

/** ⑦ G2 单次最坏花费预留。 */
cases.push(['worstCostOf：693k + 1 → 0.693001 元', () => {
  return Math.abs(worstCostOf(693_000, 1, { hit: 0.02, miss: 1, out: 4 }) - 0.693001) < 1e-9
}])

cases.push(['worstCostOf：208k + 1 → 0.208001 元', () => {
  return Math.abs(worstCostOf(208_000, 1, { hit: 0.02, miss: 1, out: 4 }) - 0.208001) < 1e-9
}])

cases.push(['worstCostOf：prompt=0 + 1 → 0.000001 元（只有输出）', () => {
  return Math.abs(worstCostOf(0, 1, { hit: 0.02, miss: 1, out: 4 }) - 0.000001) < 1e-9
}])

cases.push(['★ G2：已花 0.4 + 本次最坏 0.21 > 上限 0.5 → 拒绝（reserve），原因带 worst/剩余', () => {
  const st = mkState({ labMode: true, labSessionAllow: ['s1'], labBudgetPerRun: 0.5, budgetPerSession: 0.5, labStartedAt: 1000 })
  const v = labVerdict(st, 's1', [entry(2000, 0.4)], 0.21)
  return v.ok === false && v.step === 'reserve' && v.why.includes('0.2100') && v.why.includes('剩余')
}])

cases.push(['G2：已花 0.4 + 最坏 0.05 ≤ 0.5 → 放行', () => {
  const st = mkState({ labMode: true, labSessionAllow: ['s1'], labBudgetPerRun: 0.5, budgetPerSession: 0.5, labStartedAt: 1000 })
  const v = labVerdict(st, 's1', [entry(2000, 0.4)], 0.05)
  return v.ok === true && v.step === 'reserve'
}])

cases.push(['★ 非试验模式即使 worst 巨大也放行（G2 同样只在 labMode 生效）', () => {
  const st = mkState({ budgetPerSession: 0.01 })
  const v = labVerdict(st, 'any', [entry(1, 99)], 999)
  return v.ok === true && v.step === 'mode'
}])

/** ⑧ G5 禁转发。 */
cases.push(['★ G5 labAllowsForward：非试验 → 允许转发', () => labAllowsForward(mkState()) === true])

cases.push(['★ G5 labAllowsForward：试验模式 → 禁止转发', () => {
  return labAllowsForward(mkState({ labMode: true })) === false
}])

cases.push(['★ G5 硬闸确实挂在 CLI 的 tryForwardToDsh 上（源码断言，防回退）', () => {
  const src = readFileSync(join(HERE, '..', 'cli', 'keepalive.mjs'), 'utf8')
  const at = src.indexOf('async function tryForwardToDsh')
  const body = src.slice(at, at + 900)
  return at > 0 && body.includes('labAllowsForward(')
}])

/** ⑨ R2：插件 `/ping` 的离线分支也必须被护栏拦住（核验员实测过绕过）。 */
cases.push(['★ R2 桩：labMode=true + 空白名单 + 历史会话 /ping → llm.stream 与 fetch 计数都为 0', () => {
  return (async () => {
    const { EventEmitter } = await import('node:events')
    const { zstdCompressSync } = await import('node:zlib')
    const home = join(WORK, 'lab-test-r2-home')
    mkdirSync(join(home, 'cache-keepalive'), { recursive: true })
    mkdirSync(join(home, 'sessions', 'p1', 'session-r2-0001'), { recursive: true })
    const log = [
      JSON.stringify({ type: 'session', id: 'session-r2-0001', cwd: '/tmp/w', createdAt: 1 }),
      JSON.stringify({
        type: 'assistant/message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { provider: 'deepseek-official', model: 'deepseek-flash' } },
      }),
    ].join('\n') + '\n'
    writeFileSync(join(home, 'sessions', 'p1', 'session-r2-0001', 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(log, 'utf8')))
    writeFileSync(join(home, 'cache-keepalive', 'state.json'), JSON.stringify({
      version: 1,
      settings: { ...DEFAULT_SETTINGS, labMode: true, labSessionAllow: [], labStartedAt: Date.now() - 60_000 },
      sessions: {}, ledger: {}, pinnedSessions: [],
    }, null, 2), 'utf8')
    const prevHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    let streamCalls = 0
    let fetchCalls = 0
    const routes = []
    const ws = { port: 19998, register: (r) => { routes.push(r); return () => {} }, tapIndex: () => () => {} }
    const fakeCtx = {
      logger: { info() {}, warn() {}, error() {} },
      on() { return () => {} },
      get(name) {
        if (name === 'agents') return { list: () => [] }
        if (name === 'profileContext') return { name: 'r2' }
        if (name === 'webServer') return ws
        if (name === 'sessionProjections') return { stateOf: () => undefined }
        if (name === 'sessionController') return { resolveAgent: async () => {} }
        return undefined
      },
      tools: { register() { return () => {} }, schemas() { return [] } },
      setInterval() { return () => {} },
      effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
      inject(_d, cb) { try { cb({ ...fakeCtx, webServer: ws }) } catch { /* ignore */ } return () => {} },
      llm: { stream: async function* () { streamCalls += 1; yield { type: 'usage', usage: {} } } },
    }
    const origFetch = globalThis.fetch
    globalThis.fetch = () => { fetchCalls += 1; return Promise.reject(new Error('no network')) }
    let body = ''
    try {
      const { apply } = await import('../src/index.ts')
      apply(fakeCtx)
      const route = routes.find((r) => r && typeof r.path === 'string' && r.path.endsWith('/ping'))
      if (route === undefined) return false
      const req = new EventEmitter()
      req.method = 'POST'
      req.setTimeout = () => req
      queueMicrotask(() => { req.emit('data', Buffer.from(JSON.stringify({ id: 'session-r2-0001', force: true }))); req.emit('end') })
      const res = { writeHead() {}, end(s) { body = String(s ?? '') }, setHeader() {} }
      await route.handler(req, res)
      await new Promise((r) => setTimeout(r, 100))
    } finally {
      globalThis.fetch = origFetch
      if (prevHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prevHome
    }
    const blocked = body.includes('试验护栏拦截')
    return streamCalls === 0 && fetchCalls === 0 && blocked
  })()
}])

/** ⑩ R1：真实 home 缺 attachments 时，dispose 也要把自建的空目录删掉。 */
cases.push(['★ R1 真实 home 只有 sessions（缺 attachments）→ dispose 后零残留', () => {
  return (async () => {
    const only = join(WORK, 'lab-test-real-C')
    mkdirSync(join(only, 'sessions'), { recursive: true })
    writeFileSync(join(only, 'sessions', 'k.txt'), 'x', 'utf8')
    const sh = await makeShadowHome({ runId: 'run-r1', baseDir: join(WORK, 'lab-test-shadow-r1'), realDshHome: only })
    sh.dispose()
    const left = shadowResidue(sh.dir)
    const realOk = existsSync(join(only, 'sessions', 'k.txt'))
    try { rmSync(only, { recursive: true, force: true }) } catch { /* 已删 */ }
    try { rmSync(join(WORK, 'lab-test-shadow-r1'), { recursive: true, force: true }) } catch { /* 已删 */ }
    return left.length === 0 && realOk
  })()
}])

/** ⑫ P3a：G6 禁改价表 / G10 原子预留账 / G7 失败即停 / 未 arm 不执行。 */
cases.push(['★ G6 stripPricePatch：剥离 prices/pricesByModel/tariff，其余保留', () => {
  const r = stripPricePatch({ prices: { hit: 1 }, pricesByModel: {}, tariff: {}, autoCount: 3, budgetPerSession: 9 })
  return r.stripped.join(',') === 'prices,pricesByModel,tariff'
    && Object.keys(r.patch).sort().join(',') === 'autoCount,budgetPerSession'
}])

cases.push(['★ G10 未拿到 usage → JSONL 有 pending + failed(unknownCost, chargedWorst)，按 worst 计入本轮', () => {
  return (async () => {
    const rows = []
    const st = { version: 1, settings: { ...DEFAULT_SETTINGS, labMode: true, labSessionAllow: ['a'], labBudgetPerRun: 0.5, labStartedAt: 1 }, sessions: {}, ledger: {}, pinnedSessions: [] }
    const r = await runLabAttempts({
      arm: true, allow: ['a'], append: (x) => rows.push(x), getState: () => st,
      prepare: async (id) => ({ ok: true, id, worst: 0.1 }),
      send: async () => ({ ok: false, error: 'no usage' }),
      record: () => ({ cost: 0, hitRate: 0, promptTokens: 0 }),
    })
    const pending = rows.find((x) => x.event === 'pending')
    const upd = rows.find((x) => x.event === 'update')
    return r.armed === true && pending !== undefined && pending.worst === 0.1
      && upd !== undefined && upd.status === 'failed' && upd.unknownCost === true && upd.chargedWorst === 0.1
  })()
}])

cases.push(['★ G7 连续 2 次 config 失败 → 中止（第 3 条不再发）', () => {
  return (async () => {
    const rows = []
    let sends = 0
    const st = { version: 1, settings: { ...DEFAULT_SETTINGS, labMode: true, labSessionAllow: ['a', 'b', 'c'], labBudgetPerRun: 0.5, labStartedAt: 1 }, sessions: {}, ledger: {}, pinnedSessions: [] }
    const r = await runLabAttempts({
      arm: true, allow: ['a', 'b', 'c'], append: (x) => rows.push(x), getState: () => st,
      prepare: async (id) => ({ ok: true, id, worst: 0.01 }),
      send: async () => { sends += 1; return { ok: false, error: 'no key', failKind: 'config' } },
      record: () => ({ cost: 0, hitRate: 0, promptTokens: 0 }),
    })
    return r.aborted !== undefined && sends === 2 && rows.some((x) => x.event === 'abort')
  })()
}])

cases.push(['★ 未 arm：runLabAttempts 第一行就返回，不 prepare / 不写盘', () => {
  return (async () => {
    let touched = 0
    const r = await runLabAttempts({
      arm: false, allow: ['a'],
      append: () => { touched += 1 },
      getState: () => { touched += 1; return { version: 1, settings: { ...DEFAULT_SETTINGS }, sessions: {}, ledger: {} } },
      prepare: async () => { touched += 1; return { ok: true, id: 'a', worst: 0.1 } },
      send: async () => { touched += 1; return { ok: true } },
      record: () => ({ cost: 0, hitRate: 0, promptTokens: 0 }),
    })
    return r.armed === false && r.results.length === 0 && touched === 0
  })()
}])

cases.push(['★ 预留额度过小 → 该条被 reserve 拒绝、不发请求', () => {
  return (async () => {
    let sends = 0
    const st = { version: 1, settings: { ...DEFAULT_SETTINGS, labMode: true, labSessionAllow: ['a'], labBudgetPerRun: 0.1, labStartedAt: 1 }, sessions: {}, ledger: {}, pinnedSessions: [] }
    const r = await runLabAttempts({
      arm: true, allow: ['a'], append: () => {}, getState: () => st,
      prepare: async (id) => ({ ok: true, id, worst: 0.5 }),
      send: async () => { sends += 1; return { ok: true } },
      record: () => ({ cost: 0, hitRate: 0, promptTokens: 0 }),
    })
    return sends === 0 && r.results[0] !== undefined && r.results[0].ok === false
      && String(r.results[0].why).includes('reserve')
  })()
}])

/** ⑬ P3b：D1 沙箱四键必须真落盘（行为断言，不是源码字符串）、D2 链接路径不得被删/写。 */
cases.push(['★ D1 行为：setSettings 写入沙箱 settings 能读回，且白名单外被 allowlist 拒', () => {
  return (async () => {
    const dir = join(WORK, 'lab-test-d1')
    mkdirSync(join(dir, 'cache-keepalive'), { recursive: true })
    const f = join(dir, 'cache-keepalive', 'state.json')
    saveState({ version: 1, settings: { ...DEFAULT_SETTINGS }, sessions: {}, ledger: {}, pinnedSessions: [] }, f)
    const st = loadState(f)
    setSettings(st, { labMode: true, labSessionAllow: ['s1'], labBudgetPerRun: 0.2, labStartedAt: Date.now() })
    saveState(st, f)
    const back = loadState(f)
    const persisted = back.settings.labMode === true
      && Array.isArray(back.settings.labSessionAllow) && back.settings.labSessionAllow.length === 1
      && Number(back.settings.labStartedAt) > 0
    const outside = labVerdict(back, 'not-in-allowlist', [])
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 已删 */ }
    return persisted && outside.ok === false && outside.step === 'allowlist'
  })()
}])

cases.push(['★ D1 根因钉死：直接改 settings 再 saveState 会被 mergeForeign 丢弃', () => {
  return (async () => {
    const dir = join(WORK, 'lab-test-d1b')
    mkdirSync(join(dir, 'cache-keepalive'), { recursive: true })
    const f = join(dir, 'cache-keepalive', 'state.json')
    saveState({ version: 1, settings: { ...DEFAULT_SETTINGS }, sessions: {}, ledger: {}, pinnedSessions: [] }, f)
    const st = loadState(f)
    st.settings = { ...st.settings, labMode: true, labSessionAllow: ['s1'] }
    saveState(st, f)
    const back = loadState(f)
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 已删 */ }
    /** 期望：直接赋值**确实**丢（labMode 回 false）—— 这就是 D1 的根因，改用 setSettings 才持久。 */
    return back.settings.labMode === false
  })()
}])

cases.push(['★ D2 dispose：home 是链接时一个字节都不动（哨兵仍在）', () => {
  return (async () => {
    const target = join(WORK, 'lab-test-d2-target')
    mkdirSync(join(target, 'cache-keepalive'), { recursive: true })
    writeFileSync(join(target, 'cache-keepalive', 'state.json'), '{"sentinel":"KEEP"}', 'utf8')
    const root = join(WORK, 'lab-test-d2')
    mkdirSync(root, { recursive: true })
    const home = join(root, 'home')
    try { rmSync(home, { force: true }) } catch { /* 不存在 */ }
    symlinkSync(target, home, 'junction')
    const sh = await makeShadowHome({ runId: 'x', baseDir: root, realDshHome: target })
    sh.dispose()
    const kept = readFileSync(join(target, 'cache-keepalive', 'state.json'), 'utf8').includes('KEEP')
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 已删 */ }
    try { rmSync(target, { recursive: true, force: true }) } catch { /* 已删 */ }
    return kept
  })()
}])

cases.push(['★ D2 CLI 前置检查在 makeShadowHome 之前（链接路径零写盘）', () => {
  const src = readFileSync(join(HERE, '..', 'cli', 'keepalive.mjs'), 'utf8')
  const guardAt = src.indexOf('D2 前置检查失败')
  const makeAt = src.indexOf('makeShadowHome({')
  return guardAt > 0 && makeAt > 0 && guardAt < makeAt && src.includes('isSymbolicLink()')
}])

cases.push(['★ D4 真跑推迟到模块末尾执行（防「模块顶部调用 → TDZ」回退）', () => {
  const src = readFileSync(join(HERE, '..', 'cli', 'keepalive.mjs'), 'utf8')
  const callAt = src.indexOf('await runPendingLive(globalThis.__CK_PENDING_LIVE__)')
  const mainAt = src.indexOf('const args = parseArgs(process.argv.slice(2))')
  return callAt > 0 && mainAt > 0 && callAt < mainAt && !src.includes('async function runLabExecutor')
}])

cases.push(['★ D4 真跑依赖全在函数内动态 import（不引用模块级 const）', () => {
  const src = readFileSync(join(HERE, '..', 'cli', 'keepalive.mjs'), 'utf8')
  const at = src.indexOf('async function runPendingLive')
  if (at < 0) return false
  const body = src.slice(at, at + 8000)
  return body.includes("await import(pathToUrl(join(SRC, 'store.ts')))")
    && body.includes("await import(pathToUrl(join(SRC, 'core', 'lab', 'guard.ts')))")
    && body.indexOf('storeMod.loadState') > 0
}])

cases.push(['★ D3 sessions 来源必须是真实 home（不被 --config-from 顶替）', () => {
  const src = readFileSync(join(HERE, '..', 'cli', 'keepalive.mjs'), 'utf8')
  const at = src.indexOf('async function runPendingLive')
  const body = src.slice(at)
  return body.includes('realDshHome: sessionsHome') && !body.includes('realDshHome: p.configFrom')
    && body.includes('沙箱 sessions 校验失败')
    && body.includes('const sessionsHome = p.userHome')
}])

/** ⑭ P4a：dry-run 样本体检（源码断言；行为已由 `--lab live` 实测覆盖三条样本）。 */
cases.push(['★ P4a 体检覆盖三类不合格：无此会话 / 闲置超门槛 / 第三方 provider', () => {
  const src = readFileSync(join(HERE, '..', 'cli', 'keepalive.mjs'), 'utf8')
  const at = src.indexOf('async function runPendingLive')
  const body = src.slice(at, at + 12000)
  return body.includes('磁盘上无此会话')
    && body.includes('cold-window-idle（')
    && body.includes("startsWith('deepseek')")
    && body.includes('第三方 provider')
}])

cases.push(['★ P4a 汇总与退出码：有坏样本 dry-run exit 1，全好 exit 0', () => {
  const src = readFileSync(join(HERE, '..', 'cli', 'keepalive.mjs'), 'utf8')
  const at = src.indexOf('async function runPendingLive')
  const body = src.slice(at, at + 12000)
  return body.includes('可跑 ${runnable.length} 条 / 不可跑 ${blocked.length} 条')
    && body.includes('if (!p.yes) process.exit(blocked.length > 0 ? 1 : 0)')
}])

cases.push(['★ P4a --arm 只跑可跑样本（不因一条坏样本全停）', () => {
  const src = readFileSync(join(HERE, '..', 'cli', 'keepalive.mjs'), 'utf8')
  const at = src.indexOf('async function runPendingLive')
  const body = src.slice(at, at + 14000)
  return body.includes('allow: runnable.map((h) => h.id)')
    && body.includes('labSessionAllow: runnable.map((h) => h.id)')
    && body.includes('skipped: blocked.map((h) => h.id)')
}])

/** ⑮ P4b：M1 可跑 0 的文案要准确、M2 缺 --config-from 要点明。 */
cases.push(['★ M1 「没有可跑样本」判断在灌配置之前（文案不再被误报成落盘失败）', () => {
  const src = readFileSync(join(HERE, '..', 'cli', 'keepalive.mjs'), 'utf8')
  const at = src.indexOf('async function runPendingLive')
  const body = src.slice(at)
  const noneAt = body.indexOf('白名单里没有一条可跑样本（见上面的体检原因）→ 先修样本再 --yes')
  const fillAt = body.indexOf('storeMod.setSettings(shSt')
  return noneAt > 0 && fillAt > 0 && noneAt < fillAt && !body.includes('白名单里没有一条可跑样本（见上面的体检原因）\\n')
}])

cases.push(['★ M2 配置来源落在影子 home → 预检明确提示必须用 --config-from', () => {
  const src = readFileSync(join(HERE, '..', 'cli', 'keepalive.mjs'), 'utf8')
  const at = src.indexOf('async function runPendingLive')
  const body = src.slice(at)
  return body.includes('配置来源落在影子 home 里') && body.includes('必须用 --config-from=<真实配置 home>')
}])

/** ⑯ B1：跨会话预算 + 插件侧 G10 在途账。 */
cases.push(['★ 本轮预算按**全部会话**账本累加（单会话账本不许算漏）', () => {
  const st = mkState({ labMode: true, labBudgetPerRun: 0.11, labStartedAt: 1, labSessionAllow: ['a'] })
  st.ledger = { a: [entry(2, 0.05)], b: [entry(3, 0.05)] }
  /** 只看会话 a 的账本 = 0.05 → 加 worst 0.05 = 0.10 ≤ 0.11 会误放行；必须用全账本 0.10 + 0.05 = 0.15 > 0.11 拒。 */
  const b = labOverBudget(st, st.ledger.a, 1)
  /** 只看会话 a 会是 0.05；必须算出 0.10（两个会话）。 */
  const v = labVerdict(st, 'a', st.ledger.a, 0.05)
  return Math.abs(b.spent - 0.1) < 1e-9 && v.ok === false && v.step === 'reserve'
}])

cases.push(['★ 插件侧 G10：非试验模式 labPending 恒空、cycleSpendOf 不加一分钱', () => {
  const st = mkState({ labStartedAt: 0 })
  const before = cycleSpendOf(st, 'a')
  const empty = labPendingWorstOf(st, 'a') === 0
  /** 直接调 append 也不该被正常路径触发 —— 这里验证「即使有人塞进去，也只在本轮窗口内计入」。 */
  return empty && before === 0 && (st.labPending === undefined || st.labPending.length === 0)
}])

cases.push(['★ 插件侧 G10：append 后 cycleSpendOf 计入 worst，成功后删除、失败标记 unknown', () => {
  const st = mkState({ labMode: true, labStartedAt: 1 })
  const id = appendLabPending(st, 'a', 0.2, 2)
  const withPending = cycleSpendOf(st, 'a')
  settleLabPending(st, id, true)
  const afterOk = cycleSpendOf(st, 'a')
  const id2 = appendLabPending(st, 'a', 0.3, 2)
  settleLabPending(st, id2, false)
  const afterFail = cycleSpendOf(st, 'a')
  return Math.abs(withPending - 0.2) < 1e-9 && afterOk === 0 && Math.abs(afterFail - 0.3) < 1e-9
    && (st.labPending ?? []).length === 1 && st.labPending[0].status === 'unknown'
}])

let pass = 0
let fail = 0
const lines = []
for (const [name, fn] of cases) {
  let ok = false
  try {
    ok = (await fn()) === true
  } catch (e) {
    ok = false
    lines.push(`     抛错：${e instanceof Error ? e.message : String(e)}`)
  }
  if (ok) pass++
  else fail++
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

/** ⑪ P2c：CLI 必须真建影子 home、执行器未 arm 不得执行、arm 分支不得调用执行器（源码断言，防回归）。 */
cases.push(['★ CLI 真的调用了 makeShadowHome（不是只做字符串比较）', () => {
  const src = readFileSync(join(HERE, '..', 'cli', 'keepalive.mjs'), 'utf8')
  return src.includes('makeShadowHome({') && src.includes("await import(pathToUrl(join(SRC, 'core', 'lab', 'live.ts')))")
}])

cases.push(['★ 执行器首行有「未 arm 即返回」（opts?.arm !== true → return）', () => {
  const src = readFileSync(join(HERE, '..', 'cli', 'keepalive.mjs'), 'utf8')
  const at = src.indexOf('async function runLabExecutor')
  if (at < 0) return false
  const head = src.slice(at, at + 260)
  return head.includes('opts?.arm !== true') && head.includes('return')
}])

cases.push(['★ --arm 已接通执行器，且接线点在 G0/precheck 之后（源码断言）', () => {
  const src = readFileSync(join(HERE, '..', 'cli', 'keepalive.mjs'), 'utf8')
  const at = src.indexOf("if (has('--arm'))")
  if (at < 0) return false
  const end = src.indexOf('process.exit(0)', at)
  const body = src.slice(at, end < 0 ? at + 1600 : end)
  const call = body.indexOf('runLabExecutor({ arm: true')
  /** 执行器调用必须在 G0 与 precheck 之后（那些代码在 arm 分支之前，所以 branch 内只需确认「先取 key 再跑」）。 */
  const keyAt = body.indexOf('loadApiKey(')
  return call > 0 && keyAt > 0 && keyAt < call && !body.includes('console.log(key')
}])
/** 清掉本次测试自建的临时树（只在自建前缀下，绝不递归碰别的）。 */
for (const p of [join(realHome), shadowBase]) {
  try { rmSync(p, { recursive: true, force: true }) } catch { /* 已删 */ }
}

console.log('=== 试验护栏 / 影子 home / 到期自愈 ===')
console.log(lines.join('\n'))
console.log('')
console.log(`通过 ${pass} / ${cases.length}` + (fail > 0 ? `   ❌ 失败 ${fail}` : '   ✅ 全绿'))
process.exit(fail > 0 ? 1 : 0)
