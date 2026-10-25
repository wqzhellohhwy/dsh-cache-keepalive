/**
 * 读 DSH 附件库里的图片字节 —— 让离线保温**不再丢图片**。
 *
 * 图片块在会话日志里只留句柄（`attachment.attachmentId = sha256:…`），字节在
 * `$DSH_HOME/attachments/v1/objects/<hash 前 2 位>/<hash>`。
 * 以前装配把图片降级成一句占位文本，导致「从那条消息起之后的前缀全部失配」，
 * 含图片的会话只能整条拒绝保温。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ResolvedImage {
  mediaType: string
  /** 原始字节的 base64（不含 data URL 前缀）。 */
  base64: string
}

/** 从 `sha256:xxxx` 里取 hash。 */
function hashOf(attachmentId: string): string | undefined {
  const id = attachmentId.startsWith('sha256:') ? attachmentId.slice('sha256:'.length) : attachmentId
  return /^[0-9a-f]{8,128}$/iu.test(id) ? id.toLowerCase() : undefined
}

/**
 * 读一张图。读不到返回 undefined（调用方据此决定是降级还是拒绝）。
 *
 * @param dshHome DSH 主目录
 * @param attachmentId 日志里的句柄（`sha256:…`）
 * @param mediaType 日志里记录的媒体类型（读不到时按 png 兜底）
 */
export function readAttachment(
  dshHome: string | undefined,
  attachmentId: string | undefined,
  mediaType?: string,
): ResolvedImage | undefined {
  if (typeof attachmentId !== 'string' || attachmentId === '') return undefined
  const hash = hashOf(attachmentId)
  if (hash === undefined) return undefined
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const file = join(home, 'attachments', 'v1', 'objects', hash.slice(0, 2), hash)
  if (!existsSync(file)) return undefined
  try {
    const buf = readFileSync(file)
    if (buf.length === 0) return undefined
    return { mediaType: mediaType ?? 'image/png', base64: buf.toString('base64') }
  } catch {
    return undefined
  }
}
