#!/usr/bin/env node

/** CS15 的大包在 R2；这里锁住会随 Git 部署的加载器、引擎与 wasm，避免本地能玩而线上 404。 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = join(root, 'public/web/cs15')
const runtimeDir = process.argv.includes('--dist') ? join(root, 'dist/client/web/cs15') : publicDir
const fail = (message) => { console.error(`✖ CS15 检查失败：${message}`); process.exit(1) }
const required = [
  'index.html', 'cs15.js', 'cs15.bundle.js', 'zip-stream.js',
  'engine/dist/index.js', 'engine/dist/xash3d.js', 'engine/dist/generated/xash.js',
  'engine/dist/xash.wasm', 'engine/dist/filesystem_stdio.wasm',
  'engine/dist/libmenu.wasm', 'engine/dist/libref_webgl2.wasm', 'engine/dist/libref_soft.wasm',
  'engine/dist/valve/extras.pk3',
  'lib/cstrike/cl_dlls/menu_emscripten_wasm32.wasm',
  'lib/cstrike/cl_dlls/client_emscripten_wasm32.wasm',
  'lib/cstrike/dlls/cs_emscripten_wasm32.wasm',
  'lib/valve/cl_dlls/client_emscripten_wasm32.wasm',
  'lib/valve/dlls/hl_emscripten_wasm32.wasm',
  'lib/cstrike/extras.pk3', 'gfx/fonts/FiraSans-Regular.ttf', 'gfx/fonts/tahoma.ttf',
]
for (const name of required) if (!existsSync(join(runtimeDir, name))) fail(`缺少 ${runtimeDir}/${name}`)

const source = readFileSync(join(publicDir, 'cs15.js'), 'utf8')
const index = readFileSync(join(publicDir, 'index.html'), 'utf8')
if (index.includes('src="./cs15.js')) fail('index.html 仍在直接加载未打包源码')
if (!index.includes('cs15.bundle.js?v=')) fail('index.html 的 bundle 没有缓存版本号')
if (!source.includes('https://assets.8bitgo.com/web/cs15/packs')) fail('生产默认资源根没有指向 R2')
if (!source.includes("Content-Encoding: br") || !source.includes('packPlan(index, game, map)')) fail('加载器缺 Brotli/R2 v2 清单支持')

const temporary = mkdtempSync(join(tmpdir(), '8bitgo-cs15-check-'))
try {
  const generated = join(temporary, 'cs15.bundle.js')
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [
    join(publicDir, 'cs15.js'), '--bundle', '--format=esm', '--platform=browser', '--target=es2022', `--outfile=${generated}`,
  ], { stdio: 'pipe' })
  if (!readFileSync(generated).equals(readFileSync(join(publicDir, 'cs15.bundle.js')))) {
    fail('cs15.bundle.js 落后于源码；运行 npm run cs15:bundle')
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

if (process.argv.includes('--dist')) {
  for (const name of required) {
    if (!readFileSync(join(publicDir, name)).equals(readFileSync(join(runtimeDir, name)))) fail(`dist 的 ${name} 与 public 不一致`)
  }
}
console.log(`✔ CS15 ${process.argv.includes('--dist') ? '部署产物' : '公开目录'}完整（R2 数据包由 npm run test:cs15 单独验证）`)
