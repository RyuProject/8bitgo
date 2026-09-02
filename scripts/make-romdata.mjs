#!/usr/bin/env node
/**
 * 从一个街机改版包生成 FBNeo RomData（.dat）骨架。
 *
 * ── 这东西解决什么 ───────────────────────────────────────────
 * 街机核心靠压缩包名认游戏（AGENTS.md §2.8）。汉化版、修改版这类包不在 FBNeo 的
 * 驱动表里，叫什么名字都是「Romset is unknown」。RomData 是 FBNeo 给这种包留的口子：
 * 一份 .dat 写明 ZipName（包名）、DrvName（借哪个驱动跑）和**整份** ROM 清单，
 * 核心就会把该驱动的包名寄生成 ZipName，并整个改用 dat 里的清单。
 *
 * 手写这份清单很难：每一行都要 romset 内真实的文件名、长度和 CRC-32，
 * 而改版包里恰恰有几个 ROM 和原版对不上（否则也不用 RomData 了）。
 * 好在这三样**就在 zip 的中央目录里**，不解压就能读 —— 和
 * scripts/build-arcade-romsets.mjs 认 romset 用的是同一份数据。
 *
 * ── 类型（第四列）为什么必须写 ───────────────────────────────
 * FBNeo 独立版的 romdata.cpp 在类型留空时会用 RDSetRomsType() 按驱动名 + 长度猜，
 * 但 **libretro 版没有这个函数**（对照 libretro/FBNeo 的 src/burner/libretro/romdata.cpp），
 * 类型为 0 的行会被直接丢掉。所以这里宁可对照基础驱动的源码把类型抄准：
 * 给 --fbneo 就按 CRC、再按文件名去 BurnRomInfo 表里对，对上的原样继承；
 * 对不上的（也就是改版包换掉的那几个）留成 TODO_TYPE，由人来定 —— 那几行本来
 * 就只有人知道它替换的是哪一块。
 *
 * ── 用法 ─────────────────────────────────────────────────────
 *   npm run romdata -- wofcn.zip --drv wofj --name "Warriors of Fate (Chinese)"
 *   npm run romdata -- wofcn.zip --drv wofj --fbneo /tmp/fbn/src/burn/drv
 *
 *   --drv <短名>     基础驱动，必填（如 wofj）
 *   --zip-name <名>  romset 包名，默认取 zip 的文件名（wofcn.zip → wofcn）
 *   --name "<全名>"  dat 里的 FullName，默认用包名
 *   --fbneo <目录>   FBNeo 的 src/burn/drv，给了就自动填类型（强烈建议给）
 *   --out <文件>     写到文件，默认打到标准输出
 *
 *   FBNeo 源码怎么取，见 scripts/build-arcade-romsets.mjs 头注释里的 sparse-checkout。
 *
 * 生成的文本直接贴进后台「RomData（改版包）」那一栏即可。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/* ---------------- 命令行 ---------------- */

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const zipPath = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true)

if (!zipPath || !flag('drv')) {
  console.error('用法: node scripts/make-romdata.mjs <包.zip> --drv <基础驱动短名> [--zip-name x] [--name "全名"] [--fbneo <FBNeo>/src/burn/drv] [--out x.dat]')
  console.error('（详见本文件头注释）')
  process.exit(1)
}

const drvName = flag('drv')
const zipName = flag('zip-name') || basename(zipPath).replace(/\.[^.]*$/, '')
const fullName = flag('name') || zipName

/* ---------------- 读 zip 中央目录 ---------------- */

/**
 * 只读中央目录，不解压。
 * 从尾部倒着找 EOCD（0x06054b50），拿到目录偏移后逐条读文件名 / CRC / 未压缩长度。
 * 不处理 zip64：街机包都是几 MB 级别，用不上。
 */
function listZipEntries(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是 zip，或者中央目录被截断了')

  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const out = []
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('中央目录条目头对不上')
    const crc = dv.getUint32(p + 16, true)
    const size = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const name = Buffer.from(buf.buffer, buf.byteOffset + p + 46, nameLen).toString('latin1')
    // 目录条目（以 / 结尾）不是 ROM
    if (!name.endsWith('/')) out.push({ name, size, crc })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/* ---------------- 从 FBNeo 源码抄基础驱动的 ROM 表 ---------------- */

const DESC = /static\s+struct\s+BurnRomInfo\s+(\w+?)RomDesc\s*\[\s*\]\s*=\s*\{([\s\S]*?)\n\};/g
const DRV = /struct\s+BurnDriver\w*\s+BurnDrv\w+\s*=\s*\{([\s\S]*?)\n\};/g
const HEAD = /^\s*"((?:[^"\\]|\\.)*)"\s*,/
const ROMINFO = /\b(\w+)RomInfo\b/
// { "tk2j_23c.8f", 0x080000, 0x9b215a68, BRF_ESS | BRF_PRG | CPS1_68K_PROGRAM_NO_BYTESWAP },
const ROW = /\{\s*"([^"]+)"\s*,\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*([^}]+?)\s*\}/g

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(cpp|c|h)$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * 找出短名为 drv 的驱动用的那张 BurnRomInfo 表。
 *
 * ⚠️ 短名必须从 BurnDriver 的第一个字段取，不能拿数组名当短名 ——
 * CPS 的数组叫 WofjRomDesc，而 romset 叫 wofj，大小写都对不上
 * （和 build-arcade-romsets.mjs 踩的是同一个坑）。
 */
function loadDriverRoms(srcDir, drv) {
  for (const file of walk(srcDir)) {
    const text = readFileSync(file, 'utf8')
    if (!text.includes(`"${drv}"`)) continue

    // 先找到这个短名对应的 RomInfo 函数名
    let romInfoName = null
    DRV.lastIndex = 0
    let m
    while ((m = DRV.exec(text))) {
      const body = m[1]
      const head = HEAD.exec(body)
      if (!head || head[1] !== drv) continue
      const info = ROMINFO.exec(body)
      if (info) romInfoName = info[1]
      break
    }
    if (!romInfoName) continue

    // 再把同名的 RomDesc 表拆出来
    DESC.lastIndex = 0
    while ((m = DESC.exec(text))) {
      if (m[1] !== romInfoName) continue
      const rows = []
      ROW.lastIndex = 0
      let r
      while ((r = ROW.exec(m[2]))) {
        rows.push({
          name: r[1],
          size: Number(r[2]),
          crc: Number(r[3]),
          // 源码里写成 `BRF_GRA | CPS1_TILES`，dat 里空格分隔即可
          type: r[4].replace(/\s*\/\/.*$/, '').split('|').map((t) => t.trim()).filter(Boolean).join(' '),
        })
      }
      return { file, rows }
    }
  }
  return null
}

/* ---------------- 生成 ---------------- */

const entries = listZipEntries(readFileSync(zipPath))
if (entries.length === 0) {
  console.error(`✖ ${zipPath} 里一个文件都没有`)
  process.exit(1)
}

const srcDir = flag('fbneo')
let base = null
if (srcDir) {
  base = loadDriverRoms(srcDir, drvName)
  if (!base) {
    console.error(`✖ 在 ${srcDir} 里没找到驱动 ${drvName} 的 BurnRomInfo 表`)
    process.exit(1)
  }
}

const byCrc = new Map((base?.rows ?? []).map((r) => [r.crc, r]))
const byName = new Map((base?.rows ?? []).map((r) => [r.name.toLowerCase(), r]))

const hex = (n, w) => `0x${n.toString(16).padStart(w, '0')}`
const lines = []
let todo = 0

for (const e of entries) {
  // CRC 优先：改版包常把原版 ROM 改了名字，但内容没动
  const hit = byCrc.get(e.crc) ?? byName.get(e.name.toLowerCase())
  const type = hit ? hit.type : 'TODO_TYPE'
  if (!hit) todo++
  const note = hit
    ? hit.crc === e.crc
      ? ''
      : `   // 同名不同内容，原版 CRC ${hex(hit.crc, 8)}`
    : '   // ← 改版包换掉的 ROM：把 TODO_TYPE 换成它替换的那一块的类型'
  lines.push(`${e.name.padEnd(20)} ${hex(e.size, 6).padEnd(10)} ${hex(e.crc, 8)}   ${type}${note}`)
}

const missing = (base?.rows ?? []).filter(
  (r) => !entries.some((e) => e.crc === r.crc || e.name.toLowerCase() === r.name.toLowerCase()),
)

const dat = [
  `// ${fullName}`,
  `// 由 scripts/make-romdata.mjs 从 ${basename(zipPath)} 生成`,
  base ? `// 类型对照自 ${base.file}` : '// 没给 --fbneo，类型全部要手填',
  '',
  `ZipName    ${zipName}`,
  `DrvName    ${drvName}`,
  `FullName   ${fullName}`,
  '',
  ...lines,
  '',
].join('\n')

const out = flag('out')
if (out) {
  writeFileSync(out, dat)
  console.error(`✔ 已写入 ${out}`)
} else {
  process.stdout.write(dat)
}

/* ---------------- 提示 ---------------- */

if (todo > 0) {
  console.error(`\n⚠️  有 ${todo} 行是 TODO_TYPE —— 这些 ROM 在 ${drvName} 里找不到对应项，八成就是改版包换掉的那几个。`)
  console.error('   CPS1 常用类型：CPS1_68K_PROGRAM_NO_BYTESWAP（程序）、CPS1_TILES（图形）、')
  console.error('   CPS1_Z80_PROGRAM（音频 CPU）、CPS1_QSOUND_SAMPLES（QSound 采样）；')
  console.error('   前面还要按用途带上 BRF_ESS BRF_PRG / BRF_GRA / BRF_SND。')
}
if (missing.length > 0) {
  console.error(`\n⚠️  基础驱动 ${drvName} 里有 ${missing.length} 个 ROM 不在这个包里：`)
  for (const r of missing.slice(0, 12)) console.error(`     · ${r.name}  ${hex(r.size, 6)}  ${hex(r.crc, 8)}  ${r.type}`)
  if (missing.length > 12) console.error(`     · …还有 ${missing.length - 12} 个`)
  console.error('   BRF_OPT 的 PLD 缺了无所谓；缺程序 / 图形 / 声音则说明这个包不完整。')
}
