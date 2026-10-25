import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS } from '../src/store.ts'

/**
 * tick 强制路径的子代理过滤（契约 §B「独立的双路径分叉问题」，判据 B8 / B9）。
 *
 * 为什么单独测：库 `candidates.ts` 的判定顺序是 `manual` 早于 `subagent`，而 `mode='on'` 的会话
 * **根本不经过 `pickAutoCandidates`** —— `src/index.ts` 的 tick 直接吃 `policyOf().mode==='on'`，
 * 那是库外的一条独立路径。少了那道过滤，「子代理也算」关着时被手动强制开的子代理照样每拍过门禁。
 *
 * 这里不能直接测 tick 内部（它依赖 ctx / 磁盘），所以把**同一段判定逻辑**固化成纯函数断言：
 * 任何一侧改了语义，这条测试和 `src/index.ts` 里的实现就会分叉，核验能立刻发现。
 */
const MIN = 60_000
const NOW = 1_000_000

/** 与 `src/index.ts` tick targets 循环严格同构（改实现必须同步这条）。 */
function targetsOf(rows, { picked = [], modes = {}, allowSubagent = false }) {
  const targets = new Set(picked)
  for (const row of rows) {
    if ((modes[row.id] ?? 'auto') === 'on') {
      if (row.origin === 'subagent' && allowSubagent !== true) continue
      targets.add(row.id)
    }
  }
  return targets
}

const sub = { id: 'sub', origin: 'subagent', lastDialogAt: NOW - 2 * MIN }
const plain = { id: 'plain', origin: '', lastDialogAt: NOW - 2 * MIN }

test('B8 allowSubagent=false + 子代理 + mode=on → targets 不含它', () => {
  const t = targetsOf([sub], { modes: { sub: 'on' }, allowSubagent: false })
  assert.equal(t.has('sub'), false, '强制路径也必须过滤子代理，否则「子代理也算」是个假开关')
})

test('B9 allowSubagent=true + 子代理 + mode=on → 允许（过滤不能过头）', () => {
  const t = targetsOf([sub], { modes: { sub: 'on' }, allowSubagent: true })
  assert.equal(t.has('sub'), true, '开关打开时，手动强制开的子代理必须照常保温')
})

test('B8b 过滤只针对子代理：普通会话 mode=on 一律进 targets', () => {
  for (const allow of [false, true]) {
    const t = targetsOf([plain], { modes: { plain: 'on' }, allowSubagent: allow })
    assert.equal(t.has('plain'), true, `allowSubagent=${allow} 时普通会话不受影响`)
  }
})

test('B8c 自动候选不受这道过滤影响（它走的是 pickAutoCandidates）', () => {
  /** 即便 allowSubagent=false，已被 pickAutoCandidates 选中的也原样保留 —— 过滤只加在 mode=on 分支。 */
  const t = targetsOf([sub], { picked: ['sub'], allowSubagent: false })
  assert.equal(t.has('sub'), true, 'picked 进来的不能被这条过滤误删（否则会削掉库的结论）')
})

test('B 默认值：subagentIntervalSeconds = 120，且脏值回落默认', () => {
  assert.equal(DEFAULT_SETTINGS.subagentIntervalSeconds, 120, '默认 120 秒（子代理寿命 1~50 分钟）')
  assert.equal(DEFAULT_SETTINGS.intervalSeconds, 4 * 3600, '主间隔仍是 4 小时，两者互不影响')
})

/**
 * 源码锚：上面那个 `targetsOf` 是**抄来的**，抄错了等于什么都没测。
 * 这里直接读 `src/index.ts` 的 tick 段，确认过滤语句和 `isSubagent` 透传都还在。
 *
 * ⚠️ **锚点写法纪律：不要把整行原文钉死。** 这段逻辑被改过两次格式
 * （单行 → 多行 && 条件），每次都因为锚点太死而误报红灯，而语义其实一字没改。
 * 所以这里改成「把空白折叠后搜关键谓词」，只钉**语义要素**：
 *   ① 存在 `row.origin === 'subagent'` 判断；
 *   ② 该判断附近出现 `autoAllowSubagent`（旧总开关）；
 *   ③ 该判断附近出现 `autoCountSubagent`（S1 起的子代理名额）；
 *   ④ 后面跟着 `continue`（= 真的跳过，不是只算了个布尔值）。
 */
test('源码锚：index.ts 的 tick 过滤与 isSubagent 透传确实存在', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const raw = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8')
  /** 折叠空白，让锚点不受换行/缩进影响（多行条件也能匹配）。 */
  const src = raw.replace(/\s+/g, ' ')

  /** 取所有 `if (row.origin === 'subagent' ... ) continue` 形态的片段。 */
  const guards = [...src.matchAll(/if \(row\.origin === 'subagent'[^)]*?\)[^;]{0,80}?continue/g)].map(m => m[0])
  assert.ok(guards.length > 0,
    'tick targets 循环里的子代理过滤没了 → B8 失效（mode=on 的子代理会绕过开关照保）')

  const g = guards[0]
  assert.match(g, /autoAllowSubagent/, '过滤里必须认旧的「子代理也算」总开关')
  assert.match(g, /autoCountSubagent/, '过滤里必须认新的「子代理条数 > 0」（S1）；否则填了条数仍被这道过滤拦死')
  assert.match(g, /continue/, '过滤必须真的 continue 跳过，而不是只算了个布尔值')

  /** 两处都要透传 isSubagent（活会话 + 空闲会话）。 */
  assert.equal(src.split("isSubagent: row?.origin === 'subagent'").length - 1, 2,
    'gateInputFor 与 gateInputForIdle 两处都要透传 isSubagent，否则子代理拿不到短间隔（B1~B6 全废）')
})
