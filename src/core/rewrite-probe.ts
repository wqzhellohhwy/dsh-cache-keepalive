/**
 * 「改写事件」的原因探测（纯函数，只吃 events 数组）。
 *
 * 单独成文件是为了**避免循环依赖**：`core/rewrite.ts` 已 import `core/sessions.ts` 的
 * decodeMultiFrame，而 `sessions.ts` 的 readMarks 又要用同一套探测。
 *
 * 真实日志实测的数据形状（2026-10，391 个会话）：
 *  - `compaction/prune|summary` 的 data：`{ shadowedSeqs: number[], shadowedTokenCount: number, ... }`
 *  - `request/header` 的 data：`{ header: { config, adapterDefaults, tools }, reason }`
 *    —— **tools 在 data.header.tools 里**；header 里没有 system 字段，
 *    所以 goal 改 system 永远无法确认，只能写「可能」。
 */
export type ToolFace = 'same' | 'def-changed' | 'toolset-changed' | 'unknown'

export interface MarkProbe {
  sub: 'summary' | 'prune' | 'goal'
  /** shadowedSeqs.length */
  shadowedCount?: number
  /** shadowedTokenCount（原样，未格式化） */
  shadowedTokens?: number
  /** 被遮蔽事件的 type 分布，如 { 'tool/result': 1 } */
  droppedTypes?: Record<string, number>
  /** 剪枝/压缩前后的工具面比对；goal 没有。 */
  toolFace?: ToolFace
}

interface Ev {
  type?: string
  seq?: number
  data?: unknown
}

interface HeaderBody {
  tools?: { name?: string }[]
}

function headerOf(ev: Ev): HeaderBody {
  const d = (ev.data ?? {}) as { header?: HeaderBody }
  return d.header ?? {}
}

/** 完整工具定义指纹 + 仅名字列表。名字用 \u0000 连接，不会被工具名里的字符误撞。 */
function toolsSig(ev: Ev): { full: string; names: string } {
  const tools = Array.isArray(headerOf(ev).tools) ? headerOf(ev).tools! : []
  return {
    full: JSON.stringify(tools),
    names: tools.map((t) => String((t && t.name) ?? '')).join('\u0000'),
  }
}

/**
 * 工具面比对：取 `idx` 之前**最后一条** `request/header` 与之后**第一条**，比 `tools`。
 *  - 完整指纹相同 → same
 *  - 不同但名字列表相同 → def-changed（工具定义内容变了）
 *  - 不同且名字列表不同 → toolset-changed（工具增删）
 *  - 前后缺任一侧（剪枝后还没发过请求 / 日志开头没有 header）→ unknown
 */
export function toolFaceAt(events: readonly Ev[], idx: number): ToolFace {
  let before = -1
  let after = -1
  for (let i = 0; i < events.length; i++) {
    if (events[i].type !== 'request/header') continue
    if (i < idx) before = i
    else if (after < 0) after = i
  }
  if (before < 0 || after < 0) return 'unknown'
  const a = toolsSig(events[before])
  const b = toolsSig(events[after])
  if (a.full === b.full) return 'same'
  if (a.names === b.names) return 'def-changed'
  return 'toolset-changed'
}

/** 把 shadowedSeqs（seq 数组）反查成事件 type 分布；查不到任何事件 → undefined。 */
export function droppedTypesOf(
  events: readonly Ev[],
  seqs: readonly unknown[] | undefined,
): Record<string, number> | undefined {
  if (!Array.isArray(seqs) || seqs.length === 0) return undefined
  const want = new Set<number>()
  for (const s of seqs) {
    const n = typeof s === 'number' ? s : Number(s)
    if (Number.isFinite(n)) want.add(n)
  }
  if (want.size === 0) return undefined
  const out: Record<string, number> = {}
  for (const ev of events) {
    const n = typeof ev.seq === 'number' ? ev.seq : Number(ev.seq)
    if (!want.has(n)) continue
    const t = typeof ev.type === 'string' && ev.type !== '' ? ev.type : '(无类型)'
    out[t] = (out[t] ?? 0) + 1
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 对 events[idx] 这条例外事件做完整探测。 */
export function probeMark(events: readonly Ev[], idx: number): MarkProbe {
  const ev = events[idx]
  if (ev === undefined) return { sub: 'goal' }
  if (ev.type === 'goal/change') return { sub: 'goal' }
  const sub: 'summary' | 'prune' = ev.type === 'compaction/summary' ? 'summary' : 'prune'
  const d = (ev.data ?? {}) as { shadowedSeqs?: unknown[]; shadowedTokenCount?: number }
  const seqs = Array.isArray(d.shadowedSeqs) ? d.shadowedSeqs : undefined
  return {
    sub,
    ...(seqs === undefined ? {} : { shadowedCount: seqs.length }),
    ...(typeof d.shadowedTokenCount === 'number' ? { shadowedTokens: d.shadowedTokenCount } : {}),
    ...(() => {
      const dt = droppedTypesOf(events, seqs)
      return dt === undefined ? {} : { droppedTypes: dt }
    })(),
    toolFace: toolFaceAt(events, idx),
  }
}

/** readMarks 产出的一条 mark（结构对齐 `ComputeMark`；不 import sessions.ts 以免循环依赖）。 */
export interface MarkLike {
  kind: 'compaction' | 'goal'
  sub: 'summary' | 'prune' | 'goal'
  at: number
  seq: number
  text: string
  shadowedCount?: number
  shadowedTokens?: number
  droppedTypes?: Record<string, number>
  toolFace?: ToolFace
}

/**
 * 时间轴 mark item 的**唯一工厂**。
 *
 * 为什么必须唯一：有实例时面板走 `index.ts` 的 timeline，`cli --serve` 走 `core/panel-service.ts`，
 * 两条路径各写一份字面量必然分叉（已发生两次：漏 `shadowedTokens` → 右侧 token 消失；
 * 漏 `sub/toolFace` → 摘要化被误标成「剪掉历史对话」、工具面一律「未确认」）。
 */
export function markItem(m: MarkLike): Record<string, unknown> {
  return {
    kind: 'mark',
    /** 时间轴「档位」判据：round / warm / mark。切档用它，**别用 `gran`**（那是 compaction/goal 细分，UI 靠它选图标）。 */
    source: 'mark',
    gran: m.kind,
    sub: m.sub,
    time: m.at,
    seq: m.seq,
    text: m.text,
    shadowedCount: m.shadowedCount ?? 0,
    shadowedTokens: m.shadowedTokens ?? 0,
    droppedTypes: m.droppedTypes ?? {},
    toolFace: m.toolFace ?? '',
    hitTokens: 0,
    missTokens: 0,
    outputTokens: 0,
    hitRate: 0,
    cost: 0,
    via: '',
    cycle: 0,
    touch: 0,
    ms: 0,
    model: '',
    factor: 1,
    factorLabel: '',
  }
}
