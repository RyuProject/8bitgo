import { assertValidZip, assertValidZipBlob, crc32, type ZipFileEntry } from './unzip'

/** Play! 街机包保留为原始 ZIP，不能套 8BG：CHD 必须以文件形式交给 libchdr。 */
export const PLAY_ARCADE_BUNDLE_FORMAT = '8bitgo-play-arcade-v1'
export const PLAY_ARCADE_BUNDLE_MAX_BYTES = 768 * 1024 * 1024
const MAX_ENTRIES = 64
const MAX_SMALL_FILE = 64 * 1024 * 1024
const MAX_MANIFEST = 16 * 1024
const MAX_DEFINITION = 64 * 1024

export interface PlayArcadeBundleManifest {
  format: typeof PLAY_ARCADE_BUNDLE_FORMAT
  id: string
  definition: string
  dongleArchive: string
  discs: string[]
}

export interface PlayArcadeBundle {
  manifest: PlayArcadeBundleManifest
  entries: Map<string, ZipFileEntry>
  definitionText: string
  dongleEntry: ZipFileEntry
  discEntries: ZipFileEntry[]
}

const fail = (message: string): never => { throw new Error(`Play! 街机包：${message}`) }

function safePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 &&
    !value.startsWith('/') && !value.includes('\\') &&
    value.split('/').every((part) => part && part !== '.' && part !== '..')
}

async function readStoredEntry(blob: Blob, entry: ZipFileEntry, limit: number): Promise<Uint8Array> {
  if ((entry.flags ?? 0) & 1) fail(`不支持加密成员 ${entry.name}`)
  if (entry.method !== 0) fail(`成员 ${entry.name} 必须使用“仅存储”方式打包`)
  if (entry.uncompressedSize > limit || entry.compressedSize !== entry.uncompressedSize) fail(`成员 ${entry.name} 超出允许大小`)
  const local = await blob.slice(entry.offset, entry.offset + 30).arrayBuffer()
  if (local.byteLength !== 30) fail(`成员 ${entry.name} 的本地头损坏`)
  const view = new DataView(local)
  const dataStart = entry.offset + 30 + view.getUint16(26, true) + view.getUint16(28, true)
  const bytes = new Uint8Array(await blob.slice(dataStart, dataStart + entry.uncompressedSize).arrayBuffer())
  if (bytes.byteLength !== entry.uncompressedSize || crc32(bytes) !== (entry.crc32 >>> 0)) fail(`成员 ${entry.name} 校验失败`)
  return bytes
}

function parseDefinition(text: string, id: string, discPaths: string[]): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    fail('arcadedef 不是有效 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('arcadedef 格式无效')
  const def = parsed as Record<string, unknown>
  if (def.id !== id) fail('arcadedef 的 id 与包清单不一致')
  if (def.driver !== 'sys246' && def.driver !== 'sys147') fail('只接受 Play! 已实现的 System 246 / System 147 驱动')
  const dongle = def.dongle
  if (!dongle || typeof dongle !== 'object' || Array.isArray(dongle)) return fail('arcadedef 未声明有效的 dongle 成员名')
  const dongleName = (dongle as Record<string, unknown>).name
  if (typeof dongleName !== 'string' || !dongleName || !safePath(dongleName)) return fail('arcadedef 未声明有效的 dongle 成员名')

  const media: Array<{ name: string }> = []
  for (const candidate of [def.cdvd, def.hdd]) {
    if (!candidate) continue
    if (typeof candidate !== 'object' || Array.isArray(candidate)) return fail('arcadedef 没有声明有效的 CD/DVD 或硬盘镜像')
    const name = (candidate as Record<string, unknown>).name
    if (typeof name !== 'string' || !name) return fail('arcadedef 没有声明有效的 CD/DVD 或硬盘镜像')
    media.push({ name })
  }
  if (media.length === 0) fail('arcadedef 没有声明 CD/DVD 或硬盘镜像')
  const names = media.map((item) => `arcaderoms/${id}/${item.name}`)
  if (names.some((path) => !safePath(path) || !discPaths.includes(path))) fail('arcadedef 引用的镜像没有收录在包里')
  if (names.length !== discPaths.length || new Set(names).size !== names.length) fail('镜像清单与 arcadedef 不匹配')
  return dongleName
}

/**
 * 校验上传 / 开局用的 Play! System 2x6 包。ZIP 中只允许存储模式，避免 500MB CHD 被
 * 整包解压进 JS 堆；校验阶段只把小清单与 arcadedef 放进内存，盘映像稍后分块写入 WASM FS。
 */
export async function inspectPlayArcadeBundle(blob: Blob): Promise<PlayArcadeBundle> {
  if (blob.size < 22 || blob.size > PLAY_ARCADE_BUNDLE_MAX_BYTES) fail(`包大小必须在 22 字节与 ${Math.round(PLAY_ARCADE_BUNDLE_MAX_BYTES / 1024 / 1024)} MiB 之间`)
  const rows = await assertValidZipBlob(blob, 'Play! 街机包')
  if (rows.length > MAX_ENTRIES) fail(`成员不能超过 ${MAX_ENTRIES} 个`)
  const entries = new Map<string, ZipFileEntry>()
  let expanded = 0
  for (const row of rows) {
    if (!safePath(row.name)) fail(`成员路径不安全：${row.name}`)
    if (entries.has(row.name)) fail(`成员重复：${row.name}`)
    if ((row.flags ?? 0) & 1) fail(`不支持加密成员 ${row.name}`)
    if (row.method !== 0) fail(`成员 ${row.name} 必须使用“仅存储”方式打包`)
    expanded += row.uncompressedSize
    if (!Number.isSafeInteger(expanded) || expanded > PLAY_ARCADE_BUNDLE_MAX_BYTES) fail('解包总量超过安全上限')
    entries.set(row.name, row)
  }

  const manifestEntry = entries.get('8bitgo-play-arcade.json')
  if (!manifestEntry) return fail('缺少 8bitgo-play-arcade.json')
  if (manifestEntry.uncompressedSize > MAX_MANIFEST) fail('8bitgo-play-arcade.json 文件过大')
  const manifestBytes = await readStoredEntry(blob, manifestEntry, MAX_MANIFEST)
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder().decode(manifestBytes)) } catch { fail('包清单不是有效 JSON') }
  if (!parsed || typeof parsed !== 'object') fail('包清单格式无效')
  const manifest = parsed as Partial<PlayArcadeBundleManifest>
  if (manifest.format !== PLAY_ARCADE_BUNDLE_FORMAT) return fail('不支持的包格式')
  if (typeof manifest.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(manifest.id)) return fail('游戏 id 无效')
  const id = manifest.id
  const definition = `arcadedefs/${id}.arcadedef`
  const dongleArchive = `arcaderoms/${id}.zip`
  if (manifest.definition !== definition || manifest.dongleArchive !== dongleArchive) return fail('definition / dongle 路径必须符合该 id 的目录约定')
  if (!Array.isArray(manifest.discs) || manifest.discs.length < 1 || manifest.discs.length > 4 || manifest.discs.some((p) => !safePath(p))) return fail('discs 清单无效')
  const discPaths = manifest.discs as string[]
  if (new Set(discPaths).size !== discPaths.length || discPaths.some((p) => !p.startsWith(`arcaderoms/${id}/`) || !/\.(chd|iso|cue|cso|isz|mds)$/i.test(p))) fail('镜像路径必须位于该游戏目录且使用 Play! 支持的格式')
  const expectedNames = new Set(['8bitgo-play-arcade.json', definition, dongleArchive, ...discPaths])
  if (entries.size !== expectedNames.size || [...entries.keys()].some((name) => !expectedNames.has(name))) fail('包中含有清单之外的文件')

  const definitionEntry = entries.get(definition)
  if (!definitionEntry) return fail(`缺少 ${definition}`)
  if (definitionEntry.uncompressedSize > MAX_DEFINITION) fail(`${definition} 文件过大`)
  const dongleEntry = entries.get(dongleArchive)
  if (!dongleEntry) return fail(`缺少 ${dongleArchive}`)
  if (dongleEntry.uncompressedSize > MAX_SMALL_FILE) fail(`${dongleArchive} 文件过大`)
  const discEntries: ZipFileEntry[] = []
  for (const path of discPaths) {
    const entry = entries.get(path)
    if (!entry || entry.uncompressedSize === 0 || entry.uncompressedSize > PLAY_ARCADE_BUNDLE_MAX_BYTES - MAX_SMALL_FILE) return fail('盘映像缺失、为空或过大')
    discEntries.push(entry)
  }
  const definitionBytes = await readStoredEntry(blob, definitionEntry, MAX_DEFINITION)
  const definitionText = new TextDecoder().decode(definitionBytes)
  const dongleMemberName = parseDefinition(definitionText, id, discPaths)
  const dongleBytes = await readStoredEntry(blob, dongleEntry, MAX_SMALL_FILE)
  if (dongleBytes.byteLength < 22 || dongleBytes[0] !== 0x50 || dongleBytes[1] !== 0x4b) fail('dongle 文件不是 ZIP')
  const dongleBuffer = dongleBytes.buffer.slice(dongleBytes.byteOffset, dongleBytes.byteOffset + dongleBytes.byteLength) as ArrayBuffer
  if (!assertValidZip(dongleBuffer, 'dongle ZIP').some((entry) => entry.name === dongleMemberName)) fail(`dongle ZIP 中找不到 ${dongleMemberName}`)
  return { manifest: manifest as PlayArcadeBundleManifest, entries, definitionText, dongleEntry, discEntries: discEntries as ZipFileEntry[] }
}
