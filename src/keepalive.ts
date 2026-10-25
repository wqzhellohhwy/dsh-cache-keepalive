/**
 * 重放：把会话的**现有投影**原样取出来，尾部加一条极短消息，发一个影子请求。
 *
 * 为什么这样做能命中缓存：请求的 system / tools / messages 与「下一次真实请求」逐字节同源
 * （都走 `session.requestHeader()` + `session.deriveMessages()`），
 * 所以前缀完全一致；尾部那条短消息之后才分岔。
 *
 * 硬约束（踩过的坑）：
 *  - **tools 必须原样带上** —— 它是 DeepSeek 缓存锚点（渲染序 tools → system → messages）的一部分，
 *    去掉它前缀立刻不同，整次保温报废。
 *  - **maxTokens 压到 1** —— 工具调用要输出几十 token 的 JSON，1 token 根本发起不了，天然防跑飞。
 *  - **绝不触碰会话日志** —— 只调 llm.stream，不走 agent loop，所以没有 append。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** 默认保温问题：答案确定、字数极短、不需要任何工具。 */
export const DEFAULT_PROMPT = 'Reply with exactly: OK'

/** 插件在会话里的来源标记（只出现在影子请求，不进日志）。 */
export const PLUGIN_ID = 'dsh-cache-keepalive'

/** agent 的最小结构（只用到这些）。 */
export interface AgentLike {
  status?: string
  session: {
    id: string
    requestHeader(): SessionHeader | undefined
    deriveMessages(): unknown[]
    /**
     * `Session.toolHistory()` —— **必须原样传给 llm.stream**。
     *
     * 它决定 `tool-addition` / `developer` 消息在投影时「延迟声明 / 保留定义」的处理方式；
     * 不传的话，投影出的 messages 字节与真实请求不同 → 缓存从 messages 第一条起全部失效。
     * 实测代价：只命中 tools 声明那 ~1.9 万 token（命中率 7%），其余 25 万全部按未命中计费。
     */
    toolHistory?(): unknown
  }
}

interface SessionHeader {
  system?: unknown
  tools?: unknown
  config?: {
    provider?: string
    model?: string
    reasoningEffort?: unknown
    temperature?: number
    maxTokens?: number
    stop?: readonly string[]
  }
}

export interface ReplayPlan {
  sessionId: string
  provider: string
  model: string
  /** 本次影子请求的 options（可直接交给 ctx.llm.stream）。 */
  request: Record<string, unknown>
  /** 尾部那条消息的文本（诊断用）。 */
  prompt: string
  /**
   * 前缀指纹：system + tools + 消息条数 + 前两条消息的哈希。
   * 两次保温之间它变了，说明缓存锚点被改写过 —— 这次不该花钱（见 `fingerprintOf`）。
   */
  fingerprint: string
}

/**
 * 前缀指纹 —— 在**花钱之前**发现「缓存锚点已经被改写」。
 *
 * 为什么必须有（2026-10-17 实测）：同一个会话 5.5 小时前保温命中 **99.9%**，换了个 DSH 实例
 * 之后再保，`promptTokens` 一字不差（275902 → 275902）却命中 **0%**，一次白烧 **0.43 元**。
 * 原因是 DSH 每轮往 system 里注入「实例身份证」（profile 名 / pid / 端口 / 工作目录），
 * 换实例就整段变 —— 长度可以刚好一样、内容不同。
 *
 * 另一类同长度改写：上下文被压缩后，开头的消息被替换成摘要。
 *
 * 所以指纹取四样：`system` + `tools` + **消息条数** + **前两条消息**。
 *  - 正常对话只在尾部追加 → 四样都不变 → 放行
 *  - 换实例 → system 变 → 拦
 *  - 上下文压缩 → 条数变 / 开头消息被换 → 拦
 */
/**
 * 只哈希**开头这几条**消息。为什么不是全部、也不是"条数"：
 *  - 全量序列化几十万 token 的会话，每个 tick 做一次太贵；
 *  - **条数绝对不能参与** —— 正常对话就是往尾部追加，条数每轮都变，
 *    拿它当判据会把正常对话全判成"前缀已变"（实测会直接死锁，见 CHANGELOG 2026-10-17）。
 * 正常追加只改尾部 → 前 8 条不变 → 放行；
 * 上下文压缩会重写开头（改成摘要）→ 前 8 条变 → 拦。
 *
 * 为什么不含 `system`：DSH 的 `request/header` 事件**不允许带 system**
 * （校验器要求 header must omit system，system 走 system/message），拿到的恒为 undefined。
 * 实例身份（profile / pid / 端口）不在 header 里，而在**开头的 system 类消息**里 ——
 * 实测落在 messages[3] 的运行时上下文快照（messages[0] 是系统提示、[1] 用户首条、
 * [2] workspace 提示、[3] 才是「当前 dsh 实例… pid …」、[4] 技能清单）。
 * 前 8 条足以覆盖它；**不要**把它调小到 2 以下，否则实例变化就检测不到了。
 */
/**
 * 指纹实现搬到 `core/fingerprint.ts`（零依赖）：独立 CLI 不能 import 本文件
 * （它依赖 `@deepseek-ai/dsh-llm`），但两边必须算**同一个**指纹。
 * 这里 import 后原样 re-export —— `export {…} from` 不会把名字带进本地作用域，本文件下面还要用。
 */
export { PREFIX_HEAD_MESSAGES, fingerprintOf }
import { PREFIX_HEAD_MESSAGES, fingerprintOf } from './core/fingerprint.ts'

/**
 * 构造重放请求。返回 null 表示这条会话还不能保温
 * （没路由过任何请求 → 拿不到 provider/model → 无从谈起缓存）。
 */
export function planReplay(agent: AgentLike, prompt: string, maxTokens: number): ReplayPlan | null {
  const session = agent.session
  const header = session.requestHeader?.()
  if (header === undefined) return null
  const config = header.config
  if (config?.provider === undefined || config.model === undefined) return null

  const messages = [
    ...session.deriveMessages(),
    createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: PLUGIN_ID },
    }),
  ]

  /**
   * 真实请求里带的 `toolHistory` 必须一起带上（见 AgentLike.session.toolHistory 的说明）。
   * 这是让「保温请求」与「真实请求」逐字节同源的最后一环；漏掉它缓存会在 messages 处整段断掉。
   */
  const toolHistory = typeof session.toolHistory === 'function' ? session.toolHistory() : undefined

  const request: Record<string, unknown> = {
    provider: config.provider,
    model: config.model,
    messages,
    // system 原样跟随上一路由请求（缓存锚点的一半）
    ...(header.system !== undefined ? { system: header.system } : {}),
    /**
     * tools 原样跟随上一路由请求 —— **这就是正确答案，不要改成"注册表里的活跃工具"。**
     *
     * 原因：`request/header` 记录的是**本轮真实的 assembly**（已含工具冻结插件
     * `dsh-tool-freeze` 补回的、注册表里已卸载的工具），而
     * `wire.tools = history.tools ∩ assembly`（见 `@deepseek-ai/dsh-llm` 的 `toolDeclarations()`）。
     * 传 `header.tools` 时，llm 层对收到的 tools 再取一次 `∩ history.tools`，
     * 得到的结果与真实请求**逐字节一致**。
     *
     * 反例（实测，会话 f-4212f29352da）：
     *   `header.tools` = 76（含 43 个注册表已卸载、被冻结插件补回的）
     *   `ctx.tools.schemas()` = 33
     *   若改传注册表的 33，llm 会算出 `76 ∩ 33 = 33`，而真实请求是 `76 ∩ 76 = 76`
     *   → 缓存从工具段整段断掉。
     */
    ...(header.tools !== undefined ? { tools: header.tools } : {}),
    ...(toolHistory !== undefined ? { toolHistory } : {}),
    // 采样参数原样跟随，避免任何一处差异改变前缀
    ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.stop !== undefined ? { stop: [...config.stop] } : {}),
    // 只有输出上限被我们覆盖：1 个 token，防跑飞
    maxTokens,
    sessionId: session.id,
  }

  return {
    sessionId: String(session.id),
    provider: config.provider,
    model: config.model,
    request,
    prompt,
    /**
     * **末尾那条「保温问题」必须排除**：它由 `createUserMessage()` 生成，带着**随机 UUID 的 `id`**，
     * 而短会话（消息 ≤ 8 条）的前 8 条切片会把它算进去 —— 于是同一条会话、同一个前缀，
     * 两次保出来的指纹也不同 → 永远判「前缀变了」、永远停保。指纹只该覆盖**缓存前缀**本身。
     */
    fingerprint: fingerprintOf({ tools: header.tools, messages: messages.slice(0, -1) }),
  }
}

/**
 * 用**离线装配**的结果构造重放请求 —— 让插件进程能保「不在本进程内」的历史会话，
 * 而且走 DSH 自己的 llm 适配器：**任何 provider/model 都能保**（DSH 按 provider 配置
 * 选端点、选协议、选 key），不再受"离线只能直连 DeepSeek"的限制。
 *
 * 与 `planReplay(agent)` 的唯一区别是数据来源：那边拿活 session 的 deriveMessages()，
 * 这边拿 `assembleSession()` 从日志重放出的同一批 messages/tools/system/toolHistory。
 */
export function planReplayFromAssembled(
  a: {
    messages: readonly unknown[]
    tools?: unknown
    system?: unknown
    toolHistory?: unknown
    config?: { provider?: string; model?: string; reasoningEffort?: string; temperature?: number; stop?: readonly string[] }
  },
  sessionId: string,
  prompt: string,
  maxTokens: number,
): ReplayPlan | null {
  const config = a.config
  if (config?.provider === undefined || config.model === undefined) return null
  const messages = [
    ...a.messages,
    createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: PLUGIN_ID },
    }),
  ]
  const request: Record<string, unknown> = {
    provider: config.provider,
    model: config.model,
    messages,
    ...(a.system !== undefined ? { system: a.system } : {}),
    ...(a.tools !== undefined ? { tools: a.tools } : {}),
    ...(a.toolHistory !== undefined ? { toolHistory: a.toolHistory } : {}),
    ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.stop !== undefined ? { stop: [...config.stop] } : {}),
    maxTokens,
    sessionId,
  }
  return {
    sessionId,
    provider: config.provider,
    model: config.model,
    request,
    prompt,
    /**
     * **末尾那条「保温问题」必须排除**：它由 `createUserMessage()` 生成，带着**随机 UUID 的 `id`**，
     * 而短会话（消息 ≤ 8 条）的前 8 条切片会把它算进去 —— 于是同一条会话、同一个前缀，
     * 两次保出来的指纹也不同 → 永远判「前缀变了」、永远停保。指纹只该覆盖**缓存前缀**本身。
     */
    fingerprint: fingerprintOf({ tools: a.tools, messages: messages.slice(0, -1) }),
  }
}

export interface ReplayUsage {
  inputTokens?: number
  cacheReadTokens?: number
  outputTokens?: number
}

export interface ReplayResult {
  ok: boolean
  usage?: ReplayUsage
  text: string
  ms: number
  error?: string
}

/** 发一次影子请求，边流边收 usage。 */
export async function runReplay(
  llm: { stream(options: object): AsyncIterable<{ type?: string; text?: string; usage?: ReplayUsage }> },
  plan: ReplayPlan,
  signal?: AbortSignal,
): Promise<ReplayResult> {
  const t0 = Date.now()
  let usage: ReplayUsage | undefined
  let text = ''
  try {
    const options = signal === undefined ? plan.request : { ...plan.request, signal }
    let lastType = ''
    for await (const chunk of llm.stream(options)) {
      const c = chunk as { type?: string; text?: string; usage?: ReplayUsage }
      if (c?.type !== undefined) lastType = c.type
      /**
       * **任何带 usage 的 chunk 都收** —— 不同 provider 适配器的 usage 挂在不同的 chunk 上：
       * deepseek 发 `{type:'usage'}`，pi-ai 那类可能挂在 `message-stop` / `done` 上。
       * 只认 `type === 'usage'` 会让第三方 provider 永远拿不到 usage → 保温被判失败。
       */
      if (c?.usage !== undefined) usage = c.usage
      else if (c?.type === 'text-delta' && typeof c.text === 'string') text += c.text
    }
    if (usage === undefined) {
      return { ok: false, text, ms: Date.now() - t0, error: '没有拿到 usage（最后一个 chunk 类型：' + (lastType || '无') + '）' }
    }
  } catch (error) {
    return { ok: false, text, ms: Date.now() - t0, error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, usage, text, ms: Date.now() - t0 }
}
