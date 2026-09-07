/**
 * 简→繁转换层（`server/src/zh-convert.js`）的单元测试。**不联网**。
 *
 * 盯住五件事：
 *   1. 用的是 s2twp 那一档 —— 转出来的用词要和 `src/locales/zh-Hant.ts` 的台湾用词对齐
 *   2. 游戏名这类专有名词不许被词库改写（这是选 s2twp 时唯一真正的风险）
 *   3. 「没有汉字」和「空值」的早退路径不炸、不把 undefined 变成 'undefined' 写进 JSON 列
 *   4. 转换器是记忆化的 —— 1MB 词库不能每调一次就重建一次 Trie
 *   5. 整篇 Markdown 直接转不会破坏结构标记和链接
 *
 * 跑：`cd server && npm run test:zh-convert`
 */
import assert from 'node:assert/strict'

const { toTraditional, loadSimplifiedToTraditional, isZhConvertAvailable } = await import('../src/zh-convert.js')

let pass = 0
const fails = []
const ok = (name) => {
  pass += 1
  console.log(`  ✓ ${name}`)
}
const bad = (name, e) => {
  fails.push(name)
  console.log(`  ✗ ${name}\n    ${e?.message || e}`)
}

if (!(await isZhConvertAvailable())) {
  console.error('opencc-js 没装 —— 先在 server/ 下 npm i')
  process.exit(1)
}

/* ---------------- 1. 用词档位 ---------------- */
try {
  // 这几条是 s2t / s2tw / s2twp 三档的分界线，改档位任意一条都会红。
  // 期望值来自 src/locales/zh-Hant.ts 的既有用词（「免費線上玩」「支援即時存檔」「預設」）。
  assert.equal(await toTraditional('在线玩'), '線上玩')
  assert.equal(await toTraditional('支持'), '支援')
  assert.equal(await toTraditional('默认'), '預設')
  assert.equal(await toTraditional('设置'), '設定')
  // 字形也要是台湾那一套：s2t 会给出「裏」，这里必须是「裡」
  assert.ok((await toTraditional('在浏览器里')).includes('裡'), '「里」要转成「裡」不是「裏」')
  ok('用的是 s2twp 档：用词和 zh-Hant.ts 的界面文案对齐')
} catch (e) {
  bad('用的是 s2twp 档：用词和 zh-Hant.ts 的界面文案对齐', e)
}

/* ---------------- 2. 专有名词不被改写 ---------------- */
try {
  // 词库里是通用词条，游戏名不在其中 —— 只做字形转换。
  assert.equal(await toTraditional('合金弹头 3'), '合金彈頭 3')
  assert.equal(await toTraditional('超级马力欧兄弟'), '超級馬力歐兄弟')
  assert.equal(await toTraditional('魂斗罗'), '魂鬥羅')
  assert.equal(await toTraditional('古惑狼'), '古惑狼')
  assert.equal(await toTraditional('侵略者'), '侵略者')
  ok('游戏名只做字形转换，不被词库改写')
} catch (e) {
  bad('游戏名只做字形转换，不被词库改写', e)
}

/* ---------------- 3. 早退与空值 ---------------- */
try {
  // 纯英文 / 纯数字：原样返回。注意是**返回原值而不是空串** ——
  // pretranslate.mjs 与发布钩子都靠「结果 === 原文」判断这条不值得落库。
  assert.equal(await toTraditional('Metal Slug 3'), 'Metal Slug 3')
  assert.equal(await toTraditional('kof97'), 'kof97')
  assert.equal(await toTraditional(''), '')
  // 非字符串不许变成 'undefined' / 'null' 这种脏数据写进 JSON 列
  assert.equal(await toTraditional(undefined), '')
  assert.equal(await toTraditional(null), '')
  assert.equal(await toTraditional(123), '')
  ok('无汉字原样返回，空值与非字符串不产出脏数据')
} catch (e) {
  bad('无汉字原样返回，空值与非字符串不产出脏数据', e)
}

/* ---------------- 4. 记忆化 ---------------- */
try {
  // 同一个 Promise 实例 = 词库只装一次。退化成每次新建的话，
  // 91 款游戏 × 多个字段会把 1MB 词库反复灌进 Trie，脚本慢到没法用。
  const a = loadSimplifiedToTraditional()
  const b = loadSimplifiedToTraditional()
  assert.equal(a, b, '两次调用必须拿到同一个 Promise')
  assert.equal(await a, await b, '两次调用必须拿到同一个转换函数')
  ok('转换器记忆化：词库只装一次')
} catch (e) {
  bad('转换器记忆化：词库只装一次', e)
}

/* ---------------- 5. Markdown 结构不被破坏 ---------------- */
try {
  const md = ['## 本周更新', '', '- 修复了 `save state` 的问题', '', '详见 [说明](https://8bitgo.com/blog/x)。'].join('\n')
  const out = await toTraditional(md)
  assert.ok(out.includes('## '), '标题标记要保留')
  assert.ok(out.includes('`save state`'), '行内代码要原样保留')
  assert.ok(out.includes('(https://8bitgo.com/blog/x)'), '链接地址不许被动')
  assert.ok(out.includes('\n\n'), '段落之间的空行要保留')
  assert.ok(out.includes('修復'), '正文汉字要转')
  ok('整篇 Markdown 直接转，结构标记与链接不受影响')
} catch (e) {
  bad('整篇 Markdown 直接转，结构标记与链接不受影响', e)
}

if (fails.length) {
  console.error(`\n❌ ${fails.length} 项失败：${fails.join('、')}`)
  process.exit(1)
}
console.log(`\n✅ 简→繁转换层：${pass} 项检查通过`)
