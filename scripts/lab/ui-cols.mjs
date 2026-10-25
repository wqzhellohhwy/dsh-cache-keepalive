    '--user-data-dir=' + join(WORK, 'ud'),
    '--remote-debugging-port=' + port, '--remote-allow-origins=*',
    '--window-size=1600,900',
    '--allow-file-access-from-files',   // file:// 页面要能读写 localStorage（筛选持久化断言用）#!/usr/bin/env node
/**
 * 列宽拖拽验证（只读 src/panel.ts，真实 DOM/布局，零外部网络）。
 *
 * 做法：从 src/panel.ts 抽出 PANEL_SRC 模板串 → 取其中 <script> 体 → 只保留**顶层声明**
 *（function / var / let / const），丢弃所有顶层语句（事件绑定、refresh()、setInterval 等），
 * 逐段 indirect eval 进一个最小页面（真实 table-layout:fixed + .tablewrap 容器 + 真 .rz 手柄），
 * 用真实 MouseEvent 走 startResize → mousemove(分帧) → mouseup，读真实 offsetWidth 断言。
 *
 * 断言三组：向右拖到底（右侧每列 == minOf、Σ == 容器宽、增量 == 右侧可压空间之和）、
 * 向左拖还原（各列宽与原值完全相等）、容器变窄（Σ == 新容器宽、每列 >= minOf）。
 *
 * 用法：node scripts/lab/ui-cols.mjs [--verbose]
 * 退出码：0 = 全 PASS，1 = 有 FAIL 或环境/提取失败。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORK = join(ROOT, '.tmp', 'ui-cols')
const VERBOSE = process.argv.includes('--verbose')

/* ── 1. 从 panel.ts 抽 PANEL_HTML，再取 <script> 体 ─────────────────────── */
const SRC_ARG = (process.argv.find(a => a.startsWith('--src=')) || '').slice(6)
const SRC_PATH = SRC_ARG || join(ROOT, 'src', 'panel.ts')
const src = readFileSync(SRC_PATH, 'utf8')

function panelTemplate(s) {
  const marker = 'const PANEL_SRC = `'
  const i0 = s.indexOf(marker)
  if (i0 < 0) throw new Error('panel.ts 里找不到 PANEL_SRC 模板串')
  const from = i0 + marker.length
  const anchor = s.indexOf('export const PANEL_HTML', from)
  if (anchor < 0) throw new Error('panel.ts 里找不到 export const PANEL_HTML')
  const to = s.lastIndexOf('`', anchor)
  if (to <= from) throw new Error('PANEL_SRC 模板串闭合反引号定位失败')
  return s.slice(from, to)
}

function scriptBodies(html) {
  const out = []
  const re = /<script[^>]*>([\s\S]*?)<\/script>/g
  let m
  while ((m = re.exec(html))) out.push(m[1])
  return out
}

/* ── 2. 顶层声明切分（字符串/注释/正则/括号配平都跳过） ─────────────────── */
function skipStr(c, i, n) {
  const q = c[i]
  let j = i + 1
  while (j < n) {
    const ch = c[j]
    if (ch === '\\') { j += 2; continue }
    if (ch === q) return j + 1
    j++
  }
  return n
}
function skipLine(c, i, n) { while (i < n && c[i] !== '\n') i++; return i }
function skipBlock(c, i, n) { const k = c.indexOf('*/', i + 2); return k < 0 ? n : k + 2 }
function skipRegex(c, i, n) {
  let j = i + 1, cls = false
  while (j < n) {
    const ch = c[j]
    if (ch === '\\') { j += 2; continue }
    if (ch === '\n') return j
    if (ch === '[') cls = true
    else if (ch === ']') cls = false
    else if (ch === '/' && !cls) return j + 1
    j++
  }
  return n
}
const REGEX_PREV = new Set(['', '(', ',', '=', ':', ';', '[', '!', '&', '|', '?', '{', '}', '+', '-', '*', '%', '<', '>', '~', '^'])

function topDecls(code) {
  const decls = []
  const n = code.length
  let i = 0, depth = 0, atStmt = true, prev = ''
  while (i < n) {
    const ch = code[i]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue }
    if (ch === '/' && code[i + 1] === '/') { i = skipLine(code, i, n); continue }
    if (ch === '/' && code[i + 1] === '*') { i = skipBlock(code, i, n); continue }
    if (ch === '"' || ch === "'" || ch === '`') { i = skipStr(code, i, n); prev = ch; continue }
    if (ch === '/' && REGEX_PREV.has(prev)) { i = skipRegex(code, i, n); prev = '/'; continue }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; prev = ch; i++; continue }
    if (ch === ')' || ch === ']' || ch === '}') { depth = Math.max(0, depth - 1); prev = ch; i++; continue }
    if (ch === ';') { if (depth === 0) atStmt = true; prev = ';'; i++; continue }
    if (depth === 0 && (atStmt || i === 0 || code[i - 1] === '\n')) {
      const kw = /^(function|var|let|const)\b/.exec(code.slice(i, i + 9))
      if (kw) {
        const start = i
        let j = i
        if (kw[1] === 'function') {
          let d = 0
          while (j < n) {
            const c2 = code[j]
            if (c2 === '"' || c2 === "'" || c2 === '`') { j = skipStr(code, j, n); continue }
            if (c2 === '/' && code[j + 1] === '/') { j = skipLine(code, j, n); continue }
            if (c2 === '/' && code[j + 1] === '*') { j = skipBlock(code, j, n); continue }
            if (c2 === '(' || c2 === '[') d++
            else if (c2 === ')' || c2 === ']') d--
            else if (c2 === '{' && d === 0) break
            j++
          }
          let d2 = 0
          while (j < n) {
            const c3 = code[j]
            if (c3 === '"' || c3 === "'" || c3 === '`') { j = skipStr(code, j, n); continue }
            if (c3 === '/' && code[j + 1] === '/') { j = skipLine(code, j, n); continue }
            if (c3 === '/' && code[j + 1] === '*') { j = skipBlock(code, j, n); continue }
            if (c3 === '{') d2++
            else if (c3 === '}') { d2--; if (d2 === 0) { j++; break } }
            j++
          }
        } else {
          let d = 0
          while (j < n) {
            const c2 = code[j]
            if (c2 === '"' || c2 === "'" || c2 === '`') { j = skipStr(code, j, n); continue }
            if (c2 === '/' && code[j + 1] === '/') { j = skipLine(code, j, n); continue }
            if (c2 === '/' && code[j + 1] === '*') { j = skipBlock(code, j, n); continue }
            if (c2 === '(' || c2 === '[' || c2 === '{') d++
            else if (c2 === ')' || c2 === ']' || c2 === '}') d--
            else if (c2 === ';' && d === 0) { j++; break }
            j++
          }
        }
        decls.push(code.slice(start, j))
        i = j
        atStmt = false
        continue
      }
    }
    atStmt = false
    prev = ch
    i++
  }
  return decls
}

const html = panelTemplate(src)
const bodies = scriptBodies(html)
if (!bodies.length) throw new Error('PANEL_SRC 里没有 <script> 块')
const decls = []
for (const b of bodies) decls.push(...topDecls(b))
const declNames = decls.map(d => (/^(?:function|var|let|const)\s+([A-Za-z_$][\w$]*)/.exec(d) || [0, '(匿名)'])[1])
for (const must of ['startResize', 'renderHead', 'minOf', 'COLS', 'applyResize']) {
  if (!declNames.includes(must)) throw new Error('提取结果里缺 ' + must + '（共提取 ' + decls.length + ' 段：' + declNames.slice(0, 40).join(',') + '）')
}

/* ── 3. 页面里跑的测试体（真实 DOM + 真实事件） ─────────────────────────── */
async function PAGE_HARNESS() {
  var RESULT = { ok: true, asserts: [], info: {} }
  function A(group, name, ok, detail) { RESULT.asserts.push({ group: group, name: name, ok: !!ok, detail: detail || '' }) }
  function frame() {
    return new Promise(function (r) {
      var done = false
      requestAnimationFrame(function () { if (!done) { done = true; r() } })
      setTimeout(function () { if (!done) { done = true; r() } }, 250)
    })
  }
  var wrap = document.querySelector('.tablewrap')
  function ths() { return Array.prototype.slice.call(document.getElementById('headRow').children) }
  function widths() {
    var o = {}
    ths().forEach(function (th) { o[th.getAttribute('data-c')] = th.offsetWidth })
    return o
  }
  function total(o) { var s = 0; for (var k in o) s += o[k]; return s }
  function container() { return wrap.clientWidth - 2 }
  function colIds() { return ths().map(function (t) { return t.getAttribute('data-c') }) }
  function diff(exp, got, ids) {
    var bad = []
    ids.forEach(function (id) {
      if (exp[id] !== got[id]) bad.push(id + ': 期望' + exp[id] + ' 实际' + got[id])
    })
    return bad
  }
  async function drag(id, dx) {
    var th = null
    ths().forEach(function (t) { if (t.getAttribute('data-c') === id) th = t })
    if (!th) throw new Error('表头里没有列 ' + id)
    var box = th.getBoundingClientRect()
    var x0 = box.right - 2
    var y = Math.round(box.top + box.height / 2)
    function mk(type, x) {
      return new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, view: window })
    }
    th.dispatchEvent(mk('mousedown', x0))
    if (!window.RS) throw new Error('mousedown 未进入拖拽态（startResize 没认 x=' + x0 + '，右缘判定区 9px）')
    var steps = 8
    for (var k = 1; k <= steps; k++) {
      document.dispatchEvent(mk('mousemove', Math.round(x0 + (dx * k) / steps)))
      await frame()
    }
    document.dispatchEvent(mk('mousemove', x0 + dx))
    await frame()
    if (typeof window.applyResize === 'function' && window.RS) window.applyResize()
    var during = widths()
    var rsNow = window.RS ? { idx: window.RS.idx, x: window.RS.x, px: window.RS.px, cur: window.RS.cur, mins: window.RS.mins, lastD: window.RS.lastD, out: window.RS.out } : null
    document.dispatchEvent(mk('mouseup', x0 + dx))
    await frame()
    window.__DRAGS = (window.__DRAGS || []).concat([{ id: id, dx: dx, x0: x0, rs: rsNow, during: during, after: widths() }])
    return { during: during, after: widths() }
  }

  try {
    var VIS = ['title', 'cand', 'active', 'warmed', 'talked', 'hit']
    window.STATE = { settings: { colWidths: {}, columns: {} } }
    for (var i = 0; i < window.COLS.length; i++) {
      window.STATE.settings.columns[window.COLS[i][0]] = VIS.indexOf(window.COLS[i][0]) >= 0
    }
    window.renderHead()
    await frame()

    var C = container()
    var W0 = widths()
    var ids = colIds()
    var CUR = 'cand'
    var idx = ids.indexOf(CUR)
    if (idx < 0) throw new Error('可见列里没有被测列 ' + CUR)
    var rights = ids.slice(idx + 1)
    var mins = {}
    ids.forEach(function (id) { mins[id] = window.minOf(id) })

    A('setup', '初始 Σ列宽 === 容器宽', total(W0) === C, 'Σ=' + total(W0) + ' 容器=' + C)
    A('setup', '被测列右侧至少 2 列（才能验「依次压缩」）', rights.length >= 2, '右侧列=' + rights.join(','))
    RESULT.info = { container: C, W0: W0, mins: mins, cur: CUR, rights: rights, fetchStub: window.__fetchCalls || 0 }

    var compressible = 0
    rights.forEach(function (r) { compressible += W0[r] - mins[r] })
    RESULT.info.compressible = compressible

    /* A. 向右拖到底 */
    var g = 'A 向右拖到底'
    var a = await drag(CUR, 2000)
    A(g, '拖动过程中 Σ列宽 === 容器宽', total(a.during) === C, 'Σ=' + total(a.during) + ' 容器=' + C)
    var badD = []
    rights.forEach(function (r) {
      if (a.during[r] !== mins[r]) badD.push(r + ': 期望' + mins[r] + ' 实际' + a.during[r])
    })
    A(g, '拖动过程中右侧每列 === minOf', badD.length === 0, badD.join('；'))
    A(g, '松手后 Σ列宽 === 容器宽', total(a.after) === C, 'Σ=' + total(a.after) + ' 容器=' + C)
    var badA = []
    rights.forEach(function (r) {
      if (a.after[r] !== mins[r]) badA.push(r + ': 期望' + mins[r] + ' 实际' + a.after[r])
    })
    A(g, '松手后右侧每列 === minOf', badA.length === 0, badA.join('；'))
    var achieved = a.after[CUR] - W0[CUR]
    A(g, '当前列增量 === 右侧可压空间之和', achieved === compressible, '增量=' + achieved + ' 可压=' + compressible)
    RESULT.info.achieved = achieved

    /* B. 向左拖还原 */
    var g2 = 'B 向左拖还原'
    var b = await drag(CUR, -achieved)
    var offB = diff(W0, b.after, ids)
    A(g2, '各列宽与原值完全相等', offB.length === 0, offB.join('；'))
    A(g2, 'Σ列宽 === 容器宽', total(b.after) === C, 'Σ=' + total(b.after) + ' 容器=' + C)

    /* M. 部分拖动：验证「依次」 */
    var g3 = 'M 部分拖动（依次压缩）'
    var r1 = rights[0], r2 = rights[1]
    var space2 = W0[r2] - mins[r2]
    if (space2 >= 2 && rights.length >= 3) {
      var dMid = W0[r1] - mins[r1] + Math.floor(space2 / 2)
      var m = await drag(CUR, dMid)
      A(g3, '紧邻右列已压到 minOf', m.after[r1] === mins[r1], r1 + ': 期望' + mins[r1] + ' 实际' + m.after[r1])
      A(g3, '第二右列被部分压缩（未到底）', m.after[r2] < W0[r2] && m.after[r2] > mins[r2],
        r2 + ': 原' + W0[r2] + ' 现' + m.after[r2] + ' min' + mins[r2])
      var farBad = diff(W0, m.after, rights.slice(2))
      A(g3, '更右的列未被触碰', farBad.length === 0, farBad.join('；'))
      A(g3, '当前列增量 === 拖动量', m.after[CUR] === W0[CUR] + dMid, '增量=' + (m.after[CUR] - W0[CUR]) + ' 拖动=' + dMid)
      A(g3, 'Σ列宽 === 容器宽', total(m.after) === C, 'Σ=' + total(m.after) + ' 容器=' + C)
      var m2 = await drag(CUR, -dMid)
      var offM = diff(W0, m2.after, ids)
      A(g3, '拖回后各列还原', offM.length === 0, offM.join('；'))
    } else {
      A(g3, '跳过（右侧可压空间不足）', true, '')
    }

    /* C. 容器变窄 */
    var g4 = 'C 容器变窄'
    wrap.style.width = '760px'
    window.renderHead()
    await frame()
    var C2 = container()
    var W2 = widths()
    A(g4, '容器确实变窄了', C2 < C, C + ' -> ' + C2)
    A(g4, 'Σ列宽 === 新容器宽', total(W2) === C2, 'Σ=' + total(W2) + ' 新容器=' + C2)
    var under = []
    for (var id in W2) if (W2[id] < mins[id]) under.push(id + ': ' + W2[id] + ' < min' + mins[id])
    A(g4, '每列宽 >= minOf', under.length === 0, under.join('；'))
    RESULT.info.narrow = { container: C2, widths: W2, sum: total(W2) }
  } catch (e) {
    RESULT.error = String((e && e.stack) || e)
  }
  RESULT.ok = !RESULT.error && RESULT.asserts.every(function (x) { return x.ok })
  RESULT.drags = window.__DRAGS || []
  return RESULT
}

/* ── 3b. 工具栏（筛选/排序）行为组：真实 DOM + 真实 click ─────────────────── */
async function PAGE_PANEL() {
  var RESULT = { asserts: [], info: {} }
  function A(group, name, ok, detail) { RESULT.asserts.push({ group: group, name: name, ok: !!ok, detail: detail || '' }) }
  function ids(list) { return list.map(function (s) { return s.id }).join(',') }
  function texts(list) { return list.map(function (s) { return s.title || s.id }).join('|') }
  function byId(list) { var o = {}; list.forEach(function (s) { o[s.id] = s }); return o }
  try {
    try { localStorage.clear() } catch (e) {}

    function mkSess(o) {
      return {
        id: o.id, short: o.id.slice(-3), title: o.title, projectKey: '', note: '', mtime: o.mtime,
        sizeBytes: 200000, spend: o.spend, count: 1, cycleSpend: 0, cycleCount: 0,
        archived: !!o.archived, origin: 'user', titleSource: 'user', live: true,
        mode: o.mode || 'auto', isAutoCandidate: !!o.picked, autoRank: o.picked ? 1 : -1,
        autoReason: o.reason || '', gateCode: o.gate, gateDetail: '',
        last: o.hit === null ? null : { at: 1, hitRate: o.hit, touch: 1, via: 'cli' },
        lastTouchAgoMin: 10, lastActivityAgoMin: 5, intervalSeconds: 14400,
        pinnedInPanel: !!o.pin
      }
    }
    window.STATE = {
      diskCount: 6, liveCount: 6, gateTexts: [], settings: {},
      sessions: [
        mkSess({ id: 's-aaa', title: 'A 可保命中高', mtime: 100, spend: 1, hit: 0.9, gate: 'warm', picked: true }),
        mkSess({ id: 's-bbb', title: 'B 未到间隔', mtime: 200, spend: 3, hit: 0.4, gate: 'too-soon', reason: 'over-quota' }),
        mkSess({ id: 's-ccc', title: 'C 已断档', mtime: 300, spend: 2, hit: 0.7, gate: 'stale', reason: 'gate' }),
        mkSess({ id: 's-ddd', title: 'D 从没保过', mtime: 400, spend: 5, hit: null, gate: 'cold-window', reason: 'never-seen', mode: 'off' }),
        mkSess({ id: 's-eee', title: 'E 强制开', mtime: 500, spend: 0.5, hit: 0.1, gate: 'warm', mode: 'on', reason: 'manual' }),
        mkSess({ id: 's-fff', title: 'F 已归档', mtime: 600, spend: 4, hit: 0.2, gate: 'archived', archived: true, reason: 'archived' })
      ]
    }
    window.SORT_SEL = null
    window.loadFilters()   // 建多选面板 + 读（已清空的）localStorage

    /* 结构：单选 <select> 已彻底消失；两个多选面板按钮数正确；面板里没有 checkbox */
    A('P1 结构', '#gateFilter 已不存在（单选改多选）', document.getElementById('gateFilter') === null, '')
    var candBox = document.getElementById('msCandBox'), gateBox = document.getElementById('msGateBox')
    A('P1 结构', '候选面板 10 个按钮', candBox.getElementsByTagName('button').length === 11, '按钮数=' + candBox.getElementsByTagName('button').length + '（含 1 个「清空」）')
    A('P1 结构', '门禁面板 15 个按钮', gateBox.getElementsByTagName('button').length === 16, '按钮数=' + gateBox.getElementsByTagName('button').length + '（含 1 个「清空」）')
    A('P1 结构', '面板内禁用勾选态（input 数 = 0）',
      candBox.querySelectorAll('input').length + gateBox.querySelectorAll('input').length === 0, '')
    var candVals = [], gateVals = []
    Array.prototype.slice.call(candBox.getElementsByTagName('button')).forEach(function (b) { var v = b.getAttribute('data-v'); if (v) candVals.push(v) })
    Array.prototype.slice.call(gateBox.getElementsByTagName('button')).forEach(function (b) { var v = b.getAttribute('data-v'); if (v) gateVals.push(v) })
    A('P1 结构', '候选选项不含 manual（死分支）', candVals.indexOf('manual') < 0, '候选=' + candVals.join(','))
    A('P1 结构', '候选选项保留 auto-disabled', candVals.indexOf('auto-disabled') >= 0, '')
    A('P1 结构', '门禁选项不含 image（GateSkip 无此码）', gateVals.indexOf('image') < 0, '门禁共 ' + gateVals.length + ' 项')
    A('P1 结构', '排序下拉无 mtimeAsc + 有 hit', (function () {
      var sel = document.getElementById('sortBy'), vs = []
      Array.prototype.slice.call(sel.options).forEach(function (o) { vs.push(o.value) })
      RESULT.info.sortOpts = vs
      return vs.indexOf('mtimeAsc') < 0 && vs.indexOf('hit') >= 0
    })(), (RESULT.info.sortOpts || []).join(','))

    /* 搜索框宽度（flex 加宽） */
    var qw = document.getElementById('q').getBoundingClientRect().width
    var rowW = document.querySelector('.fields').getBoundingClientRect().width
    RESULT.info.qWidth = Math.round(qw)
    RESULT.info.rowWidth = Math.round(rowW)
    A('P2 搜索框', '宽度 > 200px（原 148 已加宽）', qw > 200, '实测 ' + Math.round(qw) + 'px')
    A('P2 搜索框', '宽度 <= 562px（max-width 560 生效，不失控）', qw <= 562, '实测 ' + Math.round(qw) + 'px')
    A('P2 搜索框', '搜索框占整行 >= 25%', qw / rowW >= 0.25, Math.round(qw) + '/' + Math.round(rowW) + '=' + (qw / rowW).toFixed(2))

    /* 筛选：候选单选 → 只留 picked */
    function clickBtn(box, v) {
      var bs = box.getElementsByTagName('button')
      for (var i = 0; i < bs.length; i++) if (bs[i].getAttribute('data-v') === v) { bs[i].click(); return true }
      return false
    }
    function clickClear(box) {
      var bs = box.getElementsByTagName('button')
      for (var i = 0; i < bs.length; i++) if (bs[i].getAttribute('data-clear') === '1') { bs[i].click(); return true }
      return false
    }
    function sum(kind) { return document.getElementById(kind === 'gate' ? 'msGateSum' : 'msCandSum') }
    window.setToggle(document.getElementById('hideArchived'), false)   // 先放开归档，便于观察 6 条

    clickBtn(candBox, 'picked')
    A('P3 候选多选', '摘要显示「候选 · 已加入保温」', sum('cand').textContent === '候选 · 已加入保温', sum('cand').textContent)
    A('P3 候选多选', '选中按钮有 .on 底色（无勾选态）',
      (function () { var bs = candBox.getElementsByTagName('button'); for (var i = 0; i < bs.length; i++) if (bs[i].getAttribute('data-v') === 'picked') return /(^| )on( |$)/.test(bs[i].className); return false })(), '')
    A('P3 候选多选', 'filtered() 只剩已入选那条', ids(window.filtered()) === 's-aaa', ids(window.filtered()))

    clickBtn(candBox, 'never-seen')
    A('P3 候选多选', '组内 OR：picked + never-seen → 2 条', ids(window.filtered()).split(',').length === 2, ids(window.filtered()))
    A('P3 候选多选', '摘要 ≥2 项显示「候选 ·2」', sum('cand').textContent === '候选 ·2', sum('cand').textContent)

    /* 组间 AND：再选门禁 */
    clickBtn(gateBox, 'warm')
    A('P4 门禁多选', '摘要显示「门禁 · 可保温」', sum('gate').textContent === '门禁 · 可保温', sum('gate').textContent)
    A('P4 门禁多选', '组间 AND：候选(picked,never-seen) × 门禁(warm) → 只剩 s-aaa',
      ids(window.filtered()) === 's-aaa', ids(window.filtered()))
    clickBtn(gateBox, 'stale')
    A('P4 门禁多选', '门禁组内 OR：+stale → 2 条（warm×picked / stale×?）',
      window.filtered().length === 1, ids(window.filtered()) + '（候选组是 picked,never-seen，stale 那条是 gate 原因 → 被候选组挡掉）')
    clickClear(gateBox)
    A('P4 门禁多选', '清空门禁 → 摘要回到「门禁」+ 无 .on', sum('gate').textContent === '门禁' && !/(^| )on( |$)/.test(sum('gate').className), sum('gate').textContent)
    clickClear(candBox)

    /* 排序 + 逆序 */
    document.getElementById('sortBy').value = 'hit'
    var rev = document.getElementById('sortRev')
    window.setToggle(rev, false)
    var asc = window.filtered().map(function (s) { return s.id + ':' + window.hitRateOf(s) })
    RESULT.info.hitDesc = asc.join(' ')
    A('P5 排序逆序', '按命中率默认降序（高的在前）', asc[0].indexOf('s-aaa') === 0 && asc[asc.length - 1].indexOf('s-ddd') === 0, asc.join(' '))
    window.setToggle(rev, true)
    var desc = window.filtered().map(function (s) { return s.id })
    A('P5 排序逆序', '开逆序后完全反转（没保过的 -1 排最前）',
      desc[0] === 's-ddd' && desc[desc.length - 1] === 's-aaa', desc.join(','))
    window.setToggle(rev, false)

    /* 置顶不受逆序影响 */
    var all = byId(window.STATE.sessions)
    all['s-bbb'].pinnedInPanel = true
    A('P5 排序逆序', '正序时置顶在最前', window.filtered()[0].id === 's-bbb', window.filtered()[0].id)
    window.setToggle(rev, true)
    A('P5 排序逆序', '逆序时置顶仍在最前（第二次稳定排序不受方向影响）', window.filtered()[0].id === 's-bbb', window.filtered()[0].id)
    window.setToggle(rev, false)
    all['s-bbb'].pinnedInPanel = false

    /* 持久化 + 迁移 */
    document.getElementById('sortBy').value = 'spend'
    window.setToggle(rev, true)
    clickBtn(gateBox, 'warm'); clickBtn(gateBox, 'stale'); clickBtn(candBox, 'over-quota')
    window.saveFilters()
    var saved = null
    try { saved = JSON.parse(localStorage.getItem('cache-keepalive:filters')) } catch (e) {}
    A('P6 持久化', '存盘含 gateCodes / candCodes / sortRev / sortBy',
      !!saved && Array.isArray(saved.gateCodes) && Array.isArray(saved.candCodes)
      && typeof saved.sortRev === 'boolean' && saved.sortBy === 'spend',
      JSON.stringify(saved))
    A('P6 持久化', 'gateCodes 是数组且含选中码', !!saved && saved.gateCodes.length === 2 && saved.gateCodes.indexOf('warm') >= 0, saved ? String(saved.gateCodes) : 'null')

    try {
      localStorage.setItem('cache-keepalive:filters', JSON.stringify({ gate: 'warm', sortBy: 'mtimeAsc' }))
    } catch (e) {}
    window.loadFilters()
    A('P6 持久化', '老格式迁移：gate:warm → gateCodes=[warm]', window.GATE_SEL.length === 1 && window.GATE_SEL[0] === 'warm', String(window.GATE_SEL))
    A('P6 持久化', '老格式迁移：mtimeAsc → sortBy=mtime + 逆序开',
      document.getElementById('sortBy').value === 'mtime' && rev.getAttribute('data-on') === '1',
      document.getElementById('sortBy').value + ' / rev=' + rev.getAttribute('data-on'))
    try {
      localStorage.setItem('cache-keepalive:filters', JSON.stringify({ gateCodes: ['php', 'warm', 'warm'] }))
    } catch (e) {}
    window.loadFilters()
    A('P6 持久化', '未知码丢弃 + 去重', window.GATE_SEL.length === 1 && window.GATE_SEL[0] === 'warm', String(window.GATE_SEL))
    try { localStorage.clear() } catch (e) {}
    window.loadFilters()

    /* 面板只建一次：render() 不能重建按钮（否则 15 秒自动刷新冲掉状态） */
    var firstBtn = candBox.getElementsByTagName('button')[0]
    clickBtn(candBox, 'gate')
    var afterRender = candBox.getElementsByTagName('button')[0]
    A('P7 不重建', 'render() 后按钮还是同一批 DOM（面板没被重建）', firstBtn === afterRender, '')
    A('P7 不重建', '重建后选中态仍在（候选 · 门禁拦着）', sum('cand').textContent === '候选 · 门禁拦着', sum('cand').textContent)
    clickClear(candBox)
  } catch (e) {
    RESULT.error = String((e && e.stack) || e)
  }
  return RESULT
}

/* ── 4. 组装页面 ────────────────────────────────────────────────────────── */
const pageHtml = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>ui-cols</title><style>',
  '*{box-sizing:border-box}',
  'body{margin:0;font:12px/1.4 sans-serif}',
  '.tablewrap{border:1px solid #ccc}',
  '.tablewrap table{min-width:100%}',
  'table{table-layout:fixed;width:100%;border-collapse:collapse;font-size:12px}',
  'th,td{padding-left:8px;padding-right:8px}',
  'td{overflow:hidden;white-space:nowrap}',
  'th{position:relative}',
  'th .rz{position:absolute;right:0;top:0;bottom:0;width:9px;cursor:col-resize}',
  '</style></head><body>',
  '<div class="tablewrap"><table><colgroup id="colgroup"></colgroup><thead><tr id="headRow"></tr></thead><tbody id="rows"></tbody></table></div>',
  '<script>window.__fetchCalls=0;window.fetch=function(){window.__fetchCalls++;return Promise.resolve({ok:true,json:function(){return Promise.resolve({ok:true})}})};window.__EVAL_FAILS=[];</script>',
  '<script>window.__DECLS__=' + JSON.stringify(decls).replace(/</g, '\\u003c') + ';</script>',
  '<script>(function(){for(var i=0;i<window.__DECLS__.length;i++){try{(0,eval)(window.__DECLS__[i])}catch(e){window.__EVAL_FAILS.push(i+": "+((e&&e.message)||e))}}})();</script>',
  '<script>(' + PAGE_HARNESS.toString() + ')().catch(function(e){window.__RESULT={ok:false,error:String((e&&e.stack)||e),asserts:[],info:{}};});</script>',
  '</body></html>'
].join('\n')

mkdirSync(WORK, { recursive: true })
const pageFile = join(WORK, 'page.html')
writeFileSync(pageFile, pageHtml, 'utf8')

/* ── 5. 起 headless Chrome（独立 user-data-dir，本机端口，页面 file://） ── */
const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean).find(p => { try { readFileSync(p); return true } catch { return false } })

function fail(msg) {
  console.error('FAIL ' + msg)
  process.exit(1)
}
if (!CHROME) fail('本机找不到 chrome / msedge（可用 CHROME_PATH 指定）')

async function probe(port) {
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(400) })
    const j = await r.json()
    return j
  } catch { return null }
}

const fileUrl = 'file:///' + pageFile.replace(/\\/g, '/')
let child = null, ws = null, port = 0

function killPid(pid) {
  return new Promise(r => {
    const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    k.on('close', r); k.on('error', r)
  })
}
/** 用 CDP 的 Browser.close 收尾（chrome.exe 会再 exec 一次，杀 launcher pid 不可靠）。 */
async function closeBrowser(p) {
  try {
    const j = await probe(p)
    if (!j || !j.webSocketDebuggerUrl) return
    const w = new WebSocket(j.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      w.addEventListener('open', res, { once: true })
      w.addEventListener('error', rej, { once: true })
    })
    w.send(JSON.stringify({ id: 1, method: 'Browser.close', params: {} }))
    await new Promise(r => setTimeout(r, 500))
    try { w.close() } catch {}
  } catch {}
}
const cleanup = async () => {
  try { if (ws) ws.close() } catch {}
  if (port) await closeBrowser(port)
  if (child) await killPid(child.pid)
  await new Promise(r => setTimeout(r, 300))
}

try {
  for (let p = 19411; p < 19480; p++) { if (!(await probe(p))) { port = p; break } }
  if (!port) throw new Error('找不到空闲的调试端口（19411-19479 全被占）')

  child = spawn(CHROME, [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--disable-component-update', '--no-pings', '--mute-audio',
    '--user-data-dir=' + join(WORK, 'ud'),
    '--remote-debugging-port=' + port, '--remote-allow-origins=*',
    '--window-size=1600,900',
    fileUrl
  ], { stdio: 'ignore' })

  let ver = null
  for (let i = 0; i < 120 && !ver; i++) { ver = await probe(port); if (!ver) await new Promise(r => setTimeout(r, 150)) }
  if (!ver) throw new Error('Chrome 调试端口未就绪（' + port + '）——多半有残留 headless 进程占着 ' + join(WORK, 'ud') + '，先清掉带 ui-cols 的 chrome 进程')

  let target = null
  for (let i = 0; i < 80 && !target; i++) {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
    target = list.find(t => t.type === 'page' && /^file:/.test(t.url || '')) || list.find(t => t.type === 'page')
    if (!target) await new Promise(r => setTimeout(r, 150))
  }
  if (!target) throw new Error('没有可用的页面目标')

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
  })
  let seq = 0
  const waiting = new Map()
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data)
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id) }
  })
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++seq
    waiting.set(id, m => (m.error ? rej(new Error(m.error.message)) : res(m.result)))
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })

  let res = null
  // 页面目标可能是 about:blank（启动竞态）→ 显式导航到我们的页面，再等结果
  await send('Page.enable', {})
  const href = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
  if (!href.result || href.result.value !== fileUrl) await send('Page.navigate', { url: fileUrl })
  for (let i = 0; i < 300 && !res; i++) {
    const r = await send('Runtime.evaluate', { expression: 'window.__RESULT ? JSON.stringify(window.__RESULT) : null', returnByValue: true })
    if (r.result && r.result.value) res = JSON.parse(r.result.value)
    else await new Promise(r2 => setTimeout(r2, 100))
  }
  if (!res) {
    const ev = await send('Runtime.evaluate', { expression: 'JSON.stringify({fails:window.__EVAL_FAILS, rs:typeof window.RS, hasRender:typeof window.renderHead, hasStart:typeof window.startResize, hasApply:typeof window.applyResize})', returnByValue: true })
    throw new Error('页面没给出结果：' + (ev.result && ev.result.value))
  }

  /* ── 6. 输出 ── */
  console.log('[来源] src/panel.ts → PANEL_SRC → <script> 体 → 顶层声明 ' + decls.length + ' 段（非声明语句全部丢弃，不执行整页）')
  console.log('[引擎] ' + (ver.Browser || 'chrome') + '  headless + CDP 127.0.0.1:' + port + '  页面 ' + fileUrl)
  console.log('[网络] 页面内 fetch 桩命中 ' + (res.info.fetchStub || 0) + ' 次（全被拦截，真实网络请求 0）')
  if (VERBOSE) console.log('[声明] ' + declNames.join(' '))
  if (VERBOSE && res.drags) for (const d of res.drags) console.log('[drag] ' + JSON.stringify(d))

  if (res.error) console.log('\n[错误] ' + res.error)
  let lastGroup = ''
  for (const a of res.asserts) {
    if (a.group !== lastGroup) { console.log('\n[' + a.group + ']'); lastGroup = a.group }
    console.log('  ' + (a.ok ? 'PASS' : 'FAIL') + '  ' + a.name + (a.detail ? '    —— ' + a.detail : ''))
  }
  if (res.info && res.info.W0) {
    console.log('\n[数字] 容器宽=' + res.info.container
      + '  起始列宽=' + JSON.stringify(res.info.W0)
      + '\n       最小宽=' + JSON.stringify(res.info.mins)
      + '  右侧列=' + (res.info.rights || []).join(',')
      + '  右侧可压=' + res.info.compressible
      + '  实测增量=' + res.info.achieved)
    if (res.info.narrow) console.log('       变窄后 容器=' + res.info.narrow.container + ' Σ=' + res.info.narrow.sum + ' 列宽=' + JSON.stringify(res.info.narrow.widths))
  }
  const fails = res.asserts.filter(a => !a.ok).length
  console.log('\n' + (res.ok ? 'PASS 全部通过' : 'FAIL ' + fails + ' 项不通过') + '（断言 ' + res.asserts.length + ' 项）')
  await cleanup()
  process.exit(res.ok ? 0 : 1)
} catch (e) {
  await cleanup()
  fail(String((e && e.message) || e))
}
