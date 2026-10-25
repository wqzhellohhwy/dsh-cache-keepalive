/**
 * 两个静态检查器的测试。
 *
 * 为什么必须有：它们是**唯一的防线**，一旦悄悄地「什么都不报」，
 * 磁盘涨到 18GB 也没人会知道。所以每条既有正例也有反例，
 * 而且「检查器自己跑不动」的时候必须报非 0，不能默认放行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { scan } from '../scripts/check-probe-chrome.mjs'
import { measureTmp } from '../scripts/check-tmp-size.mjs'
import { tmproot, tmpremove } from './_tmp.js'

const REPO = join(import.meta.dirname, '..')
const PROBE = join(REPO, 'scripts', 'check-probe-chrome.mjs')
const TMPCHK = join(REPO, 'scripts', 'check-tmp-size.mjs')

// 本文件自己会被 check-probe-chrome 扫到（tests/ 在扫描范围内），
// 所以「--user-data-dir」与「spawn(」都不能以连续字面量出现，否则本文件自己判违规。
const UD = ['--user', 'data', 'dir'].join('-')
const SP = 'sp' + 'awn'
const BAD_BODY = `import { ${SP} } from 'node:child_process'\n${SP}('chrome', ['${UD}=C:/x'])\n`

const tmps = []
function newTmp(prefix) {
  const d = tmproot(prefix)
  tmps.push(d)
  return d
}
process.on('exit', () => { for (const d of tmps) tmpremove(d) })

/** 造一个假仓库：<root>/scripts/... */
function fakeRepo(files, prefix = 'probe') {
  const root = newTmp(prefix)
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, body)
  }
  return root
}

function run(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

/* ── check-probe-chrome：scan() 单元层 ───────────────────────────────── */

test(`scan：同时有 ${UD} 与 ${SP} 的文件判违规`, () => {
  const root = fakeRepo({ 'scripts/bad.mjs': BAD_BODY })
  const r = scan(root)
  assert.deepEqual(r.violations, ['scripts/bad.mjs'])
  assert.equal(r.checked, 1)
})

test(`scan：只有 ${UD} 没有 ${SP} → 不违规`, () => {
  const root = fakeRepo({ 'scripts/ok.mjs': `export const flag = '${UD}'\n` })
  const r = scan(root)
  assert.deepEqual(r.violations, [])
  assert.equal(r.checked, 1, '应当计入 checked')
})

test(`scan：只有 ${SP} 没有 ${UD} → 不违规也不计入 checked`, () => {
  const root = fakeRepo({
    'scripts/ok2.mjs': `import { ${SP} } from 'node:child_process'\n${SP}('node', ['-v'])\n`,
  })
  const r = scan(root)
  assert.deepEqual(r.violations, [])
  assert.equal(r.checked, 0)
})

test(`scan：先 import chrome.mjs 再自己 ${SP} 一个 → 照样违规（入口形同虚设）`, () => {
  const root = fakeRepo({
    'scripts/two-timing.mjs': [
      `import { launch } from './lab/chrome.mjs'`,
      `import { ${SP} } from 'node:child_process'`,
      `${SP}('chrome.exe', ['${UD}=/x'])`,
    ].join('\n'),
  })
  assert.deepEqual(scan(root).violations, ['scripts/two-timing.mjs'])
})

test(`scan：注释里写 ${UD} 不算（stripComments 生效）`, () => {
  const root = fakeRepo({
    'scripts/commented.mjs': [
      `// 别自己传 ${UD}=xxx`,
      `/* ${SP}('chrome', ['${UD}=y']) */`,
      `export const a = 1`,
    ].join('\n'),
  })
  const r = scan(root)
  assert.deepEqual(r.violations, [])
  assert.equal(r.checked, 0, '注释里的字样不该被计入 checked')
})

test('scan：豁免名单里的文件即使违规也不报（ui-cols / chrome.mjs）', () => {
  const root = fakeRepo({
    'scripts/lab/ui-cols.mjs': BAD_BODY,
    'scripts/lab/chrome.mjs': BAD_BODY,
  })
  const r = scan(root)
  assert.deepEqual(r.violations, [])
  assert.equal(r.exempt, 2, '豁免计数应为 2')
})

test('scan：自身（check-probe-chrome.mjs）跳过 —— 它源码里就有那串字样', () => {
  const root = fakeRepo({ 'scripts/check-probe-chrome.mjs': BAD_BODY })
  assert.deepEqual(scan(root).violations, [])
})

test('scan：node_modules / .tmp / lib / .git 不扫', () => {
  const root = fakeRepo({
    'scripts/node_modules/a.mjs': BAD_BODY,
    'scripts/.tmp/b.mjs': BAD_BODY,
    'scripts/lib/c.mjs': BAD_BODY,
    'tests/.git/d.mjs': BAD_BODY,
  })
  assert.deepEqual(scan(root).violations, [])
})

test('scan：只扫 .mjs/.cjs；.js/.ts 不扫', () => {
  const root = fakeRepo({ 'scripts/a.js': BAD_BODY, 'scripts/b.ts': BAD_BODY, 'cli/c.cjs': BAD_BODY })
  assert.deepEqual(scan(root).violations, ['cli/c.cjs'])
})

test('scan：scripts/tests/cli 三个目录都扫，相对路径用正斜杠', () => {
  const root = fakeRepo({ 'scripts/a.mjs': BAD_BODY, 'tests/b.mjs': BAD_BODY, 'cli/c.mjs': BAD_BODY, 'lib/d.mjs': BAD_BODY })
  assert.deepEqual(scan(root).violations, ['scripts/a.mjs', 'tests/b.mjs', 'cli/c.mjs'])
})

/* ── check-probe-chrome：退出码层 ────────────────────────────────────── */

test('check-probe-chrome：违规文件 → exit 1 且点名文件', () => {
  const root = fakeRepo({ 'scripts/bad.mjs': BAD_BODY })
  const r = run(PROBE, [`--root=${root}`])
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`FAIL 以下脚本自己 ${SP} 并传 ${UD}`), r.out)
  assert.match(r.out, /scripts\/bad\.mjs/)
})

test('check-probe-chrome：合规文件 → exit 0', () => {
  const root = fakeRepo({ 'scripts/ok.mjs': `export const a = 1\n` })
  const r = run(PROBE, [`--root=${root}`])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /OK 所有起 Chrome 的地方都走了统一入口/)
})

test('check-probe-chrome：违规 + 合规混在一起 → exit 1 且只点名违规那个', () => {
  const root = fakeRepo({ 'scripts/bad.mjs': BAD_BODY, 'scripts/ok.mjs': `export const a = 1\n` })
  const r = run(PROBE, [`--root=${root}`])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /scripts\/bad\.mjs/)
})

/**
 * 该用例曾在 `scripts/check-probe-chrome.mjs` 缺失期间整文件崩（本文件 import 它就 ERR_MODULE_NOT_FOUND）。
 * 缺失文件已于 2026-10-25 恢复，之后不再复现。
 */
test('check-probe-chrome：不误报 —— 连跑两次结果一致（幂等，无副作用）', () => {
  const root = fakeRepo({ 'scripts/ok.mjs': `export const a = 1\n` })
  const a = run(PROBE, [`--root=${root}`])
  const b = run(PROBE, [`--root=${root}`])
  assert.equal(a.code, 0)
  assert.equal(b.code, 0)
  assert.equal(a.out, b.out, '两次输出不一致，说明有状态泄漏')
})

test('check-probe-chrome：豁免生效（ui-cols.mjs 违规但仍 exit 0）', () => {
  const root = fakeRepo({ 'scripts/lab/ui-cols.mjs': BAD_BODY })
  const r = run(PROBE, [`--root=${root}`])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /豁免 1/)
})

test('check-probe-chrome：未知参数 → exit 2；--root 不存在 → exit 2', () => {
  assert.equal(run(PROBE, ['--bogus']).code, 2)
  assert.equal(run(PROBE, [`--root=${join(REPO, 'no-such-dir-xyz')}`]).code, 2)
})

test('check-probe-chrome：真仓库 exit 0', () => {
  const r = run(PROBE, [])
  assert.equal(r.code, 0, r.out)
})

/* ── check-tmp-size ──────────────────────────────────────────────────── */

const MB = 1024 * 1024

test('measureTmp：汇总总字节/文件数，tops 按大小降序只含顶层子目录', () => {
  const root = newTmp('ts')
  writeFileSync(join(root, 'loose.txt'), Buffer.alloc(100))
  mkdirSync(join(root, 'big', 'deep'), { recursive: true })
  writeFileSync(join(root, 'big', 'a.bin'), Buffer.alloc(2 * MB))
  writeFileSync(join(root, 'big', 'deep', 'b.bin'), Buffer.alloc(MB))
  mkdirSync(join(root, 'small'))
  writeFileSync(join(root, 'small', 'c.bin'), Buffer.alloc(10))

  const m = measureTmp(root)
  assert.equal(m.bytes, 3 * MB + 110)
  assert.equal(m.files, 4)
  assert.deepEqual(m.tops.map((t) => t.name), ['big', 'small'])
  assert.equal(m.tops[0].bytes, 3 * MB, 'big 递归了子目录')
  assert.equal(m.tops[0].files, 2)
})

test('check-tmp-size：--limit 非正数 / 非数字 → exit 2', () => {
  for (const bad of ['--limit=0', '--limit=-5', '--limit=abc', '--limit=', '--limit=NaN']) {
    const r = run(TMPCHK, [bad])
    assert.equal(r.code, 2, `${bad} 应为 exit 2：${r.out}`)
    assert.match(r.out, /--limit 必须是正数/)
  }
})

test('check-tmp-size：未知参数 → exit 2；--root 不存在 → exit 2', () => {
  assert.equal(run(TMPCHK, ['--bogus']).code, 2)
  assert.equal(run(TMPCHK, [`--root=${join(REPO, 'no-such-dir-xyz')}`]).code, 2)
})

test('check-tmp-size：未超限 → exit 0 且打印 MB 与阈值', () => {
  const root = fakeRepo({ '.tmp/x/a.bin': '' }, 'ts-ok')
  const r = run(TMPCHK, [`--root=${root}`, '--limit=1'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /阈值 1MB/)
  assert.match(r.out, /OK 在预算内/)
})

/**
 * ⚠️ 该用例曾**偶发红约 1/10**（`expected: 1, actual: 2`）。根因已定位并修复，勿再当 flaky 追：
 * `check-tmp-size.mjs` 原来用 `existsSync(root)` 判 `--root` 在不在，而 `existsSync` 对**任何** stat 错误
 * 都返回 false —— 杀软/索引器瞬时占用（EPERM/EBUSY）被当成「目录不存在」→ exit 2 而不是超限的 exit 1。
 * 现在脚本改用 `pathExists()`：可重试错误短退让重试，只有确认不存在（ENOENT 等）才判 false。
 * 实测：复现脚本 60 次 0 例外（修复前 44 次里 1 次），本文件连跑 8 次全绿。
 */
test('check-tmp-size：超限 → exit 1 且报出超了多少', () => {
  const root = newTmp('ts-big')
  mkdirSync(join(root, '.tmp', 'fat'), { recursive: true })
  writeFileSync(join(root, '.tmp', 'fat', 'big.bin'), Buffer.alloc(Math.round(1.5 * MB)))
  const r = run(TMPCHK, [`--root=${root}`, '--limit=1'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /FAIL \.tmp 超预算 0\.50MB/)
})

test('check-tmp-size：.tmp 不存在 → exit 0（不算超预算）', () => {
  const root = newTmp('ts-none')
  const r = run(TMPCHK, [`--root=${root}`])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /\.tmp 不存在，无需检查/)
})

test('check-tmp-size：边界 —— 恰好等于阈值不算超（> 才算）', () => {
  const root = newTmp('ts-edge')
  mkdirSync(join(root, '.tmp', 'exact'), { recursive: true })
  writeFileSync(join(root, '.tmp', 'exact', 'x.bin'), Buffer.alloc(MB))
  assert.equal(run(TMPCHK, [`--root=${root}`, '--limit=1']).code, 0, '恰好 1MB 不该判超')
  assert.equal(run(TMPCHK, [`--root=${root}`, '--limit=0.5']).code, 1)
})

test('check-tmp-size：只统计一遍字节（改回双倍遍历会让 tops 与总量对不上）', () => {
  const root = newTmp('ts-single')
  for (const n of ['a', 'b', 'c']) {
    mkdirSync(join(root, '.tmp', n), { recursive: true })
    writeFileSync(join(root, '.tmp', n, 'f.bin'), Buffer.alloc(MB))
  }
  const m = measureTmp(join(root, '.tmp'))
  const sum = m.tops.reduce((s, t) => s + t.bytes, 0)
  assert.equal(sum, m.bytes, 'tops 之和应等于总量')
  assert.equal(sum, 3 * MB)
})

test('check-tmp-size：真仓库 exit 0', () => {
  const r = run(TMPCHK, [])
  assert.equal(r.code, 0, r.out)
})
