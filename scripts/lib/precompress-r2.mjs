import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { constants, createBrotliCompress } from 'node:zlib'

export async function sha256File(file) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

export function readCompressionManifest(file) {
  if (!existsSync(file)) return { version: 1, assets: {} }
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (value?.version === 1 && value.assets && typeof value.assets === 'object') return value
  } catch {
    /* 旧清单坏了就重算；压缩结果只是构建缓存，不是用户数据。 */
  }
  return { version: 1, assets: {} }
}

export function writeCompressionManifest(file, manifest) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * Brotli quality 11 + 16MiB 窗口是浏览器原生 Brotli 能稳定解码的最高压缩档。
 * 结果按源文件 SHA 复用：100MB WASM 跑 q11 很慢，源字节没变就绝不能每次上传重压。
 */
export async function prepareBrotli({ source, target, cached, text = false }) {
  const sourceSize = statSync(source).size
  const sourceSha256 = await sha256File(source)
  if (
    cached?.sourceSha256 === sourceSha256 &&
    cached?.sourceSize === sourceSize &&
    existsSync(target) &&
    statSync(target).size === cached.compressedSize
  ) {
    return { ...cached, reused: true }
  }

  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.tmp-${process.pid}`
  rmSync(temp, { force: true })
  try {
    await pipeline(
      createReadStream(source),
      createBrotliCompress({
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 11,
          [constants.BROTLI_PARAM_LGWIN]: 24,
          [constants.BROTLI_PARAM_MODE]: text ? constants.BROTLI_MODE_TEXT : constants.BROTLI_MODE_GENERIC,
          [constants.BROTLI_PARAM_SIZE_HINT]: sourceSize,
        },
      }),
      createWriteStream(temp),
    )
    renameSync(temp, target)
  } finally {
    rmSync(temp, { force: true })
  }

  const compressedSize = statSync(target).size
  return {
    sourceSha256,
    sourceSize,
    compressedSha256: await sha256File(target),
    compressedSize,
    ratio: compressedSize / sourceSize,
    reused: false,
  }
}

export const mib = (bytes) => `${(bytes / 1048576).toFixed(1)} MiB`
