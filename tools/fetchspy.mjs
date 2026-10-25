#!/usr/bin/env node
/**
 * **真实请求体取证探针** —— 把 DSH 真正发出去的请求体落盘。
 *
 * ## 为什么必须拦在 fetch 上
 * 会话日志里只有 `request/header`（config + tools）和 `request/context`（provider/model/contextWindow），
 * **没有 messages**；`OPENAI_LOG=debug` 也只打 options/headers（`openai/internal/utils/log.mjs:56-77`）。
 *
 * ## 为什么拦得住
 * `openai/client.mjs:157`  `this.fetch = options.fetch ?? Shims.getDefaultFetch()`
 * `openai/internal/shims.mjs:2-7`  `getDefaultFetch()` 返回 `globalThis.fetch`
 * `pi-ai/dist/api/openai-completions.js:186,561`  建客户端时用的就是那个全局 fetch
 * → 包装 `globalThis.fetch` 拿到的就是 SDK 序列化后的**最终请求体**。
 *
 * ## 用法
 * ```
 * NODE_OPTIONS="--import=file:///C:/Users/53518/dsh-plugins/dsh-cache-keepalive/scripts/fetchspy.mjs" \
 *   node <dsh>/lib/bin.js --profile <临时profile> web --port 19399
 * ```
 * 环境变量：
 *  - `CK_SPY_OUT`    落盘目录（默认 `<cwd>/.tmp`）
 *  - `CK_SPY_MAX`    正文文件上限（默认 3）
 *  - `CK_SPY_MATCH`  正文只抓 URL 含该子串的 POST（默认 `tokenrhythm`）
 *  - `CK_SPY_FREEZE_MAX` 冻结副本**文件数**上限（默认 1）
 *  - `CK_SPY_FREEZE_MAX_BYTES` 单份日志复制上限（默认 50MB，超过不冻）
 *
 * ## 产出（全部在 `CK_SPY_OUT`）
 * | 文件 | 内容 |
 * |---|---|
 * | `spy-loaded-<pid>-<ts>.json` | 本进程装上探针了（含 argv） |
 * | `spy-skip-<pid>.txt` | **没装上**，写的是 `argv[1]`（入口一变要能立刻看出来） |
 * | `spy-meta-<pid>-<ts>.json` | 首次命中任意 POST 时的 URL + 顶层键名（**无条件写，防死锁**） |
 * | `real-body-<pid>-<ts>.json` | 命中 `CK_SPY_MATCH` 的请求体正文（最多 `CK_SPY_MAX` 个） |
 * | `real-body-<pid>-<ts>.meta.json` | 该正文对应的 URL / 主机 / 字节数 / 冻结副本路径 |
 * | `frozen-<ts>-<pid>.zstd` | **拦截那一刻**复制的一份会话日志（时序快照，见下） |
 *
 * ## 为什么要冻结日志
 * 会话日志是 append-only 的，而且**随时会被压缩改写**（同一条会话的装配条数会在
 * 1926 → 75 → 58 之间跳）。`assembleSession` 只用 mtime/size 做缓存键，锁不住。
 * 所以必须在「请求发出的那一刻」把日志复制一份，事后对副本装配 —— 否则比的是两个时刻的东西。
 *
 * ## 冻结哪份日志（可靠性说明）
 * `--import` 阶段拿不到会话路径。这里用两条线索交叉：
 *  1. `process.argv` 里的 `--profile <name>`（或 `-p`）→ 复制该 profile 的 cordis 配置，记下 profile 名
 *  2. 扫 `$DSH_HOME/sessions` 下**最近 mtime 的若干条** `.zstd`，按 mtime 倒序，**全部**记进 meta
 * 为什么都记：探针进程可能是 web 服务进程，真正被记日志的是它派生的 agent 子进程，
 * 「最近改过的那几条」才是候选。**不猜哪一条**，把候选列表原样交给 `scripts/wire-diff.mjs`，
 * 由它逐条装配、挑出与 body 的 `messages` 数量/首尾内容最吻合的那份（挑不出就全部报出来）。
 *
 * ## 纪律
 *  - **不改请求**：只在读 body，原样透传（ReadableStream 用 `tee()`，原流不受影响）
 *  - **不落请求头**：`authorization` 这类凭据一律不写盘
 *  - **脱敏**：body 里 `sk-` 开头的串抹成 `sk-***`
 *  - **限流**：正文最多 `CK_SPY_MAX` 个，冻结副本最多 `CK_SPY_FREEZE_MAX` 个
 *  - 纯 ESM（`--import` 只吃 ESM）；**顶层不许 `return`**
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { decodeMultiFrame } from '../src/core/sessions.ts'

/** DSH 入口：`dsh/lib/bin.js`（子进程 `spawn(execPath, [binPath, ...])` 也是它）。 */
const ENTRY_RE = /[\\/]dsh[\\/]lib[\\/]bin\.js$|[\\/]dsh-desktop-host[\\/]lib[\\/]cli\.js$/u

function outDirOf() {
  const env = process.env.CK_SPY_OUT
  return env !== undefined && env !== '' ? resolve(env) : join(process.cwd(), '.tmp')
}

function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

function stamp() {
  return process.pid + '-' + Date.now()
}

/**
 * apiKey 脱敏。
 *
 * ## 两次踩坑（都导致 P0 出现假差异，改之前先看）
 * 1. 初版 `/sk-[A-Za-z0-9_-]{8,}/` 把 `task-specific` 抹成 `task-***`（差 5 字符）
 * 2. 收紧到 `{20,}` 后，**会话里引用的测试样例** `sk-abcdefghijklmnop1234`（恰 20 位）
 *    又被抹掉 —— 它不是真 key，却让 40b9 的第 107 / 111 条差 17 个字符
 *
 * ## 现在的策略：**只按字段名脱敏，不猜值的形态**
 * 真实 key 只出现在 `authorization` / `api_key` 这类**字段**里；正文里任何 `sk-` 文本
 * 都可能是正常内容（代码、讨论、测试样例）。按值猜必然误伤，误伤的代价是
 * 「P0 永远差几个字符」，而那个差异会被误判成序列化 bug。
 *
 * 请求头本来就不落盘，所以字段级脱敏已经覆盖了真正会泄露的位置。
 *
 * @param text 待落盘文本
 */
function redact(text) {
  return text.replace(
    /("(?:api_?key|authorization|x-api-key)"\s*:\s*")([^"]*)(")/giu,
    (_, a, __, c) => a + '***' + c,
  )
}

/**
 * 把 body 读成文本。
 *
 * ⚠️ ReadableStream 的返回值是**替换用**的新 body：`tee()` 会把原流锁住，
 * 如果还拿原流去 `realFetch`，undici 直接抛
 * `TypeError: Response body object should not be disturbed or locked` —— 探针把请求弄死了。
 * 所以调用方必须用返回的 `{ text, nextBody }` 里的 `nextBody` 转发。
 *
 * @param body 原始 body
 * @returns `text` = 读出来的文本（读不到为 undefined）；`nextBody` = 转发给下游的 body
 */
async function readBody(body) {
  if (body === undefined || body === null) return { text: undefined, nextBody: body }
  if (typeof body === 'string') return { text: body, nextBody: body }
  if (body instanceof Uint8Array) return { text: Buffer.from(body).toString('utf8'), nextBody: body }
  if (typeof body === 'object' && typeof body.getReader === 'function' && typeof body.tee === 'function') {
    /**
     * ⚠️ **流已被上游读过（`locked === true`）时，绝对不能 tee** —— 那会抛
     * `TypeError: body object should not be disturbed or locked`，
     * 探针把整个请求吞掉（真实事故：用户在抓包实例里发消息没反应）。
     * 这种情况**直接放弃读取**，原样转发，请求照常工作、只是这次抓不到正文。
     */
    if (body.locked === true) return { text: undefined, nextBody: body }
    /** 两半：`mine` 用来读，`theirs` 原样交给下游。 */
    const [mine, theirs] = body.tee()
    const reader = mine.getReader()
    const chunks = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) chunks.push(typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value))
    }
    return { text: Buffer.concat(chunks).toString('utf8'), nextBody: theirs }
  }
  return { text: undefined, nextBody: body }
}

/** body 形态名字（写进 meta 便于事后判断，不参与逻辑）。 */
function formOf(body) {
  if (body === undefined || body === null) return String(body)
  if (typeof body === 'string') return 'string'
  if (body instanceof Uint8Array) return 'Uint8Array'
  if (typeof body.getReader === 'function') return body.locked === true ? 'ReadableStream(locked)' : 'ReadableStream'
  return typeof body
}

/** URL 可能是字符串 / URL / Request。 */
function urlOf(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input !== null && typeof input === 'object' && typeof input.url === 'string') return input.url
  return ''
}

/**
 * **请求头摘要（脱敏）** —— 只有 `CK_SPY_HEADERS=1` 时才产出。
 *
 * 为什么需要：实测「同一份 body（sha256 完全一致）」在两条路径上命中率差很多
 * （CLI 直连 37%/55% vs 插件经 llm adapter 100%），body 已经排除，剩下的嫌疑就是 header。
 *
 * 脱敏规则（**绝不落明文**）：
 *  - `authorization` / `x-api-key` / 任何含 key·token·secret·cookie 的头 → 只留前 7 字符 + `****`
 *  - 其余头 → 只留**前 8 字符 + 值长度**（足够比对「两边是不是同一组/同一个值」，又拿不到全文）
 */
function headerDigest(input, init) {
  if (process.env.CK_SPY_HEADERS !== '1') return null
  const src = init?.headers ?? (typeof input === 'object' && input !== null ? input.headers : undefined)
  if (src === undefined || src === null) return []
  const pairs = []
  if (typeof src.forEach === 'function' && typeof src.get === 'function') {
    src.forEach((v, k) => pairs.push([String(k), String(v)]))
  } else if (Array.isArray(src)) {
    for (const it of src) if (Array.isArray(it)) pairs.push([String(it[0]), String(it[1])])
  } else if (typeof src === 'object') {
    for (const [k, v] of Object.entries(src)) pairs.push([String(k), String(v)])
  }
  const SECRET = /authorization|x-api-key|api-key|cookie|token|secret/i
  return pairs.map(([k, v]) => (SECRET.test(k)
    ? { name: k, len: v.length, preview: v.slice(0, 7) + '****' }
    : { name: k, len: v.length, preview: v.slice(0, 8) }))
}

function methodOf(input, init) {
  const raw = init?.method ?? (typeof input === 'object' && input !== null ? input.method : undefined) ?? 'GET'
  return String(raw).toUpperCase()
}

/** 从 argv 里挖 `--profile <name>`。 */
function profileOf(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--profile' || a === '-p') return argv[i + 1]
    if (a.startsWith('--profile=')) return a.slice('--profile='.length)
  }
  return undefined
}

const dshHomeOf = () => process.env.DSH_HOME ?? join(homedir(), '.dsh')

/**
 * 找**本次请求可能写过**的会话日志。三条硬筛，缺一条就会灌爆用户磁盘：
 *
 *  1. **mtime ≥ t0 − CK_SPY_FREEZE_LOOKBACK_MS（默认 120 秒）**
 *  2. **单个文件 ≤ 50MB** —— 大会话的 `.zstd` 能到 38MB，复制一份就是把用户全部对话抄一遍
 *  3. **总数 ≤ CK_SPY_FREEZE_MAX（默认 1）** —— 限的是**文件数**，不是「冻结次数」
 *
 * ## 为什么是 t0 − 120 秒，不是 t0
 * t0 是探针**启动**时刻，冻结发生在**请求发出时**。这两个时刻对**已有会话**是有差距的：
 * 在 40b9 这种老会话里聊一句时，请求发出那一刻本轮内容还没落盘，mtime 仍是上一轮的 ——
 * 若卡死 `mtime >= t0`，「在真实会话里聊一句」这条**最便宜的取证路径**就会漏冻。
 * 放宽 120 秒的代价只是多几个候选，而有 size 上限 + 文件数上限 1 兜着；
 * 漏冻则要重跑一次探针（要花真钱），代价不对称。
 *
 * 历史教训：初版限的是次数（3 次 × 每次复制 5 条 = 15 个副本），实测灌了 194.6MB 用户对话。
 *
 * @param t0 探针启动时刻（毫秒）
 * @param lookbackMs 往前放宽的窗口
 * @param maxBytes 单文件上限
 * @returns 绝对路径，按 mtime 倒序
 */
function recentLogs(t0, lookbackMs, maxBytes) {
  const root = join(dshHomeOf(), 'sessions')
  const out = []
  const floor = t0 - lookbackMs
  let projects = []
  try {
    projects = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return out
  }
  for (const project of projects) {
    let sessions = []
    try {
      sessions = readdirSync(join(root, project.name), { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      continue
    }
    for (const session of sessions) {
      const file = join(root, project.name, session.name, 'session.v4.jsonl.zstd')
      try {
        const st = statSync(file)
        if (st.mtimeMs < floor) continue
        if (st.size > maxBytes) continue
        out.push({ file, mtime: st.mtimeMs, size: st.size })
      } catch {
        /* 没有日志文件的会话跳过 */
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out.map((x) => x.file)
}

/** 全部逻辑。**只有确定是 DSH 入口时才会被调用**。 */
function install() {
  const outDir = outDirOf()
  if (!ensureDir(outDir)) return
  const maxBody = Number(process.env.CK_SPY_MAX ?? '3')
  /** 冻结副本**文件数**上限（不是次数）。默认 1。 */
  const maxFreeze = Number(process.env.CK_SPY_FREEZE_MAX ?? '1')
  /** 单份日志复制上限：超过就不冻（大会话 zstd 能到 38MB）。 */
  const freezeMaxBytes = Number(process.env.CK_SPY_FREEZE_MAX_BYTES ?? String(50 * 1024 * 1024))
  /** 冻结的时间窗：往前放宽多久（见 `recentLogs` 的注释）。 */
  const lookbackMs = Number(process.env.CK_SPY_FREEZE_LOOKBACK_MS ?? '120000')
  const match = process.env.CK_SPY_MATCH ?? 'tokenrhythm'
  const profile = profileOf(process.argv)
  const tag = stamp()
  /** 探针启动时刻：只冻结这之后被写过的日志（那必然是本次请求写的）。 */
  const t0 = Date.now()

  let bodies = 0
  let frozenCount = 0
  let metaWritten = false
  const frozenPaths = []

  const write = (name, text) => {
    try {
      writeFileSync(join(outDir, name), redact(text), 'utf8')
      return true
    } catch {
      return false
    }
  }

  /**
   * 拦截这一刻的日志快照（**按文件数限流**，时间窗见 `recentLogs`）。
   *
   * **必须按 body 内容挑，不能只按 mtime 取最近一条。**
   *
   * 实测事故（2026-10-23）：在 3f0b 上触发保温，抓到的 frozen 首行 id 却是
   * `session-1f64b53f…`（40b9）—— 因为 40b9 恰好也在写日志，`recentLogs` 按 mtime
   * 排序把它排在前面。结果「装配 1314 条 vs body 632 条」被误判成插件少吐/多吐，
   * 白查两轮。
   *
   * 判据：body 第 0 条 system/developer 文本的开头（默认 120 字符）必须出现在
   * 候选日志的**最后一个 system/message 事件**里。匹配不上就不冻（宁缺毋滥），
   * 并在 freeze json 里写明原因。
   */
  const bodyFingerprint = (bodyText) => {
    try {
      const parsed = JSON.parse(bodyText)
      const msgs = Array.isArray(parsed?.messages) ? parsed.messages : []
      const sys = msgs.find((m) => m?.role === 'system' || m?.role === 'developer')
      return typeof sys?.content === 'string' ? sys.content.slice(0, 120) : ''
    } catch {
      return ''
    }
  }

  /** 读候选日志最后一个 system/message 的文本（解压失败返回 ''）。 */
  const lastSystemTextOf = (file) => {
    try {
      const { text } = decodeMultiFrame(readFileSync(file))
      let last = ''
      for (const line of text.split('\n')) {
        if (line === '') continue
        if (!line.includes('"system/message"') && !line.includes('"developer/message"')) continue
        try {
          const e = JSON.parse(line)
          const blocks = e?.data?.content ?? e?.data?.message?.content ?? []
          const joined = Array.isArray(blocks) ? blocks.map((b) => b?.text ?? '').join('') : ''
          if (joined !== '') last = joined
        } catch {
          /* 单行坏了不影响其它行 */
        }
      }
      return last
    } catch {
      return ''
    }
  }

  const freezeLogs = (bodyName, bodyText) => {
    if (maxFreeze <= 0 || frozenCount >= maxFreeze) return []
    /**
     * **`CK_SPY_LOG` 优先**：调用方（`cli/keepalive.mjs --spy`）知道本次保温是哪条会话，
     * 直接给路径最可靠。
     *
     * 为什么必需：`recentLogs()` 靠 `mtime >= t0-窗口` 找候选，但**离线保温不写会话日志** ——
     * 目标会话的 mtime 可能停在几小时前，永远落在窗口外，于是只会冻到别的活跃会话
     * （实测把 3f0b 冻成了另一条 fbf8ac6e）。
     */
    const explicit = process.env.CK_SPY_LOG
    const candidates = typeof explicit === 'string' && explicit !== '' && existsSync(explicit)
      ? [explicit]
      : recentLogs(t0, lookbackMs, freezeMaxBytes)
    const need = bodyFingerprint(bodyText ?? '')
    const picked = need === '' ? candidates : candidates.filter((f) => lastSystemTextOf(f).includes(need))
    if (picked.length === 0) {
      /** 明确失败，不静默：告诉人为什么没冻到、下一步怎么办。 */
      write(`freeze-${tag}.json`, JSON.stringify({
        schema: 'ck-fetchspy/1',
        profile: profile ?? null,
        dshHome: dshHomeOf(),
        at: new Date().toISOString(),
        rule: `mtime >= t0-${lookbackMs}ms && size <= ${freezeMaxBytes} 字节；且最后一个 system/message 含 body 指纹（前 120 字符）；最多 ${maxFreeze} 个`,
        frozen: [],
        why: candidates.length === 0
          ? `$DSH_HOME/sessions 下没有满足条件（mtime >= ${new Date(t0 - lookbackMs).toISOString()} 且 ≤ ${freezeMaxBytes} 字节）的会话日志`
          : `${candidates.length} 个候选的 system/message 都不含 body 指纹（body 与日志可能不是同一条会话）`,
        next: '增大 CK_SPY_FREEZE_LOOKBACK_MS 重跑，或直接用 --log 指定会话日志路径',
      }, null, 2))
      return []
    }
    for (const src of picked) {
      if (frozenCount >= maxFreeze) break
      const dest = join(outDir, `frozen-${Date.now()}-${process.pid}-${frozenCount}.zstd`)
      try {
        copyFileSync(src, dest)
        frozenCount += 1
        frozenPaths.push({ from: src, to: dest })
      } catch {
        /* 复制失败就跳过这条候选 */
      }
    }
    if (frozenPaths.length > 0) {
      write(`freeze-${tag}.json`, JSON.stringify({
        schema: 'ck-fetchspy/1',
        profile: profile ?? null,
        dshHome: dshHomeOf(),
        at: new Date().toISOString(),
        rule: `mtime >= t0-${lookbackMs}ms && size <= ${freezeMaxBytes} 字节；最多 ${maxFreeze} 个`,
        frozen: frozenPaths,
        note: '哪一份对应本次请求由 wire-diff --freeze 判定（它会打印每个候选的吻合度）',
      }, null, 2))
    }
    return frozenPaths
  }

  const realFetch = globalThis.fetch

  /**
   * **探针绝不改变请求**。整个 hook 体包在 try/catch 里：
   * 任何异常（读 body 失败、落盘失败、上游已读过流……）一律**静默回落到原 fetch**。
   *
   * 历史事故：探针包装后用户发消息没反应 —— 因为 `init.body` 是**上游已经读过**的
   * `ReadableStream`（`locked === true`），`tee()` 直接抛 `TypeError`，请求被吞掉。
   * 现在 `readBody` 会先检查 `locked`，锁住就**不读**、原样转发。
   */
  globalThis.fetch = async function spyFetch(input, init) {
    /** 落一份错误痕迹但不打断请求。 */
    const note = (stage, e) => {
      try {
        write(`spy-error-${tag}.txt`, `[${stage}] ${String(e?.stack ?? e?.message ?? e)}`)
      } catch {
        /* 连错误都写不了就算了，绝不能影响原请求 */
      }
    }
    try {
      const url = urlOf(input)
      const method = methodOf(input, init)
      if (method !== 'POST') return await realFetch(input, init)

      const rawBody = init?.body ?? (typeof input === 'object' && input !== null ? input.body : undefined)
      let text
      let nextBody = rawBody
      try {
        const got = await readBody(rawBody)
        text = got.text
        nextBody = got.nextBody
      } catch (e) {
        note('readBody', e)
      }
      /**
       * **必须**用 `nextBody` 转发：流形态下原 body 已被 `tee()` 锁住，再用它会抛 TypeError。
       * 若 `readBody` 因「流已 locked」而放弃读取，`nextBody === rawBody`，原样转发 —— 请求照常。
       *
       * **`duplex: 'half'` 不可省**：body 是 `ReadableStream` 时，undici 在 `new Request()` 阶段就抛
       * `TypeError: RequestInit: duplex option is required when sending a body`，请求根本发不出去
       * （表现为「页面卡住、消息发不出」）。原 `init` 由 openai SDK 构造，不带 duplex，必须补。
       */
      const isStreamBody = (b) => b !== null && typeof b === 'object' && typeof b.getReader === 'function'
      const withDuplex = (o) => (isStreamBody(o?.body) ? { ...o, duplex: 'half' } : o)
      const forward = async () => {
        if (nextBody === rawBody) return await realFetch(input, init)
        if (init !== undefined && init !== null) return await realFetch(input, withDuplex({ ...init, body: nextBody }))
        if (typeof input === 'object' && input !== null && 'url' in input) {
          return await realFetch(new Request(input, withDuplex({ body: nextBody })), init)
        }
        return await realFetch(input, withDuplex({ body: nextBody }))
      }

      /** 首次命中任意 POST：**无条件**落一份 meta（只含 URL + 顶层键名，不含正文）。 */
      if (!metaWritten) {
        metaWritten = true
        let keys = null
        if (typeof text === 'string' && text !== '') {
          try {
            const parsed = JSON.parse(text)
            keys = parsed !== null && typeof parsed === 'object' ? Object.keys(parsed) : null
          } catch {
            keys = null
          }
        }
        write(`spy-meta-${tag}.json`, JSON.stringify({
          schema: 'ck-fetchspy/1',
          url,
          method,
          pid: process.pid,
          at: new Date().toISOString(),
          topLevelKeys: keys,
          bodyIsText: typeof text === 'string',
          bodyForm: formOf(rawBody),
          profile: profile ?? null,
          argv: process.argv.slice(0, 10),
          /** `CK_SPY_HEADERS=1` 才有值；内容已脱敏（见 headerDigest）。 */
          headers: headerDigest(input, init),
          note: '请求头默认不落盘；CK_SPY_HEADERS=1 时只落脱敏摘要（名前缀 8 字符 + 值长度）',
        }, null, 2))
      }

      const isTarget = typeof text === 'string' && text !== '' && (match === '' || url.includes(match))
      if (!isTarget || (maxBody > 0 && bodies >= maxBody)) return await forward()

      const n = bodies
      bodies += 1
      let parsed
      let isJson = true
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
        isJson = false
      }
      const bodyName = `real-body-${process.pid}-${Date.now()}-${n}.json`
      const ok = write(bodyName, isJson ? JSON.stringify(parsed, null, 2) : text)
      if (!ok) return await forward()
      const frozen = freezeLogs(bodyName)
      write(bodyName.replace(/\.json$/u, '.meta.json'), JSON.stringify({
        schema: 'ck-fetchspy/1',
        url,
        host: (() => {
          try {
            return new URL(url).host
          } catch {
            return ''
          }
        })(),
        bytes: text.length,
        pid: process.pid,
        at: new Date().toISOString(),
        frozen,
        note: 'charsPerToken 口径：JSON.stringify(本文件里的 body).length ÷ 同一次请求的 prompt_tokens（见同目录 usage-*.json）',
      }, null, 2))
      /**
       * **顺带把响应里的 usage 也抓下来** —— `charsPerToken` 的分母 `prompt_tokens` 只在响应里。
       * 流式响应是 SSE（`data: {...}` 逐行），非流式是 JSON；两种都试。
       * ⚠️ 用 `res.clone()`，原响应流照常给下游，不改变任何行为。
       */
      const res = await forward()
      try {
        const text2 = await res.clone().text()
        const u = usageOf(text2)
        if (u !== undefined) {
          write(`usage-${process.pid}-${Date.now()}-${n}.json`, JSON.stringify({
            schema: 'ck-fetchspy/1',
            forBody: bodyName,
            url,
            at: new Date().toISOString(),
            usage: u,
          }, null, 2))
        }
      } catch {
        /* 抓不到 usage 不影响正文落盘 */
      }
      return res
    } catch (e) {
      /**
       * **兜底**：探针里任何未预期的异常都不能影响原请求。
       * 这里退回一次「最朴素」的转发（不带任何 body 改造）。
       */
      note('hook', e)
      return await realFetch(input, init)
    }
  }

  write(`spy-loaded-${tag}.json`, JSON.stringify({
    schema: 'ck-fetchspy/1',
    pid: process.pid,
    out: outDir,
    maxBody,
    maxFreeze,
    freezeMaxBytes,
    match,
    t0: new Date(t0).toISOString(),
    profile: profile ?? null,
    argv: process.argv.slice(0, 10),
    at: new Date().toISOString(),
  }, null, 2))

  process.on('exit', () => {
    if (bodies === 0 && !metaWritten) return
    write(`spy-summary-${tag}.json`, JSON.stringify({
      pid: process.pid, bodies, frozen: frozenCount, frozenBytes: totalBytes(frozenPaths), metaWritten,
      out: outDir, maxBody, maxFreeze, freezeMaxBytes, match,
    }, null, 2))
  })
}

/** 冻结副本总字节（写进 summary，便于一眼看出有没有失控）。 */
function totalBytes(paths) {
  let sum = 0
  for (const p of paths) {
    try {
      sum += statSync(p.to).size
    } catch {
      /* 副本被删了就按 0 算 */
    }
  }
  return sum
}

/**
 * 从响应文本里挖 usage。
 *
 * 非流式是整段 JSON；流式是 SSE（`data: {...}` 逐行，最后一条带 usage）。
 * 只挑 `prompt_tokens`，其余原样留着。
 *
 * @param text 响应文本
 * @returns `{ prompt_tokens, ... }`；找不到返回 undefined
 */
function usageOf(text) {
  const take = (obj) => {
    const u = obj?.usage
    return u !== undefined && u !== null && typeof u.prompt_tokens === 'number' ? u : undefined
  }
  try {
    const whole = JSON.parse(text)
    const hit = take(whole)
    if (hit !== undefined) return hit
  } catch {
    /* 不是整段 JSON：按 SSE 走 */
  }
  let last
  for (const line of text.split('\n')) {
    const m = /^data:\s*(\{.*\})\s*$/u.exec(line.trim())
    if (m === null) continue
    try {
      const hit = take(JSON.parse(m[1]))
      if (hit !== undefined) last = hit
    } catch {
      /* 半截行忽略 */
    }
  }
  return last
}

const entry = process.argv[1] ?? ''
/**
 * 是否安装钩子。
 *
 * - 常规：入口必须是 DSH 本体（`dsh/lib/bin.js` 或桌面版 `dsh-desktop-host/lib/cli.js`）
 * - **`CK_SPY_FORCE=1`：无条件安装** —— 给非 DSH 入口用，典型是
 *   `cli/keepalive.mjs --spy`（它 spawn 自己时带这个变量）。
 *   CLI 的 `argv[1]` 永远是 `keepalive.mjs`，只靠入口正则**永远不会装**（只会写 skip marker）。
 */
if (ENTRY_RE.test(entry) || process.env.CK_SPY_FORCE === '1') {
  install()
} else if (process.env.CK_SPY_QUIET !== '1') {
  /**
   * 没装上的**必须留痕**：入口一变（换版本、换打包方式）钩子就静默失效，
   * 跑完什么都没抓到，分不清「没发生」还是「没装上」。这里写 argv[1] 供比对。
   */
  const dir = outDirOf()
  if (ensureDir(dir)) {
    try {
      writeFileSync(join(dir, `spy-skip-${process.pid}.txt`), entry === '' ? '(none)' : entry, 'utf8')
    } catch {
      /* 连 marker 都写不了就没办法了，但不能因此让宿主进程起不来 */
    }
  }
}
