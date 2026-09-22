import path from 'node:path'
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'

/**
 * 把几个「又大又不需要加工」的静态目录排除在产物复制之外。
 *
 * `public/` 现在有 994MB，其中两个目录是纯数据、一个字节都不需要 Vite 碰：
 *   · web/cs15   550MB —— CS1.5 的游戏数据包（Valve 的资产，不进 git）
 *   · qemu-wasm  140MB —— /linux 那个页面的 QEMU 运行时（上游产物）
 * 而 Vite 会把 `public/` **整个**复制到 `dist/client/` —— 每次构建先拷 690MB，
 * 产物目录一度有 998MB。既占盘，也把构建时间从几秒拖到几十秒。
 *
 * Vite 没有「public 里排除某个子目录」的选项（`copyPublicDir` 只能全开或全关，
 * 全关就得自己把剩下的 300MB 也拷一遍）。所以做法是**构建期间把目录挪出去**：
 * buildStart 移走 → Vite 看不见 → closeBundle 移回来，并在产物里放一根软链，
 * 这样 Express（`/web/:name` 那条路由和 express.static）和本地预览照样读得到
 * —— 两者都会跟随软链。
 *
 * ⚠️⚠️ **移回来只能在 closeBundle 里做，不能提到 buildEnd**。
 * rollup 的钩子顺序是 buildStart → buildEnd → renderStart → writeBundle → closeBundle，
 * 而 Vite 复制 `public/` 就是在 renderStart 那一带（构建日志里 `vite:prepare-out-dir
 * renderStart` 那一行）—— 在 buildEnd 里移回来的话，目录刚好赶在复制之前回到 public，
 * 白忙一场，`dist` 照样 998MB。
 *
 * ⚠️ 于是失败时的自愈改为两条：下一次 buildStart 先把暂存区里的东西放回去（幂等），
 * 外加一个 `process.on('exit')` 兜底。前者挡「上次崩了」，后者挡「这次崩了」；
 * 只靠 closeBundle 的话，一次语法错误就会让目录凭空消失。
 */
const HUGE_STATIC = ['web/cs15', 'qemu-wasm']

const PUBLIC_DIR = path.resolve(import.meta.dirname, 'public')
const DIST_DIR = path.resolve(import.meta.dirname, 'dist/client')
const STAGE_DIR = path.resolve(import.meta.dirname, '.public-staging')

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

function skipHugeStatic() {
  let armed = false
  return {
    name: 'skip-huge-static',
    apply: 'build' as const,
    buildStart() {
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
        // 目录被挪走了，产物里本来不该有它；有就是上一次留下的旧实体，删掉再链
        if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
        mkdirSync(path.dirname(dest), { recursive: true })
        symlinkSync(live, dest, 'dir')
      }
    },
  }
}

/** 构建预览也要加隔离头；只在开发服务器加，预览中的 PS2 启动会直接失败。 */
function isolationHeaders(req: IncomingMessage, res: ServerResponse, next: () => void) {
  // 只隔离独立页；给整站加头会拦掉跨源封面和字体。
  const requestUrl = req.url || ''
  const pathname = requestUrl.split('?')[0]
  const ps2Play = /^\/(?:zh-Hans\/|zh-Hant\/|en\/|es\/|fr\/|it\/|de\/|ja\/)?play\/ps2\/[^/]+\/?$/.test(pathname)
  if (pathname === '/linux' || pathname === '/linux.html' || ps2Play) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    if (pathname === '/linux') req.url = `/linux.html${requestUrl.slice('/linux'.length)}`
  }
  if (pathname === '/qemu-wasm/qemu-system-x86_64.worker.js') {
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
  }
  if (pathname === '/play/Play.js') {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  }
  next()
}

/**
 * 提前和封面 / ROM 那个域名握手。
 *
 * 封面都在对象存储的独立域名上（VITE_ROM_BASE_URL）。不预热的话，每一张封面在下载前
 * 都要先走一遍 DNS + TCP + TLS —— 首屏那一批图于是排队握手，看起来就是「图一张张慢慢
 * 冒出来」。这一步把握手提前到 HTML 一开始解析的时候，之后所有封面复用同一条连接。
 *
 * ⚠️ 用**构建时**的地址，不用 localStorage 里的覆盖值：那是管理员本机调试用的，
 * 对访客没意义，而 preconnect 是写死在 HTML 里的，也没法跟着运行时变。
 * ⚠️ 不加 `crossorigin`：封面是普通 `<img>`（非 CORS 请求），带 crossorigin 开的是
 * 匿名 CORS 连接，反而不会被这些图片复用 —— 字体才需要 crossorigin。
 */
function coverOrigin(env: Record<string, string>): string {
  const raw = String(env.VITE_ROM_BASE_URL || '').trim()
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
    tailwindcss(),
    skipHugeStatic(),
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
    {
      name: 'isolated-pages',
      configureServer(server) {
        server.middlewares.use(isolationHeaders)
      },
      configurePreviewServer(server) {
        server.middlewares.use(isolationHeaders)
      },
    },
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
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        /*
          把 React 全家桶单独切一个 chunk。
          
          目的**不是**减少字节数（总量不变），而是让它的文件名不随业务代码变化：
          /assets/ 下的文件名带内容哈希、响应头是一年 immutable（见 server/src/cache.js），
          所以只要 react 那几条依赖没动，老访客和 Cloudflare 边缘都不用重新下载它。
          不切的话它和业务代码挤在同一个 index chunk 里，改一行文案就整包作废 ——
          那是首屏里最重的一块（gzip 四十多 KB）。

          ⚠️ 只用 advancedChunks，别同时写 codeSplitting：rolldown 里两者同时给时
          advancedChunks 会被**静默忽略**（见 rolldown 的 OutputOptions 注释）。
          ⚠️ test 用正则匹配 node_modules 路径 —— react / react-dom / scheduler 是同一批
          跟着 React 版本走的包，拆开会让它们互相 import 而被再次合并。
        */
        advancedChunks: {
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
      },
    },
  },
  }
})
