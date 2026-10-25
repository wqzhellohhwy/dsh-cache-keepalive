/**
 * 前缀骤降判定（压缩 / 裁剪）。
 *
 * 曾经这里还有「保温间隔自适应」（`adaptInterval` + `ADAPT_MIN_MS` / `ADAPT_MAX_MS`），
 * 用户已要求删除该功能（`autoAdapt` 一并删掉）—— 间隔现在只由用户设定。
 * 判断这次保温的 prompt 是不是「骤降」——即会话被**压缩 / 裁剪**过。
 *
 * 压缩是一次 surface replace：整个前缀被换掉（实测压缩后首步命中率直接掉到 0~5%），
 * 所以旧账本里的命中率、连续次数**全部失去意义**——
 * 拿它继续判熔断会把一条好会话永久拉黑。
 *
 * 判据：这次 prompt 不到上次的一半。
 */
export function isCompactionDrop(prevPromptTokens: number, currentPromptTokens: number): boolean {
  if (prevPromptTokens <= 0 || currentPromptTokens <= 0) return false
  return currentPromptTokens < prevPromptTokens * 0.5
}
