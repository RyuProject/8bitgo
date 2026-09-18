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
import { readFileSync } from 'node:fs'

/**
 * @param {string} indexPath public/arcade-romsets.bin 的绝对路径
 * @returns {{ byName: Map<string, string>, setCount: number }}
 *   byName 只收**需要 BIOS** 的 romset（bios 字段为空的表示它自带全部 ROM，不进表）
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
  for (const line of lines) {
    const [name, , bios] = line.split('\t')
    if (name && bios) byName.set(name.trim().toLowerCase(), bios.trim().toLowerCase())
  }
  return { byName, setCount }
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
