#!/usr/bin/env node
/** v25 按弱网吞吐放宽 PSP Range 时限，并保留 300 秒无进度熔断。 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replacePspRangeReadAhead } from './helpers/ppsspp-runtime-patch.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceDir = resolve(root, 'public/ppsspp/v0dbfaca/v24')
const targetDir = resolve(root, 'public/ppsspp/v0dbfaca/v25')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

if (!existsSync(sourceDir)) throw new Error('缺少 PPSSPP v24 基线')
if (existsSync(targetDir)) throw new Error('v25 目录已存在；不可覆盖不可变运行时')

const baseline = JSON.parse(readFileSync(resolve(sourceDir, 'runtime.json'), 'utf8'))
for (const [name, expected] of Object.entries(baseline.artifacts || {})) {
  if (hash(readFileSync(resolve(sourceDir, name))) !== expected.sha256) {
    throw new Error(`v24 ${name} 与清单哈希不符；不能换代`)
  }
}

const temporary = mkdtempSync(resolve(root, 'public/ppsspp/v0dbfaca/.v25-build-'))
const working = resolve(temporary, 'v25')
try {
  cpSync(sourceDir, working, { recursive: true })

  const scriptPath = resolve(working, 'PPSSPPSDL.js')
  const workerPath = resolve(working, 'range-prefetch-worker.js')
  writeFileSync(scriptPath, replacePspRangeReadAhead(
    readFileSync(scriptPath, 'utf8'),
    readFileSync(resolve(root, 'vendor/ppsspp/range-read-ahead.js'), 'utf8'),
  ))
  writeFileSync(workerPath, readFileSync(resolve(root, 'vendor/ppsspp/range-prefetch-worker.js')))

  const sourcePath = resolve(working, 'SOURCE.txt')
  writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8').replaceAll('v24', 'v25').trimEnd()}

The v25 Range layer estimates a safe finite timeout from Network Information and completed
block throughput. This avoids restarting a 2 MiB transfer every 30 seconds on weak links;
the PPSSPP bridge also refreshes its mount deadline only when core or disc progress advances.
`)

  const manifest = {
    ...baseline,
    runtimeGeneration: 'v25',
    rangeTransferTimeoutProfile: 'throughput-aware-progress-idle-v1',
  }
  for (const name of ['PPSSPPSDL.js', 'range-prefetch-worker.js', 'SOURCE.txt']) {
    const path = resolve(working, name)
    const bytes = readFileSync(path)
    manifest.artifacts[name] = { bytes: statSync(path).size, sha256: hash(bytes) }
  }
  writeFileSync(resolve(working, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(working, targetDir)
  console.log('✔ PPSSPP v25：弱网 Range 时限按吞吐调整，启动期限按真实进度续期')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
