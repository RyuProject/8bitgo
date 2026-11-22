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
import { ARCADE_HACKS, matchArcadeHack, romScopedHackForData, romScopedHackForName } from '../src/data/arcadeHacks.ts'
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
let failedChecks = 0
/**
 * ⚠️ 断言失败**不再抛异常**，而是记一笔继续往下跑。
 *
 * 原来是 `assert.ok(cond, msg)` —— 第一条炸了整个进程就退出，后面的用例一条都不执行。
 * 2026-09-11 的教训：test:indexnow 从 09-08 起就红着，28 条里只跑到第 6 条，
 * 后面 22 条三天没被执行过，而没人知道，因为根本没人跑它（现在有 `npm test` 了）。
 * 一条小毛病不该把整套的价值清零。
 *
 * 退出码由下面那个 exit 钩子负责 —— 有失败就是非零，绝不会变成静默通过。
 */
const ok = (cond, msg) => {
  if (cond) {
    n++
    console.log('✅ ' + msg)
    return
  }
  failedChecks++
  console.log('❌ ' + msg)
}
process.on('exit', () => {
  if (failedChecks) {
    console.log(`\n❌ ${failedChecks} 项失败（上面带 ❌ 的那几条）`)
    process.exitCode = 1
  }
})

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
ok(hack.romDataScope === 'rom', 'wofcn 的 RomData 标记为 ROM 专属，不写入游戏级共享字段')
ok(hack.romData === undefined && hack.derive === undefined, '没有真实对白画面验收前，播放器不拿实验方案开局')
ok(hack.experimentalPlan?.romData && hack.experimentalPlan.derive, '候选 RomData 与合成方案仅保存在诊断字段')
ok(romScopedHackForData(hack.experimentalPlan?.romData)?.zipName === 'wofcn', '实验方案的 ZipName 仍能识别为 ROM 专属配置')
ok(romScopedHackForName('wofcn.zip') === hack, '只在当前 ROM 槽名为 wofcn.zip 时预选专属核心')
ok(romScopedHackForName('wof') === null, '其他地区包名不命中 wofcn 的 ROM 专属核心')
ok(romScopedHackForName('wofj.zip') === null, '日版 wofj 仍使用原图形 ROM')
ok(romScopedHackForName('wofa.zip') === null, '亚洲版 wofa 仍使用原图形 ROM')
ok(romScopedHackForData('ZipName kof97\nDrvName kof97') === null, '普通 kof97 配置不被误判为 ROM 专属')

// 少一个指纹就不认 —— 指纹必须全中，宁可交回给覆盖率那套去猜
for (const missing of hack.fingerprint) {
  const partial = WOFCN_ZIP.map(([, , c]) => c).filter((c) => c !== missing)
  ok(matchArcadeHack(partial) === null, `少了指纹 0x${missing.toString(16)} 就不认（不会误判）`)
}
ok(matchArcadeHack([]) === null, '空包不认')

console.log('\n── 合成 ROM（derive）──')
/**
 * 合成用真包跑不了（仓库里不放 ROM），所以这里用字节标记验证 FBNeo 字库段顺序和 ROM 字节原样保留；
 * 目标变化时 dat CRC 必须从真包重算。
 */
const SIZE = 0x080000
const FONT_SIZE = 0x008000
const fill = (byte = 0) => new Uint8Array(SIZE).fill(byte)
const gfx5 = fill()
const gfx6 = fill()
const fillWords = (buffer, start, end, high, low) => {
  for (let i = start; i < end; i += 2) { buffer[i] = high; buffer[i + 1] = low }
}
fillWords(gfx5, 0x10000, 0x18000, 0x55, 0x5a)
fillWords(gfx5, 0x18000, 0x20000, 0x56, 0x5b)
fillWords(gfx6, 0x10000, 0x18000, 0x66, 0x6a)
fillWords(gfx6, 0x18000, 0x20000, 0x67, 0x6b)
const syntheticInputs = {
  'tk2_gfx5cn.rom': gfx5,
  'tk2_gfx6cn.rom': gfx6,
}
const experimentalPlan = hack.experimentalPlan
const experimentalDerive = experimentalPlan.derive
const derived = experimentalDerive.run(syntheticInputs)
ok(derived.length === 4, `独立字库有 4 条 CPS1 通道：${derived.map((d) => d.name).join(', ')}`)
const expected = [
  ['tk2h5_cjk_fbneo_v5_lane0.rom', 0x55, 0x5a],
  ['tk2h5_cjk_fbneo_v5_lane1.rom', 0x56, 0x5b],
  ['tk2h5_cjk_fbneo_v5_lane2.rom', 0x66, 0x6a],
  ['tk2h5_cjk_fbneo_v5_lane3.rom', 0x67, 0x6b],
]
for (const [index, [name, first, second]] of expected.entries()) {
  const d = derived[index].data
  ok(d.length === FONT_SIZE, `${name}: 长度是单个 CPS1 通道的 0x${FONT_SIZE.toString(16)}`)
  ok(d.every((b, i) => b === (i & 1 ? second : first)), `${name}: 按 FBNeo 左右半片组合顺序且保留字节`)
}
// 合成不能改调用方的 buffer。
const again = experimentalDerive.run(syntheticInputs)
ok(crc32(again[0].data) === crc32(derived[0].data), '合成是纯函数，同样输入同样输出')
ok(gfx5[0x10000] === 0x55 && gfx5[0x18000] === 0x56 && gfx6[0x18000] === 0x67, '合成没有改调用方的字库原始数据')

console.log('\n── 内置 dat 和真包 + 合成产物对得上 ──')
const rows = romLines(experimentalPlan.romData)
const byName = new Map(WOFCN_ZIP.map(([name, size, crc]) => [name, { size, crc }]))
const derivedNames = new Set(derived.map((d) => d.name))
const deriveInputs = new Set(experimentalDerive.inputs)
ok(rows.length > 0, `dat 里解析出 ${rows.length} 条 ROM 行`)
const tileRows = rows.filter((r) => r.flags.includes('CPS1_TILES'))
const extraTileRows = rows.filter((r) => r.flags.includes('CPS1_EXTRA_TILES_400000'))
const tileNames = tileRows.map((r) => r.name)
const extraTileNames = extraTileRows.map((r) => r.name)
ok(
  tileNames.length === 8 && JSON.stringify(extraTileNames) === JSON.stringify(experimentalDerive.outputs),
  'dat 保留八块基础图形 ROM，并将四条字库通道标记为 FBNeo 扩展图形',
)
const rowNameIndex = new Map(rows.map((r, i) => [r.name, i]))
const firstQsound = rowNameIndex.get('tk2_q1.rom')
const lastQsound = rowNameIndex.get('tk2_q4.rom')
const firstExtraTile = rowNameIndex.get(experimentalDerive.outputs[0])
const lastExtraTile = rowNameIndex.get(experimentalDerive.outputs.at(-1))
ok(
  firstExtraTile === lastQsound + 1 && lastExtraTile === firstExtraTile + 3 && firstExtraTile > firstQsound,
  '四条扩展图形 ROM 紧跟 QSound，符合 FBNeo loader 的读取顺序',
)
ok(
  rows.slice(firstExtraTile, lastExtraTile + 1).every((r) => r.flags.includes('CPS1_EXTRA_TILES_400000')),
  '扩展图形四通道连续，避免 loader 把 Z80 或 QSound 行当作字库',
)
const expectedLaneCrcs = [0x38d273a2, 0xedb8cfbb, 0x9c2ada91, 0x2a48eb5a]
const laneRows = rows.filter((r) => experimentalDerive.outputs.includes(r.name))
ok(
  laneRows.length === 4 && laneRows.every((r, i) => r.size === FONT_SIZE && r.crc === expectedLaneCrcs[i]),
  '四条通道按 FBNeo CpsLoadTiles 左右半片顺序组合，大小与真包 CRC 完全对应',
)

const missing = rows.filter((r) => !byName.has(r.name) && !derivedNames.has(r.name))
ok(missing.length === 0, `dat 里的每个文件要么在真包里、要么是合成产物${missing.length ? '：缺 ' + missing.map((r) => r.name).join(', ') : ''}`)

const wrong = rows.filter((r) => byName.has(r.name) && (byName.get(r.name).crc !== r.crc || byName.get(r.name).size !== r.size))
ok(wrong.length === 0, `真包里那些的大小和 CRC 全部吻合${wrong.length ? '：' + wrong.map((r) => r.name).join(', ') : ''}`)

// FBNeo 的额外图形 loader 只需要每条 0x8000 字节通道，专用核心会把解码结果复制到两个剧情 tile 窗口。
const badSize = rows.filter((r) => derivedNames.has(r.name) && r.size !== FONT_SIZE)
ok(badSize.length === 0, `合成产物在 dat 里写的长度是 0x${FONT_SIZE.toString(16)}${badSize.length ? '：' + badSize.map((r) => r.name).join(', ') : ''}`)

// derive 的输入被合成产物取代了，dat 里不能再直接引用 —— 引用了就等于把补丁片
// 或者未打补丁的原图形装进去，中文一定不显示
const stillReferenced = rows.filter((r) => deriveInputs.has(r.name) && !derivedNames.has(r.name))
const replaced = new Set(deriveInputs)
ok(
  stillReferenced.length === 0 && rows.every((r) => !replaced.has(r.name)),
  `用于两处字库合成的原 ROM 都不会被 dat 再次直接装载${stillReferenced.length ? '：' + stillReferenced.map((r) => r.name).join(', ') : ''}`,
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
  const plan = h.romData ? { romData: h.romData, derive: h.derive } : h.experimentalPlan
  if (!plan) continue
  const dat = plan.romData
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
  if (plan.derive) {
    const outNames = new Set(plan.derive.run(Object.fromEntries(plan.derive.inputs.map((k) => [k, fill(0)]))).map((d) => d.name))
    const names = new Set(romLines(dat).map((r) => r.name))
    ok([...outNames].every((x) => names.has(x)), `${h.zipName}: 每个合成产物 dat 里都引用了（${[...outNames].join(', ')}）`)
  }
}

/* ---------------- 入库的包也必须跑合成 ---------------- */
{
  console.log('\n── 合成这一步两条路都要接上 ──')
  const { readFileSync } = await import('node:fs')
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  /*
    病史：合成（derive）以前**只有「玩本地 ROM」那条路接了**。入库的游戏那条只做两件事 ——
    套 hack.romData、把包名改成 hack.zipName —— 而 dat 里引用的偏偏是合成产物
    （wofcn 的中文字库要先拆成四条扩展图形通道）。包里没有这些合成通道，
    核心按 dat 去找就是两条 missing，游戏必死，而后台界面还绿字写着「✓ 识别为已知改版包」。
  */
  const adapter = strip(readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8'))
  ok(
    /deriveArcadeHackBytes\(/.test(adapter),
    '⭐ prepareRemoteArcadeRom 这条路会跑合成（入库的改版包不能只套 dat 不合成）',
  )
  ok(
    !/new Blob\(\[data\], \{ type: 'application\/zip' \}\)/.test(adapter),
    '⭐ 不许再直接拿原始字节建 blob —— 必须过 arcadeBlobFrom，它才会合成',
  )
  const local = strip(readFileSync(new URL('../src/emulator/arcadeHack.ts', import.meta.url), 'utf8'))
  ok(/deriveArcadeHackBytes\(/.test(local), '本地那条路也走同一个函数（同一张表、同一套合成）')

  // outputs 必须和 run() 的实际产出、以及 romData 里引用的名字三者一致
  for (const hack of ARCADE_HACKS) {
    const plan = hack.derive ? { romData: hack.romData, derive: hack.derive } : hack.experimentalPlan
    if (!plan?.derive) continue
    const { inputs, outputs, run } = plan.derive
    ok(Array.isArray(outputs) && outputs.length > 0, `${hack.zipName}: derive 声明了 outputs`)
    // 拿够长的假数据跑一遍，只核名字
    const fake = {}
    for (const name of inputs) fake[name] = new Uint8Array(0x200000)
    const produced = run(fake).map((x) => x.name)
    ok(
      JSON.stringify(produced) === JSON.stringify(outputs),
      `${hack.zipName}: outputs 和 run() 实际产出一致（${produced.join(', ')}）`,
    )
    for (const name of outputs) {
      ok(plan.romData.includes(name), `${hack.zipName}: 实验 RomData 里引用了合成产物 ${name}`)
    }
  }
}

console.log(`\n全部通过 ✅  共 ${n} 项`)
