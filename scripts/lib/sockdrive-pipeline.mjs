import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from 'node:zlib'

// 官方 CLI 2.0.10 会按原始镜像字节数选择内置磁盘描述，多一个字节或少一个字节都会拒绝转换。
export const SOCKDRIVE_DISK_TEMPLATES = Object.freeze([
  Object.freeze({ id: 'fat16-256mb', label: 'FAT16-256MB', bytes: 252_370_944 }),
  Object.freeze({ id: 'fat32-2gb', label: 'FAT32-2GB', bytes: 2_147_483_648 }),
])
export const SOCKDRIVE_FILESYSTEM_OVERHEAD_BYTES = 16 * 1024 ** 2

export function parseSockdriveSize(value) {
  const match = /^([1-9]\d*)([KMG])$/i.exec(String(value || '').trim())
  if (!match) throw new Error('Sockdrive 空闲空间请写成 128M 这类正数容量')
  const multiplier = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[2].toUpperCase()]
  const bytes = Number(match[1]) * multiplier
  if (!Number.isSafeInteger(bytes)) throw new Error('Sockdrive 空闲空间超过安全整数范围')
  return bytes
}

/**
 * sockify 目前不是任意尺寸切块器，只认识仓库内置的两份磁盘布局。这里在制盘前选中精确模板，
 * 并留出分区表、FAT 和目录项余量，避免花几分钟生成镜像后才被官方 CLI 拒绝。
 */
export function selectSockdriveDiskTemplate(sourceBytes, freeSpace) {
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0) throw new Error('Sockdrive 源文件总大小无效')
  const requestedFreeBytes = parseSockdriveSize(freeSpace)
  const requiredBytes = sourceBytes + requestedFreeBytes + SOCKDRIVE_FILESYSTEM_OVERHEAD_BYTES
  const template = SOCKDRIVE_DISK_TEMPLATES.find((candidate) => requiredBytes <= candidate.bytes)
  if (!template) {
    const sourceMiB = Math.ceil(sourceBytes / 1024 ** 2)
    const freeMiB = Math.ceil(requestedFreeBytes / 1024 ** 2)
    throw new Error(
      `解压后的游戏文件约 ${sourceMiB}MiB，加上 ${freeMiB}MiB 预留空间后超过官方 Sockdrive 最大 2GB 模板`,
    )
  }
  return { ...template, requestedFreeBytes, requiredBytes }
}

/**
 * 7z 解包发生在制作机本地，但上传包仍可能带绝对路径、盘符或 `..`。先检查清单再解包，
 * 否则一个坏包就能把工作目录外的同名文件覆盖掉。
 */
export function assertSafeArchiveEntry(name) {
  const value = String(name ?? '').replace(/\\/g, '/')
  // eslint-disable-next-line no-control-regex -- 归档文件名里的控制字符没有可移植语义。
  if (!value || value.startsWith('/') || /^[a-z]:/i.test(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`ZIP 含不安全路径：${JSON.stringify(name)}`)
  }
  if (value.split('/').some((part) => part === '..')) {
    throw new Error(`ZIP 含目录穿越路径：${JSON.stringify(name)}`)
  }
  return value
}

/** 解析 `7z l -slt`；第一段是归档自身信息，分隔线后才是成员。 */
export function archiveEntriesFrom7z(output, maxDeclaredBytes = 8 * 1024 ** 3) {
  const lines = String(output).replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex((line) => /^-{10,}$/.test(line.trim()))
  if (start < 0) throw new Error('无法解析 7z 文件清单')
  const details = lines.slice(start + 1).join('\n')
  // 不能等解包后才拦链接：归档可以先创建指向工作目录外的链接，再让后续成员沿它写出去。
  if (/^(?:Symbolic Link|Hard Link) = /im.test(details) || /^Attributes = .*\bL\b/im.test(details)) {
    throw new Error('ZIP 含符号链接或硬链接，拒绝解包')
  }
  const entries = []
  let declaredBytes = 0
  for (const line of lines.slice(start + 1)) {
    const match = /^Path = (.*)$/.exec(line)
    if (match) entries.push(assertSafeArchiveEntry(match[1]))
    const size = /^Size = (\d+)$/.exec(line)
    if (size) declaredBytes += Number(size[1])
  }
  if (!entries.length) throw new Error('ZIP 中没有文件')
  if (entries.length > 200_000) throw new Error('ZIP 成员超过 20 万个，拒绝在制作机解包')
  if (!Number.isSafeInteger(maxDeclaredBytes) || maxDeclaredBytes <= 0) throw new Error('ZIP 解压上限无效')
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxDeclaredBytes) {
    throw new Error(`ZIP 声明解压后超过 ${Math.floor(maxDeclaredBytes / 1024 ** 2)}MiB，拒绝在制作机解包`)
  }
  return entries
}

export function decodeSockdriveFile(bytes, encoding, name = 'Sockdrive 文件') {
  try {
    if (encoding === 'br') return brotliDecompressSync(bytes)
    if (encoding === 'gzip') return gunzipSync(bytes)
    if (encoding === 'identity') return Buffer.from(bytes)
  } catch (error) {
    throw new Error(`${name} 与压缩格式 ${encoding} 不一致：${error instanceof Error ? error.message : String(error)}`)
  }
  throw new Error(`不支持的 Sockdrive 压缩格式：${encoding}`)
}

export function encodeSockdriveFile(bytes, encoding) {
  if (encoding === 'br') return brotliCompressSync(bytes)
  if (encoding === 'gzip') return gzipSync(bytes)
  if (encoding === 'identity') return Buffer.from(bytes)
  throw new Error(`不支持的 Sockdrive 压缩格式：${encoding}`)
}

/**
 * 首次发布还没有真实游玩轨迹，因此先把 sockify 自带的保守清单复制成独立热点清单。
 * 这样线上绝不会请求一个 404 JSON；收集到真实轨迹后用新版本目录发布优化后的清单。
 */
export function ensureBaselinePreloadProfile(directory, encoding) {
  const metadataPath = `${directory}/sockdrive.metaj`
  const profilePath = `${directory}/preload_ranges.metaj`
  if (!existsSync(metadataPath)) throw new Error(`${directory} 缺少 sockdrive.metaj`)
  if (existsSync(profilePath)) return { created: false, ranges: null }

  let metadata
  try {
    metadata = JSON.parse(decodeSockdriveFile(readFileSync(metadataPath), encoding, 'sockdrive.metaj').toString('utf8'))
  } catch (error) {
    throw new Error(`无法生成基础热点清单：${error instanceof Error ? error.message : String(error)}`)
  }
  const ranges = metadata?.preload_ranges
  if (!Array.isArray(ranges)) throw new Error('sockdrive.metaj 缺少 preload_ranges 数组')
  const body = Buffer.from(JSON.stringify(ranges))
  writeFileSync(profilePath, encodeSockdriveFile(body, encoding))
  return { created: true, ranges }
}

export function shellQuote(value) {
  const text = String(value)
  return `'${text.replaceAll("'", `'\\''`)}'`
}
