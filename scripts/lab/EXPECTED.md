# 虚拟环境已知红（`node cli/keepalive.mjs --lab run`）

**当前状态：无已知红。** `--lab run` 115 例全绿、`knownRed 0`、退出码 0 —— 这张网现在是真门：
任何红都是**未知红**，必须当场查，不许往这个文件里搬。

口径：`knownRed > 0` 不阻断退出码（历史机制，保留）；`unknownRed > 0` → 退出 1。
新增红若确认为「暂时不修的真实缺陷」，才登记到本文件并在 `invariants.ts` 的 `KNOWN_RED` 里加 case id。

复现：`node cli/keepalive.mjs --lab run --only=<不变量id> --json`。

## 三条历史已知红的收口方式（P1c，2026-10-19）

| 原已知红 | 收口方式 |
|---|---|
| `V13/unsat-interval-over-limit`（间隔 > 上限 → 保过一次就锁死） | **治本**：P1b 在 `applySettingsPatch` 末尾加 `idleLimitHours*3600 > intervalSeconds` 关系校验（按合并后值判、整批拒绝、一个字段都不写）。V13 用例改成「非法配置必须被拒（成对 + 单字段两种）」 |
| `V9/reasons-too-idle`（`too-idle` 是死码） | **删码**：`src/auto.ts` 删掉 `too-idle` 判定与 `CandidateReason` 值（它与门禁 `cold-window-idle`/`stale` 同判据同基准，`gateOk` 在前必然截走）；`src/panel.ts` 删 `CAND_WHY` 对应文案；V9 理由全集 9 → 8 |
| `V15/fake-knob-cacheTtl`（`cacheTtlSeconds` 假旋钮） | **标注不删**：面板「缓存到期」输入框加灰字「仅画到期线，不参与保温判定」；V15 改判「只要它不影响判定，面板必须有这句标注」（源码 grep 断言） |

## 变异可杀（防「假绿」记录）

| 变异 | 期望 | 实测 |
|---|---|---|
| 把 `gate.ts` 三条终局判据（budget / max-touches / max-touches-total）挪回 `too-soon` 之后 | `V3` 3/3 红、整体退出 1 | 见 P1c 回报：`V3` 0/3（实际全返回 `too-soon`）、`--lab run` exit 1 |

还原后：115 例 / 115 过 / 0 红。

## 本层不覆盖（交给真实环境，别在这里补）

1. 保温请求本身（`planReplay` / 前缀指纹 / 离线装配 / `warmOffline`）—— 需要真实日志与凭据。
2. 面板前端文案函数（`PANEL_HTML` 模板字符串内的 `gateHead` / `gateNoteOf` / `CAND_WHY`）—— 不可 import。
   （V15 的标注断言只做「源码里存在这句话」，渲染效果仍需浏览器验。）
3. 进程间锁与并发写（已有 `tests/store-lock.test.mjs`）。
4. 真实会话日志解析与时间轴（`src/core/sessions.ts` / `panel-service.timeline()`）—— 需要真实目录。
