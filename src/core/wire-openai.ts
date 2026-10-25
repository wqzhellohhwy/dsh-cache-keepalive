/**
 * 把 DSH 内部消息序列化成 **OpenAI Chat Completions** 请求体（纯 Node，给离线保温用）。
 *
 * 为什么需要：DSH 的 `llm.stream()` 对第三方 provider（tokenrhythm / dots …）不发 usage chunk
 * —— 那些 provider 的适配器按 `compat.supportsUsageInStreaming` 决定要不要
 * `stream_options.include_usage`，未配置时就不带 → 面板永远拿不到命中率、无法记账。
 * 直连并自己带上 `stream_options:{include_usage:true}` 才拿得到 usage。
 *
 * 与 `wire.ts`（Anthropic 版）保持同构：system 快照留在对话流里、tool_result 单独成消息、
 * developer 的 tool_addition 丢弃（OpenAI 协议没有对应表达，真实请求也不会发）。
 */
import type { InternalMessage } from './wire.ts'

/**
 * **请求序列化口径版本**。
 *
 * 改本文件（或 `wire.ts`）**输出形态**时 +1：
 * - `1` — 第 0 条 role 从 `system` 改为 `developer`（v6 / D1）
 * - `2` — `content` 形态从块数组改为字符串（v7 / E1）
 * - `3` — reasoning 的落点由 `replayState` 决定（v8 / RC 规则）
 *
 * 为什么放在这里：`fingerprint.ts` 用它组成指纹的版本段，
 * **写在一起就不会出现「改了序列化忘了升指纹版本」** —— 忘了的后果是
 * 「所有会话判前缀已变 → 集体停保」，而且很难联想到根因。
 */
export const WIRE_SERIALIZE_VERSION = 3

interface Block {
  type?: string
  text?: string
  id?: string
  name?: string
  arguments?: unknown
  toolName?: string
  [k: string]: unknown
}

interface OutMsg {
  role: string
  content: string | null | unknown[]
  tool_calls?: unknown[]
  tool_call_id?: string
  reasoning_content?: string
}

const textOf = (blocks: readonly Block[]): string =>
  blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')

/**
 * **这条 assistant 消息能否按「原生 replay」发送** —— 决定 reasoning 的落点。
 *
 * ## 为什么需要
 * 实测 3f0b（`.tmp/spy-3f0b`）240 条 assistant：
 * ```
 * 有 reasoning 块         173
 * 有 replayState(pi-ai)    238
 * 两者都有                171   ← 与真实 body 里 171 条 `reasoning_content` **完全相等**
 * 有 reasoning 无 replayState  2   ← 真实 body 里那两条 content 是 **字符串**
 * ```
 * ⇒ 有 replayState：`content` 只放 text，reasoning 走 `reasoning_content`；
 *    没有（DSH 会降级成 `foreignAssistant`）：**reasoning 与 text 直接拼进 `content`**，不发 `reasoning_content`。
 *
 * ## 判据来源（逐条复刻，不是猜）
 * `dsh-llm-pi-ai/lib/index.js:97 readReplayState()` + `:182 replayedAssistant()`：
 * 前 11 条是 `readReplayState` 的防御性校验，后 3 条（provider/model 匹配、块数匹配、逐块 type 匹配）
 * 是 `replayedAssistant` 真正会因之降级的条件。任一不满足 → DSH 走 `foreignAssistant`。
 *
 * ⚠️ **不要复用 `wire.ts` 的 `replayBlocks()`** —— 那套判的是
 * `response.kind === 'deepseek-messages' && version === 1`（DeepSeek Messages 协议），
 * 而 pi-ai 是 `kind === 'pi-ai' && version === 2`，会 100% 判成「无签名」。
 *
 * @param raw 内部消息
 * @returns 能按原生 replay 发送时为 true
 */
export function hasValidPiReplay(raw: InternalMessage): boolean {
  const source = raw.source as { kind?: unknown; provider?: unknown; model?: unknown; replayState?: unknown } | undefined
  if (source?.kind !== 'model' || source.replayState === undefined) return false
  const envelope = source.replayState as { response?: unknown; blocks?: unknown }
  const resp = envelope?.response as Record<string, unknown> | undefined
  if (resp === undefined || resp === null || typeof resp !== 'object' || Array.isArray(resp)) return false
  if (resp['kind'] !== 'pi-ai') return false
  if (resp['version'] !== 2) return false
  for (const k of ['api', 'provider', 'model']) {
    const v = resp[k]
    if (typeof v !== 'string' || v === '') return false
  }
  if (!['stop', 'length', 'toolUse', 'error', 'aborted'].includes(String(resp['stopReason']))) return false
  const blocks = envelope.blocks
  if (!Array.isArray(blocks)) return false
  for (const b of blocks as unknown[]) {
    if (b === null || typeof b !== 'object' || Array.isArray(b)) return false
    if (!['text', 'reasoning', 'tool-call'].includes(String((b as { type?: unknown }).type))) return false
  }
  /** `replayedAssistant` 的三条：provider / model 与 source 一致、块数与内容一致、逐块 type 一致。 */
  if (resp['provider'] !== source.provider) return false
  if (resp['model'] !== source.model) return false
  const content = raw.content ?? []
  if (blocks.length !== content.length) return false
  for (let i = 0; i < blocks.length; i += 1) {
    if ((blocks[i] as { type?: unknown }).type !== content[i]?.type) return false
  }
  return true
}

/** 把工具声明转成 OpenAI 的 function 形态。 */
function wireTools(tools: readonly unknown[]): unknown[] {
  return tools.map((raw) => {
    const t = raw as { name?: string; description?: string; parameters?: unknown; input_schema?: unknown }
    return {
      type: 'function',
      function: {
        name: t.name,
        ...(t.description === undefined ? {} : { description: t.description }),
        parameters: t.parameters ?? t.input_schema ?? { type: 'object', properties: {} },
      },
    }
  })
}

export type ImageResolver = (attachment: {
  attachmentId?: string
  mediaType?: string
}) => { mediaType: string; base64: string } | undefined

export interface OpenAISerializeOptions {
  model: string
  maxTokens: number
  system?: string
  tools?: unknown[]
  temperature?: number
  /** 图片块 → 真实字节；不传就按占位文本降级。 */
  resolveImage?: ImageResolver
  /**
   * **D1** 第 0 条消息的 role。由调用方按 `provider-meta.instructionRoleOf()` 判定后传入，
   * 不硬编码 —— 实测 tokenrhythm 的 v4.1 真实请求发的是 `developer`。
   */
  instructionRole?: 'system' | 'developer'
  /** **D2** 顶层 `thinking`（实测 `{type:'enabled'}`）。由 `thinkingParamsOf()` 算。 */
  thinking?: { type: 'enabled' | 'disabled' }
  /** **D3** 顶层 `reasoning_effort`（实测 `"high"`）。由 `thinkingParamsOf()` 算。 */
  reasoningEffort?: string
  /**
   * **D4** 输出上限的键名。由 `provider-meta.maxTokensFieldOf()` 决定，不硬编码。
   * 实测 tokenrhythm 发 `max_completion_tokens`，DeepSeek 官方端点发 `max_tokens`。
   */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** **D5** 顶层 `store`；实测真实请求带 `false`。 */
  store?: boolean
}

/**
 * 序列化成 OpenAI Chat Completions 请求体。
 *
 * 顶层键顺序对齐实测真实 body：
 * `model / messages / stream / stream_options / store / max_*_tokens / tools / thinking / reasoning_effort`
 */
export function serializeForOpenAI(
  messages: readonly InternalMessage[],
  opts: OpenAISerializeOptions,
): Record<string, unknown> {
  const wire: OutMsg[] = []
  const instructionRole = opts.instructionRole ?? 'system'
  if (opts.system !== undefined && opts.system !== '') {
    wire.push({ role: instructionRole, content: opts.system })
  }

  for (const raw of messages) {
    const role = raw.role ?? ''
    const blocks = (raw.content ?? []) as Block[]

    if (role === 'system' || role === 'developer') {
      const text = textOf(blocks)
      if (text !== '') wire.push({ role: instructionRole, content: text })
      continue
    }

    if (role === 'tool') {
      // 内部：role=tool + content[0] 是 tool-result
      const res = blocks.find((b) => b.type === 'tool-result') ?? blocks[0]
      const text = typeof res?.text === 'string' ? res.text : textOf(blocks)
      wire.push({ role: 'tool', content: text, tool_call_id: String(raw.toolCallId ?? res?.id ?? '') })
      continue
    }

    if (role === 'assistant') {
      const text = textOf(blocks)
      const reasoning = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text ?? '').join('')
      const calls = blocks.filter((b) => b.type === 'tool-call').map((b) => ({
        id: String(b.id ?? ''),
        type: 'function',
        function: { name: String(b.name ?? ''), arguments: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {}) },
      }))
      /**
       * **reasoning 的落点由 `replayState` 决定**（见 `hasValidPiReplay` 的说明）。
       *
       * ```
       * 有有效 replayState → content = text（有 tool_calls 则 null）；reasoning → reasoning_content
       * 没有/无效          → content = reasoning + text（无分隔，reasoning 在前）；**不发 reasoning_content**
       * ```
       *
       * 依据（实测 3f0b）：240 条 assistant 里「有 reasoning 且有 replayState」= 171，
       * 与真实 body 的 171 条 `reasoning_content` 完全相等；剩下 2 条无 replayState 的，
       * 真实 body 里 content 正是 `reasoning + text` 拼成的字符串（1888 = 1841+47，449 = 449+0）。
       */
      const nativeReplay = hasValidPiReplay(raw)
      /**
       * ⚠️ **没有 text 也没有 tool_calls 的 assistant 消息，`content` 必须给空串，不能给 `null`**。
       * DSH 内部允许"只有 reasoning 块"的 assistant 消息（Anthropic 协议合法），但 OpenAI 兼容网关
       * 收到 `{role:'assistant', content:null}` 且无 `tool_calls` 会整条请求 400 —— 实测 tokenrhythm133
       * 回 `MODEL_TOOL_NOT_SUPPORTED`（文案误导，看着像模型不支持工具，其实是消息非法）。
       * 空串实测 200，且命中率比直接删掉这条消息更高（61.6% vs 61.4%，保留 reasoning 更贴近真实前缀）。
       */
      const contentText = nativeReplay
        ? text
        /** 降级：DSH 的 `foreignAssistant` 把 reasoning 拍平成文本放在前面，无分隔符。 */
        : reasoning + text
      const out: OutMsg = {
        role: 'assistant',
        content: contentText !== '' ? contentText : (calls.length > 0 ? null : ''),
      }
      if (calls.length > 0) out.tool_calls = calls
      /** 只有原生 replay 才把 reasoning 单独放进 `reasoning_content`。 */
      if (nativeReplay && reasoning !== '') out.reasoning_content = reasoning
      wire.push(out)
      continue
    }

    // user
    /**
     * ⚠️ **`content` 的形态必须与真实请求一致**（E1，实测 40b9 403 条里 **0 条块数组**）。
     *
     * 真实 body 全量统计：`developer/user/tool` 与纯文本 `assistant` 全是 **string**，
     * 带 `tool_calls` 的 `assistant` 全是 **null**。以前这里把**多个文本块**发成
     * `[{type:'text',...}]` 块数组 —— 从第 1 条起形态就不同，整条前缀全 miss。
     *
     * 现在的规则：
     *  - 全是文本块 → **拼成一个字符串**（不保留块结构）
     *  - 有图片 → 必须用数组（OpenAI 唯独这里要 `image_url` 对象）
     */
    const texts: string[] = []
    let hasNonText = false
    let toolResultPushed = false
    for (const b of blocks) {
      if (b.type === 'text') {
        if ((b.text ?? '') !== '') texts.push(b.text ?? '')
        continue
      }
      if (b.type === 'image') {
        hasNonText = true
        continue
      }
      if (b.type === 'tool-result') {
        // OpenAI 协议里 tool 结果是独立消息，必须先于其它内容
        wire.push({ role: 'tool', content: typeof b.text === 'string' ? b.text : '', tool_call_id: String(b.id ?? '') })
        toolResultPushed = true
        continue
      }
      // reasoning / tool-call 在 user 侧丢弃（与 wire.ts 一致）
    }
    if (!hasNonText && texts.length > 0) {
      wire.push({ role: 'user', content: texts.join('') })
    } else if (hasNonText) {
      const parts: unknown[] = texts.length === 1
        ? [{ type: 'text', text: texts[0] }]
        : texts.map((t) => ({ type: 'text', text: t }))
      for (const b of blocks) {
        if (b.type !== 'image') continue
        const att = (b.attachment ?? {}) as { attachmentId?: string; mediaType?: string }
        const img = opts.resolveImage?.(att)
        if (img !== undefined) {
          parts.push({ type: 'image_url', image_url: { url: 'data:' + img.mediaType + ';base64,' + img.base64 } })
        }
      }
      wire.push({ role: 'user', content: parts })
    } else if (!toolResultPushed) {
      wire.push({ role: 'user', content: '' })
    }
  }

  const maxField = opts.maxTokensField ?? 'max_tokens'
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: wire,
    stream: true,
    /** 关键：不带它，第三方 provider 的流式响应里**没有 usage**。 */
    stream_options: { include_usage: true },
    store: opts.store ?? false,
    [maxField]: opts.maxTokens,
  }
  if (Array.isArray(opts.tools) && opts.tools.length > 0) body.tools = wireTools(opts.tools)
  if (opts.thinking !== undefined) body.thinking = opts.thinking
  if (opts.reasoningEffort !== undefined) body.reasoning_effort = opts.reasoningEffort
  if (opts.temperature !== undefined) body.temperature = opts.temperature
  return body
}


