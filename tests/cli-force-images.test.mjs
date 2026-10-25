import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

/**
 * `--force` 必须穿透图片安全阀：`cli/keepalive.mjs` 的 `refuseImages` 不能写死 `true`。
 *
 * 为什么：图片块读不到字节时默认拒绝是对的（那条之后的前缀永远命中不了，白烧钱还污染缓存），
 * 但 `--force` 的语义就是「用户已明确要求，别再拦」—— 与门禁那条一致。
 * 实测踩过：诊断 `session-1f64b53f` 时被这条挡下，只能复制 27 MB 附件库绕过。
 */
const SRC = readFileSync(new URL("../cli/keepalive.mjs", import.meta.url), "utf8")

test("cli 的 refuseImages 必须随 --force 变化（不能写死 true）", () => {
  /** 取 sendWarmInner 里 warmOffline( 调用的参数块 */
  const at = SRC.indexOf("const out = await warmOffline({")
  assert.ok(at > 0, "找不到 warmOffline 调用")
  const block = SRC.slice(at, at + 800)
  const line = block.split("\n").find((l) => l.includes("refuseImages"))
  assert.ok(line !== undefined, "warmOffline 调用里必须有 refuseImages")
  assert.ok(/--force/u.test(line), "refuseImages 必须引用 --force，实际：" + line.trim())
  assert.ok(!/refuseImages:\s*true\s*,/u.test(line), "不许写死 true（那样 --force 无效）")
})

test("--help 的 --force 文案要写明会跳过图片安全阀", () => {
  assert.ok(/--force\s+.*跳过.*图片|跳过.*图片.*--force|--force.*图片安全阀/u.test(SRC),
    "help 里要说明 --force 也会跳过图片检查")
})
