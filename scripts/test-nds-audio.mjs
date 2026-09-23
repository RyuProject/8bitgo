/** NDS 音频缓冲的静默回归守卫；原生旋转由 test:nds-layout 验证。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { raiseAudioLatency } from '../src/emulator/mameAudio.ts'
import { NDS_AUDIO_BUFFER_BYTES_48K, NDS_AUDIO_LATENCY_MS } from '../src/emulator/ndsAudio.ts'

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
}

check('NDS 从引擎默认 64ms 提到 96ms，但不吃 MAME 的 128ms 延迟', () => {
  assert.equal(NDS_AUDIO_LATENCY_MS, 96)
  assert.ok(NDS_AUDIO_LATENCY_MS > 64 && NDS_AUDIO_LATENCY_MS < 128)
})

check('96ms 在 48kHz 双声道 Float32 下应是 36864 bytes', () => {
  assert.equal(NDS_AUDIO_BUFFER_BYTES_48K, 36_864)
})

check('补丁只改 audio_latency，重复执行幂等', () => {
  const before = 'video_vsync = true\naudio_latency = 64\naudio_volume = 0.0\n'
  const once = raiseAudioLatency(before, NDS_AUDIO_LATENCY_MS)
  const twice = raiseAudioLatency(once, NDS_AUDIO_LATENCY_MS)
  assert.equal(once, 'video_vsync = true\naudio_latency = 96\naudio_volume = 0.0\n')
  assert.equal(twice, once)
})

const adapter = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
const code = adapter.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

check('NDS 开局前确实进入音频缓冲计划，不是只定义了常量', () => {
  assert.match(code, /options\.platform === 'nds'[\s\S]{0,180}NDS_AUDIO_LATENCY_MS/)
  assert.match(code, /raiseCoreAudioLatency\?\.\(emu\)/)
})

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
