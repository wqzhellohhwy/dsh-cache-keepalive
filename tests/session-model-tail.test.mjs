/**
 * 尾部读组（`readTailFacts`）：`readSessionModel` 与 `readLastDialogAt` 共用**一次**读盘 + 一趟扫帧。
 *
 * 为什么必须有这组断言：合并后两条判据的**取数口径**变成了同一个函数，任何一边少了命中路径
 * （例如只剩 `request/header`、或漏了全量兜底）都会让 per-model 覆盖静默失效 —— 而
 * 87 条会话 `model` 为 undefined 是基线事实，漏掉兜底会让这个数字变大却没人发现。
 *
 * **与更早的旧实现之间有一处已知差异，属修复不是回归**（Lead 已裁定保留）：
 * 967 行的旧版 `readSessionModel` 只认 `request/header`、且尾部扫满 12 帧就放弃 → 长会话一律 undefined；
 * 新版还认 `assistant/message` 的 `message.source`，并把帧预算**跨窗口累计**。
 * 真机 563 条实测：`model` 为 undefined 的从 **413 条降到 88 条** —— 326 条从 null 变成有值，
 * 方向单一（`oldValNewNull=0`、`bothDiffVal=0`），全量解析验证 **新版即真值、旧版漏识别**。
 * 别为了"与旧版零差异"把 `assistant/message` 这条路径删掉：那会让 per-model 覆盖对长会话彻底失效。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { tmproot, tmpremove } from './_tmp.js'
import {
  readLastDialogAt, readSessionModel, readRounds, readRoundsCached, readRoundsCachedWithText,
} from '../src/core/sessions.ts'

const PK = '--C-proj--'
const SID = 'session-tailread-0000-0000-0000-000000000001'

const line = (o) => JSON.stringify(o)
const frame = (events) => zstdCompressSync(Buffer.from(events.map(line).join('\n') + '\n', 'utf8'))
const logOf = (dir, frames) => {
  mkdirSync(join(dir, 'sessions', PK, SID), { recursive: true })
  const f = join(dir, 'sessions', PK, SID, 'session.v4.jsonl.zstd')
  writeFileSync(f, Buffer.concat(frames))
  return f
}

const assistant = (time, provider, model, usage) => ({
  type: 'assistant/message',
  seq: 1,
  time,
  data: {
    turn: 1,
    step: 1,
    ...(usage === undefined ? {} : { usage }),
    message: { role: 'assistant', source: { provider, model }, content: [{ type: 'text', text: 'ok' }] },
  },
})
const user = (time, text) => ({ type: 'user/message', seq: 2, time, message: { role: 'user', content: [{ type: 'text', text }] } })
const header = (time, provider, model) => ({
  type: 'request/header',
  seq: 0,
  time,
  data: { header: { config: { provider, model } } },
})
const tool = (i) => ({ type: 'tool/call', seq: 100 + i, time: 1000 + i, data: { name: 'read', input: { i } } })
const usageOf = (n) => ({
  inputTokens: n, cacheReadTokens: n * 3, outputTokens: n, totalTokens: n * 4,
})

test('① 尾部只有 assistant/message（无 request/header）→ 也能拿到 provider/model', () => {
  const dir = tmproot('tail-a')
  try {
    const f = logOf(dir, [frame([user(1000, 'hi'), assistant(2000, 'deepseek-official', 'deepseek-flash', usageOf(10))])])
    assert.deepEqual(readSessionModel(f), { provider: 'deepseek-official', model: 'deepseek-flash' })
    assert.equal(readLastDialogAt(f), 2000)
  } finally { tmpremove(dir) }
})

test('② 两种事件都在 → 优先 request/header（那是真实配置头）', () => {
  const dir = tmproot('tail-b')
  try {
    /** `request/header` 在文件里更靠后 → 从后往前扫时先遇到它。 */
    const f = logOf(dir, [frame([
      user(1000, 'hi'),
      assistant(2000, 'assistant-src', 'model-from-source', usageOf(10)),
      header(2100, 'header-cfg', 'model-from-header'),
    ])])
    assert.deepEqual(readSessionModel(f), { provider: 'header-cfg', model: 'model-from-header' })
  } finally { tmpremove(dir) }
})

test('③ 尾部 12 帧都没有路由事件 → 靠全量兜底拿到', () => {
  const dir = tmproot('tail-c')
  try {
    /**
     * 帧 0 是唯一的 `assistant/message`（带 usage，`readRounds` 能取到）；
     * 后面 19 帧全是工具事件 —— 超过 `MAX_TAIL_FRAMES=12`，尾部扫不到任何路由事件。
     */
    const frames = [frame([user(1000, 'hi'), assistant(2000, 'fallback PROVIDER', 'fallback-model', usageOf(10))])]
    for (let i = 0; i < 19; i += 1) frames.push(frame([tool(i)]))
    const f = logOf(dir, frames)
    assert.deepEqual(readSessionModel(f), { provider: 'fallback PROVIDER', model: 'fallback-model' },
      '没走全量兜底 → 这类会话的 per-model 门槛会静默失效')
    /**
     * 对话时间**没有**全量兜底（与旧实现一致）：尾部 12 帧扫不到就给 0 = 「未知」，
     * 调用方按「活动未知」放行。这里钉住这个语义，别哪天顺手加兜底把 `lastDialogAt` 变慢。
     */
    assert.equal(readLastDialogAt(f), 0, '对话时间不该为 model 的兜底买单')
  } finally { tmpremove(dir) }
})

/** 造一个 ≥5MB、多帧、尾部有 `assistant/message` 的日志（每帧内容不同，避免压缩率虚高）。 */
const bigLog = (dir, framesCount = 2000) => {
  const frames = []
  for (let i = 0; i < framesCount; i += 1) {
    const events = []
    for (let k = 0; k < 60; k += 1) {
      /** `pad` 随 i/k 变化：全用同一个字符会让 zstd 压到几 KB，全量解码反而变得比尾部还快。 */
      events.push({
        type: 'tool/call',
        seq: i * 100 + k,
        time: 1_000_000 + i * 1000 + k,
        data: { name: 'read', n: i * 1000 + k, pad: ('tool-' + i + '-' + k + '-').repeat(12) },
      })
    }
    frames.push(frame(events))
  }
  frames.push(frame([user(9_000_000, 'hi'), assistant(9_001_000, 'deepseek-official', 'deepseek-flash', usageOf(50))]))
  return logOf(dir, frames)
}

test('⑥ 尾部读成本不随文件大小线性增长（抓「窗口不自适应 = 读整个文件」这个变异）', (t) => {
  const dirs = []
  try {
    const measure = (prefix, framesCount) => {
      let best = Number.POSITIVE_INFINITY
      /** 两次取小，且每次都用**新目录新文件**：同一路径第二次会命中 `TAIL_FACTS_CACHE`。 */
      for (let i = 0; i < 2; i += 1) {
        const dir = tmproot(prefix + i)
        dirs.push(dir)
        const f = bigLog(dir, framesCount)
        const t0 = Date.now()
        readSessionModel(f)
        best = Math.min(best, Date.now() - t0)
      }
      return best
    }
    const small = measure('tail-size-s', 2000)
    const huge = measure('tail-size-h', 16000)
    /**
     * 自适应窗口（从 256KB 起）→ 8 倍大的文件耗时**几乎相同**（差值只剩噪声）；
     * 「一次读全文件」的变异 → 多读 8 倍字节，差值随体积线性增长（实测 30ms+）。
     * 用**差值**而不是倍数：自适应时两个值都接近常数（1~3ms），倍数是噪声放大器。
     */
    assert.ok(huge - small < 12,
      '尾部读随文件变大而变慢：小=' + small + 'ms 大(8x)=' + huge + 'ms（说明窗口没有自适应，读了更多字节）')
    console.log('  ⑥ 实测：小文件(5MB)=' + small + 'ms 大文件(40MB)=' + huge + 'ms')
  } finally {
    for (const d of dirs) tmpremove(d)
  }
})

test('④ 大文件（≥5MB、多帧）尾部命中 → 不触发全量解压（**选耗时判据**；ESM 无法给 readRounds 打桩）', (t) => {
  const dirs = []
  try {
    let tailMs = Number.POSITIVE_INFINITY
    let fullMs = Number.POSITIVE_INFINITY
    /** 取 3 次最小值：并发负载下单次抖动可达数倍，最小值才代表真实成本。 */
    for (let i = 0; i < 3; i += 1) {
      const dir = tmproot('tail-big' + i)
      dirs.push(dir)
      const f = bigLog(dir)
      const t0 = Date.now()
      const m = readSessionModel(f)
      const t1 = Date.now()
      const r = readRounds(f)
      const t2 = Date.now()
      assert.deepEqual(m, { provider: 'deepseek-official', model: 'deepseek-flash' }, '大文件尾部也要命中')
      assert.ok(r.length > 0, '全量解码应当能拿到 usage')
      tailMs = Math.min(tailMs, t1 - t0)
      fullMs = Math.min(fullMs, t2 - t1)
    }
    assert.ok(tailMs < 200, '尾部读不得慢于 200ms（实际 ' + tailMs + 'ms）')
    console.log('  ④ 实测：tail=' + tailMs + 'ms full=' + fullMs + 'ms 比值=' + (fullMs / tailMs).toFixed(1) + 'x')
    if (fullMs < 40) {
      t.skip('全量解码只用了 ' + fullMs + 'ms，判据无区分力（机器太快或样本太小）')
      return
    }
    assert.ok(tailMs * 2 < fullMs,
      '尾部读没有明显快于全量解码：tail=' + tailMs + 'ms full=' + fullMs + 'ms（说明走了全量）')
  } finally {
    for (const d of dirs) tmpremove(d)
  }
})

test('⑤ readRoundsCached 与 readRounds 同数据，且第二次命中缓存', () => {
  const dir = tmproot('tail-e')
  try {
    const events = [user(1000, 'hi')]
    for (let i = 0; i < 5; i += 1) events.push(assistant(2000 + i, 'p' + i, 'm' + i, usageOf(10 + i)))
    const f = logOf(dir, [frame(events)])
    const direct = readRounds(f)
    const first = readRoundsCachedWithText(f)
    assert.equal(JSON.stringify(first.rounds), JSON.stringify(direct), '缓存版与直读版数据必须逐字节相同')
    assert.ok(first.text !== undefined, '首次未命中应当把解压后的 text 交回来（供 marks 复用）')
    assert.equal(JSON.stringify(readRoundsCached(f)), JSON.stringify(direct))
    const second = readRoundsCachedWithText(f)
    assert.equal(JSON.stringify(second.rounds), JSON.stringify(direct))
    assert.equal(second.text, undefined, '第二次命中缓存 → 不再解压，也就没有 text')
  } finally { tmpremove(dir) }
})
