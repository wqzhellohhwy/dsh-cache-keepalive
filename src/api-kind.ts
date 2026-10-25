/**
 * **协议判定** —— 保温请求该按哪种 API 发。
 *
 * ## 为什么需要它
 * `warm-offline.ts` 原先是「第三方 → `/chat/completions`，否则 → `/v1/messages`」的二分。
 * 那个二分把两件事混在一起：**谁是供应商** 和 **说哪种协议**。
 * 实际上同一家供应商可以只开 Anthropic 端点（`api.deepseek.com/anthropic`），
 * 第三方也可以开 OpenAI Responses 端点。所以判定必须按 **provider 配置里声明的 `api` 字段**。
 *
 * ## 判定顺序（越靠前越可信）
 * 1. `apiHint` 直接命中三种之一 —— 配置说了算
 * 2. `apiHint` 是已知的别名（`openai` / `anthropic` 等）—— 按别名归类
 * 3. baseURL 含 `anthropic` —— 端点自曝身份
 * 4. `/responses` 在 baseURL 里 —— 端点自曝身份
 * 5. baseURL 含 `/v1` 且 provider 像第三方（`isNonStandard` 的反面）—— OpenAI 兼容网关
 * 6. 其余 → `anthropic-messages`（保持旧默认，DeepSeek 官方走这条）
 */
import { isNonStandard } from './core/provider-meta.ts'

/** 三种 wire 协议。名字与 DSH `pi-ai` 的 `api` 字段一致。 */
export type ApiKind = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

/** 三种合法取值的快速集合。 */
const KINDS: readonly ApiKind[] = ['openai-completions', 'openai-responses', 'anthropic-messages']

/**
 * 配置里可能出现的**别名** → 归一后的协议。
 *
 * pi-ai 只认上面三个名字，但用户/profile 里可能写 `openai`、`anthropic` 这类简写；
 * 把它们也认下来，避免「写了个合理名字却被当成未知而回退」。
 */
const ALIASES: Record<string, ApiKind> = {
  openai: 'openai-completions',
  'openai-chat': 'openai-completions',
  'openai-chat-completions': 'openai-completions',
  'chat-completions': 'openai-completions',
  completions: 'openai-completions',
  'azure-openai': 'openai-completions',
  responses: 'openai-responses',
  'openai-response': 'openai-responses',
  anthropic: 'anthropic-messages',
  'anthropic-message': 'anthropic-messages',
  messages: 'anthropic-messages',
  claude: 'anthropic-messages',
}

/**
 * 判定 provider 该走哪种协议。
 *
 * @param provider 路由名（会话日志 `request/header.config.provider`）
 * @param baseURL 路由端点
 * @param apiHint provider 配置里的 `api` 字段（可缺省）
 */
export function apiKindOf(provider: string, baseURL: string, apiHint?: string): ApiKind {
  const hint = (apiHint ?? '').trim().toLowerCase()
  if (hint !== '') {
    if ((KINDS as readonly string[]).includes(hint)) return hint as ApiKind
    const alias = ALIASES[hint]
    if (alias !== undefined) return alias
  }

  const u = (baseURL ?? '').toLowerCase()
  /** 端点自曝身份优先于 `/v1` 那条启发式（`/v1/messages` 也是 `/v1`）。 */
  if (u.includes('anthropic')) return 'anthropic-messages'
  if (u.includes('/responses')) return 'openai-responses'
  /**
   * `/v1` + 非标准供应商 ⇒ OpenAI 兼容网关。
   * `isNonStandard` 是 pi-ai `detectCompat()` 的名单口径，这里用它的反面，
   * 保证「谁算第三方」与 `supportsDeveloperRole` 的判定是同一套标准。
   */
  if (u.includes('/v1') && !isNonStandard(provider, baseURL)) return 'openai-completions'
  return 'anthropic-messages'
}

/** 该协议的 `baseURL` 之后要拼的路径。 */
export function endpointPathOf(kind: ApiKind): string {
  switch (kind) {
    case 'openai-completions': return '/chat/completions'
    case 'openai-responses': return '/responses'
    case 'anthropic-messages': return '/v1/messages'
  }
}
