/**
 * 序列化成 **OpenAI Responses API** 的请求体。
 *
 * ## 与 Chat Completions 的差别（都是会让请求直接 400 的硬差别）
 *
 * | | Chat Completions | Responses |
 * |---|---|---|
 * | 消息数组 | `messages` | `input` |
 * | system | `messages[0]`，role=system/developer | **顶层 `instructions`** |
 * | 文本内容 | 裸字符串 `content: "..."` | `content: [{type:'input_text'\|'output_text', text}]` |
 * | 工具声明 | `{type:'function', function:{name,…}}` | **扁平** `{type:'function', name, …}` |
 * | 输出上限 | `max_tokens` / `max_completion_tokens` | **`max_output_tokens`** |
 * | 工具结果 | `{role:'tool', tool_call_id}` | `{type:'function_call_output', call_id, output}` |
 * | 工具调用 | `assistant.tool_calls` | `{type:'function_call', call_id, name, arguments}` |
 * | 流式开关 | `stream` + `stream_options` | 只要 `stream` |
 *
 * ## 块映射沿用 `wire-openai.ts` 的思想
 * DSH 内部的块名（`reasoning` / `tool-call` / `tool-result`）与 wire 名不同，
 * 这里复用同一套映射，不另起一套 —— 两套映射必然分叉。
 */
import type { ImageResolver, InternalMessage } from './wire.ts'

/** 内部块的最小形状（与 `wire.ts` / `wire-openai.ts` 一致）。 */
interface Block {
  type?: string
  text?: string
  id?: string
  name?: string
  arguments?: unknown
  attachment?: { attachmentId?: string; mediaType?: string }
}

export interface ResponsesSerializeOptions {
  model: string
  maxTokens: number
  /** 承载到顶层 `instructions`（**不是** `input[0]`）。 */
  system?: string
  tools?: unknown[]
  temperature?: number
  /** 图片块 → 真实字节；不传就按占位文本降级。 */
  resolveImage?: ImageResolver
  /** 顶层 `reasoning: { effort }`；不传就不带。 */
  reasoningEffort?: string
  /** 顶层 `store`；Responses 默认不存。 */
  store?: boolean
}

/**
 * Responses 的文本块类型：
 * - 用户/系统侧输入 → `input_text`
 * - assistant 自己的产出 → `output_text`
 *
 * 发错会让 API 回 `Invalid value: 'input_text'` 之类，是硬错误。
 */
function textPart(role: string, text: string): { type: string; text: string } {
  return { type: role === 'assistant' ? 'output_text' : 'input_text', text }
}

/** 把工具声明转成 Responses 的**扁平** function 形态。 */
function wireTools(tools: readonly unknown[]): unknown[] {
  return tools.map((raw) => {
    const t = raw as { name?: string; description?: string; parameters?: unknown; input_schema?: unknown }
    return {
      type: 'function',
      name: t.name,
      ...(t.description === undefined ? {} : { description: t.description }),
      parameters: t.parameters ?? t.input_schema ?? { type: 'object', properties: {} },
    }
  })
}

/** 一条 `input` 项。 */
type InputItem = Record<string, unknown>

/**
 * 序列化成 OpenAI Responses 请求体。
 *
 * @param messages DSH 内部消息
 * @param opts 选项
 */
export function serializeForResponses(
  messages: readonly InternalMessage[],
  opts: ResponsesSerializeOptions,
): Record<string, unknown> {
  const input: InputItem[] = []
  /**
   * 历史里的 system 快照。
   *
   * Responses 只有**一个** `instructions` 字段装系统提示，压缩过的会话会在历史里
   * 插若干 system 快照 —— 把它们全并进 `instructions` 会让位置整体错位、前缀当场断
   * （与 `wire.ts` 里 `seenSystem` 那段的结论一致）。
   * 所以：**首个 system → `instructions`；其余作为 `input` 里的 `system` 角色项留在原位**。
   */
  let instructions = opts.system ?? ''
  let seenSystem = instructions !== ''

  for (const raw of messages) {
    const role = raw.role ?? ''
    const blocks = (raw.content ?? []) as Block[]

    if (role === 'system' || role === 'developer') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
      if (text === '') continue
      if (!seenSystem) {
        instructions = text
        seenSystem = true
      } else {
        input.push({ role: 'system', content: [textPart('system', text)] })
      }
      continue
    }

    if (role === 'tool') {
      const res = blocks.find((b) => b.type === 'tool-result') ?? blocks[0]
      const text = typeof res?.text === 'string' ? res.text : blocks.map((b) => b.text ?? '').join('')
      input.push({
        type: 'function_call_output',
        call_id: String(raw.toolCallId ?? res?.id ?? ''),
        output: text,
      })
      continue
    }

    if (role === 'assistant') {
      const texts: string[] = []
      const calls: { call_id: string; name: string; arguments: string }[] = []
      for (const b of blocks) {
        if (b.type === 'text' && (b.text ?? '') !== '') texts.push(b.text ?? '')
        else if (b.type === 'tool-call') {
          calls.push({
            call_id: String(b.id ?? ''),
            name: String(b.name ?? ''),
            arguments: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {}),
          })
        }
        /**
         * `reasoning` 块**不单独发**：Responses 的 reasoning item 需要 `encrypted_content`
         * 之类的私有字段，DSH 内部块里没有。拍平成文本会改变 content 形态。
         * 与 `wire-openai.ts` 的降级分支同理 —— 只在没有 text 时才把 reasoning 当前缀补上。
         */
      }
      const reasoning = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text ?? '').join('')
      const text = texts.join('') === '' && calls.length === 0 ? reasoning : texts.join('')
      if (text !== '') {
        input.push({ role: 'assistant', content: [textPart('assistant', text)] })
      }
      for (const c of calls) {
        input.push({ type: 'function_call', call_id: c.call_id, name: c.name, arguments: c.arguments })
      }
      continue
    }

    /** user：文本块拼起来；图片转 `input_image`；顺手把 tool-result 拆成独立项。 */
    const texts: string[] = []
    const images: Block[] = []
    for (const b of blocks) {
      if (b.type === 'text') {
        if ((b.text ?? '') !== '') texts.push(b.text ?? '')
      } else if (b.type === 'image') {
        images.push(b)
      } else if (b.type === 'tool-result') {
        input.push({
          type: 'function_call_output',
          call_id: String(b.id ?? ''),
          output: typeof b.text === 'string' ? b.text : '',
        })
      }
    }
    const parts: unknown[] = texts.map((t) => textPart('user', t))
    for (const b of images) {
      const img = opts.resolveImage?.((b.attachment ?? {}) as { attachmentId?: string; mediaType?: string })
      if (img !== undefined) {
        parts.push({ type: 'input_image', image_url: 'data:' + img.mediaType + ';base64,' + img.base64 })
      }
    }
    if (parts.length > 0) input.push({ role: 'user', content: parts })
  }

  const body: Record<string, unknown> = {
    model: opts.model,
    input,
    stream: true,
    store: opts.store ?? false,
    max_output_tokens: opts.maxTokens,
  }
  if (instructions !== '') body.instructions = instructions
  if (Array.isArray(opts.tools) && opts.tools.length > 0) body.tools = wireTools(opts.tools)
  if (opts.reasoningEffort !== undefined) body.reasoning = { effort: opts.reasoningEffort }
  if (opts.temperature !== undefined) body.temperature = opts.temperature
  return body
}
