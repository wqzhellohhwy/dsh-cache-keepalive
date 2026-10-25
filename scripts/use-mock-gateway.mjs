#!/usr/bin/env node
/**
 * 把**临时 profile** 里 `tokenrhythm*` 路由的 `baseURL` 指向假网关，或回滚。
 *
 * ## 用法
 * ```
 * node scripts/use-mock-gateway.mjs --profile mock-probe --port 18888
 * node scripts/use-mock-gateway.mjs --profile mock-probe --restore
 * ```
 * 改了哪些文件会打印出来；改之前自动备份成 `<文件名>.bak-mockgateway-<时间戳>`。
 *
 * ## 安全边界（**写死白名单，不在名单里直接拒绝**）
 * 只允许改**临时探针 profile**：`mock-probe`、`wire-probe`、`wire-probe2`、`wire-hl`、`wire-mock`。
 * **`backup` / `experiment` / `desktop` / `web` / `headless` 等正式 profile 一律拒绝** ——
 * 那是用户正在用的实例，改了就联网断掉。
 * 判定看两处：profile 名在不在白名单，以及 `$DSH_HOME/profiles/<name>/package.json` 存在。
 *
 * ## 改哪些行
 * `cordis.patch.yml` 里形如：
 * ```yaml
 *       tokenrhythm-title:
 *         baseURL: https://tokenrhythm.studio/v1
 * ```
 * 的 `baseURL` 值（只改 provider 名以 `tokenrhythm` / `dots` 开头的块）。
 * 回滚时从备份文件还原（按 mtime 取最近一份）。
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 允许操作的 profile（**只加临时探针 profile，永远不要加正式 profile**）。 */
const ALLOWED = new Set(['mock-probe', 'wire-probe', 'wire-probe2', 'wire-hl', 'wire-mock'])

/** 会被改写的 provider 名前缀。 */
const TARGET_PROVIDERS = /^(tokenrhythm|dots)/u

const argv = process.argv.slice(2)
const argOf = (name) => {
  const i = argv.indexOf(name)
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1]
  const eq = argv.find((a) => a.startsWith(name + '='))
  return eq === undefined ? undefined : eq.slice(name.length + 1)
}

const profile = argOf('--profile')
const port = Number(argOf('--port') ?? '18888')
const restore = argv.includes('--restore')

if (profile === undefined || profile === '') {
  process.stderr.write('用法：node scripts/use-mock-gateway.mjs --profile <名> --port <端口>\n'
    + '      node scripts/use-mock-gateway.mjs --profile <名> --restore\n')
  process.exit(2)
}
if (!ALLOWED.has(profile)) {
  process.stderr.write(
    `❌ 拒绝：profile "${profile}" 不在临时探针白名单 [${[...ALLOWED].join(', ')}]。\n`
    + '   只允许改临时 profile —— 改正式 profile 会把用户正在用的实例的联网断掉。\n',
  )
  process.exit(1)
}

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const dir = join(home, 'profiles', profile)
if (!existsSync(dir)) {
  process.stderr.write(`❌ profile 目录不存在：${dir}\n`)
  process.exit(1)
}

const BASE = `http://127.0.0.1:${port}/v1`

/**
 * 改写一段 YAML 里目标 provider 的 `baseURL`。
 * 用缩进跟踪「当前在哪个 provider 块里」—— provider 名与 `baseURL:` 都是缩进行，
 * 靠 `providers:` 之下的缩进层级判断。
 *
 * @param text 原文
 * @param to 目标 baseURL（`null` = 不改，仅统计）
 * @returns `{ text, changed }`；`changed` 是改了哪些 provider
 */
function rewriteBaseURL(text, to) {
  const lines = text.split('\n')
  let providersIndent = -1
  let curProvider = null
  let curIndent = -1
  const changed = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const body = line.trim()
    if (body === '' || body.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (providersIndent < 0) {
      if (/^providers:\s*$/u.test(body)) providersIndent = indent
      continue
    }
    if (indent <= providersIndent) {
      providersIndent = /^providers:\s*$/u.test(body) ? indent : -1
      curProvider = null
      continue
    }
    const nameOnly = /^([A-Za-z0-9_.-]+):\s*$/u.exec(body)
    if (nameOnly !== null && indent <= (curIndent < 0 ? indent : curIndent) + 2) {
      curProvider = nameOnly[1]
      curIndent = indent
      continue
    }
    if (curProvider === null || !TARGET_PROVIDERS.test(curProvider)) continue
    const kv = /^baseURL:\s*(.+)$/u.exec(body)
    if (kv === null) continue
    const before = kv[1].trim()
    lines[i] = line.slice(0, indent) + 'baseURL: ' + to
    changed.push({ provider: curProvider, from: before, to })
  }
  return { text: lines.join('\n'), changed }
}

const patchFile = join(dir, 'cordis.patch.yml')
const backups = () => readdirSync(dir)
  .filter((f) => f.startsWith('cordis.patch.yml.bak-mockgateway-'))
  .sort()
  .reverse()

if (restore) {
  const list = backups()
  if (list.length === 0) {
    process.stderr.write(`❌ 没有备份可回滚：${join(dir, 'cordis.patch.yml.bak-mockgateway-*')}\n`)
    process.exit(1)
  }
  copyFileSync(join(dir, list[0]), patchFile)
  /** 回滚后把该备份挪走，避免下次回滚拿到同一份（但保留文件本身供排查）。 */
  process.stdout.write(`✅ 已回滚 ${patchFile}\n   用的是备份 ${list[0]}\n`)
  process.exit(0)
}

if (!existsSync(patchFile)) {
  process.stderr.write(`❌ 找不到 ${patchFile}\n`)
  process.exit(1)
}

const original = readFileSync(patchFile, 'utf8')
const { text, changed } = rewriteBaseURL(original, BASE)
if (changed.length === 0) {
  process.stderr.write(`❌ ${patchFile} 里没有 tokenrhythm* / dots* 的 baseURL 可改\n`)
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
const backup = `${patchFile}.bak-mockgateway-${stamp}`
copyFileSync(patchFile, backup)
writeFileSync(patchFile, text, 'utf8')

process.stdout.write(`✅ 已把 ${profile} 的 ${changed.length} 个路由指向假网关 ${BASE}\n`)
for (const c of changed) process.stdout.write(`   ${c.provider}: ${c.from} → ${c.to}\n`)
process.stdout.write(`   备份：${backup}\n   回滚：node scripts/use-mock-gateway.mjs --profile ${profile} --restore\n`)
