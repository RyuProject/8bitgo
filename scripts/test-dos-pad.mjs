/**
 * DOS 屏幕手柄键位的回归测试。
 *
 * ── 盯的是什么 ──────────────────────────────────────────────
 * 这个模块里最容易错、也最难发现的是 **GLFW 键码表**。抄错一个数字不会报任何错：
 * 玩家点手柄，`sendKeyEvent` 收到一个引擎不认的编号，DOSBox 里就是**什么都没发生** ——
 * 没有异常、没有日志、画面上一切正常。这类 bug 只能靠「表本身对不对」来拦。
 *
 * 所以下面第一组断言是**硬编码的期望值**，来源是 js-dos 自己的编号
 * （对照 src/emulator/windowsLaunch.ts 的 WIN_KEY，那里已经在用同一套数字开 Windows 的
 * 「运行」框 —— 两处对不上就说明有一边抄错了）。
 *
 * 第二组盯的是「手机上的虚拟键盘」那条路：安卓输入法大多不给 `event.code`，
 * 只能靠 `event.key` 里那个字符去反查。反查表是从标签反推出来的，标签一改它就悄悄失效。
 *
 * 第三组是存储：读出来**永远得是完整可用的八颗**，坏数据要退回默认而不是变成死键。
 *
 * 跑：npm run test:dospad
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

/* ---------------- localStorage 替身 ---------------- */

/**
 * node 里没有 localStorage，而这个模块必须能在两种环境下跑（浏览器 / 测试）。
 * 装一个最小实现：只要 getItem / setItem / removeItem 三件套就够它用。
 */
function installStorage() {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
  }
  return map
}

const mod = await import(fileURLToPath(new URL('../src/emulator/dosPad.ts', import.meta.url)))
const {
  CODE_TO_GLFW,
  DOS_PAD_BUTTONS,
  DOS_PAD_DEFAULT,
  glfwKeyForPress,
  glfwKeyLabel,
  loadDosPadKeys,
  saveDosPadKeys,
  resetDosPadKeys,
  dosPadCustomized,
} = mod

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.log(`  ✗ ${name}`)
    console.log(`      ${e.message}`)
  }
}

/* ---------------- 一、键码表 ---------------- */

console.log('\n键码表（数字必须和 js-dos 一致）')
check('字母 = ASCII 大写（KeyA→65 … KeyZ→90）', () => {
  assert.equal(CODE_TO_GLFW.KeyA, 65)
  assert.equal(CODE_TO_GLFW.KeyW, 87)
  assert.equal(CODE_TO_GLFW.KeyZ, 90)
})
check('数字与空格', () => {
  assert.equal(CODE_TO_GLFW.Digit0, 48)
  assert.equal(CODE_TO_GLFW.Digit9, 57)
  assert.equal(CODE_TO_GLFW.Space, 32)
})
check('特殊键：Esc/Enter/Tab/Backspace = 256..259', () => {
  assert.equal(CODE_TO_GLFW.Escape, 256)
  assert.equal(CODE_TO_GLFW.Enter, 257)
  assert.equal(CODE_TO_GLFW.Tab, 258)
  assert.equal(CODE_TO_GLFW.Backspace, 259)
})
check('方向键：右262 左263 下264 上265', () => {
  assert.equal(CODE_TO_GLFW.ArrowRight, 262)
  assert.equal(CODE_TO_GLFW.ArrowLeft, 263)
  assert.equal(CODE_TO_GLFW.ArrowDown, 264)
  assert.equal(CODE_TO_GLFW.ArrowUp, 265)
})
check('修饰键：Shift340 Ctrl341 Alt342', () => {
  assert.equal(CODE_TO_GLFW.ShiftLeft, 340)
  assert.equal(CODE_TO_GLFW.ControlLeft, 341)
  assert.equal(CODE_TO_GLFW.AltLeft, 342)
})
check('F1 = 290（F 键从 290 起）', () => {
  assert.equal(CODE_TO_GLFW.F1, 290)
  assert.equal(CODE_TO_GLFW.F12, 301)
})
check('小键盘：Num0 = 320，NumEnter = 335', () => {
  assert.equal(CODE_TO_GLFW.Numpad0, 320)
  assert.equal(CODE_TO_GLFW.NumpadEnter, 335)
})
check('windowsLaunch 用到的键都在这张表里', () => {
  // 这几个是 src/emulator/windowsLaunch.ts 开「运行」框要敲的键。那边直接写死数字，
  // 这里反着验一遍：万一表里的编号被改错，那条启动链会先坏掉（而且是静默的）
  assert.equal(CODE_TO_GLFW.Semicolon, 59)
  assert.equal(CODE_TO_GLFW.Minus, 45)
  assert.equal(CODE_TO_GLFW.Backslash, 92)
  assert.equal(CODE_TO_GLFW.Period, 46)
})

/* ---------------- 二、按键换算 ---------------- */

console.log('\n按键换算（code 优先，手机退回 key）')
check('code 路径：KeyW → 87', () => {
  assert.equal(glfwKeyForPress({ code: 'KeyW', key: 'w' }), 87)
})
check('code 认不出时用 key：安卓输入法只给字符', () => {
  assert.equal(glfwKeyForPress({ code: '', key: 'w' }), 87)
  assert.equal(glfwKeyForPress({ code: 'Unidentified', key: 'W' }), 87)
  assert.equal(glfwKeyForPress({ code: 'Unidentified', key: '5' }), 53)
})
check('空格：key 是一个空格字符', () => {
  assert.equal(glfwKeyForPress({ code: 'Unknown', key: ' ' }), 32)
})
check('具名键：方向 / 回车 / Esc / 修饰键', () => {
  assert.equal(glfwKeyForPress({ code: '', key: 'ArrowUp' }), 265)
  assert.equal(glfwKeyForPress({ code: '', key: 'ArrowLeft' }), 263)
  assert.equal(glfwKeyForPress({ code: '', key: 'Enter' }), 257)
  assert.equal(glfwKeyForPress({ code: '', key: 'Escape' }), 256)
  assert.equal(glfwKeyForPress({ code: '', key: 'Control' }), 341)
  assert.equal(glfwKeyForPress({ code: '', key: 'Shift' }), 340)
  assert.equal(glfwKeyForPress({ code: '', key: 'Alt' }), 342)
})
check('AZERTY 上按物理位置的 W 不会被 key 带到 Z 去', () => {
  // 这就是「先看 code」的理由：code 是物理键位，key 随布局变
  assert.equal(glfwKeyForPress({ code: 'KeyW', key: 'z' }), 87)
})
check('认不出来返回 null（界面要说「这个键不支持」）', () => {
  assert.equal(glfwKeyForPress({ code: 'Unidentified', key: 'Unidentified' }), null)
  assert.equal(glfwKeyForPress({ code: '', key: '' }), null)
  assert.equal(glfwKeyForPress({}), null)
  // AudioVolume 这类多媒体键 DOS 时代不存在，不能悄悄映射成别的
  assert.equal(glfwKeyForPress({ code: 'AudioVolumeUp', key: 'AudioVolumeUp' }), null)
})

console.log('\n标签')
check('方向和修饰键显示成符号 / 短名', () => {
  assert.equal(glfwKeyLabel(265), '↑')
  assert.equal(glfwKeyLabel(264), '↓')
  assert.equal(glfwKeyLabel(263), '←')
  assert.equal(glfwKeyLabel(262), '→')
  assert.equal(glfwKeyLabel(341), 'Ctrl')
  assert.equal(glfwKeyLabel(342), 'Alt')
  assert.equal(glfwKeyLabel(256), 'Esc')
  assert.equal(glfwKeyLabel(257), 'Enter')
  assert.equal(glfwKeyLabel(87), 'W')
})
check('表里没有的键码也要有东西显示（不能是空串）', () => {
  assert.equal(glfwKeyLabel(9999), '#9999')
})

/* ---------------- 三、默认键位 ---------------- */

console.log('\n默认键位')
check('八颗按钮一颗不少', () => {
  assert.deepEqual([...DOS_PAD_BUTTONS].sort(), ['a', 'b', 'down', 'left', 'right', 'select', 'start', 'up'])
  for (const b of DOS_PAD_BUTTONS) assert.equal(typeof DOS_PAD_DEFAULT[b], 'number')
})
check('方向 = 方向键（这就是站长要的「上=⬆️ 下=⬇️ 左=⬅️ 右=➡️」）', () => {
  assert.equal(DOS_PAD_DEFAULT.up, 265)
  assert.equal(DOS_PAD_DEFAULT.down, 264)
  assert.equal(DOS_PAD_DEFAULT.left, 263)
  assert.equal(DOS_PAD_DEFAULT.right, 262)
})
check('动作键 = Ctrl / Alt / 回车 / Esc（没绑过的玩家行为和以前完全一样）', () => {
  assert.equal(DOS_PAD_DEFAULT.a, 341)
  assert.equal(DOS_PAD_DEFAULT.b, 342)
  assert.equal(DOS_PAD_DEFAULT.start, 257)
  assert.equal(DOS_PAD_DEFAULT.select, 256)
})
check('每颗按钮的默认值都在表里（否则标签会退化成 #数字）', () => {
  for (const b of DOS_PAD_BUTTONS) assert.ok(!glfwKeyLabel(DOS_PAD_DEFAULT[b]).startsWith('#'), `${b} 的默认值不在表里`)
})

/* ---------------- 四、按游戏存取 ---------------- */

console.log('\n按游戏存取')
installStorage()

check('没存过时返回一份完整的默认表', () => {
  const keys = loadDosPadKeys('doom')
  assert.deepEqual(keys, DOS_PAD_DEFAULT)
  assert.equal(dosPadCustomized('doom'), false)
})

check('存了之后读得回来，且互不串台', () => {
  saveDosPadKeys('doom', { ...DOS_PAD_DEFAULT, a: CODE_TO_GLFW.KeyW, b: CODE_TO_GLFW.KeyA })
  assert.equal(loadDosPadKeys('doom').a, 87)
  // 另一个游戏必须是它自己的（没有全局兜底）
  assert.equal(loadDosPadKeys('prince').a, 341)
  assert.equal(dosPadCustomized('doom'), true)
  assert.equal(dosPadCustomized('prince'), false)
})

check('恢复默认：清掉记录、读回来还是默认表', () => {
  resetDosPadKeys('doom')
  assert.deepEqual(loadDosPadKeys('doom'), DOS_PAD_DEFAULT)
  assert.equal(dosPadCustomized('doom'), false)
})

/**
 * 存储键的前缀在这里是**硬编码**的，故意的：它一旦改了，所有玩家的自定义键位就全丢
 * （读不到旧记录 = 全退回默认）。所以把它钉在测试里，改的人必须是有意识地在改。
 */
const PREFIX = '8bitgo.dospad.'

check('写入用的是约定好的键名', () => {
  saveDosPadKeys('keyfmt', { ...DOS_PAD_DEFAULT, a: 87 })
  assert.notEqual(localStorage.getItem(`${PREFIX}keyfmt`), null, `存的时候必须用 ${PREFIX}<slug>`)
})

check('存档坏掉（不是 JSON）不抛错，退回默认', () => {
  localStorage.setItem(`${PREFIX}broken`, '{{{not json')
  assert.deepEqual(loadDosPadKeys('broken'), DOS_PAD_DEFAULT)
})

check('表里没有的键码会被丢掉，退回默认（不能塞一颗死键）', () => {
  localStorage.setItem(`${PREFIX}weird`, JSON.stringify({ ...DOS_PAD_DEFAULT, a: 99999 }))
  assert.equal(loadDosPadKeys('weird').a, 341, '越界的键码必须退回默认')
  // 同一份记录里合法的那个要保住
  localStorage.setItem(`${PREFIX}weird`, JSON.stringify({ ...DOS_PAD_DEFAULT, a: 99999, b: 87 }))
  assert.equal(loadDosPadKeys('weird').b, 87)
})

check('缺字段的存档按字段补默认（老版本 / 手改过）', () => {
  localStorage.setItem(`${PREFIX}partial`, JSON.stringify({ up: 87 }))
  const keys = loadDosPadKeys('partial')
  assert.equal(keys.up, 87)
  assert.equal(keys.down, 264)
  assert.equal(keys.a, 341)
})

check('localStorage 写不进去时也不抛（隐私模式）', () => {
  const real = globalThis.localStorage
  globalThis.localStorage = {
    getItem() {
      throw new Error('denied')
    },
    setItem() {
      throw new Error('denied')
    },
    removeItem() {
      throw new Error('denied')
    },
  }
  assert.deepEqual(loadDosPadKeys('x'), DOS_PAD_DEFAULT)
  saveDosPadKeys('x', DOS_PAD_DEFAULT)
  resetDosPadKeys('x')
  assert.equal(dosPadCustomized('x'), false)
  globalThis.localStorage = real
})

console.log(failed ? `\n❌ ${failed} 项失败\n` : '\n✅ 全部通过\n')
process.exit(failed ? 1 : 0)
