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
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    open: false,
  },
})
