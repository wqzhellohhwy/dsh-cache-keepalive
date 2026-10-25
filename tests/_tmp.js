/**
 * 测试用临时目录：**一律建在工作目录的 `.tmp/` 下**（不用系统 tmp，便于统一的清理与排查）。
 *
 * 用法：`const dir = tmproot('前缀')` … `finally { tmpremove(dir) }`。
 *
 * **兜底自清**：`tmproot()` 会把目录登记进 `LIVE`，并在 `process.on('exit')` 里统一清掉 ——
 * 忘记 `tmpremove`、或测试中途 `skip`/抛错时不会在 `.tmp` 留 `ck-*` 垃圾。
 *
 * **删前先断联接**（[KB]\DSH工具集\tmp-junction-safe-clean.md）：`.tmp` 里可能有指向真实
 * `~/.dsh` 的 junction，`rmSync` 虽不跟随联接，但递归遍历遇到 reparse point 会 EBUSY/EPERM。
 * 所以先把所有 reparse point 用 `rmdirSync`/`unlinkSync` 断掉（**不进入联接内部**），再删目录。
 */
import { mkdtempSync, mkdirSync, rmSync, rmdirSync, unlinkSync, readdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(process.cwd(), '.tmp')

/** 已建、尚未显式删除的临时根。 */
const LIVE = new Set()

/**
 * 断掉一棵树里所有 junction / 符号链接（只删链接本身，**绝不跟随**）。
 * 用 `lstatSync` 判类型 —— Windows 上 junction 在 Node 里 `isSymbolicLink()` 为 true。
 */
function breakLinks(dir) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    let st
    try { st = lstatSync(p) } catch { continue }
    if (st.isSymbolicLink()) {
      try { st.isDirectory() ? rmdirSync(p) : unlinkSync(p) } catch { /* 断链失败就交给外层重试 */ }
      continue
    }
    if (st.isDirectory()) breakLinks(p)
  }
}

/** junction 安全的递归删除；失败重试几次（Windows 上偶发 EBUSY/EPERM）。返回是否真的删掉了。 */
function safeRemove(dir) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      breakLinks(dir)
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch {
      // 短暂占用（索引器/杀软/尚未关闭的句柄）时退让一下再试；退让逐次加长，最多约 1.25 秒
      const until = Date.now() + 100 * (attempt + 1)
      while (Date.now() < until) { /* 忙等，避免引入 setTimeout 异步 */ }
    }
  }
  return false
}

let hooked = false
/** 进程退出时兜底清理：只清**本进程建过且没删成**的目录。 */
function hookExit() {
  if (hooked) return
  hooked = true
  process.on('exit', () => {
    for (const d of [...LIVE]) {
      if (safeRemove(d)) LIVE.delete(d)
    }
  })
}

export function tmproot(prefix) {
  mkdirSync(ROOT, { recursive: true })
  const dir = mkdtempSync(join(ROOT, 'ck-' + prefix + '-'))
  hookExit()
  LIVE.add(dir)
  return dir
}

/**
 * 显式清理。**只有真的删掉了才从登记表摘除** —— 否则退出兜底钩子还能再试一次；
 * 早先版本无条件摘除，导致「删除偶发失败 → 目录留在 `.tmp` 且再也没人管」。
 */
export function tmpremove(dir) {
  if (safeRemove(dir)) LIVE.delete(dir)
}
