/**
 * client 半边 —— 在 DSH 界面里加一个「缓存保温」页签（`conversation.view` 席位）。
 *
 * ## 为什么只有页签，没有侧边栏按钮
 * 侧边栏入口（`sidebar.footer.action`）本来是想开新窗口看面板，但**桌面版宿主不放行**：
 * `window.open` 被 `setWindowOpenHandler` 拦下，**返回 null 的同时窗口其实已经开了**
 * （所以任何"多路兜底"都会变成开两个）。web 版虽然能开，但和页签重复。
 * 2026-10-15 用户拍板：**只留页签**。
 *
 * ## 页签内容
 * 用 iframe 内嵌 host 面板（`?embed=1` 让面板隐藏自己的页头，避免与外层标题重复）——
 * 不重写一套 React：host 那套已经完整，内嵌零重复实现；且 iframe 是独立文档，
 * 不污染渲染端的模块图与样式。
 *
 * ## 三条硬约束（别改）
 *  ① 产物是 **CJS bundle**，外层包 `window.__ModuleLoader__.load({ id, factory })`
 *     —— 由 `scripts/build-client.mjs` 的 banner/footer 注入（含幂等守卫）。
 *  ② `react` / `react-dom` / `jsx-runtime` / `@deepseek-ai/*` 一律 **external**。
 *  ③ JSX 用 classic runtime（`React.createElement`）。
 */
import * as React from 'react'

/** 必须等于 `package.json` 的 name（含 scope），且与 build 脚本的 ID 一致。 */
export const name = '@dsh-external/dsh-cache-keepalive'

export const inject = ['slots'] as const

const VIEW_ID = 'cache-keepalive-view'
const STYLE_ID = 'dsh-cache-keepalive-style'

/** host 面板路由（相对形式；web 版同源可直接用）。 */
const PANEL_PATH = '/api/cache-keepalive/panel'

const CSS = `
/**
 * 页签根节点：**必须带 data-conversation-composer-overlay 属性**（见 KeepaliveView）。
 * 它会命中宿主两条规则，把 .viewArea 从"高度由内容撑开"还原成确定高度，
 * 于是 height:100% 才有效 —— 否则百分比高度会退化成 auto（实测踩过：那时只能
 * 猜 calc(100vh - 168px)，窗口/侧栏一变就不准）。
 * 同时它还会隐藏宿主的拉宽手柄（全宽面板本来就该关）。
 */
.ck-view {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
/* iframe 吃满剩余高度、自己滚动 */
.ck-frame {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  border: 0;
  display: block;
}
`

/** 一次性注入样式（判重，重复注册不叠加）。 */
function installStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

/**
 * 面板地址。
 *
 * ① 优先用 host 经 `tapIndex` 注入的绝对地址；取不到则退回相对路径
 *    （**web 版**同源可用；桌面版页签 iframe 实测相对路径也能显示，所以这层回落别删）。
 * ② `sessionId` 交给面板 —— 它用来给列表打「当前」标记、渲染「当前对话」卡。
 *    这个 id 由框架按 slot 的 `scope: 'session'` 自动注入（`props.sessionId`，必定有值）。
 */
function panelUrl(sessionId: string): string {
  const injected = (window as unknown as { __CACHE_KEEPALIVE_PANEL__?: unknown }).__CACHE_KEEPALIVE_PANEL__
  const base = (typeof injected === 'string' && injected !== '') ? injected : PANEL_PATH
  const sep = base.includes('?') ? '&' : '?'
  /**
   * 带上构建号 → 插件一升级这个 src 就变，浏览器必须新建文档 ⇒ 拿到新 JS。
   * 只靠页面自身的 build 哨兵不够：卡在旧标签页里的旧 JS 根本没有哨兵，永远不会自己换新。
   */
  const build = (window as unknown as { __CACHE_KEEPALIVE_BUILD__?: unknown }).__CACHE_KEEPALIVE_BUILD__
  const v = (typeof build === 'string' && build !== '') ? '&v=' + encodeURIComponent(build) : ''
  return base + sep + 'embed=1' + (sessionId !== '' ? '&current=' + encodeURIComponent(sessionId) : '') + v
}

/** 「对话｜轨迹｜记忆」那一行的页签内容 —— 在 DSH 内嵌面板。 */
function KeepaliveView(props: { sessionId?: unknown }): React.ReactElement {
  const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
  return React.createElement(
    'div',
    { className: 'ck-view', 'data-conversation-composer-overlay': true },
    React.createElement('iframe', {
      className: 'ck-frame',
      src: panelUrl(sessionId),
      title: '缓存保温面板',
    }),
  )
}

/**
 * 宿主覆盖层 —— 「使用说明」与「时间轴详情」要**压过 DSH 输入框**。
 *
 * 为什么必须由 client（跑在宿主文档里）渲染：面板在 iframe 里，`position:fixed` **出不了 iframe**，
 * 永远盖不住宿主的 `[data-composer-seat]`（z-index:7）。
 *
 * 三条硬约束：
 *  ① **非模态** —— 不用 `dialog.showModal()`（会锁宿主交互，打字被打断）。遮罩层 `pointer-events:none`，
 *     只有卡片和关闭按钮可点，所以用户仍然能点输入框/打字（点卡片外就关掉）。
 *  ② **必须带 nonce** 回 ACK —— 面板靠它区分「宿主接管了」还是「没宿主、自己弹」，否则双弹层。
 *  ③ **颜色跟主题** —— 用系统色 `Canvas`/`CanvasText`（自动跟随深色模式），不写死。
 */
const OVERLAY_ID = 'dsh-cache-keepalive-overlay'


/**
 * **第 1 优先：读面板 iframe 里的 `--bg` / `--fg`。**
 *
 * 为什么不读宿主 DOM 的背景色：DSH 里 `body` / `#root` 实测**都是 `rgba(0,0,0,0)` 透明**
 * （用户实测），主题色在内层更深的地方；而 DSH 的深色**不一定跟随**系统 `prefers-color-scheme`
 * （系统浅色 + DSH 强制深色）→ 一路推断都会落到浅色 = 白底。
 *
 * 面板 iframe 同源，它自己的 `--bg` / `--fg` 就是它**真正在用**的底色 —— 变量一定有值，
 * 不受元素是否透明影响。
 */
function themeFromPanel(): { bg: string; fg: string } | undefined {
  const frame = findPanelFrame()
  if (frame === undefined) return undefined
  try {
    const doc = frame.contentDocument
    if (doc === null) return undefined
    const cs = getComputedStyle(doc.documentElement)
    const bg = cs.getPropertyValue('--bg').trim()
    const fg = cs.getPropertyValue('--fg').trim()
    if (bg !== '' && fg !== '') return { bg, fg }
  } catch { /* 跨域 / 文档未就绪 → 走下一层 */ }
  return undefined
}


/**
 * 主题色：**面板变量优先，拿不到再按系统深浅色推算**。
 *
 * 任何一层都**不返回 `Canvas` / `CanvasText`** —— 那是 CSS 系统色，DSH 没声明 `color-scheme`
 * 时就解析成白底黑字，正是「白框」的来源。
 */
function readThemeColors(): { bg: string; fg: string } {
  /** 第 1 层：面板 `--bg` / `--fg`（唯一可靠来源）。 */
  const fromPanel = themeFromPanel()
  if (fromPanel !== undefined) return fromPanel
  /**
   * 第 2 层（`elementFromPoint` 找宿主背景）**故意跳过**：
   * DSH 里 `body` / `#root` 实测全透明，取样点落到宿主白底上就会返回白色 ——
   * 那正是卡片白底的来源（比乱猜更糟）。
   */
  /** 第 3 层：系统深浅色推算。 */
  const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
  return dark ? { bg: '#16181d', fg: '#e8eaee' } : { bg: '#ffffff', fg: '#16181d' }
}

/** 把主题色刷到已挂载的覆盖层上（主题切换时调用）。 */
function repaintOverlay(): void {
  const root = document.getElementById(OVERLAY_ID)
  if (root === null) return
  const { bg, fg } = readThemeColors()
  const card = root.firstElementChild as HTMLElement | null
  if (card !== null) {
    card.style.backgroundColor = bg
    card.style.color = fg
  }
  const frame = root.querySelector('iframe')
  if (frame !== null) frame.style.backgroundColor = bg
}


interface OverlayPayload {
  kind?: unknown
  nonce?: unknown
  html?: unknown
  url?: unknown
}

/** 当前打开的覆盖层清理函数（同名重复打开时先清掉上一个）。 */
let disposeOverlay: (() => void) | undefined

function closeOverlay(): void {
  /** **全删**所有同 id 节点：只删 `getElementById` 拿到的第一个会留下残影（旧节点脱离 DOM 时更糟）。 */
  for (const el of Array.from(document.querySelectorAll('#' + OVERLAY_ID))) el.remove()
  if (disposeOverlay !== undefined) {
    const fn = disposeOverlay
    disposeOverlay = undefined
    fn()
  }
}

/** 面板 iframe 的 `src` 前缀（宿主里那个「缓存保温」页签的 iframe）。 */
const PANEL_SRC_MARK = '/api/cache-keepalive/panel'

/**
 * 找宿主里「缓存保温」面板的 iframe。
 *
 * 卡片要**居面板容器正中**（用户拍板），所以必须先量到它；找不到就回落整页居中。
 */
function findPanelFrame(): HTMLIFrameElement | undefined {
  for (const el of Array.from(document.querySelectorAll('iframe'))) {
    /**
     * **必须跳过自己覆盖层里的 iframe**：`tl` 卡的 iframe `src` 也含同一前缀。
     * 不跳过就会自锁 —— 真面板一走（切页签/卸载）它就量到自己卡里的 iframe，
     * 摆卡 → 卡里 iframe 尺寸随卡变 → 100ms 轮询自反馈，回落分支永不触发（实测卡片漂到屏幕外）。
     */
    if (el.closest('#' + OVERLAY_ID) !== null) continue
    const src = el.getAttribute('src') ?? ''
    if (src.includes(PANEL_SRC_MARK)) return el
  }
  return undefined
}

/** 网页版（`v-cli`）顶端偏移。 */
const CARD_TOP = 8
/** 浏览器实例插件版（`v-plugin`，非桌面）。 */
const CARD_TOP_PLUGIN = 24
/** 桌面版量不到面板矩形时的兜底（用户实测顶栏约 50px）。 */
const CARD_TOP_DESKTOP_FALLBACK = 50

/** 读面板 iframe 的 `body.className`（服务端打的 `v-cli` / `v-plugin` / `v-desktop`）。 */
function panelBodyClass(): string {
  try {
    return findPanelFrame()?.contentDocument?.body?.className ?? ''
  } catch { return '' }
}

function isDesktopPanel(): boolean {
  return /\bv-desktop\b/.test(panelBodyClass())
}

function isWebPanel(): boolean {
  return /\bv-cli\b/.test(panelBodyClass())
}

/**
 * 顶端偏移：
 * - 桌面版（`v-desktop`）：**自适应 = 面板 iframe 的 `rect.top`**（面板本来就在顶栏下面，
 *   它的顶边就是「内容该从哪开始」；顶栏高度变了自动跟着走），夹在 `0~200` 防异常值，
 *   面板贴顶（`rect.top === 0`）就用 0；**量不到矩形**才回落 `CARD_TOP_DESKTOP_FALLBACK`。
 * - 网页版（`v-cli`）：`CARD_TOP`。
 * - 浏览器插件版（`v-plugin`）：`CARD_TOP_PLUGIN`。
 */
function topOffsetFor(rect: DOMRect | undefined): number {
  if (isDesktopPanel()) {
    if (rect === undefined) return CARD_TOP_DESKTOP_FALLBACK
    return Math.min(200, Math.max(0, Math.round(rect.top)))
  }
  return isWebPanel() ? CARD_TOP : CARD_TOP_PLUGIN
}



function mountOverlay(data: OverlayPayload, ev: MessageEvent): void {
  if (typeof document === 'undefined' || document.body === null) return
  closeOverlay()
  const kind = data.kind === 'tl' ? 'tl' : 'help'

  /** 挂载时读一次（不每次渲染都读）；主题切换由 `apply()` 里的监听器刷新。 */
  const theme = readThemeColors()

  const root = document.createElement('div')
  root.id = OVERLAY_ID
  root.setAttribute('data-ck-overlay', kind)
  /**
   * 遮罩：**铺满整个窗口**（压过宿主输入卡），背景半透明。
   * 与网页版 `#help` / `#tl` 同口径：固定 45% 黑，不跟主题。
   */
  root.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:9999',
    'pointer-events:auto', 'box-sizing:border-box',
    'padding:24px', 'overflow:auto',
    /** 与网页版 `#help` / `#tl` 一致：固定 45% 黑，**不跟主题**（用户明确要求）。 */
    'background:rgba(0,0,0,.45)',
  ].join(';')

  const card = document.createElement('div')
  /**
   * 卡片摆放（用户拍板的口径）：
   *  - 宽 `min(1020, 面板宽 − 48)` —— **说明页与详情页同宽**（原来说明是 860）
   *  - 顶端固定贴**窗口顶 8px**（不是面板顶 —— 顶部超出面板是预期的）
   *  - 底边保持原位置 `rect.bottom − 24`
   *  - 水平居面板容器正中
   *  - 找不到面板 iframe → 回落整页居中（顶端同样 8px）
   */
  const CARD_MAX_W = 1020
  card.style.cssText = [
    'pointer-events:auto', 'position:absolute', 'box-sizing:border-box',
    'display:flex', 'flex-direction:column',
    'background:' + theme.bg, 'color:' + theme.fg,
    'border:1px solid color-mix(in srgb, currentColor 18%, transparent)',
    'border-radius:12px', 'box-shadow:0 18px 50px rgba(0,0,0,.45)',
    'overflow:hidden',
  ].join(';')

  /**
   * 卡片摆放（用户拍板的口径）：
   *  - 宽 `min(1020, 面板宽 − 48)` —— 说明页与详情页同宽
   *  - 顶端偏移走 `topOffsetFor(rect)`：桌面版自适应面板顶边 / 插件版 24 / 网页版 8
   *  - 底边保持 `rect.bottom − 24`（顶端下移时高度相应减少）
   *  - 水平居面板容器正中；找不到面板 iframe → 回落整页居中
   */
  const placeCard = (): boolean => {
    const frame = findPanelFrame()
    const rect = frame === undefined ? undefined : frame.getBoundingClientRect()
    const topOffset = topOffsetFor(rect)
    if (rect === undefined || rect.width < 40 || rect.height < 40) {
      /** 回落：水平居中、顶端同样用 topOffset。 */
      card.style.left = '50%'
      card.style.top = topOffset + 'px'
      card.style.transform = 'translateX(-50%)'
      card.style.margin = '0'
      card.style.width = 'min(' + CARD_MAX_W + 'px, calc(100vw - 48px))'
      card.style.maxHeight = 'calc(100vh - ' + (topOffset + 8) + 'px)'
      card.style.height = 'calc(100vh - ' + (topOffset + 8) + 'px)'
      return false
    }
    const w = Math.min(CARD_MAX_W, Math.max(120, rect.width - 48))
    /** **底边不变**：`rect.bottom − 24` 是固定的下沿，高度随 topOffset 相应减少。 */
    const h = Math.max(200, (rect.bottom - 24) - topOffset)
    card.style.transform = 'none'
    card.style.margin = '0'
    card.style.width = Math.round(w) + 'px'
    card.style.left = Math.round(rect.left + (rect.width - w) / 2) + 'px'
    card.style.top = topOffset + 'px'
    card.style.height = Math.round(h) + 'px'
    card.style.maxHeight = 'none'
    return true
  }
  placeCard()

  /**
   * 关闭按钮：**浮在卡片右上角**（用户拍板）—— 不带标题栏。
   * 说明页正文里本来就有「使用说明 · 机制 · 省钱知识」这个标题，详情页按用户选择不补标题。
   * `card` 自身是 `position:absolute`，本身就是定位祖先，不用再加 relative。
   * 半透明底色是为了**盖住滚过去的内容**。
   */
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '✕'
  close.title = '关闭（Esc）'
  close.style.cssText = [
    'position:absolute', 'top:8px', 'right:8px', 'z-index:2',
    'width:26px', 'height:26px', 'padding:0',
    'display:flex', 'align-items:center', 'justify-content:center',
    'border-radius:6px', 'cursor:pointer',
    'background:color-mix(in srgb, currentColor 12%, transparent)',
    'color:inherit', 'border:0', 'font-size:14px', 'line-height:1',
  ].join(';')

  const body = document.createElement('div')
  body.style.cssText = 'flex:1 1 auto;min-height:0;overflow:auto'
  card.append(body, close)

  if (kind === 'tl' && typeof data.url === 'string' && data.url !== '') {
    /** 详情页保留交互（粒度切换、翻页）→ 同源 iframe，不复制一套 React。 */
    const frame = document.createElement('iframe')
    frame.src = data.url
    frame.title = '保温详情'
    frame.style.cssText = 'width:100%;height:100%;border:0;display:block;background:' + theme.bg
    /** 面板文档 load 之后 `--bg` 才一定可读 —— 那时再刷一次主题色。 */
    /** 面板文档就绪后重刷主题色（那时 `--bg` 才一定可读）。 */
    frame.addEventListener('load', () => { repaintOverlay() }, { once: true })
    body.append(frame)
  } else {
    /** 使用说明是纯静态 HTML（面板 `#help .box` 的 outerHTML）→ 直接塞。 */
    const box = document.createElement('div')
    box.style.cssText = 'padding:16px 18px;font-size:13px;line-height:1.65'
    if (typeof data.html === 'string') box.innerHTML = data.html
    body.append(box)
  }

  root.append(card)
  document.body.append(root)

  /**
   * **挂载后立刻按「当前」主题重刷一次**。
   *
   * 建卡片时读过一次，但那一刻面板 iframe 可能还没就绪（读到的值不可靠）。
   * 不重刷的话卡片会停在那个旧值上 —— 遮罩对、卡片白（真实事故）。
   */
  repaintOverlay()
  /**
   * 再补几轮：面板 iframe 可能比覆盖层**晚挂上**，那时第 1 层才读得到 `--bg`。
   * 用固定几轮 `setTimeout` 而不是监听器 —— 不依赖事件机制，确定会跑到。
   * `repaintOverlay` 有 null 守卫，重复调用安全（幂等）。
   */
  for (const ms of [0, 60, 200, 600, 1500]) window.setTimeout(() => { repaintOverlay() }, ms)

  /** 点卡片外（含 DSH 输入框）→ 关闭。`pointer-events:none` 让事件直达宿主，这里用捕获阶段兜住。 */
  const onPointerDown = (e: PointerEvent): void => {
    if (document.getElementById(OVERLAY_ID) !== root) return
    if (card.contains(e.target as Node)) return
    closeOverlay()
    postToPanel({ type: 'cache-keepalive:overlay-close', v: 1, nonce: data.nonce })
  }
  /** ESC 关闭。 */
  const onKey = (e: KeyboardEvent): void => {
    /** 身份校验：只对**当前挂载的这个**覆盖层生效（旧监听不能干扰新实例）。 */
    if (document.getElementById(OVERLAY_ID) !== root) return
    if (e.key !== 'Escape') return
    closeOverlay()
    postToPanel({ type: 'cache-keepalive:overlay-close', v: 1, nonce: data.nonce })
  }

  /**
   * **把 Esc 监听同时注入详情页 iframe 内部**（在 `onKey` 定义之后绑，避免 TDZ）。
   *
   * 详情页打开后焦点在 iframe 里，按 Esc 的事件只在 iframe 内发生、**不冒泡到父文档**，
   * 父文档的 keydown 收不到 → 用户觉得「Esc 关不掉」（真实事故）。同源才能注入，跨域跳过。
   */
  if (kind === 'tl') {
    const tlFrame = body.querySelector('iframe')
    if (tlFrame !== null) {
      /**
       * 幂等重绑：**先移除再添加**。
       *
       * 不能用 `{ once: true }` —— iframe 先设 `src` 再 append，初始的 `about:blank` 可能先触发一次 load，
       * 把 once 消耗掉，真实文档那份 Esc 监听就永远绑不上（真实事故）。每次 load 都重绑才稳。
       */
      const bindInner = (): void => {
        try {
          const innerDoc = tlFrame.contentDocument
          if (innerDoc === null) return
          innerDoc.removeEventListener('keydown', onKey, true)
          innerDoc.addEventListener('keydown', onKey, true)
        } catch { /* 跨域，父文档监听兜底 */ }
      }
      bindInner()
      tlFrame.addEventListener('load', bindInner)
    }
  }
  const onCloseClick = (): void => {
    closeOverlay()
    postToPanel({ type: 'cache-keepalive:overlay-close', v: 1, nonce: data.nonce })
  }

  close.addEventListener('click', onCloseClick)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKey, true)

  /**
   * 面板被拖动 / 窗口 resize / 侧栏收放 → 卡片跟着走。
   * `resize` 管窗口，`ResizeObserver` 管面板自身尺寸，100ms 轮询管「面板被拖到别处」。
   */
  const onResize = (): void => { placeCard() }
  window.addEventListener('resize', onResize)
  const observed = findPanelFrame()
  const ro = observed !== undefined && typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => { placeCard() })
    : undefined
  if (ro !== undefined && observed !== undefined) ro.observe(observed)
  let lastSig = ''
  const timer = window.setInterval(() => {
    const f = findPanelFrame()
    const r = f?.getBoundingClientRect()
    const sig = r === undefined ? 'none' : [r.left, r.top, r.width, r.height].map((v) => Math.round(v)).join(',')
    if (sig !== lastSig) { lastSig = sig; placeCard() }
  }, 100)

  /** 关掉时把监听与定时器全部摘掉（否则重复打开会累积）。 */
  disposeOverlay = () => {
    close.removeEventListener('click', onCloseClick)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', onResize)
    if (ro !== undefined) ro.disconnect()
    window.clearInterval(timer)
  }

  /** ACK **必须带 nonce**（面板按 nonce 判「宿主接管了」；不带就会双弹层）。 */
  postToPanel({
    type: 'cache-keepalive:overlay-ack',
    v: 1,
    nonce: data.nonce,
    origin: window.location.origin,
  })

  /** 来源窗（面板 iframe）—— 用来回消息；拿不到就广播。 */
  function postToPanel(msg: Record<string, unknown>): void {
    const target = ev.source as Window | null
    try {
      /** `file://` 与 sandbox iframe 的 `origin` 是字符串 `'null'` —— 直接当 targetOrigin 会抛（实测 ACK 发不出去）。 */
      const origin = ev.origin === '' || ev.origin === 'null' ? '*' : ev.origin
      if (target !== null) target.postMessage(msg, origin)
      else window.postMessage(msg, '*')
    } catch { /* 宿主/面板已销毁，忽略 */ }
  }
}

export function apply(ctx: any): void {
  installStyles()

  /**
   * 面板里「🌐 网页版打开」在 **DSH 右栏内嵌** 模式下会 `postMessage` 过来。
   *
   * 为什么必须绕这一道：面板跑在 iframe 里，拿不到宿主的 `sidebarRight` 服务；
   * 而本组件活在宿主渲染端，持有它。跨源所以只能 postMessage（发 '*'、只认自己的 type）。
   * 找不到内嵌浏览器（比如 web profile 没装那个插件）就落回系统浏览器。
   */
  const onMessage = (ev: MessageEvent): void => {
    const data = ev.data as { type?: unknown; url?: unknown } | null
    if (data === null || typeof data !== 'object') return
    /** 面板请求宿主代渲染覆盖层（使用说明 / 时间轴详情）—— 唯一能在宿主文档里压过输入框的办法。 */
    if (data.type === 'cache-keepalive:overlay') {
      mountOverlay(data as OverlayPayload, ev)
      return
    }
    /**
     * 面板发来的关闭命令（详情页 Esc / 面板内点 ✕ / 插件版说明页 Esc）。
     *
     * 之前没有这个分支 → 所有关闭命令被**静默丢弃**，用户点了/按了都没反应（真实事故）。
     * 不校验 nonce：面板是被宿主被动打开的 iframe，手里没有 nonce；`closeOverlay()` 本身就是「全删同 id」。
     */
    if (data.type === 'cache-keepalive:overlay-close') {
      closeOverlay()
      return
    }
    if (data.type !== 'cache-keepalive:open-panel') return
    const url = typeof data.url === 'string' ? data.url : ''
    if (url === '') return
    const tabs = ctx.get('sidebarRightTabs') as { get?: (kind: string) => unknown } | undefined
    const right = ctx.get('sidebarRight') as { openTab?: (kind: string, opts: unknown) => void } | undefined
    if (typeof right?.openTab === 'function' && tabs?.get?.('browser') !== undefined) {
      right.openTab('browser', { params: { url } })
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  window.addEventListener('message', onMessage)

  /**
   * 主题切换时刷新已挂载覆盖层的颜色。
   *
   * `matchMedia` 管系统深浅色；`MutationObserver` 管 DSH 自己的主题开关（改 class/内联样式）。
   * **整块包 try/catch**：任一 API 缺失都不能打断 `apply()` —— 否则下面的 message 监听注册不上，
   * 覆盖层就完全不出（踩过）。
   */
  try {
    /**
     * 主题切换时刷新已挂载覆盖层的颜色。
     *
     * 两条路都接：`matchMedia` 管系统深浅色切换；`MutationObserver` 管 DSH 自己的主题开关
     * （它靠改 `html`/`body` 的 class 或内联样式，不一定动 `prefers-color-scheme`）。
     */
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined
    const onScheme = (): void => { repaintOverlay() }
    mq?.addEventListener('change', onScheme)
    const mo = typeof MutationObserver === 'undefined'
      ? undefined
      : new MutationObserver(() => { repaintOverlay() })
    if (mo !== undefined) {
      for (const el of [document.documentElement, document.body]) {
        if (el !== null) mo.observe(el, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
      }
    }
    ctx.effect(
      () => () => {
        mq?.removeEventListener('change', onScheme)
        mo?.disconnect()
      },
      'cache-keepalive: 覆盖层主题跟随',
    )
  } catch { /* 主题跟随失败不影响覆盖层本身 */ }
  ctx.effect(
    () => () => window.removeEventListener('message', onMessage),
    'cache-keepalive: 面板请求打开的转达',
  )

  // 「对话」那一行的页签（order 200 → 排最右；既有：记忆 10 / 技能 20 / 待办 30 / Memory Evolve 设置 120）
  ctx.effect(
    () => ctx.slots.inject('conversation.view', () => ctx.slots.register({
      name: 'conversation.view',
      id: VIEW_ID,
      order: 200,
      label: '缓存保温',
    }, KeepaliveView)),
    'cache-keepalive: conversation view tab',
  )
}
