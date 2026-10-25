/**
 * 离线装配一条保温请求 —— **纯 Node，零 DSH 依赖**。
 *
 * 这是「脱离 DSH」的核心：不启动 DSH、不 import 任何 DSH 包，直接从磁盘上的会话日志
 * 重建出与**真实请求逐字节同源**的前缀（system + tools + messages）。
 *
 * ## 装配链（每一步都有踩坑记录）
 *  ① 多帧 zstd 解码 → 事件流（`core/sessions.ts`）
 *  ② 过滤不带 `seq` 的事件（日志首行是会话头，混进去会破坏 seq 连续性）
 *  ③ `foldSurface` 折出模型可见的节点顺序（`core/surface.ts`，已与官方实现逐节点比对一致）
 *  ④ 逐节点投影成消息（空内容的 system/developer/assistant 丢弃）
 *  ⑤ `foldRequestHeader` 取最后一次请求头（config / tools）
 *  ⑥ `foldToolHistory` 重建工具声明序列
 *  ⑦ **算出 wire 层真正发出的工具声明**：`history.tools ∪ updates.additions`
 *  ⑧ 末尾追加保温问题，再修掉未闭合的 `tool_use`
 *
 * ## 为什么 ⑦ 必须这么算
 * `wire.tools = history.tools ∩ assembly`，而冻结机制保证 `assembly ⊇ history.tools`，
 * 于是 `wire ≡ history.tools`（加上尚未进基线的新工具）。
 * **不要**用 `header.tools` 当基准 —— 它只是最后一次请求的 assembly 快照，会随工具面
 * 动态缩小。实测反例（会话 `b43faaf6457e`）：`history.tools=157` 而 `header.tools=86`，
 * 用后者会让工具段当场断掉，命中率掉到 8.6%（近乎全冷启动）。
 */
import { readFileSync } from 'node:fs'
import { statSync } from 'node:fs'
import { decodeMultiFrame, inheritedSeedOf } from './sessions.ts'
import {
  deriveEventMessage,
  foldRequestHeader,
  foldSurface,
  modelSwitchNoticeMessage,
  modelSwitchOf,
  type DerivedMessage,
  type RequestConfig,
  type RequestHeader,
  type SurfaceEvent,
} from './surface.ts'
import { foldToolHistory, type ToolDecl, type ToolHistory } from './toolhistory.ts'
import { detectPrefixRewrite } from './rewrite.ts'

/** 装配结果。成功时 `error` 为 undefined。 */
export interface AssembleResult {
  /** 日志尾部是否有「压缩/goal 改写且其后无真实请求」——有则不该保（保=付全量）。 */
  rewrite?: import('./rewrite.ts').PrefixRewrite
  /**
   * **fork 继承状态导致摘要不可靠** —— 有值就说明「这条会话的首条摘要不在本会话日志里」。
   *
   * `inheritedSeedOf()` 的返回值：继承了 `session/end-seed {inherited:true}`，
   * 且它发生在最后一次 `compaction/summary` 之后（或本会话从未压缩过）。
   *
   * ⚠️ 这种会话**不该保温**：真实请求的 #1 摘要来自父会话，
   * 本会话日志里没有它 ⇒ 装配出来的 #1 必然不同 ⇒ 整条前缀 miss ⇒ 花钱买 0 命中。
   * 实测 `.tmp/spy-exp` 的 177e3411：本会话最后一条 summary 8190，真实用的是 11521。
   */
  inherited?: NonNullable<ReturnType<typeof inheritedSeedOf>>
  /** 失败原因（有值就说明装配不出来，其余字段无意义）。 */
  error?: string
  /** 完整的消息序列（**已含**末尾追加的保温问题）。 */
  messages: DerivedMessage[]
  /** wire 层真正发出的工具声明。 */
  tools: ToolDecl[]
  /** system（来自最后一次请求头；DSH 的 header 不含 system，通常为 undefined）。 */
  system: unknown
  /** 采样参数（model / provider / reasoningEffort …）。 */
  config?: RequestConfig
  /** 工具声明序列（基线 + 更新）。 */
  toolHistory: ToolHistory
  /** 最后一次请求头里的工具数（= 那一轮的 assembly 快照，诊断用）。 */
  headerToolCount: number
  stats: {
    /** 解出的事件数。 */
    events: number
    /** surface 节点数（= 折叠后的事件条数）。 */
    nodes: number
    /** 最终消息数（含末尾的保温问题）。 */
    messages: number
    /** 被删掉的未闭合 tool_use 块数（0 = 日志干净）。 */
    removedToolCalls: number
    /** 位置替换次数（> 0 说明这条会话被压缩或剪枝过）。 */
    replacements: number
    /**
     * 图片块数量。
     *
     * ⚠️ **离线装配的硬边界**：图片字节存在 DSH 的附件库里，本模块不去读，
     * 所以图片块会被降级成一句占位文本 —— 真实请求里这里是「句柄文本 + image 块」。
     * 结果是**从那一条消息起，之后的前缀全部失配**。
     * 实测 286 条可装配会话里 18 条含图片（46 个块），位置从中段到末尾都有。
     * 熔断会兜住（命中率塌了就停手），但要提前知道就看这个数。
     */
    imageBlocks: number
    /** 第一个图片块在最终消息序列里的位置比例（0~1）；没有图片时为 -1。 */
    firstImageAt: number
  }
}

/**
 * 修掉「未闭合的 `tool_use`」。
 *
 * 日志里确实会出现「assistant 发起了工具调用、但没有对应结果」的情况 ——
 * 用户打断、或 `compaction/prune` 把结果段剪掉了。而 Messages API 的硬性要求是
 * **每个 `tool_use` 后面必须紧跟对应的 `tool_result`**，否则直接 400：
 *
 *     `tool_use` ids were found without `tool_result` blocks immediately after
 *
 * 处理办法：把那条 assistant 消息里**找不到结果的 `tool-call` 块删掉**
 * （整条只剩空壳就连同消息一起丢）。
 *
 * 代价：断裂点那一小块前缀会失配。但断裂通常在会话尾部，**前面的大段前缀照样命中** ——
 * 实测某条会话 553 条消息里只有 1 处断裂，影响可忽略。
 */
export function repairUnclosedToolUse(messages: readonly DerivedMessage[]): {
  messages: DerivedMessage[]
  removed: number
} {
  const fixed: DerivedMessage[] = []
  let removed = 0
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]
    if (m.role !== 'assistant') {
      fixed.push(m)
      continue
    }
    const content = m.content ?? []
    const calls = content.filter((b) => b.type === 'tool-call')
    if (calls.length === 0) {
      fixed.push(m)
      continue
    }
    const provided = new Set<unknown>()
    for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j += 1) {
      provided.add(messages[j]['toolCallId'])
    }
    const missing = calls.filter((b) => !provided.has(b['id']))
    if (missing.length === 0) {
      fixed.push(m)
      continue
    }
    removed += missing.length
    const kept = content.filter((b) => b.type !== 'tool-call' || provided.has(b['id']))
    if (kept.length === 0) continue // 删空了就整条丢掉
    fixed.push({ ...m, content: kept })
  }
  return { messages: fixed, removed }
}

/**
 * 计算 wire 层真正发出的工具声明。
 *
 * 基线是 `history.tools`，再按记录顺序追加「尚未进基线」的新工具（`updates.additions`）。
 * 同名工具以先出现的为准（后出现的同名声明属于「定义变了 → 本该切基线」的场景，
 * 那时 `foldToolHistory` 已经把基线换掉了，这里不会走到「覆盖」分支）。
 */
export function wireToolsOf(toolHistory: ToolHistory): ToolDecl[] {
  const declarations = new Map<string, ToolDecl>()
  for (const tool of toolHistory.tools) declarations.set(tool.name, tool)
  for (const update of toolHistory.updates) {
    for (const tool of update.additions) if (!declarations.has(tool.name)) declarations.set(tool.name, tool)
  }
  return [...declarations.values()]
}

/**
 * 含**靠前**图片块的会话是否应当拒绝保温。
 *
 * 离线装配拿不到图片字节（字节在 DSH 的附件库里），前缀会与真实请求不同。
 * 这时保温不只是白花钱 —— 它会把一份**错误的前缀**写进提供方缓存、挤掉对的锚点，
 * 用户之后在 DSH 里继续这条会话反而要按未命中价重算。
 *
 * 阈值 **90%**（不是 30%）：实测 `session-…-4a24-b41a-0877f9e83a07` 的图片在 **41%** 处，
 * 离线保温只命中 **30.7%**、花 **0.2120 元**、杠杆 **1.4 倍** —— 几乎等于白花，
 * 因为图片之后的内容永远不可能命中（真实请求带真图片，我们带占位文本）。
 * 只有图片落在最后 10% 时，前面的大段前缀才值得保。
 *
 * @param stats 装配统计
 * @param force 用户显式强制
 */
export function refuseForImages(
  stats: { imageBlocks: number; firstImageAt: number },
  force = false,
): boolean {
  if (force) return false
  return stats.imageBlocks > 0 && stats.firstImageAt >= 0 && stats.firstImageAt < 0.9
}

/**
 * 装配一条会话的保温请求。
 *
 * @param logFile 会话日志绝对路径（`session.v4.jsonl.zstd`）
 * @param prompt 末尾追加的保温问题（务必极短、答案确定）
 */
/**
 * 装配结果缓存：键 = 日志文件（mtime+size）+ prompt。
 *
 * 为什么必须有：解压 + 折叠一条正常会话的日志要几百毫秒到几秒，而**保温本身不写会话日志**
 * —— 同一份日志会被反复装配（每次保温、面板打开详情、CLI 循环）。
 * 日志真变了（mtime/size 变）缓存自动失效，不会用到旧数据。
 */
const ASM_CACHE = new Map<string, { key: string; val: AssembleResult }>()
/**
 * 缓存容量。实测（2026-10-20）：`autoCount=6` 时容量 4 → **第二轮命中率 0%**（3176ms ≈ 首轮 2677ms）；
 * 提到 8 后 6 条都在缓存里。内存代价：单条装配结果最大约 1.4MB → 8 条约 11MB，可接受。
 */
const ASM_MAX = 8

function statKeyOf(file: string): string {
  try {
    const st = statSync(file)
    return st.mtimeMs + ':' + st.size
  } catch {
    return ''
  }
}

export function assembleSession(logFile: string, prompt: string): AssembleResult {
  const key = statKeyOf(logFile) + '|' + prompt
  const hit = ASM_CACHE.get(logFile)
  if (hit !== undefined && hit.key === key) {
    // 命中即提到队首（LRU）
    ASM_CACHE.delete(logFile)
    ASM_CACHE.set(logFile, hit)
    return hit.val
  }
  const val = assembleUncached(logFile, prompt)
  if (key !== '|' + prompt) {
    ASM_CACHE.set(logFile, { key, val })
    if (ASM_CACHE.size > ASM_MAX) {
      const oldest = ASM_CACHE.keys().next().value
      if (oldest !== undefined) ASM_CACHE.delete(oldest)
    }
  }
  return val
}

function assembleUncached(logFile: string, prompt: string): AssembleResult {
  const empty: AssembleResult = {
    messages: [],
    tools: [],
    system: undefined,
    toolHistory: { tools: [], updates: [] },
    headerToolCount: 0,
    stats: { events: 0, nodes: 0, messages: 0, removedToolCalls: 0, replacements: 0, imageBlocks: 0, firstImageAt: -1 },
  }

  let text = ''
  try {
    text = decodeMultiFrame(readFileSync(logFile)).text
  } catch (e) {
    return { ...empty, error: '解压会话日志失败：' + String((e as { message?: string } | undefined)?.message ?? e) }
  }

  const events: SurfaceEvent[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    let event: SurfaceEvent
    try {
      event = JSON.parse(line) as SurfaceEvent
    } catch {
      continue // 坏行（写日志时被强行中断）
    }
    // 日志首行是会话头（无 seq）；混进去会破坏「seq 从 baseSeq 起连续」的前提
    if (typeof event.seq === 'number') events.push(event)
  }
  if (events.length === 0) return { ...empty, error: '这条会话日志里没有任何带 seq 的事件' }

  let surface
  try {
    surface = foldSurface(events)
  } catch (e) {
    return { ...empty, error: '折叠 surface 失败：' + String((e as { message?: string } | undefined)?.message ?? e) }
  }

  // 按 seq 建索引：nodes 里存的是 seq，不是下标
  const bySeq = new Map<number, SurfaceEvent>()
  for (const event of events) if (typeof event.seq === 'number') bySeq.set(event.seq, event)

  /**
   * 换模型提示的插入点（`model/selection` → 一条 user 消息）。
   *
   * 规则见 `surface.ts` 的 `modelSwitchOf()`：拿**本次选择**与**它之前最近一次
   * `request/header` 的 config** 比，provider/model 不同才产生提示。
   * 插入位置是 `model/selection` 事件**之前**（它是下一个请求的开头，提示必须先于那一轮的回复）。
   *
   * 实测（`.tmp/spy-exp` 那条会话）：5 条 `model/selection` 只产生 2 条提示 ——
   * 两次 effort 变化被 `sameRoute` 挡掉，与 DSH 行为一致。
   */
  /**
   * **换模型提示的插入点**。
   *
   * 规则见 `surface.ts` 的 `modelSwitchOf()`：拿**下一个要发的请求的选择**（`model/selection`）
   * 与**它之前最近一次 `request/header` 的 config** 比，provider/model 不同才产生提示。
   *
   * ⚠️ **绝对不能用 seq 大小来定位**（踩过两次，实测记录）：
   * `foldSurface` 的 `replace` 是 `nodes.splice(…, event.seq)` —— 压缩后的节点 seq 是**压缩事件自己**的
   * seq。实测 `.tmp/spy-exp`：`surface.nodes` 开头是 `44864, 43533, 43526, …`，而 `model/selection`
   * 是 `34185` —— 拿两者比大小，提示全被排到最前。
   *
   * 正确做法：**按事件流位置**记。第一遍扫事件流，记下每条提示出现时
   * 「`surface.nodes` 里已经有几个节点」，第二遍按节点下标插入。
   * `nodes` 是**按事件流顺序**累积的（append 推入、replace 原位替换），所以「已累积个数」就是下标。
   */
  /**
   * **换模型提示的插入点**。
   *
   * ## 规则（`dsh-agent/lib/types/model-selection.js:76-88`）
   * 在 `agent/pre-step` 里把**本次选择**（`model/selection`）与**上一次请求头的 config** 比，
   * provider/model 不同就**追加一条 user 消息**（`:38`：effort-only 变化不产生）。
   * 它在下一次请求的**消息列表末尾**，所以出现在「这一轮用户输入之后、assistant 回复之前」。
   *
   * ## 定位：**绝不能比 seq 大小**（踩过两次，实测记录）
   * `foldSurface` 的 `replace` 是 `nodes.splice(…, event.seq)` —— 压缩后的节点 seq 是**压缩事件自己**的
   * seq。实测 `.tmp/spy-exp`：`surface.nodes` 开头是 `44864, 43533, 43526, …`，
   * 而 `model/selection` 是 `34185` —— 比大小会把提示排到最前。
   *
   * ## 正确做法：按**事件流顺序**数「已出现几个节点」
   * 提示插在「它之后第一个 surface 节点」**之前**（实测真实 body：#3 用户消息 → #6 提示 → #7 回复）。
   */
  const noticesAt = new Map<number, DerivedMessage[]>()
  {
    const place = (at: number | undefined, msg: DerivedMessage): void => {
      /**
       * ⚠️ **`at` 必须是数字**。若上游漏了「后面必须有存活节点」的 guard，
       * 这里会收到 `undefined` —— 塞进 `noticesAt.get(undefined)` 之后**永远读不到**，
       * 结果是「碰巧对」，但那依赖隐式行为，脆。
       *
       * 实测：删掉 `if (afterIdx === undefined) return` 后，MC5 曾经**抓不住**
       * （42/42 仍全绿）。这里显式拒绝，让漏 guard 变成**可观测的错误**而不是静默正确。
       */
      if (typeof at !== 'number' || !Number.isFinite(at)) {
        throw new Error('modelSwitchNotice 的插入位置必须是数字（说明漏了「后面必须有存活节点」的 guard）')
      }
      noticesAt.set(at, [...(noticesAt.get(at) ?? []), msg])
    }
    /**
     * ## 定位：用**节点在 `nodes` 数组里的真实下标**（rev-e 方案 A）
     *
     * 踩过的两个坑（都实测过）：
     * 1. **不能比 seq 大小**：`replace` 让节点 seq 变成压缩事件自己的，`nodes` 开头是
     *    `44864, 43533, 43526, …`，而 `model/selection` 是 `34185`。
     * 2. **不能数「事件流里已出现过几个存活节点」**：`nodes` 的排序不是事件流顺序
     *    （`44864` 在事件流最后却在 `nodes[0]`）—— 数出来恒为 0，提示全挤到最前。
     *
     * 做法：对每个切换点，找「它之后第一个仍在 `nodes` 里的节点」，取**它在数组里的下标**。
     * 找不到（那段历史已被摘要替代）⇒ **丢弃这条提示**（rev-f 的方案）。
     */
    const surfaceIdx = new Map<number, number>()
    surface.nodes.forEach((seq, i) => surfaceIdx.set(seq, i))

    let lastHeaderCfg: { provider?: unknown; model?: unknown } | undefined
    /** 连续 `model/selection` 只认最后一次（DSH 每次 pre-step 判一次）。 */
    let burstLast: { provider?: unknown; model?: unknown } | undefined
    let burstStart = -1
    const flushBurst = (startPos: number): void => {
      if (burstLast === undefined) return
      const sw = modelSwitchOf(lastHeaderCfg, burstLast)
      burstLast = undefined
      if (sw === undefined) return
      /**
       * **两条判据（不是三条）—— 实测证明第三条与第一条等价，别写冗余分支。**
       *
       * 实测 40b9（`.tmp/spy-3080`）：`foldSurface` 只剩 seq 43526 之后的 405 个节点，
       * 而 5 条 `model/selection` 与 2 个 header 变化点（34196 / 34559）**全在那之前**
       * ⇒ 那段历史已被压缩成摘要 ⇒ **真实 body 里 `[model changed]` 是 0 条**。
       * 照旧生成就会多 2 条、把后面全部顶偏。
       *
       * ```
       * ② 切换点**之后**必须存在存活节点（否则无处可插）
       * ③ 「之前最近的存活节点」与「之后最近的存活节点」之间**不许有 compaction**
       * ```
       * ③ 同时覆盖了「切换点之前一个存活节点都没有」—— 那种情况下 `beforePos = -1`，
       * 扫描区间从 0 开始，必然扫到把历史换掉的那条 compaction。
       * （曾经另写了一条 `if (beforePos < 0) return`，实测去掉后所有用例照样全绿 ⇒ 冗余，已删。）
       *
       * ⚠️ **这是保守近似**：它保证「历史已被整段替换时不乱插」，
       * 但不能证明「历史还在时一定该插」。精确规则要等 v9（压缩历史展开）把投影补全后再定。
       */
      let afterIdx: number | undefined
      let afterPos = -1
      for (let i = startPos; i < events.length; i += 1) {
        const at = surfaceIdx.get(events[i].seq)
        if (at !== undefined) {
          afterIdx = at
          afterPos = i
          break
        }
      }
      if (afterIdx === undefined) return
      /** 之前最近的存活节点（`-1` = 没有，此时 ③ 的扫描从 0 开始，自然会扫到 compaction）。 */
      let beforePos = -1
      for (let i = afterPos - 1; i >= 0; i -= 1) {
        if (surfaceIdx.has(events[i].seq)) {
          beforePos = i
          break
        }
      }
      /** ③ 两者之间不许有 compaction 断开。 */
      for (let i = beforePos + 1; i < afterPos; i += 1) {
        const t = events[i].type
        if (t === 'compaction/summary' || t === 'compaction/start' || t === 'compaction/prune') return
      }
      /** 插在「切换点之后第一个存活节点」**之前**。 */
      place(afterIdx, modelSwitchNoticeMessage(sw.from, sw.to))
    }

    for (let i = 0; i < events.length; i += 1) {
      const event = events[i]
      if (event.type === 'request/header') {
        flushBurst(i)
        const cfg = (event.data as { header?: { config?: { provider?: unknown; model?: unknown } } } | undefined)
          ?.header?.config
        if (cfg !== undefined) lastHeaderCfg = cfg
        continue
      }
      if (event.type === 'model/selection') {
        if (burstLast === undefined) burstStart = i
        burstLast = event.data as { provider?: unknown; model?: unknown }
        continue
      }
      /** 非 selection 事件：结束这一批。 */
      flushBurst(burstStart)
    }
    flushBurst(burstStart)
  }

  const messages: DerivedMessage[] = [...(noticesAt.get(0) ?? [])]
  for (let i = 0; i < surface.nodes.length; i += 1) {
    const event = bySeq.get(surface.nodes[i])
    if (event !== undefined) {
      const message = deriveEventMessage(event, surface.projectedMessages)
      if (message !== null) messages.push(message)
    }
    /** `i+1` = 处理完前 i+1 个节点；提示记在「那时已累积的节点数」上。 */
    const after = noticesAt.get(i + 1)
    if (after !== undefined) messages.push(...after)
  }

  const header: RequestHeader | undefined = foldRequestHeader(events)
  const toolHistory = foldToolHistory(events)
  const tools = wireToolsOf(toolHistory)

  // 先追加保温问题，再统一修配对 —— 保证「最后一个 tool_use」的检查覆盖到全部消息
  messages.push({
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: 'dsh-cache-keepalive-cli' },
  } as DerivedMessage)
  const repaired = repairUnclosedToolUse(messages)

  // 图片块统计：离线装配把它们降级成占位文本，从那条消息起之后的前缀都会失配
  let imageBlocks = 0
  let firstImageAt = -1
  for (let i = 0; i < repaired.messages.length; i += 1) {
    const has = (repaired.messages[i].content ?? []).some((b) => b.type === 'image')
    if (!has) continue
    if (firstImageAt < 0) firstImageAt = repaired.messages.length <= 1 ? 0 : i / (repaired.messages.length - 1)
    for (const b of repaired.messages[i].content ?? []) if (b.type === 'image') imageBlocks += 1
  }

  return {
    rewrite: detectPrefixRewrite(events),
    /**
     * **fork 继承检测**（见 `inheritedSeedOf`）：继承发生在最后一次压缩之后 ⇒ 首条摘要不可靠。
     * 调用方据此跳过保温 —— 拿不到真摘要就必然 0 命中，花钱买 0 命中是最坏结局。
     */
    ...(() => {
      const seeded = inheritedSeedOf(events)
      return seeded === undefined ? {} : { inherited: seeded }
    })(),
    messages: repaired.messages,
    tools,
    system: header?.system,
    ...(header?.config !== undefined ? { config: header.config } : {}),
    toolHistory,
    headerToolCount: Array.isArray(header?.tools) ? header.tools.length : 0,
    stats: {
      events: events.length,
      nodes: surface.nodes.length,
      messages: repaired.messages.length,
      removedToolCalls: repaired.removed,
      replacements: surface.replacements,
      imageBlocks,
      firstImageAt,
    },
  }
}


