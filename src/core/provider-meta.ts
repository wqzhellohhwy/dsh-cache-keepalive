/**
 * 从 DSH 的 profile 配置**静态推导**「真实请求会怎么发」。
 *
 * ⚠️ 纯只读、纯静态：只读各 profile 目录下的 `cordis.yml` 与 `cordis.patch.yml`，不联网、不读凭据、
 * **不改任何行为**。判定对不对的唯一依据是 `tools/fetchspy.mjs` 抓到的真实请求体。
 *
 * ## 推导链（每一环对着源码）
 *
 * ```
 * cordis.yml 的 model 条目
 *   reasoningEfforts 缺省 → reasoning = 目录能力（本仓库不读目录 → 按未声明 false）
 *   reasoningEfforts 有值 → reasoning = true          （dsh-llm-pi-ai/lib/index.js:586）
 *   compat.supportsDeveloperRole 显式声明 → 用它     （model 级 > provider 级 > 名单推断）
 *   未声明 → detectCompat() 的名单（openai-completions.js:1218-1261）
 *   compat.thinkingFormat 显式声明 → 用它；未声明 → 仅 deepseek.com 端点算 'deepseek'
 * instructionRole = model.reasoning && supportsDeveloperRole ? 'developer' : 'system'
 *                                                     （openai-completions.js:896）
 * ```
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** `pi-ai` 认定的全部思考档位（`dsh-llm-pi-ai/lib/index.js:296`）。 */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 一个 model 条目。 */
export interface ParsedModel {
  id: string
  /** 声明的档位 → wire 值（`off: null` 就是 null）。 */
  thinkingLevelMap: Record<string, string | null>
  /** 是否声明了至少一个非 off 档 → `model.reasoning`。 */
  reasoning: boolean
  /** model 级 `compat`。 */
  compat?: Record<string, unknown>
}

/** 一个 provider 路由（含它的全部 model 条目）。 */
export interface ParsedProvider {
  name: string
  api?: string
  baseURL?: string
  apiKeyEnv?: string
  /** provider 级 `compat`。 */
  compat?: Record<string, unknown>
  /** 按 model id 索引的条目。 */
  models: Map<string, ParsedModel>
}

/** 去引号、识别 null/true/false 的标量。 */
function scalarOf(raw: string): unknown {
  const v = raw.trim().replace(/^["']|["']$/gu, '')
  if (v === '' || v === 'null' || v === '~') return null
  if (v === 'true') return true
  if (v === 'false') return false
  return v
}

/**
 * 解析 `llm-pi-ai.config.providers` 段。
 *
 * 不能靠正则逐行状态机：provider 名（`tokenrhythm-title`）与 model id
 * （`deepseek-v4.1-flash-1017`）本身形似 `key: value`，只能按**缩进深度**区分。
 *
 * @param text cordis.yml / cordis.patch.yml 全文
 */
export function parseProviderBlocks(text: string): ParsedProvider[] {
  const out: ParsedProvider[] = []
  /** `-1` = 还没进 providers 段。 */
  let providersIndent = -1
  /** `-1` = 不在任何 provider 里。 */
  let providerIndent = -1
  let provider: ParsedProvider | undefined
  /** `models:` 的缩进；`-1` = 该 provider 没有 models 段。 */
  let modelsIndent = -1
  let model: ParsedModel | undefined
  /** 当前 `compat:` / `reasoningEfforts:` 块的缩进与落点；`-1` = 不在块里。 */
  let compatIndent = -1
  let compatTarget: Record<string, unknown> | undefined
  let effortsIndent = -1

  const flushModel = () => {
    if (provider !== undefined && model !== undefined) provider.models.set(model.id, model)
    model = undefined
    compatIndent = -1
    compatTarget = undefined
    effortsIndent = -1
  }
  const flushProvider = () => {
    flushModel()
    provider = undefined
    providerIndent = -1
    modelsIndent = -1
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/u, '')
    if (line.trim() === '' || /^\s*#/u.test(line)) continue
    const indent = line.length - line.trimStart().length
    const body = line.trim()

    if (providersIndent < 0) {
      if (/^providers:\s*$/u.test(body)) providersIndent = indent
      continue
    }
    if (indent <= providersIndent) {
      flushProvider()
      providersIndent = /^providers:\s*$/u.test(body) ? indent : -1
      continue
    }
    if (provider !== undefined && indent <= providerIndent) {
      flushProvider()
    }
    if (provider === undefined) {
      // provider 名：带连字符也算，靠缩进与 `key: value` 区分
      const nameOnly = /^([A-Za-z0-9_.-]+):\s*$/u.exec(body)
      if (nameOnly === null) continue
      provider = { name: nameOnly[1], models: new Map() }
      providerIndent = indent
      out.push(provider)
      continue
    }
    /** provider 级字段（`models:` 之前）。 */
    if (modelsIndent < 0) {
      if (/^models:\s*$/u.test(body)) {
        modelsIndent = indent
        continue
      }
      const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/u.exec(body)
      if (kv === null) continue
      if (kv[1] === 'baseURL') provider.baseURL = String(scalarOf(kv[2]) ?? '')
      else if (kv[1] === 'api') provider.api = String(scalarOf(kv[2]) ?? '')
      else if (kv[1] === 'apiKeyEnv') provider.apiKeyEnv = String(scalarOf(kv[2]) ?? '')
      else if (kv[1] === 'compat' && kv[2] === '') {
        provider.compat ??= {}
        compatTarget = provider.compat
        compatIndent = indent
      }
      continue
    }
    if (model !== undefined && effortsIndent >= 0 && indent > effortsIndent) {
      const kv = /^(['"]?)([A-Za-z_]+)\1:\s*(.*)$/u.exec(body)
      if (kv === null) continue
      const level = kv[2]
      if (!(THINKING_LEVELS as readonly string[]).includes(level)) continue
      /**
       * **必须复刻 `dsh-llm-pi-ai/lib/index.js:580-585` 的三种写法**，不能把 `null` 存进去：
       * ```js
       * if (wire === void 0) map[level] = null;      // 未声明 → null
       * else if (wire !== null) map[level] = wire;   // 声明非 null → 写入
       *                                              // 声明 null → **键不存在（undefined）**
       * ```
       * `openai-completions.js:670` 判的是 `thinkingLevelMap?.off !== null`：
       * 「声明 `off: null`」→ `undefined !== null` → **true → 发 disabled**；
       * 「完全没声明 off」→ `null` → **false → 不发**。存成 `null` 就把这两种情形混成一种了。
       */
      const wire = scalarOf(kv[3]) as string | null
      if (wire === null) continue
      model.thinkingLevelMap[level] = wire
      continue
    }
    if (model !== undefined && compatIndent >= 0 && indent > compatIndent) {
      const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/u.exec(body)
      if (kv !== null && compatTarget !== undefined) compatTarget[kv[1]] = scalarOf(kv[2])
      continue
    }
    const listId = /^-\s+id:\s*(.+)$/u.exec(body)
    if (listId !== null) {
      flushModel()
      model = { id: String(scalarOf(listId[1]) ?? ''), reasoning: false, thinkingLevelMap: {} }
      continue
    }
    if (model === undefined) continue
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/u.exec(body)
    if (kv === null) continue
    if (kv[1] === 'reasoningEfforts' && kv[2] === '') {
      effortsIndent = indent
      compatIndent = -1
    } else if (kv[1] === 'compat' && kv[2] === '') {
      model.compat ??= {}
      compatTarget = model.compat
      compatIndent = indent
      effortsIndent = -1
    }
  }
  flushProvider()
  for (const p of out) {
    for (const m of p.models.values()) {
      m.reasoning = Object.entries(m.thinkingLevelMap).some(([k, v]) => k !== 'off' && v !== null)
    }
  }
  return out
}

/** 一个模型条目的判定视图。 */
export interface ProviderMeta {
  provider: string
  baseURL?: string
  /** 该模型条目声明的 `compat`（模型级）。 */
  compat?: Record<string, unknown>
  /** 路由级 `compat`（provider 级）。 */
  routeCompat?: Record<string, unknown>
  /** `reasoningEfforts` 是否声明了至少一个非 off 档 → `model.reasoning`。 */
  reasoning: boolean
  /** 声明的档位 → wire 值。 */
  thinkingLevelMap: Record<string, string | null>
}

/**
 * 读 profile 目录下的全部配置文本（主文件在前、patch 在后，后者覆盖）。
 *
 * @param dshHome DSH 主目录
 */
export function profileConfigTexts(dshHome: string): string[] {
  const out: string[] = []
  let names: string[] = []
  try {
    names = readdirSync(join(dshHome, 'profiles'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'node_modules')
      .map((d) => d.name)
  } catch {
    return out
  }
  for (const name of names) {
    for (const file of ['cordis.yml', 'cordis.patch.yml']) {
      const p = join(dshHome, 'profiles', name, file)
      if (!existsSync(p)) continue
      try {
        out.push(readFileSync(p, 'utf8'))
      } catch {
        /* 读不了就当没这条 */
      }
    }
  }
  return out
}

/**
 * 取某 provider/model 的元信息。**读不到返回 `undefined`** —— 调用方必须退回保守值，不许猜。
 *
 * @param dshHome DSH 主目录
 * @param provider 路由名
 * @param model 模型 id
 * @param texts 配置文本（不给就自己读 `dshHome/profiles`）
 */
export function providerMetaOf(
  dshHome: string | undefined,
  provider: string,
  model: string,
  texts?: readonly string[],
): ProviderMeta | undefined {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const key = home + '\u0001' + provider + '\u0001' + model
  if (texts === undefined && META_CACHE.has(key)) return META_CACHE.get(key)
  let found: ProviderMeta | undefined
  for (const text of texts ?? profileConfigTexts(home)) {
    const route = parseProviderBlocks(text).find((p) => p.name === provider)
    const entry = route?.models.get(model)
    if (entry === undefined) continue
    found = {
      provider,
      ...(route?.baseURL === undefined ? {} : { baseURL: route.baseURL }),
      ...(entry.compat === undefined ? {} : { compat: entry.compat }),
      ...(route?.compat === undefined ? {} : { routeCompat: route.compat }),
      reasoning: entry.reasoning,
      thinkingLevelMap: entry.thinkingLevelMap,
    }
  }
  if (texts === undefined) META_CACHE.set(key, found)
  return found
}

const META_CACHE = new Map<string, ProviderMeta | undefined>()

/**
 * 读 profile 里 **agent 当前选择**的思考档位（`agent-default-model.config.reasoningEffort`）。
 *
 * ## 为什么需要它
 * 日志里 `request/header` 的 `reasoningEffort` 是**历史值**（每次请求时那个值）。
 * 而 **DSH 在线保温用的是 agent 的当前选择** —— 实测 `.tmp/spy-exp`：
 * 日志最后 6 条 header 的 effort 全是 `off`，而真实保温请求发的是 `reasoning_effort: "high"`，
 * 配置里正是 `agent-default-model.config.reasoningEffort: high`。
 *
 * 离线装配拿不到运行时对象，但**配置就是当前状态的快照**，读它比读历史 header 更接近真相。
 *
 * @param dshHome DSH 主目录
 * @param dshHome DSH 主目录（**第一参数**）
 * @param texts **配置文本列表**（`profileConfigTexts()` 的返回值），**不是 provider 名**。
 *   不传就自己读 `$DSH_HOME/profiles`。传它是为了测试时喂固定内容。
 * @returns 配置里的 effort；读不到返回 undefined（调用方回退到历史 header）
 */
export function currentReasoningEffortOf(dshHome: string | undefined, texts?: readonly string[]): string | undefined {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  /** 主文件在前、patch 在后 ⇒ 后者覆盖，所以**倒序遍历**取最后一个命中。 */
  const list = [...(texts ?? profileConfigTexts(home))].reverse()
  for (const text of list) {
    const found = agentDefaultModelBlock(text)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * 从一份 YAML 里抠出 `agent-default-model` 条目的 `config.reasoningEffort`。
 *
 * @param text YAML 全文
 */
function agentDefaultModelBlock(text: string): string | undefined {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^-?\s*id:\s*agent-default-model\s*$/u.test(lines[i].trim())) continue
    const baseIndent = lines[i].length - lines[i].trimStart().length
    let inConfig = false
    let configIndent = -1
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]
      if (line.trim() === '' || line.trim().startsWith('#')) continue
      const indent = line.length - line.trimStart().length
      /** 离开这个条目（回到同级或更浅的列表项）。 */
      if (indent <= baseIndent && /^-\s/u.test(line.trim())) break
      const body = line.trim()
      if (/^config:\s*$/u.test(body)) {
        inConfig = true
        configIndent = indent
        continue
      }
      /** 只在 `config:` 块内找 —— 否则会命中别的同名字段。 */
      if (!inConfig || indent <= configIndent) continue
      const m = /^reasoningEffort:\s*(.+)$/u.exec(body)
      if (m === null) continue
      const v = m[1].trim().replace(/^["']|["']$/gu, '')
      return v === '' ? undefined : v
    }
  }
  return undefined
}

/**
 * 判定 `instructionRole`（与 `openai-completions.js:896` 同构）。
 *
 * @param meta 配置推出的模型元信息
 */
export function instructionRoleOf(meta: ProviderMeta): 'system' | 'developer' {
  return meta.reasoning === true && supportsDeveloperRoleOf(meta) ? 'developer' : 'system'
}

/** `compat.supportsDeveloperRole`：显式声明优先，否则按 `detectCompat()` 推。 */
export function supportsDeveloperRoleOf(meta: ProviderMeta): boolean {
  const declared = meta.compat?.['supportsDeveloperRole']
  if (typeof declared === 'boolean') return declared
  const route = meta.routeCompat?.['supportsDeveloperRole']
  if (typeof route === 'boolean') return route
  return !isNonStandard(meta.provider, meta.baseURL ?? '')
}

/**
 * `openai-completions.js:1234-1261` 的名单（逐条对应）。
 * 命中任意一条 → `supportsDeveloperRole = false`。
 *
 * @param provider 路由名
 * @param baseURL 路由端点
 */
export function isNonStandard(provider: string, baseURL: string): boolean {
  const p = provider.toLowerCase()
  const u = baseURL
  return p === 'nvidia' || u.includes('integrate.api.nvidia.com')
    || p === 'cerebras' || u.includes('cerebras.ai')
    || p === 'xai' || u.includes('api.x.ai')
    || p === 'together' || u.includes('api.together.ai') || u.includes('api.together.xyz')
    || u.includes('chutes.ai')
    || p === 'deepseek' || u.toLowerCase().includes('deepseek.com')
    || p === 'zai' || p === 'zai-coding-cn' || u.includes('api.z.ai') || u.includes('open.bigmodel.cn')
    || p === 'moonshotai' || p === 'moonshotai-cn' || u.includes('api.moonshot.')
    || p === 'opencode' || u.includes('opencode.ai')
    || p === 'cloudflare-workers-ai' || u.includes('api.cloudflare.com')
    || p === 'cloudflare-ai-gateway' || u.includes('gateway.ai.cloudflare.com')
    || p === 'ant-ling' || u.includes('api.ant-ling.com')
}

/** `compat.thinkingFormat`：显式声明优先，否则只有 deepseek.com 端点算 `deepseek`。 */
export function thinkingFormatOf(meta: ProviderMeta): string | undefined {
  const declared = meta.compat?.['thinkingFormat']
  if (typeof declared === 'string') return declared
  const route = meta.routeCompat?.['thinkingFormat']
  if (typeof route === 'string') return route
  const u = (meta.baseURL ?? '').toLowerCase()
  return meta.provider === 'deepseek' || u.includes('deepseek.com') ? 'deepseek' : undefined
}

/** `compat.supportsReasoningEffort`（`openai-completions.js:1262`）。 */
export function supportsReasoningEffortOf(meta: ProviderMeta): boolean {
  const declared = meta.compat?.['supportsReasoningEffort']
  if (typeof declared === 'boolean') return declared
  const p = meta.provider.toLowerCase()
  const u = meta.baseURL ?? ''
  return !(p === 'xai' || u.includes('api.x.ai'))
    && !(p === 'zai' || p === 'zai-coding-cn' || u.includes('api.z.ai') || u.includes('open.bigmodel.cn'))
    && !(p === 'moonshotai' || p === 'moonshotai-cn' || u.includes('api.moonshot.'))
    && !(p === 'together' || u.includes('api.together'))
    && !(p === 'cloudflare-ai-gateway' || u.includes('gateway.ai.cloudflare.com'))
    && !(p === 'nvidia' || u.includes('integrate.api.nvidia.com'))
    && !(p === 'ant-ling' || u.includes('api.ant-ling.com'))
}

/**
 * `reasoningEffort` 值 → pi-ai 的档位。`''`（未声明）与 `'off'` 都归到 `'off'`。
 *
 * ⚠️ `dsh-llm-pi-ai/lib/index.js:1675`：`reasoning === "off" ? undefined : reasoning` ——
 * **`off` 被翻译成「不带 reasoning 选项」**，pi-ai 里 `options.reasoningEffort === undefined`。
 * 所以 `'off'` 走的是「没有 effort」那条分支，不发 `reasoning_effort`。
 *
 * @param effort 请求头里的 `reasoningEffort` 原值
 */
export function resolveLevel(effort: unknown): string {
  return typeof effort === 'string' && effort !== '' && effort !== 'off' ? effort : 'off'
}

/** 当前档位在 wire 上的参数（`openai-completions.js:666-677`）。 */
export interface ThinkingParams {
  thinking?: { type: 'enabled' | 'disabled' }
  reasoning_effort?: string
}

/**
 * `thinkingFormat === 'deepseek' && model.reasoning` 时真实请求会带的参数。
 *
 * ## off 的三值语义（**最容易写反的地方**）
 *
 * `dsh-llm-pi-ai/lib/index.js:580-585` 构造 `thinkingLevelMap` 时：
 * ```js
 * for (const level of THINKING_LEVELS) {
 *   const wire = efforts[level];
 *   if (wire === void 0) map[level] = null;      // 未声明 → null
 *   else if (wire !== null) map[level] = wire;   // 声明非 null → 写入
 *   // 声明 null → 什么都不做 ⇒ **键不存在（undefined）**
 * }
 * ```
 * 再看 `openai-completions.js:670` 的 `else if (model.thinkingLevelMap?.off !== null)`：
 *
 * | profile 写法 | `map.off` | `!== null` | 真实请求 |
 * |---|---|---|---|
 * | `off: null`（本机就是这样） | `undefined` | **true** | **发 `{type:'disabled'}`** |
 * | 完全不声明 `off` | `null` | false | **不发 thinking** |
 *
 * 所以「声明 `off: null` ⇒ 发 disabled」「完全不声明 off ⇒ 不发」——**与直觉相反**。
 * 40b9 实测确认：真实请求体顶层就是 `thinking: {type: 'disabled'}`。
 *
 * ## 有 effort 时
 * `thinking:{type:'enabled'}` + `reasoning_effort`（映射后的值）。
 *
 * @param meta 配置推出的模型元信息
 * @param effort 本次请求的思考档位（`config.reasoningEffort` 原值）
 * @returns 要合并进请求体的字段；该格式不适用时返回 `{}`
 */
export function thinkingParamsOf(meta: ProviderMeta, effort: unknown): ThinkingParams {
  if (meta.reasoning !== true) return {}
  if (thinkingFormatOf(meta) !== 'deepseek') return {}
  const level = resolveLevel(effort)
  if (level !== 'off') {
    const out: ThinkingParams = { thinking: { type: 'enabled' } }
    if (supportsReasoningEffortOf(meta)) {
      const mapped = meta.thinkingLevelMap[level]
      out.reasoning_effort = typeof mapped === 'string' ? mapped : level
    }
    return out
  }
  /**
   * off（或未声明 effort）：看 `map.off` 的**三种**取值。
   * 注意 `map` 里 `off: null` 的写法**不会**产生 `null` —— 见函数头注释。
   */
  if (meta.thinkingLevelMap['off'] !== null) return { thinking: { type: 'disabled' } }
  /** `map.off === null` 只可能是「profile 完全没声明 off」→ 源码那句不成立 → 不发。 */
  return {}
}

/**
 * 输出上限那个键叫什么（`openai-completions.js:1265`）。
 *
 * ```js
 * const useMaxTokens = baseUrl.includes("chutes.ai") || isDeepSeek || isMoonshot || …
 * maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens"
 * ```
 * `isDeepSeek` 看 **provider 名或 baseUrl 含 `deepseek.com`**（`:1233`）。
 *
 * ⚠️ **不许调用方硬编码**：这个键随 provider/端点变 —— 本机 tokenrhythm 实测发
 * `max_completion_tokens`，而 DeepSeek 官方端点发 `max_tokens`。写死任何一边，
 * 另一边的请求体就会多/少一个键，前缀从那里断开。
 *
 * @param meta 配置推出的模型元信息
 */
export function maxTokensFieldOf(meta: ProviderMeta): 'max_tokens' | 'max_completion_tokens' {
  const declared = meta.compat?.['maxTokensField']
  if (declared === 'max_tokens' || declared === 'max_completion_tokens') return declared
  const useMaxTokens = useMaxTokensOf(meta)
  return useMaxTokens ? 'max_tokens' : 'max_completion_tokens'
}

/** `detectCompat()` 里 `useMaxTokens` 的名单（`openai-completions.js:1240-1255`）。 */
function useMaxTokensOf(meta: ProviderMeta): boolean {
  const p = meta.provider.toLowerCase()
  const u = meta.baseURL ?? ''
  const isDeepSeek = p === 'deepseek' || u.toLowerCase().includes('deepseek.com')
  const isMoonshot = p === 'moonshotai' || p === 'moonshotai-cn' || u.includes('api.moonshot.')
  const isZai = p === 'zai' || p === 'zai-coding-cn' || u.includes('api.z.ai') || u.includes('open.bigmodel.cn')
  const isTogether = p === 'together' || u.includes('api.together.ai') || u.includes('api.together.xyz')
  const isNvidia = p === 'nvidia' || u.includes('integrate.api.nvidia.com')
  const isAntLing = p === 'ant-ling' || u.includes('api.ant-ling.com')
  const isCloudflareAiGateway = p === 'cloudflare-ai-gateway' || u.includes('gateway.ai.cloudflare.com')
  return u.includes('chutes.ai') || isDeepSeek || isMoonshot
    || isCloudflareAiGateway || isTogether || isNvidia || isAntLing || isZai
}
