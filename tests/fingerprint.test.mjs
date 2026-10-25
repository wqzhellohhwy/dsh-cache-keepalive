/**
 * **前缀指纹的稳定性**（`core/fingerprint.ts`）+ 与插件离线路径的一致性。
 *
 * 为什么必须有这一组（2026-10-20 实测出来的洞）：
 * `createUserMessage()` 生成的「保温问题」带**随机 UUID 的 `id`**。会话消息 ≤ 8 条时，
 * `fingerprintOf` 的「前 8 条」切片会把它算进去 → 同一条会话、同一份前缀，
 * 两次保出来的指纹也不同 → **永远判「前缀变了」→ 永远不保**。
 * 修法是把末尾那条 prompt 排除（`messages.slice(0, -1)`）—— 但那行看起来很像 bug，
 * 没有这组测试就会被后人「顺手优化掉」。
 *
 * 实测：修前 22 条短会话只有 3 条两侧一致；修后 40/40（含 17 条短会话）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fingerprintOf } from '../src/core/fingerprint.ts'
import { planReplayFromAssembled } from '../src/keepalive.ts'

const PROMPT = 'Reply with exactly: OK'

/** 造一条普通会话消息（无 id —— 真实日志里 derive 出来的消息本来就没有随机 id）。 */
const msg = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-cache-keepalive' } })

/** 造一条「保温问题」消息：**每次都换一个随机 id**，模拟 `createUserMessage()`。 */
const promptMsg = () => ({ ...msg(PROMPT), id: randomUUID() })

const TOOLS = [{ name: 't1', description: 'd', parameters: {} }]
const CONFIG = { provider: 'deepseek-official', model: 'deepseek-flash' }

test('短会话（2 条消息）：两次保温算出的指纹必须相同（随机 id 不许进指纹）', () => {
  const base = [msg('hi'), { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }]
  const runOnce = () => fingerprintOf({ tools: TOOLS, messages: [...base, promptMsg()].slice(0, -1) })
  const a = runOnce()
  const b = runOnce()
  assert.equal(a, b, '同一份前缀两次算出的指纹不同 —— 说明末尾那条带随机 id 的 prompt 混进来了')
  assert.match(a, /^\d+:\d+:[0-9a-f]{16}$/, '指纹格式必须是 <指纹版本>:<序列化版本>:<16 位十六进制>')
})

test('短会话（2 条消息）：离线侧与在线侧指纹一致', () => {
  const base = [msg('hi'), { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }]
  /** 插件离线路径：自己往末尾 append createUserMessage(prompt)（随机 id）。 */
  const plan = planReplayFromAssembled({ messages: base, tools: TOOLS, config: CONFIG }, 'sid', PROMPT, 1)
  assert.notEqual(plan, null)
  /** CLI 路径：装配产物里**已含**末尾 prompt（手写对象、无 id），算指纹时排掉它。 */
  const cliFp = fingerprintOf({ tools: TOOLS, messages: [...base, msg(PROMPT)].slice(0, -1) })
  assert.equal(cliFp, plan.fingerprint, 'CLI 与插件离线路径算出的指纹不一致 → 两边会互相判「前缀变了」')
  /** 插件侧连续两次（每次新 UUID）也必须一致。 */
  const again = planReplayFromAssembled({ messages: base, tools: TOOLS, config: CONFIG }, 'sid', PROMPT, 1)
  assert.equal(again.fingerprint, plan.fingerprint, '插件侧连续两次指纹不同 → 每次保温都会自我暂停')
})

test('恰好 8 条消息的边界：slice(0,-1) 后是 7 条，prompt 不进指纹', () => {
  const seven = Array.from({ length: 7 }, (_, i) => msg('m' + i))
  const a = [...seven, promptMsg()]
  const b = [...seven, promptMsg()]
  assert.equal(a.length, 8, '这条用例的前提就是「总长 8 条」')
  assert.equal(
    fingerprintOf({ tools: TOOLS, messages: a.slice(0, -1) }),
    fingerprintOf({ tools: TOOLS, messages: b.slice(0, -1) }),
    '8 条边界上随机 id 漏进了指纹',
  )
  /** 反向证据：**不**排除末条时两者必须不同 —— 否则这条用例其实什么都没测到。 */
  assert.notEqual(
    fingerprintOf({ tools: TOOLS, messages: a }),
    fingerprintOf({ tools: TOOLS, messages: b }),
    '不排除 prompt 却算出相同指纹 → 这条回归网是空转的，需要换个造数方式',
  )
})

test('9 条消息（切片已不含 prompt）：排除与不排除结果相同', () => {
  const eight = Array.from({ length: 8 }, (_, i) => msg('m' + i))
  const a = [...eight, promptMsg()]
  const b = [...eight, promptMsg()]
  assert.equal(a.length, 9)
  assert.equal(
    fingerprintOf({ tools: TOOLS, messages: a }),
    fingerprintOf({ tools: TOOLS, messages: b }),
    '消息多于 8 条时末尾 prompt 本来就在切片之外，不该有差异',
  )
})

test('工具面变化必须改变指纹（排除末条不许把整个指纹弄成常量）', () => {
  const base = [msg('hi')]
  const p1 = fingerprintOf({ tools: [{ name: 'a' }], messages: base })
  const p2 = fingerprintOf({ tools: [{ name: 'b' }], messages: base })
  assert.notEqual(p1, p2)
  const m1 = fingerprintOf({ tools: TOOLS, messages: [msg('x')] })
  const m2 = fingerprintOf({ tools: TOOLS, messages: [msg('y')] })
  assert.notEqual(m1, m2)
})
