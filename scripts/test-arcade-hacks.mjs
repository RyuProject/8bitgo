/**
 * 已知街机改版包（src/data/arcadeHacks.ts）的自检。
 *
 * 这里用一份真实的 wofcn.zip 成员指纹核对识别结果。
 * 中文字库的加载映射尚未验证，因此测试还守住一条底线：不能为它保留未经画面验证的
 * RomData 或图形合成方案，否则会把已确认乱码的补丁重新交给玩家。
 *
 * 用法：npm run test:arcade-hacks
 */
import assert from 'node:assert/strict'
import { ARCADE_HACKS, matchArcadeHack, romScopedHackForData, romScopedHackForName } from '../src/data/arcadeHacks.ts'
import { crc32, appendZipEntries, listZipEntries, extractZipEntry } from '../src/lib/unzip.ts'

/**
 * wofcn.zip 的真实成员表（name / 未压缩大小 / CRC-32），2026-09-04 从玩家给的包里读的。
 * 这就是 HBMAME 的 tk2h5「Tenchi wo Kurau II (Edition Chinese)」——
 * HBMAME 父驱动为 **wof** 的中文 Hack，不是 wofj，也不是 wofch 的残缺版（覆盖率那套曾经就是这么判错的，
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
ok(hack.driver === 'wof', `借 HBMAME tk2h5 的父驱动 wof（不是 wofj / wofch），实际 ${hack.driver}`)
ok(hack.romDataScope === 'rom', 'wofcn 保持 ROM 专属标记，可拦截游戏级旧 RomData')
ok(!hack.romData && !hack.derive, '未验证字库映射前不自动注入 RomData 或图形补丁')
ok(romScopedHackForData('ZipName wofcn\nDrvName wof') === hack, '即使没有加载方案仍能识别旧版 wofcn 专属配置')
ok(romScopedHackForName('wofcn.zip') === hack, '只在当前 ROM 槽名为 wofcn.zip 时识别专属设置范围')
ok(romScopedHackForName('wof') === null, '其他地区包名不命中 wofcn 的 ROM 专属核心')
ok(romScopedHackForData('ZipName kof97\nDrvName kof97') === null, '普通 kof97 配置不被误判为 ROM 专属')

// 少一个指纹就不认 —— 指纹必须全中，宁可交回给覆盖率那套去猜
for (const missing of hack.fingerprint) {
  const partial = WOFCN_ZIP.map(([, , c]) => c).filter((c) => c !== missing)
  ok(matchArcadeHack(partial) === null, `少了指纹 0x${missing.toString(16)} 就不认（不会误判）`)
}
ok(matchArcadeHack([]) === null, '空包不认')

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
    const outNames = new Set(h.derive.run(Object.fromEntries(h.derive.inputs.map((k) => [k, new Uint8Array(0x200000)]))).map((d) => d.name))
    const names = new Set(romLines(dat).map((r) => r.name))
    ok([...outNames].every((x) => names.has(x)), `${h.zipName}: 每个合成产物 dat 里都引用了（${[...outNames].join(', ')}）`)
  }
}

/* ---------------- 合成加载方案两条路径都必须接通 ---------------- */
{
  console.log('\n── 改版包加载路径守卫 ──')
  const { readFileSync } = await import('node:fs')
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  const adapter = strip(readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8'))
  ok(
    /deriveArcadeHackBytes\(/.test(adapter),
    '远程 ROM 的改版合成仍走统一处理函数',
  )
  ok(
    !/new Blob\(\[data\], \{ type: 'application\/zip' \}\)/.test(adapter),
    '⭐ 不许再直接拿原始字节建 blob —— 必须过 arcadeBlobFrom，它才会合成',
  )
  const local = strip(readFileSync(new URL('../src/emulator/arcadeHack.ts', import.meta.url), 'utf8'))
  ok(/deriveArcadeHackBytes\(/.test(local), '本地 ROM 的改版合成也走同一个函数')

  ok(
    /configuredScopedHackMatches\s*&&\s*configuredScopedHack\.romData\s*\?\s*configuredRomData\s*:\s*''/.test(adapter),
    '无已验证 RomData 的 ROM 专属改版不会重新注入历史错误清单',
  )
  ok(
    /selectedScopedHack\?\.romData\s*&&\s*!isFbneoCore\(core\)/.test(adapter),
    '没有已验证 RomData 时不会仅凭包名把游戏强切到 FBNeo',
  )

  const player = strip(readFileSync(new URL('../src/emulator/EmulatorPlayer.tsx', import.meta.url), 'utf8'))
  ok(
    /if\s*\(matched\?\.hack\)\s*\{\s*setError\(fmt\(t\.player\.arcadeHackNoPlan/.test(player),
    '本地玩家上传识别到但没有加载方案的改版包时会提示并停止开局',
  )
  ok(
    /prepared\.hack\?\.romDataScope === 'rom' && !prepared\.hack\.romData[\s\S]{0,220}failLoad\(fmt\(getT\(\)\.player\.arcadeHackNoPlan[\s\S]{0,100}, 'config'\)/.test(adapter),
    '远端 wofcn 也会在没有验证过的字库方案时明确停止，不误送基础 wof 驱动',
  )

  const localPage = strip(readFileSync(new URL('../src/pages/PlayLocalPage.tsx', import.meta.url), 'utf8'))
  ok(
    !/ZipName\s+wofcn[\s\S]{0,100}DrvName\s+wofj/.test(localPage),
    '本地试玩页不再把未经验证的 wofcn → wofj 当成可用示例',
  )
  ok(/wofcn[\s\S]{0,80}尚未验证/.test(localPage), '本地试玩页明确提示 wofcn 字库方案尚未验证')

  const generator = readFileSync(new URL('../scripts/make-romdata.mjs', import.meta.url), 'utf8')
  ok(!/wofcn\.zip\s+--drv\s+wofj/.test(generator), 'RomData 生成器不再指导 wofcn 借用错误的 wofj 驱动')
  const mapper = readFileSync(new URL('../server/src/mappers.js', import.meta.url), 'utf8')
  ok(!/DrvName（借用的驱动，如 wofj）/.test(mapper), '后台校验错误不再建议错误的 wofj 驱动')

  // outputs 必须和 run() 的实际产出、以及 romData 里引用的名字三者一致
  for (const hack of ARCADE_HACKS) {
    if (!hack.derive) continue
    const { inputs, outputs, run } = hack.derive
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
      ok(hack.romData.includes(name), `${hack.zipName}: romData 里引用了合成产物 ${name}`)
    }
  }
}

console.log(`\n全部通过 ✅  共 ${n} 项`)
