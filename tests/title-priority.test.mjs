/**
 * **网页版标题优先级**：`rt.title` → `readProjectionTitle()` → `meta.title` → （前端显示「(无标题)」）。
 *
 * 为什么必须有（2026-10-20 实测）：插件侧 `aa0b855` 改成读 DSH 投影缓存后，**网页版漏了**，
 * 于是同一批会话在网页版显示旧标题。实测 `session-8ffa1e45…`：
 *   日志头部（旧名）：`Everything MCP 插件搜索结果核实`
 *   投影缓存（新名）：`元操控插件/工具整理/Everything mcp`
 * 全库 510 条里这类有 84 条（投影 `val=null` 的 84 条回落 meta/空串）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { tmproot, tmpremove } from './_tmp.js'

const SID = 'session-titleprio-0000-0000-0000-000000000001'
const PK = '--C-proj--'
const OLD_TITLE = '日志里的旧标题'
const NEW_TITLE = '投影里的新标题'

const projBody = (val) => `{
  "version": 7,
  "record": { "rows": { "title": { "ver": 1, "seq": 9, "val": ${val} } } }
}
`

/** 造一个最小会话（日志头能读出旧标题）+ 可选投影缓存。 */
const setup = (prefix, projection) => {
  const home = tmproot(prefix)
  const dir = join(home, 'sessions', PK, SID)
  mkdirSync(dir, { recursive: true })
  const log = [
    JSON.stringify({ type: 'session', seq: 0, time: 1, data: { id: SID, projectKey: PK } }),
    JSON.stringify({ type: 'session/title', seq: 1, time: 2, data: { title: OLD_TITLE } }),
    JSON.stringify({ type: 'request/header', seq: 0, time: 2, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } }),
    JSON.stringify({ type: 'user/message', seq: 1, time: 3, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
  ].join('\n') + '\n'
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(log, 'utf8')))
  if (projection !== undefined) {
    const pdir = join(home, 'storages', 'session_projcache', 'sessions')
    mkdirSync(pdir, { recursive: true })
    writeFileSync(join(pdir, 'session-' + SID + '.json'), projBody(projection))
  }
  return home
}

const titleOfSnapshot = async (home) => {
  const { createPanelService } = await import('../src/core/panel-service.ts')
  const svc = createPanelService({ dshHome: home, warm: async () => ({ ok: true }), loopEnabled: false })
  const snap = await svc.snapshot()
  const row = snap.sessions.find((s) => s.id === SID)
  assert.ok(row !== undefined, '没扫到会话行')
  return row.title
}

test('标题优先级：投影缓存盖过日志头里的旧标题', async () => {
  const home = setup('title-prio', JSON.stringify(NEW_TITLE))
  try {
    assert.equal(await titleOfSnapshot(home), NEW_TITLE, '没用投影缓存 → 网页版会显示旧标题')
  } finally { tmpremove(home) }
})

test('标题优先级：投影 val=null 时回落日志头标题（不显示 "null"）', async () => {
  const home = setup('title-prio-null', 'null')
  try {
    assert.equal(await titleOfSnapshot(home), OLD_TITLE)
  } finally { tmpremove(home) }
})

test('标题优先级：没有投影文件时回落日志头标题', async () => {
  const home = setup('title-prio-none', undefined)
  try {
    assert.equal(await titleOfSnapshot(home), OLD_TITLE)
  } finally { tmpremove(home) }
})
