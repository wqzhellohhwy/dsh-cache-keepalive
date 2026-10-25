/**
 * 时间轴配色纪律 + 列宽「压缩不落盘」纪律。
 * 这两个都是"看着没事、实际会退化"的点，用源码级断言钉住（浏览器实测在 scripts/lab/ui-cols.mjs）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'src', 'panel.ts'), 'utf8')
const at = SRC.indexOf('const PANEL_SRC = ')
const BODY = SRC.slice(SRC.indexOf('`', at) + 1, SRC.lastIndexOf('`'))

test('C1 轮次合计用专用变量 --turn（浅/深各定义一次），与调用的 accent 不同色', () => {
  // 两种主题各定义一次：:root 与 @media(prefers-color-scheme: dark)
  const darkAt = BODY.indexOf('@media (prefers-color-scheme: dark)')
  assert.ok(darkAt > 0, '找不到深色主题块')
  const lightBlock = BODY.slice(0, darkAt)
  const darkBlock = BODY.slice(darkAt)
  assert.ok(/--turn:\s*#[0-9a-fA-F]{6}/.test(lightBlock), '浅色主题缺 --turn 定义')
  assert.ok(/--turn:\s*#[0-9a-fA-F]{6}/.test(darkBlock), '深色主题缺 --turn 定义')

  // turnagg 行与轮次 pill 都必须用 var(--turn)；调用的 pill.auto 保持 accent
  assert.ok(/#tl \.it\.turnagg \{[^}]*var\(--turn\)/.test(BODY), 'turnagg 行没用 var(--turn)')
  assert.ok(/\.pill\.turnaggpill \{[^}]*var\(--turn\)/.test(BODY), '轮次 pill 没用 var(--turn)')
  assert.ok(/\.pill\.auto \{[^}]*var\(--accent\)/.test(BODY), '调用 pill 应保持 accent（两者必须不同色）')

  // 不许在这几条规则里写死颜色
  const rules = [/#tl \.it\.turnagg \{[^}]*\}/, /\.pill\.turnaggpill \{[^}]*\}/, /\.pill\.auto \{[^}]*\}/]
  for (const re of rules) {
    const m = BODY.match(re)
    assert.ok(m, '找不到规则 ' + re)
    assert.equal(/#[0-9a-fA-F]{6}/.test(m[0]), false, '规则里出现写死颜色：' + m[0])
  }
})

test('C2 列宽：「压缩后不落盘」——renderHead 里不许把适配结果写回 colWidths', () => {
  const rh = (() => {
    const i = BODY.indexOf('function renderHead(')
    let j = BODY.indexOf('{', i), depth = 1
    while (j < BODY.length && depth > 0) { j++; if (BODY[j] === '{') depth++; else if (BODY[j] === '}') depth-- }
    return BODY.slice(i, j)
  })()
  // 这两种写法都会把「容器变窄（DevTools/iframe 缩放）时的压缩值」永久写进存储 → 关掉 DevTools 也不还原
  assert.equal(/if \(scale < 1\) \{/.test(rh), false, 'renderHead 里还有 scale<1 的写回块（压缩会被持久化）')
  assert.equal(/STATE\.settings\[colKey\(\)\] = synced/.test(rh), false, 'renderHead 还在把渲染值整份写回 colWidths')
  assert.equal(/NEED_SAVE_COLS = true/.test(rh), false, 'renderHead 不该自己置 NEED_SAVE_COLS（应由拖拽/归一化显式触发）')
  // 拖拽落盘必须还在（这是唯一合法的写入口）
  assert.ok(/post\('\/settings', colPatch\(toSave\)\)/.test(BODY), '拖拽结束的保存路径不见了')
})

test('C3 窗口 resize 必须重跑 renderHead（防抖 150ms），拖拽中不打断', () => {
  assert.ok(/addEventListener\('resize'/.test(BODY), '没有 resize 监听 → 视口变化后列宽不会重算')
  const i = BODY.indexOf("addEventListener('resize'")
  const seg = BODY.slice(i, i + 520)
  assert.ok(/150/.test(seg), 'resize 防抖应为 150ms')
  assert.ok(/renderHead\(\)/.test(seg), 'resize 回调里要重跑 renderHead()')
  assert.ok(/RS !== null|if \(RS\)/.test(seg), '拖拽进行中要跳过（否则与拖拽重排打架）')
})
