# 真跑第一枪（`--lab live --yes --arm`）

面向 agent / 操作者。**这一步会真的花钱**（每会话一次保温请求）。全程零外部依赖、不碰用户 `state.json`。

## 0. 红线（违反任一条就停手）

1. **`DSH_HOME` 必须指向影子 home**（`<repo>/.tmp/lab/<runId>/home`）。指向 `~/.dsh` → G0 直接 exit 3。
2. **白名单必须非空**（`labSessionAllow`），空 = 拒绝一切。
3. **`labBudgetPerRun` 必须设小**（首枪建议 `0.2`）。护栏按「已花 + 本次最坏花费」预扣，超了就拒。
4. **API key 只在进程内存**：执行器从 `--config-from` 的 `.credentials.yaml` 读入 `process.env.DEEPSEEK_API_KEY`，
   **不落盘、不写 JSONL、不进日志**。别把 key 贴到命令行或 README。
5. 影子 home 的 `sessions` 是 **junction 指真实目录（活的）** —— 用户正在聊的会话前缀每轮在漂。
   **首枪只对「固定前缀的历史会话」跑**（没在跑回合、最近没被写过的）。

## 1. 选样本（三条硬条件，缺一条就白跑）

`--lab live` 现在会**逐条体检**并给出「可跑 N / 不可跑 M」，但样本仍要你自己挑。硬条件：

| 条件 | 不合格的后果 | 怎么查 |
|---|---|---|
| **日志 mtime 在 `idleLimitHours` 内**（默认 8h） | `⛔ prepare: cold-window-idle` —— 沙箱账本为空 = 视为「从没保过」，闲置超门槛就直接拒 | 体检行的 `闲置 x.xh / 门槛 8.0h` |
| **装配出的 provider 以 `deepseek` 开头** | `⛔ prepare: provider` —— 第三方 provider（如 `dots/*`、`tokenrhythm181-title/*`）走不同的 key/端点 | 体检行的 `provider/model` |
| **是历史会话**（不在跑回合） | 前缀每轮在漂，命中率无意义 | `node cli/keepalive.mjs --status` 看 `running` |

另外：**账本末条 `promptTokens` 优先 20k–50k**（一次最坏约 0.05 元，0.2 元预算够跑几次）。
没有账本记录时护栏按 **50k 地板**估最坏花费。

### 真实反例（2026-10-19 首轮，全部零花费失败）

| 样本 | arm 时结果 | 真因 | 现在 dry-run 会怎么说 |
|---|---|---|---|
| `40b4321bcd9a` | `⛔ prepare: cold-window-idle` | 日志 mtime **11.6h 前** > 8h 门槛，沙箱账本空 | `⛔ … 闲置 11.6h > 门槛 8.0h → 会判 cold-window-idle` |
| `6eddd2400b27` | `⛔ prepare: provider` | 装配出 `dots/dots3-note-prev`（第三方） | `⛔ … 第三方 provider（dots/dots3-note-prev）` |
| `ef7868df99f5` | ✅ 成功（命中 97.87%，0.000336 元） | 8 分钟前活跃 + `deepseek-official/deepseek-flash` | `✅ … 可跑` |

**记住**：`可跑 0 条` 时 `--yes` 会直接拒绝（exit 3）；`可跑 ≥ 1` 时 `--arm` **只跑可跑的那几条**，不会因一条坏样本全停。

## 2. 准备影子 home（不建也行 —— `--yes` 会真建）

```bash
# 设 DSH_HOME 到影子 home 的 home 子目录（runId 默认按日期，可用 --run-id= 固定）
set DSH_HOME=<repo>\.tmp\lab\run-2026-10-19\home      # Windows cmd
$env:DSH_HOME = "<repo>\.tmp\lab\run-2026-10-19\home" # PowerShell
```

`--lab live --yes` 会按顺序做：**G0 字面断言 → 真建影子 home → G0 realpath 复核 → precheck →（arm）执行**。
建出来的沙箱：`sessions`/`attachments` junction 指真实 home；`state.json` 全新；**不写 `runtime.json`**；
并把试验四键（labMode / 白名单 / 预算 / 起点 / 到期）从配置来源灌进去。

## 3. 配置（写在一个**只读**的配置 home 里，或直接写 `~/.dsh` 的 state —— 不推荐）

推荐：把配置放进一个临时 home，用 `--config-from` 指过去（只读，账本/策略不会复制）：

```bash
# <cfgHome>/cache-keepalive/state.json 里：
#   settings.labMode = true
#   settings.labSessionAllow = ["<样本 id>"]
#   settings.labBudgetPerRun = 0.2
#   settings.labExpiresAt = <now + 2h>（0 = 不过期；建议设，到期自愈会兜底）
```

`.credentials.yaml` 也要在同一个 home 下（`loadApiKey(configFrom)` 读它）。

## 4. 先 dry-run（零请求，必做）

```bash
node cli/keepalive.mjs --lab live --config-from=<cfgHome>
```

检查三行：`白名单 n 条`、`预算 … 剩余 …`、`--yes 预检：全部通过`。有 `⚠️ 已到期` 就先修配置。

## 5. 执行（**真花钱**）

```bash
node cli/keepalive.mjs --lab live --yes --arm --config-from=<cfgHome>
```

输出会给出：影子 home 路径、隔离边界说明、逐会话「prompt≈ / 预留 / 已花 / 放得下?」、执行结果与 JSONL 路径。
JSONL：`.tmp/lab/<runId>/runs/<时间戳>.jsonl`，逐行事件：
`run-start` → `pending`（含 worst）→ `update{done|failed, unknownCost, chargedWorst}`；异常时 `abort`（G7）。

中止条件：连续 **2 次** config 类失败（缺 key / 模型下线 / 400）→ G7 中止，退出码 1。

## 6. 回滚

```bash
node cli/keepalive.mjs --lab verify        # 只读；有残留 exit 1，逐条列出
```

- 沙箱残留：手工删 `<repo>\.tmp\lab\<runId>`（**不要** `rm -rf` 到 junction 目标 —— 先确认路径）。
- 配置 home 里的 `labMode`：到期自愈（插件 tick / CLI 循环）会自动退出并还原；也可 `cache_lab action=set-settings` 关掉。
- **用户 `~/.dsh/cache-keepalive/state.json` 全程不应被写**（只有配置 home 里的文件被读）。

## 7. 出问题先看哪里

| 现象 | 先查 |
|---|---|
| `exit 3` + `G0 路径断言失败` | `DSH_HOME` 没指影子 home，或指到了 `~/.dsh` |
| `exit 3` + `labSessionAllow 为空` | 配置 home 的白名单没写 / `--config-from` 指错 |
| `exit 3` + `本轮已花 … 触顶 …` | `labStartedAt` 太旧把历史花费算进本轮；重开试验模式 |
| `exit 3` + `找不到 API Key` | `--config-from` 的 home 下没有 `.credentials.yaml`，或没设 `DEEPSEEK_API_KEY` |
| 全部 `⛔ 护栏: reserve` | 单次最坏 > 预算：换更小的会话，或把 `labBudgetPerRun` 调高 |
| `unknown-cost` 行很多 | 提供方没回 usage；这些按 worst 计入本轮花费，属预期 |
