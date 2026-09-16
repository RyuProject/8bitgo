/// <reference lib="webworker" />

import { compress, init } from '@bokuweb/zstd-wasm'
import {
  ROM_PACK_CHUNK_BYTES,
  ROM_PACK_CODEC,
  ROM_PACK_VERSION,
  bytesToBase64Url,
  encodeRomPackPrefix,
  romPackAad,
  romPackIv,
  type RomPackCodec,
  type RomPackHeader,
} from '../../shared/rom-pack-format.js'

interface PackRequest {
  type: 'pack'
  file: File
  originalName: string
  packageId: string
  keyId: string
  key: ArrayBuffer
  codec: RomPackCodec
  level: number
}

type WorkerReply =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'done'; blob: Blob; header: RomPackHeader }
  | { type: 'error'; message: string }

let zstdReady: Promise<void> | null = null
const ready = () => (zstdReady ??= init())

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (v) => v.toString(16).padStart(2, '0')).join('')

async function encode(codec: RomPackCodec, source: Uint8Array, level: number): Promise<Uint8Array<ArrayBuffer>> {
  if (codec === ROM_PACK_CODEC.STORE) return new Uint8Array(source)
  if (codec === ROM_PACK_CODEC.ZSTD) {
    await ready()
    // zstd-wasm 的声明没有承诺底层一定是 ArrayBuffer；复制也避免下一次压缩复用 WASM 内存。
    return new Uint8Array(compress(source, level))
  }
  // codec 在容器里是开放字段；这里把未安装的实现说清楚，未来只需在这张分发表补一项。
  throw new Error(`当前打包器还没有安装 ${codec} 编码器`)
}

async function pack(request: PackRequest): Promise<{ blob: Blob; header: RomPackHeader }> {
  if (!request.file.size) throw new Error('不能打包空 ROM')
  if (!/^[a-f0-9]{32}$/i.test(request.packageId)) throw new Error('packageId 无效')
  const cryptoKey = await crypto.subtle.importKey('raw', request.key, 'AES-GCM', false, ['encrypt'])
  const nonce = crypto.getRandomValues(new Uint8Array(8))
  const header: RomPackHeader = {
    version: ROM_PACK_VERSION,
    packageId: request.packageId,
    keyId: request.keyId,
    codec: request.codec,
    codecVersion: 1,
    compressionLevel: request.codec === ROM_PACK_CODEC.ZSTD ? request.level : undefined,
    // LZMA2 的字典大小等参数以后直接放这里；老 Zstd 包的解释不受新 codec 影响。
    codecOptions: {},
    cipher: 'aes-256-gcm',
    originalName: request.originalName,
    originalSize: request.file.size,
    originalSha256: null,
    chunkSize: ROM_PACK_CHUNK_BYTES,
    noncePrefix: bytesToBase64Url(nonce),
    chunks: [],
    payloadSize: 0,
    createdAt: new Date().toISOString(),
  }
  const encryptedChunks: Blob[] = []

  // AAD 只认证当前块的元数据，所以每块压完就能立刻加密并释放原文/压缩文。
  // 浏览器只需要保留最终要上传的密文，不会同时攒一整份压缩中间产物。
  for (let at = 0; at < request.file.size; at += ROM_PACK_CHUNK_BYTES) {
    const source = new Uint8Array(await request.file.slice(at, at + ROM_PACK_CHUNK_BYTES).arrayBuffer())
    const encoded = await encode(request.codec, source, request.level)
    const sha256 = hex(await crypto.subtle.digest('SHA-256', source))
    const chunk = { sourceSize: source.byteLength, encodedSize: encoded.byteLength, cipherSize: encoded.byteLength + 16, sha256 }
    header.chunks.push(chunk)
    header.payloadSize += chunk.cipherSize
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: romPackIv(header, header.chunks.length - 1), additionalData: romPackAad(header, header.chunks.length - 1), tagLength: 128 },
      cryptoKey,
      encoded,
    )
    // 每块立刻固化成 Blob，浏览器可把大 Blob 落盘；数组里不长期钉着整库的 ArrayBuffer。
    encryptedChunks.push(new Blob([cipher]))
    ;(self as DedicatedWorkerGlobalScope).postMessage({ type: 'progress', loaded: Math.min(at + source.byteLength, request.file.size), total: request.file.size } satisfies WorkerReply)
  }

  return { blob: new Blob([encodeRomPackPrefix(header), ...encryptedChunks], { type: 'application/x-8bitgo-rom' }), header }
}

self.onmessage = (event: MessageEvent<PackRequest>) => {
  if (event.data?.type !== 'pack') return
  void pack(event.data)
    .then(({ blob, header }) => (self as DedicatedWorkerGlobalScope).postMessage({ type: 'done', blob, header } satisfies WorkerReply))
    .catch((error) => (self as DedicatedWorkerGlobalScope).postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) } satisfies WorkerReply))
}
