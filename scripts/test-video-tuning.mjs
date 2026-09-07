/**
 * 推流编码参数（src/emulator/videoTuning.ts）的回归测试。
 *
 *   npm run test:video-tuning
 *
 * 为什么值得测：这块的错误**不会报错**，只会让画面看起来「就是有点糊」——
 * 没人会为此报 bug，而它恰恰是观众对直播质量的全部感受。
 * 尤其是分档那条线：判错一次，红白机的画面就会被缩成马赛克。
 */
import assert from 'node:assert/strict'
import { tuningFor, fpsForViewers, RETRO_MAX_PIXELS, usableVideoSize, MIN_VIDEO_EDGE } from '../src/emulator/videoTuning.ts'

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

/** 站上真实存在的几种源分辨率 */
const SOURCES = {
  gb: [160, 144],
  nes: [256, 240],
  gba: [240, 160],
  snes: [256, 224],
  psx: [320, 240],
  megadrive: [320, 224],
  dos: [640, 480],
  n64: [640, 480],
  tab720p: [1280, 720],
}

console.log('一、分档：小源保分辨率，大源保帧率')

for (const [name, [w, h]] of Object.entries(SOURCES)) {
  const big = w * h > RETRO_MAX_PIXELS
  check(`${name} ${w}×${h} → ${big ? '保帧率 / motion' : '保分辨率 / detail'}`, () => {
    const t = tuningFor({ width: w, height: h, fps: 30 })
    assert.equal(t.retro, !big)
    assert.equal(t.degradationPreference, big ? 'maintain-framerate' : 'maintain-resolution')
    assert.equal(t.contentHint, big ? 'motion' : 'detail')
  })
}

check('分界线本身（320×240）算像素画', () => {
  const t = tuningFor({ width: 320, height: 240, fps: 30 })
  assert.equal(t.retro, true, '320×240 是 PS1 / 多数街机板子的分辨率，必须在像素画这一档')
})

check('刚过界一格就换档', () => {
  assert.equal(tuningFor({ width: 321, height: 240, fps: 30 }).retro, false)
})

check('拿不到宽高时按大源处理（猜错的代价不对称）', () => {
  const t = tuningFor({ fps: 30 })
  assert.equal(t.retro, false)
  assert.equal(t.degradationPreference, 'maintain-framerate', '把大源当小源会让 640×480 掉到个位数帧率，那是没法玩的')
  assert.equal(t.contentHint, 'motion')
})

console.log('二、码率按像素数走')

check('小机型比原来的固定 1.5Mbps 省', () => {
  const gb = tuningFor({ width: 160, height: 144, fps: 30 }).maxBitrate
  assert.ok(gb < 1_500_000, `Game Boy 应低于原来的 1.5Mbps，实际 ${gb}`)
})

check('大机型比原来的固定 1.5Mbps 多', () => {
  const dos = tuningFor({ width: 640, height: 480, fps: 30 }).maxBitrate
  assert.ok(dos > 1_500_000, `640×480 应高于原来的 1.5Mbps，实际 ${dos}`)
})

check('像素数越大码率越大（单调）', () => {
  let prev = 0
  for (const [w, h] of [[160, 144], [256, 240], [320, 240], [640, 480], [1280, 720]]) {
    const b = tuningFor({ width: w, height: h, fps: 30 }).maxBitrate
    assert.ok(b >= prev, `${w}×${h} 的码率不该比更小的源低`)
    prev = b
  }
})

check('有下限：再小的画面也不至于低到出块', () => {
  const tiny = tuningFor({ width: 64, height: 64, fps: 30 }).maxBitrate
  assert.ok(tiny >= 1_000_000, `下限应至少 1Mbps，实际 ${tiny}`)
})

check('有上限：家宽上行还要乘以观众数', () => {
  const huge = tuningFor({ width: 3840, height: 2160, fps: 60 }).maxBitrate
  assert.ok(huge <= 6_000_000, `上限应不超过 6Mbps，实际 ${huge}`)
})

check('调用方给了固定码率就听它的（分享标签页那条路自己算过）', () => {
  assert.equal(tuningFor({ width: 160, height: 144, fps: 30, maxBitrate: 4_000_000 }).maxBitrate, 4_000_000)
})

check('下限可以调高（联机对画质要求比直播高）', () => {
  const live = tuningFor({ width: 256, height: 240, fps: 30 }).maxBitrate
  const netplay = tuningFor({ width: 256, height: 240, fps: 30, minBitrate: 2_000_000 }).maxBitrate
  assert.ok(netplay > live, '联机的下限更高，同一个源应该给得更多')
  assert.equal(netplay, 2_000_000)
})

check('帧率原样带出去', () => {
  assert.equal(tuningFor({ width: 256, height: 240, fps: 20 }).maxFramerate, 20)
})

console.log('三、观众数前馈降帧')

check('3 人以内不降', () => {
  for (const n of [0, 1, 2, 3]) assert.equal(fpsForViewers(n, 30), 30)
})

check('4~6 人降到 24', () => {
  for (const n of [4, 5, 6]) assert.equal(fpsForViewers(n, 30), 24)
})

check('7 人以上降到 20', () => {
  for (const n of [7, 12, 50]) assert.equal(fpsForViewers(n, 30), 20)
})

check('单调不增：人越多帧率只会更低', () => {
  let prev = Number.POSITIVE_INFINITY
  for (let n = 0; n <= 20; n++) {
    const f = fpsForViewers(n, 30)
    assert.ok(f <= prev, `观众数 ${n} 时帧率反而升了`)
    prev = f
  }
})

check('绝不超过采集帧率（源头只有这么多帧，写高了只是骗自己）', () => {
  for (const n of [0, 5, 10]) assert.ok(fpsForViewers(n, 15) <= 15)
})

console.log('四、废画面（2×2 黑屏那次）')

check('线上真实出过的那个尺寸：2×2 判为不可用', () => {
  assert.equal(usableVideoSize(2, 2), false)
})

check('站上最小的真源 Game Boy 160×144 必须可用', () => {
  assert.equal(usableVideoSize(160, 144), true)
  // 其余真实机型顺带全过一遍：这条线一旦划错，误伤的是正常直播
  for (const [name, [w, h]] of Object.entries(SOURCES)) {
    assert.ok(usableVideoSize(w, h), `${name} ${w}×${h} 被判成废画面了`)
  }
})

check('边界正好在 MIN_VIDEO_EDGE 上，取等号算可用', () => {
  assert.equal(usableVideoSize(MIN_VIDEO_EDGE, MIN_VIDEO_EDGE), true)
  assert.equal(usableVideoSize(MIN_VIDEO_EDGE - 1, MIN_VIDEO_EDGE), false)
  assert.equal(usableVideoSize(MIN_VIDEO_EDGE, MIN_VIDEO_EDGE - 1), false)
})

check('尺寸未知（0 / undefined / NaN）一律算不可用', () => {
  // 「还没有画面」和「画面是废的」由调用方分：这个函数只回答尺寸能不能看。
  // 观众端就是靠先判 videoWidth > 0 再问这里，才不会把开局第一拍误杀。
  for (const bad of [[0, 0], [undefined, undefined], [640, 0], [0, 480], [NaN, NaN]]) {
    assert.equal(usableVideoSize(bad[0], bad[1]), false, `${bad} 不该算可用`)
  }
})

check('一条边正常、另一条塌了也算废（1×800 这种）', () => {
  assert.equal(usableVideoSize(1, 800), false)
  assert.equal(usableVideoSize(800, 1), false)
})

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过 ✅')
process.exit(failed ? 1 : 0)
