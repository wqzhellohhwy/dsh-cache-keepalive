/**
 * 门禁文案表 —— 状态词与说明模板都可以在设置里改写，这里只是默认值。
 *
 * 说明模板里的 `{名字}` 会被替换成实际数值（具体可用变量见每条的 `vars`）。
 * 用户在设置里留空 = 用本文件的默认值。
 */
export interface GateTextDef {
  /** 稳定 key：既是设置里的键，也是 CSS 类名 `gate-<key>` 的后缀。 */
  key: string
  /** 列表里的默认状态词。 */
  text: string
  /** 默认说明模板；空串表示不显示说明。 */
  detail: string
  /** 该模板可用的占位符名字。 */
  vars?: readonly string[]
  /**
   * **长档**状态词：闲置超过 `LONG_IDLE_MINUTES` 分钟时用它。
   *
   * 只有需要分档的门禁码才有（`cold-window-idle` / `stale`）；其余码留空 = 长档就是短档。
   * 用户覆盖走独立键 `key + ':long'`，**不与短档覆盖互相回退**（两档是两套话）。
   */
  textLong?: string
  /** **长档**说明模板（同样只在长档用）。 */
  detailLong?: string
}

/**
 * 闲置超过这个分钟数（9999 分钟 ≈ 6.9 天）就切**长档**文案。
 *
 * 为什么要有：真机出现过「闲置 29000000 分钟」，短档说明里的具体数字毫无意义；
 * 状态词也得跟着从「闲置超窗」变「闲置过久」，否则说明说「过久」、状态词说「超窗」，自相矛盾。
 */
export const LONG_IDLE_MINUTES = 9999
export const LONG_IDLE_MS = LONG_IDLE_MINUTES * 60_000

export const GATE_TEXTS: readonly GateTextDef[] = [
  { key: 'warm', text: '可保温', detail: '下一轮就保' },
  {
    key: 'fresh', text: '已保温',
    detail: '{since}前保过，{window}内不重复', vars: ['since', 'window'],
  },
  {
    key: 'too-soon', text: '未到点',
    detail: '距{label} {gap}｜间隔 {interval}｜还差 {remain}', vars: ['label', 'gap', 'interval', 'remain'],
  },
  { key: 'cold-window', text: '没保过', detail: '从未保温、活动时间未知；先发条消息，或用「保温」强制' },
  {
    key: 'cold-window-idle', text: '闲置超窗',
    detail: '已闲置 {idle} > 上限 {window}；缓存大概率已断，先聊一句或用「保温」强制',
    textLong: '闲置过久',
    /** 长档**不报具体数字**（29 亿分钟没有意义），只给一句整话；两档都可被用户覆盖。 */
    detailLong: '闲置过久，缓存大概率已断；先聊一句或用「保温」强制',
    vars: ['idle', 'window'],
  },
  {
    key: 'stale', text: '断档',
    detail: '距最后刷新 {since} > 上限 {limit}；保了也是 0 命中，先发条消息重建',
    textLong: '断档过久',
    detailLong: '断档过久（闲置过久，缓存大概率已断）；先发条消息重建',
    vars: ['since', 'limit'],
  },
  { key: 'archived', text: '已归档', detail: '归档会话不保温' },
  { key: 'tripped', text: '熔断', detail: '上次命中率低于阈值：漏一次 ≈ 50 次保温的钱' },
  { key: 'budget', text: '超预算', detail: '本周期已达上限 {budget} 元', vars: ['budget'] },
  {
    key: 'max-touches', text: '本期次数满',
    detail: '本周期 {touch}/{max} 次（「清账」可开新周期）', vars: ['touch', 'max'],
  },
  {
    key: 'max-touches-total', text: '累计次数满',
    detail: '累计 {touch}/{max} 次（跨周期也算；调高上限或设 0 解除）', vars: ['touch', 'max'],
  },
  { key: 'running', text: '跑回合中', detail: '正在跑回合，真回合优先' },
  { key: 'no-route', text: '无路由', detail: '还没路由过请求，拿不到 provider/model' },
  { key: 'no-agent', text: '找不到', detail: '无此会话' },
  {
    key: 'image', text: '有图',
    detail: '图片会让离线前缀失配，只在最后 {tail} 段内可保；可用「保温」强制', vars: ['tail'],
  },
  { key: 'prefix-changed', text: '前缀变', detail: '工具声明或系统消息变过；已暂停、不花钱，真实使用后自动恢复' },
]

/** key → 默认状态词。 */
export const GATE_TEXT_DEFAULTS: Record<string, string> = Object.fromEntries(
  GATE_TEXTS.map((d) => [d.key, d.text]),
)

/** key → 默认说明模板。 */
export const GATE_DETAIL_DEFAULTS: Record<string, string> = Object.fromEntries(
  GATE_TEXTS.map((d) => [d.key, d.detail]),
)

/** 把模板里的 `{名字}` 换成实际值；没给值的占位符原样保留（便于用户发现写错了）。 */
export function renderGateText(tpl: string, vars?: Record<string, string>): string {
  if (tpl === '') return ''
  return tpl.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = vars?.[name]
    return v === undefined ? whole : v
  })
}

/** key → 定义（面板与服务端都要按 key 取 textLong/detailLong）。 */
export const GATE_TEXTS_BY_KEY: Record<string, GateTextDef> = Object.fromEntries(
  GATE_TEXTS.map((d) => [d.key, d]),
)

/** 该门禁码是否有长档文案（只有需要分档的码才有）。 */
export function hasLongTier(def: GateTextDef): boolean {
  return def.textLong !== undefined || def.detailLong !== undefined
}

/**
 * 取状态词：长档 → 用户覆盖 `key:long` → `textLong`；短档 → 用户覆盖 `key` → `text`。
 *
 * **两档不许互相回退**：用户只改了短档（`gateText.stale`）时，长档仍用内置的 `textLong`。
 * 回退过去会让长档显示成短档的词（用户明明设的是「断档」，长档却要说「断档过久」，反而更乱）。
 */
export function gateTextOf(def: GateTextDef, long = false, overrides?: Record<string, string>): string {
  if (long) {
    const ovLong = overrides?.[def.key + ':long']
    if (ovLong !== undefined && ovLong !== '') return ovLong
    return def.textLong ?? def.text
  }
  const ov = overrides?.[def.key]
  return ov !== undefined && ov !== '' ? ov : def.text
}

/** 取说明模板：规则与 `gateTextOf` 完全一致（长档独立覆盖 → `detailLong` → 短档）。 */
export function gateDetailOf(def: GateTextDef, long = false, overrides?: Record<string, string>): string {
  if (long) {
    const ovLong = overrides?.[def.key + ':long']
    if (ovLong !== undefined && ovLong !== '') return ovLong
    return def.detailLong ?? def.detail
  }
  const ov = overrides?.[def.key]
  return ov !== undefined && ov !== '' ? ov : def.detail
}
