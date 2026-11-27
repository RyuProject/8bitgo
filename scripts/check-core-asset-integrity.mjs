#!/usr/bin/env node
/** 构建期核对轻量模拟器核心的浏览器端可信摘要，防止换产物却漏改运行时校验值。 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distMode = process.argv.includes('--dist')
const assetRoot = distMode ? join(root, 'dist/client') : join(root, 'public')
const fail = (message) => {
  console.error(`✖ 轻量核心完整性检查失败：${message}`)
  process.exit(1)
}
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const source = readFileSync(join(root, 'src/emulator/coreAssetIntegrity.ts'), 'utf8')
const iodine = readFileSync(join(root, 'src/emulator/iodinegbaVersion.ts'), 'utf8')

for (const name of ['binjgb.js', 'binjgb.wasm', 'binjgb-js.js']) {
  const expected = new RegExp(`name: '${name.replaceAll('.', '\\.')}',\\s*bytes: ([\\d_]+),\\s*sha256: '([a-f0-9]{64})'`).exec(source)
  if (!expected) fail(`浏览器端缺少 ${name} 的固定长度与 SHA-256`)
  const path = join(assetRoot, 'binjgb', name)
  const bytes = readFileSync(path)
  if (bytes.byteLength !== Number(expected[1].replaceAll('_', '')) || sha256(path) !== expected[2]) {
    fail(`${name} 与浏览器运行时完整性常量不一致`)
  }
}

const iodineSha = iodine.match(/export const IODINEGBA_SHA256 = '([a-f0-9]{64})'/)?.[1]
const iodineBuild = iodine.match(/export const IODINEGBA_BUILD = '([a-f0-9]{16})'/)?.[1]
const iodineFile = join(assetRoot, 'iodinegba/iodinegba.js')
if (!iodineSha || sha256(iodineFile) !== iodineSha || iodineSha.slice(0, 16) !== iodineBuild) {
  fail('IodineGBA 当前脚本与完整摘要 / 内容代次不一致')
}

console.log(`✔ Binjgb JS/WASM 与 IodineGBA 核心 SHA-256 常量和${distMode ? '部署产物' : '公开目录'}一致`)
