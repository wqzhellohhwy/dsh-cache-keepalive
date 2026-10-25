/**
 * 面板「最后一条对话时间」的实现细节：**`now()` 注入必须真的生效**。
 *
 * 端到端结果由 `scripts/check-activity-freshness.mjs` 守；这里只守一条端到端测试看不见、
 * 但错误代价很隐蔽的事：`readSessionMeta()` 的 `now` 参数漏传（写成 `readSessionMeta(home)`）
 * 时会用真实 `Date.now()`，注入的虚拟时钟对它完全无效 —— 过期判定从「过期」翻成
 * 「未过期」（算出负年龄），**测试仍然可能是绿的**，而生产上过了 5 分钟就开始犯老毛病。
 *
 * 构造：虚拟时钟固定在过去，meta 按这个时钟算过期 / 新鲜各一份，看返回值跟哪一方走。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { createPanelService } from '../src/core/panel-service.ts'
import { readLastDialogAt } from '../src/core/sessions.ts'
import { tmproot, tmpremove } from './_tmp.js'

/** 虚拟时钟：**故意取一个过去的时间**，与真实 `Date.now()` 相差好几年。 */
const VNOW = 1_800_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN
const ID = 'session-detail-1'
const LOG_NAME = 'session.v4.jsonl.zstd'

/** 写一条最小会话日志（多帧 zstd，与真实文件同构）。 */
function writeLog(home, dialogAt) {
  const dir = join(home, 'sessions', 'proj-a', ID)
  mkdirSync(dir, { recursive: true })
  const text = [
    { type: 'session', seq: 0, time: dialogAt - MIN, id: ID, cwd: 'C:\\tmp', createdAt: dialogAt - MIN },
    { type: 'user/message', seq: 1, time: dialogAt },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n'
  writeFileSync(join(dir, LOG_NAME), zstdCompressSync(Buffer.from(text, 'utf8')))
  return join(dir, LOG_NAME)
}

const item = (lastDialogAt) => ({
  mtime: VNOW - 5 * MIN, title: 't', titleSource: 'user', archived: false, origin: '',
  projectKey: 'proj-a', dirName: ID, sizeBytes: 1, lastDialogAt,
})

function writeMeta(home, at, lastDialogAt) {
  const dir = join(home, 'cache-keepalive')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'sessions.meta.json'),
    JSON.stringify({ at, version: 1, sig: 'x', items: { [ID]: item(lastDialogAt) } }), 'utf8')
}

const svcOf = (home) => createPanelService({ dshHome: home, warm: async () => ({ ok: true }), now: () => VNOW })
const dialogOf = (home) => (svcOf(home).snapshot().sessions ?? []).find((r) => r.id === ID)?.lastDialogAt

test('now() 注入生效：虚拟时钟下 meta 被正确判为过期（漏传 now 会用真实时间算成负年龄）', () => {
  const home = tmproot('act-now-stale')
  try {
    /** 真实时间现在比 VNOW 晚几年：now − at 会是**负数**，`> maxAge` 永远不成立 → 永不判过期。 */
    writeLog(home, VNOW - 5 * MIN)
    writeMeta(home, VNOW - 10 * MIN, VNOW - 5 * HOUR)
    assert.equal(dialogOf(home), VNOW - 5 * MIN, '虚拟时钟下 meta 明显过期 → 必须回落日志里的真实对话时间')
  } finally { tmpremove(home) }
})

test('now() 注入生效：虚拟时钟下 meta 被正确判为新鲜 → 复用 meta 值', () => {
  const home = tmproot('act-now-fresh')
  try {
    writeLog(home, VNOW - 5 * MIN)
    writeMeta(home, VNOW, VNOW - HOUR)
    assert.equal(dialogOf(home), VNOW - HOUR, 'meta 新鲜 → 用 meta（证明不是「永远回退」）')
  } finally { tmpremove(home) }
})

test('meta 缺失时回落解帧，且与 readLastDialogAt 同值（口径一致）', () => {
  const home = tmproot('act-nometa')
  try {
    const log = writeLog(home, VNOW - 3 * MIN)
    assert.equal(dialogOf(home), readLastDialogAt(log))
  } finally { tmpremove(home) }
})

test('meta 损坏（坏 JSON）→ 回落解帧，不抛异常', () => {
  const home = tmproot('act-broken')
  try {
    const log = writeLog(home, VNOW - 7 * MIN)
    const dir = join(home, 'cache-keepalive')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'sessions.meta.json'), '{ 不是 JSON', 'utf8')
    assert.equal(dialogOf(home), readLastDialogAt(log))
  } finally { tmpremove(home) }
})
