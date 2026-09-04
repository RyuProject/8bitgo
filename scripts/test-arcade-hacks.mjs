/**
 * 已知街机改版包（src/data/arcadeHacks.ts）的自检。
 *
 * 这张表里最容易悄悄坏掉的不是指纹，是**那份内置 dat 和真包对不对得上**：
 * RomData 会把 ROM 清单整个替换掉，写错一个文件名或 CRC，核心不会说"你写错了"，
 * 只会说 "Romset is unknown" 或者少装一块图形，看起来像是包的问题。
 *
 * 所以这里拿一份**真包的成员表**（wofcn.zip 的中央目录，25 项）当基准，
 * 正反两个方向都对一遍；带 derive 的条目还要多对一层「合成产物和 dat 是否咬合」。
 *
 * 用法：npm run test:arcade-hacks
 */
import assert from 'node:assert/strict'
import { ARCADE_HACKS, matchArcadeHack } from '../src/data/arcadeHacks.ts'
import { crc32, appendZipEntries, listZipEntries, extractZipEntry } from '../src/lib/unzip.ts'

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

console.log('\n── 合成 ROM（derive）──')
/**
 * 合成用真包跑不了（仓库里不放 ROM），所以这里只验**机制**：
 * 输出必须是「原 ROM 原样 + 只有那个窗口换成补丁片」。
 * 窗口一旦改动，dat 里那两个合成产物的 CRC 就不再是 arcadeHacks.ts 记的值 ——
 * 那两个 CRC 是 2026-09-04 拿真包（wofj 的 gfx1/gfx3 + wofcn 的 gfx5cn/gfx6cn）
 * 实算出来的，并且用完整的 FBNeo 装载管线渲染验证过中文能正常显示。
 */
const SIZE = 0x080000
const WINDOW = [0x010000, 0x019c00]
const fill = (byte) => new Uint8Array(SIZE).fill(byte)
const derived = hack.derive.run({
  'tk2_gfx1.rom': fill(0x11), 'tk2_gfx3.rom': fill(0x33),
  'tk2_gfx5cn.rom': fill(0x55), 'tk2_gfx6cn.rom': fill(0x66),
})
ok(derived.length === 2, `产出 2 块合成 ROM：${derived.map((d) => d.name).join(', ')}`)
for (const [i, base] of [0x11, 0x33].entries()) {
  const patch = [0x55, 0x66][i]
  const d = derived[i].data
  ok(d.length === SIZE, `${derived[i].name}: 长度还是 0x${SIZE.toString(16)}`)
  ok(d.subarray(0, WINDOW[0]).every((b) => b === base), `${derived[i].name}: 窗口之前是原 ROM 的内容`)
  ok(d.subarray(WINDOW[0], WINDOW[1]).every((b) => b === patch), `${derived[i].name}: 窗口内换成了补丁片`)
  ok(d.subarray(WINDOW[1]).every((b) => b === base), `${derived[i].name}: 窗口之后还是原 ROM 的内容`)
}
// 合成不能改调用方的 buffer —— 上面那些 fill() 如果被就地改了，第二次调用结果就不对
const again = hack.derive.run({
  'tk2_gfx1.rom': fill(0x11), 'tk2_gfx3.rom': fill(0x33),
  'tk2_gfx5cn.rom': fill(0x55), 'tk2_gfx6cn.rom': fill(0x66),
})
ok(crc32(again[0].data) === crc32(derived[0].data), '合成是纯函数，同样输入同样输出')

console.log('\n── 内置 dat 和真包 + 合成产物对得上 ──')
const rows = romLines(hack.romData)
const byName = new Map(WOFCN_ZIP.map(([name, size, crc]) => [name, { size, crc }]))
const derivedNames = new Set(derived.map((d) => d.name))
const deriveInputs = new Set(hack.derive.inputs)
ok(rows.length > 0, `dat 里解析出 ${rows.length} 条 ROM 行`)

const missing = rows.filter((r) => !byName.has(r.name) && !derivedNames.has(r.name))
ok(missing.length === 0, `dat 里的每个文件要么在真包里、要么是合成产物${missing.length ? '：缺 ' + missing.map((r) => r.name).join(', ') : ''}`)

const wrong = rows.filter((r) => byName.has(r.name) && (byName.get(r.name).crc !== r.crc || byName.get(r.name).size !== r.size))
ok(wrong.length === 0, `真包里那些的大小和 CRC 全部吻合${wrong.length ? '：' + wrong.map((r) => r.name).join(', ') : ''}`)

// 合成产物在 dat 里必须写成和原 ROM 一样的长度 —— derive 只换窗口，不改长度
const badSize = rows.filter((r) => derivedNames.has(r.name) && r.size !== SIZE)
ok(badSize.length === 0, `合成产物在 dat 里写的长度是 0x${SIZE.toString(16)}${badSize.length ? '：' + badSize.map((r) => r.name).join(', ') : ''}`)

// derive 的输入被合成产物取代了，dat 里不能再直接引用 —— 引用了就等于把补丁片
// 或者未打补丁的原图形装进去，中文一定不显示
const stillReferenced = rows.filter((r) => deriveInputs.has(r.name) && !derivedNames.has(r.name))
const replaced = new Set(['tk2_gfx1.rom', 'tk2_gfx3.rom', 'tk2_gfx5cn.rom', 'tk2_gfx6cn.rom'])
ok(
  stillReferenced.every((r) => !replaced.has(r.name)),
  `被合成取代的原 ROM 没有再出现在 dat 里${stillReferenced.length ? '：' + stillReferenced.map((r) => r.name).join(', ') : ''}`,
)

// 反过来：包里有、dat 没提、也不是合成输入的文件 = 那块 ROM 永远不会被装载
const referenced = new Set(rows.map((r) => r.name))
const orphan = WOFCN_ZIP.map(([name]) => name).filter((name) => !referenced.has(name) && !deriveInputs.has(name))
ok(orphan.length === 0, `包里每个文件要么 dat 用上了、要么是合成输入${orphan.length ? '：漏了 ' + orphan.join(', ') : ''}`)

console.log('\n── 往包里追加成员（appendZipEntries）──')
// 空 zip = 只有一条 EOCD，是合法的；从它开始追加最能单独验证写出来的结构
const emptyZip = new Uint8Array(22)
new DataView(emptyZip.buffer).setUint32(0, 0x06054b50, true)
const adds = [
  { name: 'a.rom', data: new Uint8Array([1, 2, 3, 4, 5]) },
  { name: 'b.rom', data: new Uint8Array(1000).fill(0xab) },
]
const zipped = appendZipEntries(emptyZip.buffer, adds)
const back = listZipEntries(zipped.buffer)
ok(back.length === 2, `追加后能读回 2 个成员：${back.map((e) => e.name).join(', ')}`)
for (const [i, a] of adds.entries()) {
  const e = back.find((x) => x.name === a.name)
  ok(!!e, `读回了 ${a.name}`)
  ok(e.crc32 === crc32(a.data), `${a.name} 的 CRC 对得上（RomData 要按 CRC 认 ROM）`)
  ok(e.uncompressedSize === a.data.length, `${a.name} 的长度对得上`)
  const got = await extractZipEntry(zipped.buffer, e)
  ok(Buffer.compare(Buffer.from(got), Buffer.from(a.data)) === 0, `${a.name} 的内容一字节不差`)
  void i
}
// 原有成员必须一个字节都不动 —— 追加是插在中央目录之前，旧的 localOffset 还有效
const twice = appendZipEntries(zipped.buffer, [{ name: 'c.rom', data: new Uint8Array([9]) }])
const back2 = listZipEntries(twice.buffer)
ok(back2.length === 3, '可以连续追加，旧成员还在')
for (const a of adds) {
  const e = back2.find((x) => x.name === a.name)
  const got = await extractZipEntry(twice.buffer, e)
  ok(Buffer.compare(Buffer.from(got), Buffer.from(a.data)) === 0, `再追加一次后 ${a.name} 内容不变`)
}

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

  // 装载循环的下标是按位置算的：同类必须连续，中间不能插别的类型
  const kindOf = (r) =>
    r.flags.find((f) => /^CPS1_/.test(f))?.replace(/^CPS1_/, '') ?? (r.flags.includes('BRF_OPT') ? 'OPT' : '?')
  const seq = romLines(dat).map(kindOf)
  const firstIdx = new Map(); const lastIdx = new Map()
  seq.forEach((k, i) => { if (!firstIdx.has(k)) firstIdx.set(k, i); lastIdx.set(k, i) })
  const split = [...firstIdx.keys()].filter((k) => lastIdx.get(k) - firstIdx.get(k) + 1 !== seq.filter((x) => x === k).length)
  ok(split.length === 0, `${h.zipName}: 同类型的 ROM 行连续、中间没插别的${split.length ? '：' + split.join(', ') : ''}`)

  // 图形必须是 4 的整数倍：CpsLoadTiles 一次固定吃 4 条
  const tiles = seq.filter((k) => k === 'TILES').length
  ok(tiles % 4 === 0, `${h.zipName}: CPS1_TILES 有 ${tiles} 条，是 4 的整数倍`)

  // derive 的产出和 dat 必须咬合
  if (h.derive) {
    const outNames = new Set(h.derive.run(Object.fromEntries(h.derive.inputs.map((k) => [k, fill(0)]))).map((d) => d.name))
    const names = new Set(romLines(dat).map((r) => r.name))
    ok([...outNames].every((x) => names.has(x)), `${h.zipName}: 每个合成产物 dat 里都引用了（${[...outNames].join(', ')}）`)
  }
}

console.log(`\n全部通过 ✅  共 ${n} 项`)
