/**
 * IodineGBA（GBA 在禁用 WebAssembly 浏览器里的纯 JS 退路）回归。
 *
 *   npm run test:iodinegba
 *
 * 1. 发布物：打包核心、版本戳、两份 MIT 许可证、开源替代 BIOS 的摘要。
 * 2. 端到端：在**删掉 WebAssembly** 的 vm 里跑 public/iodinegba/iodinegba.js，装上随站的开源 BIOS，
 *    喂一个手写的 512 字节测试卡带（不涉及任何商业 ROM）—— 它把显示模式设成 Mode 3、在左上角画一个红点。
 *    SKIPBoot 打开时要出红点；关掉时开源 BIOS 的开机动画走不完、画面一直空白（这就是适配器必须 SKIPBoot 的原因）。
 * 3. 音频队列：AudioContext 没在放时不参与调速（remainingBuffer 返回 undefined），否则核心会被压到 0%。
 * 4. 适配器源码形状：没绑官方 BIOS 用开源 BIOS、不再报「请先配置」。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url))
const text = (p) => read(p).toString('utf8')
let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ❌ ${name}\n     ${error.message}`)
  }
}

const adapter = text('src/emulator/adapters/iodinegba.ts')
const biosSha = /OPEN_GBA_BIOS_SHA256 = '([0-9a-f]{64})'/.exec(adapter)?.[1]
const bundle = read('public/iodinegba/iodinegba.js')
const bios = read('public/iodinegba/gba-bios-cult-of-gba.bin')

console.log('一、发布物')
check('打包核心的版本戳就是内容 SHA-256 前 16 位（换核心必换 URL）', () => {
  const stamp = /IODINEGBA_BUILD = '([0-9a-f]{16})'/.exec(text('src/emulator/iodinegbaVersion.ts'))?.[1]
  assert.equal(stamp, createHash('sha256').update(bundle).digest('hex').slice(0, 16))
})
check('压缩产物保留 MIT 声明，目录里带完整许可证（IodineGBA 与开源 BIOS 各一份）', () => {
  assert.match(bundle.subarray(0, 200).toString(), /^\/\*! IodineGBA \(C\) .*Grant Galitz, MIT/)
  assert.match(text('public/iodinegba/LICENSE'), /Grant Galitz/)
  assert.match(text('public/iodinegba/LICENSE'), /Permission is hereby granted/)
  assert.match(text('public/iodinegba/LICENSE-gba-bios'), /DenSinH and fleroviux/)
})
check('开源 BIOS 正好 16 KiB，摘要与适配器、UPSTREAM.md 一致', () => {
  assert.equal(bios.length, 0x4000)
  assert.ok(biosSha, '适配器里缺 OPEN_GBA_BIOS_SHA256')
  assert.equal(createHash('sha256').update(bios).digest('hex'), biosSha)
  assert.ok(text('vendor/iodinegba/UPSTREAM.md').includes(biosSha))
  assert.ok(adapter.includes('`${BASE}/gba-bios-cult-of-gba.bin?v=${OPEN_GBA_BIOS_SHA256.slice(0, 16)}`'))
})

console.log('二、端到端：没有 WebAssembly 的 vm 里跑真核心')
/** 512 字节测试卡带：b 0xC0 → Mode 3 + BG2 → VRAM[0] = 0x001F（红）→ 原地循环 */
function testRom() {
  const rom = new Uint8Array(0x200)
  const view = new DataView(rom.buffer)
  const words = (at, list) => list.forEach((w, i) => view.setUint32(at + i * 4, w >>> 0, true))
  words(0x00, [0xea00002e]) // b 0xC0
  rom.set(new TextEncoder().encode('8BITGO TEST '), 0xa0)
  rom.set(new TextEncoder().encode('T8BG01'), 0xac)
  words(0xc0, [
    0xe3a00301, // mov r0, #0x04000000
    0xe3a01b01, // mov r1, #0x400
    0xe2811003, // add r1, r1, #3      ; DISPCNT = Mode 3 | BG2
    0xe1c010b0, // strh r1, [r0]
    0xe3a00406, // mov r0, #0x06000000
    0xe3a0101f, // mov r1, #0x1F       ; 红
    0xe1c010b0, // strh r1, [r0]
    0xeafffffe, // b .
  ])
  return rom
}

function runCore(skipBoot) {
  const sandbox = {}
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.navigator = { userAgent: 'node' }
  const context = vm.createContext(sandbox)
  // 和玩家那台浏览器一样：根本没有 WebAssembly
  vm.runInContext('delete globalThis.WebAssembly', context)
  assert.equal(vm.runInContext('typeof WebAssembly', context), 'undefined')
  vm.runInContext(bundle.toString('utf8'), context, { filename: 'iodinegba.js' })
  const Core = sandbox.IodineGBA
  assert.equal(typeof Core, 'function', 'bundle 没有导出 window.IodineGBA')
  const core = new Core()
  core.settings.offthreadGfxEnabled = false
  core.settings.SKIPBoot = skipBoot
  let frame = null
  let frames = 0
  core.attachPlayStatusHandler(() => {})
  core.attachSaveImportHandler((_name, _found, missing) => missing())
  core.attachSaveExportHandler(() => {})
  core.attachGraphicsFrameHandler({ copyBuffer: (buffer) => { frames++; frame = Uint8Array.from(buffer.subarray ? buffer.subarray(0, 3) : Array.from(buffer).slice(0, 3)) } })
  core.attachROM(testRom())
  core.attachBIOS(new Uint8Array(bios))
  core.setIntervalRate(16)
  core.play()
  assert.equal(core.emulatorStatus & 0x1, 0x1, '核心没能用开源 BIOS + 测试卡带初始化')
  for (let t = 16; t <= 16 * 40; t += 16) core.timerCallback(t)
  return { frames, pixel: frame ? [...frame] : null }
}

check('SKIPBoot：开源 BIOS 下测试卡带出画面，左上角是红点', () => {
  const { frames, pixel } = runCore(true)
  // 画面不变时核心不重复交帧，所以只要求至少出过一帧
  assert.ok(frames >= 1, '一帧都没出')
  assert.ok(pixel && pixel[0] > 200 && pixel[1] < 40 && pixel[2] < 40, `左上角像素 ${JSON.stringify(pixel)}，不是红色`)
})
check('不 SKIPBoot：开源 BIOS 的开机动画在 IodineGBA 里走不完，卡带从没画上去（所以适配器必须 SKIPBoot）', () => {
  const { pixel } = runCore(false)
  assert.ok(!pixel || !(pixel[0] > 200 && pixel[1] < 40 && pixel[2] < 40), '开源 BIOS 现在能完整开机了：可以重新评估是否保留 SKIPBoot')
})

console.log('三、音频队列：AudioContext 没在放时不参与调速')
{
  const { transformSync } = await import('esbuild')
  const fnSource = adapter.match(/export function createIodineAudioQueue[\s\S]*?\n\}\n/)?.[0]
  assert.ok(fnSource, '缺 createIodineAudioQueue')
  const js = transformSync(fnSource.replace(/^export /, ''), { loader: 'ts' }).code
  const ctx = { Float32Array, Math }
  vm.runInNewContext(`${js};globalThis.make=createIodineAudioQueue`, ctx)
  let running = false
  const q = ctx.make(() => 48_000, () => running, 1 << 12)
  q.handler.initialize(2, 44_100, 0)
  const block = new Float32Array(882 * 2).fill(0.5)
  check('挂起时 remainingBuffer 是 undefined（上游只按数字调速），推入的样本被丢掉', () => {
    q.handler.setBufferSpace(1000)
    q.handler.push(block, 0, block.length)
    assert.equal(q.handler.remainingBuffer(), undefined)
    assert.equal(q.buffered(), 0)
  })
  check('放起来以后按输出采样率重采样入队，水位按真实样本数报告', () => {
    running = true
    q.handler.push(block, 0, block.length)
    const remaining = q.handler.remainingBuffer()
    assert.equal(typeof remaining, 'number')
    // 882 帧 @44.1k → 约 960 帧 @48k，交错立体声约 1920 个样本
    assert.ok(Math.abs(remaining - 1920) <= 4, `水位 ${remaining}`)
    const left = new Float32Array(256)
    const right = new Float32Array(256)
    q.pull(left, right)
    assert.ok(Math.abs(left[10] - 0.5) < 1e-6 && Math.abs(right[10] - 0.5) < 1e-6)
  })
  check('再次挂起又恢复：丢掉挂起前的旧样本，不带着旧声音延迟', () => {
    running = false
    assert.equal(q.handler.remainingBuffer(), undefined)
    running = true
    assert.equal(q.handler.remainingBuffer(), 0)
  })
}

console.log('四、适配器')
check('没绑官方 BIOS 时用开源 BIOS，不再报「请先在后台配置」', () => {
  assert.match(adapter, /if \(!biosUrl\) \{\s*biosUrl = OPEN_GBA_BIOS_URL/)
  assert.doesNotMatch(adapter, /throw new IodineStartupError\([^)]*请先在后台配置/)
  // 本地实测这个接口 502 / 十几秒才回时，整局停在「正在准备模拟器 14%」：失败和慢都不能挡住开局
  assert.match(adapter, /await Promise\.race\(\[\s*fetchPlatformBios\(\)\.catch\(\(\) => undefined\),\s*new Promise<void>\(\(resolve\) => \{ waitTimer = setTimeout\(resolve, BIOS_MAP_WAIT_MS\) \}\),\s*\]\)\s*\/\/[^\n]*\n\s*clearTimeout\(waitTimer\)/, 'BIOS 映射接口要限时等待，并清掉定时器')
  assert.match(adapter, /const BIOS_MAP_WAIT_MS = 3_000/)
})
check('一律 SKIPBoot，并在测出慢速时提示（关了 JIT 的浏览器只有一二成速度）', () => {
  assert.match(adapter, /instance\.settings\.SKIPBoot = true/)
  assert.match(adapter, /attachSpeedHandler\(/)
  assert.match(adapter, /showSlowNotice\(surface, percent\)/)
  for (const lang of ['zh-Hans', 'zh-Hant', 'en', 'es', 'de', 'it', 'fr', 'ja']) {
    const locale = text(`src/locales/${lang}.ts`)
    assert.match(locale, /iodinegbaDesc: '/, `${lang} 缺 iodinegbaDesc`)
    assert.match(locale, /iodinegbaSlow: '[^\n]*\{percent\}/, `${lang} 缺 iodinegbaSlow`)
  }
  assert.match(text('src/emulator/runtimeMeta.ts'), /get description\(\) \{\s*return getT\(\)\.runtime\.iodinegbaDesc/)
})
check('路由：GBA 没有 WebAssembly 时走 IodineGBA，后台固定的 EmulatorJS 拦不回去', () => {
  const registry = text('src/emulator/registry.ts')
  const iodine = registry.indexOf("platform === 'gba' && ctx.gbaWasmUnavailable")
  const override = registry.indexOf('if (ctx.runtimeOverride && !overrideNeedsWebgl)')
  assert.ok(iodine > 0 && override > iodine, 'IodineGBA 退路要排在逐游戏覆盖之前')
  assert.match(text('shared/wasm-free-platforms.js'), /'gba'/)
})

console.log(failed ? `\n${failed} 项未通过` : '\ntest:iodinegba 通过')
process.exit(failed ? 1 : 0)
