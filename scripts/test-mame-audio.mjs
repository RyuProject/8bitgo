/**
 * MAME 音频窗口（src/emulator/mameAudio.ts）的回归测试。
 *
 *   npm run test:mame-audio
 *
 * 为什么值得测：这一块的两类错误**全都不报错**。
 *   1. 纯函数改错行 → cfg 里出现两行 audio_latency（或者根本没写进去），
 *      核心照旧按 64ms 跑，玩家听到的还是毛刺，而日志里一句提示都没有。
 *   2. **引擎换了版本** → cfg 路径变了、或者它不再写 audio_latency，
 *      我们的覆盖就落在一份没人读的文件上（或者被后写的 64 盖回去），
 *      同样是静默失效。所以这里把引擎里那两处字面量一起钉住。
 *
 * 取证方式：`public/emulatorjs/emulator.min.js` 里 `getRetroArchCfg()` 的那段
 * （`autosave_interval = 60\n…\naudio_latency = 64\n…`），以及写盘时用的绝对路径。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MAME_AUDIO_LATENCY_MS, RETROARCH_CFG_PATH, raiseAudioLatency } from '../src/emulator/mameAudio.ts'

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

const ENGINE = 'public/emulatorjs/emulator.min.js'

/** 引擎写的那份 cfg 长这样（真实内容，只摘了头尾） */
const ENGINE_CFG = [
  'autosave_interval = 60',
  'screenshot_directory = "/"',
  'block_sram_overwrite = false',
  'video_gpu_screenshot = false',
  'audio_latency = 64',
  'video_top_portrait_viewport = true',
  'savefile_directory = "/data/saves"',
  '',
].join('\n')

console.log('\nMAME 音频窗口')

check('窗口必须比引擎默认的 64ms 大（否则这个修复没意义）', () => {
  assert.ok(MAME_AUDIO_LATENCY_MS > 64, `当前 ${MAME_AUDIO_LATENCY_MS}`)
})

check('128 窗口在 48kHz 下正好是整数帧（日志里 Buffer size = 49152）', () => {
  const frames = Math.round((MAME_AUDIO_LATENCY_MS * 48000) / 1000)
  assert.equal(frames * 2 * 4, 49152, `推出来 ${frames * 8} bytes，和预期不一致`)
})

check('就地改掉引擎写死那一行，其它行一个字都不动', () => {
  const out = raiseAudioLatency(ENGINE_CFG, 128)
  assert.ok(out.includes(`audio_latency = ${MAME_AUDIO_LATENCY_MS}`), '没写进去')
  assert.ok(!out.includes('audio_latency = 64'), '旧的那行还留着（两行会让人不知道哪行生效）')
  assert.equal(
    out.replace(/audio_latency = \d+/, 'X'),
    ENGINE_CFG.replace(/audio_latency = \d+/, 'X'),
    '除了那一行之外还动了别的地方',
  )
})

check('幂等：再跑一次结果完全相同（钩子跑两次不会把文件改脏）', () => {
  const once = raiseAudioLatency(ENGINE_CFG, 128)
  assert.equal(raiseAudioLatency(once, 128), once)
})

check('cfg 里本来没有这一项 → 追加在末尾（后写能覆盖引擎的默认）', () => {
  const out = raiseAudioLatency('autosave_interval = 60\n', 128)
  assert.ok(out.trimEnd().endsWith(`audio_latency = ${MAME_AUDIO_LATENCY_MS}`), out)
})

check('多行 audio_latency 只留一条', () => {
  const out = raiseAudioLatency('audio_latency = 32\naudio_latency = 64\n', 128)
  assert.equal(out.split('\n').filter((l) => l.trim().startsWith('audio_latency')).length, 1, out)
})

check('空 cfg 也不炸', () => {
  assert.equal(raiseAudioLatency('', 128), `audio_latency = ${MAME_AUDIO_LATENCY_MS}`)
})

check('引擎的 cfg 路径和我们写的那份一致（引擎换版本要重新取证）', () => {
  const engine = readFileSync(ENGINE, 'utf8')
  assert.ok(engine.includes(RETROARCH_CFG_PATH), `${ENGINE} 里找不到 ${RETROARCH_CFG_PATH}`)
})

check('引擎确实还在写死 audio_latency = 64（不再写就可以考虑收掉这个补丁）', () => {
  const engine = readFileSync(ENGINE, 'utf8')
  assert.ok(/audio_latency = 64/.test(engine), `${ENGINE} 里已经没有 audio_latency = 64，重新取证后再决定要不要保留`)
})

console.log(failed === 0 ? '\nMAME 音频窗口测试通过\n' : `\nMAME 音频窗口测试失败：${failed} 项\n`)
process.exit(failed === 0 ? 0 : 1)
