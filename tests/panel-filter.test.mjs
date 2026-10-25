import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const SRC = readFileSync(new URL('../src/panel.ts', import.meta.url), 'utf8')

/** 取 PANEL_SRC 模板串体（面板 HTML + 内联脚本）。 */
function panelBody() {
  const at = SRC.indexOf('const PANEL_SRC = ')
  assert.ok(at > 0)
  const s = SRC.indexOf('`', at) + 1
  const e = SRC.lastIndexOf('`')
  return SRC.slice(s, e)
}
const BODY = panelBody()

/** 取某个顶层函数体（从 `function 名(` 到下一个顶层 `}`）。 */
function fn(name) {
  const at = BODY.indexOf('function ' + name + '(')
  assert.ok(at > 0, '找不到函数 ' + name)
  const end = BODY.indexOf('\n}', at)
  return BODY.slice(at, end < 0 ? BODY.length : end)
}

test('F1 候选筛选项 = CAND_WHY 的键去掉 manual（死分支），含 auto-disabled', () => {
  const whyAt = BODY.indexOf('var CAND_WHY = {')
  assert.ok(whyAt > 0)
  const why = BODY.slice(whyAt, BODY.indexOf('};', whyAt))
  const whyKeys = [...why.matchAll(/'([a-z-]+)':/g)].map(m => m[1])
  assert.ok(whyKeys.length >= 8, 'CAND_WHY 键解析失败：' + whyKeys.join(','))

  const opts = fn('candOpts')
  const picked = [...opts.matchAll(/\['([a-z-]+)',/g)].map(m => m[1])
  assert.deepEqual(picked.slice(0, 3), ['picked', 'on', 'off'], '前 3 项是面板上实际显示的状态')
  const reasons = picked.slice(3)
  assert.deepEqual(reasons.slice().sort(), whyKeys.filter(k => k !== 'manual').sort(),
    '候选筛选项必须等于 CAND_WHY 键去掉 manual：实际=' + reasons.join(','))
  assert.equal(reasons.indexOf('manual'), -1, 'manual 是死分支，不能做成筛选项')
  assert.ok(reasons.indexOf('auto-disabled') >= 0, 'auto-disabled 在全局自动关时可达，必须保留')
  assert.ok(whyKeys.length === reasons.length + 1, '正好少一个 manual')
})

test('F2 门禁筛选项 15 项且不含 image（image 只是文案 key，GateSkip 无此码）', () => {
  const gate = fn('gateOpts')
  const vals = [...gate.matchAll(/\['([a-z-]+)',/g)].map(m => m[1])
  assert.equal(vals.length, 15, '实测 ' + vals.length + '：' + vals.join(','))
  assert.equal(vals.indexOf('image'), -1, 'image 不能做筛选项（恒 0 命中）')
  for (const must of ['warm', 'fresh', 'too-soon', 'cold-window', 'cold-window-idle', 'stale',
    'tripped', 'budget', 'max-touches', 'max-touches-total', 'prefix-changed', 'no-route', 'no-agent',
    'archived', 'running']) {
    assert.ok(vals.indexOf(must) >= 0, '缺门禁码 ' + must)
  }
})

test('F3 单选 <select id="gateFilter"> 已彻底删除（残引用会让顶层绑定抛错 → 整页白屏）', () => {
  assert.equal(SRC.indexOf('gateFilter'), -1, 'panel.ts 里还有 gateFilter 残留')
  assert.ok(BODY.indexOf('msGate') > 0, '门禁多选控件没建')
  assert.ok(BODY.indexOf('msCand') > 0, '候选多选控件没建')
})

test('F4 排序下拉无 mtimeAsc + 有 hit；mtimeAsc 只出现在迁移分支里', () => {
  const selAt = BODY.indexOf('<select id="sortBy">')
  assert.ok(selAt > 0)
  const sel = BODY.slice(selAt, BODY.indexOf('</select>', selAt))
  assert.equal(sel.indexOf('mtimeAsc'), -1, '下拉里不该再有 mtimeAsc')
  const vals = [...sel.matchAll(/<option value="([a-zA-Z]+)"/g)].map(m => m[1])
  assert.deepEqual(vals, ['mtime', 'spend', 'hit', 'title', 'size'], '实际=' + vals.join(','))
  const hits = [...BODY.matchAll(/mtimeAsc/g)]
  assert.equal(hits.length, 2, 'mtimeAsc 只应留在 loadFilters 的迁移两行，实际 ' + hits.length + ' 处')
  for (const m of hits) {
    const ctx = BODY.slice(Math.max(0, m.index - 120), m.index + 60)
    assert.ok(/f\.sortBy === 'mtimeAsc'|f\.sortRev === true \|\| f\.sortBy/.test(ctx), 'mtimeAsc 出现在迁移分支之外：' + ctx)
  }
})

test('F5 逆序只乘第一次排序；置顶的第二次稳定排序不带 rev', () => {
  const body = fn('filtered')
  assert.ok(/var rev = sortRevOn\(\) \? -1 : 1;/.test(body), 'rev 计算没找到')
  assert.ok(/return r \* rev;/.test(body), '第一次排序没乘 rev')
  const pinAt = body.indexOf('pinnedInPanel')
  assert.ok(pinAt > 0, '置顶的第二次排序没找到')
  const pinLine = body.slice(pinAt - 120, body.indexOf('\n', pinAt))
  assert.equal(/rev/.test(pinLine), false, '置顶排序不能受逆序影响：' + pinLine)
  assert.ok(body.indexOf('pinnedInPanel') > body.indexOf('return r * rev'), '置顶排序必须在第一次排序之后')
})

test('F6 命中率兜底：s.last 为空或 hitRate 缺失 → -1（防 NaN 进比较器）', () => {
  const body = fn('hitRateOf')
  assert.ok(/s\.last && s\.last\.hitRate >= 0/.test(body), '没判 s.last 存在')
  assert.ok(/return -1/.test(body), '没兜底 -1')
  assert.ok(fn('filtered').indexOf('hitRateOf') > 0, '排序里没用 hitRateOf')
})

test('F7 持久化字段齐 + 老格式迁移分支存在（幂等、未知值丢弃）', () => {
  const save = fn('saveFilters')
  for (const k of ['sortRev', 'gateCodes', 'candCodes', 'sortBy', 'q', 'pageSize']) {
    assert.ok(save.indexOf(k + ':') > 0, 'saveFilters 少了 ' + k)
  }
  assert.equal(save.indexOf('gate:'), -1, '不能再存老的单值 gate 字段')
  const load = fn('loadFilters')
  assert.ok(/f\.gateCodes/.test(load), 'loadFilters 没读 gateCodes')
  assert.ok(/msPick\('gate', f\.gateCodes, f\.gate\)/.test(load), '缺 gate → gateCodes 迁移')
  assert.ok(/f\.sortBy === 'mtimeAsc' \? 'mtime'/.test(load), '缺 mtimeAsc → mtime 迁移')
  const pick = fn('msPick')
  assert.ok(/allow\[v\] === 1/.test(pick), '未知值必须被白名单丢弃')
  assert.ok(/out\.indexOf\(v\) < 0/.test(pick), '必须去重')
  assert.ok(/Array\.isArray\(arr\)/.test(pick), '非数组必须回落 []')
})

test('F8 搜索框按 flex 加宽，且不动全局 input[type=text] 宽（设置页靠它）', () => {
  assert.ok(/\.field\.f-q \{ flex: 1 1 240px; min-width: 240px; max-width: 560px; \}/.test(BODY),
    '缺 .field.f-q 的 flex 规则')
  assert.ok(/#q \{ width: 100%; min-width: 0; \}/.test(BODY), '缺 #q 满宽规则')
  assert.ok(/input\[type=text\] \{ width: 148px; \}/.test(BODY), '全局 148px 被改了（会连带设置页）')
  assert.ok(/<div class="field f-q">/.test(BODY), '搜索框的 .field 没挂 f-q 类')
})

test('F9 多选面板只在 loadFilters 里建一次（render 不能重建，否则 15s 刷新冲掉按钮态）', () => {
  assert.ok(fn('loadFilters').indexOf('msBuild()') > 0, 'loadFilters 没建面板')
  assert.equal(fn('render').indexOf('msBuild'), -1, 'render() 里不能重建面板')
  assert.ok(fn('buildMultiOrRender') === '' || true, '')
})

test('F10 每个筛选/排序 handler 都重置 SHOWN（否则分页「显示 N/M」错位）', () => {
  for (const id of ['q', 'sortBy', 'sortRev', 'hideArchived', 'hideSubagent', 'hideBlank', 'pageSize']) {
    const at = BODY.indexOf("$('" + id + "').on")
    assert.ok(at > 0, '找不到 ' + id + ' 的事件绑定')
    const line = BODY.slice(at, BODY.indexOf('\n', at))
    assert.ok(/SHOWN = 0|flipToggle/.test(line), id + ' 的 handler 没重置 SHOWN：' + line)
  }
})

test('F11 多选按钮无勾选态：面板里只有 button，且选中态走 className "tgl on"', () => {
  const build = fn('msBuild')
  assert.ok(build.indexOf('<button') > 0, '面板里没生成 button')
  assert.equal(build.indexOf('<input'), -1, '面板里不能出现 input（勾选态）')
  assert.equal(build.indexOf('checkbox'), -1, '面板里不能出现 checkbox')
  const apply = fn('msApply')
  assert.ok(/'tgl on'/.test(apply) && /'tgl'/.test(apply), '选中态必须靠 className 切 tgl/tgl on（颜色反馈）')
})

test('F12 B1 回归：操作列测量 table 的 style 必须含 width:auto（否则被全局 table{width:100%} 撑到视口宽）', () => {
  const body = fn('measureOpsMin')
  const styleAt = body.indexOf('position:absolute')
  assert.ok(styleAt > 0)
  const line = body.slice(styleAt, body.indexOf("')", styleAt))
  assert.ok(/width:auto/.test(line), '缺 width:auto：' + line)
})
