import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'
import { join } from 'node:path'
import {
  cleanSubagentTitle,
  isUselessTitle,
  readSubagentTitle,
  readTeammateNameFromLog,
  findSessionLogFile,
} from '../src/core/sessions.ts'
import { tmproot, tmpremove } from './_tmp.js'

/**
 * X4 子代理标题：从会话投影缓存读标题并清洗，**只在官方标题无用时覆盖**。
 *
 * 真实数据背景（实测 550 会话 / 255 子代理）：
 *  - 193 条子代理官方标题是 `<system-reminder> You are teammate "impl`，长度**恰好 40**（被截断）
 *  - 名字只剩半截（`impl` / `buil` / `test`），完整名（`impl-chrome`）在**会话日志首条消息**里
 */

const HOME = () => tmproot('x4')

/* ── 判据 2：清洗函数覆盖四种输入 ─────────────────────────────────────── */

test('清洗：`<system-reminder> You are teammate "核验 B：契约一致性与数据正确性"` → 取引号内名字', () => {
  const got = cleanSubagentTitle('<system-reminder> You are teammate "核验 B：契约一致性与数据正确性"')
  assert.equal(got, '核验 B：契约一致性与数据正确性')
})

test('清洗：空串 → undefined（不造空标题）', () => {
  assert.equal(cleanSubagentTitle(''), undefined)
  assert.equal(cleanSubagentTitle('   '), undefined)
})

test('清洗：非该形态的普通标题 → 原样保留', () => {
  assert.equal(cleanSubagentTitle('普通的会话标题'), '普通的会话标题')
})

test('清洗：裸 id → 原样返回（是否采用由 isUselessTitle 决定）', () => {
  assert.equal(cleanSubagentTitle('session-17-48-49-5c5e54bf'), 'session-17-48-49-5c5e54bf')
})

test('清洗：**截断形态**（真实数据 193 条的形状，引号没闭合）也要能取出名字', () => {
  // 真实值恰好 40 字符：`<system-reminder> You are teammate "impl`
  const truncated = '<system-reminder> You are teammate "impl'
  assert.equal(truncated.length, 40, '这条要是真实形态：正好 40 字符')
  assert.equal(cleanSubagentTitle(truncated), 'impl', '捕获组不能要求闭合引号')
})

test('清洗：去掉开头的 <…> 标签块后取首行', () => {
  const got = cleanSubagentTitle('<system-reminder>\n别的提醒内容\n第二行')
  assert.equal(got, '别的提醒内容')
})

/* ── 判据 3：覆盖条件（有用的官方标题不许动）─────────────────────────── */

test('覆盖条件：官方标题有用 → 不被覆盖', () => {
  assert.equal(isUselessTitle('核验 B：契约一致性与数据正确性'), false, '可读标题必须保留')
  assert.equal(isUselessTitle('impl-chrome'), false)
})

test('覆盖条件：空 / 裸 id / 等于工作目录名 → 判为无用（该被覆盖）', () => {
  assert.equal(isUselessTitle(''), true, '空标题无用')
  assert.equal(isUselessTitle('   '), true)
  assert.equal(isUselessTitle('session-17-48-49-5c5e54bf'), true, '裸 id 无用')
  assert.equal(isUselessTitle('session-72f6b9f3-83fc-4be6-9365-8c25584bd0b9'), true)
  assert.equal(isUselessTitle('dsh-cache-keepalive', 'C:/repo/dsh-cache-keepalive'), true, '等于工作目录名无用')
  assert.equal(isUselessTitle('dsh-cache-keepalive', 'C:/repo/dsh-cache-keepalive/'), true, '尾斜杠也要认')
})

test('覆盖条件：与工作目录名相似但不同的，算有用', () => {
  assert.equal(isUselessTitle('dsh-cache-keepalive-v2', 'C:/repo/dsh-cache-keepalive'), false)
  assert.equal(isUselessTitle('session 17 48 49', 'C:/repo/x'), false, '不是裸 id 形态就别误判')
})

/* ── 端到端：从投影缓存读 → 清洗 ─────────────────────────────────────── */

test('readSubagentTitle：投影里有 system-reminder 串 → 返回清洗后的名字', () => {
  const home = HOME()
  try {
    const dir = join(home, 'storages', 'session_projcache', 'sessions')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session-abc.json'), JSON.stringify({
      record: { rows: { title: { val: '<system-reminder> You are teammate "核验 B：契约一致性与数据正确性"' } } },
    }))
    assert.equal(readSubagentTitle(home, 'abc'), '核验 B：契约一致性与数据正确性')
  } finally { tmpremove(home) }
})

test('readSubagentTitle：投影里没有该会话 → undefined（调用方保持原样）', () => {
  const home = HOME()
  try {
    assert.equal(readSubagentTitle(home, 'nope'), undefined)
  } finally { tmpremove(home) }
})

test('readSubagentTitle：截断的投影值 + 有日志 → 回落到日志拿**完整**名字', () => {
  const home = HOME()
  try {
    const dir = join(home, 'storages', 'session_projcache', 'sessions')
    mkdirSync(dir, { recursive: true })
    const truncated = '<system-reminder> You are teammate "impl'
    writeFileSync(join(dir, 'session-abc.json'), JSON.stringify({
      record: { rows: { title: { val: truncated } } },
    }))
    assert.equal(truncated.length, 40)
    // 只有投影时拿到半截
    assert.equal(readSubagentTitle(home, 'abc'), 'impl')

    /**
     * 日志里是 **JSON 转义形态**：原始字符序列就是 `You are teammate \"impl-chrome\"`。
     * 用 String.raw 构造，保证落盘的字面量与真实日志一致（普通字符串会把 \" 变成 "）。
     * 另：真实日志是 **zstd 压缩的多帧**，`decodeMultiFrame` 对纯文本返回空串 —— 必须压缩后再写。
     */
    const logFile = join(home, 's.log')
    const line = String.raw`{"type":"user/message","data":{"content":[{"type":"text","text":"<system-reminder>\nYou are teammate \"impl-chrome\".\nYour Team Lead is named \"lead\"."}]}}`
    writeFileSync(logFile, zstdCompressSync(Buffer.from(line + '\n', 'utf8')))
    assert.equal(readTeammateNameFromLog(logFile), 'impl-chrome', '日志里是转义引号形态（\\"），正则必须认')

    /**
     * **端到端**：`readSubagentTitle` 必须走截断回落拿到全名 ——
     * 只测 `readTeammateNameFromLog` 挡住「日志提取改坏」，挡不住「回落条件改坏」
     * （变异验证里 looksTruncated 恒 false 时，只测提取那条仍会绿）。
     */
    assert.equal(readSubagentTitle(home, 'abc', logFile), 'impl-chrome',
      '投影值被截断时必须回落到日志拿完整名，否则只能显示半截 `impl`')
  } finally { tmpremove(home) }
})

test('readTeammateNameFromLog：非该系统提醒的日志 → undefined', () => {
  const home = HOME()
  try {
    const logFile = join(home, 'plain.log')
    writeFileSync(logFile, '{"type":"user/message","data":{"content":[{"type":"text","text":"帮我修个 bug"}]}}\n')
    assert.equal(readTeammateNameFromLog(logFile), undefined)
  } finally { tmpremove(home) }
})

/* ── ★ 真机回归：只给 id 也要拿到全名（端点就是这么调的）──────────────── */

test('★ readSubagentTitle 只传 id（不给 logFile）也必须拿到**完整**名字', () => {
  // 真机踩过：HTTP 端点手上只有 id，以前必须在参数里传 logFile 才会走日志回落，
  // 端点忘了传 → 返回截断的 `impl`（单测传了 logFile 所以没暴露）。
  // 现在 readSubagentTitle 会自己按 id 反查日志（sessions/<project>/<id>/session.v4.jsonl.zstd）。
  const home = HOME()
  try {
    // 造投影缓存：被截断的 title
    const dir = join(home, 'storages', 'session_projcache', 'sessions')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session-sub1.json'), JSON.stringify({
      record: { rows: { title: { val: '<system-reminder> You are teammate "impl' } } },
    }))
    // 造会话日志：完整名（真实布局 sessions/<project>/<id>/session.v4.jsonl.zstd）
    const sessDir = join(home, 'sessions', 'proj-key', 'sub1')
    mkdirSync(sessDir, { recursive: true })
    const line = String.raw`{"type":"user/message","data":{"content":[{"type":"text","text":"<system-reminder>\nYou are teammate \"impl-chrome\"."}]}}`
    writeFileSync(join(sessDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(line + '\n', 'utf8')))

    assert.equal(readSubagentTitle(home, 'sub1'), 'impl-chrome',
      '只传 id 时必须自己反查日志拿到全名，否则端点只能返回截断的 impl')
    // 显式给 logFile 也要一致
    assert.equal(readSubagentTitle(home, 'sub1', join(sessDir, 'session.v4.jsonl.zstd')), 'impl-chrome')
  } finally { tmpremove(home) }
})

test('findSessionLogFile：按 id 能在 sessions/<project>/<id>/ 下找到日志', () => {
  const home = HOME()
  try {
    const sessDir = join(home, 'sessions', 'some-proj', 'abc123')
    mkdirSync(sessDir, { recursive: true })
    const f = join(sessDir, 'session.v4.jsonl.zstd')
    writeFileSync(f, 'x')
    assert.equal(findSessionLogFile(home, 'abc123'), f)
    assert.equal(findSessionLogFile(home, 'no-such'), undefined)
  } finally { tmpremove(home) }
})
