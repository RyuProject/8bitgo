/**
 * 已知街机改版包（src/data/arcadeHacks.ts）的自检。
 *
 * 这张表里最容易悄悄坏掉的不是指纹，是**那份内置 dat 和真包对不对得上**：
 * RomData 会把 ROM 清单整个替换掉，写错一个文件名或 CRC，核心不会说"你写错了"，
 * 只会说 "Romset is unknown" 或者少装一块图形，看起来像是包的问题。
 *
 * 所以这里拿一份**真包的成员表**（wofcn.zip 的中央目录，25 项）当基准，
 * 正反两个方向都对一遍。
 *
 * 用法：npm run test:arcade-hacks
 */
import assert from 'node:assert/strict'
import { ARCADE_HACKS, matchArcadeHack } from '../src/data/arcadeHacks.ts'

/**
 * wofcn.zip 的真实成员表（name / 未压缩大小 / CRC-32），2026-09-04 从玩家给的包里读的。
 * 这就是 HBMAME 的 tk2h5「Tenchi wo Kurau II (Edition Chinese)」——
 * 基于**日版 wofj** 的中文 Hack，不是 wofch 的残缺版（覆盖率那套曾经就是这么判错的，
 * 见 arcadeHacks.ts 头注释）。
 */
const WOFCN_ZIP = [
  ['tk2_gfx1.rom', 524288, 0x0d9cb9bf], ['tk2_gfx2.rom', 524288, 0xc5ca2460],
  ['tk2_gfx3.rom', 524288, 0x45227027], ['tk2_gfx4.rom', 524288, 0xe349551c],
  ['tk2_q1.rom', 524288, 0x611268cf], ['tk2_q2.rom', 524288, 0x20f55ca9],
  ['tk2_q3.rom', 524288, 0xbfcf6f52], ['tk2_q4.rom', 524288, 0x36642e88],
  ['tk2_qa.rom', 131072, 0xc9183a0d],
  ['buf1', 279, 0xeb122de7], ['ioa1', 279, 0x59c7ee3b], ['rom1', 279, 0x41dc73b9],
  ['bprg1.11d', 279, 0x31793da7], ['iob1.12d', 279, 0x3abc0700], ['ioc1.ic1', 279, 0x0d182081],
  ['prg2', 279, 0x4386879a], ['tk263b.1a', 279, 0xc4b0349b],
  ['tk205.bin', 524288, 0xe4a44d53], ['tk206.bin', 524288, 0x58066ba8],
  ['tk207.bin', 524288, 0xd706568e], ['tk208.bin', 524288, 0xd4a19a02],
  ['tk2j22c.bin', 524288, 0xb74b09ac],
  ['tk2_gfx5cn.rom', 524288, 0xec6e8689], ['tk2_gfx6cn.rom', 524288, 0x722787df],
  ['tk2j23ccn.bin', 524288, 0xe1dd01d8],
]

let n = 0
const ok = (cond, msg) => { assert.ok(cond, msg); n++; console.log('✅ ' + msg) }

/** dat 里的 ROM 行：<名字> <0x大小> <0xCRC> <类型…>。注释、空行、头部字段都不是 */
function romLines(dat) {
  return dat
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .map((l) => l.split(/\s+/))
    .filter((t) => t.length >= 3 && /^0x[0-9a-f]+$/i.test(t[1]) && /^0x[0-9a-f]+$/i.test(t[2]))
    .map((t) => ({ name: t[0], size: Number(t[1]), crc: Number(t[2]) >>> 0, flags: t.slice(3) }))
}

console.log('── 指纹识别 ──')
const hack = matchArcadeHack(WOFCN_ZIP.map(([, , crc]) => crc))
ok(hack?.zipName === 'wofcn', '真包能认出来，是 wofcn')
ok(hack.driver === 'wofj', `借的是日版 wofj 驱动（不是 wof / wofch），实际 ${hack.driver}`)

// 少一个指纹就不认 —— 指纹必须全中，宁可交回给覆盖率那套去猜
for (const missing of hack.fingerprint) {
  const partial = WOFCN_ZIP.map(([, , c]) => c).filter((c) => c !== missing)
  ok(matchArcadeHack(partial) === null, `少了指纹 0x${missing.toString(16)} 就不认（不会误判）`)
}
ok(matchArcadeHack([]) === null, '空包不认')

console.log('\n── 内置 dat 和真包对得上 ──')
const rows = romLines(hack.romData)
const byName = new Map(WOFCN_ZIP.map(([name, size, crc]) => [name, { size, crc }]))
ok(rows.length > 0, `dat 里解析出 ${rows.length} 条 ROM 行`)

const missing = rows.filter((r) => !byName.has(r.name))
ok(missing.length === 0, `dat 里的每个文件真包里都有${missing.length ? '：缺 ' + missing.map((r) => r.name).join(', ') : ''}`)

const wrong = rows.filter((r) => byName.has(r.name) && (byName.get(r.name).crc !== r.crc || byName.get(r.name).size !== r.size))
ok(wrong.length === 0, `大小和 CRC 全部吻合${wrong.length ? '：' + wrong.map((r) => r.name).join(', ') : ''}`)

// 反过来：包里有、dat 没提的文件 = 那块 ROM 永远不会被装载
const referenced = new Set(rows.map((r) => r.name))
const orphan = WOFCN_ZIP.map(([name]) => name).filter((name) => !referenced.has(name))
ok(orphan.length === 0, `包里每个文件 dat 都用上了${orphan.length ? '：漏了 ' + orphan.join(', ') : ''}`)

console.log('\n── 写 dat 的三条硬规则 ──')
for (const h of ARCADE_HACKS) {
  if (!h.romData) continue
  const dat = h.romData
  ok(/^\s*ZipName\s+\S+/m.test(dat), `${h.zipName}: 有 ZipName`)
  ok(/^\s*DrvName\s+\S+/m.test(dat), `${h.zipName}: 有 DrvName`)
  ok(new RegExp(`^\\s*ZipName\\s+${h.zipName}\\s*$`, 'm').test(dat), `${h.zipName}: dat 里的 ZipName 和表里的一致（核心按这个名字找包）`)
  // FullName 不加引号的话 romdata.cpp 的 strqtoken 只会取到第一个词
  ok(/^\s*FullName\s+"/m.test(dat), `${h.zipName}: FullName 加了引号`)
  // 类型列必填：libretro 版没有 RDSetRomsType()，类型为 0 的行会被直接丢掉
  const untyped = romLines(dat).filter((r) => !r.flags.some((f) => /^(BRF_|CPS1_|CPS2_)/.test(f)))
  ok(untyped.length === 0, `${h.zipName}: 每条 ROM 行都带类型${untyped.length ? '：' + untyped.map((r) => r.name).join(', ') : ''}`)
  ok(!dat.includes('\r'), `${h.zipName}: 没有 CRLF（\\r 会并进最后一个 token）`)
}

console.log(`\n全部通过 ✅  共 ${n} 项`)
