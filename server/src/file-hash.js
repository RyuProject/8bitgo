/**
 * 静态文件的 sha256（十六进制全长），按「路径 + 大小 + mtime」缓存，同一份文件每次部署只算一次。
 *
 * 给两处用：
 *   - runtime-version-guard.js：`/emulatorjs/x?v=<内容哈希>` 的版本号与磁盘上的文件对不上时不许边缘缓存；
 *   - precompressed-static.js：`.br` 旁注记下的原文件 sha256 与当前原文件不一致时不吐过期压缩版。
 *
 * 流式读、并发请求共用同一个 Promise，不阻塞事件循环（核心文件 8–30MB）。
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

const cache = new Map()
const MAX_ENTRIES = 2000

/**
 * @param {string} file 绝对路径
 * @returns {Promise<{ sha256: string, size: number } | null>} 文件不存在 / 不是普通文件时为 null
 */
export async function fileSha256(file) {
  let info
  try {
    info = await stat(file)
  } catch {
    return null
  }
  if (!info.isFile()) return null
  const key = `${file}\0${info.size}\0${info.mtimeMs}`
  let pending = cache.get(key)
  if (!pending) {
    pending = new Promise((resolve) => {
      const hash = createHash('sha256')
      const stream = createReadStream(file)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', () => {
        cache.delete(key)
        resolve(null)
      })
      stream.on('end', () => resolve({ sha256: hash.digest('hex'), size: info.size }))
    })
    if (cache.size >= MAX_ENTRIES) cache.clear()
    cache.set(key, pending)
  }
  return pending
}

/** 测试用 */
export function clearFileHashCache() {
  cache.clear()
}
