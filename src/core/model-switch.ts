/**
 * 换模型检测 —— 相邻两次保温用的模型不同 = 换了一个**缓存池**，前缀必然全 miss。
 *
 * 为什么单独成文件：`tripVerdict`（`store.ts`）要判它，而 `store.ts` 不该反过来依赖门禁/面板层。
 * 这是纯函数，没有任何副作用，测试可以直接喂账本条目。
 *
 * 真实事故（会话 `1f64b53f`，本插件自己的会话）：
 * ```
 * #5 10-20 02:57  deepseek-flash              命中 99.93%
 * #6 10-22 03:32  deepseek-v4.1-flash-1017    命中  0.35%   ← 这里换了模型
 * ```
 * 换模型后命中率归零是**必然**的，不是「装配失真」。旧 `tripVerdict` 不知道模型变了，
 * 按「单次低命中且没新建缓存」判 `tripped` → 熔断，白花钱还停保。
 */
import type { LedgerEntry } from '../store.ts'

/**
 * 本次与上一次保温的模型是否不同。
 *
 * **三态固定**（任何一条都不能改，改了就是烧钱）：
 *  - `prev` 缺失（账本只有 1 条）→ `false`：没有对照物，零信息，不能豁免；
 *  - 任一侧 `model` 为 `undefined` / 空串（老账本没记这个字段）→ `false`：
 *    老数据里 `model` 普遍缺失，若把 undefined 当「不同」，等于给所有老会话永久豁免熔断；
 *  - 两侧都有值且**不相同** → `true`。
 */
export function modelChangedOf(prev: LedgerEntry | undefined, cur: LedgerEntry): boolean {
  if (prev === undefined) return false
  const a = prev.model
  const b = cur.model
  if (typeof a !== 'string' || a === '') return false
  if (typeof b !== 'string' || b === '') return false
  return a !== b
}
