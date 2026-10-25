/**
 * 门禁文案表（`core/gate-texts.ts`）的默认值质量门。
 *
 * 重点是**占位符**：面板/CLI 显示的是 `renderGateText()` 渲染后的文本，模板里写了 `{x}` 却没有
 * 对应 `vars`（或反过来）→ 用户会看到字面的 `{x}` 或拿不到数字。这类错手滑一次就上线，
 * 所以这里用「双向严格一致」钉死。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { GATE_TEXTS, GATE_TEXT_DEFAULTS, GATE_DETAIL_DEFAULTS, renderGateText } from '../src/core/gate-texts.ts'
import { NON_GATE_TEXT_KEYS } from '../src/core/lab/invariants.ts'

const usedVars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1])

test('T1 状态词 ≤ 6 字（列表列很窄，超了会把门禁列撑爆）', () => {
  const bad = GATE_TEXTS.filter((d) => [...String(d.text)].length > 6)
  assert.deepEqual(bad.map((d) => d.key + '=' + d.text), [], '这些状态词超过 6 字')
  assert.ok(GATE_TEXTS.length >= 16, '条数变少了：' + GATE_TEXTS.length)
})

test('T2 vars 与 detail 里的 {x} 双向严格一致（防手滑删占位符 → 面板显示字面量）', () => {
  for (const d of GATE_TEXTS) {
    const used = usedVars(d.detail)
    const vars = [...(d.vars || [])]
    assert.deepEqual(vars.slice().sort(), used.slice().sort(),
      d.key + '：vars=' + JSON.stringify(vars) + ' 但 detail 里用了 ' + JSON.stringify(used))
    assert.equal(new Set(used).size, used.length, d.key + '：detail 里同一个占位符出现了多次（渲染没问题但通常是手滑）')
  }
})

test('T3 渲染后不残留 {x}（给每个 vars 填值，跑一遍 renderGateText）', () => {
  for (const d of GATE_TEXTS) {
    const fill = {}
    for (const v of d.vars || []) fill[v] = 'X9'
    const out = renderGateText(d.detail, fill)
    assert.equal(/\{\w+\}/.test(out), false, d.key + ' 渲染后仍有字面量占位符：' + out)
    // 每个占位符都要真的被替换成值
    for (const v of d.vars || []) assert.ok(out.includes('X9'), d.key + ' 的 {' + v + '} 没被替换：' + out)
  }
})

test('T4 三个「非门禁码」的文案 key 必须保留（invariants.ts 的 NON_GATE_TEXT_KEYS 依赖它们存在）', () => {
  for (const k of NON_GATE_TEXT_KEYS) {
    assert.ok(GATE_TEXTS.some((d) => d.key === k), '缺文案 key ' + k)
    assert.ok(typeof GATE_TEXT_DEFAULTS[k] === 'string' && GATE_TEXT_DEFAULTS[k] !== '')
  }
})

test('T5 关键数字/单位没被精简掉（语义不许变）', () => {
  const d = Object.fromEntries(GATE_TEXTS.map((x) => [x.key, x.detail]))
  assert.ok(/50/.test(d.tripped), 'tripped 少了「漏一次 ≈ 50 次保温的钱」那个 50')
  assert.ok(/元/.test(d.budget), 'budget 少了单位「元」')
  assert.ok(/0 命中/.test(d.stale), 'stale 少了「0 命中」这个结论')
  assert.ok(/跨周期/.test(d['max-touches-total']), 'max-touches-total 少了「跨周期也算」')
  assert.ok(/provider\/model/.test(d['no-route']), 'no-route 少了 provider/model')
  assert.ok(/清账/.test(d['max-touches']), 'max-touches 少了开新周期的按钮名')
  assert.ok(/\{tail\}/.test(d.image), 'image 少了 {tail}')
  assert.equal(/立刻保温/.test(d.image + d['cold-window'] + d['cold-window-idle']), false,
    '界面按钮叫「保温」，不是「立刻保温」')
})

test('T6 默认值表与主表同源（GATE_TEXT_DEFAULTS / GATE_DETAIL_DEFAULTS 不能各写一份）', () => {
  assert.equal(Object.keys(GATE_TEXT_DEFAULTS).length, GATE_TEXTS.length)
  assert.equal(Object.keys(GATE_DETAIL_DEFAULTS).length, GATE_TEXTS.length)
  for (const d of GATE_TEXTS) {
    assert.equal(GATE_TEXT_DEFAULTS[d.key], d.text)
    assert.equal(GATE_DETAIL_DEFAULTS[d.key], d.detail)
  }
})
