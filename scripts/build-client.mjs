/**
 * 构建 **client 半边**：`src/client/index.tsx` → `lib/client.js`
 *
 * host 半边**继续源码直跑**（`package.json` 的 `main = ./src/index.ts`），不打包。
 *
 * ## 产物契约（抄自 dsh-session-id/scripts/build.mjs，别乱改）
 *  - 必须是 **CJS bundle**，外层包 `window.__ModuleLoader__.load({ id, factory })`
 *    —— 由下面 banner/footer 注入，源码里看不到这层壳；注入器的预检会查 `__ModuleLoader__` 特征。
 *  - `react` / `react-dom` / `react/jsx-runtime` / `@deepseek-ai/*` 一律 **external**：
 *    宿主用冻结模块表提供它们，打进来会变成**两份 React**（必炸）。
 *  - JSX 用 **classic runtime**（`React.createElement`）：少一个 require，少一处会随宿主漂移的契约。
 *
 * ## esbuild 从哪来
 * 本包的 `npm i -D esbuild` 在本机失败过（npm 自身报 `Cannot read properties of null`），
 * 所以做成**三级探测**：本地依赖 → 环境变量 ESBUILD_PATH → 同机别的插件借一份。
 * 装了本地依赖就会走第一级，这个 fallback 平时用不到。
 *
 * 跑法：`node scripts/build-client.mjs`
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 模块表里的 id —— **必须等于 `package.json` 的 name**（含 scope）。
 *
 * ⚠️ 2026-10-15 踩过：这里一度写成短名 `dsh-cache-keepalive`，而包名是
 * `@dsh-external/dsh-cache-keepalive` —— 两者不一致会让渲染端报
 * `duplicate factory registration`（同一个 slot 被按两个身份注册），整个插件装载失败。
 * 对照：`dsh-session-id` 的包名就是短名，所以它怎么写都对；scoped 包必须写全名。
 */
const ID = '@dsh-external/dsh-cache-keepalive'

const require = createRequire(import.meta.url)

function loadEsbuild() {
  const tried = []
  const sources = [
    () => require('esbuild'),                                                        // 本地/全局
    () => (process.env.ESBUILD_PATH !== undefined ? require(process.env.ESBUILD_PATH) : null),
    () => {                                                                          // 同机借用
      const p = join(homedir(), 'dsh-plugins', 'dsh-session-id', 'node_modules', 'esbuild')
      return existsSync(p) ? require(p) : null
    },
  ]
  for (const load of sources) {
    try {
      const mod = load()
      if (mod !== null && mod !== undefined) return mod
    } catch (error) {
      tried.push(String(error.message).slice(0, 80))
    }
  }
  console.error('找不到 esbuild。装一个（npm i -D esbuild），或用 ESBUILD_PATH 指向它的目录。')
  if (tried.length > 0) console.error('已尝试：\n  ' + tried.join('\n  '))
  process.exit(1)
}

const { build } = loadEsbuild()

await mkdir('lib', { recursive: true })

await build({
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  external: ['@deepseek-ai/*', 'react', 'react-dom', 'react/jsx-runtime', 'node:*'],
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  format: 'cjs',
  platform: 'browser',
  target: 'chrome120',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  /**
   * ⚠️ **幂等守卫（必须有）**
   *
   * 渲染端的 `loadShared(url)` 只在**在途**去重（`pendingArrival` 里用完就删），
   * 所以**同一个 URL 先后被请求两次，bundle 就会执行两次**；第二次再
   * `__ModuleLoader__.load({ id })` 就撞上 `duplicate factory registration`，
   * 整个插件的 client 半边装载失败 → `web boot: 1 entry did not activate`。
   * （2026-10-15 桌面版连挂两次就是这个。）
   *
   * 在 bundle 最外面加一道标记：同一个 id 只注册一次，第二次执行直接跳过。
   */
  banner: {
    js: `(function () { if (window.__ModuleLoader__ && !window.__ModuleLoader__.loaded___dsh_cache_keepalive) { window.__ModuleLoader__.loaded___dsh_cache_keepalive = 1; window.__ModuleLoader__.load({ id: "${ID}", factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } }); } })();',
  },
})

console.log(`client 半边已构建 → lib/client.js （模块 id: ${ID}）`)
