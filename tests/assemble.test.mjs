/**
 * 离线装配链路的单元测试（**不联网、不读磁盘、不花钱**）。
 *
 * 覆盖三块：
 *  - `core/surface.ts`：surface 折叠（append / replace / 校验）、请求头规范化、消息推导
 *  - `core/assemble.ts`：tool_use 配对修复、wire 工具声明、图片安全阀
 *  - `core/wire.ts` 里能被纯函数验证的部分由 `check-cli-assemble.mjs` 全库覆盖
 *
 * 跑法：`node tests/assemble.test.mjs`
 */
import {
  PROJECTION_REQUIRED_TYPES,
  deriveEventMessage,
  foldRequestHeader,
  foldSurface,
  isReplaceOp,
  messagesOf,
} from '../src/core/surface.ts'
import { refuseForImages, repairUnclosedToolUse, wireToolsOf } from '../src/core/assemble.ts'

const cases = []

/** 造一个 surface 事件。 */
const ev = (seq, type, extra = {}) => ({ seq, type, ...extra })
/** 造一条消息事件（append）。 */
const msg = (seq, type, text, extra = {}) => ({
  seq,
  type,
  surfaceOp: 'append',
  data: type === 'user/message'
    ? { role: 'user', content: [{ type: 'text', text }] }
    : { message: { role: type.replace('/message', ''), content: [{ type: 'text', text }] } },
  ...extra,
})
/** 造一个 replace 事件。 */
const replace = (seq, type, startSeq, endSeq, text) => ({
  seq,
  type,
  surfaceOp: { op: 'replace', startSeq, endSeq },
  data: type === 'user/message'
    ? { role: 'user', content: [{ type: 'text', text }] }
    : { message: { role: type.replace('/message', ''), content: [{ type: 'text', text }] } },
})

// ── surface 折叠 ──────────────────────────────────────────────
cases.push(['append 按顺序进节点', () => {
  const s = foldSurface([
    msg(0, 'system/message', 'sys'),
    msg(1, 'user/message', 'hi'),
    msg(2, 'assistant/message', 'yo'),
  ])
  return JSON.stringify(s.nodes) === '[0,1,2]' && s.replacements === 0
}])

cases.push(['非 surface 类型不进节点', () => {
  const s = foldSurface([
    msg(0, 'user/message', 'hi'),
    ev(1, 'tool/call', { data: {} }),
    ev(2, 'step/start', { data: {} }),
    msg(3, 'assistant/message', 'yo'),
  ])
  return JSON.stringify(s.nodes) === '[0,3]'
}])

cases.push(['replace 用 splice 换掉整段', () => {
  const s = foldSurface([
    msg(0, 'system/message', 'sys'),
    msg(1, 'user/message', 'a'),
    msg(2, 'assistant/message', 'b'),
    msg(3, 'user/message', 'c'),
    replace(4, 'user/message', 1, 2, 'summary'),
    msg(5, 'assistant/message', 'd'),
  ])
  // 1、2 被 4 替换掉：节点变成 0,4,3,5
  return JSON.stringify(s.nodes) === '[0,4,3,5]' && s.replacements === 1
}])

cases.push(['replace 单点（压缩后的 tool_result 改写）', () => {
  const s = foldSurface([
    msg(0, 'user/message', 'a'),
    msg(1, 'tool/result', 'big'),
    replace(2, 'tool/result', 1, 1, 'small'),
  ])
  return JSON.stringify(s.nodes) === '[0,2]'
}])

cases.push(['replace 范围不存在 → 严格模式抛错', () => {
  try {
    foldSurface([msg(0, 'user/message', 'a'), replace(1, 'user/message', 5, 9, 'x')])
    return false
  } catch (e) {
    return String(e.message).includes('不在当前 surface')
  }
}])

cases.push(['seq 不连续 → 严格模式抛错（指向「混入无 seq 事件」）', () => {
  try {
    foldSurface([msg(0, 'user/message', 'a'), msg(2, 'user/message', 'b')])
    return false
  } catch (e) {
    return String(e.message).includes('seq 不连续')
  }
}])

cases.push(['surface 类型缺 surfaceOp → 抛错', () => {
  try {
    foldSurface([{ seq: 0, type: 'user/message', data: {} }])
    return false
  } catch (e) {
    return String(e.message).includes('缺 surfaceOp')
  }
}])

cases.push(['image/offload → 明确抛错（不静默出错）', () => {
  if (!PROJECTION_REQUIRED_TYPES.has('image/offload')) return false
  try {
    foldSurface([{ seq: 0, type: 'image/offload', surfaceOp: 'append', data: {} }])
    return false
  } catch (e) {
    return String(e.message).includes('投影器')
  }
}])

cases.push(['宽松模式跳过异常事件继续折', () => {
  const s = foldSurface([
    msg(0, 'user/message', 'a'),
    { seq: 1, type: 'user/message', data: {} },      // 缺 surfaceOp
    msg(2, 'assistant/message', 'b'),
  ], { strict: false })
  return JSON.stringify(s.nodes) === '[0,2]'
}])

cases.push(['baseSeq 支持日志窗口（seq 不从 0 起）', () => {
  const s = foldSurface([
    { ...msg(100, 'user/message', 'a') },
    { ...msg(101, 'assistant/message', 'b') },
  ], { baseSeq: 100 })
  return JSON.stringify(s.nodes) === '[100,101]'
}])

// ── 请求头 ────────────────────────────────────────────────────
cases.push(['foldRequestHeader：取最后一个 + 空 tools 视为无', () => {
  const h = foldRequestHeader([
    { seq: 0, type: 'request/header', data: { header: { config: { model: 'a' }, tools: [{ name: 'x' }] } } },
    { seq: 1, type: 'request/header', data: { header: { config: { model: 'b' }, tools: [] } } },
  ])
  return h.config.model === 'b' && h.tools === undefined
}])

cases.push(['foldRequestHeader：adapterDefaults 在任一为 true 时整份保留（同官方 canonicalHeader）', () => {
  const h = foldRequestHeader([
    { seq: 0, type: 'request/header', data: { header: { config: {}, adapterDefaults: { reasoningEffort: false, maxTokens: true } } } },
  ])
  // 官方保留的是**整个对象**，不是只保留为 true 的字段
  return h.adapterDefaults.maxTokens === true && h.adapterDefaults.reasoningEffort === false
}])

cases.push(['foldRequestHeader：adapterDefaults 全不为 true 时整份丢掉', () => {
  const h = foldRequestHeader([
    { seq: 0, type: 'request/header', data: { header: { config: {}, adapterDefaults: { reasoningEffort: false } } } },
  ])
  return h.adapterDefaults === undefined
}])

cases.push(['foldRequestHeader：没有 header 事件 → undefined', () => {
  return foldRequestHeader([msg(0, 'user/message', 'a')]) === undefined
}])

// ── 消息推导 ──────────────────────────────────────────────────
cases.push(['deriveEventMessage：user/message 直返 data', () => {
  const m = deriveEventMessage({ seq: 0, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'a' }] } })
  return m.role === 'user'
}])

cases.push(['deriveEventMessage：空 content 的 assistant 丢弃', () => {
  const m = deriveEventMessage({ seq: 0, type: 'assistant/message', data: { message: { role: 'assistant', content: [] } } })
  return m === null
}])

cases.push(['deriveEventMessage：非消息事件返回 null', () => {
  return deriveEventMessage({ seq: 0, type: 'step/start', data: {} }) === null
}])

cases.push(['messagesOf：节点 → 消息，顺序与 nodes 一致', () => {
  const { messages } = messagesOf([
    msg(0, 'system/message', 'sys'),
    msg(1, 'user/message', 'hi'),
    ev(2, 'step/start', { data: {} }),
    msg(3, 'assistant/message', 'yo'),
  ])
  return messages.length === 3
    && messages[0].role === 'system' && messages[1].role === 'user' && messages[2].role === 'assistant'
}])

// ── tool_use 配对修复 ─────────────────────────────────────────
cases.push(['repairUnclosedToolUse：删掉没有结果的 tool-call', () => {
  const r = repairUnclosedToolUse([
    { role: 'assistant', content: [
      { type: 'text', text: 'ok' },
      { type: 'tool-call', id: 'a' },
      { type: 'tool-call', id: 'b' },
    ] },
    { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'r' }] },
  ])
  return r.removed === 1
    && r.messages[0].content.length === 2
    && r.messages[0].content.filter((b) => b.type === 'tool-call').length === 1
}])

cases.push(['repairUnclosedToolUse：全无结果 → 整条消息丢弃', () => {
  const r = repairUnclosedToolUse([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'a' }] },
    { role: 'user', content: [{ type: 'text', text: 'x' }] },
  ])
  return r.removed === 1 && r.messages.length === 1 && r.messages[0].role === 'user'
}])

cases.push(['repairUnclosedToolUse：配对完整 → 不动', () => {
  const input = [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'a' }] },
    { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'r' }] },
  ]
  const r = repairUnclosedToolUse(input)
  return r.removed === 0 && r.messages.length === 2
}])

// ── wire 工具声明 ─────────────────────────────────────────────
cases.push(['wireToolsOf：基线 + 尚未进基线的新工具', () => {
  const tools = wireToolsOf({
    tools: [{ name: 'a' }, { name: 'b' }],
    updates: [{ messageId: 'm1', additions: [{ name: 'c' }] }],
  })
  return tools.map((t) => t.name).join(',') === 'a,b,c'
}])

cases.push(['wireToolsOf：同名不重复（先出现的为准）', () => {
  const tools = wireToolsOf({
    tools: [{ name: 'a', description: 'orig' }],
    updates: [{ messageId: 'm1', additions: [{ name: 'a', description: 'dup' }] }],
  })
  return tools.length === 1 && tools[0].description === 'orig'
}])

// ── 图片安全阀 ────────────────────────────────────────────────
cases.push(['refuseForImages：靠前图片 → 拒绝（阈值 90%）', () => {
  return refuseForImages({ imageBlocks: 1, firstImageAt: 0.15 }) === true
    && refuseForImages({ imageBlocks: 2, firstImageAt: 0 }) === true
    // 实测踩过的：41% 处的图片只换来 30.7% 命中、花 0.21 元 → 现在也拒绝
    && refuseForImages({ imageBlocks: 3, firstImageAt: 0.41 }) === true
    && refuseForImages({ imageBlocks: 1, firstImageAt: 0.89 }) === true
}])

cases.push(['refuseForImages：只在最后 10% 才放行', () => {
  return refuseForImages({ imageBlocks: 1, firstImageAt: 0.9 }) === false
    && refuseForImages({ imageBlocks: 1, firstImageAt: 0.95 }) === false
    && refuseForImages({ imageBlocks: 1, firstImageAt: 1 }) === false
}])

cases.push(['refuseForImages：无图片 → 放行', () => {
  return refuseForImages({ imageBlocks: 0, firstImageAt: -1 }) === false
}])

cases.push(['refuseForImages：--force 覆盖', () => {
  return refuseForImages({ imageBlocks: 1, firstImageAt: 0.1 }, true) === false
}])

cases.push(['isReplaceOp 形状校验', () => {
  return isReplaceOp({ op: 'replace', startSeq: 1, endSeq: 2 }) === true
    && isReplaceOp({ op: 'replace', startSeq: 2, endSeq: 1 }) === true   // 倒序由折叠时报错
    && isReplaceOp({ op: 'append' }) === false
    && isReplaceOp({ op: 'replace', startSeq: -1, endSeq: 2 }) === false
    && isReplaceOp(null) === false
}])

let pass = 0
let fail = 0
const lines = []
for (const [name, fn] of cases) {
  let ok = false
  let err = ''
  try {
    ok = fn() === true
  } catch (e) {
    err = ' 抛错: ' + (e && e.message ? e.message : String(e))
  }
  if (ok) pass++
  else fail++
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : err}`)
}

console.log('=== 离线装配链路测试 ===')
console.log(lines.join('\n'))
console.log('')
console.log(`通过 ${pass} / ${cases.length}` + (fail > 0 ? `   ❌ 失败 ${fail}` : '   ✅ 全绿'))
process.exit(fail > 0 ? 1 : 0)
