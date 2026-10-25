/**
 * `scripts/lab/chrome.mjs` 的**真实浏览器**测试。
 *
 * 这些断言用打桩替不掉：
 *  - `pageWs()` 能连上且 `Runtime.evaluate('1+1')` === 2（页面级端点才认 Runtime.*）。
 *  - `browserWsUrl` 上发 `Runtime.evaluate` 报 `-32601` —— 证明「浏览器级端点≠页面级」这条注释是真的。
 *  - `close()` 后 ud 目录与浏览器进程都消失，不留残留。
 *  - 两个档案并发时端口与目录互不相同。
 *
 * ## 清理纪律（本文件曾因泄漏把整机内存搞炸，必须遵守）
 * 每个用例**第一句**就 `t.after(...)` 登记清理，而不是靠末尾的 `finally`：
 *  - `finally` 在断言失败时也会跑，但**用例抛错早于 finally 覆盖范围**、或进程被中断时就没人管；
 *  - `t.after` 由 test runner 在该用例结束后**无论成败**调用，是结构保证不是自觉。
 * 顶层 `after()` 只作为最后兜底（它只在 runner 正常收尾时执行，进程被 kill 时不跑）。
 *
 * 时长控制：一个文件顺序跑 6 个用例，每个约 1~2 秒。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { launch, close, dirBytes, LIST_FILE } from '../scripts/lab/chrome.mjs'
import { tmproot, tmpremove } from './_tmp.js'

// 本文件自己建的所有根目录（前缀 ck-real-*），顶层 after 兜底删
const roots = []

function newTmp(prefix) {
  const d = tmproot(prefix)
  roots.push(d)
  return d
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 按 user-data-dir 精确杀掉指向该目录的所有 chrome 进程。
 *
 * **为什么必须这么做（实测）**：`close()` 里的 `killTree(child.pid)` 杀的是 Node spawn 出来的
 * 「启动器」进程，真正的 Chrome 主进程是它的**子进程**，两者不是同一个 pid：
 *   h.pid = 28860（启动器） → 7080|28860|MAIN（真 Chrome）+ 8 个子进程
 * 启动器先退出后，`taskkill /T` 的树关系断裂，9 个 chrome 全活下来并占住 ud，
 * 于是 rmSync 一直 EPERM、ud 目录删不掉 —— 这就是 116MB/次的泄漏。
 *
 * 只匹配 **本 ud 的绝对路径**，绝不会碰到用户自己的浏览器窗口。
 */
function killChromeOf(ud) {
  if (!ud) return 0
  try {
    // 路径里可能有单引号，PowerShell 里要双写
    const esc = ud.replace(/'/g, "''")
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | `
      + `Where-Object { $_.CommandLine -like '*${esc}*' } | ForEach-Object { $_.ProcessId }`,
    ], { encoding: 'utf8' })
    const pids = out.split(/\s+/).filter(Boolean)
    if (!pids.length) return 0
    const args = []
    for (const p of pids) args.push('/PID', p)
    // 不带 /T：这些 pid 就是整棵树的成员，逐个杀更可靠（树关系已断）
    try { execFileSync('taskkill.exe', [...args, '/F'], { stdio: 'ignore' }) } catch {}
    return pids.length
  } catch { return 0 }
}

/** 尽力删目录，绝不抛错（清理失败不得把「用例本来通过」变成失败）。 */
async function rmSoft(dir, tries = 12) {
  for (let i = 0; i < tries; i++) {
    if (!existsSync(dir)) return true
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
    if (!existsSync(dir)) return true
    // Chrome 退出后文件句柄不立即释放（实测 EPERM），等一会儿再试
    await sleep(100)
  }
  return !existsSync(dir)
}

/**
 * 关掉一个 handle：先按 ud 杀进程（补 close() 的缺口），再删目录。
 * 全程不抛错。
 */
async function dispose(h) {
  if (!h) return
  try { await close(h) } catch {}
  // close() 杀不干净的，这里按 ud 精确补刀
  for (let i = 0; i < 5; i++) {
    if (!existsSync(h.ud)) break
    killChromeOf(h.ud)
    await sleep(250)
    try { rmSync(h.ud, { recursive: true, force: true }) } catch {}
  }
}

/**
 * 起一个浏览器，并把「关它」挂到当前用例的 t.after 上。
 * 用例中途任何断言失败、抛错，runner 都会调这个清理，不会留 chrome 进程与 ud 目录。
 * @param {import('node:test').TestContext} t
 * @param {object} [o] 透传给 launch
 */
async function open(t, o = {}) {
  const root = o.root || newTmp('real')
  const h = await launch({ ...o, root })
  const done = { v: false }
  t.after(async () => {
    if (!done.v) { done.v = true; await dispose(h) }
    else killChromeOf(h.ud)
    await rmSoft(h.ud)
    await rmSoft(h.lab)
    await rmSoft(root)
    // 只有确认真的没了才从兜底清单移除，否则留给顶层 after 再试
    const i = roots.indexOf(root)
    if (i >= 0 && !existsSync(root)) roots.splice(i, 1)
  })
  // 让用例里能提前关（并发用例关 b），关过就不再重复关
  h._closeOnce = async () => {
    if (done.v) return
    done.v = true
    await dispose(h)
    killChromeOf(h.ud)
  }
  return h
}

/** 在某个 ws 上发一帧并取回第一帧。 */
function rpc(wsUrl, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const t = setTimeout(() => { try { ws.close() } catch {} ; reject(new Error('ws 超时：' + wsUrl)) }, timeoutMs)
    ws.onerror = () => { clearTimeout(t); reject(new Error('ws 连接失败：' + wsUrl)) }
    ws.onopen = () => ws.send(JSON.stringify(payload))
    ws.onmessage = (e) => { clearTimeout(t); try { ws.close() } catch {} ; resolve(JSON.parse(e.data)) }
  })
}

const EVAL = { id: 1, method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } }

const alive = (p) => { try { process.kill(p, 0); return true } catch (e) { return e.code === 'EPERM' } }

// 最后兜底：只在 runner 正常收尾时执行；进程被 kill 时它不跑，所以它不能是唯一防线
after(async () => {
  for (const d of roots.splice(0)) await rmSoft(d)
})

test('真实浏览器：launch 后 ud 存在，pageWs 上 Runtime.evaluate(1+1) === 2', async (t) => {
  const h = await open(t, { url: 'about:blank' })

  assert.ok(existsSync(h.ud), 'ud 不存在：' + h.ud)
  assert.ok(h.port > 0)

  const page = await h.pageWs()
  assert.match(page, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/page\/[0-9A-F]+$/i)
  assert.ok(page.includes(':' + h.port + '/'), 'pageWs 端口与 handle.port 不一致')

  const r = await rpc(page, EVAL)
  assert.equal(r.error, undefined, '页面级端点不该报错：' + JSON.stringify(r.error))
  assert.equal(r.result.result.value, 2)

  // close() 的契约：返回时 ud 与浏览器进程都必须已经消失
  await close(h)
  assert.equal(existsSync(h.ud), false, 'close 后 ud 还在：' + h.ud)
  assert.equal(alive(h.pid), false, 'close 后浏览器进程还在：' + h.pid)
})

test('真实浏览器：browserWsUrl 上发 Runtime.evaluate 报 -32601（证明它不是页面端点）', async (t) => {
  const h = await open(t, { url: 'about:blank' })

  assert.match(h.browserWsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]+$/i)
  const r = await rpc(h.browserWsUrl, EVAL)
  assert.ok(r.error, '浏览器级端点居然执行成功，说明 handle.browserWsUrl 给错了')
  assert.equal(r.error.code, -32601, '错误码不是 -32601：' + JSON.stringify(r.error))
  assert.match(r.error.message, /Runtime\.evaluate.*wasn't found/)

  await close(h)
  assert.equal(existsSync(h.ud), false)
})

test('真实浏览器：两个档案并发 —— 端口不同、目录不同、互不干扰，close 一个另一个照常工作', async (t) => {
  const a = await open(t, { url: 'about:blank' })
  const b = await open(t, { url: 'data:text/html,<title>B</title>' })

  assert.notEqual(a.port, b.port, '两个档案抢到了同一个端口')
  assert.notEqual(a.ud, b.ud)
  assert.notEqual(a.lab, b.lab, '两个档案共用了 lab 目录')

  await b._closeOnce()
  assert.equal(existsSync(b.ud), false, '关掉的 b 的 ud 还在')
  assert.equal(existsSync(a.ud), true, '关 b 把 a 的 ud 也删了')

  const r = await rpc(await a.pageWs(), EVAL)
  assert.equal(r.result.result.value, 2, '关掉 b 之后 a 不能用了')

  await close(a)
  assert.equal(existsSync(a.ud), false)
})

test('真实浏览器：单档案 2 秒内体积远小于 49MB（OptimizationHints 生效的粗体检）', async (t) => {
  const h = await open(t, { url: 'about:blank' })

  const mb = dirBytes(h.ud) / 1048576
  // 不做 25 秒饱和测量（太慢）；这里只保证「没有在启动前就把 49MB 塞进来」
  assert.ok(mb < 30, `ud 已经 ${mb.toFixed(1)}MB，超出启动阶段应有量级`)
})

test('真实浏览器：pageWs() 入口必须只认 type=page（列表首个是 background_page 时不能返回它）', async (t) => {
  // 这条守的是**对外入口** handle.pageWs()，不是内部函数 pageWsOf。
  // 用打桩 list 构造「background_page 排第一、page 排第二」——真实 Chrome 的 /json/list 就是这个顺序。
  const root = newTmp('entry')
  const d = join(root, 'ab')
  mkdirSync(d, { recursive: true })
  const listFile = join(d, LIST_FILE)
  writeFileSync(listFile, JSON.stringify([
    { type: 'background_page', url: 'chrome-extension://x/background.html', webSocketDebuggerUrl: 'ws://bg-must-not-win' },
    { type: 'service_worker', url: 'chrome-extension://x/sw.js', webSocketDebuggerUrl: 'ws://sw-must-not-win' },
    { type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://page-expected' },
  ]))

  const h = await open(t, { root, pageWsOpts: { listFile } })

  const ws = await h.pageWs()
  assert.equal(ws, 'ws://page-expected', 'pageWs() 入口返回了非 page 的 target')

  // 再给一份「一个 page 都没有」的列表：入口必须抛错，不能退而求其次拿 background_page
  writeFileSync(listFile, JSON.stringify([
    { type: 'background_page', url: 'chrome-extension://x/background.html', webSocketDebuggerUrl: 'ws://bg' },
    { type: 'service_worker', url: 'chrome-extension://x/sw.js', webSocketDebuggerUrl: 'ws://sw' },
  ]))
  await assert.rejects(() => h.pageWs(), /找不到 type=page 的 target/, 'pageWs() 在只有 background_page 时居然返回了值')
})

test('真实浏览器：lab-chrome 目录下不留 ud（每个用例都清干净）', () => {
  const labs = new Set(roots)
  for (const lab of labs) {
    if (!existsSync(lab)) continue
    const left = readdirSync(lab)
    assert.deepEqual(left, [], 'lab 目录残留：' + join(lab, left.join(',')))
  }
})

// 收尾自检：本文件跑完不应有任何 chrome 进程还指着我们建过的目录
after(() => {
  for (const d of roots) killChromeOf(d)
})
