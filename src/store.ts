/**
 * 每会话策略、全局配置与账本（sidecar 持久化）。
 *
 * 绝不写进会话日志 —— 写进去会污染 surface、甚至触发压缩。
 * 存到 `$DSH_HOME/cache-keepalive/state.json`。
 */
import {
  closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  DEFAULT_PRICES, DEFAULT_TARIFF, normalizePriceTable, normalizePrices, normalizeTariff, recomputeCost,
  type PriceTable, type Prices, type RecomputeSettings, type Tariff,
} from './econ.ts'
import { modelChangedOf } from './core/model-switch.ts'

/** 单会话策略。`mode` 是手动三态，`auto` 表示交给自动候选筛选决定。 */
export interface SessionPolicy {
  /** 手动三态：on=强制保温，off=强制不保温，auto=按自动候选。 */
  mode: 'on' | 'off' | 'auto'
  /** 每会话自定义的保温问题（空则用全局默认）。 */
  prompt?: string
  /** 每会话输出上限（默认 1）。 */
  maxTokens?: number
  /** 间隔秒（默认取全局）。 */
  intervalSeconds?: number
  /** 最大保温次数（默认取全局）。 */
  maxTouches?: number
  /**
   * **已废弃**：旧版「间隔自适应」写回的目标值。自适应功能已删，新数据不会再写这个字段；
   * 保留仅为了老 `state.json` 里的历史键不报错（读取处已全部忽略）。
   */
  adaptedSeconds?: number
  /** 备注，方便辨认。 */
  note?: string
  /** 手动操作时间戳。 */
  updatedAt?: number
}

/**
 * 全局配置（面板上可直接改）。
 *
 * `autoCount` / `idleLimitHours` 就是"自动候选"的两个旋钮：
 * 按最后活动时间从近到远排序，只取 **闲置不超过 `idleLimitHours`** 的前 **K 条** 保温。
 */
export interface Settings {
  /** 自动策略总开关；关掉后只有手动 mode=on 的会话会被保温。 */
  autoEnabled: boolean
  /** 自动保几条（按最近活动排序）。 */
  autoCount: number
  /**
   * **子代理独立名额**（0 = 不保子代理，默认）。
   *
   * 与 `autoCount` 是两个池、互不占位：普通会话占 `autoCount`，子代理占这个名额。
   * 只有 `autoAllowSubagent === true`（总开关）且本值 > 0 时才真的保子代理。
   */
  autoCountSubagent: number
  /**
   * 是否把**子代理会话**也纳入自动候选。默认 false。
   * 见 `auto.AutoSettings.allowSubagent` 的取舍说明。
   */
  autoAllowSubagent: boolean
  /** 默认保温间隔（秒）。 */
  intervalSeconds: number
  /**
   * **子代理专用保温间隔（秒）**，默认 120。
   *
   * 为什么单独一条：子代理寿命只有 1~50 分钟（30 个样本：59s/86s/127s/314s/…/2910s），
   * 而主间隔默认 4 小时 —— 子代理**等不到第一个门禁窗口就已经结束**了（实测 40 条子代理进候选 4 条，
   * 其中 3 条判 `too-soon`，对话距今才 1.2~2.2 分钟）。所以子代理要走一条短间隔，
   * 且不吃「网页版晚 2 分钟」那层 `delayMs`（见 `gate.ts` 的 `isSubagent`）。
   */
  subagentIntervalSeconds: number
  /** **本周期**最多保温多少次（清账后重数）。 */
  maxTouches: number
  /**
   * **累计**最多保温多少次（跨周期，`0` = 不限）。
   *
   * 两个都要：「本周期」让用户清账后能重新开始；「累计」是清账也绕不过去的总闸。
   */
  maxTouchesTotal: number
  /** 单会话累计花费上限（元）。 */
  budgetPerSession: number
  /** 默认保温问题。 */
  prompt: string
  /** 默认输出上限。 */
  maxTokens: number
  /**
   * **闲置上限（小时）**：门禁与自动候选**共用这一份**判定。
   *
   * 距最后活动（或最后保温）超过它就判定「凉了」：门禁不保（`cold-window-idle` / `stale`），
   * 自动候选也不纳入。**必须大于 `intervalSeconds`**，否则永远保不上。
   */
  idleLimitHours: number
  /**
   * **按 `provider/model` 覆盖时间门槛**。键格式 `provider/model`
   * （如 `tokenrhythm-title/deepseek-v4.1-flash-1017`）。
   *
   * 优先级（`effectiveLimitsOf()` 是唯一判定点）：
   * ```
   * 模型设了值 → 用模型的
   * 模型留空   → 用通用的 idleLimitHours / intervalSeconds
   * 模型填 0   → 该模型不保温（完全跳过）
   * ```
   * **字段缺省 = 继承通用**，所以只设一个字段也合法。
   */
  modelOverrides?: Record<string, { idleLimitHours?: number; intervalSeconds?: number }>
  /**
   * **「刚保过」窗口（秒）**：距上次保温小于它，门禁报 `fresh`（面板显示「已保温」）。
   *
   * 默认 300（5 分钟）；试验模式压到 5 秒。`0` = 关掉这个状态（永不 `fresh`）。
   */
  freshSeconds: number
  /**
   * **单价（元 / 百万 token），可自主设置。**
   *
   * 换模型、切高峰/空闲档、官方调价时改这里即可 ——
   * `w/r`（一次冷启动 = 多少次保温）、次数上限、盈亏平衡概率、每次花费全都会跟着变，
   * 不需要改代码。默认值见 `econ.DEFAULT_PRICES`。
   */
  prices: Prices
  /**
   * 模型价表：键是模型名（小写），值是该模型的单价。
   *
   * 会话日志里每一条 `assistant/message` 都带 `message.source.model`，
   * 所以时间轴能**按轮次识别模型**分别计价；表里查不到的模型回落 `prices`。
   */
  pricesByModel: PriceTable
  /**
   * 峰谷时段表 + 节假日表。基准价对应倍率 1，命中时段就乘上该时段的 `factor`。
   * 总开关关掉时价格恒为基准价，时段表只作参考。
   */
  tariff: Tariff
  /** 会话列表显示哪些列（列 id → 是否显示）。缺省项按代码里的默认值。 */
  columns: Record<string, boolean>
  /**
   * **熔断命中率线**：一次保温的命中率低于它就判「装配与真实请求不一致」→ 熔断停保。
   * 默认 0.5（与 `econ.BREAK_CIRCUIT_HIT_RATE` 同值，零行为变化）；硬夹 [0.05, 0.95]。
   *
   * 为什么上限是 0.95：正常保温实测 99.5%+、劣化的 7%~28%，两端离得很远；
   * 2026-10-20 用户要求开 8 档（30~95），上限从 0.9 放宽到 0.95；再高会把正常波动也判熔断（见 `.tmp/inv-a.md` §3.5）。
   */
  circuitHitRate: number
  circuitCooldownSeconds: number
  /**
   * 试验模式：一键把全部时间参数压到秒级，用于快速验证全链路
   * （自动候选 → 保温 → 命中判定 → 熔断 → 冷却恢复）。
   *
   * 打开后覆盖：`intervalSeconds=30`、`freshSeconds=5`、`circuitCooldownSeconds=60`、
   * `maxTouches=99`（`idleLimitHours` 不动 —— `core/settings.ts` 的 `labBackup` 不备份它，
   * 压低了退出试验模式后收不回来；`freshSeconds` 已进 `labBackup`）。
   *
   * ⚠️ **仅用于测试**：它会持续真实调用 API 产生花费，验完请关掉。
   */
  labMode: boolean
  /**
   * **试验模式到期时刻**（毫秒时间戳；`0` = 不过期）。
   *
   * 进试验模式时自动设 `now + 2 小时`。插件 tick 与 CLI 守护循环每拍检查，
   * 到点自动退出并按 `labBackup` 还原参数 —— 防「忘了关 → 30 秒间隔持续烧钱」。
   */
  labExpiresAt: number
  /** 本轮试验的**起始时刻**（毫秒；`0` = 没有进行中的试验）。`labSpendOf()` 用它算本轮花费。 */
  labStartedAt: number
  /** **本轮试验总花费上限（元）**：跨会话合计，独立于 `budgetPerSession`。默认 0.5。 */
  labBudgetPerRun: number
  /**
   * **试验白名单会话 id**。空 = 不允许任何会话（试验模式默认拒绝一切保温）。
   *
   * 这是护栏的主体：试验模式下只有名单内的会话能发请求，防止顺手把真实会话保一批。
   */
  labSessionAllow: string[]
  /**
   * 是否把**测验台工具**（`cache_lab`）开放给 agent。
   *
   * 开 = 注册 `cache_lab`（试验模式开关 / 时间轴 / 设置读写 / 会话列表）；
   * 关 = 从工具面**注销**它（agent 看不到、调用不了）。
   *
   * ⚠️ 切换它会改变工具面，**导致所有会话的前缀缓存失效一次**（下一轮按未命中价重算）。
   * 要开关就一次决定好，别频繁切。
   */
  exposeLabTools: boolean
  /** 是否把主工具 `cache_keepalive` 开放给 agent（默认 true）。 */
  exposeKeepaliveTool: boolean
  /** 门禁状态词覆盖：key → 文本（key 见 `core/gate-texts.ts`）；没写的用默认。 */
  gateText: Record<string, string>
  /** 门禁说明模板覆盖：key → 模板（可用 `{名字}` 占位符）；没写的用默认。 */
  gateDetail: Record<string, string>
  /** 候选理由文案覆盖：key → 文本（key 见面板 CAND_WHY / 候选多选那 10 项）；没写的用默认。 */
  candText: Record<string, string>
  /** 用户拖过的列宽（列 id → px）；没拖过的列按默认比例自适应。插件版用这一份。 */
  colWidths: Record<string, number>
  /** CLI 网页版（`panel-service`）自己的一份列宽 —— 两个面板容器宽不同，共用会把对方拖乱。 */
  colWidthsCli: Record<string, number>
  /** 「门禁文案」里状态词输入框的宽度（px），可拖两栏之间的分隔线调整。 */
  gateWordWidth: number
  /**
   * 详情（时间轴）结果缓存多少分钟。
   * 时间轴要解压整份会话日志（几 MB、几秒），同一条反复点很浪费；0 = 不缓存。
   */
  timelineCacheMinutes: number
}

export const DEFAULT_SETTINGS: Settings = {
  autoEnabled: true,
  autoCount: 2,
  autoCountSubagent: 0,
  autoAllowSubagent: false,
  intervalSeconds: 4 * 3600,
  subagentIntervalSeconds: 120,
  maxTouches: 9,
  maxTouchesTotal: 0,
  budgetPerSession: 0.5,
  prompt: 'Reply with exactly: OK',
  maxTokens: 1,
  idleLimitHours: 6,
  freshSeconds: 5 * 60,
  circuitCooldownSeconds: 0,
  circuitHitRate: 0.5,
  labMode: false,
  labExpiresAt: 0,
  labStartedAt: 0,
  labBudgetPerRun: 0.5,
  labSessionAllow: [],
  exposeLabTools: true,
  exposeKeepaliveTool: true,
  prices: DEFAULT_PRICES,
  /** 默认给一条 DSH 官方模型（`deepseek-flash`），用户可再加。 */
  pricesByModel: { 'deepseek-flash': { ...DEFAULT_PRICES } },
  tariff: DEFAULT_TARIFF,
  /** 列表「花费」列显示什么：本周期花费，或全部保温次数。 */
  costScope: 'cycle',
  columns: {},
  cellGap: 8,
  gateText: {},
  gateDetail: {},
  candText: {},
  colWidthsCli: {},
  colWidths: {},
  gateWordWidth: 170,
  timelineCacheMinutes: 10,
}

/** 试验模式一键覆盖的时间参数（见 `Settings.labMode`）。 */
export const LAB_OVERRIDES = {
  intervalSeconds: 30,
  freshSeconds: 5,
  circuitCooldownSeconds: 60,
  maxTouches: 99,
} as const

/** 一次保温的记录。 */
export interface LedgerEntry {
  at: number
  /** 距上次保温或上次真实活动的间隔（秒）。 */
  gapSeconds: number
  promptTokens: number
  hitTokens: number
  missTokens: number
  outputTokens: number
  cost: number
  hitRate: number
  ms: number
  /** 续了几次。 */
  touch: number
  /** 触发方式（`panel`=面板按钮、`tool`=agent 工具、`cli`=独立 CLI、`manual`=旧账未分源）。 */
  via?: 'auto' | 'manual' | 'panel' | 'tool' | 'cli'
  /**
   * 这一条是不是**离线装配**保的（非本进程会话走 `assembleSession` + `warmOffline`）。
   * 面板据此把「自动」显示成「自动·离线」—— 两种路径的失败模式不同，排障时要能一眼分开。
   */
  offline?: boolean
  /**
   * 本次**新建**缓存的 token 数（Anthropic 叫 `cache_creation_input_tokens`）。
   *
   * 为什么必须记：区分两种低命中 ——
   *  - 本次全 miss 但**新建了大量缓存** = 缓存被回收，这次已把前缀重新写进去 → 下一轮必命中，**不该熔断**；
   *  - 全 miss 且**没有新建** = 我们发的和缓存根本对不上（装配偏差）→ 直接熔断。
   * 实测 345 个相邻保温对里，这种「低→下一次恢复」有 10 次（含 0.5%→100%）。
   */
  cacheWriteTokens?: number
  /** 提供方没报缓存命中数 → 命中率未知。这类记录**不参与熔断**。 */
  cacheUnknown?: boolean
  /**
   * 本次保温时的前缀指纹（system + tools + 消息条数 + 前两条消息的哈希）。
   * 下一次保温前会与它比对 —— 变了就说明缓存锚点被改写过，保了也是 0 命中，直接跳过不花钱。
   */
  fingerprint?: string
  /**
   * **改写指纹**（`core/rewrite.ts` 的 `rewriteFpOf`）：`无改写` → 空串，否则 `kind:sub:seq`。
   *
   * 与上面的 `fingerprint`（tools+messages 的**内容哈希**）是两个独立维度：
   * 那个答「装配出的前缀和上次一样吗」，这个答「日志里发生过的改写和上次保温时是同一个吗」。
   */
  rewriteFp?: string
  /** 这次保温用的是哪个模型（会话路由的 model）。 */
  model?: string
  /** 计价用的价倍率（时段表命中时 ≠ 1）；没记录按 1 处理。 */
  factor?: number
  /** 倍率来自哪个时段（展示用）。 */
  factorLabel?: string
  /** 所属**保温周期**（从 1 开始；熔断或手动清除计费时 +1）。 */
  cycle?: number
}

export interface State {
  version: 1
  settings: Settings
  sessions: Record<string, SessionPolicy>
  ledger: Record<string, LedgerEntry[]>
  /**
   * 试验模式的「原始参数备份」。
   *
   * 进入试验模式时把被覆盖的几项存这里、退出时原样恢复 ——
   * 这样 `settings` 本身始终是**生效值**，全代码 20 多处读取点无需感知试验模式。
   */
  labBackup?: Partial<Settings>
  /**
   * 面板里手动置顶的会话 id —— **本插件自己的一份**，与 DSH workspace 的置顶互不干扰。
   * 面板把这些行排在最上，方便一眼找到常保的那几条。
   */
  pinnedSessions?: string[]
  /**
   * **已见过的改写指纹**（`id → kind:sub:seq`），只用于「别再重复提示/记录」。
   *
   * ⚠️ **不是判定基准**：判定基准是**上一条账本**的 `rewriteFp`。往这里写不会解除保护，
   * 只有成功保温落账（写入新 `rewriteFp`）才会。
   */
  rewriteSeen?: Record<string, string>
  /**
   * 每会话当前的保温周期号（缺省 1）。
   *
   * 账本**永远不清**（总花费要保留历史总和）；换周期只改这个号，
   * 新记的条目带上新号，统计时按号分组即可。
   */
  cycles?: Record<string, number>
  /**
   * 清账时的「保温次数基准」：本周期连续保温次数 = 最后一条账本的 touch − 这个基准。
   * 只加这一张表，账本本身不动（历史保留）。
   */
  touchBase?: Record<string, number>
  /**
   * **解熔标记**：会话 id → 解熔时刻（毫秒）。见 `untripSession()`。
   *
   * 解熔**不再删账本**（`clearLedger` 曾把历史连同花费一起抹掉），只在这里记一笔；
   * `tripVerdict` 见到「末条 at <= 解熔时刻」就视同 100% 命中放行。
   * 新保温落账后末条 at 更大 → 标记自动失效，语义自然，不需要谁去清。
   */
  untripped?: Record<string, number>
  /**
   * **试验模式的在途账（G10）**：每笔请求发出去前写一条，拿到 usage 后删掉；
   * 拿不到 usage（钱可能已花）就改成 `unknown` 并**按 worst 计入本周期花费**，否则预算会漏算。
   *
   * 只在 `labMode === true` 时写入；非试验模式恒为空 → 对生产零影响。
   * 按 `at >= settings.labStartedAt` 过滤，天然按试验轮次隔离（换轮后旧的自动不计）。
   */
  labPending?: { id: string; sessionId: string; worst: number; at: number; status: 'inflight' | 'unknown' }[]
  /**
   * **跨进程「正在保温」标记**：会话 id → { at, by }。
   *
   * 为什么必须落盘：插件（tick / 面板 / 工具）与独立 CLI 是两个进程，各自持有一份内存 state，
   * 光有内存锁挡不住「同一时刻两个入口各发一次」—— 实测同一会话 7~16 秒内被保两次，
   * 第二次命中 2~4%（漏 47~79 万 token ≈ 50 次正常保温的钱）。
   * 过期时间见 `INFLIGHT_TTL_MS`；处理见 `tryClaimInflight` / `releaseInflight`。
   */
  inflight?: Record<string, InflightMark>
}

/** 每会话账本最多保留多少条。 */
const LEDGER_CAP = 200

/** 一条「正在保温」标记。 */
export interface InflightMark {
  /** 抢占时刻（毫秒）。 */
  at: number
  /** 谁抢的：`cli` = CLI 守护循环/命令行，`panel` = 面板点击，`tool` = agent 工具，`auto` = tick。 */
  by: string
}

/**
 * 在途标记多久算过期（毫秒）。
 *
 * **60 秒**的依据：实测最慢的一次保温 `ms=29569`（约 30 秒），60 秒给 2 倍余量。
 * 太短 → 正常慢请求被误判过期，第二个入口闯进来（互斥失效）；
 * 太长 → 进程被强杀后残留标记会长时间堵住这条会话（用户点「保温」没反应）。
 */
export const INFLIGHT_TTL_MS = 60_000

/**
 * 本进程**最后一次**动过某会话在途标记的时刻（claim / release 都记）。
 *
 * 用途：`mergeForeign` 写盘时会把磁盘上的标记并回来 —— 磁盘那份可能正是本进程上一次写的旧快照，
 * 把刚 `releaseInflight()` 掉的标记搬回来就等于没释放（实测会永久堵住）。判据用**时刻**而不是
 * 「碰过没有」：磁盘标记比自己最后一次操作还新 ⇒ 那是别人写的，必须并回；更旧 ⇒ 是自己写剩的，跳过。
 */
const LAST_TOUCH = new Map<string, number>()

function markHolding(id: string): void {
  LAST_TOUCH.set(id, Date.now())
}

/**
 * 抢「正在保温」标记。**必须在 `withStateLock` 的临界区内、且用锁内重新 `loadState()` 的
 * 那份 state 调用** —— 用锁外的旧快照判等于没判（两个进程都读到「无标记」就都放行）。
 *
 * @returns true = 抢到（可以发请求）；false = 别人正在保且未过期（本次跳过、不花钱）
 */
export function tryClaimInflight(state: State, id: string, by: string, now = Date.now()): boolean {
  if (state.inflight === undefined) state.inflight = {}
  const cur = state.inflight[id]
  if (cur !== undefined && now - cur.at < INFLIGHT_TTL_MS) return false
  state.inflight[id] = { at: now, by }
  markHolding(id)
  return true
}

/**
 * 释放在途标记。**记账后 / 失败后 / 抛错后都要调**（调用方用 `try/finally`），
 * 否则这条会话会被堵到 `INFLIGHT_TTL_MS` 过期为止。
 */
export function releaseInflight(state: State, id: string): void {
  /** 先记 HOLDING 再删：否则紧接着那次 `saveState` 会把磁盘上的旧标记搬回来（= 根本没释放）。 */
  markHolding(id)
  if (state.inflight === undefined) return
  delete state.inflight[id]
}

/** 清掉过期标记（写盘时顺手做，避免 state.json 越攒越大）。返回清掉几个。 */
export function sweepInflight(state: State, now = Date.now()): number {
  if (state.inflight === undefined) return 0
  let n = 0
  for (const [id, m] of Object.entries(state.inflight)) {
    if (now - m.at >= INFLIGHT_TTL_MS) { delete state.inflight[id]; n += 1 }
  }
  return n
}

export function statePath(): string {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'cache-keepalive', 'state.json')
}

/**
 * `state.json` 的**版本标记**（`mtime:字节数`）。
 *
 * 用途：插件进程内存里持有一份 `state`，独立 CLI 是另一个进程。谁写盘谁改文件，
 * 靠这个标记判断「内存那份是不是已经落后于磁盘」——相等即无需重读。
 *
 * ⚠️ 必须是**字符串拼接**，不能 `mtimeMs + size / 1e6`：那个量级双精度 ULP 约 4e-4，
 * 折算成字节约 ±400 —— 同一毫秒内两次写盘、大小差几百字节时会被误判成「没变」。
 */
export function stateMtimeOf(file = statePath()): string {
  try {
    const st = statSync(file)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return '0:0'
  }
}

/** 只收 string → string 的表；其余丢掉（脏值会把面板打出 undefined）。 */
function textMap(v: unknown): Record<string, string> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val
  }
  return out
}

/** 只收正数表（列宽 px）；0 / 负数 / NaN 一律丢掉。 */
function numMap(v: unknown): Record<string, number> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, number> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) out[k] = Math.round(val)
  }
  return out
}

/**
 * 归一化 settings：补默认 → **丢弃已废弃的老字段** → 校验 `idleLimitHours` / `freshSeconds`。
 *
 * 老 `state.json` 里还留着 `warmWindowSeconds` / `staleSeconds` / `autoMaxIdleHours`：直接丢弃，不迁移
 * （前两者的语义已被 `idleLimitHours` 一条合并；`autoMaxIdleHours` 已无消费者，自动候选读同一个 `idleLimitHours`）。
 * 留着只会被再次写回磁盘误导下次。
 */
export function normalizeSettings(raw: unknown): Settings {
  const src = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const merged = { ...DEFAULT_SETTINGS, ...src } as Settings & Record<string, unknown>
  delete merged.warmWindowSeconds
  delete merged.staleSeconds
  delete merged.autoMaxIdleHours
  /** 已删除的死设置：不清理的话老 state.json 会永远留着这个键（saveState 会原样写回）。 */
  delete merged.tlGranularity
  delete merged.autoAdapt
  delete merged.keepWarmAfterTrip
  delete merged.cycleResetOnTrip
  delete merged.panelOpenMode
  /** 合并时间门槛后删掉的设置项（用户拍板：「同一个 since 不该两套阈值」）。 */
  delete merged.refreshLimitHours
  /** 「缓存到期」与「闲置上限」是同一个概念，已合并 ⇒ 删字段，时间轴到期线改用 idleLimitHours。 */
  delete merged.cacheTtlSeconds
  /**
   * **`modelOverrides` 归一化**：只保留 `idleLimitHours` / `intervalSeconds` 两个数值字段。
   * 0 有意义（= 该模型不保温），**不能当脏值丢掉**；负数和非数字丢掉（= 继承通用）。
   */
  const ovRaw = src.modelOverrides
  if (ovRaw !== null && typeof ovRaw === 'object' && !Array.isArray(ovRaw)) {
    const ov: Record<string, { idleLimitHours?: number; intervalSeconds?: number }> = {}
    for (const [key, val] of Object.entries(ovRaw as Record<string, unknown>)) {
      if (val === null || typeof val !== 'object' || Array.isArray(val)) continue
      const v = val as Record<string, unknown>
      const e: { idleLimitHours?: number; intervalSeconds?: number } = {}
      for (const f of ['idleLimitHours', 'intervalSeconds'] as const) {
        const n = v[f]
        if (typeof n === 'number' && Number.isFinite(n) && n >= 0) e[f] = n
      }
      ov[key] = e
    }
    merged.modelOverrides = ov
  } else {
    delete merged.modelOverrides
  }
  const idle = Number(src.idleLimitHours)
  merged.idleLimitHours = Number.isFinite(idle) && idle > 0 ? idle : DEFAULT_SETTINGS.idleLimitHours
  /**
   * **先判类型再夹取**：`Number(true)` = 1、`Number(null)` = 0 会把脏值「强转」成合法值（实测 true→上限最严、null→0.05 最松），
   * 必须 `typeof v === 'number' && Number.isFinite(v)` 才认。非数字一律回落默认 0.5；负数/0 **落到下界 0.05**（不是回落默认）。
   */
  const thrRaw = src.circuitHitRate
  merged.circuitHitRate = typeof thrRaw === 'number' && Number.isFinite(thrRaw)
    ? Math.min(0.95, Math.max(0.05, thrRaw))
    : DEFAULT_SETTINGS.circuitHitRate
  /** 「刚保过」窗口：负值/非数字回落默认；`0` 是合法值（= 关掉 fresh）。 */
  const fresh = Number(src.freshSeconds)
  merged.freshSeconds = Number.isFinite(fresh) && fresh >= 0 ? fresh : DEFAULT_SETTINGS.freshSeconds
  /**
   * 子代理间隔：必须是**正数**（0/负数 = 永不等门禁窗口或恒负，两者都是坏值）→ 回落默认 120。
   * 先判类型再夹取，理由同 `circuitHitRate`（`Number(true)` = 1 会把脏值强转成「1 秒」）。
   */
  const subIv = src.subagentIntervalSeconds
  merged.subagentIntervalSeconds = typeof subIv === 'number' && Number.isFinite(subIv) && subIv > 0
    ? Math.max(1, subIv)
    : DEFAULT_SETTINGS.subagentIntervalSeconds
  // 价格单独归一化 —— 它是唯一参与「除法」的用户输入，脏值（0 / 负数 / NaN）必须挡掉。
  merged.prices = normalizePrices(src.prices)
  merged.pricesByModel = normalizePriceTable(src.pricesByModel)
  merged.tariff = normalizeTariff(src.tariff)
  merged.gateText = textMap(src.gateText)
  merged.gateDetail = textMap(src.gateDetail)
  merged.candText = textMap(src.candText)
  merged.colWidthsCli = numMap(src.colWidthsCli)
  merged.colWidths = numMap(src.colWidths)
  /** 试验模式四键：时间戳/金额必须是非负有限数，白名单只收非空字符串。 */
  const stamp = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  merged.labExpiresAt = stamp(src.labExpiresAt)
  merged.labStartedAt = stamp(src.labStartedAt)
  const perRun = Number(src.labBudgetPerRun)
  merged.labBudgetPerRun = Number.isFinite(perRun) && perRun >= 0 ? perRun : DEFAULT_SETTINGS.labBudgetPerRun
  merged.labSessionAllow = Array.isArray(src.labSessionAllow)
    ? (src.labSessionAllow as unknown[]).filter((x): x is string => typeof x === 'string' && x !== '')
    : []
  return merged
}

export function loadState(file = statePath()): State {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<State>
    return {
      version: 1,
      settings: normalizeSettings(raw.settings),
      sessions: raw.sessions ?? {},
      ledger: raw.ledger ?? {},
      /**
       * ⚠️ **必须解析 `labBackup`**：试验模式进入时把被覆盖的几项存这里、退出时恢复。
       * 早先漏了这一行 → 开试验模式 → 重启 → 关掉试验模式时拿不到备份，
       * 参数**停在 30 秒间隔 / 99 次上限**照常跑（会疯狂保温烧钱）。
       */
      ...(raw.labBackup !== null && typeof raw.labBackup === 'object'
        ? { labBackup: raw.labBackup as Partial<Settings> }
        : {}),
      touchBase: numMap(raw.touchBase),
      /** 解熔标记：只收正数时间戳；脏值丢弃（解熔语义靠它，不能被脏数据破掉）。 */
      untripped: numMap(raw.untripped),
      cycles: raw.cycles !== null && typeof raw.cycles === 'object' && !Array.isArray(raw.cycles)
        ? Object.fromEntries(Object.entries(raw.cycles as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'number' && Number.isFinite(v)))
        : {},
      pinnedSessions: Array.isArray(raw.pinnedSessions)
        ? raw.pinnedSessions.filter((x): x is string => typeof x === 'string')
        : [],
      /** 在途账（G10）：只收结构完整的条目，脏数据丢弃。 */
      labPending: Array.isArray(raw.labPending)
        ? (raw.labPending as unknown[]).filter((p): p is NonNullable<State['labPending']>[number] => {
          if (p === null || typeof p !== 'object') return false
          const o = p as Record<string, unknown>
          return typeof o.id === 'string' && typeof o.sessionId === 'string'
            && typeof o.worst === 'number' && Number.isFinite(o.worst) && typeof o.at === 'number'
            && (o.status === 'inflight' || o.status === 'unknown')
        })
        : [],
      /**
       * **跨进程在途标记必须解析回来** —— 漏了这一行整套互斥就是假的：
       * 抢标记时写进去了，另一个进程读回来却是 `undefined` → 它照样抢得到。
       * 只收 `{ at: number, by: string }` 结构完整的条目，脏值丢弃。
       */
      inflight: (() => {
        const src = raw.inflight
        if (src === null || typeof src !== 'object' || Array.isArray(src)) return {}
        const out: Record<string, InflightMark> = {}
        const now = Date.now()
        for (const [id, v] of Object.entries(src as Record<string, unknown>)) {
          if (v === null || typeof v !== 'object') continue
          const o = v as Record<string, unknown>
          /** 结构不全（缺 at / 缺 by / at 不是有限数）→ 丢：脏数据不能变成「永久占着」。 */
          if (typeof o.at !== 'number' || !Number.isFinite(o.at)) continue
          if (typeof o.by !== 'string') continue
          /** 过期的直接丢（崩溃残留自愈）：读进来就当它不存在，调用方不必自己清。 */
          if (now - o.at >= INFLIGHT_TTL_MS) continue
          out[id] = { at: o.at, by: o.by }
        }
        return out
      })(),
    }
  } catch {
    return { version: 1, settings: { ...DEFAULT_SETTINGS }, sessions: {}, ledger: {}, pinnedSessions: [] }
  }
}

/** 原子写：先写临时文件再 rename，避免半截 JSON。**必须在锁内调用**（见 `withStateLock`）。 */
function writeAtomic(state: State, file: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** 同一个文件的重入深度（同一进程嵌套加锁不会自锁）。 */
const LOCK_DEPTH = new Map<string, number>()

/**
 * 本次写盘明确要求「清空账本」的会话。
 *
 * 为什么需要：`mergeForeign` 会从磁盘搬回「内存里没有的」账本条目（那是别的写者刚记的）。
 * 但「解除熔断」和「压缩重置」是**主动清空** —— 如果只把数组赋成 `[]`，
 * 下一次写盘时磁盘旧条目会被当成「别人记的」搬回来，重置被静默撤销。
 * 所以清空必须走 `clearLedger()` 留下标记，`mergeForeign` 见到标记就跳过。
 */
const CLEARED_LEDGER = new Set<string>()

/**
 * 主动清空某会话的账本（压缩重置）。
 * **不要**直接写 `state.ledger[id] = []` —— 那样会被 `mergeForeign` 复活。
 *
 * ⚠️ **解除熔断不走这里**（那会连历史花费一起抹掉），走 `untripSession()`。
 */
export function clearLedger(state: State, id: string): void {
  state.ledger[id] = []
  CLEARED_LEDGER.add(id)
}

/**
 * **解除熔断**：一条记录都不删，只记一个会话级标记。
 *
 * 用户口径：「按原顶层设计应该只是新开一轮保温周期，记录应该在详情留着，
 * 上次熔断的保温记录打上『解熔』标记，相当于 100%，绕过门禁。」
 *
 * 为什么不挂在账本条目上：`mergeForeign` 按 `at` 升序合并，另一个写者新增更晚的记录
 * 会成为新末条，挂在旧末条上的标记就失效了。挂会话级 + 用「末条 at <= 解熔时刻」判定，
 * 新记录来了自然失效，不受末条身份影响。
 *
 * 不动 `cycles` / `touchBase` —— 那两样是「清除计费（开新周期）」的语义，解熔不碰。
 */
export function untripSession(state: State, id: string, at = Date.now()): void {
  state.untripped = { ...(state.untripped ?? {}), [id]: at }
}


/** 同步睡眠（锁重试用）。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * **进程间文件锁** —— 保护 `state.json` 的「读 → 改 → 写」。
 *
 * 为什么必须有：账本是「读整份、改一处、写整份」。两个写者（插件与独立 CLI、或两个 CLI 实例）
 * 同时走这条路径，后写的会整份覆盖先写的 —— 丢掉的是账本条目，表现为**花费偏低、
 * 预算更晚触顶、面板数字对不上**。
 *
 * 可重入：`record()` 会先加锁再调 `saveState()`，而 `saveState()` 内部也加锁 ——
 * 靠 `LOCK_DEPTH` 让同进程嵌套不再抢同一个文件。跨进程仍然互斥。
 *
 * 陈旧锁：进程被强杀时 `finally` 不执行，锁文件会留下 → 超过 90 秒视为死锁直接回收。
 *
 * @param file 状态文件路径（锁文件是 `file + '.lock'`）
 * @param fn 临界区（**不要在里面 await**，否则持有锁的时间不可控）
 * @param waitMs 最长等待
 */
export function withStateLock<T>(file: string, fn: () => T, waitMs = 5000): T {
  const depth = LOCK_DEPTH.get(file) ?? 0
  if (depth > 0) {
    LOCK_DEPTH.set(file, depth + 1)
    try {
      return fn()
    } finally {
      LOCK_DEPTH.set(file, depth)
    }
  }
  const lockFile = file + '.lock'
  /**
   * ⚠️ **建目录必须在 open 之前**。锁文件和 state.json 同目录，
   * 全新部署（新 DSH_HOME、用户删掉 cache-keepalive/ 后首次运行）时目录还不存在 →
   * `openSync(lockFile,'wx')` 抛 ENOENT（不是 EEXIST，会被直接 rethrow）→
   * `saveState` 的 catch 吞掉 → **一个字节都写不进去**（设置/账本永不落盘）。
   */
  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch {
    /* 建不了就让下面的 open 报出真实原因 */
  }
  const start = Date.now()
  for (;;) {
    try {
      const fd = openSync(lockFile, 'wx')
      try {
        writeSync(fd, String(process.pid))
      } finally {
        closeSync(fd)
      }
      break
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e
      try {
        const st = statSync(lockFile)
        if (Date.now() - st.mtimeMs > 90_000) {
          unlinkSync(lockFile)
          continue
        }
      } catch {
        continue
      }
      if (Date.now() - start > waitMs) throw new Error('state.json 写锁超时（另一个进程正在写？）')
      sleepSync(50)
    }
  }
  LOCK_DEPTH.set(file, 1)
  try {
    return fn()
  } finally {
    LOCK_DEPTH.set(file, 0)
    try {
      unlinkSync(lockFile)
    } catch {
      /* 已被回收 */
    }
  }
}

/**
 * 把磁盘上「**别的写者新增的**」账本条目与策略并进本次要写的内存态。
 *
 * 解决的真问题：插件持有一份内存态 `state`，写盘时整份覆盖。独立 CLI 在这之间追加的
 * 账本条目会被抹掉（少记花费 → 预算更晚触顶 → 面板数字偏低）。
 *
 * 合并规则（保守，只增不减）：
 *  - 账本：**内存里压根没有这个会话**时才搬磁盘条目；内存里是**空数组**视为
 *    「主动清空」（解除熔断 / 压缩重置）—— **不要复活**，否则「解除熔断」会变成假开关
 *  - 策略：内存里没有的会话才补（磁盘上被删掉的不复活）
 *  - 置顶：只在内存里完全没这个字段时补
 *  - `settings`：本次写盘**不是**改设置 → 取磁盘那份。
 *    以前一律「以内存为准」，但面板和 DSH 实例是两个进程共用同一个 state.json：
 *    A 进程改了列宽/门禁文案 → B 进程下一次 tick 写盘 → 用自己内存里的旧 settings
 *    **整份覆盖**，用户看到的就是「改了不记忆」。
 */

/** 本次 saveState 是否来自「改设置」。非设置写入时 settings 以磁盘为准。 */
let SETTINGS_DIRTY = false
function mergeForeign(state: State, file: string): void {
  let disk: State
  try {
    disk = loadState(file)
  } catch {
    return
  }
  if (!SETTINGS_DIRTY) state.settings = disk.settings
  for (const [id, list] of Object.entries(disk.ledger)) {
    // 本次写盘明确要求清空这条会话的账本 → 绝不从磁盘复活
    if (CLEARED_LEDGER.has(id)) continue
    const mine = state.ledger[id]
    /**
     * 内存里没有这个会话（键不存在）→ 搬磁盘那份。
     *
     * ⚠️ **内存是空数组时也必须走合并**，不能"跳过"：
     * 写盘用的是整份覆盖，跳过就等于**把磁盘上那条删掉**。
     * 真实漏账序列（核实员实测）：
     *   ① 用户点过「解除熔断」→ 磁盘 `X: []`
     *   ② 独立 CLI 给 X 保温记账 → 磁盘 `X` 有 1 条
     *   ③ 插件下一次写盘 → 若跳过 → 写回 `X: []` → **CLI 那条账被抹掉**
     * 真正的「主动清空」只由 `clearLedger()` 的标记表达，上面的 `continue` 已经处理了。
     */
    if (mine === undefined) {
      state.ledger[id] = list
      continue
    }
    const known = new Set(mine.map((e) => `${e.at}|${e.touch}`))
    const extra = list.filter((e) => !known.has(`${e.at}|${e.touch}`))
    if (extra.length === 0) continue
    const merged = [...mine, ...extra].sort((a, b) => a.at - b.at)
    state.ledger[id] = merged.length > LEDGER_CAP ? merged.slice(-LEDGER_CAP) : merged
  }
  for (const [id, policy] of Object.entries(disk.sessions)) {
    if (state.sessions[id] === undefined) state.sessions[id] = policy
  }
  /**
   * 解熔标记也要并：另一个写者（面板 / CLI）点的解熔，不能被本进程的整份覆盖抹掉，
   * 否则「点了解熔没反应」。取**较晚**的那个 —— 解熔是单向前进的动作，后来者覆盖先前者。
   */
  if (disk.untripped !== undefined) {
    const mine = state.untripped ?? (state.untripped = {})
    for (const [id, at] of Object.entries(disk.untripped)) {
      const cur = mine[id]
      if (typeof cur !== 'number' || cur < at) mine[id] = at
    }
  }
  if (state.pinnedSessions === undefined && disk.pinnedSessions !== undefined) {
    state.pinnedSessions = disk.pinnedSessions
  }
  /**
   * 在途标记：并回磁盘那份 —— 别人正在保这条会话时，本进程一次无关的写盘
   * 不能把它的标记整份覆盖抹掉（否则跨进程互斥时好时坏）。
   * 同 id 取更晚的；**本进程刚碰过的（HOLDING）跳过** —— 磁盘那份可能是自己上一次写的旧快照，
   * 搬回来会把刚释放掉的标记复活。
   */
  if (disk.inflight !== undefined) {
    const mine = state.inflight ?? (state.inflight = {})
    for (const [id, m] of Object.entries(disk.inflight)) {
      const touched = LAST_TOUCH.get(id)
      /** 磁盘标记比本进程最后一次操作还旧 → 是自己写剩的（可能是刚释放掉的），不许复活。 */
      if (touched !== undefined && m.at <= touched) continue
      const cur = mine[id]
      if (cur === undefined || cur.at < m.at) mine[id] = m
    }
  }
  /**
   * 最后统一压到上限 —— 不只压在合并路径上。
   * 手工改过的 `state.json`、或早期版本写进去的超长账本，否则会一直原样写回。
   */
  for (const [id, list] of Object.entries(state.ledger)) {
    if (list.length > LEDGER_CAP) state.ledger[id] = list.slice(-LEDGER_CAP)
  }
}

/**
 * 持久化。**加锁 + 先合并别人新增的账本条目再写**，所以可以安全地与独立 CLI 并存。
 *
 * 失败不影响保温本身（状态是缓存，丢了下次重建）。
 */
export function saveState(state: State, file = statePath()): string {
  /** 写盘后的版本标记，**在锁内取**：锁外取可能拿到「另一个进程紧接着写入」的标记，
   * 调用方据此记下 `stateMark` 会误判「磁盘与内存一致」而漏一次同步。 */
  let mark = stateMtimeOf(file)
  try {
    withStateLock(file, () => {
      mergeForeign(state, file)
      writeAtomic(state, file)
      mark = stateMtimeOf(file)
    })
  } catch {
    /* 持久化失败不影响保温本身 */
  } finally {
    // 清空标记是「本次写盘」的语义，无论成败都要清掉，免得泄漏到下一次
    CLEARED_LEDGER.clear()
    SETTINGS_DIRTY = false
  }
  return mark
}

export function policyOf(state: State, sessionId: string): SessionPolicy {
  return state.sessions[sessionId] ?? { mode: 'auto' }
}

export function setPolicy(state: State, sessionId: string, patch: Partial<SessionPolicy>): SessionPolicy {
  const next: SessionPolicy = { ...policyOf(state, sessionId), ...patch, updatedAt: Date.now() }
  state.sessions[sessionId] = next
  return next
}

export function setSettings(state: State, patch: Partial<Settings>): Settings {
  const next = { ...state.settings, ...patch }
  // 价格是唯一参与除法的用户输入：任何来源（面板 / 工具 / 配置文件）都过一遍归一化
  next.prices = normalizePrices(next.prices)
  next.pricesByModel = normalizePriceTable(next.pricesByModel)
  next.tariff = normalizeTariff(next.tariff)
  state.settings = next
  SETTINGS_DIRTY = true
  return state.settings
}

export function appendLedger(state: State, sessionId: string, entry: LedgerEntry): void {
  const list = state.ledger[sessionId] ?? []
  list.push(entry)
  if (list.length > LEDGER_CAP) list.splice(0, list.length - LEDGER_CAP)
  state.ledger[sessionId] = list
}

export function ledgerOf(state: State, sessionId: string): LedgerEntry[] {
  return state.ledger[sessionId] ?? []
}

/**
 * 该会话是否已被熔断（最近一次保温命中率塌了）。
 *
 * 有**两条自动解除**通道：
 *  ① `lastActiveAt > last.at` —— 用户之后真的用了这条会话，缓存已被那次真实请求重建；
 *  ② **冷却到点** —— 距那次低命中已过 `settings.circuitCooldownSeconds` 秒，允许再探测一次
 *     （探测再低命中会重新熔断并刷新冷却）。
 *
 * 为什么必须有通道②：只有①的话，一条旧的低命中记录会把会话**永久拉黑**。
 * 实测：会话 `f-4212f29352da` 被 `toolHistory` 修复前的一次 0.5% 拖黑，修复后它本可 100% 命中，
 * 却一直保不了，只能靠手动 reset —— 这就是那个逻辑 bug。
 *
 * @param now 当前时间（可注入，便于测试）。
 */
/**
 * 熔断判定（看最近两条账本）。
 *
 * - `ok`       没低命中 → 正常
 * - `rearmed`  低命中**但本次新建了大量缓存**（≥ prompt 的 50%）= 缓存被回收，这次已把前缀重新写进去
 *              → 下一轮必命中，**不算熔断**，允许再保一次
 * - `model-changed` 低命中，且**本次换了模型**（跟上一条的 `model` 不同）= 换了个缓存池，全 miss 是必然的
 *              → 不熔断（但仍要看完上面这条记录的 `hitRate`；换算一次模型就永久豁免会烧钱）
 * - `tripped`  连续两次低命中，或单次低命中且**没有新建缓存**（我们发的和缓存对不上 = 装配不一致）
 *
 * 实测依据（345 个相邻保温对）：低命中后下一次恢复的有 10 次，含 `0.5% → 100%`（那次 0.58 元）——
 * 当时若按「低命中即熔断」停手，这 10 次恢复都不会发生，用户下次真实请求还要再付一次全量。
 *
 * `model-changed` 的真实案例：会话 `1f64b53f` 第 6 次把模型从 `deepseek-flash` 换成
 * `deepseek-v4.1-flash-1017`，命中率 0.35%，旧逻辑判 `tripped` 熔断（冤枉钱 + 停保）。
 *
 * `untripped`（解熔标记）：末条 `at <= 解熔时刻` 时视同 100% 命中 → `ok`。
 * **只绕熔断这一条**；预算 / 次数 / 闲置门槛 / 归档 / 路由 / 前缀变更全在 `gate.ts` 里，
 * 这里管不着也管不到（解熔不是「万能放行」）。
 */
export type TripVerdict = 'ok' | 'rearmed' | 'tripped' | 'model-changed'

export function tripVerdict(state: State, sessionId: string, threshold: number): TripVerdict {
  const led = ledgerOf(state, sessionId)
  const last = led[led.length - 1]
  if (last === undefined) return 'ok'
  /**
   * 解熔标记只在「末条还没被顶掉」时生效：`at <= 解熔时刻` = 这条低命中记录就是被解熔的那条。
   * 有新保温落账（`at` 更大）→ 标记自动失效，回到正常判定。
   */
  const untrippedAt = state.untripped?.[sessionId]
  if (typeof untrippedAt === 'number' && Number.isFinite(untrippedAt) && last.at <= untrippedAt) return 'ok'
  /** 提供方没报命中数 → 不知道该不该熔断，放行（不然第三方 provider 会被永久停掉）。 */
  if (last.cacheUnknown === true) return 'ok'
  if ((last.hitRate ?? 0) >= threshold) return 'ok'
  const prev = led[led.length - 2]
  /**
   * ⚠️ **顺序不能动**：必须在 `prevLow` 之前、`hitRate >= threshold` 之后。
   * 放到 `prevLow` 之后 → 换模型那一次仍会先被判 `tripped`，豁免完全失效。
   * 只看**这一次**是不是换模型：只豁免换模型后的第一次保温；
   * 新模型上第二次还是低命中，说明装配/前缀真的对不上，照熔断（见 `tests/model-switch.test.mjs` D1b）。
   */
  if (modelChangedOf(prev, last)) return 'model-changed'
  const prevLow = prev !== undefined && prev.cacheUnknown !== true && (prev.hitRate ?? 0) < threshold
  if (prevLow) return 'tripped'
  /** 分母必须含「新建缓存」（三者互斥），否则 write 大的那次会被误判成「新建足够多」而放行。 */
  const prompt = (last.hitTokens ?? 0) + (last.missTokens ?? 0) + (last.cacheWriteTokens ?? 0)
  const wrote = last.cacheWriteTokens ?? 0
  if (prompt > 0 && wrote * 2 >= prompt) return 'rearmed'
  return 'tripped'
}

export function isTripped(
  state: State,
  sessionId: string,
  threshold: number,
  lastActiveAt = 0,
  now = Date.now(),
): boolean {
  if (tripVerdict(state, sessionId, threshold) !== 'tripped') return false
  const list = ledgerOf(state, sessionId)
  const last = list[list.length - 1]
  if (last === undefined) return false
  /** 之后被真实使用过 → 缓存已被那次请求重建，自动解除。 */
  if (lastActiveAt > last.at) return false
  const cd = state.settings.circuitCooldownSeconds
  if (Number.isFinite(cd) && cd > 0 && now - last.at >= cd * 1000) return false
  return true
}


/** 该会话当前周期号（缺省 1）。 */
export function cycleOf(state: State, sessionId: string): number {
  const n = state.cycles?.[sessionId]
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? n : 1
}

/**
 * 开一个新周期（账本不动，只把号 +1）。
 * 同时把**连续保温次数**的基准挪到当前值 —— 清账后次数从 0 重新数，
 * 否则「次数用尽」会跨周期继续拦（用户眼里这是清账没清干净）。
 */
export function beginNewCycle(state: State, sessionId: string): number {
  const next = cycleOf(state, sessionId) + 1
  state.cycles = { ...(state.cycles ?? {}), [sessionId]: next }
  const led = ledgerOf(state, sessionId)
  const last = led[led.length - 1]
  state.touchBase = { ...(state.touchBase ?? {}), [sessionId]: last?.touch ?? 0 }
  return next
}

/** 本周期内的连续保温次数（清账后归零重数）。 */
export function touchCountOf(state: State, sessionId: string): number {
  const led = ledgerOf(state, sessionId)
  const last = led[led.length - 1]
  if (last === undefined) return 0
  const base = state.touchBase?.[sessionId] ?? 0
  return Math.max(0, (last.touch ?? 0) - base)
}

/** 该会话当前周期的累计花费。 */
export function cycleSpendOf(state: State, sessionId: string): number {
  const cur = cycleOf(state, sessionId)
  const ledgerSpend = ledgerOf(state, sessionId).reduce((s, e) => s + ((e.cycle ?? 1) === cur ? e.cost : 0), 0)
  /** 在途/未知花费（G10）：非试验模式恒为 0，所以生产行为零变化。 */
  return ledgerSpend + labPendingWorstOf(state, sessionId)
}

/**
 * 该会话当前周期的累计花费，**按当前价格重算** —— 预算这类**判定**统一走它。
 *
 * 为什么判定也要按现价：`entry.cost` 是记账时的价快照。曾经把模型价调高跑了一段再调回来，
 * 那段时间的账本永远停在 24 元 —— 于是出现「面板显示 0.099 元、门禁说已达 20 元上限」的自相矛盾
 * （真机 `verify-a` 23 条 Σ21.99 元 / 现价 0.099 元）。判定与展示必须是同一口径。
 *
 * 取的是**与 `cycleSpendOf` 完全相同的那批条目**：`cycleOf()` 为当前周期号的账本 + 在途 worst。
 * 「清账基线」在这条链路上等价于「只取本周期」—— `beginNewCycle()` 只把周期号 +1，
 * 历史条目留在旧周期号里，天然不计入（`touchBase` 是**次数**基线，与金额无关）。
 * 在途花费（`labPendingWorstOf`）已经是一个金额估计，不参与重算，原样相加，与 `cycleSpendOf` 一致。
 *
 * §改价的双向语义：价格调高时历史折算也变高 → **可能新熔**；调低时 → **可能解熔**。两者都是预期。
 * 结果下限 0：将来若加金额基线、或出现在途负数，也不该把预算判成「已花 −3 元」。
 */
export function cycleSpendAtCurrentPrices(state: State, settings: RecomputeSettings, sessionId: string): number {
  const cur = cycleOf(state, sessionId)
  let sum = 0
  for (const e of ledgerOf(state, sessionId)) {
    if ((e.cycle ?? 1) === cur) sum += recomputeCost(e, settings).cost
  }
  return Math.max(0, sum + labPendingWorstOf(state, sessionId))
}

/** 本轮试验的在途/未知花费（元）。`sessionId` 缺省 = 全部会话。非试验模式恒 0。 */
export function labPendingWorstOf(state: State, sessionId?: string): number {
  const list = state.labPending ?? []
  if (list.length === 0) return 0
  const since = Number(state.settings.labStartedAt) || 0
  return list.reduce((sum, p) => {
    if (since > 0 && p.at < since) return sum
    if (sessionId !== undefined && p.sessionId !== sessionId) return sum
    return sum + (Number(p.worst) || 0)
  }, 0)
}

/** 写一条在途账（只在试验模式调用）。返回记录 id。 */
export function appendLabPending(state: State, sessionId: string, worst: number, at = Date.now()): string {
  const id = `${at}-${(state.labPending?.length ?? 0) + 1}`
  const list = state.labPending ?? (state.labPending = [])
  list.push({ id, sessionId, worst: Number(worst) || 0, at, status: 'inflight' })
  return id
}

/** 结掉一条在途账：`ok` → 删（真实花费已在账本）；`unknown` → 标记按 worst 计入。 */
export function settleLabPending(state: State, id: string, ok: boolean): void {
  const list = state.labPending
  if (list === undefined) return
  const i = list.findIndex((p) => p.id === id)
  if (i < 0) return
  if (ok) list.splice(i, 1)
  else list[i].status = 'unknown'
}

/**
 * 按周期汇总（花费详情弹层用）。
 * @returns 每周期一条，按周期号升序
 */
export function cycleStatsOf(state: State, sessionId: string): {
  cycle: number
  count: number
  cost: number
  hitRate: number
  firstAt: number
  lastAt: number
}[] {
  const map = new Map<number, { count: number; cost: number; hit: number; prompt: number; firstAt: number; lastAt: number }>()
  for (const e of ledgerOf(state, sessionId)) {
    const c = e.cycle ?? 1
    const cur = map.get(c) ?? { count: 0, cost: 0, hit: 0, prompt: 0, firstAt: e.at, lastAt: e.at }
    cur.count += 1
    cur.cost += e.cost
    cur.hit += e.hitTokens
    cur.prompt += e.promptTokens
    if (e.at < cur.firstAt) cur.firstAt = e.at
    if (e.at > cur.lastAt) cur.lastAt = e.at
    map.set(c, cur)
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([cycle, v]) => ({
      cycle,
      count: v.count,
      cost: v.cost,
      hitRate: v.prompt === 0 ? 0 : v.hit / v.prompt,
      firstAt: v.firstAt,
      lastAt: v.lastAt,
    }))
}

export function spendOf(state: State, sessionId: string): number {
  return ledgerOf(state, sessionId).reduce((s, e) => s + e.cost, 0)
}
