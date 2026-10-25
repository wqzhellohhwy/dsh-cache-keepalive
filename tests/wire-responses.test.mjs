/**
 * 三种协议的序列化 + 协议判定 + usage 口径。
 *
 * 跑法：`node --test tests/wire-responses.test.mjs`
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apiKindOf, endpointPathOf } from '../src/api-kind.ts'
import { parseUsage, buildRequest } from '../src/core/warm-offline.ts'
import { serializeForApi } from '../src/core/wire.ts'
import { serializeForOpenAI } from '../src/core/wire-openai.ts'
import { serializeForResponses } from '../src/core/wire-responses.ts'

/** 同一份内部消息，三种 serialize 各吃一遍。 */
const MESSAGES = [
  { role: 'user', content: [{ type: 'text', text: '你好' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '我看看' },
      { type: 'tool-call', id: 'call_1', name: 'read', arguments: { path: 'a.txt' } },
    ],
  },
  { role: 'tool', toolCallId: 'call_1', content: [{ type: 'tool-result', id: 'call_1', text: '内容' }] },
  { role: 'user', content: [{ type: 'text', text: '继续' }] },
]
const SYSTEM = '你是助手'
const TOOLS = [{ name: 'read', description: '读文件', parameters: { type: 'object', properties: {} } }]
const OPTS = { model: 'm1', maxTokens: 1, system: SYSTEM, tools: TOOLS }

// ── Responses 序列化 ────────────────────────────────────────
test('R1： Responses 的 instructions 承载 system，且 system 不进 input', () => {
  const body = serializeForResponses(MESSAGES, OPTS)
  assert.equal(body.instructions, SYSTEM, 'system 必须在顶层 instructions')
  const input = body.input
  assert.ok(Array.isArray(input), 'input 必须是数组')
  assert.equal(input.filter((i) => i.role === 'system').length, 0, 'system 不许出现在 input 里')
})

test('R2：Responses 用 max_output_tokens，且没有 max_tokens', () => {
  const body = serializeForResponses(MESSAGES, OPTS)
  assert.equal(body.max_output_tokens, 1, '必须有 max_output_tokens')
  assert.equal(body.max_tokens, undefined, '不许有 max_tokens')
  assert.equal(body.max_completion_tokens, undefined, '不许有 max_completion_tokens')
})

test('R3：Responses 的 tools 是扁平 {type:function,name,...}，不是嵌套 function', () => {
  const body = serializeForResponses(MESSAGES, OPTS)
  const tools = body.tools
  assert.ok(Array.isArray(tools) && tools.length === 1, '应有一个工具')
  const t = tools[0]
  assert.equal(t.type, 'function')
  assert.equal(t.name, 'read', 'name 必须在顶层')
  assert.equal(t['function'], undefined, '不许有嵌套 function 对象')
  assert.deepEqual(t.parameters, { type: 'object', properties: {} })
})

test('R4：Responses 文本块用 input_text / output_text', () => {
  const body = serializeForResponses(MESSAGES, OPTS)
  const user = body.input.find((i) => i.role === 'user')
  assert.equal(user.content[0].type, 'input_text', '用户文本是 input_text')
  const asst = body.input.find((i) => i.role === 'assistant')
  assert.equal(asst.content[0].type, 'output_text', 'assistant 文本是 output_text')
})

test('R5：Responses 的工具调用与结果走 function_call / function_call_output', () => {
  const body = serializeForResponses(MESSAGES, OPTS)
  const call = body.input.find((i) => i.type === 'function_call')
  assert.equal(call.call_id, 'call_1')
  assert.equal(call.name, 'read')
  assert.equal(call.arguments, JSON.stringify({ path: 'a.txt' }), 'arguments 是 JSON 字符串')
  const out = body.input.find((i) => i.type === 'function_call_output')
  assert.equal(out.call_id, 'call_1')
  assert.equal(out.output, '内容')
})

test('R6：Responses 用 input 而不是 messages', () => {
  const body = serializeForResponses(MESSAGES, OPTS)
  assert.ok(Array.isArray(body.input), '必须有 input 数组')
  assert.equal(body.messages, undefined, '不许有 messages 键')
})

test('R7：Responses 的 reasoning 是 {effort}，且只在给了 effort 时出现', () => {
  const no = serializeForResponses(MESSAGES, OPTS)
  assert.equal(no.reasoning, undefined, '没给 effort 就不带 reasoning')
  const yes = serializeForResponses(MESSAGES, { ...OPTS, reasoningEffort: 'high' })
  assert.deepEqual(yes.reasoning, { effort: 'high' })
})

test('R8：三种 serialize 对同一份消息都能产出 body（三条协议互不干扰）', () => {
  const a = serializeForOpenAI(MESSAGES, OPTS)
  const b = serializeForResponses(MESSAGES, OPTS)
  const c = serializeForApi(MESSAGES, { ...OPTS, declaredNames: new Set(['read']) })
  assert.ok(Array.isArray(a.messages), 'completions 用 messages')
  assert.ok(Array.isArray(b.input), 'responses 用 input')
  assert.ok(Array.isArray(c.messages), 'anthropic 用 messages')
  assert.equal(a.max_tokens ?? a.max_completion_tokens, 1, 'completions 用 max_*_tokens')
  assert.equal(b.max_output_tokens, 1, 'responses 用 max_output_tokens')
  assert.equal(c.max_tokens, 1, 'anthropic 用 max_tokens')
})

test('R9：历史里的第二个 system 留在 input 原位，不并进 instructions', () => {
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'a' }] },
    { role: 'system', content: [{ type: 'text', text: '压缩快照' }] },
    { role: 'user', content: [{ type: 'text', text: 'b' }] },
  ]
  const body = serializeForResponses(msgs, { model: 'm', maxTokens: 1, system: '顶层' })
  assert.equal(body.instructions, '顶层', 'instructions 是顶层那条')
  const sys = body.input.filter((i) => i.role === 'system')
  assert.equal(sys.length, 1, '历史 system 留在 input 里')
  assert.equal(sys[0].content[0].text, '压缩快照')
})

// ── apiKindOf ──────────────────────────────────────────────
test('K1：apiHint 直中 openai-completions', () => {
  assert.equal(apiKindOf('x', 'https://a.com/v1', 'openai-completions'), 'openai-completions')
})

test('K2：apiHint 直中 openai-responses（即便 baseURL 像 anthropic）', () => {
  assert.equal(apiKindOf('x', 'https://api.anthropic.com/v1', 'openai-responses'), 'openai-responses')
})

test('K3：apiHint 直中 anthropic-messages（即便 baseURL 像 openai）', () => {
  assert.equal(apiKindOf('x', 'https://tokenrhythm.studio/v1', 'anthropic-messages'), 'anthropic-messages')
})

test('K4：baseURL 含 anthropic → anthropic-messages', () => {
  assert.equal(apiKindOf('deepseek', 'https://api.deepseek.com/anthropic'), 'anthropic-messages')
})

test('K5：/v1 + 第三方 → openai-completions', () => {
  assert.equal(apiKindOf('tokenrhythm', 'https://tokenrhythm.studio/v1', 'openai-completions'), 'openai-completions')
})

test('K6：未知（无 hint、无 anthropic、无 /v1）→ anthropic-messages 兜底', () => {
  assert.equal(apiKindOf('whatever', 'https://example.com/api'), 'anthropic-messages')
})

test('K7：别名 openai / anthropic / responses 都认', () => {
  assert.equal(apiKindOf('x', '', 'openai'), 'openai-completions')
  assert.equal(apiKindOf('x', '', 'anthropic'), 'anthropic-messages')
  assert.equal(apiKindOf('x', '', 'responses'), 'openai-responses')
})

test('K8：baseURL 含 /responses → openai-responses', () => {
  assert.equal(apiKindOf('x', 'https://a.com/v1/responses'), 'openai-responses')
})

test('K9：端点路径三种各不同', () => {
  assert.equal(endpointPathOf('openai-completions'), '/chat/completions')
  assert.equal(endpointPathOf('openai-responses'), '/responses')
  assert.equal(endpointPathOf('anthropic-messages'), '/v1/messages')
})

// ── usage 口径 ─────────────────────────────────────────────
test('U1：Anthropic usage → inputTokens 就是未命中', () => {
  const u = parseUsage({
    input_tokens: 194, cache_read_input_tokens: 207360, cache_creation_input_tokens: 0, output_tokens: 5,
  })
  assert.equal(u.inputTokens, 194, 'input_tokens 原样是未命中')
  assert.equal(u.cacheReadTokens, 207360)
  assert.equal(u.outputTokens, 5)
  assert.equal(u.cacheKnown, true)
  assert.equal(u.totalTokens, 194 + 207360 + 5)
})

test('U2：OpenAI Chat Completions usage → prompt_tokens 是总长，要减掉命中', () => {
  const u = parseUsage({
    prompt_tokens: 1000, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 900 },
  })
  assert.equal(u.cacheReadTokens, 900, '命中来自 prompt_tokens_details.cached_tokens')
  assert.equal(u.inputTokens, 100, '未命中 = 1000 - 900')
  assert.equal(u.outputTokens, 7)
  assert.equal(u.cacheKnown, true)
})

test('U3：OpenAI Responses usage → input_tokens 是总长，命中在 input_tokens_details', () => {
  const u = parseUsage({
    input_tokens: 5000, output_tokens: 12, input_tokens_details: { cached_tokens: 4600 },
  })
  assert.equal(u.cacheReadTokens, 4600, '命中来自 input_tokens_details.cached_tokens')
  assert.equal(u.inputTokens, 400, '未命中 = 5000 - 4600')
  assert.equal(u.outputTokens, 12, 'output_tokens 三协议同名')
  assert.equal(u.cacheKnown, true)
  assert.equal(u.totalTokens, 400 + 4600 + 12)
})

test('U4：三种协议映射到同一口径（同一份等价数据结果相同）', () => {
  const anthropic = parseUsage({
    input_tokens: 400, cache_read_input_tokens: 4600, cache_creation_input_tokens: 0, output_tokens: 12,
  })
  const chat = parseUsage({
    prompt_tokens: 5000, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 4600 },
  })
  const resp = parseUsage({ input_tokens: 5000, output_tokens: 12, input_tokens_details: { cached_tokens: 4600 } })
  for (const [name, u] of [['chat', chat], ['resp', resp]]) {
    assert.equal(u.inputTokens, anthropic.inputTokens, `${name} 的未命中应与 anthropic 一致`)
    assert.equal(u.cacheReadTokens, anthropic.cacheReadTokens, `${name} 的命中应与 anthropic 一致`)
    assert.equal(u.outputTokens, anthropic.outputTokens, `${name} 的输出应与 anthropic 一致`)
    assert.equal(u.totalTokens, anthropic.totalTokens, `${name} 的总量与 anthropic 一致`)
  }
})

test('U5：没有缓存字段时 cacheKnown=false（不能谎报命中率）', () => {
  const u = parseUsage({ prompt_tokens: 100, completion_tokens: 3 })
  assert.equal(u.cacheKnown, false)
  assert.equal(u.cacheReadTokens, 0)
  assert.equal(u.inputTokens, 100)
})

test('U6：usage 为空/undefined 时全是 0，不抛', () => {
  for (const raw of [undefined, {}, { input_tokens: 'x' }]) {
    const u = parseUsage(raw)
    assert.equal(u.inputTokens, 0)
    assert.equal(u.outputTokens, 0)
    assert.equal(u.cacheReadTokens, 0)
  }
})

// ── buildRequest：三分支的 URL / header / body（桩，零真实请求）──
const SHAPE = { instructionRole: 'system', maxTokensField: 'max_tokens' }
const BASE = {
  messages: MESSAGES,
  model: 'm1',
  system: SYSTEM,
  tools: TOOLS,
  maxTokens: 1,
  wireShape: SHAPE,
  baseURL: 'https://gw.example.com/v1/',
  apiKey: 'sk-test',
}

test('B1：openai-completions → /chat/completions + Bearer 鉴权', () => {
  const r = buildRequest('openai-completions', BASE)
  assert.equal(r.url, 'https://gw.example.com/v1/chat/completions', '末尾斜杠要去掉后拼路径')
  assert.equal(r.headers.authorization, 'Bearer sk-test')
  assert.equal(r.headers['x-api-key'], undefined, 'completions 不用 x-api-key')
  assert.equal(r.headers['anthropic-version'], undefined)
  const body = JSON.parse(r.body)
  assert.equal(body.stream, false, '非流式')
  assert.equal(body.stream_options, undefined, '非流式要删掉 stream_options')
  assert.ok(Array.isArray(body.messages))
})

test('B2：openai-responses → /responses + Bearer 鉴权 + max_output_tokens', () => {
  const r = buildRequest('openai-responses', BASE)
  assert.equal(r.url, 'https://gw.example.com/v1/responses')
  assert.equal(r.headers.authorization, 'Bearer sk-test')
  assert.equal(r.headers['x-api-key'], undefined)
  const body = JSON.parse(r.body)
  assert.equal(body.stream, false)
  assert.equal(body.instructions, SYSTEM, 'system 走顶层 instructions')
  assert.equal(body.max_output_tokens, 1)
  assert.equal(body.max_tokens, undefined)
  assert.equal(body.messages, undefined, '不许有 messages 键')
  assert.ok(Array.isArray(body.input))
  assert.equal(body.tools[0].type, 'function')
  assert.equal(body.tools[0].name, 'read', 'tools 是扁平形态')
})

test('B3：anthropic-messages → /v1/messages + x-api-key + anthropic-version', () => {
  const r = buildRequest('anthropic-messages', BASE)
  assert.equal(r.url, 'https://gw.example.com/v1/v1/messages', '现状行为：根上再拼 /v1/messages')
  assert.equal(r.headers['x-api-key'], 'sk-test')
  assert.equal(r.headers['anthropic-version'], '2023-06-01')
  assert.equal(r.headers.authorization, undefined, 'anthropic 不用 Bearer')
  const body = JSON.parse(r.body)
  /**
   * `stream` 必须与 DSH adapter 一致：`dsh-llm-deepseek/lib/index.js:1704` 恒发 `stream: true`。
   * 离线保温只要 usage、非流式更省事，但参数不一致会让「保温请求与真实请求是否同源」无从判断。
   */
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 1)
  assert.equal(body.max_output_tokens, undefined)
  assert.equal(body.input, undefined)
})

test('B4：三种分支的 URL 互不相同，且都带 content-type', () => {
  const kinds = ['openai-completions', 'openai-responses', 'anthropic-messages']
  const urls = kinds.map((k) => buildRequest(k, BASE).url)
  assert.equal(new Set(urls).size, 3, '三条 URL 必须互不相同')
  for (const k of kinds) {
    const r = buildRequest(k, BASE)
    assert.equal(r.headers['content-type'], 'application/json', `${k} 要有 content-type`)
    assert.doesNotThrow(() => JSON.parse(r.body), `${k} 的 body 必须是合法 JSON`)
  }
})

test('B5：Responses 分支带 reasoning 时是 {effort}', () => {
  const r = buildRequest('openai-responses', { ...BASE, reasoningEffort: 'high' })
  assert.deepEqual(JSON.parse(r.body).reasoning, { effort: 'high' })
})
