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
import { readFileSync } from 'node:fs'
import {
  findLayoutOption,
  findTouchModeOption,
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

/* ================= 触控模式（2026-09-08） ================= */

/**
 * 取值全部是**从核心 wasm 里实读出来的**（把 `*-wasm.data` 那个 7z 解开、
 * 读 data 段里的 retro_core_option_v2_definition）。别改成手抄的。
 */
const MELONDS_TOUCH = {
  key: 'melonds_touch_mode',
  values: ['Mouse', 'Touch', 'Joystick', 'disabled'],
  default: 'Mouse',
}
/** desmume 那一支的一整组触控选项 —— 实读的 key 名，这一轮**刻意不接** */
const DESMUME_TOUCH_KEYS = [
  'desmume_pointer_type',
  'desmume_pointer_mouse',
  'desmume_mouse_speed',
  'desmume_pointer_colour',
  'desmume_pointer_stylus_pressure',
  'desmume_pointer_device_l',
  'desmume_pointer_device_r',
  'desmume_pointer_device_deadzone',
  'desmume_pointer_device_acceleration_mod',
  'desmume_hybrid_cursor_always_smallscreen',
]

check('认出 melonDS 的触控模式项，并挑出绝对坐标那一档', () => {
  const opt = findTouchModeOption([MELONDS_TOUCH])
  assert.ok(opt, '应该认出来')
  assert.equal(opt.key, 'melonds_touch_mode')
  /*
    这一条是整件事的要害：核心出厂默认是 Mouse = RETRO_DEVICE_MOUSE = **相对位移**，
    而 Touch = RETRO_DEVICE_POINTER = **绝对坐标**（libretro.h 两段注释的原话）。
    2026-09-07 的项目记忆里曾把这两者写反、并写着「别改」，09-08 订正。
  */
  assert.equal(opt.absolute, 'Touch')
  assert.equal(opt.fallback, 'Mouse', '核心的出厂默认就是那个错的档位')
  assert.notEqual(opt.absolute, opt.fallback, '要是这两个相等就说明核心改了默认，这条守卫该退休')
})

check('{ options: [...] } 那种包一层的形状也认（引擎两种都可能给）', () => {
  assert.equal(findTouchModeOption({ options: [MELONDS_TOUCH] })?.key, 'melonds_touch_mode')
})

check('取值是 {value,label} 对象数组时也认（getCoreOptionsJSON 的真实形状）', () => {
  const opt = findTouchModeOption([
    { key: 'melonds_touch_mode', values: [{ value: 'Mouse' }, { value: 'Touch', label: '触摸' }] },
  ])
  assert.equal(opt?.absolute, 'Touch')
})

check('⚠️ 作用范围只到 melonDS —— desmume 那一整组一个都不许命中', () => {
  /*
    desmume 的触控是一整组语义不同的选项（含 pointer_colour，能画出看得见的笔尖），
    值得单独一轮。这一条钉住「这次只动 melonDS」这个决定：
    哪天有人把正则放宽到 /point/，这里会红，那时必须连带把 desmume 的默认值一起想清楚。
  */
  for (const key of DESMUME_TOUCH_KEYS) {
    const opt = findTouchModeOption([{ key, values: ['mouse', 'touch', 'absolute'] }])
    assert.equal(opt, null, `${key} 不该被当成触控模式项`)
  }
})

check('⚠️ 没有绝对坐标那一档时返回 null，绝不猜一个塞进去', () => {
  // 认不出就保持核心默认。塞一个不认识的字符串最好是静默失效，
  // 最坏是把玩家推到 Joystick（摇杆推光标）那一档，比现状更糟
  assert.equal(findTouchModeOption([{ key: 'melonds_touch_mode', values: ['Mouse', 'Joystick'] }]), null)
  assert.equal(findTouchModeOption([{ key: 'melonds_touch_mode', values: [] }]), null)
})

check('脏输入不炸', () => {
  for (const bad of [null, undefined, 0, '', 'nope', {}, [], [null], [{ key: 123 }], [{ key: 'melonds_touch_mode' }]])
    assert.equal(findTouchModeOption(bad), null)
})

check('current 与 fallback 原样带出来（适配器靠它判「已经对了就别再写」）', () => {
  const opt = findTouchModeOption([{ ...MELONDS_TOUCH, current: 'Touch' }])
  assert.equal(opt.current, 'Touch')
  assert.equal(opt.fallback, 'Mouse')
})

check('大小写/空格不敏感地挑绝对坐标那一档，但回填的是核心的原文', () => {
  const opt = findTouchModeOption([{ key: 'melonds_touch_mode', values: ['Mouse', ' TOUCH '] }])
  assert.equal(opt?.absolute, ' TOUCH ', '回填必须原样 —— 核心认的是它自己那份字符串')
})

/* ---------- 适配器源码守卫：鼠标锁定必须对 POINTER_FIRST 平台无条件关掉 ---------- */
/*
  为什么只能扫源码：这几条错误全在浏览器里才现形，而现形的样子是「Chrome 压下一条
  『按 esc 显示光标』、指针没了、触控笔点不准」—— 没有异常、没有日志，
  跑任何单元测试都是绿的。09-08 修之前它就这么活了一整天。
*/
const ADAPTER = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
/** 断言用的源码：把注释剥掉，别被我们自己写的病因注释骗过去（test:j2me 踩过） */
const ADAPTER_CODE = ADAPTER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

check('⚠️ releaseMouseLock 不能挂在 applyTouchInput 里（桌面进不去那个函数）', () => {
  const from = ADAPTER_CODE.indexOf('const applyTouchInput = ')
  assert.ok(from > 0, '找不到 applyTouchInput —— 改名了就把这条守卫一起改')
  const body = ADAPTER_CODE.slice(from, ADAPTER_CODE.indexOf('\n  const ', from + 10))
  assert.ok(
    !body.includes('releaseMouseLock'),
    'applyTouchInput 开头就 `if (!isMobile && !hasTouchScreen && !coarse) return`，' +
      '桌面浏览器根本进不去；而锁定指针只在桌面上发生。放这儿等于没做',
  )
})

check('⚠️ 开局时按 POINTER_FIRST 无条件关掉鼠标锁定', () => {
  const from = ADAPTER_CODE.indexOf('const finishStart = ')
  assert.ok(from > 0, '找不到 finishStart')
  const body = ADAPTER_CODE.slice(from, ADAPTER_CODE.indexOf('\n  const ', from + 10))
  assert.match(body, /POINTER_FIRST\.has\(options\.platform\)/, 'finishStart 里要按平台判')
  assert.match(body, /releaseMouseLock\(/, 'finishStart 里要真调 releaseMouseLock')
})

check('⚠️ 关锁定除了走 changeSettingOption 还必须直接写 enableMouseLock', () => {
  const from = ADAPTER_CODE.indexOf('const releaseMouseLock = ')
  assert.ok(from > 0, '找不到 releaseMouseLock')
  const body = ADAPTER_CODE.slice(from, ADAPTER_CODE.indexOf('\n  const ', from + 10))
  assert.match(body, /changeSettingOption\?\.\('lockMouse', 'disabled', true\)/, "第三参必须是 true —— 这是默认值不是玩家的选择")
  assert.match(
    body,
    /enableMouseLock = false/,
    '引擎那句 requestPointerLock 只看这个布尔；菜单那一行没建时，光走 changeSettingOption 等于没关',
  )
  assert.match(body, /exitPointerLock\(\)/, '已经锁上了要当场退出来')
})

check('⚠️ 触控模式那一路改完要回读核对（changeSettingOption?.() 不在时是静默的）', () => {
  const from = ADAPTER_CODE.indexOf('const applyTouchModeDefault = ')
  assert.ok(from > 0, '找不到 applyTouchModeDefault')
  const body = ADAPTER_CODE.slice(from, ADAPTER_CODE.indexOf('\n  const ', from + 10))
  assert.match(body, /readTouchModeOption\(emu\)\?\.current/, '要再读一次核心选项当证据')
  assert.match(body, /console\.warn/, '回读对不上必须 warn，不能只打「已改」')
})

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
