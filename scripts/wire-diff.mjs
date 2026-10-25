#!/usr/bin/env node
/**
 * **请求体逐条比对**：真实 body（`scripts/fetchspy.mjs` 抓到的那份） vs 插件产物
 * （`assembleSession` + `serializeForOpenAI`）。
 *
 * ## 用法
 * ```
 * node scripts/wire-diff.mjs --body .tmp/real-body-<pid>-<ts>.json --log .tmp/frozen-<ts>.zstd
 * node scripts/wire-diff.mjs --body ... --freeze .tmp/freeze-<pid>-<ts>-1.json   # 让脚本自己挑冻结副本
 * node scripts/wire-diff.mjs --help
 * ```
 * 选项：
 *  - `--body`   真实请求体 JSON（必填）
 *  - `--log`    冻结的会话日志（`.zstd` 绝对路径）。`assembleSession` 自己解多帧，不用预解码
 *  - `--freeze` fetchspy 写的 `freeze-*.json`，里面有若干候选日志；不给 `--log` 时逐条装配、挑最吻合的
 *  - `--text`   插件侧末尾追加的保温问题（**默认从 body 末尾那条 user 提取**，不要手填成 state.json 的值）
 *  - `--full`   把所有差异都列出来（默认只出**第一处**）
 *
 * ## 退出码
 * `0` 完全一致；`1` 找到差异；`2` 输入有问题（拿不到 body / 装配失败）—— 都是**人话报错，不崩**
 *
 * ## 为什么必须传 `resolveImage`
 * 含图会话里图片是附件句柄，真实请求会把真字节内联进去。不传 `resolveImage` 就会两边都降级成
 * 占位文本 —— 差异是真的，但结论会指错方向（「图片段不同」其实是「没去读图」）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { readAttachment } from '../src/core/attachments.ts'
import { assembleSession } from '../src/core/assemble.ts'
import { serializeForOpenAI } from '../src/core/wire-openai.ts'
import { loadProviders } from '../src/core/providers.ts'
import { providerMetaOf, instructionRoleOf, thinkingParamsOf } from '../src/core/provider-meta.ts'
import { wireShapeOf } from '../src/core/warm-offline.ts'

const dshHome = () => process.env.DSH_HOME ?? join(homedir(), '.dsh')

const USAGE = `用法：
  node scripts/wire-diff.mjs --body <real-body.json> --log <frozen.zstd> [--full]
  node scripts/wire-diff.mjs --body <real-body.json> --freeze <freeze-*.json> [--full]
  node scripts/wire-diff.mjs --help

  --body    真实请求体（scripts/fetchspy.mjs 落的 real-body-*.json）
  --log     冻结的会话日志（.zstd 绝对路径）
  --freeze  fetchspy 落的 freeze-*.json（含候选日志列表，脚本自己挑最吻合的一份）
  --text    插件侧末尾追加的保温问题（**默认从 body 末尾那条 user 自动提取**）
  --full    列出全部差异（默认只出第一处）`

function parseArgs(argv) {
  const out = { full: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--full') out.full = true
    else if (a === '--body' || a === '--log' || a === '--freeze' || a === '--text') {
      out[a.slice(2)] = argv[i + 1]
      i += 1
    } else if (a.startsWith('--body=')) out.body = a.slice(7)
    else if (a.startsWith('--log=')) out.log = a.slice(6)
    else if (a.startsWith('--freeze=')) out.freeze = a.slice(9)
    else if (a.startsWith('--text=')) out.text = a.slice(7)
  }
  return out
}

function fail(msg) {
  process.stderr.write('❌ ' + msg + '\n')
  process.exit(2)
}

/**
 * 保温问题：**从真实 body 的最后一条 user 消息里取**。
 *
 * 为什么不用 `state.json` 的默认值：探针任务往往和用户设置的保温问题不同
 * （例如探针是「只回复两个字：OK」，设置里是「Reply with exactly: OK」），
 * 拿默认值会让末尾那条永远假差异，还会影响 `assembleSession` 的缓存键。
 *
 * @param real 真实请求体
 * @returns 末尾 user 的文本；取不到就退回 `'ok'`（并会在报告里说明）
 */
function promptFromBody(real) {
  const msgs = real?.messages
  if (!Array.isArray(msgs)) return 'ok'
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i]
    if (m?.role !== 'user') continue
    if (typeof m.content === 'string' && m.content !== '') return m.content
    if (Array.isArray(m.content)) {
      const text = m.content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('')
      if (text !== '') return text
    }
  }
  return 'ok'
}

/** 把任意值缩成一行可读的样子（长字符串只给长度 + 首尾）。 */
function brief(v) {
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  if (typeof v === 'string') {
    const s = JSON.stringify(v)
    return s.length <= 120 ? s : s.slice(0, 80) + `…（共 ${v.length} 字符）…` + s.slice(-20)
  }
  const s = JSON.stringify(v)
  return s === undefined ? String(v) : s.length <= 160 ? s : s.slice(0, 140) + '…'
}

/**
 * 一条消息的字段级差异（按出现顺序）。
 *
 * ⚠️ **`content` 先比形态、再比文本**（E4）。
 *
 * 以前只比 `JSON.stringify` 的值 —— 当真实是 `"..."` 字符串、插件是
 * `[{"type":"text","text":"..."}]` 块数组时，字符串化结果虽不同会报差异，但**报告措辞只说
 * 「content 不同」**，看不出是形态问题；而且一旦哪天有人「把数组拼成字符串再比」，
 * 形态差异就会被归一化掉、变成假绿灯（v6 的新会话就是这么被放过的：真实 string / 插件数组，
 * 却报「逐条一致」）。
 *
 * 所以形态差异必须**显性**：字段名标 `content(形态)`，两边分别写清是哪种形态。
 *
 * @param realMsg 真实消息
 * @param pluginMsg 插件消息
 * @param index 消息下标
 */
function diffMessage(realMsg, pluginMsg, index) {
  const out = []
  const shapeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
  /** 先比形态：只要形态不同就直接报，不再往下比文本（文本比了也是误导）。 */
  const realShape = shapeOf(realMsg?.content)
  const pluginShape = shapeOf(pluginMsg?.content)
  if (realShape !== pluginShape) {
    out.push({
      index,
      field: 'content(形态)',
      real: realShape,
      plugin: pluginShape,
      detail: `真实=${realShape} / 插件=${pluginShape}`,
    })
  }
  const roles = ['role', 'content', 'tool_calls', 'tool_call_id', 'reasoning_content']
  for (const k of roles) {
    const a = realMsg?.[k]
    const b = pluginMsg?.[k]
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    /** 形态已经报过了，文本差异就不再重复报（否则同一条消息刷两条）。 */
    if (k === 'content' && realShape !== pluginShape) continue
    out.push({ index, field: k, real: a, plugin: b, missing: a === undefined ? 'real' : b === undefined ? 'plugin' : null })
  }
  return out
}

/**
 * 找这份 body 对应的 usage（`scripts/fetchspy.mjs` 落的 `usage-*.json`，按 `forBody` 关联）。
 *
 * @param bodyPath 真实 body 文件绝对路径
 * @returns `{ prompt_tokens, ... }`；没抓到返回 undefined
 */
function usageForBody(bodyPath) {
  const dir = dirname(bodyPath)
  const base = basename(bodyPath)
  let names = []
  try {
    names = readdirSync(dir).filter((f) => /^usage-.*\.json$/u.test(f))
  } catch {
    return undefined
  }
  for (const f of names) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (j?.forBody === base && typeof j?.usage?.prompt_tokens === 'number') return j.usage
    } catch {
      /* 坏文件跳过 */
    }
  }
  return undefined
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true) {
    process.stdout.write(USAGE + '\n')
    process.exit(0)
  } 
  if (args.body === undefined) {
    process.stderr.write(USAGE + '\n\n❌ 缺少 --body：先跑 scripts/fetchspy.mjs 抓一个真实请求体\n')
    process.exit(2)
  }
  const bodyPath = isAbsolute(args.body) ? args.body : resolve(process.cwd(), args.body)
  if (!existsSync(bodyPath)) {
    fail(`找不到请求体文件：${bodyPath}\n   先跑：NODE_OPTIONS="--import=file:///<仓库>/scripts/fetchspy.mjs" node <dsh>/lib/bin.js …`)
  }
  let real
  try {
    real = JSON.parse(readFileSync(bodyPath, 'utf8'))
  } catch (e) {
    fail(`请求体不是合法 JSON：${bodyPath}\n   ${String(e?.message ?? e)}`)
  }
  if (!Array.isArray(real?.messages)) {
    fail(`请求体里没有 messages 数组：${bodyPath}\n   顶层键：${Object.keys(real ?? {}).join(', ') || '(空)'}`)
  }

  /** 候选日志：`--log` 直给，或从 `--freeze` 的清单里取。 */
  let candidates = []
  if (args.log !== undefined) {
    const p = isAbsolute(args.log) ? args.log : resolve(process.cwd(), args.log)
    if (!existsSync(p)) fail(`找不到日志：${p}`)
    candidates = [p]
  } else if (args.freeze !== undefined) {
    const fp = isAbsolute(args.freeze) ? args.freeze : resolve(process.cwd(), args.freeze)
    if (!existsSync(fp)) fail(`找不到 freeze 清单：${fp}`)
    let manifest
    try {
      manifest = JSON.parse(readFileSync(fp, 'utf8'))
    } catch (e) {
      fail(`freeze 清单不是合法 JSON：${fp}\n   ${String(e?.message ?? e)}`)
    }
    candidates = (manifest?.frozen ?? []).map((x) => x.to).filter((x) => typeof x === 'string' && existsSync(x))
    if (candidates.length === 0) {
      fail(`freeze 清单里没有可用的日志副本：${fp}\n   （fetchspy 复制时 $DSH_HOME/sessions 下没有会话，或副本已被清理）`)
    }
  } else {
    process.stderr.write(USAGE + '\n\n❌ 缺少 --log 或 --freeze：需要一份「请求发出那一刻」的会话日志副本\n')
    process.exit(2)
  }

  const prompt = args.text ?? promptFromBody(real)

  /** 组装插件侧。真实 body 里的 model 可能来自任意 provider，兼容信息按配置补。 */
  const realOf = []
  for (const logFile of candidates) {
    const plan = assembleSession(logFile, prompt)
    if (plan.error !== undefined) {
      realOf.push({ logFile, error: plan.error })
      continue
    }
    const providerName = plan.config?.provider
    const modelName = plan.config?.model
    const meta = typeof providerName === 'string' && typeof modelName === 'string'
      ? providerMetaOf(dshHome(), providerName, modelName)
      : undefined
    const third = typeof providerName === 'string' ? loadProviders(dshHome()).get(providerName) : undefined
    /** **唯一判定点**：与 `warm-offline.ts` 走同一个 `wireShapeOf()`，脚本不自己拼形状。 */
    const shape = wireShapeOf(plan, dshHome())
    const pluginBody = serializeForOpenAI(plan.messages, {
      model: String(modelName ?? real.model ?? ''),
      maxTokens: args.warm === true ? 1 : Number(real?.max_completion_tokens ?? real?.max_tokens ?? plan.config?.maxTokens ?? 1),
      ...(plan.system === undefined ? {} : { system: plan.system }),
      ...(plan.tools.length === 0 ? {} : { tools: plan.tools }),
      resolveImage: (att) => readAttachment(dshHome(), att.attachmentId, att.mediaType),
      ...shape,
    })
    /**
     * **模拟 `warmOffline` 发保温请求时对 body 的改动**（`warm-offline.ts` 里做的那两步）。
     * 不模拟的话，比的是「普通流式请求」而不是「保温请求」，`stream` / `stream_options`
     * 会永远报差异 —— 那是 wire-diff 的模拟缺失，不是插件缺陷。
     *
     * **自动检测**：被比的 body 若 `stream === false` 且输出上限是 1（保温请求的标志），
     * 就自动按保温形态处理 —— 别指望人记得加 `--warm`。`--warm` 仍可强制开启。
     */
    const looksWarm = real?.stream === false
      && Number(real?.max_completion_tokens ?? real?.max_tokens ?? 0) === 1
    if (args.warm === true || looksWarm) {
      pluginBody.stream = false
      delete pluginBody.stream_options
    }
    realOf.push({
      logFile,
      plan,
      pluginBody,
      third: third !== undefined,
      /**
       * 配置推导值：**只存纯值**（`'system'` / `'developer'`）。
       * 后缀（例如「配置未命中」）放 `roleDerivedNote` ——
       * 混进值里会让 `roleDerived !== roleShipped` 在两边都是 `system` 时也成立，
       * 报告就会喊「role 不同」，把 P0 结论引向改 role（v2 已经因此栽过一次）。
       */
      roleDerived: meta === undefined ? 'system' : instructionRoleOf(meta),
      roleDerivedNote: meta === undefined ? '配置未命中，按 system 兜底' : null,
      /** 插件真正发出去的 role（从产物里读，这才是事实）。 */
      roleShipped: String(pluginBody.messages?.[0]?.role ?? ''),
      thinking: meta === undefined ? {} : thinkingParamsOf(meta, plan.config?.reasoningEffort),
      score: score(real.messages, pluginBody.messages),
    })
  }

  const usable = realOf.filter((x) => x.error === undefined)
  if (usable.length === 0) {
    fail('所有候选日志都装配失败：\n' + realOf.map((x) => `  ${x.logFile}\n    ${x.error}`).join('\n'))
  }
  usable.sort((a, b) => b.score - a.score)
  const pickOne = usable[0]

  const realMsgs = real.messages
  const plugMsgs = pickOne.pluginBody.messages ?? []
  /**
   * **真实 body 有几条就比几条**（契约 v6 D6）。
   *
   * 以前是「两侧末尾都是 user 就排除末条」，理由是 `assembleSession` 一定在末尾 push 一条
   * 保温问题。但那个假设不成立：真实末尾本来就是 user 时（例如 runtime-context 快照、
   * 或用户刚发的一条），**真实的那一条也会被一起排掉** —— 真差异被吞掉。
   *
   * 现在：比对范围取两边较长的那个；**真实里有的每一条都比**，插件多出来的那些
   * 单独标注为「插件多出、未比对」（那是装配追加的保温问题，不是序列化差异）。
   */
  const cmpCount = realMsgs.length
  const diffs = []
  for (let i = 0; i < cmpCount; i += 1) {
    diffs.push(...diffMessage(realMsgs[i], plugMsgs[i], i))
    if (diffs.length > 0 && args.full !== true) break
  }
  /** 插件多出来、真实 body 里没有的那些（通常是末尾追加的保温问题）。 */
  const extra = plugMsgs.length > realMsgs.length
    ? plugMsgs.slice(realMsgs.length).map((m, k) => ({ index: realMsgs.length + k, role: m?.role, len: String(m?.content ?? '').length }))
    : []

  /**
   * 插件多出的那部分是否**可以豁免**。
   *
   * ⚠️ 别放宽成「真实都对上就通过」：曾经这么写过，结果把真实 body 砍掉最后一条后
   * （插件多出 2 条）**照样 exit 0** —— 装配真多吐一条也会被绿灯放过。
   *
   * 三个条件全满足才算（保温请求 = 真实请求 + 末尾再追加一个短问题）：
   *  1. 只多出 **1 条**（≥2 条说明装配真多吐了东西）
   *  2. 它在**末尾**（`assembleSession` 追加的位置）
   *  3. `role === 'user'`
   *
   * 为什么不比 content 与 prompt：`--text` / body 末尾提取出的 prompt 既是**装配输入**、
   * 又拿来当判据，两边一起变，等于自己和自己比（实测反例 C 就是这么蒙过去的）。
   * 内容对不对由「真实 body 的每一条都逐字节相等」保证。
   */
  /**
   * 插件多出消息时是否可豁免：
   * - **0 条** → 通过（两边完全相等，最理想 —— 保温 prompt 已经被 `assembleSession` 算进去时就是这种）
   * - **1 条且在末尾且是 user** → 通过（那是 `assembleSession` 追加的保温 prompt）
   * - 其余一律不通过
   *
   * ⚠️ 早先写成 `extra.length === 1 && …`，把「0 条」判成了失败 ——
   * 实测离线保温体（652=652、逐条一致）因此报 ❌ exit 1，是假红。
   */
  const extraOk = extra.length === 0 || (extra.length === 1
    && extra[0].index === plugMsgs.length - 1
    && extra[0].role === 'user')

  /**
   * 顶层键**全量**比对：先比两边键集合，再逐个比值。
   * 只列一个固定名单会漏检（曾经漏掉 `max_completion_tokens` / `store` → 报「顶层一致」的假绿灯）。
   *
   * ⚠️ `messages` **不参与这里**（它由下面逐条比对负责，且插件必然多一条保温 prompt，
   * 放进来就是一条永远红的假差异）；只比它的**是否存在**。
   */
  const realKeys = Object.keys(real ?? {}).sort()
  const plugKeys = Object.keys(pickOne.pluginBody ?? {}).sort()
  const topKeys = [...new Set([...realKeys, ...plugKeys])].filter((k) => k !== 'messages')
  const topDiffs = []
  for (const k of topKeys) {
    const a = real?.[k]
    const b = pickOne.pluginBody?.[k]
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    topDiffs.push({ field: k, real: a, plugin: b })
  }
  const keySetSame = realKeys.length === plugKeys.length && realKeys.every((k, i) => k === plugKeys[i])

  const L = []
  L.push('=== wire-diff：真实请求体 vs 插件产物 ===')
  L.push('真实 body  : ' + bodyPath)
  L.push('会话日志    : ' + pickOne.logFile)
  if (usable.length > 1) {
    L.push('候选日志（按吻合度，选第 1 个）：')
    for (const x of usable) {
      L.push(`  score=${String(x.score).padStart(4)}  messages=${x.pluginBody.messages?.length ?? 0}  ${x.logFile}`)
    }
    L.push('  ⚠️ 同分时按路径顺序取第一个；若 pick 不对请改用 --log 直指')
  }
  L.push('装配信息    : events=' + pickOne.plan.stats.events + ' nodes=' + pickOne.plan.stats.nodes
    + ' messages=' + pickOne.plan.stats.messages + ' tools=' + pickOne.plan.tools.length
    + ' replacements=' + pickOne.plan.stats.replacements + ' imageBlocks=' + pickOne.plan.stats.imageBlocks)
  L.push(`provider/model: ${pickOne.plan.config?.provider ?? '?'} / ${pickOne.plan.config?.model ?? '?'}`
    + ` | reasoningEffort=${String(pickOne.plan.config?.reasoningEffort ?? '(无)')} | 第三方直连=${pickOne.third}`)
  L.push(`instructionRole  配置推导=${pickOne.roleDerived}`
    + (pickOne.roleDerivedNote === null ? '' : `（${pickOne.roleDerivedNote}）`)
    + `  插件实际发出=${pickOne.roleShipped}`
    + (pickOne.roleDerived !== pickOne.roleShipped
      ? '  ⚠️ 两者不同（插件序列化器目前不接受该选项，实际忽略配置推导）'
      : '  ✅ 一致'))
  L.push('')
  L.push(`messages.length  真实=${realMsgs.length}  插件=${plugMsgs.length}` + (realMsgs.length === plugMsgs.length ? '  ✅' : '  ❌'))
  L.push(`比对范围      : 真实 ${cmpCount} 条全比` + (extra.length > 0
    ? `；插件多出 ${extra.length} 条（${extra.map((x) => `#${x.index} ${x.role}[${x.len}]`).join('、')}），未比对`
    : ''))
  L.push('')
  if (topDiffs.length > 0) {
    L.push('【顶层参数差异】')
    for (const d of topDiffs) L.push(`  ${d.field}: 真实=${brief(d.real)} / 插件=${brief(d.plugin)}`)
    L.push('')
  } else {
    L.push(`【顶层参数】一致 ✅（键集合相同=${keySetSame ? '是' : '否'}，共 ${realKeys.length} 键：${realKeys.join(' / ')}）`)
    L.push('')
  }
  if (!keySetSame && topDiffs.length === 0) {
    L.push(`  ⚠️ 键集合不同：真实=${realKeys.join(',')} / 插件=${plugKeys.join(',')}`)
    L.push('')
  }
  /**
   * **charsPerToken 口径**（契约 §③）：`JSON.stringify(实际发出的 body).length ÷ 该请求的 prompt_tokens`。
   *
   * 分子必须是**真正发出去的那个字符串**：落盘文件是带缩进的美化 JSON（37,507 字节），
   * 而真实发的是紧凑 JSON（27,480 字符）—— 用文件字节数算会把比例抬高 36%。
   * 分母只在响应里：`scripts/fetchspy.mjs` 会把 usage 落到同目录 `usage-*.json`（按 `forBody` 关联）。
   * 抓不到分母时**明确说缺什么**，不给假数值。
   */
  const compactLen = JSON.stringify(real).length
  const usage = usageForBody(bodyPath)
  L.push('charsPerToken  : ' + (usage === undefined
    ? `待补分母 —— 紧凑 body ${compactLen} 字符已就绪，但没有同批的 usage-*.json。`
      + ' 下一步：fetchspy 已支持抓响应 usage，重抓一次即可；或从会话日志的 usage 事件补 prompt_tokens'
    : `${compactLen} ÷ ${usage.prompt_tokens} = ${(compactLen / usage.prompt_tokens).toFixed(3)}`))
  L.push('')
  if (diffs.length === 0) {
    const extraNote = extra.length === 0
      ? '（插件没有多出消息）'
      : extraOk
        ? '（插件末尾多出的那一条正是本次保温 prompt，豁免）'
        : `❌ 插件多出 ${extra.length} 条，不满足豁免条件（须「恰好 1 条 + 在末尾 + user + 等于保温 prompt」）`
    const head = topDiffs.length === 0
      ? '真实 body 的每一条消息、每一个顶层键都与插件产物一致'
      : '⚠️ 比对范围内逐条一致，但顶层参数不同（见上）'
    L.push((topDiffs.length === 0 && extraOk ? '✅ ' : '❌ ') + head + extraNote)
  } else {
    L.push('【第一处差异】' + (args.full === true ? '' : '（要看全部加 --full）'))
    const d = diffs[0]
    const where = d.index < realMsgs.length && d.index < plugMsgs.length
      ? `第 ${d.index} 条消息`
      : (d.index >= plugMsgs.length ? `第 ${d.index} 条消息（真实有、插件没有）` : `第 ${d.index} 条消息（插件多出）`)
    L.push(`  ${where} / 字段 ${d.field}`)
    L.push(`    真实 = ${brief(d.real)}`)
    L.push(`    插件 = ${brief(d.plugin)}`)
    if (d.missing === 'plugin') L.push('    → 真实请求里有这个字段，插件没发（少发）')
    else if (d.missing === 'real') L.push('    → 插件发了这个字段，真实请求里没有（多发）')
    if (args.full === true && diffs.length > 1) {
      L.push('')
      L.push(`【其余差异】共 ${diffs.length} 处`)
      for (const x of diffs.slice(1, 40)) L.push(`  #${x.index} ${x.field}: 真实=${brief(x.real)} / 插件=${brief(x.plugin)}`)
      if (diffs.length > 40) L.push(`  …还有 ${diffs.length - 40} 处`)
    }
  }
  const pass = diffs.length === 0 && topDiffs.length === 0 && extraOk
  process.stdout.write(L.join('\n') + '\n')
  process.exit(pass ? 0 : 1)
}

/**
 * 一份候选日志有多吻合真实 body：条数差值 + 首尾消息 role 命中。
 * 只用于「多个候选里挑一个」，不参与差异判定。
 *
 * @param real 真实消息
 * @param plugin 插件消息
 */
function score(real, plugin) {
  let s = -Math.abs(real.length - plugin.length) * 10
  const pairs = [[0, 0], [real.length - 1, plugin.length - 1]]
  for (const [i, j] of pairs) {
    if (real[i] === undefined || plugin[j] === undefined) continue
    if (real[i].role === plugin[j].role) s += 5
    const t = (m) => String(m?.content ?? '').slice(0, 80)
    if (t(real[i]) === t(plugin[j])) s += 5
  }
  return s
}

main()
