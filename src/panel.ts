/**
 * 管理面板（自包含 HTML，无外部依赖、无构建链）。
 *
 * 为什么不做成 client 插件：client 半区需要 tsdown 打包成 bundle，
 * 本机只有 DSH 运行时包、没有源码 checkout。host 路由 + 自包含页面零构建、同源可直接 fetch。
 *
 * 两条硬约束：
 *  ① 配色**显式定义**（跟随系统主题）—— 只靠 `color-scheme` 会在浅色主题下「白底白字看不见」。
 *  ② 前端 JS 一律字符串拼接、**不用模板字符串** —— 外层这段 HTML 本身就是模板字符串，
 *     内部再出现 `${` 会被提前求值，直接语法崩。
 *
 * 视觉约定：**每个旋钮一个色系**，一眼能认出是哪一类参数（间隔=蓝、熔断=红、预算=黄、
 * 次数=紫、输出=青）。灰色留给纯文字。
 */

import { BUILD_ID } from './build-id.ts'

export const PANEL_PATH = '/api/cache-keepalive/panel'

/** 面板 HTML（导出时把 __BUILD_ID__ 换成构建号）。 */
const PANEL_SRC = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>缓存保温 · dsh-cache-keepalive</title>
<style>
  :root {
    --bg: #ffffff; --panel: #f7f7f8; --fg: #16181d; --dim: #62666e;
    --line: #d9dbe0; --ok: #0f7a3d; --bad: #c02626; --warn: #a35b00; --accent: #1d4ed8;
    /* 时间轴「整轮合计」专用色（紫）：必须与「单次调用」的 accent（蓝）色相明显不同 */
    --turn: #9333ea;
    /** 底部让位量：桌面版 DSH 的输入卡浮层常驻在 iframe 底部。插件版 130、网页版 0 —— 只改这一处。 */
    --card-reserve: 130px;
    /* 每个旋钮一个色系：一眼分清参数类别 */
    --c-interval: #2563eb;
    --c-circuit:  #dc2626;
    --c-budget:   #ca8a04;
    --c-touch:    #7c3aed;
    --c-out:      #0891b2;
    --c-price:    #059669;
    /* 原生控件（滚动条 / select / input）跟着主题走；深色下画布系统色也变深 */
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16181d; --panel: #1e2127; --fg: #e8eaee; --dim: #9aa0aa;
      --line: #343842; --ok: #4ade80; --bad: #f87171; --warn: #fbbf24; --accent: #60a5fa;
    --turn: #c084fc;
      --c-interval: #60a5fa;
      --c-circuit:  #f87171;
      --c-budget:   #fbbf24;
      --c-touch:    #a78bfa;
      --c-out:      #22d3ee;
      --c-price:    #34d399;
      color-scheme: dark;
      /* 深色主题下同一套门禁色，按对比度提亮（色相不变，仍是一码一色） */
    }
  }
  @media (prefers-color-scheme: dark) {
    .gate-running     { color: #60a5fa; }
    .gate-no-route    { color: #fb923c; }
    .gate-no-agent    { color: #94a3b8; }
.gate-fresh       { color: var(--ok); }
  }
/* 单元格左右内边距 = 「列间距」，由设置里的 cellGap 驱动 */
th, td { padding-left: var(--cellgap, 8px); padding-right: var(--cellgap, 8px); }
/* 可点格：文字挡冒泡 → 只有文字以外的空白才触发 */
td.hit { cursor: pointer; }
td.hit:hover { background: color-mix(in srgb, var(--fg) 14%, transparent); }
td input.note { width: 8em; font-size: 12px; }
/* 候选状态：手动=黄 / 自动策略在保=绿 / 关闭=红 / 未入选=灰 */
.cand-on { color: var(--warn); font-weight: 600; }
.cand-auto { color: var(--ok); font-weight: 600; }
.cand-off { color: var(--bad); }
.cand-stop { color: var(--bad); }
  .candcell, .gatecell, td.ops { text-align: left; }
  td.ops button { vertical-align: top; }
  .candcell select, .candcell span { display: inline-block; vertical-align: top; text-align: left; }
  .candcell select.mode { text-align: left; text-align-last: left; }
  th[data-c="cand"], th[data-c="gate"], th[data-c="gateNote"], th[data-c="ops"] { text-align: left; }
  .tline { display: flex; align-items: baseline; gap: 4px; flex-wrap: wrap; }
  .tline .title { font-weight: 600; }
  .tl-open { cursor: pointer; }
  .tl-open:hover { text-decoration: underline; }
select.mode { font-size: 12px; padding: 0; }
select.mode.cand-on { color: var(--warn); }
select.mode.cand-auto { color: var(--ok); }
select.mode.cand-off { color: var(--bad); }
.toggle { background: var(--panel); color: var(--dim); border: 1px solid var(--line); border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 12px; }
.toggle.on { background: var(--accent); color: var(--bg); border-color: var(--accent); font-weight: 600; }
  @media (prefers-color-scheme: dark) {
    .gate-image       { color: #d97706; }
    .gate-tripped     { color: #f87171; }
    .gate-archived    { color: #94a3b8; }
    .gate-stale       { color: #d4a373; }
    .gate-cold-window { color: #22d3ee; }
  .gate-cold-window-idle { color: #f87171; }
    .gate-too-soon    { color: #facc15; }
    .gate-budget      { color: #f472b6; }
    .gate-max-touches { color: #a78bfa; }
  }
  * { box-sizing: border-box; }
  /* 纵向滚动条始终占位：否则它会随内容高度出现/消失，视口宽度在 1339↔1354 之间跳，
     列宽按视口算 → 内容宽度变 → 高度变 → 滚动条又变，形成自激振荡。 */
  html { scrollbar-gutter: stable; }
  html, body { background: var(--bg); color: var(--fg); }
  body { margin: 0; padding: 12px 14px 30px; font: 13px/1.55 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; max-width: 1640px; margin-inline: auto; }
  .topbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 9px; }
  /**
   * 嵌入模式：client 的「缓存保温」页签用 iframe 嵌本页时会带 ?embed=1。
   * 此时**隐藏页头**（大标题 + 那句「会话空闲时重放…」）—— 外层页签已经有标题了，重复。
   */
  body.v-plugin { --card-reserve: 130px; }
  body.v-cli { --card-reserve: 0px; }
  body.embed .topbar { display: none; }
  /*
   * 详情模式（?embed=1&tl=<id>，宿主覆盖层里的 iframe）：整页只留时间轴。
   * 宿主那边已有标题栏和关闭按钮，所以连 #tl 自己的标题栏一起藏掉 —— 否则会看到两层标题。
   */
  /* 兜底：详情模式下页面底色透明，内容铺不到底时也不会露出深色横条 */
  body.is-detail { background: transparent; }
  body.is-detail .tabs, body.is-detail #page-main { display: none; }
  body.is-detail #tl { position: static; background: transparent; padding: 0; }
  /* 只藏面板自带的 ✕（宿主卡片右上角已经有一个）；标题与元信息要留下 —— 宿主那轮把它的 bar 删了，
     面板再藏就两边都没有标题了。右侧留 40px 给宿主的浮动 ✕ 让位（它 26×26、right:8px）。 */
  /* 只有「宿主覆盖层里的详情页」才藏面板 ✕、才需要给宿主那个浮动 ✕ 让位；
     网页版直开 ?tl=（没有宿主）要保留自己的 ✕。 */
  body.is-detail-embed #tlClose { display: none; }
  body.is-detail-embed #tlTitle, body.is-detail-embed #tlSub { padding-right: 40px; }
  body.is-detail #tl .box { border: 0; padding: 0; max-width: none; }
  /* 底部大留白：内嵌在页签里时，桌面版输入框浮层（composer overlay）会盖住 viewArea
     底部约 170px；不给留白，滚动到底时最后几行（会话列表末尾）会被浮层截断。 */
  body.embed { padding: 8px 10px calc(70px + var(--card-reserve)); }
  /* 详情页没有输入卡浮层，无需底部让位；这条必须放在 body.embed 之后并提高特异性，否则被它覆盖（实测多 56px 滚动） */
  body.embed.is-detail { padding-bottom: 0; }
  h1 { font-size: 17px; margin: 0 0 2px; }
  h2 { font-size: 13px; margin: 0 0 7px; }
  .sub { color: var(--dim); font-size: 12px; max-width: 88ch; }
  .card { border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; margin-bottom: 9px; background: var(--panel); }
  /* 二级页面（tab）。默认全隐，靠 JS 切 .on */
  .tabs { display: flex; gap: 3px; margin-bottom: 9px; border-bottom: 1px solid var(--line); }
  .tab { border: 1px solid var(--line); border-bottom: none; border-radius: 7px 7px 0 0; background: var(--panel); color: var(--dim); padding: 4px 14px; font-size: 13px; margin-bottom: -1px; }
  .tab.on { color: var(--fg); background: var(--bg); font-weight: 600; }
  /* 「使用说明」紧跟「⚙️ 设置」tab，**不留间隙**（用户要求紧贴） */
  .tab.helpbtn { margin-left: 0; }
  .page { display: none; }
  .page.on { display: block; }
  /**
   * 参数排布：**标签 + 输入框 + 单位 全在同一行**（横排、可换行）；
   * 推荐值**不占字段行的位置**，汇总到字段行下方另起一行（.recs）。
   */
  .fields { display: flex; flex-wrap: wrap; gap: 5px 9px; align-items: center; }
  /**
   * 「锁定一行」的参数行：**不换行**，用 space-between 把整行撑满（间距自适应）。
   * 用户要求：「间隔 … 恢复默认」必须是一整行，不要折成两行、不要留大片空隙。
   * 窄屏时给横向滚动兜底，避免挤成一团。
   */
  /* 默认参数卡字段多，一行放不下 —— 换行，绝不出横向滚动条 */
.fields.one-line { flex-wrap: wrap; gap: 6px 10px; }
/* 按钮不许被挤成竖排（"保\u0020存"），也不许被压缩 */
.fields > button, .savebar > button { flex: 0 0 auto; white-space: nowrap; }
  .field { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; white-space: nowrap; }
  .field > .lab { display: inline-flex; align-items: center; gap: 4px; }
  /* 复选框与文字垂直居中：默认是按基线对齐，字看着往下坠 */
  .field label, .savebar label, label.hint { display: inline-flex; align-items: center; gap: 4px; line-height: 1.4; }
  .field input[type=checkbox], .savebar input[type=checkbox], label.hint input[type=checkbox] { margin: 0; flex: 0 0 auto; }
  .recs { font-size: 11px; color: var(--dim); margin-top: 6px; line-height: 1.7; }
  .recs b { color: var(--fg); font-weight: 600; }
  .field .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: 0 0 auto; }
  .f-interval .dot { background: var(--c-interval); }
  .f-circuit  .dot { background: var(--c-circuit); }
  .f-budget   .dot { background: var(--c-budget); }
  .f-touch    .dot { background: var(--c-touch); }
  .f-out      .dot { background: var(--c-out); }
  .f-price    .dot { background: var(--c-price); }
  input[type=number], input[type=text], select, textarea {
    padding: 3px 6px; border: 1px solid var(--line); border-left-width: 3px; border-radius: 5px;
    background: var(--bg); color: var(--fg); font: inherit;
  }
  .f-interval input { border-left-color: var(--c-interval); }
  .f-circuit  input { border-left-color: var(--c-circuit); }
  .f-budget   input { border-left-color: var(--c-budget); }
  .f-touch    input { border-left-color: var(--c-touch); }
  .f-out      input { border-left-color: var(--c-out); }
  .f-price    input { border-left-color: var(--c-price); }
  input[type=number] { width: auto; }
  /* 每页条数只填数字，别吃满一行（全局 number 是 auto，会被 flex 顶宽） */
  #pageSize { width: 64px; }
  input[type=text] { width: 148px; }
  input[type=text].wide { width: 208px; }
  /* 搜索框吃掉整行剩余宽度。.field 是 inline-flex（shrink-to-fit），给它百分比会循环依赖，
     所以用 flex 基准宽 + 上下限：桌面长到 560，窄屏换行后保底 240。 */
  .field.f-q { flex: 1 1 240px; min-width: 240px; max-width: 560px; }
  /* 实例插件版：搜索框收窄到约一半，右侧留给「定位本会话」；CLI 网页版（v-cli）保持弹性 */
  body.v-plugin .field.f-q { flex: 0 1 177px; max-width: 177px; min-width: 0; }
  #q { width: 100%; min-width: 0; }
  .savebar { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
  button { padding: 1px 7px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); color: var(--fg); font: inherit; font-size: 12px; line-height: 1.5; cursor: pointer; }
  button:hover { border-color: currentColor; }
  button.primary { border-color: var(--ok); color: var(--ok); }
  /* 开关按钮：状态由底色承担（不用勾选态）；未开是描边，开了是实色。
     用 .tgl 而不是 button.tgl —— 多选浮层的 <summary> 触发器也要同一套配色。 */
  .tgl { color: var(--dim); }
  .tgl.on { border-color: var(--accent); background: var(--accent); color: var(--bg); font-weight: 600; }
  /* 多选浮层（候选 / 门禁）：触发器 .tgl + 按钮网格面板，选中态只靠底色，不用勾选 */
  .ms { position: relative; display: inline-flex; }
  .ms > summary { padding: 1px 7px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg);
    font-size: 12px; line-height: 1.5; cursor: pointer; list-style: none; }
  .ms > summary::-webkit-details-marker { display: none; }
  .ms-panel { position: absolute; left: 0; top: calc(100% + 3px); z-index: 40; display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px; padding: 4px;
    width: 340px; max-width: calc(100vw - 24px);
    border: 1px solid var(--line); border-radius: 6px; background: var(--panel); box-shadow: 0 4px 14px rgba(0, 0, 0, .18); }
  /* details 关闭时必须真的不渲染：.ms-panel 的 display:grid 会盖掉浏览器默认的隐藏语义 */
  .ms:not([open]) > .ms-panel { display: none; }
  .ms-panel button { width: 100%; text-align: left; padding: 1px 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ms-panel .ms-foot { grid-column: 1 / -1; display: flex; justify-content: flex-end; }
  /* 模式行（筛选/排序）：跨满两列，等分宽度，不留白 */
  .ms-panel .ms-mode { grid-column: 1 / -1; display: flex; gap: 2px; }
  .ms-panel .ms-mode button { flex: 1 1 0; text-align: center; }
  button:disabled { opacity: .4; cursor: default; }
  .split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 340px); gap: 18px; align-items: start; }
  @media (max-width: 1100px) { .split { grid-template-columns: 1fr; } }
  .notes { border-left: 2px solid var(--accent); padding-left: 11px; font-size: 12px; color: var(--dim); }
  .notes b { color: var(--fg); }
  .notes ul { margin: 6px 0 0; padding-left: 16px; }
  .notes li { margin-bottom: 4px; }
  /**
   * 会话列表容器：**不限高、不内滚、不横向滚**（用户要求「取消滚动条、完全展开」），整页一起滚。
   * overflow 一旦出现，表头的 position: sticky 就被困在这个容器里、只在容器内吸顶 ——
   * 用户看到的就是"浮条消失"。所以这里必须保持 visible。
   */
  .tablewrap { border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
.tablewrap table { min-width: 0; width: auto; }
  /* 操作列的按钮不换行（否则「立刻保温」「解除熔断」会被挤成两行，列宽跟着变形） */
  .ops { white-space: nowrap; }
  td { overflow: hidden; }
  .nw { white-space: nowrap; }
  /* 列宽可拖：表头右缘的细手柄 */
  th { position: relative; }
  /* 可点区 9px = 判定区宽度；1px 细线画在正中 */
  th .rz { position: absolute; right: 0; top: 0; bottom: 0; width: 9px; cursor: col-resize; background: transparent; }
  th .rz::after { content: ''; position: absolute; left: 50%; top: 0; bottom: 0; width: 1px;
    transform: translateX(-50%); background: color-mix(in srgb, var(--fg) 16%, transparent); }
  th .rz:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  th .rz:hover::after { width: 2px; background: var(--accent); }
  .resizing, .resizing * { cursor: col-resize !important; user-select: none !important; }
  table { table-layout: fixed; }
  /* 门禁文案设置：一行一条 */
  .gt-row { display: flex; align-items: center; gap: 4px; min-width: 0; margin-bottom: 2px; }
  .gt-row input { font-size: 12px; padding: 1px 4px; min-width: 0; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 4px; }
  .gt-row input.w { flex: 0 0 auto; width: var(--gatewordw, 170px); }
  /* 两栏之间的分隔线：拖它调状态词框宽度 */
  .gt-split { position: relative; flex: 0 0 auto; width: 7px; align-self: stretch; cursor: col-resize; background: transparent; }
  .gt-split::after { content: ''; position: absolute; left: 50%; top: 0; bottom: 0; width: 1px;
    transform: translateX(-50%); background: color-mix(in srgb, var(--fg) 16%, transparent); }
  .gt-split:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .gt-split:hover::after { width: 2px; background: var(--accent); }
  .gt-row input.d { flex: 1 1 0; min-width: 160px; }
  /* flex: 0 0 auto —— 不加会被 flex 收缩压成 0 宽，按钮直接看不见 */
  .gt-row .mini { flex: 0 0 auto; padding: 0 4px; font-size: 11px; line-height: 1.6; }
  .gt-builtin { color: var(--dim); font-size: 12px; padding: 1px 0 4px 2px; }
  /* 候选文案：行首显示 key（门禁文案没有这一列，那边是双输入框） */
  .gt-key { color: var(--dim); font-size: 11px; flex: 0 0 auto; min-width: 104px; font-family: ui-monospace, monospace; }
  /* 门禁格内两栏：左状态词、右说明并排（说明不再独占下一行，行高降一半） */
  .g2 { display: flex; gap: 6px; align-items: baseline; min-width: 0; }
  .g2 .gw { white-space: nowrap; }
  .g2 .gn { color: var(--dim); min-width: 0; }
  /* 操作列按钮紧凑化：tripped 行会多出第 4 个按钮，必须在 minOf(ops) 内全部可见 */
  .ops button { padding: 1px 3px; margin: 1px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  /* 左内边距 0：内容紧贴列边界（上一列的拖动线），右侧留 cellgap 以免两列粘连 */
  th, td { text-align: left; padding: 2px var(--cellgap, 8px) 2px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
/* 数值列右对齐，一眼能比大小 */
td.num, th.num { text-align: right; }
  /* 表头吸顶：滚到顶时钉在页面最上方（前提是 .tablewrap 不再 overflow） */
  th { font-weight: 600; color: var(--dim); white-space: nowrap; position: sticky; top: 0; background: var(--bg); z-index: 3; box-shadow: 0 1px 0 var(--line); padding-left: 1px; }
  tr:hover td { background: color-mix(in srgb, var(--fg) 7%, transparent); }
  td.num { text-align: left; font-variant-numeric: tabular-nums; }
  #tl .it .amt { text-align: right; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size: 11px; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); font-size: 11px; white-space: nowrap; }
  .pill.on { border-color: var(--ok); color: var(--ok); }
  .pill.off { border-color: var(--dim); color: var(--dim); }
  .pill.auto { border-color: var(--accent); color: var(--accent); }
  /* 整轮合计的标签走 --turn（紫），与单次调用的 accent（蓝）拉开色相 */
  .pill.turnaggpill { border-color: var(--turn); color: var(--turn); font-weight: 700; }
  .pill.hot { border-color: var(--bad); color: var(--bad); }
  .pill.arch { border-color: var(--warn); color: var(--warn); }
  /* 「当前」标记：client 页签会把当前会话 id 放进 ?current=，命中的那一行打这个标 */
  .pill.cur { border-color: var(--accent); color: var(--accent); font-weight: 700; }
  /* 本插件自己的置顶（与 DSH workspace 的置顶无关） */
  .pill.pin { border-color: var(--c-budget); color: var(--c-budget); font-weight: 700; }
  /* 「定位本会话」：滚到那一行后闪几下，眼睛才抓得住 */
  @keyframes ckflash { 0%, 100% { background: transparent; } 50% { background: rgba(29, 78, 216, .22); } }
  tr.flash td { animation: ckflash .7s ease-in-out 3; }
  .ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--warn); } .dim { color: var(--dim); }
  /**
   * 门禁拦截码：**加粗** + 每码一个独立符号 + 一个独立颜色。
   * 十个情形**色相两两不同**，一眼分得开：通过=绿、在跑=蓝、没路由=橙、找不到=灰、
   * 熔断=红、断档=褐、凉了=青、没到点=黄、钱花完=洋红、次数用完=紫。
   */
  .gate { font-weight: 700; white-space: nowrap; }
  .gate-pass        { color: var(--ok); }
.gate-fresh       { color: var(--ok); }
  .gate-running     { color: #2563eb; }
  .gate-no-route    { color: #c2410c; }
  .gate-no-agent    { color: #64748b; }
.gate-image       { color: #f59e0b; }
  .gate-tripped     { color: #dc2626; }
  .gate-archived    { color: #64748b; }
  .gate-stale       { color: #92400e; }
  .gate-cold-window { color: #0891b2; }
  .gate-cold-window-idle { color: #dc2626; }
  .gate-too-soon    { color: #ca8a04; }
  .gate-budget      { color: #db2777; }
  .gate-max-touches { color: #7c3aed; }
  .gate-max-touches-total { color: #b91c1c; }
  .gate-prefix-changed { color: #a855f7; }
  /* 「不在本进程」的小圆点：只是提示，不改变门禁码本身的颜色 */
  .off-dot { margin-left: 3px; font-size: 10px; color: var(--dim); cursor: help; }
  .sel { padding: 3px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; }
  /* 弹层：盖住面板内一切（含吸顶表头），但盖不住 DSH 宿主自己的对话框 —— iframe 内 z-index 出不去 */
#help, #holidayBox, #tl { z-index: 60; }
  /* 弹层滚到边界不许把滚动传给背后的页面 */
  #tl, #help, #holidayBox { overscroll-behavior: contain; }
  #tl .box, #help .box, #holidayBox .box { overscroll-behavior: contain; }
#holidayBox { display: none; position: fixed; inset: 0; background: rgba(0, 0, 0, .55); overflow: auto; padding: 24px 12px; }
#holidayBox .box.narrow { max-width: 620px; }
#holidayBox.show { display: block; }
#toast { position: fixed; right: 18px; bottom: calc(18px + var(--card-reserve)); padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--fg); display: none; font-size: 12px; max-width: 46ch; z-index: 60; }
  .hint { font-size: 11px; color: var(--dim); }
/**
 * class="hint bad" 必须显示红色：.bad 定义在 .hint 之前，.hint 的 color 会把红色盖掉
 * （实测单用 .bad = rgb(192,38,38)，.hint.bad = rgb(98,102,110) 灰）。这里显式提高组合优先级。
 */
.hint.bad { color: var(--bad); }
  /**
   * 「会话列表」用 <details> 默认折叠 —— 内容几百行，页签里滚起来太重。
   * 折叠后的标题行沿用 h2 的字号/字重，视觉上与其它卡的标题一致。
   */
  summary.cardSummary { cursor: pointer; font-size: 13px; font-weight: 600; margin-bottom: 0; }
  details.card[open] > summary.cardSummary { margin-bottom: 8px; }
  summary.cardSummary::marker { color: var(--dim); }
  .title { max-width: 230px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  details.lead { margin-top: 10px; font-size: 12px; }
  details.lead summary { cursor: pointer; color: var(--dim); }
  /* 使用说明弹层 */
  /**
   * 遮罩铺满视口（插件版/网页版都 inset:0）：覆盖层渲染在宿主文档里，不再需要给输入卡浮层让位。
   * 用 inset 收缩可视区（不是给内容加 padding）—— 这样「滚到底」时内容真的贴在可见底边，
   * 而不是像旧版那样在 embed 里额外塞一大段 padding —— 那样滚到底会留一大片空白。
   */
  #help { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: none; z-index: 50; overflow: auto; padding: 24px; }
  #help .box { max-width: 860px; margin: 0 auto; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 12px; padding: 20px 24px; }
  #help h3 { font-size: 15px; margin: 18px 0 6px; }
  #help h3:first-of-type { margin-top: 6px; }
  #help p, #help li { font-size: 12.5px; }
  #help code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; background: var(--panel); padding: 1px 4px; border-radius: 4px; }
  #help table { font-size: 12px; margin: 6px 0; }
  /**
   * 弹层里的表格**必须**取消 sticky 表头。
   * 全局的 th { position: sticky } 是给会话列表用的；弹层里继承到它会变成
   * 「表头悬浮在内容上面」——用户看到的就是"表格是浮着的"。
   */
  #help th { position: static; }
  #help .box, #tl .box, #holidayBox .box { position: relative; }
#help .close, #tl .close, #holidayBox .close { position: absolute; right: 14px; top: 12px; margin: 0; }
  /* 使用说明很长：关闭按钮必须跟着视口走（sticky），否则滚到下面就没法关 */
  #help .close { position: sticky; top: 0; right: auto; float: right; margin: 0 0 0 10px; z-index: 1; }
  /* 时间轴弹层：每轮真实计费 + 保温，按时间合并 */
  /* 时间轴弹层同样铺满视口（与 #help 一致） */
  #tl { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: none; z-index: 55; overflow: auto; padding: 24px; }
  #tl .box { max-width: 1020px; margin: 0 auto; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 12px; padding: 18px 22px; }
  
  #tl .sum { display: flex; flex-wrap: wrap; gap: 10px; margin: 10px 0 14px; font-size: 12px; }
  #tl .sum .s1 { color: var(--c-interval); }
  #tl .sum .s2 { color: var(--c-budget); }
  #tl .sum .s3 { color: var(--c-price); }
  #tl .sum .s4 { color: var(--c-out); }
  /* 第一行数字跟格子主色；第二行（.dim 里）的数字红 */
  #tl .sum b { color: inherit; }
  #tl .sum .dim b { color: var(--bad); }
  /* 副标题也跟着主色（不用灰），只靠透明度分主次 */
  #tl .sum .dim { color: inherit; opacity: .82; }
  #tl .sum div { border: 1px solid var(--line); border-radius: 8px; padding: 6px 11px; }
  #tl .sum b { font-size: 13px; }
  /* 遮罩现在铺满视口（覆盖层交给宿主），轴体不再让位 —— 再减 130px 就会平白少显示一段 */
  #tl .axis { max-height: 62vh; overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
  /* 第 2 列给「剪枝 1 个事件（1838 tok）」这类长标签留出可换行空间：
     固定 70px + .pill nowrap 会让标签溢出到第 3 列、与右侧说明文字叠印。 */
  #tl .it { display: grid; grid-template-columns: 92px minmax(70px, 150px) minmax(0, 1fr) 138px; gap: 9px; padding: 5px 9px; border-bottom: 1px solid var(--line); font-size: 12px; align-items: center; }
  #tl .it > span { min-width: 0; }
  #tl .it .pill { white-space: normal; overflow-wrap: anywhere; max-width: 100%; }
  #tl .it:last-child { border-bottom: none; }
  #tl .it.warm { background: rgba(220, 38, 38, .07); }
  /* 整轮合计：不是另一种"档"，是同一条时间轴上的聚合行 —— 用左边框 + 加粗区分，不改色系 */
  #tl .it.turnagg { border-left: 3px solid var(--turn); background: color-mix(in srgb, var(--turn) 8%, transparent); font-weight: 600; }
  /* 压缩 / 改写(goal)：计算轮次，不是用户对话 —— 单独底色，避免被读成"压缩轮" */
  #tl .it.mark { background: color-mix(in srgb, var(--warn) 10%, transparent); }
  #tl .it.mk-goal { background: color-mix(in srgb, var(--accent) 10%, transparent); }
  #tl .it .t { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--dim); }
  #tl .it .bar { height: 10px; border-radius: 3px; background: var(--line); overflow: hidden; display: flex; }
  #tl .it .bar i { display: block; height: 100%; }
  #tl .it .bar i.h { background: var(--ok); }
  #tl .it .bar i.m { background: var(--bad); }
  #tl .it .amt { text-align: right; font-variant-numeric: tabular-nums; font-size: 11px; }
  .clickable { cursor: pointer; }
  .clickable:hover { text-decoration: underline; }
  /* 手填态：下拉隐藏、手填框出现（只切行类，不改 DOM 结构） */
  .mrow.manual .m-provider, .mrow.manual .m-model { display: none; }
  .mrow:not(.manual) .mname-text { display: none; }
</style>
</head>
<body>

<div class="topbar">
  <div>
    <h1>缓存保温</h1>
    <div class="sub">会话空闲时重放它的完整前缀（system + tools + messages），让提供方前缀缓存持续被读到。
    冷启动按 <span id="wrRatio">50</span> 倍价重算，保温只付命中价。</div>
  </div>
</div>

<div class="tabs">
  <button class="tab on" id="tab-main" onclick="switchTab('main')">保温</button>
  <button class="tab" id="tab-settings" onclick="switchTab('settings')">⚙️ 设置</button>
  <button class="tab helpbtn" id="helpBtn" title="教程 / 机制 / 省钱知识">📖 使用说明</button>
  <button class="tab" id="openWeb" title="在浏览器里打开这块面板（桌面版会用系统默认浏览器）">🌐 网页版打开</button>
</div>

<div class="page on" id="page-main">

<div class="hint bad" id="loopWarn" style="display:none;margin-bottom:6px"></div>

<div class="card" id="currentCard" style="display:none">
  <h2>当前对话 <span class="hint" id="curTitle"></span></h2>
  <div class="fields" id="curState"></div>
  <div class="savebar" id="curOps"></div>
</div>

<div class="card">
  <h2>自动候选</h2>
  <div class="fields">
    <button class="toggle" id="autoEnabled" onclick="flipTgl(this)" title="开启后按「保 N 条」自动挑候选并保温">启用自动策略</button>
    <div class="field f-touch"><i class="dot"></i><label>保</label><input type="number" id="autoCount" min="0" step="1" style="width:58px"><label>条</label></div>
    <div class="field f-interval"><i class="dot"></i><label>闲置上限</label><input type="number" id="idleLimitHours" min="0.5" step="0.5" style="width:64px"><label>小时（门禁与自动共用，须大于间隔）</label></div>
    <button class="toggle" id="autoAllowSubagent" onclick="flipTgl(this)" title="子代理会话也纳入自动候选">子代理也算</button>
    <button class="primary" id="saveAuto">保存自动策略</button>
    <button id="resetAuto" title="把本卡字段填回推荐值并保存">恢复默认</button>
  </div>
</div>

<div class="card">
  <h2>默认参数</h2>
  <div class="fields one-line">
    <div class="field f-interval"><i class="dot"></i><label>间隔</label><input type="number" id="intervalSeconds" min="60" step="60" style="width:82px"><label>秒</label></div>
    <div class="field f-interval"><i class="dot"></i><label>刚保过提示</label><input type="number" id="freshSeconds" min="0" step="1" style="width:64px" title="这么短时间内不重复保；试验模式会压到 5 秒"><label>秒</label></div>
    <div class="field f-circuit"><i class="dot"></i><label>熔断冷却</label><input type="number" id="circuitCooldownSeconds" min="0" step="10" style="width:64px"><label>秒</label></div>
    <div class="field f-circuit"><i class="dot"></i><label>熔断线</label>
      <select class="sel" id="circuitHitRate" title="命中率低于它就算「塌了」：连续两次低命中，或单次低命中且没新建缓存 → 熔断">
        <option value="0.3">30 很宽松</option>
        <option value="0.4">40 宽松</option>
        <option value="0.5">50 标准</option>
        <option value="0.6">60 偏严</option>
        <option value="0.7">70 严格</option>
        <option value="0.8">80 很严</option>
        <option value="0.9">90 极严</option>
        <option value="0.95">95 最严</option>
      </select>
    </div>
    <div class="field f-touch"><i class="dot"></i><label>本周期最多保</label><input type="number" id="maxTouches" min="0" step="1" style="width:58px"><label>次</label></div>
      <div class="field f-touch"><i class="dot"></i><label>累计最多保</label><input type="number" id="maxTouchesTotal" min="0" step="1" style="width:64px" placeholder="0=不限"><label>次</label></div>
    <div class="field f-budget"><i class="dot"></i><label>单会话预算</label><input type="number" id="budgetPerSession" min="0" step="0.1" style="width:72px"><label>元</label></div>
    <div class="field f-out"><i class="dot"></i><label>输出上限</label><input type="number" id="maxTokens" min="1" step="1" style="width:58px"></div>
    <div class="field f-out"><i class="dot"></i><label>详情缓存</label><input type="number" id="timelineCacheMinutes" min="0" step="1" style="width:58px"><label>分钟</label></div>
    <div class="field f-out"><i class="dot"></i><label>保温问题</label><input type="text" class="wide" id="prompt"></div>
    <button class="primary" id="saveDefaults">保存</button>
    <button id="resetDefaults" title="把本卡字段填回推荐值并保存">恢复默认</button>
  </div>
</div>

<div class="card">
  <h2>会话列表 <span class="hint" id="stat"></span></h2>
  <div class="fields" style="margin-bottom:10px">
    <div class="field f-q">
      <span class="lab">搜索</span>
      <input type="text" id="q" placeholder="标题 / ID / 目录 / 备注">
    </div>
    <button id="gotoCur" title="滚到当前会话那一行并高亮">定位本会话</button>
    <div class="field">
      <span class="lab">排序</span>
      <select id="sortBy">
        <option value="mtime">最后查看</option>
        <option value="spend">累计花费</option>
        <option value="hit">命中率</option>
        <option value="title">标题</option>
        <option value="size">体积</option>
      </select>
      <button class="toggle" id="sortRev" data-on="0" title="反转排序方向（置顶的会话仍在最上）">逆序</button>
    </div>
    <div class="field">
      <details class="ms" id="msCand">
        <summary class="tgl" id="msCandSum">候选</summary>
        <div class="ms-panel" id="msCandBox"></div>
      </details>
    </div>
    <div class="field">
      <details class="ms" id="msGate">
        <summary class="tgl" id="msGateSum">门禁</summary>
        <div class="ms-panel" id="msGateBox"></div>
      </details>
    </div>
    <div class="field">
      <span class="lab">每页条数</span>
      <input type="number" id="pageSize" min="10" step="10" value="50">
    </div>
    <div class="field">
      <button class="toggle on" id="hideArchived" data-on="1">隐藏已归档</button>
    </div>
    <div class="field">
      <button class="toggle on" id="hideSubagent" data-on="1">隐藏子代理</button>
    </div>
    <!-- 这四个放同一个 .field：彼此紧贴（内部 gap 4px），刷新紧跟排序开关 -->
    <div class="field">
      <button class="toggle on" id="hideBlank" data-on="1">隐藏空会话</button>
      <button id="refresh">刷新</button>
    </div>
    <div class="field">
      <button class="toggle" id="onlyLive" data-on="0" title="只显示本进程内活着的会话；纯显示筛选，不影响保温范围">只看本进程</button>
    </div>
  </div>
  <div class="hint" style="margin-bottom:6px">
    <span id="lastRefresh"></span>
  </div>
  <div class="tablewrap">
    <table>
      <colgroup id="colgroup"></colgroup>
      <thead><tr id="headRow"></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <div class="savebar">
    <span class="hint" id="pagerInfo"></span>
    <button id="more">加载更多</button>
    <button id="all">全部展开</button>
  </div>
</div>

</div>

<div class="page" id="page-settings">
  <div class="card">
    <h2>价格（元 / 百万 token）</h2>
    <div class="fields">
      <div class="field f-price"><i class="dot"></i><label>命中单价</label><input type="number" id="priceHit" min="0.0001" step="0.01"><label>元/百万</label></div>
      <div class="field f-price"><i class="dot"></i><label>未命中单价</label><input type="number" id="priceMiss" min="0.0001" step="0.1"><label>元/百万</label></div>
      <div class="field f-price"><i class="dot"></i><label>输出单价</label><input type="number" id="priceOut" min="0.0001" step="0.5"><label>元/百万</label></div>
      <button class="primary" id="savePrices">保存价格</button>
      <button id="resetPrices" title="把本卡字段填回推荐值并保存">恢复默认</button>
      <button class="tgl" id="tglTariff" onclick="toggleTariff()" title="峰谷时段倍率是否生效（每个模型还能单独关）">峰谷时段</button>
      <button class="tgl" id="tglHoliday" onclick="toggleHoliday()" title="节假日倍率是否生效（每个模型还能单独关）">节假日</button>
    </div>
    <div class="hint" style="margin-top:7px">
      当前 w/r = <b id="wrBox">—</b>（一次冷启动 = 多少次保温的保费）
    </div>
  </div>

  <div class="card">
    <h2>模型价表（元 / 百万 token）</h2>
    <div class="hint" style="margin-bottom:9px">
      会话日志里每一笔真实调用都带模型名，所以时间轴能<b>按轮次识别模型</b>、分别用对应单价算钱。
      表里查不到的模型回落上面的「基准价」。匹配顺序：精确名 → 最长包含（<code>deepseek-flash-2026</code> 命中 <code>deepseek-flash</code>）。
    </div>
    <datalist id="modelList">
      <option value="deepseek-flash"></option>
      <option value="deepseek-v4-pro"></option>
    </datalist>
    <div id="modelRows"></div>
    <div class="fields" style="margin-top:9px">
      <button id="addModel">＋ 加一个模型</button>
      <button class="primary" id="saveModels">保存模型价表</button>
      <button class="primary" id="saveLimits" title="行右侧「闲置 / 间隔」两列：按模型覆盖通用的时间门槛">保存时间门槛</button>
    </div>
  </div>

  <div class="card">
    <h2>峰谷时段表 / 节假日表</h2>
    <div class="hint" style="margin-bottom:9px">
      基准价对应<b>倍率 1</b>；命中某时段就乘上它的倍率（例：基准填空闲档，高峰时段倍率 2）。
      时段按<b>从上到下</b>先命中先用，跨零点写反（<code>23:00 → 07:00</code>）即可。节假日<b>覆盖</b>时段表，不叠乘。
    </div>
    <div class="fields">
      <div class="field f-out"><i class="dot"></i><label>时区</label><input type="text" class="wide" id="tariffZone" placeholder="Asia/Shanghai"></div>
      <span class="hint">启用开关在「价格」那一行（峰谷时段 / 节假日）</span>
    </div>
    <div id="slotRows" style="margin-top:8px"></div>
    <div class="fields" style="margin-top:6px">
      <button id="addSlot">＋ 加一个时段</button>
    </div>
    <div class="fields" style="margin-top:10px">
      <div class="field f-price"><i class="dot"></i><label>节假日倍率</label><input type="number" id="holidayFactor" min="0.01" step="0.5"></div>
    </div>
    <div class="fields" style="margin-top:8px">
      <button id="openHoliday" title="打开节假日表（一行一天，格式 02-17 春节）">编辑节假日表</button>
      <button class="primary" id="saveTariff">保存时段表</button>
      <button id="resetTariff" title="填回默认（空闲 1 倍 / 高峰 2 倍 + 2026 节假日）">恢复默认</button>
    </div>
    <div class="hint" style="margin-top:6px">节假日表默认隐藏 —— 点上面的「编辑节假日表」打开。</div>
  </div>

  <div class="card">
    <h2>向 Agent 开放的工具</h2>
    <div class="fields">
      <button class="toggle" id="exposeKeepaliveTool" onclick="flipTgl(this)" title="agent 能不能看到并调用 cache_keepalive">开放主工具 cache_keepalive</button>
      <button class="tgl" id="labExpose" onclick="toggleLab('labExpose')" title="agent 能不能看到并调用 cache_lab">开放测验台工具 cache_lab</button>
      <button class="primary" id="saveTools">保存工具开关</button>
      <button id="resetTools" title="恢复为默认（都开放）并保存">恢复默认</button>
    </div>
    <div class="hint" style="margin-top:7px"><span id="toolsState"></span></div>
  </div>

  <div class="card">
    <h2>门禁文案</h2>
    <div class="hint" style="margin-bottom:6px">左格状态词（门禁列里显示的那几个字），右格说明；说明里的 {名字} 会替换成实际数字（鼠标停在类型名上能看到可用变量）。留空 = 用默认。只影响显示，不影响判定。</div>
    <div id="gateRows"></div>
    <div class="fields" style="margin-top:8px">
      <button class="primary" id="saveGateText">保存门禁文案</button>
      <button id="cancelGateText" style="display:none" title="放弃这次没保存的修改">取消保存</button>
      <button id="resetGateText" title="清空所有自定义文案，全部回内置">恢复内置</button>
    </div>
  </div>
  <div class="card">
    <h2>候选文案</h2>
    <div class="hint" style="margin-bottom:6px">候选列/候选筛选里显示的那几个字（已加入保温、强制开、已关闭，以及各条落选原因）。留空 = 用内置文案。只影响显示，不影响判定。</div>
    <div id="candRows"></div>
    <div class="fields" style="margin-top:8px">
      <button class="primary" id="saveCandText">保存候选文案</button>
      <button id="resetCandText" title="清空所有自定义候选文案，全部回内置">恢复内置</button>
    </div>
  </div>
  <div class="card">
    <h2>会话列表显示哪些列</h2>
    <div class="hint" style="margin-bottom:6px">会话 / 候选 / 命中率 / 花费 / 门禁 / 操作 是必需列，不可关。</div>
    <div class="fields" id="colToggles"></div>
    <div class="fields" style="margin-top:8px">
      <span class="lab">花费列显示</span>
      <button class="tgl" id="costScopeCycle" onclick="setCostScope('cycle')" title="显示本周期花了多少">本周期花费</button>
      <button class="tgl" id="costScopeTotal" onclick="setCostScope('total')" title="显示全部保温次数">全部次数</button>
      <button class="primary" id="saveCols" style="margin-left:9px">保存列</button>
      <button id="resetColW" title="清空拖过的列宽，回到默认比例">列宽恢复默认</button>
    </div>
  </div>

</div>

<div id="toast"></div>

<div id="tl">
  <div class="box">
    <button class="close" id="tlClose">关闭 ✕</button>
    <h2 style="font-size:16px" id="tlTitle">会话时间轴</h2>
    <div class="hint" id="tlSub"></div>
    <div class="sum" id="tlSum"></div>
    <div class="savebar" style="margin:6px 0 10px;flex-wrap:wrap">
      <button class="toggle on" id="tlDesc" data-on="1" onclick="flipTl(this)" title="最新的一条排在最上面">最新在最上</button>
      <span class="hint">粒度</span>
      <select class="sel" id="tlGran">
        <option value="step">单次调用</option>
        <option value="turn">整轮合计</option>
        <option value="both">两种都列</option>
      </select>
      <span class="hint">只看</span>
      <select class="sel" id="tlKind">
        <option value="all">轮次 + 保温</option>
        <option value="round">只看对话轮次</option>
        <option value="warm">只看保温（含压缩/goal）</option>
        <option value="compaction">只看压缩</option>
        <option value="goal">只看改写(goal)</option>
      </select>
      <select class="sel" id="tlSort">
        <option value="time">按时间</option>
        <option value="hit">按缓存命中率</option>
        <option value="cost">按花费</option>
      </select>
      <button class="toggle" id="tlRev" onclick="flipTl(this)" title="把当前排序整体反转">逆序</button>
      <span class="hint">周期</span>
      <select class="sel" id="tlCycle"><option value="">全部周期</option></select>
      <button class="toggle" id="tlSkipFirst" onclick="flipTl(this)" title="第一轮通常是冷启动，去掉它更好比较">筛除第一轮</button>
    </div>
    <div class="axis" id="tlAxis"></div>
  </div>
</div>


<div id="holidayBox">
  <div class="box narrow">
    <button class="close" id="holidayClose">关闭 ✕</button>
    <h2 style="font-size:16px">节假日表</h2>
    <div class="hint" style="margin:6px 0 8px">
      一行一天，格式 <code>02-17 春节</code>（只写月-日，不写年份，每年通用）。下面是国务院放假安排（只含放假日期，不含调休上班日）。
    </div>
    <textarea id="holidayList" style="width:100%;height:300px;font-family:inherit;font-size:12px" spellcheck="false"></textarea>
    <div class="fields" style="margin-top:8px">
      <button class="primary" id="saveHoliday">保存节假日表</button>
      <button id="resetHoliday" title="填回内置默认表">恢复默认</button>
    </div>
  </div>
</div>

<div id="help">
  <div class="box">
    <button class="close" id="helpClose">关闭 ✕</button>
    <h2 style="font-size:17px">使用说明 · 机制 · 省钱知识</h2>

    <h3>一、它是怎么省钱的</h3>
    <p>DeepSeek 的前缀缓存在<b>账号级</b>按「前缀内容」共享。同一段前缀：<b>命中按 1 倍价、未命中按 50 倍价</b>。
    所以一次「冷启动重算」的钱 = 保温 50 次的钱。</p>
    <p>保温做的事只有一件：在会话空闲时，把那串前缀<b>原样再发一遍</b>，末尾加一句极短的问候，让服务端确认
    「这段我还记得」，从而给缓存续命。请求体 = 完整上下文 + 一个问题，输出上限设 1 个 token（防跑飞，也顺便防它去调工具）。</p>
    <p><b>结论</b>：只要保住的概率 &gt; 约 <code>n/49</code>（n = 你打算保几次），就是赚的。</p>

    <h3>二、怎么才不亏钱</h3>
    <table>
      <tr><th>情形</th><th>建议</th></tr>
      <tr><td>会话很大（几十万 token）</td><td><b>尽量保</b>。全命中时几十万 token 也只要不到 1 分钱</td></tr>
      <tr><td>会话很小（几万 token）</td><td>保的价值有限，按 4 小时默认间隔即可</td></tr>
      <tr><td>你已经很久没碰它</td><td>别保。实测 4~8 小时存活率掉到 50%、超过 8 小时只剩约 5%</td></tr>
      <tr><td>它还在被高强度使用</td><td>不用保 —— 你自己的请求就在刷新缓存</td></tr>
    </table>
    <p><b>熔断是保命的</b>：一旦某次保温命中率低于 50%，说明「这条前缀已经被别的东西顶掉了」，
    插件立刻停手 —— 因为漏一次 = 50 次的保费。你可以在会话行点「解除熔断」手动放行一次探测。</p>
    <p><b>真正的坑</b>：前缀一旦有一处不同（工具面变了、system 变了、上下文被压缩过），
    命中率会瞬间塌到接近 0，那一轮就按冷启动全价计费。插件为此严格复刻真实请求的每一个字段。</p>

    <h3>三、最好保几轮 / 推荐保几个</h3>
    <ul>
      <li><b>保几轮</b>：连续保的次数上限就是「一次冷启动 = 50 次保温」的推论 —— 超过 50 次，累计花的钱已经
      够让它冷掉重算一遍了。面板因此建议 <b>9 次</b>（留足余量，且有熔断兜底）。</li>
      <li><b>保几个会话</b>：建议 <b>2 个</b>。保温是概率押注，同时保太多等于把预算摊薄到冷门会话上。</li>
      <li><b>间隔</b>：推荐 <b>TTL 的一半</b>。官方实测 4~8 小时存活率掉到 50%，所以默认 4 小时。</li>
    </ul>

    <h3>四、每项参数的含义</h3>
    <table>
      <tr><th>参数</th><th>含义</th></tr>
      <tr><td>闲置门槛</td><td>只对「最近活跃时间不超过 N 小时」的会话自动保温</td></tr>
      <tr><td>熔断冷却</td><td>命中率塌了之后，隔多久自动允许再试探一次（0 = 不自动，等你手动放行）</td></tr>
      <tr><td>单会话预算</td><td>这条会话累计花超过这个数就不再保</td></tr>
      <tr><td>次数上限</td><td>连续保温次数触顶就停，避免在一条已经凉了的会话上反复烧钱</td></tr>
      <tr><td>输出上限</td><td>固定 1。让模型只回一个 token，既省钱又彻底杜绝它自作主张</td></tr>
      <tr><td>单价</td><td>在「设置」页。换模型 / 切峰谷档 / 官方调价时改这里，w/r、次数上限、花费都会跟着变</td></tr>
    </table>
    <p><b>官方现价</b>（元 / 百万 token，2026-10）：<code>deepseek-flash</code> 命中 0.02 / 未命中 1 / 输出 4（空闲档）；
    <code>deepseek-v4-pro</code> 命中 0.15 / 未命中 4.5 / 输出 13.5。
    DeepSeek 是<b>峰谷定价</b>：工作日北京 09:00–12:00、14:00–18:00 为高峰，
    其余时间（含周末与中国法定节假日全天）为空闲，<b>空闲价一律是高峰的一半</b>。
    因为高峰档全部 ×2、<b>比值不变</b>，所以只填空闲档、所有结论一样成立。</p>
    <p><b>代理工具开关</b>：关掉 = 把 <code>cache_lab</code> 从工具面<b>注销</b>，agent 看不到也调不了。
    ⚠️ 切换它会<b>改变工具面</b>，导致所有会话的前缀缓存失效一次（下一轮按未命中价重算整个上下文）——
    要开要关就一次决定好，别频繁切。</p>

    <h3>五、试验模式（已从面板移出）</h3>
    <p>面板上<b>不再有</b>「试验模式」页签，改用命令行：<br>
    <code>node cli/keepalive.mjs --lab verify</code> —— 只读体检（零花费、零网络）<br>
    <code>node cli/keepalive.mjs --lab live --yes --arm --config-from=&lt;真实配置 home&gt;</code> —— <b>真跑，会花钱</b><br>
    （<code>--lab run</code> 是零花费的虚拟不变量，<b>它不认 <code>--arm</code></b>；真跑只走 <code>--lab live --yes --arm</code>。）
    试验模式把时间参数压到秒级（间隔 30s、冷却 60s、闲置门槛 3 分钟、次数上限 99），
    让你在几分钟内看完整链路：自动候选 → 保温 → 命中判定 → 熔断 → 冷却恢复；<b>退出时自动还原你原来的值</b>。</p>
    <p>同一套动作也开放给 Agent（工具 <code>cache_lab</code>，开关在「设置」页）：agent 能开试验模式、读写设置、列会话、看时间轴。
    不想给就关掉那个开关 —— 关掉即从工具面注销，agent 看不到也调不了。</p>

    <h3>六、门禁：一句状况说明，不是黑名单</h3>
    <p>「门禁」列<b>永远有内容</b> —— 通过时显示绿色的「✅ 通过」，并跟上可核对的时间事实
    （「已保温 12 分钟前 · 上次会话 3 分钟前」）。只有真被拦下时才换成下面的码，
    每个码有自己的符号和颜色：</p>
    <table>
      <tr><th>码</th><th>意思 / 怎么办</th></tr>
      <tr><td><span class="gate gate-archived">📦 archived</span></td><td>会话已归档 —— 归档的不保温（取消归档后自动恢复）</td></tr>
      <tr><td><span class="gate gate-too-soon">⏳ too-soon</span></td><td>距上次刷新不到一个间隔，还不用保</td></tr>
      <tr><td><span class="gate gate-cold-window-idle">🥶 cold-window-idle</span></td><td>从未保温且已经闲置超过<b>闲置上限</b>：缓存大概率已断，保了等于白烧一次冷启动</td></tr>
      <tr><td><span class="gate gate-cold-window">🧊 cold-window</span></td><td>插件没见过这条会话活动，不确定缓存热不热 —— 在里面发一句话或点「立刻保温」</td></tr>
      <tr><td><span class="gate gate-tripped">⛔ tripped</span></td><td>已熔断，点「解除熔断」放行一次探测</td></tr>
      <tr><td><span class="gate gate-budget">💸 budget</span></td><td>本周期花费触到单会话预算上限</td></tr>
      <tr><td><span class="gate gate-max-touches">🔁 max-touches</span></td><td>本周期保温次数触顶（清账可开新周期重数）</td></tr>
      <tr><td><span class="gate gate-max-touches-total">⛔ max-touches-total</span></td><td>累计保温次数触顶（跨周期也算；调高上限或设 0 解除）</td></tr>
      <tr><td><span class="gate gate-prefix-changed">🔀 prefix-changed</span></td><td><b>前缀被改写过，且上次保温之后这条会话没被真实使用过</b>
      （工具声明或开头的系统消息变了）—— 此时缓存已经对不上，再保必定 0 命中，所以<b>暂停、不花钱</b>；
      你在会话里发一条消息重建缓存后自动恢复。
      注意：如果改写本身正是一次真实对话引起的，缓存已被那次对话重建，<b>这种情况不会暂停</b></td></tr>
      <tr><td><span class="gate gate-no-route">🛰 no-route</span></td><td>会话还没路由过任何请求，拿不到 provider/model</td></tr>
      <tr><td><span class="gate gate-no-agent">💤 no-agent</span></td><td>会话找不到（磁盘上既没有日志也不在本进程内）</td></tr>
      <tr><td><span class="gate gate-image">🖼 image</span></td><td>含靠前的图片块：离线拿不到图片字节，保了反而会把错误前缀写进缓存。<b>图片在最后 10% 以内才会放行</b></td></tr>
      <tr><td><span class="gate gate-stale">📉 stale</span></td><td>保过，但距缓存最后一次刷新已经超过<b>闲置上限</b>
      （默认 8 小时）—— 缓存大概率早断了，保了也是 0 命中。要在会话里发一条消息重建缓存</td></tr>
    </table>

    <h3>七、自动策略的完整规则</h3>
    <p>「自动候选」卡决定<b>哪几条会话归自动保温管</b>。判定按顺序走，前面命中就不再往后看：</p>
    <table>
      <tr><th>#</th><th>规则</th><th>为什么</th></tr>
      <tr><td>0</td><td>总开关关 → 全部不保</td><td>手动优先</td></tr>
      <tr><td>1</td><td><b>门禁不认</b> → 不占自动名额</td><td>先门禁后自动。例外：「已在保温节奏上」的
      <code>too-soon</code>/<code>fresh</code>（保过、还没到间隔）<b>照样占名额</b> —— 否则名额会随节奏滚动、保费翻倍</td></tr>
      <tr><td>2</td><td>已归档 → 不占名额</td><td>归档 = 你已经收起来了，不该再花钱</td></tr>
      <tr><td>3</td><td>手动设成「强制开 / 关闭」的 → 不占自动名额</td><td>它们归你亲自管，别浪费配额</td></tr>
      <tr><td>4</td><td>没有标题的新对话 → 不纳管</td><td>还没起名，说明还没真正用起来</td></tr>
      <tr><td>5</td><td>子代理会话 → 不纳管</td><td>命短、上下文碎，保了基本赔钱。想保就勾「子代理也算」</td></tr>
      <tr><td>6</td><td>本插件没见过它活动 → 不纳管</td><td>不知道它的缓存到底热不热</td></tr>
      <tr><td>7</td><td>闲置超过<b>闲置上限</b>（与门禁同一个数）→ 不纳管</td><td>早就凉了，再保等于白烧一次冷启动</td></tr>
      <tr><td>8</td><td>剩下的按「最后活动」从近到远排，取前 N 条</td><td>名额有限，只保你最可能要回去用的</td></tr>
    </table>
    <p>规则 1~5 是<b>资格问题</b>（压根不归自动管），6~8 是<b>健康问题</b>（值不值得保）。
    所以被手动指定或被门禁挡下的会话，哪怕刚活跃过，也不会占自动名额。</p>
    <p>面板里写的「推荐值」只是提示：<b>填多少就是多少，不封顶</b>（唯一保底：间隔最小 60 秒、单价 &gt; 0）。</p>

    <h3>八、会话列表：任何一条都能保</h3>
    <p><b>不再有「本进程内 / 进程外」之分，也没有「激活」这一步。</b>
    所有会话都能直接从磁盘日志离线装配前缀（实测对着真实缓存命中 99.9%），
    不需要把它装进哪个进程，也不占 DSH 内存。</p>
    <p>命令行同样能管全部：<code>cli/keepalive.mjs --once &lt;会话id&gt;</code>、
    <code>--status</code>、以及起无实例面板的 <code>--serve</code>。</p>
    <table>
      <tr><th>列 / 筛选项</th><th>含义</th></tr>
      <tr><td>候选</td><td>自动候选里的名次，或没被选上的原因</td></tr>
      <tr><td>上次保温</td><td>时间 + 命中率 + 命中/总 token + 花费 + 耗时 + 第几次 + 触发方式。
      <b>点这一格</b>直接看该会话的全部保温记录。</td></tr>
      <tr><td>隐藏已归档</td><td>归档 = 你已经收起来的会话，通常不再使用</td></tr>
      <tr><td>隐藏子代理</td><td>主会话临时派出去干活的那些，命短、上下文碎</td></tr>
      <tr><td>隐藏空会话</td><td>既没标题、日志也几乎没内容 —— 开了但没真正用过</td></tr>
      <tr><td>置顶</td><td><b>本插件自己的一份置顶</b>（与 DSH 侧栏的置顶无关），置顶行永远排最上</td></tr>
      <tr><td>定位本会话</td><td>滚到当前会话那一行并闪三下（不自动置顶）</td></tr>
    </table>
    <p>搜索、排序、每页条数、以上勾选、以及时间轴的排序与筛选<b>都会记住，刷新页面不丢</b>。</p>
    <p><b>时间轴</b>（点会话名或「上次保温」打开）：默认<b>最新在最上</b>，可切回正序；
    「只看」可选轮次 / 保温 / 两者；还能按<b>缓存命中率</b>排序、以及<b>筛除第一轮</b>
    （第 1 轮必然是冷启动、命中率接近 0，留着会把整体水平拉低）。</p>
    <p><b>粒度</b>三选：<b>单次调用</b>（step，一次 API 调用一项）、<b>整轮合计</b>（turn，一整轮合成一项）、
    <b>两种都列</b>。一次工具往返就是同一轮里的两次调用 —— 本会话真实数据是 1547 次调用 → 74 轮，
    看「这一轮总共花了多少」必须用 turn，否则 1547 行根本没法读。</p>

    <h3>九、钱是怎么算出来的</h3>
    <p>实际花费 = <b>模型价</b> × <b>时段倍率</b>。</p>
    <ul>
      <li><b>模型价</b>：会话日志里每一笔真实调用都带模型名，所以时间轴能<b>按轮识别模型</b>、
      用对应单价算钱。表里查不到的模型回落「基准价」。匹配：精确名 → 最长包含
      （<code>deepseek-flash-2026</code> 命中 <code>deepseek-flash</code>）→ 基准价。</li>
      <li><b>时段倍率</b>：基准价对应<b>倍率 1</b>，命中某时段就乘上它的倍率。默认两格是
      「空闲 <code>00:30→08:30</code> ×1 / 高峰 <code>08:30→00:30</code> ×2」，所以默认单价按<b>空闲档</b>填。
      时段从上往下先命中先用；跨零点就写反（<code>23:00→07:00</code>）。</li>
      <li><b>节假日</b>默认<b>不启用</b>（DeepSeek 官方并不按节假日调价）。表里给的是 2026 年国务院放假日期，
      你要叠自定义倍率再打开它 —— 打开后它<b>覆盖</b>时段表，不叠乘。</li>
      <li>时段判定走你填的<b>时区</b>（默认 Asia/Shanghai），不看系统时区。</li>
    </ul>

    <h3>十一、这些数字从哪来</h3>
    <p>全部来自本机实测，不是估的：工具面的缓存效应（含「形态首现 vs 复现」对照实验）、
    前缀 TTL 分布（上万对样本）、压缩经济学、以及保温请求与真实请求的逐字节对照。</p>
  </div>
</div>

<script>
var API = '/api/cache-keepalive';
/** 本页构建号：服务端换了一代就自动重载（15 秒自动刷新只重画表格，不会重载 CSS）。 */
/** 嵌入模式（被 client 的页签 iframe 引用时带 ?embed=1）——隐藏页头，避免与外层标题重复。 */
var EMBED = /(^|[?&])embed=1(&|$)/.test(window.location.search);
/**
 * 详情页 iframe = 宿主覆盖层里那一层（URL 带 tl=）。
 * **主面板 iframe 也带 embed=1**（?embed=1&current=<id>）—— 所以判断"是不是详情"只能看 tl=，
 * 用 EMBED 一刀切会把主面板的覆盖层委托一起挡掉（覆盖层就永远不出现了）。
 */
var IS_DETAIL = /(^|[?&])tl=/.test(window.location.search);
if (IS_DETAIL) document.body.className = (document.body.className + ' is-detail').trim();
/* 额外标记：只有「宿主覆盖层里的详情页」才藏面板 ✕（网页版直开 ?tl= 要保留） */
if (IS_DETAIL && EMBED) document.body.className = (document.body.className + ' is-detail-embed').trim();
/**
 * 详情模式不要给 html 设透明：透明露出来的是 iframe 的**文档画布**（默认系统色 Canvas，
 * 没声明 color-scheme 时就是白），而 iframe 元素自身背景在画布**下面**、被整个盖住。
 * 这里显式给主题底色；body 仍透明（内容由 #tl 自己铺）。
 */
if (IS_DETAIL) document.documentElement.style.background = 'var(--bg)';
/** 详情模式首帧只该有时间轴：占位行由脚本给，详情模式一行都不生成（#rows 里 0 行）。 */
if (!IS_DETAIL) { var rowsBoot = document.getElementById('rows'); if (rowsBoot) rowsBoot.innerHTML = '<tr><td colspan="6" class="dim">加载中…</td></tr>'; }
if (EMBED) document.body.className = (document.body.className + ' embed').trim();

/**
 * 当前会话 id —— client 页签通过 ?current=<id> 传进来（那个 id 来自 slot 的
 * scope:'session' 自动注入的 props.sessionId）。
 * 用来：① 给列表里那一行打「当前」标；② 渲染「当前对话」卡。
 */
var CURRENT_ID = (function () {
  var m = /(^|[?&])current=([^&]*)/.exec(window.location.search);
  return m === null ? '' : decodeURIComponent(m[2]);
})();
var LS_KEY = 'cache-keepalive:filters';
var $ = function (id) { return document.getElementById(id); };
var STATE = null;
var SHOWN = 0;

function toast(msg, bad) {
  var t = $('toast');
  t.textContent = msg;
  t.style.borderColor = bad ? 'var(--bad)' : 'var(--ok)';
  t.style.display = 'block';
  setTimeout(function () { t.style.display = 'none'; }, 3200);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtAgo(sec) {
  if (sec < 0) return '<span class="dim">未知</span>';
  if (sec < 60) return sec + ' 秒前';
  if (sec < 3600) return Math.round(sec / 60) + ' 分钟前';
  if (sec < 86400) return (sec / 3600).toFixed(1) + ' 小时前';
  return Math.round(sec / 86400) + ' 天前';
}
function fmtWhen(ms) {
  if (!ms) return '<span class="dim">-</span>';
  var d = new Date(ms);
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function fmtSize(b) {
  if (!b) return '-';
  if (b < 1024) return b + 'B';
  if (b < 1048576) return Math.round(b / 1024) + 'K';
  return (b / 1048576).toFixed(1) + 'M';
}
function fmtMoney(v) { return (v === undefined || v === null) ? '-' : v.toFixed(3) + ' 元'; }
/* 本周期花费：优先「展示价」cycleSpendDisplay（按当前价重算）；老后端没这个字段就回落账本值。 */
function cycleSpendShown(s) {
  var v = s.cycleSpendDisplay;
  return (typeof v === 'number' && isFinite(v)) ? v : (Number(s.cycleSpend) || 0);
}

/* ── 筛选状态的记忆（刷新不丢）────────────────────────────────────── */
/* 开关按钮：data-on=1 表示开启（隐藏生效），颜色由 .toggle.on 决定 */
function setToggle(el, on) {
  el.setAttribute('data-on', on === false ? '0' : '1');
  el.classList.toggle('on', on !== false);
}
function flipToggle(el) {
  setToggle(el, el.getAttribute('data-on') !== '1');
  SHOWN = 0; saveFilters(); render();
}
/** 读 .toggle 按钮的状态（data-on=1 才算开；缺省视为关）。 */
function tglOn(id) {
  var el = $(id);
  return !!el && el.getAttribute('data-on') === '1';
}
/** 设置卡片里的开关：只切颜色，点该卡的保存按钮才落盘。 */
function flipTgl(el) { setToggle(el, el.getAttribute('data-on') !== '1'); }
/** 时间轴弹层里的开关：切完立即生效并记住。 */
function flipTl(el) {
  setToggle(el, el.getAttribute('data-on') !== '1');
  /* 三个开关各写各的字段，不碰别人 */
  var idTl = el.id, pTl = {};
  if (idTl === 'tlDesc') pTl.desc = tglOn('tlDesc');
  else if (idTl === 'tlRev') pTl.rev = tglOn('tlRev');
  else if (idTl === 'tlSkipFirst') pTl.skipFirst = tglOn('tlSkipFirst');
  if (idTl === 'tlDesc' || idTl === 'tlRev' || idTl === 'tlSkipFirst') patchTlPref(pTl);
  paintTimeline();
}
/** 列显示开关：只切颜色，点「保存列设置」才落盘（collectCols 直接读 DOM，不需要脏标记）。 */
function flipCol(el) { setToggle(el, el.getAttribute('data-on') !== '1'); }

/** 多选筛选的选中值（组内 OR；组间与 hide* / 搜索 AND）。存 localStorage，与 settings 无关。 */
var GATE_SEL = [];
var CAND_SEL = [];
/** 两组各两种模式：'filter' = 不命中就隐藏（原语义）；'sort' = 不隐藏，命中行像置顶一样排前。 */
var CAND_MODE = 'filter';
var GATE_MODE = 'filter';
function msMode(kind) { return kind === 'gate' ? GATE_MODE : CAND_MODE; }
function msSetMode(kind, m) { if (kind === 'gate') GATE_MODE = m; else CAND_MODE = m; }

function saveFilters() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      q: $('q').value,
      sortBy: $('sortBy').value,
      sortRev: sortRevOn(),
      pageSize: Number($('pageSize').value) || 50,
      gateCodes: GATE_SEL.slice(0),
      candMode: CAND_MODE,
      gateMode: GATE_MODE,
      candCodes: CAND_SEL.slice(0),
      hideArchived: $('hideArchived').getAttribute('data-on') === '1',
      hideSubagent: $('hideSubagent').getAttribute('data-on') === '1',
       hideBlank: $('hideBlank').getAttribute('data-on') === '1',
       onlyLive: $('onlyLive').getAttribute('data-on') === '1'
    }));
  } catch (e) { /* 隐私模式下 localStorage 可能不可用，忽略 */ }
}
/** 候选筛选项：前 3 项是「面板上实际显示的状态」，其余文案一律取自 CAND_WHY（避免两处漂移）。
 *  刻意不含 CAND_WHY.manual —— 候选列先按 mode 显示，auto.ts 只在 mode!=auto 时给 manual，
 *  那个分支永远被 mode 截走，做成筛选项会恒 0 命中。 */
function candOpts() {
  return [
    ['picked', candWord('picked')], ['on', candWord('on')], ['off', candWord('off')],
    ['auto-disabled', candWord('auto-disabled')], ['gate', candWord('gate')],
    ['archived', candWord('archived')], ['untitled', candWord('untitled')],
    ['subagent', candWord('subagent')], ['never-seen', candWord('never-seen')],
    ['over-quota', candWord('over-quota')]
  ];
}
/** 门禁筛选按钮的中文兜底：只在 /state 还没到（或一直失败）时用。
 *  **必须与 core/gate-texts.ts 的 key+text 一致** —— tests/gate-texts.test.mjs 的 T7 会逐条比对，别单独改这里。 */
var GATE_WORD_FALLBACK = {
  'warm': '可保温', 'fresh': '已保温', 'too-soon': '未到点', 'cold-window': '没保过',
  'cold-window-idle': '闲置超窗', 'stale': '断档', 'tripped': '熔断', 'budget': '超预算',
  'max-touches': '本期次数满', 'max-touches-total': '累计次数满', 'prefix-changed': '前缀变',
  'no-route': '无路由', 'no-agent': '找不到', 'archived': '已归档', 'running': '跑回合中'
};
/** 有 STATE.gateTexts 就用真文案（含用户自定义覆盖），否则用中文兜底 —— 绝不把英文 key 摆给用户看。 */
function gateWordSafe(key) {
  if (STATE && STATE.gateTexts && STATE.gateTexts.length > 0) return gateWord(key);
  return GATE_WORD_FALLBACK[key] || key;
}
/** 门禁筛选项：15 项 = 门禁码全集（GateSkip 的 14 个 + warm）。
 *  **不含 image** —— 它只是文案表的 key，GateSkip 里没有这个码，做成筛选项会恒 0 命中。 */
function gateOpts() {
  /* 文案一律取 gateWordSafe()：有 STATE 走 gateWord（与门禁列同一份 + 用户自定义覆盖），
     STATE 未就绪/服务异常时用中文兜底表 —— 用户永远看不到 too-soon 这种英文 key。 */
  var defs = [
    ['warm', '可保温'], ['fresh', '已保温'], ['too-soon', '未到点'], ['cold-window', '没保过'],
    ['cold-window-idle', '闲置超窗'], ['stale', '断档'], ['tripped', '熔断'], ['budget', '超预算'],
    ['max-touches', '本期次数满'], ['max-touches-total', '累计次数满'], ['prefix-changed', '前缀变'],
    ['no-route', '无路由'], ['no-agent', '找不到'], ['archived', '已归档'], ['running', '跑回合中'],
  ];
  var out = [];
  for (var gi = 0; gi < defs.length; gi++) out.push([defs[gi][0], gateWordSafe(defs[gi][0])]);
  return out;
}
function sortRevOn() { return $('sortRev').getAttribute('data-on') === '1'; }
/** 候选筛选项对应的键（与候选列显示的状态一一对应）。 */
function candKeyOf(s) {
  if (s.isAutoCandidate) return 'picked';
  if (s.mode === 'on') return 'on';
  if (s.mode === 'off') return 'off';
  return String(s.autoReason || '');
}
/** 命中率：没保过的会话记 -1，排最后；绝不让 undefined 进比较器（否则 NaN 排序结果不确定）。 */
function hitRateOf(s) {
  if (s && s.last && s.last.hitRate >= 0) return s.last.hitRate;
  return -1;
}
function msOpts(kind) { return kind === 'gate' ? gateOpts() : candOpts(); }
function msSel(kind) { return kind === 'gate' ? GATE_SEL : CAND_SEL; }
function msBoxId(kind) { return kind === 'gate' ? 'msGateBox' : 'msCandBox'; }
function msSumId(kind) { return kind === 'gate' ? 'msGateSum' : 'msCandSum'; }
/** 触发器摘要：筛选模式 0 项「门禁」/ 1 项带文案 / ≥2 项「门禁 ·N」；排序模式再多一个「·排序」。
 *  msApply / msRelabel 共用这一份，避免两处漂移。 */
function msSummaryText(kind) {
  var opts = msOpts(kind), sel = msSel(kind), i;
  var txt = kind === 'gate' ? '门禁' : '候选';
  if (msMode(kind) === 'sort') txt += ' ·排序';
  if (sel.length === 1) {
    for (i = 0; i < opts.length; i++) if (opts[i][0] === sel[0]) txt += ' · ' + opts[i][1];
  } else if (sel.length > 1) {
    txt += ' ·' + sel.length;
  }
  return txt;
}
/** 按当前选择重刷按钮底色 + 触发器摘要；模式行按 data-mode 单独着色（与选项 data-v 互不干扰）。 */
function msApply(kind) {
  var opts = msOpts(kind), sel = msSel(kind), box = $(msBoxId(kind)), sum = $(msSumId(kind)), i;
  if (box) {
    var btns = box.getElementsByTagName('button');
    for (i = 0; i < btns.length; i++) {
      var v = btns[i].getAttribute('data-v');
      if (v === null) continue;
      btns[i].className = sel.indexOf(v) >= 0 ? 'tgl on' : 'tgl';
    }
    for (i = 0; i < btns.length; i++) {
      var md = btns[i].getAttribute('data-mode');
      if (md === 'filter' || md === 'sort') btns[i].className = md === msMode(kind) ? 'tgl on' : 'tgl';
    }
  }
  if (!sum) return;
  sum.textContent = msSummaryText(kind);
  sum.className = (sel.length > 0 || msMode(kind) === 'sort') ? 'tgl on' : 'tgl';
}
/** 建面板：**只在 loadFilters() 里调一次**。render() 不重建 —— 否则 15 秒自动刷新会冲掉按钮态。 */
/** 建面板：**只在 loadFilters() 里调一次**。render() 不重建 —— 否则 15 秒自动刷新会冲掉按钮态。 */
function msBuild() {
  var kinds = ['cand', 'gate'], k, i;
  for (k = 0; k < kinds.length; k++) {
    var kind = kinds[k], opts = msOpts(kind), html = '';
    html += '<div class="ms-mode">'
      + '<button class="tgl" data-mode="filter" title="不命中就隐藏">筛选</button>'
      + '<button class="tgl" data-mode="sort" title="不隐藏，命中排前">排序</button>'
      + '</div>';
    for (i = 0; i < opts.length; i++) {
      html += '<button class="tgl" data-v="' + esc(opts[i][0]) + '" title="' + esc(opts[i][1]) + '">'
        + esc(opts[i][1]) + '</button>';
    }
    html += '<div class="ms-foot"><button class="tgl" data-clear="1" title="取消本组全部筛选">清空</button></div>';
    var box = $(msBoxId(kind));
    if (box) box.innerHTML = html;
  }
  $('msCandBox').onclick = function (ev) { msHit(ev, 'cand'); };
  $('msGateBox').onclick = function (ev) { msHit(ev, 'gate'); };
  msApply('cand');
  msApply('gate');
}
/** 只刷新面板里按钮的文字与摘要，**不重建 DOM**（选中态/展开态都不动）。改文案保存后调用。 */
function msRelabel() {
  var kinds = ['cand', 'gate'], k, i, j;
  for (k = 0; k < kinds.length; k++) {
    var kind = kinds[k], opts = msOpts(kind), box = $(msBoxId(kind));
    if (!box) continue;
    var btns = box.getElementsByTagName('button');
    for (i = 0; i < btns.length; i++) {
      var v = btns[i].getAttribute('data-v');
      if (v === null) continue;
      for (j = 0; j < opts.length; j++) if (opts[j][0] === v) btns[i].textContent = opts[j][1];
    }
    msApply(kind);
  }
}
function msHit(ev, kind) {
  var b = ev.target;
  if (!b || b.tagName !== 'BUTTON') return;
  ev.stopPropagation();
  var modeHit = b.getAttribute('data-mode');
  if (modeHit === 'filter' || modeHit === 'sort') {
    msSetMode(kind, modeHit);
    msApply(kind);
    SHOWN = 0; saveFilters(); render();
    return;
  }
  if (b.getAttribute('data-clear') === '1') {
    msSel(kind).length = 0;
  } else {
    var v = b.getAttribute('data-v'), sel = msSel(kind), at = sel.indexOf(v);
    if (at >= 0) sel.splice(at, 1); else if (v) sel.push(v);
  }
  msApply(kind);
  SHOWN = 0; saveFilters(); render();
}
/** 点浮层以外的地方收起（用 click 不用 mousedown —— mousedown 会插进列宽拖拽链路）。 */
function msCloseOutside(ev) {
  var ids = ['msCand', 'msGate'], i, d;
  for (i = 0; i < ids.length; i++) {
    d = $(ids[i]);
    if (d && d.open && !d.contains(ev.target)) d.open = false;
  }
}
/**
 * 同时只允许一个浮层打开：点在某个 summary 上时先把另一个关掉。
 * 必须走**捕获阶段** —— 浏览器是在 click 默认动作里才切换 open，冒泡阶段看到的本个还是旧状态。
 */
function msExclusive(ev) {
  var ids = ['msCand', 'msGate'], i, d, sum, hit = -1;
  for (i = 0; i < ids.length; i++) {
    d = $(ids[i]);
    if (!d) continue;
    sum = d.querySelector('summary');
    if (sum && sum.contains(ev.target)) hit = i;
  }
  if (hit < 0) return;
  for (i = 0; i < ids.length; i++) {
    if (i === hit) continue;
    d = $(ids[i]);
    if (d) d.open = false;
  }
}
/** 浮层贴到视口右边缘时改右对齐，避免横向溢出被裁；右对齐后左缘若被甩出视口，再夹左缘。 */
function msFit(d) {
  var panel = d.querySelector('.ms-panel');
  if (!panel) return;
  panel.style.left = '0';
  panel.style.right = 'auto';
  var r = panel.getBoundingClientRect();
  if (r.right > document.documentElement.clientWidth - 8) {
    panel.style.left = 'auto';
    panel.style.right = '0';
  }
  // 右对齐会让左缘往左跑（窄视口实测 left = -215）→ 再夹一次左缘，用相对 details 的 left 偏移修正
  var r2 = panel.getBoundingClientRect();
  if (r2.left < 8) {
    panel.style.right = 'auto';
    panel.style.left = (8 - d.getBoundingClientRect().left) + 'px';
  }
}
/** 读盘：白名单过滤 + 老格式迁移（单值 gate → gateCodes；旧的「升序查看时间」→ mtime + 逆序）。 */
function msPick(kind, arr, legacy) {
  var opts = msOpts(kind), allow = {}, out = [], i, v;
  for (i = 0; i < opts.length; i++) allow[opts[i][0]] = 1;
  var src = Array.isArray(arr) ? arr : (typeof legacy === 'string' && legacy ? [legacy] : []);
  for (i = 0; i < src.length; i++) {
    v = String(src[i]);
    if (allow[v] === 1 && out.indexOf(v) < 0) out.push(v);
  }
  return out;
}
function loadFilters() {
  var f = null;
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (raw) f = JSON.parse(raw);
  } catch (e) { f = null; }
  msBuild();   // 面板只在这里建一次（见 msBuild 注释）
  if (!f) return;
  /**
   * 已删功能的遗留键：**读到就丢**，并且当场清洗回写一次 ——
   * 否则要等到用户下次动筛选才会被 saveFilters 覆盖，刷新后 localStorage 里还留着这些键。
   */
  var stale = ['activeIncludeViewed', 'showViewed', 'rankViewedLast', 'viewedFilter', 'viewedRank'], dropped = false, si;
  for (si = 0; si < stale.length; si++) {
    if (Object.prototype.hasOwnProperty.call(f, stale[si])) { delete f[stale[si]]; dropped = true; }
  }
  if (dropped) { try { localStorage.setItem(LS_KEY, JSON.stringify(f)); } catch (e) { /* 隐私模式忽略 */ } }
  try {
    if (typeof f.q === 'string') $('q').value = f.q;
    var by = f.sortBy === 'mtimeAsc' ? 'mtime' : f.sortBy;
    if (typeof by === 'string' && $('sortBy').querySelector('option[value="' + by + '"]')) $('sortBy').value = by;
    setToggle($('sortRev'), f.sortRev === true || f.sortBy === 'mtimeAsc');
    if (typeof f.pageSize === 'number' && f.pageSize >= 10) $('pageSize').value = f.pageSize;
    GATE_SEL = msPick('gate', f.gateCodes, f.gate);
    CAND_MODE = f.candMode === 'sort' ? 'sort' : 'filter';
    GATE_MODE = f.gateMode === 'sort' ? 'sort' : 'filter';
    CAND_SEL = msPick('cand', f.candCodes, null);
    setToggle($('hideArchived'), f.hideArchived);
    setToggle($('hideSubagent'), f.hideSubagent);
    setToggle($('hideBlank'), f.hideBlank);
    setToggle($('onlyLive'), f.onlyLive === true);
  } catch (e) { /* 坏数据就当没存过 */ }
  buildMultiOrRender();
}

/** 两个多选面板的收尾（建在 loadFilters 开头，这里只刷选中态与摘要）。
 *  render() **不许**调它：每 15 秒重建会把按钮上的选中态冲掉。 */
function buildMultiOrRender() {
  msApply('cand');
  msApply('gate');
}
function modeLabel(m) {
  if (m === 'on') return '<span class="pill on">强制开</span>';
  if (m === 'off') return '<span class="pill off">关闭</span>';
  return '<span class="pill auto">自动</span>';
}
function candLabel(s) {
  if (s.isAutoCandidate) return '<span class="pill on">#' + s.autoRank + '</span>';
  return '<span class="dim">' + (s.autoReason ? esc(candWord(s.autoReason)) : '-') + '</span>';
}

/** 命中判定（无权重：命中即 1）。选中为空 → 恒不命中，等价于该组没开。 */
function candHit(s) { return CAND_SEL.length > 0 && CAND_SEL.indexOf(candKeyOf(s)) >= 0; }
function gateHit(s) { return GATE_SEL.length > 0 && GATE_SEL.indexOf(String(s.gateCode || '')) >= 0; }
/** 这条会话有没有「真的用过」的证据：有过对话（lastDialogAt）或保过温（账本 last.at）。 */
function hasDialogOrWarm(s) {
  return Number(s.lastDialogAt || 0) > 0 || !!(s.last && Number(s.last.at) > 0);
}/** 最后活动 = max(最后保温, 最后对话)。**不含点开时间**（点开时间在「最后查看」列）。 */
function activeOf(s) {
  return Math.max(Number(s.lastDialogAt) || 0, s.last ? Number(s.last.at) || 0 : 0);
}

function filtered() {
  if (!STATE) return [];
  var q = $('q').value.trim().toLowerCase();
  var hideArch = $('hideArchived').getAttribute('data-on') === '1';
  var hideSub = $('hideSubagent').getAttribute('data-on') === '1';
  var hideBlank = $('hideBlank').getAttribute('data-on') === '1';
     /** 「只看本进程」：纯显示筛选，与保温范围无关（「live」 只表示本进程内有没有活 agent）。 */
     var onlyLive = $('onlyLive').getAttribute('data-on') === '1';
  /* 筛选模式才隐藏；排序模式那组不隐藏，只参与下面的「命中数」排序键。 */
  var anyGate = GATE_MODE === 'filter' && GATE_SEL.length > 0;
  var anyCand = CAND_MODE === 'filter' && CAND_SEL.length > 0;
  var list = STATE.sessions.filter(function (s) {
    if (hideArch && s.archived) return false;
    // 子代理：命短、上下文碎，默认不显示（自动候选也默认排除它们）
    if (hideSub && s.origin === 'subagent') return false;
    // 空会话 = 既没标题、日志也几乎没内容（还没真正用起来的那条）
    if (hideBlank && !s.title && s.sizeBytes < 4096) return false;
       if (onlyLive && s.live !== true) return false;
    if (anyGate && GATE_SEL.indexOf(String(s.gateCode || '')) < 0) return false;
    if (anyCand && CAND_SEL.indexOf(candKeyOf(s)) < 0) return false;
    if (q) {
      var hay = (s.title + ' ' + s.id + ' ' + s.projectKey + ' ' + s.note).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });
  var by = $('sortBy').value;
  /** 逆序只作用在这一遍；下面的置顶（第二次稳定排序）不受方向影响，置顶永远在最上。 */
  var rev = sortRevOn() ? -1 : 1;
  list.sort(function (a, b) {
    /* 排序模式：命中数（0/1/2，不分优先级、无权重表）多的在前；**命中键也乘 rev**
       （用户要求：命中行像置顶一样排前，逆序时跟着反过来）。
       注意与最后那遍置顶排序的区别 —— 那遍不乘 rev，置顶永远在最上。 */
    var hb = (CAND_MODE === 'sort' && candHit(b) ? 1 : 0) + (GATE_MODE === 'sort' && gateHit(b) ? 1 : 0);
    var ha = (CAND_MODE === 'sort' && candHit(a) ? 1 : 0) + (GATE_MODE === 'sort' && gateHit(a) ? 1 : 0);
    if (hb !== ha) return (hb - ha) * rev;
    var r = 0;
    if (by === 'active') r = activeOf(b) - activeOf(a);
    else if (by === 'mtime') r = b.mtime - a.mtime;
    else if (by === 'spend') r = b.spend - a.spend;
    else if (by === 'hit') r = hitRateOf(b) - hitRateOf(a);
    else if (by === 'title') r = String(a.title || '~').localeCompare(String(b.title || '~'), 'zh');
    else if (by === 'size') r = b.sizeBytes - a.sizeBytes;
    return r * rev;
  });
  /**
   * 置顶的永远压在最上（**本插件自己的置顶**，与 DSH workspace 的置顶无关）。
   * 用第二次稳定排序实现：置顶组内部仍保持上面选定的排序，不打乱。
   */
  list.sort(function (a, b) { return (b.pinnedInPanel ? 1 : 0) - (a.pinnedInPanel ? 1 : 0); });
  return list;
}

/**
 * 门禁码 → 独立符号。九种情形符号互不相同，配合各自的颜色，扫一眼就知道是
 * 「让路 / 还没就绪 / 真出事 / 没到点 / 钱或次数用完」哪一类。
 */
var GATE_ICON = {
  'running': '⏸',
  'no-route': '🛰',
  'no-agent': '💤',
    'fresh': '🔵',
          'image': '🖼',
  'tripped': '⛔',
  'archived': '📦',
  'stale': '📉',
  'cold-window': '🧊',
  'cold-window-idle': '🥶',
  'too-soon': '⏳',
  'budget': '💸',
  'max-touches': '🔁',
  'max-touches-total': '⛔',
  'prefix-changed': '🔀'
};

/** 门禁类型的默认文案由服务端给（STATE.gateTexts），用户在设置里可逐条改。 */
function gateDef(key) {
  var list = (STATE && STATE.gateTexts) || [];
  for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
  return null;
}
/** 该门禁码是否有长档文案（后端只有需要分档的码才给 textLong/detailLong）。 */
function gateHasLong(d) {
  return d !== null && d !== undefined && (d.textLong !== undefined || d.detailLong !== undefined);
}
/** 状态词：用户改过就用用户的；长档（isLong）优先取 key:long 覆盖 → 再取 textLong。 */
function gateWord(key, isLong) {
  var ov = (STATE && STATE.settings && STATE.settings.gateText) || {};
  if (isLong === true) {
    var dl = gateDef(key);
    /** 该码没有长档文案时维持短档（不许凭空造一个长档词）。 */
    if (gateHasLong(dl)) {
      if (ov[key + ':long']) return ov[key + ':long'];
      return dl.textLong || dl.text;
    }
  }
  if (ov[key]) return ov[key];
  var d = gateDef(key);
  return d ? d.text : key;
}
/** 说明：用户改过就用用户的（拦截类的说明已由服务端按模板渲染好）。 */
function gateNote(key, fallback) {
  var ov = (STATE && STATE.settings && STATE.settings.gateDetail) || {};
  if (ov[key]) return ov[key];
  var d = gateDef(key);
  return (d && d.detail) || fallback || '';
}
/** 门禁：状态词 + 原因。 */
/** 门禁：只有状态词（列表里是独立一列）。 */
/**
 * 门禁说 warm（可保）不等于"下一轮就会保"：只有**真的在自动名额里**才会。
 * 非候选、且没被手动强制开的会话，状态词/说明一律用固定文案，
 * **不读** settings.gateText.warm —— 那是用户给"已加入保温"设的自定义词，套在非候选上就是假话。
 */
function gateWarmNotPicked(s) {
  return String(s.gateCode || '') === 'warm' && s.isAutoCandidate !== true && s.mode !== 'on';
}
function gateHead(s) {
  var code = String(s.gateCode || '');
  var pass = code === 'warm';
  var word = pass && gateWarmNotPicked(s) ? '可保温' : gateWord(code, s.gateLong === true);
  var cls = pass ? 'gate gate-pass' : ('gate gate-' + code.replace(/[^a-z-]/g, ''));
  /**
   * 颜色只表达**门禁状态**，不表达"在不在本进程"：
   * 非本进程的会话现在也能离线保温（走 pingOffline），再灰显会让人以为不可保。
   * 「不在本进程」用文末那个小圆点 + tooltip 表达，颜色一点不动。
   */
  var offMark = s.live ? '' : '<span class="off-dot" title="不在本进程：点保温会读日志离线装配，比进程内的慢 1~2 秒">◦</span>';
  return '<span class="' + cls + '">'
    + (GATE_ICON[code] || '✅') + ' ' + esc(word) + offMark + '</span>';
}
/** 门禁这一格的原因说明（列表里是独立一列）。 */
function gateNoteOf(s) {
  var pass = String(s.gateCode || '') === 'warm';
  var note;
  if (pass && s.mode === 'on') note = '手动指定，点「保温」即保';
  else if (pass && gateWarmNotPicked(s)) note = '门禁允许，但不在自动名额内（可点「保温」手动保）';
  else note = pass ? gateNote('warm') : s.gateDetail;
  return note ? '<span class="dim">' + esc(note) + '</span>' : '';
}
/** 详情卡里用的组合形态（状态词 + 说明一行）。 */
function gateHtml(s) {
  var note = gateNoteOf(s);
  return '<div class="g2"><span class="gw">' + gateHead(s) + '</span>'
    + (note ? '<span class="gn">' + note + '</span>' : '') + '</div>';
}

/* 列定义：id / 表头 / 默认是否显示 / 是否可点开详情 */
var COLS = [
  ['title', '会话', 1, 1],
  ['cand', '候选', 1, 0],
  ['active', '最后活动', 1, 0],
  ['seen', '最后查看', 0, 0],
  ['warmed', '已保温', 1, 1],
  ['talked', '上次对话', 1, 0],
  ['hit', '命中率', 1, 1],
  ['lastCost', '上次花费', 1, 0],
  ['cost', '花费', 1, 1],
  ['gate', '门禁', 1, 0],
  ['gateNote', '门禁说明', 1, 0],
  ['interval', '间隔', 1, 0],
  ['ops', '操作', 1, 0],
  ['size', '大小', 0, 0],
  ['note', '备注', 0, 0]
];


/** 某列是否显示（设置里可关；缺省用 COLS 的默认值）。 */
function colOn(id) {
  var st = (STATE && STATE.settings && STATE.settings.columns) || {};
  if (typeof st[id] === 'boolean') return st[id];
  for (var i = 0; i < COLS.length; i++) if (COLS[i][0] === id) return COLS[i][2] === 1;
  return true;
}
/** 列宽存哪个字段：插件版 colWidths，CLI 网页版 colWidthsCli（两个面板容器宽不同，混用会互相拖乱）。 */
function colKey() { return (STATE && STATE.variant === 'cli') ? 'colWidthsCli' : 'colWidths'; }
/** 提交列宽用的 patch 对象（字段名跟着变体走，不能写死 colWidths）。 */
function colPatch(v) { var o = {}; o[colKey()] = v; return o; }
/** 列宽：拖过就用 px，没拖过用权重百分比。 */
var COL_W = {
  title: 34, cand: 9, active: 8, seen: 8, warmed: 8, talked: 7, hit: 9, lastCost: 11,
  cost: 9, gate: 13, gateNote: 30, interval: 6, ops: 20, size: 7, note: 8
};
function colWidth(id) {
  var m = (STATE && STATE.settings && STATE.settings[colKey()]) || {};
  var w = Number(m[id]);
  return isFinite(w) && w > 0 ? Math.round(w) : 0;
}
/**
 * 按当前列开关重画表头（含 colgroup 与拖拽手柄）。
 *
 * 列宽分配规则（**必须是「总量守恒」**，否则一定出事）：
 *   1. 拖过的列先按 px 占位，但它们的和可能**超过容器宽**（用户拖多了）；
 *      所以超了就按比例缩回去。
 *   2. 没拖过的列（含**新加的列**）永远先从总宽里扣掉一份，剩下的才给定宽列。
 *   3. 全部输出 px —— 不再混百分比，避免「定宽 + 百分比 = 总和 > 100%」把某列挤成 0 宽
 *      （那样这一列的字会一字一行，行高直接爆掉）。
 */
var COL_AUTO_MIN = 40;
/** 归一化改过 colWidths，等调用方统一落盘（避免松开鼠标时写两次）。 */
/**
 * 纯计算（无 DOM）：存量列宽迁移（一次性把脏数据拉回合理区间）。
 * - 单列存量不得超过容器宽（否则一列吃掉整行，还会被 synced 写回 colWidths）；
 * - 操作列额外有内容上限 mins * 4：老版本 B1 把隐藏测量 table 撑到视口宽（实测 1567）
 *   写进了 state.json，新版不再产生，但**存量必须能自愈**，否则该列永久占 70% 宽。
 * 0（未定宽）保持 0。返回新数组。
 */
function migrateWidths(cur, mins, total, opsIdx) {
  var out = cur.slice(), i;
  for (i = 0; i < out.length; i++) {
    if (!(out[i] > 0)) continue;
    if (total > 0 && out[i] > total) out[i] = total;
    if (i === opsIdx && out[i] > mins[i] * 4) out[i] = mins[i];
  }
  return out;
}
function renderHead() {
  var wrap = document.querySelector('.tablewrap');
  // 留 2px 余量：否则「无滚动条 → 按全宽分配 → 撑出滚动条 → 收缩 → 没滚动条」会自激振荡
  var total = ((wrap && wrap.clientWidth) || (document.documentElement.clientWidth - 40) || 1339) - 2;
  var html = '', cols = '', i, c;
  /**
   * 存量迁移（一次性自愈）：单列存量宽不得超容器宽；操作列超 mins*4 视为历史污染 → 复位到最小宽。
   * 老版本 B1 曾把 1567 写进 colWidths.ops（占 70% 宽），只靠 Math.max(minOf, 存量) 压不回来。
   */
  var migIds = visColIds(), migW = [], migMin = [];
  for (i = 0; i < migIds.length; i++) { migW.push(colWidth(migIds[i])); migMin.push(minOf(migIds[i])); }
  /**
   * 存量迁移（单列超容器 / ops 历史污染）**只影响显示**，不写回存储 ——
   * 窄容器下「单列超容器」是常态（不是污染），写回会把临时布局固化成用户配置。
   */
  var migOut = migrateWidths(migW, migMin, total, migIds.indexOf('ops'));
  /** 迁移后的宽度（显示用）：单列超容器 / ops 历史污染在这里被收回，但**不写存储**。 */
  var migFix = {};
  for (i = 0; i < migIds.length; i++) if (migW[i] > 0 && migW[i] !== migOut[i]) migFix[migIds[i]] = migOut[i];
  var autoIds = [], fixedIds = [], fixedSum = 0, autoWeight = 0;
  for (i = 0; i < COLS.length; i++) {
    c = COLS[i];
    if (!colOn(c[0])) continue;
    var w0 = colWidth(c[0]);
    if (w0 > 0) { fixedIds.push(c[0]); fixedSum += w0; }
    else { autoIds.push(c[0]); autoWeight += COL_W[c[0]] || 10; }
  }
  // 未定宽列先留足最低空间，剩下的才给定宽列；定宽列超了就按比例缩
  var needAuto = COL_AUTO_MIN * autoIds.length;
  var roomForFixed = Math.max(total - needAuto, total * 0.25);
  var scale = fixedSum > roomForFixed ? roomForFixed / fixedSum : 1;
  var rest = Math.max(total - fixedSum * scale, needAuto);
  var widthOf = {};
  for (i = 0; i < fixedIds.length; i++) {
    var baseW = migFix[fixedIds[i]] !== undefined ? migFix[fixedIds[i]] : colWidth(fixedIds[i]);
    widthOf[fixedIds[i]] = Math.max(minOf(fixedIds[i]), Math.round(baseW * scale));
  }
  /**
   * ⚠️ **这里绝不能把缩下来的宽度写回 colWidths**。
   * 容器变窄（打开 DevTools / iframe 被压）→ scale<1 是**临时布局结果**，不是用户意图；
   * 一旦写回，关掉 DevTools 也回不去（实测：1440→900→1440 往返后列宽再也变不回来）。
   * 存储只由「拖拽结束」与「恢复默认」两处写。
   */
  for (i = 0; i < autoIds.length; i++) {
    var wA = autoWeight > 0 ? Math.max(minOf(autoIds[i]), Math.round((rest * (COL_W[autoIds[i]] || 10)) / autoWeight)) : COL_AUTO_MIN;
    widthOf[autoIds[i]] = wA;
  }
  /**
   * 总宽约束只有一条：Σ <= 容器宽。
   * Σ 超了 → 按比例缩回（不破 minOf）；Σ 不足 → **保留右侧留白**（用户拖窄后右侧就该空着，
   * 按比例拉满会把拖出来的状态抹掉）。唯一例外：还存在未定宽列（新列/首次打开）→ 余量补给它们。
   */
  var visIds = visColIds(), visCur = [], visMin = [];
  for (i = 0; i < visIds.length; i++) {
    visCur.push(widthOf[visIds[i]] || COL_AUTO_MIN);
    visMin.push(minOf(visIds[i]));
  }
  var fitted = fitTotal(visCur, visMin, total), sumF = 0;
  for (i = 0; i < fitted.length; i++) sumF += fitted[i];
  if (sumF < total && autoIds.length > 0) {
    var spare = total - sumF, ai = -1, aw = -1;
    for (i = 0; i < autoIds.length; i++) {
      var ww = COL_W[autoIds[i]] || 10;
      if (ww > aw) { aw = ww; ai = i; }
    }
    if (ai >= 0) fitted[visIds.indexOf(autoIds[ai])] += spare;
  }
  for (i = 0; i < visIds.length; i++) widthOf[visIds[i]] = fitted[i];
  /* 同样不写回：fitted 是「按当前容器宽适配后的结果」，只用于这次渲染。 */
  /**
   * table-layout:fixed 只在表宽**非 auto** 时生效。留白需要 CSS width:auto，那会让浏览器
   * 退化成 auto 布局 → 列被表头 nowrap 文字撑在最小内容宽（实测 talked/gateNote 57 而非 40），
   * minOf 形同虚设、拖拽条位移也不对。所以显式写「表宽 = Σ列宽」，fixed 生效且留白照旧。
   */
  var sumAll = 0;
  for (i = 0; i < visIds.length; i++) sumAll += widthOf[visIds[i]] || COL_AUTO_MIN;
  var tbl = wrap ? wrap.querySelector('table') : null;
  if (tbl) tbl.style.width = sumAll + 'px';
  // 每列都挂拖拽条：最后一列拖右边缘 = 改它自己的宽度（贴边即停，不会超出容器）
  for (i = 0; i < COLS.length; i++) {
    c = COLS[i];
    if (!colOn(c[0])) continue;
    cols += '<col data-c="' + c[0] + '" style="width:' + (widthOf[c[0]] || COL_AUTO_MIN) + 'px">';
    html += '<th data-c="' + c[0] + '" onmousedown="startResize(event, this)">' + esc(c[1])
      + '<span class="rz"></span></th>';
  }
  $('colgroup').innerHTML = cols;
  $('headRow').innerHTML = html;
}
/** 最小列宽：默认 40；内容更宽的列单独给（拖到底不能把字裁掉）。 */
var MIN_COL = 40;
var COL_MIN = { hit: 58, lastCost: 54, interval: 46 };
/**
 * 操作列最小宽 = 按钮并排的实际宽度（保温 / 清账 / 熔 / ☆ **四个** —— 必须覆盖 tripped 行的最坏
 * 情况，只量三常态按钮会让第 4 个「熔」被 td 的 overflow:hidden 裁掉）。
 * 用隐藏 td 量（同 .ops nowrap、同字体、含 padding），量一次缓存。
 * 量不出来（body 未就绪等）才退回 MIN_COL * 3。
 * ⚠️ style 必须显式 width:auto —— 全局 CSS（table 宽 100%）会把这张隐藏 table 撑到视口宽
 *    （实测量出 1567），minOf('ops') 跟着变 1567：Σ 溢出容器、其余列被压到 40，
 *    还会被 renderHead 写回 colWidths（拖一下松手就污染 state.json）。
 */
var OPS_MIN = 0;
function measureOpsMin() {
  if (OPS_MIN > 0) return OPS_MIN;
  var host = document.body || document.documentElement;
  if (!host) return 0;
  var t = document.createElement('table');
  t.setAttribute('style', 'position:absolute;left:-9999px;top:0;visibility:hidden;table-layout:auto;width:auto');
  t.innerHTML = '<tr><td class="ops"><button>保温</button><button>清账</button>'
    + '<button>熔</button><button>☆</button></td></tr>';
  host.appendChild(t);
  var td = t.querySelector('td');
  var w = td ? Math.ceil(td.getBoundingClientRect().width) : 0;
  host.removeChild(t);
  OPS_MIN = w > 0 ? w : MIN_COL * 3;
  return OPS_MIN;
}
function minOf(id) {
  if (id === 'ops') return Math.max(MIN_COL, measureOpsMin());
  return COL_MIN[id] || MIN_COL;
}
/**
 * 纯计算（无 DOM）：Σ 超容器宽时按比例缩回（每列不低于 mins）；不超则原样返回（保留右侧留白）。
 */
function fitTotal(cur, mins, total) {
  var n = cur.length, out = cur.slice(), i, s = 0;
  for (i = 0; i < n; i++) s += out[i];
  if (!(total > 0) || s <= total) return out;
  var slack = [], slackSum = 0;
  for (i = 0; i < n; i++) { slack[i] = Math.max(0, out[i] - mins[i]); slackSum += slack[i]; }
  var need = s - total;
  if (slackSum <= 0) return out;
  if (need >= slackSum) { for (i = 0; i < n; i++) out[i] = Math.min(out[i], mins[i]); return out; }
  var k = need / slackSum, cut = 0, d;
  for (i = 0; i < n; i++) { d = Math.min(slack[i], Math.round(slack[i] * k)); out[i] -= d; cut += d; }
  var left = need - cut;
  while (left > 0) {
    var bi = -1, bs = 0;
    for (i = 0; i < n; i++) { var sl = out[i] - mins[i]; if (sl > bs) { bs = sl; bi = i; } }
    if (bi < 0) break;
    d = Math.min(bs, left);
    out[bi] -= d; left -= d;
  }
  return out;
}
/** 当前可见列 id，按渲染顺序。 */
function visColIds() {
  var out = [];
  for (var i = 0; i < COLS.length; i++) if (colOn(COLS[i][0])) out.push(COLS[i][0]);
  return out;
}
/** 取（必要时新建）某列的 <col> 元素。 */
function colElOf(id) {
  var el = $('colgroup').querySelector('col[data-c="' + id + '"]');
  if (el) return el;
  el = document.createElement('col');
  el.setAttribute('data-c', id);
  $('colgroup').appendChild(el);
  return el;
}
/**
 * 拖分界线改列宽：**只动本列 + 贴边后压右侧**。
 *
 * 设拖拽条在第 N 列右边缘：
 *   1. 向左拖 → 只压第 N 列，N-1 及左侧、N+1 及右侧一像素不动 ⇒ Σ 变小、右侧留白（预期）；
 *   2. 向右拖 → 先扩第 N 列、右侧不动，直到 Σ = 容器宽（贴边，填留白）；
 *   3. 贴边后继续向右拖 → 拖拽条**继续跟随**：本列增长量 = 从**最右列往左**逐一压到各自 minOf
 *      的**实际让掉量**（先压最后一列，压到底再压倒数第二列；压不动就停），Σ 恒 = 容器宽；
 *   4. 每次 applyResize 都用「起点快照 cur + 相对起点的总位移 d」重算（不累加）⇒
 *      向右压过右侧列后再向左拖回来，被压过的列自动完全还原。
 *
 * 不再强制 Σ = 容器宽：只保证 Σ <= 容器宽（右侧允许留白，不拉伸）。
 */
var RS = null;
/**
 * 纯计算（无 DOM）：cur 各列当前宽（起点快照）、mins 各列最小宽、idx 拖拽列下标、
 * d 相对起点的总位移、total 容器宽。返回 {d: 本列实际变化量, ws: 新宽度数组}。
 * Σws <= total 恒成立；贴边后 Σ = total（本列增长 = 右侧让位量）。最后一列贴边即停（无列可压）。
 * 压缩顺序：贴边后**从最右列往左**逐一压（先末列，压到 minOf 再往左）。
 */
function rsPlan(cur, mins, idx, d, total) {
  var n = cur.length, out = cur.slice(), i, left = Math.round(Number(d) || 0);
  if (idx < 0 || idx >= n) return { d: 0, ws: out };
  if (left === 0) return { d: 0, ws: out };
  if (left < 0) {
    // 只压本列；本列已低于自己的下限时不反向撑大
    out[idx] = Math.min(cur[idx], Math.max(mins[idx], cur[idx] + left));
    return { d: out[idx] - cur[idx], ws: out };
  }
  var base = 0;
  for (i = 0; i < n; i++) base += cur[i];
  var t = Number(total) || 0;
  // room = 还能扩多少（填容器留白）；填满后本列继续增长的量 = 从右侧实际让掉的 pressed
  var room = t > 0 ? Math.max(0, t - base) : left;
  if (left <= room) {
    out[idx] = cur[idx] + left;
    return { d: left, ws: out };
  }
  var over = left - room, pressed = 0;
  // 压缩顺序：**从最右列往左**逐一压到各自 minOf（先压最后一列，压到底再压倒数第二列）
  for (i = n - 1; i > idx && pressed < over; i--) {
    var take = Math.min(Math.max(0, out[i] - mins[i]), over - pressed);
    out[i] -= take;
    pressed += take;
  }
  out[idx] = cur[idx] + room + pressed;
  return { d: room + pressed, ws: out };
}
function startResize(ev, th) {
  var box = th.getBoundingClientRect();
  var target = null;
  if (box.right - ev.clientX <= 9) target = th;
  else if (ev.clientX - box.left <= 9) {
    var prev = th.previousElementSibling;
    if (prev && prev.tagName === 'TH') target = prev;
  }
  if (!target) return;
  var ids = visColIds();
  var idx = ids.indexOf(target.getAttribute('data-c'));
  if (idx < 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  var ths = target.parentNode ? target.parentNode.children : [];
  var cur = [], mins = [], cols = [], i, w, m;
  for (i = 0; i < ids.length; i++) {
    cols.push(colElOf(ids[i]));
    m = /([0-9]+)px/.exec(cols[i].getAttribute('style') || '');
    w = m ? Number(m[1]) : (ths[i] ? ths[i].offsetWidth : 0);
    if (!(w > 0)) w = minOf(ids[i]);
    cur.push(Math.round(w));
    mins.push(minOf(ids[i]));
  }
  var wrap = document.querySelector('.tablewrap');
  var total = ((wrap && wrap.clientWidth) || (document.documentElement.clientWidth - 40) || 1339) - 2;
  RS = {
    ids: ids, idx: idx, cur: cur, mins: mins, cols: cols, total: total,
    tbl: wrap ? wrap.querySelector('table') : null,
    x: ev.clientX, px: ev.clientX, lastWs: null, changed: false, out: null
  };
  document.body.className = (document.body.className + ' resizing').trim();
}
/** 拖动帧节流句柄（0 = 空闲）。 */
var RS_RAF = 0;
document.addEventListener('mousemove', function (ev) {
  if (!RS) return;
  RS.px = ev.clientX;
  // 同一帧内合并多次事件：每改一次列宽都要全表重排，逐事件直接写会掉帧（表现为「一顿一顿」）
  if (RS_RAF !== 0) return;
  RS_RAF = requestAnimationFrame(function () {
    RS_RAF = 0;
    if (!RS) return;
    applyResize();
  });
});
/** 用 RS.px 算一次并把涉及的列宽写下去（值没变就不写，省一次重排）。 */
function applyResize() {
  if (!RS) return;
  var pl = rsPlan(RS.cur, RS.mins, RS.idx, RS.px - RS.x, RS.total);
  var out = {}, i, same = RS.lastWs !== null;
  for (i = 0; i < RS.ids.length; i++) {
    out[RS.ids[i]] = pl.ws[i];
    if (same && pl.ws[i] !== RS.lastWs[i]) same = false;
  }
  if (same) return;
  RS.lastWs = pl.ws;
  RS.out = out;
  RS.changed = false;
  var sumWs = 0;
  for (i = 0; i < RS.ids.length; i++) {
    if (pl.ws[i] !== RS.cur[i]) RS.changed = true;
    sumWs += pl.ws[i];
    RS.cols[i].setAttribute('style', 'width:' + pl.ws[i] + 'px');
  }
  /**
   * 表宽必须跟着 Σ 走：table-layout:fixed 下表宽固定时，某列变窄释放的空间会被浏览器
   * 按比例**分回其它列**（实测左拖 -20：title 288→292、gateNote 255→259、ops 170→173），
   * 视觉上就是「向左拖、左侧内容反而变宽」。renderHead 只在松手后重设，拖拽中也得同步。
   */
  if (RS.tbl) RS.tbl.style.width = sumWs + 'px';
}
document.addEventListener('mouseup', function () {
  if (!RS) return;
  /** 只是点了一下列边界、没有移动 → 什么都不做（不重算列宽、不写盘）。 */
  if (RS.px === RS.x) {
    if (RS_RAF !== 0) { cancelAnimationFrame(RS_RAF); RS_RAF = 0; }
    document.body.className = document.body.className.replace(/\\s*resizing/, '');
    RS = null;
    return;
  }
  if (RS_RAF !== 0) { cancelAnimationFrame(RS_RAF); RS_RAF = 0; }
  applyResize();   // 用最后一次鼠标位置补算，保证松手值 = 最后看到的值
  document.body.className = document.body.className.replace(/\\s*resizing/, '');
  var out = RS.out, changed = RS.changed;
  RS = null;
  if (!out || !changed) return;
  var all = {}, cur = (STATE.settings && STATE.settings[colKey()]) || {}, k;
  for (k in cur) all[k] = cur[k];
  for (k in out) all[k] = out[k];
  STATE.settings[colKey()] = all;
  renderHead();
  var toSave = (STATE.settings && STATE.settings[colKey()]) || all;
  post('/settings', colPatch(toSave)).then(function (d) { if (!d.ok) toast(d.error || '列宽保存失败', true); });
});

/** 可点格：**整格都能点（含文字）**，点开对应详情。 */
function hitCell(s, inner) {
  return '<td class="hit" data-id="' + esc(s.id) + '" onclick="openTimeline(this)">'
    + inner + '</td>';
}

/** 自动候选落选原因（与后端 autoReason 一对一）。 */
/** CAND_WHY 之外、只属于候选列的 3 个显示态（与 CAND_WHY 一起构成「候选文案」那 10 项）。 */
var CAND_EXTRA = { picked: '已加入保温', on: '已手动指定', off: '已关闭保温' };
/** 候选理由的内置文案（用户没覆盖时用它）。 */
function candDefault(key) { return CAND_WHY[key] || CAND_EXTRA[key] || key; }
/** 候选理由实际显示的文案：settings.candText 覆盖优先，没有则回内置。 */
function candWord(key) {
  var ov = (STATE && STATE.settings && STATE.settings.candText) || {};
  return ov[key] || candDefault(key);
}
var CAND_WHY = {
  'never-seen': '未见过活动', 'over-quota': '超条数', 'auto-disabled': '自动关',
  'manual': '手动指定', 'untitled': '无标题', 'subagent': '子代理', 'archived': '已归档',
  'gate': '门禁拦截'
};
/** 候选列：下拉框选模式（下拉框文字颜色反馈语义）+ 自动候选排名 / 落选原因。 */
function candCell(s) {
  var cls = s.mode === 'off' ? 'cand-off' : (s.mode === 'on' ? 'cand-on' : (s.isAutoCandidate ? 'cand-auto' : 'cand-stop'));
  var tag;
  if (s.mode === 'off') tag = '<span class="cand-off">' + esc(candWord('off')) + '</span>';
  else if (s.mode === 'on') tag = '<span class="cand-on">' + esc(candWord('on')) + '</span>';
  else if (s.isAutoCandidate) tag = '<span class="cand-auto">' + esc(candWord('picked')) + ' #' + (Number(s.autoRank) >= 0 ? Number(s.autoRank) : '-') + '</span>';
  else tag = '<span class="cand-stop">' + (s.autoReason ? esc(candWord(s.autoReason)) : '未入选') + '</span>';
  return '<td class="candcell">'
    + '<select class="mode ' + cls + '" data-id="' + esc(s.id) + '" onchange="setMode(this)">'
    + '<option value="auto"' + (s.mode === 'auto' ? ' selected' : '') + '>自动</option>'
    + '<option value="on"' + (s.mode === 'on' ? ' selected' : '') + '>强制开</option>'
    + '<option value="off"' + (s.mode === 'off' ? ' selected' : '') + '>关闭</option>'
    + '</select><br>' + tag + '</td>';
}


/** 「换模型」标记：命中率低不是装配坏了，是缓存池换了（见 core/model-switch.ts）。 */
function switchTag(last) {
  if (!last || last.modelChanged !== true) return '';
  return ' <span class="pill" title="与上一次保温用的不是同一个模型：'
    + esc(String(last.model || '?')) + ' —— 换模型即换缓存池，低命中是必然的，不算熔断">换模型</span>';
}

function renderRow(s) {
  var iv = Number(s.intervalSeconds);
  var ivTxt = isFinite(iv) && iv > 0
    ? (iv >= 3600 ? (iv / 3600).toFixed(iv % 3600 === 0 ? 0 : 1) + ' 小时' : Math.round(iv / 60) + ' 分钟')
    : '-';
  var lastCell = s.last
    ? fmtWhen(s.last.at) + '<br><span class="dim">' + fmtAgo(s.lastTouchAgoMin * 60) + '</span>'
    : '<span class="dim">没保过</span>';
  var hitCellTxt = s.last
    ? '<b class="' + hitClass(s.last.hitRate) + '">'
      + (s.last.hitRate * 100).toFixed(1) + '%</b>' + switchTag(s.last)
    : '<span class="dim">—</span>';
  var tag = (s.id === CURRENT_ID ? '<span class="pill cur">当前</span>' : '')
    + (s.pinnedInPanel ? '<span class="pill pin">置顶</span>' : '')
    + (s.origin === 'subagent' ? '<span class="pill">子代理</span>' : '')
    + (s.titleSource === 'user' ? '<span class="pill">手改</span>' : '')
    + (s.archived ? '<span class="pill arch">归档</span>' : '');
  var titleCell = '<div class="tline">'
    + '<span class="title tl-open" data-id="' + esc(s.id) + '" onclick="openTimeline(this)"'
    + ' title="点开看这条会话的保温记录与对话轮次">'
    + (s.title ? esc(s.title) : '<span class="dim">(无标题)</span>') + '</span>' + tag + '</div>'
    + '<div class="dim mono">' + esc(s.short) + '</div>';
  var ops = warmBtn(s, '保温')
    + '<button data-id="' + esc(s.id) + '" onclick="resetCost(this)" title="开一个新保温周期：总花费保留，本周期花费归零">清账</button>'
    + (s.tripped ? '<button data-id="' + esc(s.id) + '" onclick="resetCircuit(this)" title="熔断中：点此解除熔断（记录保留，历史花费不变）">熔</button>' : '')
    + '<button data-id="' + esc(s.id) + '" data-pin="' + (s.pinnedInPanel ? '1' : '0') + '" onclick="pinRow(this)"'
    + ' title="' + (s.pinnedInPanel ? '取消置顶' : '置顶') + '">' + (s.pinnedInPanel ? '★' : '☆') + '</button>';
  var html = '<tr id="row-' + esc(s.id) + '">';
  if (colOn('title')) html += '<td>' + titleCell + '</td>';
  if (colOn('cand')) html += candCell(s);
  if (colOn('active')) {
    /** 最后活动 = 对话 **或** 保温，取较新的那个（点开时间不参与，它在「最后查看」列）。 */
    var actAt = activeOf(s);
    if (actAt <= 0) {
      html += '<td><b class="dim" title="只被查看过：既没有对话，也没有保温记录">—</b><br>'
        + '<span class="dim">只查看过</span></td>';
    } else {
      // 到期线用**闲置上限**（已与「缓存到期」合并：同一个概念不该两个值）。
      var ttlMs = Math.max(0.1, Number(STATE.settings && STATE.settings.idleLimitHours) || 6) * 3600 * 1000;
      var ratio = (Date.now() - actAt) / ttlMs;
      var ageCls = ratio < 0.5 ? 'ok' : (ratio < 0.8 ? 'warn' : 'bad');
      html += '<td><b class="' + ageCls + '">' + fmtWhen(actAt) + '</b><br><span class="dim">'
        + fmtAgo(Math.round((Date.now() - actAt) / 1000)) + '</span></td>';
    }
  }
  if (colOn('seen')) {
      /* 最后查看 = 点开时间（日志 mtime）。默认不显示，设置页可勾出来。 */
      var seenAt = Number(s.mtime) || 0;
      html += '<td>' + (seenAt > 0
        ? fmtWhen(seenAt) + '<br><span class="dim">' + fmtAgo(Math.round((Date.now() - seenAt) / 1000)) + '</span>'
        : '<span class="dim">—</span>') + '</td>';
    }
    if (colOn('warmed')) html += hitCell(s, lastCell);
  if (colOn('talked')) {
    /* 以前显示 mtime（= 最后查看/写入），与列名对不上；现在只认真实对话时间，未知就显示 — */
    var dlg = Number(s.lastDialogAt) || 0;
    html += '<td>' + (dlg > 0 ? fmtWhen(dlg) : '<span class="dim" title="没有对话记录（或该 snapshot 未提供 lastDialogAt）">—</span>') + '</td>';
  }
  if (colOn('hit')) html += hitCell(s, hitCellTxt);
  if (colOn('lastCost')) html += '<td>' + (s.last ? fmtMoney(s.last.cost) : '-') + '</td>';
  if (colOn('cost')) {
    // 只显示一个口径：本周期花费，或全部保温次数（跟随设置 costScope）
    var scope = (STATE.settings && STATE.settings.costScope === 'total') ? 'total' : 'cycle';
    var costTxt = scope === 'total'
      ? '共 ' + (Number(s.warmCount) || 0) + ' 次'
      : fmtMoney(cycleSpendShown(s));
    html += '<td class="hit" data-id="' + esc(s.id) + '" onclick="openTimeline(this)"'
      + ' title="' + (scope === 'total' ? '全部保温次数（跨周期）' : '本周期花费') + ' · 点开看这条会话的全部记录">'
      + '<span class="nw">' + costTxt + '</span></td>';
  }
  if (colOn('gate')) html += '<td class="gatecell">' + gateHead(s) + '</td>';
  if (colOn('gateNote')) html += '<td>' + gateNoteOf(s) + '</td>';
  if (colOn('interval')) html += '<td class="nw">' + esc(ivTxt) + '</td>';
  if (colOn('ops')) html += '<td class="ops">' + ops + '</td>';
  if (colOn('size')) html += '<td class="mono">' + fmtSize(s.sizeBytes) + '</td>';
  if (colOn('note')) html += '<td><input type="text" class="note" value="' + esc(s.note) + '" placeholder="备注" data-id="' + esc(s.id) + '" onchange="setNote(this)"></td>';
  return html + '</tr>';
}

/** 点候选格：自动 → 强制开 → 关闭 → 自动 */
/** 保温模式的中文名。 */
function modeText(mode) {
  return mode === 'on' ? '强制开' : (mode === 'off' ? '关闭' : '自动');
}

/** 「当前对话」卡里的模式按钮 —— 等价于列表里的下拉，但一眼能点。 */
function setModeBtn(el, mode) {
  post('/policy', { id: el.getAttribute('data-id'), mode: mode }).then(function (d) {
    toast(d.ok ? ('已设为「' + modeText(mode) + '」' + (d.warning ? ' ｜ ' + d.warning : '')) : (d.error || '失败'), !d.ok);
    refresh();
  }).catch(function (e) { toast('失败: ' + e, true); });
}

/**
 * 选出「当前会话」。
 *
 * ① 有 ?current= 就用它（client 页签传进来的，最准）；
 * ② 没有则**兜底取本进程内最近活动的那条** —— 网页版直接从 URL 打开时走这条，
 *    否则这张卡在网页版永远是空的（用户明确要求网页版也要显示）。
 */
function currentSession() {
  if (!STATE) return null;
  var i, s;
  if (CURRENT_ID !== '') {
    for (i = 0; i < STATE.sessions.length; i++) {
      if (STATE.sessions[i].id === CURRENT_ID) return STATE.sessions[i];
    }
  }
  var live = [];
  for (i = 0; i < STATE.sessions.length; i++) {
    s = STATE.sessions[i];
    if (s.live) live.push(s);
  }
  if (live.length > 0) {
    live.sort(function (a, b) {
      var av = a.lastActiveAgoSec < 0 ? 1e9 : a.lastActiveAgoSec;
      var bv = b.lastActiveAgoSec < 0 ? 1e9 : b.lastActiveAgoSec;
      return av - bv;
    });
    return live[0];
  }
  /**
   * ③ 本进程里一条都没有（插件版直接从浏览器打开、或全是历史会话）→ **别空着**：
   *    退而取「最后对话」最近的那条。它不一定能立刻保（离线装配/门禁各自会说话），
   *    但用户至少看得到自己想看的那条，而不是一块空白。全都没有对话时间才返回 null。
   */
  var newest = null, newestAt = -1;
  for (i = 0; i < STATE.sessions.length; i++) {
    s = STATE.sessions[i];
    var dlg = Number(s.lastDialogAt) || 0;
    if (dlg > newestAt) { newestAt = dlg; newest = s; }
  }
  return newestAt > 0 ? newest : null;
}

/**
 * 渲染「当前对话」卡。
 *
 * 内容 = 这条会话的**保温状态** + 模式切换（自动 / 强制开 / 关闭）+ 立刻保温。
 * 会话 id 优先来自 ?current=（页签传的），网页版兜底取最近活动那条并标注「按最近活动推测」。
 */
function renderCurrent() {
  var card = $('currentCard');
  /* CLI 网页版（panel-service）没有活 agent、也没有 ?current= —— 这张卡只对插件版有意义，整块不显示。 */
  if (STATE && STATE.variant === 'cli') { card.style.display = 'none'; return; }
  var s = currentSession();
  if (s === null) { card.style.display = 'none'; return; }

  var guessed = CURRENT_ID === '' || s.id !== CURRENT_ID;
  card.style.display = '';
  var titleText = (s.title || '(无标题)') + ' · ' + s.short + (guessed ? '（按最近活动推测）' : '');
  $('curTitle').innerHTML = '<span class="clickable" title="点开看这条会话的计费与保温" data-id="'
    + esc(s.id) + '" onclick="openTimeline(this)">' + esc(titleText) + '</span>';

  var last = s.last
    ? ('命中 <b class="' + hitClass(s.last.hitRate) + '">'
       + (s.last.hitRate * 100).toFixed(1) + '%</b> · 第 ' + s.last.touch + ' 次 · ' + (s.last.via || '')
       + switchTag(s.last))
    : '<span class="dim">还没保过</span>';

  $('curState').innerHTML =
    '<div class="field"><span class="lab">保温状态</span><b>' + modeText(s.mode) + '</b>'
      + (s.mode === 'off' ? ' <span class="hint">（不保）</span>' : '') + '</div>'
    + '<div class="field"><span class="lab">门禁</span>' + gateHtml(s) + '</div>'
    + '<div class="field"><span class="lab">上次保温</span>' + last + '</div>'
    + '<div class="field"><span class="lab">本期</span>' + fmtMoney(cycleSpendShown(s)) + ' / ' + (s.cycleCount || 0) + ' 次</div>'
    + '<div class="field"><span class="lab">累计</span>' + fmtMoney(s.spend) + ' / ' + s.count + ' 次</div>'
    + '<div class="field"><span class="lab">自动候选</span>' + candLabel(s) + '</div>';

  $('curOps').innerHTML =
    '<button data-id="' + esc(s.id) + '" onclick="setModeBtn(this,&#39;auto&#39;)"' + (s.mode === 'auto' ? ' disabled' : '') + '>自动</button>'
    + '<button data-id="' + esc(s.id) + '" onclick="setModeBtn(this,&#39;on&#39;)"' + (s.mode === 'on' ? ' disabled' : '') + '>强制开</button>'
    + '<button data-id="' + esc(s.id) + '" onclick="setModeBtn(this,&#39;off&#39;)"' + (s.mode === 'off' ? ' disabled' : '') + '>关闭</button>'
    + warmBtn(s, '立刻保温', 'primary');
}

function render() {
  if (!STATE) return;
  /* 详情模式只显示时间轴：列表一律不渲染，连静态占位行也清掉（否则 #rows 里还有一行「加载中…」） */
  if (IS_DETAIL) { $('rows').innerHTML = ''; return; }
  if (!RS) {
    renderHead();
  }
  document.documentElement.style.setProperty('--cellgap', '8px');
  var list = filtered();
  var size = Math.max(10, Number($('pageSize').value) || 50);
  if (SHOWN < size) SHOWN = size;
  var page = list.slice(0, SHOWN);
  $('rows').innerHTML = page.length
    ? page.map(renderRow).join('')
    : '<tr><td colspan="10" class="dim">没有匹配的会话</td></tr>';
  $('pagerInfo').textContent = '显示 ' + page.length + ' / ' + list.length + ' 条（磁盘共 ' + STATE.diskCount
    + '，本进程内 ' + STATE.liveCount + '）';
  $('more').style.display = page.length < list.length ? '' : 'none';
  /* 「定位本会话」只对插件版有意义：CLI 网页版没有 ?current= */
  document.body.classList.toggle('v-cli', STATE.variant === 'cli');
  document.body.classList.toggle('v-plugin', STATE.variant !== 'cli');
  if ($('gotoCur')) $('gotoCur').style.display = (STATE.variant === 'cli') ? 'none' : '';
  /* 网页版不需要「打开网页版」这个按钮（它本身就是网页版） */
  if ($('openWeb')) $('openWeb').style.display = (STATE.variant === 'cli') ? 'none' : '';
  /* CLI 版：panel-service 把 live 恒设 true → 「只看本进程」永远空操作，别摆个点了没反应的按钮 */
  if ($('onlyLive')) {
    $('onlyLive').style.display = (STATE.variant === 'cli') ? 'none' : '';
    $('onlyLive').title = (STATE.variant === 'cli')
      ? 'CLI 版没有「本进程内」这个概念（所有会话一视同仁）'
      : '只显示本进程内活着的会话；纯显示筛选，不影响保温范围';
  }
  $('stat').textContent = '共 ' + STATE.sessions.length + ' 条，其中归档 ' + STATE.sessions.filter(function (s) { return s.archived; }).length + ' 条';
  renderCurrent();
}

/** 需要保持勾选的列（多选，勾选态合法）。 */
var FIXED_COLS = { title: 1, cand: 1, hit: 1, cost: 1, gate: 1, ops: 1 };
/** 门禁文案设置：两栏罗列，placeholder 是默认值。 */
/** 已展开「内置文案」的行（key → true），15 秒自动刷新重建后仍保持展开。 */
var BUILTIN_OPEN = {};
/** 「门禁文案」两栏分隔线的拖动状态。 */
var GS = null;
function startGateSplit(ev) {
  ev.preventDefault();
  var row = ev.target.parentNode;
  var wIn = row.querySelector('input.w');
  GS = { x: ev.clientX, w: wIn ? wIn.offsetWidth : 170 };
  document.body.className = (document.body.className + ' resizing').trim();
}
document.addEventListener('mousemove', function (ev) {
  if (!GS) return;
  var w = Math.max(80, Math.min(600, Math.round(GS.w + ev.clientX - GS.x)));
  GS.w2 = w;
  document.documentElement.style.setProperty('--gatewordw', w + 'px');
});
document.addEventListener('mouseup', function () {
  if (!GS) return;
  document.body.className = document.body.className.replace(/\\s*resizing/, '');
  var w = GS.w2;
  GS = null;
  if (!w) return;
  post('/settings', { gateWordWidth: w }).then(function (d) {
    if (!d.ok) toast(d.error || '保存失败', true);
  });
});
function builtinText(d) {
  // 状态词输入框里已经显示着，这里只回默认说明
  return esc(d.detail || '（这条没有说明）');
}
function paintGateRows(st) {
  /**
   * 正在这张表里编辑就**不重建**：整块 innerHTML 重建会换掉输入框节点 → 焦点丢失。
   * dirty 标志只在打字（input）时置位，单纯点一下不算脏，所以这里必须再加一道焦点守卫。
   */
  var box = $('gateRows');
  if (box && box.contains(document.activeElement)) return;
  var list = (STATE && STATE.gateTexts) || [];
  var ovT = st.gateText || {}, ovD = st.gateDetail || {};
  var html = '';
  for (var i = 0; i < list.length; i++) {
    var d = list[i];
    var tip = d.vars && d.vars.length ? ('可用变量：' + d.vars.join(' ')) : '无变量';
    html += '<div class="gt-row" data-key="' + esc(d.key) + '">'
      + '<input class="w" type="text" data-k="text" value="' + esc(ovT[d.key] || d.text)
      + '" title="' + esc(d.text + '（' + d.key + '）· 门禁列里显示的状态词') + '">'
      + '<span class="gt-split" onmousedown="startGateSplit(event)"></span>'
      + '<input class="d" type="text" data-k="detail" value="' + esc(ovD[d.key] || d.detail)
      + '" title="' + esc(d.text + '（' + d.key + '）· ' + tip) + '">'
      + '<button class="mini" onclick="seeBuiltin(this)" title="看这一条的内置文案（不改输入框）">内置文案</button>'
      + '<button class="mini" onclick="resetOneGate(this)" title="只把这一条恢复成内置文案">恢复内置</button>'
      + '</div>'
      + '<div class="gt-builtin"' + (BUILTIN_OPEN[d.key] ? '' : ' style="display:none"') + '>'
      + (BUILTIN_OPEN[d.key] ? builtinText(d) : '') + '</div>';
  }
  $('gateRows').innerHTML = html;
  GATE_SNAP = gateSig();
  var w = Number(st.gateWordWidth);
  document.documentElement.style.setProperty('--gatewordw', (isFinite(w) && w > 0 ? w : 170) + 'px');
}

/** 候选文案的输入行（key 一行一条；与门禁文案同一套 .gt-row / .mini 样式）。 */
function paintCandRows(st) {
  var cbox = $('candRows');
  if (cbox && cbox.contains(document.activeElement)) return;
  var opts = candOpts(), ov = (st && st.candText) || {}, html = '', i;
  for (i = 0; i < opts.length; i++) {
    var k = opts[i][0];
    html += '<div class="gt-row" data-key="' + esc(k) + '">'
      + '<span class="gt-key">' + esc(k) + '</span>'
      + '<input class="d" type="text" data-k="text" value="' + esc(ov[k] || candDefault(k))
      + '" title="' + esc(k + ' · 候选列里显示的文字') + '">'
      + '<button class="mini" onclick="resetOneCand(this)" title="只把这一条恢复成内置文案">恢复内置</button>'
      + '</div>';
  }
  $('candRows').innerHTML = html;
  CAND_SNAP = candSig();
}
/** 两个文案表的「当前输入值指纹」：用来判断有没有真的改动（无改动就不该提交、也不该弹「已保存」）。 */
var GATE_SNAP = '';
var CAND_SNAP = '';
function gateSig() {
  var rows = $('gateRows').querySelectorAll('.gt-row'), out = [], i;
  for (i = 0; i < rows.length; i++) {
    var t = rows[i].querySelector('input[data-k="text"]');
    var d = rows[i].querySelector('input[data-k="detail"]');
    out.push(rows[i].getAttribute('data-key') + ':' + (t ? t.value : '') + '\u0001' + (d ? d.value : ''));
  }
  return out.join('\u0002');
}
function candSig() {
  var rows = $('candRows').querySelectorAll('.gt-row'), out = [], i;
  for (i = 0; i < rows.length; i++) {
    var t = rows[i].querySelector('input[data-k="text"]');
    out.push(rows[i].getAttribute('data-key') + ':' + (t ? t.value : ''));
  }
  return out.join('\u0002');
}
/** 保存候选文案：与内置相同的、空的都不入库（空串 = 删掉该 key，回默认）。 */
function saveCandTable(okMsg) {
  var t = {}, rows = $('candRows').querySelectorAll('.gt-row');
  for (var i = 0; i < rows.length; i++) {
    var k = rows[i].getAttribute('data-key');
    var v = rows[i].querySelector('input[data-k="text"]').value.trim();
    if (v && v !== candDefault(k)) t[k] = v;
  }
  post('/settings', { candText: t }).then(function (r) {
    if (r.ok) CAND_DIRTY = false;
    toast(r.ok ? (okMsg || '候选文案已保存') : (r.error || '失败'), !r.ok);
    refresh();
  });
}
/** 只恢复这一条。 */
function resetOneCand(btn) {
  var row = btn.parentNode;
  var k = row.getAttribute('data-key');
  row.querySelector('input[data-k="text"]').value = candDefault(k);
  saveCandTable('「' + candDefault(k) + '」已恢复内置');
}
function paintColToggles(st) {
  var box = $('colToggles');
  if (!box) return;
  var st2 = (st && st.columns) || {};
  var html = '';
  for (var i = 0; i < COLS.length; i++) {
    var c = COLS[i];
    var on = typeof st2[c[0]] === 'boolean' ? st2[c[0]] : (c[2] === 1);
    var fixed = FIXED_COLS[c[0]] === 1;
    html += '<button class="toggle' + (on ? ' on' : '') + '" data-on="' + (on ? '1' : '0') + '" data-col="' + c[0] + '"'
      + (fixed ? ' disabled title="这一列固定显示"' : ' onclick="flipCol(this)"') + '>' + esc(c[1]) + '</button>';
  }
  box.innerHTML = html;
}
function collectCols() {
  var out = {};
  var box = $('colToggles');
  if (!box) return out;
  var xs = box.getElementsByTagName('button');
  for (var i = 0; i < xs.length; i++) {
    var col = xs[i].getAttribute('data-col');
    if (col) out[col] = xs[i].getAttribute('data-on') === '1';
  }
  return out;
}

function renderSettings(st) {
  /** 守护循环开着（--serve --auto）→ 顶部红字常驻：它在真实 home 上花真钱。 */
  var lw = $('loopWarn');
  if (lw) {
    var loopOn = !!(STATE && STATE.loopEnabled === true);
    lw.textContent = loopOn ? '⚠️ 自动保温已开启：按策略在真实 home 上花真实费用（每 60 秒一拍）' : '';
    lw.style.display = loopOn ? '' : 'none';
  }
  setToggle($('autoEnabled'), !!st.autoEnabled);
  $('autoCount').value = st.autoCount;
  $('idleLimitHours').value = st.idleLimitHours === undefined ? 8 : st.idleLimitHours;
  setToggle($('autoAllowSubagent'), !!st.autoAllowSubagent);
  $('intervalSeconds').value = st.intervalSeconds;
  $('freshSeconds').value = st.freshSeconds === undefined ? 300 : st.freshSeconds;
  paintColToggles(st);
  /* 门禁文案正在编辑时不重画 —— 15 秒自动刷新会把没保存的文本冲掉（用户要求「点别处不重置」） */
  if (!GATE_DIRTY) paintGateRows(st);
  if (!CAND_DIRTY) paintCandRows(st);
  $('timelineCacheMinutes').value = st.timelineCacheMinutes === undefined ? 10 : st.timelineCacheMinutes;
  $('maxTouches').value = st.maxTouches;
  $('maxTouchesTotal').value = st.maxTouchesTotal === undefined ? 0 : st.maxTouchesTotal;
  $('budgetPerSession').value = st.budgetPerSession;
  $('prompt').value = st.prompt;
  $('maxTokens').value = st.maxTokens;
  $('circuitCooldownSeconds').value = st.circuitCooldownSeconds;
  paintCircuitRate(st.circuitHitRate);
  paintLabExpose(st);
  setToggle($('exposeKeepaliveTool'), st.exposeKeepaliveTool !== false);
  paintTgl(st);
  paintCostScope(st);
  /* 正在编辑的表不重画 —— 15 秒一次的自动刷新会把没保存的草稿冲掉（见 MODELS_DIRTY 的说明） */
  if (!MODELS_DIRTY) paintModelRows();
  if (!TARIFF_DIRTY) paintTariff(st.tariff);
  var p = st.prices || { hit: 0.02, miss: 1, out: 4 };
  $('priceHit').value = p.hit;
  $('priceMiss').value = p.miss;
  $('priceOut').value = p.out;
  // 用当前价算出 w/r（一次冷启动 = 多少次保温的保费），改价后自动跟着变
  var wr = (p.miss > 0 && p.hit > 0) ? Math.round(p.miss / p.hit) : 50;
  $('wrRatio').textContent = wr;
  $('wrBox').textContent = wr + ' 次保温';
  $('toolsState').textContent = '主工具 ' + (st.exposeKeepaliveTool !== false ? '● 已注册' : '○ 已注销')
    + ' ｜ 测验台 ' + (st.exposeLabTools !== false ? '● 已注册' : '○ 已注销');
  $('toolsState').className = 'hint' + (st.exposeLabTools !== false ? ' ok' : ' dim');
}

/* ── 二级页面切换（保温 / 设置） ─────────────────────────────────── */
var TABS = ['main', 'settings'];
function switchTab(name) {
  var i, id;
  for (i = 0; i < TABS.length; i++) {
    id = TABS[i];
    $('page-' + id).className = 'page' + (id === name ? ' on' : '');
    $('tab-' + id).className = 'tab' + (id === name ? ' on' : '');
  }
  try { localStorage.setItem('cache-keepalive:tab', name); } catch (e) { /* 隐私模式等，忽略 */ }
}

/**
 * 拉一次状态。
 * 手动点「刷新」时给按钮加进行中反馈（禁用 + 改文案），完成后 toast 结果；
 * 15 秒的自动刷新走静默路径，不打扰。
 */
function refresh(manual) {
  var btn = $('refresh');
  var isManual = manual === true;
  if (isManual) { btn.disabled = true; btn.textContent = '刷新中…'; }
  var done = function (ok, msg) {
    if (isManual) { btn.disabled = false; btn.textContent = '刷新'; }
    if (!ok) {
      /* 失败也要重贴筛选面板文案：首帧 / 持续异常时 STATE 是空的，
         不刷就会把英文 key（too-soon 之类）一直摆在用户面前。 */
      msRelabel();
      toast(msg || '读取失败', true);
      return;
    }
    $('lastRefresh').textContent = '最后刷新 ' + fmtClock(Date.now()) + ' ｜ 每 15 秒自动刷一次';
    if (isManual) {
      toast('已刷新 ｜ ' + STATE.sessions.length + ' 条会话，本进程内 ' + STATE.liveCount + ' 条');
    }
  };
  return fetch(API + '/state').then(function (r) { return r.json(); }).then(function (d) {
    if (!d.ok) { done(false, d.error); return; }
    STATE = d.state;
    renderSettings(STATE.settings);
    render();
    msRelabel();
    done(true);
  }).catch(function (e) { done(false, '读取失败: ' + e); });
}

function post(path, body) {
  return fetch(API + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  }).then(function (r) { return r.json(); });
}

function setMode(el) {
  post('/policy', { id: el.getAttribute('data-id'), mode: el.value }).then(function (d) {
    if (!d.ok) { toast(d.error || '设置失败', true); return; }
    toast('已设为「' + modeText(el.value) + '」' + (d.warning ? ' ｜ ' + d.warning : ''));
    refresh();
  }).catch(function (e) { toast('设置失败: ' + e, true); });
}
function setNote(el) {
  post('/policy', { id: el.getAttribute('data-id'), note: el.value }).then(function (d) {
    toast(d.ok ? '备注已保存' : (d.error || '保存失败'), !d.ok);
  });
}
function resetCircuit(el) {
  // 不删记录：只给熔断前那条低命中打「解熔」标记（视同 100%），历史与花费全部保留
  if (!confirm('解除熔断不会删除任何保温记录（历史花费照常显示）。'
    + '只是把这次低命中标记为「解熔」、视同 100% 命中，让门禁放行。确定？')) return;
  post('/reset', { id: el.getAttribute('data-id') }).then(function (d) {
    toast(d.ok ? '熔断已解除（记录保留，之前那次低命中视同 100%）' : (d.error || '失败'), !d.ok);
    refresh();
  }).catch(function (e) { toast('失败: ' + e, true); });
}
/* ── 时间轴：每轮真实计费 + 保温（按时间合并） ───────────────────── */
function fmtClock(ms) {
  var d = new Date(ms);
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
/** token 数量格式化：4129 → 4.1k；299611 → 299.6k；小于 1000 原样。 */
function fmtTok(n) {
  var v = Number(n) || 0;
  if (v < 1000) return String(v);
  return (v / 1000).toFixed(1) + 'k';
}
/** 工具面比对的措辞（与 core/rewrite.ts 的 FACE_TXT 保持一致）。 */
var FACE_TXT = {
  same: '工具面未变',
  'def-changed': '工具定义变了',
  'toolset-changed': '工具增删',
  unknown: '工具面未确认'
};
/**
 * 计算轮次（压缩 / 剪枝 / goal）的右侧说明。
 * 左侧徽标只写「压缩/剪枝 N 个事件」，量（token）与原因（剪掉了什么、工具面）都放这里。
 */
/** 「4.1k tok」这数字是被遮蔽内容的历史规模，不是花费。 */
var TOK_TIP = '被遮蔽掉的历史规模，用来解释这轮之后缓存为什么失效';
function markBits(it, withTip) {
  var bits = [];
  var sub = it.sub || (it.gran === 'goal' ? 'goal' : '');
  if (sub === 'goal') {
    /** header 里没有 system，无法确认 goal 到底改没改 —— 只能写「可能」。 */
    bits.push('系统提示词可能被改写');
    bits.push('之后没有真实请求就不保');
    return bits;
  }
  if (Number(it.shadowedTokens) > 0) {
    var tokTxt = fmtTok(it.shadowedTokens) + ' tok';
    bits.push(withTip === true ? ('<span title="' + TOK_TIP + '">' + tokTxt + '</span>') : tokTxt);
  }
  if (sub === 'summary') {
    bits.push('历史摘要化');
  } else {
    bits.push(dropReason(it.droppedTypes));
  }
  bits.push(FACE_TXT[it.toolFace] || FACE_TXT.unknown);
  bits.push('之后没有真实请求就不保');
  return bits;
}
/** 被剪掉的是什么：tool/result 占多数 → 工具输出；否则 → 历史对话。 */
function dropReason(dist) {
  var o = dist || {}, total = 0, tool = 0, k;
  for (k in o) {
    if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
    var n = Number(o[k]) || 0;
    total += n;
    if (k === 'tool/result') tool += n;
  }
  if (total > 0 && tool * 2 > total) return '剪掉工具输出';
  return '剪掉历史对话';
}
/** 时间轴当前数据 + 视图偏好（偏好持久化 —— 用户要求「记住是否逆序」）。 */
var TL_DATA = null;
/** 当前详情浮层打开的是哪条会话（空串 = 没开）。改价后要按它重拉。 */
var TL_OPEN_ID = '';
var TLS_KEY = 'cache-keepalive:timeline:v2';
/**
 * 旧键。老版本面板（没有换新哨兵、且是整份写盘）若还活着，只能写这个键 ——
 * 换键之后它再也糊不到新值（实测用户浏览器里那份旧文档每开一次详情就整份写回默认值）。
 */
var TLS_KEY_OLD = 'cache-keepalive:timeline';
/**
 * 只写 patch 里列出的字段（读-改-写）。
 * 绝不做「整份写盘」：插件版有两份文档各持一套控件（主面板 iframe + 详情 iframe），
 * 谁后写谁就把对方写的整张糊掉 —— 这是「选项记不住」的根因，只能靠逐字段写根治。
 */
function patchTlPref(patch) {
  var cur = {};
  try { var rawP = localStorage.getItem(TLS_KEY); cur = rawP ? JSON.parse(rawP) : {}; } catch (e) { cur = {}; }
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) cur = {};
  for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) { cur[k] = patch[k]; if (TL_PREFS) TL_PREFS[k] = patch[k]; }
  try { localStorage.setItem(TLS_KEY, JSON.stringify(cur)); } catch (e) { try { toast('偏好存不下: ' + e, true); } catch (e2) { /* toast 都没有就算了 */ } }
}
/** 读到的偏好（loadTlPrefs 暂存，applyTlPrefs 负责套到控件上）。 */
var TL_PREFS = null;
function loadTlPrefs() {
  try {
    var raw = localStorage.getItem(TLS_KEY);
    if (!raw) {
      /* 一次性迁移：新键没有、旧键有 → 搬过来（写完新键就再也不会重搬，旧文档只写得动旧键） */
      var oldRaw = localStorage.getItem(TLS_KEY_OLD);
      if (!oldRaw) { TL_PREFS = null; return; }
      raw = oldRaw;
      try { localStorage.setItem(TLS_KEY, raw); } catch (e0) { /* 存不下就只当本次生效 */ }
    }
    var f = JSON.parse(raw);
    TL_PREFS = (f && typeof f === 'object' && !Array.isArray(f)) ? f : null;
  } catch (e) { TL_PREFS = null; try { toast('偏好读不出: ' + e, true); } catch (e2) { /* 忽略 */ } }
}
/**
 * 把 TL_PREFS 套到控件上。
 * **时机是关键**：#tlCycle 的 option 由 renderTimeline 按数据重建，建之前给它赋值会被浏览器丢掉，
 * 所以 loadTlPrefs 阶段一个控件都不碰，统一在这里套（初始化一次 + 每次重建选项后再套）。
 */
function applyTlPrefs() {
  var f = TL_PREFS;
  if (!f) return;
  if (typeof f.desc === 'boolean') setToggle($('tlDesc'), f.desc);
  var kd = f.kind === 'mark' ? 'all' : f.kind;
  if (kd === 'all' || kd === 'round' || kd === 'warm' || kd === 'compaction' || kd === 'goal') $('tlKind').value = kd;
  if (f.gran === 'step' || f.gran === 'turn' || f.gran === 'both') $('tlGran').value = f.gran;
  if (f.sort === 'time' || f.sort === 'hit' || f.sort === 'cost') $('tlSort').value = f.sort;
  if (typeof f.rev === 'boolean') setToggle($('tlRev'), f.rev);
  if (typeof f.skipFirst === 'boolean') setToggle($('tlSkipFirst'), f.skipFirst);
  /* 周期：只有选项里真有这个值才设（选项来自数据），否则保持「全部周期」——偏好仍在存档里 */
  if (typeof f.cycle === 'string' && f.cycle !== '') {
    if ($('tlCycle').querySelector('option[value="' + f.cycle + '"]')) $('tlCycle').value = f.cycle;
  }
}

/**
 * 打开会话时间轴。
 * @param el   带 data-id 的元素
 * @param kind 可选初始筛选（'round' / 'warm' / 'all'）——
 *             点列表里「上次保温」那一格会传 'warm'，直接只看保温记录。
 */
/**
 * 覆盖层交给宿主（插件版）：把「使用说明」的 HTML / 「详情页」的地址 postMessage 给父页，
 * 由宿主的文档层渲染（不再困在 iframe 里）。**250ms 内没收到带同一 nonce 的 ACK 就自己弹** ——
 * 宿主没实现 / 不是被嵌入 / 消息被拦，行为与今天完全一致。
 */
var OVERLAY_ACK = {};
var OVERLAY_HOST_ORIGIN = '*';
/** 测试口子：生产恒为 null（取真正的 window.parent）；自动化测试塞一个假宿主进来。 */
var OVERLAY_HOST_OVERRIDE = null;
function hostParent() {
  if (OVERLAY_HOST_OVERRIDE !== null) return OVERLAY_HOST_OVERRIDE;
  return (window.parent && window.parent !== window) ? window.parent : null;
}
window.addEventListener('message', function (ev) {
  var d = ev.data;
  if (!d || d.type !== 'cache-keepalive:overlay-ack') return;
  if (typeof d.nonce !== 'string') return;
  OVERLAY_ACK[d.nonce] = Date.now();
  /* 宿主回了 origin → 之后只往它发（覆盖层里带会话标题，不该再广播） */
  /* 注意：这里不能用「带转义斜杠」的正则 —— PANEL_SRC 是模板字符串，反斜杠转义会在求值时被吃掉，
     浏览器拿到的是坏语法（真实事故：面板整页白屏卡在「加载中」）。所以用纯字符串判断。 */
  if (typeof d.origin === 'string' && d.origin.slice(0, 4) === 'http') OVERLAY_HOST_ORIGIN = d.origin;
});
/**
 * 在浏览器里打开这块面板：桌面版 Electron 把 http(s) 的 window.open 转成 shell.openExternal，
 * 于是落到系统默认浏览器；若设置里选「DSH 右栏内嵌」（panelOpenMode=sidebar）且当前在 iframe 里，
 * 就把请求 postMessage 给宿主（面板拿不到 sidebarRight 服务，跨源所以用 *）。
 * 地址直接用同源绝对地址拼：__CK_PANEL_ABS__ 的注入已删，留着只作兼容兜底。
 */
function openWebPanel() {
  var url = window.__CK_PANEL_ABS__ || (window.location.origin + API + '/panel');
  var mode = (STATE && STATE.settings) ? STATE.settings.panelOpenMode : 'browser';
  if (mode === 'sidebar' && window.parent && window.parent !== window) {
    try {
      window.parent.postMessage({ type: 'cache-keepalive:open-panel', url: url }, '*');
      toast('已请 DSH 在右栏打开');
      return;
    } catch (e) { /* 转不过去就落回系统浏览器 */ }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
/** 面板自己的地址（详情页交给宿主时会开成同源 iframe，所以参数要能被本页认出来）。 */
function panelSelfUrl(extra) {
  var base = window.location.origin + window.location.pathname;
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + extra;
}
/**
 * 试一次宿主覆盖层。返回句柄；返回 null 表示"没有宿主，直接自己弹"。
 * kind='help' 传 HTML（纯静态），kind='tl' 传 url（宿主开同源 iframe，交互仍在面板里）。
 */
function overlayTryHost(kind, extra) {
  /* 详情页（tl=）自己就在宿主覆盖层的 iframe 里，再请求会让宿主再开一个同样的 iframe（无限嵌套）。
     主面板（embed=1 但没 tl=）必须照常委托，否则覆盖层根本不出现。 */
  if (IS_DETAIL) return null;
  var parentWin = hostParent();
  if (parentWin === null) return null;
  if (STATE && STATE.variant === 'cli') return null;
  var nonce = 'ov-' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2, 8);
  var msg = { type: 'cache-keepalive:overlay', v: 1, kind: kind, nonce: nonce };
  if (kind === 'help') {
    var box = $('help') && $('help').getElementsByClassName('box')[0];
    /**
     * 宿主覆盖层自带标题栏和「✕ 关闭（Esc）」，而 #helpClose 在宿主文档里没绑事件（死按钮）。
     * 所以只在「发给宿主的这份 HTML」里剥掉它；面板自己的 DOM 保留 ——
     * 网页版没有 ESC 绑定，删了面板里的它网页版就关不掉说明页了。
     */
    msg.html = box ? (function () { var c = box.cloneNode(true); var x = c.querySelector('#helpClose'); if (x) x.remove(); return c.outerHTML; })() : ($('help') ? $('help').innerHTML : '');
  } else {
    msg.url = panelSelfUrl('embed=1&tl=' + encodeURIComponent(String(extra || '')));
    msg.id = String(extra || '');
  }
  try {
    parentWin.postMessage(msg, OVERLAY_HOST_ORIGIN);
  } catch (e) {
    return null;
  }
  return { nonce: nonce };
}
/** 宿主是否接管了这次覆盖层（ACK 的 nonce 必须对得上，防止迟到的 ACK 把下一次误判成已接管）。 */
function overlayTaken(h) {
  return !!h && OVERLAY_ACK[h.nonce] !== undefined;
}
/** 关掉宿主那层（面板内的关闭按钮也要通知它，否则两边状态不同步）。 */
function overlayCloseHost() {
  var parentWin = hostParent();
  if (parentWin === null) return;
  try {
    parentWin.postMessage({ type: 'cache-keepalive:overlay-close', v: 1 }, OVERLAY_HOST_ORIGIN);
  } catch (e) { /* 没有宿主就算了 */ }
}

/**
 * 宿主是否正在显示某个覆盖层（说明页 / 时间轴）。
 * 插件版里这两个覆盖层是宿主画的，面板自己的 #help / #tl 是隐藏的 ——
 * 所以「关掉」必须同时考虑本地 DOM 和这个标记。
 */
var OVERLAY_HOSTED = { help: false, tl: false };
/** 关说明页：本地显示或宿主接管，任一成立就算关掉。返回是否真的关了。 */
function closeHelpAny() {
  var local = !!($('help') && $('help').style.display === 'block');
  if (local) $('help').style.display = 'none';
  var hosted = OVERLAY_HOSTED.help;
  OVERLAY_HOSTED.help = false;
  return local || hosted;
}
/** 关时间轴（同上）。 */
function closeTlAny() {
  var local = !!($('tl') && $('tl').style.display === 'block');
  if (local) $('tl').style.display = 'none';
  var hosted = OVERLAY_HOSTED.tl;
  OVERLAY_HOSTED.tl = false;
  return local || hosted;
}
/** 关节假日表弹层（它用 class=show，不是 style.display）。 */
function closeHolidayAny() {
  var box = $('holidayBox');
  if (!box) return false;
  var open = String(box.className || '').indexOf('show') >= 0;
  if (open) box.className = '';
  return open;
}
/**
 * 打开某个会话的时间轴详情。
 * **不看是从哪一列点进来的** —— 「只看」的唯一来源是用户在详情里手选那个下拉框，
 * 点列只负责打开同一个详情（用户口径：任何列进入都是相同的）。
 */
function openTimeline(el) {
  var id = el.getAttribute('data-id');
  /* 交给宿主渲染（宿主开同源 iframe，交互不丢）；没宿主 / 没 ACK 就按老样子自己弹 */
  var host = overlayTryHost('tl', id);
  if (host !== null) {
    $('tlTitle').textContent = '加载中…';
    $('tlSub').textContent = '';
    $('tlSum').innerHTML = '';
    $('tlAxis').innerHTML = '';
    OVERLAY_HOSTED.tl = true;
    setTimeout(function () {
      if (overlayTaken(host)) return;
      OVERLAY_HOSTED.tl = false;
      showTimelineLocal(id);
    }, 250);
    return;
  }
  showTimelineLocal(id);
}

/** 面板自己弹时间轴（老路径）。 */
function showTimelineLocal(id) {
  TL_OPEN_ID = id;
  $('tlTitle').textContent = '加载中…';
  $('tlSub').textContent = '';
  $('tlSum').innerHTML = '';
  $('tlAxis').innerHTML = '<div class="dim" style="padding:12px">正在读会话日志（全量解压，稍等）…</div>';
  $('tl').style.display = 'block';
  fetchTimeline(id);
}

/**
 * 拉一次时间轴数据（按当前粒度）。
 * 粒度是**后端**算的（聚合要读全量日志），所以改粒度必须重新请求，不能前端筛。
 */
function fetchTimeline(id) {
  post('/timeline', { id: id, granularity: $('tlGran').value }).then(function (d) {
    if (!d.ok) {
      TL_DATA = null;
      $('tlTitle').textContent = d.error || '读取失败';
      $('tlAxis').innerHTML = '';
      return;
    }
    TL_DATA = d;
    renderTimeline(d);
  }).catch(function (e) {
    TL_DATA = null;
    $('tlTitle').textContent = '读取失败: ' + e;
    $('tlAxis').innerHTML = '';
  });
}

/**
 * 详情浮层开着就用当前 id 与粒度**重拉一次**。
 *
 * 为什么需要：账本 entry.cost 是记账时的价快照，展示按**当前价**重算 ——
 * 保存价格 / 门槛 / 模型价表之后不重拉，浮层里的金额要等 15 秒自动刷新才变，
 * 用户会以为「改了价没生效」（这是 10-25 那条 6fabda6「改价后详情立即重拉」的落点）。
 */
function reloadTimelineIfOpen() {
  if (TL_OPEN_ID === '' || TL_DATA === null) return;
  if ($('tl').style.display !== 'block') return;
  fetchTimeline(TL_OPEN_ID);
}

/** 按当前控件重排重绘（改筛选 / 改排序 / 点「最新在最上」都走这里）。 */
/** 保温触发方式的显示名。 */
var VIA_TXT = { auto: '自动', panel: '面板', tool: '工具', cli: 'CLI', manual: '手动' };
/** 离线装配保的记录单独标出来：只显示「自动」时分不清是本进程还是历史会话。 */
function viaLabel(it) { return (VIA_TXT[it.via] || '手动') + (it.offline === true ? '·离线' : ''); }

/**
 * 排序用的时刻：**整轮合计用 endTime**（该轮最后一笔），其余用 time。
 * 只按 time 排会让合计（= 该轮首笔）排在自己那些调用**下面** —— 默认「最新在最上」时
 * 看起来就是"最新的几个调用没有合计"。
 */
function sortTimeOf(it) {
  var e = Number(it.endTime || 0);
  return e > 0 ? e : Number(it.time || 0);
}
function paintTimeline() {
  var d = TL_DATA;
  if (!d) return;
  var desc = tglOn('tlDesc');
  var kind = $('tlKind').value;
  var by = $('tlSort').value;
  var items = d.items.slice();
  if (kind === 'round') items = items.filter(function (it) { return it.kind === 'round'; });
  // 「只看保温」把计算轮次一起带上 —— 用户想弄清「这一轮之后为什么没保」
  if (kind === 'warm') items = items.filter(function (it) { return it.kind === 'warm' || it.kind === 'mark'; });
  if (kind === 'compaction') items = items.filter(function (it) { return it.kind === 'mark' && it.gran === 'compaction'; });
  if (kind === 'goal') items = items.filter(function (it) { return it.kind === 'mark' && it.gran === 'goal'; });
  /**
   * 筛除第一轮：第 1 轮必然是冷启动（前缀还没建立，命中率必然接近 0），
   * 留着会把整体命中率拉低，看不出稳态水平。两种粒度下一并筛掉（both 模式下 T1 有两项）。
   */
  if (tglOn('tlSkipFirst')) {
    items = items.filter(function (it) {
      return !(it.kind === 'round' && Number(it.turn) === 1);
    });
  }
  /* 按保温周期筛：选了某周期就只留该周期的保温记录（对话轮次没有周期概念，一并隐去）。
     ⚠️ 这两段是**并列**的独立筛选，别再被上面那个 if 包进去（历史 bug：只有勾了「筛除第一轮」周期筛选才生效）。 */
  var cyc = $('tlCycle').value;
  if (cyc !== '') {
  items = items.filter(function (it) { return it.kind === 'warm' && String(it.cycle || 1) === cyc; });

  }
  items.sort(function (a, b) {
    if (by === 'cost') {
      var ca = Number(a.cost || 0), cb = Number(b.cost || 0);
      if (ca !== cb) return cb - ca;
      return sortTimeOf(a) - sortTimeOf(b);
    }
    if (by === 'hit') {
      var ha = Number(a.hitRate || 0), hb = Number(b.hitRate || 0);
      if (ha !== hb) return hb - ha;
      return sortTimeOf(a) - sortTimeOf(b);
    }
    var ta = sortTimeOf(a), tb = sortTimeOf(b);
    if (ta !== tb) return desc ? (tb - ta) : (ta - tb);
    /**
     * 同一时刻（合计与它自己最后一次调用必然同刻）→ 整轮合计要贴在调用**之后**的那一侧：
     * 「最新在最上」时合计在上、正序时合计在下。否则两种顺序里总有一种看起来像"缺了合计"。
     */
    var ga = (a.kind === 'round' && a.gran === 'turn') ? 1 : 0;
    var gb = (b.kind === 'round' && b.gran === 'turn') ? 1 : 0;
    return desc ? (gb - ga) : (ga - gb);
  });
  // 逆序：把最终顺序整个翻过来
  if (tglOn('tlRev')) items.reverse();
  var html = '';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var tot = Number(it.hitTokens || 0) + Number(it.missTokens || 0);
    var hp = tot > 0 ? (Number(it.hitTokens || 0) / tot) * 100 : 0;
    var isWarm = it.kind === 'warm';
    /** 计算轮次（压缩 / goal）：不是用户对话，但会改写前缀 —— 与保温并列，解释「这轮之后为什么没保」。 */
    var isMark = it.kind === 'mark';
    var isTurn = isWarm === false && isMark === false && it.gran === 'turn';
    var label = isMark
      ? '<span class="pill ' + (it.gran === 'compaction' ? 'arch' : 'cur') + '">'
        + (it.gran === 'compaction' ? '🧩 ' : '🎯 ') + esc(String(it.text || '')) + '</span>'
      : (isWarm
        ? '<span class="pill hot">保温 ' + viaLabel(it) + '</span>'
        : (isTurn
          ? '<span class="pill turnaggpill">合计 T' + it.turn + '</span>'
          : '<span class="pill auto">T' + it.turn + 'S' + it.step + '</span>'));
    var bits = isMark ? markBits(it, true) : ['输出 ' + it.outputTokens + ' tok'];
    if (isTurn && Number(it.steps) > 1) bits.unshift('整轮 ' + it.steps + ' 步');
    if (isWarm) { bits.push('第' + it.touch + '次'); bits.push(it.ms + 'ms'); }
    if (it.model) bits.push(String(it.model));
    var fac = Number(it.factor);
    /* factor=0 是后端的「整轮跨时段」标记（轮内每笔各自计价，没有单一倍率可显示） */
    if (fac === 0) bits.push('跨时段计价');
    else if (isFinite(fac) && fac !== 1 && fac > 0) bits.push((it.factorLabel || '时段') + ' ×' + fac);
    var detail = bits.join(' · ');
    /** 行类：基础色按 kind 分（warm/round/mark），round 内部再用 gran 区分"整轮合计"和"单次调用"。 */
    var rowCls = isWarm ? 'it warm'
      : (isMark ? ('it mark ' + (it.gran === 'compaction' ? 'mk-compaction' : 'mk-goal'))
        : (isTurn ? 'it turnagg' : 'it step'));
    html += '<div class="' + rowCls + '">'
      + '<span class="t">' + fmtClock(it.time) + '</span>'
      + '<span>' + label + '</span>'
      + (isMark
        ? '<span><span class="dim mono">' + detail + '</span></span><span class="amt">—</span>'
        : '<span><span class="bar" title="命中 ' + it.hitTokens + ' / 未命中 ' + it.missTokens + '">'
          + '<i class="h" style="width:' + hp.toFixed(2) + '%"></i>'
          + '<i class="m" style="width:' + (100 - hp).toFixed(2) + '%"></i></span>'
          + ' <span class="dim mono">' + hp.toFixed(1) + '% · ' + detail + '</span></span>'
          + '<span class="amt">' + Number(it.cost || 0).toFixed(3) + ' 元</span>')
      + '</div>';
  }
  $('tlAxis').innerHTML = html || '<div class="dim" style="padding:12px">这条会话没有符合条件的记录</div>';

  /* 详情模式：时间轴画完再把轴体撑到视口底（不能在画之前，元素尺寸还没定） */

  fitDetailAxis();
  var axis = $('tlAxis');
  // 最新在最上时停在顶部；否则停在底部（最新一条）
  // 默认停在最上（最新 / 最高分都在上）；只有「按时间且不要最新在最上」才滚到底
  axis.scrollTop = (by === 'time' && !desc) ? axis.scrollHeight : 0;
}

/**
 * 详情模式把时间轴撑到 iframe 视口底部：「#tl」是 static、「.axis」有 62vh 上限，
 * 内容铺不满时底部会露出页面底色（深色主题下就是那条黑块）。
 *
 * ⚠️ **必须先量再放开**：一旦先把 maxHeight 设成 none，高度立刻涨成内容全高（实测 20 万 px），
 * gap 变负就再也补不上了。
 */
function fitDetailAxis() {
  if (!IS_DETAIL) return;
  var ax = document.querySelector('#tl .axis');
  if (!ax) return;
  var r = ax.getBoundingClientRect();
  var gap = window.innerHeight - r.bottom;
  if (gap > 0) {
    ax.style.maxHeight = 'none';
    ax.style.height = Math.round(r.height + gap) + 'px';
  }
}
function renderTimeline(d) {
  var p = d.prices || { hit: 0.02, miss: 1, out: 4 };
  var nModel = d.pricesByModel ? Object.keys(d.pricesByModel).length : 0;
  $('tlTitle').textContent = d.title || '(无标题)';
  $('tlSub').textContent = d.short
    + ' · 基准价（元/百万 token）命中 ' + p.hit + ' / 未命中 ' + p.miss + ' / 输出 ' + p.out
    + (nModel > 0 ? ' · 另有 ' + nModel + ' 个模型价' : '')
    + (d.tariff && d.tariff.enabled ? ' · 时段表已开（' + d.tariff.timeZone + '）' : '')
    + ' · 粒度 ' + (d.granularity || 'step')
    + ' · 轴上一共 ' + d.items.length + ' 项'
    + ' · 真实调用 ' + d.summary.rounds + ' 次 / ' + (d.summary.turns || 0) + ' 轮'
    + ' · 保温 ' + d.summary.warms + ' 次';
  var s = d.summary;
  $('tlSum').innerHTML =
    '<div class="s1">真实对话 <b>' + s.rounds + '</b> 次调用<br><span class="dim">共 <b>' + s.roundCost.toFixed(3) + '</b> 元</span></div>'
    + '<div class="s2">共 <b>' + (s.turns || 0) + '</b> 轮合计 <b>' + s.totalCost.toFixed(3) + '</b> 元'
    + '<br><span class="dim">保温占 <b>' + (s.warmShare * 100).toFixed(1) + '</b>%</span></div>'
    + '<div class="s3">保温 <b>' + s.warms + '</b> 次<br><span class="dim">共 <b>' + s.warmCost.toFixed(3) + '</b> 元</span></div>'
    + '<div class="s4">本期 <b>' + (s.cycleWarms || 0) + '</b> 次'
    + '<br><span class="dim">共 <b>' + Number(s.cycleWarmCost || 0).toFixed(3) + '</b> 元 · 周期 #' + (s.cycle || 1) + '</span></div>';
  // 周期下拉：用数据里出现过的周期号重建（保留当前选择）
  var seen = {}, cycs = [];
  for (var ci = 0; ci < d.items.length; ci++) {
    var itc = d.items[ci];
    if (itc.kind !== 'warm') continue;
    var n = Number(itc.cycle || 1);
    if (!seen[n]) { seen[n] = 1; cycs.push(n); }
  }
  cycs.sort(function (a, b) { return a - b; });
  var opt = '<option value="">全部周期</option>';
  for (var cj = 0; cj < cycs.length; cj++) {
    opt += '<option value="' + cycs[cj] + '">周期 #' + cycs[cj] + '</option>';
  }
  $('tlCycle').innerHTML = opt;
  /* 选项建好了，这时候才把偏好套上去（#tlCycle 的 cycle 只有此刻才设得上） */
  applyTlPrefs();
  paintTimeline();
}
/* ── 模型价表 / 时段表 / 节假日：动态行 ─────────────────────── */
/** 编辑中标记：为 true 时不做自动重画（否则 15 秒一次的刷新会冲掉没保存的草稿）。 */
var MODELS_DIRTY = false;
var TARIFF_DIRTY = false;
/** 门禁文案有未保存改动：此时不重画表格，并显示「取消保存」。 */
var GATE_DIRTY = false;
/** 候选文案有未保存改动：同样不重画（15 秒刷新不能冲掉草稿）。 */
var CAND_DIRTY = false;

/** 换行符。**不能写反斜杠 n** —— 这里在模板字符串里，反斜杠 n 会被解释成真换行、直接截断生成的 JS。 */
var NL = String.fromCharCode(10);
function okHm(s) {
  var parts = String(s).split(':');
  if (parts.length !== 2) return false;
  if (parts[0] === '' || parts[1] === '') return false;
  var h = Number(parts[0]), m = Number(parts[1]);
  return isFinite(h) && isFinite(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59;
}
/** 节假日日期只认月-日（MM-DD），不带年份 —— 同一张表每年通用。 */
function okDate(s) {
  var p = String(s).split('-');
  if (p.length !== 2) return false;
  if (p[0].length !== 2 || p[1].length !== 2) return false;
  var mo = Number(p[0]), d = Number(p[1]);
  return isFinite(mo) && isFinite(d) && mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
}
function mrowHtml(name, p) {
  var cat = (STATE && STATE.modelCatalog) ? STATE.modelCatalog : [];
  var s = String(name);
  var slash = s.indexOf('/');
  var pv = '';
  var md = '';
  if (slash > 0) {
    pv = s.slice(0, slash);
    md = s.slice(slash + 1);
  } else {
    md = s;
    for (var hi = 0; hi < cat.length; hi++) {
      if (cat[hi].models && cat[hi].models.indexOf(md) >= 0) { pv = cat[hi].provider; break; }
    }
  }
  /** 手填只给「没有 provider 段、目录里也反查不到」的键；带斜杠的键一律下拉态（不强制手填）。 */
  var manual = slash <= 0 && pv === '';
  /** 裸名反查成功 → 隐藏域写全名，保存落盘就是 provider/model。 */
  var fullName = (!manual && slash <= 0 && pv !== '') ? (pv + '/' + md) : s;
  var provs = providerPool(s);
  var pOpts = '';
  for (var a = 0; a < provs.length; a++) {
    pOpts += '<option value="' + esc(provs[a]) + '"' + (provs[a] === pv ? ' selected' : '') + '>' + esc(provs[a]) + '</option>';
  }
  var head = '<select class="m-provider" onchange="syncModelSelect(this)" style="min-width:130px" title="供应商">' + pOpts + '</select>'
    + '<select class="m-model" onchange="syncModelKey(this)" style="min-width:170px" title="模型">'
    + '<option value="' + esc(md) + '" selected>' + esc(md) + '</option></select>'
    + '<input type="text" class="mname-text" style="width:236px" value="' + esc(fullName) + '" placeholder="provider/model" oninput="syncModelText(this)">'
    + '<input type="hidden" class="mname" value="' + esc(fullName) + '">';
  /** 面板规范：禁 checkbox，开关一律 .tgl 按钮 + 颜色反馈。 */
  var toggle = '<button class="tgl m-manual' + (manual ? ' on' : '') + '" onclick="toggleManual(this)"'
    + ' title="点亮就手填 provider/model（目录里没有这条时用）">手填</button>';
  return '<div class="mrow' + (manual ? ' manual' : '') + '" style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap">'
    + head + toggle
    + '<span class="hint">命中</span><input type="number" class="mhit" style="width:62px" step="0.01" min="0.0001" value="' + p.hit + '"><span class="hint">元/M</span>'
    + '<span class="hint">未命中</span><input type="number" class="mmiss" style="width:62px" step="0.1" min="0.0001" value="' + p.miss + '"><span class="hint">元/M</span>'
    + '<span class="hint">输出</span><input type="number" class="mout" style="width:62px" step="0.5" min="0.0001" value="' + p.out + '"><span class="hint">元/M</span>'
    + '<button class="tgl mtariff' + (p.tariff === false ? '' : ' on') + '" data-k="tariff" onclick="toggleModelFlag(this)"'
    + ' title="该模型是否吃峰谷时段倍率">峰谷</button>'
    + '<button class="tgl mholiday' + (p.holiday === false ? '' : ' on') + '" data-k="holiday" onclick="toggleModelFlag(this)"'
    + ' title="该模型是否吃节假日倍率">节假日</button>'
    + '<span class="hint">闲置</span><input type="number" class="m-idle" style="width:66px" step="0.5" min="0"'
    + ' title="该模型的缓存能活多久，单位【小时】。留空=用通用值；填 0=该模型不保温"'
    + ' value="' + (p.idleLimitHours === undefined ? '' : p.idleLimitHours) + '" placeholder="通用">'
    + '<span class="hint">小时</span>'
    + '<span class="hint">间隔</span><input type="number" class="m-interval" style="width:72px" step="600" min="0"'
    + ' title="该模型的保温间隔，单位【秒】（3600 = 1 小时）。留空=用通用值；填 0=该模型不保温"'
    + ' value="' + (p.intervalSeconds === undefined ? '' : p.intervalSeconds) + '" placeholder="通用">'
    + '<span class="hint">秒</span>'
    + effectiveHintHtml(p)
    + '<button onclick="delRow(this)">删除</button></div>';
}
function srowHtml(s) {
  return '<div class="srow" style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap">'
    + '<input type="text" class="slabel" style="width:110px" value="' + esc(s.label) + '" placeholder="名称">'
    + '<input type="text" class="sfrom" style="width:70px" value="' + esc(s.from) + '" placeholder="08:30">'
    + '<span class="hint">→</span>'
    + '<input type="text" class="sto" style="width:70px" value="' + esc(s.to) + '" placeholder="00:30">'
    + '<span class="hint">倍率</span>'
    + '<input type="number" class="sfactor" style="width:72px" step="0.5" min="0.01" value="' + s.factor + '">'
    + '<button onclick="delRow(this)">删除</button></div>';
}
function delRow(el) {
  var row = el.parentNode;
  if (!row || !row.parentNode) return;
  // 增删行也算编辑：不标脏的话，下一次自动刷新会把这一行凭空画回来
  if (String(row.className).indexOf('mrow') >= 0) MODELS_DIRTY = true;
  else TARIFF_DIRTY = true;
  row.parentNode.removeChild(row);
}

/** 开关按钮当前是否打开（状态只在 class 上，不用勾选态）。 */
function isTglOn(el) {
  return !!el && el.classList.contains('on');
}
/**
 * 设置一个开关按钮的状态。
 * **只切 on 这一个类**，不整段重置 className —— 否则带附加类（如 mtariff / mholiday）的按钮
 * 一旦改走这里，附加类会被无声吃掉（与 setToggle 同一个坑，别改回去）。
 */
function setTgl(el, on) {
  if (el) el.classList.toggle('on', on === true);
}
/** 「向 Agent 开放的工具」卡里的按钮（如 cache_lab 开关）：点一下只切 class，点保存才落盘。 */
function toggleLab(id) {
  var el = $(id);
  if (el) setTgl(el, !isTglOn(el));
}

/** 画「向 Agent 开放的工具」卡里那个 cache_lab 开关（从试验页搬过去了）。 */
/** 熔断线档位回填：三档之外的值（agent 直接改过）临时补一个「自定义」选项，不让用户看到错的档。 */
function paintCircuitRate(v) {
  var sel = $('circuitHitRate');
  if (!sel) return;
  var num = Number(v);
  if (!isFinite(num) || num <= 0) num = 0.5;
  var all = sel.querySelectorAll('option');
  for (var i = all.length - 1; i >= 0; i--) {
    if (all[i].getAttribute('data-custom') === '1') sel.removeChild(all[i]);
  }
  var want = String(num), hit = null;
  for (var j = 0; j < sel.options.length; j++) {
    if (sel.options[j].value === want) { hit = sel.options[j]; break; }
  }
  if (hit === null) {
    hit = document.createElement('option');
    hit.value = want;
    hit.textContent = '自定义 ' + Math.round(num * 100) + '%';
    hit.setAttribute('data-custom', '1');
    sel.appendChild(hit);
  }
  sel.value = want;
}
/** 命中率配色：≥90% 绿；≥熔断线 黄；否则红。熔断线可在「默认参数」卡里改（默认 0.5）。 */
function hitClass(rate) {
  var t = (STATE && STATE.settings) ? Number(STATE.settings.circuitHitRate) : 0.5;
  var thr = (isFinite(t) && t > 0) ? t : 0.5;
  /**
   * 三档语义（一目了然）：**低于阈值 = 会被熔断（红）**、高于阈值但没到 90% = 比较危险（黄）、
   * 90% 以上 = 健康（绿）。所以 ok 门槛 = max(0.9, 阈值)：
   *   thr=0.5  → ≥90% 绿 / 50~90% 黄 / <50% 红
   *   thr=0.95 → ≥95% 绿 / <95% 红（黄区自然收窄为 0，符合"阈值已经这么高了"的直觉）
   */
  var okAt = Math.max(0.9, thr);
  return rate >= okAt ? 'ok' : (rate >= thr ? 'warn' : 'bad');
}
function paintLabExpose(st) {
  setTgl($('labExpose'), st.exposeLabTools !== false);
}

/** 模型行里的「峰谷 / 节假日」开关：点一下切状态并标脏（保存模型价表才落盘）。 */
function toggleModelFlag(el) {
  el.classList.toggle('on');
  MODELS_DIRTY = true;
}
/** 把两个总开关的按钮状态画成已保存的值。 */
function paintTgl(st) {
  var t = (st && st.tariff) || {};
  var a = $('tglTariff');
  if (a) a.className = 'tgl' + (t.enabled === true ? ' on' : '');
  var b = $('tglHoliday');
  if (b) b.className = 'tgl' + (t.holidayEnabled === true ? ' on' : '');
}
/** 价格行那个「峰谷时段」：点一下即时保存（不碰下面未保存的时段草稿）。 */
function toggleTariff() {
  var cur = (STATE && STATE.settings && STATE.settings.tariff) || {};
  var next = JSON.parse(JSON.stringify(cur));
  next.enabled = cur.enabled !== true;
  post('/settings', { tariff: next }).then(function (d) {
    toast(d.ok ? ('峰谷时段已' + (next.enabled ? '启用' : '关闭') + '（每个模型还能单独关）') : (d.error || '失败'), !d.ok);
    refresh();
  }).catch(function (e) { toast('失败: ' + e, true); });
}
/** 价格行那个「节假日」：点一下即时保存。 */
function toggleHoliday() {
  var cur = (STATE && STATE.settings && STATE.settings.tariff) || {};
  var next = JSON.parse(JSON.stringify(cur));
  next.holidayEnabled = cur.holidayEnabled !== true;
  post('/settings', { tariff: next }).then(function (d) {
    toast(d.ok ? ('节假日倍率已' + (next.holidayEnabled ? '启用' : '关闭') + '（每个模型还能单独关）') : (d.error || '失败'), !d.ok);
    refresh();
  }).catch(function (e) { toast('失败: ' + e, true); });
}
/** 花费列口径按钮。 */
function paintCostScope(st) {
  var v = (st && st.costScope === 'total') ? 'total' : 'cycle';
  var a = $('costScopeCycle');
  if (a) a.className = 'tgl' + (v === 'cycle' ? ' on' : '');
  var b = $('costScopeTotal');
  if (b) b.className = 'tgl' + (v === 'total' ? ' on' : '');
}
function setCostScope(v) {
  post('/settings', { costScope: v }).then(function (d) {
    toast(d.ok ? ('花费列改为显示' + (v === 'total' ? '全部保温次数' : '本周期花费')) : (d.error || '失败'), !d.ok);
    refresh();
  }).catch(function (e) { toast('失败: ' + e, true); });
}
/** 门禁文案草稿开关。「取消保存」只在有未保存改动时出现。 */
function setGateDirty(on) {
  GATE_DIRTY = on === true;
  var b = $('cancelGateText');
  if (b) b.style.display = GATE_DIRTY ? '' : 'none';
}
function effectiveHintHtml(p) {
  var lim = (STATE && STATE.limits) || {};
  var floorSec = Number(lim.perModelIntervalMinSec);
  var raw = Number(p.intervalSeconds);
  if (!isFinite(floorSec) || floorSec <= 0) return '';
  if (!isFinite(raw) || raw <= 0) return '';
  if (raw >= floorSec) return '';
  return '<span class="hint" style="color:var(--bad)" title="后端对按模型的间隔有下限，填太小会被夹">'
    + '实际生效 ' + floorSec + ' 秒</span>';
}

function providerPool(key) {
  var set = {};
  var cat = (STATE && STATE.modelCatalog) ? STATE.modelCatalog : [];
  for (var i = 0; i < cat.length; i++) set[cat[i].provider] = true;
  var pm = (STATE && STATE.settings && STATE.settings.pricesByModel) ? STATE.settings.pricesByModel : {};
  for (var k in pm) {
    if (!Object.prototype.hasOwnProperty.call(pm, k)) continue;
    var j = String(k).indexOf('/');
    if (j > 0) set[String(k).slice(0, j)] = true;
  }
  var s = String(key || '');
  var slash = s.indexOf('/');
  if (slash > 0) set[s.slice(0, slash)] = true;
  var out = [];
  for (var p in set) if (Object.prototype.hasOwnProperty.call(set, p)) out.push(p);
  out.sort();
  return out;
}

function modelPool(provider, key) {
  var cat = (STATE && STATE.modelCatalog) ? STATE.modelCatalog : [];
  var models = [];
  for (var i = 0; i < cat.length; i++) if (cat[i].provider === provider) models = cat[i].models.slice();
  var s = String(key || '');
  var j = s.indexOf('/');
  var md = j > 0 ? s.slice(j + 1) : (provider === '' ? s : '');
  if (md !== '' && models.indexOf(md) < 0) models.push(md);
  return models;
}

function modelOptionsHtml(models, keep) {
  var html = '';
  var hit = false;
  for (var i = 0; i < models.length; i++) {
    if (models[i] === keep) hit = true;
    html += '<option value="' + esc(models[i]) + '"' + (models[i] === keep ? ' selected' : '') + '>' + esc(models[i]) + '</option>';
  }
  if (!hit && keep !== '') html = '<option value="' + esc(keep) + '" selected>' + esc(keep) + '</option>' + html;
  return html;
}

function applyKeyToSelects(row, key) {
  var pSel = row.getElementsByClassName('m-provider')[0];
  var mSel = row.getElementsByClassName('m-model')[0];
  if (!pSel || !mSel) return false;
  var s = String(key || '');
  var j = s.indexOf('/');
  var pv = j > 0 ? s.slice(0, j) : '';
  var md = j > 0 ? s.slice(j + 1) : s;
  var provs = providerPool(key);
  if (pv === '' && provs.length > 0) {
    pv = provs[0];
    var first = modelPool(pv, key);
    if (md === '' && first.length > 0) md = first[0];
  }
  var pOpts = '';
  for (var a = 0; a < provs.length; a++) {
    pOpts += '<option value="' + esc(provs[a]) + '"' + (provs[a] === pv ? ' selected' : '') + '>' + esc(provs[a]) + '</option>';
  }
  pSel.innerHTML = pOpts;
  pSel.value = pv;
  mSel.innerHTML = modelOptionsHtml(modelPool(pv, key), md);
  mSel.value = md;
  syncModelKey(mSel);
  return true;
}

function syncModelText(txt) {
  var row = txt.parentNode;
  var hid = row ? row.getElementsByClassName('mname')[0] : null;
  if (hid) hid.value = String(txt.value || '').trim();
  MODELS_DIRTY = true;
  LIMITS_DIRTY = true;
}

function modelNameIssues() {
  var rows = $('modelRows').getElementsByClassName('mrow');
  var seen = {};
  var issues = [];
  for (var i = 0; i < rows.length; i++) {
    var box = rows[i].getElementsByClassName('mname')[0];
    var name = box ? String(box.value || '').trim().toLowerCase() : '';
    var no = i + 1;
    if (name === '') { issues.push('第' + no + '行模型名为空'); continue; }
    if (seen[name] !== undefined) { issues.push('第' + no + '行与第' + seen[name] + '行重名（' + name + '）'); continue; }
    seen[name] = no;
  }
  return issues;
}

function guardModelRows() {
  var issues = modelNameIssues();
  if (issues.length === 0) return true;
  toast('先修好这些再保存：' + issues.join('；'), true);
  return false;
}

function paintModelRows() {
  var t = (STATE.settings && STATE.settings.pricesByModel) || {};
  /**
   * 时间门槛覆盖（settings.modelOverrides）**按精确键贴到对应行**。
   * 包含匹配会让 prov-b/m1 那行把 prov-a/m1 的门槛显示出来（老数据裸名键的权宜之计，已废）。
   * 老裸名键对不上 → 该行不显示门槛，但保存时由 collectModelOverrides 的「并回外键」保住。
   */
  var ov = (STATE.settings && STATE.settings.modelOverrides) || {};
  var names = Object.keys(t);
  var html = '';
  for (var i = 0; i < names.length; i++) {
    var p = {};
    for (var k in t[names[i]]) p[k] = t[names[i]][k];
    var mine = ov[names[i]];
    if (mine !== undefined) {
      if (p.idleLimitHours === undefined && mine.idleLimitHours !== undefined) p.idleLimitHours = mine.idleLimitHours;
      if (p.intervalSeconds === undefined && mine.intervalSeconds !== undefined) p.intervalSeconds = mine.intervalSeconds;
    }
    html += mrowHtml(names[i], p);
  }
  /** 空表时默认放一条 DSH 官方模型（只作显示，保存后才落盘）。 */
  if (html === '') html = mrowHtml('deepseek-flash', { hit: 0.02, miss: 1, out: 4 });
  $('modelRows').innerHTML = html;
}
/**
 * 选了 provider → 重建该行的 model 下拉。
 * 目录查不到时保留原 model 选项，避免把用户已有数据抹掉。
 */
/**
 * 勾/取消「手填」—— 把这一行的 provider/model 下拉换成输入框，或反过来。
 *
 * 取消勾选时值不在目录里怎么办：把当前值塞成 select 的一个选项（**不丢数据**），
 * 这是用户明确要的行为 —— 「取消勾选变回下拉，当前值不在列表里就保留为选项」。
 */
function toggleManual(btn) {
  var row = btn.parentNode;
  var hid = row.getElementsByClassName('mname')[0];
  var txt = row.getElementsByClassName('mname-text')[0];
  if (!hid || !txt) return;
  var on = !btn.classList.contains('on');
  btn.classList.toggle('on', on);
  row.classList.toggle('manual', on);
  if (on) {
    txt.value = hid.value;
    if (typeof txt.focus === 'function') txt.focus();
  } else {
    applyKeyToSelects(row, hid.value);
  }
  MODELS_DIRTY = true;
  LIMITS_DIRTY = true;
}
function syncModelSelect(sel) {
  var mSel = sel.parentNode.getElementsByClassName('m-model')[0];
  if (!mSel) return;
  var keep = mSel.value;
  mSel.innerHTML = modelOptionsHtml(modelPool(sel.value, ''), keep);
  syncModelKey(mSel);
  MODELS_DIRTY = true;
  LIMITS_DIRTY = true;
}
/** 两个下拉都变了 → 把拼接后的 provider/model 写回隐藏域（collectModels 读它）。 */
function syncModelKey(el) {
  var row = el.parentNode;
  var pSel = row.getElementsByClassName('m-provider')[0];
  var mSel = row.getElementsByClassName('m-model')[0];
  var hid = row.getElementsByClassName('mname')[0];
  if (hid && pSel && mSel) hid.value = pSel.value + '/' + mSel.value;
  MODELS_DIRTY = true;
  LIMITS_DIRTY = true;
}
function collectModels() {
  var rows = $('modelRows').getElementsByClassName('mrow');
  var out = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var name = r.getElementsByClassName('mname')[0].value.trim().toLowerCase();
    if (name === '') continue;
    var one = {
      hit: Number(r.getElementsByClassName('mhit')[0].value),
      miss: Number(r.getElementsByClassName('mmiss')[0].value),
      out: Number(r.getElementsByClassName('mout')[0].value)
    };
    if (!isTglOn(r.getElementsByClassName('mtariff')[0])) one.tariff = false;
    if (!isTglOn(r.getElementsByClassName('mholiday')[0])) one.holiday = false;
    out[name] = one;
  }
  return out;
}
/** 默认时段表 + 2026 节假日（与后端 DEFAULT_TARIFF 保持一致）。 */
var DEFAULT_TARIFF_UI = {
  enabled: false,
  timeZone: 'Asia/Shanghai',
  slots: [
    { id: 'off-peak-1', label: '空闲时段', from: '00:30', to: '08:30', factor: 1 },
    { id: 'peak-1', label: '高峰时段1', from: '08:30', to: '12:00', factor: 2 },
    { id: 'off-peak-2', label: '空闲时段', from: '12:00', to: '14:30', factor: 1 },
    { id: 'peak-2', label: '高峰时段2', from: '14:30', to: '18:00', factor: 2 },
    { id: 'off-peak-3', label: '空闲时段', from: '18:00', to: '00:30', factor: 1 }
  ],
  holidayEnabled: false,
  holidayFactor: 1,
  holidays: [
    { date: '01-01', name: '元旦' }, { date: '01-02', name: '元旦' }, { date: '01-03', name: '元旦' },
    { date: '02-15', name: '春节' }, { date: '02-16', name: '春节' }, { date: '02-17', name: '春节' },
    { date: '02-18', name: '春节' }, { date: '02-19', name: '春节' }, { date: '02-20', name: '春节' },
    { date: '02-21', name: '春节' }, { date: '02-22', name: '春节' }, { date: '02-23', name: '春节' },
    { date: '04-04', name: '清明' }, { date: '04-05', name: '清明' }, { date: '04-06', name: '清明' },
    { date: '05-01', name: '劳动节' }, { date: '05-02', name: '劳动节' }, { date: '05-03', name: '劳动节' },
    { date: '05-04', name: '劳动节' }, { date: '05-05', name: '劳动节' },
    { date: '06-19', name: '端午' }, { date: '06-20', name: '端午' }, { date: '06-21', name: '端午' },
    { date: '09-25', name: '中秋' }, { date: '09-26', name: '中秋' }, { date: '09-27', name: '中秋' },
    { date: '10-01', name: '国庆' }, { date: '10-02', name: '国庆' }, { date: '10-03', name: '国庆' },
    { date: '10-04', name: '国庆' }, { date: '10-05', name: '国庆' }, { date: '10-06', name: '国庆' },
    { date: '10-07', name: '国庆' }
  ]
};
function paintTariff(t) {
  var src = t || DEFAULT_TARIFF_UI;
  var html = '';
  var slots = src.slots || [];
  for (var i = 0; i < slots.length; i++) html += srowHtml(slots[i]);
  $('slotRows').innerHTML = html;
  $('tariffZone').value = src.timeZone || 'Asia/Shanghai';
  $('holidayFactor').value = src.holidayFactor === undefined ? 1 : src.holidayFactor;
  var lines = [];
  var hol = src.holidays || [];
  for (var k = 0; k < hol.length; k++) lines.push(hol[k].date + ' ' + hol[k].name);
  $('holidayList').value = lines.join(NL);
}
function collectTariff() {
  var rows = $('slotRows').getElementsByClassName('srow');
  var slots = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    slots.push({
      id: 'slot-' + i,
      label: r.getElementsByClassName('slabel')[0].value.trim() || ('时段' + (i + 1)),
      from: r.getElementsByClassName('sfrom')[0].value.trim(),
      to: r.getElementsByClassName('sto')[0].value.trim(),
      factor: Number(r.getElementsByClassName('sfactor')[0].value)
    });
  }
  var holidays = [];
  var lines = $('holidayList').value.split(NL);
  for (var k = 0; k < lines.length; k++) {
    var line = lines[k].trim();
    if (line === '') continue;
    var raw = line.split(' ')[0];
    // 手滑带年份也认：统一存成 MM-DD（后端只按「月-日」匹配）
    var date = raw.length === 10 ? raw.slice(5) : raw;
    holidays.push({ date: date, name: line.slice(raw.length).trim() });
  }
  var saved = (STATE && STATE.settings && STATE.settings.tariff) || {};
  return {
    // 两个总开关不属于这张表的草稿：它们在「价格」行，点一下即时保存
    enabled: saved.enabled === true,
    timeZone: $('tariffZone').value.trim() || 'Asia/Shanghai',
    slots: slots,
    holidays: holidays,
    holidayEnabled: saved.holidayEnabled === true,
    holidayFactor: Number($('holidayFactor').value)
  };
}

/** 花费详情：按保温周期分组，可只看某一周期。 */
function resetCost(el) {
  var id = el.getAttribute('data-id');
  el.disabled = true;
  post('/reset-cost', { id: id }).then(function (d) {
    el.disabled = false;
    toast(d.ok ? ('已清除计费 → 开新保温周期 #' + d.cycle + '（总花费不变）') : (d.error || '失败'), !d.ok);
    refresh();
  }).catch(function (e) { el.disabled = false; toast('失败: ' + e, true); });
}

/**
 * 正在保温的会话（id → 开始时刻）。15 秒自动刷新会重建这些按钮，
 * 光靠 el.disabled 保不住「保温中」态 —— 不记在这里，用户连点两次就是两次真实花费。
 */
var PINGING = {};
/** 这条会话是否正在保温（超过 3 分钟当作掉线，允许重试）。 */
function pingBusy(id) {
  var at = PINGING[id];
  if (!at) return false;
  if (Date.now() - at < 180000) return true;
  delete PINGING[id];
  return false;
}
/**
 * 「保温」按钮。活会话与非活会话都走同一个 /ping（后端自己选真 agent 还是离线装配），
 * 区别只在 title 里说明非活会话要装配、会慢一点。
 */
function warmBtn(s, txt, cls) {
  var busy = pingBusy(s.id);
  return '<button' + (cls ? ' class="' + cls + '"' : '') + (busy ? ' disabled' : '')
    + ' data-id="' + esc(s.id) + '" onclick="ping(this)"'
    + ' title="' + (s.live ? '用本进程里的会话直接保（秒级）' : '非本进程的会话：读日志离线装配后保，可能要一两秒') + '">'
    + (busy ? '保温中…' : txt) + '</button>';
}
function ping(el) {
  var id = el.getAttribute('data-id');
  if (pingBusy(id)) return;   /* 已在保：忽略连点 */
  /**
   * 含图片的会话会被安全阀拒绝（离线拿不到图片字节，保了会把错误前缀写进缓存）。
   * 但用户可能有「我就想保一次」的正当需求 —— 所以**再点一次**就带 force 放行。
   * 按钮文案会变成「强制保温」，避免误触。
   */
  var force = el.getAttribute('data-force') === '1';
  PINGING[id] = Date.now();
  el.disabled = true; el.textContent = '保温中…';
  post('/ping', { id: id, force: force, via: 'panel' }).then(function (d) {
    delete PINGING[id];
    el.disabled = false;
    if (!d.ok && !force && String(d.error || '').indexOf('图片') >= 0) {
      el.setAttribute('data-force', '1');
      el.textContent = '强制保温';
      toast('含图片：离线保会与真实前缀不符。确实要保就再点一次（慎用）', true);
      return;
    }
    el.removeAttribute('data-force');
    el.textContent = '立刻保温';
    toast(d.ok ? d.message : (d.error || '失败'), !d.ok);
    refresh();
  }).catch(function (e) {
    delete PINGING[id];
    el.disabled = false; el.textContent = '立刻保温';
    toast('失败: ' + e, true);
  });
}

/** 置顶 / 取消置顶（**本插件自己的一份**，写 state.json，与 DSH workspace 的置顶无关）。 */
function pinRow(el) {
  var id = el.getAttribute('data-id');
  var want = el.getAttribute('data-pin') !== '1';
  el.disabled = true;
  post('/pin', { id: id, pinned: want }).then(function (d) {
    el.disabled = false;
    toast(d.ok ? (want ? '已置顶（排在最上）' : '已取消置顶') : (d.error || '失败'), !d.ok);
    refresh();
  }).catch(function (e) { el.disabled = false; toast('失败: ' + e, true); });
}

/** 定位到「当前对话」那一行：滚动 + 闪三下。**不置顶** —— 置顶是用户手动的事。 */
function gotoCurrent() {
  if (!CURRENT_ID) { toast('当前没有会话 id（网页版直接打开时可能会缺）', true); return; }
  var row = document.getElementById('row-' + CURRENT_ID);
  if (!row) { toast('找不到当前会话那行：可能被筛选条件藏起来了', true); return; }
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.className = 'flash';
  setTimeout(function () { row.className = ''; }, 2300);
}


/**
 * 闲置上限必须 > 保温间隔 —— 否则门禁永远说"闲置超窗"，一次都保不上。
 * 只在**保存前**拦：不拦的话用户会看到"保存成功"却永远不保温，很难自己查出来。
 */
function idleVsIntervalBad(idleHours, intervalSeconds) {
  return !(Number(idleHours) * 3600 > Number(intervalSeconds));
}
var IDLE_BAD = '闲置上限必须大于保温间隔，否则永远保不上';

$('saveAuto').onclick = function () {
  var idleHours = Number($('idleLimitHours').value);
  var interval = (STATE && STATE.settings) ? STATE.settings.intervalSeconds : 0;
  if (idleVsIntervalBad(idleHours, interval)) {
    toast(IDLE_BAD + '（现在间隔 ' + interval + ' 秒 ≈ ' + (interval / 3600).toFixed(1) + ' 小时）', true);
    return;
  }
  post('/settings', {
    autoEnabled: tglOn('autoEnabled'),
    autoCount: Number($('autoCount').value),
    idleLimitHours: idleHours,
    autoAllowSubagent: tglOn('autoAllowSubagent')
  })
    .then(function (d) { toast(d.ok ? '自动策略已保存' : (d.error || '失败'), !d.ok); refresh(); });
};

/* ── 模型价表 ─────────────────────────────────────────────── */
$('modelRows').addEventListener('input', function () { MODELS_DIRTY = true; });
$('addModel').onclick = function () {
  if ($('modelRows').getElementsByClassName('mrow').length === 0) $('modelRows').innerHTML = '';
  $('modelRows').insertAdjacentHTML('beforeend', mrowHtml('', { hit: 0.02, miss: 1, out: 4 }));
  MODELS_DIRTY = true;
};
/**
 * 把行上的时间门槛字段收成 modelOverrides。
 *
 * **键用模型名本身**（面板只有模型名，没有 provider）——
 * 判定侧 effectiveLimitsOf 做两级匹配：精确 provider/model 优先，其次按模型名后缀包含。
 */
function collectModelOverrides() {
  var rows = $('modelRows').getElementsByClassName('mrow');
  var out = {};
  var seen = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var name = r.getElementsByClassName('mname')[0].value.trim().toLowerCase();
    if (name === '') continue;
    seen[name] = true;
    var idleRaw = r.getElementsByClassName('m-idle')[0].value.trim();
    var intRaw = r.getElementsByClassName('m-interval')[0].value.trim();
    if (idleRaw === '' && intRaw === '') continue;
    var one = {};
    if (idleRaw !== '') one.idleLimitHours = Number(idleRaw);
    if (intRaw !== '') one.intervalSeconds = Number(intRaw);
    out[name] = one;
  }
  var old = (STATE && STATE.settings && STATE.settings.modelOverrides) || {};
  for (var k in old) {
    if (!Object.prototype.hasOwnProperty.call(old, k)) continue;
    if (seen[String(k).toLowerCase()] === true) continue;
    out[k] = old[k];
  }
  return out;
}
$('saveModels').onclick = function () {
  if (!guardModelRows()) return;
  post('/settings', { pricesByModel: collectModels(), modelOverrides: collectModelOverrides() }).then(function (d) {
    if (d.ok) MODELS_DIRTY = false;
    toast(d.ok ? '模型价表已保存 —— 时间轴会按每一轮的实际模型分别计价' : (d.error || '失败'), !d.ok);
    /** 改价后已打开的详情必须重算重拉（账本 cost 是快照，展示按当前价）。 */
    /** typeof 守卫：测试沙箱按名字抽函数，没抽到的名字直接调会抛错。 */
    if (d.ok && typeof reloadTimelineIfOpen === 'function') reloadTimelineIfOpen();
    refresh();
  }).catch(function (e) { toast('失败: ' + e, true); });
};
$('saveLimits').onclick = function () {
  if (!guardModelRows()) return;
  post('/settings', { modelOverrides: collectModelOverrides() }).then(function (d) {
    if (d.ok) LIMITS_DIRTY = false;
    toast(d.ok ? '按模型的时间门槛已保存 —— 门禁下一拍就用新值' : (d.error || '失败'), !d.ok);
    /** 门槛也参与时间轴上的「间隔/闲置」标注，同样要重拉。 */
    /** typeof 守卫：测试沙箱按名字抽函数，没抽到的名字直接调会抛错。 */
    if (d.ok && typeof reloadTimelineIfOpen === 'function') reloadTimelineIfOpen();
    refresh();
  }).catch(function (e) { toast('失败: ' + e, true); });
};

/* ── 时段表 / 节假日 ──────────────────────────────────────── */
$('slotRows').addEventListener('input', function () { TARIFF_DIRTY = true; });
$('holidayList').addEventListener('input', function () { TARIFF_DIRTY = true; });
/* 这两个是**标量**输入框，不在 #slotRows 里 —— 漏了它们，15 秒自动刷新会把改动覆盖回旧值 */
$('tariffZone').addEventListener('input', function () { TARIFF_DIRTY = true; });
$('holidayFactor').addEventListener('input', function () { TARIFF_DIRTY = true; });
/* 门禁文案：一改就算草稿（显示「取消保存」，且 15 秒刷新不覆盖） */
$('gateRows').addEventListener('input', function () { setGateDirty(true); });
/**
 * 只点一下、还没打字也要挡住 15 秒自动重建 —— 所以 focusin 也置脏；
 * focusout 后若值与上次绘制完全一样，再把脏标记清掉（不留多余的「取消保存」按钮）。
 */
$('gateRows').addEventListener('focusin', function () { setGateDirty(true); });
$('gateRows').addEventListener('focusout', function () {
  setTimeout(function () { if (gateSig() === GATE_SNAP) setGateDirty(false); }, 0);
});
/* 候选文案同理：一改就算草稿，15 秒刷新不覆盖 */
$('candRows').addEventListener('input', function () { CAND_DIRTY = true; });
$('candRows').addEventListener('focusin', function () { CAND_DIRTY = true; });
$('candRows').addEventListener('focusout', function () {
  setTimeout(function () { if (candSig() === CAND_SNAP) CAND_DIRTY = false; }, 0);
});
$('addSlot').onclick = function () {
  $('slotRows').insertAdjacentHTML('beforeend', srowHtml({ label: '', from: '', to: '', factor: 1 }));
  TARIFF_DIRTY = true;
};
$('saveTariff').onclick = function () {
  // 先在前端校验格式：格式错了后端会整行丢掉，用户会以为"保存成功但行不见了"
  var rows = $('slotRows').getElementsByClassName('srow');
  for (var i = 0; i < rows.length; i++) {
    var f = rows[i].getElementsByClassName('sfrom')[0].value.trim();
    var t = rows[i].getElementsByClassName('sto')[0].value.trim();
    if (!okHm(f) || !okHm(t)) {
      toast('时段第 ' + (i + 1) + ' 行的起止时间要写成 HH:MM（例 08:30）', true);
      return;
    }
  }
  var lines = $('holidayList').value.split(NL);
  for (var k = 0; k < lines.length; k++) {
    var line = lines[k].trim();
    if (line === '') continue;
    if (!okDate(line.split(' ')[0])) {
      toast('节假日第 ' + (k + 1) + ' 行日期要写成 MM-DD（例 02-17，不带年份）', true);
      return;
    }
  }
  post('/settings', { tariff: collectTariff() }).then(function (d) {
    if (d.ok) TARIFF_DIRTY = false;
    toast(d.ok ? '时段表与节假日已保存 —— 之后每笔花费按当时时段计价' : (d.error || '失败'), !d.ok);
    refresh();
  }).catch(function (e) { toast('失败: ' + e, true); });
};
$('resetTariff').onclick = function () {
  paintTariff(DEFAULT_TARIFF_UI);
  TARIFF_DIRTY = true;
  toast('已填回默认值 —— 点「保存时段表与节假日」才生效');
};
$('saveDefaults').onclick = function () {
  /* 改间隔也可能把「闲置上限 > 间隔」的约束破掉 —— 同一处校验，别只在自动策略卡拦 */
  var idleHours = (STATE && STATE.settings) ? STATE.settings.idleLimitHours : 8;
  var newInterval = Number($('intervalSeconds').value);
  if (idleVsIntervalBad(idleHours, newInterval)) {
    toast(IDLE_BAD + '（现在闲置上限 ' + idleHours + ' 小时）', true);
    return;
  }
  /* 刚保过提示只要求非负：0 = 关掉这个状态（门禁里 freshMs === 0 即不判 fresh） */
  var newFresh = Number($('freshSeconds').value);
  if (!isFinite(newFresh) || newFresh < 0) {
    toast('刚保过提示要填 0 或正数（秒）', true);
    return;
  }
  /* 熔断线：面板只提供 8 档，但 agent 能直接写别的值 → 越界时在这里拦住说清楚（夹取只在后端一处） */
  var newRate = Number($('circuitHitRate').value);
  if (!isFinite(newRate) || newRate < 0.05 || newRate > 0.95) {
    toast('熔断线要在 5%~95% 之间（现在是 ' + (isFinite(newRate) ? Math.round(newRate * 100) + '%' : '非数字') + '）', true);
    return;
  }
  post('/settings', {
    intervalSeconds: newInterval,
    freshSeconds: newFresh,
    circuitCooldownSeconds: Number($('circuitCooldownSeconds').value),
    circuitHitRate: newRate,
    timelineCacheMinutes: Number($('timelineCacheMinutes').value),
    maxTouches: Number($('maxTouches').value),
    maxTouchesTotal: Number($('maxTouchesTotal').value),
    budgetPerSession: Number($('budgetPerSession').value),
    prompt: $('prompt').value,
    maxTokens: Number($('maxTokens').value)
  }).then(function (d) {
    toast(d.ok ? ('默认参数已保存' + (d.warning ? ' ｜ ' + d.warning : '')) : (d.error || '失败'), !d.ok);
    refresh();
  });
};
/** 把当前表格整份提交（与内置相同的条目不入库）。 */
function saveGateTable(okMsg) {
  var t = {}, d = {}, rows = $('gateRows').querySelectorAll('.gt-row');
  for (var i = 0; i < rows.length; i++) {
    var k = rows[i].getAttribute('data-key');
    var def = gateDef(k) || {};
    var tv = rows[i].querySelector('input[data-k="text"]').value.trim();
    var dv = rows[i].querySelector('input[data-k="detail"]').value.trim();
    if (tv && tv !== def.text) t[k] = tv;
    if (dv && dv !== def.detail) d[k] = dv;
  }
  post('/settings', { gateText: t, gateDetail: d }).then(function (r) {
    if (r.ok) setGateDirty(false);
    toast(r.ok ? (okMsg || '门禁文案已保存') : (r.error || '失败'), !r.ok);
    refresh();
  });
}
/** 看这一条的内置文案（就地展开，不覆盖输入框）。 */
function seeBuiltin(btn) {
  var row = btn.parentNode;
  var key = row.getAttribute('data-key');
  var d = gateDef(key) || {};
  var box = row.nextElementSibling;
  if (!box) return;
  var open = BUILTIN_OPEN[key] !== true;
  BUILTIN_OPEN[key] = open;
  box.innerHTML = open ? builtinText(d) : '';
  box.style.display = open ? 'block' : 'none';
}
/** 只恢复这一条。 */
function resetOneGate(btn) {
  var row = btn.parentNode;
  var k = row.getAttribute('data-key');
  var d = gateDef(k) || {};
  row.querySelector('input[data-k="text"]').value = d.text;
  row.querySelector('input[data-k="detail"]').value = d.detail || '';
  saveGateTable('「' + (d.text || k) + '」已恢复内置');
}
$('saveCandText').onclick = function () {
  if (candSig() === CAND_SNAP) { toast('候选文案没有改动，未提交'); return; }
  saveCandTable('候选文案已保存（留空或与内置相同的不入库）');
};
$('resetCandText').onclick = function () {
  if (!confirm('清空所有自定义候选文案，全部回默认？')) return;
  post('/settings', { candText: {} }).then(function (d2) {
    toast(d2.ok ? '已恢复默认' : (d2.error || '失败'), !d2.ok);
    CAND_DIRTY = false;
    refresh();
  });
};
$('saveGateText').onclick = function () {
  /** 无改动就别提交、也别弹「已保存」—— 误触保存按钮时那句 toast 是假信息。 */
  if (gateSig() === GATE_SNAP) { toast('门禁文案没有改动，未提交'); return; }
  saveGateTable('门禁文案已保存（留空或与内置相同的不入库）');
};
$('cancelGateText').onclick = function () {
  setGateDirty(false);
  if (STATE && STATE.settings) paintGateRows(STATE.settings);
  toast('已取消未保存的修改，填回已保存的文案');
};
$('resetGateText').onclick = function () {
  if (!confirm('清空所有自定义门禁文案，全部回默认？')) return;
  post('/settings', { gateText: {}, gateDetail: {} }).then(function (d2) {
    toast(d2.ok ? '已恢复默认' : (d2.error || '失败'), !d2.ok);
    refresh();
  });
};
$('resetColW').onclick = function () {
  post('/settings', colPatch({})).then(function (d) {
    toast(d.ok ? '列宽已恢复默认' : (d.error || '失败'), !d.ok);
    refresh();
  });
};
$('saveCols').onclick = function () {
  post('/settings', { columns: collectCols() })
    .then(function (d) { toast(d.ok ? '列设置已保存' : (d.error || '失败'), !d.ok); refresh(); });
};
$('savePrices').onclick = function () {
  post('/settings', {
    prices: { hit: Number($('priceHit').value), miss: Number($('priceMiss').value), out: Number($('priceOut').value) }
  }).then(function (d) {
    toast(d.ok ? '价格已保存 —— w/r、次数上限、盈亏平衡全都跟着变了' : (d.error || '失败'), !d.ok);
    /** 改价后已打开的详情必须重算重拉（账本 cost 是快照，展示按当前价）。 */
    /** typeof 守卫：测试沙箱按名字抽函数，没抽到的名字直接调会抛错。 */
    if (d.ok && typeof reloadTimelineIfOpen === 'function') reloadTimelineIfOpen();
    refresh();
  });
};
$('saveTools').onclick = function () {
  /** 两开关都读**按钮当前态**（原来读已保存值 → 切了也没用，等于假开关）。 */
  var on = isTglOn($('labExpose'));
  var onMain = tglOn('exposeKeepaliveTool');
  post('/settings', { exposeLabTools: on, exposeKeepaliveTool: onMain }).then(function (d) {
    toast(d.ok
      ? ('主工具 cache_keepalive 已' + (onMain ? '开放给 agent' : '从工具面注销') + '（工具面变了，缓存下轮重算）')
      : (d.error || '失败'), !d.ok);
    refresh();
  });
};

/* ── 恢复默认：把本卡字段填回推荐值，再点该卡自己的保存按钮 ───────────── */
var RECOMMENDED = {
  defaults: {
    intervalSeconds: 14400, freshSeconds: 300, circuitHitRate: 0.5, circuitCooldownSeconds: 0, timelineCacheMinutes: 10, maxTouches: 9, maxTouchesTotal: 0,
    budgetPerSession: 0.5, maxTokens: 1, prompt: 'Reply with exactly: OK'
  },
  prices: { priceHit: 0.02, priceMiss: 1, priceOut: 4 },
  tools: { exposeLabTools: true, exposeKeepaliveTool: true }
};
function fillAndSave(card, saveBtnId) {
  var vals = RECOMMENDED[card];
  for (var key in vals) {
    if (!Object.prototype.hasOwnProperty.call(vals, key)) continue;
    var el = $(key);
    if (!el) continue;
    if (el.classList && el.classList.contains('toggle')) setToggle(el, vals[key] === true);
    else el.value = vals[key];
  }
  $(saveBtnId).click();
}
$('resetAuto').onclick = function () { fillAndSave('auto', 'saveAuto'); };
$('resetDefaults').onclick = function () { fillAndSave('defaults', 'saveDefaults'); };
$('resetPrices').onclick = function () { fillAndSave('prices', 'savePrices'); };
$('resetTools').onclick = function () {
  setTgl($('labExpose'), true);
  fillAndSave('tools', 'saveTools');
};

$('tlClose').onclick = function () { closeTlAny(); overlayCloseHost(); };
$('tlKind').onchange = function () { patchTlPref({ kind: $('tlKind').value }); paintTimeline(); };
/* 粒度是后端算的（要聚合全量日志），改了得重新拉一次数据 */
$('tlGran').onchange = function () {
  patchTlPref({ gran: $('tlGran').value });
  if (TL_DATA && TL_DATA.id) { $('tlAxis').innerHTML = '<div class="dim" style="padding:12px">按新粒度重算…</div>'; fetchTimeline(TL_DATA.id); }
};
$('tlSort').onchange = function () { patchTlPref({ sort: $('tlSort').value }); paintTimeline(); };
$('tlCycle').onchange = function () { patchTlPref({ cycle: $('tlCycle').value }); paintTimeline(); };
$('tl').onclick = function (e) { if (e.target === $('tl')) $('tl').style.display = 'none'; };

$('openHoliday').onclick = function () { $('holidayBox').className = 'show'; };
$('holidayClose').onclick = function () { closeHolidayAny(); };
$('holidayBox').onclick = function (e) { if (e.target === $('holidayBox')) closeHolidayAny(); };
$('saveHoliday').onclick = function () {
  post('/settings', { tariff: collectTariff() }).then(function (d) {
    toast(d.ok ? '节假日表已保存' : (d.error || '失败'), !d.ok);
    TARIFF_DIRTY = false; refresh();
  }).catch(function (e) { toast('失败: ' + e, true); });
};
$('resetHoliday').onclick = function () {
  $('holidayList').value = DEFAULT_TARIFF_UI.holidays.map(function (h) { return h.date + ' ' + h.name; }).join(NL);
  TARIFF_DIRTY = true;
  toast('已填回 2026 默认表 —— 点「保存节假日表」生效');
};
$('helpBtn').onclick = function () {
  var host = overlayTryHost('help');
  if (host === null) { $('help').style.display = 'block'; OVERLAY_HOSTED.help = false; return; }
  /* 先按「宿主接管」记账：250ms 内按 Esc 也能关掉；宿主没 ACK 再改回本地显示 */
  OVERLAY_HOSTED.help = true;
  setTimeout(function () { if (!overlayTaken(host)) { OVERLAY_HOSTED.help = false; $('help').style.display = 'block'; } }, 250);
};
$('helpClose').onclick = function () { closeHelpAny(); overlayCloseHost(); };
/**
 * Esc 关弹层 —— **必须在面板侧监听**：插件版焦点在 iframe 内，keydown 不会冒泡到父文档，
 * 宿主那层的监听永远收不到（这是「插件版 Esc 关不掉」的真正原因）。
 * 用捕获阶段，免得被别的 handler 抢；**没有弹层时不吃这个键**（不干扰 DSH 自己的 Esc）。
 */
document.addEventListener('keydown', function (ev) {
  if (ev.key !== 'Escape' && ev.keyCode !== 27) return;
  /**
   * 详情页（?embed=1&tl=）自己**就是**宿主那个「保温详情」覆盖层的 iframe：
   * 这里的 #tl 是 is-detail 的内联显示、不是浮层，本地没有可关的东西；
   * 按 Esc 的唯一语义就是让宿主把整个覆盖层收起来。
   * ⚠️ 绝不在这里设 #tl display:none —— 宿主卡片还在，就变成「关了一半」的空壳。
   */
  /* 只有「宿主覆盖层里的详情页」（embed + tl）才走这条：整张卡片由宿主管。 */
  if (IS_DETAIL && EMBED) {
  ev.stopPropagation();
  try { overlayCloseHost(); } catch (err) { /* 没宿主就算了 */ }
  return;
  }
  var closed = false;
  if (closeHolidayAny()) closed = true;
  if (closeTlAny()) closed = true;
  /* 说明页放最后关：它的层级最低（三者不会同时开，但顺序稳定些好排查） */
  if (closeHelpAny()) closed = true;
  if (!closed) return;
  ev.stopPropagation();
  /* 插件版覆盖层是宿主画的，本地关掉之后还要让它也收起来 */
  try { overlayCloseHost(); } catch (err) { /* 没宿主就算了 */ }
}, true);
$('help').onclick = function (e) { if (e.target === $('help')) { closeHelpAny(); overlayCloseHost(); } };

$('refresh').onclick = function () { refresh(true); };
$('gotoCur').onclick = function () { gotoCurrent(); };
$('openWeb').onclick = function () { openWebPanel(); };
$('hideSubagent').onclick = function () { flipToggle(this); };
$('hideBlank').onclick = function () { flipToggle(this); };
$('onlyLive').onclick = function () { flipToggle(this); };
$('more').onclick = function () { SHOWN += Math.max(10, Number($('pageSize').value) || 50); render(); };
$('all').onclick = function () { SHOWN = 1e9; render(); };
$('q').oninput = function () { SHOWN = 0; saveFilters(); render(); };
$('sortBy').onchange = function () { SHOWN = 0; saveFilters(); render(); };
$('sortRev').onclick = function () { flipToggle(this); };
$('hideArchived').onclick = function () { flipToggle(this); };
$('pageSize').onchange = function () { SHOWN = 0; saveFilters(); render(); };
document.addEventListener('click', msExclusive, true);
document.addEventListener('click', msCloseOutside);
/** toggle 不冒泡，但捕获阶段能收到 —— 打开瞬间做一次右对齐。 */
document.addEventListener('toggle', function (ev) {
  var t = ev.target;
  if (t && t.open && t.className && String(t.className).indexOf('ms') >= 0) msFit(t);
}, true);

/* 宿主覆盖层用 iframe 嵌本页时会带 ?tl=<会话 id>：加载完自动打开那条时间轴 */
var TL_AUTO = (function () {
  var m = /[?&]tl=([^&]+)/.exec(window.location.search);
  if (m === null) return '';
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
})();
loadFilters();   // 先恢复上次的筛选（顺带建好多选面板），再拉数据 —— 避免闪烁成默认视图
loadTlPrefs();
applyTlPrefs();   /* 静态 option 的那几项先套上；cycle 等 renderTimeline 重建选项后再套 */
try {
  var lastTab = localStorage.getItem('cache-keepalive:tab');
if (lastTab === 'settings') switchTab(lastTab);
} catch (e) { /* 隐私模式等，忽略 */ }
refresh();
/**
 * 只有**主面板**才每 15 秒自动整刷。
 * 详情 iframe（?embed=1&tl=…）里整刷会让内容闪、数据清空再回来。
 * 需要更新就由用户点「刷新」（面板里的按钮仍在）。
 */
if (!IS_DETAIL) setInterval(refresh, 15000);
/**
 * 视口变了（打开/关闭 DevTools、iframe 被压、窗口缩放）→ 重算列宽。
 * **防抖 150ms**：DevTools 拖拽时会连续几十次 resize，不防抖会把主线程拖死。
 * **拖拽中跳过**：那时 RS 有自己的布局循环，插手会把用户正在拖的值打乱。
 * 存储不在这里动 —— renderHead 只改显示，落盘只由拖拽结束/恢复默认触发。
 */
var RESIZE_TIMER = 0;
window.addEventListener('resize', function () {
  if (RS !== null) return;
  if (RESIZE_TIMER !== 0) clearTimeout(RESIZE_TIMER);
  RESIZE_TIMER = setTimeout(function () { RESIZE_TIMER = 0; if (IS_DETAIL) fitDetailAxis(); else renderHead(); }, 150);
});
if (TL_AUTO !== '') {
  /**
   * 详情模式：**立刻**开时间轴，一秒都不等 —— 等 400ms 会先露出会话列表（用户看到的「小保温页」）。
   * openTimeline 只依赖 URL 里的 id，不依赖 /state 先回来。
   */
  try { openTimeline({ getAttribute: function () { return TL_AUTO; }, getAttribute_: 0 }); } catch (e) { /* 会话不存在就算了 */ }
}
</script>
</body>
</html>
`
/** 面板 HTML。 */
export const PANEL_HTML = PANEL_SRC.split('__BUILD_ID__').join(BUILD_ID)

