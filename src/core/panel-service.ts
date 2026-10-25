/**
 * 面板的**纯 Node 数据服务** —— 让面板在没有任何 DSH 实例时也能跑（`cli --serve`）。
 *
 * ## 与插件侧的分工
 * 插件侧的 `snapshot()` 能拿到活信息（`agent.status`、实时标题投影、真实路由），
 * 这里只有磁盘上的会话日志 + `state.json` + 可选的 `runtime.json`。
 * 所以同一个面板，两套数据源：**字段名与语义保持一致**，前端一行不用改。
 *
 * ## `runtime.json`（由任意 DSH 实例写，本服务只读）
 * 解决「CLI 看不到 running / 标题不准」这两个独有短板：
 * ```
 * { updatedAt, instances: [{ profile, pid, port }],
 *   sessions: { "<id>": { running: true, title: "准确标题" } } }
 * ```
 * 读不到就退回磁盘信息（mtime / 日志头标题），绝不因此报错。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { listSessions, readMarksCached, readRoundsCachedWithText, readLastDialogAt, readProjectionTitle, readSessionModel, decodeMultiFrame, type SessionRow } from './sessions.ts'
import { readSessionMeta, sessionMetaPath, type SessionMetaFile } from './session-meta.ts'
import { detectPrefixRewrite, rewriteFpOf, rewriteOfFile, type PrefixRewrite } from './rewrite.ts'
import { markItem } from './rewrite-probe.ts'

/**
 * 「前缀被改写」缓存（按日志 mtime 失效）。
 *
 * 只有**候选会话 / 置顶会话**才实际去算 —— 339 条会话逐条解压要几十秒，
 * 而面板每 10 秒轮询一次，不可能每条都算。
 */
const REWRITE_CACHE = new Map<string, { mtime: number; val: PrefixRewrite | undefined }>()

function rewriteOf(row: SessionRow): PrefixRewrite | undefined {
  let mtime = 0
  try {
    mtime = statSync(row.logFile).mtimeMs
  } catch {
    return undefined
  }
  const hit = REWRITE_CACHE.get(row.logFile)
  if (hit !== undefined && hit.mtime === mtime) return hit.val
  let val: PrefixRewrite | undefined
  try {
    const events = decodeMultiFrame(readFileSync(row.logFile)).text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try { return JSON.parse(line) as { type?: string; seq?: number; data?: unknown } } catch { return undefined }
      })
      .filter((x) => x !== undefined)
    val = detectPrefixRewrite(events)
  } catch {
    val = undefined
  }
  REWRITE_CACHE.set(row.logFile, { mtime, val })
  if (REWRITE_CACHE.size > 600) {
    const oldest = REWRITE_CACHE.keys().next().value
    if (oldest !== undefined) REWRITE_CACHE.delete(oldest)
  }
  return val
}
import { costAt, hitRate, normalizePrices, priceFingerprint, promptTokens, recomputeCost } from '../econ.ts'
import { decideWarm, type GateInput } from '../gate.ts'
import { decideCandidates } from './candidates.ts'
import {
  appendLedger, beginNewCycle, cycleOf, cycleSpendOf, cycleStatsOf, isTripped, ledgerOf, loadState, policyOf, saveState, setPolicy,
  untripSession,
  statePath, type LedgerEntry, type State,
} from '../store.ts'
import { buildGateInput } from './gate-input.ts'
import { modelChangedOf } from './model-switch.ts'
import { applySettingsPatch, labRestoreBackup, labSnapshotOf } from './settings.ts'
import { buildLedgerEntry, spendAtCurrentPrices } from './ledger-entry.ts'
import { BUILD_ID } from '../build-id.ts'
import { GATE_TEXTS } from './gate-texts.ts'
import type { RouteDeps } from '../routes.ts'

function trippedOf(state: State, id: string, lastActivityAt: number, at = Date.now()): boolean {
  return isTripped(state, id, state.settings.circuitHitRate, lastActivityAt, at)
}

/** 时间轴结果缓存（`id|粒度` → {at, val}），TTL 由设置里的 timelineCacheMinutes 控制。 */
const TL_CACHE = new Map<string, { at: number; val: unknown }>()

/** 会话 id 缩写长度（与插件侧一致）。 */
const SHORT = 22
const shortId = (id: string): string => (id.length > SHORT ? id.slice(-SHORT) : id)

/** `runtime.json` 里一个实例的运行时信息。 */
export interface RuntimeSession {
  /** 是否正在跑回合（真实请求就在刷新缓存 → 不该保温）。 */
  running?: boolean
  /** 准确标题（实时投影优先于日志头）。 */
  title?: string
}

export interface RuntimeSnapshot {
  /** 写入时刻（毫秒）。太旧视为无效。 */
  updatedAt: number
  /** 写入方实例列表（诊断用）。 */
  instances?: { profile: string; pid: number; port?: number }[]
  /** 会话 id → 运行时信息。 */
  sessions: Record<string, RuntimeSession>
}

/** `runtime.json` 的默认位置（与 `state.json` 同目录）。 */
export function runtimePath(dshHome?: string): string {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'cache-keepalive', 'runtime.json')
}

/** `runtime.json` 超过这个年龄就当作失效（实例可能已经关了）。 */
const RUNTIME_TTL_MS = 5 * 60_000

/**
 * 读运行时快照。
 * @param file 路径
 * @param now 当前时间
 * @returns 快照；文件不存在/坏掉/过期都返回 `undefined`
 */
export function readRuntime(file = runtimePath(), now = Date.now()): RuntimeSnapshot | undefined {
  try {
    if (!existsSync(file)) return undefined
    const raw = JSON.parse(readFileSync(file, 'utf8')) as RuntimeSnapshot
    if (raw === null || typeof raw !== 'object') return undefined
    if (typeof raw.updatedAt !== 'number' || now - raw.updatedAt > RUNTIME_TTL_MS) return undefined
    if (raw.sessions === null || typeof raw.sessions !== 'object') return undefined
    return raw
  } catch {
    return undefined
  }
}

/** 服务依赖：`warm` 由调用方注入（要真实发请求，不能在这里实现）。 */
export interface PanelServiceOptions {
  /** DSH 主目录。 */
  dshHome?: string
  /** 立刻保温一次并返回给面板的一句话结果。 */
  warm: (id: string, force?: boolean) => Promise<{ ok: boolean; message?: string; error?: string }>
  /** 当前时间（测试可注入）。 */
  now?: () => number
  /**
   * 守护循环是否开启（`--serve --auto` 才开）。面板据此显示红字警告，
   * 免得用户以为「只开了面板」而实际每 60 秒在真实 home 上花真钱。
   */
  loopEnabled?: boolean
}

/** 面板数据服务 —— 直接满足 `routes.ts` 的 `RouteDeps`。 */
export interface PanelService extends RouteDeps {
  /** 这一拍该不该保温（守护循环用，与面板显示同一个判据）。 */
  gateOf(id: string): { ok: boolean; code: string; detail: string }
}

/**
 * 造一个纯 Node 的面板服务。
 *
 * @param options 依赖注入
 */
export function createPanelService(options: PanelServiceOptions): PanelService {
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const file = join(dshHome, 'cache-keepalive', 'state.json')
  const now = options.now ?? Date.now

  /** 每次都重新读盘：本服务是**唯一写者**，但仍要反映别处（手改文件、CLI 单发）的改动。 */
  const stateOf = (): State => loadState(file)
  /**
   * 会话清单（**带 60 秒缓存**）。
   *
   * 为什么必须有：`listSessions` 要解压 320 个日志头（每 256KB）≈ 1.7 秒，
   * 而面板每 15 秒拉一次 `/state`，无缓存时单线程全程阻塞、一次「保存策略」要等 3.5 秒。
   * 60 秒与插件侧 `SessionIndex` 的 TTL 一致；新会话最多晚 60 秒出现。
   */
  let rowsCache: { rows: SessionRow[]; at: number } | undefined
  const rowsOf = (force = false): SessionRow[] => {
    const t = now()
    if (!force && rowsCache !== undefined && t - rowsCache.at < 60_000) return rowsCache.rows
    const rows = listSessions(dshHome, { headBytes: 256 * 1024 })
    rowsCache = { rows, at: t }
    return rows
  }

  /**
   * **某会话「最后一条对话」的时间**（毫秒；`0` = 确实没有对话记录）。
   *
   * 口径与插件侧 `index.ts` 的 `dialogFor(id)` 一致：先读 `sessions.meta.json`（插件 tick 写好的，
   * 零 IO，60 秒缓存与 `rowsCache` 同 TTL）→ 缺失才回落 `readLastDialogAt()`（尾部解帧）。
   *
   * **为什么所有「活动时间」都必须用它、不能再用 `row.mtime`**：
   * `mtime` 只是「日志最后被写」—— 打开一条老会话、跑 skill、写 seed 事件都会刷新它。
   * 用 mtime 当活动时间会让「只点开过、几天没聊」的会话被误判成「刚活动过」：
   * 门禁返回 `warm`（其实早过闲置上限）、自动候选把它选中（`isAutoCandidate=true`）。
   * 2026-10-20 实测该会话 `lastDialogAt=10-18 06:30` 而 `mtime=10-20 22:22` → 网页版 status 全错。
   *
   * ⚠️ **必须走 `readSessionMeta()`，不许自己 `readFileSync` + `JSON.parse`**：
   * meta 只有插件 tick 会写，实例关掉/插件被禁用后文件就冻在最后一次写盘时刻，里面的
   * `lastDialogAt` 全是旧的。2026-10-22 实测：文件冻在 23:53:26，两条刚聊完的会话被显示成
   * 「5.5 小时前」。`readSessionMeta()` 按 `at` 判过期（> 5 分钟 → `undefined`），
   * 过期就整体回落解帧，正是要的行为（与 `cli/keepalive.mjs:514` 同一条路）。
   * 传 `t` 而不是让默认参数取 `Date.now()`：否则注入的虚拟时钟对这个判定无效，测试里
   * 永远算成「负年龄 = 新鲜」。
   *
   * 缓存项带**文件指纹**：插件 tick 每 60 秒重写一次 meta（内容不变也刷新 `at`），
   * 只按时间缓存的话，面板正好在 meta 过期那一刻读过一次，就会把「undefined」结论钉住 60 秒——
   * 期间 tick 已经写过新 meta，面板却还显示旧结论。
   * ⚠️ 指纹**不能只用 `mtimeMs+size`**：同一 mtime 刻度内用**等长**内容重写（`at` 变了、字数没变）
   * 时两者一模一样，缓存照样命中旧结论（实测抓得到）。而「mtime 撞车」在快盘上并不罕见，
   * 光靠 `sleep` 去规避只是把不确定性推给运行环境。
   * 所以指纹 = `mtimeMs:size` + **内容 sha1**：每次读完整份 meta 再哈希 ——
   * 实测 176KB、**≈0.25ms/次**；换来的是「内容一变就一定重算」，与 mtime 精度彻底解耦。
   * `JSON.parse` 仍按 TTL 缓着，哈希只用来判「要不要重解析」。
   *
   * ⚠️ **指纹每快照只算一次**（`dialogFp`，由 `snapshot()` 开头 `beginDialogEpoch()` 作废）。
   * `dialogOf` 在一条快照里被调 **4 次/条会话**（`activityOf` 三处调用点 + `build()` 里 `dialogAt`），
   * 520 条 = **2080 次**；每次调用都算指纹 = 每快照读盘 **~400MB**，
   * 热态从基线 **58~65ms 劣化到 ~650ms（10 倍）**。
   * ⚠️ 记忆的键**不能是 `t`**：`now()` 在一条快照里被调 2083 次，`Date.now()` 逐次推进，
   * 每个 `t` 都不同 → 按 `t` 记忆等于没记（实测仍 ~650ms）。必须按**快照边界**作废：
   * 本次快照内复用同一份指纹，下一次快照必然重算 → meta 一变立刻感知（判据 2b 仍成立）。
   */
  let dialogCache: { meta: SessionMetaFile | undefined; fp: string; at: number } | undefined
  /** 本次快照的 meta 指纹；`undefined` = 还没算过（= 本次快照第一次问）。 */
  let epochFp: string | undefined
  /**
   * **本拍**算出来的会话 → 对话时间。
   *
   * 为什么要有它：meta 过期时（实例停掉后 meta 就冻住，`readSessionMeta` 必然返回
   * `undefined`）每条都要回落 `readLastDialogAt()` 解帧，**单次 36µs**；而 `dialogOf` 一条
   * 快照里被问 4 次 → 520 条 = 2080 次 = **~75ms 白算**（同样的输入问 4 遍）。
   * 本拍记住就只算 1 次（520 次 ≈ 19ms），下一次快照开头作废 —— 与 `epochFp` 同生命周期，
   * 所以 meta/日志一变下一拍立刻反映，不会陈旧。
   */
  let epochDialog: Map<string, number> | undefined
  /** 快照边界：作废指纹与对话时间记忆，下一次 `dialogOf` 必然重算。 */
  const beginDialogEpoch = (): void => { epochFp = undefined; epochDialog = undefined }
  const dialogFp = (): string => {
    if (epochFp !== undefined) return epochFp
    let fp = ''
    try {
      const st = statSync(sessionMetaPath(dshHome))
      fp = st.mtimeMs + ':' + st.size + ':' + createHash('sha1').update(readFileSync(sessionMetaPath(dshHome))).digest('hex')
      /** 文件不在 → fp 保持空串：与任何已缓存的指纹都不同，缓存自然失效。 */
    } catch { /* 读不到就按「没有 meta」处理 */ }
    epochFp = fp
    return fp
  }
  const dialogOf = (row: SessionRow): number => {
    const hit = epochDialog?.get(row.id)
    if (hit !== undefined) return hit
    const t = now()
    const fp = dialogFp()
    const ttlHit = dialogCache !== undefined && t - dialogCache.at < 60_000
    if (ttlHit && dialogCache.fp === fp) {
      /** 内容一个字节都没变 → 直接复用解析结果。 */
    } else {
      dialogCache = { meta: readSessionMeta(dshHome, t), fp, at: t }
    }
    const cached = dialogCache.meta?.items?.[row.id]?.lastDialogAt
    if (typeof cached === 'number') return cached
    if (typeof row.lastDialogAt === 'number' && row.lastDialogAt > 0) return row.lastDialogAt
    const at = readLastDialogAt(row.logFile)
    ;(epochDialog ??= new Map()).set(row.id, at)
    return at
  }

  /**
   * **门禁 / 候选 / 「最后活动」显示用的时间** = 真·最后对话时间，**不做任何 mtime 回落**。
   *
   * `0` = 从没对话过（实测 82/483 条）= **活动时间未知**，必须让它一路传到 `gate.ts` 的
   * `lastActivityAt === 0` 分支判 `cold-window`（不保温）。
   * 这里曾经回落过 `row.mtime`，那等于「没聊过也算刚活动过」—— 与插件侧判据直接打架
   * （插件侧 `gate.ts:161` 就是按 0 判的），两边结果会对不上。
   */
  const activityOf = (row: SessionRow): number => dialogOf(row)

  /** 门禁输入 —— 与插件侧 / CLI 共用 `buildGateInput()`。 */
  function gateInputOf(
    state: State,
    row: SessionRow,
    runtime: RuntimeSnapshot | undefined,
    withRewrite = false,
  ): GateInput {
    const rw = withRewrite ? rewriteOf(row) : undefined
    const dialogAt = activityOf(row)
    return buildGateInput(state, {
      id: row.id,
      mtime: row.mtime,
      /** 子代理走短间隔、不吃 delay（见 `gate.ts` 的 `isSubagent`）。 */
      isSubagent: row.origin === 'subagent',
      /** **闲置/断档判据一律用「最后对话」**：`mtime` 会被「点开过」刷新（见 `dialogOf` 注释）。 */
      lastActivityAt: dialogAt,
      archived: row.archived === true,
      hasRoute: true,
      /** 按模型自定义门槛（`settings.modelOverrides`）。 */
      ...((): Record<string, string> => { const m = readSessionModel(row.logFile); return m === undefined ? {} : { provider: m.provider, model: m.model } })(),
      /**
       * **熔断解除看 `mtime`、不看对话时间**（与插件侧 `lastActiveOf = max(内存活动, mtime)` 同义）：
       * 熔断问的是「**有没有人碰过这条会话**」——点开也算碰过，点开就会重建缓存、就该解除。
       * 用对话时间会分叉：插件侧点开即解除，网页版仍判熔断（实测 repro-tripfork：一边 warm、一边 tripped）。
       * 注意与上一行 `lastActivityAt` 不冲突：那是「闲置多久」，必须看对话。
       */
      tripped: trippedOf(state, row.id, row.mtime),
      agentStatus: runtime?.sessions[row.id]?.running === true ? 'running' : 'idle',
      ...(rw === undefined ? {} : { rewritten: true, rewriteDetail: rw.detail }),
    })
  }

  /**
   * 自动候选（纯函数，池子从磁盘构造）。
   *
   * 判定**不在本服务里做**：统一走 `core/candidates.ts:decideCandidates()`（与插件 tick / CLI 同一份）。
   * 这里只把 `SessionRow` 映射成 `CandidateRow`。
   */
  function decisionsOf(state: State, rows: readonly SessionRow[]) {
    return decideCandidates(
      state,
      rows.map((r) => {
        const dialogAt = activityOf(r)
        return {
          id: r.id,
          mtime: r.mtime,
          /** 候选池的「闲置」也按最后对话算；不传会回落 `mtime` → 只点开过的会话被误选。 */
          lastActiveAt: dialogAt,
          archived: r.archived === true,
          origin: r.origin,
          title: r.title,
          /** 覆盖成与门禁同口径的熔断判定（同样用 `mtime`，理由见 `gateInputOf`）。 */
          tripped: trippedOf(state, r.id, r.mtime),
        }
      }),
      now(),
      {
        enabled: state.settings.autoEnabled,
        count: state.settings.autoCount,
        maxIdleHours: state.settings.idleLimitHours,
        allowSubagent: state.settings.autoAllowSubagent,
      },
    )
  }

  function gateOf(id: string): { ok: boolean; code: string; detail: string } {
    const state = stateOf()
    const row = rowsOf().find((r) => r.id === id || r.id === id || r.id.endsWith(id))
    if (row === undefined) return { ok: false, code: 'no-agent', detail: '找不到这条会话' }
    const g = decideWarm(gateInputOf(state, row, readRuntime(runtimePath(dshHome), now())))
    return g.ok ? { ok: true, code: 'warm', detail: '' } : { ok: false, code: g.code, detail: g.detail }
  }

  function snapshot(): unknown {
    const t = now()
    /** 快照边界：本拍的 meta 指纹在这里作废，第一次 `dialogOf` 会重算（见 `dialogFp`）。 */
    beginDialogEpoch()
    const state = stateOf()
    const rows = rowsOf()
    const runtime = readRuntime(runtimePath(dshHome), t)
    const decisions = decisionsOf(state, rows)
    const pinned = new Set(state.pinnedSessions ?? [])

    const built = rows.map((meta) => {
      const policy = policyOf(state, meta.id)
      const led = ledgerOf(state, meta.id)
      const last = led[led.length - 1]
      /**
       * 只给「候选 / 置顶 / 有保温账本」的会话算「前缀改写」—— 其余按未改写处理。
       * 339 条逐条解压要几十秒；实际会保的就候选那几条 + 保过的那几十条，且 rewriteOf 按 mtime 缓存。
       */
      const dec = decisions.get(meta.id)
      const isPanelPinned = pinned.has(meta.id)
      /**
       * ⚠️ 必须用 `dec.picked`：`pickAutoCandidates` 对池里**每一条**都返回 decision（未选中的 picked=false），
       * 用 `dec !== undefined` 会让 339 条全部去解压日志 → 单次 snapshot 10 秒、面板全超时。
       */
      /**
       * 只给「真入选候选 / 置顶 / 手动强制开」算前缀改写。
       * - 必须用 `dec.picked`：`pickAutoCandidates` 对池里每条都返回 decision；
       * - `mode='on'` 的会话在 `auto.ts` 里直接 `continue`，`picked` 恒 false，得单独判；
       * - **不加「有账本」**：实测 45 条有账本里 0 条处于改写，花 4s 解压换零收益。
       */
      const withRewrite = dec?.picked === true || isPanelPinned || policyOf(state, meta.id).mode === 'on'
      const gate = decideWarm(gateInputOf(state, meta, runtime, withRewrite))
      /**
       * 同一次 snapshot 内**只算一次**：
       * `dialogAt` = 纯对话时间（「上次对话」列），`activityAt` = 活动时间（门禁/候选/「最后活动」列）。
       */
      const dialogAt = dialogOf(meta)
      const activityAt = activityOf(meta)
      const rt = runtime?.sessions[meta.id]
      /**
       * **标题优先级**（与插件侧 `src/index.ts:titleOf` 对齐，两版列表必须显示同一个名字）：
       *  ① `rt.title` —— `runtime.json` 里活会话的实时投影（CLI 侧永远是空）
       *  ② `readProjectionTitle()` —— DSH 的标题投影缓存（`storages/session_projcache`）。
       *     这是**最新标题的权威来源**：日志头部只扫 256KB，重命名事件可能落在文件中部
       *     （实测某会话最新标题在 24% 位置），全库 510 条里 31 条因此显示旧名。
       *     纯文件读取，CLI 侧 `--serve` 一样能读，不需要宿主服务。
       *  ③ `meta.title` —— 磁盘索引（可能旧；**可能是空串**，交给前端显示「(无标题)」）
       *
       * ⚠️ 之前只有 ①③，所以网页版显示旧标题（插件版 `aa0b855` 已改，网页版漏了）。
       * **不在这里回落 `meta.id`**：插件侧 `titleOf` 查不到就返回空串，前端 `panel.ts:1812`
       * 对空标题显示「(无标题)」。这里多给 id 会让「网页版 vs 插件版标题逐条对比」出现 83 条假差异。
       */
      const projTitle = readProjectionTitle(dshHome, meta.id)
      const title = (rt?.title !== undefined && rt.title !== '')
        ? rt.title
        : (projTitle !== undefined && projTitle !== '' ? projTitle : meta.title)
      const running = rt?.running === true
      return {
        id: meta.id,
        short: shortId(meta.id),
        title,
        titleSource: meta.titleSource,
        sizeBytes: meta.sizeBytes,
        mtime: meta.mtime,
        projectKey: meta.projectKey,
        archived: meta.archived,
        pinned: meta.pinned,
        pinnedInPanel: pinned.has(meta.id),
        origin: meta.origin,
        /** 纯 Node 服务里没有「本进程内」概念：一律可以保（这正是脱离 DSH 的意义）。 */
        live: true,
        status: running ? 'running' : 'idle',
        route: '',
        mode: policy.mode,
        note: policy.note ?? '',
        isAutoCandidate: dec?.picked ?? false,
        autoRank: dec?.rank ?? -1,
        autoReason: dec?.reason ?? '',
        /**
         * **最后一条对话的时间**（面板「上次对话」列 + 「只看有对话的」筛选都用它）。
         *
         * 口径与插件侧 `index.ts` 的 `dialogFor(id)` 一致：先看元数据缓存（插件 tick 写好的，
         * 零 IO）→ 缺失才回落 `readLastDialogAt()`（尾部解帧，内部按 mtime+size 缓存）。
         * **必须给数字**：`0` = 这条会话确实没有对话记录（列表显示 —、筛选会把它滤掉）；
         * `undefined` 的语义是「这个 snapshot 根本没提供该字段」→ 筛选必须恒放行，否则整张表会被滤空。
         * 2026-10-20 这里漏了字段，网页版「上次对话」列恒显示 —（而 116 个单测全绿，无任何断言覆盖）。
         */
        lastDialogAt: dialogAt,
        /** 「最后活动」= 最后对话（面板表格的 `activeOf` 再与「最后保温」取大，见 `panel.ts`）。 */
        /** 活动未知（`0`）给 `-1`：前端按 `< 0` 显示「—」并排到最后（不会算出 1970 年的分钟数）。 */
        lastActiveAgoSec: activityAt > 0 ? Math.round((t - activityAt) / 1000) : -1,
        gateOk: gate.ok,
        /** 长闲置二档（「断档过久」/「闲置过久」）：只影响文案，不影响判定。 */
        gateLong: gate.ok !== true && gate.long === true,
        gateCode: !gate.ok ? gate.code : 'warm',
        gateDetail: !gate.ok ? gate.detail : '',
        lastTouchAgoMin: last === undefined ? -1 : Math.round((t - last.at) / 60000),
        /** 与门禁、候选池同一口径（都取最后对话），不再用 `mtime`。 */
        lastActivityAgoMin: activityAt > 0 ? Math.round((t - activityAt) / 60000) : -1,
        last: last === undefined ? null : {
          at: last.at,
          hitRate: last.hitRate,
          hitTokens: last.hitTokens,
          promptTokens: last.promptTokens,
          /** 展示按**当前价格**重算（账本 `cost` 是记账快照，改价后要跟着变）；判定方另看存储值。 */
          cost: recomputeCost(last, state.settings).cost,
          ms: last.ms,
          touch: last.touch,
          via: last.via ?? 'cli',
          /** 与插件侧同口径：面板据此标「换模型」（见 `core/model-switch.ts`）。 */
          modelChanged: modelChangedOf(led[led.length - 2], last),
          ...(last.model === undefined ? {} : { model: last.model }),
        },
        /** **展示**花费按**当前价格**重算（与插件侧 snapshot 同口径）；预算/熔断仍用存储 `e.cost`。 */
        spend: spendAtCurrentPrices(led, state.settings).cost,
        cycle: cycleOf(state, meta.id),
        /** 本周期花费（**账本口径**：真实花过的钱，改价不影响 —— 判定方在用，别改）。 */
        cycleSpend: cycleSpendOf(state, meta.id),
        /** 本周期花费（**展示口径**：逐笔按当前价重算，面板一列表加详情「本期」都读它）。 */
        cycleSpendDisplay: spendAtCurrentPrices(
          led.filter((e) => (e.cycle ?? 1) === cycleOf(state, meta.id)), state.settings,
        ).cost,
        cycleCount: led.filter((e) => (e.cycle ?? 1) === cycleOf(state, meta.id)).length,
        warmCount: led.length,
        count: led.length,
        tripped: trippedOf(state, meta.id, meta.mtime, t),
        prompt: policy.prompt ?? '',
        maxTokens: policy.maxTokens ?? state.settings.maxTokens,
        /**
         * 生效间隔（秒）：下限 **1 秒**（试验模式 30 秒不能被显示成 60），
         * `Number(x) || 60` 只兜脏值（0/NaN → 60），与 `core/gate-input.ts:intervalOf()` 同口径。
         */
        intervalSeconds: Math.round(Math.max(1, Number(policy.intervalSeconds ?? state.settings.intervalSeconds) || 60)),
        maxTouches: policy.maxTouches ?? state.settings.maxTouches,
        maxTouches: policy.maxTouches ?? state.settings.maxTouches,
      }
    })

    // 活跃的排前面（正在跑的 → 最近活动的）
    built.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'running' ? -1 : 1
      return b.mtime - a.mtime
    })

    return {
      /** 供 `routes.ts` 在服务端把 `<body class="v-cli">` 写进 HTML（首屏就取消 130px），见 `RouteDeps.variant`。 */
      variant: 'cli' as const,
      now: t,
      /** 面板变体：CLI 网页版没有活 agent、列宽也用自己的那一份。 */
      variant: 'cli',
      loopEnabled: options.loopEnabled === true,
      settings: state.settings,
      /** 试验模式三块数据：与插件版共用同一工厂。 */
      ...labSnapshotOf(state),
      build: BUILD_ID,
      gateTexts: GATE_TEXTS,
      sessions: built,
      diskCount: rows.length,
      liveCount: built.filter((x) => x.status === 'running').length,
      lastScanAt: t,
      scanError: '',
      statePath: file,
      dshHome,
      panelPath: '/api/cache-keepalive/panel',
      apiPrefix: '/api/cache-keepalive',
      tickCount: 0,
      lastTickAt: 0,
      tickMs: 60_000,
      /** 无实例服务没有「自动激活」——所有会话本来就能保。 */
      runtime: runtime === undefined
        ? null
        : { updatedAt: runtime.updatedAt, instances: runtime.instances ?? [], count: Object.keys(runtime.sessions).length },
    }
  }

  return {
    snapshot,
    /** 时间轴结果缓存：解压整份日志很贵，同一条在 TTL 内直接复用。 */
    async timeline(id: string, granularityIn?: string) {
      const st = stateOf()
      const ttl = Math.max(0, Number(st.settings.timelineCacheMinutes ?? 10)) * 60_000
      /**
       * 缓存键带账本戳（条数 + 末条时刻）：不带的话新保温的那几轮在 TTL 内永不出现。
       * 再带价格指纹：改价后旧缓存里的花费是按旧价算的，不失效就成了「改了价详情不变」。
       */
      const led = st.ledger[id] ?? []
      const priceFp = priceFingerprint(st.settings)
      const key =
        id + '|' + (granularityIn ?? '') + '|' + led.length + '|' + (led[led.length - 1]?.at ?? 0) + '|' + priceFp
      if (ttl > 0) {
        const hit = TL_CACHE.get(key)
        if (hit !== undefined && Date.now() - hit.at < ttl) return hit.val
      }
      const self = this as unknown as { timelineUncached: (i: string, g?: string) => Promise<unknown> }
      const out = await self.timelineUncached(id, granularityIn)
      if (ttl > 0) {
        TL_CACHE.set(key, { at: Date.now(), val: out })
        if (TL_CACHE.size > 8) {
          const oldest = TL_CACHE.keys().next().value
          if (oldest !== undefined) TL_CACHE.delete(oldest)
        }
      }
      return out
    },
    gateOf,
    setPolicy(id, patch) {
      const state = stateOf()
      const rows = rowsOf()
      const full = rows.find((r) => r.id === id) ?? rows.find((r) => r.id.endsWith(id))
      const target = full?.id ?? id
      const nextPatch = patch
      setPolicy(state, target, nextPatch)
      saveState(state, file)
      return { ok: true }
    },
    setSettings(patch) {
      const state = stateOf()
      /** 恢复残留的 `labBackup`：与插件版同一入口（不能走 applySettingsPatch({labMode:false})）。 */
      if (patch !== null && typeof patch === 'object' && (patch as Record<string, unknown>).restoreLabBackup === true) {
        const r = labRestoreBackup(state)
        if (!r.ok) return { ok: false, error: r.error }
        saveState(state, file)
        return { ok: true, warning: '已还原：' + (r.restored ?? []).join(' / ') }
      }
      // ⚠️ 必须走共用实现：直接 `store.setSettings` 会绕过试验模式的 LAB_OVERRIDES，
      // 面板显示「试验模式运行中」但时间参数一个都没压（核实员实测的假开关）
      const out = applySettingsPatch(state, patch)
      // 关系校验不通过 → **不写盘**（整批未生效、labBackup 也没动），错误原样抛给面板
      if (out.error !== undefined) return { ok: false, error: out.error }
      saveState(state, file)
      // `notice` = 自动改了别的字段，面板要 toast 出来（不许静默）
      return { ok: true, ...(out.notice === undefined ? {} : { warning: out.notice }) }
    },
    /**
     * 解除熔断：与插件侧 `index.ts:resetCircuit` 同一条路 —— **不删记录**，只记会话级解熔标记。
     * 只改插件侧会留下失效路径：用户从网页面板点解熔仍会清空账本。
     */
    reset(id) {
      const state = stateOf()
      const rows = rowsOf()
      const full = rows.find((r) => r.id === id) ?? rows.find((r) => r.id.endsWith(id))
      const target = full?.id ?? id
      untripSession(state, target)
      saveState(state, file)
      return { ok: true }
    },
    setPinned(id, pinned) {
      const state = stateOf()
      const set = new Set(state.pinnedSessions ?? [])
      if (pinned) set.add(id)
      else set.delete(id)
      state.pinnedSessions = [...set]
      saveState(state, file)
      return { ok: true }
    },
    resetCost(id) {
      const state = stateOf()
      const rows = rowsOf()
      const full = rows.find((r) => r.id === id) ?? rows.find((r) => r.id.endsWith(id))
      const target = full?.id ?? id
      const cycle = beginNewCycle(state, target)
      saveState(state, file)
      return { ok: true, cycle }
    },
    costs(id) {
      const state = stateOf()
      const rows = rowsOf()
      const row = rows.find((r) => r.id === id) ?? rows.find((r) => r.id.endsWith(id))
      const target = row?.id ?? id
      const s = state.settings
      /**
       * 各周期金额按**当前价格**重算（账本 `cost` 是记账时快照，改价后要跟着变）：
       * 面板的花费详情与插件侧 `index.ts` 的 `--costs` 必须同口径，否则同一会话两个金额。
       */
      const live = new Map<number, number>()
      for (const e of ledgerOf(state, target)) {
        const c = e.cycle ?? 1
        live.set(c, (live.get(c) ?? 0) + recomputeCost(e, s).cost)
      }
      const cycles = cycleStatsOf(state, target).map((c) => ({ ...c, cost: live.get(c.cycle) ?? c.cost }))
      return {
        ok: true,
        id: target,
        short: shortId(target),
        current: cycleOf(state, target),
        total: cycles.reduce((s, c) => s + c.cost, 0),
        count: cycles.reduce((s, c) => s + c.count, 0),
        cycles,
      }
    },
    async ping(id, force) {
      return options.warm(id, force)
    },
    async timelineUncached(id, granularityIn) {
      const state = stateOf()
      const rows = rowsOf()
      const row = rows.find((r) => r.id === id) ?? rows.find((r) => r.id.endsWith(id))
      if (row === undefined) return { ok: false, error: '找不到该会话' }
      /**
       * **一次解码、两处复用**（与插件侧 `index.ts` 同口径）：缓存未命中时 `readRoundsCachedWithText`
       * 把解压后的 text 交回来供 `readMarks` 复用，text 不进任何缓存。
       */
      const { rounds, text: roundsText } = readRoundsCachedWithText(row.logFile)
      const warms = ledgerOf(state, row.id)
      const s = state.settings
      /** 请求参数优先；面板详情页每次都显式传 `granularity`，缺省按 step。 */
      const gran = granularityIn === 'step' || granularityIn === 'turn' || granularityIn === 'both'
        ? granularityIn
        : 'step'
      /** 价格归一化只做一次（原来每条 round 都 `normalizePrices` 一遍）。 */
      const normPrices = normalizePrices(s.prices)
      const costOfRound = (r: typeof rounds[number]) =>
        costAt({ cacheReadTokens: r.hitTokens, inputTokens: r.missTokens, outputTokens: r.outputTokens },
          normPrices, r.model, s.pricesByModel ?? {}, s.tariff ?? {}, r.time)
      const itemOf = (r: typeof rounds[number], g: 'step' | 'turn') => {
        const total = r.hitTokens + r.missTokens
        const c = costOfRound(r)
        return {
          kind: 'round', gran: g, source: 'round', time: r.time, turn: r.turn, step: r.step,
          provider: r.provider, model: r.model,
          hitTokens: r.hitTokens, missTokens: r.missTokens, outputTokens: r.outputTokens,
          hitRate: total === 0 ? 0 : r.hitTokens / total,
          cost: c.cost, factor: c.factor, factorLabel: c.label,
        }
      }
      let items: Record<string, unknown>[] = rounds.map((r) => itemOf(r, 'step'))
      if (gran === 'turn' || gran === 'both') {
        const byTurn = new Map<number, typeof rounds[number][]>()
        for (const r of rounds) {
          const list = byTurn.get(r.turn) ?? []
          list.push(r)
          byTurn.set(r.turn, list)
        }
        const turnItems = [...byTurn.entries()].map(([turn, list]) => {
          const pick = list[0]
          const hitTokens = list.reduce((x, r) => x + r.hitTokens, 0)
          const missTokens = list.reduce((x, r) => x + r.missTokens, 0)
          const outputTokens = list.reduce((x, r) => x + r.outputTokens, 0)
          const total = hitTokens + missTokens
          /**
           * **口径统一（原来这一行是错的）**：以前先用「合并后的 token」算一次 `costAt`，
           * 紧接着又被「逐条相加」覆盖 —— token/hitRate 按合并、cost 按逐条，同一行两个口径，
           * 跨峰谷时段时拿它乘单价必然对不上。现在 token / cost / factor **全部按逐条求和**：
           * 合并后的 token 只是求和结果，不再单独计价。
           */
          const costs = list.map(costOfRound)
          const sameFactor = costs.every((c) => c.factor === costs[0].factor)
          return {
            kind: 'round', gran: 'turn', source: 'round',
            time: Math.min(...list.map((r) => r.time)),
            /** 渲染侧按 `[time, endTime]` 画区间条（同一轮的多条 step 要合成一根）。 */
            endTime: Math.max(...list.map((r) => r.time)),
            turn, step: 0, steps: list.length,
            provider: pick.provider, model: pick.model,
            hitTokens, missTokens, outputTokens,
            hitRate: total === 0 ? 0 : hitTokens / total,
            cost: costs.reduce((x, c) => x + c.cost, 0),
            factor: sameFactor ? costs[0].factor : 0,
            factorLabel: sameFactor ? costs[0].label : '跨时段',
          }
        })
        items = gran === 'turn' ? turnItems : [...items, ...turnItems]
      }
      /** 计算轮次（压缩 / goal）：与保温并列，解释「这一轮之后为什么没保」。走唯一工厂，别手写。 */
      const marks = readMarksCached(row.logFile, roundsText)
      for (const m of marks) items.push(markItem(m))
      /**
       * 保温条目**按当前价格重算**（账本 `w.cost` 是记账时快照，改价后要跟着变）。
       * 与插件侧 `index.ts` 同一个口径；预算 / 熔断判定仍看存下来的 `entry.cost`（历史账，别漂）。
       */
      const warmCostOf = (w: LedgerEntry): number => recomputeCost(w, s).cost
      for (const w of warms) {
        items.push({
          kind: 'warm', gran: 'warm', source: 'warm', time: w.at,
          hitTokens: w.hitTokens, missTokens: Math.max(0, w.promptTokens - w.hitTokens),
          outputTokens: w.outputTokens, hitRate: w.hitRate, cost: warmCostOf(w),
          via: w.via ?? 'cli', touch: w.touch, ms: w.ms, cycle: w.cycle ?? 1,
          model: w.model ?? '', factor: w.factor ?? 1, factorLabel: w.factorLabel ?? '',
        })
      }
      /**
       * 排序必须**确定性**：同一毫秒里可能有「改写标记 / 保温 / 轮次」三样，
       * 只按 `time` 排的话三者先后随数组插入顺序变（`both` 模式尤其明显：step 与 turn 同 time）。
       * 二级键：同一时刻先改写（它解释了后面为什么没保）、再保温、最后轮次；三级键 step 在 turn 前。
       */
      const SRC_ORDER: Record<string, number> = { mark: 0, warm: 1, round: 2 }
      const GRAN_ORDER: Record<string, number> = { step: 0, turn: 1, warm: 2, mark: 3 }
      items.sort((a, b) =>
        Number(a['time']) - Number(b['time'])
        || (SRC_ORDER[String(a['source'])] ?? 9) - (SRC_ORDER[String(b['source'])] ?? 9)
        || (GRAN_ORDER[String(a['gran'])] ?? 9) - (GRAN_ORDER[String(b['gran'])] ?? 9))
      let roundCost = 0
      for (const r of rounds) roundCost += costOfRound(r).cost
      const warmCost = warms.reduce((x: number, w: LedgerEntry) => x + warmCostOf(w), 0)
      return {
        ok: true, id: row.id, title: row.title, short: shortId(row.id),
        prices: s.prices, pricesByModel: s.pricesByModel,
        tariff: { enabled: s.tariff.enabled, timeZone: s.tariff.timeZone },
        granularity: gran, items,
        summary: {
          rounds: rounds.length,
          turns: new Set(rounds.map((r) => r.turn)).size,
          warms: warms.length,
          /** 压缩 / goal 标记数（前端「压缩轮」那一档的计数，别自己数 items）。 */
          markCount: marks.length,
          cycle: cycleOf(state, row.id),
          cycleWarms: warms.filter((w) => (w.cycle ?? 1) === cycleOf(state, row.id)).length,
          cycleWarmCost: warms.filter((w) => (w.cycle ?? 1) === cycleOf(state, row.id)).reduce((x, w) => x + warmCostOf(w), 0),
          roundCost, warmCost,
          totalCost: roundCost + warmCost,
          warmShare: roundCost + warmCost === 0 ? 0 : warmCost / (roundCost + warmCost),
        },
      }
    },
  }
}

/**
 * 某会话日志**当前**的改写指纹（`kind:sub:seq` / 无改写为 `''`）。
 *
 * 与插件侧 `index.ts` 的 `rewriteFpFor(id)` 同口径（都用 `rewriteFpOf(rewriteOfFile(...))`，
 * 后者按 `mtime` 缓存，重复调用几乎零成本）：账本要拿它当**判定基准**，
 * 少写这一格 → 判定落 `unknown` → 永久放行（保护静默失效）。
 *
 * 收 `logFile` 而不是 id：`recordWarm` 是模块级导出，拿不到 `createPanelService` 闭包里的 `rowsOf()`。
 */
function rewriteFpForFile(logFile: string | undefined): string {
  if (logFile === undefined || logFile === '') return ''
  return rewriteFpOf(rewriteOfFile(logFile))
}

/**
 * **计价回归的唯一被测入口**（消费者只有 `scripts/check-billing-data.mjs`）。
 *
 * ⚠️ 面板/守护循环的记账**不走这里**：CLI 走 `cli/keepalive.mjs` 的 `record()`，
 * 插件走 `src/index.ts` 的落账路径。早先的注释写「守护循环与面板 ping 共用」是错的。
 *
 * **不要以为它「零调用就可以直接删」（2026-10-20 试过）**：删掉 `export` 后
 * `check-billing-data.mjs` 当场 `TypeError: recordWarm is not a function` ——
 * 那一节验的是「按 model-b ×3 记金额 + 倍率标签 + 金额落盘」，是计价链路唯一的端到端回归。
 * 真要删，得先把那段改成「`costAt` + `buildLedgerEntry` 手工拼装」，否则回归网就降级了。
 */
export function recordWarm(options: {
  state: State
  id: string
  usage: { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens?: number }
  ms: number
  via: 'cli' | 'auto' | 'manual' | 'panel' | 'tool'
  model: string
  intervalMs: number
  /** 会话日志路径：用来算**改写指纹**（判定基准）。不传则记空串（= 无改写，判定会落 unknown 并放行）。 */
  logFile?: string
  /** 内容指纹（tools+messages 的哈希），由调用方算好传进来（这里没有 plan 上下文）。 */
  fingerprint?: string
}): LedgerEntry {
  const { state, id, usage, ms, via, model, intervalMs } = options
  const s = state.settings
  const c = costAt(usage, normalizePrices(s.prices), model, s.pricesByModel ?? {}, s.tariff ?? {}, Date.now() - ms)
  const hit = usage.cacheReadTokens ?? 0
  const miss = usage.inputTokens ?? 0
  /** 分母含「新建缓存」（三者互斥），与 econ.hitRate 同口径。 */
  const total = promptTokens(usage)
  const prev = ledgerOf(state, id).slice(-1)[0]
  const gapSeconds = prev === undefined ? 0 : Math.round((Date.now() - prev.at) / 1000)
  const touch = prev !== undefined && intervalMs > 0 && gapSeconds < (intervalMs / 1000) * 3 ? prev.touch + 1 : 1
  /**
   * 走**唯一的条目工厂**（`core/ledger-entry.ts`）：字段漏一个，判定基准就静默失效
   * （`rewriteFp` 缺 → 判定落 `unknown` → 放行，保护悄悄没了，不报错）。
   * `rewriteFp` 取**当前日志尾部**的改写指纹；无改写时是空串（合法值，必须落账）。
   */
  const entry: LedgerEntry = buildLedgerEntry({
    at: Date.now(),
    gapSeconds,
    promptTokens: total,
    hitTokens: hit,
    missTokens: miss,
    outputTokens: usage.outputTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    cost: c.cost,
    hitRate: hitRate(usage),
    ...(usage.cacheKnown === false ? { cacheUnknown: true } : {}),
    ms,
    touch,
    cycle: cycleOf(state, id),
    via,
    model,
    factor: c.factor,
    factorLabel: c.label,
    rewriteFp: rewriteFpForFile(options.logFile),
    fingerprint: options.fingerprint,
  })
  appendLedger(state, id, entry)
  saveState(state, statePath())
  return entry
}
