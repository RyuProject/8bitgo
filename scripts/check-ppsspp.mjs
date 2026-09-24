#!/usr/bin/env node
/** 检查 PSP 平台、桥与 Range 核心是不是同一套可发布实现。 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const VERSION = '0dbfaca'
const useDist = process.argv.includes('--dist')
const sourceOnly = process.argv.includes('--source-only')
const publicDir = join(root, 'public', 'ppsspp', `v${VERSION}`)
const runtimeDir = useDist ? join(root, 'dist', 'client', 'ppsspp', `v${VERSION}`) : publicDir

const fail = (message) => {
  console.error(`✖ PPSSPP 检查失败：${message}`)
  process.exit(1)
}
const need = (path) => {
  if (!existsSync(path)) fail(`缺少 ${path}`)
  return readFileSync(path)
}

for (const name of ['index.html', 'host.js', 'runtime.json', 'SOURCE.txt']) need(join(runtimeDir, name))
const host = need(join(runtimeDir, 'host.js')).toString('utf8')
for (const marker of ['8bitgo-ppsspp-bridge', 'mount-remote', 'WORKERFS', 'IDBFS', '__ppssppRangeProgress']) {
  if (!host.includes(marker)) fail(`host.js 缺少桥标记 ${marker}`)
}
if (/fetch\s*\(\s*(?:remote(?:\?\.)?\.url|gamePath)/.test(host) || /arrayBuffer\s*\(/.test(host)) {
  fail('host.js 出现整盘下载代码；远程镜像只能把 URL 交给 C++ Range loader')
}

const patch = need(join(root, 'vendor', 'ppsspp', 'patches', '0001-range-streaming.patch')).toString('utf8')
for (const marker of [
  'EMSCRIPTEN_FETCH_SYNCHRONOUS',
  'fetch->status == 206',
  'BLOCK_BYTES = 2 * 1024 * 1024',
  'MAX_CACHE_BYTES = 192 * 1024 * 1024',
  '-sPROXY_TO_PTHREAD=1',
]) {
  if (!patch.includes(marker)) fail(`核心补丁缺少 ${marker}`)
}

const manifest = JSON.parse(need(join(runtimeDir, 'runtime.json')).toString('utf8'))
if (manifest.commit !== '0dbfaca62a8a924abc2c5dd5dd0733b668e5e68a') fail('runtime.json 的上游提交没有锁定')
if (manifest.rangeStreaming !== true || manifest.blockBytes !== 2097152 || manifest.memoryCacheBytes !== 201326592) {
  fail('runtime.json 的 Range / 缓存参数与补丁不一致')
}

const binaries = ['PPSSPPSDL.js', 'PPSSPPSDL.wasm', 'PPSSPPSDL.data', 'PPSSPPSDL.worker.js']
const installed = binaries.every((name) => existsSync(join(runtimeDir, name)))
const productionEnv = existsSync(join(root, '.env.production'))
  ? readFileSync(join(root, '.env.production'), 'utf8')
  : ''
const productionEnabled = /^VITE_PPSSPP_PATH\s*=\s*\S+/m.test(productionEnv)
if ((!sourceOnly || productionEnabled) && !installed) {
  fail('核心二进制尚未安装；先运行 npm run ppsspp:build -- --source <源码目录>')
}
if (installed) {
  if (!manifest.artifactsInstalled || !manifest.artifacts) fail('已有二进制，但 runtime.json 没有来源/哈希清单')
  for (const name of binaries) {
    const bytes = need(join(runtimeDir, name))
    const expected = manifest.artifacts[name]
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (!expected || expected.bytes !== bytes.byteLength || expected.sha256 !== hash) fail(`${name} 与 runtime.json 校验值不符`)
  }
}

if (useDist) {
  for (const name of ['index.html', 'host.js', 'runtime.json', 'SOURCE.txt']) {
    const a = need(join(publicDir, name))
    const b = need(join(runtimeDir, name))
    if (!a.equals(b)) fail(`dist/client 中的 ${name} 不是 public 里的当前版本`)
  }
}

console.log(`✔ PPSSPP ${sourceOnly && !installed ? '源码接入' : 'Range 运行时'}检查通过${useDist ? '（dist）' : ''}`)
