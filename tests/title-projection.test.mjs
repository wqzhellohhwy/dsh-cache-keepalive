import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readProjectionTitle } from '../src/core/sessions.ts'
import { tmproot, tmpremove } from './_tmp.js'

/** 造一个投影缓存文件（形状与 DSH 真实产物一致：多行带缩进） */
const projBody = (id, val, seq = 7) => `{
  "version": 7,
  "record": {
    "rows": {
      "title": {
        "ver": 1,
        "seq": ${seq},
        "val": ${val}
      },
      "titleInput": {
        "ver": 4,
        "seq": ${seq},
        "val": { "first": { "seq": 9 } }
      }
    }
  }
}
`

const setup = (prefix) => {
  const home = tmproot(prefix)
  mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  return { home, dir: join(home, 'storages', 'session_projcache', 'sessions') }
}

test('投影缓存：session- 前缀文件名能读到 val', () => {
  const { home, dir } = setup('proj-prefix')
  try {
    writeFileSync(join(dir, 'session-abc-123.json'), projBody('abc-123', '"真实标题"'))
    assert.equal(readProjectionTitle(home, 'abc-123'), '真实标题')
  } finally { tmpremove(home) }
})

test('投影缓存：裸 id 文件名也能读到 val', () => {
  const { home, dir } = setup('proj-bare')
  try {
    writeFileSync(join(dir, 'def-456.json'), projBody('def-456', '"裸文件名标题"'))
    assert.equal(readProjectionTitle(home, 'def-456'), '裸文件名标题')
  } finally { tmpremove(home) }
})

test('投影缓存：val=null → undefined（当没有标题，不拿旧值顶）', () => {
  const { home, dir } = setup('proj-null')
  try {
    writeFileSync(join(dir, 'session-n1.json'), projBody('n1', 'null'))
    assert.equal(readProjectionTitle(home, 'n1'), undefined)
  } finally { tmpremove(home) }
})

test('投影缓存：val 为空串 → undefined', () => {
  const { home, dir } = setup('proj-empty')
  try {
    writeFileSync(join(dir, 'session-e1.json'), projBody('e1', '""'))
    assert.equal(readProjectionTitle(home, 'e1'), undefined)
  } finally { tmpremove(home) }
})

test('投影缓存：val 里的转义引号与换行不会被截断', () => {
  const { home, dir } = setup('proj-escape')
  try {
    writeFileSync(join(dir, 'session-x1.json'), projBody('x1', '"含 \\"引号\\" 与 \\n 换行的标题"'))
    assert.equal(readProjectionTitle(home, 'x1'), '含 "引号" 与 \n 换行的标题')
  } finally { tmpremove(home) }
})

test('投影缓存：只认 record.rows.title，不撞 titleInput', () => {
  const { home, dir } = setup('proj-notinput')
  try {
    /** titleInput 里的 val 是对象 —— 若误读会把 `{"first"...}` 当标题 */
    writeFileSync(join(dir, 'session-y1.json'), projBody('y1', '"正确"'))
    const got = readProjectionTitle(home, 'y1')
    assert.equal(got, '正确')
    assert.ok(got !== undefined && !got.startsWith('{'))
  } finally { tmpremove(home) }
})

test('投影缓存：文件不存在 → undefined（不抛）', () => {
  const { home } = setup('proj-missing')
  try {
    assert.equal(readProjectionTitle(home, 'not-there'), undefined)
    assert.equal(readProjectionTitle(home, ''), undefined)
  } finally { tmpremove(home) }
})

test('投影缓存：改文件后缓存失效（mtime+size）', async () => {
  const { home, dir } = setup('proj-cache')
  try {
    const file = join(dir, 'session-c1.json')
    writeFileSync(file, projBody('c1', '"第一版"'))
    assert.equal(readProjectionTitle(home, 'c1'), '第一版')
    /** 等 mtime 粒度再写（Windows 上 mtime 分辨率约 1ms） */
    await new Promise((r) => setTimeout(r, 20))
    writeFileSync(file, projBody('c1', '"第二版更长一些"'))
    assert.equal(readProjectionTitle(home, 'c1'), '第二版更长一些')
  } finally { tmpremove(home) }
})

test('投影缓存：标题超过 4KB 位置时走 64KB 档仍能拿到', () => {
  const { home, dir } = setup('proj-deep')
  try {
    /** 在 title 之前塞 8KB 的 padding，把 title 推到 4KB 之后 */
    const pad = 'x'.repeat(8 * 1024)
    const body = `{ "pad": "${pad}", "record": { "rows": { "title": { "ver": 1, "seq": 9, "val": "深位置标题" } } } }`
    writeFileSync(join(dir, 'session-d1.json'), body)
    assert.equal(readProjectionTitle(home, 'd1'), '深位置标题')
  } finally { tmpremove(home) }
})
