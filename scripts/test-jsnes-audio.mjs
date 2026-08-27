/**
 * jsnes 的采样率回归测试。不需要浏览器、不需要 ROM。
 *
 *   node scripts/test-jsnes-audio.mjs
 *
 * 防的是这个 bug：jsnes 的 Browser 在构造 NES 时写的是
 * `sampleRate: this._speakers.getSampleRate()`，而那一刻 audioCtx 还没建，
 * 只能返回兜底值 44100。等 AudioContext 真起来用的是声卡原生采样率（通常 48000）——
 * 核心按 44100 产样本、worklet 按 48000 消费，永远产不够，
 * 于是 underrun 处理里的「连跑两帧追音频」接管了时钟，游戏跑快约 9%
 * （96kHz 的声卡就是 2.18 倍速）。
 *
 * 修复在 src/emulator/adapters/jsnes.ts 的 attachAudio()：等 worklet 就绪后
 * 把真实采样率补给 papu。这个测试同时盯两件事：
 *   1. 修复所依赖的 jsnes 内部接口还在不在（升级 jsnes 时会先在这里炸）
 *   2. 补完之后每帧产的采样数确实对得上声卡
 */
import { NES } from 'jsnes'

let failed = 0
const ok = (name, cond, detail = '') => {
  if (!cond) failed++
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`)
}
const section = (t) => console.log(`\n── ${t} ──`)

/** NES 的真实帧率。每秒要产 sampleRate 个采样，摊到每帧就是这么多 */
const NES_FPS = 60.098
const perFrameNeeded = (rate) => rate / NES_FPS

/** 最小的合法 NROM 卡带：16KB PRG + 8KB CHR，程序体是 JMP 到自己 */
function makeRom() {
  const out = new Uint8Array(16 + 16384 + 8192)
  out.set([0x4e, 0x45, 0x53, 0x1a, 1, 1], 0) // iNES 头：1 个 PRG 组、1 个 CHR 组
  out[16 + 0] = 0x4c // JMP $C000
  out[16 + 1] = 0x00
  out[16 + 2] = 0xc0
  out[16 + 0x3ffc] = 0x00 // RESET 向量 -> $C000
  out[16 + 0x3ffd] = 0xc0
  let s = ''
  for (const b of out) s += String.fromCharCode(b)
  return s
}
const ROM = makeRom()

/**
 * 跑若干帧，数每帧产多少个音频采样。
 * fixTo 不为空时，模拟 attachAudio() 的修复动作。
 */
function samplesPerFrame(constructedWith, fixTo = null) {
  let n = 0
  const nes = new NES({ sampleRate: constructedWith, onAudioSample: () => n++, onFrame: () => {} })
  nes.loadROM(ROM)
  if (fixTo) {
    nes.opts.sampleRate = fixTo
    nes.papu.sampleRate = fixTo
    nes.setFramerate(60)
  }
  const FRAMES = 120
  n = 0
  for (let i = 0; i < FRAMES; i++) nes.frame()
  return n / FRAMES
}

const off = (got, want) => Math.abs(got - want) / want

/* ============ 一、修复依赖的接口还在吗 ============ */
section('修复依赖的 jsnes 内部接口')
{
  const nes = new NES({ sampleRate: 44100, onAudioSample: () => {}, onFrame: () => {} })
  nes.loadROM(ROM)
  ok('nes.opts.sampleRate 存在', typeof nes.opts?.sampleRate === 'number')
  ok('nes.papu.sampleRate 存在', typeof nes.papu?.sampleRate === 'number')
  ok('nes.setFramerate 是函数', typeof nes.setFramerate === 'function')
}

/* ============ 二、复现问题 ============ */
section('采样率对不上会让游戏跑快')
const need48 = perFrameNeeded(48000)
const broken = samplesPerFrame(44100)
const speedUp = need48 / broken

ok(
  '核心以为 44100 时，每帧产的采样喂不饱 48kHz 声卡',
  broken < need48 * 0.95,
  `每帧 ${broken.toFixed(1)} 个，48kHz 要 ${need48.toFixed(1)} 个`,
)
ok(
  '差额会让游戏跑到 65 fps 左右',
  speedUp > 1.05 && speedUp < 1.15,
  `${(speedUp * NES_FPS).toFixed(1)} fps，快 ${(speedUp * 100 - 100).toFixed(1)}%`,
)

/* ============ 三、修复有效 ============ */
section('补上真实采样率之后')
const fixed48 = samplesPerFrame(44100, 48000)
const native48 = samplesPerFrame(48000)

ok('48kHz：每帧采样数对得上', off(fixed48, need48) < 0.01, `每帧 ${fixed48.toFixed(1)} 个`)
ok('48kHz：和「构造时就传对」完全一致', Math.abs(fixed48 - native48) < 0.01)
ok('48kHz：速度回到 60 fps', off((need48 / fixed48) * NES_FPS, NES_FPS) < 0.01)

for (const rate of [44100, 96000]) {
  const need = perFrameNeeded(rate)
  const got = samplesPerFrame(44100, rate)
  ok(`${rate} Hz 的声卡也对得上`, off(got, need) < 0.01, `每帧 ${got.toFixed(1)} 个，需要 ${need.toFixed(1)} 个`)
}

console.log(failed === 0 ? '\n全部通过 ✅' : `\n有 ${failed} 项失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
