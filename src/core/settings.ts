/**
 * **设置补丁的唯一实现** —— 插件侧与无实例面板共用，避免两套语义漂移。
 *
 * 为什么必须共用：核实员实测过一例真实分叉 —— 无实例面板（`--serve`）直接调
 * `store.setSettings()`（只合并 + 归一化价格），**绕过了 `LAB_OVERRIDES`**，
 * 于是面板显示「试验模式运行中」，但间隔/冷却/次数一个都没被压到秒级（假开关）。
 * 现在两边都走这里，试验模式只在「谁来重注册工具」这一点上不同（那是插件侧的事）。
 */
import {
  LAB_OVERRIDES, setSettings,
  type Settings, type State,
} from '../store.ts'
import { normalizePrices, normalizePriceTable, normalizeTariff, type Prices, type Tariff } from '../econ.ts'
import { labOverBudget } from './lab/guard.ts'

/**
 * 应用一份设置补丁（直接改 `state.settings`）。
 *
 * 语义要点：
 *  - 数值项**只校验「是有限数字」不封顶** —— 用户想改多大就多大；
 *    `floor` 只挡住会导致异常行为的极端值（例如 0 秒间隔会每个 tick 都打一次 ping）
 *  - 价格 / 模型价表 / 时段表都是**整份替换**（面板每次提交完整表，避免孤儿键）
 *  - 试验模式：进入时把被覆盖的几项备份到 `state.labBackup` 再写入 `LAB_OVERRIDES`；
 *    退出时原样恢复。这样 `state.settings` **恒为生效值**，20 多处读取点无需感知
 *
 * @param state 状态（原地修改）
 * @param patch 补丁
 * @returns `labModeChanged`（调用方据此决定要不要重注册工具）；`error` 非空表示**整批未被应用**；
 *   `notice` 是「已替你改了别的字段」的可读说明（例如退出试验模式时自动抬高闲置上限）—— 调用方要显示出来。
 */
export function applySettingsPatch(
  state: State,
  patch: Record<string, unknown>,
): { labModeChanged: boolean; error?: string; notice?: string } {
  const next: Partial<Settings> = {}
  const bag = patch as Record<string, unknown>
  const setNum = (key: keyof Settings, floor?: number): void => {
    const raw = bag[key]
    if (raw === undefined) return
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    ;(next as Record<string, unknown>)[key] = floor !== undefined && n < floor ? floor : n
  }

  if (patch.autoEnabled !== undefined) next.autoEnabled = Boolean(patch.autoEnabled)
  /** 列显示：面板每次提交**完整**的 id→bool 表（整份替换，避免删不掉的孤儿键）。 */
  if (patch.columns !== null && typeof patch.columns === 'object' && !Array.isArray(patch.columns)) {
    const bag2: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(patch.columns as Record<string, unknown>)) {
      if (typeof k === 'string' && k !== '' && typeof v === 'boolean') bag2[k] = v
    }
    next.columns = bag2
  }
  if (typeof patch.cellGap === 'number' && Number.isFinite(patch.cellGap)) {
    next.cellGap = Math.max(0, Math.min(40, Math.round(patch.cellGap)))
  }
  /** 列宽：面板提交完整表；只收 40~2000 的整数 px。
   *  插件版写 `colWidths`，CLI 网页版写 `colWidthsCli` —— 两个面板容器宽/列集合不同，混用会互相把列宽改错。 */
  for (const cwKey of ['colWidths', 'colWidthsCli'] as const) {
    const v4 = patch[cwKey]
    if (v4 === null || v4 === undefined || typeof v4 !== 'object' || Array.isArray(v4)) continue
    const bag4: Record<string, number> = {}
    for (const [k, v] of Object.entries(v4 as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        bag4[k] = Math.round(Math.max(40, Math.min(2000, v)))
      }
    }
    next[cwKey] = bag4
  }
  /** 文案覆盖：面板每次提交**完整**表；空串 = 删掉该 key（回默认）。
   *  gateText/gateDetail = 门禁状态词/说明，candText = 候选理由文案。 */
  for (const k of ['gateText', 'gateDetail', 'candText'] as const) {
    const v = patch[k]
    if (v === null || typeof v !== 'object' || Array.isArray(v)) continue
    const bag3: Record<string, string> = {}
    for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
      if (key !== '' && typeof val === 'string' && val !== '') bag3[key] = val
    }
    next[k] = bag3
  }
  setNum('autoCount', 0)
  /** 子代理独立名额（负数夹到 0；非数字丢弃；数字字符串照收）。 */
  setNum('autoCountSubagent', 0)
  setNum('intervalSeconds', 60)
  /** 闲置上限（小时）：门禁与自动候选共用。下限 0.5 小时。 */
  setNum('idleLimitHours', 0.5)
  /** 「刚保过」窗口（秒）：下限 0（= 关掉 fresh）。 */
  setNum('freshSeconds', 0)
  setNum('maxTouches', 0)
  setNum('budgetPerSession', 0)
  setNum('maxTokens', 1)
  setNum('circuitCooldownSeconds', 0)
  /**
   * 熔断命中率线：**必须带上下限** —— `setNum` 只支持下限（floor），上限 [0.95] 得单独夹。
   * 非法值（NaN / 非数字）**整批拒绝**，与其它字段同一口径。
   */
  if (bag.circuitHitRate !== undefined) {
    /** 先判类型：`Number(true)`=1、`Number(null)`=0 会把脏值强转成合法值。 */
    const v = bag.circuitHitRate
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { labModeChanged: false, error: '熔断命中率线必须是数字（0.05~0.95）' }
    }
    next.circuitHitRate = Math.min(0.95, Math.max(0.05, v))
  }
  setNum('gateWordWidth', 80)
  setNum('timelineCacheMinutes', 0)
  if (patch.prices !== undefined) next.prices = normalizePrices(patch.prices as Partial<Prices>)
  if (patch.pricesByModel !== undefined) next.pricesByModel = normalizePriceTable(patch.pricesByModel)
  if (patch.tariff !== undefined) next.tariff = normalizeTariff(patch.tariff as Partial<Tariff>)
  if (patch.costScope === 'cycle' || patch.costScope === 'total') next.costScope = patch.costScope
  if (typeof patch.maxTouchesTotal === 'number' && Number.isFinite(patch.maxTouchesTotal)) {
    next.maxTouchesTotal = Math.max(0, Math.round(patch.maxTouchesTotal))
  }
  if (typeof patch.prompt === 'string' && patch.prompt.trim() !== '') next.prompt = patch.prompt
  // 测验台工具开关会改变工具面（注册/注销 cache_lab）→ 所有会话前缀缓存失效一次，是用户显式选择
  if (typeof patch.exposeLabTools === 'boolean') next.exposeLabTools = patch.exposeLabTools
  if (typeof patch.exposeKeepaliveTool === 'boolean') next.exposeKeepaliveTool = patch.exposeKeepaliveTool
  if (typeof patch.autoAllowSubagent === 'boolean') next.autoAllowSubagent = patch.autoAllowSubagent

  let labModeChanged = false
  /**
   * 试验模式的范围与预算：**与 labMode 无关**，关闭态也能预设（"先配 20 条会话再开"是主路径）。
   * 放进 labMode 分支之外 → 不产生 `labBackup`、不动 `labExpiresAt/labStartedAt`。
   *
   * 非法值一律**整批拒绝**（一个字段都不写），与下面那条关系校验同一个口径。
   */
  const allowRaw = bag.labSessionAllow
  if (allowRaw !== undefined) {
    if (!Array.isArray(allowRaw)) {
      return { labModeChanged: false, error: '白名单必须是会话 id 数组' }
    }
    const seen = new Set<string>()
    const allow: string[] = []
    for (const x of allowRaw) {
      if (typeof x !== 'string') continue
      const v = x.trim()
      if (v === '' || seen.has(v)) continue
      seen.add(v)
      allow.push(v)
      /** 上限 500 条：防手滑/脚本写进几万条把 state 撑爆。 */
      if (allow.length >= LAB_ALLOW_MAX) break
    }
    next.labSessionAllow = allow
  }
  const budgetRaw = bag.labBudgetPerRun
  if (budgetRaw !== undefined) {
    const n = Number(budgetRaw)
    if (!Number.isFinite(n)) return { labModeChanged: false, error: '本轮预算必须是数字（元）' }
    next.labBudgetPerRun = Math.max(0, Math.round(n * 100) / 100)
  }
  /**
   * 退出试验模式时要恢复的备份。**先取局部副本**：`state.labBackup` 只能在**保存成功之后**删，
   * 否则整批被拒时（例如恢复出来的间隔非法）settings 回滚了、备份却已丢失 →
   * 用户再退一次就静默停在 30 秒间隔 / 99 次上限（原值永久丢失）。
   */
  let restoreBackup: Partial<Settings> | undefined
  if (typeof patch.labMode === 'boolean' && patch.labMode !== state.settings.labMode) {
    next.labMode = patch.labMode
    labModeChanged = true
    if (patch.labMode) {
      state.labBackup = {
        intervalSeconds: state.settings.intervalSeconds,
        freshSeconds: state.settings.freshSeconds,
        circuitCooldownSeconds: state.settings.circuitCooldownSeconds,
        maxTouches: state.settings.maxTouches,
      }
      Object.assign(next, LAB_OVERRIDES)
      /**
       * **到期自愈的锚**：默认 2 小时后自动退出（`0` = 调用方显式要求不过期）。
       * `labStartedAt` 是本轮花费的统计起点（`labSpendOf()` 用）。
       */
      next.labStartedAt = Date.now()
      next.labExpiresAt = typeof patch.labExpiresAt === 'number' && Number.isFinite(patch.labExpiresAt)
        ? Math.max(0, patch.labExpiresAt)
        : Date.now() + LAB_DEFAULT_TTL_MS
    } else {
      if (state.labBackup !== undefined) {
        restoreBackup = state.labBackup
        /**
         * **只认 4 个键**：`labBackup` 被手改或历史版本塞进别的字段时，不能顺着 `Object.assign`
         * 把它们写进 settings（那等于把任意键注入配置）。
         */
        for (const k of LAB_BACKUP_KEYS) {
          const v = (state.labBackup as Record<string, unknown>)[k]
          if (typeof v === 'number' && Number.isFinite(v)) (next as Record<string, unknown>)[k] = v
        }
      }
      /** 退出就清时间戳 —— **不依赖 `labBackup` 存在**（手改 state.json 造出的 labMode=true 没有备份）。 */
      next.labExpiresAt = 0
      next.labStartedAt = 0
    }
  } else if (
    /**
     * 运行中改到期（**单开路径**）。判据必须是：
     *  - `patch.labMode === undefined` —— 不能写成"等于现状"：否则 `{labMode:true, labExpiresAt:X}`
     *    会被开启分支和本条**同时吃**；
     *  - 用**现状** `state.settings.labMode` 判运行中 —— 不能写 `next.labMode === true`：
     *    `next` 是 `Partial<Settings>`，本条又要求未改 `labMode`，那个值**恒 undefined**，判据永远 false。
     */
    patch.labMode === undefined
    && state.settings.labMode === true
    && bag.labExpiresAt !== undefined
  ) {
    const exp = Number(bag.labExpiresAt)
    if (!Number.isFinite(exp)) {
      return { labModeChanged: false, error: '到期时间必须是毫秒时间戳（0 = 不自动退出）' }
    }
    next.labExpiresAt = Math.max(0, exp)
  }

  let notice: string | undefined
  /**
   * 退出试验模式时，如果恢复出来的间隔与**当前**闲置上限不满足关系（历史版本允许写入这类配置），
   * 把闲置上限抬到刚好大于间隔 —— 否则校验会把「退出」整批拒掉，用户卡在秒级参数里。
   * 用**局部副本**判（`state.labBackup` 此刻还没删，但也不能依赖那个时机）。
   */
  if (restoreBackup !== undefined && next.idleLimitHours === undefined) {
    const iv = next.intervalSeconds ?? state.settings.intervalSeconds
    if (!(state.settings.idleLimitHours * 3600 > iv)) {
      const raised = Math.round((iv / 3600 + 0.5) * 100) / 100
      next.idleLimitHours = raised
      notice = `已自动把闲置上限抬到 ${raised} 小时，以容纳恢复的保温间隔 ${iv} 秒（原上限 ${state.settings.idleLimitHours} 小时）`
    }
  }
  /**
   * **熔断阈值抬高 → 冷却强制联动**（`.tmp/inv-a.md` §3.6）。
   *
   * 为什么必须联动：`circuitCooldownSeconds = 0` 的语义是「熔断后不自动恢复」，
   * 而阈值从 ≤0.5 抬到 >0.5 会让**更多**会话被判熔断 —— 用户这时往往正想「更严一点、但别一封到底」，
   * 停手就变成永久封禁（只能靠真实使用或手改配置解）。所以自动给 600 秒探测窗口，并用 notice 明说。
   * 只在「原本就是 0」且「阈值确实抬高」时动，不覆盖用户显式设的冷却值。
   */
  if (
    next.circuitHitRate !== undefined
    && next.circuitHitRate > 0.5
    && state.settings.circuitHitRate <= 0.5
    /** 用户**显式**传了冷却（哪怕是 0）就尊重它 —— 否则「抬阈值但保持不自动恢复」无法表达。 */
    && patch.circuitCooldownSeconds === undefined
    && state.settings.circuitCooldownSeconds === 0
  ) {
    next.circuitCooldownSeconds = 600
    notice = `熔断线从 ${Math.round(state.settings.circuitHitRate * 100)}% 抬到 `
      + `${Math.round(next.circuitHitRate * 100)}%：为避免被判熔断的会话永久封禁，`
      + '已把熔断冷却从 0 秒改成 600 秒（10 分钟后自动允许再探测一次）'
  }

  /**
   * **关系校验：`idleLimitHours * 3600 > intervalSeconds`。**
   *
   * 不满足时门禁的 `too-soon` 段与 `stale` 段相接 → 会话保过一次就**永远保不上**（V13 已知红的成因）。
   * 前端面板本来有校验，但后端（agent 的 `set-settings`、CLI、直接打 `/settings`）没有 → 能写出永久锁死配置。
   * 这里按**合并后**的值判（单改一个字段也要能发现冲突），不满足则整批拒绝、一个字段都不写、`labBackup` 保持原样。
   */
  const mergedInterval = next.intervalSeconds ?? state.settings.intervalSeconds
  const mergedIdleHours = next.idleLimitHours ?? state.settings.idleLimitHours
  if (!(mergedIdleHours * 3600 > mergedInterval)) {
    return {
      labModeChanged: false,
      error: `闲置上限必须大于保温间隔，否则永远保不上：现在间隔 ${mergedInterval} 秒、闲置上限 ${mergedIdleHours} 小时`
        + '（本次保存整批未生效；试验模式的备份仍在，参数没丢）',
    }
  }

  setSettings(state, next)
  /** 保存成功后才清备份 —— 失败路径必须留着它。 */
  if (labModeChanged && patch.labMode === false) delete state.labBackup
  return { labModeChanged, ...(notice === undefined ? {} : { notice }) }
}

/**
 * 恢复残留的 `labBackup`（上次退出试验模式时被整批拒绝，备份留在 state 里）。
 *
 * **不能复用** `applySettingsPatch({ labMode: false })`：残留场景下 `labMode` 往往**已经是 false**，
 * 同值不进 labMode 分支 → 什么都不会恢复，用户点「恢复」看起来成功、实际参数没变。
 */
export function labRestoreBackup(state: State): { ok: boolean; error?: string; restored?: string[] } {
  /** ① 运行中不允许：写回的值会立刻被 `LAB_OVERRIDES` 盖掉，用户以为恢复了。 */
  if (state.settings.labMode === true) {
    return { ok: false, error: '试验模式运行中，不能恢复备份 —— 先退出试验模式' }
  }
  const backup = state.labBackup
  if (backup === undefined) return { ok: false, error: '没有残留的备份' }
  /** ⑤ 只认白名单里的 4 个键；备份里混进别的字段一律忽略。 */
  const patch: Record<string, unknown> = {}
  const keys: string[] = []
  for (const k of LAB_BACKUP_KEYS) {
    const v = (backup as Record<string, unknown>)[k]
    if (typeof v === 'number' && Number.isFinite(v)) {
      patch[k] = v
      keys.push(k)
    }
  }
  if (keys.length === 0) return { ok: false, error: '备份里没有可恢复的字段' }
  /**
   * ② 走 `applySettingsPatch`：复用归一化与 `idleLimitHours * 3600 > intervalSeconds` 那条关系校验。
   *   直接 `Object.assign` 能把历史版本写进去的**非法组合**恢复出来，之后任何保存都会被整批拒绝。
   */
  const r = applySettingsPatch(state, patch)
  /** ③ 失败（被整批拒绝）保留备份，错误原样回给面板。 */
  if (r.error !== undefined) return { ok: false, error: r.error }
  /** ④ 恢复成功后清两个时间戳 —— 否则「本轮花费」会继续算上一轮的旧账。 */
  setSettings(state, { labExpiresAt: 0, labStartedAt: 0 })
  /** ③ 成功才删备份。 */
  delete state.labBackup
  return { ok: true, restored: keys }
}

/** 试验模式默认有效期：2 小时。到点自动退出，防「忘了关 → 30 秒间隔持续烧钱」。 */
export const LAB_DEFAULT_TTL_MS = 2 * 3_600_000

/** 白名单条数上限：防手滑/脚本写进几万条把 state 撑爆。 */
export const LAB_ALLOW_MAX = 500

/** `labBackup` 只认这 4 个键（与进入试验模式时写入的清单保持一致）。 */
const LAB_BACKUP_KEYS = ['intervalSeconds', 'freshSeconds', 'circuitCooldownSeconds', 'maxTouches'] as const

/**
 * 面板用的试验模式快照（`labSpend` / `labResidual` / `labUserParams`）。
 *
 * 两条 snapshot 路径（`index.ts` 插件版 / `core/panel-service.ts` CLI 版）**必须都调这里** ——
 * 上一轮 `markItem` 就是两边各写一份导致分叉（有实例的那条丢了 5 个字段）。
 *
 * ⚠️ `labSpend` 用 `labOverBudget`（**全部会话账本 + 在途花费**），不能用 `labSpendOf`
 * （它只算传入的单会话账本、不含在途）—— 否则面板显示「还剩 0.4 元」而护栏已经拒了。
 */
export function labSnapshotOf(state: State): {
  labSpend: { over: boolean; spent: number; budget: number }
  labResidual: { count: number; keys: string[] }
  labUserParams: {
    intervalSeconds: number
    freshSeconds: number
    circuitCooldownSeconds: number
    maxTouches: number
  }
} {
  const st = state.settings
  const backup = (state.labBackup ?? {}) as Record<string, unknown>
  const keys = state.labBackup === undefined ? [] : Object.keys(state.labBackup)
  /** 「你的值」：试验中取备份里的原值，没试验时两列相同。 */
  const pick = (k: typeof LAB_BACKUP_KEYS[number]): number => {
    const v = backup[k]
    const n = typeof v === 'number' && Number.isFinite(v) ? v : Number((st as unknown as Record<string, unknown>)[k])
    return Number.isFinite(n) ? n : 0
  }
  return {
    labSpend: labOverBudget(state, undefined, st.labStartedAt),
    labResidual: { count: keys.length, keys },
    labUserParams: {
      intervalSeconds: pick('intervalSeconds'),
      freshSeconds: pick('freshSeconds'),
      circuitCooldownSeconds: pick('circuitCooldownSeconds'),
      maxTouches: pick('maxTouches'),
    },
  }
}

/**
 * **到期自愈**：试验模式到点就退出并还原参数。**纯判定 + 调用方驱动的写**。
 *
 * 返回 `undefined` = 不用处理（没开试验 / 没设到期 / 还没到点）。
 * 返回对象 = 已调用 `applySettingsPatch({labMode:false})` 并把结论交回给调用方记日志。
 *
 * 被违规保持 `labMode=true` 的后果：30 秒间隔持续发真实请求，几个小时就是几十元。
 */
export function labExpireIfDue(state: State, now = Date.now()): { restored: boolean; message: string } | undefined {
  const s = state.settings
  if (s.labMode !== true) return undefined
  if (!(typeof s.labExpiresAt === 'number') || s.labExpiresAt <= 0) return undefined
  if (now <= s.labExpiresAt) return undefined
  const r = applySettingsPatch(state, { labMode: false })
  return {
    restored: r.labModeChanged === true,
    message: `试验模式已到期（${new Date(s.labExpiresAt).toLocaleString()}）→ 自动退出并按备份还原参数`
      + (r.error === undefined ? '' : `；但还原失败：${r.error}`),
  }
}
