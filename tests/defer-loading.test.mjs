/**
 * **`defer_loading` 必须与 DSH 一致**：会话中途新增的工具（插件注册的）要带这个标记。
 *
 * 依据：`dsh-llm/lib/types/content.js:252-279` 的 `toolDeclarations()`
 * ```js
 * const declarations = new Map(history.tools.map(tool => [tool.name, tool]))   // 基线原样
 * for (const update of history.updates)
 *   for (const tool of update.additions)
 *     if (!declarations.has(tool.name))
 *       declarations.set(tool.name, { ...tool, deferLoading: true })           // ← 后来新增的
 * ```
 * 发出去就是 `defer_loading: true`（每条多 21 字节）。
 *
 * 实测代价：会话 `ba6eb37a` 插件发的 body tools 段 69,415 字符、离线只 68,491
 * （差 44 × 21 = 924）→ **缓存前缀从第一条新增工具（tools[40]）起断开**，
 * 命中止于 11,008 / 713,796 = 1.54%，并被熔断拉黑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wireToolsOf } from '../src/core/assemble.ts'
import { serializeForApi } from '../src/core/wire.ts'

const base = (name) => ({ name, description: name + ' 内置', parameters: { type: 'object', properties: {} } })
const extra = (name) => ({ name, description: name + ' 插件', parameters: { type: 'object', properties: {} } })

const hist = {
  tools: [base('read'), base('write')],
  updates: [{ messageId: 'm1', additions: [extra('dev_inject_plugin'), extra('tmpprofile_run')] }],
}

test('wireToolsOf：后来新增的工具带 deferLoading，基线工具不带', () => {
  const list = wireToolsOf(hist)
  assert.equal(list.length, 4)
  const byName = new Map(list.map((t) => [t.name, t]))
  assert.equal(byName.get('read').deferLoading, undefined, '基线工具不许带 deferLoading')
  assert.equal(byName.get('write').deferLoading, undefined)
  assert.equal(byName.get('dev_inject_plugin').deferLoading, true, '后来新增的必须带')
  assert.equal(byName.get('tmpprofile_run').deferLoading, true)
})

test('serializeForApi：deferLoading 变成 wire 的 defer_loading（21 字节/条）', () => {
  const body = serializeForApi([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], {
    model: 'deepseek-flash',
    maxTokens: 1,
    tools: wireToolsOf(hist),
  })
  const t = body.tools
  assert.equal(t.length, 4)
  const byName = new Map(t.map((x) => [x.name, x]))
  assert.equal(byName.get('read').defer_loading, undefined, '内置工具不许带 defer_loading')
  assert.equal(byName.get('dev_inject_plugin').defer_loading, true)
  assert.deepEqual(Object.keys(byName.get('dev_inject_plugin')).sort(),
    ['defer_loading', 'description', 'input_schema', 'name'])
  /** 每条多 `,"defer_loading":true` = 21 字节（与实测 924 / 44 一致） */
  const withDefer = body.tools.find((x) => x.name === 'dev_inject_plugin')
  const { defer_loading: _drop, ...rest } = withDefer
  assert.equal(JSON.stringify(withDefer).length - JSON.stringify(rest).length, 21, '多出的字节数必须正好是 21')
})

test('同名工具重复出现时保持先出现的为准（基线优先，不重复标 deferLoading）', () => {
  const dup = {
    tools: [base('read')],
    updates: [{ messageId: 'm1', additions: [extra('read')] }],
  }
  const list = wireToolsOf(dup)
  assert.equal(list.length, 1, '同名不许出现两次')
  assert.equal(list[0].deferLoading, undefined, '基线里已有的工具不算「后来新增」')
})
