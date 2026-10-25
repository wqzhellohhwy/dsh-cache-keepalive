/**
 * **前缀指纹**：把「system/tools + 前若干条消息」压成一个短哈希，用来判断
 * 「两次保温之间缓存锚点有没有被改写」。
 *
 * 为什么单独一个文件（零依赖）：`src/keepalive.ts` 依赖 `@deepseek-ai/dsh-llm`，
 * 而 **独立 CLI 不能引入任何 DSH 包**（脱离 DSH 的设计），但两边算的必须是**同一个指纹** ——
 * 算法放这里，插件与 CLI 都 import 它，从根上杜绝「两处各算一套」（D1 那类双路径分叉）。
 */
import { createHash } from 'node:crypto'
import { WIRE_SERIALIZE_VERSION } from './wire-openai.ts'

/**
 * 参与指纹的前 8 条消息。
 *
 * 实测落在 messages[3] 的运行时上下文快照（messages[0] 系统提示、[1] 用户首条、
 * [2] workspace 提示、[3] 「当前 dsh 实例… pid …」、[4] 技能清单）。
 * 前 8 条足以覆盖它；**不要**把它调小到 2 以下，否则实例变化就检测不到了。
 */
export const PREFIX_HEAD_MESSAGES = 8

/**
 * 指纹格式版本前缀。
 *
 * ## 为什么需要
 * `prefixStale` 的判据是「`prevFp !== 当前指纹`」。**序列化口径一变**（例如第 0 条 role
 * 从 `system` 改成 `developer`、或 `content` 从块数组改成字符串），所有历史账本里的旧指纹
 * 都会与新版对不上 → 每条有保温记录的会话都被判「前缀已变」→ 暂停保温。
 *
 * 而真正停保的是「上次保温之后没有真实活动」的那些 —— **正是纯靠保温续命的闲置会话**，
 * 也就是本插件存在的全部理由。所以不能接受这个副作用。
 *
 * ## 做法
 * 指纹带版本前缀，判定时**只跟同版本的指纹比**。旧账本里的低版本/无前缀指纹 → 自动豁免。
 * 代价是「升级那一次不做跨版本比较」，换来零停保、零迁移。
 *
 * ## 版本历史
 * - `2:` — v6：第 0 条 role 从 `system` 改为 `developer`
 * - `3:` — v7（E1）：`content` 形态从块数组改为字符串（带 `tool_calls` 的 assistant 为 `null`）
 *
 * ⚠️ **这是一次性机制**：以后真正改了前缀口径，要把版本号 +1 再来一次。
 * 更根本的做法是让保温请求与真实请求逐字节一致 —— 版本号只是「口径迁移」那个瞬间的护栏。
 */
/**
 * 指纹**结构**版本（前缀取值的含义变了吗）。
 *
 * - `1` — 最初的 16 位裸 sha1
 * - `2` — 开始带版本前缀
 * - `3` — 加入 `WIRE_SERIALIZE_VERSION` 段（下列内容与序列化口径解耦）
 *
 * 改「参与指纹的输入」时 +1。
 */
export const FINGERPRINT_VERSION = '3'

/**
 * 指纹是否属于当前版本（旧账本的无前缀值、低版本值都返回 false → 自动豁免）。
 *
 * @param fp 账本里的指纹
 */
/** 指纹是否属于当前版本（旧账本的无前缀值返回 false）。 */
export function isCurrentFingerprint(fp: string | undefined): boolean {
  return typeof fp === 'string' && fp.startsWith(FINGERPRINT_VERSION + ':' + WIRE_SERIALIZE_VERSION + ':')
}


/**
 * 前缀指纹。
 *
 * ⚠️ **不要把 role 从输入里剔除**来绕过版本迁移 —— 指纹的语义是「这段前缀的字节有没有变」，
 * role 变了前缀字节就真变了，剔除它等于让系统在「前缀已经不同」时认为「相同」，
 * 本该暂停的会话会继续花钱。
 *
 * @param parts 工具声明 + 消息序列
 * @returns `<指纹版本>:<序列化版本>:<16 位十六进制>`
 */
export function fingerprintOf(parts: {
  tools?: unknown
  messages: readonly unknown[]
}): string {
  const h = createHash('sha1')
  h.update(JSON.stringify(parts.tools ?? null))
  h.update('\u0000')
  h.update(JSON.stringify(parts.messages.slice(0, PREFIX_HEAD_MESSAGES)))
  return FINGERPRINT_VERSION + ':' + WIRE_SERIALIZE_VERSION + ':' + h.digest('hex').slice(0, 16)
}

