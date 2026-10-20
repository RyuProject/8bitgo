#!/usr/bin/env node
/**
 * 只换代 PPSSPP 的浏览器预读胶水与清单，不触碰锁定的 Wasm/data 二进制。
 *
 * v12 没有修改 C++ ABI；从已校验的 v11 复制锁定的 Wasm/data，再更新预读胶水、独立
 * Worker 和哈希。实体目录只生成一次，避免同一 URL 后来指向另一批字节。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replacePspRangeReadAhead } from './helpers/ppsspp-runtime-patch.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceRuntimeDir = resolve(root, 'public/ppsspp/v0dbfaca/v11')
const targetRuntimeDir = resolve(root, 'public/ppsspp/v0dbfaca/v12')
const sourcePath = resolve(root, 'vendor/ppsspp/range-read-ahead.js')
const workerSourcePath = resolve(root, 'vendor/ppsspp/range-prefetch-worker.js')
if (!existsSync(sourceRuntimeDir)) throw new Error('缺少已发布的 v11 PPSSPP 基线')
if (existsSync(targetRuntimeDir)) {
  const script = readFileSync(resolve(targetRuntimeDir, 'PPSSPPSDL.js'), 'utf8')
  const worker = readFileSync(resolve(targetRuntimeDir, 'range-prefetch-worker.js'))
  const manifest = JSON.parse(readFileSync(resolve(targetRuntimeDir, 'runtime.json'), 'utf8'))
  const scriptHash = createHash('sha256').update(script).digest('hex')
  const workerHash = createHash('sha256').update(worker).digest('hex')
  if (
    script.includes(readFileSync(sourcePath, 'utf8').trimEnd()) &&
    worker.equals(readFileSync(workerSourcePath)) &&
    manifest.runtimeGeneration === 'v12' &&
    manifest.artifacts?.['PPSSPPSDL.js']?.sha256 === scriptHash &&
    manifest.artifacts?.['range-prefetch-worker.js']?.sha256 === workerHash
  ) {
    console.log('✔ PPSSPP v12 已是当前源码与哈希，无需改动不可变目录')
    process.exit(0)
  }
  throw new Error('v12 目录已存在且与源码不同；不可覆盖已生成的实体运行时')
}
const baseline = JSON.parse(readFileSync(resolve(sourceRuntimeDir, 'runtime.json'), 'utf8'))
for (const name of ['PPSSPPSDL.js', 'PPSSPPSDL.wasm', 'PPSSPPSDL.data']) {
  const bytes = readFileSync(resolve(sourceRuntimeDir, name))
  if (baseline.artifacts?.[name]?.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
    throw new Error(`v11 基线 ${name} 与原清单不符，不能换代`)
  }
}
const stagingRoot = mkdtempSync(resolve(root, 'public/ppsspp/v0dbfaca/.v12-build-'))
const runtimeDir = resolve(stagingRoot, 'v12')
cpSync(sourceRuntimeDir, runtimeDir, { recursive: true })
const runtimeScriptPath = resolve(runtimeDir, 'PPSSPPSDL.js')
const manifestPath = resolve(runtimeDir, 'runtime.json')

const runtimeScript = replacePspRangeReadAhead(
  readFileSync(runtimeScriptPath, 'utf8'),
  readFileSync(sourcePath, 'utf8'),
)
writeFileSync(runtimeScriptPath, runtimeScript)
copyFileSync(workerSourcePath, resolve(runtimeDir, 'range-prefetch-worker.js'))

const hostPath = resolve(runtimeDir, 'host.js')
writeFileSync(hostPath, readFileSync(hostPath, 'utf8').replaceAll('v11', 'v12'))
const sourceInfoPath = resolve(runtimeDir, 'SOURCE.txt')
writeFileSync(sourceInfoPath, readFileSync(sourceInfoPath, 'utf8')
  .replaceAll('v11', 'v12')
  .replace('two adjacent validated 2 MiB\nblocks concurrently', 'validated 2 MiB blocks in a dedicated\nprefetch Worker when available')
  .replace('Its cancellation path is\nreentrancy-safe', 'Shared-memory handoff avoids duplicate demand reads. Cancellation remains\nreentrancy-safe'))

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.runtimeGeneration = 'v12'
manifest.pthreadAudioContext = 'shared-ring-buffer-worklet-fade-v2'
manifest.rangeReadAheadProfile = 'adaptive-rolling-buffer-shared-worker-v5'
manifest.rangeReadAheadBlocks = 10
manifest.rangeReadAheadConcurrency = 4
manifest.rangeReadAheadCacheBytes = 24 * 1024 * 1024
for (const name of ['PPSSPPSDL.js', 'PPSSPPSDL.wasm', 'PPSSPPSDL.data', 'range-prefetch-worker.js']) {
  const path = resolve(runtimeDir, name)
  const bytes = readFileSync(path)
  manifest.artifacts[name] = {
    bytes: statSync(path).size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

try {
  renameSync(runtimeDir, targetRuntimeDir)
  rmSync(stagingRoot, { recursive: true, force: true })
} catch (error) {
  rmSync(stagingRoot, { recursive: true, force: true })
  throw error
}

console.log('✔ PPSSPP v12 独立预读 Worker 与运行时哈希已生成')
