#!/usr/bin/env node

/**
 * 对 `/web/celeste`（Webleste，MercuryWorkshop/celeste-wasm 的发布产物）做定点修补。
 *
 * 上游只发布构建产物（GitHub Release 的 webleste-loader.tar.zst），没有可改的源码，
 * 所以和 terraria 同一套纪律：解压后跑本脚本，**每处替换必须恰好命中一次**（或者
 * 已打过的幂等跳过），命中数对不上直接失败 —— 上游换版本时补丁点会漂移，
 * 那时要重新核对本文件里的定位串，别为了让脚本变绿把断言删掉。
 *
 * 修的是什么（对照 terraria §2.28.6 的三条纪律，celeste 上游同款问题）：
 *
 * 1. **子路径**。上游 demo 托管在根路径，vite 产物里全是相对引用；直接挂到
 *    `/web/celeste`（生产 URL 不带尾斜杠）时 `./assets/...` 会解析到 `/web/assets/...`
 *    （「diablo 当成文件」那个坑），必须补 `<base href>`。
 * 2. **第三方统计**。上游 index.html 引 `a.r58playz.dev/colonthree.js`。删掉后
 *    bundle 里的 `event()` 埋点自动变 no-op（`umami` 不存在时直接 return），安全。
 * 3. **`window.fetch` 被全局劫持**：native fetch 失败会回落到 epoxy 客户端，
 *    也就是把请求发往 wisp 中继（默认 `wss://anura.pro`，第三方中继）。整段替换为
 *    原生 fetch；Everest 自动下载里的 `epoxyFetch` 一并换成原生 fetch。
 * 4. **`window.WebSocket` 被换成 Proxy**：非同源 ws 一律转 EpxWs/EpxTcpWs（wisp 隧道，
 *    SteamKit2 的 TCP 也从这儿走）。替换为原生 WebSocket —— wisp / Steam 从此无路可走。
 * 5. **wisp 默认地址** `"wss://anura.pro"` 改成不可路由的 `127.0.0.1:9`：设置界面里
 *    WispServer 输入框和 epoxy 库代码还在（死代码），万一哪条漏网路径真的去连，
 *    也是立刻连本机的黑洞端口，不会碰到第三方。
 * 6. **Steam 登录对话框**。原本让玩家在本页输入 Steam 账号密码（SteamKit2 走 wisp TCP）。
 *    网络路径已断，登录永远失败；与其留一个永远失败的凭据输入框，不如换成明确说明。
 *    （steamState / SteamJS 导出还在，纯死代码，不再有 UI 入口。）
 *
 * 用法：
 *   npm run celeste:patch                      # 就地修补 public/web/celeste/
 *   npm run celeste:patch -- --src <解压目录>   # 先从上游解压产物整体拷入（覆盖），再修补
 */
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : ''
}
const src = arg('src')
const target = join(root, 'public/web/celeste')

if (src) {
  if (!existsSync(join(src, 'index.html'))) throw new Error(`${src} 里没有 index.html，请填上游 tar 包的解压目录`)
  cpSync(src, target, {
    recursive: true,
    // 运行时在 R2（见 server/src/celeste.js），这两份不该进 public/
    filter: (p) => !/\/_framework(\/|$)/.test(p) && !p.endsWith('/robots.txt') && !p.endsWith('/_headers'),
  })
  console.log('· 已从上游拷入（不含 _framework / robots.txt / _headers）')
}

const fail = (msg) => {
  console.error(`✖ Celeste 补丁失败：${msg}`)
  process.exit(1)
}

/* ---------------- index.html ---------------- */

const indexFile = join(target, 'index.html')
if (!existsSync(indexFile)) fail(`缺少 ${indexFile}`)
let index = readFileSync(indexFile, 'utf8')

// 1) <base href>：让 ./assets 相对引用在 /web/celeste（无尾斜杠）下也解析到正确位置
const BASE = '<base href="/web/celeste/">'
if (index.includes(BASE)) {
  console.log('· <base href> 已在位')
} else if (index.includes('<meta charset="UTF-8" />')) {
  index = index.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n\t\t${BASE}`)
  console.log('✔ 已插入 <base href="/web/celeste/">')
} else {
  fail('index.html 里找不到 <meta charset="UTF-8" />（上游改版了，重新核对）')
}

// 2) 第三方统计脚本
const ANALYTICS = '\t\t<script src="https://a.r58playz.dev/colonthree.js" data-website-id="0c64d81c-78c2-49c4-8bb9-fe01f46083a5" data-before-send="processEvent"></script>\n'
if (index.includes('colonthree')) {
  if (!index.includes(ANALYTICS)) fail('统计脚本行与预期不一致，重新核对 ANALYTICS 常量')
  index = index.replace(ANALYTICS, '')
  console.log('✔ 已移除 colonthree 统计脚本')
} else {
  console.log('· 统计脚本已移除')
}

// 3) canonical 指向上游 demo
const CANONICAL_OLD = '<link rel="canonical" href="https://celeste.r58playz.dev" />'
const CANONICAL_NEW = '<link rel="canonical" href="https://8bitgo.com/web/celeste" />'
if (index.includes(CANONICAL_OLD)) {
  index = index.replace(CANONICAL_OLD, CANONICAL_NEW)
  console.log('✔ canonical 已改指 8bitgo')
} else if (!index.includes(CANONICAL_NEW)) {
  fail('index.html 里既没有上游 canonical 也没有本站 canonical（上游改版了，重新核对）')
} else {
  console.log('· canonical 已在位')
}

writeFileSync(indexFile, index)

/* ---------------- vite bundle ---------------- */

const assetsDir = join(target, 'assets')
const bundles = existsSync(assetsDir)
  ? readdirSync(assetsDir).filter((n) => /^index-.+\.js$/.test(n))
  : []
if (bundles.length !== 1) fail(`assets/ 下应有且只有一个 index-<hash>.js，实际：${bundles.join(', ') || '(无)'}`)
const bundleFile = join(assetsDir, bundles[0])
let bundle = readFileSync(bundleFile, 'utf8')
let bundlePatched = false

/** 必须命中一次的定点替换；already 判断用于幂等重跑。 */
function patchOnce({ name, from, to, already, allowMultiple = false }) {
  const hits = bundle.split(from).length - 1
  if (already && bundle.includes(already)) {
    console.log(`· ${name} 已在位`)
    return
  }
  if (hits !== (allowMultiple ? Math.min(hits, 1) || 1 : 1)) {
    fail(`${name}：期望恰好 1 处命中，实际 ${hits} 处 —— 上游改版后定位串漂移，重新核对`)
  }
  bundle = bundle.replace(from, to)
  bundlePatched = true
  console.log(`✔ ${name}`)
}

// 4) WebSocket Proxy → 原生 WebSocket（EpxWs/EpxTcpWs 的 wisp 隧道从此不可达）
patchOnce({
  name: 'WebSocket 代理还原为原生',
  from: 'window.WebSocket=new Proxy(WebSocket,{construct(t,e,n){const r=new URL(e[0]);return e[0]===getWispUrl()||r.host===location.host?Reflect.construct(t,e,n):r.hostname.startsWith("__celestewasm_wisp_proxy_ws__")?new EpxTcpWs(r.pathname.substring(1),r.hostname.replace("__celestewasm_wisp_proxy_ws__","")):new EpxWs(...e)}})',
  to: 'window.WebSocket=WebSocket',
  already: 'window.WebSocket=WebSocket',
})

// 5) window.fetch 覆盖 → 原生 fetch。函数体太长且压缩形态不稳定，用括号配平截取整段替换
const FETCH_HEAD = 'window.fetch=async(...t)=>{'
if (bundle.includes('window.fetch=nativefetch')) {
  console.log('· window.fetch 已还原为原生')
} else if (bundle.includes(FETCH_HEAD)) {
  const start = bundle.indexOf(FETCH_HEAD)
  const bodyStart = start + FETCH_HEAD.length - 1 // 指向函数体的 {
  let depth = 0
  let end = -1
  for (let i = bodyStart; i < bundle.length; i++) {
    const ch = bundle[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end < 0) fail('window.fetch 覆盖的函数体括号不配平，无法定位结尾')
  bundle = bundle.slice(0, start) + 'window.fetch=nativefetch' + bundle.slice(end + 1)
  bundlePatched = true
  console.log('✔ window.fetch 已还原为原生（含 /depot/ 下载拦截一并移除）')
} else {
  fail('找不到 window.fetch 覆盖（上游改版了，重新核对）')
}

// 6) wisp 默认地址 → 本机黑洞端口（设置界面的 WispServer 输入框与 epoxy 库仍在，兜底）
patchOnce({
  name: 'wisp 默认地址改为 127.0.0.1:9',
  from: '"wss://anura.pro"',
  to: '"wss://127.0.0.1:9"',
})

// 7) Steam 登录对话框内容 → 说明文字（凭据输入框不能再出现）
patchOnce({
  name: 'Steam 登录对话框替换为说明',
  from: 'h(SteamCloud,{open:use(this.steamOpen)})',
  to: 'h("p",{style:"padding:1rem;line-height:1.7;color:#9ca3af"},"Steam 登录与云存档在本站不可用：该功能依赖第三方网络中继，出于隐私与安全考虑已移除。游戏本体请用本机 Celeste 目录导入。")',
})

// 8) Everest 自动下载走 epoxyFetch → 原生 fetch（epoxy 从此完全退役；GitHub Pages 无 CORS
//    时会失败并提示，用户仍可手动拖入 everest.zip，与上游行为一致）
patchOnce({
  name: 'Everest 自动下载改走原生 fetch',
  from: 'await epoxyFetch(a.mainDownload)',
  to: 'await nativefetch(a.mainDownload)',
})

/* ---------------- 收尾断言 ---------------- */

for (const forbidden of ['anura.pro', 'a.r58playz.dev', 'colonthree', '__celestewasm_wisp_proxy_ws__']) {
  if (bundle.includes(forbidden)) fail(`补丁后 bundle 里仍有「${forbidden}」`)
}
if (bundle.includes('epoxyFetch(') && !bundle.includes('async function epoxyFetch')) {
  // 定义还在（死代码），但除了定义本身不应再有调用点
  const calls = bundle.split('epoxyFetch(').length - 1
  const defs = bundle.split('async function epoxyFetch').length - 1 + bundle.split('self.epoxyFetch=').length - 1
  if (calls > defs) fail(`epoxyFetch 仍有 ${calls - defs} 处调用点存活`)
}

if (bundlePatched) writeFileSync(bundleFile, bundle)

// 一定要真解析一遍：字符串替换极易把压缩代码改出语法错误，而浏览器只会报一句
// 「Unexpected token」且所有字符串检查照样全绿（terraria §2.28.6 的教训）。
execFileSync(join(root, 'node_modules/.bin/esbuild'), [bundleFile, '--outfile=/dev/null', '--log-level=warning'], { stdio: 'pipe' })
console.log(`✔ ${bundles[0]} 通过 esbuild 解析（补丁未破坏语法）`)
console.log('✔ Celeste 补丁完成')
