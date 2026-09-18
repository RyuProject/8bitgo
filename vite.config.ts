import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

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
 * 两套构建产物：
 *   npm run build:client -> dist/client   浏览器用的静态资源
 *   npm run build:server -> dist/server   给 Express 调用的 render()
 * `npm run build` 会依次跑完两个。
 */
export default defineConfig({
  optimizeDeps: {
    // 这个包用 import.meta.url 定位自带的 zstd.wasm，预打包后地址会丢；交给 Vite 原样处理。
    exclude: ['@bokuweb/zstd-wasm'],
  },
  plugins: [
    react(),
    tailwindcss(),
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
})
