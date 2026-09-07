/**
 * 双屏布局（src/emulator/dualScreen.ts + screenAspect.ts）的回归测试。
 *
 *   npm run test:nds-layout
 *
 * 为什么值得测：这一块的三类错误**全都不报错**。
 *   1. 认不出核心那一项 → 工具栏整块不画，或者画出来点了没反应（静默）
 *   2. `showsTouchScreen` 判错 → 玩家切到「只有上屏」时按键没被补上，
 *      这一局**一个能按的东西都没有**，而且没有任何提示
 *   3. 比例取整取错方向 → 画面悄悄缩小，没人会为此报 bug
 *
 * MELONDS_OPTIONS 是**实测**得来的，不是照文档抄的：2026-09-07 把
 * public/emulatorjs/cores/melonds-wasm.data 那个 7z 解开，读 wasm 数据段里的
 * retro_core_option_v2_definition 数组打出来的。改核心版本后值可能变，
 * 重新取一次证再改这里。
 */
import assert from 'node:assert/strict'
import {
  findLayoutOption,
  isDualScreen,
  isWideBox,
  layoutShape,
  layoutToken,
  nominalRatio,
  parseCoreOptionsText,
  preferredLayout,
  showsTouchScreen,
} from '../src/emulator/dualScreen.ts'
import { aspectClass, desktopScreenAspect, mobileScreenAspect } from '../src/emulator/screenAspect.ts'
import { isDiscPlatform, isSelfDownloadPlatform } from '../src/emulator/paths.ts'

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

/** melonDS 核心真实上报的那一项（EmulatorJS getCoreOptionsJSON 的形状） */
const LAYOUT_VALUES = ['Top/Bottom', 'Bottom/Top', 'Left/Right', 'Right/Left', 'Top Only', 'Bottom Only', 'Hybrid Top', 'Hybrid Bottom']
const MELONDS_OPTIONS = {
  options: [
    { key: 'melonds_console_mode', desc: 'Console Mode', values: [{ value: 'DS' }, { value: 'DSi' }], default: 'DS' },
    { key: 'melonds_touch_mode', desc: 'Touch Mode', values: [{ value: 'Mouse' }, { value: 'Touch' }, { value: 'Joystick' }, { value: 'disabled' }], default: 'Mouse' },
    { key: 'melonds_screen_layout', desc: 'Screen Layout', values: LAYOUT_VALUES.map((value) => ({ value })), default: 'Top/Bottom' },
    { key: 'melonds_screen_gap', desc: 'Screen Gap', values: [{ value: '0' }, { value: '1' }], default: '0' },
    { key: 'melonds_hybrid_small_screen', desc: 'Hybrid Small Screen Mode', values: [{ value: 'Bottom' }, { value: 'Top' }, { value: 'Duplicate' }], default: 'Bottom' },
  ],
}

console.log('一、从核心自报的选项表里认出布局那一项')

check('melonDS 的真实选项表 → 认出 melonds_screen_layout 与八个取值', () => {
  const opt = findLayoutOption(MELONDS_OPTIONS)
  assert.ok(opt, '没认出来')
  assert.equal(opt.key, 'melonds_screen_layout')
  assert.deepEqual(opt.values, LAYOUT_VALUES)
  assert.equal(opt.fallback, 'Top/Bottom')
})

check('裸数组也认（不是每个调用方都包一层 options）', () => {
  assert.equal(findLayoutOption(MELONDS_OPTIONS.options)?.key, 'melonds_screen_layout')
})

check('desmume 那一路的 key（screens_layout）也认得出', () => {
  const opt = findLayoutOption([{ key: 'desmume_screens_layout', values: ['top/bottom', 'left/right'] }])
  assert.equal(opt?.key, 'desmume_screens_layout')
})

check('取值只有一个 → 当没有（只有一个选项的选择器没有意义）', () => {
  assert.equal(findLayoutOption([{ key: 'melonds_screen_layout', values: ['Top/Bottom'] }]), null)
})

check('没有布局项的核心 → null，而不是拿别的项凑', () => {
  assert.equal(findLayoutOption([{ key: 'melonds_screen_gap', values: ['0', '1'] }]), null)
  assert.equal(findLayoutOption([{ key: 'fceumm_palette', values: ['a', 'b'] }]), null)
})

check('输入不是选项表（null / 字符串 / 空）一律 null，不抛', () => {
  for (const bad of [null, undefined, '', 'nope', 42, {}, { options: 'x' }]) {
    assert.equal(findLayoutOption(bad), null, `${JSON.stringify(bad)} 没有安全退出`)
  }
})

console.log('一之二、换核心不用改代码（desmume / desmume2015 的真实取值）')

/*
  下面两组取值是**实读**的，不是照文档抄的：把 @emulatorjs/core-desmume@4.2.3 和
  core-desmume2015@4.2.3 的 .data（7z）解开，读 wasm 数据段里的选项定义。
  两个核心的格式还不一样 —— desmume 是 v2（结构化），desmume2015 是**旧版 v1**
  （一整句 `Screen layout; top/bottom|…`）。
*/
const DESMUME_VALUES = ['top/bottom', 'bottom/top', 'left/right', 'right/left', 'top only', 'bottom only', 'hybrid/top', 'hybrid/bottom']
/** ⚠️ desmume2015 多一个 `quick switch` —— 我们归不了类的真实样本 */
const DESMUME2015_VALUES = [...DESMUME_VALUES.slice(0, 6), 'quick switch', 'hybrid/top', 'hybrid/bottom']

check('desmume：小写取值 + 复数 screens_layout 照样认得出', () => {
  const opt = findLayoutOption([
    { key: 'desmume_frameskip', values: ['0', '1'] },
    { key: 'desmume_screens_layout', values: DESMUME_VALUES.map((value) => ({ value })), default: 'top/bottom' },
  ])
  assert.equal(opt?.key, 'desmume_screens_layout')
  assert.deepEqual(opt?.values, DESMUME_VALUES)
})

check('desmume：形态归类和 melonDS 完全一致（大小写、斜杠写法都不影响）', () => {
  assert.equal(layoutShape('top/bottom'), 'stack')
  assert.equal(layoutShape('left/right'), 'side')
  assert.equal(layoutShape('top only'), 'single')
  assert.equal(layoutShape('hybrid/top'), 'hybrid')
  assert.equal(layoutToken('hybrid/bottom'), 'HybridBottom')
  assert.equal(layoutToken('top/bottom'), 'StackTop')
})

check('desmume：默认布局照样挑得出，且不会挑到单屏', () => {
  assert.equal(preferredLayout(DESMUME_VALUES, true), 'left/right')
  assert.equal(preferredLayout(DESMUME_VALUES, false), 'top/bottom')
})

check('⚠️ desmume：`top only` 一样要判成藏掉触摸屏', () => {
  for (const v of DESMUME_VALUES) assert.equal(showsTouchScreen(v), v !== 'top only', `${v} 判错了`)
})

check('desmume2015 的 `quick switch`：归不了类，但不当成藏掉触摸屏', () => {
  // 归不出形态 → 我们不替它猜比例（照旧用上一个量到的），但它照样能选
  assert.equal(layoutShape('quick switch'), 'unknown')
  assert.equal(layoutToken('quick switch'), '')
  // quick switch 是「一次显示一块、玩家自己切」，触摸屏是够得着的 —— 不能强行弹按键
  assert.equal(showsTouchScreen('quick switch'), true)
  // 也绝不会被挑成默认
  assert.notEqual(preferredLayout(DESMUME2015_VALUES, true), 'quick switch')
  assert.notEqual(preferredLayout(DESMUME2015_VALUES, false), 'quick switch')
})

check('desmume2015 走 v1 文本那条路：分号前那截当 key（引擎自己就是这么解的）', () => {
  const opt = findLayoutOption(parseCoreOptionsText('Screen layout; top/bottom|left/right|top only'))
  assert.ok(opt, '空格分隔的 `Screen layout` 也得认 —— 否则 v1 核心整块 UI 不出现')
  assert.deepEqual(opt.values, ['top/bottom', 'left/right', 'top only'])
})

console.log('二、老格式的核心选项文本（getCoreOptionsJSON 拿不到时的兜底）')

check('一行一项，竖线前是 key、分号后是取值', () => {
  const text = [
    'melonds_console_mode|DS; DS|DSi',
    'melonds_screen_layout|Top/Bottom; Top/Bottom|Left/Right|Top Only',
  ].join('\n')
  const opts = parseCoreOptionsText(text)
  assert.equal(opts.length, 2)
  const opt = findLayoutOption(opts)
  assert.equal(opt?.key, 'melonds_screen_layout')
  assert.deepEqual(opt?.values, ['Top/Bottom', 'Left/Right', 'Top Only'])
})

check('(Default) 前缀会被剥掉 —— 否则回填给核心的是一个不存在的取值', () => {
  const opts = parseCoreOptionsText('melonds_screen_layout; (Default) Top/Bottom|Left/Right')
  assert.deepEqual(opts[0].values, ['Top/Bottom', 'Left/Right'])
})

check('不是文本 / 没有分号的行一律跳过，不抛', () => {
  assert.deepEqual(parseCoreOptionsText(null), [])
  assert.deepEqual(parseCoreOptionsText('乱七八糟没有分号'), [])
})

console.log('三、形态归类')

const SHAPES = {
  'Top/Bottom': 'stack',
  'Bottom/Top': 'stack',
  'Left/Right': 'side',
  'Right/Left': 'side',
  'Top Only': 'single',
  'Bottom Only': 'single',
  'Hybrid Top': 'hybrid',
  'Hybrid Bottom': 'hybrid',
}
for (const [value, shape] of Object.entries(SHAPES)) {
  check(`${value} → ${shape}`, () => assert.equal(layoutShape(value), shape))
}
check('认不出的取值 → unknown（不是错误，只是我们不替它猜比例）', () => {
  assert.equal(layoutShape('Quick Switch'), 'unknown')
  assert.equal(layoutShape(''), 'unknown')
})

console.log('四、⚠️ 触摸屏看不看得见 —— 判错就是「这一局没有任何输入」')

check('只有 Top Only 藏掉触摸屏', () => {
  for (const value of LAYOUT_VALUES) {
    assert.equal(showsTouchScreen(value), value !== 'Top Only', `${value} 判错了`)
  }
})
check('Bottom Only 恰恰是全触屏，必须算看得见', () => {
  assert.equal(showsTouchScreen('Bottom Only'), true)
})
check('词序反过来（Only Top）也拦得住 —— 别赌核心的写法', () => {
  assert.equal(showsTouchScreen('Only Top'), false)
})
check('空值按看得见处理（没量到不等于藏起来了）', () => {
  assert.equal(showsTouchScreen(''), true)
  assert.equal(showsTouchScreen(undefined), true)
})

console.log('五、默认布局按容器方向定')

check('宽容器 → 左右并排（上屏在左那个，不是 Right/Left）', () => {
  assert.equal(preferredLayout(LAYOUT_VALUES, true), 'Left/Right')
})
check('竖容器 → 上下叠（上屏在上）', () => {
  assert.equal(preferredLayout(LAYOUT_VALUES, false), 'Top/Bottom')
})
check('⚠️ 单屏永远不做默认 —— Top Only 会让纯触控游戏没有输入', () => {
  for (const wide of [true, false]) {
    const picked = preferredLayout(LAYOUT_VALUES, wide)
    assert.notEqual(layoutShape(picked), 'single')
  }
  // 核心只给单屏时也不硬挑，返回空串 = 不动它
  assert.equal(preferredLayout(['Top Only', 'Bottom Only'], true), '')
})
check('核心的取值一个也归不了类 → 空串（保持核心自己的默认）', () => {
  assert.equal(preferredLayout(['Quick Switch', 'Whatever'], true), '')
})

check('isWideBox：明显是横的才算宽（1.2 这条线是刻意的）', () => {
  assert.equal(isWideBox(1920, 1080), true)
  assert.equal(isWideBox(390, 700), false)
  // 接近正方形判成 side 的代价更大（8:3 塞进方框，画面只剩三分之一高）
  assert.equal(isWideBox(400, 380), false)
  assert.equal(isWideBox(480, 400), true)
  // 量不到尺寸时不算宽 —— 手机竖屏是更常见的情形，猜错代价更小
  assert.equal(isWideBox(0, 0), false)
})

console.log('六、文案键')

const TOKENS = {
  'Top/Bottom': 'StackTop',
  'Bottom/Top': 'StackBottom',
  'Left/Right': 'SideLeft',
  'Right/Left': 'SideRight',
  'Top Only': 'TopOnly',
  'Bottom Only': 'BottomOnly',
  'Hybrid Top': 'HybridTop',
  'Hybrid Bottom': 'HybridBottom',
}
for (const [value, token] of Object.entries(TOKENS)) {
  check(`${value} → layout${token}`, () => assert.equal(layoutToken(value), token))
}
check('认不出的取值 → 空串（UI 原样显示英文，不硬翻）', () => {
  assert.equal(layoutToken('Quick Switch'), '')
})

console.log('七、⚠️ 比例取整必须向「更竖」的那一档取')

check('每一档的 min 就是那个类名自己的比例（差一点就反了）', () => {
  // 取到的那一档必须**不比内容更宽**，否则画面按高度缩
  const cases = [
    [512 / 192, 'aspect-[8/3]'],
    [16 / 9, 'aspect-video'],
    [240 / 160, 'aspect-[3/2]'],
    [256 / 192, 'aspect-[4/3]'],
    [160 / 144, 'aspect-[10/9]'],
    [256 / 384, 'aspect-[2/3]'],
  ]
  for (const [ratio, cls] of cases) assert.equal(aspectClass(ratio), cls, `${ratio} 落错档`)
})
check('略宽于某一档 → 仍落在那一档，绝不跳到更宽的一档', () => {
  assert.equal(aspectClass(16 / 9 + 0.02), 'aspect-video')
  assert.equal(aspectClass(4 / 3 + 0.01), 'aspect-[4/3]')
  // 反过来：略窄于 16:9 要掉到 3:2，不能留在 16:9
  assert.equal(aspectClass(16 / 9 - 0.02), 'aspect-[3/2]')
})
check('拿不到比例 → 16:9 兜底，不抛', () => {
  for (const bad of [0, -1, NaN, undefined, null]) assert.equal(aspectClass(bad), 'aspect-video')
})

console.log('八、容器比例：双屏跟实测，其余仍查表')

check('NDS 按实测几何走：上下叠 2:3、并排 8:3、单屏 4:3', () => {
  assert.equal(mobileScreenAspect('nds', { width: 256, height: 384 }), 'aspect-[2/3]')
  assert.equal(mobileScreenAspect('nds', { width: 512, height: 192 }), 'aspect-[8/3]')
  assert.equal(mobileScreenAspect('nds', { width: 256, height: 192 }), 'aspect-[4/3]')
})
check('NDS 还没量到几何 → 退回查表的 2:3（核心默认就是上下叠）', () => {
  assert.equal(mobileScreenAspect('nds', null), 'aspect-[2/3]')
  assert.equal(mobileScreenAspect('nds'), 'aspect-[2/3]')
})
check('⚠️ 单屏机型必须继续查表 —— 表里写的是 CRT 显示比例，不是像素比例', () => {
  // 红白机画布是 256×224（10:9），而该给的是 4:3。拿实测值去顶会把所有主机悄悄改矮一档
  assert.equal(mobileScreenAspect('nes', { width: 256, height: 224 }), 'aspect-[4/3]')
  assert.equal(mobileScreenAspect('psx', { width: 320, height: 240 }), 'aspect-[4/3]')
  assert.equal(mobileScreenAspect('gba', { width: 240, height: 160 }), 'aspect-[3/2]')
})

check('桌面端：上下叠放宽到 4:3，并排/单屏维持 16:9', () => {
  assert.equal(desktopScreenAspect('nds', { width: 256, height: 384 }), 'sm:aspect-[4/3]')
  assert.equal(desktopScreenAspect('nds', { width: 512, height: 192 }), 'sm:aspect-video')
  assert.equal(desktopScreenAspect('nds', { width: 256, height: 192 }), 'sm:aspect-[4/3]')
})
check('桌面端：非双屏机型一律 16:9（默认值就是它，调用方直接顶掉写死的类名）', () => {
  assert.equal(desktopScreenAspect('nes', { width: 256, height: 224 }), 'sm:aspect-video')
  assert.equal(desktopScreenAspect('nds', null), 'sm:aspect-video')
})

console.log('九、其余')

check('只有 NDS 算双屏', () => {
  assert.equal(isDualScreen('nds'), true)
  for (const p of ['nes', 'gba', 'psx', 'dos', 'flash', 'java']) assert.equal(isDualScreen(p), false)
})
check('标称比例只作兜底，混合布局不给数（必须靠量）', () => {
  assert.equal(nominalRatio('stack'), 256 / 384)
  assert.equal(nominalRatio('side'), 512 / 192)
  assert.equal(nominalRatio('single'), 256 / 192)
  assert.equal(nominalRatio('hybrid'), 0)
  assert.equal(nominalRatio('unknown'), 0)
})

console.log('十、ROM 由谁下载')

check('NDS 由我们自己下（要缓存、要断点重传、要提前报体积）', () => {
  assert.equal(isSelfDownloadPlatform('nds'), true)
})
check('光盘平台照旧自己下', () => {
  for (const p of ['psx', 'ps2']) assert.equal(isSelfDownloadPlatform(p), true)
})
check('⚠️ 小 ROM 的平台绝不能进来 —— 多一次 Blob 拷贝换不到什么', () => {
  for (const p of ['nes', 'snes', 'gb', 'gbc', 'gba', 'segaMD', 'ws', 'arcade', 'dos', 'flash', 'java', 'html5', 'n64'])
    assert.equal(isSelfDownloadPlatform(p), false, `${p} 不该自己下`)
})
check('NDS 不是光盘平台 —— isDiscPlatform 的语义没被顺手改掉', () => {
  // 这两个集合分开是有意的：光盘那条失败就报错，NDS 失败要退回引擎自己下
  assert.equal(isDiscPlatform('nds'), false)
  assert.equal(isDiscPlatform('psx'), true)
})

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
