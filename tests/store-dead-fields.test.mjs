/**
 * 老 state.json 的**死字段清理**：`normalizeSettings` 的 `delete` 清单必须覆盖所有被删掉的设置。
 *
 * 为什么单独一个文件：`store.test.mjs` 只测 `isTripped` 这类纯判定；这里要真的写盘再读盘。
 * 临时目录：与 `tests/lab.test.mjs`、`tests/store-lock.test.mjs` 同样在仓库 `.tmp/` 下自建自删
 * （本仓库没有 `tests/_tmp.js`），绝不碰用户 state.json。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadState, saveState } from '../src/store.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WORK = join(HERE, '..', '.tmp')

function withDir(name, fn) {
  const dir = join(WORK, 'dead-fields-' + name)
  mkdirSync(dir, { recursive: true })
  try {
    return fn(dir)
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 已删 */ }
  }
}

test('D1 老 state.json 里的 tlGranularity 必须在保存时被清掉', () => {
  withDir('gran', (dir) => {
    const file = join(dir, 'state.json')
    writeFileSync(file, JSON.stringify({
      settings: { tlGranularity: 'turn', intervalSeconds: 7200 },
      ledger: {}, policies: {},
    }, null, 2), 'utf8')
    const st = loadState(file)
    assert.equal(Object.prototype.hasOwnProperty.call(st.settings, 'tlGranularity'), false, '加载后内存里就不该有该键')
    saveState(st, file)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(Object.prototype.hasOwnProperty.call(raw.settings, 'tlGranularity'), false, '保存后磁盘上不该再有该键')
    assert.equal(raw.settings.intervalSeconds, 7200, '其它字段不受影响')
  })
})

test('D2 对照组：历史死字段 warmWindowSeconds / staleSeconds / autoMaxIdleHours 同样被清掉', () => {
  withDir('hist', (dir) => {
    const file = join(dir, 'state.json')
    writeFileSync(file, JSON.stringify({
      settings: { warmWindowSeconds: 900, staleSeconds: 1800, autoMaxIdleHours: 6, maxTouches: 5 },
      ledger: {}, policies: {},
    }, null, 2), 'utf8')
    const st = loadState(file)
    saveState(st, file)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    for (const k of ['warmWindowSeconds', 'staleSeconds', 'autoMaxIdleHours']) {
      assert.equal(Object.prototype.hasOwnProperty.call(raw.settings, k), false, k + ' 没被清掉')
    }
    assert.equal(raw.settings.maxTouches, 5)
  })
})

test('D3 全新文件（无该键）不会因为清理逻辑写出多余字段', () => {
  withDir('fresh', (dir) => {
    const file = join(dir, 'state.json')
    saveState(loadState(file), file)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(Object.prototype.hasOwnProperty.call(raw.settings, 'tlGranularity'), false)
    assert.equal(typeof raw.settings.intervalSeconds, 'number')
  })
})
