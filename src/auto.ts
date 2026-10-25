/**
 * 自动候选筛选 —— 决定默认该保哪几条会话。
 *
 * 全量保温是负收益（会话越多成本线性叠加，而收益只有你真正回去用的那几条），
 * 所以自动策略只挑「门禁放行、且还没凉」的前 K 条：
 *
 *   0. 已归档的不保（`archived`）—— **排在门禁之前**：归档是资格问题（用户已收起来），
 *      不是门禁问题；否则它的 reason 会被说成"门禁拦截"，用户看不出真相
 *   1. **先门禁后自动**：门禁不认的（`gateOk !== true`）一律不占名额 ——
 *      自动策略只是"在能保的里面挑几条"，不能替门禁做决定
 *      （`gateOk` 含"已在我的保温节奏上"的 `too-soon`/`fresh`，见 `Candidate.gateOk`）
 *   2. 不归自动管的：手动设成「强制开 / 关闭」的、还没起标题的新对话 —— 不占名额
 *   3. 活动时间**已知**（本插件见过它跑回合）
 *   4. 按最后活动从近到远排序，取前 `count` 条（**最近活跃优先**，不是"快凉了优先"）
 *
 * 「凉没凉」不在这里判：闲置上限与时间基准都由门禁负责（`cold-window-idle` / `stale`），
 * 这里再判一遍会得到和门禁完全相同的结论 —— 那就成了永远走不到的死码（曾经的 `too-idle`）。
 *
 * 纯函数，可单测。
 */

export interface AutoSettings {
  enabled: boolean
  /** 保几条。 */
  count: number
  /**
   * 闲置上限（小时）。**资格判定已不再用它** —— 门禁按同一个 `settings.idleLimitHours`
   * 判 `cold-window-idle` / `stale`，`gateOk` 已把超限会话截走。
   * 字段保留是因为三处调用方与 `decideCandidates` 仍在传（删它要同时改 4 个文件，收益为零）。
   */
  maxIdleHours: number
  /**
   * 是否把**子代理会话**也纳入自动候选。默认 false。
   *
   * 为什么默认排除：子代理是主会话临时派出去干活的，命短、上下文碎、用完即弃，
   * 给它续缓存的钱基本收不回来；而且它们的数量可能远超主会话，会把自动名额吃光。
   */
  allowSubagent: boolean
}

export interface Candidate {
  id: string
  /**
   * 最后活动时间戳（毫秒）；0 表示未知。
   *
   * ⚠️ **只用于排序**（最近活跃优先）。不要拿它判"凉没凉" —— 保温不写会话日志，
   * 手动保过的会话 `lastActiveAt` 会停在很久以前，用它会把手动保温过的会话永久踢出候选。
   */
  lastActiveAt: number
  /**
   * **最后刷新**（毫秒）= `max(最后活动, 最后保温)`。
   *
   * 资格判定已不再用它（闲置上限由门禁按同一基准负责），保留作诊断字段：
   * `decideCandidates` 仍在填，未来若要加「快凉了优先」的排序才有现成数据。
   */
  lastRefreshAt?: number
  /** 该会话的保温策略模式。**只有 `auto` 才纳入自动候选**（`on`/`off` 是手动指定，不让自动策略染指）。 */
  mode?: 'auto' | 'on' | 'off'
  /** 该会话是否已有标题。**无标题的新对话不纳入自动托管**（还没起名就说明还没用起来）。 */
  hasTitle?: boolean
  /**
   * 门禁是否"认这条会话"（口径由 `gateAccepts()` 给出，三处调用方共用那一份）。
   *
   * 语义 = **已放行 或 已在我的保温节奏上**（`too-soon`/`fresh`）：保过的会话在间隔内必然是这两种，
   * 那是"我负责保的那几条"的常态，**照样占名额**（`count` 是长期占位，不是每拍能保几条）。
   * 只有真保不了 / 不该保的（cold-window / cold-window-idle / stale / tripped / no-route /
   * archived / budget / max-touches* / prefix-changed）才 `false`，让出名额。
   * **只有 `true` 才进候选** —— `false` 或未传都让出名额。
   */
  gateOk?: boolean
  /** 是否已归档。归档会话不保温，也不占名额。 */
  archived?: boolean
  /** 是否是子代理会话（日志头 `origin === 'subagent'`）。 */
  isSubagent?: boolean
}

export type CandidateReason =
  /** 全局自动策略开关是关的。 */
  | 'auto-disabled'
  /** 门禁不认（见 `Candidate.gateOk`）—— 排进候选也保不了，白占名额。 */
  | 'gate'
  /** 已归档 —— 归档会话不保温。 */
  | 'archived'
  /** 该会话被手动设成「强制开」或「关闭」—— 归手动管，不占自动名额。 */
  | 'manual'
  /** 无标题的新对话 —— 不纳入自动托管。 */
  | 'untitled'
  /** 子代理会话 —— 默认不纳入自动托管（见 `AutoSettings.allowSubagent`）。 */
  | 'subagent'
  /** 本插件没见过它活动，不知道热不热。 */
  | 'never-seen'
  /** 前面排满了，名额不够。 */
  | 'over-quota'

export interface CandidateDecision {
  id: string
  /** 是否被选为自动候选。 */
  picked: boolean
  /** 排序后的名次（从 1 开始）；未入选者为 -1。 */
  rank: number
  /** 未入选原因。 */
  reason?: CandidateReason
}

/** 挑出自动候选。返回每个会话的判定，便于面板展示"为什么没保它"。
 *
 * `now` 保留在签名里（三处调用方与 `decideCandidates` 仍传）：当前判定不需要当前时间 ——
 * 「凉没凉」由门禁按同一个 `now` 判完（`cold-window-idle` / `stale`），这里不再重复。
 */
export function pickAutoCandidates(
  candidates: readonly Candidate[],
  settings: AutoSettings,
  now: number,
): CandidateDecision[] {
  const judged = new Map<string, CandidateDecision>()
  for (const c of candidates) {
    judged.set(c.id, { id: c.id, picked: false, rank: -1 })
  }
  if (!settings.enabled) {
    for (const d of judged.values()) d.reason = 'auto-disabled'
    return [...judged.values()]
  }

  const eligible: Candidate[] = []
  for (const c of candidates) {
    const d = judged.get(c.id)!
    /**
     * **归档排第一**（在门禁之前）：归档会话的门禁码恒为 `archived`，若先判 `gateOk`
     * 就永远走不到这一支，面板会把它说成"门禁拦截"——归档是**资格问题**，得照实说。
     */
    if (c.archived === true) {
      d.reason = 'archived'
      continue
    }
    /**
     * 接着**门禁**（用户口径：先门禁后自动）：门禁不认的会话连"能不能保"都没过，
     * 不该占用自动名额。
     */
    if (c.gateOk !== true) {
      d.reason = 'gate'
      continue
    }
    /**
     * **子代理关掉开关时，先于一切「不归自动管」的理由报 `subagent`**：
     * `mode='on'` 的子代理走 tick 的强制路径（不经本函数），自动池里这条只是「自动策略不接管」，
     * 报 `manual` 会让人以为是用户手动指定的结果。
     */
    if (c.isSubagent === true && settings.allowSubagent !== true) {
      d.reason = 'subagent'
      continue
    }
    /**
     * 接着是**"不归自动管"**：手动指定 / 无标题是**资格问题**，不是健康问题 ——
     * 哪怕它刚活跃过，也不该占自动名额（否则配额会被插件管不到的会话吃光）。
     */
    if (c.mode !== undefined && c.mode !== 'auto') {
      d.reason = 'manual'
      continue
    }
    if (c.hasTitle === false) {
      d.reason = 'untitled'
      continue
    }
    if (c.lastActiveAt <= 0) {
      d.reason = 'never-seen'
      continue
    }
    /**
     * **「凉没凉」不在这里判**：闲置上限由门禁负责（`cold-window-idle` / `stale`，同一个
     * `settings.idleLimitHours`），而 `gateOk` 已在上面把这些会话截成 `reason='gate'`。
     * 过去这里还重复判一遍 `now - lastRefreshAt > maxIdleHours`，判据与门禁完全相同 →
     * 永远走不到，成了死码（`too-idle`）。删掉，只留门禁那一份。
     */
    eligible.push(c)
  }

  eligible.sort((a, b) => b.lastActiveAt - a.lastActiveAt) // 最近活跃的优先（不许改成按 lastRefreshAt）
  eligible.forEach((c, index) => {
    const d = judged.get(c.id)!
    if (index < settings.count) {
      d.picked = true
      d.rank = index + 1
    } else {
      d.reason = 'over-quota'
    }
  })
  return [...judged.values()]
}

/** 便捷：只要入选的 id 集合。 */
export function autoCandidateIds(
  candidates: readonly Candidate[],
  settings: AutoSettings,
  now: number,
): Set<string> {
  return new Set(pickAutoCandidates(candidates, settings, now).filter((d) => d.picked).map((d) => d.id))
}

/**
 * 门禁判定 → `Candidate.gateOk` 的**唯一口径**（插件 tick / 无实例面板 / 独立 CLI 三处共用）。
 *
 * 认 = 已放行 **或** 已在保温节奏上（`too-soon`/`fresh`）：保过的会话在间隔内必然是这两种，
 * 那是"我负责保的那几条"的常态，照样占 `count` 名额。
 * 只传 `{ ok, code }` 是为了不依赖 `gate.ts` 的类型（本模块保持零依赖、可单测）。
 */
export function gateAccepts(decision: { ok: boolean; code?: string }): boolean {
  return decision.ok || decision.code === 'fresh' || decision.code === 'too-soon'
}
