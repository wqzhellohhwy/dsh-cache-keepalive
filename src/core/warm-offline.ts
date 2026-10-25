/**
 * **离线保温** —— 不发请求的那部分都在这：装配 + 序列化 + 直连 API + 解析 usage。
 *
 * ## 为什么插件也需要它
 * 去掉「激活」之后，面板上每条会话都显示「立刻保温」。但插件的 `/ping` 原先是
 * `resolveAgent(id)` —— 只能找到**本进程内**的 agent，历史会话一律「找不到会话」。
 * 实测用户点 `session-...-4a24-b41a-0877f9e83a07` 就报这个错。
 *
 * 所以：**活会话用活 agent 保，历史会话用这个模块保**，面板对两者行为一致。
 * CLI 也走同一套（以前是 CLI 里的一份私有实现，现在收敛到这里）。
 *
 * ## 认证
 * 插件侧本可以用 `ctx.llm`，但离线路径没有 agent、也就没有路由上下文，
 * 只能自己读 key 直连 —— 与 CLI 完全相同：
 * `DEEPSEEK_API_KEY` → `$DSH_HOME/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assembleSession, refuseForImages, type AssembleResult } from './assemble.ts'
import { serializeForApi } from './wire.ts'
import { serializeForOpenAI } from './wire-openai.ts'
import { serializeForResponses } from './wire-responses.ts'
import { apiKindOf, type ApiKind } from '../api-kind.ts'
import { loadProviders } from './providers.ts'
import { currentReasoningEffortOf, instructionRoleOf, maxTokensFieldOf, providerMetaOf, thinkingParamsOf } from './provider-meta.ts'
import { readAttachment } from './attachments.ts'

/** 保温请求的输出上限：1 个 token，防跑飞。 */
export const WARM_MAX_TOKENS = 1

/** 请求超时默认值：30 秒。**必须真用** —— 原来只在接口里声明、实现从未使用，
 * 一个永不返回的连接会让保温永久挂住（进程不崩但停摆）。 */
export const DEFAULT_WARM_TIMEOUT_MS = 30_000

/** 把「外部取消信号」与「超时信号」合成一个（Node 20+ 的 `AbortSignal.any`）。 */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** 默认 API 根（DeepSeek 的 Anthropic 兼容端点）。 */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic'

/** 读 API Key。 */
export function loadApiKey(dshHome?: string): string | undefined {
  const fromEnv = process.env.DEEPSEEK_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const file = join(home, '.credentials.yaml')
  if (!existsSync(file)) return undefined
  try {
    const text = readFileSync(file, 'utf8')
    // 极简 YAML 取值：refs 段下的 DEEPSEEK_API_KEY
    const m = /^\s*DEEPSEEK_API_KEY:\s*(.+?)\s*$/mu.exec(text)
    return m === null ? undefined : m[1].replace(/^["']|["']$/gu, '')
  } catch {
    return undefined
  }
}

/**
 * 非 DeepSeek 提供方的会话能不能离线保 —— 返回拒绝原因，可保则 undefined。
 * 三处入口都要过（独立面板 / --once / --loop 都走 prepareWarm；插件侧走本模块）。
 */
export function providerRefusal(provider: string | undefined): string | undefined {
  if (typeof provider !== 'string' || provider === '') return undefined
  if (/deepseek/iu.test(provider)) return undefined
  /**
   * 用户**显式指定了端点**（`DEEPSEEK_BASE_URL`）就放行 —— 他自己承担把它发到那个端点。
   * 早先文案里写着「可用 DEEPSEEK_BASE_URL 改端点」却不看这个变量，照做也没用。
   */
  const own = process.env.DEEPSEEK_BASE_URL
  if (typeof own === 'string' && own !== '') return undefined
  return `这条会话走的是 ${provider} 提供方，离线保温只能直连 DeepSeek。`
    + '要么在 DSH 里用它聊一句（路由刷新后仍不一定能用），要么设 DEEPSEEK_BASE_URL 指向你自己的端点'
}

/** 本次调用的 usage（与插件侧口径一致：`inputTokens` = 未命中）。 */
export interface OfflineUsage {
  inputTokens?: number
  cacheReadTokens?: number
  /** 本次新建缓存的 token（`cache_creation_input_tokens`）；OpenAI 兼容端点没有这个字段。 */
  cacheWriteTokens?: number
  outputTokens?: number
  totalTokens?: number
  /**
   * 提供方是否报告了缓存命中数。
   * 第三方（tokenrhythm 等）常只回 prompt_tokens、不带 cached_tokens —— 此时命中率**未知**，
   * 不能当成 0 命中去熔断（那会把还能用的 provider 直接停掉）。
   */
  cacheKnown?: boolean
}

export interface OfflineWarmResult {
  ok: boolean
  /** 失败原因。 */
  error?: string
  /** 请求体里的消息数 / 工具数（诊断）。 */
  messages?: number
  tools?: number
  /** 实际用的模型（记账计价要用）。 */
  model?: string
  /** 装配统计（压缩次数 / 未闭合 tool_use / 图片块）。 */
  stats?: { events: number; nodes: number; messages: number; removedToolCalls: number; replacements: number; imageBlocks: number; firstImageAt: number }
  ms?: number
  usage?: OfflineUsage
  /** 原始响应（截断前由调用方决定怎么展示）。 */
  raw?: unknown
}

export interface OfflineWarmOptions {
  /** 会话日志绝对路径。 */
  logFile: string
  /** 末尾追加的保温问题。 */
  prompt: string
  /** DSH 主目录（读凭据用）。 */
  dshHome?: string
  /** API Key；不传就自己读。 */
  apiKey?: string
  /** API 根；默认 `DEEPSEEK_API_ROOT` 环境变量或官方地址。 */
  baseUrl?: string
  /** 输出上限（默认 1）。 */
  maxTokens?: number
  /** 请求超时（毫秒，默认 **30 秒**）。超时按失败处理（会进退避表，不会挂住进程）。 */
  timeoutMs?: number
  /** 外部取消信号。 */
  signal?: AbortSignal
  /**
   * 含靠前图片块时是否拒绝发请求（默认 **true**）。
   *
   * 为什么必须在**发请求前**拦：图片字节在 DSH 附件库里、离线拿不到，
   * 装配出的前缀会与真实请求不同 —— 发了就是「付一次钱买一段永远命中不了的尾巴」，
   * 还会把错误的前缀写进提供方缓存。实测 41% 处的图片只换来 30.7% 命中、花 0.21 元。
   */
  refuseImages?: boolean
}

/**
 * 把装配结果翻译成「真实请求的形状」——**唯一判定入口**，调用方不许自己拼。
 *
 * 三个值都来自 `provider-meta.ts`（按 profile 配置 + pi-ai 的 detectCompat 名单推）：
 *  - `instructionRole`：第 0 条 role（实测 tokenrhythm 的 v4.1 发 `developer`）
 *  - `thinking` / `reasoningEffort`：顶层思考参数
 *  - `maxTokensField`：输出上限的键名（`max_tokens` 还是 `max_completion_tokens`）
 *
 * 配置读不到 → 全部退回**旧行为**（`system` / 无 thinking / `max_tokens`），绝不猜。
 *
 * @param plan 装配结果
 * @param dshHome DSH 主目录（读 profile 配置用）
 */
export function wireShapeOf(plan: AssembleResult, dshHome?: string): {
  instructionRole: 'system' | 'developer'
  thinking?: { type: 'enabled' | 'disabled' }
  reasoningEffort?: string
  maxTokensField: 'max_tokens' | 'max_completion_tokens'
} {
  const provider = plan.config?.provider
  const model = plan.config?.model
  const meta = typeof provider === 'string' && typeof model === 'string'
    ? providerMetaOf(dshHome, provider, model)
    : undefined
  if (meta === undefined) {
    return { instructionRole: 'system', maxTokensField: 'max_tokens' }
  }
  /**
   * **思考档位：优先 `request/header` 的历史值**，只有它缺失时才回退到当前 profile 配置。
   *
   * ## 为什么必须优先历史
   * 离线保温的本质是「**复现这条会话的下一次请求**」——用的应该是**这条会话的历史状态**，
   * 不是别的会话、也不是当前的全局配置。
   * 实测 40b9（`.tmp/spy-3080`）：抓包那一刻 `request/header` 是 `reasoningEffort: off`，
   * 用当前配置（`agent-default-model.reasoningEffort: high`）去覆盖，
   * 就把本来对的 `thinking:{type:'disabled'}` 改成了 `enabled` → 顶层参数反而错了。
   *
   * 如果用户中途改过 effort，`request/header` 会在下一次真实请求时更新，插件自然跟上。
   *
   * ⚠️ **已知限制**：在线保温（`ping()` → DSH adapter）用的是 **agent 当前选择**；
   * 两者在「用户中途改过 effort」时会不同。但离线拿不到运行时对象，
   * **优先复现历史才是正确取向**。
   */
  const effort = plan.config?.reasoningEffort ?? currentReasoningEffortOf(dshHome)
  const t = thinkingParamsOf(meta, effort)
  return {
    instructionRole: instructionRoleOf(meta),
    ...(t.thinking === undefined ? {} : { thinking: t.thinking }),
    ...(t.reasoning_effort === undefined ? {} : { reasoningEffort: t.reasoning_effort }),
    maxTokensField: maxTokensFieldOf(meta),
  }
}

/**
 * **把三种协议的 usage 映射到插件内部同一口径**。
 *
 * ```
 * 内部口径：inputTokens = 未命中、cacheReadTokens = 命中、cacheWriteTokens = 新建缓存、outputTokens = 输出
 * ```
 *
 * ⚠️ **API 用 snake_case，DSH 内部用 camelCase** —— 直接当 camelCase 读会全是 0。
 *
 * ## 三种协议的关键差别：`input_tokens` 到底是不是总长
 *
 * | 协议 | 未命中 | 命中 | 总长口径 |
 * |---|---|---|---|
 * | Anthropic Messages | `input_tokens` **就是未命中** | `cache_read_input_tokens` | input+read+write |
 * | OpenAI Chat Completions | `prompt_tokens - cached` | `prompt_tokens_details.cached_tokens` 或 `prompt_cache_hit_tokens` | `prompt_tokens` 是**总长** |
 * | OpenAI Responses | `input_tokens - cached` | `input_tokens_details.cached_tokens` | `input_tokens` 是**总长** |
 *
 * 早先一律当总长处理 → `input_tokens=194 / read=207360` 被算成 0 未命中、命中率 100%（真实 99.9%）。
 *
 * @param raw 响应里的 `usage` 对象
 */
export function parseUsage(raw: Record<string, unknown> | undefined): OfflineUsage {
  const u = (raw ?? {}) as Record<string, unknown>
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const obj = (v: unknown): Record<string, unknown> | undefined =>
    (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined)

  const read = num(u['cache_read_input_tokens'])
  const hit = num(u['prompt_cache_hit_tokens'])
  const write = num(u['cache_creation_input_tokens'])
  const chatCached = num(obj(u['prompt_tokens_details'])?.['cached_tokens'])
  const respCached = num(obj(u['input_tokens_details'])?.['cached_tokens'])
  const cached = read ?? hit ?? chatCached ?? respCached ?? 0

  /**
   * Anthropic 的 `input_tokens` 是**未命中**，OpenAI 两家的都是**总长**。
   *
   * ⚠️ 判据**不能**用「有没有 anthropic 专属字段」单独决定：Responses 只有
   * `input_tokens` + `input_tokens_details`，没有 `cache_read_input_tokens`，
   * 那样会把它误判成 Anthropic，进而把命中率算成 0。
   *
   * 正确判据：
   *  - 出现 `prompt_tokens` 或 `*_tokens_details` ⇒ 一定是 OpenAI 系（总长口径）
   *  - 否则出现 `cache_read_input_tokens` / `cache_creation_input_tokens` ⇒ Anthropic
   */
  const openAiStyle = num(u['prompt_tokens']) !== undefined
    || obj(u['prompt_tokens_details']) !== undefined
    || obj(u['input_tokens_details']) !== undefined
  const isAnthropicStyle = !openAiStyle && (read !== undefined || write !== undefined)
  const total = isAnthropicStyle
    ? (num(u['input_tokens']) ?? 0) + cached + (write ?? 0)
    : (num(u['input_tokens']) ?? num(u['prompt_tokens']) ?? 0)

  const usage: OfflineUsage = {
    inputTokens: isAnthropicStyle
      ? (num(u['input_tokens']) ?? 0)
      : Math.max(0, total - cached - (write ?? 0)),
    outputTokens: num(u['output_tokens']) ?? num(u['completion_tokens']) ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: write ?? 0,
  }
  usage.cacheKnown = read !== undefined || hit !== undefined || chatCached !== undefined || respCached !== undefined
  usage.totalTokens = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.outputTokens ?? 0)
  return usage
}

/** `buildRequest` 的入参。 */
export interface BuildRequestOptions {
  messages: Parameters<typeof serializeForApi>[0]
  model?: string
  system?: unknown
  tools: readonly unknown[]
  maxTokens: number
  reasoningEffort?: string
  wireShape: ReturnType<typeof wireShapeOf>
  /** 端点根（不含路径）。 */
  baseURL: string
  /** 已解析的 key。 */
  apiKey: string
  resolveImage?: Parameters<typeof serializeForApi>[1]['resolveImage']
}

/** 一条待发的 HTTP 请求（纯数据，便于断言）。 */
export interface BuiltRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/**
 * **按协议构造保温请求** —— 纯函数、不联网。
 *
 * 三条分支的差别全部收敛在这里，调用方只看 `apiKind`：
 *
 * | apiKind | URL 后缀 | 鉴权头 | body 序列化器 |
 * |---|---|---|---|
 * | `openai-completions` | `/chat/completions` | `authorization: Bearer` | `serializeForOpenAI` |
 * | `openai-responses` | `/responses` | `authorization: Bearer` | `serializeForResponses` |
 * | `anthropic-messages` | `/v1/messages` | `x-api-key` + `anthropic-version` | `serializeForApi` |
 *
 * 三种都发**非流式**（`stream:false`）：离线只要 usage，拿完整 JSON 更简单。
 *
 * @param kind 协议
 * @param o 入参
 */
export function buildRequest(kind: ApiKind, o: BuildRequestOptions): BuiltRequest {
  const root = o.baseURL.replace(/\/+$/u, '')
  const json = 'application/json'
  if (kind === 'openai-responses') {
    const body = serializeForResponses(o.messages, {
      model: o.model ?? '',
      maxTokens: o.maxTokens,
      ...(o.system === undefined ? {} : { system: String(o.system) }),
      ...(o.tools.length === 0 ? {} : { tools: [...o.tools] }),
      ...(o.reasoningEffort === undefined ? {} : { reasoningEffort: o.reasoningEffort }),
      ...(o.resolveImage === undefined ? {} : { resolveImage: o.resolveImage }),
    })
    body.stream = false
    return {
      url: root + '/responses',
      headers: { 'content-type': json, authorization: 'Bearer ' + o.apiKey },
      body: JSON.stringify(body),
    }
  }
  if (kind === 'openai-completions') {
    const body = serializeForOpenAI(o.messages, {
      model: o.model ?? '',
      maxTokens: o.maxTokens,
      ...(o.system === undefined ? {} : { system: String(o.system) }),
      ...(o.tools.length === 0 ? {} : { tools: [...o.tools] }),
      ...(o.resolveImage === undefined ? {} : { resolveImage: o.resolveImage }),
      ...o.wireShape,
    })
    body.stream = false
    delete body.stream_options
    return {
      url: root + '/chat/completions',
      headers: { 'content-type': json, authorization: 'Bearer ' + o.apiKey },
      body: JSON.stringify(body),
    }
  }
  const tools = [...o.tools] as { name?: string }[]
  const body = serializeForApi(o.messages, {
    model: o.model ?? 'deepseek-flash',
    maxTokens: o.maxTokens,
    ...(o.system === undefined ? {} : { system: String(o.system) }),
    ...(tools.length === 0 ? {} : { tools, declaredNames: new Set(tools.map((t) => String(t.name ?? ''))) }),
    ...(o.reasoningEffort === undefined ? {} : { reasoningEffort: o.reasoningEffort }),
    ...(o.resolveImage === undefined ? {} : { resolveImage: o.resolveImage }),
  })
  body.stream = false
  return {
    url: root + '/v1/messages',
    headers: { 'content-type': json, 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  }
}

/**
 * 掉一次真实保温请求（离线装配 + 直连）。
 *
 * @param options 参数
 */
export async function warmOffline(options: OfflineWarmOptions): Promise<OfflineWarmResult> {
  /**
   * **真超时**：`timeoutMs` 以前只在接口里声明、实现从未使用 —— 一个永不返回的连接会让
   * 保温永久挂住（进程不崩但停摆）。现在与外部 `signal` 合成一个，超时按失败处理。
   */
  const reqSignal = withTimeout(options.signal, options.timeoutMs ?? DEFAULT_WARM_TIMEOUT_MS)
  const plan: AssembleResult = assembleSession(options.logFile, options.prompt)
  if (plan.error !== undefined) return { ok: false, error: '装配失败：' + plan.error }
  /**
   * **止损：fork 会话的摘要不可靠 → 不保温，不花钱。**
   *
   * `session/end-seed {inherited:true}` 表示这条会话 fork 自别的会话，继承了它的状态，
   * 但**继承进来的摘要不落盘**。于是本会话日志里最后一条 `compaction/summary` ≠ 真实用的那份
   * （实测 177e3411：本会话 8190，真实 11521）⇒ 从 #1 就不同 ⇒ **整条前缀 miss**。
   *
   * **花钱买 0 命中是最坏结局**，所以宁可不动。
   * 想保的话：在会话里发一条真实消息（重建缓存后再保），或等父链摘要能取到时再放开。
   */
  if (plan.inherited?.afterLastSummary === true) {
    /**
     * 打出**判定依据**：以后真遇到「fork 后从未压缩」的会话，
     * 日志里 `reason=no-summary` 会明确告诉你「放行了、因为没有摘要」——
     * 出问题时能一眼分清是误放还是正常，不用再靠推断。
     */
    process.stderr.write(
      `[warm-offline] 跳过 fork 继承会话（reason=${plan.inherited.reason}, `
      + `seedAt=${plan.inherited.at}, lastSummarySeq=${String(plan.inherited.lastSummarySeq)}）\n`,
    )
    return {
      ok: false,
      error: '这条会话是 fork 继承来的（`session/end-seed {inherited:true}` 在最后一次压缩之后，'
        + `reason=${plan.inherited.reason}），它的首条摘要来自父会话、没有落进本会话日志 → `
        + '保了必然 0 命中，已跳过（没花钱）。'
        + '要么在会话里发一条真实消息重建缓存，要么等父链摘要可取时再保。',
      stats: plan.stats,
      messages: plan.stats.messages,
      tools: plan.tools.length,
    }
  }
  const providerName = plan.config?.provider
  /**
   * 第三方 provider：只要 DSH 的 profile 配置里有它（baseURL + apiKeyEnv），
   * 就按 OpenAI Chat Completions 直连，用它自己的 key —— 这时**不需要 DeepSeek 的 key**。
   */
  const third = typeof providerName === 'string' ? loadProviders(options.dshHome).get(providerName) : undefined
  const useThird = third !== undefined && third.apiKey !== undefined ? third : undefined
  /**
   * 只有「直连 DeepSeek」才需要 DeepSeek 的 key。原先这个检查在最前面，
   * 于是第三方会话在没有 DEEPSEEK_API_KEY 的机器上报「找不到 API Key」—— 明明走不到那条路。
   */
  const apiKey = useThird !== undefined ? undefined : (options.apiKey ?? loadApiKey(options.dshHome))
  if (useThird === undefined) {
    /**
     * **配了但缺 key** 与「压根没配」要分开说：前者去补那个 provider 的 key，
     * 后者才是「只能直连 DeepSeek」—— 混在一起会把用户指向错误的修法。
     * ⚠️ 必须先判这个再判 DeepSeek 的 key，否则用户只会看到「找不到 API Key」。
     */
    if (third !== undefined) {
      return {
        ok: false,
        error: '提供方 ' + providerName + ' 已配置（' + third.baseURL + '），但没读到它的 API Key：'
          + '检查 $DSH_HOME/.credentials.yaml 的 refs 段有没有 ' + (third.apiKeyEnv ?? '对应变量'),
        stats: plan.stats,
        messages: plan.stats.messages,
        tools: plan.tools.length,
      }
    }
    /** 顺序固定：配了但缺 key（上面）→ 没配（只能直连 DeepSeek）→ DeepSeek 缺 key。 */
    const refusal = providerRefusal(providerName)
    if (refusal !== undefined) {
      return { ok: false, error: refusal, stats: plan.stats, messages: plan.stats.messages, tools: plan.tools.length }
    }
    if (apiKey === undefined) {
      return {
        ok: false,
        error: '找不到 API Key（设 DEEPSEEK_API_KEY，或写进 $DSH_HOME/.credentials.yaml 的 refs 段）',
        stats: plan.stats,
        messages: plan.stats.messages,
        tools: plan.tools.length,
      }
    }
  }
  /** 图片块 → 真实字节（附件库）。读不到返回 undefined。 */
  const resolveImage = (att: { attachmentId?: string; mediaType?: string }) =>
    readAttachment(options.dshHome, att.attachmentId, att.mediaType)
  /**
   * 含图片的会话：**先试着把图片读出来**。读得到就正常保（前缀与真实请求一致），
   * 读不到才拒绝 —— 以前一律拒绝，等于「含图片的会话永远不能保」。
   */
  let missingImages = 0
  for (const m of plan.messages) {
    for (const b of (m.content ?? []) as { type?: string; attachment?: { attachmentId?: string; mediaType?: string } }[]) {
      if (b.type !== 'image') continue
      if (resolveImage(b.attachment ?? {}) === undefined) missingImages += 1
    }
  }
  if (options.refuseImages !== false && missingImages > 0 && refuseForImages(plan.stats)) {
    return {
      ok: false,
      error: `含 ${plan.stats.imageBlocks} 个图片块（第一个在 ${Math.round(plan.stats.firstImageAt * 100)}% 处），其中 ${missingImages} 个`
        + '从附件库读不到字节：那条之后的前缀永远命中不了，保了既白花钱又会污染缓存',
      stats: plan.stats,
      messages: plan.stats.messages,
      tools: plan.tools.length,
    }
  }

  /**
   * 必须经 `serializeForApi`：DSH 内部的块名与 API 变体名不同
   * （`reasoning` → `thinking`、`tool-call` → `tool_use`），直发会吃 422。
   */
  const t0 = Date.now()
  let res: Response
  /** 真实请求的形状（role / thinking / 输出上限键名）——**全部由 `provider-meta` 判定，不硬编码**。 */
  const wireShape = wireShapeOf(plan, options.dshHome)
  /**
   * **协议判定**：按 provider 配置里声明的 `api` 字段走，不再用「第三方 vs 官方」二分。
   *
   * 二分把两件事混在一起了 —— 同一家供应商可以只开 Anthropic 端点
   * （`api.deepseek.com/anthropic`），第三方也可以开 Responses 端点。
   */
  const apiHint = third?.api
  const baseURLOf = useThird !== undefined
    ? useThird.baseURL
    : (options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL)
  const apiKind = apiKindOf(
    typeof providerName === 'string' ? providerName : 'deepseek',
    baseURLOf,
    apiHint,
  )
  /**
   * **按协议构造真正的请求**（URL + headers + body）—— 纯函数、不联网，便于用桩 fetch 断言。
   */
  const req = buildRequest(apiKind, {
    messages: plan.messages,
    model: plan.config?.model,
    system: plan.system,
    tools: plan.tools,
    maxTokens: options.maxTokens ?? WARM_MAX_TOKENS,
    reasoningEffort: plan.config?.reasoningEffort as string | undefined,
    wireShape,
    baseURL: baseURLOf,
    apiKey: String(useThird?.apiKey ?? apiKey ?? ''),
    resolveImage,
  })
  try {
    res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: reqSignal,
    })
  } catch (e) {
    return { ok: false, error: '请求失败：' + String((e as { message?: string } | undefined)?.message ?? e) }
  }
  const ms = Date.now() - t0
  const json = (await res.json().catch(() => ({}))) as { usage?: Record<string, number>; error?: unknown }
  if (!res.ok) {
    const detail = JSON.stringify(json).slice(0, 300)
    /**
     * 模型下线是**数据问题、不是代码问题**：这条会话最后还是用 `dots3-note-prev` 这条
     * 已经不被支持的模型（实测提供方回「supported API model names are …」）。
     * 换模型去保没有意义 —— 得在 DSH 里用它聊一句，路由才会刷新。
     */
    const modelGone = /supported API model names/iu.test(detail)
    return {
      ok: false,
      error: modelGone
        ? `这条会话用的模型已不可用（${plan.config?.model ?? '未知'}）。换模型保没有意义 —— `
          + '在 DSH 里给它发一句话会刷新路由，之后就能保了。原始响应：' + detail
        : `HTTP ${res.status}：${detail}`,
      ms,
    }
  }
  const usage = parseUsage(json.usage)
  return {
    ok: true,
    messages: plan.stats.messages,
    tools: plan.tools.length,
    model: plan.config?.model,
    stats: plan.stats,
    ms,
    usage,
    raw: json,
  }
}

