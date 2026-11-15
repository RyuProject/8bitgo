import path from 'node:path'
import { defineConfig } from 'vite'
import { optOutRocketLoader } from './shared/rocket-loader-optout.js'

const projectRoot = path.resolve(import.meta.dirname, 'vendor/j2me-web')

export default defineConfig({
  root: projectRoot,
  publicDir: false,
  plugins: [
    {
      // 和主站一样退出 Cloudflare Rocket Loader：否则 embed.ts 要等 window load 才执行，
      // 适配器在 iframe load 时发的 start 消息没人接（见 AGENTS.md §2.37.1）。
      name: 'rocket-loader-optout',
      enforce: 'post',
      transformIndexHtml: (html) => optOutRocketLoader(html),
    },
  ],
  base: '/j2me-web/',
  build: {
    outDir: path.resolve(import.meta.dirname, 'public/j2me-web'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: path.join(projectRoot, 'embed.html'),
    },
  },
})
