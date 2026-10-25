/**
 * 端到端检查：「最后活动」必须反映真实对话时间，不能拿过期的 `sessions.meta.json` 糊弄。
 *
 * 缺陷（2026-10-22）：面板 `panel-service.ts` 自己 `readFileSync` + `JSON.parse` 读 meta，
 * 绕过了 `readSessionMeta()` 的新鲜度校验。插件一停，meta 就冻在最后一次写盘时刻，
 * 面板拿冻结的旧值当「最后对话」，刚聊完的会话显示成 5.5 小时前。
 *
 * 本脚本只守**结果**：全部黑盒调 `createPanelService({ dshHome, now }).snapshot()`，
 * 不查内部有没有调 `readSessionMeta`。
 *
 * 约束（两条，违反则本检查在别的机器上必红/必绿不定）：
 *  1. 自造临时 home（`tests/_tmp.js` 的 `tmproot()`），**禁止读真实 home**；
 *  2. 过期构造用**明显过期**（now−10min），不用「恰好 5 分钟」（上限判定是严格 `>`）。
 *
 * 跑法：`node scripts/check-activity-freshness.mjs`
 * 退出码：0 全绿 / 1 有失败
 */
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { createPanelService } from '../src/core/panel-service.ts'
import { readLastDialogAt } from '../src/core/sessions.ts'
import { SESSION_META_MAX_AGE_MS } from '../src/core/session-meta.ts'
import { tmproot, tmpremove } from '../tests/_tmp.js'

const VNOW = 1_800_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN
const LOG_NAME = 'session.v4.jsonl.zstd'

const out = []
const check = (name, ok, detail) => { out.push([name, ok, detail]) }

/** 一条最小 DSH 会话日志（多帧 zstd，与真实文件同构）。 */
function writeLog(home, id, dialogAt) {
  const dir = join(home, 'sessions', 'proj-a', id)
  mkdirSync(dir, { recursive: true })
  const lines = [
    { type: 'session', seq: 0, time: dialogAt - MIN, id, cwd: 'C:\\tmp', createdAt: dialogAt - MIN, origin: '' },
    { type: 'user/message', seq: 1, time: dialogAt, data: { message: { role: 'user', content: '你好' } } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n'
  writeFileSync(join(dir, LOG_NAME), zstdCompressSync(Buffer.from(lines, 'utf8')))
  return join(home, 'sessions', 'proj-a', id, LOG_NAME)
}

/** 一条 meta 条目（只填判据关心的字段）。 */
const metaItem = (id, mtime, lastDialogAt) => ({
  mtime, title: 't-' + id, titleSource: 'user', archived: false, origin: '',
  projectKey: 'proj-a', dirName: id, sizeBytes: 1, lastDialogAt,
})

/**
 * 写 `sessions.meta.json`。
 * @param at 文件写入时刻（新鲜度判据只看它，与条目里的值无关）
 */
function writeMeta(home, at, items) {
  const dir = join(home, 'cache-keepalive')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'sessions.meta.json'), JSON.stringify({ at, version: 1, sig: 'x', items }), 'utf8')
}

const svcOf = (home) => createPanelService({ dshHome: home, warm: async () => ({ ok: true }), now: () => VNOW })
const rowOf = (snap, id) => (snap.sessions ?? []).find((r) => r.id === id)

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 9; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 5; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 5; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 5; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 5; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 5; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 5; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 5; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 5; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 5; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 5; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 5; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 5; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 5; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 5; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * **同性质参照量**：把同一批 `N` 条日志各解一遍帧（`readLastDialogAt`），取中位数。
 *
 * 为什么必须「同性质」：试过用空库 snapshot 当参照，不成立（0.07ms 的纯 CPU 心跳与
 * 50~84ms 的解压+磁盘不是一回事，比值飘到 100×+）。这里选「解帧」是因为它正是
 * `snapshot()` 热态的主要成本来源，机器忙/闲两者一起变。
 *
 * 实测稳定性（本机）：
 *   - 空闲 4 轮：比值 4.18 / 4.26 / 4.36 / 4.43
 *   - 8 路 CPU 负载 4 轮：绝对值从 64ms 涨到 **195~246ms**，但比值仍 3.70 / 4.42 / 4.46 / 5.20
 * 所以「绝对阈值会假红、比值不会」。
 */
function refDecodeMsOf(logFiles) {
  const xs = []
  for (let k = 0; k < 5; k += 1) {
    const t = process.hrtime.bigint()
    for (const f of logFiles) readLastDialogAt(f)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 0.5)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 同机空库基线：**只用于诊断输出，不参与判定**。
 *
 * 试过拿它当相对判据（「519 条 ≤ 空库 ×40」），不成立：空库 snapshot 是 0.07ms 量级
 * （纯 CPU 心跳），519 条是 50~84ms（解压 + 磁盘），两者工作性质不同，比值会飘到 100×+。
 * 比值判据要成立，参照量必须是**同性质、同量级**的工作，这里没有这样的参照量。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * **同机现测基线**：空库（0 条会话）跑 `snapshot()` 的耗时。
 *
 * 不用它比绝对值（空库与 519 条根本不是一回事），只用它测「这台机器此刻有多忙」：
 * 机器再慢/再有负载，空库那点活也跟着一起慢，比值相对稳定。
 * 用途见下面的 `WARM_RATIO`。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * **同机现测基线**：空库（0 条会话）跑 `snapshot()` 的耗时。
 *
 * 不用它比绝对值（空库与 519 条根本不是一回事），只用它测「这台机器此刻有多忙」：
 * 机器再慢/再有负载，空库那点活也跟着一起慢，比值相对稳定。
 * 用途见下面的 `WARM_RATIO`。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * **同机现测基线**：空库（0 条会话）跑 `snapshot()` 的耗时。
 *
 * 不用它比绝对值（空库与 519 条根本不是一回事），只用它测「这台机器此刻有多忙」：
 * 机器再慢/再有负载，空库那点活也跟着一起慢，比值相对稳定。
 * 用途见下面的 `WARM_RATIO`。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * **同机现测基线**：空库（0 条会话）跑 `snapshot()` 的耗时。
 *
 * 不用它比绝对值（空库与 519 条根本不是一回事），只用它测「这台机器此刻有多忙」：
 * 机器再慢/再有负载，空库那点活也跟着一起慢，比值相对稳定。
 * 用途见下面的 `WARM_RATIO`。
 */
function idleBaseMsOf(home) {
  const svc = svcOf(home)
  return warmMsOf(svc)
}

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
/**
 * 兜底天花板（毫秒）。**主判据是下面的 `WARM_RATIO`（比值），这个只是保险丝**。
 *
 * 为什么不能只靠绝对值：8 路 CPU 负载下实测 170~246ms，收到 110/200 都会假红
 * （已经因此被打回过一次）。定时器判据一旦随机红，就会被加 `skip` 绕过去，那时什么都拦不住。
 * 400ms 只兜「比值参照本身也失真」的极端情况；量级回归（650ms 那一档）
 * 主要靠比值判据拦 —— 实测 546ms / 参照 15ms = 36×，远超 8 倍阈值。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/** 相对判据上限：519 条热态 ÷ 同机空库热态。本机实测 12~20×，取 40 倍防翻倍级劣化。 */
const WARM_RATIO = 40

/** 相对判据上限：519 条热态 ÷ 同机空库热态。本机实测 12~20×，取 40 倍防翻倍级劣化。 */
const WARM_RATIO = 40

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的绝对上限（毫秒）。
 *
 * 数据来源（本机实测，519 条会话）：
 *   - 实现正确（meta 落值缓存 + 本拍记忆）：过期路径 **70~84ms**、新鲜路径 **51~58ms**
 *   - 上一版（每次 dialogOf 都算一遍 meta 指纹）：**650ms**（新鲜路径）
 * 取 **200ms**：约 2.4 倍余量。
 *
 * ⚠️ **不要再收紧**（曾经收到 110ms，被实测证伪）：
 *   - 4 路 CPU 负载 → 99.0ms（已逼近 110）
 *   - 8 路 CPU 负载 → **170~228ms → 假红**
 *   - 与 `node --test` 并行跑（`npm run check` 的真实情形）→ 同样假红
 *   定时器判据一旦随机假红，就会被人加 `skip` 绕过去，那时它连 650ms 都拦不住。
 *   「更严」≠「更稳」：阈值必须在**有负载**时也给得出绿。
 * 但它也**不能放水到 1s** —— 1s 会让 650ms 的 10 倍回归照样通过（上一版就是这么放过去的）。
 * 量级回归靠「650ms vs 正常 80ms」这 8 倍差距兜底，200ms 足以拦住。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8

/**
 * 性能判据的双阈值。
 *
 * - `WARM_ABS_MS`：绝对上限，防「量级崩」——慢机器也给得起。基线实测 54~84ms，
 *   取 200ms 有约 2.4 倍余量。
 * - `WARM_RATIO`：相对本机基线的倍数，防「在快机器上悄悄劣化」。
 *   绝对阈值单独存在时，**同一条 10 倍回归在快机器上仍是绿的**（上一版就是这么放过去的）。
 *
 * "本机基线"不用旧代码算（旧代码就在仓库里会过期），而用**纯开销参照**：
 * 同样的 519 条会话，把 `snapshot()` 换成「只解一遍帧 + 走一遍目录」的等价工作量。
 * 这样阈值随机器快慢自动缩放，不写死毫秒数。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8
const WARM_RATIO = 2.5

/** 参照量：519 条会话只做解帧（不含任何面板逻辑），代表本机磁盘+解压成本。 */
function baseWarmMsOf(rows) {
  const xs = []
  for (let k = 0; k < 5; k += 1) {
    const t = process.hrtime.bigint()
    for (const r of rows) readLastDialogAt(r.logFile)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 1)
}

/**
 * 性能判据的双阈值。
 *
 * - `WARM_ABS_MS`：绝对上限，防「量级崩」——慢机器也给得起。基线实测 54~84ms，
 *   取 200ms 有约 2.4 倍余量。
 * - `WARM_RATIO`：相对本机基线的倍数，防「在快机器上悄悄劣化」。
 *   绝对阈值单独存在时，**同一条 10 倍回归在快机器上仍是绿的**（上一版就是这么放过去的）。
 *
 * "本机基线"不用旧代码算（旧代码就在仓库里会过期），而用**纯开销参照**：
 * 同样的 519 条会话，把 `snapshot()` 换成「只解一遍帧 + 走一遍目录」的等价工作量。
 * 这样阈值随机器快慢自动缩放，不写死毫秒数。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8
const WARM_RATIO = 2.5

/** 参照量：519 条会话只做解帧（不含任何面板逻辑），代表本机磁盘+解压成本。 */
function baseWarmMsOf(rows) {
  const xs = []
  for (let k = 0; k < 5; k += 1) {
    const t = process.hrtime.bigint()
    for (const r of rows) readLastDialogAt(r.logFile)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 1)
}

/**
 * 性能判据的双阈值。
 *
 * - `WARM_ABS_MS`：绝对上限，防「量级崩」——慢机器也给得起。基线实测 54~84ms，
 *   取 200ms 有约 2.4 倍余量。
 * - `WARM_RATIO`：相对本机基线的倍数，防「在快机器上悄悄劣化」。
 *   绝对阈值单独存在时，**同一条 10 倍回归在快机器上仍是绿的**（上一版就是这么放过去的）。
 *
 * "本机基线"不用旧代码算（旧代码就在仓库里会过期），而用**纯开销参照**：
 * 同样的 519 条会话，把 `snapshot()` 换成「只解一遍帧 + 走一遍目录」的等价工作量。
 * 这样阈值随机器快慢自动缩放，不写死毫秒数。
 */
const WARM_ABS_MS = 400

/**
 * **主判据**：热态 ÷ 同机解帧参照。本机实测 4.18~4.43（空闲）、3.70~5.20（8 路负载）。
 * 取 8 倍：正常值近 2 倍余量，同时拦得住「每次 dialogOf 都算一遍指纹」那档
 * （实测该回归 546ms / 参照 ~15ms = 36×）。
 */
const WARM_RATIO = 8
const WARM_RATIO = 2.5

/** 参照量：519 条会话只做解帧（不含任何面板逻辑），代表本机磁盘+解压成本。 */
function baseWarmMsOf(rows) {
  const xs = []
  for (let k = 0; k < 5; k += 1) {
    const t = process.hrtime.bigint()
    for (const r of rows) readLastDialogAt(r.logFile)
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return Math.max(xs[Math.floor(xs.length / 2)], 1)
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/**
 * 热态耗时：热身两拍后取 **15 拍的中位数**。
 *
 * 为什么是 15 拍而不是 7：与 `node --test` 并行时，7 拍里可能有一两拍被 GC/抢占打出尖峰
 * （实测 189ms，而正常 78~86ms），中位数压不住。样本多一点，中位数才代表「常态」而不是「运气」。
 * 取中位数而不是平均值：平均值会被同样的尖峰直接拉高。
 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/** 热态耗时中位数（先热身两拍，再取 7 拍中位数；单拍会被 GC/磁盘抖动带偏）。 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 7; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/** 热态耗时中位数（先热身两拍，再取 7 拍中位数；单拍会被 GC/磁盘抖动带偏）。 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 7; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/** 热态耗时中位数（先热身两拍，再取 7 拍中位数；单拍会被 GC/磁盘抖动带偏）。 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 7; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/** 热态耗时中位数（先热身两拍，再取 7 拍中位数；单拍会被 GC/磁盘抖动带偏）。 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 7; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/** 热态耗时中位数（先热身两拍，再取 7 拍中位数；单拍会被 GC/磁盘抖动带偏）。 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 7; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/** 热态耗时中位数（先热身两拍，再取 7 拍中位数；单拍会被 GC/磁盘抖动带偏）。 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 7; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/** 热态耗时中位数（先热身两拍，再取 7 拍中位数；单拍会被 GC/磁盘抖动带偏）。 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 7; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/** 热态耗时中位数（先热身两拍，再取 7 拍中位数；单拍会被 GC/磁盘抖动带偏）。 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 7; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/** 热态耗时中位数（先热身两拍，再取 7 拍中位数；单拍会被 GC/磁盘抖动带偏）。 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 7; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/** 热态耗时中位数（先热身两拍，再取 7 拍中位数；单拍会被 GC/磁盘抖动带偏）。 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 7; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/** 热态耗时中位数（先热身两拍，再取 7 拍中位数；单拍会被 GC/磁盘抖动带偏）。 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 7; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/** 热态耗时中位数（先热身两拍，再取 7 拍中位数；单拍会被 GC/磁盘抖动带偏）。 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 7; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

/** 热态耗时中位数（先热身两拍，再取 7 拍中位数；单拍会被 GC/磁盘抖动带偏）。 */
function warmMsOf(svc) {
  svc.snapshot()
  svc.snapshot()
  const xs = []
  for (let i = 0; i < 7; i += 1) {
    const t = process.hrtime.bigint()
    svc.snapshot()
    xs.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

const ID = 'session-fix-0001'

/**
 * 判据 1：meta 过期（now−10min > 5 分钟上限）→ 必须回落扫盘，拿到日志里的真实对话时间。
 * meta 里故意写一个与日志**不同**的值（now−5h），只要面板还返回它就说明没回落。
 */
{
  const home = tmproot('act-stale')
  try {
    const realDialogAt = VNOW - 5 * MIN
    writeLog(home, ID, realDialogAt)
    writeMeta(home, VNOW - 10 * MIN, { [ID]: metaItem(ID, realDialogAt, VNOW - 5 * HOUR) })
    const svc = svcOf(home)
    const row = rowOf(svc.snapshot(), ID)
    const got = row?.lastDialogAt
    const diffMin = Math.abs(got - realDialogAt) / MIN
    check('1   meta 过期 → 回落扫盘，拿到日志真实对话时间（≈now−5min，±1min）',
      typeof got === 'number' && diffMin <= 1,
      `got=${got} 期望≈${realDialogAt} 差=${diffMin.toFixed(2)}min`)
    check('1   回溯值不能是 meta 里的旧值（now−5h）',
      got !== VNOW - 5 * HOUR,
      `got=${got} 旧值=${VNOW - 5 * HOUR}`)
    check('1   日志本身可解帧（确认回落真的读了盘，不是碰巧 0）',
      readLastDialogAt(join(home, 'sessions', 'proj-a', ID, LOG_NAME)) === realDialogAt,
      '')

    /**
     * ⚠️ 这里**不做计时**：1 条会话的 snapshot 是 0.5ms 量级，拿去比阈值只会制造
     * 「测过了」的假象。性能归下面 519 条规模的用例（过期 / 新鲜两条路径各一条）。
     */
  } finally { tmpremove(home) }
}

/**
 * 判据 2：meta 新鲜（at = now）→ 必须复用 meta 里的值（now−1h），
 * 而日志 mtime 是 now、日志里真实对话是 now。若返回 now−1h，说明没有「永远回退」。
 */
{
  const home = tmproot('act-fresh')
  try {
    writeLog(home, ID, VNOW - 5 * MIN)
    writeMeta(home, VNOW, { [ID]: metaItem(ID, VNOW - 5 * MIN, VNOW - HOUR) })
    const got = rowOf(svcOf(home).snapshot(), ID)?.lastDialogAt
    check('2   meta 新鲜（at=now）→ 复用 meta 值（now−1h），没有「永远回退」',
      got === VNOW - HOUR, `got=${got} 期望=${VNOW - HOUR}（日志里是 ${VNOW - 5 * MIN}）`)
  } finally { tmpremove(home) }
}

/**
 * 判据 2b：同一面板实例，先拿过期 meta 跑一次 → 把 meta 改新鲜（60 秒 TTL 内）→ 再跑，
 * 必须立刻拿到新值。防「过期结论被缓存 60 秒」。
 *
 * ⚠️ **不能靠 sleep 保证 mtime 变了**：实测连续两次写盘有近一半落在同一个 `mtimeMs` 刻度，
 * 那样用例会随机假绿。这里直接 `utimesSync` 把 mtime **钉成同一个值**，确定性复现
 * 「mtime/size 都没变、只有内容变了」的极端情况 —— 能过这条，才说明缓存失效不依赖 mtime 精度。
 */
{
  const home = tmproot('act-ttl')
  try {
    const staleAt = VNOW - 10 * MIN
    const freshValue = VNOW - 2 * HOUR
    const metaFile = () => join(home, 'cache-keepalive', 'sessions.meta.json')
    /** 固定 mtime：两次写盘后的时间戳完全一致（秒级），size 也一致（等长改写）。 */
    const PINNED = new Date(1_700_000_000_000)
    const pinMtime = () => utimesSync(metaFile(), PINNED, PINNED)

    writeLog(home, ID, VNOW - 5 * MIN)
    writeMeta(home, staleAt, { [ID]: metaItem(ID, VNOW - 5 * MIN, VNOW - 5 * HOUR) })
    pinMtime()
    let vnow = VNOW
    const svc = createPanelService({ dshHome: home, warm: async () => ({ ok: true }), now: () => vnow })
    const first = rowOf(svc.snapshot(), ID)?.lastDialogAt
    const st1 = statSync(metaFile())

    /** ① 只改值、`at` 仍过期 → 结论应仍是「回落」，证明不是「内容一变就无脑采信」。 */
    writeMeta(home, staleAt, { [ID]: metaItem(ID, VNOW - 5 * MIN, freshValue) })
    pinMtime()
    vnow += 1000
    const mid = rowOf(svc.snapshot(), ID)?.lastDialogAt

    /** ② 把 meta 整体改成新鲜（`at = now`）→ 必须立刻拿到新值。 */
    writeMeta(home, vnow, { [ID]: metaItem(ID, VNOW - 5 * MIN, freshValue) })
    pinMtime()
    const st2 = statSync(metaFile())
    vnow += 1000
    const second = rowOf(svc.snapshot(), ID)?.lastDialogAt

    check('2b  构造有效：两次写盘的 mtime 与 size 完全相同（只有内容变了）',
      st1.mtimeMs === st2.mtimeMs && st1.size === st2.size,
      `mtime ${st1.mtimeMs} vs ${st2.mtimeMs} / size ${st1.size} vs ${st2.size}`)
    check('2b  TTL 内 meta 变新鲜 → 第二次立刻拿到新值（不得缓存「过期」结论）',
      second === freshValue, `first=${first} second=${second} 期望=${freshValue}（虚拟时间共前进 2s）`)
    check('2b  变新鲜之前仍是过期的 meta → 仍按过期处理（回落值不变）',
      mid === VNOW - 5 * MIN, `mid=${mid} 期望=${VNOW - 5 * MIN}`)

    /** ③ meta 文件被删掉 → 缓存必须立刻失效、回落解帧（mtime 同样钉死，排除时间戳帮忙）。 */
    const withMeta = second
    rmSync(metaFile(), { force: true })
    vnow += 1000
    const noMeta = rowOf(svc.snapshot(), ID)?.lastDialogAt
    check('2b  meta 文件删除 → 缓存立刻失效，回落日志值（不沿用 60 秒内的旧结论）',
      withMeta === freshValue && noMeta === VNOW - 5 * MIN,
      `有meta=${withMeta} 删后=${noMeta} 期望=${VNOW - 5 * MIN}`)
  } finally { tmpremove(home) }
}

/**
 * 规模样本：519 条 meta + 519 条日志，**meta 过期与新鲜两种都要测**。
 *
 * 为什么必须补「新鲜」这一半：真实环境里 meta 大部分时间是**新鲜**的（插件 tick 每 60 秒
 * 刷一次），面板走的正是新鲜路径。上一版只在过期场景量性能，结果漏掉了新鲜路径上的
 * 10 倍回归（每次 dialogOf 都算一遍 meta 指纹 × 2080 次/拍）。
 */
{
  const N = 519
  for (const [tag, metaAt, expectAt] of [
    ['过期', VNOW - 10 * MIN, VNOW - 5 * MIN],
    ['新鲜', VNOW, VNOW - 5 * HOUR],
  ]) {
    const home = tmproot('act-scale-' + (tag === '过期' ? 'stale' : 'fresh'))
    try {
      const items = {}
      const usedIds = []
      for (let i = 0; i < N; i += 1) {
        const id = 'session-scale-' + String(i).padStart(4, '0')
        writeLog(home, id, VNOW - 5 * MIN)
        items[id] = metaItem(id, VNOW - 5 * MIN, VNOW - 5 * HOUR)
        usedIds.push(id)
      }
      writeMeta(home, metaAt, items)
      const svc = svcOf(home)
      const snap = svc.snapshot()
      const bad = snap.sessions.filter((r) => r.lastDialogAt !== expectAt)
      check(`1b  ${N} 条 meta ${tag} → 全部取到 ${tag} 应取的来源（无一条错源）`,
        bad.length === 0, `不符 ${bad.length} 条，期望 ${expectAt}`)
      /** 参照量用同一批日志文件、同一磁盘缓存状态（必须在 snapshot 之后测）。 */
      const logFiles = usedIds.map((id) => ({ logFile: join(home, 'sessions', 'proj-a', id, LOG_NAME) }))
      const baseWarmMs = baseWarmMsOf(logFiles)
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      /** 参照量必须在 `${tag}` 路径的热身之后测，且用同一批日志文件（磁盘缓存状态一致）。 */
      const baseWarmMs = baseWarmMsOf(snap.sessions.map((r) => ({ logFile: r._logFile ?? '' })).filter((x) => x.logFile !== ''))
      const warm = warmMsOf(svc)
      /**
       * 双阈值：绝对上限 `WARM_ABS_MS` 防「量级崩」（慢机器也兜得住），
       * 相对倍数 `WARM_RATIO` 防「在快机器上悄悄劣化」（绝对值判据会让回归蒙混过关）。
       * 本机实测：正常 77~84ms、去掉本拍记忆的变异 129~135ms —— 倍数判据能区分两者。
       */
      const ratio = warm / baseWarmMs
      check(`1b  ${N} 条 meta ${tag} 路径 snapshot 热态中位数 < ${WARM_ABS_MS}ms 且 < ${WARM_RATIO}× 基线`,
        warm < WARM_ABS_MS && ratio < WARM_RATIO,
        `${warm.toFixed(1)}ms（基线 ${baseWarmMs.toFixed(1)}ms，${ratio.toFixed(2)}×）`)
    } finally { tmpremove(home) }
  }
}

/** 自检：上限常量仍是 5 分钟（判据的构造完全依赖它）。 */
check('0   过期上限 = 5 分钟（构造前提）', SESSION_META_MAX_AGE_MS === 5 * MIN, String(SESSION_META_MAX_AGE_MS))

let pass = 0
for (const [name, ok, detail] of out) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === '' ? '' : '   [' + detail + ']'))
  if (ok) pass += 1
}
console.log(pass === out.length
  ? `✅ 活动时间新鲜度 ${pass}/${out.length} 全绿`
  : `❌ 活动时间新鲜度 ${pass}/${out.length}（有失败）`)
process.exit(pass === out.length ? 0 : 1)
