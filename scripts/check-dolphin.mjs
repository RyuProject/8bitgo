#!/usr/bin/env node
/**
 * 锁住 wasm-dolphin 的版本化运行时，并确认真正部署的 dist 没漏文件。
 *
 * 这个核心的胶水与 wasm 必须成套；只缺 Worker、只换 wasm、或构建时没把 17MB 目录复制
 * 进去，表现都会是玩家点开始后白屏。版本目录不靠肉眼验收，构建前后都在这里校验。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = 'v7e38409'
const CORE_SHA256 = 'd7395b3a94080f5b7d08a0522f59096007419d117b7b0eb868246429adee6f5c'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = join(root, 'public', 'dolphin', VERSION)
const useDist = process.argv.includes('--dist')
const runtimeDir = useDist ? join(root, 'dist', 'client', 'dolphin', VERSION) : publicDir
const adapter = readFileSync(join(root, 'src', 'emulator', 'adapters', 'dolphin.ts'), 'utf8')

const fail = (message) => {
  console.error(`✖ wasm-dolphin 检查失败：${message}`)
  process.exit(1)
}

const required = [
  'index.html',
  'LICENSE',
  'SOURCE.txt',
  'src/bootstrap.js',
  'src/app.js',
  'src/core-host.js',
  'src/upstream-worker-adapter.js',
  'src/upstream-discio-worker.js',
  'src/range-backed-file.js',
  'cores/dolphin/dolphin-core-upstream.js',
  'cores/dolphin/dolphin-core-upstream.wasm',
  'cores/dolphin/dolphin-core-upstream.build.json',
  'provenance/dolphin-source.lock.json',
  'provenance/dolphin-vendor-snapshot-v1.json',
  'provenance/wasm-toolchain.lock.json',
]

for (const relative of required) {
  const file = join(runtimeDir, relative)
  if (!existsSync(file) || readFileSync(file).byteLength === 0) fail(`缺少 ${relative}`)
}
if (!/index\.html\?embed=1&r=1/.test(adapter)) {
  fail('Dolphin iframe 入口缺内容代次，旧 301/HTML 会继续被边缘缓存命中')
}

const source = readFileSync(join(runtimeDir, 'SOURCE.txt'), 'utf8')
if (!source.includes('7e38409ace3dda709c178312ff63fd92a3653cc7') || !source.includes('GPL-2.0-or-later')) {
  fail('SOURCE.txt 没锁定当前上游提交与 GPL 许可证')
}

const wasm = readFileSync(join(runtimeDir, 'cores/dolphin/dolphin-core-upstream.wasm'))
if (!wasm.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) fail('Dolphin 核心不是有效 WASM')
if (createHash('sha256').update(wasm).digest('hex') !== CORE_SHA256) fail('Dolphin 核心哈希变化，胶水与来源锁可能已经不配套')

const app = readFileSync(join(runtimeDir, 'src/app.js'), 'utf8')
const worker = readFileSync(join(runtimeDir, 'src/upstream-discio-worker.js'), 'utf8')
const range = readFileSync(join(runtimeDir, 'src/range-backed-file.js'), 'utf8')
for (const marker of ['8bitgo-dolphin-bridge', 'mount-remote', 'host-ready']) {
  if (!app.includes(marker)) fail(`站内桥缺关键特征 ${marker}`)
}
if (!worker.includes('RangeBackedFile') || !worker.includes('mountRemote')) fail('Worker 没有远程光盘挂载接口')
if (!range.includes('Range') || !range.includes('206') || !range.includes('XMLHttpRequest')) fail('远程光盘不是 HTTP Range 随机读取实现')

if (useDist) {
  const mismatched = []
  const walk = (relative = '') => {
    for (const entry of readdirSync(join(publicDir, relative), { withFileTypes: true })) {
      const next = relative ? posix.join(relative, entry.name) : entry.name
      if (entry.isDirectory()) {
        walk(next)
        continue
      }
      const built = join(runtimeDir, next)
      if (!existsSync(built) || !readFileSync(join(publicDir, next)).equals(readFileSync(built))) mismatched.push(next)
    }
  }
  walk()
  if (mismatched.length) fail(`${mismatched.length} 个部署文件和 public 不一致：${mismatched.slice(0, 5).join('、')}`)
}

console.log(`✔ wasm-dolphin ${useDist ? '部署产物' : '运行时'}完整（固定提交、核心哈希、Range 桥均在位）`)
