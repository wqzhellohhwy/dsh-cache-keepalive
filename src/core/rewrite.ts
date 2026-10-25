import { readFileSync, statSync } from 'node:fs'
import { decodeMultiFrame } from './sessions.ts'
import { probeMark, type ToolFace } from './rewrite-probe.ts'
/**
 * 「前缀被改写」检测 —— 在**花钱之前**发现「日志里刚发生过压缩/goal 改写，且之后没有真实请求」。
 *
 * 为什么必须单独判：我们的前缀指纹只看 `tools + 前 8 条消息`，而
 *  - **压缩**改的是历史中段（`compaction/summary|prune` 用 `shadowedSeqs` 遮蔽一段）；
 *  - **goal**改的是 system（`goal/change` 的 create/complete/resume 会重写 system 前缀）。
 * 两者都不进指纹 → 不会被「指纹变」拦住 → 照保 → 但服务端缓存还是**改写前**的前缀 →
 * 一次全量付费（等于替用户付一次冷启动）。
 *
 * 判据：取最后一条改写事件；若它之后**没有任何 `request/header`**（没被真实请求重建缓存）→ 判改写。
 * 实测：22 条有压缩的会话里 2 条压缩是最后动作；46 次 goal/change 里 8 次之后无请求（其中 complete 4 次）。
 */
export interface PrefixRewrite {
  /** 改写来源：压缩 / goal。 */
  kind: 'compaction' | 'goal'
  /** 细分：压缩摘要 / 剪枝 / goal。 */
  sub: 'summary' | 'prune' | 'goal'
  /** 最后一条改写事件的 seq。 */
  seq: number
  /** 被遮蔽的事件条数（shadowedSeqs.length）。 */
  shadowedCount?: number
  /** 被遮蔽的 token 数（原样，未格式化）。 */
  shadowedTokens?: number
  /** 被遮蔽事件的 type 分布，如 { 'tool/result': 1 }。 */
  droppedTypes?: Record<string, number>
  /** 改写前后工具面比对（goal 没有）。 */
  toolFace?: ToolFace
  /** 一句人话（面板/日志直接用）。 */
  detail: string
}

interface Ev {
  type?: string
  seq?: number
  data?: unknown
}

/** 压缩类事件（都表示"历史被遮蔽/剪枝"）。 */
const COMPACTION_TYPES = new Set(['compaction/summary', 'compaction/prune', 'compaction/end'])

/** 工具面比对的措辞（面板/日志共用一套，避免两处不一致）。 */
const FACE_TXT: Record<ToolFace, string> = {
  same: '工具面未变',
  'def-changed': '工具定义变了',
  'toolset-changed': '工具增删',
  unknown: '工具面未确认',
}

/**
 * **改写指纹**：`无改写 → ''`，否则 `${kind}:${sub}:${seq}`。
 *
 * 为什么需要它（而不是只看「日志尾部有没有改写」）：旧判据是「最后一条改写之后没有 `request/header` 就拒」，
 * 但**上次保温本身可能就发生在这个改写之后**（缓存早已重建）—— 旧判据会一直拒到用户真的聊一句为止（误拒）。
 * 拿它和**上一条账本**的 `rewriteFp` 比：一样 = 上次就是在这之后保的 → 放行；不一样 = 真变了 → 拒。
 *
 * ⚠️ 与 `keepalive.ts` 的 `fingerprint`（tools+messages 的**内容哈希**）不是一回事，两个字段各自独立。
 */
export function rewriteFpOf(rw: PrefixRewrite | undefined): string {
  return rw === undefined ? '' : `${rw.kind}:${rw.sub}:${rw.seq}`
}

export function detectPrefixRewrite(events: readonly Ev[]): PrefixRewrite | undefined {
  let compactionSeq = -1
  let lastDetailSeq = -1
  let goalSeq = -1
  let goalOp = ''
  let lastRequestSeq = -1
  let compactionIdx = -1
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    const seq = typeof ev.seq === 'number' ? ev.seq : -1
    if (seq < 0) continue
    /**
     * **真实请求的证据不止 `request/header`**：DSH 只在 initial / change / series 三种时机写 header，
     * 同一 series 内的连续请求**一条都不写**（实测某会话 809 条 assistant/message 只配 18 条 header）。
     *
     * 只认 header 会把「改写之后明明又聊了很多轮」误判成「之后没有真实请求」→ 恒拒保温。
     * `assistant/message` 是模型响应，出现即证明发生过真实请求；两者的 `seq` 是同一全局序列，
     * 可直接取较大者比较。
     */
    if (ev.type === 'request/header' || ev.type === 'assistant/message') lastRequestSeq = seq
    if (COMPACTION_TYPES.has(ev.type ?? '')) {
      if (seq > compactionSeq) compactionSeq = seq
      /** 只有 summary/prune 带遮蔽量，end 只表示"这次压缩结束"——detail 别被它覆盖成 '?'。 */
      if ((ev.type === 'compaction/summary' || ev.type === 'compaction/prune') && seq > lastDetailSeq) {
        lastDetailSeq = seq
        compactionIdx = i
      }
    }
    if (ev.type === 'goal/change') {
      if (seq > goalSeq) {
        goalSeq = seq
        const d = (ev.data ?? {}) as { operation?: string }
        goalOp = typeof d.operation === 'string' ? d.operation : 'change'
      }
    }
  }
  const lastRewrite = Math.max(compactionSeq, goalSeq)
  /** 改写之后已经有真实请求 → 缓存已被那次请求重建，保温有效。 */
  if (lastRewrite < 0 || lastRequestSeq > lastRewrite) return undefined
  if (compactionSeq >= goalSeq) {
    const p = compactionIdx >= 0 ? probeMark(events, compactionIdx) : undefined
    const n = p?.shadowedCount
    const tok = p?.shadowedTokens
    const face = p?.toolFace === undefined ? '' : '，' + FACE_TXT[p.toolFace]
    return {
      kind: 'compaction',
      sub: p?.sub === 'summary' ? 'summary' : 'prune',
      seq: compactionSeq,
      ...(n === undefined ? {} : { shadowedCount: n }),
      ...(tok === undefined ? {} : { shadowedTokens: tok }),
      ...(p?.droppedTypes === undefined ? {} : { droppedTypes: p.droppedTypes }),
      ...(p?.toolFace === undefined ? {} : { toolFace: p.toolFace }),
      detail: (p?.sub === 'summary' ? '压缩摘要' : '剪枝') + '遮蔽了 ' + (n ?? '?') + ' 个事件'
        + (tok === undefined ? '' : '（' + tok + ' tok）') + face + '，之后没有真实请求',
    }
  }
  return {
    kind: 'goal',
    sub: 'goal',
    seq: goalSeq,
    detail: 'goal ' + goalOp + ' 改写了系统提示词前缀（system 不在日志里，无法确认），之后没有真实请求',
  }
}

/**
 * 带缓存的版本：按日志 `mtime` 失效。
 *
 * 为什么需要缓存：门禁会**按拍**评估活会话（60 秒一次）、面板会按轮询评估保过的会话，
 * 每次解压整份日志（十几 MB）不可接受；同一份日志只要没被写过结论就不会变。
 */
const FILE_CACHE = new Map<string, { mtime: number; val: PrefixRewrite | undefined }>()

export function rewriteOfFile(logFile: string): PrefixRewrite | undefined {
  let mtime = 0
  try {
    mtime = statSync(logFile).mtimeMs
  } catch {
    return undefined
  }
  const hit = FILE_CACHE.get(logFile)
  if (hit !== undefined && hit.mtime === mtime) return hit.val
  let val: PrefixRewrite | undefined
  try {
    const events = decodeMultiFrame(readFileSync(logFile)).text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try { return JSON.parse(line) as Ev } catch { return undefined }
      })
      .filter((x) => x !== undefined)
    val = detectPrefixRewrite(events)
  } catch {
    val = undefined
  }
  FILE_CACHE.set(logFile, { mtime, val })
  if (FILE_CACHE.size > 600) {
    const oldest = FILE_CACHE.keys().next().value
    if (oldest !== undefined) FILE_CACHE.delete(oldest)
  }
  return val
}
