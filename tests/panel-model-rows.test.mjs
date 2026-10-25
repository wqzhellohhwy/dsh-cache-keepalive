/**
 * 模型价表 UI 的行结构 / 保存语义回归（U1）。
 *
 * 为什么这样测：面板的可执行代码躺在 `PANEL_HTML` 这个模板字符串里（浏览器端 JS），
 * Node 里 import 不到函数本身。所以从 `PANEL_HTML` 文本里按「顶格函数」抽出源码，
 * 配上最小 DOM 桩用 `new Function` 求值 —— 测的是真实面板代码，不是照抄一份。
 *
 * 标准 node:test：一条断言一个 test()，失败时能直接定位到是哪条守线。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PANEL_HTML } from '../src/panel.ts'
import { effectiveLimitsOf } from '../src/core/gate-input.ts'
import { DEFAULT_SETTINGS } from '../src/store.ts'

const SRC = PANEL_HTML

/**
 * 从面板源码里抽一个顶格函数的完整文本。
 * 用行扫描 + 「行首无缩进的 }」作结束（面板里所有顶层函数都顶格，体内一律缩进），
 * 比逐字符扫括号更稳 —— 函数体里有正则字面量（如 esc），逐字符扫会把正则里的括号算进去。
 */
function extractFn(name) {
  const lines = SRC.split('\n')
  const start = lines.findIndex((l) => l.startsWith('function ' + name + '('))
  assert.ok(start >= 0, '面板源码里找不到函数：' + name)
  for (let i = start; i < lines.length; i++) {
    if (i > start && lines[i] === '}') return lines.slice(start, i + 1).join('\n')
  }
  assert.fail('函数未闭合：' + name)
}

/** 抽一段以 `$('id').onclick = function () {` 开头的顶格处理器。 */
function extractHandler(id) {
  const lines = SRC.split('\n')
  const marker = "$('" + id + "').onclick = function () {"
  const start = lines.findIndex((l) => l.startsWith(marker))
  assert.ok(start >= 0, '找不到处理器：' + id)
  for (let i = start; i < lines.length; i++) {
    if (i > start && (lines[i] === '}' || lines[i] === '};')) return lines.slice(start, i + 1).join('\n')
  }
  assert.fail('处理器未闭合：' + id)
}

/* ── 最小 DOM 桩 ───────────────────────────────────────────── */
function el(cls, extra) {
  const node = Object.assign({ className: cls, value: '', innerHTML: '', style: {} }, extra || {})
  node.classList = {
    contains: (c) => String(node.className).split(/\s+/).indexOf(c) >= 0,
    toggle: (c, on) => {
      const set = String(node.className).split(/\s+/).filter((x) => x && x !== c)
      const want = on === undefined ? !node.classList.contains(c) : on === true
      if (want) set.push(c)
      node.className = set.join(' ')
    },
  }
  return node
}

/** 造一行：给各控件的值；手填行的 className 带 manual。 */
function mkRow(f) {
  const o = f || {}
  const map = {
    'mname': [el('mname', { type: 'hidden', value: o.name === undefined ? '' : o.name })],
    'mname-text': [el('mname-text', { type: 'text', value: o.name === undefined ? '' : o.name, focus() {} })],
    'm-provider': [el('m-provider', { value: o.provider === undefined ? '' : o.provider })],
    'm-model': [el('m-model', { value: o.model === undefined ? '' : o.model })],
    'mhit': [el('mhit', { value: o.hit === undefined ? '0.02' : String(o.hit) })],
    'mmiss': [el('mmiss', { value: o.miss === undefined ? '1' : String(o.miss) })],
    'mout': [el('mout', { value: o.out === undefined ? '4' : String(o.out) })],
    'mtariff': [el('mtariff on')],
    'mholiday': [el('mholiday on')],
    'm-idle': [el('m-idle', { value: o.idle === undefined ? '' : String(o.idle) })],
    'm-interval': [el('m-interval', { value: o.interval === undefined ? '' : String(o.interval) })],
  }
  const row = {
    className: 'mrow' + (o.manual ? ' manual' : ''),
    children: [map['m-provider'][0], map['m-model'][0], map['mname-text'][0], map['mname'][0]],
    getElementsByClassName: (c) => map[c] || [],
  }
  row.classList = {
    contains: (c) => String(row.className).split(/\s+/).indexOf(c) >= 0,
    toggle: (c, on) => {
      const set = String(row.className).split(/\s+/).filter((x) => x && x !== c)
      const want = on === undefined ? !row.classList.contains(c) : on === true
      if (want) set.push(c)
      row.className = set.join(' ')
    },
  }
  for (const key of Object.keys(map)) for (const n of map[key]) n.parentNode = row
  row._map = map
  return row
}

/** 用抽出的真实源码 + 桩组沙箱，返回 { api, st }。 */
function makeSandbox(opts) {
  const o = opts || {}
  const fns = ['esc', 'mrowHtml', 'effectiveHintHtml', 'providerPool', 'modelPool', 'modelOptionsHtml', 'applyKeyToSelects',
    'syncModelText', 'toggleManual', 'syncModelSelect', 'syncModelKey',
    'modelNameIssues', 'guardModelRows', 'collectModels', 'collectModelOverrides']
  const code = fns.map(extractFn).join('\n')
    + '\n' + extractHandler('saveModels') + '\n' + extractHandler('saveLimits')
  const st = {
    toasts: [],
    posts: [],
    STATE: {
      modelCatalog: o.catalog === undefined ? [] : o.catalog,
      settings: o.settings === undefined ? {} : o.settings,
      ...(o.limits === undefined ? {} : { limits: o.limits }),
    },
    rows: o.rows === undefined ? [] : o.rows,
    containers: {},
  }
  const $ = (id) => {
    if (id === 'modelRows') {
      if (st.containers.modelRows === undefined) {
        st.containers.modelRows = { getElementsByClassName: (c) => (c === 'mrow' ? st.rows : []) }
      }
      return st.containers.modelRows
    }
    if (st.containers[id] === undefined) st.containers[id] = el(id, { onclick: null })
    return st.containers[id]
  }
  const esc = (s) => String(s === undefined ? '' : s)
    .split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;')
  const toast = (msg, bad) => { st.toasts.push({ msg: String(msg), bad: bad === true }) }
  const refresh = () => { st.refreshed = (st.refreshed || 0) + 1 }
  const post = (path, body) => {
    st.posts.push({ path, body })
    return { then: (fn) => { fn({ ok: true }); return { catch: () => {} } }, catch: () => {} }
  }
  const withHandlers = code
    .replace("$('saveModels').onclick = function () {", 'var $SAVEM = function () {')
    .replace("$('saveLimits').onclick = function () {", 'var $SAVEL = function () {')
  const src = withHandlers + '\nreturn { mrowHtml: mrowHtml, toggleManual: toggleManual,'
    + ' providerPool: providerPool, modelPool: modelPool, modelNameIssues: modelNameIssues, guardModelRows: guardModelRows,'
    + ' collectModels: collectModels, collectModelOverrides: collectModelOverrides, syncModelText: syncModelText,'
    + ' saveModels: $SAVEM, saveLimits: $SAVEL }'
  const api = new Function('STATE', '$', 'esc', 'toast', 'refresh', 'post', 'isTglOn',
    'var MODELS_DIRTY = false, LIMITS_DIRTY = false;\n' + src)(
    st.STATE, $, esc, toast, refresh, post, (node) => node && node.classList.contains('on'))
  return { api, st }
}

/**
 * 跑**真实的 `paintModelRows`**（它只往 `$('modelRows').innerHTML` 写），返回生成的 HTML。
 * 用来验「门槛贴到哪一行」这类渲染期行为。
 */
function paintRowsHtml(settings) {
  const state = { modelCatalog: CATALOG, settings: settings }
  const holder = { innerHTML: '' }
  const $ = (id) => {
    if (id === 'modelRows') return holder
    return { style: {}, classList: { contains: () => false, toggle: () => {} } }
  }
  const esc = (s) => String(s === undefined ? '' : s)
    .split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;')
  const code = ['esc', 'mrowHtml', 'effectiveHintHtml', 'providerPool', 'modelPool', 'modelOptionsHtml', 'paintModelRows']
    .map(extractFn).join('\n')
  const fn = new Function('STATE', '$', 'esc', code + '\nreturn paintModelRows')
  fn(state, $, esc)()
  return holder.innerHTML
}

const CATALOG = [{ provider: 'deepseek-official', models: ['deepseek-flash', 'deepseek-v4-pro'] }]
/**
 * 3084 真实数据快照（Lead 实测）：7 个 provider，`pricesByModel` 唯一的键是
 * `deepseek-account/deepseek-flash` —— 而 deepseek-account **不在**目录里（它是插件 id，不在 llm providers 下）。
 * 这正是用户「手填关不掉」的现场。
 */
const REAL_CATALOG = [
  { provider: 'deepseek-official', models: ['deepseek-flash', 'deepseek-v4-pro'] },
  { provider: 'dots', models: ['dots3-note-prev'] },
  { provider: 'dots-title', models: ['dots3-note-prev'] },
  { provider: 'tokenrhythm', models: ['deepseek-flash', 'deepseek-v4.1-flash-1017', 'neohorse-1-9b'] },
  { provider: 'tokenrhythm-title', models: ['deepseek-flash', 'deepseek-v4.1-flash-1017'] },
  { provider: 'tokenrhythm181', models: ['deepseek-v4.1-flash-1017', 'qwen3.8-flash'] },
  { provider: 'tokenrhythm181-title', models: ['deepseek-v4.1-flash-1017', 'qwen3.8-flash'] },
]
const REAL_SETTINGS = { pricesByModel: { 'deepseek-account/deepseek-flash': { hit: 0.02, miss: 1, out: 4 } } }
const count = (html, needle) => html.split(needle).length - 1
const rowClassOf = (html) => (html.match(/<div class="mrow[^"]*"/) || [''])[0]
const mrow = (name, catalog, settings) => makeSandbox({
  catalog: catalog === undefined ? CATALOG : catalog,
  settings: settings === undefined ? {} : settings,
}).api.mrowHtml(name, { hit: 0.02, miss: 1, out: 4 })
/** 取某个 select 里的 option 列表：`value` 与是否 selected。 */
const optionsOf = (html, cls) => {
  const seg = html.slice(html.indexOf('<select class="' + cls + '"'))
  const end = seg.indexOf('</select>')
  const body = end < 0 ? seg : seg.slice(0, end)
  return [...body.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)]
    .map((m) => ({ value: m[1], selected: m[2].includes('selected'), text: m[3] }))
}

/* ── R1：结构不变式 ─────────────────────────────────────────── */
test('R1 三种输入下 class="mname" 恒 1 个且都是 type="hidden"', () => {
  for (const name of ['deepseek-official/deepseek-flash', 'deepseek-flash', 'my-own/vendor-model-x']) {
    const html = mrow(name)
    assert.equal(count(html, 'class="mname"'), 1, name + ' 的 .mname 个数')
    assert.ok(html.includes('<input type="hidden" class="mname"'), name + ' 的 .mname 必须是 hidden')
    assert.equal(count(html, 'class="mname-text"'), 1, name + ' 的 .mname-text 个数')
    assert.equal(count(html, 'class="m-provider"'), 1, name + ' 的 .m-provider 个数')
    assert.equal(count(html, 'class="m-model"'), 1, name + ' 的 .m-model 个数')
  }
})

test('R1 带 provider 前缀的键一律下拉态（目录里没有也不强制手填）', () => {
  assert.equal(rowClassOf(mrow('deepseek-official/deepseek-flash')), '<div class="mrow"')
  assert.equal(rowClassOf(mrow('deepseek-flash')), '<div class="mrow"')
  // 目录里没有的 provider（如用户真实在用的 deepseek-account）也进池 → 不强制手填
  assert.equal(rowClassOf(mrow('my-own/vendor-model-x')), '<div class="mrow"')
  // 只有"无斜杠的裸名且在目录里反查不到"才退回手填
  assert.equal(rowClassOf(mrow('no-such-model-anywhere')), '<div class="mrow manual"')
})

test('R1 三种输入的结构完全一致（归一掉选项池与行类后逐字节比较）', () => {
  /**
   * 只归一两类**必然随数据变**的东西：`<option>` 池、行类（manual 只体现在类上）。
   * 其余一切（属性、标签、顺序、空白）逐字节比较 —— 这样才能抓住「多一个 data-* 属性 / 少一个控件」这类漂移。
   * （纯计数断言抓不住：注入 `data-auto="1"` 时控件数不变，旧写法照样绿。）
   */
  const norm = (h) => h
    .replace(/<option\b[\s\S]*?<\/option>/g, '')
    .replace(/class="mrow[^"]*"/g, 'class="mrow"')
    .replace(/class="tgl m-manual[^"]*"/g, 'class="tgl m-manual"')
    .replace(/value="[^"]*"/g, 'value=""')
  const a = norm(mrow('deepseek-official/deepseek-flash'))
  const b = norm(mrow('deepseek-flash'))
  const c = norm(mrow('my-own/vendor-model-x'))
  assert.ok(a.includes('class="mname-text"'), '归一后仍应保留控件（防归一化把整段吃掉）')
  assert.equal(a, b, '已知 vs 裸模型名：结构不同（option 池除外）')
  assert.equal(a, c, '已知 vs 目录里没有：结构不同（option 池除外）')
})

test('R1 mrowHtml 源码里不再有 text 版 .mname', () => {
  const src = extractFn('mrowHtml')
  assert.ok(!src.includes('class="mname" list='), '仍存在 text 版 mname')
  assert.ok(!/class="mname"[^>]*type="text"/.test(src), '仍存在 type=text 的 mname')
})

test('R1 三种输入的 HTML 归一后完全一致（只差行类）', () => {
  /**
   * **provider 下拉整段换成占位符再比**：provider 池允许并入「当前键的 provider」
   * （真机 3084 的 `deepseek-account` 不在目录里，不并进去就选不中 —— 这正是「手填关不掉」那个 bug），
   * 所以池大小**随输入而变**（目录里的键 1 个、目录里没有的键 2 个）。
   * R1 要守的是「除**池内容/池大小**与**行类**外，结构逐字节一致」—— 池大小不在守备范围。
   * ⚠️ 归一范围只到 provider 下拉为止：model 下拉、按钮、价格框、隐藏域一律照原样比。
   */
  const norm = (html) => html
    .replace(/<select class="m-provider"[\s\S]*?<\/select>/, '<select class="m-provider"/>')
    .replace(/value="[^"]*"/g, 'value="V"')
    .replace(/<option[^>]*>[^<]*<\/option>/g, '<option/>')
    .replace(/class="mrow[^"]*"/, 'class="mrow"')
    .replace(/class="tgl m-manual[^"]*"/g, 'class="tgl m-manual"')
  const a = norm(mrow('deepseek-official/deepseek-flash'))
  const b = norm(mrow('deepseek-flash'))
  const c = norm(mrow('my-own/vendor-model-x'))
  assert.equal(a, b, '已知 vs 裸模型名 结构不同')
  assert.equal(a, c, '已知 vs 目录里没有 结构不同')
})

/* ── D1：手填切换零 DOM 增删 ────────────────────────────────── */
test('D1 toggleManual 函数体不含任何 DOM 增删/重建 API', () => {
  const src = extractFn('toggleManual')
  for (const bad of ['insertBefore', 'appendChild', 'removeChild', 'replaceChild', 'innerHTML', 'createElement', 'children.slice']) {
    assert.ok(!src.includes(bad), 'toggleManual 里仍有 ' + bad)
  }
})

test('D1 toggleManual 只切 .manual 类并同步隐藏域与手填框', () => {
  const row = mkRow({ name: 'deepseek-official/deepseek-flash' })
  const box = makeSandbox({ catalog: CATALOG, rows: [row] })
  const btn = el('tgl m-manual')
  btn.parentNode = row
  box.api.toggleManual(btn)
  assert.ok(row.classList.contains('manual'), '切手填后行类应含 manual')
  assert.ok(btn.classList.contains('on'), '按钮应变亮')
  assert.equal(row._map['mname-text'][0].value, 'deepseek-official/deepseek-flash', '手填框应带出当前键')
  // 再点一次切回下拉（该键在目录里，能解析）
  box.api.toggleManual(btn)
  assert.ok(!row.classList.contains('manual'), '再点应取消 manual')
  assert.equal(row._map['mname'][0].value, 'deepseek-official/deepseek-flash', '切回后隐藏域仍是规范键')
})

test('D1 手填框输入写回唯一数据源（隐藏域）', () => {
  const row = mkRow({ name: 'old/key', manual: true })
  const box = makeSandbox({ rows: [row] })
  const txt = row._map['mname-text'][0]
  txt.value = '  New/Model  '
  box.api.syncModelText(txt)
  assert.equal(row._map['mname'][0].value, 'New/Model')
})

test('D1 CSS：按行类显隐三个控件（切手填不改结构）', () => {
  assert.ok(SRC.includes('.mrow.manual .m-provider, .mrow.manual .m-model { display: none; }'),
    '缺少隐藏下拉的 CSS')
  assert.ok(SRC.includes('.mrow:not(.manual) .mname-text { display: none; }'),
    '缺少隐藏手填框的 CSS')
})

/* ── D2：两个保存按钮各管一半 ───────────────────────────────── */
test('D2 一颗保存按钮：一次 post 同时带 pricesByModel 与 modelOverrides', () => {
  const box = makeSandbox({ rows: [mkRow({ name: 'deepseek-official/deepseek-flash', idle: '2' })] })
  box.api.saveModels()
  assert.equal(box.st.posts.length, 1, '只应发一次请求')
  assert.deepEqual(Object.keys(box.st.posts[0].body).sort(), ['modelOverrides', 'pricesByModel'])
  /**
   * ⚠️ 这里原本还有一条 `assert.equal(box.api.saveLimits, undefined, …)`，已删：
   * `saveLimits` **必须存在** —— 同批的「保存时间门槛只 post modelOverrides 一个键」要调用它，
   * 且 `makeSandbox()` 用 `extractHandler('saveLimits')` 取处理器入参（删掉它 20 条测试会一起崩）。
   * 「saveModels 一颗按钮同时带两个键」由上面两条断言守着，删这条不影响覆盖。
   */
})

/* ── 0069：并回「面板外键」+ 门槛精确匹配 ──────────────────── */
test('★ 0069-B：面板上没有对应行的门槛键（C）必须被并回 payload', () => {
  // 价格表只有 A、B；门槛表有 A、B、C（C 是遗留）
  const rows = [mkRow({ name: 'prov-a/m1' }), mkRow({ name: 'prov-b/m1' })]
  const settings = {
    pricesByModel: { 'prov-a/m1': {}, 'prov-b/m1': {} },
    modelOverrides: { 'prov-a/m1': {}, 'prov-b/m1': {}, 'prov-c/m3': { idleLimitHours: 5 } },
  }
  const box = makeSandbox({ rows: rows, settings: settings })
  box.api.saveModels()
  const ov = box.st.posts[0].body.modelOverrides
  assert.ok(Object.prototype.hasOwnProperty.call(ov, 'prov-c/m3'), '面板外键 C 必须保留：' + JSON.stringify(ov))
  assert.deepEqual(ov['prov-c/m3'], { idleLimitHours: 5 }, 'C 的原值必须原样带回')
})

test('★ 0069-B：面板行 A 留空 → 该键不写（清空必须生效，不能被当成"外键"并回）', () => {
  const rows = [mkRow({ name: 'prov-a/m1' })] // m-idle / m-interval 都留空
  const settings = {
    pricesByModel: { 'prov-a/m1': {} },
    modelOverrides: { 'prov-a/m1': { idleLimitHours: 9 }, 'prov-c/m3': { idleLimitHours: 5 } },
  }
  const box = makeSandbox({ rows: rows, settings: settings })
  box.api.saveModels()
  const ov = box.st.posts[0].body.modelOverrides
  assert.ok(!Object.prototype.hasOwnProperty.call(ov, 'prov-a/m1'), 'A 被清空后不应再写：' + JSON.stringify(ov))
  assert.ok(Object.prototype.hasOwnProperty.call(ov, 'prov-c/m3'), '外键 C 仍要并回')
})

test('★ 0069-C：门槛贴行用精确匹配（子串键不会被误贴）', () => {
  /**
   * 构造「一个键是另一个键的子串」才暴露差异：
   * 价格表有 `prov-a/m1` 与裸名 `m1`，门槛表只有 `prov-a/m1`。
   *  - 精确匹配：`prov-a/m1` 行显示 7，`m1` 行留空（老数据裸名键靠 0069-B 并回，显示不上但不丢）
   *  - 包含匹配（旧实现）：`'prov-a/m1'.indexOf('m1') >= 0` → `m1` 行也被贴上 7（错）
   */
  const html = paintRowsHtml({
    pricesByModel: { 'prov-a/m1': {}, 'm1': {} },
    modelOverrides: { 'prov-a/m1': { idleLimitHours: 7 } },
  })
  const rows = html.split('<div class="mrow')
  const values = rows.slice(1).map((seg) => (seg.match(/class="m-idle"[^>]*value="([^"]*)"/) || [])[1])
  assert.deepEqual(values, ['7', ''], '只有 prov-a/m1 那行显示 7，裸名 m1 那行必须留空')
})

test('D2 保存时间门槛只 post modelOverrides 一个键', () => {
  const box = makeSandbox({ rows: [mkRow({ name: 'deepseek-official/deepseek-flash', idle: '2' })] })
  box.api.saveLimits()
  assert.equal(box.st.posts.length, 1)
  assert.deepEqual(Object.keys(box.st.posts[0].body), ['modelOverrides'])
})

/* ── D4 / D5：保存前校验 ────────────────────────────────────── */
test('D4 有空名行 → 保存中止、不 post、toast 指出第几行', () => {
  const box = makeSandbox({ rows: [mkRow({ name: 'a/b' }), mkRow({ name: '' })] })
  box.api.saveModels()
  box.api.saveLimits()
  assert.equal(box.st.posts.length, 0, '不应该发出任何 post')
  const said = box.st.toasts.some((t) => t.bad && t.msg.includes('第2行模型名为空'))
  assert.ok(said, 'toast 应指出第2行模型名为空')
})

test('D5 两行重名 → 保存中止、不 post、toast 指出重名行号', () => {
  const box = makeSandbox({ rows: [mkRow({ name: 'a/b' }), mkRow({ name: 'A/B' })] })
  box.api.saveModels()
  assert.equal(box.st.posts.length, 0, '不应该发出 post')
  const said = box.st.toasts.some((t) => t.bad && t.msg.includes('重名') && t.msg.includes('第2行'))
  assert.ok(said, 'toast 应指出第2行重名')
})

/* ── D3：键口径 ─────────────────────────────────────────────── */
test('D3 modelOverrides 的键取 provider/model（与 pricesByModel 同源）', () => {
  const box = makeSandbox({ rows: [mkRow({ name: 'deepseek-official/deepseek-flash', idle: '2', interval: '3600' })] })
  const ov = box.api.collectModelOverrides()
  assert.deepEqual(Object.keys(ov), ['deepseek-official/deepseek-flash'])
  assert.equal(ov['deepseek-official/deepseek-flash'].idleLimitHours, 2)
  assert.equal(ov['deepseek-official/deepseek-flash'].intervalSeconds, 3600)
})

test('D3 后端 effectiveLimitsOf 能精确命中 provider/model 键（2 小时）', () => {
  const settings = Object.assign({}, DEFAULT_SETTINGS, {
    idleLimitHours: 8,
    intervalSeconds: 4 * 3600,
    modelOverrides: { 'deepseek-official/deepseek-flash': { idleLimitHours: 2 } },
  })
  assert.equal(effectiveLimitsOf(settings, 'deepseek-official', 'deepseek-flash').idleLimitMs, 2 * 3600_000)
  // 别的模型不受影响，回落通用 8 小时
  assert.equal(effectiveLimitsOf(settings, 'other-provider', 'other-model').idleLimitMs, 8 * 3600_000)
})

/* ── 用户报障：#5 选项池 = 目录 ∪ 现有数据，永远不拦 ────────── */
test('★ 空目录最坏桩（19388 现状）：deepseek-account 仍进 provider 池且被选中、不强制手填', () => {
  // 19388 离线面板真实情况：modelCatalog 是 null/空，价表里唯一的键是 deepseek-account/deepseek-flash
  const html = mrow('deepseek-account/deepseek-flash', [], REAL_SETTINGS)
  assert.notEqual(rowClassOf(html), '<div class="mrow manual"', '空目录时不该强制手填')
  const providers = optionsOf(html, 'm-provider')
  const hit = providers.filter((o) => o.value === 'deepseek-account')
  assert.equal(hit.length, 1, 'provider 池里必须有 deepseek-account：' + JSON.stringify(providers.map((o) => o.value)))
  assert.equal(hit[0].selected, true, 'deepseek-account 必须 selected')
  const models = optionsOf(html, 'm-model')
  const m = models.filter((o) => o.value === 'deepseek-flash')
  assert.equal(m.length, 1, 'model 池里必须有 deepseek-flash')
  assert.equal(m[0].selected, true, 'deepseek-flash 必须 selected')
})

test('★ provider 池包含 pricesByModel 里其它键的 provider（同一份数据可互相切换）', () => {
  const settings = { pricesByModel: { 'other-provider/x-model': {} } }
  const html = mrow('deepseek-official/deepseek-flash', CATALOG, settings)
  const vals = optionsOf(html, 'm-provider').map((o) => o.value)
  assert.ok(vals.includes('deepseek-official'), '目录里的 provider 应在池里')
  assert.ok(vals.includes('other-provider'), '价表里其它键的 provider 也应进池：' + JSON.stringify(vals))
  assert.deepEqual(vals, [...vals].sort(), 'provider 池应排序')
})

test('★ toggleManual 关手填一律放行：键完全不在目录也不在价表里，也不 toast、不返回', () => {
  const row = mkRow({ name: 'ghost-provider/ghost-model', manual: true })
  const box = makeSandbox({ catalog: [], settings: {}, rows: [row] })
  const btn = el('tgl m-manual on')
  btn.parentNode = row
  box.api.toggleManual(btn)
  assert.equal(box.st.toasts.length, 0, '不应弹任何提示：' + JSON.stringify(box.st.toasts))
  assert.ok(!row.classList.contains('manual'), '手填态必须被关掉')
  assert.equal(row._map['mname'][0].value, 'ghost-provider/ghost-model', '隐藏域必须保持该键（不丢数据）')
  assert.equal(row._map['m-provider'][0].value, 'ghost-provider', 'provider 下拉应对齐到该键')
})

test('R8+ 供应商/模型下拉改 min-width（长 provider 名不被截断）', () => {
  const cat = CATALOG.concat([{ provider: 'tokenrhythm181-title', models: ['deepseek-v4.1-flash-1017'] }])
  for (const key of ['deepseek-account/deepseek-flash', 'tokenrhythm181-title/deepseek-v4.1-flash-1017']) {
    const html = mrow(key, cat)
    // 精确取 style 属性值：min-width 里含 width 子串，不能用 includes 判
    const pStyle = (html.match(/<select class="m-provider"[^>]*style="([^"]*)"/) || [])[1]
    const mStyle = (html.match(/<select class="m-model"[^>]*style="([^"]*)"/) || [])[1]
    assert.equal(pStyle, 'min-width:130px', key + ' 的 provider 下拉应是 min-width')
    assert.equal(mStyle, 'min-width:170px', key + ' 的 model 下拉应是 min-width')
    assert.ok(!/^width:/.test(String(pStyle)), key + ' 的 provider 下拉不能是固定 width（长名会被截断）')
    // 长 provider 名必须完整出现在 option 里（供浏览器按内容撑开）
    const pv = key.slice(0, key.indexOf('/'))
    const opt = optionsOf(html, 'm-provider').find((o) => o.value === pv)
    assert.ok(opt !== undefined, key + ' 的 provider 选项缺失')
    assert.equal(opt.text, pv, key + ' 的 provider 选项文字必须完整')
    assert.equal(opt.selected, true, key + ' 的 provider 必须 selected')
  }
})

/* ── R7：开关一律 .tgl 按钮，面板 0 个 checkbox ─────────────── */
test('R7 面板 HTML 里 type="checkbox" 计数为 0（UI 规范 F20）', () => {
  assert.equal(count(SRC, 'type="checkbox"'), 0, 'PANEL_HTML 里仍有 checkbox')
})

test('R7 手填开关是 .tgl 按钮（不是 checkbox）', () => {
  const html = mrow('my-own/vendor-model-x')
  assert.ok(count(html, 'class="tgl m-manual') === 1, '手填开关应是 .tgl 按钮')
  assert.ok(!html.includes('checkbox'), '手填开关里出现了 checkbox')
  assert.ok(SRC.includes("onclick=\"toggleManual(this)\""), '手填按钮应直连 toggleManual')
})

/* ── R8：三个价格框 62px 且紧跟「元/M」─────────────────────── */
test('R8 三个价格框都是 width:62px，且每个紧跟含 元/M 的提示', () => {
  const html = mrow('deepseek-official/deepseek-flash')
  const unitRightAfter = (cls, nextMarkers) => {
    const start = html.indexOf('class="' + cls + '"')
    assert.ok(start >= 0, '找不到 ' + cls)
    let end = html.length
    for (const m of nextMarkers) {
      const j = html.indexOf(m, start + 1)
      if (j > 0 && j < end) end = j
    }
    const seg = html.slice(start, end)
    assert.ok(seg.includes('width:62px'), cls + ' 不是 width:62px')
    assert.ok(seg.includes('元/M'), cls + ' 后面没有紧跟 元/M')
  }
  unitRightAfter('mhit', ['class="mmiss"'])
  unitRightAfter('mmiss', ['class="mout"'])
  unitRightAfter('mout', ['class="mtariff"'])
})
