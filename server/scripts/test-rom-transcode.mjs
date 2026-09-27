/**
 * rom-pack-transcode.js 的单元测试。
 *
 * 不依赖对象存储或线上服务：内存里用原生 zstd + AES 造一份合法的 8BG 包，
 * 再走本模块的「读头 → 分块计划 → 逐块解密」原路解回，断言与原文一致。
 * 覆盖整包、Range 续传、篡改即报错、并发闸。
 */
import assert from 'node:assert/strict'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'
import { deriveRomPackKey } from '../src/rom-pack-key.js'
import {
  ROM_PACK_CHUNK_BYTES,
  ROM_PACK_CODEC,
  ROM_PACK_HEADER_PREFIX_BYTES,
  encodeRomPackPrefix,
  romPackAad,
  romPackIv,
} from '../../shared/rom-pack-format.js'
import {
  ByteReader,
  decryptRomPackChunk,
  isRomPackHeadPrefix,
  planRomPackChunks,
  readRomPackHead,
  releaseTranscodeSlot,
  resolveZstd,
  romTranscodeLimits,
  tryAcquireTranscodeSlot,
} from '../src/rom-pack-transcode.js'

// deriveRomPackKey 需要 ROM_PACK_SECRET（keyId=v1 对应 ROM_PACK_SECRET_V1）。测试用密钥，≥32 字节。
process.env.ROM_PACK_SECRET_V1 = process.env.ROM_PACK_SECRET_V1 || '0123456789abcdef0123456789abcdef01'

const PACKAGE_ID = '0123456789abcdef0123456789abcdef'
const KEY_ID = 'v1'

let failed = 0
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✔ ${name}`)
  } else {
    failed += 1
    console.error(`  ✘ ${name} ${extra}`)
  }
}

/** 内存里造一份合法 8BG 包（zstd 压缩 + AES-256-GCM）。 */
function packInMemory(plain) {
  const chunkSize = ROM_PACK_CHUNK_BYTES
  const key = deriveRomPackKey(PACKAGE_ID, KEY_ID)
  const header = {
    version: 1,
    packageId: PACKAGE_ID,
    keyId: KEY_ID,
    codec: ROM_PACK_CODEC.ZSTD,
    codecVersion: 1,
    compressionLevel: 3,
    codecOptions: {},
    cipher: 'aes-256-gcm',
    originalName: 'test-游戏.bin',
    originalSize: plain.length,
    originalSha256: createHash('sha256').update(plain).digest('hex'),
    chunkSize,
    noncePrefix: randomBytes(8).toString('base64url').slice(0, 11),
    chunks: [],
    payloadSize: 0,
  }
  const payloads = []
  for (let i = 0; i < plain.length; i += chunkSize) {
    const source = plain.subarray(i, i + chunkSize)
    const encoded = Buffer.from(zstdCompressSync(Buffer.from(source)))
    // 先入列块元（AAD 引用本块，索引为 length-1，和浏览器端打包顺序一致）
    const chunk = {
      sourceSize: source.length,
      encodedSize: encoded.length,
      cipherSize: 0,
      sha256: createHash('sha256').update(source).digest('hex'),
    }
    header.chunks.push(chunk)
    const index = header.chunks.length - 1
    const iv = romPackIv(header, index)
    const aad = Buffer.from(romPackAad(header, index))
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(aad)
    const enc = Buffer.concat([cipher.update(encoded), cipher.final()])
    const tag = cipher.getAuthTag()
    const ciphertext = Buffer.concat([enc, tag])
    chunk.cipherSize = ciphertext.length
    header.payloadSize += ciphertext.length
    payloads.push(ciphertext)
  }
  const prefix = encodeRomPackPrefix(header) // 内部会走 validateRomPackHeader
  return { bytes: Buffer.concat([prefix, ...payloads]), header }
}

function readerFromBuffer(buf, size = 1 << 16) {
  const it = (async function* () {
    for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size)
  })()
  return new ByteReader(it)
}

/** 按计划从 payload（偏移 dataOffset 起）逐块解密并拼接，应用到 Range 裁剪。 */
async function transcode(bytes, start = 0, end = bytes.length) {
  const headReader = readerFromBuffer(bytes)
  const { header, dataOffset } = await readRomPackHead(headReader)
  const key = deriveRomPackKey(header.packageId, header.keyId)
  const plan = planRomPackChunks(header, start, end)
  if (plan.length === 0) return Buffer.alloc(0)
  const payloadReader = readerFromBuffer(bytes.subarray(dataOffset))
  // 路由里会用 Range 让流从第一个命中的块开始；测试里流从 payload 头开始，
  // 因此要先跳过 plan 之前的分块，再按序读命中的块（和路由「只解密需要的块」语义一致）。
  for (let i = 0; i < plan[0].index; i++) await payloadReader.readExactly(header.chunks[i].cipherSize)
  const out = []
  for (const step of plan) {
    const encrypted = await payloadReader.readExactly(header.chunks[step.index].cipherSize)
    const source = await decryptRomPackChunk({ header, key, index: step.index, encrypted })
    out.push(source.subarray(step.skipHead, step.skipHead + step.takeLen))
  }
  return Buffer.concat(out)
}

async function main() {
  await resolveZstd() // 确保 zstd 解码器就绪（测试里命中原生 node:zlib）

  // 造一份跨多分块的明文（3 个 8MB 块）
  const plain = randomBytes(ROM_PACK_CHUNK_BYTES * 3 - 12345)
  const { bytes, header } = packInMemory(plain)
  check('内存打包产出合法 8BG 头', bytes.subarray(0, 4).toString() === '8BG1')

  // 1) 整包往返
  const full = await transcode(bytes)
  check('整包解密解压 == 原文', full.equals(plain), `len ${full.length} vs ${plain.length}`)

  // 2) Range：从中间某字节到接近末尾
  const s = 1
  const e = plain.length - 5
  const slice = await transcode(bytes, s, e)
  check('Range 中段 == 原文切片', slice.equals(plain.subarray(s, e)), `len ${slice.length}`)

  // 3) Range：落在分块边界附近（跨块裁剪）
  const b = ROM_PACK_CHUNK_BYTES + 10
  const mid = await transcode(bytes, b, b + 999)
  check('Range 跨块裁剪 == 原文切片', mid.equals(plain.subarray(b, b + 999)), `len ${mid.length}`)

  // 4) 篡改一个密文字节 → GCM 验签失败抛错
  const headReader = readerFromBuffer(bytes)
  const { dataOffset } = await readRomPackHead(headReader)
  const payload = Buffer.from(bytes.subarray(dataOffset))
  const tampered = Buffer.from(payload)
  tampered[0] ^= 0xff // 翻第一个密文块的首字节
  let threw = false
  try {
    const r2 = readerFromBuffer(tampered)
    const enc = await r2.readExactly(header.chunks[0].cipherSize)
    await decryptRomPackChunk({ header, key: deriveRomPackKey(header.packageId, header.keyId), index: 0, encrypted: enc })
  } catch { threw = true }
  check('篡改密文会被 GCM 拦下', threw)

  // 5) isRomPackHeadPrefix
  check('magic 判定真', isRomPackHeadPrefix(Buffer.from('8BG1xxxx')))
  check('magic 判定假', !isRomPackHeadPrefix(randomBytes(8)))

  // 6) planRomPackChunks 边界：空范围
  check('空范围返回空计划', planRomPackChunks(header, 0, 0).length === 0)

  // 7) 并发闸
  const limits = romTranscodeLimits()
  const slots = []
  for (let i = 0; i < limits.concurrency; i++) slots.push(tryAcquireTranscodeSlot(limits))
  check('并发闸按上限放行', slots.every(Boolean) && slots.length === limits.concurrency)
  check('超出并发上限被拒', tryAcquireTranscodeSlot(limits) === false)
  slots.forEach(() => releaseTranscodeSlot())
  check('释放后又能放行', tryAcquireTranscodeSlot(limits) === true)
  releaseTranscodeSlot()

  console.log(failed ? `\nROM 转码测试：${failed} 项失败` : '\nROM 转码测试：全部通过')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
