#!/usr/bin/env node
/**
 * 「看直播时画面最多放大到原生分辨率的几倍」的回归测试。跑：npm run test:live-scale
 *
 * 背景（2026-09-11 站长报的）：**大播放器会导致串流画面很糊。**
 *
 * 病因不是布局难看，是放大倍数：推流发的是**源画布的分辨率**，像素画那一档还刻意
 * `maintain-resolution`（videoTuning.ts：小源宁可掉帧也不减分辨率）。
 * 云端真 Chromium 实测（probe + Playwright，流按 256×240）：1920×1170 上画面
 * 1077×1010 = **4.21 倍**，2560×1440 上 4.45 倍 —— 而这是一条按 0.25 bit/像素/帧 压过的流。
 * 限 3 倍之后统一是 768×720；**矮屏（1280×720）上画面一个像素都没变**
 * （那里本来就是视口高度在限），完整表格在 screenAspect.ts 的 LIVE_MAX_SCALE 上方。
 *
 * ⚠️ 顺带钉一条结论，省得以后又绕回去：**「改回第一版布局」解决不了这件事。**
 * 09-07 那次「限宽 → 限高」的改动里画面尺寸一个像素都没变（推导在 stageHeightCap 上方），
 * 而 09-07 之前那个 8/4 两栏虽然真的更小，但它跟着窗口缩放 —— 4K 屏上照样撑到 1400 宽。
 * 只有「按流自己的分辨率限」才和窗口无关。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LIVE_MAX_SCALE,
  STAGE_CAP_EXPR,
  liveStageStyle,
  stageHeightCap,
} from '../src/emulator/screenAspect.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

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

/** 几个真实平台的源尺寸 */
const NES = { width: 256, height: 240 }
const GB = { width: 160, height: 144 }
const DOS = { width: 640, height: 480 }
const NDS_STACK = { width: 256, height: 384 }

/* ---------------- 一、算出来的尺寸 ---------------- */

check('按原生分辨率的整数倍限大小', () => {
  const s = liveStageStyle(NES, false)
  assert.equal(s.maxWidth, `${256 * LIVE_MAX_SCALE}px`)
  assert.ok(s.maxHeight.includes(`${240 * LIVE_MAX_SCALE}px`))
})

check('⚠️ 比例按**流的实际尺寸**给，不是 16:9', () => {
  /*
    不给比例的话舞台还是 16:9，4:3 的流在里面 contain 一次 ——
    maxWidth 限的是那个 16:9 的框，画面只能拿到 768 × 9/16 × 4/3 = 576 宽，
    也就是 2.25 倍而不是 3 倍。少的那 0.75 倍正是「还是有点糊」的来源。
  */
  assert.equal(liveStageStyle(NES, false).aspectRatio, '256 / 240')
  assert.equal(liveStageStyle(NDS_STACK, false).aspectRatio, '256 / 384', '双屏上下叠是竖的')
  assert.equal(liveStageStyle(DOS, false).aspectRatio, '640 / 480')
})

check('⚠️ 高度上限必须和视口上限做 min，不能顶掉它', () => {
  /*
    inline style 的优先级高过任何类名。直接写 `maxHeight: '720px'` 会把
    stageHeightCap 那条**顶掉** —— 矮屏（1280×720 的笔记本）上画面就会比视口还高，
    玩家得滚着看直播。
  */
  const normal = liveStageStyle(NES, false)
  assert.match(normal.maxHeight, /^min\(/)
  assert.ok(normal.maxHeight.includes(STAGE_CAP_EXPR.normal), '少了视口那一半')
  assert.ok(normal.maxHeight.includes('720px'), '少了分辨率那一半')
  // 沉浸模式那一档用的是另一个视口预算（顶栏藏了）
  const imm = liveStageStyle(NES, true)
  assert.ok(imm.maxHeight.includes(STAGE_CAP_EXPR.immersive))
  assert.ok(!imm.maxHeight.includes(STAGE_CAP_EXPR.normal))
})

check('⚠️ 不知道流多大时**不猜**', () => {
  // 第一帧还没到。这时候限成任何尺寸都是瞎猜，照走类名那一套
  for (const bad of [null, undefined, { width: 0, height: 0 }, { width: 256, height: 0 }, {}]) {
    assert.equal(liveStageStyle(bad, false), undefined, `${JSON.stringify(bad)} 竟然算出了上限`)
  }
})

check('倍数可调，且至少是 1 倍', () => {
  assert.equal(liveStageStyle(GB, false, 2).maxWidth, '320px')
  // 0 / 负数 / NaN 一律当 1 —— 限成 0 像素比不限糟得多
  for (const n of [0, -3, Number.NaN]) {
    assert.equal(liveStageStyle(GB, false, n).maxWidth, '160px', `${n} 倍没有兜到 1`)
  }
})

check('大源（DOS / N64 那种 640×480）照旧铺得很大', () => {
  // 这条是为了说明这个上限**不是一刀切的缩小**：640×480 的源 3 倍是 1920 宽，
  // 比任何内容列都宽，也就是完全不生效 —— 糊的从来只是小源被放大的那几倍
  assert.equal(liveStageStyle(DOS, false).maxWidth, '1920px')
})

/* ---------------- 二、两份数字必须同步 ---------------- */

check('⚠️ STAGE_CAP_EXPR 和 stageHeightCap 的类名是同一份数字', () => {
  /*
    Tailwind 的类名必须是字面量，而 CSS 的 calc() 里减号两侧要有空格 ——
    两种写法拼不成一个，只能写两遍。这条断言把它们钉在一起。
  */
  const squeeze = (s) => s.replace(/\s+/g, '')
  assert.ok(
    squeeze(stageHeightCap(false)).includes(squeeze(STAGE_CAP_EXPR.normal)),
    `普通档漂了：${stageHeightCap(false)} vs ${STAGE_CAP_EXPR.normal}`,
  )
  assert.ok(
    squeeze(stageHeightCap(true)).includes(squeeze(STAGE_CAP_EXPR.immersive)),
    `沉浸档漂了：${stageHeightCap(true)} vs ${STAGE_CAP_EXPR.immersive}`,
  )
})

/* ---------------- 三、只在该生效的地方生效 ---------------- */

check('⚠️ 只对观众生效，主播端一个像素都不动', () => {
  const src = code('src/emulator/EmulatorPlayer.tsx')
  const m = src.match(/const watchingLiveStage = ([^\n]+)/)
  assert.ok(m, '找不到 watchingLiveStage')
  assert.match(m[1], /session\?\.live/, '判据必须是「我在看别人的直播」')
  assert.match(m[1], /!narrow/, '手机上舞台是 auto 高度的三段，给它 aspectRatio 会把手柄和工具栏挤出去')
  assert.ok(
    !/liveSession/.test(m[1]),
    '判据里出现了 liveSession（那是「我在推流」= 主播）—— 主播看的是本地画布，不该被限',
  )
})

check('⚠️ 只挂在普通分支，全屏 / 游玩布局不能被夹住', () => {
  const src = read('src/emulator/EmulatorPlayer.tsx')
  const i = src.indexOf('liveCap\n')
  assert.ok(i > 0, '找不到那一支三元')
  // 上限出现在 embedFill 之后的那一支里（也就是最后那个「普通」分支）
  const branch = src.slice(src.indexOf('fullscreen\n            ?'), src.indexOf('dragging &&'))
  assert.ok(branch.includes('liveCap'), '上限没挂在普通分支里')
  const before = branch.slice(0, branch.indexOf('liveCap'))
  for (const other of ["'relative h-full'", "'fixed inset-0 z-[60]'"]) {
    assert.ok(before.includes(other), `${other} 那一支应该排在前面（也就是不受上限影响）`)
  }
})

check('⚠️ 限了之后要居中，否则框会贴在内容列左边', () => {
  const src = read('src/emulator/EmulatorPlayer.tsx')
  assert.match(src, /liveCap\s*\n?\s*\? 'relative mx-auto'/)
})

check('⚠️ 舞台的比例和高度上限这时只能有一个来源', () => {
  /*
    一个类名（sm:aspect-video / lg:max-h-[…]）+ 一条 inline 规则同时描述同一件事，
    谁赢就要去想优先级 —— 而 inline 永远赢，于是类名那份成了误导。
    所以这一支把两个类名一起让出去。
  */
  const src = read('src/emulator/EmulatorPlayer.tsx')
  const branch = src.slice(src.indexOf("liveCap\n"), src.indexOf('dragging &&'))
  const fallback = branch.slice(branch.indexOf(': cx('))
  assert.ok(fallback.includes('desktopScreenAspect'), '非直播那一支照旧用类名')
  const capped = branch.slice(0, branch.indexOf(': cx('))
  assert.ok(!capped.includes('desktopScreenAspect') && !capped.includes('stageHeightCap'))
})

/* ---------------- 四、观众端必须上报流的分辨率 ---------------- */

check('⚠️ liveview 要上报流的真实尺寸（以前一次都没报过）', () => {
  const src = code('src/emulator/adapters/liveview.ts')
  assert.match(src, /options\.onGeometry\?\.\(\{ width: w, height: h \}\)/, '没有上报几何 —— 上限就无从算起')
  assert.match(src, /if \(!usableVideoSize\(w, h\)\) return/, '一条 2×2 的废流报上去会把舞台限成 6×6')
  // 主播换游戏 / NDS 切布局时流的尺寸会变
  assert.match(src, /video\.addEventListener\('resize', reportSize\)/, '没跟着 resize 更新')
  assert.match(src, /video\.removeEventListener\('resize', reportSize\)/, 'destroy 时要摘掉')
})

check('第一帧那一刻就报（不然进来的头几秒是按旧尺寸限的）', () => {
  const src = code('src/emulator/adapters/liveview.ts')
  // ⚠️ 锚点要取 onEvent 那个函数体，别拿 `tinyFrame = false` 去 indexOf ——
  // 那个串在文件里出现三次，第一次是模块顶部的声明（第一版就这么假红过）
  const i = src.indexOf('const onEvent = () =>')
  assert.ok(i > 0, '找不到 onEvent')
  const body = src.slice(i, src.indexOf('const cleanup', i))
  const report = body.indexOf('reportSize()')
  const fire = body.indexOf('fire()')
  assert.ok(report >= 0, 'onEvent 里没上报尺寸')
  assert.ok(report < fire, '要在 fire() 之前报 —— 否则上层撤进度条那一刻还不知道流多大')
})

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
