/**
 * 门禁**长档**：闲置超过 `LONG_IDLE_MINUTES`（9999 分钟 ≈ 6.9 天）时，状态词要从
 * 「闲置超窗」变「闲置过久」、从「断档」变「断档过久」（用户报障）。
 *
 * 原来只有说明文字分档（超长闲置给一句整话），**状态词永远走短档** ——
 * 于是出现「说明说闲置过久、状态词说闲置超窗」的自相矛盾。
 *
 * 三块拼起来才算修好：① `gate-texts.ts` 有 `textLong`/`detailLong` 与两档取值；
 * ② `gate.ts` 判出 `long` 并回传；③ `panel.ts` 的 `gateWord(key, isLong)` 据 `s.gateLong` 选档。
 *
 * ⚠️ 造时间必须用**真实当前时间**作基准：`buildGateInput` 的 `at` 不传时兜底 `Date.now()`，
 * 造未来时刻会把 `now − lastActivityAt` 算成负数 → 误判 `too-soon`，测不出长档。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildGateInput } from '../src/core/gate-input.ts'
import { decideWarm } from '../src/gate.ts'
import { loadState } from '../src/store.ts'
import {
  GATE_TEXTS, GATE_TEXTS_BY_KEY, LONG_IDLE_MINUTES, gateDetailOf, gateTextOf, hasLongTier,
} from '../src/core/gate-texts.ts'
import { PANEL_HTML } from '../src/panel.ts'

const NOW = Date.now()
const HOUR = 3600_000
const MIN = 60_000

/** 一份干净内存 State（`loadState` 指向不存在的文件 → 默认态，不读盘不写盘）。 */
const freshState = () => loadState('C:/definitely/not/here/state.json')

/** 一条保温记录（`at` 决定「距上次保温多久」）。 */
const warmEntry = (at) => ({
  at, gapSeconds: 3600, promptTokens: 1000, hitTokens: 900, missTokens: 100, outputTokens: 10,
  cost: 0.001, hitRate: 0.9, ms: 2000, touch: 1, cycle: 1, model: 'm', via: 'cli',
})

function stateWith(entries) {
  const st = freshState()
  st.ledger = { s: entries || [] }
  return st
}

const gateOf = (st, f) => decideWarm(buildGateInput(st, {
  id: 's', mtime: NOW, hasRoute: true, tripped: false, at: NOW, ...(f || {}),
}))

/* ── ① gate.ts：长档标记 ────────────────────────────────────────── */

test('从未保过 + 闲置 200 小时 → cold-window-idle 且 long === true', () => {
  const g = gateOf(stateWith([]), { lastActivityAt: NOW - 200 * HOUR })
  assert.equal(g.ok, false)
  assert.equal(g.code, 'cold-window-idle')
  assert.equal(g.long, true, '超过 LONG_IDLE_MINUTES（' + LONG_IDLE_MINUTES + ' 分钟）必须标长档')
})

test('短档对照：闲置 10 小时（过闲置上限但没到长档）→ 不带 long', () => {
  const g = gateOf(stateWith([]), { lastActivityAt: NOW - 10 * HOUR })
  assert.equal(g.code, 'cold-window-idle')
  assert.notEqual(g.long, true, '短档不许标 long')
})

test('保过但断档 200 小时 → stale 且 long === true；断档 10 小时不带 long', () => {
  const long = gateOf(stateWith([warmEntry(NOW - 200 * HOUR)]), { lastActivityAt: NOW - 200 * HOUR })
  assert.equal(long.code, 'stale')
  assert.equal(long.long, true)

  const short = gateOf(stateWith([warmEntry(NOW - 10 * HOUR)]), { lastActivityAt: NOW - 10 * HOUR })
  assert.equal(short.code, 'stale')
  assert.notEqual(short.long, true)
})

test('长档说明走 detailLong（不拼具体分钟数），短档仍是模板', () => {
  const long = gateOf(stateWith([]), { lastActivityAt: NOW - 200 * HOUR })
  assert.equal(long.detail, GATE_TEXTS_BY_KEY['cold-window-idle'].detailLong)
  assert.ok(!/\d/.test(long.detail), '长档说明里不该再有具体数字：' + long.detail)

  const short = gateOf(stateWith([]), { lastActivityAt: NOW - 10 * HOUR })
  assert.ok(/\d/.test(short.detail), '短档说明要带实际数字：' + short.detail)
})

/* ── ② gate-texts.ts：两档取值 ──────────────────────────────────── */

test('gateTextOf 两档对照：短档「闲置超窗」/「断档」，长档「闲置过久」/「断档过久」', () => {
  const idle = GATE_TEXTS_BY_KEY['cold-window-idle']
  const stale = GATE_TEXTS_BY_KEY['stale']
  assert.equal(gateTextOf(idle, false), '闲置超窗')
  assert.equal(gateTextOf(idle, true), '闲置过久')
  assert.equal(gateTextOf(stale, false), '断档')
  assert.equal(gateTextOf(stale, true), '断档过久')
  assert.equal(gateDetailOf(idle, true), idle.detailLong)
  assert.equal(gateDetailOf(stale, true), stale.detailLong)
})

test('用户覆盖 key:long 生效，且不串到短档', () => {
  const stale = GATE_TEXTS_BY_KEY['stale']
  const ov = { 'stale': '断了', 'stale:long': '凉透了' }
  assert.equal(gateTextOf(stale, true, ov), '凉透了')
  assert.equal(gateTextOf(stale, false, ov), '断了')
  assert.equal(gateDetailOf(stale, true, ov), '凉透了', '说明与状态词共用同一个覆盖键')
  assert.equal(gateDetailOf(stale, false, ov), '断了')
})

test('只覆盖短档时长档**不回退**到短档覆盖', () => {
  const stale = GATE_TEXTS_BY_KEY['stale']
  const ov = { 'stale': '断了' }
  assert.equal(gateTextOf(stale, true, ov), '断档过久', '长档不许被短档覆盖带跑')
  assert.equal(gateDetailOf(stale, true, ov), stale.detailLong)
})

test('空串覆盖视为未设置（两条档位都按默认走）', () => {
  const stale = GATE_TEXTS_BY_KEY['stale']
  assert.equal(gateTextOf(stale, true, { 'stale:long': '' }), '断档过久')
  assert.equal(gateTextOf(stale, false, { stale: '' }), '断档')
})

test('无长档文案的码：传 isLong 也不变词（budget / tripped / warm）', () => {
  for (const key of ['budget', 'tripped', 'warm', 'fresh']) {
    const def = GATE_TEXTS_BY_KEY[key]
    assert.equal(hasLongTier(def), false, key + ' 不该有长档')
    assert.equal(gateTextOf(def, true), def.text, key + ' 长档必须等于短档')
    assert.equal(gateDetailOf(def, true), def.detail)
  }
})

test('只有 cold-window-idle 与 stale 有长档文案', () => {
  const withLong = GATE_TEXTS.filter((d) => hasLongTier(d)).map((d) => d.key).sort()
  assert.deepEqual(withLong, ['cold-window-idle', 'stale'])
})

/* ── ③ panel.ts：状态词选档 ─────────────────────────────────────── */

/** 从面板源码抽顶层函数（都是顶格 + 体内缩进）。 */
function extractFn(name) {
  const lines = PANEL_HTML.split('\n')
  const start = lines.findIndex((l) => l.startsWith('function ' + name + '('))
  assert.ok(start >= 0, '面板源码里找不到函数：' + name)
  for (let i = start; i < lines.length; i++) {
    if (i > start && lines[i] === '}') return lines.slice(start, i + 1).join('\n')
  }
  assert.fail('函数未闭合：' + name)
}

/** 用真实 GATE_TEXTS 造 STATE，求值面板里的 gateWord（依赖 gateDef / gateHasLong）。 */
function panelGateWord(overrides) {
  const src = ['gateDef', 'gateHasLong', 'gateWord'].map(extractFn).join('\n')
  const STATE = { gateTexts: GATE_TEXTS, settings: { gateText: overrides || {} } }
  return new Function('STATE', src + '\nreturn gateWord;')(STATE)
}

test('面板 gateWord 按 isLong 选档：短档「闲置超窗」/「断档」，长档「闲置过久」/「断档过久」', () => {
  const word = panelGateWord()
  assert.equal(word('cold-window-idle', false), '闲置超窗')
  assert.equal(word('cold-window-idle', true), '闲置过久')
  assert.equal(word('stale', false), '断档')
  assert.equal(word('stale', true), '断档过久')
})

test('面板长档尊重 key:long 覆盖，且无长档文案的码传 isLong 也不变', () => {
  const word = panelGateWord({ 'stale:long': '凉透了', 'stale': '断了' })
  assert.equal(word('stale', true), '凉透了')
  assert.equal(word('stale', false), '断了')

  const plain = panelGateWord()
  assert.equal(plain('tripped', true), '熔断')
  assert.equal(plain('budget', true), '超预算')
  assert.equal(plain('warm', true), '可保温')
})

test('源码锚：面板渲染把长档标记传进 gateWord（否则永远短档）', () => {
  const panel = readFileSync(fileURLToPath(new URL('../src/panel.ts', import.meta.url)), 'utf8')
  assert.ok(panel.includes('gateWord(code, s.gateLong === true)'), 'gateHead 必须把 s.gateLong 传给 gateWord')
  assert.ok(panel.includes('function gateHasLong(d)'), '面板要有长档判定（与后端同义）')
})
