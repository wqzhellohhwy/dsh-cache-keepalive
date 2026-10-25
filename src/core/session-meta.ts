/**
 * **会话元数据缓存**（`<DSH_HOME>/cache-keepalive/sessions.meta.json`）。
 *
 * 为什么需要：CLI 每跑一次都要 `listSessions()` —— 遍历 `sessions/*` 下每个会话目录、
 * 每个日志读 256KB 头解标题。400 条实测 **~1.5 秒**。插件 tick 本来就已经有这份索引，
 * 顺手写出来，CLI 直接读，能省掉整个扫盘。
 *
 * 契约：
 *  - **只有插件 tick 写**；CLI **只读**（读不到 / 过期 → 自己扫盘，不允许拿旧缓存把新会话当不存在）。
 *  - 原子写：先写临时文件再 `rename`（CLI 可能正在读）。
 *  - 带 `at`（写入时刻）：超过 `SESSION_META_MAX_AGE_MS` 一律视为过期。
 *  - 内容没变时**每 2 分钟**才刷新一次 `at`（避免每拍都写盘，又不让 CLI 误判过期）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionRow } from './sessions.ts'

/** 超过这个年龄就回落自己扫盘。选 5 分钟：插件 tick 是 60 秒，正常最多差一拍。 */
export const SESSION_META_MAX_AGE_MS = 5 * 60_000

/** 内容不变时刷新 `at` 的间隔：取过期线的一半，保证 CLI 不会因为「内容没变」而误判过期。 */
const TOUCH_INTERVAL_MS = 2 * 60_000

export interface SessionMetaItem {
  mtime: number
  title: string
  titleSource: string
  archived: boolean
  origin: string
  /** 会话目录名（`<projectKey>/<id>` 的前半），用来补出日志绝对路径。 */
  projectKey: string
  /**
   * 会话**目录名**。DSH 正常约定是「目录名 = 会话 id」，但迁移/手工改过的历史会话会不一致 ——
   * 只存 `projectKey` 就拼不出日志路径，那类会话会被**静默丢掉**（核验员实测：真扫盘 2 条、CLI 只列 1 条）。
   */
  dirName: string
  sizeBytes: number
  /**
   * **最后一条对话的时间**（`user/message`/`assistant/message` 的 `time`）；`0` = 未知。
   *
   * 为什么不直接用 `mtime`：`mtime` 是「文件最后被写」，工具结果/压缩/seed 都会刷新它 ——
   * 一条只用过工具、早就没人说话的会话会被误判成"刚活动过"，白占自动候选名额。
   * 由插件 tick 写入（反向解帧算出来），CLI 直接读，**不重复付解帧的 6ms**。
   */
  lastDialogAt?: number
}

export interface SessionMetaFile {
  at: number
  version: 1
  /** 内容指纹：内容没变时只刷新 `at`，不重算 items。 */
  sig: string
  items: Record<string, SessionMetaItem>
}

export function sessionMetaPath(dshHome: string): string {
  return join(dshHome, 'cache-keepalive', 'sessions.meta.json')
}

/** 内容指纹（djb2 + 长度）：只要 mtime/title/archived/origin 变了就会变。 */
function sigOf(items: Record<string, SessionMetaItem>): string {
  const s = JSON.stringify(items)
  let h = 5381
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36) + '.' + s.length.toString(36)
}

/**
 * 读缓存。**过期 / 缺失 / 损坏一律返回 `undefined`**（调用方回落到自己扫盘）。
 */
export function readSessionMeta(
  dshHome: string,
  now = Date.now(),
  maxAgeMs = SESSION_META_MAX_AGE_MS,
): SessionMetaFile | undefined {
  try {
    const f = sessionMetaPath(dshHome)
    if (!existsSync(f)) return undefined
    const j = JSON.parse(readFileSync(f, 'utf8')) as SessionMetaFile
    if (j === null || typeof j !== 'object') return undefined
    if (j.version !== 1 || typeof j.at !== 'number' || j.items === null || typeof j.items !== 'object') return undefined
    if (!Number.isFinite(j.at) || now - j.at > maxAgeMs) return undefined
    return j
  } catch {
    return undefined
  }
}

/**
 * 把一条缓存记录补成 `SessionRow`（日志路径按 DSH 的目录约定拼）。
 *
 * 缓存里不存 `logFile`/`dir`/`cwd`/`createdAt`/`pinned` —— 那些要么能推导、要么 CLI 用不到。
 * 拼出来的路径如果文件不存在，调用方应当当作「这条缓存已失效」。
 */
export function metaToRow(dshHome: string, id: string, it: SessionMetaItem): SessionRow {
  const dir = join(dshHome, 'sessions', it.projectKey, it.dirName !== undefined && it.dirName !== '' ? it.dirName : id)
  return {
    id,
    projectKey: it.projectKey,
    dir,
    logFile: join(dir, 'session.v4.jsonl.zstd'),
    title: it.title,
    titleSource: (it.titleSource as SessionRow['titleSource']) ?? 'none',
    cwd: '',
    createdAt: 0,
    mtime: it.mtime,
    sizeBytes: it.sizeBytes,
    archived: it.archived === true,
    pinned: false,
    origin: it.origin ?? '',
    /** 最后一条对话的时间（插件 tick 算好写进缓存）。缺失 = 老缓存，调用方回落 `readLastDialogAt()`。 */
    ...(it.lastDialogAt === undefined ? {} : { lastDialogAt: it.lastDialogAt }),
  }
}

/**
 * 由插件 tick 调用：把索引写进缓存。
 *
 * @returns 是否真的写了盘（内容没变且 `at` 还新鲜时不写）。
 */
export function writeSessionMetaIfChanged(
  dshHome: string,
  rows: readonly SessionRow[],
  now = Date.now(),
  /**
   * **只在必要时**算「最后对话时间」的回调（插件传 `readLastDialogAt`）。
   *
   * 为什么要有：每拍对 459 条各解一次帧 ≈ 580ms，与 `/state` 首次请求**抢 IO**
   * （用户实测「重启后面板一直转」）。有它就能做到「`(mtime,size)` 没变且条目里已有
   * `lastDialogAt` → 直接复用，**0 解帧**」。
   */
  computeLastDialog?: (row: SessionRow) => number,
  /**
   * **只在标题可能变了时**读投影缓存标题的回调（插件传 `(r) => readProjectionTitle(dshHome, r.id)`）。
   *
   * 为什么需要：**标题不是日志 `mtime` 决定的** —— 用户手动改标题时 DSH 写进**投影缓存**，
   * 而日志文件的 `mtime`/`size` 早在标题事件落盘时就定死了。只看 `(mtime,size)` 的话，
   * meta 里的 `title` 会**永远是旧值**，网页版 / CLI 跟着一起旧。
   */
  computeProjectionTitle?: (row: SessionRow) => string | undefined,
): boolean {
  /** 一次读入旧 meta：既用于「没变就不写」，也用于「复用旧值」。 */
  const old = readSessionMeta(dshHome, now, Number.POSITIVE_INFINITY)
  const prevItems = old?.items ?? {}
  const items: Record<string, SessionMetaItem> = {}
  /** 有任何一条标题变过 → 必须写盘（否则 `sig` 相同时会被下面的「没变就不写」挡掉）。 */
  let titleChangedAny = false
  for (const r of rows) {
    const prev = prevItems[r.id]
    /** 文件层面没变（`mtime`/`size` 相同）→ `lastDialogAt` 可以复用、不解帧。 */
    const fileSame = prev !== undefined
      && prev.mtime === r.mtime
      && prev.sizeBytes === r.sizeBytes
    /**
     * **标题单独判**：读投影缓存（自带 mtime 缓存，很便宜），与旧条目的 `title` 不同就重算。
     * 读不到（实测 14% 的会话没有标题）→ 当作「没变」，保持现有行为。
     */
    const projTitle = computeProjectionTitle === undefined ? undefined : computeProjectionTitle(r)
    const titleChanged = projTitle !== undefined && projTitle !== prev?.title
    if (titleChanged) titleChangedAny = true
    /** `lastDialogAt` 的复用**只看文件层面** —— 标题变了不该连带重新解帧（那一步贵）。 */
    const reuseLastDialog = fileSame && prev.lastDialogAt !== undefined
    const lastDialogAt = r.lastDialogAt !== undefined
      ? r.lastDialogAt
      : reuseLastDialog
        ? prev.lastDialogAt
        : computeLastDialog === undefined ? undefined : computeLastDialog(r)
    /** 标题取值：投影缓存优先（那就是最新值），否则用行里的（日志头部）。 */
    const title = projTitle !== undefined ? projTitle : r.title
    const titleSource = projTitle !== undefined ? 'provider' : r.titleSource
    items[r.id] = {
      mtime: r.mtime,
      title,
      titleSource,
      archived: r.archived === true,
      origin: r.origin ?? '',
      projectKey: r.projectKey,
      dirName: r.dir.split(/[\\/]/).pop() ?? r.id,
      sizeBytes: r.sizeBytes,
      ...(lastDialogAt === undefined ? {} : { lastDialogAt }),
    }
  }
  const sig = sigOf(items)
  /** 内容没变、标题也没变、且上次刷新没超过 TOUCH_INTERVAL_MS → 不写（避免每拍 40KB 写放大）。 */
  if (!titleChangedAny && old !== undefined && old.sig === sig && now - old.at < TOUCH_INTERVAL_MS) return false

  const file = sessionMetaPath(dshHome)
  const payload: SessionMetaFile = { at: now, version: 1, sig, items }
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp-' + process.pid
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    /** 写失败不影响主流程（CLI 会回落扫盘）。顺手清理临时文件。 */
    try { rmSync(file + '.tmp-' + process.pid, { force: true }) } catch { /* ignore */ }
    return false
  }
}
