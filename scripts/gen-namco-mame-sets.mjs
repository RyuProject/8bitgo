#!/usr/bin/env node
/**
 * 从 MAME 源码生成 Namco System 11 / 12 的 romset 指纹表（src/lib/namcoMameSetsData.ts）。
 *
 * 为什么要生成而不是手抄：System 11 + 12 一共 95 个 set（含克隆），每个十来颗 ROM，
 * 手抄 CRC 必错；MAME 的 ROM_START 是这些板子的唯一权威清单（FBNeo 索引里一个都没有）。
 * MAME 克隆的 ROM_START 本身就是完整清单（共用的 ROM 重复列出），所以按 set 逐项比对
 * 就能直接判定「这是一个 non-merged 自洽包」。
 *
 * 用法：
 *   curl -sSO https://raw.githubusercontent.com/mamedev/mame/master/src/mame/namco/namcos11.cpp
 *   curl -sSO https://raw.githubusercontent.com/mamedev/mame/master/src/mame/namco/namcos12.cpp
 *   node scripts/gen-namco-mame-sets.mjs namcos11.cpp namcos12.cpp
 *
 * ⚠️ 核心（mame-current）的 MAME 版本变了要重新生成：MAME 偶尔会给 ROM 改名或改 CRC。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const files = process.argv.slice(2)
if (!files.length) {
  console.error('用法：node scripts/gen-namco-mame-sets.mjs <namcos11.cpp> <namcos12.cpp>')
  process.exit(2)
}

function parse(file) {
  const src = readFileSync(file, 'utf8')
  const sets = {}
  for (const m of src.matchAll(/ROM_START\(\s*(\w+)\s*\)([\s\S]*?)ROM_END/g)) {
    const roms = [...m[2].matchAll(/ROM_\w*\s*\(\s*"([^"]+)"\s*,[^;\n]*?CRC\(\s*([0-9a-fA-F]{8})\s*\)/g)]
      .map((r) => [r[1].toLowerCase(), r[2].toLowerCase()])
    const disks = [...m[2].matchAll(/DISK_IMAGE\w*\(\s*"([^"]+)"/g)].map((d) => d[1].toLowerCase())
    sets[m[1]] = { roms, disks }
  }
  const games = [...src.matchAll(/^\s*GAME\(\s*(\d+)\s*,\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*,\s*\w+\s*,\s*\w+\s*,\s*\w+\s*,\s*[^,]+,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*([^)]*)\)/gm)]
    .map((g) => ({ year: Number(g[1]), name: g[2], parent: g[3] === '0' ? '' : g[3], machine: g[4], title: g[6], flags: g[7] }))
  return { games, sets }
}

const out = []
for (const file of files) {
  const board = /namcos11/.test(basename(file)) ? 11 : /namcos12/.test(basename(file)) ? 12 : 0
  if (!board) throw new Error(`认不出是哪块板子：${file}`)
  const { games, sets } = parse(file)
  for (const g of games) {
    const set = sets[g.name]
    if (!set || !set.roms.length) throw new Error(`${g.name} 没有 ROM 清单`)
    const names = new Set()
    for (const [n] of set.roms) {
      if (names.has(n)) throw new Error(`${g.name} 有重名 ROM ${n}`)
      names.add(n)
    }
    const status = /MACHINE_NOT_WORKING/.test(g.flags)
      ? 'not-working'
      : /MACHINE_NODEVICE_LAN/.test(g.flags)
        ? 'needs-link'
        : /MACHINE_IMPERFECT/.test(g.flags)
          ? 'imperfect'
          : 'ok'
    out.push({
      r: g.name,
      p: g.parent,
      b: board,
      // System 11 每块板都带 C76 声音 MCU（内部 16KB ROM，MAME 设备 namcoc76）；System 12 没有 BIOS 集。
      m: g.machine,
      t: g.title,
      y: g.year,
      s: status,
      d: set.disks,
      f: set.roms.map(([n, c]) => `${n}:${c}`).join(' '),
    })
  }
}
out.sort((a, b) => a.b - b.b || a.r.localeCompare(b.r))

const target = join(dirname(fileURLToPath(import.meta.url)), '../src/lib/namcoMameSetsData.ts')
const body = `/* 自动生成，勿手改：node scripts/gen-namco-mame-sets.mjs namcos11.cpp namcos12.cpp（见脚本头注释） */
/* eslint-disable */
export interface NamcoMameSetRow {
  /** MAME 短名 */
  r: string
  /** 父集短名；空串是父集 */
  p: string
  /** 11 = Namco System 11，12 = Namco System 12 */
  b: 11 | 12
  /** MAME machine config（coh700 / coh700b / aplarail …） */
  m: string
  t: string
  y: number
  s: 'ok' | 'imperfect' | 'needs-link' | 'not-working'
  /** 必需 CHD 名；非空时还要 MAME 媒体盘 */
  d: readonly string[]
  /** 空格分隔的 "rom名:crc32" */
  f: string
}

export const NAMCO_MAME_SETS: readonly NamcoMameSetRow[] = ${JSON.stringify(out, null, 0).replace(/\},\{/g, '},\n  {')}
`
writeFileSync(target, body)
console.log(`写入 ${target}：${out.length} 个 set（System 11 ${out.filter((x) => x.b === 11).length}，System 12 ${out.filter((x) => x.b === 12).length}）`)
