/** PPSSPP 欠载掩蔽回归：断流与恢复都不能制造瞬时波形跳变。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../public/ppsspp/v0dbfaca/v10/audio-worklet.js', import.meta.url), 'utf8')
let Processor

class FakeAudioWorkletProcessor {
  constructor() {
    this.port = {
      messages: [],
      onmessage: null,
      postMessage: (message) => this.port.messages.push(message),
    }
  }
}

const context = {
  AudioWorkletProcessor: FakeAudioWorkletProcessor,
  SharedArrayBuffer,
  Uint32Array,
  Float32Array,
  Atomics,
  Math,
  currentFrame: 0,
  sampleRate: 48_000,
  registerProcessor(name, implementation) {
    assert.equal(name, 'ppsspp-audio')
    Processor = implementation
  },
}
vm.runInNewContext(source, context, { filename: 'audio-worklet.js' })
assert.equal(typeof Processor, 'function', 'AudioWorklet 必须注册处理器')

const memory = new SharedArrayBuffer(8192)
const u32 = new Uint32Array(memory)
const f32 = new Float32Array(memory)
const processor = new Processor()
const ringBase = 16
processor.port.onmessage({
  data: { type: 'init', memory, readSlot: 0, writeSlot: 1, ringBase, ringMask: 255 },
})

for (let frame = 0; frame < 64; frame++) {
  f32[ringBase + frame * 2] = 1
  f32[ringBase + frame * 2 + 1] = -1
}
Atomics.store(u32, 1, 64)
const first = [[new Float32Array(128), new Float32Array(128)]]
processor.process([], first)
assert.equal(first[0][0][63], 1, '有效采样不能被欠载掩蔽改写')
assert.ok(first[0][0][64] < 1 && first[0][0][64] > 0.9, '欠载起点应从最后采样平滑衰减')
assert.ok(Math.abs(first[0][0][127]) < 0.0001, '欠载尾部必须回到静音')

for (let frame = 64; frame < 192; frame++) {
  f32[ringBase + ((frame & 255) * 2)] = 1
  f32[ringBase + ((frame & 255) * 2) + 1] = -1
}
Atomics.store(u32, 1, 192)
context.currentFrame = 48_000 * 5
const second = [[new Float32Array(128), new Float32Array(128)]]
processor.process([], second)
assert.ok(second[0][0][0] > 0 && second[0][0][0] < 0.1, '恢复首帧必须淡入，不能从 0 突跳')
assert.equal(second[0][0][31], 1, '短淡入后必须恢复原始幅度')
assert.deepEqual(
  { ...processor.port.messages.at(-1) },
  { type: 'stats', underflows: 1, missingFrames: 64, sampleRate: 48_000 },
  '诊断必须同时报告欠载次数与真实缺失帧数',
)

console.log('✔ PSP AudioWorklet 欠载衰减、恢复淡入与缺失时长遥测通过')
