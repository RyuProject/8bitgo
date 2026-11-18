// 平台表的不变量。跑：npm run test:platforms
//
// 目前只盯一条，但它值一个独立的测试文件：**每个平台都必须声明 runtime**。
//
// 背景（2026-09-07 修）：java 平台的 runtime 曾经是 null，本意是「j2me 要自托管，
// 没配就当不存在」。可那个目的 registry 里的 platformDefault() 自己就达成了 ——
// 它会判 available() && supports()。写 null 只是多余的第二道保险，却换来一个会闪的 bug：
//
//   resolveRuntime 的第 1、2 步都要 ext，而 ext 来自 extOf(romUrl)，romUrl 是异步
//   探测出来的。探测回来之前只剩第 3 步 platformDefault —— runtime 为 null 就返回
//   undefined，页面显示「该平台暂不支持在线运行」；ROM 地址一到又变成「开始游戏」。
//   同一个 URL 两种状态，取决于这次探测走缓存还是走网络。
//
// 所以：runtime 是「这个平台默认拿什么跑」，**不是**「这个引擎部署了没有」。
// 后者由 available() 回答，不要用 null 去表达。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/data/platforms.ts', import.meta.url), 'utf8')
const browse = readFileSync(new URL('../src/pages/BrowsePages.tsx', import.meta.url), 'utf8')
const detect = readFileSync(new URL('../src/emulator/detect.ts', import.meta.url), 'utf8')

// 先把注释剥掉再匹配。否则像上面那段说明一样、写在 id 和 runtime 之间的长注释
// 会把两者顶出正则的窗口，测试就会误报「平台不见了」（第一版就踩了）。
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

/** 从源码里抓出每个平台的 id 和 runtime。不 import 是因为这份文件带 TS 类型和 i18n 依赖 */
const found = []
for (const m of stripComments(src).matchAll(/id: '([A-Za-z0-9]+)',[\s\S]{0,800}?runtime: ([^,\n]+),/g)) {
  found.push({ id: m[1], runtime: m[2].trim() })
}

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

check('平台表解析出来了', () => {
  assert.ok(found.length >= 14, `只解析到 ${found.length} 个平台，platforms.ts 的写法变了，这个测试要跟着改`)
})

/*
  唯一的例外：根本不走通用播放器、只有独立页面的平台。
  2026-11-16（481af52）加的塞班 / N-Gage 走 /symbian 的 EKA2L1 专用页，要玩家先导入授权固件，
  platforms.ts 里写明了「不能接进通用 ROM 播放器」。它的 runtime 写 null 表达的是「通用播放器里
  确实没有任何引擎」，不是「引擎还没部署」—— 和上面 java 那次的语义不一样。
  ⚠️ 例外不是白给的：闪烁 bug 的前提是「ROM 探测回来后有引擎能按扩展名接手」，下面那条检查
  逐项钉住这个前提对它不成立；名单外的平台照旧一个 null 都不许有。
*/
const DEDICATED_PAGE_PLATFORMS = { symbian: '/symbian' }

check('每个平台都声明了 runtime —— 除独立页面平台外一个 null 都不许有', () => {
  const nulls = found
    .filter((p) => p.runtime === 'null' && !Object.hasOwn(DEDICATED_PAGE_PLATFORMS, p.id))
    .map((p) => p.id)
  assert.deepEqual(
    nulls,
    [],
    `${nulls.join('、')} 的 runtime 是 null。` +
      '这会让 ROM 探测回来之前 resolveRuntime 返回 undefined，页面谎报「该平台暂不支持在线运行」，' +
      '探完又变回能玩。引擎有没有部署交给 available() 判，别用 null 表达。',
  )
})

check('⚠️ 独立页面平台在通用播放器里始终没有引擎（不会闪），且独立入口真的存在', () => {
  const meta = stripComments(readFileSync(new URL('../src/emulator/runtimeMeta.ts', import.meta.url), 'utf8'))
  const routes = readFileSync(new URL('../src/AppRoutes.tsx', import.meta.url), 'utf8')
  const plain = stripComments(src)
  for (const [id, route] of Object.entries(DEDICATED_PAGE_PLATFORMS)) {
    const entry = found.find((p) => p.id === id)
    assert.ok(entry, `${id} 平台不见了 —— 不再需要例外的话把它从 DEDICATED_PAGE_PLATFORMS 里删掉`)
    assert.equal(entry.runtime, 'null', `${id} 已经有通用运行时了，从例外名单里删掉，按普通平台验收`)
    const at = plain.indexOf(`id: '${id}',`)
    const block = plain.slice(at, plain.indexOf('\n  },', at))
    // EmulatorJS 的 supports 只看 core：core 非空它就会在探测回来后接手，又闪回「能玩」。
    assert.match(block, /\bcore: null,/, `${id} 配了 core，EmulatorJS 会在 ROM 探测后接手`)
    assert.ok(!meta.includes(`'${id}'`), `runtimeMeta.ts 里有运行时声明支持 ${id}，通用播放器会在探测后改口`)
    assert.doesNotMatch(detect, new RegExp(`: '${id}',`), `detect.ts 把某个扩展名映射到了 ${id}`)
    assert.ok(routes.includes(`path="${route}"`), `${id} 的独立页面路由 ${route} 不见了，玩家没有任何入口`)
  }
})

check('java 走 j2me（这条是上面那个 bug 的原案发地）', () => {
  const java = found.find((p) => p.id === 'java')
  assert.ok(java, 'java 平台不见了')
  assert.equal(java.runtime, "'j2me'")
})

check('ps2 走 Play!，不能再回到“暂不支持在线运行”', () => {
  const ps2 = found.find((p) => p.id === 'ps2')
  assert.ok(ps2, 'ps2 平台不见了')
  assert.equal(ps2.runtime, "'play'")
})

check('PSP 固定走自建 PPSSPP，不退回 EmulatorJS 整盘下载', () => {
  const psp = found.find((p) => p.id === 'psp')
  assert.ok(psp, 'psp 平台不见了')
  assert.equal(psp.runtime, "'ppsspp'")
})

check('GameCube / Wii 都固定走 wasm-dolphin', () => {
  for (const id of ['gamecube', 'wii']) {
    const platform = found.find((p) => p.id === id)
    assert.ok(platform, `${id} 平台不见了`)
    assert.equal(platform.runtime, "'dolphin'")
  }
})

check('新增的最高 / 高 / 中优先级 WASM 平台全部走 EmulatorJS', () => {
  const expected = [
    'segaMS', 'segaGG', 'segaCD',
    'pce', 'ngp', 'atari2600', 'atari5200', 'atari7800', 'lynx',
    'sega32x', 'c64', 'amiga',
  ]
  for (const id of expected) {
    const platform = found.find((p) => p.id === id)
    assert.ok(platform, `${id} 平台不见了`)
    assert.equal(platform.runtime, "'emulatorjs'", `${id} 没走 EmulatorJS`)
  }
})

check('新增平台的专用 ROM 后缀都能自动识别', () => {
  const expected = {
    sms: 'segaMS', gg: 'segaGG', '32x': 'sega32x',
    pce: 'pce', ngp: 'ngp', ngc: 'ngp',
    a26: 'atari2600', a52: 'atari5200', a78: 'atari7800', lnx: 'lynx',
    d64: 'c64', crt: 'c64', adf: 'amiga', hdf: 'amiga',
  }
  for (const [extension, platform] of Object.entries(expected)) {
    assert.match(
      detect,
      new RegExp(`(?:^|\\n)\\s*(?:'${extension}'|${extension}): '${platform}',`),
      `.${extension} 没有映射到 ${platform}`,
    )
  }
})

check('已开放的 Linux 虚拟机在平台总览有入口', () => {
  assert.ok(browse.includes('href="/linux"') && browse.includes('t.browse.linuxTitle') && browse.includes('t.browse.linuxAction'))
})

console.log(`\n✅ 平台表：${passed} 项检查通过`)
