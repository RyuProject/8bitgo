/**
 * 服务端 JAR 完整性检查。
 *
 * 前端的检查改善本地上传体验，但公开上传接口不能相信前端；这里独立解析 ZIP 末尾的
 * 中央目录，确认每个成员的数据都在请求体范围内，再检查 manifest 与 class。FreeJ2ME
 * 仍会做最终字节码加载，因此这是“容器完整性 + 运行时兼容性”两道关。
 */
export function assertJarBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('JAR 文件为空或过短')
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) throw new Error('不是 ZIP/JAR 文件')

  let eocd = -1
  const from = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('JAR 中央目录缺失，文件可能未下载完整')

  const disk = buf.readUInt16LE(eocd + 4)
  const centralDisk = buf.readUInt16LE(eocd + 6)
  const diskCount = buf.readUInt16LE(eocd + 8)
  const count = buf.readUInt16LE(eocd + 10)
  const centralSize = buf.readUInt32LE(eocd + 12)
  const centralOffset = buf.readUInt32LE(eocd + 16)
  const commentLength = buf.readUInt16LE(eocd + 20)
  if (disk || centralDisk || diskCount !== count || count === 0 || count === 0xffff) throw new Error('不支持空包、分卷或 ZIP64 JAR')
  if (eocd + 22 + commentLength > buf.length || centralOffset + centralSize > eocd) throw new Error('JAR 中央目录越界')

  const names = []
  const centralEnd = centralOffset + centralSize
  let at = centralOffset
  for (let i = 0; i < count; i++) {
    if (at + 46 > centralEnd || buf.readUInt32LE(at) !== 0x02014b50) throw new Error('JAR 中央目录损坏')
    const compressedSize = buf.readUInt32LE(at + 20)
    const nameLength = buf.readUInt16LE(at + 28)
    const extraLength = buf.readUInt16LE(at + 30)
    const commentLength2 = buf.readUInt16LE(at + 32)
    const localOffset = buf.readUInt32LE(at + 42)
    const next = at + 46 + nameLength + extraLength + commentLength2
    if (next > centralEnd) throw new Error('JAR 成员名称越界')
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('JAR 本地文件头损坏')
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    if (dataStart > buf.length || dataStart + compressedSize > buf.length) throw new Error('JAR 成员数据不完整')
    names.push(buf.toString('utf8', at + 46, at + 46 + nameLength).replaceAll('\\', '/').toLowerCase())
    at = next
  }

  if (!names.includes('meta-inf/manifest.mf')) throw new Error('JAR 缺少 META-INF/MANIFEST.MF')
  if (!names.some((name) => name.endsWith('.class'))) throw new Error('JAR 里没有 Java class 文件')
  return names
}
