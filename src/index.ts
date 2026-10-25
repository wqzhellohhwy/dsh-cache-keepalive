/**
 * @dsh-external/dsh-cache-keepalive
 *
 * 会话空闲时重放它的完整前缀（system + tools + messages）再补一条极短消息，
 * 让 DeepSeek 的前缀缓存一直"被读到"而不被回收。冷启动一次要按 50 倍价重算整个上下文，
 * 保温一次只按命中价付 —— 实测杠杆约 40 倍（命中率 99.5%）。
 *
 * 安全边界（缺一不可）：
 *  1. `tools` 原样带上 —— 缓存锚点（渲染序 tools → system → messages），去掉即全断；
 *  2. `maxTokens` 压到 1 —— 发不起工具调用，天然防跑飞；
 *  3. 只走 `llm.stream`，不进 agent loop —— 绝不写会话日志；
 *  4. 归档不保 —— `archived` 会话门禁直接返回 `archived`；会话**正在跑回合也照保**
 *     （真回合自己会刷新缓存，保温与它并行不冲突）；
 *  5. 命中率塌了立即熔断 —— 漏一次 = 50 次保温的钱；
 *  6. 只对"确认还热"的会话首次保温 —— 凉会话救火等于白烧一次冷启动（实测 3.17% 命中）。
 *
 * 界面：浏览器打开 `http://127.0.0.1:<端口>/api/cache-keepalive/panel`
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  DEFAULT_PROMPT,
  planReplay,
  planReplayFromAssembled,
  runReplay,
  type AgentLike,
} from './keepalive.ts'
import { decideWarm } from './gate.ts'
import { isCompactionDrop } from './ttl.ts'
import { decideCandidates, pickedIds, type CandidateRow } from './core/candidates.ts'
import {
  appendLedger,
  beginNewCycle,
  cycleOf,
  cycleSpendAtCurrentPrices,
  cycleSpendOf,
  cycleStatsOf,
  clearLedger,
  isTripped,
  LAB_OVERRIDES,
  appendLabPending,
  ledgerOf,
  loadState,
  releaseInflight,
  tryClaimInflight,
  withStateLock,
  policyOf,
  saveState,
  settleLabPending,
  setPolicy,
  setSettings,
  touchCountOf,
  untripSession,
  statePath,
  stateMtimeOf,
  type LedgerEntry,
  type SessionPolicy,
  type Settings,
  type State,
} from './store.ts'
import { makeRoutes, API_PREFIX } from './routes.ts'
import { BUILD_ID } from './build-id.ts'
import { GATE_DETAIL_DEFAULTS, GATE_TEXTS, renderGateText } from './core/gate-texts.ts'
import { SessionIndex, readMarksCached, readRoundsCachedWithText, readLastDialogAt, readProjectionTitle, readSessionModel, readTitleDeep, sumByTurn, type SessionRow } from './core/sessions.ts'
import { readSessionMeta, writeSessionMetaIfChanged } from './core/session-meta.ts'
import { buildLedgerEntry, spendAtCurrentPrices } from './core/ledger-entry.ts'
import { isCurrentFingerprint } from './core/fingerprint.ts'
import { warmOffline, wireShapeOf } from './core/warm-offline.ts'
import { loadModelCatalog, mergeModelCatalog } from './core/providers.ts'
import { assembleSession } from './core/assemble.ts'
import { applySettingsPatch, labExpireIfDue, labRestoreBackup, labSnapshotOf } from './core/settings.ts'
import { KNOWN_RED, runAll } from './core/lab/invariants.ts'
import { labVerdict, promptTokensEstimate, worstCostOf } from './core/lab/guard.ts'
import { buildReport } from './core/lab/report.ts'
import { buildGateInput, effectiveLimitsOf } from './core/gate-input.ts'
import { cleanSubagentTitle, isUselessTitle } from './core/sessions.ts'
import { modelChangedOf } from './core/model-switch.ts'
import { rewriteFpOf, rewriteOfFile } from './core/rewrite.ts'
import { markItem } from './core/rewrite-probe.ts'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PANEL_PATH } from './panel.ts'
import {
  breakEvenProbability,
  coldStartCost,
  costAt,
  costOf,
  effectivePrices,
  expectedNet,
  hitRate,
  maxTouchesHard,
  normalizePrices,
  normalizePriceTable,
  normalizeTariff,
  priceFingerprint,
  priceForModel,
  promptTokens,
  recomputeCost,
  scalePrices,
  warmCost,
  warmOverRestart,
  type Prices,
  type Tariff,
} from './econ.ts'

export const name = '@dsh-external/dsh-cache-keepalive'
/**
 * 依赖声明 —— **`llm` 不能漏**。
 *
 * `ctx.llm` 在 cordis 里是 inject 门控的服务：不声明就访问会抛
 * `cannot get property "llm" without inject`。这个错误在 tick 里被 catch 吞掉后
 * 表现为「门禁全部放行、账本却永远是空的」——极难发现。历史上漏过一次，不要再犯。
 */
export const inject = ['tools', 'timer', 'llm'] as const

export interface Config {
  /** 守护 tick 间隔（毫秒）。 */
  tickMs?: number
  /** 首次启动时的默认设置（写进 state.json 后以 state 为准）。 */
  settings?: Partial<Settings>
}

interface AgentRegistry {
  list(): AgentLike[]
}

const SHORT = 22
const yuan = (v: number): string => v.toFixed(4) + ' 元'
const shortId = (id: string): string => (id.length > SHORT ? id.slice(-SHORT) : id)

export function apply(ctx: Context, config: Config = {}): void {
  const tickMs = config.tickMs ?? 60_000
  /**
   * **provider / model 目录的进程内缓存**（面板「模型价表」下拉框用）。
   *
   * 为什么缓存而不是每次快照现算：`snapshot()` 是**同步**的，而 `ctx.llm.listModels()` 是
   * **async**（`dsh-llm` 的 `LlmRuntime.listModels` 返回 Promise），同步路径拿不到。
   * 路由列表在一次进程生命周期里基本不变，所以启动时异步填一次、之后定时刷新即可。
   *
   * 两级策略（与 `dsh-session-title-fix` 的 `modelsOf` 同一套）：
   * 1. **运行时枚举**：`listProviders()` + `listModels(provider)` —— 能覆盖官方适配器
   * 2. **回退配置**：`loadModelCatalog(dshHome)` 扫 profile 的 cordis 配置
   *    （离线 CLI 与「没装插件的实例」走的就是这一层）
   */
  let modelCatalog: { provider: string; models: string[] }[] = []
  /**
   * `home` 必须**由调用方传入**，不能读外层 `dshHome`：`apply()` 里调用点在
   * `const dshHome = ...` 之前，读它会撞暂时性死区，而下面的 `catch` 会把
   * ReferenceError 一起吞掉 —— 表现为 `offline` 恒为 `[]`、面板只剩在线那 2 个 provider。
   */
  const refreshModelCatalog = async (home: string): Promise<void> => {
    /**
     * ① **离线铺底**：扫 profile 配置的 `llm-pi-ai` 路由。
     *
     * ⚠️ **不能写成「在线有结果就 return」**：实测 3084 的 `listProviders()` 只返回
     * `dots` + `deepseek-official` 两个，而配置里有 6 个（tokenrhythm 系列全在 patch 层）。
     * 二选一会把配置里的路由全丢掉 —— 面板下拉框只剩 2 个 provider。
     */
    let offline: { provider: string; models: string[] }[] = []
    try {
      offline = loadModelCatalog(home)
    } catch (e) {
      log('读 profile 配置的 provider 目录失败：' + String((e as { message?: string } | undefined)?.message ?? e))
    }
    /** ② **在线补齐 / 覆盖**：同名 provider 以运行时为准。 */
    const online: { provider: string; models: string[] }[] = []
    try {
      const svc = ctx.llm as unknown as {
        listProviders?: () => { id?: string; provider?: string }[]
        listModels?: (provider: string) => Promise<{ id: string }[]>
      }
      if (typeof svc.listProviders === 'function' && typeof svc.listModels === 'function') {
        for (const info of svc.listProviders() ?? []) {
          const name = String(info.id ?? info.provider ?? '')
          if (name === '') continue
          try {
            online.push({ provider: name, models: (await svc.listModels(name)).map((m) => String(m.id)) })
          } catch { /* 列举失败就不放进 online，从而保留离线那份 */ }
        }
      }
    } catch { /* 在线那层整个不可用就用离线结果 */ }
    modelCatalog = mergeModelCatalog(offline, online)
  }
  const stateFile = statePath()
  /** 配置里的设置覆盖：每次重读磁盘后都要重新叠上去，否则会被磁盘值冲掉。 */
  const settingsOverride = config.settings
  const withOverride = (s: State): State =>
    settingsOverride === undefined ? s : { ...s, settings: { ...s.settings, ...settingsOverride } }
  let state: State = withOverride(loadState(stateFile))
  let stateMark = stateMtimeOf(stateFile)
  /**
   * 把内存 `state` 对齐磁盘。
   *
   * 独立 CLI 是**另一个进程**，它记的账本条目插件进程看不见 —— 不对齐就会出现
   * 「面板时间轴少最后一轮」（实测：连续保温最后一次 89.1% 不出现在详情里）。
   */
  /**
   * 把内存 `state` 对齐磁盘。
   *
   * 独立 CLI 是**另一个进程**，它记的账本条目插件进程看不见 —— 不对齐就会出现
   * 「面板时间轴少最后一轮」（实测：连续保温最后一次 89.1% 不出现在详情里）。
   *
   * **反过来也要防**：磁盘可能被外部脚本覆盖成一份更少的账本（2026-10-19 事故：
   * 测试脚本在真实 home 上跑，把用户几百条账本冲成 1 条假记录）。所以磁盘账本**条数更少**时
   * 不整体替换，而是**按 `at` 合并**（内存多的保留、磁盘新增的追加），并打一条 WARN。
   */
/** 账本总条数（跨会话）。 */
const countEntries = (ledger: Record<string, LedgerEntry[]> | undefined): number => {
  let n = 0
  for (const arr of Object.values(ledger ?? {})) n += arr.length
  return n
}

/**
 * 合并内存与磁盘两份 `state`（**只在磁盘更少时调用**）。
 *
 * 规则：
 *  - 以磁盘为基底（设置 / 新字段以磁盘为准）；
 *  - 账本按 `at|touch|cost` 取并集，按 `at` 升序（同一时刻以磁盘那条为准，它可能被 CLI 更新过）；
 *  - `pinnedSessions` 取并集；`sessions` 策略 / `touchBase` / `cycles` 磁盘有则用磁盘、没有则保留内存。
 */
function mergeState(mem: State, disk: State): State {
  const merged: State = { ...disk }
  const ledger: Record<string, LedgerEntry[]> = { ...(disk.ledger ?? {}) }
  for (const [id, memLed] of Object.entries(mem.ledger ?? {})) {
    const diskLed = ledger[id] ?? []
    const key = (e: LedgerEntry): string => e.at + '|' + (e.touch ?? 0) + '|' + (e.cost ?? 0)
    const seen = new Set(diskLed.map(key))
    const extra = memLed.filter((e) => !seen.has(key(e)))
    if (extra.length > 0) ledger[id] = [...diskLed, ...extra].sort((a, b) => a.at - b.at)
  }
  merged.ledger = ledger
  merged.pinnedSessions = [...new Set([...(disk.pinnedSessions ?? []), ...(mem.pinnedSessions ?? [])])]
  const sess: State['sessions'] = { ...(disk.sessions ?? {}) }
  for (const [id, p] of Object.entries(mem.sessions ?? {})) if (sess[id] === undefined) sess[id] = p
  merged.sessions = sess
  const tb = { ...(disk.touchBase ?? {}) }
  for (const [id, v] of Object.entries(mem.touchBase ?? {})) if (tb[id] === undefined) tb[id] = v
  merged.touchBase = tb
  const cy = { ...(disk.cycles ?? {}) }
  for (const [id, v] of Object.entries(mem.cycles ?? {})) if (cy[id] === undefined) cy[id] = v
  merged.cycles = cy
  /** 在途标记取并集、同 id 取更晚的：本进程刚抢的标记不能因为「磁盘账本更少」这条合并路径被丢掉。 */
  const ifl = { ...(disk.inflight ?? {}) }
  for (const [id, m] of Object.entries(mem.inflight ?? {})) {
    const cur = ifl[id]
    if (cur === undefined || cur.at < m.at) ifl[id] = m
  }
  merged.inflight = ifl
  return merged
}

  const syncState = (force = false): void => {
    const mark = stateMtimeOf(stateFile)
    if (!force && mark === stateMark) return
    stateMark = mark
    try {
      const disk = withOverride(loadState(stateFile))
      const memCount = countEntries(state.ledger)
      const diskCount = countEntries(disk.ledger)
      const memPinned = (state.pinnedSessions ?? []).length
      const diskPinned = (disk.pinnedSessions ?? []).length
      /** 磁盘「明显更少」才合并：正常路径（CLI 记账后磁盘更多）直接替换，零额外开销。 */
      if (memCount > diskCount || memPinned > diskPinned) {
        state = mergeState(state, disk)
        commit()
        log(`⚠️ 磁盘账本比内存少（${diskCount} < ${memCount} 条，置顶 ${diskPinned} < ${memPinned}）`
          + ' → 已按 at 合并并保留内存版本（磁盘上的记录不会被静默丢弃）')
      } else {
        state = disk
      }
    } catch {
      /* 读坏了就继续用内存那份 */
    }
  }
  /** 落盘并记住新版本标记（不记的话下一次 `syncState()` 会白读一遍整份文件）。 */
  const commit = (): void => {
    stateMark = saveState(state, stateFile)
  }
  /**
   * 前缀指纹失配的会话（内存态，不落盘）—— 只用来给面板解释「为什么这条没保」。
   * `ping` 跳过时写入，命中成功后删除。
   */
  const prefixStale = new Map<string, { at: number; loggedAt: number; nextTryAt: number }>()
  /** 指纹失配后的复查间隔：期间不再空转 planReplay，等会话被真实使用后自然恢复。 */
  const PREFIX_STALE_RETRY_MS = 600_000

  /**
   * **离线会话的失败退避**（`id → 下次可尝试时刻`）。
   *
   * 为什么必须有：`hasRoute` 对非本进程会话是**乐观放行**的，装配失败又没有账本记录 →
   * `lastTouchAt` 不变 → 门禁每拍都放行 → 坏会话会**每 60 秒重试一次**，还会白占 `autoCount` 名额
   * （把好会话挤出去）、每拍刷一条失败日志、每拍解压一次日志。
   *
   * 退避期间该会话在候选池里按 `hasRoute:false` 排除（= 不占名额、不重试、不刷日志）。
   */
  const offlineRetryAt = new Map<string, number>()
  /** 一般失败（网络 / 限流 / 未知）→ 10 分钟后再试。 */
  const OFFLINE_RETRY_MS = 600_000
  /** 确定性失败（装配失败 / 没有 provider-model / 没 key / 撞上限）→ 30 分钟后再试。 */
  const OFFLINE_RETRY_FATAL_MS = 1_800_000
  const offlineBlocked = (id: string, at: number): boolean => {
    const until = offlineRetryAt.get(id)
    return until !== undefined && until > at
  }

  /**
   * 索引刷新间隔：tick 每 5 分钟主动重扫一次。
   *
   * 不刷的话，候选池的磁盘部分只在「启动 + 面板 `/state`」时更新 —— 用户从不打开面板时，
   * 插件启动后新产生的会话**永远进不了池**（A 批的能力在这种场景下退化）。
   * 冷扫一次 1.7 秒（412 条），所以不能每拍扫。
   */
  const INDEX_REFRESH_MS = 300_000

  const log = (msg: string): void => {
    try {
      ctx.logger?.info?.('[cache-keepalive] ' + msg)
    } catch {
      /* 日志失败静默 */
    }
  }

  /**
   * 会话 → 最后观察到 running 的时间戳（毫秒）。
   *
   * 为什么不问 session 要：**`session.events` 在本机运行时是 `undefined`**（已实测），
   * 而 `eventAt()` / `snapshotEvents()` 已被官方标记弃用、禁止新增生产调用。
   * 所以改成：每次 tick 看到某个 agent 处于 `running` 就记一笔时间。
   *
   * 副作用（而且是好的保守）：插件启动时就已 idle 的老会话永远拿不到活动时间 →
   * 门禁按「未知」处理，**一律不允许首次保温** —— 那些会话多半早已凉透。
   */
  const lastActiveAt = new Map<string, number>()

  /**
   * 守护循环心跳。用来判断 tick 到底有没有在跑 ——
   * 曾经因为 `inject` 漏声明 `llm` 导致每次 tick 都在 ping 里抛错、被 catch 静默吞掉，
   * 表现为「门禁全部放行、账本永远为空」，极难定位。有心跳一眼就能分辨。
   */
  let tickCount = 0
  let lastTickAt = 0

  /** DSH 主目录。 */
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')

  /** 模型目录：启动填一次，之后 5 分钟刷一次（路由/模型只在用户改 profile 时才变）。 */
  void refreshModelCatalog(dshHome)
  const catalogTimer = setInterval(() => { void refreshModelCatalog(dshHome) }, 5 * 60_000)
  catalogTimer.unref?.()

  /**
   * 磁盘会话索引 —— 面板与独立 CLI 共用同一套扫描（`src/core/sessions.ts`）。
   *
   * 进程内 `agentsOf()` 只能看到**当前进程加载过**的少数会话（实测 8 个），
   * 而磁盘上有 238 个。列表必须以磁盘为准，再把进程内力状态叠加上去。
   */
  const sessionIndex = new SessionIndex(dshHome, { headBytes: 256 * 1024, refreshTtlMs: 60_000 })

  /** 磁盘扫描错误（有值说明列表可能不全；面板会显示出来便于排查）。 */
  let scanError = ''

  // 启动即预扫一次，避免面板首次打开是空的。异步不阻塞 apply。
  void sessionIndex.list().catch((e: unknown) => {
    scanError = String((e as { message?: string } | undefined)?.message ?? e)
  })

  /**
   * 把**只有实例才知道的信息**写给外部读者（独立 CLI / 无实例面板）。
   *
   * 为什么需要：CLI 从日志离线装配，能力已经很完整，但有两条天生的短板：
   *  ① 不知道哪条会话**正在跑回合**（真实请求本身就在刷新缓存，这时保温纯属白花钱）；
   *     它只能看日志 mtime，而一个回合可能几分钟不写盘。
   *  ② 标题只能读日志头 256KB，重命名事件落在后面的会话会显示旧名。
   *
   * 所以插件（任意个实例都行，谁写谁最新）每 tick 把这两样写进 `runtime.json`，
   * CLI 读它。这是「数据实时统一」的通道：**实例只写运行时快照，账本只由 CLI 写**，
   * 两个写者各管自己的文件，不竞争。
   *
   * 文件很小（几百字节），整份覆盖写 —— 读方永远读到完整的一份，不需要锁。
   */
  function writeRuntime(agents?: readonly AgentLike[]): void {
    try {
      const dir = join(dshHome, 'cache-keepalive')
      const file = join(dir, 'runtime.json')
      const sessions: Record<string, { running: boolean; title: string }> = {}
      for (const agent of agents ?? agentsOf()) {
        const id = String(agent.session?.id)
        if (id === '' || id === 'undefined') continue
        sessions[id] = {
          running: agent.status === 'running',
          title: titleOf(agent, sessionIndex.cached.find((r) => r.id === id)),
        }
      }
      const profile = (ctx.get('profileContext') as { name?: string } | undefined)?.name ?? ''
      const port = (ctx.get('webServer') as { port?: number } | undefined)?.port
      const payload = JSON.stringify({
        updatedAt: Date.now(),
        instances: [{ profile, pid: process.pid, ...(port === undefined ? {} : { port }) }],
        sessions,
      })
      mkdirSync(dir, { recursive: true })
      // tmp 名带 pid：两个实例同时写同一个 runtime.json 时不会互相踩（rename 前被对方删掉会 ENOENT）
      const tmp = file + '.' + process.pid + '.tmp'
      writeFileSync(tmp, payload, 'utf8')
      renameSync(tmp, file)
    } catch {
      /* 快照写不出去不影响保温本身 */
    }
  }

  // 自维护活动时间（见文件头注释）。事件驱动 + tick 兜底：
  // tick 每 60 秒才醒一次，而一个回合可能几秒就跑完 —— 只靠 tick 会大量漏记，
  // 漏记的后果是「用户刚聊完，插件却以为缓存早断了」而拒绝保温。
  ctx.on('agent/status', (payload: { agent?: AgentLike; status?: string } | undefined) => {
    try {
      const id = payload?.agent?.session?.id
      if (payload?.status === 'running' && id !== undefined) {
        lastActiveAt.set(String(id), Date.now())
        writeRuntime()
      }
    } catch {
      /* 事件载荷异常不影响主流程 */
    }
  })

  const agentsOf = (): AgentLike[] => {
    const reg = ctx.get('agents') as AgentRegistry | undefined
    try {
      return reg?.list?.() ?? []
    } catch {
      return []
    }
  }

  /**
   * **会话 id 解析**（面板/接口允许只给尾号）。
   *
   * 顺序：运行中的 agent → 磁盘索引（历史会话不在 agentsOf 里！）。
   * 都找不到返回 undefined —— **绝不能把传进来的原文当键**：那会造出假成功
   * （接口回 ok、state.json 里多一个垃圾周期键，实际一分没改）。核实员实测踩过。
   */
  function resolveSessionId(id: string): string | undefined {
    const live = agentsOf()
    const hit = live.find((a) => String(a.session?.id) === id)
      ?? live.find((a) => String(a.session?.id).endsWith(id))
    if (hit !== undefined) return String(hit.session.id)
    const disk = sessionIndex.cached
    const row = disk.find((r) => r.id === id) ?? disk.find((r) => r.id.endsWith(id))
    return row?.id
  }

  /** 手动指定的 sessionId 优先（支持只给尾号），否则用工具执行时所在的会话。 */
  function resolveAgent(sessionId: string | undefined, exec: { agent?: unknown }): AgentLike | undefined {
    if (sessionId !== undefined && sessionId !== '') {
      const all = agentsOf()
      return all.find((a) => String(a.session?.id) === sessionId)
        ?? all.find((a) => String(a.session?.id).endsWith(sessionId))
    }
    return exec.agent as AgentLike | undefined
  }

  /** 自动候选的旋钮（面板可改）。闲置上限与门禁共用 `idleLimitHours`。 */
  const autoSettings = (): {
    enabled: boolean
    count: number
    maxIdleHours: number
    allowSubagent: boolean
  } => ({
    enabled: state.settings.autoEnabled,
    count: state.settings.autoCount,
    maxIdleHours: state.settings.idleLimitHours,
    allowSubagent: state.settings.autoAllowSubagent,
  })

  /** 面板自己的置顶集合（存在 state.json，与 DSH workspace 的置顶无关）。 */
  const pinnedSet = (): Set<string> => new Set(state.pinnedSessions ?? [])

  /**
   * 会话「最后活动时间」：**内存观测优先，缺失则回落到磁盘日志的 mtime**。
   *
   * 为什么必须有回落：内存观测（`lastActiveAt`）**插件一重启就归零**，于是
   * ① 自动候选把它们全排除（要求"活动时间已知且近期"）→ 自动保温集体停摆；
   * ② 门禁判 `cold-window`/`stale` 时也拿不到时间。
   * 而日志文件的 mtime 是**持久**的 —— 它就是"这条会话最后一次被写入"的时刻，
   * 语义上正等于"最后活动时间"。
   */
  function lastActiveOf(id: string): number {
    const mem = lastActiveAt.get(id) || 0
    const disk = sessionIndex.cached.find((r) => r.id === id)?.mtime ?? 0
    return Math.max(mem, disk)
  }

  /**
   * 会话「**最后一条对话**」的时间（`user/message` / `assistant/message`）；`0` = 未知。
   *
   * **为什么不能只看 `mtime`**：`mtime` 是「文件最后被写」，工具结果、压缩、seed 事件都会刷新它 ——
   * 一条只用过工具、早已没人说话的会话，`mtime` 会显得"刚活动过"，于是被自动候选选中、白花钱。
   * 所以**候选池与门禁的「闲置」都看对话，不看写入**。
   * `lastActiveOf`（= max(内存活动, mtime)）**只给熔断解除 / `gapSeconds` / 熔断的
   * 「真实活动」判定**用 —— 那几处要的正是「有没有人碰过这条会话」（点开也算碰过）。
   * ⚠️ 门禁的 `lastActivityAt` 已经**不再**用它（改看 `lastDialogOf`），别再按它判 `cold-window`。
   */
  function lastDialogOf(id: string): number {
    const row = sessionIndex.cached.find((r) => r.id === id)
    if (row === undefined) return 0
    return readLastDialogAt(row.logFile)
  }

  /**
   * 当前是否真的处于熔断。
   *
   * 全部规则都在 `store.isTripped` 里（含两条自动解除：真实活动 / 冷却到点）——
   * 这里只负责把「最后活动时间」按内存+磁盘兜底算出来传进去。
   *
   * `at` 可选：虚拟时钟/测试时传同一个"现在"，让熔断冷却也按同一时刻判；
   * 生产不传 → `at ?? Date.now()`，与 `isTripped` 的默认完全一致（行为不变）。
   */
  function trippedNow(id: string, at?: number): boolean {
    return isTripped(state, id, state.settings.circuitHitRate, lastActiveOf(id), at ?? Date.now())
  }

  /**
   * 会话标题 —— **实时投影优先，磁盘索引兜底**。
   *
   * 为什么不能只用磁盘索引：`sessionIndex.cached` 是**扫日志头部**（256KB）得来的，
   * 而重命名事件往往写在**文件更靠后**的位置，再加 60 秒 TTL —— 结果就是面板显示**旧名**
   * （实测：本会话真名「探索dsh kv缓存机制原理」，索引里却是「探索dsh压缩会话机制原理」）。
   *
   * 正路是 DSH 自己的标题投影：`dsh-session-title` 注册了 key=`title` 的投影，
   * `stateOf(session, 'title')` 返回**当前实时标题**。
   * 用 `ctx.get` **软取**（不进 inject）—— 投影服务缺席时自动回落，不影响插件加载。
   */
  /**
   * 子代理标题清洗（**唯一入口**）：列表、详情、候选三处都过它，避免各自一套口径。
   *
   * 真实数据：193 条子代理的官方标题是 `<system-reminder> You are teammate "impl`（被截断）。
   * 清洗后仍是「无用标题」（空 / 裸 id / 等于工作目录名）时保持原样 —— 采用与否交给调用方判断。
   */
  function cleanTitleOf(raw: string | undefined, cwd?: string): string {
    const s = String(raw ?? '').trim()
    if (s === '') return ''
    const cleaned = cleanSubagentTitle(s)
    if (cleaned === undefined) return s
    return isUselessTitle(cleaned, cwd) ? s : cleaned
  }

  function titleOf(agent: AgentLike | undefined, fallbackMeta?: SessionRow): string {
    if (agent !== undefined) {
      const proj = ctx.get('sessionProjections') as
        | { stateOf?: (session: unknown, key: string) => unknown }
        | undefined
      try {
        const live = proj?.stateOf?.(agent.session, 'title')
        if (typeof live === 'string' && live.trim() !== '') return cleanTitleOf(live)
      } catch {
        /* 投影未就绪/版本不符 → 落回磁盘索引 */
      }
    }
    /**
     * **DSH 的标题投影缓存**（`storages/session_projcache`）—— 最新标题的权威来源。
     *
     * 为什么在日志头部**之前**：日志只有头 256KB，重命名事件可能落在文件中部（实测某会话最新标题在 24% 位置），
     * 全库 510 条里 31 条因此显示旧名。投影缓存里的 `record.rows.title.val` 才是最新值。
     */
    const id = String(agent?.session?.id ?? fallbackMeta?.id ?? '')
    if (id !== '') {
      const fromProj = readProjectionTitle(dshHome, id)
      if (fromProj !== undefined) return cleanTitleOf(fromProj)
    }
    return cleanTitleOf(fallbackMeta?.title)
  }

  /**
   * 自动候选池的行（插件视角：只放**本进程内存里活着的** agent —— 保温要的是活对象，
   * 真实路由、工具面、凭据；磁盘上的会话只是历史记录，挂不上请求）。
   *
   * 判定本身**不在这里做**：统一交给 `core/candidates.ts:decideCandidates()`（三处共用一份）。
   * 这里只负责把活会话的信息映射成 `CandidateRow`。
   *
   * ⚠️ 标题一律走 `titleOf()`，**不要**读 `(agent.session as any).title` —— 内存 session
   * 对象没有这个字段（实测恒为 undefined），照它判会把所有会话都当成无标题、自动保温集体停摆。
   * 另外**查不到标题时按「有标题」处理**（保守放行）—— 投影与索引都还没就绪时不该误杀；
   * 用非空占位（`'-'`）表达"放行"，因为库函数只按 `title !== ''` 判有无标题。
   */
  /**
   * 候选池 = **活会话 ∪ 磁盘全会话**。
   *
   * 为什么扩：一个插件实例要同时覆盖「本进程活会话（快路径，零读盘）」与「非本进程 / 历史会话
   * （离线装配，慢但全能）」。扩之前池子里只有 `agentsOf()`，历史会话永远不是候选。
   *
   * 活会话：内存活动时间 + 真实 `requestHeader()` 判路由；
   * 非活会话：只有 `sessionIndex` 的元数据，**`hasRoute` 一律乐观放行** —— 真保时装配失败会把
   * 结果记进日志，不该因为「拿不到 header」就把整类会话从候选里排除。
   *
   * ⚠️ **不在候选循环里判前缀改写**：那要全量解压日志，几百条会让每拍慢几秒。
   * 改写判定仍只在 `gateInputFor` / `gateInputForIdle(id, true)` 里、对**真要保的那几条**做。
   */
  const candidateRows = (at: number, agents: readonly AgentLike[]): CandidateRow[] => {
    const out: CandidateRow[] = []
    const seen = new Set<string>()
    for (const a of agents) {
      const id = String(a.session.id)
      const meta = sessionIndex.cached.find((r) => r.id === id)
      const title = titleOf(a, meta)
      const header = a.session.requestHeader?.()
      seen.add(id)
      out.push({
        id,
        mtime: meta?.mtime ?? 0,
        archived: meta?.archived === true,
        origin: meta?.origin ?? '',
        // meta 缺失（活会话还没落盘）时给非空占位 = 旧口径「查不到标题就放行」
        title: title !== '' ? title : (meta === undefined ? '-' : ''),
        /** 覆盖：插件侧有内存活动时间（tick 刚观测到的 running）。 */
        /**
         * **与磁盘分支同口径**：两边都用「最后对话」。
         *
         * 以前活会话用 `lastActiveOf`（= max(内存活动, mtime)），非活用 `lastDialogOf` —— 同一个会话
         * 「加载过 / 没加载过」时排序权重不同，候选名次会跳。`lastActiveOf`（含 mtime/end-seed）继续只给
         * 熔断解除 / `gapSeconds` / 门禁 `cold-window` 用，那是「有没有人碰过」的语义。
         */
        lastActiveAt: lastDialogOf(id),
        /**
         * 与 tick 的门禁同口径：真实请求头决定有没有路由。
         * 没路由的会话 `ping()` 也会直接失败，所以让它从候选里让出名额是对的。
         */
        hasRoute: header?.config?.provider !== undefined && header?.config?.model !== undefined,
        /** 按模型自定义门槛（`settings.modelOverrides`）。 */
        ...(typeof header?.config?.provider !== 'string' || typeof header?.config?.model !== 'string'
          ? {}
          : { provider: header.config.provider, model: header.config.model }),
        tripped: trippedNow(id),
        live: true,
      })
    }
    for (const meta of sessionIndex.cached) {
      if (seen.has(meta.id)) continue
      out.push({
        id: meta.id,
        mtime: meta.mtime,
        archived: meta.archived === true,
        origin: meta.origin ?? '',
        title: meta.title ?? '',
        /**
         * 乐观放行，**但退避期内按 `false` 排除** —— 否则坏会话会每拍重试、白占 `autoCount` 名额、
         * 每拍刷一条失败日志（见 `offlineRetryAt` 的注释）。
         */
        /**
         * **候选池看「最后对话」而不是 `mtime`**（用户要求：只点开过 / 只跑过工具轮的会话不该算"刚活动"）。
         * 用 getter 惰性算：`decideCandidates` 只在通过前面所有筛子后才读它，
         * 首拍不必为 416 条会话各解一次帧（缓存命中后是 0ms）。
         */
        get lastActiveAt(): number { return lastDialogOf(meta.id) },
        hasRoute: !offlineBlocked(meta.id, at),
        tripped: trippedNow(meta.id),
        live: false,
      })
    }
    return out
  }

  /** 一次保温。`via` 记录触发方式，便于面板区分自动/手动/面板/工具/CLI。 */
  /**
   * **跨进程抢「正在保温」标记**。
   *
   * 必须在 `withStateLock` 的临界区内**重新 `loadState()`** —— 内存 `state` 可能是几秒前的快照，
   * 里面没有别的进程刚写进去的标记，拿它判等于没判（两个写者都读到「无标记」就都放行了）。
   * 抢到立刻落盘，让另一个进程下一次 load 就能看见。
   *
   * @param by 谁在抢（`auto` / `panel` / `tool` / `cli`）
   */
  const claimPingInflight = (id: string, by: string): { ok: boolean; detail: string } => {
    const file = stateFile
    try {
      let ok = false
      withStateLock(file, () => {
        const fresh = withOverride(loadState(file))
        ok = tryClaimInflight(fresh, id, by)
        if (ok) saveState(fresh, file)
      })
      if (ok) return { ok: true, detail: '' }
      return { ok: false, detail: '已有保温在飞（另一入口正在保这条会话），本次跳过不花钱' }
    } catch (e) {
      /** 抢标记失败**不能**变成「拒绝保温」—— 那会让用户点了没反应。放行并留日志。 */
      log('抢在途标记失败（放行）：' + String(e))
      return { ok: true, detail: '' }
    }
  }

  /** 释放在途标记并落盘。释放失败无所谓：`INFLIGHT_TTL_MS`（60 秒）后自然过期。 */
  const releasePingInflight = (id: string): void => {
    const file = stateFile
    try {
      withStateLock(file, () => {
        const fresh = withOverride(loadState(file))
        releaseInflight(fresh, id)
        saveState(fresh, file)
      })
    } catch { /* 交给 TTL 兜底 */ }
  }

  /**
   * 保温（活会话）——**外层只管互斥，内层 `pingInner` 才是真逻辑**。
   *
   * 为什么用「改名 + 包一层」而不是在长函数中间插 try/finally：
   * `pingInner` 里有十几处 `return`，手工包容易漏掉一处就把这条会话堵到过期。
   */
  async function ping(
    agent: AgentLike,
    via: 'auto' | 'panel' | 'tool' | 'cli' | 'manual' = 'manual',
    signal?: AbortSignal,
  ): Promise<{ entry?: LedgerEntry; result: string }> {
    syncState()
    const id = String(agent.session.id)
    /**
     * **门禁先判、抢占在后**：`check-guard` 的契约是「被拒后 state.json 未被改写」。
     * 抢占要写盘（让别的进程看得见），所以它必须发生在门禁放行之后。
     */
    const guardEarly = spendGuard(id)
    if (guardEarly !== undefined) return { result: guardEarly }
    const claim = claimPingInflight(id, via)
    if (!claim.ok) {
      log('跳过保温 ' + shortId(id) + '：' + claim.detail)
      return { result: claim.detail }
    }
    try {
      return await pingInner(agent, via, signal)
    } finally {
      releasePingInflight(id)
    }
  }

  async function pingInner(
    agent: AgentLike,
    via: 'auto' | 'panel' | 'tool' | 'cli' | 'manual' = 'manual',
    signal?: AbortSignal,
  ): Promise<{ entry?: LedgerEntry; result: string }> {
    syncState()
    const id = String(agent.session.id)
    const guard = spendGuard(id)
    if (guard !== undefined) return { result: guard }
    const policy = policyOf(state, id)
    const s = state.settings
    const prompt = policy.prompt ?? s.prompt ?? DEFAULT_PROMPT
    const maxTokens = policy.maxTokens ?? s.maxTokens
    const plan = planReplay(agent, prompt, maxTokens)
    if (plan === null) return { result: '该会话还没有路由过任何请求，拿不到 provider/model，无法保温。' }
    /**
     * **试验护栏**：`labMode` 时只允许白名单会话、且本轮不超预算、且**单次最坏花费放得下**。
     * 放在 `plan` 之后：最坏花费要用本次请求的实际请求体来估；非试验模式第一条就放行（零行为变化）。
     */
    const lg = labVerdict(
      state, id, ledgerOf(state, id),
      worstCostOf(
        promptTokensEstimate(plan.request, ledgerOf(state, id).slice(-1)[0]?.promptTokens ?? 0),
        maxTokens,
        s.prices,
      ),
    )
    if (!lg.ok) {
      log(`试验护栏拦截 ${shortId(id)}（${lg.step}）：${lg.why}`)
      return { result: `试验护栏拦截（${lg.step}）：${lg.why}`, fatal: true }
    }

    /**
     * **花钱之前先比前缀指纹。**
     *
     * 指纹变了 = 缓存锚点已被改写 = 这次保必定 0 命中。实测（2026-10-17）：
     * 同一会话 5.5 小时前命中 99.9%，换了个 DSH 实例之后再保，promptTokens 一字不差
     * （275902 → 275902）却命中 0%，一次白烧 0.43 元。
     *
     * 只拦「上一次保温之后变过」的；从没保过的放行。跳过时不发请求、不记账、不花钱 ——
     * 等用户在会话里发一条真实消息重建缓存，指纹稳定下来自然会放行。
     */
    const lastLed = ledgerOf(state, plan.sessionId).slice(-1)[0]
    const prevFp = lastLed?.fingerprint
    /**
     * **只跟同版本的指纹比**（`fingerprint.ts` 的 `FINGERPRINT_VERSION`）。
     *
     * 序列化口径一变（比如第 0 条 role 从 `system` 改成 `developer`），所有历史账本里的旧指纹
     * 都会与新版对不上 → 每条有记录的会话都判「前缀已变」→ 暂停。而真正停保的是
     * 「上次保温后没有真实活动」的那些 —— 正是纯靠保温续命的闲置会话，不能接受。
     * 旧账本里的无前缀指纹走这里直接豁免，零停保、零迁移。
     */
    if (isCurrentFingerprint(prevFp) && prevFp !== plan.fingerprint && !prefixStale.has(plan.sessionId)) {
      /**
       * `at` 记的是**上次成功保温的时刻**，不是"发现失配的时刻"。
       *
       * 为什么必须这样：指纹变化几乎总是由一次**真实活动**引起的（用户聊了一轮 → 开头的
       * 运行时上下文快照变了），而真实活动**必然早于**发现时刻（tick 60 秒一拍）。
       * 若用发现时刻，`lastActiveOf > at` 就永远为假 → 每次失配都判成"尚未被真实使用"，
       * 暂停会精确盖住唯一值得保温的窗口（刚被真实请求重建缓存的那一刻）。
       */
      prefixStale.set(plan.sessionId, { at: lastLed?.at ?? 0, loggedAt: 0, nextTryAt: 0 })
      log(`会话 ${shortId(plan.sessionId)} 前缀指纹变了（${prevFp} → ${plan.fingerprint}）→ 暂停保温（不花钱）`)
    }
    const held = prefixStale.get(plan.sessionId)
    if (held !== undefined) {
      /**
       * 恢复条件：**指纹变化之后会话被真实使用过** —— 那时缓存已被真实请求重建。
       * 没有这条恢复路径就会死锁：跳过时不记账，`prevFp` 永远是旧指纹，于是永远失配。
       */
      if (lastActiveOf(plan.sessionId) > held.at) {
        prefixStale.delete(plan.sessionId)
      } else {
        held.nextTryAt = Date.now() + PREFIX_STALE_RETRY_MS
        if (Date.now() - held.loggedAt > 600_000) {
          held.loggedAt = Date.now()
          log(`会话 ${shortId(plan.sessionId)} 前缀已变且尚未被真实使用 → 继续暂停保温`)
        }
        return {
          result: '前缀已变（工具声明或开头的系统消息被改写过），这时保必定 0 命中 → 已暂停、没花钱。'
            + '在会话里发一条消息重建缓存后会自动恢复。',
        }
      }
    }

    /**
     * **G10 在途账**：发请求前先记一条 pending（含 `worstCostOf` 与时间），
     * 拿到 usage 就删（真实花费已进账本）；拿不到就标 `unknown` 并按 worst 计入本周期花费。
     * **只在试验模式**写；非试验模式 `labMode !== true` 直接跳过（生产零影响）。
     */
    let pendingId: string | undefined
    if (state.settings.labMode === true) {
      const worst = worstCostOf(promptTokensEstimate(plan.request, lastLed?.promptTokens ?? 0), maxTokens, s.prices)
      pendingId = appendLabPending(state, plan.sessionId, worst)
    }
    const r = await runReplay(ctx.llm as never, plan, signal)
    if (pendingId !== undefined) settleLabPending(state, pendingId, r.ok && r.usage !== undefined)
    if (!r.ok || r.usage === undefined) {
      return { result: '保温请求失败：' + (r.error ?? '没有拿到 usage') + '（未记账）' }
    }
    const u = r.usage
    const prev = ledgerOf(state, plan.sessionId).slice(-1)[0]
    // 压缩/裁剪会让 prompt 骤降 —— 旧账本的命中率、连续次数、自适应间隔全部失去意义。
    // 不重置的话，压缩后的正常保温会被上一次的低命中率永久判成"熔断"。
    if (prev !== undefined && isCompactionDrop(prev.promptTokens, promptTokens(u))) {
      clearLedger(state, plan.sessionId)
      log(`会话 ${shortId(plan.sessionId)} 前缀骤降（${prev.promptTokens} → ${promptTokens(u)}），判定为压缩/裁剪 → 账本与熔断状态已重置`)
    }
    const now = Date.now()
    const actAt = lastActiveOf(plan.sessionId)
    const since = Math.max(prev?.at ?? 0, actAt)
    const gapSeconds = since > 0 ? Math.round((now - since) / 1000) : 0
    const interval = (policy.intervalSeconds ?? s.intervalSeconds) * 1000
    const touch = prev !== undefined && gapSeconds < (interval / 1000) * 3 ? prev.touch + 1 : 1
    /**
     * 计价 = 模型价表 × 峰谷倍率，时刻取**这次请求发出的那一刻**（`now - r.ms`）——
     * 跨时段边界时按发车时刻算才不会记错账。
     */
    const priced = effectivePrices(
      s.prices, plan.model, s.pricesByModel, state.settings.tariff, now - r.ms,
    )
      /**
       * **走唯一工厂** `buildLedgerEntry`（`core/ledger-entry.ts`）：
       * `rewriteFp` / `fingerprint` 这类「判定基准字段」只要一边漏写，另一侧就读到 `undefined`
       * → 判定落 `unknown` 静默放行（保护失效且不报错，跑几天才发现多花钱）。
       */
      const entry: LedgerEntry = buildLedgerEntry({
        at: now,
        rewriteFp: rewriteFpFor(plan.sessionId),
        gapSeconds,
        promptTokens: promptTokens(u),
        hitTokens: u.cacheReadTokens ?? 0,
        missTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheWriteTokens: (u as { cacheWriteTokens?: number }).cacheWriteTokens ?? 0,
        cost: costOf(u, priced.prices),
        hitRate: hitRate(u),
        ms: r.ms,
        touch,
        via,
        fingerprint: plan.fingerprint,
        model: plan.model,
        factor: priced.factor,
        factorLabel: priced.label,
        cycle: cycleOf(state, plan.sessionId),
      })
    appendLedger(state, plan.sessionId, entry)
    /**
     * **熔断不再推进计费周期**（周期只由「清账」推进）。
     * 以前熔断就开新周期，面板出现「本期 0 次 / 显示熔断」的自相矛盾，
     * 且「重建型低命中」会被误判成异常 → 把刚重建好的缓存扔掉。
     */
    if (entry.hitRate < state.settings.circuitHitRate) {
      log(`会话 ${shortId(plan.sessionId)} 命中率 ${(entry.hitRate * 100).toFixed(1)}%（低于熔断线 ${(state.settings.circuitHitRate * 100).toFixed(0)}%，本次新建缓存 ${entry.cacheWriteTokens ?? 0} tok，周期不推进）`)
    }
    commit()
    return { entry, result: '' }
  }

  /**
   * 用账本里记下的 `model` + `factor` **重建当时那套单价**。
   *
   * 为什么必须重建：`e.cost` 是实付价（已含模型价与时段倍率），而
   * `coldStartCost(tokens, settings.prices)` 用的是基准价 —— 两者口径不同，
   * 时段表开着时杠杆会差一个倍率（实测高峰 ×2 时显示 24 倍、真实 48 倍）。
   */
  function entryPrices(e: LedgerEntry): Prices {
    const byModel = priceForModel(e.model ?? '', state.settings.pricesByModel, state.settings.prices)
    return scalePrices(byModel, e.factor ?? 1)
  }

  /**
   * **离线保温的记账**（历史会话走这条路，没有活的 agent 时用）。
   *
   * 规则与 `ping()` 后半段逐条一致：压缩检测 → 断档/连续次数 → 峰谷计价 → 落账。
   * 抽出来是因为两处都要，且都不能各写一套（否则账本口径会漂）。
   */
  function appendOfflineEntry(
    sessionId: string,
    usage: { inputTokens?: number; cacheReadTokens?: number; outputTokens?: number; cacheKnown?: boolean },
    ms: number,
    policy: SessionPolicy,
    model: string | undefined,
    via: LedgerEntry['via'],
  ): LedgerEntry {
    syncState()
    const s = state.settings
    const prev = ledgerOf(state, sessionId).slice(-1)[0]
    if (prev !== undefined && isCompactionDrop(prev.promptTokens, promptTokens(usage))) {
      clearLedger(state, sessionId)
      log(`会话 ${shortId(sessionId)} 前缀骤降（${prev.promptTokens} → ${promptTokens(usage)}），判定为压缩/裁剪 → 账本已重置`)
    }
    const now = Date.now()
    const actAt = lastActiveOf(sessionId)
    const since = Math.max(prev?.at ?? 0, actAt)
    const gapSeconds = since > 0 ? Math.round((now - since) / 1000) : 0
    /** 与 `ping()` 一致用**基础**间隔（含自适应会让两条路累加「连续次数」的窗口不同）。 */
    const interval = (policy.intervalSeconds ?? s.intervalSeconds) * 1000
    const touch = prev !== undefined && gapSeconds < (interval / 1000) * 3 ? prev.touch + 1 : 1
    const priced = effectivePrices(s.prices, model, s.pricesByModel, s.tariff, now - ms)
      /**
       * **走唯一工厂** `buildLedgerEntry`（`core/ledger-entry.ts`）：
       * `rewriteFp` / `fingerprint` 这类「判定基准字段」只要一边漏写，另一侧就读到 `undefined`
       * → 判定落 `unknown` 静默放行（保护失效且不报错，跑几天才发现多花钱）。
       */
      const entry: LedgerEntry = buildLedgerEntry({
        at: now,
        rewriteFp: rewriteFpFor(sessionId),
        gapSeconds,
        promptTokens: promptTokens(usage),
        hitTokens: usage.cacheReadTokens ?? 0,
        missTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        cost: costOf(usage, priced.prices),
        hitRate: hitRate(usage),
        ms,
        touch,
        via,
        /** 提供方没报命中数时标出来，否则会被当成 0 命中去熔断。 */
        ...(usage.cacheKnown === false ? { cacheUnknown: true } : {}),
        model: model ?? '',
        factor: priced.factor,
        factorLabel: priced.label,
        cycle: cycleOf(state, sessionId),
        offline: true,
      })
    appendLedger(state, sessionId, entry)
    /** 命中率低于熔断线只**记日志**，不推进计费周期（周期只由「清账」推进）—— 旧注释写「熔断即换周期」与代码不符，已改。 */
    if (entry.hitRate < state.settings.circuitHitRate && entry.cacheUnknown !== true) {
      log(`会话 ${shortId(sessionId)} 命中率 ${(entry.hitRate * 100).toFixed(1)}%（本次新建缓存 ${entry.cacheWriteTokens ?? 0} tok，周期不推进）`)
    }
    commit()
    return entry
  }

  /**
   * 离线保温（非本进程 / 历史会话）：读日志离线装配 → 用 DSH 自己的 llm 适配器发 →
   * 失败回落直连 DeepSeek。
   *
   * 返回形与 `ping(agent)` 一致（`{ entry?, result }`），供 **tick 自动路径**与 `/ping` 路由共用。
   * **不要各写一份** —— `markItem` 分叉的教训（一份漏字段，两边口径就不同）。
   */
  /**
   * 保温（离线装配）—— 与 `ping()` 同一个在途标记：活会话和离线会话抢的是**同一把锁**，
   * 否则「面板点活会话 + CLI 保离线」会在同一时刻对同一条会话各发一次。
   */
  async function pingOffline(
    row: SessionRow,
    via: LedgerEntry['via'],
    force?: boolean,
  ): Promise<{ entry?: LedgerEntry; result: string }> {
    syncState()
    /** 同 `ping()`：门禁先判，被拒的路径绝不写盘。 */
    const guardEarly = spendGuard(row.id)
    if (guardEarly !== undefined) return { result: guardEarly, fatal: true }
    const claim = claimPingInflight(row.id, via ?? 'auto')
    if (!claim.ok) {
      log('跳过保温 ' + shortId(row.id) + '：' + claim.detail)
      return { result: claim.detail }
    }
    try {
      return await pingOfflineInner(row, via, force)
    } finally {
      releasePingInflight(row.id)
    }
  }

  async function pingOfflineInner(
    row: SessionRow,
    via: LedgerEntry['via'],
    force?: boolean,
  ): Promise<{ entry?: LedgerEntry; result: string }> {
    syncState()
    const guarded = spendGuard(row.id)
    if (guarded !== undefined) return { result: guarded, fatal: true }
    const policy = policyOf(state, row.id)
    const prompt = policy.prompt ?? state.settings.prompt
    const maxTokens = policy.maxTokens ?? state.settings.maxTokens
    /**
     * **试验护栏（离线分支）**：活会话那条（`ping()` 开头）拦不住这里 ——
     * 历史会话走 `ctx.llm.stream` / 直连，是真花钱的路。最坏花费用账本末条 prompt 估。
     */
    const lg = labVerdict(
      state, row.id, ledgerOf(state, row.id),
      worstCostOf(
        promptTokensEstimate(prompt, ledgerOf(state, row.id).slice(-1)[0]?.promptTokens ?? 0),
        maxTokens,
        state.settings.prices,
      ),
    )
    if (!lg.ok) {
      log(`试验护栏拦截（离线）${shortId(row.id)}（${lg.step}）：${lg.why}`)
      return { result: `试验护栏拦截（${lg.step}）：${lg.why}` }
    }
    let llmErr = ''
    /** 在 try 外可见：兜底判据要用它区分「没有 provider/model」与「装配/序列化崩了」。 */
    let plan: ReturnType<typeof planReplayFromAssembled> = null
    try {
      const assembled = await assembleSession(row.logFile, prompt)
      if (assembled.error !== undefined) llmErr = '装配失败：' + assembled.error
      /**
       * 诊断：真实请求应当长什么样（role / thinking / 输出上限键名）。
       * 全部来自 `wireShapeOf()`（= `provider-meta` 的判定），命中率异常时看这一行定位。
       */
      if (assembled.error === undefined) {
        const shape = wireShapeOf(assembled, dshHome)
        log(`离线会话 ${shortId(row.id)} wire=${shape.instructionRole}`
          + `/${shape.maxTokensField}`
          + (shape.thinking === undefined ? '/无thinking' : `/${shape.thinking.type}`)
          + (shape.reasoningEffort === undefined ? '' : `/${shape.reasoningEffort}`))
      }
      /**
       * **前缀刚被改写且之后没有真实请求** → 直接拒（除非 force）。压缩改历史中段、goal 改 system，
       * 都不进前缀指纹，只能靠日志事件判；这时保了是付一次全量。
       */
      if (assembled.rewrite !== undefined && force !== true) {
        return {
          result: '前缀刚被改写（' + assembled.rewrite.detail + '）→ 这时保了是付一次全量。'
            + '在会话里发一条消息重建缓存后会自动恢复。',
        }
      }
      /**
       * 这里不因图片拒绝：`assembled` 原样交给 DSH 的 llm 适配器（`planReplayFromAssembled`
       * 保留 attachment 块），适配器会自己去附件库取图 —— 前缀与真实请求一致。
       * 图片拦截只对「自己序列化成请求体」的路径有意义（`warmOffline` / CLI 直连）。
       */
      plan = planReplayFromAssembled(assembled, row.id, prompt, maxTokens)
      if (plan === null) llmErr = '装配结果没有 provider/model（config=' + JSON.stringify(assembled.config) + '）'
      if (plan !== null) {
        const out = await runReplay(ctx.llm as never, plan)
        if (out.ok && out.usage !== undefined) {
          return { entry: appendOfflineEntry(row.id, out.usage, out.ms, policy, plan.model, via) }
        }
        if (out.error !== undefined) {
          llmErr = out.error
          log(`离线会话 ${shortId(row.id)} 走 llm 失败：${out.error}（改试直连 DeepSeek）`)
        } else if (!out.ok) {
          llmErr = '请求失败但没有 error 字段'
        } else {
          llmErr = '没有拿到 usage'
        }
      }
    } catch (e) {
      llmErr = e instanceof Error ? e.message : String(e)
      log(`离线会话 ${shortId(row.id)} 装配/发送失败：${llmErr}（改试直连 DeepSeek）`)
    }
    /**
     * **禁止静默 fallback**：只有两种情形才允许落到「自己拼请求体」的直连兜底 ——
     *   ① `planReplayFromAssembled` 返回 null（装配结果里没有 provider/model，没有 adapter 可走）；
     *   ② DSH 适配器**明确不支持**这条路由（`UNSUPPORTED_*`）。
     * 其余（装配崩溃 / 序列化异常 / 请求失败）**必须报错跳过**：自拼的 body 与 adapter 输出
     * 并不保证同源，静默兜底会花真钱、却让人以为"保温成功"（实测一条会话 713,796 token 只命中 11,008）。
     */
    const canFallback = !llmErr.startsWith('装配失败：')
      && (plan === null || /UNSUPPORTED_|not supported|不支持/iu.test(llmErr))
    if (!canFallback) {
      return {
        result: '离线保温放弃（不走自拼请求体兜底）：' + (llmErr === '' ? '未知原因' : llmErr),
        fatal: true,
      }
    }
    /** 兜底：直连 DeepSeek（第三方 provider 没有配置或 DSH llm 不可用时走这条）。 */
    const r = await warmOffline({
      logFile: row.logFile,
      prompt,
      maxTokens: policy.maxTokens ?? state.settings.maxTokens,
      dshHome,
      /** 显式 force 时放行含图片的会话（用户自己承担污染风险）。 */
      refuseImages: force !== true,
      signal: undefined,
    })
    if (!r.ok || r.usage === undefined) {
      const msg = (r.error ?? '没有拿到 usage') + (llmErr !== '' ? '｜先试过 DSH llm：' + llmErr : '')
      /** 确定性失败（没 key / 没 provider-model / 装配不出来）→ 退避更久，别每 10 分钟又去解压一遍。 */
      const fatal = /API ?Key|provider\/model|装配失败|找不到|不存在/.test(msg + llmErr)
      return { result: msg, ...(fatal ? { fatal: true } : {}) }
    }
    return { entry: appendOfflineEntry(row.id, r.usage, r.ms ?? 0, policy, r.model, via) }
  }
  /**
   * 这条会话当前该用的间隔（秒）：用户/全局基准值（`policy.intervalSeconds` 优先，其次 settings）。
   *
   * 曾经这里还有「按账本命中率自适应」（连续 3 次满命中 ×1.25、差点断 ÷2）：用户已要求删除
   * （`autoAdapt` / `ttl.adaptInterval` 均已删除）—— 间隔现在只由用户设定。
   */
  function effectiveIntervalSeconds(_id: string, policy: SessionPolicy): number {
    return policy.intervalSeconds ?? state.settings.intervalSeconds
  }

  /**
   * 取当前**注册表**里的工具集 —— **仅供诊断，不要拿它当保温请求的 tools。**
   *
   * 实测反例（会话 f-4212f29352da）：注册表 33 个，而 `header.tools` 是 76 个
   * （多出的 43 个是被工具冻结插件补回 assembly 的、注册表里已卸载的工具）。
   * 真实请求的 assembly 是那个 76，不是这 33。
   */
  function registryToolsForDiagnostics(): readonly unknown[] | undefined {
    try {
      const svc = ctx.tools as unknown as { schemas?: (scope?: unknown) => unknown } | undefined
      const s = svc?.schemas?.(undefined)
      return Array.isArray(s) ? s : undefined
    } catch {
      return undefined
    }
  }

  /** 组装门禁输入（tick / 面板 / CLI 共用 `buildGateInput()`，保证三处结论一致）。 */
  /** 取会话日志路径 → 带缓存的「前缀改写」判定（见 core/rewrite.ts 的 `rewriteOfFile`）。 */
  function rewriteOfFileFor(id: string) {
    const row = sessionIndex.cached.find((r) => r.id === id)
    return row === undefined ? undefined : rewriteOfFile(row.logFile)
  }

  /**
   * 落账用的改写指纹（**唯一计算点**）：`ping` 与 `appendOfflineEntry` 都调它，不许各写一份。
   * `check-guard` 有源码断言禁止两边手写 `rewriteFp:` 字面量（一边漏写 = 判定永久失效且不报错）。
   */
  function rewriteFpFor(id: string): string {
    return rewriteFpOf(rewriteOfFileFor(id))
  }

  /**
   * **改写指纹判定**（契约见 `.tmp/plan-a.md` / lead 的 C3）：
   *
   *  - `无改写` → `ok`（放行）
   *  - 有改写，且**与上一条账本的 `rewriteFp` 相同** → `ok`（上次保温就发生在这个改写之后，缓存早已重建）
   *  - 有改写，且与上一条**不同** → `stale`（真变了，保了就是付全量）
   *  - 上一条账本没有 `rewriteFp`（老账本）→ `unknown`，**放行**并在本次落账时补写（兼容老数据）
   *
   * 旧逻辑是「有改写且之后没请求就拒」，会**误拒**：上次保温明明就在这个改写之后，仍被拒到用户真聊一句为止。
   */
  function rewriteVerdict(id: string, rw: PrefixRewrite | undefined): 'ok' | 'stale' | 'unknown' {
    if (rw === undefined) return 'ok'
    const prev = ledgerOf(state, id).slice(-1)[0]
    if (prev === undefined || prev.rewriteFp === undefined) return 'unknown'
    return rewriteFpOf(rw) === prev.rewriteFp ? 'ok' : 'stale'
  }

  /**
   * 门禁输入（活会话）。
   *
   * `at` 可选：**只在虚拟时钟/测试时传**，让门禁与候选名次用同一个"现在"。
   * 生产调用方不传 → `buildGateInput` 内回落 `Date.now()`，行为不变。
   */
  function gateInputFor(agent: AgentLike, at?: number) {
    const id = String(agent.session.id)
    const header = agent.session.requestHeader?.()
    const row = sessionIndex.cached.find((r) => r.id === id)
    /** 活会话也判一次「前缀刚被压缩/goal 改写」—— 否则 tick 会照保，付一次全量（活会话数量少，直接算）。 */
    const rw = rewriteOfFileFor(id)
    /** 只有「真变了」才拒；`unknown`（老账本）放行，落账时补写指纹。 */
    const stale = rewriteVerdict(id, rw) === 'stale'
    /** **判变后只记「见过」，不覆盖判定基准 `rewriteFp`**（覆盖会削掉保护，ui-b 提醒过）。 */
    if (stale) state.rewriteSeen = { ...(state.rewriteSeen ?? {}), [id]: rewriteFpOf(rw) }
    return buildGateInput(state, {
      ...(stale ? { rewritten: true, rewriteDetail: rw?.detail ?? '' } : {}),
      id,
      mtime: row?.mtime ?? 0,
      archived: row?.archived === true,
      /** 子代理走短间隔、不吃 delay（见 `gate.ts` 的 `isSubagent`）。`AgentLike` 上没有 origin，查索引。 */
      isSubagent: row?.origin === 'subagent',
      hasRoute: header?.config?.provider !== undefined && header?.config?.model !== undefined,
      /** 按模型自定义门槛（`settings.modelOverrides`）。 */
      ...(typeof header?.config?.provider !== 'string' || typeof header?.config?.model !== 'string'
        ? {}
        : { provider: header.config.provider, model: header.config.model }),
      tripped: trippedNow(id, at),
      agentStatus: agent.status === 'running' ? 'running' : 'idle',
      /**
       * **活动时间用「最后对话」，不是「最后碰过」**：门禁的 cold-window-idle / too-soon 判的是
       * 真实对话活跃度。用 lastActiveOf（含 mtime / end-seed）会把「只是被点开过」的会话判成刚活动过
       * → 错判 warm、白付一次冷启动。lastActiveOf 仍留给熔断解除 / gapSeconds（那些要的是「有没有人碰过」）。
       */
      lastActivityAt: lastDialogOf(id),
      ...(at === undefined ? {} : { at }),
    })
  }

  /**
   * 门禁输入（**没有活 agent**）。
   *
   * 与 `gateInputFor()` 同口径，只有两处不同：
   *  - `agentStatus` 恒 `idle`（感知不到 running；CLI 侧靠 `runtime.json`，这里没有）
   *  - `hasRoute` 恒 true（日志里有 request/header 就有路由；真装配失败会在 ping 时报错）
   *
   * `at` 可选：同 `gateInputFor()`，只在虚拟时钟/测试时传。
   */
  function gateInputForIdle(id: string, withRewrite = false, at?: number) {
    /** 全量列表（341 条）不逐个解压；只有候选 / 置顶 / 手动强制开才判改写。 */
    const rw = withRewrite ? rewriteOfFileFor(id) : undefined
    const row = sessionIndex.cached.find((r) => r.id === id)
    return buildGateInput(state, {
      ...(rw === undefined ? {} : { rewritten: true, rewriteDetail: rw.detail }),
      id,
      mtime: row?.mtime ?? 0,
      archived: row?.archived === true,
      /** 与 `gateInputFor()` 同口径：子代理走短间隔。 */
      isSubagent: row?.origin === 'subagent',
      hasRoute: true,
      /** 按模型自定义门槛：从日志尾部读 provider/model（尾部解帧，几百微秒）。 */
      ...(row === undefined ? {} : (() => { const m = readSessionModel(row.logFile); return m === undefined ? {} : { provider: m.provider, model: m.model } })()),
      tripped: trippedNow(id, at),
      /* 与 gateInputFor 同口径：门禁看「最后对话」，不看「有没有被点开过」。 */
      lastActivityAt: lastDialogOf(id),
      ...(at === undefined ? {} : { at }),
    })
  }

  /**
   * **花钱前的硬护栏**：单会话预算（`budgetPerSession`）与连续次数上限（`maxTouches`）。
   *
   * `cold-window` / `too-soon` 这类「现在保不划算」的软判断**不拦** —— 用户点「立刻保温」
   * 就是要现在保，`force` 可放行。但上面这两条是**上限制**：再保下去累计保费已超过一次
   * 冷启动（`maxTouches` 的由来就是这个 50 倍价差），继续保纯亏。
   * 实测（2026-10-18）：会话 `f6f7b238b1b5` 被外部每分钟打一次 `/ping`，保了 196 次、
   * 花 0.97 元（≈4 次冷启动），全程没人拦。
   */
  function spendGuard(id: string): string | undefined {
    const policy = policyOf(state, id)
    /**
     * 三条硬上限各有分工，**任何触发方式都拦**（面板按钮、工具、CLI、tick）：
     *  - `budget`        本周期花费（清账后归零）；
     *  - `max-touches`   本周期次数（`touchCountOf` 已减清账基线）；
     *  - `max-touches-total` 累计次数（跨周期，清账也绕不过去的总闸，`0` = 不限）。
     *
     * 只留累计 → 清账后永远保不了（实测「本期才花 0.0086 元却被判次数尽」）；
     * 只留周期 → 反复点「清除计费」可以无限保。所以两个都留、都可调。
     */
    const led = ledgerOf(state, id)
    const touchTotal = led[led.length - 1]?.touch ?? 0
    const touchCycle = touchCountOf(state, id)
    const maxTouches = policy.maxTouches ?? state.settings.maxTouches
    const maxTouchesTotal = state.settings.maxTouchesTotal ?? 0
    const spent = cycleSpendAtCurrentPrices(state, state.settings, id)
    const budget = state.settings.budgetPerSession
    /**
     * ⚠️ **独立判，不要复用 `decideWarm` 的返回码**：它先返回 `fresh` / `too-soon`
     * （「刚保过」比「次数尽」更贴近当下），软判断被 `--force` 放行后就轮不到硬上限 ——
     * 实测 `f6f7b238b1b5` 加 `--force` 又保了一次。
     */
    const overBudget = spent >= budget
    const overCycle = touchCycle >= maxTouches
    const overTotal = maxTouchesTotal > 0 && touchTotal >= maxTouchesTotal
    if (!overBudget && !overCycle && !overTotal) return undefined
    return '保温已触发上限，本次不发请求（没花钱）：'
      + `本期已保 ${touchCycle} 次 / 上限 ${maxTouches} 次，`
      + `累计已保 ${touchTotal} 次 / 上限 ${maxTouchesTotal > 0 ? maxTouchesTotal : '不限'}，`
      + `本期花费 ${yuan(spent)} / 上限 ${yuan(budget)}。`
      + '要接着保：面板「清除计费」开新周期（次数与花费都从 0 起算），或调高对应上限。'
  }

  // ── 面板数据 ────────────────────────────────────────────────────────────
  /**
   * 组装面板快照。
   *
   * **会话来源以磁盘为准**（238 条），进程内 agent 只用来叠加"活着/在跑/能直接保温"的状态。
   * 不在本进程内的历史会话**照样按离线口径过门禁** —— 去掉「激活」之后两者都能保（`/ping` 走 `warmOffline()`）。
   * 它们要保温得靠独立 CLI（读日志离线重放）。
   */
  function snapshot(): unknown {
    syncState()
    const now = Date.now()
    const auto = autoSettings()
    const decisions = decideCandidates(state, candidateRows(now, agentsOf()), now, auto)


    const live = new Map<string, AgentLike>()
    for (const a of agentsOf()) live.set(String(a.session.id), a)

    void sessionIndex.list().catch((e: unknown) => {
      scanError = String((e as { message?: string } | undefined)?.message ?? e)
    })
    const disk = sessionIndex.cached

    /**
     * **一次快照内每条会话只解一次帧**：`build()`（要填 `lastDialogAt`）与排序（按对话倒序）都要用，
     * 不共用就会解两遍。
     *
     * **优先读 `sessions.meta.json`**：插件 tick 每 5 分钟把它写进去（`lastDialogAt` 字段），
     * 读一次 40KB JSON（~2ms）就能覆盖 459 条 —— 比逐条查 `LAST_DIALOG_CACHE` 更省，
     * 也让「重启后第一次打开面板」不用等全量解帧。
     */
    const metaFile = readSessionMeta(dshHome)
    const dialogCache = new Map<string, number>()
    const dialogFor = (id: string): number => {
      let d = dialogCache.get(id)
      if (d === undefined) {
        const fromMeta = metaFile?.items[id]?.lastDialogAt
        d = fromMeta !== undefined ? fromMeta : lastDialogOf(id)
        dialogCache.set(id, d)
      }
      return d
    }
    const build = (id: string, meta: SessionRow | undefined, agent: AgentLike | undefined) => {
      const policy = policyOf(state, id)
      const led = ledgerOf(state, id)
      const last = led[led.length - 1]
      const header = agent?.session?.requestHeader?.()
      const actAt = lastActiveOf(id)
      const dec = decisions.get(id)
      const gate = agent !== undefined
        ? decideWarm(gateInputFor(agent))
        /**
         * 历史会话（不在本进程内）也走同一条门禁 —— 只是没有活 agent，用「空闲 + 有路由」的保守口径。
         * **不要再标记成 `no-agent`**：那样面板会写「本插件直接保不了」，而按钮其实已经能离线保了。
         * 列表是**全量** 339 条：只有候选/置顶才去解压判改写，否则首轮会阻塞主进程好几秒。
         */
        : decideWarm(gateInputForIdle(id, dec?.picked === true || pinnedSet().has(id) || policyOf(state, id).mode === 'on'))
      return {
        id,
        short: shortId(id),
        title: titleOf(agent, meta),
        titleSource: meta?.titleSource ?? 'none',
        sizeBytes: meta?.sizeBytes ?? 0,
        mtime: meta?.mtime ?? 0,
        projectKey: meta?.projectKey ?? '',
        archived: meta?.archived ?? false,
        /** DSH workspace 的置顶（只读参考）。 */
        pinned: meta?.pinned ?? false,
        /** 本插件面板自己的置顶（可改，存在 state.json）。 */
        pinnedInPanel: pinnedSet().has(id),
        /** 子代理会话（`subagent`）—— 列表默认隐藏、自动候选默认排除。 */
        origin: meta?.origin ?? '',
        /** 是否在本进程内（只有它能被本插件直接保温）。 */
        live: agent !== undefined,
        status: agent?.status ?? 'offline',
        route: header?.config?.provider !== undefined ? `${header.config.provider}/${header.config.model}` : '',
        mode: policy.mode,
        note: policy.note ?? '',
        isAutoCandidate: dec?.picked ?? false,
        autoRank: dec?.rank ?? -1,
        autoReason: dec?.reason ?? '',
        lastActiveAgoSec: actAt > 0 ? Math.round((now - actAt) / 1000) : -1,
        gateOk: gate.ok,
        /** 长闲置二档（「断档过久」/「闲置过久」）：只影响文案，不影响判定。 */
        gateLong: gate.ok !== true && gate.long === true,
        /**
         * 门禁码**通过时也给**（`warm`）—— 面板不再只显示「✅ 通过」，
         * 而是把「通过 + 距上次保温多久 / 距上次会话多久」一并说出来。
         * 用户口径：门禁是额外信息，不是一张拦截码列表。
         */
        gateCode: !gate.ok ? gate.code : (prefixStale.has(id) ? 'prefix-changed' : 'warm'),
        gateDetail: !gate.ok
          ? gate.detail
          : (prefixStale.has(id)
            ? renderGateText(state.settings.gateDetail['prefix-changed'] || GATE_DETAIL_DEFAULTS['prefix-changed'] || '')
            : ''),
        /** 距上次保温多少分钟（-1 = 从没保过）。 */
        lastTouchAgoMin: last === undefined ? -1 : Math.round((now - last.at) / 60000),
        /** 距上次会话活动多少分钟（-1 = 未知）。 */
        lastActivityAgoMin: actAt > 0 ? Math.round((now - actAt) / 60000) : -1,
        last: last === undefined ? null : {
          at: last.at,
          hitRate: last.hitRate,
          hitTokens: last.hitTokens,
          promptTokens: last.promptTokens,
          /** 展示按**当前价格**重算（账本 `cost` 是记账快照，改价后要跟着变）。 */
          cost: recomputeCost(last, state.settings).cost,
          ms: last.ms,
          touch: last.touch,
          via: last.via ?? 'manual',
          /** 与上一条比换了模型（面板据此标「换模型」：这种低命中是缓存池变了，不是装配坏了）。 */
          modelChanged: modelChangedOf(led[led.length - 2], last),
          ...(last.model === undefined ? {} : { model: last.model }),
        },
        /** **展示**花费按**当前价格**重算（改价后历史数据跟着变）；预算/熔断仍用存储 `e.cost`。 */
        spend: spendAtCurrentPrices(led, state.settings).cost,
        /** 预算口径：真实花过的钱（改价不影响）。 */
        ledgerSpend: led.reduce((sum, e) => sum + e.cost, 0),
        /** 当前保温周期号。 */
        cycle: cycleOf(state, id),
        /** 本周期花费（**账本口径**「总花费」= 全部周期之和，永不减少；判定方在用，别改）。 */
        cycleSpend: cycleSpendOf(state, id),
        /** 本周期花费（**展示口径**：逐笔按当前价重算，面板读它）。 */
        cycleSpendDisplay: spendAtCurrentPrices(
          led.filter((e) => (e.cycle ?? 1) === cycleOf(state, id)), state.settings,
        ).cost,
        cycleCount: ledgerOf(state, id).filter((e) => (e.cycle ?? 1) === cycleOf(state, id)).length,
      /** 全部保温次数（跨周期），「花费」列切到「全部」时显示它。 */
      warmCount: ledgerOf(state, id).length,
        count: led.length,
        tripped: trippedNow(id),
        prompt: policy.prompt ?? '',
        maxTokens: policy.maxTokens ?? state.settings.maxTokens,
        /**
         * **生效间隔（秒）**：与门禁/自动候选同一套 per-model 覆盖（`effectiveLimitsOf`）。
         * 只读 `policy.intervalSeconds ?? settings.intervalSeconds` 完全不吃 `modelOverrides`，
         * 用户按模型填了间隔却看到全局值 = 「以为没生效」。
         */
        intervalSeconds: (() => {
          const m = readSessionModel(row?.logFile ?? '')
          /** model 的兜底：日志头常拿不到，账本末条一直记着。 */
          const lastLed = led[led.length - 1]
          const model = m?.model ?? lastLed?.model
          const lim = effectiveLimitsOf(state.settings, m?.provider, model)
          if (model === undefined || lim.intervalMs <= 0) return effectiveIntervalSeconds(id, policy)
          return Math.round(Math.max(1, lim.intervalMs / 1000))
        })(),
        /** 你设的基准间隔（自适应可能把它改掉，面板要能标出「自适应 ← 你设的 X」）。 */
        baseIntervalSeconds: policy.intervalSeconds ?? state.settings.intervalSeconds,
        adaptedSeconds: policy.adaptedSeconds ?? null,
        maxTouches: policy.maxTouches ?? state.settings.maxTouches,
        /**
         * **最后一条对话的时间**（`user/message`/`assistant/message`）；`0` = 未知。
         * 面板「上次对话」列读它 —— 之前 snapshot 没给这个字段，前端恒显示 `—`。
         */
        lastDialogAt: dialogFor(id),
      }
    }

    const rows = disk.map((meta) => build(meta.id, meta, live.get(meta.id)))
    const known = new Set(disk.map((m) => m.id))
    for (const [id, agent] of live) {
      if (!known.has(id)) rows.push(build(id, undefined, agent)) // 还没落盘的活会话
    }
    /**
     * 默认排序：**按「最后对话」倒序**（前端可自行改排）。
     *
     * ⚠️ **不再优先 `live`**：A 批之后非活会话也能保温，把活会话永远排最前会把「最该保的、最近聊过的那条」压到后面。
     * `live` 只在 `mtime` 相同时做 tie-break（稳定排序用）。
     */
    /**
     * 按**最后对话**倒序（`lastDialogOf`，回落 `mtime`）；`live` 只在完全同分时 tie-break。
     *
     * ⚠️ **不再优先 `live`**：A 批之后非活会话也能保温，把活会话永远排最前会把「最该保的、最近聊过的那条」压到后面。
     * 用 `lastDialogOf` 而不是 `mtime`：`mtime` 含 end-seed / 工具轮，会让「刚被工具碰过但早就没对话」的会话插队。
     */
    rows.sort((a, b) => {
      const da = dialogFor(a.id)
      const db = dialogFor(b.id)
      if (db !== da) return db - da
      if (a.live !== b.live) return a.live ? -1 : 1
      return 0
    })

    return {
      now,
      /** 面板变体：插件版（有活 agent、用 settings.colWidths 那一份列宽）。 */
      variant: 'plugin',
      settings: state.settings,
        /** provider/model 目录，面板下拉框用（拿不到就是空数组，不影响其它功能）。 */
        modelCatalog,
      /** 试验模式三块数据：工厂唯一，与 CLI 网页版共用（别各写一份，上一轮 markItem 就是这么分叉的）。 */
      ...labSnapshotOf(state),
      build: BUILD_ID,
      gateTexts: GATE_TEXTS,
      sessions: rows,
      diskCount: disk.length,
      liveCount: live.size,
      lastScanAt: sessionIndex.lastScanAt,
      scanError,
      statePath: stateFile,
      dshHome,
      panelPath: PANEL_PATH,
      apiPrefix: API_PREFIX,
      tickCount,
      lastTickAt,
      tickMs,
    }
  }

  /**
   * 会话时间轴：**每一轮真实对话的计费** + **保温记录**，按时间合并成一条轴。
   *
   * 保温在轴上表现为「额外插入的一个轮次」—— 它本质就是一次真实的 API 调用，
   * 只不过是我们替用户发的，用来给缓存续命。这样一眼就能看出：
   * 「这一轮真实对话花了多少」和「为了让它不冷、我额外付了多少」的比例。
   *
   * 数据来源两处互补：
   *  - 真实轮次 → 磁盘日志的 `assistant/message.data.usage`（`readRounds`）
   *  - 保温     → 本插件的账本（`ledgerOf`）
   */

  /** 面板自己的置顶开关（写 state.json，与 DSH workspace 的置顶互不干扰）。 */
  function setPinned(id: string, pinned: boolean): { ok: boolean; error?: string } {
    syncState()
    const target = resolveSessionId(id)
    if (target === undefined) return { ok: false, error: '找不到会话 ' + id }
    const set = new Set(state.pinnedSessions ?? [])
    if (pinned) set.add(target)
    else set.delete(target)
    commit()
    return { ok: true }
  }

  async function timelineOf(id: string, granularityIn?: string): Promise<Record<string, unknown>> {
    const disk = sessionIndex.cached.length > 0 ? sessionIndex.cached : await sessionIndex.list()
    const row = disk.find((r) => r.id === id)
      ?? disk.find((r) => r.id.endsWith(id))
    if (row === undefined) return { ok: false, error: '找不到该会话' }

    const s = state.settings
    /**
     * 粒度：`step` = 每次 API 调用一项（一次工具往返就是两项），
     * `turn` = 一整轮合计一项，`both` = 两种都列（对照用）。
     * 请求参数优先；面板详情页每次都显式传，缺省按 step。
     */
    const gran = granularityIn === 'step' || granularityIn === 'turn' || granularityIn === 'both'
      ? granularityIn
      : 'step'
    /**
     * **一次解码、两处复用**：`readRoundsCachedWithText` 在缓存未命中时把解压后的 text 交回来，
     * 下面 `readMarks` 直接吃它 —— 否则同一条 45MB 日志在这一个请求里会被解压两次（白付约 1.1s）。
     * text 只用于本次请求，不进任何缓存。
     */
    const { rounds, text: roundsText } = readRoundsCachedWithText(row.logFile)
    const warms = ledgerOf(state, row.id)

    const items: Record<string, unknown>[] = []
    /**
     * 每轮的花费 = **该轮逐笔花费之和**，每笔按它自己的时刻取倍率。
     *
     * 不能用「轮首时刻的倍率 × 整轮 token」—— 一轮跨时段边界时（轮首 08:20 空闲、
     * 后续 08:40 高峰）那样算出来的整轮金额与它自己的单步明细对不上，
     * 也与面板顶部按单次调用重算的 summary 对不上（实测差 1.5 倍）。
     */
    const turnAgg = new Map<number, { cost: number; factors: Set<number>; labels: Set<string>; models: Set<string> }>()
    if (gran !== 'step') {
      for (const r of rounds) {
        const c = costAt(
          { cacheReadTokens: r.hitTokens, inputTokens: r.missTokens, outputTokens: r.outputTokens },
          s.prices, r.model, s.pricesByModel, s.tariff, r.time, r.provider,
        )
        const cur = turnAgg.get(r.turn) ?? { cost: 0, factors: new Set<number>(), labels: new Set<string>(), models: new Set<string>() }
        /** 一轮里换过模型：记下全部，输出时多于一个就把 model 留空（不许只取最后一笔）。 */
        if (r.model !== '') cur.models.add(r.model)
        cur.cost += c.cost
        cur.factors.add(c.factor)
        if (c.factor !== 1) cur.labels.add(c.label)
        turnAgg.set(r.turn, cur)
      }
    }
    const pushRound = (granularity: 'step' | 'turn'): void => {
      if (granularity === 'step') {
        for (const r of rounds) {
          const total = r.hitTokens + r.missTokens
          const c = costAt(
            { cacheReadTokens: r.hitTokens, inputTokens: r.missTokens, outputTokens: r.outputTokens },
            s.prices, r.model, s.pricesByModel, s.tariff, r.time,
          )
          items.push({
            kind: 'round',
            gran: 'step',
            time: r.time,
            turn: r.turn,
            step: r.step,
            provider: r.provider,
            model: r.model,
            hitTokens: r.hitTokens,
            missTokens: r.missTokens,
            outputTokens: r.outputTokens,
            hitRate: total === 0 ? 0 : r.hitTokens / total,
            cost: c.cost,
            factor: c.factor,
            factorLabel: c.label,
          })
        }
        return
      }
      for (const t of sumByTurn(rounds)) {
        const total = t.hitTokens + t.missTokens
        const agg = turnAgg.get(t.turn)
        /**
         * 整轮的倍率：整轮只落在同一时段就显示那个倍率，跨时段（factors.size > 1）用 0 表示「混合」。
         */
        const factors = agg?.factors ?? new Set<number>([1])
        const factor = factors.size === 1 ? [...factors][0] : 0
        const factorLabel = factors.size === 1 ? ([...(agg?.labels ?? [])][0] ?? '') : '跨时段'
        /** 一轮内的模型集合：多于一个就留空 model，另给 models 清单（面板据此显示「换过模型」）。 */
        const turnModels = [...(agg?.models ?? new Set())];
        items.push({
          kind: 'round',
          gran: 'turn',
          time: t.time,
          endTime: t.endTime,
          turn: t.turn,
          /** 一轮里有几步 —— 面板显示成 `T3(×2步)`。 */
          steps: t.steps,
          provider: t.provider,
          models: turnModels,
          model: turnModels.length === 1 ? turnModels[0] : '',
          hitTokens: t.hitTokens,
          missTokens: t.missTokens,
          outputTokens: t.outputTokens,
          hitRate: total === 0 ? 0 : t.hitTokens / total,
          cost: agg?.cost ?? 0,
          factor,
          factorLabel,
        })
      }
    }
    if (gran === 'step') pushRound('step')
    else if (gran === 'turn') pushRound('turn')
    else {
      pushRound('turn')
      pushRound('step')
    }
    /**
     * 计算轮次（压缩 / goal）：与保温并列显示 —— 用户看时间轴就能明白
     * 「这一轮之后为什么没保」（前缀被改写，缓存还是改写前的）。
     */
    for (const m of readMarksCached(row.logFile, roundsText)) {
      /** 走唯一工厂：与 core/panel-service.ts（cli --serve 路径）必须逐字段一致。 */
      items.push(markItem(m))
    }
    for (const w of warms) {
      items.push({
        kind: 'warm',
        gran: 'warm',
        time: w.at,
        hitTokens: w.hitTokens,
        missTokens: Math.max(0, w.promptTokens - w.hitTokens),
        outputTokens: w.outputTokens,
        hitRate: w.hitRate,
        /** 展示按**当前价格**重算（账本 `w.cost` 是记账时快照，改价后要跟着变）。 */
        cost: recomputeCost(w, state.settings).cost,
        via: w.via ?? 'manual',
        cycle: w.cycle ?? 1,
        touch: w.touch,
        ms: w.ms,
        model: w.model ?? '',
        factor: w.factor ?? 1,
        factorLabel: w.factorLabel ?? '',
      })
    }
    items.sort((a, b) => Number(a['time']) - Number(b['time']))

    /**
     * summary 恒按**单次调用**口径算，与时轴粒度无关 ——
     * `both` 模式下 items 里同时有「轮合计」和「单步」，直接累加会翻倍。
     */
    let roundCost = 0
    for (const r of rounds) {
      roundCost += costAt(
        { cacheReadTokens: r.hitTokens, inputTokens: r.missTokens, outputTokens: r.outputTokens },
        s.prices, r.model, s.pricesByModel, s.tariff, r.time,
      ).cost
    }
    const warmCostSum = spendAtCurrentPrices(warms, state.settings).cost

    return {
      ok: true,
      id: row.id,
      /** 与列表**同一个** `titleOf()`，避免两处口径不一致（曾有会话列表与详情标题不同）。 */
      title: titleOf(undefined, row),
      short: shortId(row.id),
      prices: s.prices,
      pricesByModel: s.pricesByModel,
      tariff: { enabled: s.tariff.enabled, timeZone: s.tariff.timeZone },
      granularity: gran,
      items,
      summary: {
        rounds: rounds.length,
        turns: new Set(rounds.map((r) => r.turn)).size,
        warms: warms.length,
        cycle: cycleOf(state, row.id),
        cycleWarms: warms.filter((w) => (w.cycle ?? 1) === cycleOf(state, row.id)).length,
        cycleWarmCost: spendAtCurrentPrices(warms.filter((w) => (w.cycle ?? 1) === cycleOf(state, row.id)), state.settings).cost,
        roundCost,
        warmCost: warmCostSum,
        totalCost: roundCost + warmCostSum,
        /** 保温花费占总支出的比例 —— 越低说明保温越值。 */
        warmShare: roundCost + warmCostSum === 0 ? 0 : warmCostSum / (roundCost + warmCostSum),
      },
    }
  }

  function applyPolicy(id: string, patch: Record<string, unknown>): { ok: boolean; error?: string; warning?: string } {
    syncState()
    // 历史会话不在 agentsOf 里 —— 必须回落到磁盘索引，否则策略会写到错键上
    /**
     * 完整 session id 即使索引没扫到也照样用（新会话还没进索引是正常的）；
     * **尾号**解析不到就报错 —— 绝不拿它当键（那是假成功 + 垃圾键）。
     */
    const target = resolveSessionId(id) ?? (id.startsWith('session-') ? id : undefined)
    if (target === undefined) return { ok: false, error: '找不到会话 ' + id }
    let warning: string | undefined
    if (patch.maxTouches !== undefined && Number(patch.maxTouches) > maxTouchesHard(state.settings.prices)) {
      // 只提示，不拦截 —— 用户想设多大就多大
      warning = `提示：连续保温超过 ${maxTouchesHard(state.settings.prices)} 次后，累计保费已超过一次冷启动`
        + `（一次冷启动 ≈ ${warmOverRestart(state.settings.prices)} 次保温）。仍按你的设置执行。`
    }
    // 用户显式改间隔 → 丢掉自适应结果，从用户值重新开始
    const nextPatch = patch.intervalSeconds !== undefined
      ? { ...patch, adaptedSeconds: undefined }
      : patch
    setPolicy(state, target, nextPatch as Partial<SessionPolicy>)
    commit()
    /**
     * 改完策略**立刻重算一次自动候选**。
     *
     * 手动设成「强制开 / 关闭」的会话不占自动名额（见 `auto.ts` 的资格位判定）——
     * 所以一改 mode，候选名单就变了。这里当场重算并记日志，不必等下一个 tick 才发现。
     * tick 与面板用的是同一个纯函数，重算结果与它们完全一致。
     */
    if (patch.mode !== undefined) {
      const picked = pickedIds(decideCandidates(state, candidateRows(Date.now(), agentsOf()), Date.now(), autoSettings()))
      log(`策略变更 ${shortId(target)} → mode=${policyOf(state, target).mode}；`
        + `自动候选即刻重算：入选 ${picked.size} 条`
        + (picked.size > 0 ? '（' + [...picked].map((x) => shortId(x)).join(', ') + '）' : ''))
    }
    return { ok: true, ...(warning !== undefined ? { warning } : {}) }
  }

  /**
   * **清除计费**：开一个新保温周期。
   *
   * 只把周期号 +1，**账本一条都不删** —— 用户口径是「总花费保留历史总和，只重置当前周期花费」。
   * 与「解除熔断」的区别：那个会清账本（连命中率一起归零）。
   */
  function resetCost(id: string): { ok: boolean; cycle?: number; error?: string } {
    syncState()
    const target = resolveSessionId(id)
    if (target === undefined) return { ok: false, error: '找不到会话 ' + id }
    const cycle = beginNewCycle(state, target)
    prefixStale.delete(target)
    commit()
    log('会话 ' + shortId(target) + ' 清除计费 → 保温周期 #' + cycle)
    return { ok: true, cycle }
  }


  /**
   * 手动解除某会话的熔断。
   *
   * 为什么必须有手动入口：熔断是**基于历史记录**的，而"命中的那次为什么低"插件不一定知道。
   * 实测场景：会话 `f-4212f29352da` 在 `toolHistory` 修复前保过一次（命中 0.5%、花 0.58 元）→ 被拉黑；
   * 修复后它本可正常保温，但旧记录把门禁永久卡在 `tripped`，**用户只能干看着**。
   * 缓存热不热用户比插件清楚，所以必须给一个显式的"我确认它现在是热的"入口。
   *
   * ⚠️ **一条记录都不删**（`untripSession` 只记会话级标记）：以前走 `clearLedger`，
   * 历史连同花费一起消失，用户看到「解熔把记录和花费都删了」。现在低命中那条原样留在详情里，
   * 只是判定时视同 100% 命中；新保温落账后标记自动失效。
   */
  function resetCircuit(id: string): { ok: boolean; error?: string } {
    syncState()
    const target = resolveSessionId(id)
    if (target === undefined) return { ok: false, error: '找不到会话 ' + id }
    untripSession(state, target)
    /**
     * 顺手清掉前缀暂停。不清的话「解除熔断」会是个假开关：
     * `prefixStale` 是内存态，只记解熔标记不碰它的话，`held` 还在 → 仍然走暂停分支。
     * 用户点了按钮却毫无变化。
     */
    prefixStale.delete(target)
    commit()
    log(`会话 ${shortId(target)} 熔断已手动解除（记录保留，标记之前的低命中视同 100%）`)
    return { ok: true }
  }

  function applySettings(patch: Record<string, unknown>): { ok: boolean; error?: string; warning?: string } {
    /**
     * **设置类操作强制重读磁盘**：`syncState` 靠 mtime 判据，同一毫秒内多次写盘会漏同步
     * （实测 `smoke-apply` 3 次里 1 次红：内存里的 `labBackup` 还是旧的 → 还原出错的间隔）。
     * 设置读一次 1.6KB 的 JSON 只要 0.2ms，不值得为这点性能冒「用旧配置」的险。
     */
    syncState(true)
    /**
     * 恢复残留的 `labBackup`：**不能**走 `applySettingsPatch({labMode:false})` ——
     * 残留场景下 `labMode` 往往已经是 false，同值不进分支，什么都不会恢复。
     */
    if (patch.restoreLabBackup === true) {
      const r = labRestoreBackup(state)
      if (!r.ok) return { ok: false, error: r.error }
      commit()
      return { ok: true, warning: '已还原：' + (r.restored ?? []).join(' / ') }
    }
    // 语义全部在 `core/settings.ts:applySettingsPatch`（与无实例面板共用，避免两套漂移）
    const out = applySettingsPatch(state, patch)
    if (out.error !== undefined) return { ok: false, error: out.error }
    commit()
    // 试验模式或工具开关变化后要重注册 cache_lab（那是插件侧独有的事）
    syncTools()
    // `notice` = 自动改了别的字段（例如退出试验模式时抬高闲置上限），必须让用户看见
    if (out.notice !== undefined) log('设置提示：' + out.notice)
    return { ok: true, ...(out.notice === undefined ? {} : { warning: out.notice }) }
  }

  // ── 工具 ────────────────────────────────────────────────────────────────
  function statusReport(): string {
    const now = Date.now()
    const auto = autoSettings()
    const decisions = decideCandidates(state, candidateRows(now, agentsOf()), now, auto)
    const lines: string[] = []
    lines.push('缓存保温状态   state: ' + stateFile)
    lines.push('面板: http://127.0.0.1:<端口>' + PANEL_PATH)
    lines.push(`守护 tick: 每 ${tickMs / 1000} 秒一轮，已跑 ${tickCount} 次，` +
      (lastTickAt > 0 ? `上次 ${new Date(lastTickAt).toLocaleTimeString()}` : '**从未跑过**'))
    lines.push(`自动候选: ${auto.enabled ? '开' : '关'}  保 ${auto.count} 条  只保闲置 < ${auto.maxIdleHours} 小时`)
    lines.push('')
    for (const agent of agentsOf()) {
      const id = String(agent.session.id)
      const policy = policyOf(state, id)
      const led = ledgerOf(state, id)
      const last = led[led.length - 1]
      const header = agent.session.requestHeader?.()
      const actAt = lastActiveOf(id)
      const dec = decisions.get(id)
      const route = header?.config?.provider !== undefined ? `${header.config.provider}/${header.config.model}` : '（无路由）'
      const idle = actAt > 0 ? Math.round((now - actAt) / 60000) + ' 分钟前' : '未知'
      lines.push(`会话 ${shortId(id)}`)
      lines.push(`  状态      ${agent.status ?? '?'}  路由 ${route}`)
      lines.push(`  策略      mode=${policy.mode}` +
        (policy.mode === 'auto'
          ? `  自动候选=${dec?.picked === true ? '是(#' + dec.rank + ')' : '否(' + (dec?.reason ?? '-') + ')'}`
          : '  自动候选=不适用（手动）'))
      lines.push(`  活动      最后活动 ${idle}`)
      const effInterval = effectiveIntervalSeconds(id, policy)
      lines.push(`  自定义    prompt=${policy.prompt ?? '（默认）'}  maxTokens=${policy.maxTokens ?? state.settings.maxTokens}` +
        `  interval=${effInterval}s  maxTouches=${policy.maxTouches ?? state.settings.maxTouches}`)
      lines.push(last !== undefined
        ? `  上次保温  ${new Date(last.at).toLocaleString()}  第 ${last.touch} 次  命中率 ${(last.hitRate * 100).toFixed(1)}%` +
          `  (${last.hitTokens}/${last.promptTokens})  花费 ${yuan(recomputeCost(last, state.settings).cost)}  ${last.ms}ms  via=${last.via ?? 'manual'}`
        : '  上次保温  （还没有记录）')
      lines.push(`  累计      ${led.length} 次  共 ${yuan(spendAtCurrentPrices(led, state.settings).cost)}  熔断=${trippedNow(id) ? '是' : '否'}`)
      if (policy.mode !== 'off') {
        const g = decideWarm(gateInputFor(agent))
        if (g.ok && policy.mode === 'on') lines.push('  门禁      ✅ 通过 —— 下次 tick 就保温')
        else if (g.ok) lines.push('  门禁      ✅ 通过（自动候选）')
        else lines.push(`  门禁      ⛔ ${g.code} — ${g.detail}`)
      }
      lines.push('')
    }
    if (agentsOf().length === 0) lines.push('（没有活动中的 agent）')
    return lines.join('\n')
  }

  function registerKeepalive(): () => void {
    return ctx.tools.register(defineTool({
    name: 'cache_keepalive',
    description:
      '缓存保温的**日常运维**工具：看状态、对会话保温、开关自动策略、解除熔断、看会话列表与花费时间轴。'
      + 'action=status 看全部会话状态；sessions 列会话摘要（门禁结论/间隔/次数/花费）；'
      + 'timeline 看某会话每轮真实计费（需 sessionId）；ping 立刻保温一次；on/off/auto 开关某会话；'
      + 'reset 解除某会话熔断。只读会话、不写日志，安全。'
      + '⚠️ 本工具**不碰配置**：改设置、跑不变量自检、预算预估、真跑一枪都在 cache_lab（那是配置与实验工具）。'
      + '图形面板见 status 输出里的面板地址。',
    parameters: {
      action: {
        type: 'string',
        enum: ['status', 'sessions', 'timeline', 'ping', 'on', 'off', 'auto', 'reset'],
        description: 'status=查看状态；sessions=列会话摘要（只列本进程内会话）；timeline=某会话花费时间轴（需 sessionId）；'
          + 'ping=立刻保温一次；on/off=强制开/关该会话；auto=交回自动候选；reset=解除某会话熔断',
      },
      sessionId: { type: 'string', description: '目标会话 id（可只给尾号）；缺省为当前会话' },
      prompt: { type: 'string', description: '该会话的自定义保温问题（务必极短、答案确定）' },
      maxTokens: { type: 'number', description: '输出上限，默认 1（防止模型跑飞）' },
      intervalSeconds: { type: 'number', description: '该会话的保温间隔秒数' },
      maxTouches: { type: 'number', description: '最大连续保温次数；硬上限 49' },
      granularity: {
        type: 'string',
        enum: ['step', 'turn', 'both'],
        description: 'timeline 用：step=每次 API 调用一项，turn=一整轮合计，both=两种都列（缺省 step）',
      },
      note: { type: 'string', description: '备注' },
      doPing: { type: 'boolean', description: 'on/auto 之后是否立刻试保温一次' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: String((value as { text?: string }).text ?? '') }],
    },
    async execute(args, exec): Promise<Record<string, JsonValue>> {
      syncState()
      const action = String(args.action ?? 'status')
      if (action === 'status') return { text: statusReport() }
      /** 与 cache_lab 双写（那边保留兼容）：日常运维只读观测应走本工具。 */
      if (action === 'sessions') return { text: sessionsReport() }
      if (action === 'timeline') {
        const want = String(args.sessionId ?? '')
        if (want === '') return { text: 'timeline 需要 sessionId（可只给尾号）' }
        const data = await timelineOf(want, typeof args.granularity === 'string' ? args.granularity : undefined)
        return { text: `会话 ${shortId(want)} 时间轴：\n` + JSON.stringify(data, null, 2) }
      }

      const agent = resolveAgent(args.sessionId, exec as { agent?: unknown })
      if (agent === undefined) return { text: '找不到目标会话（请给定 sessionId，或在会话内调用）' }
      const id = String(agent.session.id)

      if (action === 'reset') {
        const out = resetCircuit(id)
        return {
          text: out.ok
            ? `会话 ${shortId(id)} 的熔断已解除，账本已重置 —— 下次门禁按新记录判断。`
            : (out.error ?? '失败'),
        }
      }

      if (action === 'ping') {
        const out = await ping(agent, 'tool', exec.signal)
        const e = out.entry
        if (e === undefined) return { text: out.result }
        const lines = [
          `保温完成：会话 ${shortId(id)}`,
          `  前缀    ${e.promptTokens} tokens = 命中 ${e.hitTokens} + 未命中 ${e.missTokens}`,
          `  命中率  ${(e.hitRate * 100).toFixed(2)}%`,
          `  输出    ${e.outputTokens} tokens`,
          `  花费    ${yuan(e.cost)}   ${e.ms}ms` + (e.factor !== undefined && e.factor !== 1 ? `（${e.factorLabel ?? '时段'} ×${e.factor}）` : ''),
          // 冷启动与保温必须用**同一套单价**（同一模型 + 同一时段倍率），否则杠杆被倍率污染
          `  对比    这次前缀若冷启动要 ${yuan(coldStartCost(e.promptTokens, entryPrices(e)))}，保温只花 ${yuan(e.cost)}`,
          `  杠杆    ${(coldStartCost(e.promptTokens, entryPrices(e)) / Math.max(e.cost, 1e-12)).toFixed(1)} 倍`,
        ]
        if (e.hitRate < state.settings.circuitHitRate) {
          lines.push(`  ⚠️ 命中率低于熔断线 ${(state.settings.circuitHitRate * 100).toFixed(0)}% —— 缓存已经断了，本次等于白烧钱，该会话应停止保温`)
        }
        return { text: lines.join('\n') }
      }

      const mode = action === 'on' ? 'on' : action === 'off' ? 'off' : 'auto'
      const out = applyPolicy(id, {
        mode,
        ...(args.prompt !== undefined ? { prompt: String(args.prompt) } : {}),
        ...(args.maxTokens !== undefined ? { maxTokens: Number(args.maxTokens) } : {}),
        ...(args.intervalSeconds !== undefined ? { intervalSeconds: Number(args.intervalSeconds) } : {}),
        ...(args.maxTouches !== undefined ? { maxTouches: Number(args.maxTouches) } : {}),
        ...(args.note !== undefined ? { note: String(args.note) } : {}),
      })
      if (!out.ok) return { text: out.error ?? '设置失败' }
      const warnLine = out.warning !== undefined ? '\n  ⚠️ ' + out.warning : ''

      const policy = policyOf(state, id)
      const lines = [
        `会话 ${shortId(id)} 保温策略已更新：mode=${policy.mode}`,
        `  prompt=${policy.prompt ?? '（默认）'}  maxTokens=${policy.maxTokens ?? state.settings.maxTokens}` +
        `  interval=${policy.intervalSeconds ?? state.settings.intervalSeconds}s  maxTouches=${policy.maxTouches ?? state.settings.maxTouches}`,
      ]
      if (policy.note !== undefined) lines.push(`  备注：${policy.note}`)
      if (warnLine !== '') lines.push(warnLine)
      if (policy.mode !== 'off' && args.doPing === true) {
        const r = await ping(agent, 'tool', exec.signal)
        lines.push(r.entry !== undefined
          ? `  试保温一次：命中率 ${(r.entry.hitRate * 100).toFixed(1)}%，花费 ${yuan(r.entry.cost)}`
          : `  试保温失败：${r.result}`)
      }
      return { text: lines.join('\n') }
    },
  }))
  }

  /** 主工具的注销函数（设置里可关）。 */
  let disposeKeepalive: (() => void) | undefined

  // ── 测验台工具（用户可在面板「设置」页关掉）──────────────────────────────
  /** 测验台用法说明。 */
  const LAB_HELP =
    'cache_lab 用法：\n'
    + '  action=settings      读全部生效设置（含单价、w/r 推论）\n'
    + '  action=set-settings  改设置：直接给要改的平铺字段（intervalSeconds / prices* / labMode …）\n'
    + '  action=sessions      列本进程内会话摘要（模式、花费、上次命中率、门禁码）\n'
    + '  action=timeline      某会话的每轮真实计费时间轴（需 sessionId）\n'
    + '  action=lab           切换试验模式（时间参数压到秒级）\n'
    + '  action=experiment    跑虚拟不变量检查（零花费、不联网），spec 传 JSON：\n'
    + '                       spec=\'{"only":["V3"]}\' / spec=\'{"lab":true}\'\n'
    + '⚠️ 试验模式会持续真实调用 API 产生花费，验完记得关。\n'
    + '面板：/api/cache-keepalive/panel'

  /**
   * `action=experiment`：跑虚拟不变量检查（`src/core/lab/*`，零花费、零网络、不写盘）。
   *
   * 返回**人读摘要**（工具返回是文本，不塞整段 JSON）：总数 / 通过 / 已知红 / 未知红 +
   * 失败项逐条（期望 vs 实际）+ 复现命令。退出码语义在 CLI 那边（`unknownRed > 0 → 1`）。
   */
  function experimentReport(args: Record<string, unknown>): string {
    const raw = typeof args.spec === 'string' ? args.spec.trim() : ''
    let spec: Record<string, unknown> = {}
    if (raw !== '') {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return 'spec 必须是 JSON 对象，例如 {"only":["V3"]} 或 {"lab":true}'
        }
        spec = parsed as Record<string, unknown>
      } catch (e) {
        return `spec 不是合法 JSON：${(e as { message?: string }).message ?? String(e)}`
          + '（示例：{"only":["V3"]}）'
      }
    }
    const only = Array.isArray(spec.only)
      ? spec.only.filter((x): x is string => typeof x === 'string' && x !== '').map((x) => x.toUpperCase())
      : undefined
    const lab = spec.lab === true
    const started = Date.now()
    const runs = runAll({ lab, ...(only === undefined ? {} : { only }) })
    const report = buildReport(runs, { labMode: lab, elapsedMs: Date.now() - started })

    const lines: string[] = []
    lines.push(`虚拟检查（${report.schema}｜基底 ${lab ? '试验模式秒级参数' : '常规参数'}｜零花费、不发请求）`)
    lines.push(`  ${report.total} 例：通过 ${report.pass}，失败 ${report.fail}`
      + `（已知红 ${report.knownRed} / 未知红 ${report.unknownRed}），耗时 ${report.elapsedMs}ms`)
    const bad = report.suites.filter((s) => s.fail > 0)
    if (bad.length === 0) lines.push('  全部不变量通过。')
    for (const s of bad) {
      lines.push(`  ${s.id} ${s.name}：${s.pass}/${s.total} 通过`)
      for (const f of s.failures) {
        lines.push(`    - ${f.case}${KNOWN_RED.has(f.case) ? '（已登记已知红）' : '（**未知红，需要查**）'}`)
        lines.push(`      期望：${f.expected}`)
        lines.push(`      实际：${f.actual}`)
      }
    }
    const onlyArg = only === undefined ? '' : ` --only=${only.join(',')}`
    lines.push(lab
      ? `复现：node scripts/lab/run.mjs --lab${onlyArg}`
      : `复现：node cli/keepalive.mjs --lab run${onlyArg}`)
    if (report.unknownRed > 0) lines.push('⚠️ 有未知红：CLI 退出码为 1（已知红不阻断）。')
    return lines.join('\n')
  }

  function settingsReport(): string {
    const s = state.settings
    const p = s.prices
    const r = warmOverRestart(p)
    const modelLines = Object.entries(s.pricesByModel)
      .map(([m, mp]) => `    ${m}：命中 ${mp.hit} / 未命中 ${mp.miss} / 输出 ${mp.out}`)
    const slotLines = s.tariff.slots.map((x) => `    ${x.label} ${x.from}→${x.to}  ×${x.factor}`)
    return [
      '缓存保温设置（生效值；单价单位 元/百万 token）',
      `  自动策略    ${s.autoEnabled ? '开' : '关'}   保 ${s.autoCount} 条   只保闲置 < ${s.idleLimitHours} 小时`,
      `  间隔        ${s.intervalSeconds} 秒`,
      `  熔断线      ${(s.circuitHitRate * 100).toFixed(0)}%（保温命中率低于它就判装配不一致并停保；可改 0.05~0.95）`,
      `  熔断冷却    ${s.circuitCooldownSeconds} 秒（0 = 不自动恢复）`,
      `  次数上限    ${s.maxTouches} 次（按当前单价的上限 ${maxTouchesHard(p)}）`,
      `  单会话预算  ${s.budgetPerSession} 元`,
      `  输出上限    ${s.maxTokens} token`,
      `  保温问题    ${s.prompt}`,
      `  闲置上限    ${s.idleLimitHours} 小时（门禁与自动候选共用；必须大于间隔）`,
      `  单价        命中 ${p.hit} / 未命中 ${p.miss} / 输出 ${p.out}`,
      '  模型价表    ' + (modelLines.length === 0 ? '（空，全部按基准单价）' : ''),
      ...modelLines,
      `  时段表      ${s.tariff.enabled ? '开' : '关（只按基准价计）'}   时区 ${s.tariff.timeZone}`,
      ...slotLines,
      `  节假日      ${s.tariff.holidayEnabled ? `开 ×${s.tariff.holidayFactor}` : '关'}   ${s.tariff.holidays.length} 天`,
      `  推论        w/r = ${r.toFixed(1)} —— 一次冷启动的钱够保温 ${r.toFixed(0)} 次`,
      `  试验模式    ${s.labMode ? '开（时间参数已压到秒级）' : '关'}`,
      `  测验台工具  ${s.exposeLabTools ? '已开放给 agent（cache_lab 已注册）' : '已关闭（cache_lab 未注册）'}`,
    ].join('\n')
  }

  function sessionsReport(): string {
    const now = Date.now()
    const agents = agentsOf()
    const lines: string[] = [`会话摘要（本进程内 ${agents.length} 条）`]
    for (const agent of agents) {
      const id = String(agent.session.id)
      const policy = policyOf(state, id)
      const led = ledgerOf(state, id)
      const last = led[led.length - 1]
      const act = lastActiveOf(id)
      const gate = decideWarm(gateInputFor(agent))
      const spend = spendAtCurrentPrices(led, state.settings).cost
      lines.push(`  ${shortId(id)}  mode=${policy.mode}  ${String(agent.status ?? '?')}`
        + `  花费 ${yuan(spend)}/${led.length}次`
        + (last !== undefined ? `  上次命中 ${(last.hitRate * 100).toFixed(1)}%` : '  还没保过')
        + `  活动 ${act > 0 ? Math.round((now - act) / 60000) + ' 分钟前' : '未知'}`
        + `  门禁 ${gate.ok ? '通过' : gate.code}`)
    }
    return lines.join('\n')
  }

  /**
   * 注册/注销测验台工具，使其与 `settings.exposeLabTools` 保持一致。
   *
   * ⚠️ 切换会**改变工具面** → 所有会话的前缀缓存失效一次（下一轮按未命中价重算）。
   * 这是用户显式选择，不做拦截，只记日志。
   */
  let disposeLab: (() => void) | undefined
  /** 按设置同步**两个**工具的注册状态（主工具与测验台工具各自可关）。 */
  function syncTools(): void {
    const wantMain = state.settings.exposeKeepaliveTool !== false
    if (wantMain && disposeKeepalive === undefined) {
      disposeKeepalive = registerKeepalive()
    } else if (!wantMain && disposeKeepalive !== undefined) {
      try {
        disposeKeepalive()
      } catch (error) {
        log('注销 cache_keepalive 出错：' + String(error))
      }
      disposeKeepalive = undefined
      log('主工具 cache_keepalive 已注销（面板「设置」里关掉了）')
    }
    syncLabTools()
  }
  function syncLabTools(): void {
    const want = state.settings.exposeLabTools === true
    if (want && disposeLab === undefined) {
      disposeLab = ctx.tools.register(defineTool({
        name: 'cache_lab',
        description:
          '缓存保温的**配置与实验**工具：读/改全部设置（含单价、熔断阈值）、开关试验模式（时间参数压到秒级，'
          + '几分钟跑完「自动候选→保温→命中判定→熔断→冷却恢复」整条链路）、跑虚拟不变量自检（零花费）、导出报告。'
          + 'action=settings 读设置；set-settings 改设置（用下面那些平铺字段）；lab 切试验模式；'
          + 'experiment 跑不变量自检（spec 传选项）；help 用法。⚠️ 改设置会影响全局；试验模式会持续真实调用 API 产生花费。'
          + '**只想看状态/保温/清账/时间轴 → 用 cache_keepalive**（那是日常运维工具，别在循环里反复调本工具）。'
          + '本工具可在面板「设置」页关闭（关掉即从工具面注销）。',
        parameters: {
          action: {
            type: 'string',
            enum: ['settings', 'set-settings', 'sessions', 'timeline', 'lab', 'experiment', 'help'],
            description: 'settings=读全部设置；set-settings=改设置（用下面那些平铺字段）；'
              + 'sessions=列会话摘要；timeline=某会话时间轴（需 sessionId）；'
              + 'lab=切换试验模式；experiment=跑虚拟不变量检查（零花费，用 spec 传选项）；help=用法说明',
          },
          /** 只在 `experiment` 用：自由 JSON 字符串，形如 `{"only":["V3"],"lab":false}`。 */
          spec: {
            type: 'string',
            description: 'experiment 用：JSON 字符串。`only`=只跑这些不变量（如 ["V3","V9"]）、'
              + '`lab`=用试验模式基底（秒级参数）再跑一遍。例：{"only":["V3"]}',
          },
          sessionId: { type: 'string', description: '目标会话 id（timeline 用；可只给尾号）' },
          granularity: {
            type: 'string',
            enum: ['step', 'turn', 'both'],
            description: 'timeline 用：step=每次 API 调用一项，turn=一整轮合计，both=两种都列（缺省读设置）',
          },
          labMode: { type: 'boolean', description: 'set-settings / lab：试验模式开关' },
          exposeLabTools: { type: 'boolean', description: 'set-settings：是否把本工具开放给 agent' },
          autoEnabled: { type: 'boolean', description: 'set-settings：自动策略总开关' },
          autoCount: { type: 'number', description: 'set-settings：自动保几条' },
          idleLimitHours: { type: 'number', description: 'set-settings：闲置上限（小时，门禁与自动候选共用，必须大于间隔）' },
          intervalSeconds: { type: 'number', description: 'set-settings：默认保温间隔（秒）' },
          maxTouches: { type: 'number', description: 'set-settings：最大连续保温次数' },
          budgetPerSession: { type: 'number', description: 'set-settings：单会话预算（元）' },
          maxTokens: { type: 'number', description: 'set-settings：输出上限' },
          circuitCooldownSeconds: { type: 'number', description: 'set-settings：熔断冷却（秒）' },
    circuitHitRate: { type: 'number', description: 'set-settings：熔断命中率线（0.05~0.95，默认 0.5）；命中率低于它判装配不一致并停保' },
          prompt: { type: 'string', description: 'set-settings：默认保温问题' },
          priceHit: { type: 'number', description: 'set-settings：命中单价（元/百万）' },
          priceMiss: { type: 'number', description: 'set-settings：未命中单价（元/百万）' },
          priceOut: { type: 'number', description: 'set-settings：输出单价（元/百万）' },
          tariffEnabled: { type: 'boolean', description: 'set-settings：峰谷时段表开关（打开后按倍率实时计价）' },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: String((value as { text?: string }).text ?? '') }],
        },
        async execute(args): Promise<Record<string, JsonValue>> {
          syncState()
          const action = String(args.action ?? 'settings')
          if (action === 'help') return { text: LAB_HELP }
          if (action === 'settings') return { text: settingsReport() }
          if (action === 'sessions') return { text: sessionsReport() }

          if (action === 'experiment') return { text: experimentReport(args) }

          if (action === 'lab') {
            const want = typeof args.labMode === 'boolean' ? args.labMode : !state.settings.labMode
            const out = applySettings({ labMode: want })
            if (!out.ok) return { text: out.error ?? '失败' }
            return {
              text: (out.warning === undefined ? '' : '提示：' + out.warning + '\n')
                + (state.settings.labMode
                  ? `试验模式已开启：间隔 ${state.settings.intervalSeconds}s、闲置上限 ${state.settings.idleLimitHours}h、`
                    /** 自检按**固定基准**（econ.BREAK_CIRCUIT_HIT_RATE）验，不随设置漂移；这里明说，免得用户以为自检验的是当前配置。 */
                    + `熔断线 ${(state.settings.circuitHitRate * 100).toFixed(0)}%（自检按固定基准 50% 验，不随设置漂移）、`
                    + `熔断冷却 ${state.settings.circuitCooldownSeconds}s、`
                    + `次数上限 ${state.settings.maxTouches}。⚠️ 会持续真实调用 API，用完再执行 action=lab 关闭。`
                  : '试验模式已关闭，原参数已恢复。'),
            }
          }

          if (action === 'timeline') {
            const want = String(args.sessionId ?? '')
            if (want === '') return { text: 'timeline 需要 sessionId' }
            const data = await timelineOf(want, typeof args.granularity === 'string' ? args.granularity : undefined)
            return { text: `会话 ${shortId(want)} 时间轴：\n` + JSON.stringify(data, null, 2) }
          }

          if (action !== 'set-settings') return { text: '未知 action：' + action + '\n\n' + LAB_HELP }

          const patch: Record<string, unknown> = {}
          for (const key of ['labMode', 'exposeLabTools', 'autoEnabled'] as const) {
            if (typeof args[key] === 'boolean') patch[key] = args[key]
          }
          for (const key of ['autoCount', 'idleLimitHours', 'intervalSeconds', 'maxTouches',
            'budgetPerSession', 'maxTokens', 'circuitCooldownSeconds', 'circuitHitRate'] as const) {
            if (typeof args[key] === 'number') patch[key] = args[key]
          }
          if (typeof args.prompt === 'string' && args.prompt.trim() !== '') patch.prompt = args.prompt
          const pricePatch: Partial<Prices> = {}
          if (typeof args.priceHit === 'number') pricePatch.hit = args.priceHit
          if (typeof args.priceMiss === 'number') pricePatch.miss = args.priceMiss
          if (typeof args.priceOut === 'number') pricePatch.out = args.priceOut
          if (Object.keys(pricePatch).length > 0) patch.prices = pricePatch
          // 时段表只有总开关能在这里改；时段/节假日明细在面板编辑（整份表提交）
          if (typeof args.tariffEnabled === 'boolean') {
            patch.tariff = { ...state.settings.tariff, enabled: args.tariffEnabled }
          }
          if (Object.keys(patch).length === 0) return { text: '没有要改的字段。先 action=settings 看现状。' }

          const out = applySettings(patch)
          if (!out.ok) return { text: out.error ?? '设置失败' }
          return {
            text: (out.warning === undefined ? '' : '提示：' + out.warning + '\n')
              + '已更新。当前值：\n' + settingsReport(),
          }
        },
      }))
      log('测验台工具 cache_lab 已注册（可在面板「设置」页关闭）')
      return
    }
    if (!want && disposeLab !== undefined) {
      try {
        disposeLab()
      } catch (error) {
        log('注销 cache_lab 出错：' + String(error))
      }
      disposeLab = undefined
      log('测验台工具 cache_lab 已注销（面板「设置」里关掉了「向 Agent 开放测验工具」）')
    }
  }

  // ── 面板路由（webServer 是可选能力：headless 环境没有 web 服务时自动跳过）────
  /**
   * 当前 profile 名（服务端事实）：宿主给的 `profileContext.name` 优先，取不到再退 `--profile` 参数。
   * 只用来给面板 HTML 打 `v-desktop`（前端据此固定覆盖层顶部间距，不做客户端探测）。
   */
  const profileNameOf = (): string => {
    try {
      const ctxAny = ctx as unknown as { get?: (name: string) => unknown }
      const svc = ctxAny.get?.('profileContext') as { name?: unknown } | undefined
      if (typeof svc?.name === 'string' && svc.name !== '') return svc.name
    } catch { /* 服务不存在就当拿不到 */ }
    const argv = process.argv
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === '--profile' && typeof argv[i + 1] === 'string') return argv[i + 1]
      if (argv[i].startsWith('--profile=')) return argv[i].slice('--profile='.length)
    }
    return ''
  }
  const routes = makeRoutes({
    beforeRequest: syncState,
    profile: profileNameOf(),
    snapshot,
    setPolicy: applyPolicy,
    setSettings: applySettings,
    reset: resetCircuit,
    timeline: async (id: string, granularityIn?: string) => {
      const ttl = Math.max(0, Number(state.settings.timelineCacheMinutes ?? 10)) * 60_000
      /**
       * 缓存键带上**账本戳**（条数 + 末条时刻）。
       *
       * 不带就会「新保温的那几轮永远不出现」：10 分钟缓存内的旧结果原样返回，
       * 实测连续保温最后一次 89.1% 在详情里一直看不到。
       */
      /** 再带价格指纹：改价后旧缓存里的金额是按旧价算的，TTL 内不失效就成了「改了价详情不变」。 */
      const led = ledgerOf(state, id)
      const key = id + '|' + (granularityIn ?? '') + '|' + led.length + '|' + (led[led.length - 1]?.at ?? 0) + '|' + priceFingerprint(state.settings)
      if (ttl > 0) {
        const hit = TL_CACHE.get(key)
        if (hit !== undefined && Date.now() - hit.at < ttl) return hit.val
      }
      const out = await timelineOf(id, granularityIn)
      if (ttl > 0) {
        TL_CACHE.set(key, { at: Date.now(), val: out })
        if (TL_CACHE.size > 8) {
          const oldest = TL_CACHE.keys().next().value
          if (oldest !== undefined) TL_CACHE.delete(oldest)
        }
      }
      return out as Record<string, unknown>
    },
    setPinned,
    resetCost,
    ping: async (id: string, force: boolean, via: 'panel' | 'tool' | 'cli' = 'panel') => {
      /**
       * **有活 agent 就走活的那条路，没有就离线装配。**
       *
       * 去掉「激活」之后，面板上每条会话都显示「立刻保温」—— 但这里原先只有
       * `resolveAgent(id)`（本进程内），历史会话一律「找不到会话」。
       * 实测用户点 `session-…-4a24-b41a-0877f9e83a07` 就报这个错。
       * 现在两条路都通：活会话用真 agent（前缀最准），历史会话用 `warmOffline()`。
       */
      const agent = resolveAgent(id, {})
      if (agent !== undefined) {
        /** 活会话也判一次「前缀刚被压缩/goal 改写」：这时保了是付一次全量（force 才放行）。 */
        const rw = rewriteOfFileFor(String(agent.session.id))
        if (rw !== undefined && force !== true) {
          return {
            ok: false,
            error: '前缀刚被改写（' + rw.detail + '）→ 这时保了是付一次全量。'
              + '在会话里发一条消息重建缓存后会自动恢复；确实要保就再点一次「强制保温」。',
          }
        }
        const out = await ping(agent, via)
        const e = out.entry
        if (e === undefined) return { ok: false, error: out.result }
        return {
          ok: true,
          message: `保温完成：命中率 ${(e.hitRate * 100).toFixed(1)}%，花费 ${yuan(e.cost)}，杠杆 ${(coldStartCost(e.promptTokens, entryPrices(e)) / Math.max(e.cost, 1e-12)).toFixed(1)} 倍`,
        }
      }
      /** 历史会话：**离线装配**（与 tick 的自动路径同一个实现，见 `pingOffline`）。 */
      const row = sessionIndex.cached.find((r) => r.id === id) ?? sessionIndex.cached.find((r) => r.id.endsWith(id))
      if (row === undefined) return { ok: false, error: '找不到会话 ' + id + '（磁盘上也没有它的日志）' }
      const out = await pingOffline(row, via, force)
      const e = out.entry
      if (e === undefined) return { ok: false, error: out.result }
      return {
        ok: true,
        message: `离线保温完成：命中率 ${(e.hitRate * 100).toFixed(1)}%，花费 ${yuan(e.cost)}，`
          + `杠杆 ${(coldStartCost(e.promptTokens, entryPrices(e)) / Math.max(e.cost, 1e-12)).toFixed(1)} 倍`,
      }
    },
  })
  ctx.inject(['webServer'], (httpCtx) => {
    /**
     * 把面板的**绝对地址**注入 index HTML。
     *
     * 为什么需要：桌面版渲染端页面是 `dsh-app://app/` 协议 —— client 半边里写相对路径
     * 会被解析成 `dsh-app://app/api/...`，按钮点了没反应（实测）。
     * 这里把 `http://127.0.0.1:<port>/api/cache-keepalive/panel` 以脚本形式塞进 index，
     * client 半边读 `window.__CACHE_KEEPALIVE_PANEL__` 就能开对地址。
     */
    httpCtx.effect(() => {
      const url = `http://127.0.0.1:${httpCtx.webServer.port}${PANEL_PATH}`
      const script = `<script>window.__CACHE_KEEPALIVE_PANEL__=${JSON.stringify(url)};window.__CACHE_KEEPALIVE_BUILD__=${JSON.stringify(BUILD_ID)}</script>`
      return httpCtx.webServer.tapIndex((html) => html.includes('</head>')
        ? html.replace('</head>', script + '</head>')
        : html + script)
    }, 'cache-keepalive: 注入面板绝对地址')

    httpCtx.effect(() => {
      const disposers = routes.map((route) => httpCtx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'cache-keepalive: routes')
  })

  // ── 守护 tick ───────────────────────────────────────────────────────────
/**
 * **tick 重入保护**：一拍里要 `await` 网络（保温往返 0.5~3 秒，慢的时候几十秒），
 * 超过 `tickMs`（60 秒）就会两拍并发。并发时两拍读到的账本末条是同一个 `at` →
 * `lastTouchAt` 没变 → 门禁两次都放行 → **同一条会话被重复 ping、重复花钱**。
 * 所以上一拍没结束就跳过本拍。
 */
let tickRunning = false
let tickStartedAt = 0

  ctx.setInterval(() => {
    if (tickRunning) {
      const secs = tickStartedAt > 0 ? Math.round((Date.now() - tickStartedAt) / 1000) : 0
      log(`⏭ 上一拍未结束（已跑 ${secs}s），跳过本拍`)
      return
    }
    tickRunning = true
    tickStartedAt = Date.now()
    /** 同步段也要兜异常：这里抛错会让 tickRunning 永久为 true → tick 永久停摆。 */
    try {
    syncState()
    /** **到期自愈**：试验模式到点自动退出并按 `labBackup` 还原（每拍查一次，防「忘了关」）。 */
    const expired = labExpireIfDue(state)
    if (expired !== undefined) {
      log(expired.message)
      if (expired.restored) saveState(state)
    }
    tickCount += 1
    lastTickAt = Date.now()
    } catch (e) {
      tickRunning = false
      log('tick 同步段异常：' + String(e))
      return
    }
    void (async () => {
      const now = Date.now()
      const agents = agentsOf()
      // 每 tick 刷新运行时快照：独立 CLI / 无实例面板靠它知道「谁在跑、标题叫什么」
      writeRuntime(agents)
      /**
       * **索引保证**：首拍 `sessionIndex.cached` 还是空的（没人请求过面板）→ 候选池里只有活会话。
       * 这里同步等一次（内部有 60 秒 TTL + 单飞，之后都是 O(1)）；扫到之后顺手把元数据写给 CLI
       * （`sessions.meta.json`），CLI 就不用自己扫盘了。
       */
      /**
       * **索引保证 + 定期刷新**：首拍 `sessionIndex.cached` 还是空的（没人请求过面板）→ 候选池里
       * 只有活会话；另外不主动刷的话，磁盘部分只在「启动 + 面板 /state」时更新，
       * **用户从不打开面板时，启动后新增的会话永远进不了池**。
       *
       * 所以：空 或 距上次扫描超过 `INDEX_REFRESH_MS` → 同步等一次（冷扫 1.7 秒 / 412 条，
       * 5 分钟一次可接受）；其余拍 `void` 让它在后台跑（内部 60 秒 TTL + 单飞）。
       */
      if (sessionIndex.cached.length === 0 || now - sessionIndex.lastScanAt > INDEX_REFRESH_MS) {
        /** force：`list()` 自带 60 秒 TTL，不强制的话到点也不会重扫（实测就栽在这）。 */
        await sessionIndex.list(true)
      } else {
        void sessionIndex.list()
      }
      /**
       * 写 meta 时把「最后对话时间」一起写：CLI 读这个字段就不必自己解帧（每次省 ~6ms/条）。
       *
       * **解帧只在必要时**：`writeSessionMetaIfChanged` 内部会先比 `(mtime,size)`，
       * 没变且旧条目已有 `lastDialogAt` 就直接复用 —— 稳态下这个回调**一次都不调**。
       * （之前是调用方无脑 `map` 全量解帧：每拍 459 条 ≈ 580ms，与 `/state` 首次请求抢 IO。）
       */
      writeSessionMetaIfChanged(
        dshHome,
        sessionIndex.cached,
        now,
        (r) => readLastDialogAt(r.logFile),
        (r) => readProjectionTitle(dshHome, r.id),
      )
      // 先更新活动时间，再算候选（刚才 running 的会话应立刻算作"刚活动"）
      for (const agent of agents) {
        if (agent.status === 'running') lastActiveAt.set(String(agent.session.id), now)
      }
      /**
       * 候选池 = 活会话 ∪ 磁盘全会话（见 candidateRows）。扩池后 `picked` 里可能有**非本进程**会话，
       * 它们走离线装配 —— 这里不按 `agentsOf()` 遍历，改成按 id 集合遍历 + 按 live 分派。
       */
      const rows = candidateRows(now, agents)
      const picked = pickedIds(decideCandidates(state, rows, now, autoSettings()))
      const liveMap = new Map<string, AgentLike>()
      for (const agent of agents) liveMap.set(String(agent.session.id), agent)
      /** 待处理 = 自动候选 ∪ `mode=on`（手动强制开的不占自动名额，但每拍都要过门禁）。 */
      const targets = new Set<string>(picked)
      for (const row of rows) {
        if (policyOf(state, row.id).mode === 'on') {
          /**
           * ⚠️ **子代理必须在强制路径上也滤一遍**（B8）。
           *
           * 库 `candidates.ts` 的判定顺序是 `manual` 早于 `subagent`，而且 `mode='on'` 的会话
           * 根本走不到 `pickAutoCandidates` —— 这里直接吃 `policyOf().mode==='on'`，
           * 是**库外的一条独立路径**。少了这道过滤，「子代理也算」关着的时候，
           * 被手动设成强制开的子代理照样每拍过门禁（CLI 侧 `keepalive.mjs:1386` 早就有这份实现）。
           *
           * 反过来也**不能滤过头**（B9）：开关打开时手动强制照常生效。
           */
          /**
           * 子代理过滤：**双条件** —— 旧的「子代理也算」总开关关着、且新的「子代理条数」没填（≤0）才跳过。
           * 只认总开关的话，用户在「子代理条数」里填了 2 仍会被这道过滤拦死（S1）。
           */
          if (row.origin === 'subagent' && state.settings.autoAllowSubagent !== true
            && (state.settings.autoCountSubagent ?? 0) <= 0) continue
          targets.add(row.id)
        }
      }

      for (const id of targets) {
        const policy = policyOf(state, id)
        if (policy.mode === 'off') continue
        // 前缀已变且还没被真实使用：10 分钟后再看，别每个 tick 空跑一次装配
        const heldPrefix = prefixStale.get(id)
        if (heldPrefix !== undefined && heldPrefix.nextTryAt > now) continue
        const agent = liveMap.get(id)
        /**
         * 改写判定（要解压日志）**只对自动候选做**：`mode=on` 的非活会话可能有几十条，
         * 全量解压会让一拍超过 2 秒。活会话沿用 `gateInputFor()`（它本来就这么判）。
         */
        const gate = decideWarm(agent !== undefined ? gateInputFor(agent) : gateInputForIdle(id, picked.has(id)))
        if (!gate.ok) {
          // running / too-soon / cold-window 都很常见，不刷日志
          if (gate.code !== 'running' && gate.code !== 'too-soon' && gate.code !== 'cold-window') {
            log(`跳过 ${shortId(id)}（${gate.code}）：${gate.detail}`)
          }
          continue
        }
        let out: { entry?: LedgerEntry; result: string; fatal?: boolean }
        if (agent !== undefined) {
          out = await ping(agent, 'auto')
        } else {
          const row = sessionIndex.cached.find((r) => r.id === id)
          if (row === undefined) {
            /** 日志被删/索引与磁盘不同步 → 退避，别每拍来一遍。 */
            offlineRetryAt.set(id, now + OFFLINE_RETRY_FATAL_MS)
            log(`会话 ${shortId(id)} 在磁盘上找不到日志，30 分钟内不再尝试`)
            continue
          }
          out = await pingOffline(row, 'auto')
          /** **失败也要退避**：不记账 → lastTouchAt 不变 → 门禁每拍都放行 → 坏会话无限重试、白占名额。 */
          if (out.entry === undefined) {
            offlineRetryAt.set(id, now + (out.fatal === true ? OFFLINE_RETRY_FATAL_MS : OFFLINE_RETRY_MS))
          } else {
            offlineRetryAt.delete(id)
          }
        }
        if (out.entry !== undefined) {
          log(`保温 ${shortId(id)} via=auto${agent === undefined ? '（离线）' : ''} 命中率=${(out.entry.hitRate * 100).toFixed(1)}%` +
            ` 花费=${yuan(out.entry.cost)} 第${out.entry.touch}次 间隔=${out.entry.gapSeconds}s`)
          if (out.entry.hitRate < state.settings.circuitHitRate) log(`⚠️ 会话 ${shortId(id)} 命中率塌了（低于熔断线 ${(state.settings.circuitHitRate * 100).toFixed(0)}%），熔断`)
        } else {
          log(`会话 ${shortId(id)} 保温失败：${out.result}`)
        }
      }
    })().catch((e) => log('tick error: ' + String(e))).finally(() => { tickRunning = false })
  }, tickMs)

  // 测验台工具按设置的初始状态注册（关闭时连注册都不做，工具面里就没有它）
  syncTools()

  log(`启动：tick=${tickMs}ms state=${stateFile} 自动候选=${state.settings.autoEnabled ? '开' : '关'}` +
    ` 保${state.settings.autoCount}条/闲置<${state.settings.idleLimitHours}h  面板=${PANEL_PATH}`)
}

export { breakEvenProbability, expectedNet, maxTouchesHard, ledgerOf }

/** 供自检脚本使用。 */
export { decideWarm } from './gate.ts'
export { pickAutoCandidates, autoCandidateIds } from './auto.ts'
/** 时间轴结果缓存（`id|粒度` → {at, val}），TTL 由设置里的 timelineCacheMinutes 控制。 */
const TL_CACHE = new Map<string, { at: number; val: unknown }>()

export const PANEL_ROUTE = PANEL_PATH
export const STATE_FILE = statePath()





