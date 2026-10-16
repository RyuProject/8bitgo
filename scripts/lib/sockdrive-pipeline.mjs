import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from 'node:zlib'

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
export function archiveEntriesFrom7z(output) {
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
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes > 8 * 1024 ** 3) {
    throw new Error('ZIP 声明解压后超过 8GB，拒绝在制作机解包')
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
