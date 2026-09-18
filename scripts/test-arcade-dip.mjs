/**
 * 街机 DIP 开关（`games.arcade_dip` → 核心选项）的回归。
 *
 * 这一套守的是三类「存得进后台、跑起来却安静失效」的情况：
 *
 *   1. **认错项**。`mahjong` 预设按「取值里同时有摇杆和麻将」认那一项 ——
 *      有的游戏另有一项叫 `Tiles: Mahjong/Cards`（牌面图案），
 *      只按「Mahjong」找会把它拨掉，玩家看到的还是玩不了，而且更难查。
 *   2. **值写错一个字**。核心只认它自己报上来的取值原文，写错的那一档是**静默**的
 *      （changeSettingOption 往 allSettings 塞一格就完了），所以这里要断言
 *      「挑不到就不动，并且留一条把可选值列出来的日志」。
 *   3. **非 FBNeo 核心**。mame2003 系没把 DIP 做成核心选项，那时核心一个 dipswitch 键
 *      都不报 —— 要有一条点名这件事的警告，而不是安静地什么都不干。
 *
 * 最后一段是源码断言（照 test-romdata.mjs 那套）：后台填的那一栏必须真的被适配器用上，
 * 而且必须走「改完回读核对」那条路 —— 光在配置里好看等于没做。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dipNameOf, findDipOptions, matchDipValue, parseArcadeDip, planDipChanges } from '../src/emulator/dipPlan.ts'
import { parseCoreOptionsText } from '../src/emulator/dualScreen.ts'

/** 照 EmulatorJS 的 get_core_options_json 的样子造一份：v2 的 values 是 [{value,label}] */
const opt = (key, values, extra = {}) => ({
  key,
  values: values.map((value) => ({ value, label: value })),
  ...extra,
})

/* ---------------- findDipOptions ---------------- */

const PGM = {
  options: [
    opt('fbneo-dipswitch-pgm-Test_mode', ['Off', 'On'], { default: 'Off', current: 'Off' }),
    opt('fbneo-dipswitch-pgm-Tiles', ['Joystick', 'Mahjong'], { default: 'Joystick', current: 'Joystick' }),
    opt('fbneo-dipswitch-pgm-Bios_select_Fake', ['Older', 'Newer']),
    // 不是 DIP：别的核心选项必须被滤掉
    opt('fbneo-allow-patched-romsets', ['disabled', 'enabled']),
    // 只有一个档的 DIP 没有意义，引擎自己的菜单也不画它
    opt('fbneo-dipswitch-pgm-Only_one', ['Only']),
  ],
}

const dip = findDipOptions(PGM)
assert.deepEqual(
  dip.map((o) => dipNameOf(o.key)),
  ['Test_mode', 'Tiles', 'Bios_select_Fake'],
  'findDipOptions 只该留下带 dipswitch、且取值多于一个的项',
)
// 数组形态和 {options} 形态都要认（适配器两条路都可能拿到）
assert.equal(findDipOptions(PGM.options).length, 3)
assert.equal(findDipOptions(null).length, 0)
assert.equal(findDipOptions(undefined).length, 0)

/* ---------------- parseArcadeDip ---------------- */

assert.deepEqual(parseArcadeDip('').intents, [])
assert.deepEqual(parseArcadeDip(undefined).intents, [])
assert.deepEqual(parseArcadeDip('   ').intents, [])

assert.deepEqual(parseArcadeDip('mahjong').intents, [{ kind: 'mahjong', name: '', value: '' }])
// 中文写法和大小写都认
assert.deepEqual(parseArcadeDip('麻将').intents, [{ kind: 'mahjong', name: '', value: '' }])
assert.deepEqual(parseArcadeDip('MAHJONG').intents, [{ kind: 'mahjong', name: '', value: '' }])

assert.deepEqual(parseArcadeDip('Controls=Mahjong').intents, [
  { kind: 'explicit', name: 'Controls', value: 'Mahjong' },
])
// 多条：逗号 / 分号 / 换行都当分隔符
assert.deepEqual(parseArcadeDip('Controls=Mahjong, Tiles=Mahjong').intents.length, 2)
assert.deepEqual(parseArcadeDip('Controls=Mahjong;Tiles=Poker').intents.length, 2)
assert.deepEqual(parseArcadeDip('Controls=Mahjong\nTiles=Poker').intents.length, 2)
// 重复的去掉（同一条写两遍没必要拨两次）
assert.equal(parseArcadeDip('mahjong, mahjong').intents.length, 1)
assert.equal(parseArcadeDip('controls=mahjong, Controls=Mahjong').intents.length, 1)
// 组名里的空格归一化后再比，所以这两种写法算同一条
assert.equal(parseArcadeDip('test mode=On, Test_mode=On').intents.length, 1)

// 看不懂的要留话，而不是默默丢掉
const badParse = parseArcadeDip('Controls Mahjong, 乱写, =On, Controls=')
assert.equal(badParse.intents.length, 0)
assert.match(badParse.warning, /看不懂/)
assert.match(badParse.warning, /Controls Mahjong/)
// 超长的一律挡掉（手滑贴进来一整段东西）
assert.equal(parseArcadeDip(`Controls=${'x'.repeat(40)}`).intents.length, 0)
assert.match(parseArcadeDip(`Controls=${'x'.repeat(40)}`).warning, /看不懂/)
// 条数上限：第 5 条形如 `a=b` 的直接丢
assert.equal(parseArcadeDip('a=1, b=2, c=3, d=4, e=5').intents.length, 4)

/* ---------------- matchDipValue ---------------- */

assert.equal(matchDipValue(['Off', 'On'], 'On'), 'On')
assert.equal(matchDipValue(['Off', 'On'], 'on'), 'On', '大小写不敏感')
assert.equal(matchDipValue(['Joystick', 'Mahjong panel'], 'Mahjong'), 'Mahjong panel', '唯一前缀可以认')
assert.equal(matchDipValue(['Off', 'On'], 'Enabled'), '', '挑不到就返回空串，绝不猜')
assert.equal(matchDipValue(['A', 'AB', 'ABC'], 'A'), 'A', '原样命中优先于前缀')
assert.equal(matchDipValue(['AB', 'ABC'], 'A'), '', '前缀命中两项 = 不知道要哪一档，不动')

/* ---------------- planDipChanges：预设 ---------------- */

// PGM 那种：一个选项里同时有 Joystick / Mahjong
const mj = planDipChanges('mahjong', PGM)
assert.equal(mj.warning, null)
assert.deepEqual(mj.changes, [
  { key: 'fbneo-dipswitch-pgm-Tiles', value: 'Mahjong', why: '麻将模式（Tiles = Mahjong；核心默认 Joystick）' },
])

/*
  关键的负面用例：只有 `Tiles: Mahjong/Cards` 这一项（牌面图案，没有摇杆档）时，
  预设**不能**去拨它 —— 拨了只是把牌面画成麻将牌，输入还是摇杆，玩家照样玩不了。
*/
const decoy = {
  options: [opt('fbneo-dipswitch-lastfort-Tiles', ['Mahjong', 'Cards'], { current: 'Mahjong' })],
}
const decoyPlan = planDipChanges('mahjong', decoy)
assert.deepEqual(decoyPlan.changes, [], '没有摇杆档的那一项不该被认成输入模式')
assert.match(decoyPlan.warning, /没找到「摇杆 \/ 麻将」那一项/)
assert.match(decoyPlan.warning, /Tiles = Mahjong \| Cards/, '警告里要列出核心报出来的 DIP，人才好照着重填')

// 麻将档排在摇杆前面也要认（词序不保证）
const reversed = { options: [opt('x-dipswitch-y-Input', ['Mahjong', 'Joystick'], { current: 'Joystick' })] }
assert.equal(planDipChanges('mahjong', reversed).changes[0]?.value, 'Mahjong')

/* ---------------- planDipChanges：显式 ---------------- */

const explicit = planDipChanges('Test mode=On', PGM)
assert.deepEqual(explicit.changes, [
  { key: 'fbneo-dipswitch-pgm-Test_mode', value: 'On', why: 'Test_mode = On' },
])
// 组名写成下划线的形式也一样（后台那一栏本来就是照核心的键名抄的）
assert.equal(planDipChanges('Test_mode=On', PGM).changes.length, 1)
// 完整键直接指定
assert.equal(planDipChanges('fbneo-dipswitch-pgm-Test_mode=On', PGM).changes[0]?.key, 'fbneo-dipswitch-pgm-Test_mode')
// 一条里面两处改动
assert.equal(planDipChanges('Test mode=On, Tiles=Mahjong', PGM).changes.length, 2)
// 取值必须落在核心报的那些档里：写个不存在的值 → 不动 + 把可选值列出来
const badValue = planDipChanges('Test mode=Enabled', PGM)
assert.deepEqual(badValue.changes, [])
assert.match(badValue.warning, /没有「Enabled」这一档/)
assert.match(badValue.warning, /Off \| On/)
// 组名写错 → 点名那个组名，并列出都有哪些
const badName = planDipChanges('Controls=Mahjong', PGM)
assert.deepEqual(badName.changes, [])
assert.match(badName.warning, /「Controls」在这一局的核心里不存在/)
assert.match(badName.warning, /Test_mode = Off \| On/)

/* ---------------- planDipChanges：非 FBNeo 核心 ---------------- */

const noDip = planDipChanges('mahjong', { options: [opt('melonds_screen_layout', ['Top/Bottom', 'Left/Right'])] })
assert.deepEqual(noDip.changes, [])
assert.match(noDip.warning, /只有 FBNeo 系核心/)
// 连核心选项表都拿不到（老构建 / 还没开局）也要说清楚
assert.match(planDipChanges('mahjong', null).warning, /只有 FBNeo 系核心/)

// 留空 = 完全不干预，也不该有任何噪音
assert.deepEqual(planDipChanges(undefined, PGM), { changes: [], warning: null })
assert.deepEqual(planDipChanges('  ', PGM), { changes: [], warning: null })

/* ---------------- 老格式文本那条路（我们这份 FBNeo 构建实际走的就是它） ---------------- */

/*
  实测（2026-09-18 把 public/emulatorjs/cores/fbneo-wasm.data 那个 7z 解开、搜符号）：
  这份 fbneo 构建里**有** `get_core_options`、**没有** `get_core_options_json`；
  同时 `fbneo-dipswitch-` 这个键前缀确实在 wasm 里，而核心是在 retro_load_game 里
  （retro_common.cpp 的 set_environment → SET_CORE_OPTIONS_V2）把 DIP 注册给前端的。
  也就是说：**真正跑起来时生效的是这条老格式文本的路**。
  这一段守它，顺便守住「当前值读得出来」—— 回读核对全靠那一格。
*/
const LEGACY = [
  'fbneo-dipswitch-pgm-Test_mode|Off; Off|On',
  'fbneo-dipswitch-pgm-Tiles|Joystick; (Default) Joystick|Mahjong',
].join('\n')

const legacyOptions = parseCoreOptionsText(LEGACY)
assert.equal(legacyOptions.length, 2)
// 老格式里 `key|` 后面那一截就是前端此刻生效的取值，不能丢
assert.equal(findDipOptions(legacyOptions)[1].current, 'Joystick')
// `(Default) ` 前缀要剥掉，否则回填给核心的是一个不存在的取值
assert.deepEqual(findDipOptions(legacyOptions)[1].values, ['Joystick', 'Mahjong'])

assert.deepEqual(planDipChanges('mahjong', legacyOptions).changes, [
  { key: 'fbneo-dipswitch-pgm-Tiles', value: 'Mahjong', why: '麻将模式（Tiles = Mahjong；核心默认 Joystick）' },
])
assert.equal(planDipChanges('Test mode=On', legacyOptions).changes[0]?.value, 'On')

/* ---------------- 适配器真的用上了它（源码断言） ---------------- */

const src = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
assert.match(src, /from '\.\.\/dipPlan'/, '适配器要 import dipPlan，否则后台那一栏没人读')
assert.match(src, /planDipChanges\(/, '适配器要调用 planDipChanges')
// 应用必须在开局之后（DIP 选项是核心在 retro_load_game 里才注册的）
const finishStartAt = src.indexOf('const finishStart = (win')
assert.ok(finishStartAt > 0, '找不到 finishStart —— 改名了就把这条测试一起改')
assert.ok(
  src.indexOf('applyArcadeDipDefault(', finishStartAt) > 0,
  'DIP 的应用要挂在 finishStart 之后 —— 开局前核心还没报出 DIP 选项',
)
// 写值必须走引擎那条路，并且**回读核对**（认不出的取值是静默失效的）
const dipFn = (() => {
  const at = src.indexOf('const applyArcadeDipDefault')
  assert.ok(at > 0, '找不到 applyArcadeDipDefault —— 改名了就把这条测试一起改')
  const end = src.indexOf('\n  }\n', at)
  return src.slice(at, end)
})()
assert.match(dipFn, /changeSettingOption\?\.\(/, '要通过 changeSettingOption 交给引擎')
assert.match(dipFn, /setVariable/, '菜单里没有那一行时要退回 gameManager.setVariable')
assert.match(dipFn, /回读到/, '改完必须回读核对，不能只打一句「已改」')
// 玩家自己在引擎菜单里选过的那一项，不能替他把选择拨回去
assert.match(dipFn, /emu\.settings\?\.\[/, '玩家自己选过的值要尊重')
// 改完还要重启一局：那一档多半是游戏在开机时读一次就定死的，不重启玩家看到的还是旧档
assert.match(dipFn, /gameManager\?\.restart\?\.\(\)/, 'DIP 改完要重启一局')
// 没改动就别重启（等于白白让玩家多等一遍开机画面）
assert.match(dipFn, /if \(changed\)/, '只在真改了东西时重启')

console.log('街机 DIP 开关（麻将模式）规划与适配器接线测试通过')
