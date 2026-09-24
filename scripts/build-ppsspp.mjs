#!/usr/bin/env node
/**
 * 构建带 8BitGo HTTP Range 补丁的 PPSSPP WebAssembly。
 *
 * 用法：
 *   npm run ppsspp:build -- --source /path/to/ppsspp-wasm
 *
 * 源码必须停在 PINNED_COMMIT。脚本会幂等应用 vendor 下的补丁、初始化子模块、调用
 * Emscripten 5.0.7 构建，再把同一批 js/wasm/data/worker 复制进版本目录并写 SHA-256。
 * 不自动清理源码或构建目录：磁盘空间紧张时也不能擅自删除开发者已有的工作。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const VERSION = '0dbfaca'
const PINNED_COMMIT = '0dbfaca62a8a924abc2c5dd5dd0733b668e5e68a'
const PATCH = join(root, 'vendor', 'ppsspp', 'patches', '0001-range-streaming.patch')
const OUTPUT = join(root, 'public', 'ppsspp', `v${VERSION}`)
const args = process.argv.slice(2)
const sourceAt = args.indexOf('--source')
const source = resolve(sourceAt >= 0 ? args[sourceAt + 1] || '' : process.env.PPSSPP_SOURCE_DIR || '')

const fail = (message) => {
  console.error(`✖ PPSSPP 构建失败：${message}`)
  process.exit(1)
}

const run = (command, commandArgs, cwd = source) => {
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', env: process.env })
  if (result.error) fail(`${command} 无法执行：${result.error.message}`)
  if (result.status !== 0) fail(`${command} ${commandArgs.join(' ')} 退出码 ${result.status}`)
}

const capture = (command, commandArgs, cwd = source) => {
  const result = spawnSync(command, commandArgs, { cwd, encoding: 'utf8' })
  if (result.status !== 0) fail(`${command} ${commandArgs.join(' ')} 执行失败：${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

if (!source || source === resolve('')) fail('请用 --source 指向 root-hunter/ppsspp-wasm 的检出目录')
if (!existsSync(join(source, '.git')) || !existsSync(join(source, 'CMakeLists.txt'))) fail(`${source} 不是 PPSSPP 源码目录`)
if (!existsSync(PATCH)) fail(`补丁不存在：${PATCH}`)
if (capture('git', ['rev-parse', 'HEAD']) !== PINNED_COMMIT) {
  fail(`源码提交不匹配，必须是 ${PINNED_COMMIT}；不要在未知上游版本上硬套二进制补丁`)
}

if (!existsSync(join(source, 'Core', 'FileLoaders', 'WasmRangeFileLoader.cpp'))) {
  run('git', ['apply', '--check', PATCH])
  run('git', ['apply', PATCH])
}

if (!args.includes('--skip-submodules')) {
  run('git', ['submodule', 'update', '--init', '--recursive', '--depth', '1'])
}

const emcmake = spawnSync('emcmake', ['--version'], { encoding: 'utf8' })
if (emcmake.error || emcmake.status !== 0) {
  fail('找不到 emcmake。请安装并激活 Emscripten 5.0.7；上游 CI 也固定使用这一版。')
}

const jobs = process.env.PPSSPP_JOBS || `-j${Math.max(1, Number(process.env.NUMBER_OF_PROCESSORS) || 4)}`
run('make', ['wasm-release', 'CMAKE=cmake', `WASM_JOBS=${jobs}`])

const buildDir = join(source, 'build-wasm-release')
const names = ['PPSSPPSDL.js', 'PPSSPPSDL.wasm', 'PPSSPPSDL.data', 'PPSSPPSDL.worker.js']
for (const name of names) {
  if (!existsSync(join(buildDir, name))) fail(`构建完成但缺少 ${join(buildDir, name)}`)
}

mkdirSync(OUTPUT, { recursive: true })
const artifacts = {}
for (const name of names) {
  const from = join(buildDir, name)
  const to = join(OUTPUT, name)
  copyFileSync(from, to)
  const bytes = readFileSync(to)
  artifacts[name] = {
    bytes: statSync(to).size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

const manifest = {
  runtime: 'PPSSPP WebAssembly',
  upstream: 'https://github.com/root-hunter/ppsspp-wasm',
  commit: PINNED_COMMIT,
  emscripten: '5.0.7',
  rangeStreaming: true,
  blockBytes: 2 * 1024 * 1024,
  memoryCacheBytes: 192 * 1024 * 1024,
  artifactsInstalled: true,
  artifacts,
}
writeFileSync(join(OUTPUT, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`✔ PPSSPP Range 运行时已写入 ${OUTPUT}`)
console.log(`  ${Object.entries(artifacts).map(([name, info]) => `${basename(name)} ${info.bytes}B`).join(' · ')}`)
