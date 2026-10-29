import path from 'node:path'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import legacy from '@vitejs/plugin-legacy'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'
import { builtinWebGameFor } from './shared/builtin-web-games.js'
import { HUGE_STATIC_DIRS } from './scripts/lib/vite-static-exclusions.mjs'

/**
 * 把几个「又大又不需要加工」的静态目录排除在产物复制之外。
 *
 * `public/` 里既有本机数据包，也有数百 MB 的模拟器运行时。Vite 会把 `public/` **整个**
 * 复制到 `dist/client/`；对已经按版本目录发布、后续不会原地覆盖的运行时，再复制一份既占盘
 * 又拖慢构建。目录清单集中在 `scripts/lib/vite-static-exclusions.mjs`：
 *   · cs15/cs16 游戏数据包、QEMU 和部分离线 .NET 文件：无需构建期处理；
 *   · Dolphin、PPSSPP：生成器只新增带版本号的目录，不会原地覆盖旧 URL。
 * js-dos / Ruffle 虽也有版本目录，但其生成脚本允许重写同版本产物，故仍保留 dist 快照。
 *
 * Vite 没有「public 里排除某个子目录」的选项（`copyPublicDir` 只能全开或全关，
 * 全关就得自己把剩下的资源也拷一遍）。所以做法是**构建期间把目录挪出去**：
 * buildStart 移走 → Vite 看不见 → closeBundle 移回来，并在产物里放一根软链，
 * 这样 Express（`/web/:name` 那条路由和 express.static）和本地预览照样读得到
 * —— 两者都会跟随软链。
 *
 * ⚠️⚠️ **移回来只能在 closeBundle 里做，不能提到 buildEnd**。
 * rollup 的钩子顺序是 buildStart → buildEnd → renderStart → writeBundle → closeBundle，
 * 而 Vite 复制 `public/` 就是在 renderStart 那一带（构建日志里 `vite:prepare-out-dir
 * renderStart` 那一行）—— 在 buildEnd 里移回来的话，目录刚好赶在复制之前回到 public，
 * 白忙一场，构建仍会复制这些大目录。
 *
 * ⚠️ 于是失败时的自愈改为两条：下一次 buildStart 先把暂存区里的东西放回去（幂等），
 * 外加一个 `process.on('exit')` 兜底。前者挡「上次崩了」，后者挡「这次崩了」；
 * 只靠 closeBundle 的话，一次语法错误就会让目录凭空消失。
 */
// 可变网页游戏目录和 EmulatorJS 仍不能挪：部署时它们的固定 URL 可能被更新，保留 dist
// 快照才能避免旧 HTML 与新运行时代码在 git pull / build 窗口里混用。
//
// `web/terraria/_framework` 同理（134.9MiB 的 .NET 运行时，不进 git、线上走 R2）：
// 它只会在「本机想离线跑」时出现在 public/ 里，那种时候不该让一次 npm run build
// 顺手把它拷进 dist（慢，而且 dist 会白白胖一圈）。
const HUGE_STATIC = HUGE_STATIC_DIRS

const PUBLIC_DIR = path.resolve(import.meta.dirname, 'public')
const DIST_DIR = path.resolve(import.meta.dirname, 'dist/client')
const STAGE_DIR = path.resolve(import.meta.dirname, '.public-staging')

/**
 * 主站（浏览、登录、搜索、后台）能安全覆盖到的浏览器下限。
 *
 * 模拟器本体仍会受 WebAssembly / WebGL / 内存大小约束，不能因为页面能打开就承诺每个核心
 * 都能跑；但至少这些设备不会在 React 挂载前因为新语法白屏。Vite 8 的默认下限已经抬到
 * Chrome 111 / Safari 16.4，这对仍在使用旧 iPhone、安卓 WebView、电视浏览器的玩家太激进。
 *
 * 不含 IE 11：React 19、CSS 自定义属性、WebAssembly 和本站的模块化运行时都没有一条可靠的
 * IE 路线。硬塞一份能解析的 JS 只会把白屏推迟到下一步，并不等于真的兼容。
 */
const LEGACY_BROWSER_TARGETS = [
  'Chrome >= 64',
  'ChromeAndroid >= 64',
  'Edge >= 79',
  'Firefox >= 67',
  'Safari >= 12',
  'iOS >= 12',
  'Samsung >= 9',
  'not IE 11',
]

/** CSS 也要按同一代浏览器降级；否则 JS 能跑，压缩器却可能产出旧 WebView 不认的颜色语法。 */
const LEGACY_CSS_TARGETS = ['chrome64', 'edge79', 'firefox67', 'safari12', 'ios12']

function restoreAll() {
  for (const rel of HUGE_STATIC) {
    const live = path.join(PUBLIC_DIR, rel)
    const staged = path.join(STAGE_DIR, rel)
    if (existsSync(staged) && !existsSync(live)) {
      mkdirSync(path.dirname(live), { recursive: true })
      renameSync(staged, live)
    }
  }
}

/**
 * legacy 插件会让同一次生产构建进入两次 closeBundle，两边可能同时创建同一根软链。
 * 不能用 existsSync → symlinkSync 的“先检查后执行”：两个钩子都可能看到不存在，随后一边
 * 因 EEXIST 把整次部署构建判失败。这里把“目标已经是正确软链”视为成功，并在竞争窗口内重试。
 */
function ensureDirectorySymlink(source: string, dest: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const stat = lstatSync(dest)
      const linkedSource = stat.isSymbolicLink()
        ? path.resolve(path.dirname(dest), readlinkSync(dest))
        : ''
      if (linkedSource === source) return
      rmSync(dest, { recursive: true, force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    mkdirSync(path.dirname(dest), { recursive: true })
    try {
      symlinkSync(source, dest, 'dir')
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }

  throw new Error(`无法稳定创建静态资源软链：${dest}`)
}

function skipHugeStatic() {
  let armed = false
  return {
    name: 'skip-huge-static',
    apply: 'build' as const,
    buildStart() {
      /*
        旧版曾把整个 cs15 / cs16 目录做成绝对软链。Vite 的 emptyOutDir 为避免越界删除，
        不会清掉指向 public 的目录软链；后续构建于是继续沿用旧入口，服务器打包出来仍可能
        指向另一台机器的绝对路径。只清理这两个已知的历史软链，让本次复制重新落实体目录。
      */
      for (const name of ['cs15', 'cs16']) {
        const legacy = path.join(DIST_DIR, 'web', name)
        try {
          if (lstatSync(legacy).isSymbolicLink()) rmSync(legacy, { force: true })
        } catch {
          /* 第一次构建本来就不存在 */
        }
      }
      // 上一次构建崩在半路的话，暂存区里可能还留着东西 —— 先放回去再重新挪
      restoreAll()
      if (!armed) {
        // 这次崩在半路的兜底。renameSync 是同步的，放在 exit 钩子里是安全的
        process.on('exit', restoreAll)
        armed = true
      }
      for (const rel of HUGE_STATIC) {
        const live = path.join(PUBLIC_DIR, rel)
        const staged = path.join(STAGE_DIR, rel)
        if (!existsSync(live) || existsSync(staged)) continue
        mkdirSync(path.dirname(staged), { recursive: true })
        renameSync(live, staged)
      }
    },
    closeBundle() {
      restoreAll()
      // 产物里不留实体，只留一根软链回源目录；源目录不在（生产机没放这些数据包）
      // 就什么都不做，页面自然 404，不会静默出错
      for (const rel of HUGE_STATIC) {
        const live = path.join(PUBLIC_DIR, rel)
        if (!existsSync(live)) continue
        const dest = path.join(DIST_DIR, rel)
        // 目录被挪走了，产物里本来不该有它；有就是上一次留下的旧实体，删掉再链。
        // legacy 构建会并发进入两次 closeBundle，创建动作必须能容忍另一边已经先完成。
        ensureDirectorySymlink(live, dest)
      }
    },
  }
}

/** 构建预览也要加隔离头；缺少它时 Play! / PPSSPP / Dolphin 会在创建共享内存前直接失败。 */
function isolationHeaders(req: IncomingMessage, res: ServerResponse, next: () => void) {
  // 只隔离独立页；给整站加头会拦掉跨源封面和字体。
  const requestUrl = req.url || ''
  const pathname = requestUrl.split('?')[0]
  const isolatedPlay = /^\/(?:zh-Hans\/|zh-Hant\/|en\/|es\/|fr\/|it\/|de\/|ja\/)?play\/(?:psp|ps2|gamecube|wii)\/[^/]+\/?$/.test(pathname)
  const localPlay = /^\/(?:zh-Hans\/|zh-Hant\/|en\/|es\/|fr\/|it\/|de\/|ja\/)?play-local\/?$/.test(pathname)
  const builtinSlug = /^\/web\/([^/]+)\/?$/.exec(pathname)?.[1]
    || /^\/(?:zh-Hans\/|zh-Hant\/|en\/|es\/|fr\/|it\/|de\/|ja\/)?play\/([^/]+)\/?$/.exec(pathname)?.[1]
  const isolatedBuiltin = Boolean(builtinSlug && builtinWebGameFor(builtinSlug)?.isolated)
  // /play-local 为 PSP 等 pthread 核心开了 COEP。它里面的 Flash 播放框即使同源，
  // 文档自身没有 COEP 也会被 Chromium 替换成 chrome-error://chromewebdata/ 黑屏。
  const flashFrame = pathname === '/flash-frame.html'
  if (pathname === '/linux' || pathname === '/linux.html' || isolatedPlay || localPlay || isolatedBuiltin || pathname.startsWith('/dolphin/') || pathname.startsWith('/ppsspp/')) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    if (pathname === '/linux') req.url = `/linux.html${requestUrl.slice('/linux'.length)}`
  }
  if (flashFrame) {
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  }
  if (pathname === '/qemu-wasm/qemu-system-x86_64.worker.js') {
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
  }
  if (pathname === '/play/Play.js') {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  }
  if (pathname.startsWith('/dolphin/') || pathname.startsWith('/ppsspp/')) {
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  }
  next()
}

/**
 * 提前和封面域名握手。
 *
 * 封面优先走 VITE_COVER_URL，没配时才退回 VITE_ROM_BASE_URL（和 roms.ts 保持一致）。
 * 不预热的话，每一张封面在下载前
 * 都要先走一遍 DNS + TCP + TLS —— 首屏那一批图于是排队握手，看起来就是「图一张张慢慢
 * 冒出来」。这一步把握手提前到 HTML 一开始解析的时候，之后所有封面复用同一条连接。
 *
 * ⚠️ 用**构建时**的地址，不用 localStorage 里的覆盖值：那是管理员本机调试用的，
 * 对访客没意义，而 preconnect 是写死在 HTML 里的，也没法跟着运行时变。
 * ⚠️ 不加 `crossorigin`：封面是普通 `<img>`（非 CORS 请求），带 crossorigin 开的是
 * 匿名 CORS 连接，反而不会被这些图片复用 —— 字体才需要 crossorigin。
 */
function coverOrigin(env: Record<string, string>): string {
  const raw = String(env.VITE_COVER_URL || env.VITE_ROM_BASE_URL || '').trim()
  if (!/^https?:\/\//i.test(raw)) return '' // 同源路径（/roms）不需要预热
  try {
    return new URL(raw).origin
  } catch {
    return ''
  }
}

/**
 * 两套构建产物：
 *   npm run build:client -> dist/client   浏览器用的静态资源
 *   npm run build:server -> dist/server   给 Express 调用的 render()
 * `npm run build` 会依次跑完两个。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const origin = coverOrigin(env)
  return {
  optimizeDeps: {
    // 这个包用 import.meta.url 定位自带的 zstd.wasm，预打包后地址会丢；交给 Vite 原样处理。
    exclude: ['@bokuweb/zstd-wasm'],
  },
  plugins: [
    react(),
    legacy({
      targets: LEGACY_BROWSER_TARGETS,
      // 这两项是 DOM / Fetch 能力，不在 core-js 的语言特性检测范围内；旧 Safari 必须单独补。
      additionalLegacyPolyfills: [
        'wicg-inert',
        'abortcontroller-polyfill/dist/polyfill-patch-fetch',
      ],
    }),
    tailwindcss(),
    skipHugeStatic(),
    // 必须排在 web-game-static 前面：后者会直接 end(index.html)，排在后面就永远加不上隔离头。
    {
      name: 'isolated-pages',
      configureServer(server) {
        server.middlewares.use(isolationHeaders)
      },
      configurePreviewServer(server) {
        server.middlewares.use(isolationHeaders)
      },
    },
    /*
      生产由 Express 的 `/web/:name` 路由 + express.static 直接提供每个 web 游戏页；
      但 Vite dev 服务器没有这条路由，目录形式的 `/web/cs16/` 会被 SPA 兜底抢成根
      index.html（React 路由匹配不到就渲染 404）。这里补一条仅 dev 用中间件：
      把 `/web/<name>` 和 `/web/<name>/` 直接吐出 `public/web/<name>/index.html`，
      让本地预览和线上行为一致。不影响生产（apply 只对 dev 生效）。
    */
    {
      name: 'web-game-static',
      apply: 'serve' as const,
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?')[0]
          const m = /^\/web\/([^/]+)\/?$/.exec(url)
          if (m) {
            const file = path.join(PUBLIC_DIR, 'web', m[1], 'index.html')
            if (existsSync(file)) {
              res.setHeader('Content-Type', 'text/html; charset=utf-8')
              res.end(readFileSync(file))
              return
            }
          }
          next()
        })
      },
    },
    ...(origin
      ? [
          {
            name: 'cover-preconnect',
            transformIndexHtml: {
              order: 'post' as const,
              handler: () => [
                { tag: 'link', attrs: { rel: 'preconnect', href: origin }, injectTo: 'head-prepend' as const },
                // 老浏览器不认 preconnect；dns-prefetch 只省 DNS，但对它们仍有意义
                { tag: 'link', attrs: { rel: 'dns-prefetch', href: origin }, injectTo: 'head-prepend' as const },
              ],
            },
          },
        ]
      : []),
  ],
  resolve: {
    alias: [
      // 服务端同步组件、浏览器懒加载组件共用同一路由声明，避免 SSR 与水合路由漂移。
      { find: '@/routes/Pages', replacement: path.resolve(import.meta.dirname, './src/routes/Pages.client.tsx') },
      { find: '@', replacement: path.resolve(import.meta.dirname, './src') },
    ],
  },
  build: {
    outDir: 'dist/client',
    cssTarget: LEGACY_CSS_TARGETS,
    /**
     * 生产进程会直接从 dist/client 发静态文件，构建又是在同一目录现场进行。
     * Vite 默认先清空目录：线上已取证到这一秒内 index.html 不存在，
     * SSR 直接 500；旧页面迟加载的哈希 chunk 也会 404，直播观众刷新后就进不来。
     *
     * 不在构建前删旧产物：新文件写完后 index.html 才切到新哈希，而已打开页面
     * 仍能按旧哈希懒加载。重复的只是 assets/ 下带内容哈希的小文件；
     * public 里的大文件是同路径覆盖，不会每次复制出一份新名字。
     */
    emptyOutDir: false,
    rolldownOptions: {
      output: {
        /*
          把 React 全家桶单独切一个 chunk。
          
          目的**不是**减少字节数（总量不变），而是让它的文件名不随业务代码变化：
          /assets/ 下的文件名带内容哈希、响应头是一年 immutable（见 server/src/cache.js），
          所以只要 react 那几条依赖没动，老访客和 Cloudflare 边缘都不用重新下载它。
          不切的话它和业务代码挤在同一个 index chunk 里，改一行文案就整包作废 ——
          那是首屏里最重的一块（gzip 四十多 KB）。

          ⚠️ Rolldown 1.x 已把 advancedChunks 标成弃用别名；这里只留 codeSplitting，
          否则每次现代版和旧浏览器版构建都会各打一条警告，未来升级还可能直接失效。
          ⚠️ test 用正则匹配 node_modules 路径 —— react / react-dom / scheduler 是同一批
          跟着 React 版本走的包，拆开会让它们互相 import 而被再次合并。
        */
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    open: false,
    // 开发期代理：把 /api 转发到本机后端（默认 8788，见 server/src/index.js:511）。
    // 配合前端的 VITE_API_URL=same-origin，npm run dev 时 5173 的页面能直接调后端，
    // 不必额外配 CORS；生产由 Express 同源托管，不会走这里。
    // 想改成别的后端地址：BACKEND_URL=http://127.0.0.1:9000 npm run dev
    proxy: {
      '/api': {
        target: process.env.BACKEND_URL || 'http://127.0.0.1:8788',
        changeOrigin: true,
        // CS1.6 的 /api/cs16/relay 是 WebSocket Upgrade；不打开这项时服务器列表能读，
        // 点 Join 却只在开发环境握手失败，和生产同源 Express 的表现正好相反。
        ws: true,
      },
    },
  },
  }
})
