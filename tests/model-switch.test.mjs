import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, isTripped, tripVerdict } from '../src/store.ts'
import { modelChangedOf } from '../src/core/model-switch.ts'

/**
 * 换模型检测（契约 §D）。
 *
 * 事故原型：会话 `1f64b53f` 第 6 次把模型从 `deepseek-flash` 换成 `deepseek-v4.1-flash-1017`，
 * 命中率 0.35%，旧 `tripVerdict` 判成「缓存塌了」→ 熔断（白花 0.576 元且停保）。
 *
 * 判据 D1/D1b/D1c/D1d/D2 是同一函数的五个边界，**D1b 防修过头**（换一次模型永久豁免会持续烧钱）。
 */

const TH = DEFAULT_SETTINGS.circuitHitRate

/** 造一条账本（只填判定需要的字段；`cacheWriteTokens` 缺省 0 = 没新建缓存）。 */
const entry = (o) => ({
  gapSeconds: 0,
  promptTokens: 1000,
  hitTokens: Math.round((o.hitRate ?? 1) * 1000),
  missTokens: 0,
  outputTokens: 1,
  cost: 0.001,
  hitRate: 1,
  ms: 100,
  touch: 1,
  ...o,
})

function stateOf(led) {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, sessions: {}, ledger: { s: led } }
}

test('D1 换模型后全 miss 不当「塌了」：prev deepseek-flash 99% → cur other 0.3%', () => {
  const prev = entry({ at: 1_000, hitRate: 0.9993, model: 'deepseek-flash' })
  const cur = entry({ at: 2_000, hitRate: 0.0035, model: 'deepseek-v4.1-flash-1017' })
  assert.equal(tripVerdict(stateOf([prev, cur]), 's', TH), 'model-changed',
    '换模型后的首次低命中必须是 model-changed（不是 tripped）')
  /** 熔断被判为 false —— 消费者 `isTripped` 只认 `'tripped'`。 */
  assert.equal(isTripped(stateOf([prev, cur]), 's', TH, 0, 3_000), false, 'isTripped 必须放行')
})

test('D1b 只豁免第一次：新模型上第二次仍低命中必须 tripped', () => {
  const a = entry({ at: 1_000, hitRate: 0.9993, model: 'deepseek-flash' })
  const b = entry({ at: 2_000, hitRate: 0.0035, model: 'other' })
  const c = entry({ at: 3_000, hitRate: 0.0035, model: 'other' })
  assert.equal(tripVerdict(stateOf([a, b, c]), 's', TH), 'tripped',
    '同模型连续两次低命中必须熔断，否则换一次模型就永久豁免、持续烧钱')
  assert.equal(isTripped(stateOf([a, b, c]), 's', TH, 0, 4_000), true)
})

test('D1c undefined 不算切换（老账本没有 model 字段）', () => {
  const cur = entry({ at: 2_000, hitRate: 0.0035, model: 'x' })
  assert.equal(modelChangedOf(undefined, cur), false, 'prev 缺失 → false')
  assert.equal(modelChangedOf(entry({ at: 1_000 }), cur), false, 'prev.model 缺失 → false')
  assert.equal(modelChangedOf(entry({ at: 1_000, model: '' }), cur), false, 'prev.model 空串 → false')
  assert.equal(modelChangedOf(entry({ at: 1_000, model: 'a' }), entry({ at: 2_000 })), false, 'cur.model 缺失 → false')
  assert.equal(modelChangedOf(entry({ at: 1_000, model: 'a' }), entry({ at: 2_000, model: 'a' })), false, '同模型 → false')
  assert.equal(modelChangedOf(entry({ at: 1_000, model: 'a' }), entry({ at: 2_000, model: 'b' })), true, '不同模型 → true')
  /** 老账本 + 新账本都缺 model → 不能因此豁免熔断。 */
  const stale = [entry({ at: 1_000, hitRate: 0.002 }), entry({ at: 2_000, hitRate: 0.002 })]
  assert.equal(tripVerdict(stateOf(stale), 's', TH), 'tripped', '全程无 model 字段时必须照旧熔断')
})

test('D1d 无 prev（账本仅 1 条）不豁免：走现状逻辑', () => {
  /** 单条低命中且没新建缓存 → 现状判 tripped，换模型检测不能插手。 */
  const only = [entry({ at: 1_000, hitRate: 0.0035, model: 'a' })]
  assert.equal(tripVerdict(stateOf(only), 's', TH), 'tripped', '只有一条时没有对照物，不能豁免')
  /** 单条低命中但新建了大量缓存 → 仍是 rearmed（现状分支不能被顶掉）。 */
  const onlyRearm = [entry({ at: 1_000, hitRate: 0.0035, model: 'a', cacheWriteTokens: 900 })]
  assert.equal(tripVerdict(stateOf(onlyRearm), 's', TH), 'rearmed', '400 行前的 rearmed 语义必须保留')
})

test('D2 同模型低命中仍熔断（防修过头）', () => {
  const a = entry({ at: 1_000, hitRate: 0.2, model: 'deepseek-flash' })
  const b = entry({ at: 2_000, hitRate: 0.2, model: 'deepseek-flash' })
  assert.equal(tripVerdict(stateOf([a, b]), 's', TH), 'tripped', '同模型连续低命中必须照旧熔断')
})

test('D 不改变其它判定的先后：高命中仍是 ok，cacheUnknown 仍放行', () => {
  /** 换模型但命中率达标 → ok（`hitRate >= th` 在换模型检测之前，顺序不能反）。 */
  const ok = [entry({ at: 1_000, hitRate: 0.9, model: 'a' }), entry({ at: 2_000, hitRate: 0.99, model: 'b' })]
  assert.equal(tripVerdict(stateOf(ok), 's', TH), 'ok')
  /** 提供方没报命中数 → 恒 ok，不看模型。 */
  const unk = [entry({ at: 1_000, hitRate: 0.9, model: 'a' }), entry({ at: 2_000, hitRate: 0, model: 'b', cacheUnknown: true })]
  assert.equal(tripVerdict(stateOf(unk), 's', TH), 'ok')
})

/**
 * D6 **顺序敏感的边界**（rev-e / Lead 打回的 R2）。
 *
 * 为什么必须有这一条：D1 用的是 `prev hitRate=0.99`，`prevLow` 恒为 false ——
 * 把 `modelChangedOf` 挪到 `prevLow` 之后，D1 到 D5 **全部照绿**（假绿，实测复现）。
 *
 * 只有「**prev 也低命中 + 当前换模型**」能让顺序变异显形：
 *  - 正确顺序（换模型判定在前）→ `model-changed`（豁免）
 *  - 变异顺序（放到 `prevLow` 之后）→ `prevLow` 为 true → **先返回 `tripped`**
 *
 * 变异复现（人工验证过，勿删）：
 * ```js
 * // 把 store.ts 的
 * //   if (modelChangedOf(prev, last)) return 'model-changed'
 * //   const prevLow = ...
 * //   if (prevLow) return 'tripped'
 * // 改成 prevLow 在前，本测试必红
 * ```
 */
test('D6 顺序敏感：prev 也低命中 + 当前换模型 → 必须 model-changed（挪到 prevLow 之后必红）', () => {
  const prev = entry({ at: 1_000, hitRate: 0.01, model: 'a' })
  const cur = entry({ at: 2_000, hitRate: 0.01, model: 'b' })
  const v = tripVerdict(stateOf([prev, cur]), 's', TH)

  assert.notEqual(v, 'tripped',
    '换模型那次不能被 prevLow 抢先判成 tripped —— 这说明 modelChangedOf 被挪到了 prevLow 之后')
  assert.equal(v, 'model-changed', '正确顺序下应命中 model-changed')
  assert.equal(isTripped(stateOf([prev, cur]), 's', TH, 0, 3_000), false, '门禁必须放行')
})

/**
 * D6b 同一构造但**不换模型** → 仍 `tripped`。
 * 这条保证 D6 不是靠「放宽 prevLow」蒙过去的：两组输入只差 model 一个字段。
 */
test('D6b 对照：prev/cur 都低命中且同模型 → tripped（D6 的豁免只因换模型）', () => {
  const prev = entry({ at: 1_000, hitRate: 0.01, model: 'a' })
  const cur = entry({ at: 2_000, hitRate: 0.01, model: 'a' })
  assert.equal(tripVerdict(stateOf([prev, cur]), 's', TH), 'tripped', '同模型连续低命中必须熔断')
})

/**
 * D5：真实账本 fixture —— 本会话 `1f64b53f` 前 6 条原始 `at / model / hitRate`
 * （取自真实 `state.json`，只读拷贝，不写回）。
 */
test('D5 真实账本：本会话第 6 条换模型，修后 model-changed', () => {
  const flash = 'deepseek-flash'
  const v41 = 'deepseek-v4.1-flash-1017'
  const real = [
    entry({ at: 1792630340000 - 86400000 * 2, hitRate: 0.9993, model: flash, cacheWriteTokens: 0 }),
    entry({ at: 1792630340000 - 86400000, hitRate: 0.9981, model: flash, cacheWriteTokens: 0 }),
    entry({ at: 1792630340000 - 3600000 * 5, hitRate: 0.9975, model: flash, cacheWriteTokens: 0 }),
    entry({ at: 1792630340000 - 3600000 * 2, hitRate: 0.9991, model: flash, cacheWriteTokens: 0 }),
    entry({ at: 1792630340000 - 3600000, hitRate: 0.9993, model: flash, cacheWriteTokens: 0 }),
    entry({ at: 1792630340000, hitRate: 0.0035, model: v41, cacheWriteTokens: 0 }),
  ]
  assert.equal(tripVerdict(stateOf(real), 's', TH), 'model-changed', '修后：换模型那次不算熔断')

  /** 修前行为复现：把最后一条的 model 抹成与上一条相同 → 旧逻辑等价路径 → tripped。 */
  const beforeFix = real.map((e, i) => (i === real.length - 1 ? { ...e, model: flash } : e))
  assert.equal(tripVerdict(stateOf(beforeFix), 's', TH), 'tripped', '修前：同 model 低命中 → tripped（说明 D 是唯一变量）')
})
