# CHANGELOG
















> ⚠️ 2026-10-25 13:28 目录清空事故导致冷层正文不可恢复：原声明 **269 条**，其中 **217 条**的条目头与**全部 269 条**的原始正文已丢失；现重建出 **63 条**（52 条可证条目头 + 9 条 2026-10-26 真实提交 + 2 条汇总级），详见 changelog/2026-10.md 顶部说明
> ⚠️ 2026-10-26 仓库 git 历史重建（旧 `.git` 对象损坏），此前条目里的 commit 锚（`· <hash>`）已无法 `cat-file` 命中，属历史断档，不是记录错误。

> 归档：`changelog/2026-10.md`（75 条）

## 2026-10-26 06:33 — 改价后详情重拉 + --log-file + lnk 指向 bat · 04073e3

验证：`node scripts/test-run.mjs`
## 2026-10-26 06:02 — 补回 5 个丢失文件 + 启动器三档规范化 · e036c68

验证：`node scripts/test-run.mjs`
详见 changelog/2026-10.md 同名条目
## 2026-10-26 03:44 — canFallback 放宽 + cli --force 穿透图片检查 · 9b9c916

验证：`node --test tests/cli-force-images.test.mjs`
详见 changelog/2026-10.md 同名条目
## 2026-10-26 02:03 — 补回 defer_loading + store 加 recovering · 25988f4

验证：`node --test tests/defer-loading.test.mjs tests/trip-large-prompt.test.mjs`
详见 changelog/2026-10.md 同名条目
## 2026-10-26 01:03 — 修宿主 /state 500「row is not defined」 · c2a8288

验证：`node --test tests/host-snapshot-smoke.test.mjs`
详见 changelog/2026-10.md 同名条目
## 2026-10-26 00:42 — anthropic 分支 stream:true + body 形状回归 · 2cb9094

验证：`node --test tests/wire-parity.test.mjs tests/wire-responses.test.mjs`
详见 changelog/2026-10.md 同名条目
## 2026-10-26 00:14 — 补回三协议/子代理/互斥/指纹一批功能 · b0839f8

验证：`node --test tests/wire-parity.test.mjs tests/subagent-auto.test.mjs`
详见 changelog/2026-10.md 同名条目
## 2026-10-25 22:37 — 移除恢复残留 ~RF*.TMP（两批） · e611126

验证：`git ls-files | Select-String -Pattern '~RF.*\.TMP$'`（同批第二批 e3fd64f 22:38）
详见 changelog/2026-10.md 同名条目
## 2026-10-25 22:37 — 插件源码全量重建（10-25 基线） · 955b7d7

验证：`node scripts/test-run.mjs`
详见 changelog/2026-10.md 同名条目
## 2026-10-25 13:08 — 尾部读合并自适应 测试守卫改skip · 6b1095a

验证：`node --test tests/session-model-tail.test.mjs`
## 2026-10-25 13:08 — 超预算按现价折算 门禁长档状态词 · 3077697

验证：`node --test tests/gate-budget-current-price.test.mjs` `node --test tests/gate-long-word.test.mjs`
## 2026-10-25 09:11 — 尾部守线测试改 min-of-3 抗负载 · 94678e9

验证：`node --test tests/session-model-tail.test.mjs`
## 2026-10-25 09:00 — 详情页一次请求只解压一次日志 · 0432fc1

验证：`node --test tests/session-model-tail.test.mjs`
## 2026-10-25 08:37 — 插件侧缓存键补价格指纹 尾部守线补测试 · 78e925d

验证：`node --test tests/timeline-warm-price.test.mjs` `node --test tests/session-model-tail.test.mjs`
## 2026-10-25 08:16 — 面板启动 15.6s→0.9s 尾部改读 assistant source · bef4920

验证：`node --test tests/session-model-tail.test.mjs`
## 2026-10-25 08:16 — 改价后展示花费全按现价 判定仍用账本 · bef4920

验证：`node --test tests/timeline-warm-price.test.mjs`
## 2026-10-25 04:25 — 间隔门槛 per-model 同源 + 子代理总开关 + 改价重算

验证：`node --test tests/per-model-price.test.mjs`
## 2026-10-25 04:23 — 改价后详情立即重拉 + 详情标题与列表同源

验证：`node --test tests/panel-model-rows.test.mjs`
## 2026-10-25 03:53 — 门槛后缀不限斜杠 + 记账传 provider + 改价清缓存 + 间隔列

验证：`node --test tests/per-model-price.test.mjs`
## 2026-10-25 00:05 — 子代理标题从投影缓存读并清洗 官方标题无用时才覆盖 端点插件宿主与 CLI 双端可达

验证：`node --test tests/subagent-title.test.mjs` `node --test tests/panel-model-rows.test.mjs`
## 2026-10-24 23:43 — 同会话保温跨进程互斥 inflight 标记，手动点击与守护循环不再双保

验证：`node --test tests/warm-inflight.test.mjs`
## 2026-10-24 23:40 — 价表门槛写明单位（闲置小时/间隔秒）+ 打开即密集刷新

验证：`node --test tests/panel-model-rows.test.mjs`
保温按钮 tooltip 按两条路径分开措辞，去掉「秒级」承诺
## 2026-10-24 23:38 — priceForModel 认 provider/model 键 + 间隔下限

验证：`node --test tests/per-model-price.test.mjs`
## 2026-10-24 18:40 — 子代理保温：独立名额 autoCountSubagent 父在保温才纳入

验证：`node --test tests/subagent-auto.test.mjs` `node --test tests/chrome-checks.test.mjs` `node --test tests/tick-subagent-filter.test.mjs`
## 2026-10-24 18:31 — 保温请求支持 OpenAI Responses 三协议 按 api 字段判定

验证：`node --test tests/wire-responses.test.mjs`
## 2026-10-24 18:31 — 面板四事：详情页命中/未命中+悬浮输出 子代理条数 门禁长档 保存反馈

验证：`node --test tests/panel-model-rows.test.mjs`
子代理 reason 补文案和筛选项，F15 允许换行
## 2026-10-24 18:26 — 门禁文案长闲置二档（>9999 分钟）全档可编辑 新增码自动出现

验证：`node --test tests/gate-texts-long.test.mjs`