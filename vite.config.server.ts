import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

/** SSR 产物：Node 端 import 的 render()，不打包成浏览器资源 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  build: {
    ssr: 'src/entry-server.tsx',
    outDir: 'dist/server',
    emptyOutDir: true,
    // CSS 由客户端构建负责，服务端产物不需要
    cssCodeSplit: false,
    /**
     * **不要把 public/ 拷进 dist/server**（2026-09-18）。
     *
     * 默认值是 true，于是每次构建都会往 dist/server 里复制一份完整的 public/ ——
     * 那是 320 MB（qemu 镜像、Ruffle 的 wasm、EmulatorJS 核心、J2ME 资源……），
     * 占掉构建里 95% 的时间（emptyOutDir + 复制，实测 4.4 秒里 3.4 秒），
     * 再在磁盘上留一份**永远没人读**的副本。
     *
     * 为什么确定没人读：静态资源由 server/src/index.js 的 express.static 从
     * CLIENT_DIR（dist/client）发出，SSR 模板也读 dist/client/index.html
     * （见 ssr.js 的 CLIENT_DIR / TEMPLATE）。dist/server 只被 import 一个 entry-server.js。
     * scripts/check-emulatorjs.mjs 的注释里早就写着「SSR 那份 dist/server/emulatorjs/
     * 没有任何人访问」—— 这条只是把那个事实落成配置。
     *
     * ⚠️ 以后若真要从服务端产物里读静态文件，先想清楚：运行期该读的是部署到线上的那一份，
     * 让它走 dist/client（或者干脆放到对象存储），而不是靠构建期多拷一份。
     */
    copyPublicDir: false,
  },
})
