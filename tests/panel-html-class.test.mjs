import assert from 'node:assert/strict'
import test from 'node:test'
import { makeRoutes } from '../src/routes.ts'

/** 最小 deps：只测面板 HTML 的 body class，业务函数全 stub。 */
function htmlOf(profile, variant) {
  const stub = () => ({ ok: true })
  const routes = makeRoutes({
    profile,
    variant,
    snapshot: stub,
    setPolicy: stub,
    setSettings: stub,
    ping: async () => ({ ok: true }),
    reset: stub,
    timeline: async () => ({ ok: true }),
    setPinned: stub,
    resetCost: stub,
  })
  const route = routes.find((r) => r.path === '/api/cache-keepalive/panel')
  assert.ok(route, '缺面板路由')
  let body = ''
  const res = {
    writeHead() { return this },
    end(b) { body = String(b ?? ''); return this },
  }
  route.handler({ method: 'GET', headers: {} }, res)
  return body
}

const bodyClass = (html) => {
  const m = /<body([^>]*)>/u.exec(html)
  assert.ok(m, '没找到 <body>')
  const c = /class\s*=\s*"([^"]*)"/u.exec(m[1])
  return c === null ? '' : c[1]
}

test('D1 桌面版 profile → body 带 v-plugin v-desktop', () => {
  const cls = bodyClass(htmlOf('desktop', 'plugin'))
  assert.ok(cls.includes('v-plugin'), 'class 缺 v-plugin: ' + cls)
  assert.ok(cls.includes('v-desktop'), 'class 缺 v-desktop: ' + cls)
})

test('D2 非桌面 profile（backup / experiment）→ 不含 v-desktop', () => {
  for (const p of ['backup', 'experiment', 'web', 'headless']) {
    const cls = bodyClass(htmlOf(p, 'plugin'))
    assert.ok(cls.includes('v-plugin'), p + ' 缺 v-plugin: ' + cls)
    assert.equal(cls.includes('v-desktop'), false, p + ' 不该有 v-desktop: ' + cls)
  }
})

test('D3 网页版（--serve / cli）→ v-cli，且不含 v-desktop', () => {
  const cls = bodyClass(htmlOf('', 'cli'))
  assert.ok(cls.includes('v-cli'), 'class 缺 v-cli: ' + cls)
  assert.equal(cls.includes('v-desktop'), false, '网页版不该有 v-desktop: ' + cls)
})

test('D4 拿不到 profile → 安全默认（不是桌面版）', () => {
  for (const p of [undefined, '', ' Desktopp ', 'DESKTOP_OLD']) {
    const cls = bodyClass(htmlOf(p, 'plugin'))
    if (p === 'DESKTOP_OLD') continue
    assert.equal(cls.includes('v-desktop'), false, 'profile=' + String(p) + ' 不该有 v-desktop: ' + cls)
  }
  // 大小写/空格容错：' DESKTOP ' 视为桌面版
  assert.ok(bodyClass(htmlOf(' DESKTOP ', 'plugin')).includes('v-desktop'), '大小写与空格要容错')
})
