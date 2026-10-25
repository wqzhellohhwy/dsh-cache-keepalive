import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeSessionMetaIfChanged, readSessionMeta } from '../src/core/session-meta.ts'
import { tmproot, tmpremove } from './_tmp.js'

/** 造一条最小 SessionRow */
const row = (id, title, mtime = 1000, sizeBytes = 500) => ({
  id,
  mtime,
  title,
  titleSource: 'user',
  archived: false,
  origin: '',
  projectKey: 'proj',
  dir: '/x/sessions/' + id,
  sizeBytes,
  logFile: '/x/' + id + '/session.v4.jsonl.zstd',
})

const projFile = (home, id) => join(home, 'storages', 'session_projcache', 'sessions', 'session-' + id + '.json')
const writeProj = (home, id, val) => {
  mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  writeFileSync(projFile(home, id), JSON.stringify({
    version: 7,
    record: { rows: { title: { ver: 1, seq: 3, val } } },
  }), 'utf8')
}
const metaFile = (home) => join(home, 'cache-keepalive', 'sessions.meta.json')

test('标题变化：投影缓存改了标题 → meta 里的 title 跟着变', () => {
  const home = tmproot('meta-title')
  try {
    const rows = [row('a1', '日志里的旧标题')]
    writeProj(home, 'a1', '投影里的新标题')
    writeSessionMetaIfChanged(home, rows, 100_000, undefined, (r) => '投影里的新标题')
    const m = readSessionMeta(home, 100_000, Number.POSITIVE_INFINITY)
    assert.equal(m.items.a1.title, '投影里的新标题')
    assert.equal(m.items.a1.titleSource, 'provider')
  } finally { tmpremove(home) }
})

test('标题变化：改投影文件后（mtime/size 不变的日志）meta 能刷新', () => {
  const home = tmproot('meta-title2')
  try {
    /** 第一次：投影是「旧标题」 */
    const rows = [row('b1', '日志标题')]
    writeSessionMetaIfChanged(home, rows, 100_000, undefined, () => '投影旧标题')
    let m = readSessionMeta(home, 100_000, Number.POSITIVE_INFINITY)
    assert.equal(m.items.b1.title, '投影旧标题')

    /** 第二次：投影改成「新标题」，但**日志行的 mtime/size 完全没变** */
    writeSessionMetaIfChanged(home, rows, 100_500, undefined, () => '投影新标题')
    m = readSessionMeta(home, 100_500, Number.POSITIVE_INFINITY)
    assert.equal(m.items.b1.title, '投影新标题', '文件没变但标题变了 → 必须刷新')
  } finally { tmpremove(home) }
})

test('标题没变：两次 tick 之间 meta 文件 mtime 不变（不频繁重写）', async () => {
  const home = tmproot('meta-stable')
  try {
    const rows = [row('c1', '日志标题')]
    writeSessionMetaIfChanged(home, rows, 100_000, undefined, () => '稳定标题')
    const t1 = statSync(metaFile(home)).mtimeMs
    await new Promise((r) => setTimeout(r, 30))
    /** TOUCH_INTERVAL_MS 内、标题没变 → 不该写盘 */
    const wrote = writeSessionMetaIfChanged(home, rows, 100_000 + 1000, undefined, () => '稳定标题')
    const t2 = statSync(metaFile(home)).mtimeMs
    assert.equal(wrote, false, '标题没变 + sig 没变 + 未到 TOUCH 间隔 → 不写')
    assert.equal(t2, t1, 'meta 的 mtime 不该变')
  } finally { tmpremove(home) }
})

test('投影读不到（undefined）：回落到行里的标题，行为与以前一致', () => {
  const home = tmproot('meta-noproj')
  try {
    const rows = [row('d1', '只有日志标题')]
    writeSessionMetaIfChanged(home, rows, 100_000, undefined, () => undefined)
    const m = readSessionMeta(home, 100_000, Number.POSITIVE_INFINITY)
    assert.equal(m.items.d1.title, '只有日志标题')
    assert.equal(m.items.d1.titleSource, 'user')
  } finally { tmpremove(home) }
})

test('lastDialogAt 复用没退化：文件没变 + 已有值 → 不调用 computeLastDialog', () => {
  const home = tmproot('meta-reuse')
  try {
    const rows = [row('e1', '标题', 2000, 800)]
    /** 第一次：算一次 */
    let calls = 0
    writeSessionMetaIfChanged(home, rows, 100_000, () => { calls += 1; return 12345 }, () => '稳定')
    assert.equal(calls, 1)
    /** 第二次：文件没变、旧条目已有 lastDialogAt → 不该再算 */
    calls = 0
    writeSessionMetaIfChanged(home, rows, 100_600, () => { calls += 1; return 12345 }, () => '稳定')
    assert.equal(calls, 0, '文件没变 → lastDialogAt 复用，不解帧')
    const m = readSessionMeta(home, 100_600, Number.POSITIVE_INFINITY)
    assert.equal(m.items.e1.lastDialogAt, 12345)
  } finally { tmpremove(home) }
})

test('标题变了但文件没变：lastDialogAt 仍然复用（不连带解帧）', () => {
  const home = tmproot('meta-title-only')
  try {
    const rows = [row('f1', '标题', 3000, 900)]
    writeSessionMetaIfChanged(home, rows, 100_000, () => 777, () => '旧标题')
    let calls = 0
    /** 标题变了 → 要重写，但 lastDialogAt 不该重算 */
    writeSessionMetaIfChanged(home, rows, 100_500, () => { calls += 1; return 999 }, () => '新标题')
    assert.equal(calls, 0, '标题变化不应触发 lastDialogAt 重算')
    const m = readSessionMeta(home, 100_500, Number.POSITIVE_INFINITY)
    assert.equal(m.items.f1.title, '新标题')
    assert.equal(m.items.f1.lastDialogAt, 777)
  } finally { tmpremove(home) }
})
