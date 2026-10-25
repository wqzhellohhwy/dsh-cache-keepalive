/**
 * 读 DSH 的 provider 配置（`profiles/<name>/cordis.yml` + `cordis.patch.yml` 的
 * `llm-pi-ai.config.providers`），让**离线保温也能认第三方供应商** ——
 * 以前只认 DeepSeek 官方，其它 provider 一律拒绝。
 *
 * ## 为什么不自己解析
 * 配置里除了 `baseURL` / `apiKeyEnv` / `api`，还有决定**真实请求长什么样**的两块：
 * `reasoningEfforts`（→ `model.reasoning`）与 `compat`（provider 级 + model 级）。
 * 这两块的解析逻辑只在 `provider-meta.ts` 里写一遍，本文件复用，不另起一套。
 * （两套解析必然分叉：`reasoningEfforts` 的 `off: null` 这种写法一处认一处不认，就会
 *  悄悄算出不同的 `instructionRole`。）
 *
 * Key 取自 `$DSH_HOME/.credentials.yaml` 的 `refs:` 段。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseProviderBlocks, type ParsedModel } from './provider-meta.ts'

export interface ProviderCfg {
  /** provider 名（会话日志 `request/header.config.provider` 里的那个）。 */
  name: string
  /** 协议：`openai-completions` / 其它（不认识就用 openai 兼容）。 */
  api: string
  baseURL: string
  apiKeyEnv?: string
  apiKey?: string
  /** provider 级 `compat`（model 级覆盖它）。 */
  compat?: Record<string, unknown>
  /** 按 model id 索引的条目：`reasoningEfforts` 与 model 级 `compat`。 */
  models?: Map<string, ParsedModel>
}

function readCreds(dshHome: string): Record<string, string> {
  const out: Record<string, string> = {}
  const file = join(dshHome, '.credentials.yaml')
  if (!existsSync(file)) return out
  try {
    const text = readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      const m = /^\s{2}([A-Z0-9_]+):\s*(.+?)\s*$/u.exec(line)
      if (m !== null) out[m[1]] = m[2].replace(/^["']|["']$/gu, '')
    }
  } catch {
    /* 凭据读不了就当没有 */
  }
  return out
}

/**
 * 从一份 YAML 文本里抠出 providers 表（解析在 `provider-meta.ts`，这里只挑字段）。
 *
 * @param text cordis.yml / cordis.patch.yml 全文
 * @returns 只含配了 `baseURL` 的 provider（没 baseURL 的用不了）
 */
export function parseProviders(text: string): ProviderCfg[] {
  const out: ProviderCfg[] = []
  for (const p of parseProviderBlocks(text)) {
    if (p.baseURL === undefined || p.baseURL === '') continue
    out.push({
      name: p.name,
      api: p.api ?? 'openai-completions',
      baseURL: p.baseURL,
      ...(p.apiKeyEnv === undefined ? {} : { apiKeyEnv: p.apiKeyEnv }),
      ...(p.compat === undefined ? {} : { compat: p.compat }),
      models: p.models,
    })
  }
  return out
}

/**
 * 读出所有可用 provider（同名以**先读到的**为准；profile 覆盖顺序里 patch 优先）。
 * 读不到就返回空表 —— 调用方据此退回 DeepSeek 官方路径。
 *
 * @param dshHome DSH 主目录
 */
export function loadProviders(dshHome?: string): Map<string, ProviderCfg> {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const creds = readCreds(home)
  const map = new Map<string, ProviderCfg>()
  const profiles = join(home, 'profiles')
  let names: string[] = []
  try {
    names = readdirSync(profiles, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'node_modules')
      .map((d) => d.name)
  } catch {
    return map
  }
  for (const name of names) {
    for (const file of ['cordis.patch.yml', 'cordis.yml']) {
      const p = join(profiles, name, file)
      if (!existsSync(p)) continue
      let text = ''
      try {
        text = readFileSync(p, 'utf8')
      } catch {
        continue
      }
      for (const cfg of parseProviders(text)) {
        if (map.has(cfg.name)) continue
        map.set(cfg.name, {
          ...cfg,
          ...(cfg.apiKeyEnv !== undefined && creds[cfg.apiKeyEnv] !== undefined ? { apiKey: creds[cfg.apiKeyEnv] } : {}),
        })
      }
    }
  }
  return map
}

/**
 * **provider / model 目录** —— 面板「模型价表」的 provider、model 两个下拉框用它。
 *
 * ## 离线版（CLI / 没装插件的实例）
 * 扫 `$DSH_HOME/profiles/<name>/cordis.yml` + `cordis.patch.yml`，取出 `llm-pi-ai` 路由的
 * provider 与它的 models，合并成一份目录。**用户主要用离线版**，所以这条必须走通。
 *
 * ## 在线版（插件宿主）
 * `src/index.ts` 会先用 `ctx.llm.listProviders()` / `listModels()`（运行时枚举，能覆盖官方适配器），
 * 失败或为空再回退到本函数（= title-fix 的 `modelsOf` 同一套两级策略）。
 *
 * @param dshHome DSH 主目录
 * @returns 按 provider 名排序的目录；读不到就是空数组
 */
export function loadModelCatalog(dshHome?: string): { provider: string; models: string[] }[] {
  const map = new Map<string, Set<string>>()
  for (const cfg of loadProviders(dshHome).values()) {
    if (cfg.models === undefined) continue
    const set = map.get(cfg.name) ?? new Set<string>()
    for (const id of cfg.models.keys()) if (id !== '') set.add(id)
    if (set.size > 0) map.set(cfg.name, set)
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([provider, models]) => ({ provider, models: [...models].sort((a, b) => a.localeCompare(b)) }))
}

/**
 * **合并「离线配置目录」与「在线运行时目录」** —— 纯函数，方便测。
 *
 * 规则（用户实测校正后定）：
 * 1. **离线先铺底**：`loadModelCatalog()` 扫 profile 配置，面更全
 *    （实测 3084：在线只认出 2 个，配置里有 6 个 —— tokenrhythm 系列全在 patch 层）
 * 2. **在线覆盖同名**：运行时列举更准，能反映官方适配器的真实模型表
 * 3. **在线独有的 provider 也加进来**
 *
 * ⚠️ **不要写成「在线有结果就 return」** —— 那会把配置里的路由全丢掉。
 *
 * @param offline 配置目录
 * @param online 运行时目录（列举失败的 provider 传空数组即可，会被跳过）
 * @returns 按 provider 名排序的合并目录
 */
export function mergeModelCatalog(
  offline: readonly { provider: string; models: readonly string[] }[],
  online: readonly { provider: string; models: readonly string[] }[],
): { provider: string; models: string[] }[] {
  const merged = new Map<string, Set<string>>()
  for (const { provider, models } of offline) {
    if (provider === '') continue
    merged.set(provider, new Set(models))
  }
  for (const { provider, models } of online) {
    /** 空列表 = 该 provider 列举失败 ⇒ 保留离线那份。 */
    if (provider === '' || models.length === 0) continue
    merged.set(provider, new Set(models))
  }
  return [...merged.entries()]
    .map(([provider, set]) => ({ provider, models: [...set].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.provider.localeCompare(b.provider))
}
