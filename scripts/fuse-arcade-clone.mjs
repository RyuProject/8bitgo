#!/usr/bin/env node
/**
 * 把一个依赖父集的街机克隆包，烘成浏览器 / FBNeo 可以单独读取的完整 ROM 包。
 *
 * 桌面模拟器通常会在同一目录继续找父集 ZIP；网页播放器只给核心一份 ROM，
 * 缺少继承的 M1 / V 等成员时，核心只能报 missing files。这个脚本不按文件名猜，
 * 而是读取 FBNeo 驱动表，逐项按「文件名、长度、CRC」从克隆包优先、父集次之取料，
 * 并重新输出一份只包含目标驱动所需成员的顶层 ZIP。
 *
 * 用法：
 *   npm run arcade:fuse -- <克隆包.zip> <父集.zip> \
 *     --driver kogplus --fbneo /path/to/FBNeo/src/burn/drv --out kogplus.zip
 *
 * 其中 --driver 必须是 FBNeo 的真实短名（不是父集名）。输出文件名也必须是
 * <driver>.zip；FBNeo 会用它选择驱动。脚本默认拒绝覆盖已有文件，传 --force
 * 才会覆盖，避免把原始 ROM 包误换掉。
 */
import { deflateRawSync } from 'node:zlib'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { appendZipEntries, crc32, extractZipEntry, listZipEntries } from '../src/lib/unzip.ts'

const argv = process.argv.slice(2)
const flags = new Map()
const positional = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (!arg.startsWith('--')) {
    positional.push(arg)
    continue
  }
  const name = arg.slice(2)
  if (name === 'force') flags.set(name, 'true')
  else flags.set(name, argv[++i] ?? '')
}

const [clonePath, parentPath] = positional
const driver = flags.get('driver')?.trim()
const sourceDir = flags.get('fbneo')?.trim()
if (!clonePath || !parentPath || !driver || !sourceDir) {
  console.error('用法: npm run arcade:fuse -- <克隆包.zip> <父集.zip> --driver <短名> --fbneo <FBNeo>/src/burn/drv [--out <完整包.zip>] [--force]')
  process.exit(1)
}

const output = resolve(flags.get('out') || join(dirname(clonePath), `${driver}.fbneo.zip`))
if (!flags.has('force') && existsSync(output)) {
  console.error(`拒绝覆盖已有文件：${output}\n请换 --out，或确认后显式加 --force。`)
  process.exit(1)
}
for (const input of [clonePath, parentPath]) {
  if (!existsSync(input)) {
    console.error(`找不到输入文件：${input}`)
    process.exit(1)
  }
}

/** 递归找 FBNeo 的驱动源码；只读 .c/.cpp/.h，避免误读构建产物。 */
function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.(?:c|cpp|h)$/i.test(entry)) out.push(full)
  }
  return out
}

/** 展开 ROM 表常用的宏，避免未来遇到 CPS / Neo Geo 公共组件时误判为缺件。 */
function expandRomMacros(text) {
  const defs = new Map()
  const define = /^#define\s+(\w+)\s*\\\n((?:.*\\\n)*.*)$/gm
  let match
  while ((match = define.exec(text))) {
    const body = match[2].replace(/\\\n/g, '\n')
    if (/\{\s*"[^"]+"\s*,\s*0x/.test(body)) defs.set(match[1], body)
  }
  if (!defs.size) return text
  return text.replace(new RegExp(`\\b(${[...defs.keys()].join('|')})\\b`, 'g'), (name) => defs.get(name) ?? name)
}

/** 从真实 BurnDriver 找到它引用的 BurnRomInfo 表；不把数组名误当驱动短名。 */
function loadDriverRows(dir, wanted) {
  const driverBlock = /struct\s+BurnDriver\w*\s+BurnDrv\w+\s*=\s*\{([\s\S]*?)\n\};/g
  const romInfo = /\b(\w+)RomInfo\b/
  const romTable = /static\s+struct\s+BurnRomInfo\s+(\w+?)RomDesc\s*\[\s*\]\s*=\s*\{([\s\S]*?)\n\};/g
  const row = /\{\s*"([^"]+)"\s*,\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*[^}]+?\}/g

  for (const file of sourceFiles(dir)) {
    const raw = readFileSync(file, 'utf8')
    if (!raw.includes(`"${wanted}"`)) continue
    const text = expandRomMacros(raw)
    let tableName = ''
    driverBlock.lastIndex = 0
    let block
    while ((block = driverBlock.exec(text))) {
      const name = /^\s*"((?:[^"\\]|\\.)*)"\s*,/m.exec(block[1])?.[1]
      if (name !== wanted) continue
      tableName = romInfo.exec(block[1])?.[1] ?? ''
      break
    }
    if (!tableName) continue

    romTable.lastIndex = 0
    let table
    while ((table = romTable.exec(text))) {
      if (table[1] !== tableName) continue
      const rows = []
      row.lastIndex = 0
      let item
      while ((item = row.exec(table[2]))) {
        rows.push({ name: item[1], size: Number(item[2]), crc: Number(item[3]) >>> 0 })
      }
      if (rows.length) return { file, rows }
    }
  }
  throw new Error(`在 ${dir} 里找不到 FBNeo 驱动 ${wanted} 的 ROM 表`)
}

function arrayBufferOf(path) {
  const file = readFileSync(path)
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
}

const cloneBuffer = arrayBufferOf(clonePath)
const parentBuffer = arrayBufferOf(parentPath)
const cloneEntries = listZipEntries(cloneBuffer)
const parentEntries = listZipEntries(parentBuffer)
if (!cloneEntries.length || !parentEntries.length) throw new Error('输入文件必须是包含 ROM 成员的有效 ZIP')

const manifest = loadDriverRows(sourceDir, driver)
const fileName = (entry) => entry.name.split('/').pop()?.toLowerCase() ?? ''
/**
 * 先选克隆包，才能保证改版 ROM 不会被父集同名成员覆盖；名字、长度、CRC 三者
 * 至少要精确匹配，之后才允许用相同 CRC 改名的成员兜底。
 */
function findMember(rows, need) {
  const exact = rows.find((entry) => fileName(entry) === need.name.toLowerCase() && entry.uncompressedSize === need.size && entry.crc32 === need.crc)
  return exact ?? rows.find((entry) => entry.uncompressedSize === need.size && entry.crc32 === need.crc)
}

const additions = []
let cloneCount = 0
let parentCount = 0
const missing = []
for (const need of manifest.rows) {
  const fromClone = findMember(cloneEntries, need)
  const entry = fromClone ?? findMember(parentEntries, need)
  const source = fromClone ? cloneBuffer : parentBuffer
  if (!entry) {
    missing.push(`${need.name} (${need.size} bytes, crc ${need.crc.toString(16).padStart(8, '0')})`)
    continue
  }
  const data = await extractZipEntry(source, entry, need.size)
  if (data.length !== need.size || crc32(data) !== need.crc) throw new Error(`解出的 ${need.name} 没有通过长度 / CRC 校验`)
  additions.push({ name: need.name, data })
  if (fromClone) cloneCount++
  else parentCount++
}
if (missing.length) {
  throw new Error(`目标驱动 ${driver} 还缺 ${missing.length} 个必需 ROM：\n${missing.map((name) => `  - ${name}`).join('\n')}`)
}

/** 空 ZIP 作为起点，复用项目已经验证过的 ZIP 中央目录写入逻辑。 */
const emptyZip = new Uint8Array(22)
new DataView(emptyZip.buffer).setUint32(0, 0x06054b50, true)

/*
 * appendZipEntries 适合网页运行期追加少量文件，固定 stored 以省 CPU；离线产物要传 R2，
 * 先把每个成员 deflate，避免完整克隆集平白膨胀几十 MB。把压缩数据重新喂给一个标准 ZIP
 * 写入器，成员名仍完全以驱动表为准。
 */
function makeDeflatedZip(entries) {
  const encoder = new TextEncoder()
  const rows = entries.map((entry) => ({
    ...entry,
    nameBytes: encoder.encode(entry.name),
    compressed: new Uint8Array(deflateRawSync(entry.data, { level: 9 })),
    crc: crc32(entry.data),
  }))
  const localLength = rows.reduce((sum, row) => sum + 30 + row.nameBytes.length + row.compressed.length, 0)
  const centralLength = rows.reduce((sum, row) => sum + 46 + row.nameBytes.length, 0)
  const out = new Uint8Array(localLength + centralLength + 22)
  const view = new DataView(out.buffer)
  const offsets = []
  let at = 0
  for (const row of rows) {
    offsets.push(at)
    view.setUint32(at, 0x04034b50, true)
    view.setUint16(at + 4, 20, true)
    view.setUint16(at + 6, 0x0800, true)
    view.setUint16(at + 8, 8, true)
    view.setUint16(at + 12, 0x0021, true)
    view.setUint32(at + 14, row.crc, true)
    view.setUint32(at + 18, row.compressed.length, true)
    view.setUint32(at + 22, row.data.length, true)
    view.setUint16(at + 26, row.nameBytes.length, true)
    out.set(row.nameBytes, at + 30)
    out.set(row.compressed, at + 30 + row.nameBytes.length)
    at += 30 + row.nameBytes.length + row.compressed.length
  }
  const centralOffset = at
  for (const [index, row] of rows.entries()) {
    view.setUint32(at, 0x02014b50, true)
    view.setUint16(at + 4, 20, true)
    view.setUint16(at + 6, 20, true)
    view.setUint16(at + 8, 0x0800, true)
    view.setUint16(at + 10, 8, true)
    view.setUint16(at + 14, 0x0021, true)
    view.setUint32(at + 16, row.crc, true)
    view.setUint32(at + 20, row.compressed.length, true)
    view.setUint32(at + 24, row.data.length, true)
    view.setUint16(at + 28, row.nameBytes.length, true)
    view.setUint32(at + 42, offsets[index], true)
    out.set(row.nameBytes, at + 46)
    at += 46 + row.nameBytes.length
  }
  view.setUint32(at, 0x06054b50, true)
  view.setUint16(at + 8, rows.length, true)
  view.setUint16(at + 10, rows.length, true)
  view.setUint32(at + 12, centralLength, true)
  view.setUint32(at + 16, centralOffset, true)
  return out
}

// 同时调用一次 appendZipEntries：空 ZIP 可读性是它的契约，未来改动时早发现不兼容。
const structuralCheck = appendZipEntries(emptyZip.buffer, [{ name: '.check', data: new Uint8Array(0) }])
if (listZipEntries(structuralCheck.buffer).length !== 1) throw new Error('ZIP 写入器自检失败')

const fused = makeDeflatedZip(additions)
const actual = listZipEntries(fused.buffer)
if (actual.length !== manifest.rows.length) throw new Error('融合后的 ZIP 成员数和驱动表不一致')
for (const need of manifest.rows) {
  const entry = actual.find((candidate) => candidate.name === need.name)
  if (!entry || entry.uncompressedSize !== need.size || entry.crc32 !== need.crc) {
    throw new Error(`融合后的 ${need.name} 未通过最终清单校验`)
  }
}

writeFileSync(output, fused)
console.log(`✓ 已写出：${output}`)
console.log(`  驱动：${driver}（${basename(manifest.file)}）`)
console.log(`  成员：${actual.length}；来自克隆包 ${cloneCount} 个，来自父集 ${parentCount} 个`)
console.log(`  大小：${(fused.length / 1024 / 1024).toFixed(2)} MiB；已用 deflate 压缩，成员都在 ZIP 根目录`)
console.log(`  直接交给 FBNeo 时文件名必须保持为 ${driver}.zip；本站后台会按完整指纹识别为该 romset。`)
