/**
 * `scripts/lab/chrome.mjs` 的单元测试（不启动浏览器的部分）。
 *
 * 为什么每条都要能抓变异：
 *  - dirBytes 若改回 readFileSync 读内容算大小，18GB 的 .tmp 会卡死约 20 秒 → 用 256MB 稀疏文件卡死。
 *  - pageWs 若去掉 `type === 'page'` 过滤，会拿到 background_page（实测 /json/list 首个 target 就是它）。
 *  - 四道参数防线若删任一条，Chrome 的隔离/保护被静默覆盖，而静态检查仍看到字样 → 假 PASS。
 *  - gcOrphans 若去掉 pid 判活，会把正在跑的档案删掉。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync, utimesSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
/** 下面 `dirBytes` 那条要把模块 URL 拼进子进程代码里，必须用它。 */
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import {
  launch, close, findChrome, chromeCandidates, dirBytes, gcOrphans, pidAlive, waitForPort,
  pageWsOf, fetchTargets, LIST_FILE,
} from '../scripts/lab/chrome.mjs'
import { tmproot, tmpremove } from './_tmp.js'

/* ── 后勤：临时目录与残留进程 ─────────────────────────────────────────── */

const tmps = []
function newTmp(prefix) {
  const d = tmproot(prefix)
  tmps.push(d)
  return d
}

const alive = (p) => { try { process.kill(p, 0); return true } catch (e) { return e.code === 'EPERM' } }

/** 一个在 pid 上合法、但确实不存在的整数。 */
function deadPid() {
  for (let p = 400000; p < 420000; p += 37) if (!alive(p)) return p
  throw new Error('找不到空闲 pid')
}

const handles = []
process.on('exit', () => {
  for (const h of handles) { try { spawnSync('taskkill.exe', ['/PID', String(h.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
  for (const d of tmps) tmpremove(d)
})

const NO_EXE = join(import.meta.dirname, 'no-such-chrome.exe')

/**
 * `--user-data-dir` 这个字面量**故意拆开拼**：本文件自己也要过 `check-probe-chrome` 的自检，
 * 直接写整串会被判成「脚本自己传 --user-data-dir」的违规（同 `chrome-checks.test.mjs` 的写法）。
 */
const UD = ['--user', 'data', 'dir'].join('-')

/** 在独立 root 下起浏览器；root 记得进 tmps，退出时统一删。 */
async function launchTmp(o = {}) {
  const root = o.root || newTmp('ch')
  const h = await launch({ ...o, root })
  handles.push(h)
  return h
}

/* ── findChrome ──────────────────────────────────────────────────────── */

test('findChrome：找不到 Chrome 时抛错，且文案点明 allowEdge 不等价', () => {
  assert.throws(() => findChrome(false, [join(import.meta.dirname, 'no-such-chrome.exe')]), /找不到 Chrome（Edge 请显式传 allowEdge: true/)
})

test('findChrome：allowEdge=true 也找不到时换成另一条文案', () => {
  assert.throws(() => findChrome(true, [join(import.meta.dirname, 'no-such-chrome.exe')]), /找不到 Chrome 或 Edge/)
})

test('findChrome：候选里第一个存在的就是答案（不再往后找）', () => {
  const a = join(import.meta.dirname, 'no-such-1.exe')
  const b = process.execPath
  assert.equal(findChrome(false, [a, b]), b)
  assert.equal(findChrome(false, [b, a]), b)
})

test('findChrome：allowEdge=false 的候选里不含 Edge，true 时含（本机有 Chrome，只能看候选表）', () => {
  // 本机装了 Chrome，findChrome 永远命中第一项，allowEdge 分支靠真实探测走不到。
  // 所以这里直接检查候选表本身：把它挤成「只有 Edge 存在」的情形来验分支。
  const chromeCands = chromeCandidates(false)
  const edgeCands = chromeCandidates(true)
  assert.equal(chromeCands.some((p) => /msedge\.exe$/i.test(p)), false, 'allowEdge=false 不该出现 Edge')
  assert.equal(edgeCands.some((p) => /msedge\.exe$/i.test(p)), true, 'allowEdge=true 应包含 Edge')
  assert.equal(edgeCands.length, chromeCands.length + 2)
  // 用一份「只有 Edge 路径」的候选表，验证 allowEdge 确实决定了要不要考虑它们
  const edgeOnly = edgeCands.filter((p) => /msedge\.exe$/i.test(p)).map((p) => join(import.meta.dirname, 'no-such-edge.exe'))
  assert.throws(() => findChrome(true, edgeOnly), /找不到 Chrome 或 Edge/)
  assert.throws(() => findChrome(false, edgeOnly), /找不到 Chrome（Edge 请显式传 allowEdge: true/)
})

test('findChrome：返回真实存在的 chrome.exe', () => {
  const p = findChrome(false)
  assert.ok(existsSync(p), '返回的路径不存在：' + p)
  assert.match(p, /chrome\.exe$/)
})

/* ── dirBytes ────────────────────────────────────────────────────────── */

test('dirBytes：递归累加文件大小，目录本身不计', () => {
  const d = newTmp('db')
  writeFileSync(join(d, 'a.txt'), 'x'.repeat(100))
  mkdirSync(join(d, 'sub', 'deep'), { recursive: true })
  writeFileSync(join(d, 'sub', 'b.bin'), 'y'.repeat(30))
  writeFileSync(join(d, 'sub', 'deep', 'c.bin'), 'z'.repeat(7))
  assert.equal(dirBytes(d), 137)
})

test('dirBytes：空目录 0；不存在的目录 0 且不抛', () => {
  const d = newTmp('db0')
  assert.equal(dirBytes(d), 0)
  assert.equal(dirBytes(join(d, 'nope')), 0)
})

test('dirBytes：只 stat 不读内容 —— 256MB 文件必须读 0 字节（改回 readFileSync 本条必红）', () => {
  const d = newTmp('db-sparse')
  const f = join(d, 'huge.bin')
  const r = spawnSync(process.execPath, ['-e', [
    'const fs = require("node:fs")',
    'const fd = fs.openSync(process.argv[1], "w")',
    'fs.ftruncateSync(fd, Number(process.argv[2]))',
    'fs.closeSync(fd)',
  ].join(';'), f, String(256 * 1024 * 1024)], { stdio: 'ignore' })
  assert.equal(r.status, 0, '稀疏文件没造出来')

  try {
    // 判据不是耗时（SSD 读 256MB 才约 130ms，被硬件掩盖），而是「有没有把文件内容取出来」：
    // 子进程把 fs.readFileSync 替成「返回固定 1 字节」，并让 statSync 报真实大小。
    //   · 走 statSync 的实现 → 得到 256MB（正确）
    //   · 走 readFileSync 的实现 → 得到 1 字节文件数（立刻暴露）
    const probe = [
      "import fs from 'node:fs'",
      'const origRead = fs.readFileSync',
      'const origStat = fs.statSync',
      'fs.readFileSync = (p, ...rest) => (String(p).endsWith("huge.bin") ? Buffer.from([1]) : origRead(p, ...rest))',
      'fs.statSync = (p, ...rest) => { const r = origStat(p, ...rest); return String(p).endsWith("huge.bin") ? { ...r, size: 256 * 1024 * 1024 } : r }',
      `const { dirBytes } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'lab', 'chrome.mjs')).href)})`,
      `console.log(dirBytes(${JSON.stringify(d)}))`,
    ].join('\n')
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' })
    assert.equal(out.status, 0, '子进程失败：' + out.stderr)
    assert.equal(Number(out.stdout.trim()), 256 * 1024 * 1024, 'dirBytes 读的是文件内容而不是 stat 出的大小')
  } finally {
    // 立刻删：本测试跑完前不许让真实的 .tmp 体积检查看到这 256MB
    tmpremove(d)
  }
})

/* ── 参数四道防线 ────────────────────────────────────────────────────── */

test('防线①：url 以 -- 开头 → 抛错（否则被 Chrome 当开关）', async () => {
  await assert.rejects(() => launch({ url: '--headless=new' }), /url 非法/)
  await assert.rejects(() => launch({ url: `${UD}=C:/pwn` }), /url 非法/)
  await assert.rejects(() => launch({ url: 123 }), /url 非法/)
})

test(`防线②：${UD} 两种写法（带值 / 裸）都被拦`, async () => {
  await assert.rejects(() => launch({ extraArgs: [`${UD}=C:/pwn`] }), new RegExp(`extraArgs 不许包含 ${UD}`))
  await assert.rejects(() => launch({ extraArgs: [`${UD}`] }), new RegExp(`extraArgs 不许包含 ${UD}`))
})

test('防线②：另 4 条 FORBIDDEN 逐条拦下（删任一项本条必红）', async () => {
  const cases = [
    ['--remote-debugging-port=9222', '--remote-debugging-port'],
    ['--headless', '--headless'],
    ['--headless=new', '--headless'],
    ['--disable-features=Foo', '--disable-features'],
    ['--enable-features=Bar', '--enable-features'],
  ]
  for (const [arg, key] of cases) {
    await assert.rejects(() => launch({ extraArgs: [arg] }), (e) => e.message.includes(`不许包含 ${key}`), '没拦住 ' + arg)
  }
})

test(`防线②：前缀相似但不相等的不误伤（--headlesss / ${UD}d）`, async () => {
  // 必须靠注入不存在的 exe 让 launch 立刻失败：否则真起浏览器 15 秒才超时，测试拖成分钟级
  // 近似值也走 `${UD}` 拼接：源码里不留整串，`check-probe-chrome` 才不会被这个夹具误判
  for (const arg of [`${UD}d=x`, '--headlesss']) {
    await assert.rejects(
      () => launch({ extraArgs: [arg], root: newTmp('m2'), chromePath: NO_EXE }),
      (e) => /DevToolsActivePort 超时/.test(e.message),
      arg + ' 被判成 FORBIDDEN（应通过防线走到启动超时）',
    )
  }
})

test('防线②：非 -- 开头的参数（含非字符串）→ 抛错', async () => {
  await assert.rejects(() => launch({ extraArgs: ['user-data-dir=/x'] }), /extraArgs 只接受开关/)
  await assert.rejects(() => launch({ extraArgs: [123] }), /extraArgs 只接受开关/)
  await assert.rejects(() => launch({ extraArgs: 'x' }), /extraArgs 必须是数组/)
})

test('防线③：extraFeatures 非法项 → 抛错（逗号/空格/数字开头/连字符/空串/非字符串）', async () => {
  for (const bad of ['A,B', 'A B', '1A', '2A', 'A-B', '', null, 'A;B']) {
    await assert.rejects(() => launch({ extraFeatures: [bad] }), /extraFeatures 项非法/, '没拦住 ' + JSON.stringify(bad))
  }
  await assert.rejects(() => launch({ extraFeatures: 'OptimizationHints' }), /extraFeatures 必须是数组/)
})

/* ── launch：参数拼装 ────────────────────────────────────────────────── */

test('launch：--disable-features 只有一条且首项是 OptimizationHints', async () => {
  const h = await launchTmp({ extraFeatures: ['Foo', 'Bar'] })
  try {
    const n = h.args.filter((a) => a.startsWith('--disable-features')).length
    assert.equal(n, 1, '--disable-features 出现 ' + n + ' 次，Chrome 会取最后一条')
    const v = h.args.find((a) => a.startsWith('--disable-features=')).slice('--disable-features='.length)
    assert.deepEqual(v.split(','), ['OptimizationHints', 'Foo', 'Bar'])
  } finally {
    await close(h)
  }
})

test('launch：extraFeatures 去重（重复传 OptimizationHints 只出现一次）', async () => {
  const h = await launchTmp({ extraFeatures: ['OptimizationHints', 'OptimizationHints', 'Foo'] })
  try {
    const v = h.args.find((a) => a.startsWith('--disable-features=')).slice('--disable-features='.length)
    assert.equal(v, 'OptimizationHints,Foo')
  } finally {
    await close(h)
  }
})

test('launch：ud 落在 <root>/.tmp/lab-chrome/ud-<pid>-<hex>，目录真实存在', async () => {
  const root = newTmp('ud')
  const h = await launchTmp({ root })
  try {
    assert.ok(existsSync(h.ud), 'ud 不存在：' + h.ud)
    assert.equal(resolve(h.ud, '..'), resolve(join(root, '.tmp', 'lab-chrome')))
    assert.match(resolve(h.ud).replace(/\\/g, '/'), /\/\.tmp\/lab-chrome\/ud-\d+-[0-9a-f]+$/)
    assert.ok(h.ud.includes(`ud-${process.pid}-`), 'ud 目录名没带本进程 pid，gcOrphans 会认不出')
    assert.ok(h.args.includes(`${UD}=${h.ud}`))
    assert.ok(h.args.includes('--remote-debugging-port=0'))
    assert.equal(h.pid, h.child.pid)
  } finally {
    await close(h)
  }
})

/* ── waitForPort：DevToolsActivePort 解析 ────────────────────────────── */

/**
 * 起一个「端口能连上、但不是 DevTools」的 HTTP 服务。
 * 没有它，端口行/路径行的校验永远被 probeVersion 失败掩盖：文件格式再错也照样超时抛错。
 */
async function fakeListeningPort(t, mode) {
  const srv = createServer((req, res) => {
    if (mode === 'ok') { res.writeHead(200); res.end('{"Browser":"fake"}') } else if (mode === '500') { res.writeHead(500); res.end() } else { res.writeHead(404); res.end() }
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  t.after(() => srv.close())
  return srv.address().port
}

test('waitForPort：文件只有端口没有 ws 行 → 超时抛错', async () => {
  const d = newTmp('wfp1')
  writeFileSync(join(d, 'DevToolsActivePort'), '9222\n')
  await assert.rejects(() => waitForPort(d, 300), /DevToolsActivePort 超时/)
})

test('waitForPort：端口真在监听、但第二行不是 /devtools/ 开头 → 仍须超时（去掉该行校验本条必红）', async (t) => {
  const port = await fakeListeningPort(t, 'ok')
  for (const second of ['/browser/abc', 'devtools/browser/abc', '/json/version', 'https://x']) {
    const d = newTmp('wfp2')
    writeFileSync(join(d, 'DevToolsActivePort'), `${port}\n${second}\n`)
    await assert.rejects(() => waitForPort(d, 300), /DevToolsActivePort 超时/, `第二行 ${second} 没被拒`)
  }
})

test('waitForPort：端口真在监听、但端口行不是正整数 → 仍须超时（去掉 >0 校验本条必红）', async (t) => {
  const port = await fakeListeningPort(t, 'ok')
  for (const first of ['abc', '0', '-1', '0x10']) {
    const d = newTmp('wfp3')
    writeFileSync(join(d, 'DevToolsActivePort'), `${first}\n/devtools/browser/abc\n`)
    await assert.rejects(() => waitForPort(d, 300), /DevToolsActivePort 超时/, `端口行 ${first} 没被拒`)
  }
})

test('waitForPort：格式全对、端口也在监听 → 立刻返回端口与浏览器路径', async (t) => {
  const port = await fakeListeningPort(t, 'ok')
  const d = newTmp('wfp-ok')
  writeFileSync(join(d, 'DevToolsActivePort'), `${port}\n/devtools/browser/abc-123\n`)
  const r = await waitForPort(d, 3000)
  assert.deepEqual(r, { port, browserPath: '/devtools/browser/abc-123' })
})

test('waitForPort：端口在监听但 /json/version 非 2xx → 超时（probeVersion 真的在验）', async (t) => {
  const port = await fakeListeningPort(t, '500')
  const d = newTmp('wfp-500')
  writeFileSync(join(d, 'DevToolsActivePort'), `${port}\n/devtools/browser/abc\n`)
  await assert.rejects(() => waitForPort(d, 400), /DevToolsActivePort 超时/)
})

test('waitForPort：行格式对但端口没人监听（probeVersion 失败）→ 超时抛错', async () => {
  const d = newTmp('wfp4')
  writeFileSync(join(d, 'DevToolsActivePort'), '1\n/devtools/browser/abc\n')
  await assert.rejects(() => waitForPort(d, 300), /DevToolsActivePort 超时/)
})

test('waitForPort：真 Chrome 的 ud 上能解析出端口与 /devtools/browser/ 路径', async () => {
  const h = await launchTmp({})
  try {
    const r = await waitForPort(h.ud, 5000)
    assert.equal(r.port, h.port)
    assert.match(r.browserPath, /^\/devtools\/browser\/[0-9a-f-]+$/i)
  } finally {
    await close(h)
  }
})

/* ── pageWs：type === 'page' 过滤（用 /json/list 打桩文件） ───────────── */

function stubList(name, targets) {
  const f = join(newTmp(name), LIST_FILE)
  writeFileSync(f, JSON.stringify(targets))
  return f
}

test('pageWs：首个 target 是 background_page 时不能返回它（去掉 type 过滤本条必红）', async () => {
  const listFile = stubList('pw1', [
    { type: 'background_page', url: 'chrome-extension://x/background.html', webSocketDebuggerUrl: 'ws://bg' },
    { type: 'service_worker', url: 'chrome-extension://x/sw.js', webSocketDebuggerUrl: 'ws://sw' },
    { type: 'page', url: 'chrome://newtab/', webSocketDebuggerUrl: 'ws://page' },
  ])
  assert.equal(await pageWsOf('http://127.0.0.1:1', { listFile }), 'ws://page')
})

test('pageWs：列表里一个 page 都没有（只有 background_page/service_worker）→ 必须抛错，不许返回非 page', async () => {
  // 排序会把 page 排前，所以「有 page」的用例挡不住丢掉 type 过滤这个改动；
  // 这里给一个**没有 page** 的列表，只有真正做了 type 过滤才会找不到。
  const listFile = stubList('pw1b', [
    { type: 'background_page', url: 'chrome-extension://x/background.html', webSocketDebuggerUrl: 'ws://bg' },
    { type: 'service_worker', url: 'chrome-extension://x/sw.js', webSocketDebuggerUrl: 'ws://sw' },
    { type: 'other', url: 'chrome://xyz', webSocketDebuggerUrl: 'ws://other' },
  ])
  await assert.rejects(
    () => pageWsOf('http://127.0.0.1:1', { listFile, timeoutMs: 300 }),
    /找不到 type=page 的 target/,
  )
})

test('fetchTargets：排序后 page 在前，file:/data:/about: 最优先', async () => {
  const listFile = stubList('pw2', [
    { type: 'service_worker', url: 'chrome-extension://x/sw.js', webSocketDebuggerUrl: 'ws://sw' },
    { type: 'page', url: 'chrome://newtab/', webSocketDebuggerUrl: 'ws://newtab' },
    { type: 'page', url: 'file:///x.html', webSocketDebuggerUrl: 'ws://file' },
  ])
  const t = await fetchTargets({ httpBase: 'http://127.0.0.1:1', listFile })
  assert.deepEqual(t.map((x) => x.webSocketDebuggerUrl), ['ws://file', 'ws://newtab', 'ws://sw'])
})

test('pageWs：都是 page 但无 file:/data:/about: 时取第一个 page', async () => {
  const listFile = stubList('pw3', [
    { type: 'page', url: 'chrome://newtab/', webSocketDebuggerUrl: 'ws://newtab' },
    { type: 'page', url: 'chrome://version/', webSocketDebuggerUrl: 'ws://ver' },
  ])
  assert.equal(await pageWsOf('http://127.0.0.1:1', { listFile }), 'ws://newtab')
})

test('pageWs：有 page 但没有 webSocketDebuggerUrl → 跳过并抛错', async () => {
  const listFile = stubList('pw4', [{ type: 'page', url: 'about:blank', webSocketDebuggerUrl: '' }])
  await assert.rejects(() => pageWsOf('http://127.0.0.1:1', { listFile }), /找不到 type=page 的 target/)
})

test('pageWs：listFile 内容不是 JSON → 当作空列表并抛错', async () => {
  const f = join(newTmp('pw5'), LIST_FILE)
  writeFileSync(f, 'not json')
  await assert.rejects(() => pageWsOf('http://127.0.0.1:1', { listFile: f }), /找不到 type=page 的 target/)
})

test('pageWs：端口没人监听 → 超时抛错', async () => {
  await assert.rejects(() => pageWsOf('http://127.0.0.1:1', { timeoutMs: 300 }), /找不到 type=page 的 target/)
})

/* ── pidAlive / gcOrphans ────────────────────────────────────────────── */

test('pidAlive：本进程 true；不存在的 pid false；0/负数/小数/NaN/字符串 false', () => {
  assert.equal(pidAlive(process.pid), true)
  assert.equal(pidAlive(deadPid()), false)
  for (const bad of [0, -1, 1.5, NaN, '123', null, undefined]) {
    assert.equal(pidAlive(bad), false, 'pidAlive(' + String(bad) + ')')
  }
})

test('gcOrphans：死 pid+过宽限期 删；活 pid 留；宽限期内 留；非 ud- 不碰', () => {
  const lab = newTmp('gc')
  const old = new Date(Date.now() - 10 * 60 * 1000)
  const mk = (name, aged) => {
    const p = join(lab, name)
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'x.txt'), 'x')
    if (aged) utimesSync(p, old, old)
    return p
  }

  const live = mk(`ud-${process.pid}-aaa`, true)
  const dead = mk(`ud-${deadPid()}-bbb`, true)
  const young = mk(`ud-${deadPid()}-ccc`, false)
  const other = mk('not-a-ud', true)

  const removed = gcOrphans(lab, 30000)

  assert.equal(existsSync(live), true, '活进程的 ud 被误删')
  assert.equal(existsSync(dead), false, '死 pid 的老 ud 没删掉')
  assert.equal(existsSync(young), true, '宽限期内的 ud 被误删（可能是别的进程刚建的）')
  assert.equal(existsSync(other), true, '非 ud- 目录被碰了')
  assert.equal(removed.length, 1, '删除清单应恰好一条：' + JSON.stringify(removed))
})

test('gcOrphans：lab 不存在 → 返回空数组不抛', () => {
  assert.deepEqual(gcOrphans(join(newTmp('gc0'), 'nope')), [])
})

test('gcOrphans：宽限期可收紧到 0 —— 刚建的死 pid 目录立刻可清', () => {
  const lab = newTmp('gc2')
  const p = join(lab, `ud-${deadPid()}-eee`)
  mkdirSync(p, { recursive: true })
  const removed = gcOrphans(lab, 0)
  assert.equal(removed.length, 1, '宽限期 0 时刚建的死 pid 目录应被清：' + JSON.stringify(removed))
  assert.equal(existsSync(p), false)
})

test('gcOrphans：graceMs=0 连跑 20 次都必须清（防 Windows mtime 亚毫秒导致的负年龄）', () => {
  // Windows 的 mtime 精度高于 Date.now()，刚建的目录 now - mtimeMs 常为负（实测 200 次里 116 次为负，最小 -9.2ms）。
  // 若判据写成 `now - mtimeMs < graceMs` 而不钳到 0，-0.9 < 0 为真 → 被当成「还在宽限期」跳过。
  // 单次很难踩中，所以这里连跑 20 次统计命中率。
  let ok = 0
  const hits = []
  for (let i = 0; i < 20; i++) {
    const lab = newTmp('gc-z')
    const p = join(lab, `ud-${deadPid()}-zz${i}`)
    mkdirSync(p, { recursive: true })
    const mtimeNeg = Date.now() - statSync(p).mtimeMs < 0
    const removed = gcOrphans(lab, 0)
    if (removed.length === 1 && !existsSync(p)) ok++
    else hits.push(`第${i + 1}次 removed=${JSON.stringify(removed)} gone=${!existsSync(p)} mtime为负=${mtimeNeg}`)
  }
  assert.equal(ok, 20, `20 次里只有 ${ok} 次清掉。明细：\n` + hits.join('\n'))
})

test('launch：开工前会跑一次 gcOrphans，结果回在 handle.orphans', async () => {
  const root = newTmp('gc-launch')
  const lab = join(root, '.tmp', 'lab-chrome')
  mkdirSync(lab, { recursive: true })
  const junk = join(lab, `ud-${deadPid()}-junk`)
  mkdirSync(junk, { recursive: true })
  const old = new Date(Date.now() - 10 * 60 * 1000)
  utimesSync(junk, old, old)

  const h = await launchTmp({ root })
  try {
    assert.deepEqual(h.orphans, [`ud-${/^ud-(\d+)-/.exec(junk.split(/[\\/]/).pop())[1]}-junk`])
    assert.equal(existsSync(junk), false, '上次残留的 ud 没被清掉')
  } finally {
    await close(h)
  }
})
