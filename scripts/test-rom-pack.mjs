import assert from 'node:assert/strict'
import { createDecipheriv, createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import zstd from '@bokuweb/zstd-wasm'
import { deriveRomPackKey, romPackSecret } from '../server/src/rom-pack-key.js'
import { assertZstdFrameContentSize, parseRomPackHeader, romPackAad, romPackIv, romPackKey, validateRomPackHeader } from '../shared/rom-pack-format.js'

const dir = await mkdtemp(path.join(os.tmpdir(), '8bitgo-rom-pack-'))
const input = path.join(dir, '测试 game.nes')
// 故意放进尚不存在的目录：打包器必须先建目录，不能在开 payload 临时文件时就失败。
const output = path.join(dir, 'nested', '测试 game.nes.8bg')
// 超过 8MB 才能真正覆盖“上一块结束 / 下一块 IV、AAD、偏移重新开始”的边界。
const source = Buffer.from('NES\x1a' + '8BitGo ROM pack regression '.repeat(400_000))
const secret = 'test-only-secret-0123456789-abcdefghijklmnopqrstuvwxyz'
await writeFile(input, source)

try {
  assert.equal(
    romPackSecret('v1', { ROM_PACK_KEY_ID: 'v2', ROM_PACK_SECRET: 'new-secret-should-not-open-v1-packages' }),
    '',
    '轮换后缺少 V1 时必须明确报未配置，不能误拿当前 V2 根密钥解旧包',
  )
  assert.equal(
    romPackSecret('v1', { ROM_PACK_KEY_ID: 'v2', ROM_PACK_SECRET_V1: secret, ROM_PACK_SECRET_V2: 'v2-secret' }),
    secret,
    '轮换后仍能按 keyId 找回历史根密钥',
  )
  const run = spawnSync(process.execPath, ['scripts/pack-rom.mjs', input, output], {
    cwd: path.resolve('.'), encoding: 'utf8', env: { ...process.env, ROM_PACK_SECRET: secret, ROM_PACK_KEY_ID: 'v1' },
  })
  assert.equal(run.status, 0, run.stderr || run.stdout)
  const packed = await readFile(output)
  const { header, dataOffset } = parseRomPackHeader(packed)
  assert.equal(header.codec, 'zstd')
  assert.equal(header.compressionLevel, 19)
  assert.equal(header.originalName, path.basename(input))
  assert.ok(header.chunks.length > 1, '测试样本必须跨过 8MB 分块边界')
  assert.equal(
    romPackKey('https://assets.example/game.nes?token=signed#download'),
    'https://assets.example/game.nes.8bg?token=signed#download',
    '容器后缀必须插在签名查询串之前',
  )
  assert.throws(
    () => validateRomPackHeader({ ...header, chunks: [{ ...header.chunks[0], sourceSize: 1 }, ...header.chunks.slice(1)] }),
    /分块边界|总大小/,
    '畸形分块表不能诱导解码器按错误边界分配内存',
  )

  await zstd.init()
  const key = deriveRomPackKey(header.packageId, header.keyId, { ROM_PACK_SECRET: secret, ROM_PACK_KEY_ID: 'v1' })
  const decoded = []
  let at = dataOffset
  for (let i = 0; i < header.chunks.length; i++) {
    const meta = header.chunks[i]
    const cipherText = packed.subarray(at, at + meta.encodedSize)
    const tag = packed.subarray(at + meta.encodedSize, at + meta.cipherSize)
    const decipher = createDecipheriv('aes-256-gcm', key, romPackIv(header, i))
    decipher.setAAD(Buffer.from(romPackAad(header, i)))
    decipher.setAuthTag(tag)
    const encoded = Buffer.concat([decipher.update(cipherText), decipher.final()])
    assertZstdFrameContentSize(encoded, meta.sourceSize)
    assert.throws(
      () => assertZstdFrameContentSize(encoded, meta.sourceSize + 1),
      /解压大小与分块表不一致/,
      '必须在 Zstd 分配输出内存之前拒绝伪造的超大 frame content size',
    )
    const chunk = Buffer.from(zstd.decompress(encoded))
    assert.equal(createHash('sha256').update(chunk).digest('hex'), meta.sha256)
    decoded.push(chunk)
    at += meta.cipherSize
  }
  assert.deepEqual(Buffer.concat(decoded), source)
  assert.equal(at, packed.byteLength)

  const restored = path.join(dir, 'restored', 'game.nes')
  const unpack = spawnSync(process.execPath, ['scripts/unpack-rom.mjs', output, restored], {
    cwd: path.resolve('.'), encoding: 'utf8', env: { ...process.env, ROM_PACK_SECRET: secret, ROM_PACK_KEY_ID: 'v1' },
  })
  assert.equal(unpack.status, 0, unpack.stderr || unpack.stdout)
  assert.deepEqual(await readFile(restored), source, '服务器侧流式解包必须和浏览器容器完全兼容')
  assert.deepEqual((await readdir(path.dirname(output))).filter((name) => /\.(?:payload|tmp)-/.test(name)), [])

  // 配置错误不能碰已有正式文件。真实运行时磁盘满/进程中断也由“临时文件 + 原子 rename”兜底。
  const protectedOutput = path.join(dir, 'existing.8bg')
  await writeFile(protectedOutput, 'keep-the-old-package')
  const failed = spawnSync(process.execPath, ['scripts/pack-rom.mjs', input, protectedOutput], {
    cwd: path.resolve('.'), encoding: 'utf8', env: { ...process.env, ROM_PACK_SECRET: 'too-short', ROM_PACK_KEY_ID: 'v1' },
  })
  assert.notEqual(failed.status, 0)
  assert.equal(await readFile(protectedOutput, 'utf8'), 'keep-the-old-package')
  const failedUnpack = spawnSync(process.execPath, ['scripts/unpack-rom.mjs', output, protectedOutput], {
    cwd: path.resolve('.'), encoding: 'utf8', env: { ...process.env, ROM_PACK_SECRET: 'wrong-secret-but-long-enough-0123456789', ROM_PACK_KEY_ID: 'v1' },
  })
  assert.notEqual(failedUnpack.status, 0)
  assert.equal(await readFile(protectedOutput, 'utf8'), 'keep-the-old-package', '解密失败不能覆盖上一份可用 ROM')
  console.log('✓ 8BG 往返、跨分块校验、服务端还原、自动建目录与原子输出均正确')
} finally {
  await rm(dir, { recursive: true, force: true })
}
