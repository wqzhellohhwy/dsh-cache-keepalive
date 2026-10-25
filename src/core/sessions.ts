/**
 * 会话清单（**纯 Node，不依赖 DSH 运行时**）。
 *
 * 这是「脱离 DSH 也能用」的地基：直接读磁盘上的会话日志，不要求宿主进程活着、
 * 也不要求官方插件 API。插件半边与独立 CLI 共用本模块。
 *
 * ## 为什么不用官方 persistence 包
 * `@deepseek-ai/dsh-session-persistence-jsonl` 是 cordis 插件，必须挂在 DSH 上下文里，
 * 独立进程用不上。
 *
 * ## 为什么不能直接用 node:zlib
 * DSH 的 `session.v4.jsonl.zstd` 是**多帧** zstd（一批写入一帧，实测单文件最多 2247 帧），
 * 而 Node 内置的 `zstdDecompressSync` / `createZstdDecompress` **只解第一帧**
 * （实测 182KB 文件只解出 184 字节 = 会话头那一帧）。
 *
 * 解法：扫 zstd 帧魔数 `28 B5 2F FD` 切段，逐段试解，解压失败的段说明魔数出现在帧内，
 * 并入下一段继续试。实测 12 个文件全部成功，且**切出的段数与真实帧数完全吻合**。
 *
 * ## 性能
 * 全量解压约 20ms/会话；只读文件头（默认 256KB）取标题会更快。
 * 330 个会话全扫约 6 秒——**必须缓存**（见 `SessionIndex`）。
 */
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { probeMark, type ToolFace } from './rewrite-probe.ts'

/** zstd 帧魔数。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 会话日志文件名（当前格式）。 */
const LOG_NAME_V4 = 'session.v4.jsonl.zstd'

/** 标题来源。 */
export type TitleSource = 'user' | 'provider' | 'fallback' | 'none'

export interface SessionRow {
  /** 会话 id（`session-<uuid>`）。 */
  id: string
  /** 项目键（cwd 的编码目录名）。 */
  projectKey: string
  /** 会话目录绝对路径。 */
  dir: string
  /** 日志文件绝对路径。 */
  logFile: string
  /** 标题（无则空串）。 */
  title: string
  /** 标题来源：user=用户改过，provider=模型生成，fallback=首句截断。 */
  titleSource: TitleSource
  /** 工作目录（从日志头的 cwd 读）。 */
  cwd: string
  /** 会话创建时间（毫秒）。 */
  createdAt: number
  /** 最后活动时间（毫秒）= 日志文件 mtime。 */
  mtime: number
  /**
   * **最后一条对话的时间**（`user/message`/`assistant/message`）；`0` = 未知、`undefined` = 没算。
   * 与 `mtime`（最后写入，含工具轮/压缩）不同 —— 候选池要用它，见 `index.ts` 的 `lastDialogOf`。
   */
  lastDialogAt?: number
  /** 日志字节数（近似反映上下文规模）。 */
  sizeBytes: number
  /** 是否被归档（来自 storages/workspace.json）。 */
  archived: boolean
  /** 是否被置顶（来自 storages/workspace.json）。 */
  pinned: boolean
  /**
   * 会话来源：`subagent` = 子代理会话，空串 = 普通会话。
   * 读自日志头 `{"type":"session",...,"origin":"subagent"}`。
   *
   * 为什么不用 `parentSession` 判：fork 出来的会话也带 parentSession，但它是用户
   * 自己要的（该保）；只有 origin 显式为 subagent 的才算子代理（命短、上下文碎，保了赔钱）。
   */
  origin: string
  /**
   * 父会话 id（仅子代理会话有；日志头 `parentSession`）。
   * 用于「父会话在保温才保子代理」——空串 = 拿不到父会话，调用方应视为在保温（宁可多保）。
   */
  parentSession: string
}

export interface ListOptions {
  /**
   * 只读日志头部多少字节来取标题；0 = 全量解压。
   * 标题通常出现在日志 0.5% 处，所以头部足够；默认 262144（256KB）。
   */
  headBytes?: number
  /** 只保留最近活动的 N 个（按 mtime 倒序后截断）；0 = 不限。 */
  limit?: number
}

/**
 * 跨帧解压多帧 zstd。
 * @param buf 文件内容（可以是头部截断）。
 * @returns 解出的文本，以及实际解成功的帧数。
 */

/**
 * 子代理标题（清洗 / 无用判定 / 从投影与日志取全名）。
 *
 * 实现放在 core/subagent-title.ts（会话扫描模块已经够大），这里只做 re-export，
 * 让调用方仍然从 sessions.ts 取 —— 保持既有导入路径不变。
 */
export {
  cleanSubagentTitle,
  findSessionLogFile,
  isUselessTitle,
  readSubagentTitle,
  readTeammateNameFromLog,
} from './subagent-title.ts'

export function decodeMultiFrame(buf: Buffer): { text: string; frames: number } {
  const marks = [0]
  for (let i = buf.indexOf(MAGIC, 1); i >= 0; i = buf.indexOf(MAGIC, i + 4)) marks.push(i)
  const parts: Buffer[] = []
  let pending = 0
  let frames = 0
  for (let k = 0; k < marks.length; k += 1) {
    const end = k + 1 < marks.length ? marks[k + 1] : buf.length
    try {
      parts.push(zstdDecompressSync(buf.subarray(pending, end)))
      pending = end
      frames += 1
    } catch {
      // 魔数落在帧内（不是真边界），或尾部被截断 —— 并入下一段继续试
    }

  }
  return { text: Buffer.concat(parts).toString('utf8'), frames }
}

/**
 * 扫描时读多少字节的日志头。
 *
 * 实测（412~416 条真实会话）：256KB=3412ms、128KB=1377ms、**64KB=1061ms**；
 * 64KB 能拿到 330/338 个标题（98%），32KB 会掉到 239/338（丢 99 条）—— **不能低于 64KB**。
 * 拿不到标题的少数会话走 `readHeadBytes` + `TITLE_RECHECK` 阶梯补读。
 */
export const DEFAULT_HEAD_BYTES = 64 * 1024
/** 阶梯补读的上限：64KB 没解析出标题时补读到这个大小。 */
export const RECHECK_HEAD_BYTES = 256 * 1024

/**
 * **只读文件头部 N 字节**（P0-2）。
 *
 * 原来用 `readFileSync` 整份读再 `subarray` —— 实测全量读 235.4MB，实际只需 50.6MB 表头（**78% 白读**）。
 * 这里用 `openSync` + `readSync` 只读需要的字节；文件比 N 短时返回整份。
 */
function readHeadBytes(file: string, bytes: number, sizeHint?: number): Buffer {
  const fd = openSync(file, 'r')
  try {
    /** 外层已有 `st.size` 就传进来：每会话多一次 statSync 是纯浪费（核验员实测只读表头本身 0.97×）。 */
    const size = sizeHint ?? statSync(file).size
    const n = Math.max(0, Math.min(bytes, size))
    const buf = Buffer.allocUnsafe(n)
    const read = n === 0 ? 0 : readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

/**
 * 阶梯补读的结果缓存（`logFile → 标题`），按 `mtime+size` 失效。
 *
 * 没有它的话：每次扫盘都要对「64KB 内没有标题」的会话补读 256KB，收益直接归零。
 */
const TITLE_RECHECK = new Map<string, { mtime: number; size: number; title: string; titleSource: TitleSource }>()

/**
 * **按文件的解析结果缓存**（P1-1）：键 = `logFile|headBytes`，失效 = `mtimeMs+size` 变了。
 *
 * 全量扫每次都要「解压 + parse 每个文件」，而会话日志在两次扫之间通常**根本没变**。
 * 命中后直接复用上次的 `parseMeta` 结果 → 实测全命中 35.6ms（对照 550ms）。
 *
 * 上限 `META_CACHE_MAX` 条（插入序淘汰最旧）：会话数再多也不会无界增长。
 */
interface MetaCacheEntry { mtime: number; size: number; meta: ParsedMeta }
const META_CACHE = new Map<string, MetaCacheEntry>()
/** 缓存条数上限：本机 416 条会话，2000 足够覆盖两台机器来回扫。 */
const META_CACHE_MAX = 2000

/**
 * **按需补读标题**（面板详情页用）：64KB 扫出来是 fallback/空时，再读 256KB 拿真标题。
 *
 * 为什么不做进 `listSessions`：把补读条件放宽到 fallback 会让冷扫 522ms → 1665ms（182 条 × 256KB 的解压），
 * 超过「冷扫 ≤ 1000ms」的红线。列表仍用 64KB（9/416 标题降级已裁决接受），详情页按需补一次即可。
 */
export function readTitleDeep(logFile: string, bytes = RECHECK_HEAD_BYTES): { title: string; titleSource: TitleSource } {
  try {
    const st = statSync(logFile)
    const m = parseMeta(decodeMultiFrame(readHeadBytes(logFile, bytes, st.size)).text)
    return { title: m.title, titleSource: m.titleSource }
  } catch {
    return { title: '', titleSource: 'none' }
  }


}

/**
 * **从 DSH 的标题投影缓存读最新标题**（`~/.dsh/storages/session_projcache/sessions/`）。
 *
 * 为什么需要：日志头部只扫 256KB，而重命名事件可能落在**文件中部**（实测某会话最新标题在 24% 位置），
 * 全库 510 条里 **31 条标题是错的**。DSH 自己把投影结果落在 `record.rows.title = {ver,seq,val}`，
 * 那个 `val` 就是**最新标题**。
 *
 * 三档读取（实测 682 个文件：`"title"` 偏移 min=214 / 中位=281 / max=632，**全部在 4KB 内**）：
 *  ① 前 4KB → ② 前 64KB → ③ 整文件。99% 走 ①。
 *
 * `val` 为 `null` / 空串 → 返回 `undefined`（**当「没有标题」**，绝不拿旧值顶上）。
 */
export function readProjectionTitle(dshHome: string, sessionId: string): string | undefined {
  if (sessionId === '') return undefined
  const dir = join(dshHome, 'storages', 'session_projcache', 'sessions')
  /** 文件名两种形态：`session-<id>.json`（428 个）与裸 `<id>.json`（254 个）。 */
  const candidates = [join(dir, 'session-' + sessionId + '.json'), join(dir, sessionId + '.json')]
  let file: string | undefined
  let st: ReturnType<typeof statSync> | undefined
  for (const f of candidates) {
    try {
      st = statSync(f)
      file = f
      break
    } catch { /* 试下一个形态 */ }
  }
  if (file === undefined || st === undefined) return undefined

  /** 缓存：`mtime+size` 失效（仿 `TAIL_FACTS_CACHE`）。 */
  const hit = PROJ_TITLE_CACHE.get(file)
  if (hit !== undefined && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.title

  let title: string | undefined
  for (const bytes of [4096, 64 * 1024]) {
    if (bytes > st.size) break
    try {
      title = extractProjectionTitle(readHeadBytes(file, bytes, st.size).toString('utf8'))
    } catch { title = undefined }
    if (title !== undefined) break
  }
  if (title === undefined) {
    try {
      title = extractProjectionTitle(readFileSync(file, 'utf8'))
    } catch { title = undefined }
  }

  PROJ_TITLE_CACHE.set(file, { mtime: st.mtimeMs, size: st.size, title })
  if (PROJ_TITLE_CACHE.size > 2000) PROJ_TITLE_CACHE.delete(PROJ_TITLE_CACHE.keys().next().value as string)
  return title
}

/**
 * 从投影缓存文本里抠出 `record.rows.title.val`。
 *
 * 用**手工括号配对 + `JSON.parse`** 而不是正则：正则要处理 `val` 里的转义引号与换行，
 * 写宽松了会把半截 JSON 当完整值；先配对出完整的 `{...}` 再 `JSON.parse` 最严格。
 */
function extractProjectionTitle(text: string): string | undefined {
  /** 只认第一处 `"title"`（实测每文件恰好 1 次，不会撞到 `titleInput`）。 */
  const at = text.indexOf('"title"')
  if (at < 0) return undefined
  const braceStart = text.indexOf('{', at)
  if (braceStart < 0) return undefined
  let depth = 0
  let inStr = false
  let esc = false
  for (let k = braceStart; k < text.length; k += 1) {
    const ch = text[k]
    if (inStr) {
      if (esc) { esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          const obj = JSON.parse(text.slice(braceStart, k + 1)) as { val?: unknown }
          const v = obj.val
          return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
        } catch { return undefined }
      }
    }
  }
  return undefined
}

/**
 * 一次尾部读同时得出的事实。`model` 缺失 = 没找到路由事件；`lastDialogAt` 为 0 = 没找到对话。
 */
interface TailFacts {
  model?: { provider: string; model: string }
  lastDialogAt: number
}

/** 自适应尾部窗口（从 256KB 起，逐档倍增到 4MB）。 */
const TAIL_WINDOWS = [256 * 1024, 512 * 1024, 1024 * 1024, 2 * 1024 * 1024, 4 * 1024 * 1024] as const
/** 尾部事实缓存：键 `logFile`，按 `mtime+size` 失效，命中 touch，上限 2000（与旧的两份缓存同量级）。 */
const TAIL_FACTS_CACHE = new Map<string, { mtime: number; size: number; val: TailFacts }>()
const TAIL_FACTS_CACHE_MAX = 2000
/** 最多尝试解几帧（防「整份都是假魔数」的极端情况）。 */
const MAX_TAIL_FRAMES = 12
/** zstd 帧魔数（little-endian 的 0xFD2FB528）。 */
const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * **一次读盘 + 一趟扫帧**同时给出 `{ model, lastDialogAt }` —— `readSessionModel` 与 `readLastDialogAt`
 * 都从这里取，不再各自读一遍尾部（原来 553 条会话要读两遍，冷启动白付一倍 IO）。
 *
 * 窗口自适应：从 256KB 起逐档倍增到 4MB，**读到就停**。绝大多数会话在 256KB 内命中（实测冷态
 * 553 条 < 500ms），只有尾部全是工具/心跳事件的长日志才一路放大到 4MB。
 *
 * 命中距离差异：`model` 通常就在最后 1~3 帧；`lastDialogAt` 可能要往前多扫几帧。
 * 两者**都命中就停**，所以只有「model 早命中、对话更远」时会多为对话解几帧（那是必须的成本）；
 * 反过来「对话近、model 远」时也为 model 多扫 —— 但两者通常同源（`assistant/message` 同时是对话与路由事件）。
 */
function readTailFacts(logFile: string): TailFacts {
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(logFile)
  } catch {
    return { lastDialogAt: 0 }
  }
  const hit = TAIL_FACTS_CACHE.get(logFile)
  if (hit !== undefined && hit.mtime === st.mtimeMs && hit.size === st.size) {
    TAIL_FACTS_CACHE.delete(logFile)
    TAIL_FACTS_CACHE.set(logFile, hit)
    return hit.val
  }
  let model: { provider: string; model: string } | undefined
  let at = 0
  let fd: number | undefined
  let buf = Buffer.alloc(0)
  let coveredFrom = st.size
  /** 已解过的帧的**最小绝对起点**（小于它的帧都解过了，绝不重解）。 */
  let solvedMinAbs = Number.POSITIVE_INFINITY
  /** 下一个待解帧范围的**绝对末端**（解失败时不动，避免切坏后续真帧）。 */
  let endAbs = st.size
  let tried = 0
  try {
    fd = openSync(logFile, 'r')
    for (const win of TAIL_WINDOWS) {
      const from = Math.max(0, st.size - win)
      if (from < coveredFrom) {
        const seg = Buffer.allocUnsafe(coveredFrom - from)
        readSync(fd, seg, 0, seg.length, from)
        buf = Buffer.concat([seg, buf])
        coveredFrom = from
      }
      /** 收集本档**新增**的帧起点（绝对偏移），从后往前。 */
      const starts: { abs: number; rel: number }[] = []
      let scan = buf.length - 4
      while (scan >= 0) {
        const idx = buf.lastIndexOf(ZSTD_FRAME_MAGIC, scan)
        if (idx < 0) break
        const abs = coveredFrom + idx
        if (abs < solvedMinAbs) starts.push({ abs, rel: idx })
        scan = idx - 1
      }
      for (const frame of starts) {
        if (tried >= MAX_TAIL_FRAMES) break
        let text = ''
        try {
          text = zstdDecompressSync(buf.subarray(frame.rel, endAbs - coveredFrom)).toString('utf8')
        } catch { continue }
        /** **解失败不占预算**：小窗口里帧内假魔数更容易踩满 12 次，把真帧挤掉就永远命不中。 */
        tried += 1
        endAbs = frame.abs
        solvedMinAbs = Math.min(solvedMinAbs, frame.abs)
        const lines = text.split('\n')
        for (let k = lines.length - 1; k >= 0; k -= 1) {
          const line = lines[k]
          if (line === '') continue
          if (model === undefined && (line.includes('"request/header"') || line.includes('"assistant/message"'))) {
            try {
              if (line.includes('"request/header"')) {
                const ev = JSON.parse(line) as { data?: { header?: { config?: { provider?: unknown; model?: unknown } } } }
                const cfg = ev.data?.header?.config
                if (typeof cfg?.provider === 'string' && cfg.provider !== ''
                  && typeof cfg.model === 'string' && cfg.model !== '') {
                  model = { provider: cfg.provider, model: cfg.model }
                }
              } else {
                const ev = JSON.parse(line) as { data?: { message?: { source?: { provider?: unknown; model?: unknown } } } }
                const src = ev.data?.message?.source
                if (typeof src?.provider === 'string' && src.provider !== ''
                  && typeof src.model === 'string' && src.model !== '') {
                  model = { provider: src.provider, model: src.model }
                }
              }
            } catch { /* 坏行忽略 */ }
          }
          if (at === 0 && (line.includes('"user/message"') || line.includes('"assistant/message"'))) {
            try {
              const o = JSON.parse(line) as { time?: number }
              if (typeof o.time === 'number' && Number.isFinite(o.time) && o.time > 0) at = o.time
            } catch { /* 坏行忽略 */ }
          }
        }
        if (model !== undefined && at > 0) break
      }
      if (model !== undefined && at > 0) break
      if (coveredFrom === 0) break
      if (tried >= MAX_TAIL_FRAMES) break
    }
  } catch { /* 读不出来就按未知 */ } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* ignore */ }
  }
  /**
   * **全量兜底（与旧的 `readSessionModel` 等价）**：尾部 12 帧里没有 `request/header`/`assistant/message`
   * 时（小日志尾部常是一串工具/心跳事件），旧实现走全量扫描找 model ——
   * 不保留这条兜底会让这类会话的 per-model 覆盖静默失效（真实存在：真机 553 条里有 2 条）。
   */
  if (model === undefined) {
    for (const r of readRoundsCached(logFile).slice().reverse()) {
      if (r.provider !== '' && r.model !== '') { model = { provider: r.provider, model: r.model }; break }
    }
  }
  const val: TailFacts = { ...(model === undefined ? {} : { model }), lastDialogAt: at }
  TAIL_FACTS_CACHE.set(logFile, { mtime: st.mtimeMs, size: st.size, val })
  if (TAIL_FACTS_CACHE.size > TAIL_FACTS_CACHE_MAX) {
    const oldest = TAIL_FACTS_CACHE.keys().next()
    if (oldest.done !== true) TAIL_FACTS_CACHE.delete(oldest.value)
  }
  return val
}

/**
 * **会话最后用的 provider / model** —— 用于查 `settings.modelOverrides`（按模型自定义门槛）。
 *
 * 拿法见 `readTailFacts`：尾部反向解帧，命中 `request/header`（或 `assistant/message` 的 source）就停。
 *
 * @param logFile 会话日志
 * @returns `{ provider, model }`；读不到返回 undefined（调用方回退到通用门槛）
 */
export function readSessionModel(logFile: string): { provider: string; model: string } | undefined {
  return readTailFacts(logFile).model
}


/**
 * **最后一条「对话」的时间**（`user/message` 或 `assistant/message`）—— 与 `mtime` 不是一回事：
 * `mtime` 只是「文件最后被写」（含工具结果、压缩、seed 事件），对话才代表「人和模型真的交流过」。
 *
 * 拿法与缓存见 `readTailFacts`（与 `readSessionModel` 共用一次读盘）。
 */
export function readLastDialogAt(logFile: string): number {
  return readTailFacts(logFile).lastDialogAt
}

/** 投影缓存标题：`mtime+size` 失效，上限 2000。 */
const PROJ_TITLE_CACHE = new Map<string, { mtime: number; size: number; title: string | undefined }>()

/** `parseMeta` 的返回（缓存按这个结构存）。 */
interface ParsedMeta {
  id: string
  cwd: string
  createdAt: number
  title: string
  titleSource: TitleSource
  origin: string
  /** 父会话 id（仅子代理有；日志头 \parentSession\）。 */
  parentSession: string
}

function parseMeta(text: string): ParsedMeta {
  let id = ''
  let cwd = ''
  let createdAt = 0
  let title = ''
  let titleSource: TitleSource = 'none'
  let origin = ''
  let parentSession = ''
  const lines = text.split('\n')
  for (const line of lines) {
    if (line === '') continue
    // 标题事件可能在任意位置；只解析含关键字的行，避免全量 JSON.parse 的开销
    if (line.startsWith('{"type":"session",')) {
      try {
        const o = JSON.parse(line) as { id?: string; cwd?: string; createdAt?: number; origin?: string; parentSession?: string }
        id = typeof o.id === 'string' ? o.id : id
        cwd = typeof o.cwd === 'string' ? o.cwd : cwd
        createdAt = typeof o.createdAt === 'number' ? o.createdAt : createdAt
        origin = typeof o.origin === 'string' ? o.origin : origin
        parentSession = typeof o.parentSession === 'string' ? o.parentSession : parentSession
      } catch { /* 忽略坏行 */ }
      continue
    }
    if (!line.includes('"session/title"')) continue
    try {
      const o = JSON.parse(line) as { data?: { title?: string; source?: { kind?: string } } }
      const t = o.data?.title
      if (typeof t === 'string' && t !== '') {
        // 后面的覆盖前面的（用户手改的通常最后出现）
        title = t
        const kind = o.data?.source?.kind
        titleSource = kind === 'user' || kind === 'provider' || kind === 'fallback' ? kind : 'provider'
      }
    } catch { /* 忽略坏行 */ }
  }
  return { id, cwd, createdAt, title, titleSource, origin, parentSession }
}

/** 读 `storages/workspace.json` 里的归档/置顶集合。 */
function readWorkspaceState(dshHome: string): { archived: Set<string>; pinned: Set<string> } {
  const archived = new Set<string>()
  const pinned = new Set<string>()
  try {
    const raw = readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8')
    const j = JSON.parse(raw) as {
      global?: { archivedSessionIds?: unknown; pinnedSessionIds?: unknown }
      tables?: { workspaces?: Record<string, { archivedSessionIds?: unknown; pinnedSessionIds?: unknown }> }
    }
    const addAll = (target: Set<string>, v: unknown): void => {
      if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') target.add(x)
    }
    addAll(archived, j.global?.archivedSessionIds)
    addAll(pinned, j.global?.pinnedSessionIds)
    for (const ws of Object.values(j.tables?.workspaces ?? {})) {
      addAll(archived, ws?.archivedSessionIds)
      addAll(pinned, ws?.pinnedSessionIds)
    }
  } catch { /* 文件缺失或坏掉：按无归档处理 */ }
  return { archived, pinned }
}

/**
 * 列出磁盘上的全部会话（按最后活动倒序）。
 *
 * @param dshHome DSH 主目录（含 `sessions/` 与 `storages/`）。
 * @param options 扫描选项。
 * @returns 会话行数组。
 */
export function listSessions(dshHome: string, options: ListOptions = {}): SessionRow[] {
  const headBytes = options.headBytes ?? DEFAULT_HEAD_BYTES
  const root = join(dshHome, 'sessions')
  const { archived, pinned } = readWorkspaceState(dshHome)
  const rows: SessionRow[] = []

  let projects: string[]
  try {
    projects = readdirSync(root)
  } catch {
    return rows
  }

  for (const projectKey of projects) {
    const projDir = join(root, projectKey)
    let entries
    try {
      entries = readdirSync(projDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(projDir, entry.name)
      const logFile = join(dir, LOG_NAME_V4)
      let st
      try {
        st = statSync(logFile)
      } catch {
        continue // 不是 v4 会话（可能是旧格式或目录残留）
      }
      /**
       * **按文件缓存解析结果**（P1-1）：`logFile|headBytes` 为键，`mtimeMs+size` 失效。
       * 会话日志两次扫之间通常没变 → 直接复用上次的 `parseMeta`，省掉解压与 parse。
       */
      const cacheKey = logFile + '|' + headBytes
      const cached = META_CACHE.get(cacheKey)
      let meta: ParsedMeta
      if (cached !== undefined && cached.mtime === st.mtimeMs && cached.size === st.size) {
        meta = cached.meta
      } else {
        let text = ''
        try {
          text = decodeMultiFrame(readHeadBytes(logFile, headBytes, st.size)).text
        } catch { /* 读不出来就只留文件信息 */ }
        meta = text === ''
          ? { id: entry.name, cwd: '', createdAt: 0, title: '', titleSource: 'none' as TitleSource, origin: '', parentSession: '' }
          : parseMeta(text)
        /**
         * **阶梯补读**（只在完全没有标题时）：64KB 拿不到标题 → 补读 256KB。
         * 放宽到 `fallback` 会让冷扫 522ms → 1665ms（超红线），所以详情页另走 `readTitleDeep()`。
         */
        if (meta.title === '' && st.size > headBytes) {
          const hit = TITLE_RECHECK.get(logFile)
          if (hit !== undefined && hit.mtime === st.mtimeMs && hit.size === st.size) {
            meta = { ...meta, title: hit.title, titleSource: hit.titleSource }
          } else {
            try {
              const more = decodeMultiFrame(readHeadBytes(logFile, Math.max(RECHECK_HEAD_BYTES, headBytes), st.size)).text
              const m2 = parseMeta(more)
              meta = { ...meta, title: m2.title, titleSource: m2.titleSource }
              TITLE_RECHECK.set(logFile, { mtime: st.mtimeMs, size: st.size, title: m2.title, titleSource: m2.titleSource })
            } catch { /* 补读失败就保持空标题 */ }
          }
        }
        /** 写入缓存（插入序淘汰最旧，保证有上限）。 */
        META_CACHE.set(cacheKey, { mtime: st.mtimeMs, size: st.size, meta })
        if (META_CACHE.size > META_CACHE_MAX) {
          const oldest = META_CACHE.keys().next()
          if (oldest.done !== true) META_CACHE.delete(oldest.value)
        }
      }
      const id = meta.id !== '' ? meta.id : entry.name
      rows.push({
        id,
        projectKey,
        dir,
        logFile,
        title: meta.title,
        titleSource: meta.titleSource,
        cwd: meta.cwd,
        createdAt: meta.createdAt,
        mtime: st.mtimeMs,
        sizeBytes: st.size,
        archived: archived.has(id),
        pinned: pinned.has(id),
        origin: meta.origin,
        parentSession: meta.parentSession,
      })
    }
  }

  rows.sort((a, b) => b.mtime - a.mtime)
  if (options.limit !== undefined && options.limit > 0) return rows.slice(0, options.limit)
  return rows
}

/**
 * 带缓存的会话索引。
 *
 * 全扫 330 个会话约 6 秒，而面板会周期性拉取 —— 必须缓存。
 * `refreshTtlMs` 内直接返回缓存；`refresh()` 强制重扫。
 */
export class SessionIndex {
  private rows: SessionRow[] = []
  private scannedAt = 0
  private scanning: Promise<SessionRow[]> | undefined

  // ⚠️ 不能用「构造函数参数属性」写法（constructor(private readonly x: T)）：
  // Node 的**类型剥离**只支持可直接擦除的语法，参数属性和 enum、namespace 一样需要真转换，
  // 会报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。必须显式声明字段 + 构造函数里赋值。
  private readonly dshHome: string
  private readonly options: ListOptions & { refreshTtlMs?: number }

  constructor(dshHome: string, options: ListOptions & { refreshTtlMs?: number } = {}) {
    this.dshHome = dshHome
    this.options = options
  }

  /** 取当前缓存（可能为空）。 */
  get cached(): readonly SessionRow[] {
    return this.rows
  }

  /** 上次扫描时间（毫秒）；0 = 从未扫过。 */
  get lastScanAt(): number {
    return this.scannedAt
  }

  /**
   * 取会话列表（必要时重扫）。
   * @param force 强制重扫。
   */
  async list(force = false): Promise<SessionRow[]> {
    const ttl = this.options.refreshTtlMs ?? 60_000
    if (!force && this.scannedAt > 0 && Date.now() - this.scannedAt < ttl) return this.rows
    if (this.scanning !== undefined) return this.scanning
    this.scanning = Promise.resolve()
      .then(() => listSessions(this.dshHome, this.options))
      .then((rows) => {
        this.rows = rows
        this.scannedAt = Date.now()
        this.scanning = undefined
        return rows
      })
      .catch((error: unknown) => {
        this.scanning = undefined
        throw error
      })
    return this.scanning
  }
}

/** 一轮对话的计费（来自日志的 `assistant/message` 事件）。 */
/**
 * **计算轮次**（不是用户对话轮次，但会影响前缀）。
 *
 * 细节页要能看出「这一轮为什么之后没保温」：压缩会遮蔽一段历史、goal 会重写 system，
 * 两者之后的第一次保温等于付一次全量（缓存还是改写前的）。所以跟保温并列成一条时间轴线。
 */
export interface ComputeMark {
  kind: 'compaction' | 'goal'
  /** 细分：压缩摘要 / 剪枝 / goal。 */
  sub: 'summary' | 'prune' | 'goal'
  at: number
  seq: number
  /** 左侧徽标文案：`压缩 1012 个事件` / `剪枝 1 个事件` / `goal complete`。token 与原因在右侧。 */
  text: string
  /** 被遮蔽的事件条数 / token 数 / type 分布（右侧拼 `4.1k tok · 剪掉工具输出`）。 */
  shadowedCount?: number
  shadowedTokens?: number
  droppedTypes?: Record<string, number>
  /** 改写前后工具面比对（goal 没有，面板写「系统提示词可能被改写」）。 */
  toolFace?: ToolFace
}

/**
 * @param text **已解压的日志文本**（可选）。同一次请求里 `readRounds` 已经解过一次时传进来，
 *   省掉第二次解压（45MB 日志约 1.1s）；不传则自己 `decodeMultiFrame`，行为与以前完全一致。
 */
export function readMarks(logFile: string, text?: string): ComputeMark[] {
  let events: { type?: string; time?: number; seq?: number; data?: unknown }[] = []
  try {
    const src = text ?? decodeMultiFrame(readFileSync(logFile)).text
    const body = src
    /**
     * **只对「用得上的事件」做全量 JSON.parse**，其余行用正则取 `type`/`seq` 就够：
     * `droppedTypesOf` 只要 `{type, seq}`，`toolFaceAt` 只需要 `request/header` 的 data，
     * `probeMark` 只需要 mark 事件自己的 data。
     *
     * 为什么必须这样：旧实现把每条日志行都 parse 一遍（45MB 日志 11 万行），
     * 实测 `readMarks` 单次 2256ms —— 是详情页首次加载里最大的一笔（比解压 1165ms 还多）。
     */
    const TYPE_RE = /"type"\s*:\s*"([^"]*)"/
    const SEQ_RE = /"seq"\s*:\s*(\d+)/
    const FULL_PARSE = new Set(['request/header', 'compaction/summary', 'compaction/prune', 'goal/change'])
    let pos = 0
    for (;;) {
      let nl = body.indexOf('\n', pos)
      if (nl < 0) nl = body.length
      const line = body.slice(pos, nl)
      pos = nl + 1
      if (line.trim() === '') {
        if (pos >= body.length) break
        continue
      }
      const tm = TYPE_RE.exec(line)
      const type = tm === null ? '' : tm[1]
      if (FULL_PARSE.has(type)) {
        try { events.push(JSON.parse(line)) } catch { /* 坏行忽略 */ }
      } else {
        const sm = SEQ_RE.exec(line)
        events.push({ type, seq: sm === null ? undefined : Number(sm[1]) })
      }
      if (pos >= body.length) break
    }
  } catch { return [] }
  const out: ComputeMark[] = []
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    const seq = typeof ev.seq === 'number' ? ev.seq : -1
    const at = typeof ev.time === 'number' ? ev.time : 0
    if (ev.type === 'compaction/summary' || ev.type === 'compaction/prune') {
      const p = probeMark(events, i)
      out.push({
        kind: 'compaction', sub: p.sub, at, seq,
        /** 徽标只放「压缩/剪枝 N 个事件」，token 与原因留给右侧（避免长标签压到旁边文字）。 */
        text: (p.sub === 'summary' ? '压缩' : '剪枝') + ' ' + (p.shadowedCount ?? '?') + ' 个事件',
        ...(p.shadowedCount === undefined ? {} : { shadowedCount: p.shadowedCount }),
        ...(p.shadowedTokens === undefined ? {} : { shadowedTokens: p.shadowedTokens }),
        ...(p.droppedTypes === undefined ? {} : { droppedTypes: p.droppedTypes }),
        ...(p.toolFace === undefined ? {} : { toolFace: p.toolFace }),
      })
    }
    if (ev.type === 'goal/change') {
      const d = (ev.data ?? {}) as { operation?: string }
      out.push({ kind: 'goal', sub: 'goal', at, seq, text: 'goal ' + (typeof d.operation === 'string' ? d.operation : 'change') })
    }
  }
  return out
}
export interface RoundUsage {
  /** 事件序号。 */
  seq: number
  /** 发生时间（毫秒）。 */
  time: number
  /** 第几轮。 */
  turn: number
  /** 这一轮里第几次 API 调用。 */
  step: number
  /** 这一轮实际用的 provider / model（来自 assistant/message 的 source；缺失时为空串）。 */
  provider: string
  model: string
  /** 未命中输入（按未命中价计费）。 */
  missTokens: number
  /** 命中输入（按命中价计费）。 */
  hitTokens: number
  outputTokens: number
  totalTokens: number
}

/**
 * 读某个会话日志里**每一轮**的 token 用量。
 *
 * 数据源：`assistant/message` 事件的 `data.usage`
 * （`inputTokens` = 未命中、`cacheReadTokens` = 命中、`outputTokens` = 输出）。
 *
 * 这是「每轮计费详情」的唯一来源 —— 账本只记**保温**那几次，这里记的是**全部真实回合**，
 * 两者按 `time` 合并后就是一条完整的时间轴（保温表现为"额外插入的一个轮次"）。
 *
 * 代价：需要**全量解压**（usage 分散在整个日志里），实测约 20ms/会话。
 */
export function readRounds(logFile: string): RoundUsage[] {
  let text = ''
  try {
    text = decodeMultiFrame(readFileSync(logFile)).text
  } catch {
    return []
  }
  return readRoundsFromText(text)
}

/** 从**已解压的日志文本**里抽每轮 token 用量（`readRounds` 的实体）。 */
export function readRoundsFromText(text: string): RoundUsage[] {
  const out: RoundUsage[] = []
  /**
   * **不 `split('\n')`**：45MB 日志解压后是几百 MB 文本，`split` 会一次性造出上百万个字符串
   * （实测详情页首次加载 4.5 秒的主因）。改成在文本上 `indexOf` 定位事件，命中后只向两侧
   * 扩到换行边界取出那一行 —— 行序、取舍条件、字段与旧实现逐条相同（`tests` 里有等价性对拍）。
   */
  const NEEDLE = '"assistant/message"'
  let pos = 0
  for (;;) {
    const hit = text.indexOf(NEEDLE, pos)
    if (hit < 0) break
    const start = text.lastIndexOf('\n', hit) + 1
    let end = text.indexOf('\n', hit)
    if (end < 0) end = text.length
    pos = end + 1
    const line = text.slice(start, end)
    // 先做廉价二次过滤，再 JSON.parse —— 日志动辄几千行，省下的解析很可观
    if (!line.includes('"usage"')) continue
    try {
      const o = JSON.parse(line) as {
        seq?: number
        time?: number
        data?: {
          turn?: number
          step?: number
          usage?: Record<string, number>
          message?: { source?: { provider?: string; model?: string } }
        }
      }
      const u = o.data?.usage
      if (u === undefined) continue
      const src = o.data?.message?.source
      out.push({
        seq: o.seq ?? 0,
        time: o.time ?? 0,
        turn: o.data?.turn ?? 0,
        step: o.data?.step ?? 0,
        provider: typeof src?.provider === 'string' ? src.provider : '',
        model: typeof src?.model === 'string' ? src.model : '',
        missTokens: u['inputTokens'] ?? 0,
        hitTokens: u['cacheReadTokens'] ?? 0,
        outputTokens: u['outputTokens'] ?? 0,
        totalTokens: u['totalTokens'] ?? 0,
      })
    } catch { /* 坏行忽略 */ }
  }
  return out
}

/**
 * `readRounds` 的**带缓存版**：`mtime+size` 失效，LRU 上限 256，命中 touch。
 * 数据与 `readRounds` 完全一致（就是它的返回值），只是别重复全量解压。
 */
export function readRoundsCached(logFile: string): RoundUsage[] {
  return readRoundsCachedWithText(logFile).rounds
}

/**
 * 同 `readRoundsCached`，另外把**解压后的文本**一并交回（仅缓存未命中时才有）。
 * 调用方在同一次请求里既要用 rounds 又要用 marks 时，把 text 传给 `readMarksCached`，
 * 45MB 日志能省一次全量解压（约 1.1s）。text 不进缓存（几百 MB，缓存必爆）。
 */
export function readRoundsCachedWithText(logFile: string): { rounds: RoundUsage[]; text?: string } {
  let st: ReturnType<typeof statSync>
  try { st = statSync(logFile) } catch { return { rounds: [] } }
  const hit = ROUNDS_CACHE.get(logFile)
  if (hit !== undefined && hit.mtime === st.mtimeMs && hit.size === st.size) {
    ROUNDS_CACHE.delete(logFile)
    ROUNDS_CACHE.set(logFile, hit)
    return { rounds: hit.rounds }
  }
  let text = ''
  try { text = decodeMultiFrame(readFileSync(logFile)).text } catch { return { rounds: [] } }
  const rounds = readRoundsFromText(text)
  ROUNDS_CACHE.set(logFile, { mtime: st.mtimeMs, size: st.size, rounds })
  if (ROUNDS_CACHE.size > ROUNDS_CACHE_MAX) {
    const oldest = ROUNDS_CACHE.keys().next()
    if (oldest.done !== true) ROUNDS_CACHE.delete(oldest.value)
  }
  return { rounds, text }
}

/** `readRoundsCached` 的 rounds 缓存（LRU 256）。 */
const ROUNDS_CACHE = new Map<string, { mtime: number; size: number; rounds: RoundUsage[] }>()
const ROUNDS_CACHE_MAX = 256

/**
 * `readMarks` 的带缓存版：`mtime+size` 失效，LRU 上限 256，命中 touch。
 * 传了 `text`（同一次请求已解压过）就直接用它算，省掉自己再解压一次。
 */
export function readMarksCached(logFile: string, text?: string): ComputeMark[] {
  let st: ReturnType<typeof statSync>
  try { st = statSync(logFile) } catch { return [] }
  const hit = MARKS_CACHE.get(logFile)
  if (hit !== undefined && hit.mtime === st.mtimeMs && hit.size === st.size) {
    MARKS_CACHE.delete(logFile)
    MARKS_CACHE.set(logFile, hit)
    return hit.marks
  }
  const marks = readMarks(logFile, text)
  MARKS_CACHE.set(logFile, { mtime: st.mtimeMs, size: st.size, marks })
  if (MARKS_CACHE.size > MARKS_CACHE_MAX) {
    const oldest = MARKS_CACHE.keys().next()
    if (oldest.done !== true) MARKS_CACHE.delete(oldest.value)
  }
  return marks
}

/** `readMarksCached` 的缓存（LRU 256）。 */
const MARKS_CACHE = new Map<string, { mtime: number; size: number; marks: ComputeMark[] }>()
const MARKS_CACHE_MAX = 256
/** 一整轮（可能跨多次 API 调用 = 多次工具往返）的合计。 */
export interface TurnUsage {
  /** 第几轮。 */
  turn: number
  /** 该轮第一笔的时间。 */
  time: number
  /** 该轮最后一笔的时间。 */
  endTime: number
  /** 这一轮里有几次 API 调用。 */
  steps: number
  /** 该轮最后一笔非空的 provider / model（正常情况整轮同模型）。 */
  provider: string
  model: string
  missTokens: number
  hitTokens: number
  outputTokens: number
}

/**
 * 把逐次调用聚合成逐轮合计。
 *
 * 为什么需要：一次工具往返就是一轮里的两次 `assistant/message`，两次都各自计费。
 * 看"这一轮到底花了多少"要把它们加起来；看"每次调用命中多少"才用原始粒度。
 * 时间取**首笔**（这一轮的开始），末笔另存 `endTime`。
 */
export function sumByTurn(rounds: readonly RoundUsage[]): TurnUsage[] {
  const order: number[] = []
  const bag = new Map<number, TurnUsage>()
  for (const r of rounds) {
    let cur = bag.get(r.turn)
    if (cur === undefined) {
      cur = {
        turn: r.turn,
        time: r.time,
        endTime: r.time,
        steps: 0,
        provider: r.provider,
        model: r.model,
        missTokens: 0,
        hitTokens: 0,
        outputTokens: 0,
      }
      bag.set(r.turn, cur)
      order.push(r.turn)
    }
    cur.steps += 1
    cur.missTokens += r.missTokens
    cur.hitTokens += r.hitTokens
    cur.outputTokens += r.outputTokens
    if (r.time > 0 && (cur.time === 0 || r.time < cur.time)) cur.time = r.time
    if (r.time > cur.endTime) cur.endTime = r.time
    // 模型取「最后一笔非空」——整轮换模型的极端情况按最后一次算
    if (r.provider !== '') cur.provider = r.provider
    if (r.model !== '') cur.model = r.model
  }
  return order.map((t) => bag.get(t)!).sort((a, b) => a.time - b.time)
}

/** 会话日志是否存在于磁盘（用于校验 agent 对应的会话）。 */
export function sessionLogExists(dshHome: string, sessionId: string): boolean {
  const root = join(dshHome, 'sessions')
  let projects: string[]
  try {
    projects = readdirSync(root)
  } catch {
    return false
  }
  for (const projectKey of projects) {
    if (existsSync(join(root, projectKey, sessionId, LOG_NAME_V4))) return true
  }
  return false
}

/**
 * **fork 会话的继承状态是否让「本会话的摘要」不可靠**。
 *
 * ## 为什么这是个必须拦的问题
 * DSH 的 fork（会话分叉）会写一条 `session/end-seed {inherited: true}`，
 * 把**父会话的状态**继承进来 —— 但**不写任何 `compaction/summary` 事件**。
 *
 * 实测（`.tmp/spy-exp` 的 177e3411）：
 * ```
 * 14:02:50  seq 43532  compaction/summary（最后一条，8190 字符）
 * 16:51:39  seq 44857  session/end-seed {"inherited": true}   ← 继承，2h49m 之后
 * 17:27:14             真实请求，其 #1 摘要内层是 11521 字符
 * ```
 * ⇒ **本会话最后一条 summary（8190）≠ 真实用的那份（11521）**，因为它来自父会话，
 * 而父会话的摘要**根本不在本会话日志里**。
 *
 * ## 后果
 * 从 #1 就不同 ⇒ **整条前缀全 miss** ⇒ 保温花真钱买 0 命中。
 * 所以 `assembleSession` 要把这件事**报给调用方**，由调用方决定「跳过保温」。
 *
 * @param events 会话事件（按 seq 升序）
 * @returns 继承了状态时返回 `{ at, lastSummarySeq, lastSummaryAt }`；否则 undefined
 */
export function inheritedSeedOf(events: readonly { type?: string; seq?: number; time?: number; data?: unknown }[]): {
  /** 继承事件的 seq。 */
  at: number
  /** 继承事件的时间。 */
  time: number
  /** 本会话最后一条 `compaction/summary` 的 seq（没有则 undefined）。 */
  lastSummarySeq?: number
  /** 本会话最后一条 `compaction/summary` 的时间（没有则 undefined）。 */
  lastSummaryAt?: number
  /**
   * 继承是否发生在**最后一次压缩之后**。
   * `true` ⇒ 本会话的摘要不可靠（继承进来的那份没落盘）。
   *
   * ⚠️ **本会话从未压缩（`lastSummarySeq === undefined`）必须放行**：
   * 那说明本会话**没有摘要**，也就不存在「摘要取自父会话」的问题。
   * 实测依据：fork 会把父会话的事件（含 `compaction/summary`）**原样复制**进子会话日志
   * （177e3411 与 40b9 的 summary seq 完全相同：1140,4140,…43532），
   * 所以「fork 后从未压缩」只可能出现在「父会话也从没压缩过」的情形 —— 那种会话本就是普通历史。
   */
  afterLastSummary: boolean
  /**
   * **判定依据**，写进拒绝日志便于事后核查是「误拦」还是「正常放行」。
   *
   * - `no-summary`：本会话无摘要 ⇒ 放行
   * - `seed-after-summary`：继承晚于最后一次压缩 ⇒ **拦**
   * - `seed-before-summary`：继承早于最后一次压缩 ⇒ 放行（本会话自己有更晚的摘要）
   */
  reason: 'no-summary' | 'seed-after-summary' | 'seed-before-summary'
} | undefined {
  let seedAt: number | undefined
  let seedTime = 0
  let lastSummarySeq: number | undefined
  let lastSummaryAt: number | undefined
  for (const event of events) {
    if (event.type === 'session/end-seed') {
      const inherited = (event.data as { inherited?: unknown } | undefined)?.inherited
      if (inherited === true) {
        seedAt = Number(event.seq)
        seedTime = Number(event.time ?? 0)
      }
      continue
    }
    if (event.type === 'compaction/summary') {
      lastSummarySeq = Number(event.seq)
      lastSummaryAt = Number(event.time ?? 0)
    }
  }
  if (seedAt === undefined) return undefined
  const reason = lastSummarySeq === undefined
    ? 'no-summary'
    : seedAt > lastSummarySeq ? 'seed-after-summary' : 'seed-before-summary'
  return {
    at: seedAt,
    time: seedTime,
    ...(lastSummarySeq === undefined ? {} : { lastSummarySeq }),
    ...(lastSummaryAt === undefined ? {} : { lastSummaryAt }),
    afterLastSummary: reason === 'seed-after-summary',
    reason,
  }
}

/**
 * 在 `$DSH_HOME/sessions` 下**全局**找某个会话 id 的日志。
 *
 * fork 的父会话可能在**别的项目目录**下（实测 177e3411 的父会话 40b9
 * 与它在同一个 projectKey，但跨项目的 fork 完全可能）。
 *
 * @param dshHome DSH 主目录
 * @param sessionId 会话 id
 * @returns 日志绝对路径；找不到返回 undefined
 */
export function findSessionLog(dshHome: string, sessionId: string): string | undefined {
  const root = join(dshHome, 'sessions')
  let projects: string[]
  try {
    projects = readdirSync(root)
  } catch {
    return undefined
  }
  for (const projectKey of projects) {
    const file = join(root, projectKey, sessionId, LOG_NAME_V4)
    if (existsSync(file)) return file
  }
  return undefined
}
