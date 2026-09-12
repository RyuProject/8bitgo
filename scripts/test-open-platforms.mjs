/**
 * 平台目录的回归测试。跑：npm run test:open-platforms
 *
 * ## 这一份存在的唯一理由：两张表会漂
 *
 * `server/src/open/platforms.js` 是 `src/data/platforms.ts` 的**后端镜像**，
 * 它自己的文件头写着「两处的 id / core / romExtensions 必须对得上」——
 * 而在这个测试之前，**没有任何东西在盯着这句话**。
 *
 * 这个仓库为同一类问题付过代价：`shared/site-taxonomy.js` 的白名单漏了一行 `nds`，
 * 平台定义、三个核心、双屏布局全都做完了，而每一款 NDS 游戏的详情页 404 了好几周，
 * 直到有人报「cooking-mama 打不开」才发现。漂移的症状从来不是报错，
 * 是「某一类东西悄悄地不工作了」。
 *
 * 而这一次漂了的后果更远：目录是发给**第三方客户端**的，他们照着它选模拟器。
 * core 写错 = 那个平台的游戏在所有第三方客户端上都用错核心启动，
 * 而我们这边一切正常，永远不会收到报错。
 *
 * ## 怎么测
 *
 * 两张表都真的 import 进来逐格比对。前端那份是 .ts 但只 `import type`，
 * `--experimental-strip-types` 脱掉类型之后可以直接加载；
 * ⚠️ 必须按**相对路径**引它，不能写 `@/data/platforms` —— ts-loader 把那个
 * 别名桩成了 `{ platformMap: {} }`（见 scripts/helpers/ts-loader.mjs），
 * 那样比对的就是一张空表，测试恒绿。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { OPEN_PLATFORMS } from '../server/src/open/platforms.js'
import { platforms as SITE_PLATFORMS } from '../src/data/platforms.ts'
import { ENABLED_PLATFORM_IDS, isPlatformEnabledId } from '../shared/site-taxonomy.js'

let pass = 0
const fails = []
const check = (name, fn) => {
  try {
    fn()
    pass++
    console.log('  ✓ ' + name)
  } catch (e) {
    fails.push({ name, e })
    console.log('  ✗ ' + name + ' —— ' + (e?.message ?? e))
  }
}

const byId = new Map(SITE_PLATFORMS.map((p) => [p.id, p]))

console.log('\n── 镜像和前端那张表必须一致 ──')

check('⚠️ 两边的平台 id 集合完全相同', () => {
  const mine = OPEN_PLATFORMS.map((p) => p.id).sort()
  const theirs = SITE_PLATFORMS.map((p) => p.id).sort()
  assert.deepEqual(mine, theirs, '前端加了平台而镜像没跟上（或反过来）')
})

/*
  逐格比。这三个字段是第三方客户端**真正拿去做决定**的：
  runtime 决定它属于哪一类、core 决定用哪个模拟器核心、romExtensions 决定怎么喂文件。
  别的字段（name / year / manufacturer）错了只是显示难看，这三个错了是跑不起来。
*/
for (const field of ['runtime', 'core', 'romExtensions']) {
  check(`⚠️ 每个平台的 ${field} 和前端一致`, () => {
    const bad = []
    for (const p of OPEN_PLATFORMS) {
      const site = byId.get(p.id)
      if (!site) continue // id 集合那条已经报过了
      const a = JSON.stringify(p[field] ?? null)
      const b = JSON.stringify(site[field] ?? null)
      if (a !== b) bad.push(`${p.id}: 镜像=${a} 前端=${b}`)
    }
    assert.deepEqual(bad, [], '\n     ' + bad.join('\n     '))
  })
}

console.log('\n── enabled：站上并不是每个平台都开着 ──')

check('⚠️ enabled 跟着白名单现算，不是写死的', () => {
  for (const p of OPEN_PLATFORMS) {
    assert.equal(p.enabled, isPlatformEnabledId(p.id), `${p.id} 的 enabled 和白名单对不上`)
  }
})

check('⚠️ 关着的平台确实被标出来了（而不是整张表恒为 true）', () => {
  /*
    这一条防的是「enabled 写成了常量 true」。
    名单为空数组时表示「不限制、全部开放」，那时全 true 是对的 —— 所以只在
    名单非空时才要求至少有一个 false，否则这条断言自己就是错的。
  */
  if (ENABLED_PLATFORM_IDS.length === 0) {
    console.log('    （白名单为空 = 全部开放，这条跳过）')
    return
  }
  const off = OPEN_PLATFORMS.filter((p) => !p.enabled).map((p) => p.id)
  const on = OPEN_PLATFORMS.filter((p) => p.enabled).map((p) => p.id)
  assert.ok(on.length > 0, '一个平台都没开？白名单读错了')
  assert.deepEqual(
    off.sort(),
    SITE_PLATFORMS.map((p) => p.id).filter((id) => !isPlatformEnabledId(id)).sort(),
    '标出来的「关着的平台」和白名单算出来的对不上',
  )
})

console.log('\n── 数据本身的自洽 ──')

check('⚠️ runnable=false 的必须给出原因，runnable=true 的必须给出模拟器', () => {
  /*
    客户端会把 note 直接显示给用户（「这个平台本地跑不了，因为……」）。
    空的 note 配 runnable:false，用户看到的就是一个没有解释的灰按钮。
  */
  for (const p of OPEN_PLATFORMS) {
    if (p.native.runnable) {
      assert.ok(p.native.emulator, `${p.id} 说能本地跑，却没说用什么跑`)
    } else {
      assert.ok(p.native.note, `${p.id} 说本地跑不了，却没说为什么`)
      assert.equal(p.native.emulator, '', `${p.id} 跑不了却还推荐了模拟器`)
    }
  }
})

check('⚠️ 整张表是深冻结的（它是每个请求共用的单例）', () => {
  /*
    Object.freeze 只冻最外层。没深冻的话，将来任何一处
    `items.forEach(p => p.native.note = ...)` 会把这张表改坏，
    而且是进程范围、永久性的 —— 之后所有客户端拿到的都是被改过的表。
  */
  assert.ok(Object.isFrozen(OPEN_PLATFORMS), '外层数组没冻')
  for (const p of OPEN_PLATFORMS) {
    assert.ok(Object.isFrozen(p), `${p.id} 这一行没冻`)
    assert.ok(Object.isFrozen(p.native), `${p.id}.native 没冻`)
    assert.ok(Object.isFrozen(p.romExtensions), `${p.id}.romExtensions 没冻`)
  }
})

check('romExtensions 都是小写、带点、不重复', () => {
  for (const p of OPEN_PLATFORMS) {
    assert.ok(p.romExtensions.length > 0, `${p.id} 没有扩展名`)
    for (const e of p.romExtensions) {
      assert.match(e, /^\.[a-z0-9]+$/, `${p.id} 的扩展名 ${e} 形状不对`)
    }
    assert.equal(new Set(p.romExtensions).size, p.romExtensions.length, `${p.id} 的扩展名有重复`)
  }
})

console.log('\n── 文档不能和数据对不上 ──')

check('⚠️ 文档里说的「下载即跑」平台数和数据算出来的一致', () => {
  /*
    文档里原来写的是「runtime=emulatorjs 那 12 个」，后面括号里只列了 11 个 ——
    因为第 12 个是 java（runtime=j2me）。数字和列表当场对不上。

    这条把那个数字换成从数据现算，文档里只留一个占位的数字，改了表就会红。
  */
  const doc = readFileSync(new URL('../docs/esp-open-api.md', import.meta.url), 'utf8')
  const ejs = OPEN_PLATFORMS.filter((p) => p.runtime === 'emulatorjs')
  const m = doc.match(/`runtime=emulatorjs` 那 (\d+) 个/)
  assert.ok(m, '文档里找不到那句话了 —— 改了措辞的话这条断言也要跟着改')
  assert.equal(
    Number(m[1]),
    ejs.length,
    `文档说 ${m[1]} 个，数据里 runtime=emulatorjs 的实际是 ${ejs.length} 个`,
  )
})

console.log('\n── 路由：这张表必须是可缓存的 ──')

check('⚠️ /v1/platforms 自己盖掉全局 no-store，并给了一个正的 max-age', () => {
  // 文档 §12 明确建议客户端「缓存整张表（很少变）」。
  // /api 上挂着一道全局 noStore，如果这条路由不自己盖掉它，服务端发的就是 no-store——
  // 每台设备每次开机都要重新拉一遍 16 行静态数据，和文档写的正好相反。
  // 这条断言盯的就是「有人把那行 res.set 删了 / 改回 no-store」。
  const src = readFileSync(new URL('../server/src/routes/open.js', import.meta.url), 'utf8')
  const start = src.indexOf("openRouter.get('/v1/platforms'")
  assert.ok(start > 0, "找不到 openRouter.get('/v1/platforms') 了 —— 路由改了名的话这条断言也要跟着改")
  const rest = src.slice(start)
  const end = rest.indexOf('\n})')
  const handler = end === -1 ? rest : rest.slice(0, end)

  const m = handler.match(/Cache-Control['"]\s*,\s*['"]([^'"]+)['"]/)
  assert.ok(m, '这条路由没有设 Cache-Control —— 会落到全局 no-store 上')
  const value = m[1]
  assert.doesNotMatch(value, /no-store|no-cache/, `Cache-Control 是 ${value}，等于没缓存`)
  const age = value.match(/max-age=(\d+)/)
  assert.ok(age && Number(age[1]) > 0, `Cache-Control 是 ${value}，没有正的 max-age`)
})

console.log('')
if (fails.length) {
  for (const f of fails) console.error('✗ ' + f.name + '\n' + (f.e?.stack ?? f.e))
  console.error(`\n❌ ${fails.length} 条失败 / 共 ${pass + fails.length} 条`)
  process.exit(1)
}
console.log(`✅ 平台目录：${pass} 条全过`)
