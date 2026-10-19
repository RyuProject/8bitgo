/// <reference lib="webworker" />

import { compress, init } from '@bokuweb/zstd-wasm'
import {
  ROM_PACK_CHUNK_BYTES,
  ROM_PACK_CODEC,
  ROM_PACK_VERSION,
  romPackAad,
  romPackIv,
  type RomPackCodec,
  type RomPackHeader,
} from '../../shared/rom-pack-format.js'

interface InitRequest {
  type: 'init'
  packageId: string
  keyId: string
  key: ArrayBuffer
  codec: RomPackCodec
  level: number
  originalName: string
  originalSize: number
  noncePrefix: string
}

interface ChunkRequest {
  type: 'chunk'
  index: number
  source: Blob
}

type PackRequest = InitRequest | ChunkRequest

type WorkerReply =
  | { type: 'ready' }
  | { type: 'chunk'; index: number; cipher: ArrayBuffer; chunk: RomPackHeader['chunks'][number] }
  | { type: 'error'; message: string; index?: number }

type PackContext = Omit<InitRequest, 'type' | 'key'>

let zstdReady: Promise<void> | null = null
const ready = () => (zstdReady ??= init())
let context: PackContext | null = null
let cryptoKey: CryptoKey | null = null

const scope = self as DedicatedWorkerGlobalScope
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (v) => v.toString(16).padStart(2, '0')).join('')

async function encode(codec: RomPackCodec, source: Uint8Array<ArrayBuffer>, level: number): Promise<Uint8Array<ArrayBuffer>> {
  // store 本来就只需要 AES。原来这里又复制了一份 8MB 原文，大 ZIP / CHD 会白白增加一次内存带宽。
  if (codec === ROM_PACK_CODEC.STORE) return source
  if (codec === ROM_PACK_CODEC.ZSTD) {
    await ready()
    // zstd-wasm 会复用自己的线性内存，复制输出后才能安全地开始下一块。
    return new Uint8Array(compress(source, level))
  }
  throw new Error(`当前打包器还没有安装 ${codec} 编码器`)
}

async function initialize(request: InitRequest) {
  if (!/^[a-f0-9]{32}$/i.test(request.packageId)) throw new Error('packageId 无效')
  if (!request.originalSize || request.originalSize < 0) throw new Error('ROM 大小无效')
  const keyBytes = new Uint8Array(request.key)
  try {
    cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
  } finally {
    // Worker 后续只保留不可导出的 CryptoKey；原始数据密钥不必继续躺在 JS 堆里。
    keyBytes.fill(0)
  }
  context = {
    packageId: request.packageId,
    keyId: request.keyId,
    codec: request.codec,
    level: request.level,
    originalName: request.originalName,
    originalSize: request.originalSize,
    noncePrefix: request.noncePrefix,
  }
  if (request.codec === ROM_PACK_CODEC.ZSTD) await ready()
}

async function packChunk(request: ChunkRequest): Promise<Extract<WorkerReply, { type: 'chunk' }>> {
  const current = context
  const key = cryptoKey
  if (!current || !key) throw new Error('ROM 打包 Worker 尚未初始化')
  if (!Number.isInteger(request.index) || request.index < 0) throw new Error('ROM 分块号无效')
  const expectedSize = Math.min(
    ROM_PACK_CHUNK_BYTES,
    current.originalSize - request.index * ROM_PACK_CHUNK_BYTES,
  )
  if (expectedSize <= 0 || request.source.size !== expectedSize) throw new Error(`ROM 第 ${request.index + 1} 块大小无效`)

  const source = new Uint8Array(await request.source.arrayBuffer()) as Uint8Array<ArrayBuffer>
  // Web Crypto 的摘要通常在线程池中运行。先发起摘要，再同步跑 Zstd，可以把两段 CPU 时间重叠起来。
  const digest = crypto.subtle.digest('SHA-256', source)
  const encoded = await encode(current.codec, source, current.level)
  const sha256 = hex(await digest)
  const chunk = {
    sourceSize: source.byteLength,
    encodedSize: encoded.byteLength,
    cipherSize: encoded.byteLength + 16,
    sha256,
  }
  // AAD 只读取当前下标的元数据，不依赖其它块。构造稀疏数组让不同 Worker 可以完全独立封装。
  const chunks = Array.from({ length: request.index + 1 }) as RomPackHeader['chunks']
  chunks[request.index] = chunk
  const header = {
    version: ROM_PACK_VERSION,
    packageId: current.packageId,
    keyId: current.keyId,
    codec: current.codec,
    codecVersion: 1,
    compressionLevel: current.codec === ROM_PACK_CODEC.ZSTD ? current.level : undefined,
    codecOptions: {},
    cipher: 'aes-256-gcm' as const,
    originalName: current.originalName,
    originalSize: current.originalSize,
    originalSha256: null,
    chunkSize: ROM_PACK_CHUNK_BYTES,
    noncePrefix: current.noncePrefix,
    chunks,
    payloadSize: 0,
    createdAt: '',
  } satisfies RomPackHeader
  const cipher = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: romPackIv(header, request.index),
      additionalData: romPackAad(header, request.index),
      tagLength: 128,
    },
    key,
    encoded,
  )
  if (cipher.byteLength !== chunk.cipherSize) throw new Error(`ROM 第 ${request.index + 1} 块加密长度异常`)
  return { type: 'chunk', index: request.index, cipher, chunk }
}

scope.onmessage = (event: MessageEvent<PackRequest>) => {
  const request = event.data
  if (request?.type === 'init') {
    void initialize(request)
      .then(() => scope.postMessage({ type: 'ready' } satisfies WorkerReply))
      .catch((error) => scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) } satisfies WorkerReply))
    return
  }
  if (request?.type !== 'chunk') return
  void packChunk(request)
    .then((message) => scope.postMessage(message, [message.cipher]))
    .catch((error) => scope.postMessage({
      type: 'error',
      index: request.index,
      message: error instanceof Error ? error.message : String(error),
    } satisfies WorkerReply))
}
