/**
 * HTTP 路由：给自包含面板提供同源 JSON 接口。
 *
 * 与 dsh-context-doctor 的 `/api/context-doctor/audit` 同款模式
 * （host 路由 + 浏览器侧 fetch，无需 client bundle）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { PANEL_HTML, PANEL_PATH } from './panel.ts'

export const API_PREFIX = '/api/cache-keepalive'

/** 请求体大小上限（防滥用）。 */
const MAX_BODY = 64 * 1024

export interface RouteDeps {
  /**
   * **谁在供数**：`'plugin'` = DSH 实例里的插件版页签，`'cli'` = CLI `--serve` 起的网页版。
   *
   * 缺省 `'plugin'`：插件版 deps 由 `index.ts` 手工构造，缺省值让它零改动。
   * 用途只有一个 —— `html()` 在**服务端**给 `<body>` 带上 `v-cli`/`v-plugin` 类，
   * 让弹层底部那 130px（桌面版输入卡浮层的补偿）**第一帧就正确**：网页版没有输入卡，
   * 若等前端拿到 `/state` 再切 class，打开弹层时会先留 130px 再跳掉。
   *
   * ⚠️ 别用 `?embed=1` 当判据：那是「被 iframe 嵌」，插件版新窗口直开时没有它、
   * 网页版被人 iframe 嵌时又有它 —— 两个边角都会错。
   */
  variant?: 'cli' | 'plugin'
  /**
   * 当前 DSH profile 名（`profileContext.name`，取不到再退 `--profile`）。
   *
   * 用途只有一个：**服务端**判断这是不是桌面版，并在 `<body>` 上打 `v-desktop`。
   * 前端据此固定覆盖层顶部间距 —— 不做任何客户端探测（顶栏高度/UA/协议全都不可靠）。
   * 拿不到就当作「不是桌面版」（安全默认）。
   */
  profile?: string
  /** 当前完整状态快照（面板 10 秒轮询一次）。 */
  snapshot(): unknown
  /** 改某会话策略。`warning` 是「不拦截但值得提醒」的话（例如超过经济学推荐值）。 */
  setPolicy(id: string, patch: Record<string, unknown>): { ok: boolean; error?: string; warning?: string }
  /** 改全局设置。`warning` = 已自动改了别的字段，需要面板显示出来（例如抬高闲置上限）。 */
  setSettings(patch: Record<string, unknown>): { ok: boolean; error?: string; warning?: string }
  /** 立刻对某会话保温一次。`force` = 跳过图片安全阀（用户显式放行）；`via` = 谁触发的（记账用）。 */
  ping(id: string, force?: boolean, via?: 'panel' | 'tool' | 'cli'): Promise<{ ok: boolean; message?: string; error?: string }>
  /** 解除某会话的熔断（重置账本）。 */
  reset(id: string): { ok: boolean; error?: string }
  /** 会话时间轴：每轮真实计费 + 保温记录，按时间合并。`granularity` 可选 step / turn / both。 */
  timeline(id: string, granularity?: string): Promise<Record<string, unknown>>
  /** 面板自己的置顶开关（写 state.json）。 */
  setPinned(id: string, pinned: boolean): { ok: boolean; error?: string }
  /** 清除计费：开一个新保温周期（账本不删，总花费保留历史总和）。 */
  resetCost(id: string): { ok: boolean; cycle?: number; error?: string }
  /** 花费详情：按周期分组。 */
  /**
   * 每个请求进业务逻辑前调一次（插件侧用来把内存 `state` 对齐磁盘）。
   *
   * 为什么必须在**每个**入口都调：插件进程内存持有 `state`，独立 CLI 是另一个进程，
   * 它记的账本条目插件看不见 —— 面板时间轴就少几轮（实测「最后一次 89.1% 不出现在
   * 详情里」）。抛错不拦请求。
   */
  beforeRequest?(): void
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 送面板 HTML。
 *
 * 以前会往页面注入 `window.__CK_PANEL_ABS__`（供面板上的「网页版打开」按钮拼绝对地址，
 * 理由是桌面版页签跑在 `dsh-app://app` 下 `location.origin` 不可信）。**那个按钮已删除**，
 * 全仓对 `__CK_PANEL_ABS__` 的引用只剩这里 —— 注入留在页面里只有一份多余的 `<script>`，删掉。
 */
/** 是不是桌面版 profile（服务端事实，不做客户端探测）。 */
function isDesktopProfile(profile: string | undefined): boolean {
  return String(profile ?? '').trim().toLowerCase() === 'desktop'
}

function html(res: ServerResponse, variant: 'cli' | 'plugin', profile?: string): void {
  /**
   * **服务端就把变体写进 `<body>` 的 class**，让首屏第一帧就正确。
   * 前端仍会在拿到 `/state` 后 `classList.toggle('v-cli', STATE.variant === 'cli')`（panel.ts），
   * 那是幂等的 —— 这里只是把「首屏之前」的那一帧补对。
   *
   * ⚠️ 这里刻意用字符串拼接而不是嵌套模板字符串：`scripts/check-imports.mjs` 的 `strip()`
   * 只会找下一个反引号（不认 `${}` 嵌套），嵌套模板会把后面的注释状态带歪 → 误报「漏掉的导入」。
   */
  const cls = 'v-' + variant + (isDesktopProfile(profile) ? ' v-desktop' : '')
  const body = PANEL_HTML.replace(/<body([^>]*)>/u, (_m, attrs: string) => {
    const got = /class\s*=\s*"([^"]*)"/u.exec(attrs)
    if (got === null) return '<body' + attrs + ' class="' + cls + '">'
    return '<body' + attrs.replace(/class\s*=\s*"[^"]*"/u, 'class="' + got[1] + ' ' + cls + '"') + '>'
  })
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** 读并解析 JSON 请求体（带上限；解析失败返回空对象）。 */
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        resolve({})
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        // 只有「普通对象」才算请求体：null / 数组 / 基本类型一律当空，避免回调里 body.id 踩到怪值
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

/** 构造面板 + API 路由。 */
export function makeRoutes(deps: RouteDeps): WebRoute[] {
  const before = deps.beforeRequest
  /** 缺省 plugin：插件版 deps 由 index.ts 手工构造，不给它加负担。 */
  const variant: 'cli' | 'plugin' = deps.variant ?? 'plugin'
  const profile = deps.profile
  const wrap = (route: WebRoute): WebRoute => {
    const h = route.handler
    if (before === undefined || typeof h !== 'function') return route
    return {
      ...route,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        try {
          before()
        } catch {
          /* 对齐失败就按内存那份继续，不影响接口 */
        }
        return h(req, res)
      },
    }
  }
  const routes: WebRoute[] = [
    {
      kind: 'exact',
      path: PANEL_PATH,
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        html(res, variant, profile)
      },
    },
    {
      /**
       * **轻量健康检查**：回一个固定小串，不扫会话、不读 state.json。
       *
       * 消费者：`cli/keepalive.mjs --serve` 启动前用它判断「这个端口上是不是本程序」。
       * 以前拿 `/state` 当招牌不行 —— 那个响应体随会话数增长（447 条时 347KB），
       * 冷启动实测首字节 861ms、偶发超 1200ms，探测会被误判成「不是本服务」，
       * 于是紧接着 listen 失败 → 报「端口被占用」，用户以为别的程序占着，其实是自己那份。
       */
      kind: 'exact',
      path: `${API_PREFIX}/health`,
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        json(res, 200, { ok: true, app: 'cache-keepalive' })
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/state`,
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        if (req.method !== 'GET') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        try {
          json(res, 200, { ok: true, state: deps.snapshot() })
        } catch (error) {
          json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/policy`,
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        void readBody(req).then((body) => {
          const id = str(body.id)
          if (id === undefined || id === '') {
            json(res, 400, { ok: false, error: '缺少 id' })
            return
          }
          const mode = str(body.mode)
          const patch: Record<string, unknown> = {}
          if (mode !== undefined) {
            if (mode !== 'on' && mode !== 'off' && mode !== 'auto') {
              json(res, 400, { ok: false, error: 'mode 只能是 on / off / auto' })
              return
            }
            patch.mode = mode
          }
          if (str(body.prompt) !== undefined) patch.prompt = str(body.prompt)
          if (num(body.maxTokens) !== undefined) patch.maxTokens = num(body.maxTokens)
          if (num(body.intervalSeconds) !== undefined) patch.intervalSeconds = num(body.intervalSeconds)
          if (num(body.maxTouches) !== undefined) patch.maxTouches = num(body.maxTouches)
          if (str(body.note) !== undefined) patch.note = str(body.note)
          const out = deps.setPolicy(id, patch)
          json(res, out.ok ? 200 : 400, out)
        })
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/settings`,
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        void readBody(req).then((body) => {
          /**
           * **直接透传 body**：字段白名单在 `applySettingsPatch()` 里，路由不再手抄一遍。
           * 手抄会漏 —— 实测漏过 panelOpenMode / autoAllowSubagent，
           * 表现为面板 toast「已保存」但实际没写（假成功）。
           */
          delete body.id
          const out = deps.setSettings(body)

          json(res, out.ok ? 200 : 400, out)
        })
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/ping`,
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        void readBody(req).then((body) => {
          const id = str(body.id)
          if (id === undefined || id === '') {
            json(res, 400, { ok: false, error: '缺少 id' })
            return
          }
          const via = str(body.via)
          deps.ping(
            id,
            bool(body.force) === true,
            via === 'tool' || via === 'cli' ? via : 'panel',
          ).then(
            (out) => json(res, out.ok ? 200 : 400, out),
            (error: unknown) => json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }),
          )
        })
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/reset`,
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        void readBody(req).then((body) => {
          const id = str(body.id)
          if (id === undefined || id === '') {
            json(res, 400, { ok: false, error: '缺少 id' })
            return
          }
          const out = deps.reset(id)
          json(res, out.ok ? 200 : 400, out)
        })
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/timeline`,
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        if (req.method !== 'POST' && req.method !== 'GET') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        // 允许 `?id=` 查询串（方便直接用浏览器/curl 打开），也允许 POST body
        let fromQuery: string | undefined
        try {
          fromQuery = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('id') ?? undefined
        } catch { /* URL 异常就当没有 */ }
        void readBody(req).then(async (body) => {
          const id = str(body.id) ?? fromQuery
          if (id === undefined || id === '') {
            json(res, 400, { ok: false, error: '缺少 id' })
            return
          }
          try {
            json(res, 200, await deps.timeline(id, str(body.granularity)))
          } catch (error) {
            json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        })
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/reset-cost`,
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        void readBody(req).then((body) => {
          const id = str(body.id)
          if (id === undefined || id === '') {
            json(res, 400, { ok: false, error: '缺少 id' })
            return
          }
          const out = deps.resetCost(id)
          json(res, out.ok ? 200 : 400, out)
        })
      },
    },
    {
      kind: 'exact',
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/pin`,
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        void readBody(req).then((body) => {
          const id = str(body.id)
          if (id === undefined || id === '') {
            json(res, 400, { ok: false, error: '缺少 id' })
            return
          }
          const out = deps.setPinned(id, bool(body.pinned) === true)
          json(res, out.ok ? 200 : 400, out)
        })
      },
    },
  ]
  return routes.map(wrap)
}
