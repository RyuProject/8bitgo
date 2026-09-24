#!/usr/bin/env node

/**
 * 把上游 Terrarium（Terraria 的 .NET/WASM 移植）的前端产物改造成本站能托管的样子。
 *
 * 为什么要「打补丁」而不是改源码：上游只发布了构建产物（`assets/index.js` 217KB，
 * 已经打包成单文件），没有公开源码仓库。所以这里对**产物**做定点替换，
 * 每一处都带上「找不到就报错」的断言 —— 上游换版本时补丁点会漂移，
 * 那时必须重新核对，而不是让构建悄悄发一个没打补丁的包出去。
 *
 * 打的补丁分三类（每一条都对应一个真问题，见 AGENTS.md §2.28.6）：
 *
 * 一、**必须改，否则会影响整个站点**
 *   - `navigator.serviceWorker.register("/sw.js",{scope:"/"})` 出现两次，作用域是**站点根**。
 *     放过去的话，这个 135MB 的页面会给 8bitgo.com 装一个全局 service worker。
 *   - `window.fetch` / `window.WebSocket` 被全局换成作者的 libcurl + wisp 代理
 *     （`wss://staging2.velzie.rip/`），并去 jsdelivr 取 `libcurl.wasm`：
 *     站内所有请求都会绕一圈别人的服务器，且违反「引擎自托管」。
 *
 * 二、**路径必须带子目录**：`/_framework/dotnet.js`、`/app.ico`、`/backdrop.png`
 *     都是根绝对路径。本站挂在 `/web/terraria` 下，不改就是 404。
 *
 * 三、**移除 Steam 登录/下载**（玩家的 Steam 账号密码会过第三方 staging 服务器）。
 *     只留「选择本机 Content 目录」与「上传归档」两条自带数据的路。
 *
 * 用法：
 *   npm run terraria:patch                      # 从 scripts/terraria-web/upstream 生成页面
 *   npm run terraria:patch -- --src <解压目录>    # 首次导入时顺带拷原样文件（图标/字体/CSS）
 *
 * ⚠️ 不部署 `sw.js` 与 `MILESTONE`：前者是上游那个根作用域的 service worker，
 * 后者只有 sw.js 会读。两者都留在上游包里，本站一律不发。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const upstreamDir = join(root, 'scripts/terraria-web/upstream')
const targetDir = join(root, 'public/web/terraria')
const srcDir = (() => {
  const at = process.argv.indexOf('--src')
  return at >= 0 ? process.argv[at + 1] : ''
})()

/**
 * 原样拷贝的文件（会被 webpack 之外的路径直接引用，不做任何修改）。
 * `assets/index.css` 里的 `url(../AndyBold.ttf)` 是**相对 CSS 自身**解析的，
 * 所以路径天然落在 /web/terraria/ 下，不需要改。
 */
const VERBATIM = ['assets/index.css', 'app.ico', 'backdrop.png', 'logo.png', 'AndyBold.ttf']

/**
 * 每条补丁：find（上游原文）→ replace（本站版本）。
 * `find` 必须**只出现一次**，否则视为上游产物变了，直接失败。
 */
const JS_PATCHES = [
  {
    what: 'service worker #1（根作用域注册 → 只留一句诊断）',
    find: 'try{crossOriginIsolated||console.log("not crossoriginisolated: using service worker");const s=await navigator.serviceWorker.register("/sw.js",{scope:"/"});s.installing?console.log("Service worker installing"):s.waiting?console.log("Service worker installed"):s.active&&(crossOriginIsolated||(console.log("not crossoriginisolated, reloading"),setTimeout(()=>location.reload(),100)))}catch(s){console.error(`Registration failed with ${s}`)}',
    replace: 'crossOriginIsolated||console.warn("[terraria] 页面不是跨源隔离的：SharedArrayBuffer 用不了，游戏起不来 —— 检查 /web/terraria 的 COOP/COEP 响应头");',
  },
  {
    what: 'dotnet 运行时入口改到 /web/terraria 下',
    // ⚠️ 必须是绝对路径：`import()` 在模块里按**模块自身 URL** 解析，
    // 写成相对会把 _framework 算到 /web/terraria/assets/ 下面。
    find: 'import("/_framework/dotnet.js")',
    replace: 'import("/web/terraria/_framework/dotnet.js")',
  },
  {
    what: '移除 libcurl / wisp 代理接线（全局 fetch 与 WebSocket 都被它换掉）',
    find: 'console.log("loading libcurl"),await libcurl.load_wasm("https://cdn.jsdelivr.net/npm/libcurl.js@0.6.20/libcurl.wasm"),libcurl.set_websocket(wisp_url),window.WebSocket=new Proxy(WebSocket,{construct(m,w,b){return w[0]===wisp_url?Reflect.construct(m,w,b):new libcurl.WebSocket(...w)}}),window.fetch=libcurl.fetch;',
    replace: '/* 8bitgo: 移除 libcurl/wisp 接线。上游把 window.fetch 与 window.WebSocket 全局换成走作者自己的 wisp 代理，并从 jsdelivr 取 libcurl.wasm；本站已移除需要它的 Steam 下载入口。 */',
    marker: '移除 libcurl/wisp 接线',
  },
  {
    what: '抹掉第三方 wisp 代理地址',
    find: ',wisp_url="wss://staging2.velzie.rip/"',
    replace: ',wisp_url=""/* 8bitgo: 上游指向作者自己的 wisp 代理，本站不使用 */',
    marker: '本站不使用',
  },
  {
    what: '移除「Download Assets from Steam」入口',
    find: ',h(Button,{"on:click":()=>this["on:next"]("download"),type:"primary",icon:"left",disabled:!1},h(Icon,{icon:data$e}),"Download Assets from Steam")',
    replace: '/* 8bitgo: 移除 Steam 下载入口 */',
    marker: '移除 Steam 下载入口',
  },
  {
    what: '移除 Steam 登录路由（连同那条分支，即使有人手动跳也进不去）',
    // ⚠️ 收尾的那个 `)` 必须一起吃掉。只删到 `{"on:done":...}` 的话，
    // 会在原地留下一个孤零零的 `)`，整个模块**语法错误**（浏览器只报
    // `Unexpected token ')'`），而字符串检查全绿 —— 所以 patch 之后一定要真解析一遍。
    find: 'if(s==="download")return h(Download,{"on:done":this["on:next"]})',
    replace: '/* 8bitgo: 移除 Steam 登录路由 */',
    marker: '移除 Steam 登录路由',
  },
  {
    what: '.NET 侧的 Steam 登录入口改成直接失败（不给它连上代理的机会）',
    find: 'async function initSteam(s,g,m){return await exports.Program.InitSteam(s,g,m)}',
    replace: 'async function initSteam(){console.warn("[terraria] 本站不提供 Steam 登录");return 1/* 8bitgo: 上游约定非 0 即失败 */}',
    marker: '本站不提供 Steam 登录',
  },
  {
    what: '.NET 侧的 Steam 下载入口改成直接抛错',
    find: 'async function downloadApp(){return await exports.Program.DownloadApp()}',
    replace: 'async function downloadApp(){throw new Error("本站不提供 Steam 下载，请用「选择本机 Content 目录」或上传归档")}',
    marker: '本站不提供 Steam 下载',
  },
  {
    what: '文件管理器里的图标改到子目录',
    find: 'h("img",{src:"/app.ico"})',
    replace: 'h("img",{src:"/web/terraria/app.ico"})',
  },
  {
    what: '启动页背景图改到子目录',
    find: 'src:"/backdrop.png"',
    replace: 'src:"/web/terraria/backdrop.png"',
  },
  {
    what: '主界面背景（CSS 里的 url()）改到子目录',
    // ⚠️ 这一处藏在组件的 CSS 模板串里，只扫双引号字符串会漏掉 ——
    // 漏了的症状是「背景图 404，界面照常能用」，肉眼很容易当成设计如此。
    find: 'background: url(/backdrop.png)',
    replace: 'background: url(/web/terraria/backdrop.png)',
  },
  {
    what: 'service worker #2（启动时那次根作用域注册）',
    find: 'try{root.replaceWith(h(App,null)),navigator.serviceWorker.register("/sw.js",{scope:"/"})}catch(s){',
    replace: 'try{root.replaceWith(h(App,null))}catch(s){',
  },

  /* ---------- 界面文案中文化 ----------
     上游是英文界面，而这一页是挂在 8bitgo 的中文站点里（同 /web/diablo）。
     原则：**只改文案，不动结构**；链接组件原样留着（对上游的署名不能动）。
     `NAME` 是上游定义的常量（= "Terraria"），出现在句子里时保持原样引用。 */
  {
    what: '引导页：这是什么（保留 Terraria / Celeste / writeup 三个外链）',
    find: `"This is a port of ",h(Link,{href:"https://terraria.org"},"Terraria")," to the browser with WebAssembly. Frontend and build system is heavily based on r58's ",h(Link,{href:"https://github.com/MercuryWorkshop/celeste-wasm"},"Celeste browser port"),h("br",null),"Want to know how this was made? Check the ",h(Link,{href:"https://velzie.rip/blog/celeste-wasm/"},"writeup"),"!"`,
    replace: `"这是 ",h(Link,{href:"https://terraria.org"},"Terraria")," 的浏览器移植版：用 .NET WebAssembly + FNA 运行，前端与构建流程大量借鉴 r58 的 ",h(Link,{href:"https://github.com/MercuryWorkshop/celeste-wasm"},"Celeste 浏览器移植"),"。",h("br",null),"实现经过见 ",h(Link,{href:"https://velzie.rip/blog/celeste-wasm/"},"这篇 writeup"),"。"`,
    marker: '的浏览器移植版',
  },
  {
    what: '引导页：必须拥有本体（这句话是整页最重要的告知，必须让中文用户读得懂）',
    find: `"You will need to own Terraria to play this. Make sure you either own it on Steam, or have it downloaded and installed on your computer."`,
    replace: `"你必须拥有 Terraria 才能玩：要么在 Steam 上买过，要么本机已经装好。本页只提供引擎与运行时，不含任何游戏素材。"`,
    marker: '只提供引擎与运行时',
  },
  {
    what: '引导页：署名一行',
    find: `"A ",h(Link,{href:"https://mercurywork.shop"},"Mercury Workshop")," Project. Ported by ",h(Link,{href:"https://velzie.rip"},"velzie")`,
    replace: `"项目由 ",h(Link,{href:"https://mercurywork.shop"},"Mercury Workshop")," 发起，",h(Link,{href:"https://velzie.rip"},"velzie")," 移植"`,
    marker: '发起，',
  },
  {
    what: '引导页：不支持文件系统访问接口时的提示',
    find: `"Your browser does not support the"," ",h(Link,{href:"https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker"},"File System Access API"),"."," ","You will be unable to copy your Terraria assets to play or use the upload features in the filesystem viewer. Please switch to a chromium based browser."`,
    replace: `"你的浏览器不支持"," ",h(Link,{href:"https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker"},"File System Access API"),"（文件系统访问接口）。"," ","因此无法从本机目录拷贝素材，文件管理器里的上传功能也用不了。请换用 Chromium 内核的浏览器（Chrome / Edge）。"`,
    marker: 'Chromium 内核的浏览器',
  },
  {
    what: '引导页：导入方式标题',
    find: `"You will need to install Terraria to your browser with one of the following methods:"`,
    replace: `"请选一种方式把 Terraria 装进这台浏览器："`,
    marker: '装进这台浏览器',
  },
  {
    what: '引导页：两个按钮文案',
    find: `PICKERS_UNAVAILABLE?"Copying local assets is unsupported":"Copy local assets"`,
    replace: `PICKERS_UNAVAILABLE?"浏览器不支持拷贝本地目录":"拷贝本地素材"`,
    marker: '拷贝本地素材',
  },
  {
    what: '引导页：上传归档按钮',
    find: `"Upload Archive"`,
    replace: `"上传归档"`,
    marker: '"上传归档"',
  },
  {
    what: '拷贝本机目录页：说明与路径提示',
    find: `"Select your Terraria install's Content directory. It will be copied to browser storage and can be removed in the file manager."`,
    replace: `"请选择本机 Terraria 安装目录下的 Content 文件夹。它会被复制进浏览器存储（可在文件管理器里删除），不会上传到服务器。"`,
    marker: '不会上传到服务器',
  },
  {
    what: '拷贝本机目录页：常见安装位置标题',
    find: `"The Content directory for Steam installs of Terraria is usually located in one of these locations:"`,
    replace: `"Steam 版 Terraria 的 Content 目录通常在这几个位置："`,
    marker: '通常在这几个位置',
  },
  {
    what: '拷贝本机目录页：按钮文案',
    find: `"Select Terraria Content directory"`,
    replace: `"选择 Terraria 的 Content 目录"`,
    marker: '的 Content 目录',
  },
  {
    what: '上传归档页：说明',
    find: `"Select a ",NAME," exported .tar archive of the root directory. You can create this on a browser with ",NAME," already set-up by clicking the archive button (",h(Icon,{icon:data$8}),") in the filesystem explorer while in the root directory."`,
    replace: `"选择 ",NAME," 导出的根目录 .tar 归档（在另一台已经装好的浏览器里，进文件管理器根目录点归档按钮（",h(Icon,{icon:data$8}),"）即可导出）。"`,
    marker: '即可导出',
  },
  {
    what: '上传归档页：按钮文案',
    find: `"Select ",NAME," archive"`,
    replace: `"选择 ",NAME," 归档"`,
    marker: '归档',
  },
]

/**
 * 补丁打完必须成立的断言 —— 与 check-terraria-web.mjs 的检查项同源。
 * 后两条是**正则**：这个 bundle 里所有对外 URL 都必须落在 /web/terraria 下，
 * 但 `/tmp`、`/dev`、`/proc` 那些是 Emscripten 虚拟文件系统的路径，不是 URL，
 * 所以只能按「src/href/url() 里出现根绝对路径」这种形状来判，不能一刀切。
 */
const FORBIDDEN_AFTER_PATCH = [
  ['navigator.serviceWorker.register', 'service worker 注册'],
  ['staging2.velzie.rip', '第三方 wisp 代理地址'],
  ['cdn.jsdelivr.net', '第三方 CDN'],
  ['Download Assets from Steam', 'Steam 下载入口'],
  ['import("/_framework/', '根绝对路径的 _framework 入口'],
  [/url\(\/(?!web\/terraria\/)/i, 'CSS 里的根绝对路径'],
  [/src:"\/(?!web\/terraria\/)/, 'src 指向站点根的绝对路径'],
]

const sourceFile = join(upstreamDir, 'assets/index.js')
if (!existsSync(sourceFile)) {
  console.error(`✖ 找不到上游产物 ${sourceFile}`)
  process.exit(1)
}
let source = readFileSync(sourceFile, 'utf8')

for (const patch of JS_PATCHES) {
  const count = source.split(patch.find).length - 1
  if (count === 0 && patch.marker && source.includes(patch.marker)) {
    console.log(`· 已打过：${patch.what}`)
    continue
  }
  if (count !== 1) {
    console.error(`✖ 补丁点异常（出现 ${count} 次，期望 1 次）：${patch.what}`)
    console.error('  上游产物很可能换了版本。请重新核对 AGENTS.md §2.28.6 里列的每一处，')
    console.error('  不要为了让构建变绿直接把这一条删掉。')
    process.exit(1)
  }
  source = source.replace(patch.find, patch.replace)
  console.log(`✔ ${patch.what}`)
}

for (const [pattern, label] of FORBIDDEN_AFTER_PATCH) {
  const hit = pattern instanceof RegExp ? pattern.test(source) : source.includes(pattern)
  if (hit) {
    console.error(`✖ 补丁后仍残留${label}（${pattern}）`)
    process.exit(1)
  }
}

if (!source.includes('import("/web/terraria/_framework/dotnet.js")')) {
  console.error('✖ 运行时入口不是 /web/terraria/_framework/dotnet.js')
  process.exit(1)
}

mkdirSync(join(targetDir, 'assets'), { recursive: true })
writeFileSync(join(targetDir, 'assets/index.js'), source)
console.log(`✔ 写入 public/web/terraria/assets/index.js（${source.length} 字节）`)

if (srcDir) {
  if (!existsSync(srcDir)) {
    console.error(`✖ --src 目录不存在：${srcDir}`)
    process.exit(1)
  }
  for (const name of VERBATIM) {
    const from = join(srcDir, name)
    if (!existsSync(from)) {
      console.error(`✖ ${srcDir} 里缺少 ${name}`)
      process.exit(1)
    }
    copyFileSync(from, join(targetDir, name))
    console.log(`✔ 原样拷贝 ${name}`)
  }
  console.log('· 注意：_framework/ 与 index.html 不由本脚本处理（前者走 R2，后者是本站自己写的）')
} else {
  const missing = VERBATIM.filter((name) => !existsSync(join(targetDir, name)))
  if (missing.length) {
    console.error(`✖ public/web/terraria 缺少原样文件：${missing.join('、')}`)
    console.error('  首次导入请带 --src <解压后的构建目录>')
    process.exit(1)
  }
}

execFileSync(process.execPath, [join(root, 'scripts/check-terraria-web.mjs')], { stdio: 'inherit' })
