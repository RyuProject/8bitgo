/**
 * jsnes 的启动与音频回归测试。不需要浏览器、不需要真实 ROM。
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
 * 修复在 src/emulator/adapters/jsnes.ts 与 jsnesCompat.ts。这个测试同时盯三件事：
 *   1. 修复所依赖的 jsnes 内部接口还在不在（升级 jsnes 时会先在这里炸）
 *   2. 补完之后每帧产的采样数确实对得上声卡
 *   3. 开局崩溃会在 Browser 建立音频前被识别，改过音频链后 stop() 也不会再抛
 */
import { readFileSync } from 'node:fs'
import { NES } from 'jsnes'
import { installJsnesSafeStop, JSNES_PREFLIGHT_FRAMES, probeJsnesStartup } from '../src/emulator/jsnesCompat.ts'

let failed = 0
const ok = (name, cond, detail = '') => {
  if (!cond) failed++
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`)
}
const section = (t) => console.log(`\n── ${t} ──`)

/** NES 的真实帧率。每秒要产 sampleRate 个采样，摊到每帧就是这么多 */
const NES_FPS = 60.098
const perFrameNeeded = (rate) => rate / NES_FPS

/** 最小的合法 NROM 卡带：16KB PRG + 8KB CHR；默认程序体是 JMP 到自己 */
function makeRom(firstOpcode = 0x4c) {
  const out = new Uint8Array(16 + 16384 + 8192)
  out.set([0x4e, 0x45, 0x53, 0x1a, 1, 1], 0) // iNES 头：1 个 PRG 组、1 个 CHR 组
  out[16 + 0] = firstOpcode
  out[16 + 1] = 0x00
  out[16 + 2] = 0xc0
  out[16 + 0x3ffc] = 0x00 // RESET 向量 -> $C000
  out[16 + 0x3ffd] = 0xc0
  let s = ''
  for (const b of out) s += String.fromCharCode(b)
  return s
}
const ROM = makeRom()
const CRASH_ROM = makeRom(0x02) // 6502 的非法操作码：确定性模拟「loadROM 成功、第一帧才崩」

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

/* ============ 四、开局试跑能在 ready 之前识别核心崩溃 ============ */
section('开局兼容性自检')
ok('自检帧数足以覆盖第 7 帧崩溃，且保持有界', JSNES_PREFLIGHT_FRAMES >= 8 && JSNES_PREFLIGHT_FRAMES <= 30)
ok('正常 ROM 通过开局自检', probeJsnesStartup(NES, ROM) === null)
const startupError = probeJsnesStartup(NES, CRASH_ROM)
ok('loadROM 成功、运行时崩溃的 ROM 会被自检拦住', startupError instanceof Error)
ok('保留核心给出的原始错误，便于以后定位兼容性', /invalid opcode/i.test(startupError?.message ?? ''), startupError?.message)

/* ============ 五、音频改线后的 stop 不再掩盖原始核心错误 ============ */
section('音频改线后的安全停机')

class FakeNode {
  connections = new Set()

  connect(destination) {
    this.connections.add(destination)
    return destination
  }

  disconnect(destination) {
    if (arguments.length === 0) {
      this.connections.clear()
      return
    }
    if (!this.connections.delete(destination)) {
      const error = new Error('the given destination is not connected')
      error.name = 'InvalidAccessError'
      throw error
    }
  }
}

{
  const destination = {}
  const gainNode = {}
  const node = new FakeNode()
  node.connect(gainNode) // 站点改线后只有 node -> gain，没有 node -> destination
  let closed = 0
  let listenersRemoved = 0
  let stopped = 0
  const speakers = {
    node,
    audioCtx: {
      destination,
      close: () => {
        closed++
        return Promise.resolve()
      },
    },
    batchPos: 37,
    _removeResumeListeners: () => listenersRemoved++,
    stop() {
      this._removeResumeListeners()
      if (this.node) {
        this.node.disconnect(this.audioCtx.destination)
        this.node = null
      }
      if (this.audioCtx) {
        void this.audioCtx.close()
        this.audioCtx = null
      }
      this.batchPos = 0
    },
  }

  let upstreamThrows = false
  try {
    speakers.stop()
  } catch (error) {
    upstreamThrows = error?.name === 'InvalidAccessError'
  }
  ok('复现上游按特定 destination 断开时的 InvalidAccessError', upstreamThrows)

  // 上一次复现只在第一步就抛了，字段仍在，正好接着验证补丁能把它清干净。
  installJsnesSafeStop(speakers, () => true, () => stopped++)
  let safeStopThrew = false
  try {
    speakers.stop()
  } catch {
    safeStopThrew = true
  }
  ok('改线后的 safe stop 不再抛错', !safeStopThrew)
  ok('safe stop 仍完整释放 node / context / 批缓冲', speakers.node === null && speakers.audioCtx === null && speakers.batchPos === 0)
  ok('safe stop 仍摘监听并关闭 AudioContext', listenersRemoved === 2 && closed === 1)
  ok('适配器能同步清掉自己持有的 gain', stopped === 1)
}

{
  let nativeStops = 0
  let stopped = 0
  const speakers = { stop: () => nativeStops++ }
  installJsnesSafeStop(speakers, () => false, () => stopped++)
  speakers.stop()
  ok('没有改音频链时仍委托上游 stop', nativeStops === 1 && stopped === 1)
}

/* safe stop 镜像了这几项内部实现；升级 jsnes 时先在测试里明确失败，不能静默漂移。 */
const speakersSource = readFileSync(new URL('../node_modules/jsnes/src/browser/speakers.js', import.meta.url), 'utf8')
for (const token of [
  '_removeResumeListeners()',
  'this.node.disconnect(this.audioCtx.destination)',
  'this.audioCtx.close()',
  'this.batchPos = 0',
]) {
  ok(`jsnes 2.1.0 的停机契约仍包含 ${token}`, speakersSource.includes(token))
}

console.log(failed === 0 ? '\n全部通过 ✅' : `\n有 ${failed} 项失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
