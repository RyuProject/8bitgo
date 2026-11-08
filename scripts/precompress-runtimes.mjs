#!/usr/bin/env node
/**
 * 给各平台模拟器的大文件预先生成 Brotli 11 压缩版（`<原名>.br` + `<原名>.br.json`）。
 *
 * ── 为什么（2026-11-09 在生产机上实测 Cloudflare 实际下发的字节数）──────────────
 * Cloudflare / EdgeOne 对 wasm 是现场压缩，压缩级别不高；Brotli 11 + 16MB 窗口还能再省 25~30%：
 *
 *   Ruffle wasm        4.68MB → 3.26MB      Dolphin wasm   4.59MB → 3.22MB
 *   DOSBox-X wasm      2.69MB → 2.02MB      Play! wasm     0.96MB → 0.69MB
 *
 * EmulatorJS 的核心（cores/*.data）本身就是 7z（LZMA2）包，最强档重压也只省约 2%，而且一换字节
 * 所有玩家都要重下核心，所以不在名单里。源站的 server/src/precompressed-static.js 对接受 br 的浏览器
 * 直接吐这里生成的 .br；Cloudflare 与 EdgeOne 都会原样转发源站的 br（已实测，也会按 Vary 分开缓存）。
 *
 * ── 怎么保证不会吐出过期的压缩版 ────────────────────────────────────────────
 * 旁边的 `.br.json` 记下原文件的字节数和 sha256。脚本每次都按 sha 判断要不要重压（没变就跳过，
 * 部署时只有第一次真正花时间）；中间件只在原文件字节数与旁注一致时才吐 .br；
 * `--check <目录>`（postbuild 对 dist/client 跑）逐个核对 sha，对不上直接让构建失败。
 * 压完立刻解开比对，省不到 5% 的不落盘。
 *
 * 用法：
 *   node scripts/precompress-runtimes.mjs            # 对 public/ 生成（prebuild）
 *   node scripts/precompress-runtimes.mjs --check dist/client
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompress, brotliDecompressSync, constants } from 'node:zlib'

const brotli = promisify(brotliCompress)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * 要预压的文件（相对静态根目录）。和 server/src/precompressed-static.js 的
 * PRECOMPRESSED_RUNTIME_PATTERNS 一一对应：这里漏了只是不预压，那边漏了就白生成。
 */
export const RUNTIME_PRECOMPRESS_PATTERNS = Object.freeze([
  /^ruffle\/v[^/]+\/[^/]+\.wasm$/,
  /^jsdos\/v[^/]+\/emulators\/(?:wdosbox|wdosbox-x|wdosbox-x-jspi|wlibzip)\.wasm$/,
  /^dolphin\/v[^/]+\/cores\/dolphin\/[^/]+\.wasm$/,
  /^play\/(?:[^/]+\/)?Play\.wasm$/,
  /^ppsspp\/v[0-9a-f]+\/v\d+\/PPSSPPSDL\.wasm$/,
  /^emulatorjs\/emulator\.min\.js$/,
])

const SCAN_DIRS = ['ruffle', 'jsdos', 'dolphin', 'play', 'ppsspp', 'emulatorjs']
const MIN_SAVING = 0.05

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const encodedByHash = new Map()

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    // ppsspp / dolphin 在 dist 里是软链（vite-static-exclusions），要跟进去
    if (entry.isDirectory() || (entry.isSymbolicLink() && statSync(path).isDirectory())) yield* walk(path)
    else if (entry.isFile() || entry.isSymbolicLink()) yield path
  }
}

export function runtimeTargets(base) {
  const out = []
  for (const top of SCAN_DIRS) {
    for (const path of walk(join(base, top))) {
      const rel = relative(base, path).split('\\').join('/')
      if (RUNTIME_PRECOMPRESS_PATTERNS.some((pattern) => pattern.test(rel))) out.push(path)
    }
  }
  return out.sort()
}

function readSidecar(path) {
  try {
    return JSON.parse(readFileSync(`${path}.br.json`, 'utf8'))
  } catch {
    return null
  }
}

async function compressOne(path) {
  const data = readFileSync(path)
  const hash = sha256(data)
  const sidecar = readSidecar(path)
  if (sidecar?.sha256 === hash && sidecar.bytes === data.byteLength && existsSync(`${path}.br`)) {
    return { path, skipped: true }
  }
  // 历代 PPSSPP 目录里的 wasm 大多逐字节相同：同一份内容只压一次（Brotli 11 每 18MB 要半分钟）
  if (!encodedByHash.has(hash)) {
    encodedByHash.set(hash, brotli(data, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_LGWIN]: 24,
        [constants.BROTLI_PARAM_SIZE_HINT]: data.byteLength,
      },
    }))
  }
  const encoded = await encodedByHash.get(hash)
  // 旧的压缩版无论如何先拿掉：原文件已经变了，留着就是过期内容
  rmSync(`${path}.br`, { force: true })
  rmSync(`${path}.br.json`, { force: true })
  if (encoded.byteLength > data.byteLength * (1 - MIN_SAVING)) return { path, notWorth: true }
  if (sha256(brotliDecompressSync(encoded)) !== hash) throw new Error(`${path} 压缩结果解不回原文件`)
  const temp = `${path}.br.tmp-${process.pid}`
  writeFileSync(temp, encoded)
  renameSync(temp, `${path}.br`)
  writeFileSync(`${path}.br.json`, `${JSON.stringify({ bytes: data.byteLength, sha256: hash, brBytes: encoded.byteLength })}\n`)
  return { path, before: data.byteLength, after: encoded.byteLength }
}

async function generate(base) {
  const targets = runtimeTargets(base)
  const queue = [...targets]
  const results = []
  // zlib 的异步压缩跑在 libuv 线程池（默认 4 条），并发 4 正好占满
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const path = queue.shift()
      const started = Date.now()
      const result = await compressOne(path)
      results.push(result)
      const rel = relative(base, path)
      if (result.skipped) continue
      if (result.notWorth) console.log(`· ${rel}：压不下 5%，不生成`)
      else console.log(`✔ ${rel}：${result.before} → ${result.after}（-${((1 - result.after / result.before) * 100).toFixed(1)}%，${Date.now() - started}ms）`)
    }
  }))
  const skipped = results.filter((r) => r.skipped).length
  console.log(`✔ 运行时预压缩：${targets.length} 个文件，${skipped} 个已是最新`)
}

function check(base) {
  let failed = 0
  let present = 0
  for (const path of runtimeTargets(base)) {
    if (!existsSync(`${path}.br`)) continue
    present += 1
    const sidecar = readSidecar(path)
    const data = readFileSync(path)
    if (!sidecar || sidecar.bytes !== data.byteLength || sidecar.sha256 !== sha256(data) ||
      statSync(`${path}.br`).size !== sidecar.brBytes) {
      console.error(`✖ ${relative(base, path)}.br 与原文件不一致；先运行 node scripts/precompress-runtimes.mjs`)
      failed += 1
    }
  }
  if (failed) process.exit(1)
  console.log(`✔ 运行时预压缩文件与原文件一致（${present} 个）`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args[0] === '--check') check(resolve(root, args[1] || 'dist/client'))
  else await generate(resolve(root, args[0] || 'public'))
}
