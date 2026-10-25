/**
 * 前缀改写原因探测（core/rewrite-probe.ts）+ 面板文案（panel.ts 的 markBits/fmtTok/dropReason）。
 *
 * 探针部分是纯函数，直接 import 测；
 * 文案部分是 PANEL_HTML 内联 script 的顶层函数，从源码文本抽出后在最小沙箱里跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { probeMark, toolFaceAt, droppedTypesOf } from '../src/core/rewrite-probe.ts'

const here = dirname(fileURLToPath(import.meta.url))
const PANEL = join(here, '..', 'src', 'panel.ts')
const SRC = readFileSync(PANEL, 'utf8')

function extractSrc(name) {
  const anchor = 'function ' + name + '('
  const at = SRC.indexOf(anchor)
  assert.ok(at >= 0, name + ' 不在 panel.ts 里')
  let depth = 0, end = -1
  for (let j = SRC.indexOf('{', at); j < SRC.length; j++) {
    const ch = SRC[j]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) { end = j + 1; break } }
  }
  assert.ok(end > 0, name + ' 括号不配平')
  return SRC.slice(at, end)
}

/* ── 造事件的小工具（形状对齐真实日志） ─────────────────────── */
const tool = (name, desc) => ({ name, description: desc, parameters: { type: 'object' } })
const hdr = (seq, tools) => ({ type: 'request/header', seq, data: { header: { config: {}, adapterDefaults: {}, tools } } })
const prune = (seq, seqs, tok) => ({ type: 'compaction/prune', seq, data: { shadowedSeqs: seqs, shadowedTokenCount: tok } })
const summary = (seq, seqs, tok) => ({ type: 'compaction/summary', seq, data: { shadowedSeqs: seqs, shadowedTokenCount: tok } })

const TOOLS = [tool('a', 'x'), tool('b', 'y')]

test('P1 droppedTypes：shadowedSeqs 反查 type 分布', () => {
  const evs = [
    hdr(1, TOOLS),
    { type: 'tool/result', seq: 20, data: {} },
    { type: 'user/message', seq: 21, data: {} },
    { type: 'tool/result', seq: 22, data: {} },
    prune(30, [20, 22], 4129),
    hdr(40, TOOLS),
  ]
  assert.deepEqual(droppedTypesOf(evs, [20, 22]), { 'tool/result': 2 })
  assert.deepEqual(probeMark(evs, 4).droppedTypes, { 'tool/result': 2 })
})

test('P2 toolFace：前后 header 完整相同 → same', () => {
  const evs = [hdr(1, TOOLS), prune(30, [], 1), hdr(40, TOOLS)]
  assert.equal(toolFaceAt(evs, 1), 'same')
})

test('P3 toolFace：只有 description 变 → def-changed', () => {
  const evs = [hdr(1, TOOLS), prune(30, [], 1), hdr(40, [tool('a', 'CHANGED'), tool('b', 'y')])]
  assert.equal(toolFaceAt(evs, 1), 'def-changed')
})

test('P4 toolFace：增删工具 → toolset-changed', () => {
  const del = [hdr(1, TOOLS), prune(30, [], 1), hdr(40, [tool('a', 'x')])]
  assert.equal(toolFaceAt(del, 1), 'toolset-changed')
  const add = [hdr(1, TOOLS), prune(30, [], 1), hdr(40, TOOLS.concat([tool('c', 'z')]))]
  assert.equal(toolFaceAt(add, 1), 'toolset-changed')
})

test('P5 toolFace：改写后没有 header → unknown（剪后还没发过请求）', () => {
  const evs = [hdr(1, TOOLS), prune(30, [], 1)]
  assert.equal(toolFaceAt(evs, 1), 'unknown')
  const none = [prune(30, [], 1), hdr(40, TOOLS)]
  assert.equal(toolFaceAt(none, 0), 'unknown', '前面没有 header 也判 unknown')
})

test('P6 probeMark：summary 也做工具面检测 + 字段齐全', () => {
  const evs = [
    hdr(1, TOOLS),
    { type: 'tool/result', seq: 20, data: {} },
    summary(30, [20], 299611),
    hdr(40, [tool('a', 'x'), tool('b', 'CHANGED')]),
  ]
  const p = probeMark(evs, 2)
  assert.equal(p.sub, 'summary')
  assert.equal(p.shadowedCount, 1)
  assert.equal(p.shadowedTokens, 299611)
  assert.deepEqual(p.droppedTypes, { 'tool/result': 1 })
  assert.equal(p.toolFace, 'def-changed')
})

test('P7 probeMark：goal 不判工具面（header 里没有 system，永远只能写「可能」）', () => {
  const p = probeMark([{ type: 'goal/change', seq: 5, data: { operation: 'complete' } }], 0)
  assert.equal(p.sub, 'goal')
  assert.equal(p.toolFace, undefined)
  assert.equal(p.droppedTypes, undefined)
})

/* ── 面板文案函数（从内联 script 抽出） ─────────────────────── */
const sandbox = vm.runInNewContext(
  extractSrc('fmtTok') + '\n' + extractSrc('dropReason') + '\n' + extractSrc('markBits') + '\n'
  + 'var FACE_TXT = { same: "工具面未变", "def-changed": "工具定义变了", "toolset-changed": "工具增删", unknown: "工具面未确认" };\n'
  + '({ fmtTok: fmtTok, dropReason: dropReason, markBits: markBits })'
)

test('P8 fmtTok：4129 → 4.1k；299611 → 299.6k；小于 1000 原样', () => {
  assert.equal(sandbox.fmtTok(4129), '4.1k')
  assert.equal(sandbox.fmtTok(299611), '299.6k')
  assert.equal(sandbox.fmtTok(999), '999')
  assert.equal(sandbox.fmtTok(0), '0')
  assert.equal(sandbox.fmtTok(1000), '1.0k')
})

test('P9 dropReason：tool/result 占多数 → 剪掉工具输出；否则历史对话', () => {
  assert.equal(sandbox.dropReason({ 'tool/result': 1 }), '剪掉工具输出')
  assert.equal(sandbox.dropReason({ 'tool/result': 3, 'user/message': 1 }), '剪掉工具输出')
  assert.equal(sandbox.dropReason({ 'user/message': 2, 'tool/result': 1 }), '剪掉历史对话')
  assert.equal(sandbox.dropReason({}), '剪掉历史对话')
})

test('P10 markBits 六种组合的右侧文案', () => {
  const S = (o) => sandbox.markBits(o).join(' · ')
  assert.equal(S({ sub: 'summary', shadowedTokens: 299611, toolFace: 'same' }),
    '299.6k tok · 历史摘要化 · 工具面未变 · 之后没有真实请求就不保')
  assert.equal(S({ sub: 'prune', shadowedTokens: 4129, toolFace: 'same', droppedTypes: { 'tool/result': 1 } }),
    '4.1k tok · 剪掉工具输出 · 工具面未变 · 之后没有真实请求就不保')
  assert.equal(S({ sub: 'prune', shadowedTokens: 4129, toolFace: 'def-changed', droppedTypes: { 'tool/result': 1 } }),
    '4.1k tok · 剪掉工具输出 · 工具定义变了 · 之后没有真实请求就不保')
  assert.equal(S({ sub: 'prune', shadowedTokens: 4100, toolFace: 'toolset-changed', droppedTypes: { 'user/message': 2 } }),
    '4.1k tok · 剪掉历史对话 · 工具增删 · 之后没有真实请求就不保')
  assert.equal(S({ sub: 'prune', shadowedTokens: 4129, toolFace: 'unknown', droppedTypes: { 'tool/result': 1 } }),
    '4.1k tok · 剪掉工具输出 · 工具面未确认 · 之后没有真实请求就不保')
  assert.equal(S({ sub: 'goal' }), '系统提示词可能被改写 · 之后没有真实请求就不保')
})

test('P11 时间轴左侧徽标不再带 token（token 挪到右侧）', () => {
  const sessions = readFileSync(join(here, '..', 'src', 'core', 'sessions.ts'), 'utf8')
  const at = sessions.indexOf('export function readMarks(')
  assert.ok(at > 0)
  const body = sessions.slice(at, sessions.indexOf('export interface RoundUsage', at))
  assert.ok(/压缩/.test(body) && /剪枝/.test(body), '徽标要区分压缩/剪枝')
  assert.ok(/个事件'/.test(body), '徽标必须是「… N 个事件」结尾')
  assert.equal(/个事件（/.test(body), false, '不许再拼「（N tok）」到徽标里')
  assert.equal(/tokens .= undefined \? '' : '（' \+ /.test(body), false, '旧的长拼法必须删掉')
})
