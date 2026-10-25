/**
 * **取证链路回归**：`scripts/fetchspy.mjs` 的四个关键构造。
 *
 * 为什么必须固化：这三个构造都是踩过坑才定下来的，只靠手动实测的话，下次改一行就可能退化，
 * 而退化的后果是**灌爆用户磁盘**（初版实测 194.6MB）或**把请求弄死**（流形态 TypeError）。
 *
 * 测法：同进程内起本地 HTTP 回环 + 假 `DSH_HOME`（用 `tmproot()`），不联网、不派生子进程。
 * 产物写在 `tmproot()` 里，跑完 `tmpremove()`。
 *
 * 跑法：`node --test tests/fetchspy.test.mjs`
 */
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tmpremove, tmproot } from './_tmp.js'

/**
 * 指向**真实现** `tools/fetchspy.mjs`，不是 `scripts/fetchspy.mjs`。
 *
 * 原因：`scripts/fetchspy.mjs` 是 138 B 的**垫片**（`export * from '../tools/fetchspy.mjs'` + `import ...`），
 * 它把真实实现转出去了。本文件每个用例靠 `?t=<随机>` 强制**重新求值**来装一份干净的 fetch 包装，
 * 而 query 只能让垫片本身重算 —— 内层 `tools/fetchspy.mjs` 仍是模块缓存，第二次装不上。
 * 实测：垫片 #1 装上=true / #2 装上=**false**；直连 tools #1=true / #2=true。
 * 垫片本身不能改（`NODE_OPTIONS` 预加载指着它），所以这里直连真实现。
 */
const SPY = new URL('../tools/fetchspy.mjs', import.meta.url).href

/** 在假 DSH_HOME 里造一份会话日志。 */
function makeLog(home, project, session, bytes, ageMs) {
  const dir = join(home, 'sessions', project, session)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, Buffer.alloc(bytes, 7))
  if (ageMs !== undefined) {
    const t = new Date(Date.now() - ageMs)
    utimesSync(file, t, t)
  }
  return file
}

/** 起一个回环服务器，返回 { url, close }。 */
async function serve() {
  const srv = createServer((req, res) => {
    let n = 0
    req.on('data', (c) => {
      n += c.length
    })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, got: n }))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { url: 'http://127.0.0.1:' + srv.address().port + '/v1/chat/completions', close: () => srv.close() }
}

/**
 * 装一次探针。
 *
 * `fetchspy.mjs` 是**一次性模块**（ESM 只求值一次），所以每个用例都用不同的 query 串
 * 强制重新求值，各自拿到一份干净的 `globalThis.fetch` 包装。
 *
 * @param out 输出目录
 * @param home 假的 DSH_HOME
 * @param match CK_SPY_MATCH
 * @param extra 额外环境变量
 * @returns 装好之后的 fetch
 */
async function installSpy(out, home, match, extra = {}) {
  mkdirSync(out, { recursive: true })
  mkdirSync(home, { recursive: true })
  process.env.CK_SPY_OUT = out
  process.env.DSH_HOME = home
  process.env.CK_SPY_MATCH = match
  for (const [k, v] of Object.entries(extra)) process.env[k] = v
  /** 让探针认为自己在 DSH 入口里跑。 */
  process.argv[1] = join(home, 'fake', 'dsh', 'lib', 'bin.js')
  const saved = globalThis.fetch
  await import(SPY + '?t=' + Math.random().toString(36).slice(2))
  const spy = globalThis.fetch
  spy.__restore = () => {
    globalThis.fetch = saved
  }
  return spy
}

/**
 * 真 key 形态：`sk-` + 恰好 32 位字母数字（真 key 35~49 位）。
 * 别用短样本 —— 正则要求 ≥20 位，短了不脱敏是**故意的**（见下一条用例）。
 */
const REAL_KEY = 'sk-' + 'abcdef0123456789'.repeat(2)

const filesIn = (dir, re) => readdirSync(dir).filter((f) => re.test(f))

// ── 冻结：只取时间窗内的 ──────────────────────────────────────
test('冻结1：只冻结时间窗内的日志，窗口外的不冻', async (t) => {
  const root = tmproot('spy-freeze')
  const out = join(root, 'out')
  const home = join(root, 'home')
  try {
    makeLog(home, '--p--', 'session-old', 64 * 1024, 3600_000)
    makeLog(home, '--p--', 'session-recent', 64 * 1024, 30_000)
    const srv = await serve()
    const spy = await installSpy(out, home, '127.0.0.1')
    try {
      await (await spy(srv.url, { method: 'POST', body: '{"a":1}' })).text()
    } finally {
      spy.__restore()
      srv.close()
    }
    const manifests = filesIn(out, /^freeze-.*\.json$/u)
    assert.equal(manifests.length, 1, '应该写一份冻结清单')
    const m = JSON.parse(readFileSync(join(out, manifests[0]), 'utf8'))
    const paths = (m.frozen ?? []).map((x) => x.from).join(' ')
    assert.match(paths, /session-recent/u, '时间窗内的日志要冻')
    assert.doesNotMatch(paths, /session-old/u, '一小时前的日志不该冻')
  } finally {
    tmpremove(root)
  }
})

test('冻结2：60MB 大会话被 size 阈值挡掉（不抄用户全部对话）', async (t) => {
  const root = tmproot('spy-big')
  const out = join(root, 'out')
  const home = join(root, 'home')
  try {
    makeLog(home, '--p--', 'session-big', 60 * 1024 * 1024, 10_000)
    const srv = await serve()
    const spy = await installSpy(out, home, '127.0.0.1')
    try {
      await (await spy(srv.url, { method: 'POST', body: '{"a":1}' })).text()
    } finally {
      spy.__restore()
      srv.close()
    }
    const frozen = filesIn(out, /^frozen-.*\.zstd$/u)
    assert.equal(frozen.length, 0, '超 50MB 的日志一个都不该复制')
    /** 明确失败路径：清单里要写清为什么没冻到，不许静默。 */
    const manifests = filesIn(out, /^freeze-.*\.json$/u)
    assert.equal(manifests.length, 1)
    const m = JSON.parse(readFileSync(join(out, manifests[0]), 'utf8'))
    assert.deepEqual(m.frozen, [])
    assert.ok(typeof m.why === 'string' && m.why !== '', '没冻到要说清原因')
    assert.ok(typeof m.next === 'string' && m.next !== '', '要给下一步')
  } finally {
    tmpremove(root)
  }
})

test('冻结3：文件数 ≤ CK_SPY_FREEZE_MAX（限的是文件数，不是次数）', async (t) => {
  const root = tmproot('spy-count')
  const out = join(root, 'out')
  const home = join(root, 'home')
  try {
    for (let i = 0; i < 6; i += 1) makeLog(home, '--p--', 'session-' + i, 4096, 5_000 + i * 100)
    const srv = await serve()
    const spy = await installSpy(out, home, '127.0.0.1', { CK_SPY_MAX: '3', CK_SPY_FREEZE_MAX: '1' })
    try {
      for (let i = 0; i < 3; i += 1) await (await spy(srv.url, { method: 'POST', body: '{"a":' + i + '}' })).text()
    } finally {
      spy.__restore()
      srv.close()
    }
    const frozen = filesIn(out, /^frozen-.*\.zstd$/u)
    assert.equal(frozen.length, 1, '6 个候选 × 3 次请求，冻结文件数必须 ≤ 1')
    const totalBytes = frozen.reduce((s, f) => s + statSync(join(out, f)).size, 0)
    assert.ok(totalBytes <= 50 * 1024 * 1024, '冻结总量必须 ≤ 50MB')
  } finally {
    tmpremove(root)
  }
})

// ── 三种 body 形态：内容要抓到，请求也要正常返回 ──────────────
test('body1：string / Uint8Array / ReadableStream 三种形态都抓到且请求成功返回', async (t) => {
  const root = tmproot('spy-body')
  const out = join(root, 'out')
  const home = join(root, 'home')
  try {
    const srv = await serve()
    const spy = await installSpy(out, home, '127.0.0.1', { CK_SPY_MAX: '3', CK_SPY_FREEZE_MAX: '0' })
    const got = []
    try {
      got.push(await (await spy(srv.url, { method: 'POST', body: '{"kind":"str","n":11}' })).text())
      got.push(await (await spy(srv.url, { method: 'POST', body: new TextEncoder().encode('{"kind":"u8","n":22}') })).text())
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"kind":"stream","n":333}'))
          c.close()
        },
      })
      got.push(await (await spy(srv.url, { method: 'POST', body: stream, duplex: 'half' })).text())
    } finally {
      spy.__restore()
      srv.close()
    }
    assert.equal(got.length, 3)
    for (const g of got) assert.ok(g.includes('"ok":true'), '请求必须成功返回：' + g)
    assert.equal(JSON.parse(got[0]).got, '{"kind":"str","n":11}'.length)
    assert.equal(JSON.parse(got[2]).got, '{"kind":"stream","n":333}'.length, '流形态下游必须收到完整内容')

    const bodies = filesIn(out, /^real-body-\d+-\d+-\d+\.json$/u)
    assert.equal(bodies.length, 3)
    const all = bodies.map((f) => readFileSync(join(out, f), 'utf8')).join('\n')
    assert.match(all, /"kind": "str"/u)
    assert.match(all, /"kind": "u8"/u)
    assert.match(all, /"kind": "stream"/u, '流形态内容必须抓到')
  } finally {
    tmpremove(root)
  }
})

test('body2：流形态 tee 之后原流不能被复用（否则 undici 报 disturbed）', async (t) => {
  const root = tmproot('spy-stream')
  const out = join(root, 'out')
  const home = join(root, 'home')
  try {
    const srv = await serve()
    const spy = await installSpy(out, home, '127.0.0.1')
    let err = null
    try {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"z":1}'))
          c.close()
        },
      })
      await (await spy(srv.url, { method: 'POST', body: stream, duplex: 'half' })).text()
    } catch (e) {
      err = e
    } finally {
      spy.__restore()
      srv.close()
    }
    assert.equal(err, null, '流形态不许抛：' + (err === null ? '' : err.message))
  } finally {
    tmpremove(root)
  }
})

// ── 其余既有能力不许退化 ─────────────────────────────────────
test('其它：脱敏 / 限流 / meta 无条件写 / 入口不对写 skip', async (t) => {
  const root = tmproot('spy-misc')
  const out = join(root, 'out')
  const home = join(root, 'home')
  try {
    const srv = await serve()
    const spy = await installSpy(out, home, '127.0.0.1', { CK_SPY_MAX: '2', CK_SPY_FREEZE_MAX: '0' })
    try {
      await (await spy(srv.url, { method: 'POST', body: JSON.stringify({ api_key: REAL_KEY, note: 'task-specific', echo: REAL_KEY }) })).text()
      await (await spy(srv.url, { method: 'GET' })).text()
      await (await spy(srv.url, { method: 'POST', body: '{"x":1}' })).text()
      await (await spy(srv.url, { method: 'POST', body: '{"y":2}' })).text()
    } finally {
      spy.__restore()
      srv.close()
    }
    const bodies = filesIn(out, /^real-body-\d+-\d+-\d+\.json$/u)
    assert.equal(bodies.length, 2, 'CK_SPY_MAX=2 → 只落 2 个正文')
    const all = bodies.map((f) => readFileSync(join(out, f), 'utf8')).join('\n')
    /** 脱敏**只按字段名**（不猜值形态）：api_key 的值必须抹掉，正文里同名字符串**原样保留**。 */
    assert.doesNotMatch(all, /"api_key": "sk-/u, 'api_key 字段必须脱敏')
    assert.match(all, /"api_key": "\*\*\*"/u, '脱敏成 ***')
    assert.match(all, /task-specific/u, '⚠️ `task-specific` 不许被误伤（初版把它抹成 task-*** 导致 P0 假差异）')
    assert.match(all, /"echo": "sk-abcdef0123456789abcdef0123456789"/u, '正文里的同形字符串也不许被猜着抹掉（会制造 P0 假差异）')
    assert.doesNotMatch(all, /task-\*\*\*/u, '`task-\*\*\*` 出现就说明脱敏正则又放宽了')
    assert.ok(filesIn(out, /^spy-meta-/u).length === 1, 'spy-meta 无条件写一次')
    const meta = readFileSync(join(out, filesIn(out, /^spy-meta-/u)[0]), 'utf8')
    assert.doesNotMatch(meta, /authorization/iu, 'meta 不许带请求头')
    assert.doesNotMatch(meta, /sk-abc/u, 'meta 不许带正文值')
    assert.equal(filesIn(out, /^spy-skip-/u).length, 0, '入口对时不该写 skip')
  } finally {
    tmpremove(root)
  }
})

test('其它：入口不对时写 spy-skip 并记下 argv[1]', async (t) => {
  const root = tmproot('spy-skip')
  const out = join(root, 'out')
  try {
    mkdirSync(out, { recursive: true })
    process.env.CK_SPY_OUT = out
    const saved = globalThis.fetch
    process.argv[1] = join(root, 'not-dsh-entry.mjs')
    await import(SPY + '?skip=' + Math.random().toString(36).slice(2))
    const same = globalThis.fetch === saved
    globalThis.fetch = saved
    assert.ok(same, '不是 DSH 入口时不许包装 fetch')
    const skip = filesIn(out, /^spy-skip-.*\.txt$/u)
    assert.equal(skip.length, 1, '必须留痕')
    assert.match(readFileSync(join(out, skip[0]), 'utf8'), /not-dsh-entry\.mjs/u, '要记下 argv[1] 供比对')
  } finally {
    tmpremove(root)
  }
})
