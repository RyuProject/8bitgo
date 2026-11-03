#!/usr/bin/env node
/**
 * 从已校验的 v15 原子生成 v16；旧 URL 的浏览器/CDN 缓存不能被原地覆盖。
 *
 * v16 只换纯 JS 的读盘层（Wasm / data 与 v15 逐字节相同）：带 `romv` 的播放地址不再发
 * If-Match / If-Unmodified-Since，浏览器 HTTP 缓存才能接住重复读取的 2MB 分片
 * （见 vendor/ppsspp/range-read-ahead.js 的 versionPinned）。PPSSPPSDL.data.br 随目录一起复制。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replacePspRangeReadAhead } from './helpers/ppsspp-runtime-patch.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceDir = resolve(root, 'public/ppsspp/v0dbfaca/v15')
const targetDir = resolve(root, 'public/ppsspp/v0dbfaca/v16')
const rangeSource = readFileSync(resolve(root, 'vendor/ppsspp/range-read-ahead.js'), 'utf8')
const prefetchSource = readFileSync(resolve(root, 'vendor/ppsspp/range-prefetch-worker.js'))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
/** 逐文件复制：fs.cpSync 在部分沙箱（macOS 克隆复制 / 保留权限位）里会 EACCES */
const copyDir = (from, to) => {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const a = resolve(from, entry.name)
    const b = resolve(to, entry.name)
    if (entry.isDirectory()) copyDir(a, b)
    else if (entry.isFile()) writeFileSync(b, readFileSync(a))
  }
}
if (!existsSync(sourceDir)) throw new Error('缺少 v15 PPSSPP 基线')
const baseline = JSON.parse(readFileSync(resolve(sourceDir, 'runtime.json'), 'utf8'))
for (const [name, expected] of Object.entries(baseline.artifacts)) {
  if (hash(readFileSync(resolve(sourceDir, name))) !== expected.sha256) throw new Error(`v15 ${name} 哈希不符`)
}
if (!existsSync(resolve(sourceDir, 'PPSSPPSDL.data.br'))) throw new Error('v15 缺少 PPSSPPSDL.data.br；先运行 npm run ppsspp:precompress -- public/ppsspp/v0dbfaca/v15')
if (existsSync(targetDir)) {
  const manifest = JSON.parse(readFileSync(resolve(targetDir, 'runtime.json'), 'utf8'))
  const script = readFileSync(resolve(targetDir, 'PPSSPPSDL.js'), 'utf8')
  if (manifest.runtimeGeneration === 'v16' && script.includes(rangeSource.trimEnd()) &&
    readFileSync(resolve(targetDir, 'range-prefetch-worker.js')).equals(prefetchSource) &&
    Object.entries(manifest.artifacts).every(([name, expected]) =>
      hash(readFileSync(resolve(targetDir, name))) === expected.sha256)) {
    console.log('✔ PPSSPP v16 已生成且哈希一致')
    process.exit(0)
  }
  throw new Error('v16 已存在但与当前源码不一致；不可覆盖不可变运行时')
}
const temporary = mkdtempSync(resolve(root, 'public/ppsspp/v0dbfaca/.v16-build-'))
const working = resolve(temporary, 'v16')
try {
  copyDir(sourceDir, working)
  const scriptPath = resolve(working, 'PPSSPPSDL.js')
  writeFileSync(scriptPath, replacePspRangeReadAhead(readFileSync(scriptPath, 'utf8'), rangeSource))
  writeFileSync(resolve(working, 'range-prefetch-worker.js'), prefetchSource)
  for (const name of ['host.js', 'SOURCE.txt']) {
    const path = resolve(working, name)
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('v15', 'v16'))
  }
  const manifest = {
    ...baseline,
    runtimeGeneration: 'v16',
    rangeReadAheadProfile: 'adaptive-rolling-buffer-shared-worker-recovery-v8',
    // romv 钉死代次的 Range 不发条件头，交给浏览器 HTTP 缓存（ETag 仍由 C++ 逐块核对）
    browserHttpCache: 'romv-pinned-no-conditional-v1',
  }
  for (const name of ['PPSSPPSDL.js', 'range-prefetch-worker.js', 'host.js', 'SOURCE.txt']) {
    const path = resolve(working, name)
    manifest.artifacts[name] = { bytes: statSync(path).size, sha256: hash(readFileSync(path)) }
  }
  writeFileSync(resolve(working, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(working, targetDir)
  console.log('✔ PPSSPP v16：romv 分片可进浏览器 HTTP 缓存，不可变哈希已生成')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
