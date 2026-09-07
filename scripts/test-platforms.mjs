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

// 先把注释剥掉再匹配。否则像上面那段说明一样、写在 id 和 runtime 之间的长注释
// 会把两者顶出正则的窗口，测试就会误报「平台不见了」（第一版就踩了）。
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

/** 从源码里抓出每个平台的 id 和 runtime。不 import 是因为这份文件带 TS 类型和 i18n 依赖 */
const found = []
for (const m of stripComments(src).matchAll(/id: '([a-z0-9]+)',[\s\S]{0,800}?runtime: ([^,\n]+),/g)) {
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

check('每个平台都声明了 runtime —— 一个 null 都不许有', () => {
  const nulls = found.filter((p) => p.runtime === 'null').map((p) => p.id)
  assert.deepEqual(
    nulls,
    [],
    `${nulls.join('、')} 的 runtime 是 null。` +
      '这会让 ROM 探测回来之前 resolveRuntime 返回 undefined，页面谎报「该平台暂不支持在线运行」，' +
      '探完又变回能玩。引擎有没有部署交给 available() 判，别用 null 表达。',
  )
})

check('java 走 j2me（这条是上面那个 bug 的原案发地）', () => {
  const java = found.find((p) => p.id === 'java')
  assert.ok(java, 'java 平台不见了')
  assert.equal(java.runtime, "'j2me'")
})

console.log(`\n✅ 平台表：${passed} 项检查通过`)
