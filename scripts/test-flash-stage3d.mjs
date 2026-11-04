/**
 * Stage3D 游戏优先走 Ruffle 的 WebGPU 后端（src/emulator/flashStage3D.ts）。
 *
 * 背景（2026-11-05《传染恐慌：幸存者》，Starling）：Ruffle 默认 wgpu-webgl，菜单每帧 24ms 只有 40 FPS；
 * WebGPU 同场景 0.2～3ms 稳 60。webgl / canvas 后端没有 Context3D，直接黑屏。
 * 锁住：FWS / CWS 都能认出 `flash.display3D`、跨解压块命中、太老 / ZWS / 损坏 / 超时一律不改后端、
 * 没有 navigator.gpu 时不扫，以及适配器确实把结果接进了 Ruffle 配置。
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { ruffleRendererPreference, swfUsesStage3D, swfVersionOf, STAGE3D_MIN_SWF_VERSION } from '../src/emulator/flashStage3D.ts'

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ❌ ${name}\n     ${error?.stack ?? error}`)
  }
}

const body = (text, padding = Buffer.alloc(0)) => Buffer.concat([padding, Buffer.from(text, 'latin1'), Buffer.from([0, 1, 2])])
function swf(signature, version, payload) {
  const header = Buffer.alloc(8)
  header.write(signature, 0, 'latin1')
  header[3] = version
  header.writeUInt32LE(payload.length + 8, 4)
  const rest = signature === 'CWS' ? deflateSync(payload) : payload
  return new Uint8Array(Buffer.concat([header, rest]))
}
const STARLING = 'starling.core\0flash.display3D\0Context3D'

await check('FWS 明文：认出 flash.display3D', async () => {
  assert.equal(await swfUsesStage3D(swf('FWS', 25, body(STARLING))), true)
})

await check('⚠️ CWS（zlib）：边解边找', async () => {
  assert.equal(await swfUsesStage3D(swf('CWS', 25, body(STARLING))), true)
  assert.equal(await swfUsesStage3D(swf('CWS', 25, body('flash.display.Sprite\0flash.media.Sound'))), false)
})

await check('大文件末尾 + 不可压缩填充：跨很多解压块也能命中（尾巴拼接）', async () => {
  const padded = body('flash.display3D', randomBytes(3 * 1024 * 1024 + 7))
  assert.equal(await swfUsesStage3D(swf('CWS', 25, padded)), true)
  // 只差一个字节的近似串不能误判
  assert.equal(await swfUsesStage3D(swf('CWS', 25, body('flash.display3X', randomBytes(1024 * 1024)))), false)
})

await check(`SWF 版本 < ${STAGE3D_MIN_SWF_VERSION}（Flash Player 11 之前没有 Stage3D）不扫`, async () => {
  assert.equal(await swfUsesStage3D(swf('FWS', 12, body(STARLING))), false)
  assert.equal(swfVersionOf(swf('CWS', 10, body('x'))), 10)
})

await check('ZWS / 非 SWF / 截断的压缩流：不猜，返回 false', async () => {
  const zws = swf('FWS', 25, body(STARLING))
  zws[0] = 0x5a
  assert.equal(await swfUsesStage3D(zws), false)
  assert.equal(await swfUsesStage3D(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])), false)
  const broken = swf('CWS', 25, body(STARLING, randomBytes(200000)))
  assert.equal(await swfUsesStage3D(broken.subarray(0, 4000)), false)
})

await check('超时不拖启动：返回 false', async () => {
  const padded = swf('CWS', 25, body('flash.display3D', randomBytes(4 * 1024 * 1024)))
  assert.equal(await swfUsesStage3D(padded, { timeoutMs: -1 }), false)
})

await check('扫描不能动原始字节（Ruffle 接着要用同一份 ArrayBuffer）', async () => {
  const data = swf('CWS', 25, body(STARLING))
  const copy = data.slice()
  await swfUsesStage3D(data.buffer)
  assert.equal(data.byteLength, copy.byteLength, 'ArrayBuffer 不能被 detach')
  assert.deepEqual(data, copy)
})

await check('渲染偏好：只有 Stage3D + navigator.gpu 才要 webgpu', async () => {
  const stage3d = swf('CWS', 25, body(STARLING))
  const plain = swf('CWS', 25, body('flash.display.Sprite'))
  assert.deepEqual(await ruffleRendererPreference(stage3d, { gpu: {} }), { preferredRenderer: 'webgpu', stage3D: true })
  assert.deepEqual(await ruffleRendererPreference(plain, { gpu: {} }), { stage3D: false })
  assert.deepEqual(await ruffleRendererPreference(stage3d, {}), { stage3D: false }, '没有 WebGPU 时 Ruffle 默认就是 wgpu-webgl，不扫')
})

await check('适配器把偏好接进 Ruffle 配置（与旧 SDK 规则并行算，不串行拖启动）', () => {
  const adapter = readFileSync(new URL('../src/emulator/adapters/ruffle.ts', import.meta.url), 'utf8')
  assert.match(adapter, /ruffleRendererPreference\(loaded\.data, win\.navigator\)/)
  assert.match(adapter, /Promise\.all\(\[\s*flashLegacyBundleRules\(/)
  assert.match(adapter, /\.\.\.\(renderer\.preferredRenderer \? \{ preferredRenderer: renderer\.preferredRenderer \} : \{\}\)/)
})

console.log(failed === 0 ? '\nStage3D → WebGPU 渲染偏好回归通过\n' : `\n失败 ${failed} 项\n`)
process.exit(failed === 0 ? 0 : 1)
