import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'

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
  },
  }
})
