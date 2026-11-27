/** 大 ROM 身份摘要只采样头 / 中 / 尾；不能为断点续传先把整张 ISO 读进内存。 */
export async function fingerprintRomUploadFile(file: Blob): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null
  const sample = 64 * 1024
  const offsets = [0, Math.max(0, Math.floor(file.size / 2) - sample / 2), Math.max(0, file.size - sample)]
  try {
    const chunks = await Promise.all(offsets.map((at) => file.slice(at, at + sample).arrayBuffer()))
    const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(new Uint8Array(chunk), offset)
      offset += chunk.byteLength
    }
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
    return [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    // 设备不支持读取 / 摘要时只禁用跨选择续传，正常上传仍可进行。
    return null
  }
}

/**
 * 为旧账本和没有 ROM 完整性清单的对象生成 v1 可续传摘要。
 * 分成 1 MiB 小窗是因为 Web Crypto 不支持流式 digest；分片上传和摘要并行时只额外保留一个小窗，
 * 不会为了确认 8 MiB 远端分片而把整张镜像再复制一份到内存。
 * 新 ROM / BIOS 上传走完整性清单的 2 MiB 块摘要，并从同一组摘要派生 v2 分片指纹，避免重复读文件。
 */
export async function fingerprintRomPart(filePart: Blob): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('当前浏览器不能核验已上传分片')

  const windowBytes = 1024 * 1024
  const hashes: Uint8Array[] = []
  for (let offset = 0; offset < filePart.size; offset += windowBytes) {
    const window = await filePart.slice(offset, Math.min(filePart.size, offset + windowBytes)).arrayBuffer()
    hashes.push(new Uint8Array(await subtle.digest('SHA-256', window)))
  }

  // 把分片长度和固定边界规则也纳入摘要，避免不同分块方式得到同一个叶子序列。
  const prefix = new TextEncoder().encode(`8bitgo-rom-part-v1:${filePart.size}:${windowBytes}:${hashes.length}:`)
  const material = new Uint8Array(prefix.byteLength + hashes.length * 32)
  material.set(prefix)
  let offset = prefix.byteLength
  for (const hash of hashes) {
    material.set(hash, offset)
    offset += hash.byteLength
  }
  const digest = new Uint8Array(await subtle.digest('SHA-256', material))
  // 128 位足以让本地续传碰撞概率可忽略，同时将 10000 片账本控制在约 320 KiB。
  return [...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
