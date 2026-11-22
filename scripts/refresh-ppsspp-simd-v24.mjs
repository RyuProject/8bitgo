#!/usr/bin/env node
/**
 * v24 在 v23 的基础上给两个带 v128 参数的 invoke_ 导入换上 Wasm 跳板（见
 * scripts/helpers/ppsspp-simd-trampoline.mjs 的取证说明）。不重编 Wasm / data，只改胶水，
 * Cloudflare 忽略运行时查询串，所以生成新的实体目录，旧目录保持不可变。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installSimdTrampolines } from './helpers/ppsspp-simd-trampoline.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceDir = resolve(root, 'public/ppsspp/v0dbfaca/v23')
const targetDir = resolve(root, 'public/ppsspp/v0dbfaca/v24')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

const copyDir = (from, to) => {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = resolve(from, entry.name)
    const target = resolve(to, entry.name)
    if (entry.isDirectory()) copyDir(source, target)
    else if (entry.isFile()) writeFileSync(target, readFileSync(source))
  }
}

if (!existsSync(sourceDir)) throw new Error('缺少 PPSSPP v23 基线')
const baseline = JSON.parse(readFileSync(resolve(sourceDir, 'runtime.json'), 'utf8'))
for (const [name, expected] of Object.entries(baseline.artifacts)) {
  if (hash(readFileSync(resolve(sourceDir, name))) !== expected.sha256) throw new Error(`v23 ${name} 哈希不符`)
}
if (existsSync(targetDir)) throw new Error('v24 目录已存在；不可覆盖不可变运行时')

const temporary = mkdtempSync(resolve(root, 'public/ppsspp/v0dbfaca/.v24-build-'))
const working = resolve(temporary, 'v24')
try {
  copyDir(sourceDir, working)
  const scriptPath = resolve(working, 'PPSSPPSDL.js')
  const { glue, entries } = installSimdTrampolines(
    readFileSync(scriptPath, 'utf8'),
    readFileSync(resolve(working, 'PPSSPPSDL.wasm')),
  )
  writeFileSync(scriptPath, glue)

  const sourcePath = resolve(working, 'SOURCE.txt')
  writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8').replaceAll('v23', 'v24').trimEnd()}

The v24 glue routes the two JS imports whose signatures carry v128
(${entries.map((entry) => entry.glueName).join(', ')}, used only by the on-screen touch
controls in UI/GamepadEmu.cpp) through a tiny embedded WebAssembly trampoline module, because
the JS API forbids v128 values crossing the Wasm/JS boundary.
`)
  const manifest = { ...baseline, runtimeGeneration: 'v24', v128InvokeProfile: 'wasm-call-indirect-trampoline-v1' }
  for (const name of ['PPSSPPSDL.js', 'SOURCE.txt']) {
    const path = resolve(working, name)
    manifest.artifacts[name] = { bytes: statSync(path).size, sha256: hash(readFileSync(path)) }
  }
  writeFileSync(resolve(working, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(working, targetDir)
  console.log(`✔ PPSSPP v24：${entries.map((entry) => entry.glueName).join(' / ')} 改走 Wasm 跳板`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
