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
