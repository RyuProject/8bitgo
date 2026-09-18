/**
 * 街机那三列入库校验：`arcade_romdata`（改版包的 FBNeo RomData）、
 * `arcade_bios`（这款游戏要哪个 BIOS 系统包）和 `arcade_dip`（DIP 开关：麻将那一档）。
 *
 * 三列的共同点：内容都会被喂给模拟器（写进虚拟文件系统、或者作为核心选项写下去）、
 * 由核心自己去解析 / 查找，所以校验的重点不是语法，而是那些「存得进去、跑起来却安静失效」的情况：
 *   · RomData 带 CRLF —— dat 是按行 token 化解析的，\r 会并进最后一个 token，romset 名就对不上
 *   · RomData 缺 ZipName/DrvName —— 核心拿不到驱动名会安静退回普通流程，
 *     表现是「后台明明填了，游戏还是 Romset is unknown」
 *   · BIOS 名形状不对（`pgm.zip`、`bios/pgm`）—— 核心按 set 名找文件，拼什么名字都找不到，
 *     表现是「缺文件」，看上去像 ROM 的问题
 *   · DIP 开关里混进分隔符 / 被小写化 —— 键名是核心定的、大小写敏感，改一下就是「填了没反应」
 *
 * 最后两段不是纯代码测试：一段断言**线上数据**（索引里 PGM 那批到底标的是哪个 BIOS），
 * 一段断言播放器侧注入器的形状。重新生成索引 / 改注入器时它们会红，那正是该有人看一眼的时刻。
 *
 * ⚠️ 播放器**怎么把 DIP 变成核心选项**不在这里测 —— 那一套（认「摇杆 / 麻将」那一项、
 * 取值挑不到就不动）在 scripts/test-arcade-dip.mjs 里，配 dipPlan.ts 看。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { arcadeBiosOf, arcadeDipOf, arcadeRomDataOf, gameApiToRow, gameApiToPartialRow, gameRowToApi } from '../server/src/mappers.js'
import { loadBiosByName, romsetNameFromKey } from '../server/src/arcade-bios-index.js'
import { biosNameOfUrl, planBiosFiles } from '../src/emulator/biosPlan.ts'

const OK = 'ZipName wofcn\nDrvName wofj\nFullName Warriors of Fate (Chinese)\ntk2_01.3a 0x080000 0x0d9cb9bf BRF_GRA CPS1_TILES'

assert.equal(arcadeRomDataOf(OK), OK)
assert.equal(arcadeRomDataOf(null), null)
assert.equal(arcadeRomDataOf('   '), null)

// CRLF 统一成 LF，控制字符清掉，但制表符保留（dat 的分隔符里就有 \t）
assert.equal(arcadeRomDataOf('ZipName\twofcn\r\nDrvName\twofj\r\n'), 'ZipName\twofcn\nDrvName\twofj')
assert.ok(!arcadeRomDataOf('ZipName wofcn\nDrvName wofj').includes(''))

// 别名也认：RomName / Parent 是 FBNeo 接受的同义词
assert.equal(arcadeRomDataOf('RomName wofcn\nParent wofj'), 'RomName wofcn\nParent wofj')
// 大小写不敏感，和核心的 _tcsicmp 一致
assert.equal(arcadeRomDataOf('zipname wofcn\ndrvname wofj'), 'zipname wofcn\ndrvname wofj')

// 缺任一必填项都要当场 400，而不是留到玩家点开游戏才发现
assert.throws(() => arcadeRomDataOf('ZipName wofcn\ntk2_01.3a 0x80000 0x0d9cb9bf BRF_GRA'), /ZipName/)
assert.throws(() => arcadeRomDataOf('DrvName wofj\n'), /ZipName/)
// 只在注释里出现不算数
assert.throws(() => arcadeRomDataOf('// DrvName wofj\nZipName wofcn'), /ZipName/)
assert.throws(() => arcadeRomDataOf('ZipName wofcn\nDrvName wofj\n' + 'x'.repeat(40000)), /太长/)

for (const fn of [arcadeRomDataOf]) {
  try {
    fn('ZipName wofcn')
    assert.fail('应该抛错')
  } catch (e) {
    assert.equal(e.status, 400)
    assert.equal(e.expose, true)
  }
}

assert.equal(gameRowToApi({ slug: 'wofcn', arcade_romdata: OK }).arcadeRomData, OK)
assert.equal(gameRowToApi({ slug: 'kof97' }).arcadeRomData, undefined)
assert.equal(gameApiToRow({ slug: 'wofcn', arcadeRomData: OK }).arcade_romdata, OK)
assert.equal(gameApiToRow({ slug: 'kof97' }).arcade_romdata, null)
// 清空要写成 NULL，否则会留下一份空 dat
assert.deepEqual(gameApiToPartialRow({ arcadeRomData: '' }), { arcade_romdata: null })

/* ---------------- arcade_bios：这款游戏要哪个 BIOS 系统包 ---------------- */

assert.equal(arcadeBiosOf('pgm'), 'pgm')
assert.equal(arcadeBiosOf('neogeo'), 'neogeo')
// 大小写与首尾空格都归一 —— 后台是手输的，`  NeoGeo ` 得当成 neogeo
assert.equal(arcadeBiosOf('  NeoGeo  '), 'neogeo')
// 下划线是合法的：FBNeo 的 set 名里有 ngp_ngp / astro_astrocde / nmk004 这类
assert.equal(arcadeBiosOf('ngp_ngp'), 'ngp_ngp')
assert.equal(arcadeBiosOf('astro_astrocde'), 'astro_astrocde')
assert.equal(arcadeBiosOf(null), null)
assert.equal(arcadeBiosOf(''), null)
assert.equal(arcadeBiosOf('   '), null)
// 清空要写成 NULL，不能留一个空串在库里
assert.equal(gameApiToRow({ slug: 'kov', arcadeBios: '' }).arcade_bios, null)

/*
  形状不对必须**当场 400**，而不是存进去之后等玩家报「缺文件」。
  这几个都是有人真会填错的写法：把文件名当系统名填、带上路径、带上别的分隔符。
*/
for (const bad of ['pgm.zip', 'bios/pgm', 'pgm.rom', 'neo geo', 'pgm;rm', '..', 'x'.repeat(33), 'PGM-ZIP']) {
  try {
    arcadeBiosOf(bad)
    assert.fail(`「${bad}」不该通过校验`)
  } catch (e) {
    assert.equal(e.status, 400, `「${bad}」应以 400 拒绝`)
    assert.equal(e.expose, true, `「${bad}」的报错要说给管理员听`)
  }
}

assert.equal(gameRowToApi({ slug: 'kov', arcade_bios: 'pgm' }).arcadeBios, 'pgm')
// 没填就不带这个字段 —— 播放器据此回落到平台级 BIOS（加这个功能之前的行为）
assert.equal(gameRowToApi({ slug: 'kof97' }).arcadeBios, undefined)
assert.equal(gameApiToRow({ slug: 'kov', arcadeBios: 'PGM' }).arcade_bios, 'pgm')
assert.equal(gameApiToRow({ slug: 'kof97' }).arcade_bios, null)
assert.deepEqual(gameApiToPartialRow({ arcadeBios: '' }), { arcade_bios: null })
assert.deepEqual(gameApiToPartialRow({ arcadeBios: 'pgm' }), { arcade_bios: 'pgm' })

/* ---------------- arcade_dip：街机 DIP 开关（麻将那一档） ---------------- */

assert.equal(arcadeDipOf(null), null)
assert.equal(arcadeDipOf('   '), null)
assert.equal(arcadeDipOf('  mahjong '), 'mahjong')
// 中文写法也认（后台是中文界面，管理员照提示写「麻将」也不该被打回）
assert.equal(arcadeDipOf('麻将'), '麻将')
// 多条统一成 `, ` 连接、两端空白收干净（存进去的是人能再读一遍的样子）
assert.equal(arcadeDipOf('Controls=Mahjong ,  Tiles=Mahjong'), 'Controls=Mahjong, Tiles=Mahjong')
assert.equal(arcadeDipOf('Test mode=On;Tiles=Mahjong'), 'Test mode=On, Tiles=Mahjong')

/*
  ⚠️ 这一条最要紧：完整键**不能**被小写化。
  `fbneo-dipswitch-kov-Controls` 里的键名是核心定的、大小写敏感，小写之后再也匹配不上，
  症状是「后台填了、跑起来没反应」，而且没有任何报错。
*/
const dipFullKey = 'fbneo-dipswitch-kov-Controls=Mahjong'
assert.equal(arcadeDipOf(dipFullKey), dipFullKey)
assert.equal(arcadeDipOf('fbneo-dipswitch-kov-Test_mode=On'), 'fbneo-dipswitch-kov-Test_mode=On')

// 形状不对当场 400，别留到玩家点开游戏才发现
for (const bad of ['Controls Mahjong', '=Mahjong', 'Controls=', 'Controls, Tiles', 'x'.repeat(210)]) {
  try {
    arcadeDipOf(bad)
    assert.fail(`「${bad}」不该通过校验`)
  } catch (e) {
    assert.equal(e.status, 400)
  }
}
assert.throws(() => arcadeDipOf('a=1, b=2, c=3, d=4, e=5'), /最多 4 条/)
// 一条里再出现等号会把「组名 / 值」切歪，也拦掉
assert.throws(() => arcadeDipOf('Controls=Mahjong=On'), /看不懂/)

// 写库 / 读回来 / PATCH 三条路都要认这个字段
assert.equal(gameApiToRow({ slug: 'kov', arcadeDip: 'mahjong' }).arcade_dip, 'mahjong')
assert.equal(gameApiToRow({ slug: 'kof97' }).arcade_dip, null)
assert.equal(gameRowToApi({ slug: 'kov', arcade_dip: 'mahjong' }).arcadeDip, 'mahjong')
// 没填就不带这个字段 —— 播放器据此保持核心默认（加这个功能之前的行为）
assert.equal(gameRowToApi({ slug: 'kof97' }).arcadeDip, undefined)
assert.deepEqual(gameApiToPartialRow({ arcadeDip: '' }), { arcade_dip: null })
assert.deepEqual(gameApiToPartialRow({ arcadeDip: 'mahjong' }), { arcade_dip: 'mahjong' })

/* ---------------- 线上数据：索引里那几个 romset 到底要哪个 BIOS ---------------- */

/*
  这一节守的是**事实**而不是代码。整个功能（自动填、回填脚本、后台提示）都建立在
  「orlegend/kov 要 pgm、kof97 要 neogeo、wof/sf2 不要 BIOS」这几条之上。
  哪天有人用别的 FBNeo 版本重新生成 public/arcade-romsets.bin，这几条一红就说明
  线上判断会跟着变 —— 那正是最该有人看一眼的时刻。
*/
const INDEX = fileURLToPath(new URL('../public/arcade-romsets.bin', import.meta.url))
const { byName, setCount } = loadBiosByName(INDEX)
assert.ok(setCount > 8000, `索引里的 romset 数看着不对：${setCount}`)
assert.ok(byName.size > 1000, `需要 BIOS 的 romset 数看着不对：${byName.size}`)
// Neo Geo 全系
assert.equal(byName.get('kof97'), 'neogeo')
assert.equal(byName.get('mslug'), 'neogeo')
// IGS PGM 那一批（三国战纪 / 西游释厄传）
assert.equal(byName.get('orlegend'), 'pgm')
assert.equal(byName.get('kov'), 'pgm')
assert.equal(byName.get('drgw2'), 'pgm')
// CPS1 / CPS2 不需要 BIOS —— 它们要是出现在表里，说明这份索引变味了
assert.equal(byName.get('wof'), undefined)
assert.equal(byName.get('sf2'), undefined)
// BIOS 系统包自己也在索引里（parent 与 bios 都为空），所以不会被当成需要 BIOS 的游戏
assert.equal(byName.get('pgm'), undefined)
assert.equal(byName.get('neogeo'), undefined)

// 对象 key → romset 短名：8BG 容器和查询串都要剥掉
assert.equal(romsetNameFromKey('roms/arcade/kof97.zip'), 'kof97')
assert.equal(romsetNameFromKey('roms/arcade/kof97.zip.8bg'), 'kof97')
assert.equal(romsetNameFromKey('https://assets.example.com/roms/java/x.zip?romv=abc'), 'x')
assert.equal(romsetNameFromKey('KOF97.ZIP'), 'kof97')

/* ---------------- 播放器侧：这次开局要放哪几个 BIOS 包 ---------------- */

/*
  决策在 src/emulator/biosPlan.ts（纯函数），这里把三条规则逐条钉住。
  它们都是「写错了看不出问题、线上只是少一个文件」的那类逻辑：
  而症状（核心报 missing files）看上去永远像是 ROM 的问题。
*/
const PG = 'https://assets.example.com/roms/bios/pgm.zip'
const NEO = '/bios/neogeo.zip'

// 不需要 / 不知道要哪个 → 什么都不做（也就是加这个功能之前的行为）
assert.deepEqual(planBiosFiles(undefined, undefined), { files: [], warning: null })
assert.deepEqual(planBiosFiles(NEO, { name: '', url: PG }), { files: [], warning: null })

// 名字小写化：后台是手输的
assert.deepEqual(planBiosFiles(NEO, { name: ' PGM ', url: PG }).files, [{ path: '/pgm.zip', url: PG }])

/*
  ⭐ 系统名形状不对 → 不写文件，并且留一条说清楚哪里错的日志。

  「玩本地 ROM」页的系统名是**浏览器里手输的**（本地文件在库里没有记录，没人替它校验），
  而这个名字会被拿去拼虚拟文件系统的路径。填成 `../x` 就是往别的路径写文件 ——
  症状还是「文件写了、核心说找不到」，查起来毫无线索。这里是那道闸。
*/
for (const bad of ['../x', 'pgm.zip', 'bios/pgm', 'neo geo', 'x'.repeat(33)]) {
  const plan = planBiosFiles(NEO, { name: bad, url: PG })
  assert.deepEqual(plan.files, [], `「${bad}」不该写文件`)
  assert.match(plan.warning ?? '', /不合法|不合法/, `「${bad}」要留下一条说清楚原因的日志`)
}
// 归一化之后是合法形状的，照样放行（大小写、空格都该被容忍）
assert.deepEqual(planBiosFiles(NEO, { name: ' PGM ', url: PG }).files, [{ path: '/pgm.zip', url: PG }])

// ⭐ 没绑定 → 不写，但日志里必须点名 bios:<名字>（核心只会说「缺文件」）
const missing = planBiosFiles(NEO, { name: 'pgm', url: '' })
assert.deepEqual(missing.files, [])
assert.match(missing.warning ?? '', /bios:pgm/)
assert.match(missing.warning ?? '', /街机 BIOS 包/)

// ⭐ 平台级那份是**别的**系统 → 必须额外写进去（这就是 PGM 起不来的那个缺口）
assert.deepEqual(planBiosFiles(NEO, { name: 'pgm', url: PG }).files, [{ path: '/pgm.zip', url: PG }])

// ⭐ 平台级那份**正好就是它** → 不写：EJS_biosUrl 已经放进去了，再下一遍白花流量
assert.deepEqual(planBiosFiles(NEO, { name: 'neogeo', url: 'https://x/neogeo.zip' }), {
  files: [],
  warning: null,
})

// 平台级地址带查询串 / 大写后缀时也要认出来（后台填过各种写法）
assert.deepEqual(biosNameOfUrl('https://x/y/NeoGeo.ZIP?romv=abc'), 'neogeo')
assert.deepEqual(biosNameOfUrl('/bios/neogeo.zip#frag'), 'neogeo')
assert.equal(biosNameOfUrl(undefined), '')
assert.equal(biosNameOfUrl(''), '')
assert.deepEqual(
  planBiosFiles('https://x/neogeo.zip?v=2', { name: 'neogeo', url: 'https://x/neogeo.zip' }).files,
  [],
)

/* ---------------- 注入通道只有一条（源码断言） ---------------- */

/*
  `Object.defineProperty(window, 'EJS_emulator', …)` 只能留一个 setter ——
  后来定义的那个会盖掉前一个，症状是「某个文件静默没写进去」。
  RomData 和额外的 BIOS 必须共用同一个注入器，这条守着它不再长出第二个。
*/
const emulatorSrc = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
const defineCount = (emulatorSrc.match(/Object\.defineProperty\(win, 'EJS_emulator'/g) ?? []).length
assert.equal(
  defineCount,
  1,
  `EJS_emulator 的 setter 被定义了 ${defineCount} 次 —— 后一个会盖掉前一个，文件会静默写不进去`,
)

// ⭐ BIOS 下载必须走带进度的那条通道（fetchWithProgress），不能用裸 fetch。
//   卡死检测的心跳挂在引擎自己的下载上，我们这条它看不见 —— 慢网上下 1.5 MB 的
//   pgm.zip 超过 30 秒时，玩家会先看到「卡住了」，而游戏其实照常在遮罩后面起来。
const biosFn = (() => {
  const at = emulatorSrc.indexOf('function fetchBiosBytes')
  assert.ok(at > 0, '找不到 fetchBiosBytes —— 改名了就把这条测试一起改')
  const end = emulatorSrc.indexOf('\n}\n', at)
  return emulatorSrc.slice(at, end)
})()
assert.match(biosFn, /fetchWithProgress\(/, 'BIOS 下载必须走 fetchWithProgress，否则卡死检测看不见它')
assert.doesNotMatch(biosFn, /[^h]fetch\(/, 'BIOS 下载里出现了裸 fetch —— 那会让它脱离卡死检测的心跳')
assert.match(biosFn, /onBeat\(\)/, '下载过程中要拍心跳')

console.log('街机 RomData / BIOS 映射与索引数据测试通过')

