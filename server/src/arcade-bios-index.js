/**
 * 读 `public/arcade-romsets.bin` 里的「romset 短名 → 需要哪个 BIOS 系统包」。
 *
 * ## 为什么服务端也要读一次这个文件
 *
 * 浏览器里那份（src/lib/arcadeRomset.ts）是给**识别**用的：拿包里的 CRC 反查是哪个 romset，
 * 所以要读完整的索引（8721 个 romset、12 万条 CRC，600 KB）。
 * 服务端做**回填**时不需要那么多 —— 存量游戏已经按 romset 短名命名过了，
 * 只要「名字 → BIOS」这一张表，也就是索引最前面那段名字表，CRC 那部分一个字节都不用解。
 *
 * 格式定义在 scripts/build-arcade-romsets.mjs，两边必须一起改：
 *   0..4    魔数 '8BRS'
 *   4       版本号（当前 1）
 *   8       romset 条数
 *   12      名字表字节数
 *   16      (CRC, romset) 对数
 *   20..    名字表，每行 `短名\t父集\tBIOS`（tab 分隔，字段可能为空）
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @param {string} indexPath public/arcade-romsets.bin 的绝对路径
 * @returns {{ byName: Map<string, string>, known: Set<string>, setCount: number }}
 *   byName 只收**需要 BIOS** 的 romset（bios 字段为空的表示它自带全部 ROM，不进表）；
 *   known 是索引里全部 romset 短名
 */
export function loadBiosByName(indexPath) {
  const buf = readFileSync(indexPath)
  if (buf.length < 20) throw new Error(`${indexPath} 太小，不是索引文件`)
  if (buf[0] !== 0x38 || buf[1] !== 0x42 || buf[2] !== 0x52 || buf[3] !== 0x53) {
    throw new Error(`${indexPath} 魔数不对（应为 8BRS），确认文件没被换掉`)
  }
  if (buf[4] !== 1) throw new Error(`不认识的索引格式版本 ${buf[4]}：先更新本文件与 build-arcade-romsets.mjs`)

  const setCount = buf.readUInt32LE(8)
  const namesLen = buf.readUInt32LE(12)
  const lines = buf.subarray(20, 20 + namesLen).toString('utf8').split('\n')
  // 条数对不上说明格式变了（或文件截断）—— 宁可在这里炸，也别拿半张表去回填
  if (lines.length !== setCount) throw new Error(`索引里名字表条数对不上（${lines.length} != ${setCount}）`)

  const byName = new Map()
  const known = new Set()
  for (const line of lines) {
    const [name, , bios] = line.split('\t')
    const short = name?.trim().toLowerCase()
    if (!short) continue
    known.add(short)
    if (bios) byName.set(short, bios.trim().toLowerCase())
  }
  return { byName, known, setCount }
}

/** undefined = 还没加载；null = 找不到索引（这时一律不下结论，沿用平台 BIOS） */
let romsetLookup

/**
 * 进程内只读一次的索引。开发时在仓库 public/，线上部署目录同样带着 public/；
 * 只部署了构建产物时退到 dist/client/。都找不到就返回 null。
 */
export function defaultRomsetLookup() {
  if (romsetLookup !== undefined) return romsetLookup
  romsetLookup = null
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const candidates = [
    process.env.ARCADE_ROMSETS_INDEX,
    path.join(root, 'public', 'arcade-romsets.bin'),
    path.join(root, 'dist', 'client', 'arcade-romsets.bin'),
  ].filter(Boolean)
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue
      const { byName, known } = loadBiosByName(file)
      romsetLookup = { biosByName: byName, known }
      break
    } catch (error) {
      console.warn(`[arcade] 读取 romset 索引失败：${file}`, error?.message ?? error)
    }
  }
  return romsetLookup
}

/**
 * 这些 ROM 对象 key 是否**全部**是已知、且不需要任何 BIOS 的 romset。
 *
 * 用途：平台级 BIOS 那格通常是 neogeo.zip，而 CPS / 老板子游戏根本用不上 ——
 * 冷启动实测它排在核心解压之后再占 1.6 秒。认不出的名字（汉化包、错名包）一律返回 false，
 * 沿用以前「平台 BIOS 照下」的保守行为。
 *
 * @param {string[]} keys
 * @param {{ biosByName: Map<string, string>, known: Set<string> } | null} lookup
 */
export function romsetsNeedNoBios(keys, lookup = defaultRomsetLookup()) {
  if (!lookup || !keys.length) return false
  return keys.every((key) => {
    const name = romsetNameFromKey(key)
    return Boolean(name) && lookup.known.has(name) && !lookup.biosByName.has(name)
  })
}

/**
 * 对象 key → romset 短名。`roms/arcade/kof97.zip.8bg` → `kof97`
 *
 * 两种后缀都要剥：8BG 容器（新上传的单文件 ROM 会被包成 `<原 key>.8bg`）和 `.zip`、
 * 以及 key 上可能带的 `?romv=` 缓存戳。
 */
export function romsetNameFromKey(key) {
  const file = String(key ?? '').split(/[?#]/)[0].split('/').pop() ?? ''
  return file.replace(/\.8bg$/i, '').replace(/\.zip$/i, '').trim().toLowerCase()
}
