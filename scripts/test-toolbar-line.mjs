/**
 * 模拟器工具栏「只占一行」的回归测试。跑：npm run test:toolbar
 *
 * ## 这一份在守什么
 *
 * 桌面端工具栏是**绝对定位压在画面底部**的（EmulatorPlayer 里的 overlayBar），
 * 所以它多折一行不是「界面丑一点」，而是**直接盖住游戏画面**。
 * 而它折行的门槛低得出乎意料 —— 只要有人往里加一段长度不定的文字。
 *
 * ## 那个反直觉的原因：truncate 在 flex-wrap 里是不生效的
 *
 * 工具栏是 `flex-wrap`。flex 的**换行判定用的是压缩前的尺寸**
 * （hypothetical main size），压缩只在换完行、每一行内部才发生。
 * 于是一个挂了 truncate 的长文本 span 根本走不到截断那一步 ——
 * 它先把自己（和它后面的按钮）顶到第二行去了。
 *
 * /play-local 上真实发生过：`📄 rusty-lake-hotel.swf · 21.1 MB` 加一句
 * `识别为 Flash 网页游戏（文件头为 SWF 标识）`，把「更换 ROM / 沉浸模式 / 全屏」
 * 挤成第二行盖在画面上。三个 span 当时**都**挂着 truncate，一个都没生效。
 *
 * ## 因此定下的规矩，也就是下面在查的东西
 *
 *   1. 长度不定的文字**只能**待在那一个 `flex-1`（= flex: 1 1 0%，basis 0）的区块里。
 *      basis 0 意味着换行判定时它算 0 宽 —— 永远不会把别人挤下去，只吃剩下的空隙。
 *   2. 工具栏的直接子节点里不许再出现 truncate —— 那就是「以为自己会截断、其实会折行」。
 *   3. 工具栏保留 flex-wrap（不能图省事改成 nowrap）：联机 + 直播 + 观众那几个
 *      纯文字徽章压不动，nowrap 会横向溢出，那时候折一行才是对的兜底。
 *   4. 右侧控件组要 shrink-0 —— 里面有 <select>，表单控件在 flex 里是会被压扁的。
 *
 * 数值验证（headless Chromium 量的行高，320–1400px 两种形态）不在这里跑：
 * 那需要 playwright，进不了这套 node 脚本。这一份守的是**结构**，
 * 结构一旦守住，那个数值结论就一直成立。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
/**
 * 去注释再扫。
 *
 * 这一步是被自己的注释坑出来的：下面那条「不许出现 truncate」第一次跑就红了，
 * 3 处命中全部来自本文件解释这个坑的**注释文字**里的 "truncate"。
 * `(^|[^:])` 那道前置是为了别把 https:// 当成行注释。
 */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const src = strip(readFileSync(path.join(root, 'src/emulator/EmulatorPlayer.tsx'), 'utf8'))

let n = 0
const check = (name, fn) => {
  n++
  try {
    fn()
    console.log('  ✓ ' + name)
  } catch (e) {
    console.log('  ✗ ' + name)
    throw e
  }
}

/* ---------------- 切出工具栏那一段，再切出里面的文字区块 ---------------- */

const barAt = src.indexOf('data-testid="emulator-toolbar"')
assert.ok(barAt > 0, '找不到 emulator-toolbar —— data-testid 被改了？')
// 工具栏的收尾：紧跟其后的「感应条」那一块
const barEnd = src.indexOf('overlayBar && barHidden && (', barAt)
assert.ok(barEnd > barAt, '找不到工具栏的结尾锚点')
const bar = src.slice(barAt, barEnd)

const REGION_CLASS = 'className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-muted"'
const regionAt = bar.indexOf(REGION_CLASS)
// 开标签在 8 个空格的缩进上，闭合标签同缩进 —— 取第一个同缩进的 </div>
const regionEnd = regionAt < 0 ? -1 : bar.indexOf('\n        </div>', regionAt)
const region = regionAt < 0 ? '' : bar.slice(regionAt, regionEnd)
/** 工具栏里除文字区块以外的部分 —— 也就是那些「直接子节点」所在的地方 */
const outside = regionAt < 0 ? bar : bar.slice(0, regionAt) + bar.slice(regionEnd)

console.log('\n一、可压缩的文字区块')

check('⭐ 区块存在，且是 min-w-0 + flex-1 + overflow-hidden 三件套', () => {
  assert.ok(regionAt > 0, '找不到那个 flex-1 的文字区块 —— 三个类名齐全才算')
  assert.ok(regionEnd > regionAt, '切不出区块的范围')
  /*
    三个都不能少：
      flex-1        -> flex: 1 1 0%，basis 0 才不会触发换行（换成 flex-auto 就是 basis auto，白干）
      min-w-0       -> 抵掉 flex 项默认的 min-width: auto
      overflow-hidden -> 自动最小尺寸归零 + 让子元素的 ellipsis 有地方生效
  */
  assert.ok(!/flex-auto|flex-\[1_1_auto\]/.test(region.slice(0, 200)), 'flex-auto 是 basis auto，起不到作用')
})

check('⭐ 三段长度不定的文字全都在区块**里面**', () => {
  for (const [what, token] of [
    ['文件名', '{file.name}'],
    ['检测 / 回退提示', 'data-testid="detect-notice"'],
    ['没有运行时的提示', '{t.player.noRuntimeShort}'],
  ]) {
    assert.ok(region.includes(token), `${what} 跑到区块外面去了 —— 它会把工具栏顶成两行`)
    assert.ok(!outside.includes(token), `${what} 在区块外还有一处`)
  }
})

check('⭐ 工具栏的直接子节点里不许再出现 truncate', () => {
  // 出现 truncate 就说明有人以为自己在做截断，而实际拿到的是折行
  const stray = [...outside.matchAll(/\btruncate\b/g)]
  assert.equal(
    stray.length,
    0,
    `工具栏里有 ${stray.length} 处区块外的 truncate —— 在 flex-wrap 里那是折行，不是截断`,
  )
})

check('⭐ 区块里每个文字子节点都必须 nowrap', () => {
  /*
    只把文字收进 overflow-hidden 的区块**还不够**。
    区块是 flex 容器，里面的 span 默认 min-width:auto（= min-content，对可换行的文本
    就是最长的那个词），于是文本会在**区块内部**折成两行，把工具栏一样顶高 ——
    这个洞是变异校验里的对照组暴露出来的：当时删掉文件名的 truncate，测试还是绿的。

    truncate 自带 whitespace-nowrap，所以两者认一个就行。
  */
  const spans = [...region.matchAll(/<span([^>]*)>/g)].map((m) => m[1])
  assert.ok(spans.length >= 2, `区块里只找到 ${spans.length} 个 span，切片可能出错了`)
  for (const attrs of spans) {
    assert.match(
      attrs,
      /\btruncate\b|\bwhitespace-nowrap\b/,
      `区块里有个 span 没锁单行，会在内部折行：<span${attrs}>`,
    )
  }
})

check('被截断的文字要留 title，鼠标悬停能看到全文', () => {
  assert.match(region, /title=\{file\.name\}/, '文件名没留 title')
  assert.match(region, /data-testid="detect-notice"[^>]*title=\{notice\}/, '检测提示没留 title')
})

console.log('\n二、工具栏本体')

check('⭐ 保留 flex-wrap，不能图省事改成 nowrap', () => {
  /*
    只取工具栏自己那一段 className 表达式。
    ⚠️ 别拿 'overlayBar' 当结束锚点 —— 去注释之后第一处 overlayBar 是
    className 之前的 data-overlay={...}，切出来的一段里什么类名都没有（踩过）。
  */
  const cls = bar.slice(bar.indexOf('className={cx('), bar.indexOf('onPointerEnter'))
  assert.ok(cls.length > 100, '切不出工具栏的 className')
  assert.match(cls, /\bflex-wrap\b/, '工具栏的 flex-wrap 不见了')
  assert.ok(!/\bflex-nowrap\b/.test(cls), 'nowrap 会让联机 + 直播 + 观众的徽章同时出现时横向溢出')
})

check('⭐ 右侧控件组必须 shrink-0（里面有 select，表单控件会被压扁）', () => {
  const at = bar.indexOf('ml-auto')
  assert.ok(at > 0, '找不到右侧控件组')
  const cls = bar.slice(at, bar.indexOf('>', at))
  assert.match(cls, /\bshrink-0\b/, '右侧控件组没锁 shrink —— 沉浸 / 全屏会被挤扁')
})

check('叠加形态仍然是绝对定位压在画面上（这正是折行代价高的原因）', () => {
  // 这条不是在守布局，是在守**前提**：哪天工具栏不再叠在画面上了，
  // 上面那些规矩的理由就变了，应该有人来重新想一遍，而不是继续照抄
  assert.match(bar, /absolute inset-x-0 bottom-0/, '叠加工具栏不再绝对定位了？这一份的前提需要重审')
})

console.log(`\n✅ 工具栏单行约束：${n} 项通过`)
