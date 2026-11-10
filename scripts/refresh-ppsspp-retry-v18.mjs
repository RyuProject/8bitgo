#!/usr/bin/env node
/**
 * 从已校验的 v17 原子生成 v18；旧 URL 的浏览器/CDN 缓存不能被原地覆盖。
 *
 * v18 只换纯 JS 的读盘层（Wasm / data 与 v17 逐字节相同）：正式的同步 Range 读遇到网络层失败
 * （status 0）时在 JS 层就地退避重试（vendor/ppsspp/range-read-ahead.js 的 SYNC_RETRY_DELAYS_MS）。
 * 2026-11-10 后台记录：阿尔及利亚、智利玩家进游戏几十秒后一次断流就整局报
 * 「Range request failed: HTTP 0」，C++ loader 的三次 250 / 500ms 重试扛不住跨洲线路的短暂断流。
 * PPSSPPSDL.wasm.br / PPSSPPSDL.data.br 随目录一起复制（内容未变）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replacePspRangeReadAhead } from './helpers/ppsspp-runtime-patch.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceDir = resolve(root, 'public/ppsspp/v0dbfaca/v17')
const targetDir = resolve(root, 'public/ppsspp/v0dbfaca/v18')
const rangeSource = readFileSync(resolve(root, 'vendor/ppsspp/range-read-ahead.js'), 'utf8')
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
if (!existsSync(sourceDir)) throw new Error('缺少 v17 PPSSPP 基线')
const baseline = JSON.parse(readFileSync(resolve(sourceDir, 'runtime.json'), 'utf8'))
for (const [name, expected] of Object.entries(baseline.artifacts)) {
  if (hash(readFileSync(resolve(sourceDir, name))) !== expected.sha256) throw new Error(`v17 ${name} 哈希不符`)
}
if (!existsSync(resolve(sourceDir, 'PPSSPPSDL.data.br'))) throw new Error('v17 缺少 PPSSPPSDL.data.br')
if (existsSync(targetDir)) {
  const manifest = JSON.parse(readFileSync(resolve(targetDir, 'runtime.json'), 'utf8'))
  const script = readFileSync(resolve(targetDir, 'PPSSPPSDL.js'), 'utf8')
  if (manifest.runtimeGeneration === 'v18' && script.includes(rangeSource.trimEnd()) &&
    Object.entries(manifest.artifacts).every(([name, expected]) =>
      hash(readFileSync(resolve(targetDir, name))) === expected.sha256)) {
    console.log('✔ PPSSPP v18 已生成且哈希一致')
    process.exit(0)
  }
  throw new Error('v18 已存在但与当前源码不一致；不可覆盖不可变运行时')
}
const temporary = mkdtempSync(resolve(root, 'public/ppsspp/v0dbfaca/.v18-build-'))
const working = resolve(temporary, 'v18')
try {
  copyDir(sourceDir, working)
  // .br.json 旁注由 precompress-runtimes 按内容重算；wasm 未变，原样带过去即可
  const scriptPath = resolve(working, 'PPSSPPSDL.js')
  writeFileSync(scriptPath, replacePspRangeReadAhead(readFileSync(scriptPath, 'utf8'), rangeSource))
  for (const name of ['host.js', 'SOURCE.txt']) {
    const path = resolve(working, name)
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('v17', 'v18'))
  }
  const manifest = {
    ...baseline,
    runtimeGeneration: 'v18',
    rangeSyncRetryProfile: 'status0-backoff-4x-45s-v1',
  }
  for (const name of ['PPSSPPSDL.js', 'host.js', 'SOURCE.txt']) {
    const path = resolve(working, name)
    manifest.artifacts[name] = { bytes: statSync(path).size, sha256: hash(readFileSync(path)) }
  }
  writeFileSync(resolve(working, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(working, targetDir)
  console.log('✔ PPSSPP v18：同步 Range 读网络失败就地重试，不可变哈希已生成')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
