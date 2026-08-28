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
 * 每一种都曾经真实发生过。宁可让构建当场失败，把话说清楚。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'public', 'emulatorjs')
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

if (!existsSync(join(dir, 'cores', 'fbneo-wasm.data'))) {
  fail(
    'public/emulatorjs/cores/ 里没有核心（至少 fbneo-wasm.data 该在）',
    'npm install && npm run ejscores（核心来自 npm 的 @emulatorjs/core-*，prebuild 会自动复制，走到这里说明 npm install 没装上）',
  )
}

console.log('✔ EmulatorJS 自建运行时 + 核心齐全（含 dontExtractIfCore）')
