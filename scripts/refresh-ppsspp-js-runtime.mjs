#!/usr/bin/env node
/**
 * 只换代 PPSSPP 的浏览器预读胶水与清单，不触碰锁定的 Wasm/data 二进制。
 *
 * v10 没有修改 C++ ABI；通过这条可复现入口从 v9 二进制副本更新注入源码并重算三项哈希，
 * 避免手工编辑 38MB 发布目录后留下一个“清单看似正确、实际字节不符”的混合版本。
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replacePspRangeReadAhead } from './helpers/ppsspp-runtime-patch.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runtimeDir = resolve(root, 'public/ppsspp/v0dbfaca/v10')
const runtimeScriptPath = resolve(runtimeDir, 'PPSSPPSDL.js')
const sourcePath = resolve(root, 'vendor/ppsspp/range-read-ahead.js')
const manifestPath = resolve(runtimeDir, 'runtime.json')

const runtimeScript = replacePspRangeReadAhead(
  readFileSync(runtimeScriptPath, 'utf8'),
  readFileSync(sourcePath, 'utf8'),
)
writeFileSync(runtimeScriptPath, runtimeScript)

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.runtimeGeneration = 'v10'
manifest.pthreadAudioContext = 'shared-ring-buffer-worklet-fade-v2'
manifest.rangeReadAheadProfile = 'adaptive-dual-lane-v3'
manifest.rangeReadAheadBlocks = 2
manifest.rangeReadAheadConcurrency = 2
manifest.rangeReadAheadCacheBytes = 8 * 1024 * 1024
for (const name of ['PPSSPPSDL.js', 'PPSSPPSDL.wasm', 'PPSSPPSDL.data']) {
  const path = resolve(runtimeDir, name)
  const bytes = readFileSync(path)
  manifest.artifacts[name] = {
    bytes: statSync(path).size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

console.log('✔ PPSSPP v10 JS 预读器与运行时哈希已刷新')
