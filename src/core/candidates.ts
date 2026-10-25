/**
 * 「会话行 → 自动候选决策」的**唯一实现**。
 *
 * 为什么要有这一层：这套判定过去在三个地方各写一遍（插件 tick `/` 无实例面板 `/` 独立 CLI），
 * 每处都自己拼 Candidate、自己调 buildGateInput + decideWarm，结果反复漂移：
 *  - 归档判定与门禁的先后顺序漂过（归档会话说成"门禁拦截"）；
 *  - 「凉没凉」的时间基准漂过（一处用最后活动、一处用 max(活动, 保温)）；
 *  - `gateOk` 的口径漂过（有的地方只排 cold-window/no-route）。
 * 现在三处都只调 `decideCandidates()`，**口径只存在这一份**。
 *
 * 调用方只负责把各自视角的信息映射成 `CandidateRow`（见各字段注释），
 * 判定顺序固定为：`pickAutoCandidates()`（archived → gate → subagent → manual → untitled → never-seen）。
 * 「凉没凉」不在这里判 —— 闲置上限由门禁负责（`cold-window-idle` / `stale`）。
 */

import { gateAccepts, pickAutoCandidates, type CandidateDecision } from '../auto.ts'
import { decideWarm } from '../gate.ts'
import { buildGateInput } from './gate-input.ts'
import { ledgerOf, policyOf, type State } from '../store.ts'
import { readSessionModel } from './sessions.ts'

/** 一条会话在候选判定里需要的全部输入。缺省值见各字段。 */
export interface CandidateRow {
  id: string
  /** 磁盘最后活动（会话日志 mtime）；没有日志时 0。 */
  mtime: number
  archived: boolean
  /** 日志头 `origin`：`'subagent'` 表示子代理会话，`''` 表示普通会话。 */
  origin: string
  /** 会话标题；空串 = 还没起标题（不纳入自动托管）。 */
  title: string
  /** 覆盖「最后活动」：插件侧有内存活动时间，传进来覆盖 `mtime`。缺省 `mtime`。 */
  lastActiveAt?: number
  /** 覆盖「最后刷新」= max(最后活动, 最后保温)。缺省由本模块按账本末条算出。 */
  lastRefreshAt?: number
  /** 有没有可用路由。缺省 `true`（乐观 —— 真装配失败会在发请求那步报出来）。 */
  hasRoute?: boolean
  /** 是否处于熔断（调用方算）。缺省 `false`。 */
  tripped?: boolean
  /** 日志尾部刚发生「压缩 / goal 改写」且其后没有真实请求。缺省视为没改写。 */
  rewritten?: { detail: string }
  /**
   * 是否本进程内的活会话。缺省 `true`（历史行为：候选池只有活 agent）。
   *
   * 判定本身不看它（口径只有一套）；执行侧据此选路径：
   * `live` → `ping(agent)`（内存，零读盘，快）；`!live` → 离线装配 `warmOffline()`（慢但全能）。
   */
  live?: boolean
}

/** 自动候选的旋钮（与 `AutoSettings` 同形；`maxIdleHours` 取 `settings.idleLimitHours`）。 */
export interface CandidatesAutoSettings {
  enabled: boolean
  count: number
  maxIdleHours: number
  allowSubagent: boolean
}

/**
 * 唯一入口：返回 `id → CandidateDecision`（含 `picked`/`rank`/`reason`）。
 *
 * 纯读：不改 state、不发请求、不写盘。`now` 由调用方给，便于测试与一拍的判定保持一致。
 */
export function decideCandidates(
  state: State,
  rows: readonly CandidateRow[],
  now: number,
  auto: CandidatesAutoSettings,
): Map<string, CandidateDecision> {
  const pool = rows.map((row) => {
    const lastActiveAt = row.lastActiveAt ?? row.mtime
    /** 与门禁同一个基准（门禁里叫 `since`）：门槛数值与时间基准必须同时同源。 */
    const lastRefreshAt = row.lastRefreshAt
      ?? Math.max(lastActiveAt, ledgerOf(state, row.id).slice(-1)[0]?.at ?? 0)
    const gate = decideWarm(buildGateInput(state, {
      id: row.id,
      mtime: row.mtime,
      hasRoute: row.hasRoute ?? true,
      /** 按模型自定义门槛（`settings.modelOverrides`）：从日志尾部读 provider/model。 */
      ...(row.logFile === undefined ? {} : ((): Record<string, string> => { const m = readSessionModel(row.logFile); return m === undefined ? {} : { provider: m.provider, model: m.model } })()),
      tripped: row.tripped ?? false,
      archived: row.archived === true,
      agentStatus: 'idle',
      lastActivityAt: lastActiveAt,
      rewritten: row.rewritten !== undefined,
      rewriteDetail: row.rewritten?.detail,
      /**
       * 子代理走**专用短间隔且不吃网页版延后**（见 `gate.decideWarm`）。
       * 不传这一位，子代理就按主会话的 4 小时间隔判 —— 它们活不到那个点，
       * 于是「子代理也算」开关看着像失效（进了候选但门禁恒 `too-soon`）。
       */
      isSubagent: row.origin === 'subagent',
      /**
       * **同一个 `now` 喂门禁与名次**（`buildGateInput` 里 `at ?? Date.now()`）。
       * 不传就成双时钟：名次按 `now` 算、门禁按真实时间算 —— 冻结时钟/虚拟实验下会得出
       * 「名次说该保、门禁说凉了」的自相矛盾结论。P1 虚拟层要求整拍同一时刻，故必须传。
       */
      at: now,
    }))
    return {
      id: row.id,
      lastActiveAt,
      lastRefreshAt,
      mode: policyOf(state, row.id).mode,
      hasTitle: row.title !== '',
      isSubagent: row.origin === 'subagent',
      archived: row.archived === true,
      gateOk: gateAccepts(gate),
    }
  })
  return new Map(pickAutoCandidates(pool, auto, now).map((d) => [d.id, d]))
}

/** 便捷：只要入选的 id 集合。 */
export function pickedIds(decisions: Map<string, CandidateDecision>): Set<string> {
  const out = new Set<string>()
  for (const [id, d] of decisions) if (d.picked) out.add(id)
  return out
}
