#!/usr/bin/env node
/**
 * 构建前体检：自建 EmulatorJS 及其核心到底在不在、对不对。
 *
 * 这一步存在的理由是历史教训：这套东西缺了任何一块，**构建照样成功**，
 * 站点照样能开，只有玩家真去开某个游戏那一刻才炸，而且三种缺法三种报错 ——
 *   缺 emulator.min.js            → 引擎整个起不来
 *   emulator.min.js 是 CDN 4.2.3  → 街机 BIOS 被解压，FBNeo 报「sp-s3.sp1 … missing」
 *   缺 cores/                     → 回落到 cdn.emulatorjs.org/4.3.0-pre/，
 *                                   报「Error loading EmulatorJS runtime」
 *   缺存档 ABI 回退补丁            → 存档一按就红字「FAILED TO SAVE STATE」（读档却是好的）
 * 每一种都曾经真实发生过。宁可让构建当场失败，把话说清楚。
 *
 * ── --dist：构建后再对一遍产物 ─────────────────────────────
 * 上面那些查的都是 public/。但真正跑在线上的是 dist/client/ 里那份拷贝，
 * 两者会脱节：2026-09-02 修好了存档 ABI（public/ 已打补丁、这个脚本也报「三项补丁均在位」），
 * 而线上仍在发 9-1 构建出来的旧引擎，玩家继续看到 FAILED TO SAVE STATE ——
 * 补丁在源码里、跑出去的是旧产物，是这套自托管引擎最容易栽的一跤：
 * 文件名不带哈希，看不出新旧，check 又只体检源码，全程没有一个环节会喊。
 *
 * 所以 `--dist` 在 vite build 之后跑（package.json 的 postbuild:client），
 * 直接按字节比对 dist/client/emulatorjs/ 与 public/emulatorjs/。
 * 只对 dist/client：SSR 那份 dist/server/emulatorjs/ 没有任何人访问
 * （server/src/index.js 的 express.static 挂的是 CLIENT_DIR）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'public', 'emulatorjs')
/** 构建后模式：额外比对 dist/client 里的产物（见头注释） */
const checkDist = process.argv.includes('--dist')
const distDir = join(root, 'dist', 'client', 'emulatorjs')
const fail = (msg, fix) => {
  console.error(`✖ ${msg}`)
  console.error(`  怎么修：${fix}`)
  process.exit(1)
}

if (!existsSync(join(dir, 'emulator.min.js')) || !existsSync(join(dir, 'loader.js'))) {
  fail(
    'public/emulatorjs/ 缺 emulator.min.js / loader.js（自建的 EmulatorJS 运行时）',
    '这目录是提交在 git 里的，正常 git pull 就有；真丢了就按 deploy/netplay/README.md 第一节重新构建',
  )
}

const js = readFileSync(join(dir, 'emulator.min.js'), 'utf8')
if (!js.includes('dontExtractIfCore')) {
  fail(
    'emulator.min.js 里没有 dontExtractIfCore —— 这是 CDN 的 4.2.3 版，不是我们自建的 main 分支版',
    '它会把街机的 neogeo.zip BIOS 解压喂给 FBNeo，直接玩不了。按 deploy/netplay/README.md 第一节重建，别从 CDN 下',
  )
}

if (!js.includes('t===this.EJS.config.gameUrl')) {
  fail(
    'emulator.min.js 缺「blob URL 文件名」补丁 —— 拖入本地街机 ROM 会报 Romset is unknown',
    'npm run ejspatch（幂等；升级引擎构建后都要重跑一次，见 scripts/patch-emulatorjs.mjs 头注释）',
  )
}

if (!js.includes('this.functions.saveStateInfo()')) {
  fail(
    'emulator.min.js 缺「存档 ABI 回退」补丁 —— 所有平台按保存进度都会红字 FAILED TO SAVE STATE',
    'npm run ejspatch。引擎（自建 4.3.0-pre）走 Module.EmulatorJSGetState，而 npm 发布的核心只导出老 ABI 的 save_state_info，两边对不上；详见 scripts/patch-emulatorjs.mjs 头注释',
  )
}

if (!existsSync(join(dir, 'cores', 'fbneo-wasm.data'))) {
  fail(
    'public/emulatorjs/cores/ 里没有核心（至少 fbneo-wasm.data 该在）',
    'npm install && npm run ejscores（核心来自 npm 的 @emulatorjs/core-*，prebuild 会自动复制，走到这里说明 npm install 没装上）',
  )
}

if (!checkDist) {
  console.log('✔ EmulatorJS 自建运行时 + 核心齐全（dontExtractIfCore / blob 文件名 / 存档 ABI 三项补丁均在位）')
  process.exit(0)
}

/* ---------------- --dist：产物有没有跟上源码 ---------------- */

if (!existsSync(distDir)) {
  fail(
    'dist/client/emulatorjs/ 不存在 —— 构建没有把自托管引擎拷进产物',
    'public/ 是 Vite 原样拷贝的，正常 vite build 一定会有。确认 vite.config.ts 的 publicDir 没被改掉，然后重新 npm run build:client',
  )
}

// 逐个字节比，而不是再 grep 一遍补丁特征串：
// 「产物落后于源码」不止存档 ABI 这一种，任何一次改了 public/ 却没重新构建都算，
// 特征串检查只能抓到已知的那几个，字节比对一次抓全。
for (const name of ['emulator.min.js', 'loader.js']) {
  const src = join(dir, name)
  const out = join(distDir, name)
  if (!existsSync(out)) {
    fail(`dist/client/emulatorjs/${name} 不存在，但 public/ 里有`, '重新 npm run build:client')
  }
  if (!readFileSync(src).equals(readFileSync(out))) {
    fail(
      `dist/client/emulatorjs/${name} 和 public/ 里的对不上 —— 线上跑的是旧引擎，源码里的补丁没生效`,
      '重新 npm run build:client；已经部署过的话还要清一次 CDN 缓存 —— ' +
        '这些文件名不带哈希，server/src/cache.js 给 /emulatorjs/ 发的是 s-maxage=2592000（边缘缓存 30 天）',
    )
  }
}

// 核心只点名，不比字节：单个 .data 有 1MB 上下，二十来个全读一遍会明显拖慢构建，
// 而核心是 npm 包复制过来的、极少变动，缺失比过期常见得多。
const cores = readdirSync(join(dir, 'cores')).filter((f) => f.endsWith('.data'))
const distCores = new Set(
  existsSync(join(distDir, 'cores')) ? readdirSync(join(distDir, 'cores')) : [],
)
const missing = cores.filter((f) => !distCores.has(f))
if (missing.length) {
  fail(
    `dist/client/emulatorjs/cores/ 少了 ${missing.length} 个核心（如 ${missing[0]}）`,
    '重新 npm run build:client；核心不在产物里，玩家开这些平台会回落到 cdn.emulatorjs.org 甚至直接报 Error loading EmulatorJS runtime',
  )
}

console.log(`✔ dist/client/emulatorjs/ 与 public/ 一致（引擎逐字节相同，${cores.length} 个核心齐全）`)
