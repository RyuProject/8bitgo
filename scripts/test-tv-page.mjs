/**
 * TV 页（电视 / 车机那一屏）的结构回归。跑：npm run test:tv-page
 *
 * 这里守的三件事都有同一个特点：**坏了不报错，页面照常渲染**，
 * 而且只有拿着遥控器坐在电视前面才发现得了。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8')
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
/** 去掉注释再扫：注释里也会提到这些标识符 */
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

console.log('\n── 焦点不许隐形 ──')

check('⭐ 每个挂了 data-focus-id 的组件都用了 useFocusable', () => {
  /*
    FocusScope 是用 querySelectorAll('[data-focus-id]') 收集候选的 ——
    也就是说**挂了 id 就会被方向键走到**。而画不画焦点态是另一回事（useFocusable）。
    只挂 id、不画焦点态的元素，在电视上的表现是「焦点凭空消失了」：
    按一下方向键屏幕上什么都不亮，再按一下又从别处冒出来。
    电视上没有鼠标指针兜底，焦点是用户唯一的位置感来源。

    真踩过一次：顶部「正在播」那颗挂了 id 忘了配 useFocusable。
  */
  /*
    ⚠️ 只扫**消费方**，不扫 FocusScope 自己 —— 它里面的 data-focus-id 是
    querySelectorAll 的选择器字符串，不是 JSX 属性。它是引擎，按定义豁免。
    ⚠️ 也只认 JSX 属性的写法 `data-focus-id={`（带花括号）：选择器字符串里是
    `data-focus-id="` 或 `[data-focus-id]`，按 `data-focus-id=` 去匹配会把两者混为一谈
    （第一版就是这么误报的）。
  */
  for (const rel of ['src/pages/TvPage.tsx']) {
    const src = code(rel)
    // 按函数声明切块，逐个组件看
    const chunks = src.split(/\n(?=(?:export )?function )/)
    for (const chunk of chunks) {
      if (!chunk.includes('data-focus-id={')) continue
      const name = /^(?:export )?function (\w+)/.exec(chunk)?.[1] ?? '(匿名)'
      assert.ok(
        chunk.includes('useFocusable('),
        `${rel} 的 ${name} 挂了 data-focus-id 却没用 useFocusable —— 焦点走到它身上会不可见`,
      )
    }
  }
})

check('⚠️ 右边那块预览不可聚焦（它是放大镜，不是能走进去的地方）', () => {
  const src = code('src/pages/TvPage.tsx')
  const i = src.indexOf('function Preview(')
  assert.ok(i > 0, '找不到 Preview')
  const body = src.slice(i, i + 2000)
  assert.ok(!body.includes('data-focus-id={'), 'Preview 变成焦点候选了：方向键会走进一块只读区域出不来')
})

console.log('\n── 一屏，不滚 ──')

check('⭐ 整页 h-dvh + overflow-hidden，真正会滚的只有列表', () => {
  /*
    「往下滚还有内容」在电视和车机上是走不通的：遥控器没有滚轮，
    车机屏幕在行驶中也不该要求人翻页。所以这一页必须是**一屏**。
  */
  const src = code('src/pages/TvPage.tsx')
  /*
    ⚠️ 必须要求这两个类出现在**同一个 className 上**，不能分别在全文里搜。
    第一版就是分别搜的 —— 而 Preview 里那个封面框本来就有 overflow-hidden，
    于是把根容器的 overflow-hidden 删掉，这条断言照样绿。全文搜关键字的断言
    十有八九是恒真的，这是第二次栽在同一个写法上了。
  */
  assert.match(
    src,
    /className="[^"]*\bh-dvh\b[^"]*\boverflow-hidden\b[^"]*"/,
    '根容器上没有同时钉住 h-dvh 和 overflow-hidden —— 整页还能滚',
  )
  assert.match(src, /<ul className="[^"]*overflow-y-auto[^"]*"/, '列表自己不滚的话，超出一屏的游戏就永远选不到')
})

console.log('\n── 子域上不套站点外壳 ──')

check('⭐ TV 子域走空壳：没有侧边栏 / 顶栏 / 页脚', () => {
  /*
    侧边栏和顶栏在遥控器上点不到，却会被焦点引擎算成候选 ——
    按几下方向键焦点就跑进一个根本用不了的菜单里出不来。
  */
  const src = code('src/components/layout/Layout.tsx')
  const i = src.indexOf('function TvShell(')
  assert.ok(i > 0, '没有给 TV 子域单独的外壳')
  const body = src.slice(i, src.indexOf('function Shell('))
  for (const bad of ['<Sidebar', '<Topbar', '<Footer']) {
    assert.ok(!body.includes(bad), `TV 空壳里还留着 ${bad}`)
  }
  assert.match(body, /<Outlet \/>/, 'TV 空壳没渲染页面本身')
  /*
    ⚠️ 守的是「切换条件里有 onTvHost()」，不是那一行的原样拼写。
    钉拼写的断言一重构就红（这一条自己就栽过：后来条件加了 `|| isTvRoute`），
    久了就会被人随手改绿 —— 那时它已经不保护任何东西了。
  */
  // ⚠️ 条件里有括号（onTvHost()），所以是非贪婪匹配到 `) return <TvShell />` 这个锚，不能用 [^)]*
  const branch = /if \((.*?)\) return <TvShell \/>/.exec(src)
  assert.ok(branch, 'Shell 里找不到切到空壳的分支')
  assert.match(branch[1], /onTvHost\(\)/, `空壳的切换条件是「${branch[1]}」，没看 host`)
})

check('⚠️ 别把空壳改成复用 immersive（那是页面内的临时开关，路由一变就被重置）', () => {
  const src = code('src/components/layout/Layout.tsx')
  const i = src.indexOf('function TvShell(')
  const body = src.slice(i, src.indexOf('function Shell('))
  assert.ok(!body.includes('immersive'), 'TvShell 依赖了 immersive —— RouteEffects 每次路由变化都会把它重置成 false')
})

console.log('\n── TV 那一屏必须是深色 ──')

check('⭐ TV 空壳挂着 tv-surface，且那套令牌真的是深色', () => {
  /*
    这不是审美偏好：客厅里一屏白光在三米外是刺眼的；车机夜间一块全白的屏幕
    会毁掉驾驶员的暗适应，那是安全问题。站点主题本身是亮白底（Duolingo 那套），
    所以 TV 这一屏必须自己把令牌覆盖成深色。

    ⚠️ 这里**算亮度**，不是查类名拼写 —— 把 --color-bg 改成 #fafafa 也能让
    「有没有写 tv-surface」这种断言通过，而屏幕照样是白的。
  */
  const layout = code('src/components/layout/Layout.tsx')
  const i = layout.indexOf('function TvShell(')
  const body = layout.slice(i, layout.indexOf('function Shell('))
  assert.match(body, /className="[^"]*\btv-surface\b/, 'TV 空壳上没挂 tv-surface')

  const css = read('src/index.css')
  const block = /\.tv-surface\s*\{([\s\S]*?)\}/.exec(css)
  assert.ok(block, 'index.css 里没有 .tv-surface 这套令牌')
  const bg = /--color-bg:\s*#([0-9a-f]{6})/i.exec(block[1])
  assert.ok(bg, '.tv-surface 里没有覆盖 --color-bg')
  const [r, g, b] = [0, 2, 4].map((k) => parseInt(bg[1].slice(k, k + 2), 16))
  // 相对亮度（sRGB 近似）。0.25 已经很宽松了：真正的深色底都在 0.1 以下
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  assert.ok(lum < 0.25, `.tv-surface 的底色 #${bg[1]} 亮度 ${lum.toFixed(2)}，不算深色`)

  const fg = /--color-fg:\s*#([0-9a-f]{6})/i.exec(block[1])
  assert.ok(fg, '.tv-surface 里没有覆盖 --color-fg —— 深底配深字等于看不见')
})

console.log('')
if (fails.length) {
  for (const f of fails) console.error('✗ ' + f.name + '\n' + (f.e?.stack ?? f.e))
  console.error(`\n❌ ${fails.length} 条失败 / 共 ${pass + fails.length} 条`)
  process.exit(1)
}
console.log(`✅ TV 页结构：${pass} 条全过`)
