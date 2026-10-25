/**
 * 离线复刻 `ToolHistoryProjection`（**纯 Node，不依赖 DSH 运行时**）。
 *
 * ## 为什么必须要有它
 * `toolHistory` 决定 `tool-addition` / `developer` 消息在投影时怎么处理。
 * **真实请求必须带上它** —— 实测漏传会让缓存从 messages 第一条起整段失效：
 * 命中率从 100% 掉到 7%，单次成本从 0.0057 元涨到 0.25 元（44 倍）。
 *
 * ## 为什么是「复刻」而不是 import
 * DSH 的 `@deepseek-ai/dsh-session` 导出了 `foldSurface` / `foldRequestHeader`，
 * 但 **`ToolHistoryProjection` 没有导出**（内部类），所以只能按它的算法复刻。
 *
 * 算法（`dsh-session/lib/index.js` 643-700 行）：
 *   - `request/header`：把该 header 的 tools 记进 `headers`（供 update 反查定义）；
 *     满足「首次 / reason==='series' / startsSeries / 同名工具定义变了」时**切基线**，
 *     即 `tools` 全量替换、`updates` 清空；
 *   - `developer/message`：把 `tool-addition` 块解析成定义（按 `headerSeq` 反查）累进 `updates`；
 *   - 快照 = `{tools, updates}`（不可变）。
 */

/** 工具声明（DSH 的 wire 形态，字段原样透传）。 */
export interface ToolDecl {
  name: string
  description?: unknown
  parameters?: unknown
  [k: string]: unknown
}

/** 一条工具更新（由 developer/message 携带）。 */
export interface ToolUpdate {
  messageId: string
  additions: ToolDecl[]
}

/** `toolHistory` 快照。 */
export interface ToolHistory {
  tools: ToolDecl[]
  updates: ToolUpdate[]
}

/** 事件的最小形态（只用到这些字段）。 */
interface EventLike {
  type?: string
  seq?: number
  data?: {
    reason?: string
    startsSeries?: boolean
    header?: { tools?: ToolDecl[] }
    message?: { id?: string; content?: { type?: string; toolName?: string }[] }
    headerSeq?: number
  }
}

/**
 * 按日志顺序折叠出 `toolHistory`。
 *
 * @param events 会话事件（**必须按 seq 升序，且只含带 seq 的事件**）。
 */
export function foldToolHistory(events: readonly EventLike[]): ToolHistory {
  /** headerSeq → 该 header 的 tools（供 tool-addition 反查定义）。 */
  const headers = new Map<number, ToolDecl[]>()
  /** 当前声明序列里保留的定义（含已被移除的）。 */
  const declared = new Map<string, ToolDecl>()
  let baselineSeq: number | undefined
  let history: ToolHistory = { tools: [], updates: [] }

  for (const event of events) {
    if (event.type === 'request/header') {
      const tools = event.data?.header?.tools ?? []
      if (typeof event.seq === 'number') headers.set(event.seq, tools)
      // 同名工具定义变了 → 也必须切基线（追加语义表达不了「替换已有名字的定义」）
      const redeclared = tools.some((tool) => {
        const before = declared.get(tool.name)
        return before !== undefined && JSON.stringify(before) !== JSON.stringify(tool)
      })
      if (baselineSeq === undefined || event.data?.reason === 'series' || event.data?.startsSeries === true || redeclared) {
        baselineSeq = event.seq
        declared.clear()
        for (const tool of tools) declared.set(tool.name, tool)
        history = { tools, updates: [] }
      }
      continue
    }

    if (event.type === 'developer/message') {
      const message = event.data?.message
      if (message === undefined) continue
      const headerSeq = event.data?.headerSeq
      const definitions = headerSeq === undefined ? undefined : headers.get(headerSeq)
      const additions: ToolDecl[] = []
      for (const block of message.content ?? []) {
        if (block.type !== 'tool-addition' || block.toolName === undefined) continue
        const tool = definitions?.find((t) => t.name === block.toolName)
        // 定义查不到就跳过（原实现会抛错；离线场景下宁可少一条也不要整个失败）
        if (tool !== undefined) additions.push(tool)
      }
      for (const tool of additions) declared.set(tool.name, tool)
      history = {
        tools: history.tools,
        updates: [...history.updates, { messageId: message.id ?? '', additions }],
      }
    }
  }

  return history
}
