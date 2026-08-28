#!/usr/bin/env node
/**
 * 升级 EmulatorJS 核心用的工具（平时不用跑 —— 核心已经提交在
 * public/emulatorjs/cores/ 里，git pull 下来就有，构建不依赖这个脚本）。
 *
 * 升级步骤：
 *   npm i --no-save @emulatorjs/cores@latest   # 官方全部核心，几百 MB，所以 --no-save
 *   npm run ejscores                           # 挑我们要的 12 个复制进 public/
 *   git add public/emulatorjs/cores/           # 升级结果照旧进 git
 *   （删掉 node_modules 里的全家桶：再跑一次 npm install 会自动清掉）
 *
 * 为什么不把核心做成 npm 依赖：每个 @emulatorjs/core-* 都依赖 @emulatorjs/emulatorjs，
 * 后者又可选依赖 @emulatorjs/cores = 全部 50 个核心 —— 装 12 个等于装全家桶。
 *
 * ── 为什么核心必须自托管 ─────────────────────────────────────────
 * public/emulatorjs/ 是从 EmulatorJS main 分支自建的（为了 dontExtractIfCore，
 * 见 adapters/emulatorjs.ts 开头），它自称 4.3.0-pre。本地 cores/ 取不到时，
 * 它会回落到 cdn.emulatorjs.org/4.3.0-pre/ 去拉核心 —— 引擎自己都在控制台里喊
 * 「THIS METHOD IS A FAILSAFE, AND NOT OFFICIALLY SUPPORTED」。实测拉回来的
 * 东西初始化不出 EJS_Runtime，玩家看到的就是「Error loading EmulatorJS runtime」。
 * 核心放本地，这条不受我们控制的路径就永远不会走到。
 *
 * ── 复制哪些 ────────────────────────────────────────────────────
 * platforms.ts 里 runtime: 'emulatorjs' 的每个平台的默认核心，外加街机的两个
 * 备选（后台可以按游戏改核心）。每个核心两个变体：
 *   <core>-wasm.data          正常版
 *   <core>-legacy-wasm.data   给不支持 WebGL2 的老浏览器
 * thread 变体不复制：要 SharedArrayBuffer，得给整站加 COOP/COEP 响应头，
 * 目前用它的只有 dosbox_pure / ppsspp，而 DOS 走的是 js-dos，用不上。
 * reports/<core>.json 也带上 —— 没有它引擎会禁用核心的 IndexedDB 缓存，
 * 每次进游戏都重新下核心。
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'public', 'emulatorjs', 'cores')
const ifMissing = process.argv.includes('--if-missing')

/** 平台 → 默认核心的对应关系见 EmulatorJS 的 getCores()（emulator.min.js 里的 u 表） */
const CORES = [
  'fbneo',              // arcade 默认（拳皇 97 这类 Neo Geo 全在这）
  'fbalpha2012_cps1',   // arcade 备选：CPS1（街霸2 初代系）
  'fbalpha2012_cps2',   // arcade 备选：CPS2（街霸2X / 恐龙快打）
  'fceumm',             // nes
  'snes9x',             // snes
  'mgba',               // gba
  'gambatte',           // gb
  'mupen64plus_next',   // n64
  'pcsx_rearmed',       // psx
  'genesis_plus_gx',    // segaMD
  'mednafen_wswan',     // ws
  'melonds',            // nds
]

if (ifMissing && existsSync(join(out, 'fbneo-wasm.data'))) process.exit(0)

const missing = CORES.filter((c) => !existsSync(join(root, 'node_modules', '@emulatorjs', `core-${c}`)))
if (missing.length) {
  const msg = `未找到 node_modules/@emulatorjs/core-*：${missing.join(', ')}，先 npm i --no-save @emulatorjs/cores@latest`
  if (ifMissing) {
    console.warn(`⚠ ${msg}`)
    process.exit(0)
  }
  console.error(`✖ ${msg}`)
  process.exit(1)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'reports'), { recursive: true })
let n = 0
let bytes = 0
for (const c of CORES) {
  const src = join(root, 'node_modules', '@emulatorjs', `core-${c}`)
  for (const f of [`${c}-wasm.data`, `${c}-legacy-wasm.data`]) {
    copyFileSync(join(src, f), join(out, f))
    n++
  }
  const report = join(src, 'reports', `${c}.json`)
  if (existsSync(report)) {
    copyFileSync(report, join(out, 'reports', `${c}.json`))
    n++
  }
}
console.log(`✔ EmulatorJS 核心已复制 ${n} 个文件到 public/emulatorjs/cores/（${CORES.length} 个核心 × 正常/legacy 两个变体）`)
