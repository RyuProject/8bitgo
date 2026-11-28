/**
 * 内存下载 + 内存解包（Blob 存储坏掉时的整条退路）端到端：
 *   - 用真打包器（scripts/pack-rom.mjs）造一个三块的 8BG；
 *   - 按网络读块的样子切成 64KB 的内存替身（fetchBlobWithProgress inMemoryUpTo 交出来的形状）；
 *   - unpackRomPackToMemory 解出来逐字节对得上原文；consumeInput 时解一块放一块密文。
 * 同一条再在「没有 WebAssembly」的子进程里跑一遍：8BG 改用纯 JS 的 fzstd 解压（2026-11-15 Android 模拟器 Chrome 110）。
 *
 *   npm run test:memory-rom-unpack
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(import.meta.url)
const repo = path.resolve(path.dirname(here), '..')
const secret = 'test-only-secret-0123456789-abcdefghijklmnopqrstuvwxyz'

if (process.env.MEMORY_ROM_CHILD) {
  await runChild(process.env.MEMORY_ROM_CHILD)
} else {
  const dir = await mkdtemp(path.join(os.tmpdir(), '8bitgo-memory-rom-'))
  try {
    const input = path.join(dir, 'game.nes')
    const output = path.join(dir, 'game.nes.8bg')
    // 超过两块（8MB 一块），可压缩但不全是重复，跨块边界才测得出偏移 / 释放的错
    const source = Buffer.alloc(17 * 1024 * 1024 + 4321)
    for (let i = 0; i < source.length; i++) source[i] = (i * 31 + (i >> 13)) & 0xff
    await writeFile(input, source)
    const pack = spawnSync(process.execPath, ['scripts/pack-rom.mjs', input, output], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, ROM_PACK_SECRET: secret, ROM_PACK_KEY_ID: 'v1' },
    })
    assert.equal(pack.status, 0, pack.stderr || pack.stdout)
    for (const mode of ['wasm', 'no-wasm']) {
      const run = spawnSync(process.execPath, [
        '--experimental-strip-types', '--import', './scripts/helpers/ts-register.mjs', here,
      ], { cwd: repo, encoding: 'utf8', env: { ...process.env, MEMORY_ROM_CHILD: mode, MEMORY_ROM_DIR: dir } })
      process.stdout.write(run.stdout)
      assert.equal(run.status, 0, `${mode}：${run.stderr || run.stdout}`)
    }
    console.log('test:memory-rom-unpack 通过')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function runChild(mode) {
  globalThis.__viteEnv = { VITE_API_URL: 'https://api.example.test' }
  const dir = process.env.MEMORY_ROM_DIR
  const { deriveRomPackKey } = await import('../server/src/rom-pack-key.js')
  const { parseRomPackHeader, bytesToBase64Url } = await import('../shared/rom-pack-format.js')
  const packed = new Uint8Array(await readFile(path.join(dir, 'game.nes.8bg')))
  const source = new Uint8Array(await readFile(path.join(dir, 'game.nes')))
  const { header } = parseRomPackHeader(packed)
  assert.ok(header.chunks.length >= 3, '要跨块')
  const key = deriveRomPackKey(header.packageId, header.keyId, { ROM_PACK_SECRET: secret, ROM_PACK_KEY_ID: 'v1' })
  // 不用 Node 的 Response：它背后的 undici 要 WebAssembly，没 WebAssembly 的那一轮会先崩在测试桩上
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/api\/rom-pack\/key/)
    const body = { packageId: header.packageId, keyId: header.keyId, key: bytesToBase64Url(key) }
    return { ok: true, status: 200, json: async () => body }
  }
  const { memoryRomBlob, memoryRomOf } = await import('../src/services/memoryRom.ts')
  const { unpackRomPackToMemory } = await import('../src/services/romPack.ts')
  const iterableRom = memoryRomBlob((function* () {
    yield new Uint8Array([1, 2])
    yield new Uint8Array([3, 4])
  })())
  assert.deepEqual([...new Uint8Array(await iterableRom.arrayBuffer())], [1, 2, 3, 4], '内存 ROM 支持惰性块迭代器')
  // 模块都加载完再拿掉（Node 自己剥 TS 类型要用 WebAssembly）；解码器是第一次解包时才按 webAssemblyAvailable() 选的
  if (mode === 'no-wasm') delete globalThis.WebAssembly

  /** 按网络读块（64KB）切开，每块独占自己的缓冲区，和 fetch 流交出来的一样 */
  const asNetworkMemory = () => {
    const parts = []
    for (let at = 0; at < packed.length; at += 65536) parts.push(packed.slice(at, at + 65536))
    return memoryRomBlob(parts)
  }
  const sameAsSource = async (blob) => {
    assert.equal(blob.size, source.length)
    const out = new Uint8Array(await blob.arrayBuffer())
    assert.ok(Buffer.compare(Buffer.from(out), Buffer.from(source)) === 0, '解出来要和原文逐字节相同')
  }

  // 不消费：输入原样可再读
  {
    const input = asNetworkMemory()
    const result = await unpackRomPackToMemory(input)
    assert.equal(result.name, 'game.nes')
    await sameAsSource(result.blob)
    assert.ok(memoryRomOf(input).parts.every(Boolean), '不消费时输入一块都不能放')
    assert.equal((await input.slice(0, 4).arrayBuffer()).byteLength, 4)
  }
  // 消费：解一块放一块，峰值不再是整份密文 + 整份明文
  {
    const input = asNetworkMemory()
    const rom = memoryRomOf(input)
    let maxLive = 0
    const live = () => rom.parts.reduce((sum, part) => sum + (part?.byteLength ?? 0), 0)
    const result = await unpackRomPackToMemory(input, () => { maxLive = Math.max(maxLive, live()) }, true)
    await sameAsSource(result.blob)
    const firstChunkCipher = header.chunks[0].cipherSize
    assert.ok(maxLive < packed.length - firstChunkCipher + 65536, `第一块解完后密文就该放掉一块（还剩 ${maxLive}）`)
    assert.ok(live() < 65536 * 2, `解完后密文几乎全部放掉（还剩 ${live()} 字节）`)
    await assert.rejects(input.slice(0, 4).arrayBuffer(), (e) => e.name === 'NotReadableError', '放掉的那段再读要报 NotReadableError')
  }
  console.log(`  ✅ ${mode === 'wasm' ? 'WebAssembly zstd' : '没有 WebAssembly（fzstd）'}：内存 8BG 解包逐字节正确，消费模式边解边放密文`)
}
