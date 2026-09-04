/**
 * 把一个已知改版包烘成「核心直接能跑」的包，并打出配套的 RomData。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────
 * 本地上传那条路由 emulator/arcadeHack.ts 在浏览器里现合成（见那边的注释）。
 * 但**入库的游戏**是从 R2 直接下载的，中途没有任何地方能做合成 —— 所以托管的包
 * 必须提前烘好：把合成 ROM 追加进去，然后把这里打出来的 dat 贴到后台
 * 「RomData（改版包）」那一栏。
 *
 * 合成产物的 CRC 会和 data/arcadeHacks.ts 里 dat 写的值对一遍，不一致直接报错 ——
 * 那说明 derive 的窗口、或者你手里的原包，和当初推导时用的不是一回事。
 *
 * ── 用法 ─────────────────────────────────────────────────────
 *   npm run hackpack -- ~/Downloads/wofcn.zip
 *   npm run hackpack -- 吞食天地2中文版.zip --out dist/wofcn.zip --dat wofcn.dat
 *
 *   --out <文件>   写出的包，默认 <ZipName>.zip 放在输入文件旁边
 *   --dat <文件>   把 RomData 也写到文件，默认只打到标准输出
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ARCADE_HACKS, matchArcadeHack } from '../src/data/arcadeHacks.ts'
import { isZip, listZipEntries, extractZipEntry, appendZipEntries, crc32 } from '../src/lib/unzip.ts'

const argv = process.argv.slice(2)
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const input = argv.find((a) => !a.startsWith('--') && !argv[argv.indexOf(a) - 1]?.startsWith('--'))

if (!input) {
  console.error('用法: npm run hackpack -- <包.zip> [--out x.zip] [--dat x.dat]')
  console.error(`已知改版包：${ARCADE_HACKS.map((h) => h.zipName).join(', ')}`)
  process.exit(1)
}

const raw = readFileSync(input)
const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
if (!isZip(buf)) {
  console.error(`${input} 不是 zip`)
  process.exit(1)
}

const entries = listZipEntries(buf)
if (!entries.length) {
  console.error(`${input} 是空包或者已损坏（中央目录读不出来）`)
  process.exit(1)
}

const hack = matchArcadeHack(entries.map((e) => e.crc32))
if (!hack) {
  console.error(`认不出这个包（${entries.length} 个成员）。指纹表在 src/data/arcadeHacks.ts。`)
  console.error('原版包不需要烘 —— 核心靠包名就能认，直接改名即可。')
  process.exit(1)
}
console.log(`认出来了：${hack.title}（${hack.zipName}，借 ${hack.driver} 驱动跑）`)
if (hack.note) console.log(`  ${hack.note}`)

let out = new Uint8Array(buf)
if (hack.derive) {
  const inputs = {}
  for (const name of hack.derive.inputs) {
    const e = entries.find((x) => x.name === name) ?? entries.find((x) => x.name.split('/').pop() === name)
    if (!e) {
      console.error(`合成需要的 ${name} 不在包里`)
      process.exit(1)
    }
    inputs[name] = await extractZipEntry(buf, e)
  }
  const derived = hack.derive.run(inputs)

  // dat 里写的 CRC 就是当初拿真包实算出来的，这里必须一致
  const datCrc = new Map(
    hack.romData
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter((t) => t.length >= 3 && /^0x/i.test(t[1]) && /^0x/i.test(t[2]))
      .map((t) => [t[0], Number(t[2]) >>> 0]),
  )
  let bad = 0
  for (const d of derived) {
    const got = crc32(d.data)
    const want = datCrc.get(d.name)
    const mark = want === undefined ? '?' : got === want ? '✅' : '❌'
    console.log(`  合成 ${d.name}  ${d.data.length} 字节  crc=${got.toString(16).padStart(8, '0')} ${mark}` +
      (want !== undefined && got !== want ? `  dat 写的是 ${want.toString(16).padStart(8, '0')}` : ''))
    if (want !== undefined && got !== want) bad++
  }
  if (bad) {
    console.error('\n合成产物的 CRC 和 dat 不一致 —— 要么你的原包和推导时用的不是同一份，')
    console.error('要么 derive 的窗口被改过。别用这个包，先回去核对 src/data/arcadeHacks.ts。')
    process.exit(1)
  }
  out = appendZipEntries(buf, derived)
}

const outPath = flag('out') ?? join(dirname(input), `${hack.zipName}.zip`)
writeFileSync(outPath, out)
console.log(`\n包已写出：${outPath}（${out.length} 字节，原包 ${raw.length}）`)
if (basename(outPath) !== `${hack.zipName}.zip`) {
  console.log(`⚠️  核心靠包名认游戏，上传 / 入库时这个文件必须叫 ${hack.zipName}.zip`)
}

if (hack.romData) {
  const datPath = flag('dat')
  if (datPath) {
    writeFileSync(datPath, hack.romData)
    console.log(`RomData 已写出：${datPath} —— 贴到后台「RomData（改版包）」那一栏`)
  } else {
    console.log('\n────── RomData（贴到后台「RomData（改版包）」）──────')
    console.log(hack.romData)
  }
} else {
  console.log('\n这个条目还没有可用的加载方案（romData 为空），烘出来的包也跑不了。')
}
