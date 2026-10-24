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
 * 两者会脱节：2026-09-02 修好了存档 ABI（public/ 已打补丁、源码体检也全部通过），
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
import { createHash } from 'node:crypto'
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

if (!js.includes('const p=(t.split("/").pop()||"").split(/[?#]/)[0]')) {
  fail(
    'emulator.min.js 缺「版本化文件路径覆盖」补丁 —— 带 ?v= 的核心报告匹配不到 EJS_paths',
    'npm run ejspatch。报告按小时带查询串，但 EJS_paths 的键只有 basename；详见 patch-emulatorjs.mjs 第三节',
  )
}

if (!js.includes('JSON.parse(new TextDecoder().decode(i.files[0].bytes))')) {
  fail(
    'emulator.min.js 缺「核心报告 JSON 解析」补丁 —— 引擎会禁用 IndexedDB 核心缓存',
    'npm run ejspatch。新下载器返回 CacheItem，不能再把 i.data 直接当 JSON；详见 patch-emulatorjs.mjs 第三节',
  )
}

if (!/m=\[[^\]]*"melondsds"[^\]]*\]/.test(js)) {
  fail(
    'emulator.min.js 没把 melondsds 列为强制 WebGL2 核心 —— 报告短暂 404 时会请求不存在的 legacy 文件',
    'npm run ejspatch。melonDS DS 只发布 wasm 产物，不能让引擎回退到 melondsds-legacy-wasm.data',
  )
}

if (
  !js.includes(
    '"string"==typeof t.minimumEJSVersion&&t.minimumEJSVersion.length>0&&this.versionAsInt(t.minimumEJSVersion)',
  )
) {
  fail(
    'emulator.min.js 缺核心最低引擎版本字段保护 —— 没有 minimumEJSVersion 的核心报告会在开局时触发 endsWith 异常',
    'npm run ejspatch。缺省版本应跳过兼容性比较；明确声明的版本仍须照常校验',
  )
}

if (!existsSync(join(dir, 'cores', 'fbneo-wasm.data'))) {
  fail(
    'public/emulatorjs/cores/ 里没有核心（至少 fbneo-wasm.data 该在）',
    'npm install && npm run ejscores（核心来自 npm 的 @emulatorjs/core-*，prebuild 会自动复制，走到这里说明 npm install 没装上）',
  )
}

// PS1 Range 依赖 Beetle 不再整盘预缓存；同名核心若被上游覆盖，网页分片层会退化成整盘读取。
const psxCore = join(dir, 'cores', 'mednafen_psx_hw-wasm.data')
const psxCoreHash = existsSync(psxCore)
  ? createHash('sha256').update(readFileSync(psxCore)).digest('hex')
  : ''
if (psxCoreHash !== 'c830df67587ba84a55bf6b962fafdc90b73bcc27f720dd074e20d746003999bb') {
  fail('Beetle PS1 核心缺少关闭整盘预缓存的 Range 补丁', '先核对上游源码，再运行 node scripts/patch-psx-range-core.mjs；新核心必须重新取证')
}
// 可玩的 Range 路径使用软件版；仅验证旧 HW 补丁会让部署时误把会崩溃的核心当成合格产物。
for (const variant of ['wasm', 'legacy-wasm']) {
  const archive = join(dir, 'cores', `mednafen_psx-${variant}.data`)
  const hash = existsSync(archive) ? createHash('sha256').update(readFileSync(archive)).digest('hex') : ''
  if (hash !== 'aa489e36f1938e14ab3e03854a09acbb03da0634362ec741d60094fe70e4f33b') {
    fail(`Beetle PS1 软件版 ${variant} 核心未通过 Range 游戏实测版本校验`, '恢复随仓库发布的 mednafen_psx 核心；换版后必须重做浏览器实玩验收')
  }
}

/*
  构建报告必须同时有 metadata 别名，而且逐字节一致。

  线上实测浏览器会把 `/cores/reports/<core>.json` 以 ERR_BLOCKED_BY_CLIENT 拦掉，
  引擎随即禁用 IndexedDB 缓存；KOF97 因此每次都要重新下载并解压约 8MB 的 FBNeo 核心。
  运行时已改请求不含 reports 的 metadata/；这里防止只改了地址却漏发文件，或自构建核心
  更新报告后别名仍停在上一版。
*/
const reportsDir = join(dir, 'cores', 'reports')
const metadataDir = join(dir, 'cores', 'metadata')
if (!existsSync(reportsDir) || !existsSync(metadataDir)) {
  fail(
    'EmulatorJS 核心报告缺 reports/ 或 metadata/ 目录',
    'npm run ejsmeta；运行时只请求 metadata/，用来避开会误拦 `/reports/` 的浏览器隐私规则',
  )
}
const reports = readdirSync(reportsDir).filter((name) => name.endsWith('.json'))
if (!reports.length) {
  fail('EmulatorJS 没有任何核心构建报告', '重新复制核心并运行 npm run ejsmeta')
}
for (const name of reports) {
  const alias = join(metadataDir, name)
  if (!existsSync(alias) || !readFileSync(join(reportsDir, name)).equals(readFileSync(alias))) {
    fail(
      `cores/metadata/${name} 缺失或与 reports/${name} 不一致`,
      'npm run ejsmeta；不要手工维护两份报告，构建前也会自动同步',
    )
  }
}

if (!checkDist) {
/*
  引擎的下载器必须还是 fetch。

  为什么要盯：`installNetTap`（adapters/emulatorjs.ts）就是靠包 iframe 的 `fetch` 才拿到
  加载进度、卡死心跳、以及 4xx/5xx 的拦截。这套东西**上一次已经悄悄失效过一整轮** ——
  当时它包的是 XMLHttpRequest，而引擎早就改用 fetch 了，于是探针整块变成死代码：
  BIOS 配错报成一句无关的「Network Error」、核心下载没有真实进度、卡死检测误报。
  tsc 不会响，页面照样能开，只有玩家撞上才知道。所以升级引擎时必须在这里当场拦住。
*/
{
  const xhrHits = (js.match(/XMLHttpRequest/g) || []).length
  if (!/\bfetch\s*\(/.test(js)) {
    fail(
      'emulator.min.js 里找不到 fetch 调用 —— 引擎可能换回了 XHR 或别的下载实现',
      'adapters/emulatorjs.ts 的 installNetTap 是靠包 fetch 工作的，换实现的话那套进度/心跳/4xx 拦截会整块失效；去那个函数里跟着改',
    )
  }
  // socket.io 自带的 polling 传输会用到 XHR，几处是正常的；多到不像话就说明引擎改实现了
  if (xhrHits > 12) {
    fail(
      `emulator.min.js 里 XMLHttpRequest 出现了 ${xhrHits} 次，远多于 socket.io 那几处`,
      '引擎可能把下载器换回了 XHR。确认之后回去看 installNetTap 包的是哪一个',
    )
  }
}

  console.log('✔ EmulatorJS 自建运行时 + 核心齐全（关键补丁在位，下载器仍是 fetch）')
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

// metadata 很小，全部逐字节比对；任何一份漏进 dist 都会让对应平台退回「每局重下核心」。
for (const name of reports) {
  const src = join(metadataDir, name)
  const out = join(distDir, 'cores', 'metadata', name)
  if (!existsSync(out) || !readFileSync(src).equals(readFileSync(out))) {
    fail(
      `dist/client/emulatorjs/cores/metadata/${name} 缺失或落后于 public/`,
      '重新 npm run build:client；核心报告不对时 EmulatorJS 会禁用 IndexedDB 缓存',
    )
  }
}

console.log(`✔ dist/client/emulatorjs/ 与 public/ 一致（引擎逐字节相同，${cores.length} 个核心、${reports.length} 份缓存元数据齐全）`)
