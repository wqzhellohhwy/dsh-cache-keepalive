/**
 * 子代理标题的清洗与提取（X4）。
 *
 * 真实数据背景（实测 550 会话 / 255 子代理）：
 *  - 193 条子代理的官方标题是 `<system-reminder> You are teammate "impl`，长度**恰好 40**（被截断）
 *  - 名字只剩半截（`impl` / `buil` / `test`），完整名（`impl-chrome`）在**会话日志首条消息**里
 *
 * 所以这里做三件事：① 从投影缓存读、② 清洗成可读名、③ 截断时回落到日志拿全名。
 * 放在独立文件里、由 `core/sessions.ts` re-export —— 会话扫描模块已经够大，标题清洗不该再往里堆。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeMultiFrame } from './sessions.ts'

/** 「你是某某的队友」这句系统提醒（日志里是 JSON 转义形态 `\"名字\"`，投影里是原文）。 */
const TEAMMATE_RE = /You are teammate\s*\\?"([^"\\\n]+)/

/**
 * 清洗标题。
 *
 * - `You are teammate "X"` → `X`（**允许引号没闭合**：真实数据里 193 条被截断成 40 字符）
 * - 开头的 `<…>` 标签块去掉、取首个非空行
 * - 空 / 全空白 → `undefined`（不造空标题）
 * - 其它原样返回（是否采用由 `isUselessTitle` 决定）
 */
export function cleanSubagentTitle(raw: string | undefined): string | undefined {
  const s = String(raw ?? '').trim()
  if (s === '') return undefined
  const m = TEAMMATE_RE.exec(s)
  if (m !== null) {
    const name = m[1].trim()
    return name === '' ? undefined : name
  }
  const stripped = s.replace(/^<[^>]*>\s*/, '').trim()
  if (stripped === '') return undefined
  const first = stripped.split('\n')[0].trim()
  return first === '' ? undefined : first
}

/** 裸会话 id（`session-17-48-49-5c5e54bf` / `session-72f6b9f3-83fc-…`）：不带空格，全是 id 字符。 */
const BARE_ID_RE = /^session-[0-9a-f][0-9a-f-]*$/i

/**
 * 这个标题「没用」吗（没用才允许被子代理名覆盖）。
 *
 * 判为没用：空 / 全空白 / 裸 id / 等于工作目录名（目录名分不清是哪个子代理干的活）。
 * 与目录名**相似但不相等**的算有用（`dsh-cache-keepalive-v2` 不是 `dsh-cache-keepalive`）。
 */
export function isUselessTitle(title: string | undefined, cwd?: string): boolean {
  const s = String(title ?? '').trim()
  if (s === '') return true
  if (BARE_ID_RE.test(s)) return true
  const dir = String(cwd ?? '').trim().replace(/[\\/]+$/, '')
  if (dir === '') return false
  const base = dir.split(/[\\/]/).pop() ?? ''
  return base !== '' && s === base
}

/** 投影缓存里这条标题是不是**被截断**的队友提醒（有 `You are teammate "` 但引号没闭合）。 */
function looksTruncated(raw: string): boolean {
  const m = /You are teammate\s*\\?"([^"\\\n]*)$/.exec(raw.trim())
  return m !== null
}

/**
 * 从会话日志里挖队友全名（日志是 zstd 多帧，走 `decodeMultiFrame`）。
 *
 * `undefined` = 日志里没有这句提醒 / 文件读不了（调用方保持原样）。
 */
export function readTeammateNameFromLog(logFile: string): string | undefined {
  let text = ''
  try {
    text = decodeMultiFrame(readFileSync(logFile)).text
  } catch {
    return undefined
  }
  if (text === '') return undefined
  const m = TEAMMATE_RE.exec(text)
  if (m === null) return undefined
  const name = m[1].trim()
  return name === '' ? undefined : name
}

/** 按 id 反查会话日志：`sessions/<project>/<id>/session.v4.jsonl.zstd`。 */
export function findSessionLogFile(home: string, id: string): string | undefined {
  const root = join(home, 'sessions')
  let projects: string[]
  try {
    projects = readdirSync(root)
  } catch {
    return undefined
  }
  for (const proj of projects) {
    const f = join(root, proj, id, 'session.v4.jsonl.zstd')
    if (existsSync(f)) return f
  }
  return undefined
}

/**
 * 取子代理标题：投影缓存 → 清洗 → **被截断就回落到日志拿全名**。
 *
 * ⚠️ `logFile` 不传时会**自己按 id 反查**（真机踩过：HTTP 端点手上只有 id，
 * 以前必须在参数里传 logFile 才走回落，端点忘了传 → 只能返回半截 `impl`）。
 */
export function readSubagentTitle(home: string, id: string, logFile?: string): string | undefined {
  const projFile = join(home, 'storages', 'session_projcache', 'sessions', 'session-' + id + '.json')
  let val: string | undefined
  try {
    const raw = JSON.parse(readFileSync(projFile, 'utf8')) as
      { record?: { rows?: { title?: { val?: unknown } } } }
    const v = raw.record?.rows?.title?.val
    if (typeof v === 'string') val = v
  } catch {
    return undefined
  }
  if (val === undefined) return undefined
  if (looksTruncated(val)) {
    const file = logFile ?? findSessionLogFile(home, id)
    if (file !== undefined) {
      const full = readTeammateNameFromLog(file)
      if (full !== undefined) return full
    }
  }
  return cleanSubagentTitle(val)
}
