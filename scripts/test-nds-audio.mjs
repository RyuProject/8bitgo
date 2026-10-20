/** NDS 音频缓冲的静默回归守卫；原生旋转由 test:nds-layout 验证。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { raiseAudioLatency } from '../src/emulator/mameAudio.ts'
import {
  NDS_AUDIO_BUFFER_BYTES_48K,
  NDS_AUDIO_LATENCY_MS,
  NDS_RHYTHM_AUDIO_LATENCY_MS,
  ndsAudioLatencyMs,
} from '../src/emulator/ndsAudio.ts'

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

check('普通 NDS 用 128ms 抵御短任务；节奏游戏仍保留 96ms', () => {
  assert.equal(NDS_AUDIO_LATENCY_MS, 128)
  assert.equal(NDS_RHYTHM_AUDIO_LATENCY_MS, 96)
  assert.equal(ndsAudioLatencyMs('pokemon-white-2'), 128)
  assert.equal(ndsAudioLatencyMs('pokemon-white-2:melonds-compat'), 128)
  assert.equal(ndsAudioLatencyMs('rhythm-heaven'), 96)
  assert.equal(ndsAudioLatencyMs('rhythm-heaven:melonds-compat'), 96)
  assert.equal(ndsAudioLatencyMs('rhythm-heaven~nds-en:melonds-compat'), 96)
  assert.equal(ndsAudioLatencyMs(undefined), 128)
})

check('128ms 在 48kHz 双声道 Float32 下应是 49152 bytes', () => {
  assert.equal(NDS_AUDIO_BUFFER_BYTES_48K, 49_152)
})

check('补丁只改 audio_latency，重复执行幂等', () => {
  const before = 'video_vsync = true\naudio_latency = 64\naudio_volume = 0.0\n'
  const once = raiseAudioLatency(before, NDS_AUDIO_LATENCY_MS)
  const twice = raiseAudioLatency(once, NDS_AUDIO_LATENCY_MS)
  assert.equal(once, 'video_vsync = true\naudio_latency = 128\naudio_volume = 0.0\n')
  assert.equal(twice, once)
  assert.equal(raiseAudioLatency(before, ndsAudioLatencyMs('rhythm-heaven')), 'video_vsync = true\naudio_latency = 96\naudio_volume = 0.0\n')
})

const adapter = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
const code = adapter.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

check('NDS 开局前确实进入音频缓冲计划，不是只定义了常量', () => {
  assert.match(code, /options\.platform === 'nds'[\s\S]{0,200}ndsAudioLatencyMs\(options\.gameSlug\)/)
  assert.match(code, /raiseCoreAudioLatency\?\.\(emu\)/)
  assert.match(code, /installAudioTap\(win, options\.platform === 'nds' \? 'shared-output' : 'direct-tap'\)/)
})

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
