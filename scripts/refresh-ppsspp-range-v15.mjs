#!/usr/bin/env node
/** 从已校验的 v14 原子生成 v15；旧 URL 的浏览器/CDN 缓存不能被原地覆盖。 */
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replacePspRangeReadAhead } from './helpers/ppsspp-runtime-patch.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceDir = resolve(root, 'public/ppsspp/v0dbfaca/v14')
const targetDir = resolve(root, 'public/ppsspp/v0dbfaca/v15')
const rangeSource = readFileSync(resolve(root, 'vendor/ppsspp/range-read-ahead.js'), 'utf8')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
if (!existsSync(sourceDir)) throw new Error('缺少 v14 PPSSPP 基线')
const baseline = JSON.parse(readFileSync(resolve(sourceDir, 'runtime.json'), 'utf8'))
for (const [name, expected] of Object.entries(baseline.artifacts)) {
  if (hash(readFileSync(resolve(sourceDir, name))) !== expected.sha256) throw new Error(`v14 ${name} 哈希不符`)
}
if (existsSync(targetDir)) {
  const manifest = JSON.parse(readFileSync(resolve(targetDir, 'runtime.json'), 'utf8'))
  const script = readFileSync(resolve(targetDir, 'PPSSPPSDL.js'), 'utf8')
  if (manifest.runtimeGeneration === 'v15' && script.includes(rangeSource.trimEnd()) &&
    Object.entries(manifest.artifacts).every(([name, expected]) =>
      hash(readFileSync(resolve(targetDir, name))) === expected.sha256)) {
    console.log('✔ PPSSPP v15 已生成且哈希一致')
    process.exit(0)
  }
  throw new Error('v15 已存在但与当前源码不一致；不可覆盖不可变运行时')
}
const temporary = mkdtempSync(resolve(root, 'public/ppsspp/v0dbfaca/.v15-build-'))
const working = resolve(temporary, 'v15')
try {
  cpSync(sourceDir, working, { recursive: true })
  const scriptPath = resolve(working, 'PPSSPPSDL.js')
  writeFileSync(scriptPath, replacePspRangeReadAhead(readFileSync(scriptPath, 'utf8'), rangeSource))
  copyFileSync(resolve(root, 'vendor/ppsspp/range-prefetch-worker.js'), resolve(working, 'range-prefetch-worker.js'))
  for (const name of ['host.js', 'SOURCE.txt']) {
    const path = resolve(working, name)
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('v14', 'v15'))
  }
  const manifest = { ...baseline, runtimeGeneration: 'v15',
    rangeReadAheadProfile: 'adaptive-rolling-buffer-shared-worker-recovery-v7' }
  for (const name of ['PPSSPPSDL.js', 'range-prefetch-worker.js', 'host.js', 'SOURCE.txt']) {
    const path = resolve(working, name)
    manifest.artifacts[name] = { bytes: statSync(path).size, sha256: hash(readFileSync(path)) }
  }
  writeFileSync(resolve(working, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(working, targetDir)
  console.log('✔ PPSSPP v15 顺序预读恢复窗口与不可变哈希已生成')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
