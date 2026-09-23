#!/usr/bin/env node

/**
 * 把 CS1.6 的确定性 TAR+gzip 包转换成适合 R2 / 浏览器的内容寻址 Zstd 分片。
 *
 * 为什么不直接做一整个 .tar.zst：Zstd 22 对当前 134MB 公共包会生成 128MB 解压窗口，
 * WebAssembly 解压器还要同时持有输入、输出和游戏 MEMFS，移动端很容易因为峰值内存黑屏。
 * 每 16MB 原始 TAR 独立压成一帧，只损失少量压缩率，却把单次解压内存、失败重试和校验
 * 都限制在一个分片里。文件名是压缩字节 SHA-256，上传 R2 后可以永久缓存且不会读到旧内容。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const inputRoot = resolve(process.argv[2] || join(root, 'public/web/cs16/packs'))
const outputRoot = resolve(process.argv[3] || join(inputRoot, 'zstd-v1'))
const chunkRawBytes = 16 * 1024 * 1024
const compressionLevel = 22
const maps = [
  'de_dust2', 'de_dust', 'de_inferno', 'de_nuke', 'de_aztec', 'de_train',
  'de_cbble', 'cs_office', 'cs_italy', 'cs_assault', 'cs_militia', 'de_vertigo',
]
const inputs = [
  ['base', join(inputRoot, 'base.tar.gz')],
  ...maps.map((name) => [`maps/${name}`, join(inputRoot, 'maps', `${name}.tar.gz`)]),
]

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const mib = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`

function findZstd() {
  const candidates = [process.env.ZSTD_BIN, 'zstd', '/opt/homebrew/bin/zstd'].filter(Boolean)
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' })
      return candidate
    } catch {
      /* 继续找下一个；不同构建机的 Homebrew 路径可能不同。 */
    }
  }
  throw new Error('找不到 zstd CLI；macOS 可执行 brew install zstd')
}

async function* rawChunks(gzipFile) {
  const stream = createReadStream(gzipFile).pipe(createGunzip())
  let parts = []
  let bytes = 0
  for await (const value of stream) {
    parts.push(value)
    bytes += value.byteLength
    if (bytes < chunkRawBytes) continue
    const joined = Buffer.concat(parts, bytes)
    yield joined.subarray(0, chunkRawBytes)
    const rest = joined.subarray(chunkRawBytes)
    parts = rest.byteLength ? [rest] : []
    bytes = rest.byteLength
  }
  if (bytes) yield Buffer.concat(parts, bytes)
}

function compressChunk(zstd, raw, workDir) {
  const rawFile = join(workDir, 'chunk.tar')
  const compressedFile = join(workDir, 'chunk.zst')
  writeFileSync(rawFile, raw)
  // 输入是实体文件，所以帧头会写入准确原始长度；浏览器的简单 WASM API 才能安全分配输出。
  execFileSync(zstd, [
    '--ultra', `-${compressionLevel}`, '--quiet', '--force', rawFile, '-o', compressedFile,
  ], { stdio: 'ignore' })
  return readFileSync(compressedFile)
}

async function packOne(key, gzipFile, chunksDir, workDir, zstd) {
  if (!existsSync(gzipFile)) throw new Error(`缺少输入包：${gzipFile}`)
  const chunks = []
  const rawHash = createHash('sha256')
  let rawBytes = 0
  let compressedBytes = 0
  let index = 0

  for await (const raw of rawChunks(gzipFile)) {
    rawHash.update(raw)
    const compressed = compressChunk(zstd, raw, workDir)
    const compressedSha256 = sha256(compressed)
    const rawSha256 = sha256(raw)
    const filename = `${compressedSha256}.zst`
    const target = join(chunksDir, filename)
    if (existsSync(target)) {
      const old = readFileSync(target)
      if (old.byteLength !== compressed.byteLength || sha256(old) !== compressedSha256) {
        throw new Error(`内容寻址分片冲突：${filename}`)
      }
    } else {
      writeFileSync(target, compressed)
    }
    chunks.push({
      index,
      path: `chunks/${filename}`,
      compressedBytes: compressed.byteLength,
      rawBytes: raw.byteLength,
      compressedSha256,
      rawSha256,
    })
    rawBytes += raw.byteLength
    compressedBytes += compressed.byteLength
    index += 1
  }

  if (!chunks.length) throw new Error(`${gzipFile} 解压后为空`)
  console.log(`  ${key}: ${chunks.length} 片 / ${mib(compressedBytes)} 下载 / ${mib(rawBytes)} 原始`)
  return {
    key,
    source: relative(inputRoot, gzipFile).replaceAll('\\', '/'),
    rawBytes,
    compressedBytes,
    rawSha256: rawHash.digest('hex'),
    chunks,
  }
}

async function main() {
  if (outputRoot === inputRoot) throw new Error('输出目录不能覆盖输入目录')
  const zstd = findZstd()
  const parent = dirname(outputRoot)
  mkdirSync(parent, { recursive: true })
  const stage = mkdtempSync(join(parent, `.${basename(outputRoot)}-`))
  const chunksDir = join(stage, 'chunks')
  const workDir = mkdtempSync(join(tmpdir(), '8bitgo-cs16-zstd-'))
  mkdirSync(chunksDir, { recursive: true })

  try {
    const packs = {}
    console.log(`Zstd ${compressionLevel}，每片原始上限 ${mib(chunkRawBytes)}：`)
    for (const [key, file] of inputs) packs[key] = await packOne(key, file, chunksDir, workDir, zstd)
    const catalog = {
      format: '8bitgo.cs16.zstd-chunks.v1',
      tarFormat: 'ustar',
      compression: { algorithm: 'zstd', level: compressionLevel, chunkRawBytes },
      packs,
    }
    writeFileSync(join(stage, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`)
    writeFileSync(join(stage, 'R2_HEADERS.txt'), [
      '# chunks/*.zst',
      'Content-Type: application/zstd',
      'Cache-Control: public, max-age=31536000, immutable',
      'Content-Encoding: （不要设置；这是应用层 Zstd，由网页解压）',
      '',
      '# catalog.json',
      'Content-Type: application/json; charset=utf-8',
      'Cache-Control: no-cache, max-age=0, must-revalidate',
      '',
    ].join('\n'))
    if (existsSync(outputRoot)) rmSync(outputRoot, { recursive: true, force: true })
    renameSync(stage, outputRoot)
    const total = Object.values(packs).reduce((sum, pack) => sum + pack.compressedBytes, 0)
    console.log(`✔ 已生成 ${outputRoot}（${mib(total)}，${statSync(join(outputRoot, 'catalog.json')).size} 字节清单）`)
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    throw error
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

await main()
