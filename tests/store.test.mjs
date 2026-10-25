/**
 * 熔断判定（`store.isTripped`）—— 纯函数，直接构造 state 来测。
 *
 * 重点是两条**自动解除**通道：
 *   ① 用户之后真的用过这条会话（`lastActiveAt > 上次保温时刻`）
 *   ② **冷却到点**（距上次低命中 ≥ `settings.circuitCooldownSeconds`）
 * 缺 ② 会造成「一条旧记录永久拉黑」—— 这就是真机暴露的那个逻辑 bug。
 */
import { isTripped } from '../src/store.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = 1_791_900_000_000
const TH = 0.5 // BREAK_CIRCUIT_HIT_RATE

/** 造一个够用的最小 state。 */
function mkState(cooldownSeconds = 0) {
  return {
    version: 1,
    settings: { circuitCooldownSeconds: cooldownSeconds },
    sessions: {},
    ledger: {},
  }
}

/** 给某会话塞一条账本记录。 */
function withEntry(state, id, { at, hitRate }) {
  const hit = Math.round(hitRate * 10000)
  state.ledger[id] = [{
    at,
    gapSeconds: 30,
    promptTokens: 10000,
    hitTokens: hit,
    missTokens: 10000 - hit,
    outputTokens: 1,
    cost: 0.01,
    hitRate,
    ms: 500,
    touch: 1,
  }]
  return state
}

const cases = [
  ['无记录 → 不熔断',
    mkState(0), 'a', 0, T0, false],

  ['上次命中 90% → 不熔断',
    withEntry(mkState(0), 'a', { at: T0 - MIN, hitRate: 0.9 }), 'a', 0, T0, false],

  ['上次命中 30%、刚保完、冷却 0 → 熔断',
    withEntry(mkState(0), 'a', { at: T0 - MIN, hitRate: 0.3 }), 'a', 0, T0, true],

  ['上次命中 30%，但用户 5 分钟前聊过（通道①）→ 不熔断',
    withEntry(mkState(0), 'a', { at: T0 - 30 * MIN, hitRate: 0.3 }), 'a', T0 - 5 * MIN, T0, false],

  ['冷却 60s 且已过 120s（通道②）→ 不熔断',
    withEntry(mkState(60), 'a', { at: T0 - 120000, hitRate: 0.3 }), 'a', 0, T0, false],

  ['冷却 60s 但只过了 30s → 仍熔断',
    withEntry(mkState(60), 'a', { at: T0 - 30000, hitRate: 0.3 }), 'a', 0, T0, true],

  ['冷却 3600s，过了 3599s → 仍熔断（边界）',
    withEntry(mkState(3600), 'a', { at: T0 - 3599000, hitRate: 0.3 }), 'a', 0, T0, true],

  ['冷却 3600s，过了 3601s → 放行',
    withEntry(mkState(3600), 'a', { at: T0 - 3601000, hitRate: 0.3 }), 'a', 0, T0, false],

  ['冷却 0 → 永不自动恢复（只能手动 reset 或真实活动）',
    withEntry(mkState(0), 'a', { at: T0 - 100 * HOUR, hitRate: 0.05 }), 'a', 0, T0, true],

  ['命中 49.9%（低于阈值）→ 熔断',
    withEntry(mkState(0), 'a', { at: T0 - MIN, hitRate: 0.499 }), 'a', 0, T0, true],

  ['命中恰好 50% → 不熔断（阈值是"低于"才算）',
    withEntry(mkState(0), 'a', { at: T0 - MIN, hitRate: 0.5 }), 'a', 0, T0, false],

  ['多条记录只看最后一条（最后一条 100% → 不熔断）',
    (() => {
      const s = mkState(0)
      s.ledger.a = [
        { at: T0 - 10 * MIN, gapSeconds: 30, promptTokens: 1, hitTokens: 0, missTokens: 1, outputTokens: 1, cost: 0.01, hitRate: 0.1, ms: 1, touch: 1 },
        { at: T0 - MIN, gapSeconds: 30, promptTokens: 1, hitTokens: 1, missTokens: 0, outputTokens: 1, cost: 0.01, hitRate: 1.0, ms: 1, touch: 2 },
      ]
      return s
    })(), 'a', 0, T0, false],

  ['另一条会话的记录不影响本会话',
    (() => {
      const s = mkState(0)
      withEntry(s, 'b', { at: T0 - MIN, hitRate: 0.1 })
      return s
    })(), 'a', 0, T0, false],

  /**
   * **阈值必须真的参与判定**（第 7 个元素 = 本次用的阈值，缺省 `TH`）。
   *
   * 为什么单列两条：上面所有用例都传固定 0.5，如果 `isTripped` 里把 threshold 写死、
   * 或者压根不读它，`node --test` 依然全绿 —— 而设置里的熔断线是可改的（0.05~0.9）。
   * 同一份 60% 命中的账本，阈值 0.7 必须熔断、0.3 必须放行，这条差异就是「库真读了阈值」的证据。
   * （`check-guard` 的 ⑧ 能兜 CLI 侧，但兜不到「库本身忽略阈值」。）
   */
  ['阈值 0.7 + 命中 60% → 熔断（阈值真的参与判定）',
    withEntry(mkState(0), 'a', { at: T0 - MIN, hitRate: 0.6 }), 'a', 0, T0, true, 0.7],

  ['阈值 0.3 + 命中 60% → 不熔断（同一份账本，只换阈值）',
    withEntry(mkState(0), 'a', { at: T0 - MIN, hitRate: 0.6 }), 'a', 0, T0, false, 0.3],
]

let pass = 0
let fail = 0
for (const [name, state, id, lastActiveAt, now, want, th] of cases) {
  const got = isTripped(state, id, th ?? TH, lastActiveAt, now)
  if (got === want) {
    pass += 1
    console.log('PASS  ' + name)
  } else {
    fail += 1
    console.log('FAIL  ' + name + '   期望 ' + want + ' 实际 ' + got)
  }
}
console.log('\n通过 ' + pass + ' / ' + (pass + fail) + (fail === 0 ? '   ✅ 全绿' : '   ❌ 失败 ' + fail))
process.exit(fail === 0 ? 0 : 1)
