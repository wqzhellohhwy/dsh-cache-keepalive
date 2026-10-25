/**
 * **静态推导单测**：`provider-meta.ts` 从 profile 配置算出的
 * `reasoning` / `supportsDeveloperRole` / `instructionRole` / thinking 参数，
 * 必须与「逐行读 pi-ai 源码」得出的结论一致。
 *
 * 定位：这是**判据 P1**。它证明「机制上真实请求长什么样」，
 * **不**证明「保温到底为什么零命中」—— 那要靠 `tools/fetchspy.mjs` 抓真实体（判据 P0）。
 *
 * 纪律：
 *  - 只读配置文件，不联网、不读 `~/.dsh/.credentials.yaml`
 *  - 本机真实配置那几条用例在**文件不存在时跳过**（别人 clone 下去也能跑）
 *  - `providerMetaOf(dshHome, p, m, texts)` 允许直接喂文本，用例不受别人 profile 干扰
 *
 * 跑法：`node --test tests/wire-parity.test.mjs`
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  instructionRoleOf,
  maxTokensFieldOf,
  parseProviderBlocks,
  providerMetaOf,
  resolveLevel,
  supportsDeveloperRoleOf,
  thinkingFormatOf,
  thinkingParamsOf,
} from '../src/core/provider-meta.ts'
import { parseProviders } from '../src/core/providers.ts'
import { serializeForOpenAI } from '../src/core/wire-openai.ts'
import { wireShapeOf } from '../src/core/warm-offline.ts'
import { fingerprintOf, isCurrentFingerprint } from '../src/core/fingerprint.ts'

/** 真形状的配置片段（顶层 `- id: llm-pi-ai` + `config.providers`）。 */
const CONFIG = [
  '- id: llm-pi-ai',
  '  name: \'@deepseek-ai/dsh-llm-pi-ai\'',
  '  config:',
  '    providers:',
  '      std:',
  '        apiKeyEnv: STD_KEY',
  '        api: openai-completions',
  '        baseURL: https://std.example/v1',
  '        models:',
  '          - id: m-think',
  '            name: m-think',
  '            reasoningEfforts:',
  "              'off': null",
  '              low: low',
  '              high: high',
  '            compat:',
  '              thinkingFormat: deepseek',
  '          - id: m-plain',
  '            name: m-plain',
  '      deepseek:',
  '        baseURL: https://api.deepseek.com/v1',
  '        models:',
  '          - id: ds-reasoner',
  '            reasoningEfforts:',
  '              high: high',
  '      dots:',
  '        baseURL: https://dots.example/v1',
  '        models:',
  '          - id: d1',
  '            reasoningEfforts:',
  '              high: high',
  '            compat:',
  '              supportsDeveloperRole: false',
  '- id: other',
].join('\n')

const META = (p, m) => providerMetaOf(undefined, p, m, [CONFIG])

// ── 解析层 ────────────────────────────────────────────────────────
test('parse：provider / model / baseURL / compat / reasoningEfforts 各归其位', () => {
  const blocks = parseProviderBlocks(CONFIG)
  assert.deepEqual(blocks.map((b) => b.name), ['std', 'deepseek', 'dots'])
  const std = blocks[0]
  assert.equal(std.baseURL, 'https://std.example/v1')
  assert.equal(std.apiKeyEnv, 'STD_KEY')
  assert.deepEqual([...std.models.keys()], ['m-think', 'm-plain'])
  const think = std.models.get('m-think')
  /**
   * **声明 `off: null` ⇒ 不写这个键**（不是写 `null`）：
   * pi-ai `openai-completions.js:670` 判 `thinkingLevelMap?.off !== null` ——
   * 「声明 null」走 `undefined !== null` → 发 disabled；「完全没声明」才是 `null` → 不发。
   * 两者混成一种就等于回到旧 bug。
   */
  assert.deepEqual(think.thinkingLevelMap, { low: 'low', high: 'high' })
  assert.equal(think.reasoning, true)
  assert.deepEqual(think.compat, { thinkingFormat: 'deepseek' })
  // 没声明 reasoningEfforts → 不当作 reasoning
  assert.equal(std.models.get('m-plain').reasoning, false)
  assert.deepEqual(std.models.get('m-plain').thinkingLevelMap, {})
})

test('parse：models 段结束后不会把下一个 provider 的字段吞进来', () => {
  const blocks = parseProviderBlocks(CONFIG)
  assert.equal(blocks[2].name, 'dots')
  assert.equal(blocks[2].baseURL, 'https://dots.example/v1', 'dots 的 baseURL 别被 std 抢走')
  assert.deepEqual([...blocks[2].models.keys()], ['d1'])
})

// ── 判据 P1：instructionRole ─────────────────────────────────────
test('P1-a：reasoning=true + 标准端点（不在名单）→ developer', () => {
  const meta = META('std', 'm-think')
  assert.equal(meta.reasoning, true)
  assert.equal(supportsDeveloperRoleOf(meta), true)
  assert.equal(instructionRoleOf(meta), 'developer')
})

test('P1-b：reasoning=false → system（即便 supportsDeveloperRole 为真）', () => {
  const meta = META('std', 'm-plain')
  assert.equal(meta.reasoning, false)
  assert.equal(supportsDeveloperRoleOf(meta), true)
  assert.equal(instructionRoleOf(meta), 'system')
})

test('P1-c：compat.supportsDeveloperRole=false（model 级）压过名单推断', () => {
  const meta = META('dots', 'd1')
  assert.equal(meta.reasoning, true)
  assert.equal(supportsDeveloperRoleOf(meta), false)
  assert.equal(instructionRoleOf(meta), 'system')
})

test('P1-d：deepseek.com 在 isNonStandard 名单里 → supportsDeveloperRole=false → system', () => {
  const meta = META('deepseek', 'ds-reasoner')
  assert.equal(meta.reasoning, true)
  assert.equal(supportsDeveloperRoleOf(meta), false)
  assert.equal(instructionRoleOf(meta), 'system')
})

test('P1-e：配置里没有的模型 → undefined（不许猜）', () => {
  assert.equal(META('std', 'nope'), undefined)
  assert.equal(META('nope', 'm-think'), undefined)
})

// ── 判据 P1：thinking 参数 ───────────────────────────────────────
test('P1-f：off 的三值语义（最容易写反的地方）', () => {
  const meta = META('std', 'm-think')
  assert.deepEqual(thinkingParamsOf(meta, 'high'), { thinking: { type: 'enabled' }, reasoning_effort: 'high' })

  /**
   * 本组配置写的是 `off: null`。
   * `dsh-llm-pi-ai/lib/index.js:580-585` 遇到声明 `null` 时**不写入键** ⇒ `map.off === undefined`
   * ⇒ `openai-completions.js:670` 的 `map.off !== null` 为 **true** ⇒ **发 disabled**。
   * （与直觉相反：声明 `off: null` 是「发 disabled」，完全不声明才是「不发」。）
   */
  assert.equal('off' in meta.thinkingLevelMap, false, '声明 off:null → 键必须不存在')
  assert.deepEqual(thinkingParamsOf(meta, 'off'), { thinking: { type: 'disabled' } })

  /** 完全不声明 off ⇒ `map.off === null` ⇒ 那句不成立 ⇒ 不发。 */
  const noOffDeclared = { ...meta, thinkingLevelMap: { low: 'low', high: 'high' } }
  assert.equal(noOffDeclared.thinkingLevelMap.off, undefined)
  assert.deepEqual(thinkingParamsOf({ ...noOffDeclared, thinkingLevelMap: { ...noOffDeclared.thinkingLevelMap, off: null } }, 'off'), {})
})

test('P1-g：非 deepseek 端点（tokenrhythm 那种）→ 一个 thinking 参数都不发', () => {
  const meta = META('std', 'm-think')
  const noFormat = { ...meta, compat: {} }
  assert.equal(thinkingFormatOf(noFormat), undefined)
  assert.deepEqual(thinkingParamsOf(noFormat, 'high'), {})
  assert.deepEqual(thinkingParamsOf(noFormat, 'off'), {})
})

test('P1-h：reasoning=false → 不发 thinking（与格式无关）', () => {
  const meta = META('std', 'm-plain')
  assert.equal(meta.reasoning, false)
  assert.deepEqual(thinkingParamsOf(meta, 'high'), {})
})

test('P1-i：off 被 pi-ai 翻译成「不带选项」，不发 reasoning_effort', () => {
  assert.equal(resolveLevel('off'), 'off')
  assert.equal(resolveLevel(undefined), 'off')
  assert.equal(resolveLevel(''), 'off')
  assert.equal(resolveLevel('high'), 'high')
  const meta = META('std', 'm-think')
  assert.equal(thinkingParamsOf(meta, 'off').reasoning_effort, undefined, 'off 时绝不能带 reasoning_effort')
})

// ── 本机真实配置（文件不在就跳过） ───────────────────────────────
const REAL = join(homedir(), '.dsh', 'profiles', 'backup', 'cordis.yml')
const REAL_PATCH = join(homedir(), '.dsh', 'profiles', 'backup', 'cordis.patch.yml')
const realText = existsSync(REAL) ? readFileSync(REAL, 'utf8') : undefined
const realPatch = existsSync(REAL_PATCH) ? readFileSync(REAL_PATCH, 'utf8') : undefined

test('P1-real：本机 tokenrhythm-title 的 deepseek-v4.1-flash-1017', (t) => {
  if (realText === undefined) return t.skip('本机没有 ' + REAL)
  const meta = providerMetaOf(undefined, 'tokenrhythm-title', 'deepseek-v4.1-flash-1017', [realText])
  assert.ok(meta !== undefined, 'backup profile 里应有这条 model')
  assert.equal(meta.reasoning, true, 'reasoningEfforts 声明了 4 档 → reasoning=true')
  assert.equal(supportsDeveloperRoleOf(meta), true, 'tokenrhythm.studio 不在 isNonStandard 名单')
  assert.equal(instructionRoleOf(meta), 'developer', 'openai-completions.js:896')
  // 本机该 model 条目**确实**声明了 `compat.thinkingFormat: deepseek`（`backup/cordis.yml` 的 tokenrhythm-title 段）
  assert.equal(thinkingFormatOf(meta), 'deepseek')
  // 本机 agent-default-model 的 reasoningEffort 是 off → **实测真实请求带 thinking:{type:'disabled'}**
  // （40b9 真实 body 顶层就是它；解析器复刻源码后 map.off === undefined ⇒ `!== null` 成立）
  assert.deepEqual(thinkingParamsOf(meta, 'off'), { thinking: { type: 'disabled' } })
  // 有 effort 时才带 reasoning_effort（openai-completions.js:667-668, 673-675）
  assert.deepEqual(thinkingParamsOf(meta, 'high'), { thinking: { type: 'enabled' }, reasoning_effort: 'high' })
})

test('P1-real：本机 dots3-note-prev 显式关掉 developer role', (t) => {
  if (realText === undefined) return t.skip('本机没有 ' + REAL)
  const dots = providerMetaOf(undefined, 'dots', 'dots3-note-prev', [realText])
  assert.ok(dots !== undefined)
  assert.equal(supportsDeveloperRoleOf(dots), false)
  assert.equal(instructionRoleOf(dots), 'system')
})

// ── 本机真实 **patch** 配置（真实生效的那一层） ────────────────────
// 契约 v5 §八 的表就是从这一份算出来的：tokenrhythm-title/v4.1 → developer + deepseek，
// tokenrhythm/v4.1 → system 且无 thinking。dot 与 patch 不一致时，patch 才是生效的那份。
test('P1-patch：tokenrhythm-title + v4.1 → reasoning=true / developer / thinkingFormat=deepseek', (t) => {
  if (realPatch === undefined) return t.skip('本机没有 ' + REAL_PATCH)
  const meta = providerMetaOf(undefined, 'tokenrhythm-title', 'deepseek-v4.1-flash-1017', [realPatch])
  assert.ok(meta !== undefined, 'patch 里应有 tokenrhythm-title / deepseek-v4.1-flash-1017')
  assert.equal(meta.reasoning, true)
  assert.equal(supportsDeveloperRoleOf(meta), true, 'tokenrhythm.studio 不在 isNonStandard 名单')
  assert.equal(instructionRoleOf(meta), 'developer')
  assert.equal(thinkingFormatOf(meta), 'deepseek')
  assert.deepEqual(thinkingParamsOf(meta, 'high'), { thinking: { type: 'enabled' }, reasoning_effort: 'high' })
})

test('P1-patch：tokenrhythm + v4.1（无 reasoningEfforts）→ reasoning=false / system / 不发 thinking', (t) => {
  if (realPatch === undefined) return t.skip('本机没有 ' + REAL_PATCH)
  const meta = providerMetaOf(undefined, 'tokenrhythm', 'deepseek-v4.1-flash-1017', [realPatch])
  assert.ok(meta !== undefined)
  assert.equal(meta.reasoning, false, '这条 model 没声明 reasoningEfforts')
  assert.equal(instructionRoleOf(meta), 'system')
  assert.equal(thinkingFormatOf(meta), undefined, '端点不是 deepseek.com、model 也没声明 thinkingFormat')
  assert.deepEqual(thinkingParamsOf(meta, 'high'), {})
})

test('P1-patch：dots-title 用 -title 路由补了 reasoningEfforts 但仍显式关掉 developer role', (t) => {
  if (realPatch === undefined) return t.skip('本机没有 ' + REAL_PATCH)
  const meta = providerMetaOf(undefined, 'dots-title', 'dots3-note-prev', [realPatch])
  assert.ok(meta !== undefined)
  assert.equal(meta.reasoning, true)
  assert.equal(supportsDeveloperRoleOf(meta), false, 'compat.supportsDeveloperRole: false 显式声明')
  assert.equal(instructionRoleOf(meta), 'system')
})

test('P1-patch：providers.ts 扩容后能读到 reasoningEfforts / compat（不写第二份解析）', (t) => {
  if (realPatch === undefined) return t.skip('本机没有 ' + REAL_PATCH)
  const cfgs = parseProviders(realPatch)
  const title = cfgs.find((c) => c.name === 'tokenrhythm-title')
  assert.ok(title !== undefined)
  const model = title.models?.get('deepseek-v4.1-flash-1017')
  assert.ok(model !== undefined, 'model 条目要带进 ProviderCfg')
  assert.equal(model.reasoning, true)
  assert.deepEqual(model.compat, { thinkingFormat: 'deepseek' })
  const dots = cfgs.find((c) => c.name === 'dots-title')
  assert.deepEqual(dots?.models?.get('dots3-note-prev')?.compat?.supportsDeveloperRole, false)
})

// ═══════════════════════════════════════════════════════════════
// v6：按**实测真实请求体**对齐每一项（D1~D5）
// 每条都要能抓变异：改回旧行为必须红。
// 实测来源：`.tmp/spy-v6/real-body-*.json`（tokenrhythm 实录）
// ═══════════════════════════════════════════════════════════════

/** 实测真实 body 的顶层键（顺序即真实顺序）。写死在这里当「事实锚」。 */
const REAL_TOP_KEYS = [
  'model', 'messages', 'stream', 'stream_options', 'store',
  'max_completion_tokens', 'tools', 'thinking', 'reasoning_effort',
]

/** 序列化器的最小入参（不传任何新选项 = 旧行为）。 */
const base = { model: 'deepseek-v4.1-flash-1017', maxTokens: 1 }

const MSGS = [
  { role: 'developer', content: [{ type: 'text', text: 'SYS' }] },
  { role: 'user', content: [{ type: 'text', text: 'hi' }] },
]

test('D1：instructionRole=developer → 第 0 条 role 是 developer（变异：硬编码 system → 红）', () => {
  const wire = serializeForOpenAI(MSGS, { ...base, instructionRole: 'developer' })
  assert.equal(wire.messages[0].role, 'developer')
  // 不传 → 旧行为 system（兜底，不是判定点）
  assert.equal(serializeForOpenAI(MSGS, base).messages[0].role, 'system')
})

test('D2/D3：thinking + reasoning_effort 进顶层（变异：不发 → 红）', () => {
  const wire = serializeForOpenAI(MSGS, {
    ...base, thinking: { type: 'enabled' }, reasoningEffort: 'high',
  })
  assert.deepEqual(wire.thinking, { type: 'enabled' })
  assert.equal(wire.reasoning_effort, 'high')
  // 不传就不出现（不是 null、不是 undefined 键）
  const bare = serializeForOpenAI(MSGS, base)
  assert.equal('thinking' in bare, false)
  assert.equal('reasoning_effort' in bare, false)
})

test('D4：maxTokensField 决定键名（变异：仍发 max_tokens → 红）', () => {
  const mc = serializeForOpenAI(MSGS, { ...base, maxTokensField: 'max_completion_tokens' })
  assert.equal(mc.max_completion_tokens, 1)
  assert.equal('max_tokens' in mc, false)
  const mt = serializeForOpenAI(MSGS, { ...base, maxTokensField: 'max_tokens' })
  assert.equal(mt.max_tokens, 1)
  assert.equal('max_completion_tokens' in mt, false)
  // 默认（不传）保持旧行为
  assert.equal(serializeForOpenAI(MSGS, base).max_tokens, 1)
})

test('D5：store 默认 false 且 stream/stream_options 保持（变异：不发 store → 红）', () => {
  const wire = serializeForOpenAI(MSGS, base)
  assert.equal(wire.store, false, '实测真实请求带 store:false')
  assert.equal(wire.stream, true)
  assert.deepEqual(wire.stream_options, { include_usage: true })
})

test('P2：顶层键集合与顺序 = 实测真实 body', () => {
  const wire = serializeForOpenAI(MSGS, {
    ...base, tools: [{ name: 't' }],
    instructionRole: 'developer', thinking: { type: 'enabled' },
    reasoningEffort: 'high', maxTokensField: 'max_completion_tokens',
  })
  assert.deepEqual(Object.keys(wire), REAL_TOP_KEYS)
})

test('D4 判定：maxTokensFieldOf 按 detectCompat 名单（不许调用方硬编码）', () => {
  const tok = { provider: 'tokenrhythm-title', baseURL: 'https://tokenrhythm.studio/v1', reasoning: true, thinkingLevelMap: {} }
  assert.equal(maxTokensFieldOf(tok), 'max_completion_tokens', '实测 tokenrhythm 发 max_completion_tokens')
  const ds = { provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1', reasoning: true, thinkingLevelMap: {} }
  assert.equal(maxTokensFieldOf(ds), 'max_tokens', 'deepseek.com 在 useMaxTokens 名单里')
  const chutes = { provider: 'x', baseURL: 'https://llm.chutes.ai/v1', reasoning: false, thinkingLevelMap: {} }
  assert.equal(maxTokensFieldOf(chutes), 'max_tokens')
  // 显式声明优先
  const declared = { ...tok, compat: { maxTokensField: 'max_tokens' } }
  assert.equal(maxTokensFieldOf(declared), 'max_tokens')
})

test('wireShapeOf：整条链路由 provider-meta 决定（配置未命中 → 退回旧行为）', () => {
  const plan = {
    messages: [],
    tools: [],
    toolHistory: { tools: [], updates: [] },
    headerToolCount: 0,
    stats: { events: 0, nodes: 0, messages: 0, removedToolCalls: 0, replacements: 0, imageBlocks: 0, firstImageAt: -1 },
    config: { provider: 'no-such-provider', model: 'no-such-model', reasoningEffort: 'high' },
  }
  const shape = wireShapeOf(plan, join(homedir(), '.dsh'))
  assert.equal(shape.instructionRole, 'system', '配置读不到不许猜')
  assert.equal(shape.maxTokensField, 'max_tokens')
  assert.equal(shape.thinking, undefined)
})

// ── 指纹版本前缀（裁决 5） ────────────────────────────────────
test('FP1：指纹带版本前缀，旧账本的无前缀指纹自动豁免', () => {
  const fp = fingerprintOf({ tools: [], messages: [] })
  /** 当前格式是 `<FINGERPRINT_VERSION>:<WIRE_SERIALIZE_VERSION>:<16 位 hex>` = `3:3:`（见 fingerprint.ts 版本历史）。 */
  assert.match(fp, /^3:3:[0-9a-f]{16}$/u, '必须是 <指纹版本>:<序列化版本>:<16 位 hex>')
  assert.equal(isCurrentFingerprint(fp), true)
  assert.equal(isCurrentFingerprint('26a83b39fb46e7ac'), false, '旧账本的 16 位 hex 不算当前版本')
  assert.equal(isCurrentFingerprint(undefined), false)
})

test('FP2：role 变化仍然改变指纹（不许为了迁移把 role 剔除）', () => {
  const a = fingerprintOf({ tools: [], messages: [{ role: 'system', content: 'X' }] })
  const b = fingerprintOf({ tools: [], messages: [{ role: 'developer', content: 'X' }] })
  assert.notEqual(a, b, 'role 变了前缀字节就变了，指纹必须变；豁免靠版本前缀，不靠剔除字段')
})

test('FP3：插件侧与 CLI 侧算同一个指纹（同源，不各写一份）', () => {
  const parts = { tools: [{ name: 't', parameters: { type: 'object' } }], messages: [{ role: 'user', content: 'hi' }] }
  assert.equal(fingerprintOf(parts), fingerprintOf(parts))
  /** 源码锚：`keepalive.ts` 必须 re-export 同一个实现，不许自己再写一份 sha1。 */
  const src = readFileSync(new URL('../src/keepalive.ts', import.meta.url), 'utf8')
  assert.match(src, /export \{ PREFIX_HEAD_MESSAGES, fingerprintOf \}/u, '插件侧必须是转出，不是另算')
  assert.doesNotMatch(src, /createHash\('sha1'\)/u, '插件侧不许自己算 sha1')
})

test('FP4：**两条消费路径都做版本检查**（插件 prefixStale + CLI prefix-changed）', () => {
  /** 只改一处的话，「零停保」在一个半边上成立 —— 这正是一次真实的返工原因。 */
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const cli = readFileSync(new URL('../cli/keepalive.mjs', import.meta.url), 'utf8')
  assert.match(idx, /isCurrentFingerprint\(prevFp\)/u, '插件侧必须做版本检查')
  assert.match(cli, /isCurrentFingerprint\(prevFp\)/u, 'CLI 侧也必须做版本检查')
  assert.match(cli, /isCurrentFingerprint[^\n]*fingerprint\.ts/u, 'CLI 必须 import 同一个判据')
  /** 反向锚：任何一侧退回「只看 !== undefined」都算回归。 */
  for (const [name, src] of [['index.ts', idx], ['keepalive.mjs', cli]]) {
    assert.doesNotMatch(src, /prevFp !== undefined && prevFp !== /u,
      `${name} 里不许再出现「只看 prevFp 是否存在」的旧判据`)
  }
})

test('FP5：旧账本无前缀指纹一律豁免（升级那一刻零停保）', () => {
  const cur = fingerprintOf({ tools: [], messages: [] })
  const stale = (prevFp) => isCurrentFingerprint(prevFp) && prevFp !== cur
  assert.equal(stale('b7ace5f5b8972e70'), false, '旧 16 位无前缀 → 豁免')
  assert.equal(stale(undefined), false, '从没保过 → 豁免')
  assert.equal(stale('3:3:deadbeefdeadbeef'), true, '同版本但值不同 → 照拦')
  assert.equal(stale('2:deadbeefdeadbeef'), false, '旧版本格式（单版本 `2:`）→ 豁免：升级那一刻零停保')
  assert.equal(stale(cur), false, '同版本且相同 → 放行')
})
