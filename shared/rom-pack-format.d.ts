export const ROM_PACK_VERSION: 1
export const ROM_PACK_MAGIC_TEXT: '8BG1'
export const ROM_PACK_HEADER_PREFIX_BYTES: 8
export const ROM_PACK_MAX_HEADER_BYTES: number
export const ROM_PACK_CHUNK_BYTES: number
export const ROM_PACK_MAX_ENCODED_CHUNK_BYTES: number
export const ROM_PACK_CODEC: Readonly<{ STORE: 'store'; ZSTD: 'zstd'; LZMA2: 'lzma2' }>

export type RomPackCodec = 'store' | 'zstd' | 'lzma2'
export interface RomPackChunk {
  sourceSize: number
  encodedSize: number
  cipherSize: number
  sha256: string
}
export interface RomPackHeader {
  version: 1
  packageId: string
  keyId: string
  codec: RomPackCodec
  codecVersion: number
  compressionLevel?: number
  /** 给未来的 LZMA2 字典大小等参数留位；旧包可以没有。 */
  codecOptions?: Record<string, string | number | boolean>
  cipher: 'aes-256-gcm'
  originalName: string
  originalSize: number
  originalSha256?: string | null
  chunkSize: number
  noncePrefix: string
  chunks: RomPackChunk[]
  payloadSize: number
  createdAt: string
}

export function isRomPackBytes(value: ArrayBuffer | Uint8Array): boolean
export function isRomPackUrl(value: unknown): value is string
export function romPackKey(key: string): string
export function romPackInnerName(name: string): string
export function encodeRomPackPrefix(header: RomPackHeader): Uint8Array<ArrayBuffer>
export function romPackHeaderLength(prefix: ArrayBuffer | Uint8Array): number
export function parseRomPackHeader(bytes: ArrayBuffer | Uint8Array): { header: RomPackHeader; dataOffset: number }
export function validateRomPackHeader(header: unknown): RomPackHeader
export function romPackAad(header: RomPackHeader, index: number): Uint8Array<ArrayBuffer>
export function romPackIv(header: RomPackHeader, index: number): Uint8Array<ArrayBuffer>
export function assertZstdFrameContentSize(value: ArrayBuffer | Uint8Array, expectedSize: number): void
export function bytesToBase64Url(bytes: Uint8Array): string
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer>
