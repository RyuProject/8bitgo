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
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tuningFor, applyTuning, encodeScaleFor, fpsForViewers, MAX_ENCODE_SCALE_DOWN, RETRO_MAX_PIXELS, usableVideoSize, MIN_VIDEO_EDGE } from '../src/emulator/videoTuning.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** 读源码并**先剥掉注释** —— 否则「注释里提到了」会被当成「代码里做了」 */
const code = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

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

check('⚠️ NDS 双屏：总像素越线，但按单块屏算才对', () => {
  // 上下叠 256×384 = 98304 > 320×240，不带 dualScreen 就会被当成大源
  const stackedWrong = tuningFor({ width: 256, height: 384, fps: 30 })
  assert.equal(stackedWrong.retro, false, '这一条是记录旧行为：不告诉它是双屏，它只能按总像素判')

  for (const [name, w, h] of [['上下叠', 256, 384], ['并排', 512, 192]]) {
    const t = tuningFor({ width: w, height: h, fps: 30, dualScreen: true })
    assert.equal(t.retro, true, `${name} 应该按单块屏（${w * h / 2}）算成像素画`)
    assert.equal(t.degradationPreference, 'maintain-resolution', `${name} 必须保分辨率`)
    assert.equal(t.contentHint, 'detail')
  }
  // 单屏布局（256×192）本来就在线以下，带不带这一位都对
  assert.equal(tuningFor({ width: 256, height: 192, fps: 30, dualScreen: true }).retro, true)
  assert.equal(tuningFor({ width: 256, height: 192, fps: 30 }).retro, true)
})

check('dualScreen **不打折码率** —— 要编的像素数是实打实的两块屏', () => {
  const plain = tuningFor({ width: 256, height: 384, fps: 30 }).maxBitrate
  const dual = tuningFor({ width: 256, height: 384, fps: 30, dualScreen: true }).maxBitrate
  assert.equal(dual, plain)
})

check('dualScreen 不会把真正的大源拽进像素画那一档', () => {
  // 分享标签页 1280×720 即便误传了这一位，单块屏仍然远超那条线
  assert.equal(tuningFor({ width: 1280, height: 720, fps: 30, dualScreen: true }).retro, false)
})

check('分界线本身（384×224，CPS 街机板）算像素画', () => {
  assert.equal(RETRO_MAX_PIXELS, 384 * 224, '线就是 CPS1/CPS2 那一块板子；改它要先看常量上方那段')
  const t = tuningFor({ width: 384, height: 224, fps: 30 })
  assert.equal(t.retro, true, '街机分类以前整个被判成大源（线是 320×240），这就是 09-11 那次糊的一半原因')
  assert.equal(t.degradationPreference, 'maintain-resolution')
  assert.equal(t.contentHint, 'detail')
})

check('刚过界一格就换档', () => {
  assert.equal(tuningFor({ width: 385, height: 224, fps: 30 }).retro, false)
})

check('⚠️ 线不能抬到 NDS 双屏（98304）之上，否则 dualScreen 那一位变成死代码', () => {
  // 抬过去的话，不带 dualScreen 的 256×384 也会被判成像素画 ——
  // 「按单块屏算」这条逻辑就再也不会被下面那条 NDS 断言测到了
  assert.ok(RETRO_MAX_PIXELS < 256 * 384, `线 ${RETRO_MAX_PIXELS} 已经盖过 NDS 双屏 98304`)
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

console.log('五、编码前缩回原生（主播端 CPU / 上行的大头）')

/**
 * 09-11 线上实测的那一组真实数字（恐龙快打 / CPS1，站长自己在播）：
 * 画布 2079×1098，游戏原生 384×224。画布不是内容，是「主播把播放器拉多宽 × dpr」。
 */
const REAL = { canvas: [2079, 1098], native: { width: 384, height: 224 } }

check('实测那一组：2079×1098 的画布按 384×224 的原生缩回去', () => {
  const scale = encodeScaleFor(REAL.canvas[0], REAL.canvas[1], REAL.native)
  // min(2079/384, 1098/224) = min(5.41, 4.90) = 4.90
  assert.ok(Math.abs(scale - 1098 / 224) < 1e-9, `倍数应当由高度决定，实得 ${scale}`)
  const w = REAL.canvas[0] / scale
  const h = REAL.canvas[1] / scale
  assert.ok(Math.round(h) === 224, `缩完高度应当正好是原生的 224，实得 ${h}`)
  assert.ok(Math.round(w) === 424, `缩完宽度应当是 424（384 内容 + 两条黑边），实得 ${w}`)
})

check('⚠️ 取两个比值里小的那个 —— 取大的会缩到原生以下', () => {
  /*
    这条是这段逻辑唯一容易写反的地方。画布通常比游戏**宽**（两侧黑边）：
    按宽算是 5.41 倍，缩完高度只剩 203 —— 低于原生 224，那是真的在丢信息，
    而且主播和观众都看不出来是哪一步丢的。
  */
  const scale = encodeScaleFor(2079, 1098, REAL.native)
  const byWidth = 2079 / 384
  assert.ok(scale < byWidth, '取成按宽算了')
  assert.ok(1098 / scale >= 224 - 1e-9, '缩完的高度低于原生了')
  assert.ok(2079 / scale >= 384 - 1e-9, '缩完的宽度低于原生了')
})

check('原生不比画布小（或正好相等）就不缩', () => {
  assert.equal(encodeScaleFor(384, 224, { width: 384, height: 224 }), 1, '相等时不该缩')
  assert.equal(encodeScaleFor(256, 240, { width: 640, height: 480 }), 1, '画布比原生还小，缩了就是马赛克')
})

check('拿不到原生就不缩（猜错的代价不对称）', () => {
  for (const bad of [undefined, null, {}, { width: 0, height: 224 }, { width: 384, height: NaN }]) {
    assert.equal(encodeScaleFor(2079, 1098, bad), 1, `${JSON.stringify(bad)} 时不该缩`)
  }
  assert.equal(encodeScaleFor(0, 0, REAL.native), 1)
})

check('离谱的倍数被 MAX_ENCODE_SCALE_DOWN 夹住', () => {
  // 画布被某个布局 bug 拉到 8K 时，与其信它，不如夹住：缩过头是观众看马赛克
  const scale = encodeScaleFor(7680, 4320, { width: 160, height: 144 })
  assert.equal(scale, MAX_ENCODE_SCALE_DOWN, `夹不住：${scale}`)
})

check('⚠️ 码率按**缩完之后**的像素数算 —— 这是上行流量的全部收益', () => {
  const before = tuningFor({ width: REAL.canvas[0], height: REAL.canvas[1], fps: 30 })
  const after = tuningFor({ width: REAL.canvas[0], height: REAL.canvas[1], fps: 30, native: REAL.native })
  assert.equal(before.maxBitrate, 6_000_000, '不缩的话 2.28Mpx 直接把 MAX_BITRATE 顶满')
  assert.equal(after.maxBitrate, 1_000_000, '缩回 424×224 之后落到码率下限')
  assert.ok(after.maxBitrate * 6 <= before.maxBitrate, '省下来的要按观众数乘：12 个观众就是 72Mbps → 12Mbps')
})

check('⚠️ 判像素画用**原生**尺寸，不用编码尺寸（编码尺寸含黑边）', () => {
  /*
    缩完是 424×224 = 94976，已经越过 384×224 = 86016 那条线。
    要是拿编码尺寸判档，这款街机游戏就又被打回「大源」—— 等于白缩。
    更糟的是它会**随主播的播放器比例变**：4:3 的播放器上缩完是 384×288，
    同一款游戏在两个主播那里判出两个档。
  */
  const t = tuningFor({ width: REAL.canvas[0], height: REAL.canvas[1], fps: 30, native: REAL.native })
  assert.equal(t.retro, true, '拿编码尺寸判档了')
  assert.equal(t.degradationPreference, 'maintain-resolution')
  assert.equal(t.contentHint, 'detail')

  // 4:3 的播放器：缩完是 384×288 = 110592，比 16:9 那次还大，但判出来必须一样
  const fourThree = tuningFor({ width: 1600, height: 1200, fps: 30, native: REAL.native })
  assert.equal(fourThree.retro, true, '换个播放器比例就判成另一档了')
})

check('真有分辨率的机型一格都不会被缩', () => {
  // DOS 640×480 在一块 1280×960 的画布上：缩 2 倍正好回到 640×480，不多不少
  const t = tuningFor({ width: 1280, height: 960, fps: 30, native: { width: 640, height: 480 } })
  assert.equal(t.scaleResolutionDownBy, 2)
  assert.equal(t.retro, false, '640×480 本来就是大源，缩回原生不改变这一点')
  assert.equal(t.contentHint, 'motion')
})

check('NDS 双屏：缩回原生之后仍然按单块屏判', () => {
  const t = tuningFor({ width: 1024, height: 1536, fps: 30, dualScreen: true, native: { width: 256, height: 384 } })
  assert.equal(t.scaleResolutionDownBy, 4)
  assert.equal(t.retro, true, '两块屏各 49152，必须落在像素画那一档')
})

check('⚠️ applyTuning 真的把倍数写进 encodings（写漏了 = 整个优化不存在）', () => {
  const encodings = [{}]
  let applied = null
  const sender = {
    track: { kind: 'video', contentHint: '' },
    getParameters: () => ({ encodings }),
    setParameters: (p) => { applied = p; return Promise.resolve() },
  }
  const tuning = tuningFor({ width: REAL.canvas[0], height: REAL.canvas[1], fps: 30, native: REAL.native })
  applyTuning(sender, tuning)
  assert.ok(applied, 'setParameters 没被调用')
  assert.equal(applied.encodings[0].scaleResolutionDownBy, tuning.scaleResolutionDownBy)
  assert.equal(applied.encodings[0].maxBitrate, tuning.maxBitrate)
  assert.equal(applied.degradationPreference, 'maintain-resolution')
  assert.equal(sender.track.contentHint, 'detail')
})

check('不传 native 时 scaleResolutionDownBy 是 1（老行为一个像素不变）', () => {
  const t = tuningFor({ width: 1280, height: 720, fps: 30 })
  assert.equal(t.scaleResolutionDownBy, 1)
})

console.log('六、原生尺寸得真的接到推流那一端（接不上 = 上面全是摆设）')

check('⚠️ 播放器把 geometry 交给 LiveControls', () => {
  const src = code('src/emulator/EmulatorPlayer.tsx')
  assert.match(src, /nativeGeometry=\{geometry\}/, '没传下去：那么 native 永远是 null，一格都不会缩')
})

check('⚠️ 只有主播会挂 LiveControls —— 这是复用 geometry 的前提', () => {
  /*
    `geometry` 这个 state 有两个来源：主播端是核心上报的 av_info 几何（384×224），
    观众端是 liveview 上报的**流尺寸**（2079×1098）。两者同名同 state，
    靠「观众不挂 LiveControls」这一条区分开。这条守卫没了，观众的流尺寸就会被
    当成原生尺寸喂给推流 —— 缩放算出来正好是 1，等于优化静默失效。
  */
  const src = code('src/emulator/EmulatorPlayer.tsx')
  // ⚠️ 不能用 indexOf('<LiveControls')：`useState<LiveControlsHandle | null>` 里也有这一串，
  // 第一次写就踩了 —— 断言读到的是那个泛型参数，跟 JSX 差了两千行
  const at = src.search(/<LiveControls\s*\n/)
  assert.ok(at > 0, '找不到 <LiveControls 那个 JSX 标签')
  const before = src.slice(Math.max(0, at - 400), at)
  assert.match(before, /!session\?\.live/, 'LiveControls 的挂载条件里没有 !session?.live 了')
})

check('⚠️ LiveControls 把 native 交给 startBroadcast，而且是**函数**', () => {
  const src = code('src/emulator/LiveControls.tsx')
  assert.match(src, /native:\s*\(\)\s*=>\s*nativeRef\.current/, 'native 没传，或者传成了值')
  // 传值的话：几何比开播晚到（核心起来才有），闭包捕到的是开播瞬间的 null，之后永不更新
  assert.ok(!/native:\s*nativeGeometry\b/.test(src), '传成了死值，换游戏 / 晚到的几何都收不到')
})

check('⚠️ native 存在 ref 里，每次渲染更新', () => {
  const src = code('src/emulator/LiveControls.tsx')
  assert.match(src, /nativeRef\.current\s*=\s*nativeGeometry/, 'ref 不更新的话永远是挂载那一刻的值')
})

check('⚠️ 分享标签页那一路**不传** native', () => {
  /*
    那条流是整个标签页（含站点 UI），没有「游戏原生尺寸」可言。
    按 384×224 去缩的话，1920×1080 的标签页会被缩成 384 宽 —— 观众看一块马赛克。
    所以整个文件里 `native:` 只能出现一次（自动开播那一路）。
  */
  const src = code('src/emulator/LiveControls.tsx')
  const hits = src.match(/\bnative:/g) ?? []
  assert.equal(hits.length, 1, `native: 出现了 ${hits.length} 次，分享标签页那一路多半也传了`)
})

check('⚠️ broadcast 把 native 一路送进 tuningFor', () => {
  const src = code('src/emulator/broadcast.ts')
  assert.match(src, /tuningFor\(\{[^}]*native[^}]*\}\)/, 'tuneSender 里没把 native 交给 tuningFor')
})

check('⚠️ 每一处 tuneSender 调用都带上 options.native', () => {
  /*
    这个函数在三个地方被调：首次协商、replaceTrack 之后、观众数变化重新调参。
    漏掉任何一处，那条路径上的编码就还是全画布 —— 而且**只在那条路径上**，
    最容易漏的 replaceTrack（Ruffle 读档换画布）恰恰是最难自测到的一条。
  */
  const src = code('src/emulator/broadcast.ts')
  const calls = src.match(/tuneSender\((?!\s*\n)[^\n]*\)/g) ?? []
  assert.ok(calls.length >= 3, `只找到 ${calls.length} 处 tuneSender 调用，预期至少 3 处`)
  for (const c of calls) {
    assert.match(c, /options\.native\?\.\(\)/, `这一处没传 native：${c.slice(0, 120)}`)
  }
})

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过 ✅')
process.exit(failed ? 1 : 0)
