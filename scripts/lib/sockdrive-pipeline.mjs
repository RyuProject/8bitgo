import { createReadStream, createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
  createBrotliCompress,
  createGzip,
  gzipSync,
  gunzipSync,
} from 'node:zlib'

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

/**
 * Sockdrive 最终写进 VFAT。Linux 能解出的名字不代表 FAT/Windows 能无损保存：冒号、结尾空格、
 * CON/COM1 这类设备名会被 guestfs 拒绝或静默改名，而大小写冲突还可能让启动 EXE 被另一项覆盖。
 * 在几分钟制盘前按真正目标文件系统拦住，不能发布一张“文件数对、客体里却少文件”的磁盘。
 */
export function fatArchiveEntryKey(name) {
  const value = assertSafeArchiveEntry(name)
  const directory = value.endsWith('/')
  // ZIP 允许无意义的 `./` 段；去掉它后再比较，才能识别 `./GAME/A` 与 `game/a` 的 FAT 冲突。
  const clean = value.replace(/\/+$/, '').split('/').filter((part) => part !== '.').join('/')
  if (!clean) throw new Error(`ZIP 含空目录名：${JSON.stringify(name)}`)
  for (const part of clean.split('/')) {
    if (/[<>:"|?*]/.test(part) || /[. ]$/.test(part)) {
      throw new Error(`ZIP 文件名不能无损写入 FAT：${JSON.stringify(name)}`)
    }
    const stem = part.split('.', 1)[0]
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) {
      throw new Error(`ZIP 使用了 Windows 保留设备名：${JSON.stringify(name)}`)
    }
    if (Array.from(part).length > 255) throw new Error(`ZIP 文件名超过 FAT 单段上限：${JSON.stringify(name)}`)
  }
  return { value: directory ? `${clean}/` : clean, key: clean.normalize('NFC').toLowerCase() }
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
  const fatNames = new Map()
  let declaredBytes = 0
  for (const line of lines.slice(start + 1)) {
    const match = /^Path = (.*)$/.exec(line)
    if (match) {
      const entry = fatArchiveEntryKey(match[1])
      const previous = fatNames.get(entry.key)
      if (previous) {
        throw new Error(`ZIP 含 FAT 下会互相覆盖的文件名：${JSON.stringify(previous)} / ${JSON.stringify(entry.value)}`)
      }
      fatNames.set(entry.key, entry.value)
      entries.push(entry.value)
    }
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
 * 官方 sockify 的 `-b/-g` 会一次为所有分块启动外部压缩器；2GB 磁盘实测会瞬间出现四百多个
 * brotli 进程并吃光 4GB 制作机。让 sockify 只负责切块，再在这里用固定数量的流式任务压缩，
 * 既不把整块磁盘读进内存，也不会在负载高峰拖死站点服务。临时文件完成后才原子替换原文件，
 * 因而中断的任务不会留下“文件名正常、正文只有半截”的可发布分块。
 */
export async function compressSockdriveDirectory(
  directory,
  encoding,
  { concurrency = 2, brotliQuality = 9, onProgress } = {},
) {
  if (encoding === 'identity') return { files: 0, sourceBytes: 0, encodedBytes: 0 }
  if (!['br', 'gzip'].includes(encoding)) throw new Error(`不支持的 Sockdrive 压缩格式：${encoding}`)
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error('Sockdrive 压缩并发必须是 1～8 的整数')
  }
  if (!Number.isSafeInteger(brotliQuality) || brotliQuality < 1 || brotliQuality > 11) {
    throw new Error('Sockdrive Brotli 质量必须是 1～11 的整数')
  }

  const names = (await readdir(directory)).sort((a, b) => a.localeCompare(b, 'en'))
  const files = []
  for (const name of names) {
    const path = join(directory, name)
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`Sockdrive 发布目录只能包含普通文件：${path}`)
    files.push({ name, path, size: info.size })
  }
  if (!files.length) throw new Error('Sockdrive 发布目录没有可压缩文件')

  let cursor = 0
  let completed = 0
  let sourceBytes = 0
  let encodedBytes = 0
  let firstError = null
  const worker = async () => {
    while (!firstError) {
      const index = cursor++
      if (index >= files.length) return
      const file = files[index]
      const temporary = `${file.path}.compressing`
      const compressor = encoding === 'br'
        ? createBrotliCompress({
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: brotliQuality,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: file.size,
          },
        })
        : createGzip()
      try {
        await pipeline(
          createReadStream(file.path),
          compressor,
          createWriteStream(temporary, { flags: 'wx' }),
        )
        const compressed = await stat(temporary)
        await rename(temporary, file.path)
        sourceBytes += file.size
        encodedBytes += compressed.size
        completed++
        try { onProgress?.({ completed, total: files.length, name: file.name, sourceBytes, encodedBytes }) } catch {
          // 进度显示不是产物的一部分，不能让 UI / 日志回调把已经原子替换的文件误判成压缩失败。
        }
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {})
        firstError ||= error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()))
  if (firstError) throw firstError
  return { files: completed, sourceBytes, encodedBytes }
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
