import path from 'node:path'
import { defineConfig } from 'vite'

const projectRoot = path.resolve(import.meta.dirname, 'vendor/j2me-web')

export default defineConfig({
  root: projectRoot,
  publicDir: false,
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
