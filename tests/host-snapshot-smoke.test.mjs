/**
 * **宿主侧 snapshot 冒烟**：`src/index.ts` 的 `/state` 路由必须返回 200。
 *
 * 为什么需要这条：插件是「一堆闭包 + 路由」的结构，`snapshot()` 不是导出函数，**只能**通过
 * 路由处理器调到。用户在 3084 上真实踩到过一次：`intervalSeconds` 里引用了不存在的 `row`
 * （那是 panel-service 的变量名，index 这边叫 `meta`），`/panel` 仍 200，但 `/state` 恒 500
 * `{"ok":false,"error":"row is not defined"}` —— 面板主体能出、数据全空，非常难定位。
 *
 * 本测试模拟宿主：假 ctx → 调 `apply()` → 拿到注册的 routes → 直接调 `/state` 的 handler，
 * 断言 200 且 `ok: true`。**全程只读临时 home，不起服务、不发网络请求、不让定时器跑**。
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { test } from 'node:test'
import { tmproot, tmpremove } from './_tmp.js'

/** 假 res：收 writeHead 的状态码与 body 文本。 */
function fakeRes() {
  const out = { status: 0, body: '', headers: {} }
  out.writeHead = (status, headers) => { out.status = status; out.headers = headers ?? {} }
  out.setHeader = () => {}
  out.end = (chunk) => { out.body = String(chunk ?? '') }
  return out
}

/** 假 ctx：只做 apply() 真正用到的那几件事，**定时器一律不执行**。 */
function fakeCtx(routes) {
  const log = Object.assign((..._a) => {}, {
    info: (...a) => log(...a), warn: (...a) => log(...a),
    error: (...a) => log(...a), debug: (...a) => log(...a),
  })
  const ctx = {
    logger: log,
    get: () => undefined,
    on: () => () => {},
    /** `effect` 必须**立即执行**回调 —— 路由注册与面板地址注入都写在 `httpCtx.effect(...)` 里。 */
    effect: (fn) => {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    /** ⚠️ 绝不执行回调：否则 tick 会真的跑保温。 */
    setInterval: () => () => {},
    tools: { register: () => ({ dispose() {} }) },
    llm: { listModels: async () => [], stream: async () => ({}) },
    inject: (names, cb) => { if (names.includes('webServer')) cb(ctx) },
    webServer: {
      port: 0,
      tapIndex: () => () => {},
      register: (route) => { routes.push(route); return () => {} },
    },
  }
  return ctx
}

test('宿主侧 /state 路由返回 200（snapshot 不在真实数据上抛错）', async () => {
  const home = tmproot('host-snapshot')
  const prevHome = process.env.DSH_HOME
  /** 必须在 import 之前设：`index.ts` 顶层有 `export const STATE_FILE = statePath()`，加载时就求值。 */
  process.env.DSH_HOME = home
  try {
    /** 造一个最小但真实的 home：一条会话日志 + state.json（让 snapshot 走完整分支）。 */
    const sessDir = join(home, 'sessions', 'proj-a', 'session-smoke-1')
    mkdirSync(sessDir, { recursive: true })
    /** 必须是**能被 listSessions 识别的多帧 zstd**（空文件会被扫盘跳过，snapshot 就永远不跑 build）。 */
    const logText = [
      { type: 'session', seq: 0, time: 1_700_000_000_000, id: 'session-smoke-1', cwd: 'C:\\tmp', createdAt: 1_700_000_000_000 },
      { type: 'user/message', seq: 1, time: 1_700_000_100_000 },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n'
    writeFileSync(join(sessDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(logText, 'utf8')))
    const stDir = join(home, 'cache-keepalive')
    mkdirSync(stDir, { recursive: true })
    writeFileSync(join(stDir, 'state.json'), JSON.stringify({
      version: 1,
      settings: { intervalSeconds: 14400, modelOverrides: { 'prov-a/m1': { intervalSeconds: 3600 } } },
      sessions: {},
      /** 账本里放一条带 model 的记录：`intervalSeconds` 的 model 兜底分支要走一遍。 */
      ledger: {
        'session-smoke-1': [{
          at: 1_700_000_000_000, gapSeconds: 0, promptTokens: 1000, hitTokens: 900, missTokens: 100,
          outputTokens: 10, cost: 0.001, hitRate: 0.9, ms: 2000, touch: 1, cycle: 1,
          via: 'cli', model: 'm1',
        }],
      },
    }), 'utf8')

    const routes = []
    const mod = await import('../src/index.ts')
    mod.apply(fakeCtx(routes), {})

    const route = routes.find((r) => r.path === '/api/cache-keepalive/state')
    assert.ok(route !== undefined, '没注册 /state 路由')

    /**
     * 调**两次**：`snapshot()` 里的 `sessionIndex.list()` 是 fire-and-forget（不 await），
     * 首次调用时 `cached` 还是空的 —— 只有第二次才会真正遍历会话、执行 `build()`。
     * 真实面板每 15 秒刷一次，所以线上永远是「第二次」那种状态。
     */
    route.handler({ method: 'GET' }, fakeRes())
    await new Promise((r) => setTimeout(r, 400))
    const res = fakeRes()
    route.handler({ method: 'GET' }, res)
    const body = JSON.parse(res.body)
    assert.equal(res.status, 200, '宿主 snapshot 抛错了：' + res.body.slice(0, 300))
    assert.equal(body.ok, true)
    assert.ok(body.state !== undefined, '响应里没有 state')
    assert.ok(Array.isArray(body.state.sessions), 'snapshot().sessions 不是数组')
    /**
     * 必须真的扫到那条会话 —— 否则 `build()` 一次都没跑，这条测试就挡不住「作用域里引用了
     * 不存在的变量」这类错误（真实故障就是这样漏过去的）。
     */
    assert.ok(body.state.sessions.length >= 1, '没扫到会话，snapshot 的 build() 没被执行过')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    tmpremove(home)
  }
})
