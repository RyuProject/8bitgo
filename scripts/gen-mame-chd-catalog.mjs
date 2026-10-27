#!/usr/bin/env node
/**
 * 从 MAME 官方源码生成“ROM CRC → 必需 CHD”的紧凑目录。
 *
 * MAME 的 CHD 依赖写在各驱动的 ROM_START / DISK_IMAGE 宏里。过去后台只维护几份
 * 人工白名单，导致一个完全正确的 bm1stmix.zip 也不会出现 CHD 上传位。这里把这份
 * 权威信息变成浏览器和服务端共用的静态目录：管理员上传 ZIP 后只读中央目录就能判断。
 *
 * 输出刻意不记录 CHD 的压缩体积与 Data SHA-1：它们会随 chdman 压缩版本变化；上传时
 * 从 v5 文件头读取并保存。MAME 驱动锁定的 CHD SHA-1、文件名和 romset 才是身份。
 *
 * 用法：
 *   node scripts/gen-mame-chd-catalog.mjs /path/to/mame [--revision <git-sha>] [--sources src/mame/a.cpp,...]
 *
 * `build-mame-current-core.mjs` 在拉取同一份官方源码后会自动调用本脚本。不要手改
 * shared/mame-chd-catalog.js / .d.ts；核心版本变化时重跑生成器即可。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = process.argv[2]
if (!root || root.startsWith('-') || !existsSync(join(root, 'src/mame'))) {
  console.error('用法：node scripts/gen-mame-chd-catalog.mjs <MAME 源码根目录> [--revision <git-sha>]')
  process.exit(2)
}

const revisionAt = process.argv.indexOf('--revision')
let revision = revisionAt >= 0 ? String(process.argv[revisionAt + 1] ?? '').trim() : ''
if (!revision) {
  try { revision = execFileSync('git', ['-C', root, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim() } catch { revision = 'unknown' }
}
const sourcesAt = process.argv.indexOf('--sources')
const selectedSources = new Set((sourcesAt >= 0 ? String(process.argv[sourcesAt + 1] ?? '') : '')
  .split(',')
  .map((value) => value.trim().replace(/^src\/mame\//, ''))
  .filter(Boolean))

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(repo, 'shared/mame-chd-catalog.js')
const declaration = join(repo, 'shared/mame-chd-catalog.d.ts')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (entry.isFile() && entry.name.endsWith('.cpp')) out.push(path)
  }
  return out
}

/** 只剥注释，保留宏参数；否则注释里的备用 DISK_IMAGE 会被误收录。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '')
}

function parseSource(path) {
  const source = stripComments(readFileSync(path, 'utf8'))
  const rows = []
  for (const match of source.matchAll(/\bROM_START\(\s*([a-z0-9_]+)\s*\)([\s\S]*?)\bROM_END\b/gi)) {
    const romset = match[1].toLowerCase()
    const body = match[2]
    const files = new Map()
    let conflict = false
    // LOAD 宏的变体非常多；CRC 是所有可校验 ROM 共有的、且在宏开头 500 字节内。
    for (const rom of body.matchAll(/\bROM_[A-Z0-9_]*LOAD[A-Z0-9_]*\s*\(\s*"([^"]+)"[\s\S]{0,500}?\bCRC\(\s*([0-9a-f]{8})\s*\)/gi)) {
      const name = rom[1].toLowerCase()
      const crc = rom[2].toLowerCase()
      const previous = files.get(name)
      if (previous && previous !== crc) conflict = true
      files.set(name, crc)
    }
    if (conflict || !files.size) continue

    const disks = []
    for (const disk of body.matchAll(/\bDISK_IMAGE(?:_READONLY)?\s*\(\s*"([^"]+)"[\s\S]{0,500}?\bSHA1\(\s*([0-9a-f]{40})\s*\)/gi)) {
      disks.push([disk[1].toLowerCase(), disk[2].toLowerCase()])
    }
    if (!disks.length) continue
    const uniqueDisks = new Map(disks)
    rows.push({
      r: romset,
      d: [...uniqueDisks].sort((a, b) => a[0].localeCompare(b[0])),
      f: [...files].sort((a, b) => a[0].localeCompare(b[0])).map(([name, crc]) => `${name}:${crc}`).join(' '),
      s: relative(join(root, 'src/mame'), path).replace(/\\/g, '/'),
    })
  }
  return rows
}

const byRomset = new Map()
for (const path of walk(join(root, 'src/mame'))) {
  const sourcePath = relative(join(root, 'src/mame'), path).replace(/\\/g, '/')
  // 裁剪 mame-current 时，目录也必须跟着裁剪；否则后台会给一个核心根本没编进的驱动显示 CHD 上传位。
  if (selectedSources.size && !selectedSources.has(sourcePath)) continue
  for (const row of parseSource(path)) {
    // 同短名多处定义不是可安全自动识别的情形；跳过而不随便挑一个。
    if (byRomset.has(row.r)) byRomset.set(row.r, null)
    else byRomset.set(row.r, row)
  }
}
const rows = [...byRomset.values()].filter(Boolean).sort((a, b) => a.r.localeCompare(b.r))

const header = `/**\n * 自动生成：node scripts/gen-mame-chd-catalog.mjs <mame-source>。\n * MAME 源码版本：${revision}；共 ${rows.length} 个带 CHD 的可识别 romset。\n * 只含 MAME 驱动公开的文件名/CRC/CHD SHA-1，不含游戏内容。\n */\n`
const js = `${header}export const MAME_CHD_CATALOG_REVISION = ${JSON.stringify(revision)}\n\nexport const MAME_CHD_CATALOG = Object.freeze(${JSON.stringify(rows)})\n\nexport function mameChdProfileForRomset(romset) {\n  const id = String(romset ?? '').trim().toLowerCase()\n  return MAME_CHD_CATALOG.find((row) => row.r === id) ?? null\n}\n\n/** MAME 驱动锁定的是 CHD SHA-1；Data SHA-1/压缩体积在上传时从头部读取。 */\nexport function knownMameChdDiskExpectation(disk) {\n  if (!disk || typeof disk !== 'object') return null\n  const profile = mameChdProfileForRomset(disk.romset)\n  if (!profile) return null\n  const name = String(disk.name ?? '').trim().toLowerCase()\n  const sha1 = String(disk.chdSha1 ?? '').trim().toLowerCase()\n  return profile.d.find(([candidateName, candidateSha1]) => candidateName === name && candidateSha1 === sha1) ?? null\n}\n`
const dts = `${header}export interface MameChdCatalogRow {\n  /** MAME machine short name */\n  r: string\n  /** [required file name without .chd, CHD SHA-1 required by MAME] */\n  d: readonly (readonly [string, string])[]\n  /** Space separated name:crc32 ROM fingerprint */\n  f: string\n  /** Source path for diagnostics */\n  s: string\n}\nexport const MAME_CHD_CATALOG_REVISION: string\nexport const MAME_CHD_CATALOG: readonly MameChdCatalogRow[]\nexport function mameChdProfileForRomset(romset: unknown): MameChdCatalogRow | null\nexport function knownMameChdDiskExpectation(disk: unknown): readonly [string, string] | null\n`
writeFileSync(target, js)
writeFileSync(declaration, dts)
console.log(`写入 ${target}、${declaration}：${rows.length} 个 CHD romset，MAME ${revision}`)
