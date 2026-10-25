/**
 * 真保温实验的**影子 home**（沙箱）管理。
 *
 * 隔离什么、不隔离什么必须写清楚（`note`）：
 * - 隔离：`cache-keepalive/state.json`（账本/策略/周期全新，绝不碰用户资产）
 * - 不隔离：`sessions` / `attachments` 是 **junction 指真实目录**（只读用途；用户正在聊的会话会继续写盘）
 * - **不隔离**：提供方那一侧的前缀缓存是**账号级**的 —— 影子 home 对它毫无作用。
 *   所以实验的命中率与真机同量，且用错前缀去保会挤掉用户正确的前缀。
 *
 * 安全红线：`dispose()` 只删 junction 与自己建的文件，**绝不递归跟随链接删除**。
 */
import {
  existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type State } from '../../store.ts'

export interface ShadowHome {
  /** 本次运行的沙箱根目录（`<baseDir>/<runId>`）。 */
  dir: string
  /** 交给子进程用的 `DSH_HOME`（`<dir>/home`）。 */
  dshHome: string
  dispose: () => void
  /** 隔离边界说明（必须包含「账号级缓存隔离不了」这句）。 */
  note: string
}

export interface ShadowHomeOptions {
  runId: string
  baseDir: string
  realDshHome: string
}

/** 允许 junction 到真实 home 的子目录（只读用途）。 */
export const SHADOW_LINKS = ['sessions', 'attachments'] as const

function stateOfShadow(): State {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    sessions: {},
    ledger: {},
    pinnedSessions: [],
  }
}

/** 建一个影子 home。已存在同名目录时直接复用（幂等，便于重复 dry-run）。 */
export async function makeShadowHome(opts: ShadowHomeOptions): Promise<ShadowHome> {
  const dir = join(opts.baseDir, opts.runId)
  const home = join(dir, 'home')
  const kaDir = join(home, 'cache-keepalive')
  mkdirSync(kaDir, { recursive: true })

  const notes: string[] = []
  for (const name of SHADOW_LINKS) {
    const link = join(home, name)
    const target = join(opts.realDshHome, name)
    if (existsSync(link)) {
      /** 已存在：只有**指向同一个真实目录**才复用；否则只删链接本身（绝不动目标）再重建。 */
      let same = false
      try {
        same = realpathSync(link) === realpathSync(target)
      } catch {
        same = false
      }
      let isLink = false
      try { isLink = lstatSync(link).isSymbolicLink() } catch { isLink = false }
      if (same) {
        notes.push(`${name}：已存在且指向正确（复用）`)
        continue
      }
      if (!isLink) {
        notes.push(`${name}：已存在且不是链接（保留，未覆盖）`)
        continue
      }
      try { unlinkSync(link) } catch { /* 已没了 */ }
      notes.push(`${name}：已存在但指向错误 → 重建`)
    }
    if (!existsSync(target)) {
      /** 真实目录不存在（新装机器）→ 建空目录，绝不让 junction 指向不存在的路径。 */
      mkdirSync(link, { recursive: true })
      notes.push(`${name}：真实目录不存在，建了空目录`)
      continue
    }
    try {
      /** Windows junction：不需要管理员权限，且不会被当成目录递归删掉目标。 */
      symlinkSync(target, link, 'junction')
      notes.push(`${name}：junction → 真实目录`)
    } catch (e) {
      mkdirSync(link, { recursive: true })
      notes.push(`${name}：junction 建不了（${e instanceof Error ? e.message : String(e)}），退回空目录 —— 含图/历史会话会读不到字节`)
    }
  }

  /** state.json 全新：**绝不复制**用户账本/策略/周期。 */
  writeFileSync(join(kaDir, 'state.json'), JSON.stringify(stateOfShadow(), null, 2), 'utf8')
  /** ⚠️ 明确**不写** runtime.json：写了面板/CLI 会把请求转发到不存在的实例（假 running）。 */

  const note = [
    '影子 home 隔离边界：',
    '✅ 隔离：cache-keepalive/state.json（账本/策略/周期全新，绝不写用户 state.json；也不写 runtime.json）',
    `✅ 只读链接：${SHADOW_LINKS.join(' / ')} → 真实 home（${opts.realDshHome}）`,
    '⚠️ 缓存是**账号级**的：影子 home 隔离不了提供方那一侧的前缀缓存。',
    '   实验命中率与真机同量；用错前缀去保会挤掉用户正确的前缀 —— 这是所有隔离方案的上限。',
    ...notes.map((n) => `· ${n}`),
  ].join('\n')

  return {
    dir,
    dshHome: home,
    note,
    dispose: () => disposeShadow(dir, home),
  }
}

/** 只删 junction 与自己建的文件；任何情况下都不跟随链接递归删。 */
function disposeShadow(dir: string, home: string): void {
  /**
   * **D2 兜底**：`home` 自己若是链接（误建），删它下面的任何东西都会**穿到真实 home** —— 一个字节都不动。
   */
  try {
    if (lstatSync(home).isSymbolicLink()) return
  } catch {
    /* home 不存在 → 下面逐项尝试即可 */
  }
  for (const name of SHADOW_LINKS) {
    const link = join(home, name)
    let isLink = false
    try {
      isLink = lstatSync(link).isSymbolicLink()
    } catch {
      continue
    }
    if (isLink) {
      try { unlinkSync(link) } catch { /* 已没了 */ }
    } else {
      /** 建链接失败时我们退回过**普通空目录** —— 也要删（`rmdir` 只删空目录，安全）。 */
      try { rmdirSync(link) } catch { /* 非空 → 留着，绝不递归 */ }
    }
  }
  try {
    unlinkSync(join(home, 'cache-keepalive', 'state.json'))
  } catch {
    /* 同上 */
  }
  try {
    unlinkSync(join(home, 'cache-keepalive', 'state.json.lock'))
  } catch {
    /* 同上 */
  }
  /** 逐层 rmdir（只删空目录）—— 比 `rmSync({recursive:true})` 更保守：非空会抛，绝不误删。 */
  for (const p of [join(home, 'cache-keepalive'), home, dir]) {
    try {
      rmdirSync(p)
    } catch {
      /* 非空或有别人放的文件 → 留着（宁可残留也不误删） */
    }
  }
}

/** 影子 home 里是否还有残留（`dispose()` 后的自检）。 */
export function shadowResidue(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
