import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

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
      name: 'linux-isolated-page',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          // 开发时也必须走真实隔离路径；把头加给整站会拦掉跨源封面和字体。
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
        })
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
