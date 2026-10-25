/**
 * 面板列宽拖拽（U3 重做语义）+ 总宽约束的纯逻辑验证。
 *
 * 被测函数直接取自 src/panel.ts 源码文本（内联 script 无法 import），只依赖 Math/Number，无 DOM。
 * 语义：拖第 N 列右边缘 —— 左拖只压本列；右拖先扩本列到贴边，之后逐一压右侧列到 minOf。
 * 约束：Σ列宽 <= 容器宽（右侧允许留白，不拉伸）、各列 >= minOf。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const PANEL = join(here, '..', 'src', 'panel.ts')
const SRC = readFileSync(PANEL, 'utf8')

function extractFn(name) {
  const anchor = 'function ' + name + '('
  const at = SRC.indexOf(anchor)
  assert.ok(at >= 0, name + ' 不在 panel.ts 里')
  let depth = 0, end = -1
  for (let j = SRC.indexOf('{', at); j < SRC.length; j++) {
    const ch = SRC[j]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) { end = j + 1; break } }
  }
  assert.ok(end > 0, name + ' 括号不配平')
  return vm.runInNewContext('(' + SRC.slice(at, end) + ')')
}

function extractSrc(name) {
  const anchor = 'function ' + name + '('
  const at = SRC.indexOf(anchor)
  assert.ok(at >= 0, name + ' 不在 panel.ts 里')
  let depth = 0, end = -1
  for (let j = SRC.indexOf('{', at); j < SRC.length; j++) {
    const ch = SRC[j]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) { end = j + 1; break } }
  }
  assert.ok(end > 0, name + ' 括号不配平')
  return SRC.slice(at, end)
}

const plan = extractFn('rsPlan')
const fit = extractFn('fitTotal')
const migrate = extractFn('migrateWidths')
const sum = (a) => a.reduce((x, y) => x + y, 0)

const CUR = [300, 100, 80, 60]
const MINS = [40, 40, 40, 40]
const TOTAL = 600            // Σ(CUR) = 540 → 留白 60

test('D0 起点 Σ=540、容器 600 → 留白 60', () => {
  assert.equal(sum(CUR), 540)
})

test('D1 向右拖 +40：只扩本列，右侧一像素不动', () => {
  const r = plan(CUR, MINS, 0, 40, TOTAL)
  assert.equal(r.d, 40)
  assert.deepEqual(r.ws, [340, 100, 80, 60])
  assert.equal(sum(r.ws), 580)
})

test('D2 向右拖 +60：正好贴容器右边（Σ=600），右侧仍不动', () => {
  const r = plan(CUR, MINS, 0, 60, TOTAL)
  assert.equal(r.d, 60)
  assert.deepEqual(r.ws, [360, 100, 80, 60])
  assert.equal(sum(r.ws), 600)
})

test('D3 贴边后继续 +100：本列继续变宽 100（跟手），从最右列往左压 20+20，Σ 仍 600', () => {
  const r = plan(CUR, MINS, 0, 100, TOTAL)
  assert.equal(r.d, 100, 'Δ本列 == d（右侧压得动）')
  assert.deepEqual(r.ws, [400, 100, 60, 40], '先压末列 60→40，再压倒数第二列 80→60')
  assert.equal(sum(r.ws), 600, '贴边后 Σ 恒 = 容器宽，不塌缩')
})

test('D3b 贴边后 +80：只压最后一列（末列 60→40），倒数第二列不变', () => {
  const r = plan(CUR, MINS, 0, 80, TOTAL)
  assert.equal(r.d, 80)
  assert.deepEqual(r.ws, [380, 100, 80, 40])
  assert.equal(r.ws[2], 80, '倒数第二列不许动')
  assert.equal(sum(r.ws), 600)
})

test('D4 拖到 +200：本列涨到 480（room 60 + 右侧让位 120），右侧全到 minOf', () => {
  const r = plan(CUR, MINS, 0, 200, TOTAL)
  assert.equal(r.d, 180, 'pressed 只有 120，剩 20 压不动')
  assert.deepEqual(r.ws, [480, 40, 40, 40])
  assert.equal(sum(r.ws), 600, '压不动也保持 Σ = 容器宽')
})

test('D5 向左拖 -100：只压本列，左右两侧全不动，Σ 变小（右侧留白）', () => {
  const r = plan(CUR, MINS, 0, -100, TOTAL)
  assert.equal(r.d, -100)
  assert.deepEqual(r.ws, [200, 100, 80, 60])
  assert.equal(sum(r.ws), 440)
  assert.deepEqual(r.ws.slice(1), CUR.slice(1), '右侧列一个像素都不许动')
})

test('D6 向左拖到底：本列夹在 minOf（300 → 40），不会变负', () => {
  const r = plan(CUR, MINS, 0, -9999, TOTAL)
  assert.equal(r.d, -260)
  assert.deepEqual(r.ws, [40, 100, 80, 60])
  assert.equal(sum(r.ws), 280)
})

test('D7 还原：先 +200（压过右侧）再回到 +40 → 右侧列完全回到起点值', () => {
  const pressed = plan(CUR, MINS, 0, 200, TOTAL)
  assert.deepEqual(pressed.ws, [480, 40, 40, 40])
  const back = plan(CUR, MINS, 0, 40, TOTAL)   // 同一份起点快照重算
  assert.deepEqual(back.ws, [340, 100, 80, 60])
  assert.deepEqual(back.ws.slice(1), CUR.slice(1), '被压过的右侧列必须完全还原')
  assert.deepEqual(plan(CUR, MINS, 0, 0, TOTAL).ws, CUR, 'd=0 → 原样')
})

test('D8 最后一列也能拖：向右最多扩到容器右边（Σ=600），不越界', () => {
  const r = plan(CUR, MINS, 3, 100, TOTAL)
  assert.equal(r.d, 60, '只剩 60 的空间（600-540）')
  assert.deepEqual(r.ws, [300, 100, 80, 120])
  assert.equal(sum(r.ws), 600)
})

test('D9 最后一列向右拖：向右边界不得超出容器（Σ <= total 恒成立）', () => {
  const r = plan(CUR, MINS, 3, 5000, TOTAL)
  assert.ok(sum(r.ws) <= TOTAL)
  assert.equal(sum(r.ws), 600)
})

test('D10 最后一列向左拖：留白变大，本列夹在 minOf（60-50=10 → 40）', () => {
  const r = plan(CUR, MINS, 3, -50, TOTAL)
  assert.equal(r.d, -20)
  assert.deepEqual(r.ws, [300, 100, 80, 40])
  assert.equal(sum(r.ws), 520)
})

test('D11 中间列（idx=1）：左拖只压它自己', () => {
  const r = plan(CUR, MINS, 1, -50, TOTAL)
  assert.deepEqual(r.ws, [300, 50, 80, 60])
  assert.equal(r.ws[0], 300)
  assert.deepEqual(r.ws.slice(2), [80, 60])
})

test('D12 中间列（idx=1）右拖压的是 idx+1 之后的列，左侧不动', () => {
  const r = plan([300, 100, 80, 60], MINS, 1, 200, TOTAL)   // room=60，右侧可压 40+20=60
  assert.equal(r.d, 120, '本列 100 → 220（room 60 + 让位 60）')
  assert.deepEqual(r.ws, [300, 220, 40, 40])
  assert.equal(sum(r.ws), 600)
  assert.equal(r.ws[0], 300, '左侧列不许动')
})

test('D13 破损输入 cur[idx] < mins[idx]：向左拖不许反向撑大', () => {
  const cur = [100, 45, 40, 40], mins = [40, 58, 40, 40]
  const r = plan(cur, mins, 1, -10, 600)
  assert.equal(r.d, 0)
  assert.deepEqual(r.ws, cur)
})

test('D14 总约束：Σ <= 容器宽 + 各列 >= minOf（fuzz 500 组）', () => {
  let seed = 424242
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  for (let n = 0; n < 500; n++) {
    const len = 2 + Math.floor(rnd() * 5)
    const mins = [], cur = []
    for (let i = 0; i < len; i++) {
      const m = 40 + Math.floor(rnd() * 40)
      mins.push(m)
      cur.push(m + Math.floor(rnd() * 200))
    }
    const idx = Math.floor(rnd() * len)
    let s0 = 0
    for (const w of cur) s0 += w
    const total = s0 + Math.floor(rnd() * 300)   // 起点 Σ <= total
    const d = Math.floor((rnd() - 0.5) * 900)
    const r = plan(cur, mins, idx, d, total)
    assert.ok(sum(r.ws) <= total, 'n=' + n + ' Σ 超容器：' + sum(r.ws) + ' > ' + total)
    r.ws.forEach((w, i) => assert.ok(w >= mins[i], 'n=' + n + ' 列' + i + ' 低于 min'))
    if (d <= 0) {
      r.ws.forEach((w, i) => { if (i !== idx) assert.equal(w, cur[i], 'n=' + n + ' 左拖时非本列不许动') })
    }
  }
})

test('D15 还原幂等：任意 d 连续算两遍结果一致（不累加）', () => {
  for (const d of [-260, -100, -1, 0, 1, 40, 60, 100, 200, 999]) {
    const a = plan(CUR, MINS, 0, d, TOTAL)
    const b = plan(CUR, MINS, 0, d, TOTAL)
    assert.deepEqual(a, b)
  }
})

test('D16 贴边后继续右拖：Σ 恒 = 容器宽（拖拽条跟手，不塌缩）', () => {
  for (const d of [60, 61, 100, 150, 200, 500]) {
    const r = plan(CUR, MINS, 0, d, TOTAL)
    assert.equal(sum(r.ws), TOTAL, 'd=' + d + ' Σ=' + sum(r.ws))
    assert.ok(r.ws[0] > CUR[0], 'd=' + d + ' 本列必须比起点宽（拖拽条跟手）')
  }
})

test('D17 贴边后继续右拖：Δ本列 == d（只要右侧还压得动，最多 60+120）', () => {
  for (const d of [61, 80, 100, 120]) {
    assert.equal(plan(CUR, MINS, 0, d, TOTAL).d, d, 'd=' + d)
  }
  assert.equal(plan(CUR, MINS, 0, 300, TOTAL).d, 180, '右侧压不动后本列停在 480')
  assert.deepEqual(plan(CUR, MINS, 0, 300, TOTAL).ws, [480, 40, 40, 40])
})

test('D18 末列没有可压的右侧列：贴边即停（不会越界，也不会塌缩）', () => {
  const r = plan(CUR, MINS, 3, 900, TOTAL)
  assert.equal(r.d, 60)
  assert.deepEqual(r.ws, [300, 100, 80, 120])
  assert.equal(sum(r.ws), TOTAL)
})

test('D19 压缩顺序锁定：只够压一列时，最后一列变窄、倒数第二列不动', () => {
  const cur = [300, 100, 80, 60]
  const r = plan(cur, MINS, 0, 70, TOTAL)      // room=60 → over=10
  assert.deepEqual(r.ws, [370, 100, 80, 50], '10px 只从末列扣')
  assert.equal(r.ws[1], 100, '相邻列（idx+1）不动 —— 旧实现会先压它')
  assert.equal(r.ws[2], 80, '倒数第二列不动')
  const r2 = plan(cur, MINS, 0, 79, TOTAL)     // over=19
  assert.equal(r2.ws[3], 41)
  assert.equal(r2.ws[2], 80)
  assert.equal(r2.ws[1], 100)
  const r3 = plan(cur, MINS, 0, 81, TOTAL)     // over=21：末列先到底(20)，再往左 1
  assert.equal(r3.ws[3], 40, '末列先压到 minOf')
  assert.equal(r3.ws[2], 79, '剩下的 1px 才轮到倒数第二列')
  assert.equal(r3.ws[1], 100, '更左边的仍不动')
})

test('D20 中间列拖拽同样从最右列往左压（idx=1）', () => {
  const r = plan([300, 100, 80, 60], MINS, 1, 70, TOTAL)   // room=60, over=10
  assert.deepEqual(r.ws, [300, 170, 80, 50])
  assert.equal(r.ws[2], 80, 'idx+1 不动')
})

test('F1 fitTotal：Σ 不超容器 → 原样（保留右侧留白，绝不拉伸）', () => {
  assert.deepEqual(fit([300, 100, 80, 60], MINS, 600), [300, 100, 80, 60])
  assert.deepEqual(fit([40, 40, 40, 40], MINS, 600), [40, 40, 40, 40])
})

test('F2 fitTotal：Σ 超容器 → 按可压量缩回，不破 minOf', () => {
  const out = fit([500, 200, 200, 200], MINS, 600)
  assert.equal(sum(out), 600)
  out.forEach((w, i) => assert.ok(w >= MINS[i], '列' + i + ' 低于 min'))
  assert.ok(out[0] > out[1], '宽列让得更多')
})

test('F3 fitTotal：缩到 min 仍超（min 总和 > 容器）→ 原样返回，不产生负宽/低于 min', () => {
  const mins = [100, 100, 100, 100]
  const out = fit([100, 100, 100, 100], mins, 250)
  out.forEach((w, i) => assert.ok(w >= mins[i]))
})

test('M1 操作列最小宽按内容测（源码里量 DOM 并缓存，不写死数字）', () => {
  const at = SRC.indexOf('function measureOpsMin(')
  assert.ok(at > 0)
  const body = SRC.slice(at, SRC.indexOf('function minOf('))
  assert.ok(/querySelector\('td'\)/.test(body), '必须真的量 td 宽度')
  assert.ok(/OPS_MIN = w > 0 \?/.test(body), '量到就缓存，量不到才兜底')
  assert.ok(!/OPS_MIN = 1[0-9][0-9]/.test(body), '不许把宽度写死')
  const at2 = SRC.indexOf('function minOf(')
  assert.ok(/id === 'ops'/.test(SRC.slice(at2, at2 + 300)), 'minOf(ops) 必须走测量值')
})

test('M2 表格宽度跟随列宽和（width:100% 会把留白吃掉）', () => {
  assert.ok(/\.tablewrap table \{ min-width: 0; width: auto; \}/.test(SRC),
    'tablewrap 内的 table 必须是 width:auto + min-width:0')
})

test('M3 每列都挂拖拽条（最后一列也能拖自己的右边缘）', () => {
  const at = SRC.indexOf("cols += '<col data-c=\"'")
  const body = SRC.slice(at, at + 600)
  assert.ok(!/lastId/.test(body), '不再按 lastId 跳过最后一列')
  assert.ok(/<span class="rz"><\/span><\/th>/.test(body))
})

test('M4 只有操作列的极端场景：最小宽 = 实测按钮并排宽度，右边缘不越界', () => {
  let created = 0
  const fakeTd = { getBoundingClientRect() { return { width: 168.4 } } }
  const fakeTable = { setAttribute() {}, set innerHTML(v) {}, querySelector() { return fakeTd } }
  const api = vm.runInNewContext(
    'var MIN_COL = 40, COL_MIN = { hit: 58 }, OPS_MIN = 0;\n'
    + extractSrc('measureOpsMin') + '\n'
    + extractSrc('minOf') + '\n'
    + '({ m: measureOpsMin, lo: minOf, cached: function () { return OPS_MIN } })',
    {
      Math,
      document: {
        body: { appendChild() {}, removeChild() {} },
        createElement() { created++; return fakeTable }
      }
    }
  )
  assert.equal(api.m(), 169, 'Math.ceil(168.4)')
  assert.equal(api.lo('ops'), 169, 'minOf(ops) 用实测值，不是写死的 40')
  assert.equal(api.m(), 169)
  assert.equal(created, 1, '量一次就缓存，不重复插 DOM')
  assert.equal(api.cached(), 169)

  const COL = 200, w0 = 169
  const hi = plan([w0], [w0], 0, 9999, COL)
  assert.deepEqual(hi.ws, [COL], '向右拖到容器右边就停')
  assert.ok(hi.ws[0] <= COL, '右边缘不得超出容器')
  const lo = plan([w0], [w0], 0, -9999, COL)
  assert.deepEqual(lo.ws, [w0], '向左拖不破按钮并排宽度')
})

test('G1 存量污染迁移：ops=1567 → 复位到 minOf(ops)=114（不是 939）', () => {
  const out = migrate([400, 120, 1567, 90], [40, 40, 114, 40], 1337, 2)
  assert.deepEqual(out, [400, 120, 114, 90])
})

test('G2 窄屏 900 同样复位（先 clamp 到容器宽，仍超上限）', () => {
  assert.deepEqual(migrate([400, 120, 1567, 90], [40, 40, 114, 40], 900, 2), [400, 120, 114, 90])
})

test('G3 正常列不动；未定宽 0 保持 0', () => {
  assert.deepEqual(migrate([400, 0, 114, 90], [40, 40, 114, 40], 1337, 2), [400, 0, 114, 90])
})

test('G4 单列存量 > 容器宽 → clamp 到容器宽（非 ops 列也兜底）', () => {
  assert.deepEqual(migrate([2000, 100], [40, 40], 1337, -1), [1337, 100])
})

test('G5 用户合法拖到 4 倍以内 → 保留；超 4 倍才复位', () => {
  assert.deepEqual(migrate([300, 456], [40, 114], 1337, 1), [300, 456])
  assert.equal(migrate([300, 457], [40, 114], 1337, 1)[1], 114)
})

test('G6 renderHead 迁移**不落盘**（迁移只影响显示，存储只由拖拽/恢复默认写）', () => {
  const body = extractSrc('renderHead')
  assert.ok(/migrateWidths\(/.test(body), 'renderHead 必须调用 migrateWidths')
  /**
   * 原本这条要求「迁移后落盘一次（自愈）」，现改为**禁止落盘** —— 两处依据：
   *  ① `renderHead` 里有一段有意写下的相反设计：「存量迁移只影响显示，不写回存储；
   *     窄容器下单列超容器是常态（不是污染），写回会把临时布局固化成用户配置」
   *     （实测：1440→900→1440 往返后列宽再也变不回来）；
   *  ② `NEED_SAVE_COLS` 在补丁库里最后出现是 10-20，之后被有意删掉。
   * 覆盖不降级：将来谁在渲染期手滑写回存储，这几条会立刻红。
   */
  assert.equal(/NEED_SAVE_COLS/.test(body), false, 'renderHead 里不许出现 NEED_SAVE_COLS（迁移不落盘）')
  assert.equal(/post\(/.test(body), false, 'renderHead 里不许发保存请求')
  assert.equal(/colPatch\(/.test(body), false, 'renderHead 里不许构造列宽 patch')
  assert.equal(/settings\[colKey\(\)\]\s*=/.test(body), false, 'renderHead 里不许给 settings[colKey()] 赋值')
  /**
   * 上面四条只挡「整对象赋值 / 发请求 / 构造 patch / NEED_SAVE_COLS」，
   * **抓不到逐列直写存储**（核验员实测：插一句 `STATE.settings.colWidths.gate = widthOf['gate']`
   * 后 43/43 仍全绿）。补两条把「按下标」与「按属性」两种直写一起挡住 ——
   * 这才是「迁移只影响显示」最容易被子类手滑破坏的入口。
   */
  assert.equal(/settings\.colWidths\[[^\]]*\]\s*=/.test(body), false,
    'renderHead 里不许按下标直写 settings.colWidths（迁移只影响显示）')
  assert.equal(/settings\.colWidths\.[A-Za-z_$][\w$]*\s*=/.test(body), false,
    'renderHead 里不许按属性直写 settings.colWidths（迁移只影响显示）')
  assert.ok(body.indexOf('migrateWidths(') < body.indexOf('fixedSum +='), '迁移必须在定宽累加之前')
})

test('G7 table-layout:fixed 生效 —— renderHead 必须显式写「表宽 = Σ列宽」（E1 防回退）', () => {
  const body = extractSrc('renderHead')
  assert.ok(/tbl\.style\.width = sumAll \+ 'px'/.test(body), '必须给 table 写显式宽度')
  assert.ok(/querySelector\('table'\)/.test(body), '要拿到 .tablewrap 里的 table')
  assert.ok(body.indexOf("style.width = sumAll") > body.indexOf('colWidths = synced'), '在定宽写回之后、拼 colgroup 之前')
})

test('G8 拖拽中表宽必须跟着 Σ 走（否则 fixed 把缩掉的量按比例分回其它列 → 左拖时左侧变宽）', () => {
  const apply = extractSrc('applyResize')
  assert.ok(/RS\.tbl\.style\.width = sumWs \+ 'px'/.test(apply), 'applyResize 必须实时同步 table 宽度')
  assert.ok(/sumWs \+= pl\.ws\[i\]/.test(apply), 'Σ 用本次算出的各列宽')
  const start = extractSrc('startResize')
  assert.ok(/tbl: wrap \? wrap\.querySelector\('table'\) : null/.test(start), 'startResize 要把 table 元素存进 RS')
})

test('G9 筛选浮层：关闭态必须真的隐藏 + 同时只允许一个打开（捕获阶段互斥）+ 不溢出视口', () => {
  assert.ok(/\.ms:not\(\[open\]\) > \.ms-panel \{ display: none; \}/.test(SRC),
    'details 关闭时必须 display:none —— .ms-panel 的 display:grid 会盖掉浏览器默认隐藏语义')
  assert.ok(/\.ms-panel \{[^}]*max-width: calc\(100vw - 24px\)/.test(SRC), '浮层要限宽防横向溢出')
  const ex = extractSrc('msExclusive')
  assert.ok(/d\.open = false/.test(ex), '互斥要把另一个 details 关掉')
  assert.ok(/document\.addEventListener\('click', msExclusive, true\)/.test(SRC),
    '互斥必须注册在捕获阶段（冒泡阶段时本个 details 还没切换 open）')
  assert.ok(/document\.addEventListener\('click', msCloseOutside\)/.test(SRC), '点外面要关')
})

test('G10 详情页「剪枝/压缩轮」行：徽标列必须可换行、网格列不能用固定窄宽（防文字叠印）', () => {
  assert.ok(/#tl \.it \{ display: grid; grid-template-columns: 92px minmax\(70px, 150px\) minmax\(0, 1fr\) 138px/.test(SRC),
    '第 2 列必须是 minmax(70px,150px)，不能是固定 70px（长标签会溢出到第 3 列）')
  assert.ok(/#tl \.it > span \{ min-width: 0; \}/.test(SRC), 'grid item 要 min-width:0 才能收缩')
  assert.ok(/#tl \.it \.pill \{ white-space: normal;/.test(SRC), '详情行里的 pill 要允许换行')
})

test('G11 浮层定位必须同时夹右缘和左缘（窄视口下右对齐会把面板左缘甩出视口）', () => {
  const fit = extractSrc('msFit')
  assert.ok(/clientWidth - 8/.test(fit), '要有右缘判定')
  assert.ok(/r2?\.left < 8|r\.left < 8/.test(fit), '要有左缘判定')
  assert.ok(/getBoundingClientRect\(\)\.left\) \+ 'px'/.test(fit), '左缘被夹时要按触发器位置回算 left 偏移')
  assert.ok(/document\.addEventListener\('toggle', function \(ev\)/.test(SRC), '打开瞬间要触发 msFit')
})

test('R12 面板三条禁忌：模板字符串内 反引号 / 美元花括号 / 反斜杠单引号 均为 0', () => {
  const at = SRC.indexOf('const PANEL_SRC = ')
  assert.ok(at > 0)
  const s = SRC.indexOf('`', at) + 1
  const e = SRC.lastIndexOf('`')
  const body = SRC.slice(s, e)
  assert.ok(body.length > 10000, '模板体取窄了')
  assert.equal(body.split('`').length - 1, 0, '出现反引号')
  assert.equal(body.split('${').length - 1, 0, '出现 ${')
  assert.equal(body.split("\\'").length - 1, 0, '出现 \\\'')
})

test('R13 内联 script 语法可编译（等价 node --check）', () => {
  const s = SRC.indexOf('<script>') + '<script>'.length
  const e = SRC.indexOf('</script>')
  const js = SRC.slice(s, e)
  assert.ok(js.length > 5000)
  new vm.Script(js)
})

test('R14 rsPlan 无 DOM 依赖（源码里不出现 document / window / STATE）', () => {
  const at = SRC.indexOf('function rsPlan(')
  const body = SRC.slice(at, SRC.indexOf('function startResize('))
  for (const bad of ['document', 'window', 'STATE', 'colElOf']) {
    assert.equal(body.includes(bad), false, 'rsPlan 里不该出现 ' + bad)
  }
})
