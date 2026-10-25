/**
 * 门禁单元测试 —— 不需要网络、不花钱、不碰真实会话。
 * 跑法：node --test tests/gate.test.mjs
 *
 * 时间口径：闲置上限 `idleLimitMs`（默认 8 小时）一条线管「从未保过」与「保过」两种情况；
 * 保温间隔 `intervalMs`（4 小时）只管节奏，**不参与门槛计算**。
 */
import { decideWarm } from '../src/gate.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = 1_000 * HOUR // 固定"现在"

/** 默认：一切正常，可以保温。 */
function base(over = {}) {
  return {
    now: T0,
    agentStatus: 'idle',
    lastActivityAt: T0 - 3 * MIN, // 3 分钟前刚活动
    lastTouchAt: 0,
    touchCount: 0,
    touchCountTotal: 0,
    cumulativeCost: 0,
    tripped: false,
    hasRoute: true,
    intervalMs: 4 * HOUR,
    idleLimitMs: 8 * HOUR,
    freshMs: 5 * MIN,
    maxTouches: 9,
    maxTouchesTotal: 0,
    budget: 0.5,
    ...over,
  }
}

const cases = [
  // ── 放行 ───────────────────────────────────────────────────────────
  ['★ 从未保过 + 距对话 4h30m（过了间隔、未到上限）→ 放行',
    base({ lastActivityAt: T0 - 4.5 * HOUR }), true, null],
  ['★ 从未保过 + 距对话 3 分钟（未到间隔）→ 等一会儿（too-soon）',
    base(), false, 'too-soon'],
  ['★ 从未保过 + 距对话 3h59m（差 1 分钟到间隔）→ too-soon',
    base({ lastActivityAt: T0 - (4 * HOUR - MIN) }), false, 'too-soon'],
  ['★ 从未保过 + 距对话 5h → 放行',
    base({ lastActivityAt: T0 - 5 * HOUR }), true, null],

  ['★ 会话正在跑回合也放行（running 拦截已删除）',
    base({ agentStatus: 'running', lastActivityAt: T0 - 4.5 * HOUR }), true, null],

  ['running + 保过、距最后刷新 4h30m（过间隔、未超闲置上限）→ 放行',
    base({ agentStatus: 'running', lastTouchAt: T0 - 4.5 * HOUR, lastActivityAt: T0 - 4.5 * HOUR, touchCount: 1 }),
    true, null],

  ['★ 网页版延后 2 分钟：距对话 4h01m + delay 2min → too-soon',
    base({ lastActivityAt: T0 - (4 * HOUR + MIN), delayMs: 120000 }), false, 'too-soon'],
  ['★ 网页版延后 2 分钟：距对话 4h05m + delay 2min → 放行',
    base({ lastActivityAt: T0 - (4 * HOUR + 5 * MIN), delayMs: 120000 }), true, null],
  ['★ 插件版不延后：距对话 4h01m + 无 delay → 放行',
    base({ lastActivityAt: T0 - (4 * HOUR + MIN) }), true, null],
  ['★ 从未保过 + 闲置 7h59m（门槛 8h）→ 放行（还没到线）',
    base({ lastActivityAt: T0 - (8 * HOUR - MIN) }), true, null],

  ['保过 + 距最后刷新 4h30m（刚过间隔 4h、远未到 8h 门槛）→ 放行',
    base({ lastTouchAt: T0 - 4.5 * HOUR, lastActivityAt: T0 - 4.5 * HOUR, touchCount: 2 }), true, null],

  // ★ 旧实现把门槛写成 `max(断档上限, 间隔 + 30 分钟)`，会在 4.5h 就判 stale，
  //   于是「闲置上限 8 小时」对保过的会话根本不起作用。新实现必须放行。
  ['★ 门槛不被间隔截断：闲置上限 8h、间隔 4h、距最后刷新 7h → 放行（旧实现会判 stale）',
    base({ lastTouchAt: T0 - 7 * HOUR, lastActivityAt: T0 - 7 * HOUR, touchCount: 2 }), true, null],

  ['保过 + 上次保温 7h 前、用户 3 分钟前刚聊过 → 等一个间隔(too-soon)，不判 stale',
    base({ lastTouchAt: T0 - 7 * HOUR, lastActivityAt: T0 - 3 * MIN, touchCount: 2 }), false, 'too-soon'],

  ['保过 + 上次保温 7h 前、用户 4.2h 前聊过 → 放行（刷新点已过间隔、未到门槛）',
    base({ lastTouchAt: T0 - 7 * HOUR, lastActivityAt: T0 - 4.2 * HOUR, touchCount: 2 }), true, null],

  // ── 拦截 ───────────────────────────────────────────────────────────
  ['★ 已归档 → 拦',
    base({ archived: true }), false, 'archived'],

  ['★ 优先级：归档高于熔断（同时 archived + tripped + 无路由）',
    base({ archived: true, tripped: true, hasRoute: false }), false, 'archived'],

  ['没有路由过任何请求 → 拦',
    base({ hasRoute: false }), false, 'no-route'],

  ['已熔断 → 拦',
    base({ tripped: true }), false, 'tripped'],

  ['优先级：tripped 高于 cold-window',
    base({ tripped: true, lastActivityAt: 0 }), false, 'tripped'],

  ['★ 从未保过 + 闲置 8h01m（门槛 8h）→ 拦（刚过线）',
    base({ lastActivityAt: T0 - (8 * HOUR + MIN) }), false, 'cold-window-idle'],

  // ★ 真机暴露的漏洞：插件启动时 Map 是空的，老会话活动时间 = 未知(0)。必须「未知即不发」。
  ['从未保过 + 活动时间未知(0) → 拦（无法确认还热，保守不发）',
    base({ lastActivityAt: 0 }), false, 'cold-window'],

  ['保过 + 会话刚活动过 3 分钟 → 拦（真实请求已刷新缓存，无需保温）',
    base({ lastTouchAt: T0 - 5 * HOUR, lastActivityAt: T0 - 3 * MIN, touchCount: 1 }),
    false, 'too-soon'],

  ['★ 保过 + 距最后刷新 3h59m（间隔 4h）→ 拦（未到点）',
    base({ lastTouchAt: T0 - (4 * HOUR - MIN), lastActivityAt: T0 - (4 * HOUR - MIN), touchCount: 2 }),
    false, 'too-soon'],

  // 实测反例：同一会话保过（命中 99.9%），5.5 小时后再保命中 **0%**，白烧 0.2759 元。
  ['★ 保过 + 距最后刷新 8h30m（超闲置上限）→ 拦 stale',
    base({ lastTouchAt: T0 - 8.5 * HOUR, lastActivityAt: T0 - 8.5 * HOUR, touchCount: 2 }),
    false, 'stale'],

  // ★ 变异杀手：只有 `intervalMs + 30m > idleLimitMs` 时，`max(idleLimitMs, intervalMs+30m)` 才与 `idleLimitMs` 分叉。
  //   这里取「间隔 8h / 门槛 8h / 距刷新 8h10m」：真实实现判 stale；
  //   若有人把判据改回掺间隔的 `max(8h, 8h30m)`，8h10m 就会被判 warm → 本条必须 FAIL。
  ['★ 门槛不掺间隔（变异杀手）：间隔 8h、闲置上限 8h、距最后刷新 8h10m → 拦 stale',
    base({ intervalMs: 8 * HOUR, idleLimitMs: 8 * HOUR, lastTouchAt: T0 - (8 * HOUR + 10 * MIN), lastActivityAt: T0 - (8 * HOUR + 10 * MIN), touchCount: 2 }),
    false, 'stale'],

  ['连续保温 9 次（上限 9）→ 拦',
    base({ lastTouchAt: T0 - 5 * HOUR, lastActivityAt: T0 - 5 * HOUR, touchCount: 9 }),
    false, 'max-touches'],

  ['累计保温 20 次（上限 20）→ 拦',
    base({ lastTouchAt: T0 - 5 * HOUR, lastActivityAt: T0 - 5 * HOUR, touchCount: 1, touchCountTotal: 20, maxTouchesTotal: 20 }),
    false, 'max-touches-total'],

  ['累计花费 0.5 元（上限 0.5）→ 拦',
    base({ lastTouchAt: T0 - 5 * HOUR, lastActivityAt: T0 - 5 * HOUR, touchCount: 2, cumulativeCost: 0.5 }),
    false, 'budget'],

  // ── 终局优先（上限类判据必须先于 fresh / too-soon）────────────────
  // ★ 变异杀手：把这三条判据挪回 too-soon 之后，这三条会依次返回 fresh → FAIL。
  ['★ 终局优先：刚保过 1 分钟（在 fresh 窗口内）但已超预算 → budget 而非 fresh',
    base({ lastTouchAt: T0 - MIN, lastActivityAt: T0 - MIN, touchCount: 1, cumulativeCost: 0.5 }),
    false, 'budget'],

  ['★ 终局优先：刚保过但连续次数已触顶 → max-touches 而非 fresh',
    base({ lastTouchAt: T0 - MIN, lastActivityAt: T0 - MIN, touchCount: 9 }),
    false, 'max-touches'],

  ['★ 终局优先：刚保过但累计次数已触顶 → max-touches-total 而非 fresh',
    base({ lastTouchAt: T0 - MIN, lastActivityAt: T0 - MIN, touchCount: 1, touchCountTotal: 20, maxTouchesTotal: 20 }),
    false, 'max-touches-total'],

  // ── fresh 窗口可调（秒级实验必须真的按秒生效）──────────────────────
  // 试验模式：freshSeconds=5、intervalSeconds=30 —— 全部在秒级，分钟级实现会立刻暴露。
  ['★ 秒级实验：freshMs=5s、间隔 30s、距上次保温 3s → fresh',
    base({ freshMs: 5_000, intervalMs: 30_000, lastTouchAt: T0 - 3_000, lastActivityAt: T0 - 3_000, touchCount: 1 }),
    false, 'fresh'],

  ['★ 秒级实验：freshMs=5s、间隔 30s、距上次保温 10s（出了 fresh 窗口、未到间隔）→ too-soon',
    base({ freshMs: 5_000, intervalMs: 30_000, lastTouchAt: T0 - 10_000, lastActivityAt: T0 - 10_000, touchCount: 1 }),
    false, 'too-soon'],

  ['★ freshMs=0 → 永不 fresh（距上次保温 3s 也直接判 too-soon）',
    base({ freshMs: 0, intervalMs: 30_000, lastTouchAt: T0 - 3_000, lastActivityAt: T0 - 3_000, touchCount: 1 }),
    false, 'too-soon'],

  ['+ freshMs=5s、间隔 30s、距上次保温 40s（已过间隔）→ 放行',
    base({ freshMs: 5_000, intervalMs: 30_000, lastTouchAt: T0 - 40_000, lastActivityAt: T0 - 40_000, touchCount: 1 }),
    true, null],

  /**
   * ── stale 用 refreshLimitMs（保过之后），cold-window 用 idleLimitMs ──
   *
   * 实测 3f0b 四条纯保温：间隔 4.04h 时 prompt 一字不差却只有 1.03% 命中；间隔 0.23h 时 99.73%。
   * ⇒ 保过之后的门槛必须比「从未保过」更小。
   */
  ['★ stale：保过 + 距刷新 7h（> 6h idleLimitMs）→ stale',
    base({ lastTouchAt: T0 - 7 * HOUR, lastActivityAt: T0 - 7 * HOUR, touchCount: 1, idleLimitMs: 6 * HOUR }),
    false, 'stale'],

  ['stale：保过 + 距刷新 5h 且已过间隔（< 6h 门槛）→ 放行',
    base({ lastTouchAt: T0 - 5 * HOUR, lastActivityAt: T0 - 5 * HOUR, touchCount: 1, intervalMs: 2 * HOUR, idleLimitMs: 6 * HOUR }),
    true, null],

  ['★ 从未保过 + 闲置 5h（< 6h idleLimitMs）→ 放行（不是 cold-window-idle、不是 stale）',
    base({ lastTouchAt: 0, lastActivityAt: T0 - 5 * HOUR, idleLimitMs: 6 * HOUR }),
    true, null],

  ['★ 从未保过 + 闲置 7h（> 6h）→ cold-window-idle',
    base({ lastTouchAt: 0, lastActivityAt: T0 - 7 * HOUR, idleLimitMs: 6 * HOUR }),
    false, 'cold-window-idle'],

  ['同一个 idleLimitMs 管两种情形：保过 7h→stale、没保过 7h→cold-window-idle',
    base({ lastTouchAt: 0, lastActivityAt: T0 - 7 * HOUR, idleLimitMs: 6 * HOUR }),
    false, 'cold-window-idle'],
]

let pass = 0
let fail = 0
const lines = []
for (const [name, input, expectOk, expectCode] of cases) {
  const d = decideWarm(input)
  const ok = d.ok === expectOk && (expectOk === true || d.code === expectCode)
  if (ok) pass++
  else fail++
  lines.push(
    `${ok ? 'PASS' : 'FAIL'}  ${name}` +
    (ok ? '' : `\n        期望 ok=${expectOk}${expectCode ? ' code=' + expectCode : ''}`
      + `\n        实际 ok=${d.ok}${d.ok ? '' : ' code=' + d.code}  detail=${d.ok ? '-' : d.detail}`)
  )
}

console.log('=== 门禁规则测试 ===')
console.log(lines.join('\n'))
console.log('')
console.log(`通过 ${pass} / ${cases.length}` + (fail > 0 ? `   ❌ 失败 ${fail}` : '   ✅ 全绿'))
process.exit(fail > 0 ? 1 : 0)
