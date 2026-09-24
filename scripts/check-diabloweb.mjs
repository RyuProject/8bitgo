#!/usr/bin/env node

/**
 * 校验 /web/diablo 的产物。
 *
 * 为什么要有这个脚本：这个页面和 PvZ / CS 那几个一样，**页面本身能打开、游戏却起不来**
 * 是它最容易出的故障形态 —— 入口 index.html 在，但它引用的 chunk、worker 或 wasm 少任何一个，
 * 浏览器只会白屏或报一句含糊的 MIME/404，线上却谁也不知道。所以这里做三件事：
 *
 *  1. index.html 里的每一个 /web/diablo/ 引用都必须在磁盘上真的存在；
 *  2. 引擎三件套（入口 chunk、worker、R2 wasm 清单）配套，且 PUBLIC_URL 正确；
 *  3. --dist 模式下逐字节比对 dist/client/web/diablo 与 public/web/diablo。
 *
 * 第 3 条是照 AGENTS.md §2.5 那次事故加的：**构建产物才是线上真正发的文件**，
 * 而这些文件名不带内容哈希时肉眼分不出新旧，只能靠字节比对。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { diabloCoreAsset } from '../server/src/diablo.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = join(root, 'public/web/diablo')
const useDist = process.argv.includes('--dist')
const runtimeDir = useDist ? join(root, 'dist/client/web/diablo') : publicDir
const label = useDist ? '部署产物' : '公开目录'

const fail = (message) => { console.error(`✖ Diablo 检查失败：${message}`); process.exit(1) }

const indexFile = join(runtimeDir, 'index.html')
if (!existsSync(indexFile)) fail(`缺少 ${indexFile}（先跑 npm run diablo:build）`)
const index = readFileSync(indexFile, 'utf8')

// PUBLIC_URL 没配对时 CRA 会原样留下占位符，或者写成相对路径 —— 两种都会在
// 「目录 URL 不带尾斜杠」的生产形态下取错文件，而且首页看上去是正常的。
if (index.includes('%PUBLIC_URL%')) fail('index.html 里还有没被替换的 %PUBLIC_URL% 占位符')
// 比较时只比到引号为止：html-minifier 会把 `<base href="..." />` 压成自闭合的 `.../>`。
if (!index.includes('<base href="/web/diablo/')) fail('index.html 缺 <base href="/web/diablo/">')

/** 从 index.html 里摘出所有 /web/diablo/ 下的引用（script src / link href）。 */
const referenced = []
for (const match of index.matchAll(/(?:src|href)="(\/web\/diablo\/[^"]+)"/g)) referenced.push(match[1])
if (!referenced.length) fail('index.html 里没有任何 /web/diablo/ 绝对引用（homepage 字段丢了？）')

for (const url of referenced) {
  const relative = url.slice('/web/diablo/'.length).split('?')[0]
  const file = join(runtimeDir, relative)
  if (!existsSync(file) || statSync(file).size === 0) fail(`index.html 引用了不存在的文件：${url}`)
}

// worker-loader 产出的文件名带哈希、且由运行期 publicPath 拼出来，静态扫不到，
// 只能确认「目录里至少有一份」—— 少了它游戏会在 new Worker() 处直接失败。
const files = readdirSync(runtimeDir)
if (!files.some((name) => /\.worker\.js$/.test(name))) fail(`${runtimeDir} 里没有 *.worker.js（游戏主循环跑在 worker 里）`)

const mediaDir = join(runtimeDir, 'static/media')
if (!existsSync(mediaDir)) fail('缺少 static/media（webpack 把 wasm 与图标放在这里）')
const media = readdirSync(mediaDir)
if (media.some((file) => file.endsWith('.wasm'))) {
  fail('static/media 里仍有 wasm；核心应由 R2 Brotli 流式代理，不能再塞进应用产物')
}

const runtimeManifestFile = join(runtimeDir, 'runtime-manifest.json')
if (!existsSync(runtimeManifestFile)) fail('缺少 runtime-manifest.json（R2 核心清单）')
const assetManifestFile = join(runtimeDir, 'asset-manifest.json')
if (!existsSync(assetManifestFile)) fail('缺少 asset-manifest.json')
let runtimeManifest
try {
  runtimeManifest = JSON.parse(readFileSync(runtimeManifestFile, 'utf8'))
} catch {
  fail('runtime-manifest.json 不是合法 JSON')
}
if (runtimeManifest?.version !== 1 || !Array.isArray(runtimeManifest.assets)) fail('runtime-manifest.json 结构错误')
const expectedNames = ['Diablo', 'DiabloSpawn', 'MpqCmp']
const webpackManifest = JSON.parse(readFileSync(assetManifestFile, 'utf8'))
for (const name of expectedNames) {
  const asset = runtimeManifest.assets.find((item) => new RegExp(`^${name}\\.[a-f0-9]{8}\\.wasm$`).test(item?.file || ''))
  if (!asset || !Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^[a-f0-9]{64}$/.test(asset.sha256 || '')) {
    fail(`R2 清单缺少合法的 ${name}.wasm 记录`)
  }
  const webpackUrl = webpackManifest.files?.[`static/media/${name}.wasm`]
  if (webpackUrl !== `/web/diablo/static/media/${asset.file}`) fail(`${name}.wasm 的 webpack URL 与 R2 清单不一致`)
  const proxyAsset = diabloCoreAsset(asset.file)
  if (!proxyAsset || proxyAsset.contentType !== 'application/wasm' || !proxyAsset.url.endsWith(`/web/diablo/runtime/${asset.file}`)) {
    fail(`${asset.file} 没有被服务端 R2 代理正确识别`)
  }
}
for (const bad of ['../Diablo.570bd59a.wasm', 'Diablo.wasm', 'Diablo.570bd59a.wasm.br', 'Other.570bd59a.wasm']) {
  if (diabloCoreAsset(bad)) fail(`服务端 R2 代理错误接受了非法核心名：${bad}`)
}

// 远程 MPQ 旧实现虽然发 Range，却先按 Content-Length 分配整份文件；500MB 盘仍会瞬间吃满内存。
const workers = files.filter((name) => /\.worker\.js$/.test(name)).map((name) => readFileSync(join(runtimeDir, name), 'utf8')).join('\n')
if (workers.includes('new Uint8Array(this.byteLength)')) fail('worker 仍会为远程 MPQ 预分配整盘内存')
if (!workers.includes('FileReaderSync')) fail('worker 没有本地 MPQ 的分块 FileReaderSync 路径')
// Terser 会把 `request.status !== 206` 交换成 `206!==i.status`；检查不可被改写的错误文案，
// 再配合 Content-Range 校验文案，避免因为变量名/比较顺序压缩而误报。
if (!workers.includes('Remote MPQ requires HTTP 206') || !workers.includes('Remote MPQ returned an invalid Content-Range')) {
  fail('worker 没有严格拒绝忽略 Range 的 200 响应')
}

if (useDist) {
  const mismatched = []
  const walk = (relative = '') => {
    for (const entry of readdirSync(join(runtimeDir, relative), { withFileTypes: true })) {
      const next = relative ? posix.join(relative, entry.name) : entry.name
      if (entry.isDirectory()) { walk(next); continue }
      const source = join(publicDir, next)
      if (!existsSync(source) || !readFileSync(source).equals(readFileSync(join(runtimeDir, next)))) mismatched.push(next)
    }
  }
  walk()
  if (mismatched.length) {
    fail(`${mismatched.length} 个文件与 public/web/diablo 不一致（重新 npm run build）：${mismatched.slice(0, 5).join('、')}`)
  }
}

console.log(`✔ Diablo ${label}完整（${referenced.length} 条入口引用、worker 与 R2 核心清单均在位）`)
