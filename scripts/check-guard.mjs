/**
 * **花钱护栏回归**：`/ping` 必须过 `budget` 与 `max-touches`。
 *
 * 背景（2026-10-18）：会话 `f6f7b238b1b5` 被外部每分钟打一次 `/ping`，连保 196 次、
 * 花 0.97 元（≈4 次冷启动），全程没有一道闸拦它 —— `ping()` 不调 `decideWarm`。
 *
 * 本脚本验三件事（**不花任何 API 钱**）：
 *  ① `routes` 层把 `via` 透传对（缺省 panel、显式 tool/cli）；
 *  ② 真实账本上「次数已尽」的会话，`/ping` 被拒且报出次数/上限/预算；
 *  ③ 被拒时**不记账、不写 state.json**。
 *
 * 用**临时 DSH_HOME**（复制真实 state.json、sessions 用 junction 只读挂上），绝不改用户真实状态。
 *
 * ## 环境前提（看到 exit 1 先看这里，别误判成代码坏了）
 * 本脚本会 `await import('../src/index.ts')`，而 `src/keepalive.ts` 依赖 `@deepseek-ai/dsh-llm` 等宿主包。
 * **真目录没有 `node_modules`**，所以会直接 `ERR_MODULE_NOT_FOUND` 在 import 阶段退出 —— 这是**环境限制**。
 * 完整跑需要「仓库真实副本 + 指向 `C:\dsh-runtime\<ver>\node_modules` 的 junction」的沙箱
 * （本次用 `.tmp/smoke-run/` 验证：插件侧 13 条断言全绿）。
 *
 * ## 不花钱
 * CLI 段**只断言付费闸**，永远不跑真实 `--once`；插件侧全部走临时 home，不联网。
 */
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, symlinkSync, statSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const REAL = process.env.DSH_HOME || join(homedir(), '.dsh')
const ID = 'session-14a53ec6-891f-43e7-a49b-f6f7b238b1b5'

let failed = 0
const say = (ok, msg, extra) => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}${ok || extra === undefined ? '' : '\n      ' + String(extra).slice(0, 500)}`)
}

/** 调一个 WebRoute：喂 JSON body，收 JSON 响应。`method` 默认 POST —— `/state` 只收 GET。 */
function callRoute(route, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = method
    req.headers = { 'content-type': 'application/json' }
    let code = 0
    const res = {
      writeHead(status) { code = status },
      setHeader() {},
      end(payload) {
        let parsed = {}
        try { parsed = JSON.parse(String(payload || '{}')) } catch { parsed = { __raw: String(payload) } }
        resolve({ code, body: parsed })
      },
    }
    try { route.handler(req, res) } catch (e) { reject(e) }
  })
}

// ── ① routes 层：via 透传 ──────────────────────────────────────────────
{
  const { makeRoutes } = await import('../src/routes.ts')
  const calls = []
  const deps = {
    snapshot: () => ({}),
    setPolicy: () => ({ ok: true }),
    setSettings: () => ({ ok: true }),
    ping: async (...args) => { calls.push(args); return { ok: true, message: 'stub' } },
    reset: () => ({ ok: true }),
    timeline: async () => ({}),
    setPinned: () => ({ ok: true }),
    resetCost: () => ({ ok: true }),
  }
  const route = makeRoutes(deps).find((r) => r.path.endsWith('/ping'))
  say(route !== undefined, '找得到 /ping 路由')
  if (route !== undefined) {
    await callRoute(route, { id: 'a', via: 'cli' })
    await callRoute(route, { id: 'b', via: 'tool' })
    await callRoute(route, { id: 'c' })
    await callRoute(route, { id: 'd', via: '瞎写' })
    say(JSON.stringify(calls[0]) === JSON.stringify(['a', false, 'cli']), 'via=cli 透传', calls[0])
    say(JSON.stringify(calls[1]) === JSON.stringify(['b', false, 'tool']), 'via=tool 透传', calls[1])
    say(JSON.stringify(calls[2]) === JSON.stringify(['c', false, 'panel']), '缺省 via → panel', calls[2])
    say(JSON.stringify(calls[3]) === JSON.stringify(['d', false, 'panel']), '非法 via → panel', calls[3])
  }
}

// ── ②③ 插件层：真实账本上的上限拒绝 + 不记账 ─────────────────────────────
{
  const home = mkdtempSync(join(tmpdir(), 'ck-guard-'))
  mkdirSync(join(home, 'cache-keepalive'), { recursive: true })
  const srcState = join(REAL, 'cache-keepalive', 'state.json')
  const dstState = join(home, 'cache-keepalive', 'state.json')
  copyFileSync(srcState, dstState)
  /**
   * **把门槛钉死**：真实 `state.json` 里的上限是用户随时在面板上调的（实测已被调到
   * `maxTouches=100 / budgetPerSession=20`，该会话 19 次），拿它当"次数已尽"的前提会随用户改设置而漂。
   * 这里在**临时副本**上写死一条「次数与预算都必然超」的门槛，断言本身一个字不改。
   */
  {
    const s = JSON.parse(readFileSync(dstState, 'utf8'))
    s.settings = { ...(s.settings || {}), maxTouches: 9, budgetPerSession: 0.01 }
    writeFileSync(dstState, JSON.stringify(s), 'utf8')
  }
  symlinkSync(join(REAL, 'sessions'), join(home, 'sessions'), 'junction')
  const before = statSync(dstState).mtimeMs
  const ledBefore = JSON.parse(readFileSync(dstState, 'utf8'))?.ledger?.[ID]?.length ?? 0
  process.env.DSH_HOME = home

  const { apply } = await import('../src/index.ts')
  const routes = []
  const tools = new Map()
  /**
   * `inject` 回调里抛的错**不许静默吞掉**：真实运行时 `inject` 是会回调的，
   * 夹具里吞掉就等于「路由少注册一半」却看不出来（2026-10-25 实测：`/state` 缺失就是这么来的）。
   */
  const injectErrors = []
  /**
   * `webServer` 必须**既是 `get('webServer')` 的返回值、又是 ctx 上的属性**。
   *
   * 真实 cordis 里 `ctx.inject(['webServer'], cb)` 回调拿到的 ctx 上 `webServer` 是属性
   * （`src/index.ts` 用的就是 `httpCtx.webServer.register(route)`），只挂在 `get()` 上夹具就收不到路由，
   * 表现为「/ping 与 /state 都没注册」而 `inject` 又不报错。
   */
  const webServer = {
    port: 19999,
    register: (r) => { routes.push(r); return () => {} },
    tapIndex: () => () => {},
  }
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    on() { return () => {} },
    get(name) {
      if (name === 'agents') return { list: () => [] }
      if (name === 'profileContext') return { name: 'guard' }
      if (name === 'webServer') return webServer
      if (name === 'sessionProjections') return { stateOf: () => undefined }
      if (name === 'sessionController') return { resolveAgent: async () => {} }
      return undefined
    },
    webServer,
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) }, schemas() { return [] } },
    setInterval() { return () => {} },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject(_deps, cb) {
      try { cb(fakeCtx) } catch (e) { injectErrors.push(e instanceof Error ? e.message : String(e)) }
      return () => {}
    },
    llm: { stream: async function* () { yield { type: 'usage', usage: {} } } },
  }
  apply(fakeCtx, { tickMs: 600_000 })
  say(injectErrors.length === 0, 'inject 回调未抛错（夹具必须与真实 ctx 同形）', injectErrors.join(' | '))

  const pingRoute = routes.find((r) => r.path.endsWith('/ping'))
  const stateRoute = routes.find((r) => r.path.endsWith('/state'))
  say(pingRoute !== undefined && stateRoute !== undefined, 'apply() 注册了 /ping 与 /state')

  // 等会话索引扫完（ping 的离线分支要靠它找日志）
  let rows = 0
  for (let i = 0; i < 40; i++) {
    const r = await callRoute(stateRoute, {}, 'GET')
    /**
     * `/state` 的响应体是 `{ ok, state: <snapshot> }`（见 `src/routes.ts`），会话列表在 `body.state.sessions`。
     * 直接读 `body.sessions` 永远是 undefined —— 夹具读错层级会让「索引可用」恒假。
     */
    const snap = r.body?.state ?? r.body ?? {}
    rows = Array.isArray(snap.sessions) ? snap.sessions.length : 0
    if (rows > 0) break
    /**
     * `scanError` 正常时是 **`null`**（不是 `undefined`）。写成 `!== undefined` 会恒真 →
     * 循环第一轮就 break、`rows` 永远是 0（2026-10-25 实测踩到）。
     * 只有**真的出错**（字符串/Error）才提前退出。
     */
    if (snap.scanError) break
    await new Promise((ok) => setTimeout(ok, 1500))
  }
  say(rows > 0, `会话索引可用（${rows} 条）`)

  const out = await callRoute(pingRoute, { id: ID, via: 'panel' })
  const err = String(out.body?.error ?? '')
  say(out.body?.ok === false, '/ping 对「次数已尽」的会话被拒', JSON.stringify(out.body).slice(0, 300))
  say(/已保 \d+ 次 \/ 上限 \d+ 次/.test(err), '拒绝文案带「已保 N 次 / 上限 M 次」', err)
  /**
   * 文案在 10-25 从「预算已用 X 元 / 上限 Y 元」改成了「本期花费 X 元 / 上限 Y 元」。
   * 断言意图不变（**拒绝文案必须同时暴露已花与上限**），两种措辞都认。
   */
  say(/(?:预算已用|本期花费) .+ 元 \/ 上限 .+ 元/.test(err), '拒绝文案带「已花 X 元 / 上限 Y 元」', err)
  /**
   * **反向控制**：把「已花 X 元」那一段抠掉后必须**不再匹配** —— 证明上面那条不是恒真的摆设。
   */
  const noSpend = err.replace(/(?:预算已用|本期花费)[^元]*元/, '')
  say(!/(?:预算已用|本期花费) .+ 元 \/ 上限 .+ 元/.test(noSpend),
    '反向：抠掉「已花」段落后不再匹配（证明该正则不是恒真）', noSpend.slice(0, 200))

  const ledAfter = JSON.parse(readFileSync(dstState, 'utf8'))?.ledger?.[ID]?.length ?? 0
  say(ledAfter === ledBefore, `被拒后没记账（${ledBefore} → ${ledAfter}）`)
  say(statSync(dstState).mtimeMs === before, '被拒后 state.json 未被改写')
}

// ── ④ CLI 路径：硬上限同样生效，且预算按「当前周期」算 ─────────────────────
{
  const home = process.env.DSH_HOME
  const { spawnSync } = await import('node:child_process')
  const runCli = () => spawnSync(process.execPath, ['cli/keepalive.mjs', '--once', ID], {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    timeout: 120000,
  })
  /**
   * 这里**只断言「付费闸」本身**，不再跑真实 `--once`。
   *
   * 为什么改（2026-10-25）：`cli/keepalive.mjs` 给 `--once` 加了付费前置闸 —— 没有
   * `--yes-i-will-pay` / `CK_YES_I_WILL_PAY=1` 就**直接拒发**。两条替代路都不通：
   *  - `--dry-run` **不经过门禁**（只装配，实测 exit 0、无上限判定文案）；
   *  - 加 `--yes-i-will-pay` 虽能测「次数/预算」两条，但「清账后预算从 0 起算」那条会**真发请求花钱**。
   * 门禁逻辑的覆盖已由上面插件侧那一组断言承担（CLI 只是薄壳），所以 CLI 段改为保证
   * **花钱入口不会被误开**：没显式付费同意就必须拒发、且一个真实保温都不能发生。
   */
  const r1 = runCli()
  const o1 = String(r1.stdout ?? '') + String(r1.stderr ?? '')
  say(/会向 provider 发真实请求/.test(o1) && /--yes-i-will-pay/.test(o1),
    'CLI --once：被付费闸拦下（无 --yes-i-will-pay 绝不发请求）', o1.trim().slice(0, 240))
  say(!/命中率|花费 [\d.]+ 元|杠杆/.test(o1),
    'CLI --once：被拦时没有发生任何真实保温', o1.trim().slice(0, 240))
  say(r1.status !== 0, 'CLI --once：被拦时以非 0 退出（npm run check 才会断）', String(r1.status))
}

console.log('')
console.log(failed === 0 ? '✅ 花钱护栏回归全绿' : `❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
