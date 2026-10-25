/**
 * 把「DSH 内部消息」序列化成 DeepSeek Messages API 的请求体（**纯 Node**）。
 *
 * ## 为什么 CLI 必须要这一步，而插件不需要
 * 插件走 `ctx.llm.stream()`，**DSH 的 adapter 会替它把内部块翻译成 API 变体**；
 * 独立 CLI 直连 API，就必须自己翻译 —— 否则会吃 422：
 *
 *     messages[2].content: unknown variant `reasoning`,
 *     expected one of `text`, `image`, `document`, `thinking`, `tool_use`, ...
 *
 * ## 复刻来源
 * `@deepseek-ai/dsh-llm-deepseek` 的 `serialize()`（lib/index.js 1577-1712）。
 * 逐条对齐的规则：
 *
 * | 场景 | 内部块 | API 变体 |
 * |---|---|---|
 * | assistant | `reasoning` | `thinking`（`thinking: block.text`） |
 * | assistant | `tool-call` | `tool_use`（`input` 由 arguments 反序列化） |
 * | user / tool | `reasoning`、`tool-call` | **丢弃** |
 * | developer | `tool-addition` | `tool_addition`（`tool_reference`） |
 *
 * 另外三条容易漏的：
 *  ① `developer` 消息**排在「前一个 user 回合」之后**（遇到 assistant 才 flush）；
 *  ② `tool` 角色在 wire 上变成 **`user`**，content 是 `tool_result`；
 *  ③ user 消息里的 `tool_result` 块要**重排到最前面**（API 要求 tool_result 先于其它内容）。
 */

/** 内部 content 块（只用到的字段）。 */
interface Block {
  type?: string
  text?: string
  id?: string
  name?: string
  arguments?: unknown
  toolName?: string
  attachment?: { attachmentId?: string }
  [k: string]: unknown
}

/** 内部消息。 */
export interface InternalMessage {
  role?: string
  content?: Block[]
  toolCallId?: string
  isError?: boolean
  /** assistant 消息的来源元数据（含 `replayState`：原生 thinking 签名）。 */
  source?: {
    kind?: string
    model?: string
    replayState?: unknown
    [k: string]: unknown
  }
  [k: string]: unknown
}

/**
 * 从 assistant 消息里取**原生 replay 元数据**（每个 content 块一项）。
 *
 * 为什么必须复刻：DeepSeek 的 `thinking` 块带 `signature`（服务端下发的推理签名），
 * DSH 在下一轮请求时**把它原样带回去**。漏掉它会让 thinking 块的内容不同 ——
 * 实测该会话只命中 35.5%（开头 tools+system 命中、messages 从某条 assistant 起分叉）。
 *
 * 校验条件与 `@deepseek-ai/dsh-llm-deepseek` 的 `validateReplay()` 逐条对齐，
 * 任一不满足就**整体放弃**（等于不带签名），绝不半带 —— 半带的后果是块数错位。
 */
function replayBlocks(
  message: InternalMessage,
  model: string | undefined,
): ({ type: string; signature?: string } | undefined)[] | undefined {
  const source = message.source
  if (source?.kind !== 'model' || source.replayState === undefined) return undefined
  const envelope = source.replayState as { response?: unknown; blocks?: unknown }
  const response = envelope.response as { kind?: unknown; version?: unknown; model?: unknown } | undefined
  if (response === undefined || response.kind !== 'deepseek-messages' || response.version !== 1) return undefined
  if (response.model !== source.model) return undefined
  if (model !== undefined && response.model !== model) return undefined
  const raw = envelope.blocks
  const content = message.content ?? []
  if (!Array.isArray(raw) || raw.length !== content.length) return undefined
  const out: ({ type: string; signature?: string } | undefined)[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const block = raw[i] as { type?: unknown; signature?: unknown } | null
    if (block === null || typeof block !== 'object') return undefined
    if (block.type !== content[i]?.type) return undefined
    if (block.signature !== undefined && (block.type !== 'reasoning' || typeof block.signature !== 'string')) return undefined
    out.push(typeof block.signature === 'string'
      ? { type: String(block.type), signature: block.signature }
      : { type: String(block.type) })
  }
  return out
}

/** 反序列化工具调用参数（内部是 JSON 字符串）。 */
function toolInput(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * assistant 的内容映射。
 * @param message 内部消息
 * @param model 本次请求的模型（用于校验 replay 签名的模型一致性）
 */
function assistantContent(message: InternalMessage, model?: string): unknown[] {
  const replay = replayBlocks(message, model)
  const blocks = message.content ?? []
  const out: unknown[] = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    switch (block.type) {
      case 'text':
        out.push({ type: 'text', text: block.text ?? '' })
        break
      case 'reasoning': {
        // ⚠️ 内部叫 reasoning，API 叫 thinking，字段也从 text 变成 thinking；
        //    有原生签名就**必须带上**（见 replayBlocks 的说明）
        const signature = replay?.[index]?.signature
        out.push({
          type: 'thinking',
          thinking: block.text ?? '',
          ...(signature === undefined ? {} : { signature }),
        })
        break
      }
      case 'tool-call':
        out.push({ type: 'tool_use', id: block.id, name: block.name, input: toolInput(block.arguments) })
        break
      default:
        // 未知块直接跳过：宁可少一块也不要整个请求 422
        break
    }
  }
  return out
}

/** 图片块 → 真实字节的解析器（由调用方注入，带 dshHome）。 */
export type ImageResolver = (attachment: {
  attachmentId?: string
  mediaType?: string
}) => { mediaType: string; base64: string } | undefined

/** user / tool-result 的内容映射（reasoning 与 tool-call 一律丢弃）。 */
function userContent(blocks: readonly Block[], resolveImage?: ImageResolver): unknown[] {
  const out: unknown[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if ((block.text ?? '') !== '') out.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'reasoning' || block.type === 'tool-call') continue
    if (block.type === 'image') {
      const att = block.attachment as { attachmentId?: string; mediaType?: string } | undefined
      const img = resolveImage?.(att ?? {})
      if (img !== undefined) {
        // 与真实请求逐字节一致：Anthropic 的图片块是 base64 source
        out.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } })
        continue
      }
    }
    // 读不到字节才降级（不再默认降级）
    out.push({ type: 'text', text: `[${block.type ?? 'attachment'} omitted in offline replay]` })
  }
  return out
}

/** developer 的内容映射。 */
function developerContent(blocks: readonly Block[], declaredNames?: ReadonlySet<string>): unknown[] {
  const out: unknown[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if ((block.text ?? '') !== '') out.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'tool-addition') {
      /**
       * 复刻 DSH `projectToolUpdates` 的判据：**只有最终 `wire.tools` 里存在的名字才保留**。
       *
       * 不筛的后果（实测）：声明里没有 `advisor_stage`，但 developer 消息仍引用它 → 400：
       *   `tool_addition` references unknown tool 'advisor_stage'
       */
      if (declaredNames !== undefined && !declaredNames.has(block.toolName ?? '')) continue
      out.push({ type: 'tool_addition', tool: { type: 'tool_reference', name: block.toolName } })
      continue
    }
    if (block.type === 'tool-removal') {
      /**
       * ⚠️ Messages API **只支持 `tool_addition`，没有 `tool_removal`** —— 直发会 422：
       *   `unknown variant 'tool_removal', expected one of … 'tool_addition'`
       *
       * DSH 内部允许这个块（只在 `in-history` 策略下保留），但**API 不支持就意味着
       * 真实请求也没有发它** —— 所以这里丢弃它，才是"对齐真实请求"而不是"丢内容"。
       */
      continue
    }
  }
  return out
}

/**
 * 把 DSH 的工具声明翻译成 Messages API 的形态。
 *
 * ⚠️ **字段名不同**：DSH 内部用 `parameters`，API 要 `input_schema`。
 * 不映射的话 API 会认为该工具的 schema 是 `null`，直接 400：
 *
 *     Invalid schema for function 'asar_backup': null is not of types "boolean", "object"
 *
 * `deferLoading` 等 DSH 内部字段不进 wire（API 不认识）。
 */
function wireTools(tools: readonly unknown[]): unknown[] {
  return tools.map((raw) => {
    const tool = raw as {
      name?: string
      description?: string
      parameters?: unknown
      input_schema?: unknown
    }
    return {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      input_schema: tool.input_schema ?? tool.parameters ?? { type: 'object', properties: {} },
    }
  })
}

export interface SerializeOptions {
  model: string
  maxTokens: number
  /** 顶层 system（`options.system` 与历史 system 拼接后的结果）。 */
  system?: string
  /**
   * 工具声明 —— **缓存锚点的核心，必须带**。
   * 顺序、字段都要与真实请求一致，否则前缀从工具段就断。
   */
  tools?: unknown[]
  /**
   * 最终 wire 工具名集合（`tools` 的名字集）。
   * 用于过滤 developer 消息里的 `tool_addition`：**声明里没有的名字绝不能出现**。
   * 不传就等于不筛（危险：可能 400）。
   */
  declaredNames?: ReadonlySet<string>
  /** 图片块 → 真实字节（不传就按占位文本降级）。 */
  resolveImage?: ImageResolver
  /** reasoning effort：只能是 `off` / `low` / `high` / `max`。 */
  reasoningEffort?: string
  temperature?: number
}

/**
 * 序列化成 API 请求体。
 *
 * @param messages DSH 内部消息（`deriveEventMessage` 的产物 + 末尾追加的保温问题）。
 * @param opts 模型与采样参数。
 * @returns 可直接 `JSON.stringify` 发给 Messages API 的对象。
 */
export function serializeForApi(
  messages: readonly InternalMessage[],
  opts: SerializeOptions,
): Record<string, unknown> {
  const wire: { role: string; content: unknown[] }[] = []
  /**
   * developer / 历史 system 快照攒在这里，等「前一个 user 回合」过去再插入。
   *
   * ⚠️ **这里存的是完整消息对象，不是 content 块**。曾经写成 `content: systemUpdates`
   * 直接塞进一个 system 消息里 → 请求体变成
   * `{role:'system', content:[{role:'system', content:[…]}]}` → API 直接 422：
   * `messages[3].content: missing field 'type'`。正确做法是**展开成独立消息**（与 DSH 一致）。
   */
  const systemUpdates: { role: string; content: unknown[] }[] = []
  const flushSystemUpdates = (): void => {
    if (systemUpdates.length === 0) return
    /**
     * 原实现要求「前面必须是 user 或 tool-result 回合」，否则直接抛 `unsupported`。
     * 离线装配的日志可能因压缩裁剪而不满足这个前提 —— 这里**改为照插**：
     * 宁可位置略有偏差，也**绝不静默丢内容**（丢一个 system 快照，
     * 会让它之后的所有前缀全部失配，实测把命中率从 100% 打到 70%）。
     */
    wire.push(...systemUpdates.splice(0))
  }

  let historySystem: string | undefined
  /** 是否已经出现过 system 消息（决定后续 system 是「顶层」还是「历史内快照」）。 */
  let seenSystem = false

  for (const message of messages) {
    const role = message.role ?? ''
    const blocks = message.content ?? []

    if (role === 'developer') {
      const content = developerContent(blocks, opts.declaredNames)
      // ⚠️ 包成**完整消息**再进队列（同 system 分支）—— 直接 `push(...content)` 会把 content 块
      // 当成消息推出去，请求体里就会出现 `messages[N].role=undefined`
      if (content.length > 0) systemUpdates.push({ role: 'system', content })
      continue
    }

    if (role === 'system') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
      /**
       * ⚠️ 这里两条规则都极易写错，写错就会让命中率腰斩：
       *
       * ① **只有首个 system 才是顶层 system**；压缩过的会话会在历史里**再插入若干
       *    system 快照**（本机实测某会话压缩 10 次 → 10 个历史 system），它们必须作为
       *    `system` 消息**留在对话流里**，全并到顶层会让位置整体错位、前缀当场断。
       * ② 顶层 system 是**覆盖**（`historySystem = text`），不是拼接 —— 原实现即如此。
       *
       * 判据用「是否已出现过 system」，不去读模型配置的 `systemPromptUpdate` ——
       * 更鲁棒，也不依赖拿不到 model 元数据的离线场景。
       */
      if (seenSystem) {
        systemUpdates.push({ role: 'system', content: [{ type: 'text', text }] })
      } else {
        historySystem = text
        seenSystem = true
      }
      continue
    }

    if (role === 'assistant') flushSystemUpdates()

    let content: unknown[]
    if (role === 'assistant') {
      content = assistantContent(message, opts.model)
    } else if (role === 'tool') {
      content = [{
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: userContent(blocks, opts.resolveImage),
        ...(message.isError === undefined ? {} : { is_error: message.isError }),
      }]
    } else {
      content = userContent(blocks, opts.resolveImage)
    }

    if (role === 'user' && content.length === 0) continue

    const wireRole = role === 'tool' ? 'user' : role
    const previous = wire.length > 0 ? wire[wire.length - 1] : undefined
    if (previous !== undefined && previous.role === wireRole) previous.content.push(...content)
    else wire.push({ role: wireRole, content })
  }
  flushSystemUpdates()

  // ⚠️ user 回合里的 tool_result 必须排到最前（API 的硬性要求）
  for (const message of wire) {
    if (message.role !== 'user') continue
    const results = message.content.filter((b) => (b as { type?: string }).type === 'tool_result')
    if (results.length === 0) continue
    message.content = [...results, ...message.content.filter((b) => (b as { type?: string }).type !== 'tool_result')]
  }

  const effort = opts.reasoningEffort ?? 'high'
  const allowed = ['off', 'low', 'high', 'max']
  const safeEffort = allowed.includes(effort) ? effort : 'high'
  const system = [opts.system, historySystem].filter((s) => typeof s === 'string' && s !== '').join('\n\n')

  return {
    model: opts.model,
    stream: true,
    messages: wire,
    max_tokens: opts.maxTokens,
    thinking: { type: safeEffort === 'off' ? 'disabled' : 'enabled' },
    ...(safeEffort === 'off' ? {} : { output_config: { effort: safeEffort } }),
    ...(system === '' ? {} : { system }),
    ...(opts.tools === undefined ? {} : { tools: wireTools(opts.tools) }),
    ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
  }
}
