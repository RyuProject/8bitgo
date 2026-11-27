# 8BitGo — 给接手的 AI 助手 / 开发者

> Codex 会自动读取仓库根目录的 `AGENTS.md`，所以工程约定和「踩过的坑」都写在这儿。
> 最后更新：2026-10-12。**「当前进度」一节有时效性，其余部分是长期有效的约定。**

---

## 1. 项目速览

复古游戏模拟器站点，线上 <https://8bitgo.com>。

| | |
|---|---|
| 前端 | Vite + React 19 + TypeScript，带 SSR（`vite.config.server.ts` → `dist/server`） |
| 后端 | `server/`，Express + MySQL，和前端**同源**（一个进程同时提供 `/api` 和静态资源） |
| 存储 | Cloudflare R2 + Worker（`worker/`），普通公开读取走 `assets.8bitgo.com`，站内明文 ROM 优选 `rom.8bitgo.com`，开放平台授权下载走 `download.8bitgo.com` |
| 部署 | 生产机 **38.76.186.225**，服务器上 `git pull && npm install && npm run build && systemctl restart 8bitgo`，前面挂 Cloudflare（部署形态见 §2.30） |
| 模拟器 | EmulatorJS（主机/掌机/街机）、Ruffle（Flash）、js-dos、jsnes、webretro、FreeJ2ME、Play!（PS2） |
| 登录 | 邮箱验证码（**Resend** 发信）/ 密码 / Google，JWT 30 天，见 §2.13–2.14 |

代码注释一律用中文，且**解释「为什么」而不是「是什么」**——现有注释里记着大量踩坑经过，改代码前先读注释。

---

## 2. 十条铁律（每一条都对应一次真实事故）

### 2.1 构建期变量必须写进 `.env.production`，不能只放 `.env.local`

`.gitignore` 第 7 行 `*.local` 会把 `.env.local` 挡在仓库外，**服务器上 `git pull` 根本拿不到它**。
曾经 `VITE_EJS_PATH` / `VITE_ROM_BASE_URL` 只写在 `.env.local`，结果线上构建静默少了配置：
模拟器退回 CDN 旧版（街机全挂）、og:image 和封面地址拼不出来。本地怎么试都是好的。

> 凡是构建期要用、又不是机密的值 → `.env.production`（已进 git）。
> 真机密（`JWT_SECRET`、数据库口令）→ `server/.env`，永远不进 git。

### 2.2 `public/emulatorjs/`（含 `cores/`）是**故意提交进 git** 的

它和 ruffle / js-dos 不一样——那两个能 `npm run ruffle|jsdos` 从 node_modules 复制出来，
这个必须 clone EmulatorJS 仓库现构建，构建机上没人会做这一步。别再把它加回 `.gitignore`。

核心也没走 npm：`@emulatorjs/core-*` 每个都依赖引擎包，引擎包又可选依赖**全部 50 个核心**，
装 12 个等于拉几百 MB 全家桶。所以 24 个 `.data` + 12 个 `reports/*.json`（约 33MB）直接进 git。

### 2.3 EmulatorJS 必须用自建的 main 构建，**且不能看版本号验收**

CDN 上的 `stable` 是 4.2.3，缺 `dontExtractIfCore`。没有它，引擎看见 `neogeo.zip` 是压缩包
就先解压再喂给核心，FBNeo 拿到一堆散文件，报「四个 Neo Geo BIOS 成员缺失」。

⚠️ **main 分支的 `version.json` 也写着 `4.2.3`**，和 CDN 一模一样，看版本号分不出来。验收看特性：

```bash
grep -c dontExtractIfCore public/emulatorjs/emulator.min.js   # 自建 = 1，CDN 版 = 0
```

### 2.4 核心必须自托管，否则回落到一个**坏地址**

自建构建自称 `4.3.0-pre`，本地 `cores/` 取不到时会回落到 `cdn.emulatorjs.org/4.3.0-pre/`
（引擎自己在控制台喊 `THIS METHOD IS A FAILSAFE, AND NOT OFFICIALLY SUPPORTED`）。
实测那儿取回的核心初始化不出 `EJS_Runtime`，玩家看到 `Error loading EmulatorJS runtime`。

### 2.5 引擎比核心新一代，存档 ABI 对不上，**必须打补丁**

自建引擎（4.3.0-pre）取存档走 `Module.EmulatorJSGetState()`；`cores/` 里 npm 发布版的核心
（core build 2.0.2 / minimumEJSVersion 4.2.2）只导出老 ABI 的 `save_state_info`，
glue 里 `EmulatorJSGetState` 一次都不出现。对不上 → `getState()` 抛 TypeError →
**所有平台**按保存进度都是红字 `FAILED TO SAVE STATE`（读档却是好的，它走 `load_state`）。
升级核心解决不了：核对到 `@emulatorjs/core-mgba@4.2.3`，官方还没发布配套 4.3.0-pre 的核心。

`npm run ejspatch` 的第二组补丁把 4.2.3 的老 ABI 接回去，并保留新 ABI 优先。验收：

```bash
grep -c 'this.functions.saveStateInfo()' public/emulatorjs/emulator.min.js   # 打过 = 1
```

**这条补丁栽过第二次，坑在产物上。** 2026-09-02 补丁已经打进 `public/`、`npm run check`
也报「三项补丁均在位」，线上却还在发 9-1 构建出来的旧 `emulator.min.js`，玩家继续看到
`FAILED TO SAVE STATE`。跑在线上的是 `dist/client/emulatorjs/` 里那份拷贝，而这些文件名
**不带内容哈希**，肉眼分不出新旧。所以 `scripts/check-emulatorjs.mjs --dist` 挂在
`postbuild:client`，构建后按字节比对 `dist/client/emulatorjs/` 与 `public/`，对不上当场失败。
改完 `public/emulatorjs/` 一定要重新构建；已经部署过的还要清一次 CDN ——
`server/src/cache.js` 给 `/emulatorjs/` 发的是 `s-maxage=2592000`，边缘缓存 30 天。

### 2.6 引擎会把**坏核心缓存进 IndexedDB**，清浏览器缓存没用

库名 `EmulatorJS-Cache`。缓存命中时日志是 `[EJS Core] Data is already decompressed cache item`
——它压根不再下载，硬刷新、清 HTTP 缓存全都无效。
`src/emulator/adapters/emulatorjs.ts` 里的 `purgePoisonedEngineCache()` 按「代次」清一次，
每个访客只清一回。**引擎构建再出现不兼容更换时，把 `EJS_CACHE_GENERATION` 加一。**
清理时 `indexedDB.databases()`、事务清表和 `deleteDatabase()` 都有时限；任一路径提前结束都必须清掉尚未触发的计时器，不能让成功开局后留下空转回调。

### 2.7 升级引擎后必须重跑 `npm run ejspatch`

引擎写虚拟文件系统时用 `url.split('/').pop()` 当文件名。「玩本地 ROM」页拖入的文件是
`blob:` URL，pop 出来是一串 UUID，FBNeo 拿到名为 UUID 的 romset → `Romset is unknown`。
补丁让 blob 的游戏 URL 改用 `EJS_gameName`，http(s) 不受影响。

脚本里现在有**两组**补丁：blob 文件名（这一节）+ 存档 ABI 回退（§2.5）。两组各自幂等，
一条命令全打；位置对不上会当场退出并打印排查思路，见 `scripts/patch-emulatorjs.mjs` 头注释。

### 2.7.1 电池存档（.srm）曾被引擎 exit 整库清空；文件名不能用 8BG 的 originalName（2026-11-12）

游戏内存档（GBA / SNES / GB / NDS 的 SRAM）存在 IDBFS `/data/saves`（IndexedDB 库名同名），路径是
`/data/saves/<核心>/<内容文件名去扩展名>.srm`，和本站即时存档（`/api/saves`、`8bitgo` 库）是两套东西。

- **整库被清空**：引擎 exit（iframe beforeunload、适配器拆 iframe 都会触发）先 saveSaveFiles 排一次 autoPersist、
  紧接着 `FS.unmount("/data/saves")`；排队的同步随后看到的是卸载后的空目录，把库里**所有游戏**的 .srm 删光。
  实测刷新一次就空。修法两道，缺一不可：`npm run ejspatch` 第十三节删掉 unmount（`check-emulatorjs` 守着）；
  `src/emulator/ejsSaveFs.ts` 的 `guardIdbfsPersist` 在每局 callMain 前给核心 IDBFS 的 reconcile 加「内存 → 库只写更新、
  从不删除」，顺带挡住第二个标签页拿旧内存副本回滚别的游戏的存档。因此 `installFsInjector` 现在每局都装。
- **文件名撞车**：8BG 解包名是管理员本机文件名，线上 GBA 大量是「德文.gba」「日文.gba」—— 不同游戏同一语言共用
  一个 .srm。现在 8BG 内容交给引擎的名字是 `batterySaveGameName(存档 slug, originalName)`：slug（含 `~rom-<语言>`，
  去掉 `:melonds-compat` 这类核心后缀）+ 原扩展名。压缩包、本地文件、非 8BG 直链不改。旧名字以游戏 slug 开头时
  开局前复制一份过去；「德文.srm」这种通用名可能属于别的游戏，不迁。
- 电池存档 IDBFS 本身是**按浏览器、按域名**的；登录后由 `src/emulator/batterySync.ts` 同步进云存档：
  `emulatorjs` / 存档 slug / **slot 9**，信封 `format = battery:<核心目录>/<文件名>`。开局与 ROM 并行拉云端，callMain 前
  （存档库保护与旧名迁移之后）按「上次同步时的内容指纹」决定用哪份；两边都改过留本地、云端另存 `.cloud-<时间>.bak`。
  核心刷存档（30 秒 / 切后台 / 离页 / 拆播放器）后内容变了就推，推送都带开局读到的 revision，别的设备先写了就 409、不覆盖。
  开局没读到云端（断网、超时）的一局**不推送**。不同步：未登录、选了只存本地、本地文件、街机、联机加入方。

回归：`npm run test:ejs-battery-saves`。
- ⚠️ 引擎的改键 / 金手指 / 核心选项存在 localStorage `ejs-<gameId>-<系统>-<gameName>-settings`，**gameName 一变就读不到**。
  8BG 改名时 `migrateEngineSettingsKey` 把旧键复制到新键；以后再改 EJS_gameName 的规则也必须带上这一步。
- 开局前 `describeBootState` 把本浏览器里的电池存档（大小）、引擎设置项名、金手指条数写进诊断包（不记内容）。
  2026-11-13《火红》`table index is out of bounds`（CN / Chrome 132 / Windows）两次都在 ROM 交给 mGBA 后约 200ms 失败；第二次只换了引擎入口，仍复用同页 ROM，下一次访问重新下载 ROM 后正常。证据更像启动重试复用了有问题的 ROM 缓存 / Blob；诊断包没有保留该玩家 ROM 字节与完整开机状态，所以不能断言更底层的损坏位置。
  适配器现在仅对远端 8BG GBA 的启动期 table trap 清理 ROM 缓存与续传片、强制网络重取一次；刷新后仍失败则删除刚写入的缓存并停止，不循环重试。新增恢复只依赖 `isWasmRuntimeCrash` 识别真实 RuntimeError，不看核心普通日志。
  本地已实测排除 SRAM / Flash 存档（含错尺寸、乱码）、金手指、mGBA 全部核心选项、回退 / 快进 / 旋转、LCD shader；再出现先看诊断包里的 `describeBootState` 行和 `[core-crash]` / ROM 刷新日志。

### 2.7.1.1 `Aborted(undefined)` 是引擎自己的退出，不是核心崩溃（2026-11-22，诊断包 #2744《黄金太阳》）

EmulatorJS 在 iframe 的 `beforeunload` 上触发 exit：存档 → `restart()` → 停主循环 → 1 秒后 `Module.abort()`（不带参数，
原文 `Aborted(undefined)`）。顶层导航 / 刷新 / 下载链接都会让子框架收到 beforeunload；弱网下旧页面 1 秒后还活着就被报成
「运行中崩溃」，导航被取消时玩家还对着一块死画面。核心自己的 C abort 打的是 `Aborted()`（空串），两者能分开。
`src/emulator/ejsUnloadGuard.ts` 在 loader.js 之前挂捕获阶段的 beforeunload，`stopImmediatePropagation` 挡住引擎的 exit，
改为我们自己刷电池存档（不 preventDefault，不弹「确定离开」）；`EJS.on('exit')` 之后 10 秒内的 `Aborted(undefined)` 不再按崩溃报。
已排除：单机不会周期性 getState；mGBA 的 `save_state_info` 用静态指针、每次先 free 上一份，不漏，不需要 v3 胶水。
回归：`node --experimental-strip-types --import ./scripts/helpers/ts-register.mjs scripts/test-ejs-unload-guard.mjs`（并入 `test:ejs-failure-reasons`）。

### 2.7.2 🔴 共享引擎坏一处 = 全站游戏打不开：五道防线不准拆（2026-11-17 事故）

**经过**：79be63d 给 `patch-emulatorjs.mjs` 加了一段 XHR 兜底，补丁字符串里写了正则 `/^(?:text/html|…)\b/i`。
字面量里的 `/` 没转义，`/^(?:text/` 就结束了，`html` 被当成 flag —— **整份 emulator.min.js 无法解析**。
loader.js 的 `import()` 失败，NES / SFC / GBA / 街机 / PS1 …… 所有 EmulatorJS 平台同时报
`Failed to load emulator.min.js because it's likely that the minified files are missing`。
补丁检查只查「字符串在不在」，tsc / lint / 构建全绿；本该拦住它的 `test:ejs-download` 当时是红的，没人跑。
上游 loader 又只在 debug 时打印真实异常，诊断包 #1094–#1104 被误判成网络 / 边缘缓存问题，94c4876 加的「备用入口」
指向的还是同一份坏文件。修复：15e6830。

**现在的防线，每一道都对应这次的一个漏洞，不准为了让构建变绿而拆掉**：

1. **生成时**：`patch-emulatorjs.mjs` 写盘前按 ES 模块解析一遍（`scripts/lib/js-module-syntax.mjs`），解析不了不写。
   往补丁字符串里写正则时，字面量里的 `/` 一律转义，能用字符串比较就别用正则。
2. **构建前 / 后**：`check-emulatorjs.mjs` 解析 emulator.min.js，并在 Node 里**真 import 一次**
   （`scripts/lib/ejs-engine-import-smoke.mjs`，宽容 DOM 桩，只求值模块顶层），要求默认导出是带关键方法的 EmulatorJS 类；
   loader.js 必须是合法经典脚本，且保留打印 import 异常那一行。
   `check-runtime-syntax.mjs`（prebuild + postbuild `--dist`）对**所有**自托管运行时 JS 与 HTML 内联脚本做同样的解析门禁
   ——js-dos、PPSSPP、Dolphin、J2ME、PvZ、CS1.6 的补丁脚本都可能以同样方式打挂一整个平台。新增不经浏览器加载的构建期源码
   要放进它的 `SKIP_PREFIXES` 并写明原因，别用「整个目录跳过」偷懒。`test:ejs-download` / `test:ejs-failure-reasons` 也挂在 prebuild 上。
3. **源站**：`/emulatorjs/` 是「同一路径 + `?v=<内容哈希>`」，静态中间件忽略查询串。`runtime-version-guard.js`
   按内容（sha256 前 16 位，按 size+mtime 缓存）核对 `?v=`，对不上的响应 **no-store**（含 CDN-Cache-Control）。
   否则部署构建窗口、构建失败、回滚期间，旧版本号会被缓存成新内容一年 —— **回滚也救不回来**。
   `precompressed-static.js` 的 `.br` 旁注同样按 sha256 + brBytes 校验，不再只比字节数（等长修改会把旧引擎挂在新版本号下）。
4. **部署**：`redeploy.sh` 构建失败且 `dist/` 已被改写时回滚（Vite 直接写线上目录，只 die 会留下半新文件）；
   重启后默认跑 `smoke-start.mjs`（NES、CPS1、GBA 各一款跑到首帧）；GBA 样例守 mGBA 的 HLE BIOS 路径，失败重试一次，仍失败回滚。
   **生产机必须装 Chromium**，否则冒烟只能告警跳过（日志里是 `⚠️⚠️ 开局冒烟没有运行`）。确认是 CDN / ROM 故障而非代码问题时
   用 `SMOKE_TEST=0` 强行发布修复。回滚改为 `git reset --hard`（留在分支上），分支名用 `symbolic-ref`，游离 HEAD 不再污染下次部署。
   ⚠️ 退出码 2 也包括「脚本自身出错」，不只是没有 Chrome。2026-11-18 生产两次部署：两款游戏都到了首帧，随后删 Chrome profile
   报 `ENOTEMPTY`（渲染 / GPU 子进程还在写），退出码 2 → 记成「冒烟没有运行」、发飞书告警、/tmp 每次留下约 30MB。
   现在 Chrome 以 `detached` 自成进程组、关闭时整组发信号，删 profile 带重试且只告警不抛错，定时巡检再兜底清 30 分钟前的残留。
   收尾的任何错误都不能改冒烟结论（`test:smoke-start` 守着）。
5. **现场**：loader.js 把 `[EJS] import <文件> failed: <异常>` 写进控制台，适配器在最终失败日志里带上它，诊断包一眼能分出
   「语法错误」和「网络断了」。这一行的措辞不能撞上 `FATAL_PHRASES`，否则会抢断回退流程（`test:ejs-failure-reasons` 守着）。

5.1 **loader.js 不往页面全局写名字（2026-11-19，诊断包 #1331 / #1334）**：Chrome 111 / Windows 的玩家开《1942》0.6 秒报
   `SyntaxError: Identifier 'debug' has already been declared`，卡在「fbneo」两分钟被看门狗判超时，重试一样。本站代码不在引擎 iframe
   里声明 `debug`，推测是浏览器扩展往每个框架注入了全局 `var debug`；旧 loader 顶层的 `const debug` / `function loadScript` 等都在
   realm 的全局作用域，撞上一个整份不执行。现在整份 loader 包在立即执行函数里，`check-emulatorjs.mjs` 先在 VM 里声明一批同名全局再跑一遍守着。
   线上复现方法：在引擎 iframe 的**最终** srcdoc 文档里插 `<script>var debug=1</script>`（初始 about:blank 那份会随导航作废），
   旧版必报这句错、卡在「正在准备模拟器」。改 loader.js 后跑 `node scripts/gen-ejs-core-versions.mjs`，URL 按内容换代。
   **复核（2026-11-20，第三份 #1343：Chrome 156 / macOS / JP，同一句）**：三份都在 `index-jTkyAWT_.js` 上；修复 4b46d14 是 09:38:44 UTC 提交的，
   #1343 是 09:40:38 UTC —— 还是旧部署。线上 `loader.js` 现已是包好的版本（内容哈希 968fa7e61032e49c 与仓库一致）。
   引擎 iframe 里剩下的经典脚本也查过：socket.io 是 UMD 立即执行函数；核心 Emscripten 胶水（引擎用同源 blob 插进来）顶层只有
   `var EJS_Runtime`、`var setImmediate`，只会和别人的 `let` / `const` 同名撞。
   但这一句以前只进日志：loader 一行没执行，适配器等满 120 秒看门狗，播放器自动重试再撞再等 120 秒，三份都是 240 秒才报失败。
   现在 `src/emulator/engineScriptErrors.ts` 认出「开局前、来自本站引擎脚本（`/emulatorjs/`、`/_cn/emulatorjs/`、本站源 blob）的 SyntaxError」，
   适配器当场 failLoad：全局名重复声明按 `'config'`（`ejsScriptConflict`，提示停用扩展或换无痕窗口，不自动重试），其它语法错误按 `'runtime'`。
   服务端诊断把这类日志归成 `script_conflict`（以前落到「启动流程超时或停滞」）。跨源无 crossorigin 的经典脚本报错会被抹成「Script error.」，
   那种照旧靠看门狗。真浏览器复现（真构建 + 生产只读 API，《1942》自动开局，扩展式地在每个框架的 document_start 插 `<script>`）：
   插 `var debug=1` 照常开局（loader 已包好）；插 `let EJS_Runtime=1`，新版开局 2.5 秒报冲突、旧版报含糊的「Error loading EmulatorJS runtime」并按引擎故障重试。
   ⚠️ Playwright 的 addInitScript 里直接写 `let x` 不会成为页面全局，而且 document_start 时 documentElement 还是 null —— 要等它出现再插 `<script>`。
   回归：`npm run test:ejs-script-conflict`。
6. **告警（2026-11-18）**：事故持续几个小时没人知道——聚集报警只发邮件，而生产上邮箱根本没配。现在统一发飞书机器人
   （`server/src/lark-notify.js`，webhook 在 `server/.env` 的 `ALERT_LARK_WEBHOOK`，不进 git）：玩家启动失败按特征聚集
   （`diag-alert.js`，邮件 / 飞书任一通道成功即算报出）、部署中止 / 自动回滚（`redeploy.sh`）、**每 15 分钟的公网开局巡检**
   （`deploy/smoke-watch/`，systemd timer，走 `https://8bitgo.com` 真实路径，失败复核一次再报、持续故障 2 小时提醒一次、恢复再报）、
   看门狗重启 / 停手。shell 统一调 `server/scripts/notify-lark.mjs`（`--dedupe` 去重，发不出去永远不拖垮调用方）。
   部署与巡检共用 `/run/lock/8bitgo-deploy.lock`：部署中巡检跳过，巡检在跑时部署等它。生产机的 Chrome 是 Google 官方 `.deb`
   （snap 版的私有 `/tmp` 读不到 DevTools 端口）；`smoke-start.mjs` 退出前必须等 Chrome 退出并删掉 profile（以前每次留 76MB）。
   看门狗是装在 `/usr/local/bin` 的副本，改了 `deploy/watchdog/8bitgo-watchdog.sh` 要重新 install。

**`npm test` 不能长期红着**：事故当天 main 上有 28 套测试是红的，本该报警的那套就混在里面。改了产品行为就同步改测试断言；
测试红了先修，别带着红灯发布。

### 2.8 街机靠**压缩包文件名**认游戏

叫 `kof97.zip` 才会跑 kof97 驱动，叫别的就 `Romset is unknown`，和内容对不对无关。
所以 `src/services/roms.ts` 里 `FILENAME_IS_IDENTITY` 把 arcade 列为「保留原文件名」。

现在后台上传街机 ROM 会**自动识别**（`src/lib/arcadeRomset.ts`）：读 zip 中央目录里每个成员的
CRC-32（不用解压），比对 `public/arcade-romsets.bin`（9377 个 romset / 13.8 万条 CRC，含跨行 ROM 宏展开）。
完全命中才自动改名；部分命中只列候选——拿父集的名字去套残缺包只会换来 missing files。
完整性校验走 `assertValidZipBlob()`，只读文件尾部 / 中央目录 / 本地头，不再把整个大包
复制成 ArrayBuffer；街机 ZIP 的安全子目录会在上传前拍平，不重压 ROM 数据；同名冲突 / 不安全路径拒绝处理，准确识别的 Namco System 11/12 克隆包保留原结构。玩家本地 ROM 和旧远端对象也必须走 `prepareArcadeArchive()`，拍平后重读目录偏移，不能只修后台上传入口。
玩家下载带 `romv` / 归档版本的街机大包时与 NDS 共用 8MB Range 断点续传；无版本 URL
不留分片，避免 R2 原地换包后把两代 ROM 拼在一起。

**不在驱动表里的包（汉化版、修改版）走 RomData**，别去改名硬套。FBNeo 给这种包留了口子：
一份 `.dat` 写明 `ZipName`（包名）、`DrvName`（借哪个驱动跑）和**整份** ROM 清单，
核心会把该驱动的包名「寄生」成 ZipName，并整个改用 dat 里的清单 ——
汉化包里那几个和原版对不上的 GFX ROM 就是这样加载的。

⚠️ **RomData 只是 FBNeo 能力，不是“FBNeo 系街机核心”通用能力。** 已发布 wasm 取证只有
`fbneo-wasm.data` 包含 `RomData / ZipName / DrvName`，`mame2003` / `mame2003_plus` 都没有。
有 `arcade_romdata` 的游戏开局时会硬纠正到 `fbneo`，别再把 MAME 当成支持 `.dat`。

触发方式挑的是最省事的一条：核心的 `retro_dat_romset_path()` 在内容名查不到驱动时，
**先找和内容同目录的 `<basename>.dat`**，找不到才去 `<system>/fbneo/romdata/`。
EmulatorJS 把 ROM 写在文件系统根目录（`callMain(["/" + fileName])`），
所以 `/wofcn.zip` 配 `/wofcn.dat` 就够了 —— 不必打开 `fbneo-allow-patched-romsets`，
也不必先加载原版 romset 再去核心选项里勾（那是 RetroArch 的交互，网页上没法要求玩家做）。

⚠️ **这个路径示例不代表 `wofcn` 已可正常显示中文。** HBMAME 的 `tk2h5` 虽挂在 `wof` 父驱动下，源码仍将中文字库加载方式标为未知；没有通过游戏画面验证前，不得用旧的 `wofj` 示例或推测的图形合成方案给玩家注入 RomData。

当前实现遵守这条门槛：`src/data/arcadeHacks.ts` 只把候选 `.dat` 和合成函数放在 `experimentalPlan`，玩家可用的 `romData` / `derive` 留空；命中该 ROM 时启动链应以「没有可用加载方案」失败关闭。要启用前必须用真实包启动、投币进入人物对白，并检查普通场景图块与中文对白都正确；字库索引图、标题画面、编译成功都不算验收。

`scripts/build-fbneo-wofcn-core.mjs` 会把补丁应用到锁定的 FBNeo 源码后再编译，并在编译前核对原字码必须早于 `Scroll1TileMask` 保存、扩展字库不能 `memcpy` 覆盖普通 tile。诊断用 `EM_ASM` 只能包含 `<emscripten/em_asm.h>`：根 `<emscripten.h>` 会和 libretro 的 `FILE -> RFILE` 冲突。构建报告必须同时记普通与 legacy 两份核心 SHA-256，`npm run test:ejs-cores` 分别核对；编译成功只证明 wasm 可构建，不替代游戏画面验收。

落地在三处：后台 `games.arcade_romdata` 列存 dat 文本；
`src/emulator/adapters/emulatorjs.ts` 的 `installFsInjector()` 在 loader.js 之前给
`window.EJS_emulator` 装 setter，包一层 `startGame()` 先把 dat 写进 FS；
骨架用 `npm run romdata -- <包.zip> --drv <基础驱动> --fbneo <FBNeo>/src/burn/drv` 生成。
注入循环必须经 `writeFsInjections()` **逐文件隔离失败**：一份 dat / BIOS 写失败只记它自己，
后面的 BIOS 仍要继续写；不准再用一个 try 包住整个循环。

⚠️ 第四列的类型**必须写**。FBNeo 独立版在类型留空时会用 `RDSetRomsType()` 按驱动名 + 长度猜，
但 libretro 版没有这个函数（对照 `libretro/FBNeo` 的 `src/burner/libretro/romdata.cpp`），
类型为 0 的行会被直接丢掉。生成脚本按 CRC 对照基础驱动源码把类型抄准，
对不上的（也就是改版包换掉的那几个）留成 `TODO_TYPE` 由人来定。

### 2.8.0.1 引擎下载器不能永远停在「下载游戏核心 100%」（2026-11-10）

后台 14 天里「加载在『下载游戏核心 N%』这一步停住了」有 30 多次（拳皇 2002 哥伦比亚、拳皇 97 等）。
引擎下载器有三处会让 Promise 永不结束，`npm run ejspatch` 第十节都补上了，`npm run test:ejs-download` 守着：

- 30 秒超时在**收到响应头就清掉**，读包体没有时限：跨洲线路丢了流结尾，进度停在 100% 一直等。
  现在 20 秒没有新字节就 abort，失败交给播放器的自动重试；
- 下载完要 `await storageCache.put()` 才交出结果，开局前还 `await storageCache.get()`；引擎的 IndexedDB 封装
  在 `transaction()` 同步抛错、请求同步抛错、`remove` 出错时都不 settle。put 限 10 秒、get 限 20 秒，
  封装里的同步异常一律当作「没有缓存」；
- 核心失败后引擎会回落 `cdn.emulatorjs.org/<版本>/data/`，而 4.3.0-pre 的官方核心起不来（§2.4），
  只会多等几十秒再报 `Error loading EmulatorJS runtime`。已关掉（`cdnFallback:!1`）。

- **IndexedDB 挂死只等一次**（第十一节，2026-11-11 萨尔瓦多 macOS Safari《超级马里奥》三局都停在「下载游戏核心」、
  **没有百分比**）：一局要连查两次缓存（核心报告 + 核心），各等满 20 秒就超过适配器 30 秒的卡死预算，库坏掉的浏览器
  每局都这样。现在 get 15 秒超时或 put 超时后下载器打 `__8bgCacheDead`，本局不再碰缓存，并写 localStorage
  `8bitgo.ejs.idbStall`；适配器 3 天内据此 `EJS_cacheConfig.enabled=false`、跳过清库和预热探测。
  `purgePoisonedEngineCache` 里的 `indexedDB.databases()` 也加了 3 秒时限（开局要等它）；数据库列表、事务或删除请求提前结束时，时限器都立即清理。
  缓存过期后的 HEAD 复验（8 秒）和文本响应包体（核心报告，20 秒）同样补了时限。

- **时限定时器必须在 get / put 完成后清掉**（第十二节，2026-11-11 孟加拉 Android 10《拳皇 2002》两局慢启动 20 秒）：
  第十一节的 `Promise.race([get(), setTimeout(15s)])` 从不 clearTimeout，get 早已返回，15 秒后定时器照样把缓存判死、
  写挂死标记 —— 开局超过 15 秒的每一局都被误判，适配器随后关缓存，关缓存那局的 get 又续一次标记，永远关着；
  每局都要在手机上重解 7z 核心（约 12 秒）。现在 race 后 clearTimeout，挂死标记换新键 `8bitgo.ejs.idbStall2`
  （旧键全是误判，作废）。`test:ejs-download` 有「缓存正常时不误判挂死」一节。凡是 race 加时限的补丁都要清定时器。

- **核心响应不要 Blob → ArrayBuffer 往返**（2026-11-15，华为浏览器 17 / Android 12，《节奏天国》两次）：两份现场的核心请求均 HTTP 200、
  收到 1.3MB 后立刻报 `NotReadableError`，错误发生在核心写 IndexedDB 缓存之前。旧引擎把 `ReadableStream` 读取和
  `new Blob(chunks).arrayBuffer()` 放在同一个 catch 中，现场没有子阶段栈，不能断言具体是哪一行抛错；但该浏览器已有 Blob
  存储读不出的现场，而 Blob 往返完全多余。响应块已经是 `Uint8Array`，直接按累计字节数分配目标数组并 `set`；流读取本身若仍失败，
  必须把原始异常对象写控制台，以便后续现场确认阶段。引擎核心日志里的 NotReadableError 不能套用 ROM Blob 的恢复：不记 `romBlobBroken`、不标记加速线路坏、
  不自动重下大 ROM；按本机运行环境错误停止并让诊断包保留原因。补丁在 `scripts/patch-emulatorjs.mjs`，构建守卫在 `scripts/check-emulatorjs.mjs`。
  这两份现场的 Resource Timing 都显示核心 1.3MB 已整份收到（等于 `melondsds-wasm.data` 大小）才报错，更像 Blob 往返那一步；
  流读取本身抛错或下载器自己的 20 秒空闲计时触发中止时（仅 GET、无请求体），改用 **XHR arraybuffer** 完整重取一次——不走流也不走 Blob，
  控制台出现「改用 XHR arraybuffer 重新下载」。自有失速通过 `f.__8bgStalled` 与外部取消区分；XHR 仍核对状态、完整长度与错误页。
  ⚠️ 那段代码块里 `t` 被 Content-Length 遮蔽，重取地址必须用 `y.url`。XHR 空闲计时在标签页后台暂停，回来后重给 20 秒；XHR 也失败才 reject。
  2026-11-21 大陆 5 份现场（vivo Browser / Chrome、Android / Windows）都在 `fbneo-legacy-wasm.data` 下载时停流，Fetch 只收到 0–1.9MB 后被这条 20 秒规则主动 abort。
  旧条件见到 `f.signal.aborted` 就跳过 XHR，直接报错；播放器随后退到大陆吞吐很差的 Cloudflare 路径，或重复开局再遇到同样失速。现场不能区分边缘断流、浏览器 Fetch 读流异常和用户网络抖动，
  但确认了本站可以修的恢复缺口：主动失速后尝试 XHR，成功则继续当前线路，XHR 失败才交给播放器。回归：`npm run test:ejs-download`。

- **XHR 兜底必须确认拿到整份核心**（2026-11-17 大陆 Android 16 Chrome 143《明星三缺一》，诊断包 #949）：Fetch 已读到约 24.3MB 后断流，XHR 却以 HTTP 200 返回 121KB；旧逻辑只看状态码，仍把它记成下载成功，随后引擎报 `EJS_Runtime is not defined`。兜底现在要求 HTTP 200、非空、字节数不短于已读流；响应未编码时还要匹配 Content-Length，并拒绝 HTML / JSON 错误页。核心缓存代次必须同步更新，清掉旧逻辑可能留下的工件。
- **版本化核心支持安全续传**（2026-11-21，大陆网络短暂断流）：旧 XHR 兜底会从头再拉整份核心，几 MB 后再次断流仍要重下。现在仅对 `?v=` 版本化的 `cores/*-wasm.data` GET 请求 `Range`；源站 Range 必须走原始 identity 文件，不能拿 `.br` 偏移。版本守卫核实内容哈希后给这些核心发完整 SHA-256 强 ETag（Express 默认弱 ETag 不可用于续传）；版本不匹配时保留 no-store，且不给强 ETag。首响和续传都校验 `206`、完整 `Content-Range`、总长度、强 ETag 和 identity 编码；弱 ETag、缺 CORS 暴露头、代理忽略 Range、偏移不连续或内容版本变化时丢弃旧前缀，完整重下，绝不能跨版本拼字节。Fetch 流中断时 XHR 可从当前内存偏移接续；跨页面只从独立库 `8bitgo-ejs-core-resume-v1` 恢复已经提交的连续 **1 MiB** 分片，manifest 与分片都按 URL + 强 ETag + 总长核对，最终不完整片不落盘。分片库最多 4 项 / 48 MiB、单核心最多 64 MiB、7 天过期；空间不足、IndexedDB 卡住 / 被禁用、Range 或响应头不可用都只关闭续传旁路，不影响正常整包下载，也不写 EmulatorJS 缓存挂死标记。成功接收完整核心后清掉分片。助手源码在 `scripts/lib/ejs-core-resume-runtime.js`，由 `npm run ejspatch` 内嵌；`check-emulatorjs.mjs` 会比对内嵌副本，CN Edge 必须暴露 `Content-Range / ETag / Content-Encoding`。`npm run test:ejs-download` 覆盖同局 XHR 偏移续接、跨页面持久化、ETag 改变、弱 ETag、无 IDB 和错误响应；服务端 `test:precompressed-static` 覆盖真实 Range / If-Range；不可只测补丁字符串。
- **核心 Fetch 连响应头都没拿到时也要切换读取方式**（2026-11-22，大陆 Android WebView 138，《拳皇 97 / 2002》《King of Gladiator Plus》，诊断包 #2907–#2910）：4 次访问在同一份 `fbneo-legacy-wasm.data` 上等待 30 秒后由引擎中止，Resource Timing 是 HTTP 0 / 0 字节；生产文件存在，源站与 CN 入口 Range 探测都返回完整 206。旧 XHR 只在响应头已到、读取包体失败后运行，因此这类首字节前停滞没有备用读取。现在仅当版本化核心 GET 的本地响应头时限触发时，用同 URL 的 XHR 重取完整包，再经过原有状态、长度与错误页校验；普通网络错误和外部取消不额外重试。超时与首个响应竞争时，流回退允许的仍只有本地超时标记。回归覆盖超时后 XHR 成功、普通 AbortError 不发 XHR，并保留 Range / ETag / 错误响应测试。
- **Fetch 在整份核心传完后仍可能以 TypeError 拒绝**（2026-11-25，大陆 32 位 Chrome 99，《King of Gladiator Plus》，诊断包 #4181）：日志里的 `Failed to fetch` 单独不足以区分网络错误，但这次 Resource Timing 的编码体、解码体字节数都精确等于当前 `fbneo-legacy-wasm.data`，传输字节数也覆盖整份文件；之后同局重试未收到字节，最终首帧耗时约 238 秒。只在带当前核心内容哈希的 URL、同次请求 Resource Timing 证明完整传输、XHR 返回字节数再次精确匹配核心清单时，允许一次 XHR arraybuffer 恢复。缺少计时、旧版本、部分字节、外部取消和普通网络错误均不触发整包重试；这修复的是确认完整传输后的恢复缺口，不代表一般网络失败都能重试。回归：`npm run test:ejs-download`。
  复核该现场发现，首次回归夹具用了裸内容哈希，但生产 Range 核心 URL 实际是 `<内容哈希>.range1`；恢复助手按完整字符串相等比较，因而把“当前版本”误判成旧版，完整传输后的 XHR 恢复根本没触发。现在只接受裸哈希或 `<内容哈希>.rangeN`，并用生产 URL 形式回归；不能为了放行而接受任意后缀或放宽完整字节校验。
- **大陆核心断流的 Range 恢复必须能校验版本**（2026-11-22，诊断包 #2903 / #2907 / #2910 复核）：CN `/_cn/emulatorjs/cores/*-wasm.data` 经 EdgeOne 返回 206，却带弱 ETag，且跨源页面读不到 `Content-Range`、`ETag` 与编码头；这会阻止浏览器验证 `If-Range` 并安全续接，恢复时只能再拉整份核心，可能加重首字节前停滞后的下载失败。源站仅在内容哈希匹配时给核心 Range 响应完整 SHA-256 强 ETag，`/_cn/emulatorjs/` 暴露 Range 校验所需响应头；`EJS_CORE_URL_EPOCH` 仅给核心二进制换查询版本以绕过无法清除的旧边缘响应头缓存，核心内容哈希不变。不能据此断言此前的网络中止完全由响应头导致。回归：`npm run test:precompressed-static`、`npm run test:cn-edge`、`npm run test:ejs-cores`。
- **核心启动看门狗不计后台时间**（同一现场）：手机浏览器将游戏页放后台约 278 秒后冻结轮询与 WASM 解压 / 编译；旧适配器仍用墙钟判断 120 秒无活动，回来时立即误报「下载游戏核心 100% 卡住」。隐藏时暂停轮询，回到前台重置心跳并恢复完整预算；若前台仍无活动，之后照常报错。

- **「Cannot allocate Wasm memory」先看是不是 32 位浏览器**（2026-11-11 大陆 Chrome 109 / Windows，8GB、4 核，
  《合金弹头 2》《1941》各一次，核心编译完在 instantiate 时报）。FBNeo 核心起步 128MB、最大 2GB，V8 分配失败会自己
  逐级缩到起步值再试，64 位浏览器不会连 128MB 都给不出；Chrome 109 是 Win7 / 8.1 的最后一版，这批机器常装 32 位版。
  `browserBitness.ts` 用高熵 `bitness`（UA 只能证明 32 位，Chrome 110 起精简 UA 一律写 x64）判断：32 位时以 `'config'`
  报 `ejsOutOfMemory32bit`（换 64 位浏览器，不原地重试）；诊断包环境多一项「32 / 64 位浏览器」。
  位数是推断，这两份样本当时没采到位数，下一份同类现场要先核对这一项。
  **2026-11-13 起默认 FBNeo 内存不足先换 `fbneo-lowmem`**（当前起步 72 MiB、按需增长，`src/emulator/fbneoLowmem.ts`）：
  又来三份同类现场（Chrome 109 / Windows ×2、Chrome 114 / Android 12，位数「未知」），旧逻辑对同一核心原地重试、
  换线路、换 ROM，十秒撞三次同一个错。现在适配器经 `onOutOfMemory` 交给播放器换核心重开一次（32 位也先试），
  并在本浏览器记 30 天，之后街机开局直接用它。低内存版也失败时以 `'config'` 报 `ejsOutOfMemoryLowmem`
  （更新或换浏览器），**不再自动原地重试**：2026-11-14 大陆 Chrome 114 / Android 12、8GB《拳皇97》两轮都在 instantiate
  报 Out of memory，重试只是多等十秒（这台机器 11-13 已出现过，换低内存核心没救）。2026-11-14 又有 Android 玩家在
  8GB 设备上连起步 80 MiB 都分配失败；物理内存充足不代表浏览器渲染进程有足够、连续的 WASM 地址空间，具体是 32 位内核、
  进程限制还是内存碎片仍未知，诊断包的位数当时也是「未知」。尝试将起步堆降到 48 MiB 时，Emscripten 链接器报告核心本身
  至少需要 70.2 MB，产物无法生成。因此将自建低内存核心的起步堆改为可构建的 72 MiB，并继续允许按需增长到 2 GiB；
  `scripts/build-fbneo-lowmem-core.mjs`、`FBNEO_LOWMEM_BUILD`、核心报告和运行时代次必须一起更新。这是降低启动门槛的实验，
  不保证解决硬性进程上限，也可能让运行中扩容更频繁；用新诊断现场和真实街机游戏验证后再决定是否保留。
  于是 `src/emulator/memoryRecovery.ts` 再做三件事：① 失败那一刻 `probeWasmMemoryCeilingMB` 实测还能新建多大的 WASM 内存，
  写进诊断包（`[memory] 低内存核心也失败；此刻还能新建…`），下一份现场分得清「整个进程给不出」还是「被占碎」；
  ② `vendorBrowserName` 认出厂商 / 应用内浏览器（华为、小米、OPPO、vivo、夸克、UC、QQ、微信、百度、360、搜狗 …，
  UA 照样写 Chrome/xxx），提示换 Chrome / Edge / Firefox（`ejsOutOfMemoryVendor`）；服务端 `classifyUserAgent` 同步认这些，
  另把带 `; wv)` 的归成 Android WebView，后台不再一律显示成「Chrome 114」；③ 详情页上整页导航到 `?autoplay=1`
  换一个干净文档重开一次（`takeCleanPageRetry`，每款游戏十分钟一次，sessionStorage 防循环），旧文档的引擎 iframe、
  ROM 副本随之释放。回归：`npm run test:fbneo-lowmem && npm run test:startup-diagnostics`。内存不足不再把大陆加速入口判坏、
  不再换 ROM（scope `runtime`）。低内存版是另一批 FBNeo 源码，即时存档单独一档（`:fbneo-lowmem`）；
  换它的构建要同步 `FBNEO_LOWMEM_BUILD`。回归：`npm run test:fbneo-lowmem`。
- **PS1 默认 PCSX 起步写死 512 MiB：内存不足先换 `pcsx_rearmed-lowmem`，并在下载 ROM 前预检**（2026-11-16，诊断包 #780 / #783，
  大陆 Chrome 132 / Windows 64 位、8GB、8 核，3G 1.35Mbps《生化危机 3：最终逃脱》）。358MB 的 `.chd.8bg` 先下了 15 分钟，
  pcsx_rearmed 才在 instantiate 时报 `Cannot allocate Wasm memory for new instance`；原地重试一轮、玩家手动再开一局，4 次同一个错。
  - **能证实的**：EmulatorJS 发布的 pcsx_rearmed（core build 2.0.2，两个包都是）memory section 起步 8192 页 = 512 MiB、上限 2 GiB，
    而它的数据段只到 0.58MB、栈顶初值约 5.4MB，胶水层带完整的按需增长。512 MiB 是构建写死的预留，不是核心的需要：用合成光盘
    （手写几条 MIPS 指令把屏幕填红，不含任何商业代码）实测，起步改成 64 MiB 后开机堆自然长到约 92MB、做一次即时存档后约 110MB。
    Beetle、mupen64plus_next、genesis_plus_gx、picodrive 同样起步 512 MiB，其余核心 128 MiB 以下（`src/emulator/ejsCoreMemory.ts` 的表）。
    引擎总是在把 ROM 交进来之前实例化核心，而我们的预下载排在引擎前面，所以失败一定在最后才暴露。
  - **#780 的 ROM 不在 JS 内存里**：#783 的 ROM 7.7 秒从 IndexedDB 缓存读回，说明 #780 下载走的是真 Blob（内存下载不写缓存）；
    两份诊断包也都没有「解包到内存」那行。所以不是本站的 ROM 副本占满了渲染进程。**这台机器为什么连 512 MiB 都提交不出来
    （系统提交额度、渲染进程限额，还是别的进程占用），诊断包里没有证据，未证实**。
  - 出事时线上那版的「换干净页面重开」只认 FBNeo 低内存提示（`isLowmemOomMessage`），PS1 的内存不足走不到它；
    aacef9d 放宽成 `isMemoryPressureMessage` 之后才会走。`probeWasmMemoryCeilingMB` 当时只在低内存核心失败时调用，所以两份现场都没有余量数据。
  - **修法**：
    - `npm run build:pcsx-lowmem`（`scripts/build-pcsx-lowmem-core.mjs`）从随仓库发布的 pcsx_rearmed 两个包派生 `pcsx_rearmed-lowmem`：
      只把 memory section 的起步页数等长改成 64 MiB，代码、胶水、core.json、即时存档格式逐字节不变。
      本地实测把默认 PCSX 存的即时存档读进低内存版，读后状态与原档只差 68 字节（RetroArch 计时字段）。
      所以它**不另开存档档位**；记忆卡 .srm 按核心库名 `PCSX-ReARMed` 落目录，也共用。
    - 适配器 `preflightCoreMemory`：起步 ≥ 256 MiB 的核心，在下载 ROM 之前用同样的起步 / 上限页数 `new WebAssembly.Memory` 一次
      （与实例化同一条分配路径）；CHD 定下最终核心、而它和预检过的不同时，在加载引擎前再预检一次。给不出时：
      ① 播放器同意原地换（`inPlaceMemoryFallback`，只给默认 PCSX → 低内存版、可原地重开的会话）就本局直接换，已下好的 ROM 接着用；
      ② 否则 `onOutOfMemory` 重挂；③ 都不行按 `'config'` 报内存不足，播放器只做一次干净页面重开。
      实例化才失败时照旧走 `onOutOfMemory` 重挂换低内存版。任何核心内存不足都先记一次此刻还能新建多大的 WASM 内存。
    - 换过一次就在本浏览器记 30 天（`8bitgo:psx-oom:<构建>`），之后 PS1 开局直接用低内存版，悬停预热也跟着换。
    - 引擎把低内存版当成另一个「系统」，开局前把 `ejs-<gameId>-psx-<gameName>-settings` 复制到它的键（`copyEngineSettingsToSystem`），
      改键 / 金手指不丢。**别把它加进引擎的 psx 别名组**：引擎会优先读设置里存着的 `retroarch_core`，把它换回 512 MiB 的默认核心。
      `npm run ejspatch` 只把它加进 `determineCueSettings` 的名单，cue+bin 压缩包挑文件的规则与默认 PCSX 一致。
  - **边界**：只替换会落到 PCSX 的开局。CHD 压缩器全是 Beetle 认识的（服务端 ISO 转出的 cdzl 盘）仍交给 Beetle：
    CHD 的即时存档档位不分核心，两种核心的状态格式不通用。Beetle 的栈和静态区就占了约 497MB，只改起步页数行不通，那类游戏照旧报内存不足。
    预检失败只说明「这一刻给不出」，不保证低内存版在真实游戏里不会在扩容时再失败。真实大陆机器、真实 PS1 游戏都没有验证过。
  - 换了 pcsx_rearmed 的源包要重跑 `npm run build:pcsx-lowmem`（`test:psx-lowmem` 会核对源包哈希），并同步 `PSX_LOWMEM_BUILD`。
    新增或换掉起步 ≥ 256 MiB 的核心，要改 `EJS_LARGE_CORE_INITIAL_PAGES`（测试对着 cores/ 里的真实 WASM 逐个核对）。
    回归：`npm run test:psx-lowmem && npm run test:fbneo-lowmem && npm run test:startup-diagnostics`。

改引擎后 URL 会自动换（2026-11-15 起引擎入口按内容版本，见 §2.8.1.1 末条），不用再手动换 `EJS_RUNTIME_GENERATION`。

- **建不出 WebGL 不重试、不换 ROM**（2026-11-11《魂斗罗》Linux Chrome 156：`reading 'GLctx'`，原地重试加三种语言 ROM
  一共试了 5 遍）。`isWebglUnavailableText` 命中后现场再建一次 WebGL：仍建不出就以 `'config'` 报
  `ejsWebglUnavailable`（提示打开硬件加速）；建得出说明只是一时，照常重试。
- **NES 建不出 WebGL 时改走 jsnes**（2026-11-13 大陆 Android 12 Chrome 123 / Linux Chrome 108，15 次失败，
  其中《超级玛丽》一人连开 5 局）：这些浏览器整机就没有 WebGL，报得再清楚也玩不了。jsnes 画 2D canvas，播放器开局前
  （effect 里，避开 SSR 水合）用 `webglSupport.ts` 的 `canCreateWebgl()` 问一次，结论经 `webglUnavailable` 交给
  `preferredNesRuntime`：mapper 未明确不支持就选 jsnes，后台固定的 emulatorjs 也让路。
  回归：`npm run test:nes-mapper`。
- **GB/GBC 建不出 WebGL 时改走 binjgb**：备用核心固定使用 Canvas 2D，不依赖 WebGL；有 WebGL 时仍使用 Gambatte。
  运行时先读 ROM，再载入自托管 `/binjgb/` 的 JS/WASM；支持 MBC1 / MBC1M / MMM01 / MBC2 / MBC3 / MBC5 / HuC1，
  其它卡带类型或损坏 ROM 明确报错。输入复用站内键盘、屏幕手柄和物理手柄；即时存档走 binjgb 状态格式，
  普通 SRAM 使用独立本地键与现有 slot 9 云同步；导入的电池数据长度必须与卡带匹配。MBC3 RTC 卡带不写入
  Gambatte 的云存档，避免把 RTC 格式交叉覆盖；binjgb 的 WebAssembly 接口只暴露外部 RAM，RTC 时钟不跨设备同步。
  升级 binjgb 必须换 `BINJGB_BUILD` 并更新
  `public/binjgb/UPSTREAM.md` 中的上游 commit，**同时重跑 `node scripts/build-binjgb-js.mjs`**：浏览器没有 WebAssembly 时
  binjgb 改载同一提交的纯 JavaScript 构建 `public/binjgb/binjgb-js.js`（Emscripten 4.0.20，上游 CMake 自带的 `-DWASM=OFF`
  → `-s WASM=0`，全局名改成 `BinjgbJs`），两份构建的提交必须一致（`test:browser-support` 核对 sha256 与提交）。
  为什么不用 jsGBC 之类的纯 JS 模拟器：同一个核心精度更高、即时存档 / 电池存档格式不变、适配器原样复用；
  jsGBC 的 npm 包还把原生模块 `speaker`（npm audit 高危）和 webpack 拖进生产依赖，它的即时存档 `load()` 是空实现。
- **无 WebGL 的 EmulatorJS 软件画面后备按核心收窄**（2026-11-26，火红 GBA 诊断 #4209 / #4210）：适配器先按后台配置定最终核心；
  街机只给 `fbneo` / `fbneo-lowmem`，GBA 只给 `mgba`，在 EmulatorJS iframe 的 `loader.js` 前安装 `src/emulator/softwareWebgl.ts`。
  GBA 没有 WebAssembly 时仍走 IodineGBA（需要管理员配置合法来源的 16 KiB BIOS）；仅缺 WebGL 且有 WebAssembly 时用 mGBA HLE BIOS，
  避免自动转到没有配置 BIOS 的 IodineGBA。mGBA legacy 的 Emscripten GL 包装额外要求 context `instanceof WebGLRenderingContext`；
  普通 Proxy 会被它丢弃，收尾时触发 `deleteContext` 读取未建立的 `GLctx`。GBA 路径现在只给代理挂 `WebGLRenderingContext.prototype`，
  同时阻止把该原型上的原生方法以伪 context 为接收者调用；FBNeo 保留原代理行为。
  WebGL2 仍返回不可用，因此应加载对应的 `*-legacy-wasm.data`；不把 MAME / FBA 核心改成 FBNeo，`mame-current`、其它核心和平台
  仍在 ROM / 核心下载前报 WebGL 环境错误。该兼容层只实现 RetroArch WebGL1 的基本纹理四边形，不支持离屏帧缓冲、自定义 shader 与顶点颜色；
  若扩展它，必须用禁用 WebGL 的真实目标核心验证首帧与输入。此次以自编 32 KiB GBA 测试程序在禁用 WebGL 的 Chromium 上实测到 mGBA `first_frame`；
  这不替代真实 FireRed ROM / 手柄操作验证。回归：`npm run test:gba-fallback`。不要把 `public/__swgl/` 里的本地试验页或 ROM 当作生产资源提交。
- **`getGamepads()` 被权限策略挡住会抛错，不能让它弄死引擎**（2026-11-14 大陆 iPad iOS 17 应用内浏览器《拳皇 97 风云再起 Plus》：
  `SecurityError: Third-party iframes are not allowed to call getGamepads()…`，之后引擎一行日志都没有、核心一字节没下，
  两分钟看门狗报「卡住」，换线路重试又等两分钟）。本站页面被别的应用 / 网站嵌在 iframe 里、外层没给 `allow="gamepad"` 时，
  我们 iframe 自带的 allow 也拿不到权限；EmulatorJS 的 GamepadHandler 在构造里同步调 `getGamepads()`，一抛错整个引擎没起来。
  `src/emulator/gamepadAccess.ts`：loader.js 之前 `guardFrameGamepads(win)` 把 iframe 的 `getGamepads` 换成读不到就返回 `[]`，
  被挡住时诊断包记一行；外层的手柄轮询（gamepad.ts / gamepadInput.ts / frameFocus.ts）一律走 `readGamepadsSafe`。
  代价只是这种环境里手柄不可用。回归：`npm run test:gamepad-access`。
- **联机超时把握手进度写进诊断包**：信令是否连上、`open-room` / `join-room` 有没有发出、回执是什么、各在第几毫秒
  （`netTrace`）。「联机没有连上」两周 100 多次，11-07 识别出服务端拒绝后已降到每天一两次，剩下的靠这一行定位。
- **全局 `io` 会被引擎覆盖；没连上就断会被引擎退房**（2026-11-11，大陆玩家《拳皇97》《合金弹头2》5 次，
  诊断包「信令 未连上、传输 ?、房间请求 没发出」）。`emulator.min.js` 自带 socket.io，加载时 UMD 执行
  `(globalThis).io = e()`，把 `hookRoomToken` 提前装的包装原样盖掉 —— game_slug 补丁、room-token、握手轨迹、
  拒绝原因全部失效（服务端没有 slug 就回 `game does not support multiplayer`）。现在 `netplaySocketHook.ts` 的
  `installIoHook` 把 `io` 钉成访问器，后赋的值也先包一层。另外 socket.io 的 `Socket.onclose` 没连上过也发
  `disconnect`，引擎据此 `leaveRoom()` 把 socket 置空、自动重连跟着没了（「传输 ?」就是 socket 已是 null）；
  `guardPreConnectDisconnect` 只拦从未连上过的那种。单次握手超时 8 秒（socket.io 默认 20 秒正好等于以前的整体等待），
  整体等待 30 秒，连着 3 次 connect_error 才提前判「连不上」。回归：`npm run test:netplay-socket-hook`。
- **首帧后的开房拒绝不是游戏加载失败**（2026-11-13，MX 玩家《火红》×2、《JOJO》×1）：游戏已出首帧，随后 `open-room` 才收到
  `game does not support multiplayer`；原来适配器把联机拒绝送进 `onError`，播放器因此拆掉能玩的单机游戏并记成启动失败。
  现在只在核心尚未启动时才报加载错误；首帧之后退出房间、保留模拟器并提示联机失败。任何联机失败出口都要清理本次 socket。

### 2.8.0.2 AvP 的旧 CPS2 图形 ROM 是 overdump（2026-11-14）

《异形大战铁血战士》（`alien-vs-predator`）两份玩家现场都由 FBNeo 找到了 `/avsp`，但报缺少
`avp.14m`、要求 CRC `0x39933b1e`。线上旧包 `roms/arcade/avsp.zip.8bg` 中的 `avp.14m` 是 2 MiB，
前后两个 1 MiB 完全相同，每半段 CRC 都是核心要求值；另外三个图形成员也有同样的重复半段：
`avp.16m` → `0x85412860`、`avp.18m` → `0x2e2beb06`、`avp.20m` → `0xe4798d1a`。
这是旧 overdump，不是 BIOS、核心或下载故障。只在确认两半逐字节相同、且半段 CRC 与驱动清单一致后，
才可去掉重复后半段；不要把这个规则套到其它包或改版 ROM。

**2026-11-25 复核：明文 ZIP 已更新，但旁边的 `.8bg` 仍是旧 overdump。** 生产 `game_roms` 绑定为
`roms/arcade/avsp.zip`，`backup_key` 为空。R2 明文 ZIP（9,056,573 字节，SHA-256
`103375cc1223ea02509f7022576e8aaedcfdecd3edc85c95195e3832a3f4127f`）里的四个图形成员均为 1 MiB，CRC
分别是 `avp.14m` `0x39933b1e`、`avp.16m` `0x85412860`、`avp.18m` `0x2e2beb06`、`avp.20m` `0xe4798d1a`。
但相邻 `roms/arcade/avsp.zip.8bg` 仍是 2026-11-03 的 10,448,007 字节旧包，四个成员均为 2 MiB 且上下半段重复；
只更新明文 ZIP 会留下两种内容不一致的候选。

修复前的生产开局冒烟在 ROM 下载后报 `Size is zero` / `RuntimeError: memory access out of bounds`；
诊断没有记录本次实际消费的候选 URL，不能单凭这条失败断言具体选中了哪个副本。修复时用 `scripts/pack-rom.mjs`
从已核验的明文 ZIP 重打 `.8bg`，用 `scripts/unpack-rom.mjs` 往返解包并确认明文 SHA 完全相同，再覆写 R2 的
`roms/arcade/avsp.zip.8bg`。旧坏副本已另存为 `roms/arcade/avsp-overdump-backup-20261125.zip.8bg`，仅供取证，
不是可播放回滚件。覆写后同一路径的生产开局冒烟在 45 秒到达首帧。今后改这类 ROM，明文 ZIP 和派生 `.8bg`
必须一起更新并逐成员核验；旧对象先复制到版本化备份键，再做生产路线开局验证，不能只以数据库绑定或上传成功作为验收。

### 2.8.1 街机 BIOS 分两档：平台一份 + **按系统包**各一份

引擎（EmulatorJS）只给**一个** BIOS 槽位（`EJS_biosUrl`），而 `arcade` 是**一个平台**却顶着
好几套硬件：Neo Geo 要 `neogeo.zip`，IGS 的 PGM 板子要 `pgm.zip`（三国战纪、西游释厄传，
索引里 173 个 romset）。平台那一格填了 neogeo，PGM 就**永远**起不来 ——
报的是 `Romset is unknown` / `missing files`，和 ROM 对不对毫无关系（2026-09-18 加的第二档）。

- **要哪个**：`games.arcade_bios` 存**系统名**（`neogeo` / `pgm`），不是地址。
  上传时由 `identifyArcadeRomset()` 的候选里那个 `bios` 自动填，后台可以手工改
  （识别不出来的汉化版、驱动表里没有的板子就靠手填 —— 这是这个功能的底线）。
  存量数据不用重传 ROM：`cd server && npm run backfill-arcade-bios` 按文件短名查索引补，
  加 `--dry-run` 只看结果。
- **地址在哪**：`platform_bios` 表里键写成 `bios:<系统名>`（`bios:pgm`），
  和平台级共用同一张表、同一套后台 UI（「ROM 存储 → 街机 BIOS 包」）。
  没绑 `bios:<名>` 时退回平台级那一份，**但只在文件名正好等于那个系统名时才算数**。
- **怎么进去**：引擎一个槽位塞不下两个包，所以额外那份由我们自己写进虚拟文件系统根目录
  `/pgm.zip`（核心就是在内容同目录按 set 名找 BIOS 的）。
  决策在 `src/emulator/biosPlan.ts`（纯函数，`npm run test:romdata` 覆盖），
  落盘走 `installFsInjector()` —— 和 RomData 共用**同一个** `EJS_emulator` setter。

⚠️ **`Object.defineProperty(window, 'EJS_emulator', …)` 只能有一个 setter**，后定义的会盖掉前一个，
症状是「某个文件静默没写进去」。加新的 FS 注入一律往 `installFsInjector` 的清单里塞，
别再写第二个注入器（`test:romdata` 有断言守着）。

⚠️ BIOS 包要**和核心同一批**的 romset：换一个版本的 `pgm.zip` 就是 CRC 对不上 → 缺文件。

**没填系统名时服务端按索引补上（2026-11-19）**：2026-11-18《圣魔世纪》（svg）当时没填 `arcade_bios`，播放器只下了平台那格的
`neogeo.zip`（现场那个 1.9MB 的 zip），FBNeo 报 `ROM at index 128 with name pgm_t01s.rom … is required`；管理员一个多小时后补上 pgm 才好。
`bios:pgm` 早就绑好了，缺的只是名字。现在 `mappers.js` 对没填系统名、没 RomData、FBNeo 核心的街机游戏调
`inferArcadeSystemBios()`：所有官方 ROM（含备用源）都认得出且指向同一个系统包才下发 `arcadeBios`；**不推 neogeo**（平台那格本来就是它，
推了只会改动 703 个 Neo Geo romset 的屏幕按键布局）；推出来的名字没有 `bios:<名>` 绑定时播放器只打提示、照常下平台 BIOS。
后台填的值始终优先。回归：`cd server && npm run test:arcade-bios-infer`。

### 2.8.1.1 街机冷启动：三条串行链已拆开（2026-10-25，《恐龙快打》实测）

修之前线上冷启动 14.7 秒，各环节依次是：
- ROM 预下载 + 8BG 解密：2.7 秒；
- loader / emulator.min.js 等入口：1.2 秒；
- FBNeo 核心 8MB：6.1 秒，排在 ROM 之后；
- 7z 解压：2.1 秒；
- `neogeo.zip`：1.6 秒，排在解压之后，而 CPS1 根本用不上它。

二次开局走引擎的 IndexedDB 缓存，只要 0.7 秒。现在的做法：

- **引擎下的核心大多是 legacy 版。** 核心报告的 `options.defaultWebGL2` 为空时，引擎下载 `<core>-legacy-wasm.data`。FBNeo、snes9x、mame2003 都属于这种情况。预热必须用 `emulatorJsCoreDataFile()`，名单是 `EJS_WEBGL2_DEFAULT_CORES`，`test:arcade-runtime` 会把它和 metadata、引擎源码逐项核对。以前悬停预热拉的是 `fbneo-wasm.data`，白下 8MB，点开后引擎再下另一份。
- **点击后与 ROM 并行预热**（`ejsStartWarm.ts`）：入口 / css / 核心报告无条件预热。核心和平台 BIOS 只在引擎库 `EmulatorJS-Cache` 里没有这个 URL 时才预热。⚠️ 查库遇到 `onupgradeneeded` 必须 abort：替引擎建出一个没有 `cache` 表的空 v1 库，会让核心缓存永久失效。
- **平台 BIOS 只在用得上时才下。** 服务端按 romset 索引推导 `Game.arcadeNoBios`（`arcade-bios-index.js` 的 `romsetsNeedNoBios`），条件是所有官方 ROM（含备用源）都是已知、且不需要 BIOS 的 romset。后台填了系统包或 RomData、或者换了非 FBNeo 核心的游戏不推导。认不出的名字一律保守地照下平台 BIOS。播放器只对官方远端 ROM、FBNeo 核心生效。
- **带 `?v=` 的 `/emulatorjs/` 请求长期缓存**（`cache.js` 的 `isVersionedRequest`）。引擎自己拼的 `compression/*` 不带版本，仍然短缓存。界面语言包例外：loader.js **等语言包回来才起核心**，所以 `emulatorJsRuntimePaths(core, 语言)` 经 `EJS_paths[语言]` 给它版本化 URL（2026-11-06《铁拳》热启动里这一步回源 0.8 秒）；改 `localization/*.json` 同样会换 URL。
- **引擎入口与核心都按内容版本**（2026-11-15）：`src/emulator/ejsCoreVersionsData.ts` 记着 cores、`emulator.min.js` / css、`loader.js`、`compression/extract7z.js`、`localization/*.json` 的 SHA-256 前 16 位，`ejsRuntimeAsset` / `ejsCoreAsset` 据此拼 `?v=`。`npm run ejspatch` 打完补丁自动重生成，`check-emulatorjs` 用 `--check` 拦住过期的表；**不再需要手动换 `EJS_RUNTIME_GENERATION`**，它只剩存档元数据 / NDS 偏好键的语义代号。内容没变、只想绕开边缘上的坏缓存（2026-11-08 EdgeOne `Vary: Origin` 那种）时改 `EJS_ENGINE_URL_EPOCH`，只换引擎入口、不动核心。回归：`npm run test:ejs-cores`。

- **点开始后引擎还串行走四步，也要并行**（2026-11-11 大陆 Firefox《圆桌骑士》：ROM 4.9 秒到手，之后 zstd 解码器 1.9 秒 →
  css 2.5 秒 → 语言包 0.9 秒 → `extract7z.js` 1 秒，依次排队）。现在：街机 / 光盘 8BG 在开始下载时就 `prewarmRomPackDecoder()`；
  语言包进预热清单；`compression/extract7z.js` 经 `EJS_paths` 拿版本化地址（引擎按末段文件名查），可长期缓存，
  并在核心不在引擎缓存时一起预热。⚠️ css 不能用 fetch 预热：loader 用不带 crossorigin 的 `<link>`，是带凭据请求，
  Firefox 的 HTTP 缓存把匿名与带凭据分开存、连接也不共用，跨源（cn.8bitgo.com）时 fetch 预热等于白做。
  改为在引擎 iframe 里插 `<link rel=preload as=style>`（`preloadEjsStyle`）。回归：`npm run test:ejs-cores`。

### 2.8.2 mame-current 的内容必须在子目录里：根路径解析不出 rompath

libretro-mame（mame-current）从内容路径解析两样东西：basename（去扩展名）当驱动名，
**父目录当 rompath**。引擎却把 ROM 写在文件系统根目录并传 `/mxsqy102tw.zip` —— 根路径
没有父目录可解析，核心报 `Error parsing system name` / `Error parsing parent path`，
然后以 `No Driver Loaded` 启动。玩家看到的就是 MAME 系统菜单，日志里**一个像样的报错都没有**
（2026-09-20 实测：ROM 名、核心驱动、zip 补丁全对，就卡在这一步）。

修法在 `src/emulator/adapters/emulatorjs.ts`，**主修是给 `EJS_gameName` 直接带路径**：

```ts
if (isMameCurrentCore(core) && engineGameName) {
  engineGameName = `roms/${canonicalMameRomset(engineGameName)}`
}
```

blob 游戏 URL 走 §2.7 那个补丁取 `EJS_gameName` 当虚拟文件系统里的文件名，引擎的
`writeFile` 会自动建出中间目录，`callMain` 拿到的就是 `/roms/<romset>.zip`。

⚠️ **2026-09-20 二次返工教训**：最初只靠 `installFsInjector` 的 `beforeStart` 钩子
在运行时改 `gameManager.fileName`，线上「代码已部署、ROM 也对」却照样回菜单——那条路要
`Object.defineProperty(window,'EJS_emulator')` 的 setter 抢在引擎赋值之前生效，**时序上很脆**，
而失败症状只是「没生效」，没有报错。现在**带路径是主修、钩子只作兜底**（http(s) 直链时
文件名取 URL 尾段、不取 `EJS_gameName`，那种情况仍要钩子改 `fileName`；它见 `name` 里已有
`/` 就跳过，不会重复搬）。**只在 mame-current 上做**——FBNeo / mame2003 在根目录一直正常。

验收看核心日志（MAME 0.289 起要出这几行才算成）：

```text
[libretro INFO] Starting game: "/roms/mxsqy102tw.zip"
[libretro INFO] Game name: mxsqy102tw
[libretro INFO] Game description: Mingxing San Que Yi (Taiwan, V102TW)
```

⚠️⚠️ **往 `/roms` 里写文件之前，父目录必须先建出来**（`fsWrite.ts` 的 `ensureParentDir`）。

Emscripten 的 `FS.writeFile` **不会**创建中间目录 —— 2026-09-20 在真实引擎里实测：
`fs.writeFile('/nodir/x.zip', …)` 抛 `ENOENT`，先 `fs.mkdir('/nodir')` 同一个调用就成功。
而注入器（`installFsInjector`）用**一个 try 包住整个注入循环**，所以：

- 一条写失败 → **后面所有注入都不写**；
- 回报只有一句笼统的「文件没写进虚拟文件系统」，症状和「本来就绑错了地址」一模一样。

`/roms` 是 `relocateMameRom` 才建的，而注入跑在它**之前**：blob 游戏那条路
`/roms` 会被引擎写 ROM 时顺带建出来（引擎自己那段 writeFile 建目录），
**直链游戏**那条路引擎把 ROM 写在根目录 —— `/roms` 根本不存在，BIOS 一条都写不进去。
所以：**任何要写进子目录的注入，都得先 `ensureParentDir`**。回归 `npm run test:fs-write`。

⚠️ **BIOS 也必须待在 `/roms` 里，不能留在根目录。** MAME 的 BIOS 搜索目录就是内容的父目录
（实测核心日志：`GET_SYSTEM_DIRECTORY: "/roms"`，`SYSTEM DIR is empty, assume CONTENT DIR`）。
而**引擎自己下的平台级 BIOS（`EJS_biosUrl`）落点是根目录**（文件名取 URL 尾段），
验证过一次实测：`EJS_biosUrl=/__mxsqy.zip` 时虚拟文件系统是
`ROOT=…,roms,__mxsqy.zip` + `/roms=mxsqy102tw.zip` —— 根目录那份 MAME 根本看不见。
所以适配器里做了两件事：我们自己注入的 BIOS 包直接写 `/roms/<set>.zip`；
引擎下的那份由 `relocateMameBios` 钩子从根目录镜像一份进 `/roms`。
**只对 mame-current 生效**，FBNeo 系列内容就在根目录、BIOS 也照旧写根目录。
症状提醒：漏了这一条，Neo Geo / PGM 报「缺文件」，而文件**看上去确实写进去了**。

⚠️ 平台级 BIOS 与游戏自己的系统包**不是同一块板子时不再下载平台那份**（`skipPlatformBios`）：
一个街机包只跑一块板子，平台填 neogeo.zip 而游戏要 pgm.zip 时那 1.5 MB 下下来核心不会用。
会打一条 `[emulatorjs] 跳过平台级 BIOS（neogeo.zip）：这款游戏要的是 pgm.zip`——
将来报缺文件时先看这条，确认不是「后台系统名填错」被这条规则主动跳过了。

⚠️ **跳过这件事有三个前提，缺一条都不许跳**（2026-09-20 补的，最初只比了名字）：

1. **平台是 `arcade`**：「一个包只跑一块板子」是街机的事实。别的平台（PS1 那种）的
   平台级 BIOS 是**必需**的，被一个手输的系统名顶掉就是整局起不来。
2. **这款游戏自己那份真的会写进去**（`planBiosFiles` 的结果非空 = 绑了地址、名字也合法）：
   否则跳掉平台那份等于**一份 BIOS 都不下**，比不跳更糟 —— 后台把系统名填错一个字母就会
   走到这里，而症状和「真没绑地址」一模一样。这也是 `planBiosFiles` 必须在算
   `skipPlatformBios` **之前**就调一次的原因（后面写文件时复用同一个结果，不重算）。
3. 两边名字都取得到且不相等。

⚠️ 给 `EJS_gameName` 拼 `roms/` 前缀时**只取末段**（`name.split('/').pop()`）：名字里若带了
路径（目录拖放、或数据里存成 `sub/game.zip`），拼出来就是 `roms/sub/game.zip` ——
核心的父目录于是变成 `/roms/sub`，rompath 和 **system dir 一起跑偏**，BIOS 又找不到了。
末段同时就是核心认定的驱动名，所以这样取是等价的，且天然幂等（不会叠成 `roms/roms/`）。

⚠️ 文件名照样是身份（§2.8 那条对 MAME 同样成立）：错名游戏用
`src/emulator/mameRomset.ts` 里的 `MAME_ROMSET_ALIASES`（mxsqy → mxsqy102tw）纠偏。
`canonicalMameRomset()` 还会把**不可能是 MAME 短名**的上传名（含连字符、空格、括号、大写，
或超过 16 个字符）收成第一段合法片段：2026-10-26《铁拳》存成 `tekken-root-flat.zip`，
核心 stderr 一个字都不打，直接停在 RetroArch「Quick Menu / No Items」；同一个包叫
`tekken.zip` 实测 60fps。合法短名（克隆集 `tekkenac` 等）原样保留，不许「纠正」成父集。
⚠️ **mame-current 的按键 5 / 6 与 FBNeo 对调**：libretro/mame `input_retro.cpp` 的默认 button_mapping 是
B A Y X **L R**（FBNeo 是 B A Y X R L）。键位表、屏幕手柄都走 `arcadeButtonIdsFor(core)`
（`src/lib/keymapData.ts`），别再直接用 `ARCADE_GENERIC_BUTTONS`。2026-10-27《狂热节拍》实测：
表上「按键 5 = E」按了没反应，真正的五号键是「按键 6（Q）」。DJ Main 的转盘是 IPT_DIAL，
方向键左 / 右（A / D）或鼠标横移都能搓。

⚠️ **CHD 绑定不比 storedBytes**：`mameDiskSatisfies()`（`src/lib/mameArcadeMedia.ts`）只认
romset / 文件名 / CHD SHA-1，目录写了才比 Data SHA-1 与逻辑容量。无损重压会改变压缩后大小；
c5d6431 改了目录却漏了播放器那处 `===`，绑好的盘恒被判「缺少必需的媒体盘」。

⚠️ **《狂热节拍》开机自检慢是实机行为，不是坏了**：DJ Main 自检要整块读写 16MB 音源 DRAM，
画面上「S RAM」「HDD」两行原速要 ~69 秒才出 OK、~77 秒才到 KONAMI 标志；真出错显示
E114 / E710 并停住。`src/emulator/mameBootSkip.ts` 对实测过的 romset（目前只有 bm1stmix，
4300 帧）开局不限倍率快进，~5 秒跑完，片头前恢复原速；联机不快进，销毁 / 进联机立刻取消。
加新 romset 前先实测帧数，别把需要玩家看的画面一起跳过。

⚠️ mame-current 必须 **non-merged** 单包自洽；缺一个成员就是一行
`v-102tw.u39 NOT FOUND (tried in mxsqy102tw mxsqy)` 然后照样回菜单，别只盯着路径查。

⚠️ **上传的 zip 里成员必须在顶层，不能套一层目录。** 2026-09-20 那份明星三缺一 ROM 的
7 个成员里，`v-102tw.u39` 被放在 `mxsqy102tw/` 子目录下（其余 6 个在顶层）——MAME 只读
zip 顶层条目，于是照旧报 `v-102tw.u39 NOT FOUND` 回菜单。拍平（去掉顶层目录前缀）后
7 个成员全在顶层，本地与线上都直接进游戏。**踩坑点：8BG 只做外层包装（zstd + AES），
内层 zip 的文件名与嵌套结构原样保留**，所以后台看 `originalName` / 文件大小都对，
问题却在内层清单里——验收要列出 zip 成员看，别只看外层。

**窄例外（2026-10-25）：** 有些下载包会把多个克隆版放在子目录，但目标父集本身的必需 ROM
仍全部在根目录。只有 `src/lib/namcoSystem11.ts` 里按 MAME 官方文件名 + CRC **逐项完整命中**的
Tekken/System 11 父集才允许保留原 ZIP 上传；MAME 使用 `tekken.zip` 时只读取根目录对应成员，
子目录中的其它克隆成员不会参与启动。缺项、错 CRC、重复成员或不安全路径仍要拦截；未知游戏仍遵守
“所有成员必须在顶层”，也绝不自动拍平/删除用户包内容。回归：`npm run test:namco-system11-upload`。

该 romset 的成员与 CRC（对照 MAME 0.289）：
`a8_027a.u41=f9ada8c4`、`igs_l2404.u23=dc8ff7ae`、`igs_l2405.u38=2f20eade`、
`igs_s2402.u21=a3e3b2e0`、`igs_m2403.u22=53940332`、`v-102tw.u39=16095b98`（+ `igs_m2401.u39=32e69540`）。


### 2.8.3 mame-current 的音频毛刺：窗口只有 64ms，且它对主线程卡顿极敏感

核心的音频驱动（RetroArch 的 `RWebAudio`，编译在核心胶水层里）是**按块排期**的：
每批音频一个新建的 `AudioBufferSourceNode`，靠时间戳首尾精确相接；能提前排多久由窗口决定，
而窗口就是 `retroarch.cfg` 里的 **`audio_latency`**（引擎写死 64）。窗口算出的可用帧数不足时
（`_RWebAudioWriteAvailFrames() < num_frames`）在 nonblock 下**整块丢弃**；队列排空后又要
`ceil(now*1000)/1000 + MIN_START_OFFSET_SEC` 重新起算 —— 两者都是波形不连续，听感就是
短促音效上的**毛刺**（MAME 实测到过 91ms 的主线程长任务，91 > 64，窗口必然被抽干）。

修法：开局前把 cfg 里的 `audio_latency = 64` 改成 128（`src/emulator/mameAudio.ts` 的纯函数，
`raiseMameAudioLatency` 钩子挂在 mame-current 的 `beforeStart` 链上，**只给 MAME**——
它是本站最重的核心，FBNeo 那一批轻得多，没必要为它们付 +64ms 音画延迟）。

**时机是成立的，已验证**：cfg 由引擎在建核心模块时写好，而核心是**在 `callMain` 里才读它**
（实测 `startGame` 那一刻 cfg 里已经有 `audio_latency = 64`），我们的钩子正好卡在 `callMain` 之前。

**验收看核心日志**（这是唯一的判据，`Buffer size` = latency × 48000 × 2ch × 4B）：

```text
[INFO] [RWebAudio] Device rate: 48000 Hz.
[INFO] [RWebAudio] Buffer size: 49152 bytes.   # 128ms；默认 64ms 时是 24576
```

回归：`npm run test:mame-audio`（含「引擎还写不写 64」「cfg 路径有没有变」两条取证断言，
引擎升级后它红了就重新取证，别直接改数字）。**注意它是延迟换稳定**：想调到别的值，
改 `MAME_AUDIO_LATENCY_MS` 并同步上面那条「Buffer size」断言。

### 2.8.3.1 JoJo CPS-3：默认走 FBNeo 四键；切 MAME 必须有 CHD

线上《JOJO 的奇妙冒险：未来遗产》当前 ROM 名是 `jojobar1.zip`，完整 CRC 集在本站 FBNeo
索引内，所以没有显式核心覆盖时按街机默认 `fbneo` 启动是正确的。MAME 当前目录对同名 set
另要求 `cap-jjm-1.chd`；不要因简介提到 MAME 就把它自动改成 `mame-current`，MAME 缺盘会在
启动前报错。若管理员确实把核心改为 MAME，必须沿 `mameChdProfileForRomset` / `detectedMameMedia`
校验并绑定该 CHD，不能静默落到 MAME 菜单。

该游戏按轻拳 / 中拳 / 重拳 / 替身四键操作。旧游戏记录未设置 `arcadeButtons` 时，
`effectiveArcadeButtons` 需要按 slug 推断四键，并同时用于键位说明、手柄图和触屏虚拟手柄；
后台明确配置仍优先。否则页面会误画按键 5 / 6，手机上也会多出无效按键。

### 2.8.3.2 Sega Model 2（Dead or Alive / doaae 等）：按 MAME 源码目录认包，merged 包自动重组（2026-11-18）

FBNeo 没有 Model 2，只能走 mame-current（全量 MAME 0.289 核心里 90 个 Model 2 set 全在，已逐个核对）。
网上的 Model 2 包几乎都是 **merged 包**：`doa.zip` 里装着 doa / doab / doaa / doaab / doaae 五个版本，
克隆集里和父集同 CRC 的 ROM 只存一份、用父集的芯片位置名（doaae 的 `mpr-19318.10` 在包里叫 `mpr-19318.11`）。
所以识别**按 CRC + 长度**，不按文件名。

- **数据**：`src/lib/mameSetCatalogData.ts` 由 `node scripts/gen-mame-set-catalog.mjs <MAME 源码根目录>` 生成，勿手改。
  生成器展开 ROM 宏（`MODEL2_CPU_BOARD` / `MODEL2A_VID_BOARD`）、只取默认 BIOS 的 ROM，并沿机台配置把**设备 ROM**解析出来
  （含 `set_default_bios_tag` 改写：Daytona 的 model1io 用 epr14869c，Virtua Cop 的 model1io2 用 epr17181 + HD44780）。
  认不出的设备宏直接失败，不当成「没有 ROM」。核心换 MAME 版本要重新生成。约 80KB，只在需要时动态加载。
- **后台上传**（`GameForm.tsx`）：在拍平**之前**按目录识别。merged 包里凑得齐多个版本且文件名不是其中一个短名时，
  弹窗让管理员选（不替他猜：2A / 2B 是不同板子）。选中的版本用 `rewriteZipEntries`（`src/lib/zipRewrite.ts`，拍平器也用它）
  按 MAME 原名重组为 `<romset>.zip` 单集：只改 ZIP 头，压缩数据原样引用，不重压。自动选 mame-current，按 MAME 输入定义填动作键数
  （DOA 三键 → 4 键布局）。
- **设备 ROM**：Model 2A/2B/2C 都要 Sega Billboard 的 `epr-18022.ic2`（CRC 0ca70f80）。MAME 找设备 ROM 的顺序是
  `[segabill, 游戏 set, 父集]`：包里自带就一并放进单集；没有就自动填「BIOS 包（系统名）」= `segabill`，
  需要在「ROM 存储 → 街机 BIOS 包」上传 `segabill.zip`（上传时按目录核对 CRC）。「BIOS 包」只有一格，缺两组设备 ROM 的
  （Virtua Cop）要把它们放进游戏 ZIP。
- **播放器**：远端街机包的 ROM 名像 Sega（epr- / mpr- / opr-）才加载目录；认出后强制 mame-current、按 CRC 结果命名、
  跳过用不上的平台 BIOS（neogeo.zip）。本地「玩本地 ROM」不走这条路（与 Namco 现状相同）。
- **2026-11-18 实测**（无游戏数据，用名字 / 长度 / CRC 对得上的全零占位 ROM）：`/roms/doaae.zip` 带 `epr-18022.ic2` 时
  MAME 进入机器、i960 开始执行（随后因全零程序报 `I960: 0: Unhandled 00`，符合预期）；去掉这颗 ROM 则机器不启动。
  **真实游戏的速度没有验证**：Model 2 是 3D 板，i960 + TGP 在 WASM 里解释执行，手机多半跑不满速；
  MAME 源码 TODO 还写着 doa / doaa 声音会花、逐渐无声。上架前在目标设备上实测到正式对战。
- 回归：`npm run test:mame-set-catalog`（真实目录 + 合成 merged 包 + 字节级重组 + 接线断言）。

### 2.8.3.3 MAME 麻将机（《龙虎争霸》lhzb 等）：键盘直通 + 白名单，触屏换麻将面板（2026-11-19）

只有麻将面板的 IGS 麻将机（名单在 `shared/mahjong-panel-sets.js`，按 MAME 源码沿 PORT_INCLUDE 展开得出；
另含 `sdmg2` / `mxsqy` / `mxsqy102tw` 这些可切换机台：MAME 出厂 Controls 分别是 Mahjong / Joystick / Joystick，
本站新玩家默认选 `Controls=Mahjong`；开局时读回实际档位，玩家保存了 Joystick 时走普通街机输入。）这些游戏的麻将档在 MAME 里用 `IPT_MAHJONG_*`，默认**只绑键盘**。本站 EmulatorJS
默认是「键盘 → RetroPad」，于是能投币开局、进了牌局一张牌都打不出去。`src/emulator/mahjongPanel.ts` 接管三条输入：

- **键盘**：开局后 `changeSettingOption('keyboardInput' / 'altKeyboardInput', 'enabled', true)`（第三参 true，不写进玩家设置），
  RetroArch 的键盘回调挂在引擎 `elements.parent`（`!parent`）上；桥装在 parent 的**捕获阶段**做白名单：面板键（A–N、空格吃、
  左 Alt 碰、左 Ctrl 杠、左 Shift 听、Z 胡、3 押注、右 Ctrl 得分、右 Shift 比倍、Enter 大、Backspace 小、1 开始、5 投币）放行，
  别名 V→投币、P→碰、S→得分换成原生键码重发，其余一律不让 MAME 看见 —— MAME 自己认 P 暂停、Tab 菜单、Esc、F2 测试、F3 复位。
  站内 F2 / F4 在 iframe document 捕获阶段，早于桥，不受影响。实测 RetroArch 自己的键盘热键（H 复位、K 帧步进）在这个构建里不生效。
- **手柄**：十字键左右在 A–N 间挪光标（画面顶部提示「选牌 X」），A 出牌，B/X/Y/LB/RB = 吃碰杠听胡，LT 押注、RT 得分、L3 比倍、↑↓ 大小；
  Start / Select 仍由引擎走 RetroPad（libretro-mame 的 JOYCODE_START / SELECT）。
- **触屏**：收掉引擎的街机虚拟手柄，声明 `mahjongPad`，播放器画 `MahjongPad.tsx`。屏幕面板 / 手柄的短按至少按住 70ms，
  否则按下和松开落在同一帧里核心看不到（PORT_IMPULSE 的投币最明显）。

联机人数：`netplay-auto.js` 把名单里的板子推断成 1 人（一块面板就是单人台；键盘直通也不在 EmulatorJS 联机同步范围内）。
存量游戏要 `cd server && npm run migrate`（会全库重算）或在后台重存一次才更新。

⚠️ **焦点**：引擎在 startGame 末尾 `elements.parent.focus()`，适配器随后 `focusFrame(iframe)` 会把 iframe 里的焦点重置回 `<body>`，
而引擎 keyChange 和 RetroArch 都只听 parent —— 所有 EmulatorJS 游戏点完「开始游戏」键盘都没反应、得先点一下画面。
现在 `focusEngine()` 先给 iframe 再给 parent，开局和 `handle.focus()` 都走它。回归：`npm run test:mahjong-panel`。

### 2.8.4 NDS：默认 melonDS DS 1.4.0，WASM 崩溃时旧核心兜底

本站 NDS 默认核心是自构建 `melondsds-wasm.data`（上游 melonDS DS v1.4.0），
`src/data/platforms.ts` 与后台下拉都直接写 `melondsds`。历史游戏数据若仍填 `nds` / `melonds`，
`emulatorJsCoreForGame()` 会在开局时硬归一到新核心；旧 `melonds-*.data` 仅作为运行时兜底发布，
不会因为历史字段而默认启用。新版发生 `RuntimeError: unreachable` 或 WASM 越界时，
播放器只对可安全重启的本机会话切换一次 `melonds-compat`；联机/云端会话不擅自重建。
两核心的即时存档使用独立档位，不能互相覆盖。回归：`npm run test:nds-crash`。
`ndsCorePreference.ts` 只记同一新版核心确实触发 WASM 陷阱、且内容身份稳定的 ROM：下次开局与
悬停预热直接走旧核心，避免重复初始化崩溃。没有 `romv` / 归档版本的远端 ROM 不持久记忆；
引擎资源代次和新版核心 SHA 前缀任一变化都会使旧记录失效，回归测试核对构建报告。
⚠️ 已定位的 `unreachable`（线上 `wasm-function[2361]:0x1a46fb`）不是模拟 bug，是**链接期 ABI 冲突**：
melonDS DS 自带的 libretro-common 声明 `int64_t path_get_size()`，EmulatorJS RetroArch 定义的是
`int32_t`。两者静态链进同一个 wasm 后同名 C 符号只留 RetroArch 那份，wasm-ld 只报 warning，
并把核心的三处调用换成 `unreachable` 桩：FlushFirmware 两个分支（重置、卸载、游戏改写固件后
定时落盘必崩）和读 system 目录（目录里只要有一个普通文件就在开局崩）。`build:melondsds` 现在
把这三处改走签名一致的 filestream API，并把最终链接里的 `function signature mismatch` 升级为
构建失败；报告里 `linkAbiChecked: true` 才是修复后的包。回归：`npm run test:melondsds-abi`。
同一个脚本还守着三件事：① 未定义符号也让构建失败（Makefile 用的是 `ERROR_ON_UNDEFINED_SYMBOLS=0`）；
② melonDS DS 前端以 `-fexceptions` 编译和链接——它用 C++ 异常报告加密 ROM、坏 ROM、DSi 专用游戏等
开局错误，旧包里没有任何 catch，这些错误只会变成一串数字的未捕获异常，也不会触发兼容核心回退；
模拟核心本体不开，热路径不受影响；③ 出包时自动改 `EJS_RUNTIME_GENERATION`，新核心和新代号必须
一起提交部署，否则浏览器可能把旧 `.data` 缓存到新 `buildStart` 名下。
⚠️ 《宝可梦 黑》开局 `RuntimeError: null function`（`wasm-function[2284]:0x183807`）是 melonDS 上游的
**未初始化成员**：`GPU.h` 里只有 `u16 VRAMCaptureBlockFlags[16]` 没写 `{}`，GPU 构造时
`SetRenderer → SyncAllVRAMCaptures` 在 `Rend` 还是 nullptr 时读它；4MB 多的 NDS 对象落在加载 ROM
留下的旧堆内存上，残留字节带 IsCapture 位就调用空虚表槽。它对具体 ROM 是确定性的（黑每次崩、白不崩）。
`build:melondsds` 在 configure 后把它零初始化，并让 `SyncAllVRAMCaptures` 在没有渲染器时直接返回；
报告里 `gpuCaptureFlagsInit: true` 才是修复后的包。前端兜底同时补了两处漏接：`ndsCrash.ts` 认全部
WASM 陷阱措辞（V8 / Firefox / Safari）；开局陷阱被引擎 catch 后是 `console.warn('Failed to start game', e)`，
错误探针对 warn 级的**真 RuntimeError 对象**也走换核心，且换核心后不再触发 onError 的重试 / 换语言 ROM。
出包时 `NDS_MODERN_CORE_BUILD` 会跟着新 SHA 自动更新。
⚠️ 对《宝可梦 白 2》这份 256MB ROM，兼容核心已实测能过片头到“从最初开始”，
但本地测试点进新游戏后仍出现长时间黑/白屏；**到菜单不等于确认可通关**，
在角色创建和第一段可操作场景都通过前不能把它标成完整修复。
用户确认没有 NDS 存档，所以没有做 `.sav` → `.srm` 或旧即时存档的迁移桥。

普通游戏详情页没有全站 COOP/COEP，因此发布的是**非 pthread 软件渲染版**：JIT、OpenGL、
threaded renderer 都在构建时关闭，避免 SharedArrayBuffer 初始化失败。间接 Wi-Fi 保留，
pcap 直连网络在浏览器构建里关闭。可复现构建入口：`npm run build:melondsds`。
DeSmuME / DeSmuME 2015 仍是逐游戏兜底；自动切换仅由确定的 WASM 崩溃触发，
普通下载/ROM 错误不能误切到旧 melonDS。
⚠️ **melondsds 只有 WebGL2 构建，没有 `-legacy-wasm.data`**（2026-11-14 大陆 Chrome 149 / Windows《使命召唤：战争世界》）：
浏览器建得出 WebGL1、建不出 WebGL2 时，引擎去下不存在的 legacy 版 → 404 →「显卡驱动已过时」；ROM 下完才报，
又被当成内容错误换语言 ROM，前后白下三遍。现在播放器开局（和悬停预热）用 `canCreateWebgl2()` 问一次，
建不出就走 `ndsCoreForWebgl2` 换 `melonds-compat`（旧 melonDS 有 legacy 构建，即时存档独立一档）；显式指定核心时
适配器在下载 ROM 前以 `'config'` 报 WebGL 环境错误；引擎这句「Outdated graphics driver」也一律按 `'config'` 报，
不重试、不换 ROM。`EJS_WEBGL2_ONLY_CORES` 由 `test:nds-crash` 对着 cores/ 核对。

⚠️ **小内存设备上不带原因的 `Aborted()` 是内存不够，不是核心坏了**（2026-11-14 香港 Android 10、2GB、Chrome 138
《使命召唤：战争世界》，64MB ROM）：melonDS DS 在 ROM 交给引擎几秒后只报 `Aborted()`，播放器换兼容核心并记住，兼容核心
同样 `Aborted()`，白等三十秒、下次访问还直接用兼容核心。C/C++ 的 new / malloc 拿不到内存（WASM 堆长不动）就是 terminate →
abort()，不带文字；真正的核心 bug 是 unreachable / null function 这类带名字的陷阱。适配器 `reportCoreCrash` 先过
`isLowMemoryAbort`（`memoryRecovery.ts`：裸 `Aborted()` 且 `deviceMemory ≤ 2`、32 位浏览器，或 NDS 崩溃时连 512 MiB WASM
地址空间都分配不出），命中就以 `'config'` 报 `ejsOutOfMemory`，不换核心、不记偏好、不自动重试；读不到内存且探针不可用时照旧换核心。
同时 `npm run ejspatch` 第十四节让引擎写游戏文件时 `FS.writeFile(…, {canOwn:!0})`：MEMFS 直接接管那块数组，开局那一刻
JS 侧少一整份 ROM（64MB ROM 就是 64MB），所有 EmulatorJS 平台受益；`check-emulatorjs` 守着；改了重跑 `npm run ejspatch`，引擎 URL 按内容自动换代。
这只能降低峰值，2GB 设备开 64MB 以上的 NDS ROM 仍可能不够。回归：`npm run test:fbneo-lowmem && npm run test:nds-crash`。

⚠️ **裸 `Aborted()` 不能当作新版核心专属故障长期记住**（2026-11-16，大陆 Chrome 132 / Windows 64 位、8GB，
《侠盗猎车手：血战唐人街》连续 4 次）：melonDS DS 首次 abort 后切旧 melonDS，旧核心也 abort；旧逻辑仍把第一次失败记成 ROM 的
兼容核心偏好，后续开局就跳过新版，重复撞旧核心。裸 abort 没有说明是核心缺陷还是当前标签页内存压力，故 NDS 在崩溃时探测
可新建的 WASM 地址空间；连 512 MiB 都分配不出时走内存提示与一次干净页面恢复。设备内存和浏览器位数正常、未检测到明显内存压力时，
仍允许本局切旧核心，但**不保存偏好**；unreachable / 越界 / 空函数等确定陷阱仍可记住。偏好键升到 v2，让旧逻辑写入的错误记录失效。
回归：`npm run test:nds-crash && npm run test:fbneo-lowmem`。

2026-11-22 《黄金太阳》mGBA 裸 `Aborted()` 的旧现场没有异常栈，不能确认是 ROM 回调、核心内部还是标签页内存压力。`installErrorTap` 现在把跨 iframe `RuntimeError.stack` 交给 `reportCoreCrash`，适配器以 `[core-crash-stack]` 写入脱敏启动诊断；这能让下一份现场定位调用路径，**不代表旧事故根因已确认**。回归：`npm run test:nds-crash`。
这份 ROM 是 128MiB（头部记录 127.7MB 有效数据，只有 6.5MB 填充，裁剪没意义）。本机复现时，melonDS DS 开局时 WASM 堆的变化是：

- 开局前 128MiB；
- 读入内容后 262MiB：RetroArch 的 persistent 缓冲加 `retro::GameInfo` 的 memcpy；
- 进卡带前 470MiB：`ParseROM` 再复制一份，这一步实际要约 422MiB。

把扩容上限压到 263MiB，就能原样得到 `Aborted()` → `Failed to start game RuntimeError: Aborted()`。
`GameInfo` 的构造函数是 noexcept，`make_unique` 拿不到内存只能 terminate，所以前端开了 `-fexceptions` 也没有错误画面。
兼容核心 melonds 也要撑到约 361MiB，换它省不了内存。

`build:melondsds` 的 `patchBorrowPersistentRom` 去掉中间那份：前端经 `GET_GAME_INFO_EXT` 确认 `persistent_data`、指针和长度都对上时，
`GameInfo` 只借用 RetroArch 的缓冲，否则照旧复制。RetroArch 在 `retro_unload_game` / `retro_deinit` 之后才 `content_deinit`，借用是安全的。
预计开局需要的堆降到约 294MiB；报告里出现 `borrowsPersistentRom: true` 才是带这项修复的包。
这项修复已按锁定的上游提交出包：`public/emulatorjs/cores/reports/melondsds.json` 的
`borrowsPersistentRom: true`、`sha256` 与 `src/emulator/ndsCorePreference.ts` 必须一致；每次重编后重跑
`npm run test:melondsds-abi`、`npm run test:ejs-cores` 和 `npm run test:nds-crash`，再用同一份 ROM 复测堆峰值，
并抽测几款 NDS 的开局、即时存档 / 读档、重置。ROM 借用只省掉前端 `GameInfo` 的一整份复制，不代表所有裸 `Aborted()`
都已根除；内存探针和干净页面恢复仍要保留。
复现方法：裸 EmulatorJS 页必须同时给 `system_directory`（见 `configureNdsSystemDirectory`）和 `melonds_sysfile_mode=builtin`。
少了任何一项，核心就停在 `No system directory is available` / RetroArch 菜单，堆只到 315MiB，看起来“省了内存”，其实游戏根本没加载。
用 `getState()` 能取到约 19MB 的状态，才算真的开机了。

NDS ROM 由适配器自己按 **8MB Range** 顺序下载；每片完成后写进独立的
`8bitgo-rom-downloads` IndexedDB，所以刷新页面、浏览器崩溃或断网重开后会只补缺失片。
临时片只认带 `romv` / 归档版本的内容键，防止 R2 原地换包后把两代 ROM 拼在一起；完整合并后
立即清临时片，再由 `romCache` 保存完整 ROM，避免长期占双份空间。临时会话保留 7 天、最多 4 款；
无痕模式、配额满或 IndexedDB 故障一律降级为普通下载，不能影响开局。实现见
`src/emulator/downloadResume.ts` 与 `fetchBlobWithProgress`，回归：`npm run test:chunked-fetch`。

⚠️ **续传片可能读不出来，解包要报进度**（2026-11-12 大陆 Windows Chrome 132 / 2GB《口袋妖怪：白 2》：同一页重开 7 次，
ROM 每次都下完，之后一局 120 秒没动静被判超时，一局抛 `NotReadableError`）。续传片是 IndexedDB 里的 Blob 引用，
这台浏览器的 Blob 存储已经坏了，读包时要么永不返回、要么抛错；而 114MB 的 8BG 解包 14 块期间又一个进度都不报。
现在：`fetchBlobWithProgress` 复用续传片前先探首尾字节（`blobReadable`，8 秒上限），读不出整组作废、本局不再写续传；
`unpackRomPackBlob` 每块经 `readBlobRange`（60 秒上限，超时也抛 `NotReadableError`）读并报一次进度
（街机 / NDS / 光盘报 `rom` + `detail: 'rom-pack'`，DOS 报 `starting`），启动看门狗不再把慢解包当卡死；
街机、NDS / 光盘、DOS 三条下载路径遇到 `isBlobReadError` 作废续传片与缓存、不带续传重下一次。回归：`npm run test:chunked-fetch`。

⚠️ 首个 Range 请求同样必须进重试循环；它既是能力探测也是第 0 片，弱网最常在建连时断。
连续 30 秒无字节会 abort 当前 signal，再换新的 controller 重试（已 abort 的 signal 不能复活）。
NDS 分片失败不能退回 EmulatorJS 的整包 XHR：那会无视已落盘分片，还吞掉播放器的自动重试。

NDS 在写入完整 ROM 缓存前会读文件头 / ZIP 中央目录：只允许一个 `.nds` / `.srl`，限制
解压后大小与成员数，并拒绝目录穿越。校验还会记住包内真正的 ROM 路径，开局前纠正
EmulatorJS 的“扩展名不认识就取第一个成员”兜底（典型失败是 README 排在 `.srl` 前）。
`200 + HTML/JSON` 错误体因此不会被永久钉进 `romCache`。回归：`npm run test:roms`。
`.srl` 也必须出现在本地检测与 `slugFromKey()` 的后缀表里，否则后台虽允许上传，却无法按文件名
自动匹配游戏；回归：`npm run test:rom-probe`。

⚠️ NDS 下载上限必须在 `fetchBlobWithProgress` **分配分片表和读取包体之前**检查：裸卡带上限
512MiB，8BG 外层另留 64MiB 密文/清单余量；Range 的 `Content-Range` 若谎报巨大 total，
不能先 `Array.from` 再指望 `assertNdsRomBlob` 收尾。损坏的跨刷新续传 metadata 也要先验总量再分配。
`200` 整包路径同样检查 Content-Length，未知长度流按已收字节止损。回归：
`npm run test:chunked-fetch && npm run test:nds-platform`。
⚠️ **Safari 18 不能把大 ROM 的外层 Blob 直接交给 iframe Response**（2026-11-13 爱尔兰 Safari 18《宝可梦 白 2》）：
ROM 已下载完成、核心也命中缓存，EmulatorJS 再 fetch 外层创建的 `blob:` 地址时读约 3 秒报 `TypeError: Load failed`；
原地重试和换语言只会重复同一路径。`installBlobFetchShortcut()` 要从外层 `Blob.slice()` 每次读 4MB，
再用 iframe 自己的 `ReadableStream` 交给引擎，不能把整个 Blob 当 `Response` body 跨 realm 传递。
⚠️ **分块流只给 WebKit 和内存 ROM，Chromium / Firefox 仍用 `new Response(blob)`**（`streamRomToEngine`）：流没有已知长度，
Chrome 的 `response.arrayBuffer()` 只能边收边扩容。2026-11-13 大陆 Chrome 132《生化危机 3》352MB PS1 镜像连开 9 局，
每局流到约 300MB 报 `Failed to fetch non-http URL: TypeError: Failed to fetch`（我们的分块读取没出错）；Blob 回应一次分配。
Blob 回应读不出时 NotReadableError 只在引擎那一行里，`reportEngineError` 据此同样记 Blob 存储已坏并按 `'runtime'` 重试。
若分块读取仍失败，后续 8BG 开局改用有大小上限的内存块输出，避免对坏掉的 Blob 存储持续重试。
这个结论记在 localStorage `8bitgo.ejs.romBlobBroken`（3 天）：2026-11-12/13 大陆 Chrome 132 / 2GB 的《宝可梦 白 2 / 黑》
是同一台机器第 7、8 次开局，只记本页的话每次新访问都要先白失败 30～40 秒（`npm run test:chunked-fetch`）。
⚠️ **下载结果本身也可能读不出，重下要改走内存**（2026-11-15 大陆华为浏览器 17 / Android 9《拳皇 97 风云再起 Plus》两次访问 5 局）：
ROM 每局都下完，一读密文就 NotReadableError；作废续传片、不带续传整包重下后，`new Blob(网络分片)` 照样读不出 ——
坏的是这台浏览器的 Blob 存储，不是续传片。现在 `fetchBlobWithProgress` 有 `inMemoryUpTo`：整份不超过上限就留在 JS 内存
（`src/services/memoryRom.ts` 的 `memoryRomBlob` 替身，全程不建真 Blob、不写续传片、不进 romCache），超过的照常走 Blob。
街机与光盘 / NDS 两条路读不出时 `retryModeAfterBlobReadError` 记 `romBlobBroken`，≤520MB 改内存重下（大光盘仍整包重下一次）；
ROM 缓存读不出同样记它。标记有效期内第一次下载就先走内存，但上限按设备内存收着（`preemptiveMemoryRomBytes`：≤2GB 128MB、
≤4GB 或读不到 256MB）—— 坏法和大小有关（那台 2GB Chrome 的密文读得出、只是 256MB 解包结果读不出），未打包的大镜像整份进 JS 内存是净增。
内存下载的 8BG 解包时 `unpackRomPackToMemory(…, true)` 解一块放一块密文，峰值是「明文 + 一块密文」而不是两份整包
（`npm run test:memory-rom-unpack` 用真打包器在有 / 没有 WebAssembly 两种环境下核对）。读 8BG 魔数经 `readRomMagic`（8 秒上限）：
坏掉的 IDB Blob 会永不返回，以前整局停在这一步等看门狗。街机解包也换成 `unpackRomPackForEngine`，内存 ROM 交给引擎一律经 `objectUrlForEngine` 占位地址
（替身不是真 Blob，不能 `createObjectURL` / `new Blob([...])` / `stream()`）。DOS 包（`dosBundleSource.ts`）还是老的「整包重下一次」。
每个 `206` 响应也只能读这一片声明的字节量：`Content-Range` 是服务端自报，畸形响应可以宣称
8MB 却持续发送巨大流，不能把它无限攒进 `chunks` 再在末尾核对；超过后直接取消并停止重试。
旧版完整 ROM 缓存不会重走下载器，同样要在解密前查缓存 Blob 大小；8BG 还得先读文件头，
拦截 `originalSize` 超过 512MiB 的容器，不能等逐块解密完才靠卡带校验发现。
外站 ZIP 解出的完整 ROM 若缓存损坏，必须先删除再回源；命中缓存的 100% 进度也只能在验证之后报。
DOS 启动的 8BG 分块解包和 ZIP 目录校验都必须接收本局 `AbortSignal`：离页 / 换游戏时停止后续分块与目录批次读取；正在进行的 Blob `arrayBuffer()` / Web Crypto 操作无法强停，但完成后不得再派发下一块、写明文块或续报。缓存解包 / 校验遇到用户取消要原样抛出，不能误判为坏缓存后删除并重下。回归：`npm run test:dos-blob && npm run test:rompack && npm run test:roms && npm run test:dos-bundle`。

⚠️ 多语言 NDS 的即时存档不能共用游戏 slug。`ndsVariantSaveSlug` 为第一语言保留旧键（避免已有存档
无声消失），其余语言加 `~nds-<语言>`；兼容核心再加原有 `:melonds-compat`。个人页解析两层后缀
再链接回原游戏。历史无后缀存档无法推断当初属于哪种语言，所以**不能自动复制到其它语言**；
玩家若在非第一语言曾保存过旧档，应先从旧版或原档位备份；新版不提供跨语言自动导入，
带原 slug 的归档还会被身份校验拒绝，不能假装能无损迁移。此规则只隔离本站即时快照；
核心内部电池存档还由 EmulatorJS/ROM 文件名管理，不能把两者混为一谈。
第一语言是当前 `ROM_LANGS` 排序里的首个已绑定槽；后台若日后新增更靠前的语言槽，历史无后缀
存档的归属会变得不确定。此时不可自动把旧档搬给新语言，必须先核对玩家原来使用的 ROM。

⚠️ NDS 也可能通过站内通用 P2P 入口在运行中开房：`p2pPlayable()` 按平台有无 EmulatorJS core
判断，不能只因“没有专门的 NDS 无线联机 UI”就跳过开局前的 socket.io/ICE 准备。

⚠️ melonDS 的 `.opt` 不能只在 `startGame()` 前写：EmulatorJS 会在 `callMain()` 内通过
`setupCoreSettingFile` 再覆盖一次。`installNdsCoreOptionsGuard()` 必须包住这个最终回调，先保留
玩家设置，再补 `builtin` / 禁 4GB homebrew SD / 关闭布局 OSD；回归：`npm run test:nds-startup`。

音频的第一处瓶颈不是插值：旧核心默认 `melonds_audio_interpolation=None`，再关也没有收益。
EmulatorJS 写死的 `audio_latency = 64` 会让超过 64ms 的主线程短任务抽干 RWebAudio 队列，
听起来就是“一卡一卡”。`src/emulator/ndsAudio.ts` 现在给普通 NDS 128ms，明确的节奏游戏
保留 96ms 以减小输入到声音的延迟；48kHz 下核心日志的 `Buffer size` 应分别是 49152 / 36864
bytes。NDS 还用 `audioTap.ts` 的 `shared-output` 模式：RWebAudio 每个短音块只连接一次固定输出总线，
不再为录屏/直播逐音块额外接第二条音频图边；总线仍可在游戏中途接入录屏或直播。
回归：`npm run test:nds-audio && npm run test:audio-tap`。这只能吸收短时抖动；若设备持续跑不到
60fps，缓冲不能补算力，应逐游戏换轻核心。弱网大 ROM 已有真实字节时，视觉计时不得抢跑到
高百分比；见 `npm run test:load-progress`。

melonDS DS 自带 `rotate-left` / `rotate-right` 布局，优先用“双屏布局”里的原生旋转；
它会连触控坐标一起转。《节奏天国黄金版 / Rhythm Heaven》这类游戏本来就要求把 DS 横拿。不要给 canvas 套
`transform: rotate(...)`：那只转视觉，触控坐标、截图和直播都会错 90°。核心在原生旋转布局里
自己调 libretro `set_screen_rotation` 并同步触控矩阵；玩家选择按游戏持久化，切换后重新实测画布几何。
DeSmuME / DeSmuME 2015 的弱机兜底也要把 `desmume_pointer_type` 从相对坐标 `mouse` 调为
绝对坐标 `touch`；只精确改这一项，颜色、压力、摇杆死区等其它 pointer 选项不碰。

#### 2.8.4.1 NDS WFC（《使命召唤：战争世界》）仍须游戏内验收

浏览器没有原生 TCP/UDP socket；`build:melondsds` 给 Emscripten SOCKFS 的 URL 工厂传目标
IP、端口、协议和原始 socket 名，`src/emulator/ndsWfc.ts` 再交给同源 WSS 中继。libslirp 的
`POLLOUT/POLLWRNORM` 不一致也由该构建脚本补，否则 TCP 看似连上却发不出包。中继默认
`NDS_WFC_ENABLED=0`，只接受这款游戏的会话、已校验的 WFC DNS 回答里的公网 IP、同源请求与
限流；不准为了让游戏“看起来能联网”把它改成开放代理。生产 nginx 必须 include
`deploy/nginx/cs16-websocket-locations.conf` 里的 WFC Upgrade 规则；普通 `/api` HTTP 反代
不能升级 WebSocket。玩家等匹配时用 WS Ping 保活。

同一个客体 UDP socket 联系多个 GameSpy/NATNEG 目标时，后端必须用同一个公网 UDP socket；
否则源端口会变，匹配握手可能失败。复制标签页会复制 `sessionStorage`，因此分组键还要带
每页随机 instanceId，不能只靠会话令牌 + socket 编号。NAS 重复 DNS 查询只缓存已校验的 A
回答 10 分钟。回归：`npm run test:nds-wfc`，其中检查发布 `.data` 内实际包含 SOCKFS 补丁；
`server/scripts/probe-nds-wfc-live.mjs` 只验证当前配置 DNS、NAS HTTP 与 GP 挑战，**不等于进房**。

⚠️ WFC DNS 上游 UDP 1.2 秒无回应或返回 `TC=1` 时，备用解析必须是真正的 DNS-over-TCP（2 字节长度前缀）；
Node `dns.Resolver` 默认仍走 UDP，不能当成 TCP 回退。只对固定 WFC DNS IP 和 `nintendowifi.net`
查询发起 TCP 53；失败回 `SERVFAIL` 并清理待处理项，不扩大成任意 DNS 代理。
2026-10-22 生产探测：Kaeru / Wiimmfi 的 UDP 53 超时而 TCP 53 能答，`1.1.1.1` UDP 正常，主机 UFW
默认允许出站。AltWFC 官方 Wiki 仍列 `172.104.88.237` 和备用 `104.131.93.87`，但两地址当前都未确认可用：
生产机对主地址 UDP 超时 / TCP 拒绝，对备用地址 UDP、TCP 超时；本机查询两地址都只拿到 `TC=1` 空响应，
TCP 也超时。别把它们标为可用入口或仅凭旧 Wiki 扩大 DNS 白名单；官方列表见
<https://github.com/barronwaffles/dwc_network_server_emulator/wiki/List-of-Servers>，加入新入口前必须重新实测。

⚠️ 自建 WFC 入口的 53 端口若从 8bitgo 生产机不可达（2026-10-24 实测 `103.242.13.112:53` UDP/TCP 超时，
但同机 NAS HTTPS、GameSpy TCP/UDP 正常），不要继续依赖 `NDS_WFC_DNS_UPSTREAM`。设置
`NDS_WFC_DNS_STATIC_IP=<自建 WFC 入口公网 IPv4>`，服务端会只把白名单内的 WFC 域名映射到该地址，
启动时同步填好会话 DNS 快照；它优先于上游解析，不开放任意 DNS 或任意 TCP/UDP 代理。回归覆盖静态快照和
未预热的游戏专属域名。

🔴 **20100 / 61020 的真正根因（2026-10-22 线上确认）：SOCKFS 对 UDP socket 永远报可读。**
Emscripten SOCKFS `poll` 里 UDP 没有 peer，`!dest` 恒真，于是每次都返回 `POLLIN`。libslirp 一看可读就
`recvfrom`，拿到 EAGAIN 后按真实错误处理，给客体回 ICMP 端口不可达。melonDS 约每毫秒 poll 一次，
DNS 和可用性检查的 UDP socket 一直开着，所以每秒有上千个 ICMP 帧。melonDS 的接收环形缓冲只有 32KB
（`PacketDispatcher`），满了就丢最早的帧，SYN-ACK 和 TCP 数据被挤掉：
- NAS 443 一直握不上手，报 20100；
- GP 的 `\lc\1` 挑战停在 SOCKFS `recv_queue` 里没人读，登录超时，报 61020；
- conntest 总能过，因为那时还没有常驻的 UDP socket。

修法：`ndsWfc.ts` 的 `fixSockfsDgramPoll`。在第一条 socket 走 URL 工厂时，从 `Module.FS.streams`
找到 socket，把共用的 `sock_ops.poll` 包一层：UDP 队列为空时去掉可读位。**不要删掉它，
也不要以为中继提速就能代替它。** 修之前，中继、连接池和 DNS 本地表都正常（服务端日志显示上游已连上），
但客体就是不发包。排查方法：
- 包一层 `sock_ops.poll` / `recvmsg` 计数。UDP socket 的 recvmsg 次数等于 poll 次数，就是复发了；
- TCP fd 在建连之后再也没被 poll，说明客体没收到 SYN-ACK。

**自建 WFC 上游**（`NDS_WFC_DNS_UPSTREAM=<IPv4>`）：
- 设置后，中继改向这台服务器解析 `nintendowifi.net`。它答出的 IP 照常进入本局授权。
- DS 侧不用改：melonDS DS 的 WFC DNS 选项只认几个预设地址，自定义 IP 会被 RetroArch 丢掉。DS 仍向 178.62.43.212 发 DNS 查询，由浏览器本地 DNS 表和中继代答。

**上线前验收**：在生产机上跑 `python3 server/scripts/probe-wfc-server.py <IP>`，覆盖 DNS、conntest、NAS、GP、gamestats、可用性检查和 NATNEG。
- NAS 443 必须接受 SSL 3.0 / TLS 1.0 + RC4，否则必报 20100。
- 2026-10-22，103.242.13.112：35/35 通过，UDP 也通。443 由这台专用 WFC 主机上的隔离旧版 TLS 前端处理，仅接受 SSL 3.0 / TLS 1.0 与 RC4，再转发到本机 HTTP 服务；不要把这些旧协议或弱加密并入系统 Nginx。生产机（香港 cognetcloud）到 Kaeru / Wiimmfi 的 UDP 收不到任何回包，所以匹配只能靠自建服务。

⚠️ melonDS 内置固件的默认 MAC 是全员相同的 `00:09:BF:11:22:33`，联机不能让所有玩家共享
这个设备身份。`ndsWfcMacAddress()` 为当前浏览器生成并保存稳定的 `00:09:BF:xx:xx:xx`（任天堂 OUI，
与 melonDS 单机多开一致；早期版本用过非任天堂前缀 `00:08:BF`，已换代为 `nds-wfc-mac-v2`），
即使中继暂时断开也继续沿用，避免在线/离线切换时游戏内档案变号。`ndsStartup.ts` 必须在引擎
最终覆盖 `.opt` 后写入 `melonds_mac_address_mode`。**只写 `.opt` 仍是假的修复**：RetroArch
`core_option_manager.c` 会把不在核心选项值清单里的自定义 MAC 静默丢弃。因此核心构建脚本也必须
让 melonDS DS 在 `RegisterCoreOptions` 扫描 `system/8bitgo-wfc-mac.txt`，先登记这个地址；
适配器必须在 `callMain` 前写该 17 字节文件。出包测试检查发布 wasm 的文件名字符串。
只对内置固件且没有玩家自定义 MAC 时托管；玩家选择 native 固件或已有自定义地址时绝不能改。
回归：`npm run test:nds-startup && npm run test:nds-wfc`。

⚠️ **WFC 设置必须跨会话保存。** 内置固件时 melonDS DS 把 WFC 用户 ID 和连接档单独写在
`system/melonDS DS/wfcsettings.bin`（2304 字节）；网页端 system 目录在内存里，刷新即丢。丢了的后果：
每局都用新 WFC ID 去 NAS 建号，而卡带存档里记的是上一局的 GameSpy 档案，好友码每局都变，
GP 登录还可能被拒（61020 的候选原因之一）。适配器在 callMain 前按 MAC 从 localStorage 恢复，
运行中每 5 秒、退出时各抄回一次（`loadNdsWfcSettings` / `saveNdsWfcSettings`）。

中继三条硬规则（2026-10-21 复查后修正）：
- 白名单外的 DNS 查询回 `REFUSED`，**不能关 WebSocket**。客体那边的 UDP socket 还活着，关掉之后同一
  socket 后续的 NAS / GameSpy 查询全部无声丢失，表现为 20100。待处理过多、上游未就绪时同理只丢包。
- 每会话 socket 上限 48：DNS 每次查询一个 socket（slirp 10 秒才回收），且 SOCKFS 没有 shutdown，
  客体发完 FIN 的 HTTPS 连接要等服务器关；24 条在重试时会被顶满成 429。
- NATNEG 对端只按可信撮合服务器（本局 DNS 授权过的 IP）发来的 CONNECT 包授权**精确 IP:端口**，
  10 分钟有效（`natnegConnectPeer`）；CONNECT 的端口取自 QR2 心跳看到的公网端口，所以 QR2 / NATNEG /
  对战必须共用同一个中继 UDP 源端口（已按 socketId 分组）。
⚠️ **线上 20100 / 52100 的真实时序问题（2026-10-22 生产实测）。** DS 的解析器约每 2 秒换一个新 UDP
socket 重查，TCP connect 也只等约 2 秒；而浏览器每个 SOCKFS socket 都是一条新 WSS，经 Cloudflare 握手
1.5～3 秒、约四分之一直接失败，生产机到 Kaeru 的 UDP DNS 又从不回（只能走 TCP，3～9 秒）。结果是 DNS
永远在 DS 放弃之后才回来（52100），侥幸解析成功后 NAS 的 443 也连不上（20100）。现在的做法：
- 会话接口下发服务端预解析好的 WFC 名字（进程启动即预热、5 分钟刷新），并预先给该会话放行这些 IP；
  `src/emulator/ndsWfcDns.ts` 把核心对 DNS 节点:53 的 socket 换成本地应答，表里没有的才转发给中继。
- 浏览器在客体第一次查 DNS 时预热 3 条空闲中继连接（`/socket/<token>/pool/<instanceId>`），客体 connect
  时直接拿一条、用首个文本帧 bind 目标；池空时退回带握手重试的直连。
- 中继 TCP 改为先接受 WebSocket、再连上游，期间缓存客体数据；上游失败就关 WebSocket。
- ⚠️ 这些类定义在父页面、核心跑在 iframe：判断二进制必须用 `Object.prototype.toString`，
  **不能 instanceof ArrayBuffer**（跨 realm 恒为 false，曾让每个查询都被当成空包）。
在生产实测里，加了本地 DNS 后游戏已能走完 conntest → NAS 首次请求 → `cod5victoryds.available` 可用性检查，
随后卡在 NAS 登录的 443 重连上报 20100 —— 这正是连接池和“先接受再连上游”要解决的部分，部署后需复测。

排查时设 `NDS_WFC_TRACE=1`：GP（29900/29901）只记命令名，服务器 `\error\` 会带 err / errmsg，
61020 是哪一步被拒绝直接看这一行；不记 authtoken / response / 会话密钥。

2026-10-21 本地用原版欧版及用户提供的美版卡带测试，游戏到达 WFC 连接流程，登录相关 TCP
和 GameSpy 挑战可通，但曾报 61020、20100；尚未实证进入在线房间/完成匹配。GameSpy 官方
`gsAvailable.c` 在 UDP 27900 可用性探测无回复时默认继续，不能伪造“服务可用”响应掩盖登录故障。
独立 MAC 核心重建后的浏览器复测已能启动游戏并显示 WFC 菜单，但本轮自动化输入没能再触发
游戏的确认按钮；不能把此前旧构建的 61020/20100 当成新构建的最终结果。后端真实服务探针与
十轮本地回归均通过，仍不足以代替两名玩家完成实际匹配的验收。
在游戏内通过登录并进入房间以前，**不要启用生产 WFC，也不要把探针成功写成联机成功**。
另一个待验收的边界是 NATNEG：GameSpy 匹配后可能下发未曾出现在 WFC DNS 答案里的玩家公网
地址；当前中继会拒绝该目标。不能直接开放任意公网 UDP 作为“修复”，那会把公开会话接口变成
可滥用的 UDP 出口；须在真实匹配流量里确认协议，再从可信匹配服务器的响应中限时授权精确对端。

### 2.8.5 js-dos 鼠标不是一个开关：捕获方式与坐标协议必须分开

桌面端 DOS 游戏统一使用 Pointer Lock，解决鼠标撞到浏览器边缘后游戏内光标停住的问题；但
**“要不要捕获”不等于“给客体发相对坐标还是绝对坐标”**。js-dos 8 默认把两者绑在一起：
`mouseCapture=true` 后界面层固定调用 `sendMouseRelativeMotion()`。这对 Doom 一类无限转向的 FPS
是对的，却会破坏两类游戏：

- Windows 3.x / 9x 客体镜像装的是 DOSBox-X 集成鼠标驱动，要 `sendMouseMotion(0~1, 0~1)`；
  把正负位移喂给这条链会被钳成四个角，《凯撒大帝 3》就是这个症状。
- 个别原生 DOS 游戏读 INT 33h 的绝对位置（《大富翁3》），按 slug 收进 `src/emulator/dosMouse.ts`
  的兼容清单。不要按 `strategy` 标签一刀切，标签不能证明输入协议。
  ⚠️ 只读位移的游戏**不能**进这张清单：绝对桥把指针钳在 0～1，游戏光标与指针一错位（换场景时游戏
  把光标放回中央）就有一侧送不出位移、一块屏幕点不到。《主题医院》曾因 js-dos 的 SI/DI 增量 bug
  （§2.24.1 第 5 项）被误放进来，2026-11-05 修掉根因后已移回原生相对 + Pointer Lock。

修复在 `src/emulator/adapters/jsdos.ts`。Windows 客体和绝对坐标 DOS 游戏都把传给 js-dos 的
`mouseCapture` 关掉，由适配器独占 pointerdown / move / up、自己请求 Pointer Lock，并把相对位移
累积成 0～1 后送 `sendMouseMotion()`。不能再只靠“替换 ci 上的一个方法”：js-dos 的 React
effect / 输入层一改挂载时序，就可能继续从旧闭包发相对包，表面看兼容分支已命中，游戏里仍只在
四角跳。2026-10-18 又在《帝国时代》真页面抓到第二个理由：Chromium 内置浏览器拒绝上游的
`unadjustedMovement` 后继续报 `UnknownError`，每次点击都只重试捕获、一个鼠标键也不发；适配器
自己的请求不带该选项，并能在拒绝后退回未锁定的绝对坐标。

实际内容区必须用 `ci.width()/height()` 从捕获表面的 CSS 矩形扣掉黑边；直接拿播放器宽高会让
4:3 游戏永远到不了左右边缘。首次捕获按点击位置校准，但锁定后的点击不能重复校准（Pointer
Lock 下 clientX/Y 已经不是真实位置）。kiosk 桌面路径的捕获面是 canvas，Layers / 触屏路径则
可能是 `.emulator-mouse-overlay`，两种都要认；非 kiosk 还有侧栏，侧栏事件绝不能拿来校准。

锁定后的 pointerdown **只能发按键，不能再读 clientX/Y**；否则每次点击都会把游戏光标拉回
浏览器锁定点。pointerup / pointercancel 要挂在 document 捕获阶段，窗口失焦、Esc 解锁和全屏
切换也要主动放掉所有已按鼠标键——DOM 在拖出画布或失去 Pointer Lock 后不保证补发 pointerup，
漏掉就是游戏里永久拖拽。老 Safari 的 `requestPointerLock()` 还可能返回 void，不能无条件 `.then()`。

⚠️ **锁定判断看 host 内有没有锁定元素，不能要求它等于当前事件目标。** js-dos 同时有 canvas
和 `.emulator-mouse-overlay`；锁在 canvas、事件落到覆盖层时，`clientX/Y` 在 Pointer Lock 下是冻结的。
若按 `pointerLockElement === event.target` 判断，就会把每次移动当作未锁定的绝对定位，软件光标
反复跳回锁定点（《主题医院》玩家报告并用覆盖层事件复现）。相对位移要按真正的锁定元素尺寸归一化；点击也不能在
覆盖层事件里重读冻结坐标。

⚠️ **覆盖层子节点也要归属游戏输入，但 host 的其它控件不能误收。** 事件落在提示/装饰子节点时，
用 `closest('canvas, .emulator-mouse-overlay')` 找到所属画面，并用 `surface.contains(target)` 验证；
只有合成的摇杆位移（没有 DOM target）才可回退到默认画布。若把事件目标和画布强行做对象相等比较，
鼠标一移到子节点上就会静默丢掉移动与点击，软件光标停住后玩家可能误选“退出”。

⚠️ Pointer Lock 会在部分 WebView / 浏览器策略下拒绝。Windows 客体与绝对坐标 DOS 的适配器接管路径必须在
拒绝后退回未锁定的 `clientX/Y → 0～1`，不能像上游那样每次点击都只重试捕获、永远不给游戏
发送鼠标按键。拒绝发生得快时要补发第一次点击；既不 resolve 也不报错的 WebView 用 750ms
兜底，避免第一下永久丢失。成功锁定时第一下仍只负责 capture，之后的点击才给游戏，保持原有
交互语义；普通 / 全屏切换后允许重新探测一次，因为部分 WebView 只在原生全屏放行 Pointer Lock。

普通相对鼠标与绝对桥的钩子都必须返回清理函数。`ci-ready` 在后端重连时可能再次到达；不清理
就会把 Y 轴反转包两层，结果看起来像开关失效。回归：`npm run test:dos-load`。

`scripts/copy-jsdos.mjs` 还会裁掉上游重复的灵敏度侧栏、黑色捕获蒙版和提示文字；普通相对鼠标的
`requestPointerLock()` 仍直接绑在 canvas 点击上，Windows / 绝对坐标分支则由适配器接管。改这段补丁后要运行 `npm run jsdos`，并让
`scripts/check-jsdos.mjs` 同时确认三块 UI 都已移除，不能只看运行时版本号。上游还会无条件调用
`navigator.keyboard.lock()`；iframe / WebView 拒绝时必须吃掉 Promise rejection，否则控制台会有
一个和鼠标捕获失败极像的全局 `InvalidStateError`，排查时很容易误判成 Pointer Lock 又坏了。

### 2.8.6 Win95 老 DirectDraw 游戏：客体桌面与游戏分辨率必须一致

《凯撒大帝 3》不是 ROM 损坏，也不是再调鼠标灵敏度就能好：游戏包里的 `CAESAR3/c3.inf`
把 `resolutionId`（偏移 16 的 little-endian int32）存成 3 = 1024×768，而共享 Win95 镜像和
DOSBox-X 帧缓冲是 800×600。原版 DirectDraw 把画面缩进客体桌面时，软件光标的绘制位置与
按钮命中坐标用了不同缩放比例，所以越往右下偏得越远；典型症状是光标还在输入框上方，
下面的 Continue 已经 hover。游戏内按 F8（800×600）后同一位置立即正常，就是这条的判据。

启动前由 `src/emulator/windowsGameCompatibility.ts` 把 `resolutionId` 改成 2，作为同路径 extra
与后台附加文件**一次性**合并进游戏层；不要在游戏启动后靠固定延时模拟 F8（片头长短和慢设备
会让按键时序漂移），也不要做一组写死的鼠标比例补偿（玩家按 F7/F8/F9 后会立刻再次失准）。
设置档必须是原版 560 字节且编号在 1～3，格式不对就明确报错，不猜。回归：
`npm run test:dos-bundle`。

《主题医院》不是这条：它是原生 DOS，局内 640×480，鼠标问题的根因是 js-dos 回调给错 SI/DI
（§2.24.1 第 5 项），不套 Win95 或 Caesar 的分辨率补丁。注意它的**主菜单（教授 + 骷髅图）是
320×200**，不是 640×480（见 §2.8.6.0）。主菜单图标（悬停提示实测）：手形 =「开始新游戏」，
右侧靶心 =「读入进度」，下方 =「开始网络游戏」；主菜单按 Esc 直接退出到 DOS。

### 2.8.6.0 DOS 画面按 4:3 显示（js-dos `renderAspect`）

DOS / Win3.x / Win9x 的画面是给 4:3 显像管看的，320×200、640×400、720×400（文本）这些模式的
像素本来就不是方的。js-dos 默认 `renderAspect: 'AsIs'` 按帧缓冲像素比例显示，于是绝大多数
VGA 游戏被横向拉宽 20%（文本模式 35%）。2026-11-05《主题医院》实测：320×200 的教授主菜单被放成
761×476（1.6:1）。现在 `adapters/jsdos.ts` 统一传 `renderAspect: JSDOS_RENDER_ASPECT`（'4/3'）；
640×480 / 800×600 / 1024×768 本来就是 4:3，不受影响。

js-dos 的 `$a()` 是把 **canvas 元素本身** 缩成该比例、帧缓冲拉伸铺满，所以：
- 绝对坐标桥的 `contentRect` 以 canvas 的矩形为准、按 4:3 求内容区（覆盖层事件也换算到 canvas），
  **不能**再用 `ci.width()/height()` 的像素比例扣黑边——那会把 4:3 画布里的 320×200 误算成
  16:10 内容，上下各丢 10% 可点区域；
- 截图 `imageDataToBlob(..., displayAspect)` 按 4:3 最近邻放大输出（320×200 → 320×240），
  与玩家看到的一致；录像仍是 canvas 原始像素（多数播放器会按容器显示，未改）。
移动端 DOS 的播放器框本来就是 `aspect-[4/3]`（`screenAspect.ts`），两者一致。回归：`test:dos-load`。


### 2.8.6.1 《天之痕》：标题页正常不等于 DirectInput 正常

《天之痕》只有点“开始游戏”后才创建 DirectInput 独占设备。原
`Windows95_Traditional-Chinese.jsdos` 把 Win95 标准鼠标换成了 DOSBox-X 集成驱动
（`SYSTEM.INI` 的 `dboxmpi.drv`），因此标题页和软件光标都正常，进入新局才弹 DirectInput
错误，随后 `Swd3e` 非法操作退出。验收必须点进角色姓名界面，停在标题页不算通过。

第一版修正版 `Windows95_Traditional-Chinese-DirectInput-v1.jsdos` 只把系统盘鼠标恢复为
`mouse.drv` + `*vmouse, msmouse.vxd`，并在 bundle 配置里使用 `mouse_emulation=locked`、
`integration device=false`。它是版本化新对象，不准覆盖原路径；浏览器会按 URL/ETag 缓存系统盘，
原地覆盖会让老访客继续拿到坏镜像。播放器里的 `needsRelativeWindowsGuestMouse()` 还必须让
这款游戏绕开 Windows 绝对坐标桥，交回 js-dos 相对鼠标链；只换镜像不换协议会变成“游戏能进，
但光标不动”。回归：`npm run test:dos-load && npm run test:system-source`。

⚠️ 这款 ROM 是原生繁体 Big5，不要再改成 CP936。第一版镜像虽能到标题页，进入新游戏仍会
弹 DirectInput 错误或非法操作：Win95 自带的旧 DirectX 不够，必须完整安装繁体
DirectX 7.0a。46.5MB 的 `Windows95_Traditional-Chinese-DirectX7a-Minimal-v1.jsdos`
保留作回退。当前《天之痕》使用 `Windows95_Traditional-Chinese-DirectX7a-UltraLite-v2.jsdos`
（29,670,830 字节）：保留繁中代码页、明体字库、原生鼠标链和 DX7 运行库；裁去帮助、安装资料、
备用注册表、工具及不使用的字体，按 FAT 表归零空闲簇后再封装。这是针对本游戏验收的系统盘，
其他 Win95 游戏需要单独验证，不能把它当通用系统镜像。
验收必须依次走过标题页 →「起」→ 姓名框 → 片头 → 第一段对白，并确认繁体中文可读；
只停在标题菜单仍然不算通过。

### 2.8.7 大型 DOS / Win95/98 游戏走静态 Sockdrive，不是视频直播

`games.dos_sockdrive` 填一款游戏的**静态 Sockdrive 目录**（对象 key、站内路径或完整 URL）；
目录根必须直接有 `sockdrive.metaj`、`*.raw`，产物按 js-dos 官方 `sockify` 流程生成：
<https://js-dos.com/publish-sockdrive-bundle.html>。Windows 客体保留共享 `dos_system` 作为系统盘，
游戏盘用 `imgmount <序号> sockdrive <URL>` 按扇区读取；纯 DOS 游戏不需要伪装成 Windows 客体：
`dos_system` 留空、后端仍选 DOSBox-X，播放器把 Sockdrive 直接挂成 C: 并运行盘内 EXE。普通 DOSBox
不支持 Sockdrive。纯 DOS 入口必须是 DOS 8.3 路径（如 `FALLOUT.EXE` 或 `GAME/RUN.EXE`），因为远程
块设备不能再靠宿主目录二次挂载长路径。`rom / roms` 那份完整 ZIP 仍留在数据里作一键回退，
但流式模式不会下载它。清空 `dos_sockdrive` 就原样回到旧整包路径，不需要迁移存量游戏。

纯 DOS 流式游戏不能从 `C:\\>` 直接输入 `D:\\GAME.EXE`：EXE 虽能打开，DOS/4GW stub 与游戏
相对资源仍按当前目录 `C:\\` 查找，Fallout 会报 `dos4gw.exe No such file or directory`。自动启动必须
先输入 `D:`，有子目录时再 `cd \\目录`，最后只输入 EXE 文件名；回归由 `test:dos-bundle` 覆盖。

⚠️ **纯 DOS 也必须有一块可启动系统盘。** `sockify` 从普通游戏 ZIP 生成的是 FAT 游戏盘，
`imgmount 2 sockdrive ...` 只把它注册成 BIOS 硬盘；DOSBox-X 内置 DOS 随后执行 `c:` 会明确报
`Drive C does not exist`。`imgmount c sockdrive` 同样不会把 Sockdrive 变成内置 DOS 的 FAT 盘。
未配置 `dos_system` 的流式 DOS 游戏因此由适配器自动叠加 10MB 的
`system-dos7.1-v1.jsdos`：系统盘占硬盘 2 / C:，游戏盘占硬盘 3 / D:，`boot c:` 后再由
`scheduleDosGuestLaunch` 在真实 DOS 提示符输入 `D:\\<EXE>`。不要再恢复“纯 DOS 不需要系统镜像”
那条分支；官方 Sockdrive 示例里的 `imgmount 2` 后面紧跟 `boot c:`，前提就是磁盘本身可启动。

⚠️ 目录必须带版本（如 `sockdrives/caesar3-v1`）且**不可原地覆盖**：浏览器会按完整 URL 把磁盘块
长期缓存在 OPFS，原地换内容会把两代扇区拼在一起。若 `sockify -b/-g`，R2 / Worker 必须分别给
`.raw` **和 `sockdrive.metaj`** 发正确的 `Content-Encoding: br/gzip`（官方工具连元数据也压缩）；
公开域名还要允许 8bitgo.com 跨域读取。完整公开 URL 去掉协议后不得超过 200 字符：js-dos 8.4.1
会把更长的 OPFS 目录名截断，版本号落在截断位置后时仍会撞进旧磁盘缓存。
发布前后统一走 `npm run sockdrive:upload -- --src <磁盘目录> --bucket <桶> --prefix
sockdrives/<游戏>-v1 --encoding br`：脚本会核对所有必需分块、先传数据再传元数据，并默认拒绝覆盖
公开域名上已经存在的版本目录；预检网络失败也会直接停止，不提供强制覆盖开关。按官方首次运行
优化得到的 `preload_ranges.metaj` 是**独立文件**，不在 `sockdrive.metaj` 里；把它放到同一磁盘目录，
上传脚本会按相同 br/gzip 编码校验并发布。上游原本想在漏传时退回转换期默认清单，但本站 R2
Worker 的 404 正文是合法 JSON，它反而会把错误对象当数组并在挂盘时崩溃。
适配器因此在外置清单缺失、读取失败或内容无效时强制用 `none` 绕开上游二次探测，同时仍按主清单完成
预算内预热；发布器继续把外置清单当一等产物校验，正式版本不应依赖这条兼容兜底。

播放器会在共享系统镜像下载期间读取这份独立热点清单，并把真正会用到的 `.raw` 送入 HTTP 缓存：
桌面 / 4G 与 3G 最多 8MB；热点清单超过 64 项时开局前只等最先触达的 8 个对象（Fallout 为约 2MB），
短清单仍最多预热 32 个对象；其余由客体按需读取。2G 与省流量模式只做一个真实热点的 HEAD 探活；
与 Win95 系统盘同时下载时正文最多两路，纯 DOS 没有大文件竞争时用四路。预热只流式计数，不能把即将丢弃的热点再
拼成完整 ArrayBuffer；否则 8MB 预算会额外制造约 16MB 峰值和一次主线程复制。每个热点正文都按
元数据校验解码后长度，缺块或截断要在
DOSBox-X 启动前明确报错，不能继续留给客体黑屏。加载错误还必须锁成终态：迟到的 `ci-ready`、
自启动回调或兜底定时器都不得在 `onError` 之后再发 `onReady`。回归统一放在 `npm run test:dos-load`。

热点预热有总启动时限：纯 DOS 桌面 / 4G 最多 20 秒、3G 最多 30 秒；与 Windows 系统镜像并行时分别最多 30 / 45 秒。
到时中止仍在进行的热点请求、传 `sockdrivePreload: 'none'`，让客体从 HTTP 缓存复用已完成的块并按需读取其余块；不能只用
「25 秒无字节」看门狗，因为持续滴流会不断续期并让开局无限等待。玩家离页仍立即取消，不得伪装成预热超时。

流式盘不能再由浏览器现场合并 `dos_extras` 或 `windowsGameCompatibilityExtras`：那块盘已经变成
远程只读扇区，补丁必须在 `sockify` **之前**写进去。尤其《凯撒大帝 3》的 `c3.inf` 分辨率补丁
必须烘进磁盘，否则 §2.8.6 的鼠标偏移会回来。后台和服务端都拒绝“Sockdrive + dos_extras”，
避免配置看似保存成功、玩家却永远读不到补丁。

js-dos 的静态 Sockdrive 会把写过的扇区单独固化，播放器因此给纯 DOS 与 Windows 流式盘开放
保存进度。⚠️ 保存**不能**走 `props.save()`：js-dos 的 `Li()` 只要配置里出现 `.qcow2` 就把 `canSave`
置 false，而我们的流式盘一定带 qcow2（Win95 系统盘或 DOS 7.1 启动盘），2026-10-26 以前《辐射》点
保存永远是“这一刻取不到存档”。适配器改为直接调 `ci.persistSockdrives()` 只取 Sockdrive 扇区差异
（实测《辐射》开局后 823 字节，URL 为规范化后的 Sockdrive 目录），经同一个存储钩子写入；开机时
js-dos 仍经 `fsChanges.pull` 交回，worker 按非 ZIP 层识别成 `sockdriveChanges[url]` 回放。不要改用
`persist(true)`：没有扇区改动时它会退回把整个文件系统（含被写过的 qcow2）打成 ZIP。
存档固定使用 js-dos 存档槽 1，和旧普通 DOS / 整包模式的槽 0 隔离，存档键还带规范化
Sockdrive URL 的指纹。**换 v2 目录会自动开一份新存档**：旧扇区差异不能套到新基础盘，否则可能
破坏文件系统；旧存档会保留，但不要自动迁移。播放器先按网络预算把热点送入 HTTP 缓存：
清单涉及的对象已全部预热时传 `sockdrivePreload: 'default'`，让官方 runtime 把缓存字节搬进
OPFS；预算只覆盖部分热点时传 `none`，否则 js-dos 会无视 8MB / 省流量上限，再以四路
并发把整份外置热点清单拉完，反而和客体真正的读盘抢带宽。这里的 `none` 不是取消预热——预算内
热点已在 HTTP 缓存，剩余块回到按需读取；发布前仍必须采集并上传完整 `preload_ranges.metaj`。
这里不能直接用
`dosboxConf + initFs` 启动：js-dos 8.4.1 会把 changes URL 留空，保存按钮看似存在却永远失败；
适配器用极小 URL bundle 建立 changes key，再让最后一层真实配置接管启动。回归：
`npm run test:dos-backend && npm run test:roms && npm run test:dos-load`。

2026-10-19 《天之痕》线上热点清单是 27 个 256KB 块（约 6.75MB）：原来的 3G 4MB 预算只装进
16 块，js-dos 因而关闭 OPFS 全量预载，剧情一开始还要等剩余 11 次网络。3G 上限改为 8MB，
但省流量 / 2G 仍不拉正文，且会跳过可选热点清单请求。已全量预热的会话里，`scripts/copy-jsdos.mjs`
还给 Sockdrive 运行时加了限量的顺序预读：连续读到两个新块后，在启动当前前台块请求的同一时刻
低优先级试读下一块，让两次网络等待重叠；真实请求会复用这最多 256KB 的结果；3G 每局上限 4MB，
其他网络 8MB，不完整热点清单与省流量会话禁用。
改这段补丁后必须更新 `JSDOS_ASSET_VERSION` 并跑 `npm run jsdos`，否则浏览器仍拿旧运行时。

整包 Windows 客体的游戏存档另走**文件差异检查点**，不能把 `ci.persist(true)` 原样存起来：它可能
把 qcow2 系统盘和 Windows 用户目录一并带入差异包。`jsdos.ts` 只保留 ZIP 差异中的 `GAME/` 条目，
按路径合并增量（新版本覆盖同名文件、保留没有再次改写的存档槽），使用存档槽 2，并以游戏 ZIP
中央目录的 CRC/长度指纹隔离游戏版本；系统镜像改动不会上传或回放。运行时每 60 秒做一次本地检查点，
切后台、离页和销毁会话时再补一次；选择云存档时本地检查点进入已有待同步流程。它仍是“游戏先在盘上
写出存档，再做检查点”，不是内存快照。适用于游戏将存档写在安装目录（客体中的 `GAME` 盘）的情况；
Windows 注册表、桌面、AppData / 用户目录不纳入。ZIP 差异格式没有删除标记，所以旧槽位文件被游戏删除时
不会自动从历史检查点移除；需要严格镜像删除语义的游戏应改用 Sockdrive 扇区差异。回归：
`npm run test:windows-guest-save && npm run test:dos-load`。

### 2.8.8 StarCraft 这类超大 Windows 包必须在下载前拦截

线上 `starcraft.en.zip.8bg` 的密文约 1.42GB，文件头声明解开后约 1.49GB；而 js-dos 的旧入口
`loadGameBytes → unpackRomPack → makeWindowsGameLayer` 需要连续 `ArrayBuffer`，并且明确拒绝 1GB
以上的原文。旧行为因此不是“弱网慢”，而是**下载完 1.42GB 后必然失败**，还可能在失败前先把
标签页内存耗尽。

`src/services/romPack.ts` 的 `inspectRemoteRomPack()` 只 Range 读取前 64KB（文件头更大时才补第二次），
`jsdos.ts` 在 Windows 客体整包模式开局前用它检查原文大小；超过连续内存上限立即停止，并明确要求
配置 Sockdrive。若对象源忽略 Range 回 200，预检必须立刻 cancel 响应体，不能把“预检”变成另一条
整包下载。回归：`npm run test:starcraft-weak-network`。

详情页还会在年龄接口旁边投机预拉播放器本体。省流量、2G/3G、低于 3Mbps 或 RTT 高于 300ms 时，
`preloadPolicy.ts` 会跳过这份数百 KB 的预拉，让几十字节的年龄结论和页面交互先完成；网络提示缺失时
维持旧行为，避免没有 Network Information API 的 Safari 全部失去预热。

这只是止损，不是让超大包重新可玩。真正发布仍按 §2.8.7：先把游戏盘制成版本化 Sockdrive、上传
`sockdrive.metaj` / `*.raw` / `preload_ranges.metaj`，再给 `games.dos_sockdrive` 绑定该目录。没有三类
产物就不要填一个猜出来的路径；元数据 404 会让所有玩家在开局前直接失败。

StarCraft 已补一条离线发布流水线：`npm run sockdrive:prepare -- --source <原始ZIP> --slug starcraft
--version v1 --exe StarCraft.exe --work-dir <目录> --cli <官方cli>`。它在 Linux 上用
`virt-make-fs` 生成带 MBR 的 VFAT/QCOW2 游戏盘，再调官方 `sockify`；加 `--publish --bucket <桶>
--bind` 会在 R2 公开校验通过后才更新游戏。绑定令牌只认环境变量 `EIGHTBITGO_ADMIN_JWT`，不收命令行
参数，避免落进 shell 历史。上传成功、绑定失败时只重跑 `npm run sockdrive:bind`，不准覆盖原目录。
完整操作见 `docs/starcraft-sockdrive.md`，回归并入 `npm run test:dos-sockdrive-upload`。

当前英文原版包只允许官方 `StarCraft.exe`；`Brood.exe` / `brood-c.exe` / `brood.dll` 是旧整合包的
第三方启动链，不能再拿来做自启动程序。包根还必须带 `STAR.REG`，播放器会在完整包和 Sockdrive
两条路径的 `RUN.BAT` 里先用 `regedit /s` 静默写入 `InstallPath` / `StarCD`，再启动主程序。
`starcraft` / `starcraft-1-16-1` 默认把 `[cpu] core` 设为已完成 Win95 实机验证的 `normal`；后台
显式 CPU 配置仍可覆盖。回归：`npm run test:dos-bundle && npm run test:roms`。

生产后台现在把这条离线流水线包成了**持久任务**：编辑已保存的 DOSBox-X 游戏，在「原始大 ZIP
自动转 Sockdrive」上传原始 ZIP。多语言「完整包 + 流式盘」只从浏览器上传一次：先写入公开完整回退包，
ROM Worker 再用 `If-Match` 对照上传响应的强 ETag，在 R2 内流式复制到私有 `sockdrive-staging/`；
不把 1GB 以上 ZIP 再从管理员网络上行一遍，也不把正文读进 Worker 内存。只有新 Worker `/ping`
声明 `sockdriveSourceCopy` 时才走该路径；旧 Worker 保留原来的私有分片上传兼容路径。单独生成流式盘仍由浏览器
直接分片写进私有 staging，不经过 Express 内存。`sockdrive_conversion_jobs` 记录 ETag、原配置和发布阶段，生产机从
`SOCKDRIVE_CONVERT_TMP_DIR`（应挂独立大盘）下载后自动制盘、上传、公开校验，再用事务 CAS 同时绑定
`dos_sockdrive` 与 `dos_executable`。页面关闭或服务重启都不丢任务；失败源保留 24 小时供后台重试。
staging ZIP 下载使用固定 1MB 背压缓冲，让网络读取与磁盘写入重叠；不能退回“每个网络小块 await 一次
随机位置写入”，1GB 以上源包会产生数万次串行等待。整个过程仍须核对 ETag、Content-Length、实际
字节数、60 秒停滞与 ZIP 文件头，优化不能改成把源包整块读进内存。
`sockdrive.metaj` 仍必须最后上传，它既是玩家入口也是发布提交点；重启后看见它才可跳过发布，若只有本地制作完成标记则复用磁盘输出并继续上传。
分片创建携带稳定 requestId（浏览器保存在续传账本，CHD 用任务 ID，Sockdrive 发布器按目标 key 与输出元数据计算），遇到响应丢失时会找回原 multipart 会话；不要对无幂等键的 `?uploads` 做网络重试。
requestId 标记写入必须用 R2 `onlyIf: { etagDoesNotMatch: '*' }` 原子抢占：多个标签页同时恢复时，输家先中止自己的会话，再读取并复用赢家；不能只做 `head()` 后无条件 `put()`。若 R2 条件冲突后暂时读不到赢家标记，只能在确认输家已中止后用同一 requestId 重试。完成请求也要带 `requestId + requestSignature + size`；最终对象保留创建时的请求 ID 与元数据签名，第二个标签页遇到已被赢家消耗的 uploadId，只能在 HEAD 确认这三项吻合时复用成功，不能误报失败或仅凭同名 / 同大小认成功。
制盘中断会删掉半份 work 目录并保留已下载 ZIP，发布 / 校验中断会保留完整 `publish/` 和制作配置标记；重试可直接恢复上传，不重复解包、造盘和 Brotli 压缩。失败 24 小时后的 staging 清理也负责回收这些本地断点，完成任务若在进程清理前崩溃也会由定时清扫回收。
远端 staging 删除、数据库状态落库和本地目录清理是三个独立步骤：只有 R2 DELETE 未确认才把 `source_deleted` 退回 0；R2 已删除但 DB 写入失败时保留 2，让下轮以 404 幂等重试补记 1。状态 2 必须绕过 `updated_at < 24h` 筛选，否则清扫器自己的 claim 会更新 `updated_at`，进程重启后任务会再卡一天。清本地目录失败也不能把远端源谎报成仍可重试。
转换任务仍保持单并发，但发布器默认以 `SOCKDRIVE_UPLOAD_CONCURRENCY=6` 隐藏小文件的 R2 往返，
压缩前小文件扫描最多 16 路并行；后台直接复用压缩阶段的文件数和输出字节统计，不再重复扫描发布目录。
默认 Brotli 质量为 5，优先缩短制盘时间；更低质量可能增大分块体积，按存储与网络预算设置 `SOCKDRIVE_BROTLI_QUALITY`。
管理员重选同一 ZIP 时用头 / 中 / 尾样本摘要找回 staging key 和版本号，接着传未完成的 multipart；版本号还带随机尾码，防止同毫秒的两个标签页写入同一目录。
兼容旧制盘输出时的兜底扫描同样最多 16 路；解码校验最多四路、大文件 multipart 最多三片并行。
自动队列会传 `--defer-validation`，因为紧随其后的
发布器已经做完整解码校验；禁止在制盘和发布两步各校验一次，把整张 2GB 盘白白解压两遍。只制作、
不发布的离线命令仍必须在交付前完成一次全量校验。
Worker 必须把 `psp-staging/` / `sockdrive-staging/` 的 GET/HEAD 也设为 Bearer 私有，并保留上传请求的
`Content-Encoding`。手工命令仍作为故障兜底，不是日常上传步骤。回归：
`npm run test:sockdrive-conversion && npm run test:dos-sockdrive-upload && npm --prefix worker test`。

多语言 DOS / Windows 游戏的流式盘按 **ROM 语言槽**绑定：`game_roms.dos_sockdrive` 经 API 映射为
`dosSockdrives`，播放器以最终选中的 ROM 语言取同槽 Sockdrive；旧的 `games.dos_sockdrive` 只在
完全没有逐语言配置时作历史数据回退，迁移一旦开始，缺配置的语言宁可走完整包也不跨语言误挂。
后台已保存游戏的语言 ROM 按钮会显示「完整包 + 流式盘」：一次选择原始 ZIP 并上传一次，
先发布同语言的 8BG 完整回退包，再由 R2 桶内复制准备私有转换源（旧 Worker 会回退为第二次上传）；任务最终用
事务 CAS 同时绑定 `object_key`、`dos_executable` 和 `dos_sockdrive`。版本目录必须带语言（如
`sockdrives/starcraft-zh-v1730000000000123456`），否则多个语言会争用不可覆盖的目录。运行环境、EXE 或
当前流式盘地址有未保存修改时必须先保存，不能让管理员传完大包才在建任务阶段发现数据库不一致。

⚠️ 官方 Sockdrive CLI 2.0.10 **不接受任意磁盘容量**，只按原始镜像字节数匹配两份内置描述：
252,370,944 字节（FAT16-256MB）或 2,147,483,648 字节（FAT32-2GB）。曾经给 `virt-make-fs`
传 `--size=+<空闲空间>`，生成 17,065,984 字节的真实 QCOW2 后，前面的文件检查全过、最后才被
`sockify` 拒绝。现在 `selectSockdriveDiskTemplate()` 会在解包/制盘前选择精确模板并为 FAT 元数据
留余量；默认只留 128MB 写空间，原始 ZIP 上限 1900MB。调大服务器硬盘不会突破 2GB 格式上限；
上游增加新模板时必须先更新常量和真实转换冒烟测试，不能只放宽上传限制。

### 2.9 平台 BIOS 的边缘缓存会骗人

后台改完 BIOS 绑定只调 `invalidateContent()`（清进程内缓存），**够不着 Cloudflare 边缘**。
症状：后台明明配好了，前台还报缺 BIOS，刷新清缓存都没用。
已把 `/api/platform-bios` 的缓存降到 30 秒（`server/src/cache.js` 的 `CACHE.bios`）。
**部署后仍建议在 Cloudflare 控制台 Purge Everything 一次。**

### 2.10 数据库缺表不会让服务起不来，只会让**某一条接口**莫名 500

`server/src/schema-check.js` 启动时查全部 v2 表并点名。缺表补法一律：

```bash
cd server && npm run migrate      # 幂等
```

**加迁移时三处要同步**（2026-11-15 起构建会拦）：`migrate.mjs` 负责给已有库补表补列，`schema-v2.sql` 只管新库，
`schema-check.js` 的 `EXPECTED_TABLES` / `EXPECTED_COLUMNS` 负责启动提醒。`server/scripts/check-schema-drift.mjs`
在 prebuild 里静态对账：期望的表 / 列迁移补不上、或迁移补了却没登记，构建直接失败。确实不该查的（代码不读写的表）
写进它的 `TABLE_ALLOWLIST` / `COLUMN_ALLOWLIST` 并注明原因。回归：`cd server && npm run test:schema-drift`。

### 2.11 Flash 大游戏是多 SWF 的，不能只传主文件

当年的游戏在运行时用**相对路径**拉同目录的其它 swf（`loadMovie('main21.swf')`）。
只传一个 swf 的话，Ruffle 会去 `roms/flash/` 根目录找它 → 404。
后台选 `.zip` 走整包上传，文件落在 `roms/flash/<slug>[.<lang>]/` 下，相对路径才对得上。
**别图省事把缺的 swf 单独补到 `roms/flash/` 根目录**——那是所有 Flash 游戏共用的目录，迟早撞名。

### 2.12 大文件必须分片；不要把平台上限或无响应写死成一个原因

曾有 100MB 单发上传报「网络错误：无法连接 Worker」且 Worker 没有日志；这说明请求可能在 Worker 前被拒绝，不能单凭 `onerror` 断定是 CORS、Worker 故障或超限。
**截至 2026-11-25，Cloudflare 文档列出的站点请求体上限是** Free / Pro 100 MB、Business 200 MB、Enterprise 可自行调到 5 GB；超过配置上限时文档规定返回 413。中间网络重置仍可能表现为 XHR `onerror`，但需要结合状态码、请求字节数和 Worker 日志诊断。[Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

现在超过 24MB（`MULTIPART_THRESHOLD`）的文件自动改走**分片上传**：
8MB 一片，首片既是真数据也是上行测速，按实际 Mbps、RTT、省流量模式与设备内存选择 1–4 路；
单片失败重试、`localStorage` 记账后可断点续传（`src/services/romMultipart.ts`）。创建 multipart 前先保存稳定 `requestId`，Worker 用它在响应丢失后找回同一会话；普通 ROM 上传和 CHD 发布都不能对有副作用的会话创建请求盲目重发。
小型 Worker 控制请求也必须有覆盖「响应头 + JSON 正文」的总超时并接收页面取消信号；创建请求只可用稳定 `requestId` 安全重试，完成响应不确定时仍须保留专门的冲突核验流程，不能盲目重发。
HTTP/2 reset、429 或网关 5xx
会立即收敛到单路，连续成功后才逐档恢复到本次测速上限；
不要把它改成四路固定并发，否则一次连接级错误会再次变成重试风暴。
XHR 的 `progress` 事件按字节差值维护总量，并限到约 12fps 再通知 React；不要恢复成每个事件遍历全部分片
并立即 `setState`，大 ISO 在 3–4 路上传时会用 UI 统计反过来堵住主线程与网络回调。
上限是按**单个请求**算的，所以分片把每次请求限制在安全范围，也让失败只需重传当前片。三个必须记住的约束：

⚠️ 浏览器控制台若同时出现多个 `PUT ... net::ERR_HTTP2_PROTOCOL_ERROR`，通常不是 ISO 或 uploadId
损坏，而是共用同一 HTTP/2 连接的分片被边缘/中间网络一起重置。不能让每个 XHR 在几百毫秒后
各自并发重试：那会在刚重建的连接上再次制造失败风暴。上传器现在遇到 `status=0`、429 或网关 5xx
会把全局闸门收敛到单路，之后每连续四片成功才恢复一档；单片最多试 5 次并用 1.5～12 秒退避。已经完成的分片和
本地账本原样保留，管理员重新选择同一文件时仍从断点继续，不准为了这个错误更换 `PART_SIZE`。

生产 R2 桶 `8bitgo` 已启用 **Local Uploads**：上传对象会先写入客户端附近的区域，再由 Cloudflare
异步复制到桶的主区域。它是桶配置，不在 `wrangler.toml`；排查时用
`npx wrangler r2 bucket local-uploads get 8bitgo`，不要误以为重新部署 Worker 会自动恢复这个开关。
Local Uploads 只优化写入，不优化下载；玩家读取继续依赖 Anycast、版本化 URL、Worker Cache API、
Range 边缘分片缓存，以及 `fetchBlobWithProgress()` 用首个真实分片选择下载并发。

大 ROM 完整下载固定用 8MB 对齐 Range：普通网络首片用 256KiB 实际字节估速；明确弱网（Network Information API 报 3G、
下行低于 1.5Mbps，或 RTT ≥800ms 且下行低于 3Mbps / 未知）改用 128KiB，避免在慢线路上等太久才比较另一域；超过 3Mbps 且并发可用时，
提前启动后续完整 Range，避免整片串行下完才开始并发；其余分片再按吞吐、RTT、省流量模式与设备内存
选择 1–4 路。ROM 至少 512KiB 且非 2G / 省流量时，首段低于 3Mbps 才比较另一域的同 ROM 对齐首片，
备用实测速率高 15% 才放弃未完成首片并换域；2G / 省流量模式不因测速额外耗流量。
测速与线路回退写入诊断包，成功的实际下载线路短时覆盖小探针结论 5 分钟。
浏览器没有 Network Information API 时仍以真实吞吐为准，不能永远卡在三路。
断点分片写 IndexedDB 与下一片网络传输重叠，但写盘积压最多两笔；进度按每路字节差值累计，禁止在
每个底层 stream chunk 上展开全部请求重新求和。完整 Blob 到手后，临时分片删除留在后台，不能让
几十到几百次 IDB delete 挡在模拟器启动前。回归：`npm run test:chunked-fetch`。

⚠️ **明确弱网要提前比较 ROM 线路**（2026-11-15，大陆 Chrome 132 / Windows，《泡泡龙 4》）：现场 0.45Mbps / RTT 1100ms，
固定 256KiB 首段花了 7.9 秒才开始测备用域，随后再花约 1.2 秒比较；切线后 ROM 到 20 秒时已下完 6.5/6.7MB，
仍被记为慢启动。改为弱网提示下 128KiB 即开始测速，普通网络保留 256KiB；备用域仍必须实测快 15% 才切，
并发继续按真实吞吐与弱网提示收敛。若后续现场的 Network Information API 不可用，仍用完整 256KiB 实测，不凭空猜带宽。

Worker 的 Range Cache 覆盖整个版本化 `/roms/<平台>/…`：完整下载型平台缓存 8MB 块；PSP、PS2、
GameCube、Wii 的按需读盘缓存 2MB 块。只有带真实 R2 ETag `romv`、严格对齐且响应长度 / ETag /
Content-Range 全部吻合的公开请求才可入边缘缓存；任意短 Range、未版本化或条件不一致仍直达 R2。
不要再把规则缩回某几个扩展名，否则 NDS / PS1 / DOS 和流式光盘会让每位玩家重复穿透存储。
卡片预览视频 `videos/*.mp4|webm` 没有版本号、播放器只发 Range（2026-11-16 实测大陆首字节 16 秒、无边缘缓存）：
Worker 按封面同一条 s-maxage=600 缓存整份 200，Range 命中时在 Worker 里切片，未命中照常回 R2 并后台填一份；
超过 32MB 或带 `Content-Encoding` / 条件头的不缓存。回归在 `worker/tests/rom.test.mjs` 的 preview video 两节。
切片是**流式**的（`sliceStream`）：不准退回 `hit.arrayBuffer()`，每个 Range 都把 32MB 读进内存，几路并发就撞 128MB 隔离上限。
取消 tee 出来的缓存正文**不能 await**（另一支没结束时 cancel 永不落定，请求会挂住）。
浏览器这一侧（`src/components/game/GameCover.tsx` 的 `CoverVideo`，2026-11-20）：桌面端预览视频的自动拉流要等页面 `load`
之后、浏览器第一次空闲（`whenPageSettled`，rIC 最晚 3 秒放行），而且只在网络明显宽裕时做（复用 `preloadPolicy.ts` 的
`allowsSpeculativePlayerPreload`：省流量、非 4G、低于 3Mbps、RTT 超过 300ms 都不自动拉）。首页实测两段预览共 3.5MB 在水合后
3.3 秒就开始下载，和 32 张封面抢带宽，最后一张封面拖到 11.9 秒。悬停播放不受限制；移动端仍只显示 poster。回归：`npm run test:seo-performance`。

⚠️ **Worker 内存与浏览器缓存的四条规矩（2026-11-16）**：
- 整份 200 写边缘缓存只收 ≤64MB 且有 Content-Length 的对象（`EDGE_FULL_PUT_MAX_BYTES`）。`response.clone()` 的两支速度不同，
  差额攒在 Worker 内存里，慢速玩家拉大文件会把隔离撑爆；大文件本来就走 8MB Range 分片缓存。
- `ALLOWED_ORIGINS=*` 时**不发 `Vary: Origin`**：响应与来源无关，带上它会让浏览器把 fetch 预热（带 Origin）和
  `<img>` / 引擎请求（不带）存成两份，同一份 ROM / 封面下两遍。按来源白名单反射时才发。
- 缺失封面负缓存 60 秒（缩略图回退要依次找 4 个位置），管理员补传后最多晚 60 秒生效。
- 下载域名的明文转发：等响应头最多 30 秒，超时回 504；源站的 `Set-Cookie` 一律剥掉。

⚠️ **网络层失败要多熬一会儿，并且能换线路**（2026-11-10 墨西哥玩家《合金弹头 3》两次「Failed to fetch」，
第二次 8.4 秒就放弃）。`fetchBlobWithProgress` 对 fetch 抛出的 TypeError 按 `NETWORK_RETRIES`（5 次，
0.5～8 秒退避，约 15 秒）重试，其它错误仍是 3 次；调用方显式传 `retries` 时两者都按传入值。
一条 CDN 线路首片实际吞吐低于 3Mbps 时，先测另一域同 ROM 的 64KiB 样本；备用实测速率至少快 15%，
或当前线路重试用光后，才用 `alternateUrl`
（`romHosts.ts` 的 `alternateRomUrl`：assets ↔ cn-assets）整套再来一次，只换一次；两边是同一个 R2 对象
和同一个 romv，断点分片按 canonical 的 resumeKey 续。成功的实际线路短时记 5 分钟，覆盖小探针结论。
RangeError（超大小上限）和用户取消不换线路。街机、光盘 / NDS、MAME CHD、DOS 包、通用 ROM 加载都已接上。
回归：`npm run test:chunked-fetch` 第八节。

⚠️ **ROM 线路记分板 + 多线路分片（2026-11-18《西游释厄传》）**：rom.8bitgo.com 的 HEAD 等满 4 秒超时才轮到
download.8bitgo.com（0.17 秒）；首段测速把握手和约 1 秒首字节算进吞吐，Chrome 又报 effectiveType=3g（实测单连接 9.5Mbps），
并发被压成 1 路，21.9MB 三片串行约 20 秒。现在：
- `src/services/romRouteHealth.ts` 按 origin 记**响应头之后**的正文吞吐（EWMA，≥64KiB 样本，30 分钟）与网络 / 超时 / 5xx / 失速故障；
  连续 2 次熔断 1～5 分钟（5 秒内同一批请求一起失败只算一次），成功即恢复。熔断只排到最后、不删候选。404 不算线路的错。HEAD、BIOS（`reachableRomAssetUrl`）、
  `chooseRomHost`（有真实数据时不跑 64KB 探针）、下载器、PSP / Dolphin / PS2 的光盘候选都读同一份排序。
- HEAD 存在性检查（`roms.ts` 的 `hedgedProbe`）：1 秒没答复或答不上来就同时问下一条；原地址的 404 是终论，备用线路的 404 要等其余线路答完。
- `fetchBlobWithProgress`：吞吐从响应头算起；有真实样本时 effectiveType=3g 不再强制单路。**只有路径与查询串（含 romv）完全相同**的线路
  （`sameObjectRoutes`）才混着取分片：按「吞吐 ÷ 在途数」分到各线路，响应头 2.5 秒（≥6×RTT、≥3×本局中位）没到就在另一条线路发同一 Range；
  若前两条仍无响应头，每过一个同样的窗口再试下一条，最多三路，避免两条线路静默挂起后等满整局看门狗。赢家回响应头后立刻中止输家；
  只有已经超过自身响应头等待窗口的输家才记为失速，避免刚启动的备用线路被误熔断。失败片换线重试，空出来的一路对最慢的片做尾部对冲（先完的落盘、另一路中止，每片一次）。首片期间提前开的分片也走池子，能被对冲。
  不带 romv 绝不混片；省流量 / 2G 不对冲。注入 `fetchImpl` 的测试默认 `routeHealth: false`，保持固定请求顺序。
- 浏览器实测（同一 ROM、同一网络）：19.4 秒 → 6.8 秒。回归：`npm run test:rom-route-health && npm run test:chunked-fetch`。

1. R2 要求**除最后一片外所有片等大**、最小 5MB、最多 10000 片 —— 改 `PART_SIZE` 会让旧的续传记录作废；续传还校验文件名、字节数、修改时间和头/中/尾内容指纹，防止把同名的另一份文件拼进旧分片
2. binding **没有 `listParts`**：complete 时必须把每片的 `{partNumber, etag}` 全报回去，所以这份账只能记在前端 —— **换浏览器就续不上**
3. binding 也**没有 `listMultipartUploads`**：没合并的分片在 R2 默认 7 天自动中止之前仍占用存储；自定义生命周期可能改变期限。Worker 在 `_uploads/` 下写标记对象，后台「ROM 存储」页靠它列出并清理残留；R2 自动中止后标记对象仍需手动清理

⚠️ **后台的 Worker 口令自动填（2026-11-22）**：管理员把提示里的占位词「ADMIN_TOKEN」原样填进口令框，所有上传 401。
现在登录后台（`site:manage`）时 `AdminLayout` 调 `ensureRomCredential()`（`src/services/romUploadCredential.ts`），
向 `GET /api/admin/rom-upload-credential` 领一张 12 小时的 HMAC 凭据（`8bg1.<过期秒>.<随机>.<签名>`，
`server/src/rom-upload-credential.js` 签发），存 sessionStorage `8bitgo.rom.credential`，剩不到 3 小时续签。
Worker 的 `authorizedAsync` 先比 ADMIN_TOKEN，再用同一把 `ROM_UPLOAD_SIGNING_SECRET` 校验凭据（过期时间超过 13 小时一律拒绝）。
这把密钥**两边必须一致**：Worker 用 `wrangler secret put ROM_UPLOAD_SIGNING_SECRET`，源站写 `server/.env`；任一边没配，
后台退回手填（服务端回 503，页面提示）。手填口令仍优先，占位词「ADMIN_TOKEN」会被当成没填。
服务端自己的转换任务（PSP / Sockdrive）仍用 `PSP_CONVERT_WORKER_TOKEN` / ADMIN_TOKEN，**那里必须是真实值**——
2026-11-22 生产 `.env` 里它写的也是字面量 `ADMIN_TOKEN`，转换任务读 staging 全 401。回归：`worker/tests/upload-credential.test.mjs`。

改 `worker/` 下任何源码后跑 `npm run test:worker`（内存版 R2 mock，不联网；分片只是其中一部分）。
改了 `worker/src/` **还要**跑 `npm --prefix worker run build:standalone` 重建单文件包 ——
`worker/tests/standalone.test.mjs` 会逐字节比对模块化实现和那份 bundle，忘了重建它就会红。
（2026-09-20：旧的 `scripts/test-worker-multipart.mjs` 测的是重写前的接口形状，已删除。）

### 2.13 验证码不能放进程内存

登录 / 换绑邮箱 / 注销账号三处都要发一封 6 位验证码，逻辑统一在 `server/src/codes.js`。

早先的实现是一个模块级 `Map`。踩过的坑：`pm2 restart` 会把所有待验证的码清空 ——
用户刚收到信、回来填，得到的是「验证码已过期，请重新获取」，而服务器日志一切正常；
多开实例时发码和验码不在同一个进程，登录随机失败一半。

现在落 `login_codes` 表，主键 `(email, purpose)`，**存 sha256(email + purpose + code) 不存明文**
（一次 mysqldump 就是所有人的账号，包括管理员）。表还没建时自动退回内存版并打一行
`[codes] login_codes 表不存在` —— 看到那行就 `cd server && npm run migrate`。

换绑 / 注销的码额外绑 `user_id`：不绑的话，A 拿自己那封「换绑到 x@y」的码，
就能去把 B 的账号也换绑成 x@y。

### 2.14 JWT 收不回来，靠 `users.token_version` 作废

「退出所有设备」、改完密码踢掉旧会话、换绑邮箱后让别处重新登录 —— 这三件事都没法靠删 token 实现，
服务端手里没有已签发令牌的名单。做法是令牌 payload 里带 `tv`，和 `users.token_version` 对不上就 401
（`server/src/auth.js`）。想作废所有旧令牌就把那一列 +1，同时给当前设备换一张新的
（`routes/me.js` 的 `rotateToken`）。

⚠️ **前端拿到新令牌必须存下来**，否则用户会被自己的操作踢下线 —— `src/services/auth.ts`
的 `acceptSession()` 就是干这个的，新增这类接口时别忘了走它。
老令牌没有 `tv`，按 0 处理，所以这套东西上线时不会把所有人踢下线。

注册必须先验邮箱（`/register/request-code` → `/register` 带 code，2026-11-17）。之前不验邮箱的带密码老号，
`users.email_verified_at` 是 NULL：主人第一次用验证码 / Google / Microsoft / Apple 登录时（`findOrCreateByEmail` →
`markEmailVerified`），清掉那份来历不明的密码并 token_version +1。代价是迁移前「验证码登录后自设密码」的老用户要重设一次密码。
**别在迁移里把老行批量标成已验证**，那会把抢注者的密码洗白；迁移只回填「库里能证明验过」的两类：没有密码的行
（只能由验证码 / 第三方建出、也只能这样登录），和 `created_at >= EMAIL_VERIFIED_BACKFILL_SINCE`（默认 2026-11-19，
比 e161dfa 晚两天，因为生产首次部署它的时刻没有记录；查到后可改成部署次日）建的行 —— 不回填的话注册验码上线后正常注册的人
会被当成抢注号静默丢密码。真清了密码时登录响应带 `passwordReset: true`（Microsoft / Apple 回调是 `#…&pwreset=1`），
前端 `notePasswordReset` 提示本人去「账号与安全」重设。部署要 `cd server && npm run migrate`。

开机 `hydrateAuth` 只在服务端**明确拒绝**令牌时（401，或带 JSON error 的 403）才清令牌；断网、超时、5xx、CDN 的 HTML 403
都保留令牌和缓存的用户，网络恢复或按 15s / 60s / 5min 再问。以前任何错误都清，一次部署 502 就把所有打开页面的人登出。

### 2.14.1 Google 登录的客户端 ID 只配服务端一份；游戏框里的第三方 Google 登录必然 403（2026-11-20）

- **本站 Google 按钮**：前端以前只认构建期 `VITE_GOOGLE_CLIENT_ID`，它从没进过 `.env.production`（§2.1 同类坑）。
  服务端 `GOOGLE_CLIENT_ID` 早就配好，线上按钮却一直报「管理员尚未配置」，Vite 还把整段 GIS 代码当死代码删了。
  现在前端没有构建期值时向 `GET /api/auth/google/config` 要（公开值，5 分钟缓存，不像 Google 客户端 ID 的值回 null），
  服务端 `.env` 的 `GOOGLE_CLIENT_ID` 是唯一来源。Google Cloud Console 里这个客户端的「已获授权的 JavaScript 来源」
  必须有 `https://8bitgo.com` 和 `https://cn.8bitgo.com`，否则 `accounts.google.com/gsi/status` 回 403、One Tap 不弹。
- 登录窗口一打开就用 `renderGoogleButton()` 画 Google **官方按钮**（`renderButton`，FedCM 按钮模式，不支持的浏览器 GIS 自己退回弹窗），
  独占一行（官方按钮最窄 200px）。只靠 One Tap `prompt()` 不行：浏览器里没登 Google、或关过 One Tap 进了冷却期，Google 根本不弹。
  画不出来（没配客户端 ID、大陆网络加载不到 GIS（10 秒上限）、PSP / 塞班隔离页的 COEP 挡住 accounts.google.com）时
  原来的按钮留着、点它走 One Tap；`prompt()` 必须接时刻通知（按 `getMomentType()` 分流），否则按钮永远停在「处理中」。
  GIS 的 `initialize` 整页只调一次，凭证交给栈顶那一方（One Tap 进行中归它，否则归官方按钮），别再各自 initialize。
  隐私政策「你主动触发才会发生的」一节写明了打开登录窗口就会从 Google 加载按钮，改加载时机要同步三种语言。
- **游戏框里的「用 Google 登录」**（《Pokecatch》玩家报的 403）：第三方 HTML5 游戏把**自己的框**跳到
  accounts.google.com，Google 对 `Sec-Fetch-Dest: iframe` 一律回 403（顶层 200，curl 可复现）；Discord 授权页
  发 `frame-ancestors 'none'`。父页面拦不住跨源框架的导航，也修不了。详情页按入口主机名提示玩家去新标签页登录，
  登记表在 `src/emulator/html5EmbedLogin.ts`。
- **Pokecatch 直接外开**：该游戏已登记在 `shared/builtin-web-games.js`，`externalLaunchUrl` 固定为
  `https://pokecatch-online.netlify.app/#`。详情页显示启动卡；用户点「开始游戏」才在新标签页直开游戏顶层页面，
  让 Google / Discord 登录不再经过 iframe。这个入口不挂 EmulatorPlayer，也不预加载播放器 chunk。
  游戏方账号与 8BitGo 云存档是两套系统；详情页的存档同步链接提供手动导入 / 导出，不承诺游戏登录能写入 8BitGo 云档。
- 回归：`npm run test:google-login && npm run test:html5-embed-login && cd server && npm run test:oauth`。

### 2.14.2 PokeCatch 的存档只能由游戏页显式交接（2026-11-20）

《Pokecatch》当前进度在游戏自己的 `localStorage` 键 `gachamon-save-v1`；登录游戏账号不等于把这份进度同步到 8BitGo。
主站详情页现在在新标签页打开游戏顶层页面，避开 Google / Discord 的 iframe 限制。`/pokecatch-save-sync` 提供 JSON / 书签手动导入导出；存档桥扩展可从游戏顶层标签页直接读取或写回这一个键，也兼容仍在运行的旧内嵌游戏框：
扩展只在精确的游戏域名读写 `gachamon-save-v1`，恢复前将旧值备份到 `8bitgo.pokecatch.backup.v1`。它不读取游戏的其它存储或账号凭证；云存档 API 仍由已登录的 8BitGo 页面调用，坐标为 `html5 / pokecatch / slot 0`。

Chrome / Edge 桌面使用目录内的 MV3 `manifest.json`；Firefox Android 使用 `manifest.firefox-android.json`，因为 Android 版不支持后台 Service Worker，也未实现 `webNavigation.getAllFrames()`，后者由 `scripting.executeScript({allFrames:true})` 配合精确主机自检替代。Safari 使用 `manifest.safari.json`：静态内容脚本只匹配游戏主机并以 `all_frames` 进入页面，主世界访问该页自己的 localStorage，隔离脚本通过扩展消息接收读写请求；不要依赖 Safari 不支持的 `scripting.executeScript` frameId / allFrames 参数。`content_scripts.world: "MAIN"` 从 macOS Safari 18.4 / iOS Safari 18 起支持。Safari 自动同步需要 Apple 包装的 macOS / iOS app 和签名，目前仓库只生成 Safari Web Extension Packager ZIP，未签名、未提交 TestFlight / App Store，也未在 Safari 设备验证；Safari 玩家暂用书签 JSON 手动迁移。Safari 用户还需允许扩展访问两个 8BitGo 域名及游戏源站。Firefox Android 正式版须先经 Mozilla 签名；兼容包尚未在实体 Android 设备验证。Android Chrome 不支持安装 Chrome 扩展，可用书签和 JSON 文件手动迁移。桌面和移动浏览器都需要安装扩展并登录同一个 8BitGo 账号；云端已有不同进度时必须确认覆盖。

回归：`node --experimental-strip-types --import ./scripts/helpers/ts-register.mjs scripts/test-pokecatch-cloud-save.mjs`、`node scripts/test-pokecatch-save-bridge-extension.mjs`、`npm run test:pokecatch-safari-bridge`；并跑 `npm run test:save-envelope`、`npm run test:save-sync`。不得读取或上传游戏的其它 localStorage 键（尤其认证信息），也不要把这一通用第三方域名加入存档桥允许列表。

### 2.15 `saves` 表以前只在 v1 的 schema 里

`schema.sql`（v1）有它，`schema-v2.sql` 漏了。按 v2 建的新库压根没有这张表，
症状是站点一切正常、后台看不出任何异常，**只有玩家点「云端存档」那一刻 `/api/saves` 全部 500**。
已经补进 `schema-v2.sql` 和 `scripts/migrate.mjs`，`schema-check.js` 也会在启动时点名。

同类问题的通用判据：`server/src/routes/` 里查了某张表的接口，去 `schema-v2.sql` 里 grep 一遍表名。

### 2.16 房主国旗全是 ❓ ＝ 反代没传真实 IP

房间卡片上房主的设备 💻📱 / 地区 🇨🇳 / 网络 👌🀄️👎 三个格子由 `server/src/presence.js`
从 **socket 握手信息**里推断：设备看 `User-Agent`，地区拿 IP 查离线库
（`@ip-location-db/geo-whois-asn-country-mmdb`，CC0，不需要 MaxMind 那种许可证密钥），
网络看 socket.io 心跳的往返时间。

三样都不接受客户端上报 —— 一是联机房间的 socket 客户端是 EmulatorJS 自带的、我们改不动，
二是客户端说了算的话挂个 VPN 报个 🇯🇵 就是一行代码的事，这三个格子的意义就没了。
唯一例外是云端房间的 RTT（那条路没有常驻连接，只能收浏览器自己测的数，服务端会钳范围）。

**踩点在这里**：nginx 的 `location /socket.io/` 里少一行
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`，后端看到的每个人都是
`127.0.0.1`，国旗全站永远是 ❓ —— **而且不会报任何错**，日志干干净净，只是「就是不显示」。
`/api/` 那个 location 同理（云端房间走它）。配好之后 `TRUST_PROXY` 保持默认的 `loopback`。

取的是 XFF 的**最后一段**：`$proxy_add_x_forwarded_for` 把 nginx 亲眼看到的对端追加在末尾，
前面几段是客户端自己带来的，谁都能 `curl -H 'X-Forwarded-For: 1.1.1.1'` 伪造。
（`playcount.js` 里取的是第一段 —— 那边只是计数，将就了；这里是要显示给所有人看的。）

⚠️ **但站点在 Cloudflare 后面时，上面这条整个反过来**：nginx 看到的对端就是 CF 的 anycast 节点，
最后一段变成 CF 的地址，真实访客在前面那一段。2026-09-07 线上实测中招（`/api/diag` 的
`effective: 104.22.100.106` 而 `cf-connecting-ip: 34.162.230.222`）。后果**全都不报错**：
每 IP 房间上限 / 限流从「按人」塌缩成「按 CF 机房共用」，国旗全站显示同一个国家
（`resolveCountry` 先用 IP，查到了就不再看那份正确的 `CF-IPCountry`）。
修法是每个 location 都换成 `proxy_set_header X-Forwarded-For $http_cf_connecting_ip;`，
**并把源站防火墙锁到 Cloudflare 的 IP 段** —— 不锁的话这个头能被直连源站的人伪造，
而原来那套「取最后一段」恰恰不怕伪造。代码里**故意不改成信这个头**（那等于默认开个伪造口子），
只做自查：`presence.js` 告警一次 + `/api/diag` 的 `usingCdnEdgeIp` / `hint`。
详见 `deploy/live/README.md` 的「在 Cloudflare 后面的话」。

自测：`cd server && npm run test:presence`（40 项，不联网、不用数据库）。

### 2.17 游戏简介的按需翻译：一个 JSON 列，不是八列

游戏简介的**存储模型从建站起就是「一个基准 + 一个译文」**，不是八种语言各开一列：

| 列 | 语言 | 谁填 |
|---|---|---|
| `description` | 中文（站点母语，基准） | 后台 |
| `description_en` | 英文 | 后台 |
| `description_i18n` | **JSON，其余六种按需缓存** | 玩家点「翻译」按钮时写入 |

后台上传游戏时只填英文和中文，西班牙语访客看到的是英文（见 `services/i18nData.ts` 的
`gameDescription`：英文优先于中文，因为「看英文也好过看中文」）。想看母语就点详情页
「游戏简介」右上角那个「翻译」按钮 → `POST /api/games/:slug/translate-description` →
按 MyMemory → Lingva → 火山的顺序翻一次 → 写进 `description_i18n[lang]` → **之后所有人都是读库，
不再调接口**。

⚠️ **为什么是 JSON 列而不是 `description_es` / `description_fr` 各一列**：八列里有六列
99% 的游戏永远是 NULL，而 schema 注释里早就定过「一个基准 + 一个译文」这条线（就是为了避免
每加一种语言就 ALTER 一次表）。JSON 列加语言不用改库，键名直接就是站点语言代码。

⚠️ **改基准必须清缓存**。`description` / `description_en` 一改，所有语言的译文都失去锚点 ——
否则玩家看到的是「后台改过简介、但翻译缓存里还是旧的」。`upsertGame` 无条件清、`patchGame`
在请求里带了这两个字段时清（见 `server/src/games-repo.js`）。**新增写路径时别忘了这一条。**

⚠️ 火山语言映射在 `server/src/translate.js` 的 `VOLC_LANG`：官方支持 `zh-Hant`；简体中文源文
到繁体仍优先走本地 OpenCC，英文源文则按目标语言调用翻译服务。

⚠️ **AK/SK 放 `server/.env`，永远不进 git**（§2.1）。火山翻译默认有 2,000,000 字符额度；
`server/src/translation-usage.js` 在 `site_settings.translation.volc.used_chars` 持久化累计预留量，
每次发火山请求前用原子更新预留，避免多实例并发超额。请求失败也保留预留量，按源文 Unicode 码点
计数，采取保守口径；计数行损坏或数据库不可用时也停止调用火山。

实际请求顺序固定为 **MyMemory → Lingva → 火山**：先把整批文本交给 MyMemory，单段按 UTF-8 字节
切在 450 bytes 以内，并用 `MYMEMORY_EMAIL=yeahcore@yeah.net` 作为 `de` 联系邮箱；MyMemory
不可用、限额或返回空译文时，整批改试 Lingva REST v1（默认 `https://lingva.ml`），不是把同一批
部分结果混在一起。两个公共接口都失败后才调用火山；没有 AK/SK 时返回包含两边错误的诊断信息。
公共 API 地址可用 `MYMEMORY_API_URL` / `LINGVA_BASE_URL` 覆盖；源文会发送给对应的外部公共翻译服务。
繁体语言码分别映射到 MyMemory `zh-TW` 与 Lingva `zh-TW`。
首次用量基线可用 `VOLC_TRANSLATE_INITIAL_USED_CHARS` 导入火山控制台已有用量，**需在首次真实翻译前**
设置；后台只读用量不会提前创建计数行。额度由 `VOLC_TRANSLATE_CHAR_LIMIT` 配置，默认 2000000。

自测：`cd server && npm run test:translate`（含字符计数、MyMemory / Lingva 优先级、火山额度保护与本地 mock）。
端到端：
```bash
curl -X POST http://127.0.0.1:8788/api/games/<slug>/translate-description \
     -H 'Content-Type: application/json' -d '{"lang":"es"}'
# 第一次 cached:false（调到可用的上游并落库），第二次 cached:true（读库，不再调）
```

### 2.17.1 文章（post）的按需翻译：和游戏同一个套路，但正文是 Markdown

文章系统的存储模型和游戏是**同一哲学、不同形状**——也是「基准 + JSON 译文缓存」，但文章
**没有英文基准列**（post 从建站起就只有母语 `excerpt` / `content`，没出过多语言版）：

| 列 | 内容 | 写入方 |
|---|---|---|
| `excerpt` | 中文（基准） | 后台 |
| `content` | 中文（基准，Markdown 正文） | 后台 |
| `excerpt_i18n` | **JSON，七种语言按需缓存**（zh-Hans 除外，见下） | 玩家点「翻译」按钮时写入 |
| `content_i18n` | **JSON，同上** | 同上 |

⚠️ **文章没有 `en` 基准，所以 en 界面也要翻译按钮。** 游戏因为 `description_en` 存在，`en`
界面直接显示英文、不需要翻译（`needsTranslation` 对 `en` 返回 false）；文章没有英文版，`en`
界面看到的是中文原文，所以 `needsPostTranslation` 对 `en` **返回 true**（把中文翻成英文）。
只有 `zh-Hans`（基准就是中文）不显示按钮。这是文章和游戏唯一的逻辑差异，前端在
`services/i18nData.ts` 的 `needsPostTranslation` / `postExcerpt` / `postContent` 里。

⚠️ **正文按段落分块翻译，不是整篇一把梭。** 游戏简介就一段，一次 `TranslateText` 搞定；
文章正文长（一篇博客 30–50KB 很常见），一次性灌给火山的 `TextList` 会被单条字符上限挡回。
`server/src/translate.js` 的 `translateMarkdown(text, source, target)` 按双换行（Markdown 段落
分隔符，且**保留**分隔符以维持段落结构）切块，每段单独翻译、内部限并发 3（免费版火山约 5 QPS，
留 2 个余量给其他翻译请求），最后拼回去。段落里的 Markdown 标记（`##`、列表、`**加粗**`、`代码`、
链接）原样交给火山，大多数情况它会保留——**接受偶尔的不完美**，比自写规则化解析便宜得多。

⚠️ **单段失败 = 整篇失败。** `translateMarkdown` 里任一段 throw，整篇翻译失败、路由回 502、
前端显示「翻译失败」让用户重试。这是有意的——避免「半篇译文 + 半篇原文」混着更迷惑。
（excerpt 和 content 两个字段之间**独立**成功/失败：接口会尽量返回已翻好的部分，前端提示
`partial`。）

⚠️ **改 excerpt / content 必须清缓存**，和游戏同一条铁律。文章只有 PUT（没有 PATCH），整体
覆盖就直接在事务里 `UPDATE posts SET excerpt_i18n = NULL, content_i18n = NULL`（见
`server/src/routes/posts.js` 的 PUT handler）——文章不存在「只改某个字段」的路径，无条件清即可。

⚠️ **`POST /api/posts/:slug/translate` 必须注册在 `GET /:slug` 之前**。Express 按声明顺序
匹配，`/blog/<slug>/translate` 这个 URL 一旦被 `GET /:slug` 吃掉就 404 了。路由文件里这条
`post` 路由特意放在所有 `:slug` 路由之前，新增路由时注意顺序。

端到端（先确认 `.env` 配了 AK/SK）：
```bash
curl -X POST http://127.0.0.1:8788/api/posts/<slug>/translate \
     -H 'Content-Type: application/json' -d '{"lang":"es"}'
# { lang: "es", excerpt: "...", content: "...(Markdown)", cached: false, partial: false }
# 第二次 cached:true（读库，不再调火山）
```

### 2.18 外链 ROM 要按语言配备用源，健康检查只能在浏览器做

`game_roms.backup_key` 是该行 `object_key` 的同语言备用地址，API 上对应
`romBackups[lang]`。播放器顺序是「当前语言主地址 → 当前语言备用地址 → 其它语言」，
所以 DOS 切到备用源后仍使用原语言槽的 BAT / EXE 入口。

网络超时 / CORS 失败以前会立刻停止整条候选链，因为同一源站继续探没有意义；现在只有紧跟着的
同语言备用地址可以越过这道停止线。备用也无法确认时仍停止，避免用户自己断网时把八种语言全等一遍。

后台“检测主/备”由管理员浏览器直接发 HEAD / Range GET。**不要改成服务端代请求任意 URL**，
否则后台可填写的外链会变成 SSRF 入口。浏览器报告“无法确认（网络或 CORS）”不等于文件必定不存在，
但玩家浏览器同样无法跨域读取时通常也不能运行。

部署这版先跑：

```bash
cd server && npm run migrate     # 增加 game_roms.backup_key，幂等
```

### 2.19 PS2 只能从独立隔离页启动，ISO 必须支持 HTTP Range

PS2 使用 Play! 官方 Web 构建，`public/play/Play.js` 和 `Play.wasm` 是**同一批产物**，连同
`runtime.json` 的长度 / SHA-256 与上游许可证一起提交。`npm run test:play` 和 prebuild 会校验；
升级时两个文件必须一起换并更新 manifest，不能只覆盖其中一个。
玩家实际收到的字节也要验：`Play.js` 先以 `modulepreload` + SRI 放进页面 module map，验证失败 / 超时
不能继续对同一 URL 做无校验的 `import()`；`Play.wasm` 在交给 Emscripten 前核对精确长度与 SHA-256，
EdgeOne 响应坏了可退回同源，但同源也必须通过相同摘要。核心验签失败时取消并行 ROM / 光盘请求，
不要让进度条继续等待大 ROM。更新运行时后同步 `src/emulator/playIntegrity.ts`、`runtime.json`，
并运行 `npm run test:play-integrity` 与 `node scripts/check-play.mjs`。

官方构建固定启用 pthread / SharedArrayBuffer，所以游戏详情页不直接挂模拟器，而是整页跳到
`/play/ps2/:slug`。Express 与 Vite 开发服务器只给这条顶层文档发 COOP / COEP；改成 SPA
内部跳转或 iframe 后，响应头不会生效，运行时会在 worker 初始化阶段崩掉。

PS2 光盘通常数 GB，播放器通过 `src/emulator/remoteDisc.ts` 按 2MB 块发送 Range 请求，不能
整份下载。后台直接上传 `.iso` / `.chd` / `.cso`，不要再包一层 ZIP；外链至少要正确响应
`Range: bytes=0-0`，返回 206、`Content-Range` 和真实总大小。当前 R2 Worker 已支持这些头。
Play.js 的模块请求与第一次 Range 探测并行；正式顺序读取维持后两块（共 4MB）滚动预取，缓存太小时
自动缩窗，不能让投机块把马上要用的块挤掉。版本化的本站光盘块还会进入上面的 2MB 边缘缓存。

Play! 浏览器版仍是实验性支持：90 秒内没有产生首帧就提示该镜像可能不兼容。不要为了让某个
商业游戏通过而查找或分发 ROM；只测试站长有权使用的备份、自制程序或开源镜像。

### 2.20 新 ROM 以明文发布；旧 8BG 容器继续兼容

从 2026-11-16 起，后台新上传的 ROM 直接保存成原始对象 key；站内浏览器播放器优先从 `rom.8bitgo.com` 读取明文。
开放平台拿到明文 ROM 后会在校验短期凭据后 302 到 `download.8bitgo.com`，文件正文不经应用服务器；浏览器播放器也优先探明文，
旧 8BG 仅作回退。旧对象需要逐步用明文重新上传，才会享有同一条直链；**不要因此删除解包能力或密钥**，
线上仍有旧 8BG 绑定，云联机同步和 `delivery=plain` 的旧包转码也继续依赖它。

历史 8BG 格式按 8MB 原文分块，每块 **Zstd 19 + AES-256-GCM**（已压缩文件只加密），对象名为
`<原 key>.8bg`。文件头保存原文件名、codec、codecVersion、keyId 和每块 SHA-256；播放器解包后仍把 `.zip` / `.nes` / `.nds` 等原名交给核心。
Zstd 解码前还必须核对 frame 自报的 content size 与分块表完全一致；只在解压后比大小挡不住
恶意 frame 先诱导 WASM 申请几十 GB 内存。校验在 `assertZstdFrameContentSize()`，不要绕过。

旧包维护工具 `packRomForUpload()` 不是单 Worker 串行：按逻辑 CPU、设备内存和真实分块数启动 1–4 个
Worker，并行完成 Zstd、SHA-256 与 AES-GCM；每个 Worker 同时只持有一块，低内存设备自动降到 1–2 路。
SHA-256 会在同步 Zstd 前先提交给 Web Crypto，以便和压缩重叠；`store` 路径不得再复制一份 8MB 原文。
并行结果必须按原块号组装，AAD / IV 与现有 v1 容器完全一致，不能为了提速改格式导致旧播放器失兼容。
网络失败后，页面内存会保留最近一份打包结果；管理员重选同名、同大小、同 mtime 的源文件时，必须先
逐块核对原文 SHA-256，完全一致才复用原密文。这样 multipart 的 uploadId 与已上传分片才能真正续上；
若重新随机生成 packageId / IV，表面是“同一个 ROM”，实际密文已变，旧分片绝不能混用。上传确认成功后
立即释放这个缓存，且只留单槽，避免后台长期占住 GB 级 Blob。

旧包使用自己的版本化容器，而不是直接存 `.zst` 或 `.7z`：维护 codec 时切 LZMA2 只需在
`scripts/pack-rom.mjs`、`scripts/unpack-rom.mjs`、`src/workers/romPackWorker.ts` 和 `src/services/romPack.ts` 的 codec
分发表增加实现。文件头会写 `codec: lzma2`，现有 `codec: zstd` 的包继续读取；数据库只存对象
key，所以**不用改表，也不用同一晚重压整个库**。不要把默认 codec 变成“旧包也按新算法解”。

历史 8BG 包的密钥根放 `server/.env` 的 `ROM_PACK_SECRET`（至少 32 字节）。轮换时保留旧密钥：
`ROM_PACK_KEY_ID=v2` + `ROM_PACK_SECRET_V1` + `ROM_PACK_SECRET_V2`。匿名试玩意味着浏览器最终会拿到
单包数据密钥；这层历史加密不能当作 DRM，也不再用于后台新上传。

旧 ROM URL 完全兼容；数据库绑定 `a.zip` 时先探明文 `a.zip`，再回退同目录 `a.zip.8bg`；没有数据库绑定的游戏也先探
`<slug>.<ext>`，再探历史 8BG 文件。重传旧槽时新对象 key 应是明文原名，8BG 留作兼容回退直至确认后清理。
cloud-game 的 libretro 不认识 8BG；`deploy/cloudgame/sync-roms.sh` 会先在隔离暂存目录解密，
全部成功后才替换 `games/`。云联机机的 `.env` 必须保留同一套 `ROM_PACK_SECRET[_Vn]`，
否则同步应失败并继续使用上一份游戏库，不能把密文直接交给核心。
历史 8BG 的本地打包与解包工具仍保留，用于兼容校验和云联机同步：

```bash
npm run rompack -- ./game.nes             # 输出 ./game.nes.8bg
npm run romunpack -- ./game.nes.8bg       # 服务器侧流式还原（cloud-game 同步也走它）
npm run test:rompack                       # Zstd 19 / AES-GCM / 摘要 / 原文件名
```

### 2.21 Flash 游戏内部在线槽和 Ruffle 快照是两套存档

`/api/saves` 保存的是 Ruffle SharedObject 整体快照；`/api/flash-saves/v1` 是给老游戏原本依赖的
第三方 API SWF 用的。两套格式不能共表，也不能互相覆盖。第一款接入的是 `infectonator-2`：Ruffle
用 `urlRewriteRules` 把失效的 Armor Games AGI 地址改到
`public/flash-api/armor-games/AGI.swf`，桥源码在 `flash-api/armor-games/`。

这个游戏会先后提交 `profileonlineN` 和 `dataonlineN`。桥必须凑齐两半后调用一次 `write-slot`，
服务端再用一行记录原子覆盖；读取时绝不能暴露半份槽。真实读取方法签名是
`retrieveUserData(callback, key = null)`，callback 在前，别按常见写法调换。

完整登录 JWT 不能进入 SWF。父页面先用它换一张由独立 `FLASH_SAVE_SECRET` 签名、绑定用户和游戏的
短期令牌，再通过 FlashVars 传入。这个密钥至少 32 字符且不能与 `JWT_SECRET` 相同；允许的游戏 slug
放在 `FLASH_SAVE_GAMES`。FlashVars 里的桥、API 和头像地址必须是绝对 URL，因为远程 ROM 的 `base`
可能指向 R2，把 `/api/...` 误解到资源域名。

兼容桥有**两代、接口互不兼容**，是两个独立产物，不能互相顶替：

| | AGI1 | AGI2 |
|---|---|---|
| 接入游戏 | `infectonator-2` | `kingdom-rush-frontiers` |
| 桥 / 源码 | `AGI.swf` / `MainTimeline.as` | `AGI2.swf` / `KrfAgiBridge.as` |
| 风格 | 方法式，profile + data 成对提交，键 `profileonlineN`/`dataonlineN` | 对象式，一次 `key→value`，键 `slot1..3` |
| 存储 | `flash_save_slots` | `flash_save_kv` |

「哪款游戏用哪套方言、加载哪个桥」只有一份，写在 `shared/flash-save-games.js`（前后端共用）；
漏改一处或自己再抄一份的后果是「桥能加载、也能连上，就是读不到档」，且不报错。
AGI1 的 `gameKey` 也配在同一条目的 `agiGameKey`，页面通过 FlashVars 下发；
别再往 `MainTimeline.as` 里加新游戏硬编码。

未登录时，桥只在玩家**主动**用在线槽或点登录时通过 `ExternalInterface`
通知页面打开全站登录框；AGI2 开局自动 `retrieve` 不弹，否则一进游戏就拦路。
`save_mode=guest` 才能弹，`unavailable` 是已登录但会话服务出错，不能误导用户反复登录。
`allowScriptAccess` 仅对接入表里的游戏开放。

新开发的 Flash 游戏统一用 AGI2 桥暴露的 `eightbitgo` 简化接口：
`isLoggedIn / getUser / showLogin / read / write / remove`，不用再仿 Armor Games 命名空间。
两代桥都已带 `opId` + `expectedRevision`、读前等写（上限 3 秒）；
删除也要同步服务端返回的新代次，否则删档后第一次保存会撞 `stale_write`。

⚠️ **桥里禁止用顶层 `JSON` 类**（2026-11-05《王国保卫战：前线》「CONNECTION LOST TO THE ARMORGAMES SAVE SYSTEM」）。
Ruffle 按**根影片**的 SWF 版本开放 API：KRF 是 SWF 10，`JSON` 只给 SWF 11+，桥里一调
`JSON.stringify` 就抛 `#1065 Variable JSON is not defined`，请求根本没发出去。AGI2 现在用自带的
`encodeJson / decodeJson`；以后接新游戏前先看主 SWF 第 4 字节（版本号），< 11 的游戏不能用
依赖 `JSON` 的桥（当前 AGI1 的 Infectonator 2 是 v11、SAS3 是 v14，暂时安全）。
另外桥是 Loader 加载的子影片，`stage` 恒为 null：AGI2 从 `connect({stage})` 的
`stage.getChildAt(0).loaderInfo.parameters` 取主影片 FlashVars，桥 URL query 只是兜底。
⚠️ **KRF「登录了，点 START 还是显示未登录」**（2026-11-06）：站内 KRF 包把面板的 Login 改成
`navigateToURL("https://8bitgo.com","_blank")`，只会新开首页、这一局收不到会话；面板的登录小部件又只在
`ADDED_TO_STAGE` 时读一次 `isLoggedIn`。修法三处缺一不可：注册表 KRF `loginUrls: ['https://8bitgo.com/']`
把跳转接回登录框；桥 `setSessionFromHost` 登录态一变就给带 `tryToLogin` 的显示对象补发 `ADDED_TO_STAGE`
（它的 `init` 不是 public，直接调抛 #1069）；`showLogin` 回调挂起到登录有结论，登录框没登录就关时
播放器调 `eightbitgoLoginSettled`。回归：`node scripts/test-flash-save-consistency.mjs`。
改桥必须提升 `FLASH_SAVE_BRIDGE_RELEASE` 发新目录（旧目录保留，Cloudflare 缓存 SWF），
只重编一代时把另一代的 SWF 原样复制进新目录。

- **接口参考手册**（两代逐方法、逐字段、错误码、限额、排查线索）：`docs/agi-bridge-api.md`
- **设计文档**（为什么分两套、令牌模型、R01/R02 并发问题的来龙去脉、验收清单）：`docs/flash-online-save.md`

部署前要迁移 `flash_save_slots` 表，并让构建检查桥源码、SWF 和 `dist` 三者哈希一致：

```bash
cd server && npm run migrate
cd .. && npm run test:flash-online-save
```

### 2.22 联机手柄位只认后台 `games.players`，全站硬上限 4

后台“最大玩家数”是 P2P 和 cloud-game 房间的唯一人数准则：1 = 不允许开联机房，2 / 3 / 4 =
对应数量的手柄位。EmulatorJS 的 `open-room.maxPlayers` 是客户端字段，绝不能直接相信；服务端会用
适配器补入的 `game_slug` 查 `games.players`，同时核对 slug 的数字散列确实等于 `game_id`。

上限统一在 `shared/netplay-players.js`，后台写入、站内/开放 API 输出、房间列表都经过同一套归一化。
不要在新代码里再手写另一个 4。P2P 手柄位满后仍可按“观众”进入，观众不占玩家名额；云端房间没有
观众席，人数和座位号都由 `/api/rooms/heartbeat` 按后台配置拒绝越界。

自测：`cd server && npm run test:netplay:all`。这一项不改数据库结构，不需要迁移。

**联机人数默认自动推断（2026-11-13）。** `games.netplay_mode` 记意图：`auto`（默认）/ `on` / `off`；
`players` / `multiplayer` 两列是**生效值**，每次写游戏后由 `server/src/netplay-auto.js` 的
`syncNetplayDerived` 在同一事务里重算，所以公开 API、游戏库筛选、开房鉴权都不用看 mode。
auto 下街机按 ROM 短名（或 RomData 的 `DrvName`）查 `shared/arcade-players.json`
（FBNeo `BurnDriver.Players`，`node scripts/build-arcade-players.mjs <FBNeo>/src/burn/drv` 生成）；
多个语言槽取最少人数；驱动表里没有的街机按 2 人；其它平台暂时沿用库里的值。
迁移把「已勾联机且 ≥2 人」的存量游戏记为 `on`，其余交给 auto，并在每次 `npm run migrate` 全库重算
（`cd server && npm run netplay-players -- --dry-run` 先预览）。回归：`cd server && npm run test:netplay-auto`。

**街机没有联机开关（2026-11-14）。** `effectiveNetplayMode` 对 `platform = arcade` 一律按 `auto` 算，
写入时把库里遗留的 `on` / `off` 收回 `auto`；后台表单对街机只显示自动识别结果，人数下拉也禁用。
别再给街机加回手动开关，识别错了就修 `shared/arcade-players.json` 或 RomData 的 `DrvName`。

**观众上场要房主同意。** 观众调 `/role {role:'player'}` 时服务端只挂申请（202），给房主 socket 发
`seat-request`；房主经 `/seat-decision` 接受才改角色（排到玩家组末尾），申请人收到 `seat-decision`。
15 秒（`NETPLAY_SEAT_REQUEST_MS`，前端 `SEAT_REQUEST_TTL_MS` 同值）不答复按超时作废，被拒 / 超时后
冷却 5 秒；申请人离房、换房主、散房都清掉申请。房主那边是画面上沿的不挡操作卡片（接受 / 拒绝 + 倒计时）。
以观众身份进房（观看链接、直播观众点「申请当玩家」）要在 join-room 的 extra 里带 `role: 'spectator'`，
否则服务端在有空位时把他记成玩家，点「上场」就绕过了同意。凭邀请链接直接加入仍然直接当玩家。
直播同屏双打（`coopSeat.ts`）的申请也同为 15 秒。回归：`cd server && npm run test:netplay:spectator`。

### 2.22.1 EmulatorJS 的 2P~4P 出厂是空的；红白机连发被控制方案删掉（2026-11-03《魂斗罗》）

- 引擎 `defaultControllers[1..3]` 是 `{}`：2P~4P **既没有键盘也没有手柄映射**。第二个手柄被分到
  2P 槽后 `gamepadEvent` 只认 `controls[1][i].value2`，按什么都不动；`.8bg` 红白机改走 EmulatorJS
  之后，jsnes 原来的小键盘 2P 也跟着没了。
- nes 控制方案只有 A / B / Select / Start / 方向，引擎建改键面板时把下标 1 / 9（RetroPad Y / X）
  从 controls 里删光；而 FCEUmm 正是拿 X / Y 当**连发 A / B**（核心选项 `fceumm_turbo_enable`，默认 None）。
- 修法在 `src/emulator/ejsSeats.ts`：开局（引擎已读完存档）后 `repairEjsSeats` **只补缺的** ——
  2P~4P 没有任何手柄映射的座位照 1P 出厂那份补；2P 一颗键盘都没绑才补小键盘（`EJS_P2_KEY_OVERRIDE`，
  和 jsnes 2P 同一套，撞上已绑的键就跳过）；FCEUmm 补回 I / U（手柄 X / Y）并默认 `fceumm_turbo_enable=Both`。
  手机屏幕手柄给 nes 自带布局 + TB / TA。defaultControllers 一起补，引擎「重置」不会再删光。
- 引擎按 **keyCode** 认键：小键盘 2P 必须开 NumLock（jsnes 认 event.code，不用管）。文案分开：`player2NoteEjs`。
- 回归：`npm run test:ejs-seats`、`npm run test:keymap`（出厂手柄映射 / 2P 键与 jsnes 对齐 / 连发确实在方案外）。
- **2P 不能只有两颗面键**（2026-11-06《铁拳》）：上面那套照红白机抄的只有 A / B，街机四键格斗（铁拳 LP RP LK RK
  = mame-current 的 B A Y X）2P 一脚都踢不出来，SFC / PS1 的 2P 也按不出 X Y L R。`EJS_P2_EXTRA_KEY_OVERRIDE`
  给 Y / X / L / R 绑小键盘 `/ * - +`（keyCode 111 / 106 / 109 / 107，不受 NumLock 影响、不撞 1P）；
  `EJS_P2_KEYS` = 两张表合并，显示 / 同步 / 补座位都用它。已有 2P 键位的旧存档只补这四颗里**空着**的，
  玩家绑过的一颗不动。线上已核对引擎把 keyCode 111 / 106 路由成 `(1, 1)` / `(1, 9)`。
- **详情页的街机键数要和播放器一致**：播放器开局后从 ROM 内容识别出 Namco 四键格斗（`namcoMameSets`
  的 `buttons: 4`），可详情页 / 开局前按键图只有 slug，以前一律画六键（铁拳页写「按键 5 = Q、按键 6 = E」，
  按了没反应）。`effectiveArcadeButtons` 现在按 slug 认铁拳 / 灵魂之刃 / 灵魂能力（`NAMCO_FOUR_BUTTON_SLUG`），
  后台显式配置仍优先。回归：`npm run test:arcade-performance`。

### 2.23 成人游戏直播的年龄门必须守在服务端

后台标为 `games.adult = 1` 的游戏，直播和游戏本体执行同一条规则：有效注册账号、已填写出生日期、
且当前年满 18 岁。检查覆盖开播、观看、断线续播、联机弹幕、房间列表和房间详情；Linux / 其它
客户端用 publisher token 里的用户 id 回查同一张 `users` 表，不能因为它不是网页端就跳过。

房间内部保存 `adult` 权限位，但 `publicRoom()` 不把它发出去。`liveRooms()` / `liveRoom()` 默认
隐藏成人房，只有 HTTP 层已经核实年龄后才显式传 `includeAdult: true`。这个默认值不能反转，否则
开放平台、TV 或后来新增但忘记鉴权的调用方会把成人直播标题先泄露出去。Socket.IO 也必须重新
验证，前端隐藏按钮和游戏页年龄遮罩都不是权限边界；知道房号或拿到续播 token 也不能绕过。

浏览器 `EventSource` 不能带 Authorization：游客直播大厅走 SSE，登录用户改走带 JWT 的轮询；
不要把 JWT 放进 SSE 查询串（会落进访问日志、历史和 Referer）。自测：
`cd server && npm run test:live`。不改数据库结构，不需要迁移。

### 2.23.1 默认开播，但「不公开」选择必须先于推流读取

玩家开始游戏后会自动创建公开直播房间；点「不公开」后立即下播，并把选择写入
`8bit.live.private`，以后的游戏也保持不公开。这个键要在 `useState` 初始化阶段读取，不能等 effect
再补读：否则明明选了私密的玩家会先向大厅泄出一帧。本地存储不可用时回到产品默认值：开播。

默认开播、全标签页采集风险和 WebRTC IP 风险必须同时写在条款、隐私政策和按钮说明里。

`/rooms?live=1` 是观看入口，不是联机入口：云端房没有观众席，不能混进列表；P2P 房即使还有空手柄位，
从这里点进去也必须带 `watch=1`，否则「观看」会静默变成加入对局。回归：`npm run test:watch-panel`；
法律文案与存储键对账：`npm run test:legal`。

房间大厅最多分批挂载 24 张卡片，剩余房间由玩家点「加载更多」；列表接口仍保留完整快照，不能因此改坏
房间合并或自动刷新。P2P SSE 降级轮询必须单请求、8 秒超时、隐藏标签页暂停、失败退避（最多 120 秒），
回到前台立即补拉；请求代次和 SSE 快照修订号共同拦住断开后的迟到响应覆盖新状态。静态游戏 slug 索引
在模块级只建一次。回归：`npm run test:rooms-page && npm run test:sse && npm run test:room-merge`。

### 2.24 Ruffle 运行时必须带版本目录，Flash / 街机按键由后台配置

Ruffle 从 npm 复制到 `public/ruffle/v<version>/`，`runtime.json` 保存每个文件的长度和 SHA-256。
版本路径可以安全缓存一年；升级 `@ruffle-rs/ruffle` 时必须同时改
`src/emulator/paths.ts` 里的 `RUFFLE_VERSION`，否则 `npm run build` 会直接失败。不要把新文件覆盖到
旧版本目录，否则边缘缓存会把新旧 WASM / JS 混在一起。

Ruffle 初始渲染像素比按 iframe 内设备能力分档：极低配置 DPR 0.8，中低配置、高 DPR 触屏或硬件信息
不可见时 DPR 1，其余 DPR 1.25。运行后由 iframe RAF 采样器每 3 秒低频统计回调耗时与帧间隔分布；这是
主线程 / 帧节奏代理值，不是屏幕呈现 FPS 或 GPU 计时。启动解码与首屏建纹理完成后先清掉预热样本；至少
12 个有效间隔才判断，稳定 30 Hz 不误判成掉帧。连续 2 个有效慢窗口降一档，持续 30 秒有余量再升档；暂停、
切后台或样本无效会同时重置连续计数，固定容量环形缓冲、销毁时还原原生 RAF；3 秒采样定时器由播放器父窗口
创建并由同一窗口清理。
稳定回调复用包装器，降低逐帧监控分配；节能限帧或纯 GPU
瓶颈无法仅凭浏览器 RAF 完全辨别，不能宣称所有卡顿都可自动修复。
Ruffle v0.7.1 的 `Stage.quality` 目前只存值，不改变 renderer，所以不要把它当性能开关，也不要向游戏脚本
写入 LOW / MEDIUM / HIGH。像素比变化会由 Ruffle 下一次 tick 重建画布，不重载、不改游戏逻辑帧率、输入、
声音、存档或渲染后端。不要用 `frameRate` 冒充性能优化（会直接改游戏时间轴），也不要为全站钉
`preferredRenderer`（官方只把它当排错项，浏览器 / Ruffle 升级后最优后端会变）。回归：`npm run test:ruffle-runtime`。

⚠️ **唯一例外：Stage3D 内容走 WebGPU**（2026-11-05《传染恐慌：幸存者》，Starling）。Ruffle 0.7.1 默认顺序是
wgpu-webgl → webgl → canvas，有 `navigator.gpu` 也**不会**自己选 WebGPU。wgpu-webgl 下菜单每帧 24ms 只有 40 FPS，
WebGPU 0.2～3ms 稳 60；webgl / canvas 没有 Context3D 直接黑屏。`flashStage3D.ts` 在 SWF ≥ v13 里找
`flash.display3D`（CWS 边解边找，命中即停），命中且有 WebGPU 才给 `preferredRenderer: 'webgpu'`，失败 Ruffle 自己退回。
回归：`scripts/test-flash-stage3d.mjs`（已并入 `npm run test:ruffle-runtime`）。
自适应降档是**试验**：两窗没有可测改善就退回并锁下限（Ruffle 主线程耗时基本不随像素变）；回调 ≥ 150ms 的
加载长任务窗口不参与调档，试验期间遇到也直接退回。

冷启动的三条重资源必须并行：游戏 SWF、短期在线存档会话、Ruffle loader/WASM；不得把
`loadGameBytes()` 放回 `script.onload` 后面才开始。鼠标悬停会依据 Ruffle 自己的五项 WASM 能力探针，
只预热正确的一套 core JS + 约 14 MB WASM；`scripts/copy-ruffle.mjs` 从官方 loader 解析对应关系写进
新 URL `bootstrap.json`，解析失败必须中止升级，不能同时预拉两份核心。省流量模式 / 2G 不预拉。
不要把这份数据塞进同版本的 `runtime.json`：它已经被长期缓存过，原地加字段会让旧访客永远读不到。

SmartFoxServer 配置只有 `shared/sfs-games.js` 里的游戏能请求（当前 `sas3`）；其它 Flash 一律直接空配置，
否则旁路故障会把每一款游戏启动拖住 1.5 秒。`api.load()` 返回也不代表舞台已经创建，必须等
`loadedmetadata/loadeddata` 再撤加载层；不等会偶发黑框并永久漏掉本局截图 / 录制 / 直播能力。
详细取证和升级约束见 `docs/ruffle-performance.md`。

`load()` 成功后 Ruffle 仍可能在后续时间轴里发生 WASM `RuntimeError` / Rust panic。若外层不接管，
播放器状态会永远停在「运行中」，用户只看到冻结或黑屏。`ruffleCrash.ts` 的守卫必须在 `ruffle.js`
之前安装，且只认确定性的 WASM / panic 特征：普通 ActionScript 异常与 `AbortError` 不得误杀，换游戏时
必须还原 iframe 的 `console.error` 并摘掉监听。回归 `npm run test:ruffle-runtime` 必须从当前 npm 包
版本推导公开目录；不准写死旧 `v0.6.0`，否则升级后会拿残留产物假绿。

《森林冰火人》这类 `flash_controls` 同时配置 p1 / p2 的游戏，在手机上只有一块本机触控板。
`TouchPad.tsx` 必须依据 `coopButtons` 提供 1P / 2P 切换，并把座位号传给 `sendButton`；切换前要先向
旧座位补齐 keyup，否则另一名角色会卡住一直走。直播访客的 2P 输入仍走同一个 seat=1 入口。

EmulatorJS 的悬停预热不能直接拿平台配置里的 `core` 拼文件名：`gb`、`gba`、`psx` 等是
`EJS_core` 接受的**平台别名**，公开目录里实际是 `gambatte-wasm.data`、`mgba-wasm.data`、
`pcsx_rearmed-wasm.data`。统一走 `paths.ts` 的 `emulatorJsCoreFileFor()`；`test:ejs-cores`
会把它和自托管 `emulator.min.js` 里的真实别名表逐项核对，避免悬停必打一条 404。

Flash 手柄键位存在 `games.flash_controls` JSON，街机屏幕手柄的动作键数存在
`games.arcade_buttons`（2 / 4 / 6）。这两列都是可空的：旧 Flash 游戏仍可用鼠标，旧街机默认六键，
所以可以先迁移再慢慢在后台补配置。部署这版必须先跑 `cd server && npm run migrate`；
自测用 `npm run test:ruffle-runtime && npm run test:game-controls && npm run test:keymap`。

### 2.24.0a 「无法初始化 Flash 播放器容器」= 播放壳没按时就绪（2026-11-07《以撒的结合》）

`flashInitFailed` 只有两个来源：`/flash-frame.html` 壳未就绪超时，或 `replaceState` 改逐游戏地址失败。
挂载时 SWF 就和壳并行下载（以撒 36.7 MB），慢网 / 丢包下 600 字节的壳导航可能排在大文件后面
十几秒；旧代码 10 秒一到就 `abort()` 掉已下一半的游戏。现在超时先直接查壳是否已到（load 可能比
定时器晚一步），没到就重新导航一次再等 20 秒，30 秒仍不行才报错，并在控制台打出 iframe 实际内容
（about:blank / 错误页 / Cloudflare 质询页 / 跨源）。重试前不许 abort。回归：`npm run test:ruffle-runtime`。

**2026-11-09 起默认不再请求这个壳**：壳必须与页面同源，只能从 8bitgo.com 取，大陆访客绕 Cloudflare 洛杉矶，
EdgeOne 帮不上。现在 `writeInlineRuffleFrame()`（`src/emulator/ruffleFrame.ts`）在没有 src 的 iframe 里
`document.open()` 就地写出同一份 HTML：父页面调用 `document.open()` 会把子文档 URL 改成父页面的同源地址，
`replaceState` 到 `/flash-frames/<slug>/frame.html` 照常成立，存档路径不变；about:blank 继承父页面的跨源隔离，
`/play-local` 也可用（已实测）。写不出来才导航到 `/flash-frame.html`，上面的超时重试保留为兜底。
`RUFFLE_FRAME_HTML` 与 `public/flash-frame.html` 必须逐字一致，测试会核对。

### 2.24.0b AwayFL 只接管逐款验证过的 Flash 游戏

Ruffle 的网页运行时依赖 WebAssembly；浏览器彻底禁用 WebAssembly 时，播放器可以改用 AwayFL 纯 JavaScript 运行时。
Shumway 原型的 15 款游戏结果只属于 Shumway，**不能照搬成 AwayFL 的通过名单**。AwayFL 验证账本在
`shared/awayfl-games.js`；当前还没有任何一款通过，所以无 WebAssembly 浏览器暂时不会自动把 Flash 游戏切过去。
候选列表包含 `fireboy-and-watergirl` 和同系列第 2～4 作，但它们都必须在 AwayFL 上单独验收。
名单外继续使用原有错误提示，不能把 AwayFL 注册成整个平台的通用 Flash 引擎。

加新游戏前必须在「没有 WebAssembly」和「禁用 JIT」两种环境完成标题 → 菜单 → 第一关 → 按键移动，
并在非高配 Mac 的真实目标设备上确认；记录浏览器 / 系统、两种限制是否生效、是否进入第一关、实际输入结果。
手工地址参数 `?awayfl=1` 只用于兼容性排查，不能作为自动放行依据。AwayFL SharedObject 存档只留在本浏览器，
按游戏 slug 隔离，不支持本站即时存档导出或云同步。宿主页位于 `public/awayfl/host-vN/`，改它必须新建版本目录
并同步 `AWAYFL_HOST_PATH`；上游运行时位于 `public/awayfl/v<版本>/`，升级时同步 `AWAYFL_VERSION`。
两类路径在 `server/src/cache.js` 都是一年缓存。

Shumway 原型记录仅作历史参考：当时 15 款里 12 款能进菜单，只有《森林冰火人》确认可玩；《黄金矿工》《雷电 X》
在开始后失败，另有 3 款黑屏。不要把这些结果写入 AwayFL 通过名单。Ruffle 仍是主运行时。
参考：[AwayFL embed](https://github.com/awayfl/awayfl-embed)、[AwayFL player](https://github.com/awayfl/awayfl-player)、
[Shumway 上游归档](https://github.com/mozilla/shumway)、[Ruffle 网页 API](https://ruffle.rs/js-docs/master/)。

### 2.24.0c Flash 冷启动：核心与 Zstd 解码器必须和 SWF 并行取（2026-11-11 大陆四局慢启动）

大陆玩家四局 Flash 在 20 秒内没进游戏（《Dad 'n Me》两局、《僵尸危机：房间》3G、《森林冰火人》）。两处串行：

- **Ruffle 核心只在 `player.load()` 里才下载**，而 load() 要等 SWF 下完、解完。核心是 core JS + wasm，
  经 EdgeOne 走 br 约 3.4MB。悬停预热只对桌面真悬停生效，触屏 / 键盘开局从来没有。《Dad 'n Me》的 SWF
  178ms 就从缓存拿到，随后整整 20 秒全是核心下载编译。现在适配器挂载时调用 `warmRuffleCore(ruffleRoot)`
  （`prewarm.ts`，不看悬停 / 省流量，反正马上要下），读 `bootstrap.json` 选出与 Ruffle 一致的那一套，
  和 SWF 并行进 HTTP 缓存。
- **8BG 的 Zstd 解码器 wasm 等到解包才 `init()`**：《森林冰火人》的 SWF 用 10.9 秒下完，11.0 秒才去取
  74KB 的 `zstd-*.wasm`，弱网上又排了 7 秒。现在 `loadGameBytes` 见到 `.8bg` 地址（`isRomPackUrl`）就先
  `prewarmRomPackDecoder()`，所有运行时共用。`readyZstd` 失败后会清掉，不再永久钉在 rejected。
- **数据密钥也与下载并行**（2026-11-12《凯撒大帝》）：以前 `/api/rom-pack/key` 要等 ROM 下完、读出包头才发，
  密钥回来才取解码器，高 RTT 线路上 ROM 之后串行多走两趟往返（实测约 2 秒）。现在 `prewarmRomPackDecoder(url)`
  同时调 `prewarmRomPackKey`：先 Range 读前 4KB 包头拿 packageId，提前要密钥，结果进 `contentKey` 的同一份缓存。
  包头超过 4KB（约 150MB 以上的 ROM）或源站不支持 Range 就不预取。普通 DOS 包走 `prepareRemoteDosBundle`、
  不经 `loadGameBytes`，以前连解码器预热都漏了，现在入口处一起补上。回归：`npm run test:rompack`。
- **密钥请求要对冲，不能单发干等**（2026-11-14《僵尸盒子 2：双人版》CN / Android Chrome 109）：ROM 0.4 秒下完，
  113 字节的 `/api/rom-pack/key` 在 cn.8bitgo.com（EdgeOne）上走了 17.3 秒，整局卡在等密钥；服务端这条接口是即时返回的，慢在线路。
  现在 `fetchRawKey` 经 `hedgedRequest`（`src/services/hedgedRequest.ts`）：同源先发，3 秒没结果（或直接失败）就同时走另一条——
  大陆入口上是主域（Cloudflare，`ALLOWED_ORIGINS` 已放行跨域），主域的大陆访客是 EdgeOne `/_cn/api`；先成功的赢，其余中止，
  每条响应仍逐条校验 packageId / 长度；单条 30 秒上限。回归：`npm run test:rompack`（含 `scripts/test-hedged-request.mjs`）。

**诊断**：以前 Ruffle 的诊断包在 ROM 之后一行日志都没有，因为 ruffle.js / 核心都在 iframe 里下，外层
performance 看不到。现在适配器做三件事：
- 用 `markStage` 记每个阶段：播放壳就绪 → 取 ruffle.js → ruffle.js 已加载 → 等 SWF 与存档会话 →
  检查 SWF → Ruffle load() → 等元数据 → 可以玩了；
- 登记 `watchFramePerformance(iframe)`；
- 打包时给一行 `Ruffle 现场：卡在「…」Ns`，带线路、SWF 大小、核心预热耗时。

看慢启动先找这行：卡在「Ruffle load()」且核心预热未完成，就是核心下载慢。回归：`npm run test:ruffle-runtime`
（含 `scripts/test-ruffle-startup.mjs`）。

**SWF 格式校验必须先于 ROM 缓存（2026-11-15，秘鲁 Edge《华纳史诗冒险 2》）**：FWS 头声明的未压缩长度大于实际字节时，播放器报「SWF 文件下载不完整」。
`loadGameBytes()` 原先在 Ruffle 的 `assertSwf()` 之前就缓存 8BG 密文，后续开局从 ROM 缓存重复取到坏内容，短时间多次点击都秒失败；诊断包没有保留文件字节，不能据此判定坏内容最初来自 R2 还是浏览器缓存。
Ruffle 要把 `assertSwf` / `assertSwfBlob` 通过 `loadGameBytes` 的校验回调传入，确保普通 SWF、8BG 解包结果、远程 ZIP 内层 SWF 都在写缓存前校验；历史缓存校验失败要同时删除 ROM 缓存和续传片再回源。管理员上传单 SWF、多 SWF ZIP、已有 8BG 容器时也先校验内层主文件。**不要在适配器拿到已缓存的字节后才做平台完整性校验。**

### 2.24.0d EditText 文本缩短后必须收紧旧选区（2026-11-16，《咒怨》Ruffle panic）

Ruffle 0.7.1 的 `EditText::set_selection()` 会把选区裁到当前文本长度，但 ActionScript 缩短文本并触发 `relayout()` 时没有重新裁选区；随后按词移动 / 删除把旧光标位置交给单词边界计算，`&text[..pos]` 越界会 panic `string indices out of bounds`。玩家现场的 SWF、WASM、首帧都已成功，约 44 秒后才报错，因此这不是下载或 SWF 完整性故障。

本站补丁 `patches/ruffle/v0.7.1-edittext-selection-clamp.patch` 在 `relayout()` 前重新调用 `set_selection()`，并在按词移动的前后边界计算中把位置限制在当前文本长度内。修补后的运行时必须发布到新路径 `public/ruffle/v0.7.1-8bitgo.1/`，不能覆盖已缓存一年的 `v0.7.1`。重编时按 Ruffle 上游 `web/README.md` 构建流程，在 v0.7.1 源码应用补丁并运行 `npm run build:dual-wasm`；随后用 `node scripts/copy-ruffle.mjs --source <packages/selfhosted/dist> --source-version 0.7.1 --version 0.7.1-8bitgo.1` 发布。`check-ruffle.mjs` 和性能回归都必须同时核对自定义运行时代次与当前 npm 上游版本。

### 2.24.0e 弱网故障必须保留错误归因（2026-11-17）

Ruffle 的远程 SWF 由 `loadGameBytes()` 下载，它已经把断流、HTTP 5xx、超时等标成网络故障。适配器不能把整个启动链 catch 一律标为内容错误：播放器会误切语言 ROM，导致同一坏线路上重复下载。SWF 下载网络错误标 `network`，格式校验 / 已知站点锁才标内容或确定性错误；Ruffle 自己的资源加载失败要允许线路故障触发同源重试，运行时设施错误不能污染 ROM 失败集。WASM 崩溃可能同时经 `console.error` 与 `load()` rejection 到达，必须保留异常对象的 `name` 并由适配器合并成一次失败通知。

Ruffle 核心预热只有在清单选中的 core JS 与 WASM 都读到结束后才算成功。预热失败要从 URL 去重表移除、允许下一局重试，并在诊断包标明失败；不能把“失败后放弃”记录成“预热完成”。大核心的悬停预热按省流量、网络类型、吞吐与 RTT 门控；玩家点击开始后仍与 SWF 并行预热核心。回归：`npm run test:ruffle-runtime && npm run test:ruffle-saves && npm run test:game-controls && npm run test:keymap`。

### 2.24.0e.1 运行时模块按进展计时；大陆加速线路判坏记 2 小时（2026-11-22，#2756 / #2758《暴力摩托》）

`loadMountOf` 的 60 秒时限以前从播放器挂载起按墙钟算，EdgeOne 对这位访客只有约 6KB/s 但一直在下，到点就判超时；js-dos.js 的
25 秒改道逻辑在 mount 里，根本没轮到。现在 `src/emulator/moduleLoadDeadline.ts`：同目录 JS / CSS 每完成一个就重新计时，
连续 60 秒没进展才判、总上限 180 秒（文案带「60 秒没有进展」/「180 秒仍未完成」，诊断归组特征随之变化）。
模块本身在加速入口上超时（`assetsOnCnEdge`）时，EmulatorPlayer 带 `__assets=origin` 整页重开一次（已是主站资源页不再跳，防循环）。
`src/emulator/runtimeEdgeRoute.ts` + `runtimeEdgeWatch.ts`：js-dos 运行时下载失速（30 秒零字节）、一段（≥20 秒）总吞吐 < 24KB/s、
或入口脚本在加速入口失败 / 超时，就本页改同源、中止坏线上的预热并改同源重拉，结论写 localStorage `8bitgo.runtime-edge-bad.v1`（按运行时分，2 小时）。
`runtimeBase` 每页每种运行时只读一次这个结论。**目前只接了 js-dos**：EmulatorJS / Ruffle 的同源线对多数大陆访客更慢，误判代价大，接之前要有现场证据。
回归：`npm run test:runtime-edge-route`。

### 2.24.0f 运行时入口加载不能无限等待（2026-11-19）

启动诊断若只有 `start_click → timeout`，且没有 ROM 完成事件或适配器阶段日志，不能据此归因成 ROM / 核心下载故障。播放器在调用适配器前会先动态导入运行时模块；该导入曾没有时限，若浏览器端代码分块请求一直 pending，适配器不会挂载、也没有机会报告进度，玩家只会在 120 秒后得到通用超时事件。`loadMountOf()` 现在 60 秒超时并清掉失败 promise，让错误状态和重试入口及时出现；播放器会记录模块加载起止，Ruffle 每个启动阶段也必须调 `onStartupActivity()`，避免已经推进的 iframe 启动被外层看门狗误判为静止。单份现场只能确认停在适配器首次可观测阶段之前，不能反推当时具体是哪条模块请求挂起。

### 2.24.0g React #185 优先于旧资源错误（2026-11-20）

**2026-11-22 定位到的最可能来源（未能复现）**：`LiveControls.tsx` 的 `coopCtl` 每次渲染新建对象，又在调用 `onControls`（父组件 `setLiveCtl`）的 effect 依赖里；
`coopReady`（有 2P 键位且正在直播，默认自动开播）为真时就形成 渲染 → effect → setState → 渲染 的循环，任何一次同步更新（点击、按键、resize）都会让 React 数满 50 层抛 #185。
《森林冰火人 4》直接命中；「NES 页面上 Ruffle 跑了 41.6 秒」是 SPA 跳转时 `usePageData` 保留旧页数据、旧 Flash 播放器还挂着，而崩溃报告按地址栏取 slug。
修法：`coopCtl` 改 `useMemo`（只依赖原始值和稳定回调）；父组件经 `acceptLiveCtl` + `sameLiveControls` 按值去重。**往 effect 依赖里放对象、effect 里又回调父组件 setState 的写法不要再用。**
回归：`npm run test:player-runtime-state`。直播中的双人 Flash 游戏上线后要实测一次。


React 19 的 `Minified React error #185` 是最大更新深度超限，表示组件树出现连续状态更新；组件栈只到 `EmulatorPlayer` 时，还不足以确定是哪一个 hook / 回调触发，必须保留组件栈和同次启动阶段继续定位。#1533 的游戏记录是 NES《超级玛丽奥兄弟》，但快照却报告 Ruffle 已运行 41.6 秒，运行时与游戏记录互相矛盾，不能据此断言模拟器已启动或把原因归到 Ruffle。列表里唯一 HTTP 400 是 459 秒前的 `u.clarity.ms/collect`，与本次故障无关。`server/src/startup-diagnostics.js` 对 #185 单独归类，资源 HTTP 错误只有发生在开局前后 30 秒内才参与判断，近期第三方错误仍只作中把握度线索；旧的 Resource Timing 不能盖过当前页面错误。`EmulatorPlayer` 对重复的能力、几何、双屏布局回报按值去重，避免相同状态不断生成新引用触发多余渲染。此保护针对可证实的更新放大路径；当前证据仍未定位到 #1533 的具体业务更新源。回归：`npm run test:player-runtime-state && npm run test:startup-diagnostics`。

### 2.24.0h GrindCraft 不兼容 Ruffle 时使用游戏方 HTML5 版（2026-11-22）

《GrindCraft》黑屏不是 ROM 下载失败：线上 SWF 已完整取得，随后 Ruffle 0.7.1 打印 TextBlock.createTextLine() 等 Flex 文本排版接口未实现，enterFrame 初始化脚本最终被 Ruffle 超时终止。玩家提供的 SWF 与线上文件 SHA-256 相同；附件里的 .swz 不能补齐 Ruffle 缺失的 ActionScript Text Layout Framework 实现。把 maxExecutionDuration 从 15 秒提到 60 秒只会让黑屏等待更久，不能作为修复。

src/emulator/grindcraftHtml5.ts 只为 grindcraft 指向游戏方公开的 https://cdn.grindcraft.com/game.html，GameDetailPage 对该 slug 使用 HTML5 播放器并跳过原 SWF ROM 的可用性和语言门控；其它 Flash 游戏仍走 Ruffle。官方 HTML5 页已实测能进入菜单并开始采集木材；改动发布前仍须在站内播放器实测嵌入后的首帧与点击操作。不要把未经核验的 .swz 加入公共 ROM 目录，也不要再为这款游戏放宽 Ruffle 脚本时限。

Ruffle 0.7.1 会把这类带样式错误输出到 iframe 的 console.log，而不一定调用 console.error。ruffleCrash.ts 必须同时观察两种方法，且销毁时还原；普通 ActionScript 日志仍不得触发红屏。回归：npm run test:ruffle-runtime。

### 2.24.0 Ruffle 存档要跟着游戏走；舞台按显示尺寸渲染

Ruffle 的 SharedObject 键是 `<hostname>/<localPath>/<名字>`，而本站所有 Flash 共用一个源：
`getLocal("save", "/")` 这类根路径存档会落在 `8bitgo.com//save`，不同游戏互相覆盖，而且不在本局
前缀下，导出 / 云存档一份都拿不到。默认 localPath 又带 SWF 文件名，单 SWF 重传成 8BG（解包名是
管理员本地原始名）或改成 `root.swf` 多文件包后，老进度就无声消失。

`src/emulator/ruffleStorageScope.ts` 在 ruffle.js 加载前把 iframe realm 的 `window.localStorage`
换成 Proxy（Ruffle 用 `storage[key]` 具名访问，不走 getItem，三种陷阱都要拦）：本局槽统一翻译到
`/flash-frames/<slug>/<稳定名>.swf/`，祖先路径的键翻译成同前缀下的 `~shared/<原路径>`。稳定名由
`flashSaveSwfName()` 从 ROM 地址推（剥 `.8bg`，`root.swf` 换目录名），单 SWF 的 `<slug>.swf` 不变，
所以存量存档不用迁；语言版本仍各自独立。旧键读不到新键时回退读并拷过来，删除写空串墓碑。
Proxy 装不上时整条退回旧路径，导出 / 导入也跟着旧路径走。回归：`npm run test:ruffle-saves`。

等比模式（默认）下舞台元素按**显示尺寸**布局，并给 Ruffle `scale: showAll + forceScale`。
不要再改回「元素钉原始像素 + CSS transform 放大」：Ruffle 画布只看 `clientWidth × DPR`，
transform 不改它，550×400 的游戏在 1080p 全屏里会按 687×500 画完再放大两倍多，整片发糊。
超过约 1080p 面积（`RUFFLE_MAX_RENDER_AREA`）才用 transform 补剩余倍数，给 4K 封顶。
在线存档会话请求有 6 秒总时限，API 卡住时按「不可用」启动，不能把已登录玩家挡在加载遮罩上。

### 2.24.1 js-dos 的 JS / DOSBox / DOSBox-X 必须整套更新，stop 必须真清理

> 2026-11-15：`scripts/jsdos-asset-lock.json` 记「`JSDOS_ASSET_VERSION` → 产物指纹」。改了 `copy-jsdos.mjs` 的补丁却没换版本号时，
> `copy-jsdos` 和 `check-jsdos` 都会失败（同一 URL 发新字节，长期缓存的访客拿不到）；换了版本号后 `npm run jsdos` 自动更新锁，
> 和 paths.ts 一起提交。回归：`npm run test:jsdos-asset-lock`。

js-dos 运行时从 npm 复制到 `public/jsdos/v<version>/`，版本同时写在
`src/emulator/paths.ts` 的 `JSDOS_VERSION`。这不是目录整理：`js-dos.js`、`wdosbox.wasm`、
`wdosbox-x.wasm` 和 JSPI 版是配套产物，固定 URL 覆盖升级会被浏览器 / Cloudflare 拼成新旧混合，
症状通常只有黑屏。升级 `js-dos` 时必须同步改版本常量并跑 `npm run jsdos`；
`scripts/check-jsdos.mjs` 会在构建前、复制到 `dist/client` 后各验一次清单、长度和 SHA-256。

`scripts/copy-jsdos.mjs` 还打这几项补丁，任何一项对不上都必须让构建失败：

1. IIFE 隔离上游数百个顶层变量，尤其不能再让它的 `io` 覆盖 socket.io；
2. IPX 地址去掉写死的 1900 端口，联机中继才能走 Cloudflare 后面的主站 443；
3. 上游每次 `Dos()` 注册的 `fullscreenchange` / `pointerlockchange` / `visibilitychange` 要在
   `stop()` 移除，并释放 `navigator.keyboard` 锁。原版只停核心、不拆这三条监听；多开几局后一次
   切后台会唤醒所有历史 Redux store，完整模拟器对象也无法回收。
4. **sync sleep 不能忙等**（2026-11-05《大富翁3》，资源代次 `8.5.3-8bitgo.3`）。DOSBox 每 1ms 节拍睡 1ms，
   原版胶水在 worker 和主线程之间来回 `ws-sync-sleep` / `wc-sync-sleep` 直到到点：空闲的 DOS 游戏每秒
   5.6～7 万条消息，两个线程各烧一个核心。现在第一轮仍经主线程让出 worker 事件循环（按键 / 鼠标照常进），
   剩余时间用 worker 的 `setTimeout` 等，消息降到约 600～1000 条/秒；同画面声音包速率 92.5/s 与原版一致，
   游戏速度不变。主线程直跑模式（隐藏页定时器会被节流到 1 秒）保留原轮询。四个 `wdosbox*.js` 都要命中，
   `check-jsdos` 会逐个验 `__8bitgoWakeWhenDue`。
5. **INT 33h 事件回调的 SI/DI 必须是累计 mickey**（2026-11-05《主题医院》，资源代次 `8.5.3-8bitgo.4`）。
   真驱动 / 原版 DOSBox / DOSBox-X 调 0Ch 注册的回调时，SI/DI 是累计原始 mickey，游戏拿两次的差当位移；
   js-dos 自己的 `jsdos-mouse.cpp` 却给「上次回调以来的增量」。只用回调的游戏（主题医院只调 INT 33h 的
   00/0C/15）算出「本次增量 − 上次增量」：同向连续移动光标不动、换向跳两倍或反向、小幅移动全丢。
   `copy-jsdos.mjs` 的 `patchInt74CumulativeMickeys()` 直接改 `wdosbox.wasm`：加两个 i32 全局，把
   INT74_Handler 里 `reg_si/di = rel.mickey_x/y` 换成累加后再写。字节特征（含 reg_si/reg_di 的线性地址）
   必须在代码段恰好一处，否则同步失败——升级 js-dos 时要重新定位（wasm2wat 找调用 getRelMickey 的
   两个函数，结果 i32 的那个就是 INT74）。`check-jsdos` 验旧特征已消失、新特征在位、`WebAssembly.validate`
   通过。排查手段：往虚拟盘写一个 INT 33h 记录 TSR（`wc-send-data-chunk` 可直接写文件），再从
   `ws-update-lines` 维护帧缓冲按形状找光标，能把「游戏读哪个接口、位移是否线性」量化出来。

普通 DOS 包生成的 `cycles=auto` 一遇保护模式就放到 max：DOS4GW 游戏若模拟节奏跟 CPU 走，就会快得没法玩
（2026-11-15《主题公园》）。这类游戏在 `windowsGameCompatibilityDosboxConfig` 里给固定周期（`theme-park` 为
`cycles=fixed 25000`），后台 `dosbox_config_override` 仍优先；别把全站默认改成 fixed，慢保护模式游戏会被拖垮。

**DOS 三项自动化（2026-11-15，线上 67 款普查后补的）**：
- **自动存档**：以前只有 Windows 客体每 60 秒做检查点，普通 DOS 要玩家「游戏内存盘 + 点保存进度」两步，漏第二步就丢。
  现在 `autoCheckpointKind` 决定：`windows`（只取 GAME/ 差异）、`files`（普通 DOS，`ci.persist(true)`，与按钮同一包）、
  `sockdrive`（纯 DOS 流式盘的扇区差异）；Win9x 流式盘中途存扇区不安全，仍只手动。只写 `'local'`，选了云存档的由待同步队列补传；
  内容没变不重写。`persist(true)` 会带上开局回放的旧存档层（它解在基础包之后，mtime 晚于 `fsCreatedAt`），不会盖掉旧进度。
  别改调 `props.save()`：它每次都弹 js-dos 自带的提示。
- **启动程序识别看文件内容**（`pickExecutable` + `executableCandidates`）：按名打分曾把英雄无敌 1 选成 `SVIEW.EXE`、
  主题医院繁体选成只跑 `ipxnet` 的 `S.BAT`、Castle Wolfenstein 选成 debug 补丁 `FIXIT.BAT`、三国志 III 选成结局 `END.EXE`。
  现在：BAT 调用了包内程序 +1、一个没调用又不换盘 -8；引用包内两个以上程序的小 EXE/COM 是启动器 +1.5；PE/NE 头（Windows 程序）-6；
  ≥512KB 才给大小分。⚠️ 这些分都必须低于「有效 BAT」：第一版大小封顶 +3、启动器 +5，回放时把主题公园 PARK.BAT、
  英雄无敌 2 START.BAT 全换成了 MAIN.EXE / 编辑器 / 安装程序。改权重前先对线上全部 DOS 包做新旧对比回放。后台配置永远优先。
- **光盘镜像自动挂载**（`autoDiscMount`）：后台没填挂盘命令、包里认得出唯一一张盘时挂成 D:。cue 的 FILE 名按包内真实大小写改写
  （宿主文件系统区分大小写，雷神之锤写的是 track01.iso、包里是 Track01.iso），缺的音轨整段删掉，改过就另存 `.8bitgo.cue`；
  只有 `.ccd + .img` 的 CloneCD（凯撒 II）按 `[TRACK n]` 生成 cue；单个 `.iso` 直接挂；多张盘 / 数据轨缺失不挂。
  游戏自己的 `.IMG` / `.BIN` 数据文件不算光盘。挂载失败 DOSBox 只打一行错误，游戏照旧启动。
回归：`npm run test:dos-bundle && npm run test:dos-load`。

普通 DOS 的 EXE / COM / BAT 若不是 8.3 文件名，不能直接在 autoexec 里加引号：DOSBox 那条命令
不会可靠剥掉，引擎照样报 ready，实际只停在 `C:\>`。`makeJsdosBundle()` 会保留原文件，再在同目录
补一个真实的 `8BITGO.EXE`（撞名时递增）供启动。ZIP 的绝对路径、盘符和 `../` 也在重打包前拒绝，
否则能覆盖虚拟盘里的 `.jsdos/dosbox.conf`。

⚠️ js-dos 的设置不在裸 localStorage 键里：它用 `new class{…}(void 0,"jsdos.8.")` 包了一层前缀，
JSPI 开关真正的键是 `jsdos.8.jspi`。2026-10-26 以前 `jspiFlag.ts` 一直写裸键 `jspi`，js-dos 从未
读到，线上 DOSBox-X 实际一直跑 Asyncify；悬停预热却按 JSPI 拉 `wdosbox-x-jspi.wasm`，每次冷启动
白下 7.9MB（gzip 约 2.7MB），真正要用的 `wdosbox-x.wasm` 反而在系统盘和游戏包下完之后才串行下载。
现在默认固定 Asyncify（所有 Win9x 游戏都在它上面验收，《帝国时代》同机 A/B 到主菜单 12～13 秒无差别），
`?jspi=1` 才写 `jsdos.8.jspi=true` 做对照；`test:jspi` 会对着 `public/jsdos` 里的运行时核对前缀与读法。
适配器在玩家点击开始的那一刻就调用 `warmJsdosCore()`，把与 `Dos({ backend })` 同一判断选出的核心
并行送进 HTTP 缓存，触屏 / 键盘开局（没有悬停）也不再把核心压在关键路径末尾。
**js-dos 依赖脚本失败后必须移除 script 标签**（2026-11-20，诊断包 #1518，《大富翁3》，Edge 157 / Windows / CN）：ROM 的 `download_complete` 已发生，随后 EdgeOne 上 `emulators.js` 请求超时；上游只看 `#emulators-js` 标签是否存在，失败标签留在 DOM 后，自动重试跳过加载并在读取 `emulators.version` 时抛 `ReferenceError: emulators is not defined`。具体为何 EdgeOne 首次请求超时，现场无法确认。`scripts/copy-jsdos.mjs` 现在只在 `window.emulators` 存在时复用加载结果，失败、onload 没有全局对象或 7 秒 pending 超时都会删标签并 reject，让播放器 8 秒兜底前释放请求、下一局切同源重试；并发调用共享 in-flight Promise，不误删仍在加载的标签，后开始的调用在共享请求完成后更新所选线路前缀。`test:jsdos-runtime` 从生成产物抽出实际加载器，覆盖错误 / 超时清理、同源重试、并发复用与无全局对象的 onload；`check-jsdos.mjs` 守住补丁特征。诊断归组按明确的 js-dos `emulators.js` 初始化错误优先于整页里残留的 ROM URL 日志，避免误报成 ROM 下载失败。改该补丁必须提升 `JSDOS_ASSET_VERSION`、重跑 `npm run jsdos`，并同步路径夹具。

**js-dos 依赖脚本失败后必须移除 script 标签**（2026-11-20，诊断包 #1518，《大富翁3》，Edge 157 / Windows / CN）：ROM 的 `download_complete` 已发生，随后 EdgeOne 上 `emulators.js` 请求超时；上游只看 `#emulators-js` 标签是否存在，失败标签留在 DOM 后，自动重试跳过加载并在读取 `emulators.version` 时抛 `ReferenceError: emulators is not defined`。具体为何 EdgeOne 首次请求超时，现场无法确认。`scripts/copy-jsdos.mjs` 现在只在 `window.emulators` 存在时复用加载结果，失败、onload 没有全局对象或 7 秒 pending 超时都会删标签并 reject，让播放器 8 秒兜底前释放请求、下一局切同源重试；并发调用共享 in-flight Promise，不误删仍在加载的标签，后开始的调用在共享请求完成后更新所选线路前缀。`test:jsdos-runtime` 从生成产物抽出实际加载器，覆盖错误 / 超时清理、同源重试、并发复用与无全局对象的 onload；`check-jsdos.mjs` 守住补丁特征。诊断归组按明确的 js-dos `emulators.js` 初始化错误优先于整页里残留的 ROM URL 日志，避免误报成 ROM 下载失败。改该补丁必须提升 `JSDOS_ASSET_VERSION`、重跑 `npm run jsdos`，并同步路径夹具。
2026-11-22 又补到主 `js-dos.js` 入口脚本没有时限：请求既不触发 `load` 也不触发 `error` 时，共享 `loading` Promise 会永久 pending，EdgeOne 到同源的回退不会发生。`loadJsdosScript` 现在 20 秒超时、失败清标签并释放 Promise；大陆入口失败后当局标记 EdgeOne 不可用并从同源重试。该入口脚本是适配器加载的，不改上游静态包，不需改 `JSDOS_ASSET_VERSION`；`test:jsdos-runtime` 的 `test-jsdos-entrypoint.mjs` 覆盖超时、错误、无全局对象、重试与定时器清理。

`ci-ready` 之后适配器清空交给 js-dos 的 `initFs` 数组并撤销 blob URL：js-dos 把每层按 4MB **复制**
进 worker，主线程原件却挂在它保存的 `options.initFs` 上整局不放（帝国时代约 34MB 系统盘 + 重打的
游戏层）。js-dos 首次加载后就把 bundle / initFs 置空，后端重连不会再读，所以可以安全释放。

普通 DOS 的 8 秒兜底只在 `ci` 已到时放行；`emu-ready` 只说明 emulators.js 加载完，之后才取包、
解压、下 wasm。壳起来但没有 `ci` 时改为继续按前台时间等（180 秒）后报错，不再提前撤遮罩把
后续 `bnd-error` 变成 ready 之后的错误（那样播放器既不自动重试也不换语言 ROM）。DOS 7.1 +
Sockdrive 的启动超时也改成与 Windows 客体相同的“建盘 / 自启动”两段前台计时，不再是 Dos() 起算的
90 秒墙钟（配了 ≥80 秒开机延迟的游戏以前必然失败）。

逐游戏兼容表（`windowsGameCompatibility*` / `dosGameCompatibility*` / 鼠标模式 / DirectDraw 刷新）
一律用 `compatSlug`：播放器传入的 `gameSlug` 是存档键，第二语言版带 `~rom-<语言>` 后缀，直接比对会让
这些修正在换语言后静默失效。绝对坐标会话（Windows 客体、大富翁3）里 `ci.sendMouseRelativeMotion`
也被换算成绝对坐标，手柄右摇杆 / 触屏鼠标板不再把光标甩到四角。

⚠️ **启动 BAT 要过一遍 DOSBox 兼容**（`src/lib/dosBatchCompat.ts`，2026-11-05《大富翁3》）。原版
`PLAY.BAT` = `subst a: .` / `Mouse.com` / `SS` / `RICH3`：DOSBox 没有 SUBST，游戏从 A: 读的图全缺——
主菜单还在，进「單人遊戲」选人画面缺背景按钮、点下去整局卡死；`MOUSE.COM` 接管 INT 33h 后内置驱动的
绝对定位作废，光标与真实鼠标 / 触屏鼠标板对不上。`makeJsdosBundle()` 现在对启动 BAT：`subst X: .`（CD /
换盘之前、盘符未被占用）翻译成 autoexec 里的 `mount x .`，包里真有的 MOUSE / CTMOUSE / GMOUSE 等驱动行改
REM；修补版写成同目录 `8BITGO.BAT`（原 BAT 不动），其余字节含 Big5 ECHO 原样。《大富翁3》同时进
`LOCKED_ABSOLUTE_MOUSE_GAMES`。回归：`scripts/test-dos-batch-compat.mjs`（并入 `npm run test:dos-bundle`）。

Windows 系统镜像、游戏包和资料片从同一刻下载；ROM 进度在系统镜像完成前暂存，避免游戏段先跑满
再长时间不动。资料片最多三路并发，并走共用的失速中止。回归：
`npm run test:jsdos-runtime && npm run test:dos-bundle && npm run test:dos-extras && npm run test:system-source`。

共享 Windows 系统模式必须有 `.jsdos` 系统镜像、游戏 ZIP，以及默认 EXE 或每个已绑定语言各自的
EXE。不能只在后台表单拦：批量导入和直接 API 会绕过页面。`server/src/dos-game-config.js` 在
PUT / PATCH 前按关联表的真实重写语义校验；启动时 `schema-check.js` 还会点名历史坏记录。

### 2.24.1.1 J2ME 的 8BG JAR 由服务端解包，不再经玩家浏览器上传（2026-11-10）

线上 49 款 J2ME 全是 `roms/java/*.jar.8bg`。以前适配器要在玩家浏览器里下载、解密，再 POST 回
`/api/j2me/upload` 才能交给 CheerpJ（freej2me 只认 `<J2ME_PATH>jar/<纯文件名>`）；大陆实测光上传就
23 秒，《寂静岭2》有玩家两分钟都没起来。现在适配器把本站 ROM 根下的 `roms/java/X.jar.8bg` 写成
`X.8bg.jar`（`j2meUrl.ts` 的 `packedJarProxyName`），`server/src/j2me.js` 从 R2 取回、用
`rom-pack-transcode.js` 解密校验，按 R2 ETag 缓存在内存（`J2ME_PACKED_CACHE_MB`，默认 64），CheerpJ 的
多次 Range 直接命中。名字必须带 `.8bg` 标记：同目录可能还留着迁移前的明文旧包，不能按「先明文再 8BG」猜。
适配器先 HEAD 一次（顺带让服务端预解），失败（没配 `ROM_PACK_SECRET`、对象缺失、外链 8BG）才退回旧的
上传路径。回归：`npm run test:j2me && cd server && npm run test:j2me-packed`。

⚠️ **J2ME 不能等预热下完才起 CheerpJ，起不来的判定要看进展**（2026-11-13 大陆 Windows Chrome 149《帝国时代 2 / 3》、
iOS《仙剑 2004》）：以前 `iframe.src` 要等 freej2me-web.jar / libmidi.wasm / 游戏 JAR 预热全部下完 —— 大陆走 Cloudflare 实测
libmidi.wasm 3.1MB 要 48 秒，CheerpJ 自己的 CDN 全程闲着；之后再按墙钟数 120 秒，后台也数、文件还在下也照样判死，
自动重试两次又各等 120 秒。现在预热最多等 2 秒就设 src（实测 Chrome 会合并同一 URL 的在途请求，iframe 那次传输 0 字节，
不会下两遍）；`J2ME_STALL_TIMEOUT_MS` 只数前台、iframe 每完成一个请求就重新计时，前台总上限 6 分钟；
iframe 登记了 `watchFramePerformance`，诊断包里能看到 CheerpJ 的下载。回归：`npm run test:j2me`。
预热若在 2 秒预算内完成，必须立即清掉并行等待的超时器；否则它会在 CheerpJ 已启动后仍唤醒一次。
JVM 起不来一律以 `'runtime'` 报（`j2meStartTimeout`）：不带 scope 时播放器当内容错，en 失败又去试 zh-Hans，玩家再等一轮。
run.html 的 load 到了却没有 `cheerpjInit`（leaningtech 的 loader.js 被拦 / 取不到，`cheerpjLoaderMissing`）先再探 CDN；
明确 `down` 才切到备用运行时，其余情况按原逻辑重载一次或报启动故障。

⚠️ **「CheerpJ 的 CDN 连不上」要看诊断包里的 `CheerpJ CDN：` 一行再下结论**（2026-11-14）：错误文案只是猜测。
适配器在 run.html load 时记一行、慢启动快照和「放弃」原因里各带一次（`summarizeCheerpjCdn`）：loader.js 是否完成与耗时、
其余 cjrtnc 请求数 / 字节 / 最慢一个、最后一个完成后又等了多久。跨源无 TAO 时字节和状态码读不到，只有耗时可信。
loader.js 地址从 run.html 现读，不抄版本号。CheerpJ 免费版**不允许**自托管或镜像运行时（官方许可：CDN 以外的任何提供方式都算 self-hosting，
需付费授权），所以别把 cjrtnc 的文件搬进 R2 / `/_cn/`。

⚠️ **只有确认 CheerpJ CDN 不可达才切到 j2me-web**（2026-11-14）：CheerpJ 免费版不允许自托管 / 镜像，不能把其运行文件搬到 R2。
适配器挂载时与 JAR 解包 / 预热并行调 `probeCheerpjCdn`（`j2meUrl.ts`）：从 run.html 读 loader.js 地址，
用 `no-cors + credentials:'include'` 取一次（与 `<script>` 同一种请求，命中同一条 HTTP 缓存，不算白下）。
两次网络层失败才判 `down`；只有 `down` 会把同一个 iframe 切到本站构建的 `public/j2me-web/`，并通过既有 `/j2me/jar/<文件名>` 代理读取已解包 JAR。
`slow`（慢不等于死）和 `unknown` 不切换；CheerpJ 仍是默认主运行时。页面由 `npm run j2me-web:build` 生成，`predev` / `prebuild` 自动调用，生成目录不进 git。
`j2me-web` 是独立的纯浏览器 JVM，MIDP / Java ME API 覆盖不如 FreeJ2ME 完整；带表单控件、厂商扩展或特殊音频的游戏可能无法启动。
失败时适配器用 `j2meFallbackFailed` 展示实际错误，不把这类兼容性失败伪装成 CDN 故障。run.html 加载完却没有 `cheerpjInit` 时先再探一次：
这回连得上就原地重载 run.html **一次**（看门狗从头计），仍不行才报错；进展看门狗判死前也再探一次，`down` 才转备用运行时，否则报「起不来」。
诊断包保留「CheerpJ CDN 探测：…」和备用运行时日志；所有错误出口经 `fail()`，一局只报一次。
例外（2026-11-15）：run.html 的 load 时**没有 `cheerpjInit`**（loader 在本页执行不起来）且重载一次后仍然没有，或再探结果不是 ok，
直接换 j2me-web，**不再看探测是否 ok**。2026-11-14 大陆 Android Chrome 143《仙剑 2004》两局：Rocket Loader 把 loader.js 改写成延后执行，
三次探测都是 ok，旧逻辑重载一次后报「CDN 连不上」。广告拦截 / 内容过滤挡掉 `<script>` 但放行 no-cors fetch 也是这种形态。
「慢」仍按原规则不切换；此时备用运行时失败的提示是「CheerpJ 无法启动」，不再写成连不上。
第二个例外（2026-11-15）：CheerpJ **起来之后卡住**也换 j2me-web。2026-11-14 大陆 Edge 157 / Windows《帝国时代 2》：
Rocket Loader 已关，loader.js 与 c.html 都到了，之后 121 秒 iframe 里一个请求都没再完成，探测仍是 ok，旧逻辑等满两分钟报「CDN 连不上」。
现在能换（同源、JAR 名已定）时，前台 `J2ME_FALLBACK_STALL_MS`（45 秒）没有新请求完成就直接换，不看探测结果，探测只记日志；
CheerpJ 的 cj3.js / cj3.wasm 压缩后约 150KB / 100KB、类库按需小块取，45 秒零完成是卡死而不是慢。换不了时仍按 120 秒报错。

⚠️ **j2me-web 备用运行时要按游戏实测，不能只看「起来了」**（2026-11-15 把站内 24 款 J2ME 全部放进去跑过）。
上游缺的东西补在 `vendor/j2me-web`（清单见其 `NOTICE.md`）：Nokia UI API（国产 / Gameloft 游戏大量继承 `FullCanvas`）、
MIDP 2.0 图层（Sprite / TiledLayer / LayerManager）、同步 GIF 解码（资源包里运行时才读的 GIF）、**startApp 改到独立线程**
（主循环写在 startApp 里的游戏，否则按键永远排在它后面）、Player 状态常量改成规范值 100/200/300/400/0（被 javac 内联进游戏，
上游的 4/8/16 让《仙剑》卡在「has not prefecthed」）、PlayerListener 事件与默认播 1 遍、`RecordStore.getRecord(int,byte[],int)`、
`AlertType` 对象常量、屏幕尺寸（GIF 整屏图、`Glu-Screen-Mode: landscape`、大 JAR 不信 128 的猜测）。
embed 开局 2 秒内的未捕获 Java 异常报 error，不报 ready（以前黑屏也撤遮罩）。
实测结果：能进菜单 / 游戏 —— 帝国时代 2 / 3 / 亚洲王朝、Anarchy 2087、Asphalt 4 / 6 / Nitro / Urban GT / Urban GT 2、仙剑 2004、
辐射、寂静岭 1 / 2、模拟人生 2；**仍不行** —— 3D（M3G，不打算支持）的 Asphalt 3 3D / Urban GT 3D / Rally / 模拟人生 3 冬季版，
以及停在片头的 Asphalt 3、模拟人生 3、逆转裁判、寂静岭 3（游戏线程 NPE）。`warcraft-iii` 的 JAR 与帝国时代 3 逐字节相同，是数据错（同 §2.27）。
复测方法：静态扫描用 javap 列出游戏引用的平台方法、对照 `allNatives` 找缺口；运行用无头 Chromium 在本地 dev 服务器里
iframe 嵌 `/j2me-web/embed.html` 发 start 消息、按键并比对画面。端到端（CheerpJ loader 404 / 卡死 → 自动换 j2me-web → 出画面）
两种都实测通过（卡死那种约 48 秒出画面）。回归：`node scripts/test-j2me-web.mjs`（已并入 `npm run test:j2me`）。

⚠️ **后台节流后的第一跳不能把隐藏时间算成前台卡死**（2026-11-14 玩家现场）：浏览器切后台会暂停 iframe 的定时器，
原看门狗只在回调里检查当前 `visibilityState`；玩家回来后第一跳已经是 visible，会把上次回调到现在的整段后台时间
记进 `stalledMs`，立即误报「CheerpJ 起不来」。`visibilitychange` 必须重置计时基准，耗时用 `performance.now()`，
单次前台计时步长封顶 2 秒，并在就绪、失败、销毁时移除监听。J2ME 的 `'runtime'` 错误（含 CheerpJ CDN 不可达）
也不做播放器自动重试：同一 CDN / 浏览器环境再等完整一轮只会放大等待，不会修好运行时设施。

⚠️ **J2ME 大文件给大陆访客走 cn.8bitgo.com，靠 Service Worker 而不是改地址**（2026-11-13）：run.html 必须与父页面同源
（读画面、接手柄、截图），CheerpJ 只会从同源 `/app/` 取 JAR、没有改源的配置。所以 `/j2me/edge-sw.js`
（源文件 `scripts/j2me-web/edge-sw.js`，`patch-j2me-runtime.mjs` 复制进被忽略的 public/j2me）只在 run.html 带 `edge=cn`
时，把 freej2me-web.jar、libmidi/libmidi.wasm、`jar/*.jar` 三类请求连同 Range 转给 `https://cn.<裸域>/_cn/j2me/…`；
边缘出错或 Range 没回 206 就退回同源。**加速域名只能由 SW 从自己的地址推出**，绝不接受参数（否则可以把任意 JAR 喂给
CheerpJ 在本站源上执行）。`cn-edge.js` 放行 `j2me` 前缀并暴露 Content-Range 等响应头。适配器 3 秒内 SW 没激活就整局同源，
开局失败 `markJ2meEdgeFailed()`，自动重试改回同源。回归：`npm run test:j2me`。

⚠️ 播放器的启动看门狗（`EmulatorPlayer.tsx`，「连续 120 秒没有启动进度或可玩信号」）只数**前台**时间：
标签页在后台时浏览器会节流 Win95 开机和 CheerpJ，各适配器自己的开机计时器也只按前台走；按墙钟计时会把
还在开机的游戏记成超时（2026-11-10《天之痕》下载 146 秒后被记超时，适配器从未报错）。

### 2.24.2 加载进度按运行时的真实启动链分区，不能全平台写死一套比例

加载条仍然只有一根、只进不退，但 `src/emulator/loadProgress.ts` 的 `loadProgressPlan()` 会按
运行时与介质选择阶段顺序和权重：Flash 从 SWF 下载开始，HTML5 只有子页面启动，PS2 是探盘后
加载大 WASM，PSP / Dolphin 是先起隔离运行时再挂 Range 光盘，J2ME 是 JAR 后起 JVM；DOS、
Windows 客体及 Sockdrive 也各自分配。不要再把 `engine → assets → rom → starting` 和
20/20/40/20 当成全平台事实，否则会出现 HTML5 一开始跳 80%、Flash 从 40% 起步、PS2 探两个
字节就走到进度中段这类假进度。

拿得到真实 `loaded` / `ratio` 的阶段永远以真实进度为准：即使没有 `Content-Length`，视觉预算
耗光也不能擅自切成“正在启动”，否则慢网仍在下载 ROM 时文案会撒谎。只有完全没有可测信号的
WASM 编译等静默阶段才允许按预算兜底推进；完成仍只认 `onReady`，最多显示 99%。自动重试会把
整套策略抬到已显示的 `floor`，阶段上界也必须一起 `liftRatio()`，不能拿抬高后的实际值去比较
未抬高的原始边界。回归：`npm run test:load-progress`。

⚠️ **分片下载的第一片也要带总量**（2026-11-05《主题医院》，150MB 游戏包）。`fetchBlobWithProgress`
按 8MB 分片走 Range，第一片的回包里才有 `Content-Range` 给的总大小；如果第一片读的过程中仍报
`total=0`，`createOverallRatio` 会按 SOFT_SCALE（4MB）做渐近估计，8MB 读完时已经冲到 rom 段
的 85% 左右（整体约 67%），之后真实比例只有 5%，被「只进不退」吞掉，进度条在 67% 停好几分钟。
现在 `blobWithProgressGuarded` 拿到第一片响应头就记下 `probedTotal` 并随每帧上报；
`createOverallRatio` 另外加了锚点重映射：同一阶段里渐近估计已经跑在前面、真实比例才到达时，
从已显示的位置按剩余真实进度线性走到阶段终点，而不是冻住。回归：`test:chunked-fetch` 第六节、
`test:load-progress`「渐近估计跑在前面后……」。

### 2.25 直播间房间的清理只认 `hostSocketId` 这个事实，不认 `membership`

`server/src/live.js` 里 `membership`（`socket.id → {roomId, role}`）每个 socket **只有一条**，
而 `rooms` 是另一张表 —— 两者一旦漂开，那间房就再也收不到任何清理：`stop-live`、
`host-visibility`、断线都只会动 membership 指的那一间。

2026-09-20 线上就出现了一间这样的房：主播**整个浏览器都关掉了**，它还挂在公开大厅里，
`viewers: 0` 而 `hostAway: false`（服务端以为人还在），谁点进去都没有画面，而且不会自愈。
（产生它的那条路径事后没钉死 —— 所以修法是「不假设它不再发生」。）

三处一起守，缺一处都还会漏：

1. `bindHost()` 绑主播之前，先关掉**同一个 socket** 名下的其它房间（`go-live` 和 `resume-live`
   都走这个函数，所以挡在两处入口）。
2. `leave()` **第一句**就按 `hostSocketId === socket.id` 扫一遍，不能只走下面那条 membership
   分支（那条在漂移状态下会 `if (!info) return` 直接放过）。
3. 兜底扫描（`GHOST_SWEEP_MS`，默认 30s）：房间记着的 `hostSocketId` 已经不在 `nsp.sockets` 里，
   就按「主播离开」处理（有人看走宽限期、没人看直接散）。判据只能是这个**事实**。

**给一款新 Runtime 加「屏幕方向键」这类按键时**：`scrollGuard` 是按 `status === 'running'`
给所有运行时装的，而**看直播的访客没有 2P 座位时方向键没有任何消费者**，拦掉只会让他滚不动页面。
所以它现在多了一维 `consumes`（传函数、每次按键现取）：访客没座位 = 不拦，拿到座位 = 立刻拦。
自测：`npm run test:scroll`（含「座位变了不重装监听也要生效」）+ `cd server && npm run test:live`
（含 `ghostRooms` 分类、停播重开不留旧房、以及三条防回退的源码断言）。

### 2.25.1 直播恢复请求必须幂等；信令断线期间不能排队发 SDP / ICE

`go-live` / `resume-live` 可能已经被服务端执行，但 ack 恰好在网络切换时丢掉。客户端重试时，
服务端若只回 `already in a room`，就拿不回 `roomId`、续播 token 和观众名单，主播界面会永久停在
“重连中”（首次开播则会直接放弃整局）。所以同一 socket 已经是该房主播时，两条事件都必须补回原成功结果；客户端的
首次 `go-live` 对 timeout / `already opening` / 临时 `failed` 做有限补试，
`resume-live` 超时或临时失败也必须在**当前已连接 socket** 上定时补试，不能等一个不会再来的
`connect` 事件。回归：`cd server && npm run test:live`、`npm run test:broadcast-signal`。

主播信令断开时，正在 `liveIceServers()` / `createOffer()` 的请求一律作废；SDP / ICE 不能进入
Socket.IO 离线队列。队列会在 `resume-live` 恢复 membership 之前冲到服务端，随后被静默丢掉。
续播拿回观众名单后只保留 `connectionState === connected` 的 PeerConnection；`new` / `connecting`
可能就是那次丢掉 offer 的半连接，必须拆掉重建。观众侧同理：`watch timeout` / `failed` /
`already watching` 是可恢复错误，socket 仍连着也要重新上闹钟，而且 `failed`、闹钟与 socket 重连
三个入口只能有一条恢复请求在飞。

手动“分享标签页”的 `ended` 监听必须在 `startBroadcast()` **之前**挂，并在开房后再复核至少一条
video track 仍是 `live`。用户可能在握手几秒内从浏览器提示条停止共享；MediaStream 仍保留那条
`readyState=ended` 的轨，不能据“轨还在数组里”误开一个永远黑屏的房间。

### 2.25.2 直播的“还在连接”不等于“还在出画面”

WebRTC 的 `disconnected` 不保证后面一定会进 `failed`。网络切换时先给它宽限自愈；
观众端 10 秒后仍没回来就主动 `rewatch()`，主播端 12 秒后收掉这路 PeerConnection，
否则会一边给空连接编码、一边让观众永久看最后一帧。远端 video track 也能在
`connectionState=connected` 时单独 `ended`，它同样必须触发恢复，不能只盯 ICE 状态。

`captureStream()` 轨结束时，canvas 节点本身可能完全没换；`captureFeed.check()` 要允许在
**同一块 canvas** 上重建新轨。转发 Worker 在拿走 generator 的 writable 之后每 2 秒报心跳，
超时则回退到原始轨：不是每种 Worker/GPU 卡死都会发 `onerror`。

手动分享只监听 **video track** 的 `ended`；音频轨单独结束只代表之后没声音，
不应把仍正常的视频直播一起关掉。主播统计读取要并行且不重入；12 个观众若串行
`getStats()` 并与下一轮叠加，自适应降帧会被重复计数、反而增加主线程压力。

### 2.25.3 直播 TURN 必须分档；Cloudflare 只能是显式末级兜底

`/api/netplay/ice` 的普通游戏联机继续保留现有多路行为；直播专用 `purpose=live` 首轮只给
STUN、自建海外 TURN（`TURN_URLS`）和仅发给大陆访客的大陆 TURN（`TURN_CN_URLS`）。大陆浏览器
同时收到两路自建候选，让真实的浏览器 ICE 收集 / 连通性检查决定可达路径；不能把候选数组顺序
宣传成 RTT 测速结果，也不能把 Cloudflare 混进首轮后声称它只会最后使用。

观众只有在 `connectionState=failed` 或 `disconnected` 宽限期耗尽后才请求
`purpose=live&fallback=cloudflare`。该请求仅返回 Cloudflare TURN，不混回已失败的自建 TURN；
拿不到有效 Cloudflare TURN 时须保留自建配置，并给临时故障设置 `retryAt`，不能把一次 API 抖动
按 `expiry: 0` 永久缓存。观众确认凭证到手后，`watch` 信令把兜底档位传给主播，由主播只为该观众
重建一条匹配配置的 PeerConnection；本次回退成功交给主播后，该观众会话不再重复使用 Cloudflare。

Cloudflare 凭证单独缓存，默认有效 15 分钟；接口另有单 IP / 全站限流。启动探针和直播首轮不可
为了预热而请求 Cloudflare 凭证。普通游戏联机需要的既有 Cloudflare 探针行为保留。服务端探针
来自源站，与大陆观众到中继的网络路径不同，因此显式末级回退不能因源站探针的 `down` 判断而
被删除；凭证接口正常时让浏览器实测自己的候选可达性。回归：`npm run test:ice-config`、
`npm run test:broadcast-signal`、`npm run test:watch-panel`、`cd server && npm run test:live`、
`cd server && npm run test:netplay:hardening`。

### 2.25.4 生产直播媒体必须经 SRS；故障时拒绝开播，不回退主播直连

生产的新直播房间音视频走 SRS SFU：主播只向 SRS 发布一路，观众从 SRS 拉流；`/live` Socket.IO
仍管理房间、弹幕和续播。直播里的 2P 按键协作仍走主播与观众之间的 DataChannel，这不是媒体流。

生产环境同时设 `LIVE_SRS_ENABLED=true` 和 `LIVE_SRS_REQUIRED=true`。前者要求新房间探测 SRS 健康并选用
SRS；后者是部署保护锁，即使启用项被误关，SRS 不可用也拒绝 `go-live`。不可把 API 故障、缺配置或
容量异常静默转为 `transport=p2p`，否则观众数增加时主播上行会按人数放大，而且绕过 SRS 容量预算。
房间创建时固定传输方式，生产部署重启会清掉旧内存房间；新房只会按这两个开关选定传输。

主机部署用 `deploy/live/srs/install-native.sh <公网 IPv4>`：版本固定、摘要校验、systemd 非 root 运行，
只开放 WebRTC UDP/TCP 8000；HTTP API 1985 必须仅监听 loopback，RTMP 1935 不开放公网。密钥只存
`/etc/8bitgo-live-srs/` 和 `server/.env`，不得提交。改动 SRS 发布 / 播放、hook、房间准入或部署时，
回归 `cd server && npm run test:live-srs && npm run test:live`，并做真实浏览器媒体发布、播放和重连检查。

⚠️ **SRS 是 ICE-lite，浏览器 offer 不需要任何候选**（2026-11-18 修正）：SRS 从不主动探测客户端候选，
只回应浏览器打到 `公网IP:8000` 的 STUN 绑定请求、按来源地址回包，官方 SDK 也是 offer 落地即 POST。
曾经的「等到 srflx 才提交、收不到就失败」是把 P2P 规则套到 SFU 上：默认 STUN 是 Google 的，
大陆网络拿不到 srflx，直播整片拉不起来，而 SRS 本身直连可达。现在 `src/services/liveSrsIce.ts`：
SRS 连接默认 `iceServers: []` + `max-bundle`、不等候选；**从没连上就 failed** 才带站点自建 TURN
（只取 turn:/turns:，绝不带 Cloudflare）重来，覆盖封了 8000 端口的网络。别再加回候选等待。
`npm run test:live-ice` 守着；浏览器验收仍须确认 PeerConnection `connected` 且观众视频帧数增长。

SRS 会话的账（`server/src/live.js` 的 `kickSrsClient` 一段）：SRS 只要客户端一直回 STUN 就一直转发，
和我们的房间成员关系无关。按 hook 的 `client_id` 记账、经回环 API `DELETE /api/v1/clients/<id>` 踢人：
同一观众新开拉流踢旧的；观众离房宽限 `LIVE_SRS_ORPHAN_GRACE_MS`（默认 45 秒，同 key 换 socket 回来可认领）
后踢；主播重新 WHIP 前先踢旧上行（否则 stream busy 要等 stun_timeout 30 秒，全房黑屏）；下播全踢。
hook 只收本机 / Docker 网桥、且不带任何反代头的请求（密钥泄露也不能从公网伪造 on_publish）。
观众换播放票走 `srs-play-grant`（不走 watch，watch 会让主播重建协作连接）；SRS 房里点对点协作通道
只在这一局有 2P 位时才建、最多 16 条，它失败只重试两次、**绝不**让视频观看报错。
回归：`cd server && npm run test:live-srs`、`npm run test:broadcast-idle`。

**SRS 房的观众不开 socket.io（2026-11-20）**：以前观众要先连上 socket.io 再 watch，大陆线路首连 4～8 秒。
现在进房是 `POST /api/live/rooms/:roomId/watch`（请求体 `{key}`），**响应体就是这位观众的事件流**
（`server/src/live.js`「不走 socket.io 的 SRS 观众」、`src/services/liveStream.ts`）：第一帧 `welcome` 带房间快照、
播放票和会话令牌，之后推 viewers / chat / srs-state / host-frozen / host-away / host-back / netplay-linked /
coop / no-source / live-ended，每 10 秒一帧 ping。换票、催主播、发弹幕各一个小 POST（`grant` / `nudge` / `chat`），
会话令牌在请求体里。几条硬规则：
- **用 fetch 读流，不用 EventSource**：EventSource 带不了请求头，登录令牌（成人房年龄门、弹幕署名）只能进 URL。
  令牌只走 `Authorization` 头，会话令牌只走请求体（§2.23）。
- 服务端的成员 id 是 `sv_…`，记进 `room.viewers` / `membership`，播放票、SRS hook、名单、人数原样复用。
  凡是拿「`nsp.sockets` 里有没有」判活的地方都要认 `isStreamViewer`，凡是给房间广播的地方都要走 `toRoom`
  （socket.io 房间一份、事件流一份）。新加房间事件时别直接写 `nsp.to(room.id).emit`，事件流观众会收不到。
- 主播收不到事件流观众的 `viewer-joined`（他们没有 socket，建不了协作连接），只收人数；人数 > 0 就开推上行。
  主播 `resume-live` 拿到的 `streamViewers` 不建点对点连接。主播手里没有画面时发 `source-missing`，服务端转成 `no-source`。
- **只有两种情况才连 socket.io**：点对点老房 / 老服务端 / 事件流名额满（503）/ 浏览器读不了流式响应，整条退回原 socket 路径；
  这一局有 2P 位（`welcome.coopOpen` 或 `coop` 事件），带同一把 key 改连 socket 再 `watch(reoffer)`。
  服务端凭 key 把事件流换成 socket（旧流收到 `replaced`），SRS 拉流转到新 id、不断，主播收到带 `replaces` 的 viewer-joined。
  房间不存在 / 满员 / 年龄门换 socket 结果一样，直接报错。
- 事件流断了（`SSE_MAX_LIFETIME_MS` 到期、网络断、25 秒没有字节）按 0.5～15 秒退避、同一把 key 重连。
  服务端在断开时立刻按离房处理，SRS 拉流挂进 45 秒宽限，重连时凭 key 认领回来。所以每 30 分钟寿命到期时人数会闪一下，画面不受影响。
  散场、报错、销毁都要先 `stopStream()`：不收的话服务端关流后客户端会去重连，拿到 not found，把「已结束」盖成「不存在」。
- SRS 房里那条点对点连接只装 2P 协作通道。`freshPc` 换它时**不能**清画面状态（`gotFrame`），否则每次协作通道重来一轮，
  20 秒后 `srsRecover` 会把好好的拉流拆掉重拉。
- 事件流观众也受 `sseGuard` 的总量 / 单 IP 名额约束（600 / 20）。超了回 503，客户端改走 socket，照样能看。

回归：`cd server && npm run test:live-stream`（真 HTTP + socket.io 主播）、`npm run test:live-stream-client`
（解析器、拒绝归类、小请求；端到端用浏览器那份客户端代码连真服务端；liveview 接线）。
2026-11-20 本地浏览器验收用的是真 `live.js`、假 SRS 和脚本化主播，经 Vite 代理验了：进房一个 POST 约 30ms、
8 秒没画面先 nudge、srs-state 一到就发 WHEP、弹幕收发、冻结、流寿命到期自动重连、2P 位改连 socket、散场、点对点房退回 socket。
**真实 SRS 的音视频拉流没有在本地验证**（这部分代码没改，只是播放票的来源换了），上线后要在生产实看一场。

生产机是从 `dist/client` 现场服务，所以 `vite.config.ts` 的 `emptyOutDir` 必须是 `false`。
2026-09-25 日志已取证到构建期 `dist/client/index.html` 短暂不存在，SSR 当场 500。
旧哈希资源留着也能保证已打开的观众页在部署期间继续懒加载；`ssr.js` 在模板
短暂读不到时要继续用内存里已有的完整模板。回归：`npm run test:watch-panel` +
`npm run test:capture-worker` + `npm run test:capture-feed` + `npm run test:broadcast-signal`。

Vite 的静态目录排除清单在 `scripts/lib/vite-static-exclusions.mjs`。除了大数据包，Dolphin 与
PPSSPP 的目录也是软链：它们的发布器只新增版本目录、不覆盖旧 URL，所以能避免每次构建
重复复制约 480 MB。js-dos / Ruffle 的脚本允许重写同版本产物，必须保留 dist 快照。
**不能把固定 URL 的 EmulatorJS 或可变网页游戏目录加进来**；
否则 git pull / build 的切换窗口会让仍在运行的旧页面拿到半更新代码。调整清单后跑
`npm run test:vite-static-exclusions`，再跑对应运行时的 `--dist` 发布检查。

### 2.26 Windows 客体（Win3.x / 95 / 98）的自动启动：**「亮 + 静止」不等于桌面**

`src/emulator/windowsLaunch.ts` 负责那条链：系统镜像（qcow2 → `boot c: -convertfat`）起来之后，
敲 `Ctrl+Esc` → `R` → 输入 `D:\8BITGO\RUN.BAT` → 回车（3.x 走 File Manager 的 File > Run）。
键是**开环**打进去的，所以「什么时候可以敲」只能靠画面判 —— 而**有两段画面的判据一模一样**：

| 那一段 | 现象 | 拦它的判据 |
|---|---|---|
| Win95 进桌面前的**纯黑图形模式** | 全黑、静止 | `frameIsBlank`（2026-09-21） |
| Win95 画出**桌面背景**、壳还没起来 | 青绿底 + 光标，**亮**、静止 | `frameHasDesktopContent`（2026-09-21） |

实测非主色像素占比（本地复现 `system-win95-v1`，640×480，抽样两万点）：

```
纯黑                    0%
纯青绿壁纸（只有光标）   0.04% ～ 0.1%
Win95 真桌面（图标+任务栏） 7.1%
Win3.11（程序管理器）    53%
```

阈值 3%：距最「稀」的真桌面还有 2 倍，距壁纸有 30 倍。

**敲早了的症状**（两版）：键落在一个还没有壳的系统上 → 全丢；随后图标和任务栏画出来
（远超 `CHANGE_RATIO`）→ 那道确认判「有反应」→ `markReady` → **既不重试也不报错**，
玩家看到的就是「打开之后停在桌面」。更早那版是键被 BIOS 缓冲、晚些才交给桌面，
`run` 里的 `r` 变成桌面上的逐字母定位、选中回收站，最后那个回车把它打开了 ——
也就是玩家报的「打开之后是回收站」。

⚠️ 这两道闸**只决定什么时候可以敲**，不参与成败判定，而且**只会推迟**敲键：
认不出来的桌面等满 `waitSeconds` 上限照样敲，最坏情况退化成「没有这道闸」的老行为。

⚠️ 本地复现 harness：`public/__win95-test.html?sys=/__win95.jsdos`（3.x 加 `&ver=3x`）——
它 import 的是**真实模块**（windowsGuest / jsdosBundle / windowsLaunch），逐帧记下
尺寸 / 是否黑屏 / 帧间差异 / 非主色占比，并把每次按键连同时间戳记下来，缩略图落在
`window.__probe`。上面两张表和两个 bug 都是靠它抓的。镜像自己准备（Win95 约 33MB、
Win3.11 约 21MB），**别提交进仓库**；小游戏层 `public/__win95game.zip`（77 字节的合法 MZ）
可以直接用。
⚠️ 用它时注意 `hideJsdosConfigForLayer` 是**原地改名**的，只能调一次（第二次就找不到
`.jsdos/dosbox.conf`，报「系统镜像缺少 dosbox.conf」）。

回归：`npm run test:dos-bundle` 的「桌面到底画完了没有」/「开机黑屏」/「壁纸静止」三节。

### 2.26.1 Win3.x 客体的「白窗口」：被压住的 MIDI 警告框，不是 16 色问题

2026-10-27《经典食人花》（zeek-the-geek）：片头过后只剩一扇纯白的「Zeek Part 1」窗口，没菜单、
没棋盘、无报错。真因是游戏一启动就用 MCI 播 MIDI，Win3.1 的 MCISEQ.DRV 弹
「This file may not play correctly with the default MIDI setup」，**这个对话框被游戏主窗口压在下面**，
游戏的 MCI 调用要等它关掉才返回。把游戏窗口最小化才看得到它；勾「不再提示」后 Windows 往
SYSTEM.INI 写的是 `[mciseq.drv] disablewarning=true`。

修法在 `src/emulator/win3xSystemIni.ts`：所有 Win3.x 客体开机前，在主线程解出系统包里的 qcow2，
按 qcow2 → MBR → FAT16 找到 `WINDOWS\SYSTEM.INI` 补上这一行（只在现有簇链里写，不分配新簇），
再把系统包里那一项**换成**改好的 qcow2（stored）。线上镜像实测约 50～100ms。任何结构意外都放行，
退回原镜像启动。

⚠️ 不能用 initFs 的 `{ path, contents }` 单独覆盖：js-dos 先把 file 层写进 worker，bundle 层到
wc-run 才解，系统包里的原版 qcow2 会反过来盖掉它（实测）。也不能在 ci-ready 后再改：那时 DOS
已在开机，和 SMARTDRV 的缓存赛跑。

⚠️ 2026-09-11 把这个白窗口误判为「16 色游戏在真彩桌面画不出来」，换了 system-win311-vga-v1。
VGA 镜像保留（640x480 下游戏窗口正好铺满画布），但它从来不是白窗口的解药。

回归：`npm run test:win3x-ini`（现场合成 qcow2 + FAT16 小盘；本机有 sysimg.local 时顺带验真镜像）。

### 2.27 「按语言切换 ROM」的槽里可能是**同一份 ROM** —— 切换器在骗人

玩家反馈（2026-09-21，英文）：「Pokémon 几乎只有日文，虽然有切换语言的选项，但选了也没变化」。
查下来是**数据**问题，不是切换逻辑的问题：`romCandidates()` 老老实实按语言取了不同的 key，
问题是那些 `<slug>.<lang>.<ext>.8bg` **其实是同一份 ROM 被重复打包了 N 遍**。

**怎么在不拿密钥的情况下证明**（这是这套判据的关键）：

- 8BG 头带 `originalName`，还带每块的 `sha256` —— 那个摘要是**算在明文上**的
  （`scripts/pack-rom.mjs`：`createHash('sha256').update(source)`）。
  所以「所有块的摘要逐一相同」＝两份文件解密后**逐字节相同**，不需要密钥。
- 密文**不能**用来比：nonce 是每文件随机的（`randomBytes(8)`），同一份明文打两次密文也不同。
- 只读前 1MB 就够：头和分块表都在最前面。

**要知道「这份内容到底是哪国语言」**（`--deep`）：从 `/api/rom-pack/key` 取密钥
（浏览器解包用的同一个公开接口）解密第一块，再读平台自己的头：

- GBA：游戏码在 `0xAC-0xAF`，末位 `J`=日 `E`=美 `F`=法 `D`=德 `S`=西 `I`=意 `P`=欧；
- GB/GBC：`0x14A` 目标码，`0`=日版、`1`=海外版。

⚠️ **`originalName` 不可信**，别拿它当语言：实测 `pokemon-emerald.ja.gba.8bg` 里装的是
`BPEE`（美版英文），而 `originalName` 写着 `pokemon-emerald.zh-Hans.gba`。
⚠️ **只有一个语言槽也会撒谎**：`pokemon-red` 只绑了 `zh-Hans` 一个槽，里面却是日版
（GB 目标码 0）。所以「槽少」不等于「标签对」。

**2026-09-21 实测范围**：394 款游戏里 133 款绑了两种以上语言，其中 **114 款（86%）**
存在「多个槽内容相同」。典型：Pokémon Emerald / Ruby / FireRed 的 8 个槽全同；
**Sapphire 的 8 个槽是 `AXPJ`（日版）** —— 正是那位玩家说的「只有日文」；
大量 NES 游戏是 `en`/`es`/`zh-Hans` 指向同一个文件。

**工具**：`npm run audit:rom-langs`（默认只报「多槽同内容」，发现即退出码 1）

```bash
npm run audit:rom-langs                          # 全量普查
npm run audit:rom-langs -- --deep                # 再逐组解密，报出真实语言（gb/gbc/gba）
npm run audit:rom-langs -- --slug=pokemon-ruby   # 单款（清理时用）
```

⚠️ 清理是**人**的决定，别让脚本猜该留哪个槽：Sapphire 唯一真正的 ROM 就是日版那份，
把 8 个槽删到只剩哪个、要不要留 `zh-Hans` 这个标签，都得看后台实际有哪些文件。
⚠️ 同一次普查还顺带发现两处**死链**（不是本问题，但要单独修）：
`taiko-no-tatsujin-web` 的 8 个槽全指向同一个外链（HTTP 404）、
`pokemon-white` 的 `zh-Hans` 指向 `roms/nds/中文.zh-Hans.nds`（404）。

### 2.28 自托管网页游戏放 `public/web/<名字>/`，访问地址 `https://8bitgo.com/web/<名字>`

（2026-09-21 上 PvZ Portable 时定的约定。）

三条硬性要求，缺一条就是「页面打不开」或「资源全取错」：

1. **`public/web/<名字>/` 里放 `index.html` + 资源**，URL 是 `/web/<名字>`（**不带尾斜杠**，
   这是站点 canonical 的写法 —— `normalizeUrl` 会把尾斜杠 301 掉）。
2. **必须在 `server/src/index.js` 里加一条 `app.get(['/web/:name', '/web/:name/'])`**，
   而且**要注册在 `express.static` 之前**。两个原因：
   - 静态中间件是 `index: false`（首页归 SSR），目录 URL 不会自动吐 index.html，
     它会一路走到 SSR 兜底（那条 catch-all 吃掉所有非 /api 的 GET）→ 渲染成「页面不存在」；
   - 静态中间件对**目录**请求默认先 301 补尾斜杠，而 `normalizeUrl` 又 301 去掉尾斜杠 ——
     两条互相踢皮球，就成了**无限重定向**。`/assets`、`/fonts`、`/bios` 这类目录 URL
     今天就是这个样子（只是没人访问才没被发现），所以 `express.static` 也顺手加了
     `redirect: false`，尾斜杠的规范化统一归 `normalizeUrl` 一家管。
3. ⚠️ **HTML 里必须加 `<base href="/web/<名字>/">`**。页面里的相对路径
   （`pvz-portable.js` / `pvz-portable.wasm` / `jszip.min.js`）在「目录 URL 不带尾斜杠」时，
   浏览器会把 `PvZ` 当成**文件**，相对路径按 `/web/` 解析 → 全部 404。
   实测症状：`window.JSZip === undefined`、wasm 从 `/web/pvz-portable.wasm` 取（404），
   而页面自己的导入界面照常显示，看起来像「引擎没起来」而不是「路径错了」。
   换名字 / 换位置时要一起改这一行。

缓存：`cache.js` 里 `/web/` 走 `CACHE.engine`（固定 URL，既不永久缓存也不走兜底那一档）。

⚠️ **PvZ2 Gardendless 是例外：`public/web/PvZ2/` 约 722MB，整目录被 Git 忽略。**
生产机上的目录会跨 `git pull` 保留，所以旧 `index.html` 也不会自动更新；曾因此缺少
`<base href="/web/PvZ2/">`，让 `npm run build` 在预检阶段退出，后面的服务重启根本没有执行。
入口模板的唯一来源是 `scripts/lib/pvzge-index.mjs`。`prebuild` 会先跑 `pvzge:prepare`，只对
已安装目录幂等重写这份小入口（不联网、不碰大资产），然后再由 `check-pvzge.mjs` 严格校验。
没有安装过 PvZ2 时必须继续跳过，不能因普通构建创建一套只有 index.html 的残缺运行时。

**当前内容：PvZ Portable（WASM 0.2.3）**。上游升级时保留这些本地集成：

1. jszip 从 `cdn.jsdelivr.net` 改自托管 `jszip.min.js`（3.10.1，MIT，保留许可证头）——
   站点其它引擎都自托管，而且 jsdelivr 在国内常不可用，导入 `main.pak` 会直接失败；
2. 上面那个 `<base>`、wasm preload、脚本加载失败回报和中文 `lang`；
3. 上游内联运行逻辑已抽到共用的 `pvz-page.js`，里面还有 ZIP 安全限制、IDBFS 存档保护、
   流式数据包和退出守卫，不能用新版 HTML 的旧内联脚本覆盖回来。

⚠️ 上游**不含任何游戏素材**（PopCap/EA 的 `main.pak`、`properties/` 都要玩家自己买），
页面上的「拖 ZIP / 文件夹导入」就是让玩家提供这些文件的（存 IndexedDB）。
⚠️ 想上架成游戏：平台选 `html5`，ROM 绑 `/web/PvZ`（html5 适配器把入口塞进 iframe，
同源相对路径可以直接用）。

`npm run pvz:check` 会锁定 0.2.3 的 JS / WASM / JSZip 哈希，并检查上述集成和 dist 产物。
升级上游时先核对变更、更新哈希，再跑 `npm run test:pvz`，不要为了让检查变绿直接改摘要。

### 2.28.1 PvZ 资源加载：2117 个 reanim 已合成一个可流式解包的 gzip

**自动加载片段的唯一来源是 `scripts/pvz-web/autoplay-snippet.html`**；资源导入、存档和退出处理的
唯一来源是 `public/web/PvZ/pvz-page.js`。`cn/` 和 `en/` 共用后者，自动片段则是生成产物。
**改了片段必须跑 `npm run pvz:sync-snippet`**，否则 snippet 和线上页面会悄悄分叉。

旧清单是 2122 项 = `main.pak`（约 44 MB）+ `reanim/` 2117 个（103.7 MB）+ `properties/` 4 个。
现在用 v2 清单：5 个普通文件 + 一个约 48.7 MB 的 `reanim-<sha>.pvzpack.gz`。浏览器用原生
`DecompressionStream('gzip')` 边解压边写 WASM FS，冷启动从 **2122 个请求 / 约 148 MB** 降到
**6 个请求 / 约 93 MB**；不会像 JSZip 那样同时把压缩包和 2117 个解压结果全留在内存。

⚠️ **2026-09-23 事故（致命）**：`reanim/` 在存储端一个都没有。旧版要么在第一个 404 处
整批失败，要么拿半套资源强行启动后 `CppException` / 黑屏。现在 **`main.pak` 和 reanim 流式包
都是必需资源**：任一个缺失就立即终止并点名 URL，不再进入必然崩溃的原生引擎。
内容寻址对象的记录在 `public/web/PvZ/pvz-pack.json`。

⚠️ **路径按 `PVZ_DATA_BASE + r2` 计算。** 当前 DATA_BASE 已经是
`https://download.8bitgo.com/PvZ/properties/`，所以清单只能写 `main.pak` / `en-main.pak` /
`packs/...`。旧生成脚本又加了一层 `properties/`，请求会变成
`PvZ/properties/properties/main.pak`；`scripts/pvz-pack-data.sh` 已修正。

打包与上传（大包不进 git，留在 `.pvz-data/`）：

```bash
npm run pvz:pack -- --reanim <reanim目录> --cn-main <中文main.pak> --en-main <英文main.pak>
npm run pvz:upload -- --dry-run       # 本地长度、SHA、两份清单一致性
npm run pvz:upload -- --probe         # 只读验证 Worker 地址与口令，不上传
npm run pvz:upload -- --yes           # 写入公开 R2，必须显式确认
npm run pvz:check-assets              # 线上 HEAD + CORS 验收
```

上传器默认读 `server/.env` 的 `ADMIN_TOKEN`；若 Worker 使用另一把口令，用环境变量
`PVZ_R2_TOKEN` 临时提供，别把它写进命令参数或提交进仓库。

加载器还修了这些严重问题：

1. 英文清单以前把中文 `main.pak` 写进 `/main.pak`，又多下载一个引擎不读的 `/en-main.pak`
   （多浪费约 43 MB）；现在英文 R2 `en-main.pak` 正确映射到 FS `/main.pak`。
2. 每个下载都校验长度 + SHA-256；缓存也校验 r2 / 长度 / SHA，截断对象或错误 HTML 不会永久
   毒化 IndexedDB。中英文主包分开缓存，reanim 和配置共用，避免双份占空间。
3. IndexedDB 在 Safari 私密模式或配额不足时，下载结果直接从内存启动本局；旧实现缓存写失败后
   又只从缓存回读，明明资源已下完仍会报「缺 main.pak」。
4. 下载有 30 秒无响应超时、两次网络重试和必需资源失败后的整池取消；写 WASM FS 每 4 MB
   让出主线程，并在写完一项后释放 JS 数据，降低移动端 OOM 风险。
5. ZIP / 文件夹导入限制文件数、单文件和解包后总大小，并拒绝 `..` / 绝对路径；旧版存档 ZIP
   能写出 `/saves/userdata`，压缩炸弹也能直接吃光浏览器内存。
6. IDBFS 首次读取失败会阻止启动，避免空存档随后覆盖旧存档；并发 sync 合并成串行队列，正常
   退出先等最终写盘。旧版忽略首次 sync 错误，且退出后立即 reload，最近进度可能丢失。
7. 旧退出守卫写成 `guard() || reload()`：守卫拒绝刷新时反而执行右边的强制 reload，完全失效；
   启动计时还早于资源写盘，慢设备一开局崩溃也会被当成正常退出。两处均已修。

另外两条容易忽略的：

- wasm 约 7MB，用 `<link rel=preload as=fetch crossorigin>` 与 js 并行下载；`moduleReadyPromise`
  有 120s 超时，脚本标签也有 `onerror`，不再永远卡在「Preparing WebAssembly runtime…」。
- 根目录那份 `pvz-manifest.json` 没有任何代码引用；`cn` / `en` 只读各自的 v2 清单。

**Pages 网页游戏的就绪预算是「连续 120 秒没有进展」（2026-11-19，诊断包 #1220）**：生命周期桥
`public/html5-api/8bitgo-runtime-bridge.js` 以前从安装起固定给 120 秒。日本 6.8Mbps / RTT 300ms 的玩家首次要下约 93MB，
下载途中就被判失败，播放器重试后又从头等 120 秒，248 秒时第二次失败。现在桥多了 `reportProgress(ratio)`：调一次就重新给满预算，
并按秒节流给父页发 `progress`（适配器转成 `starting` 阶段的 onProgress，只喂播放器的启动看门狗，不推进度条）。
PvZ 自动加载片段的 `setProgress()` 按下载字节调用它。没接进度的游戏行为不变。桥是随 Pages 构建复制进各游戏子域的，
**改了桥必须重新构建并发布对应的 Pages 项目**（`npm run pages:web-games:build -- pvz` → 发布），只部署主站不生效。
回归：`npm run test:html5-runtime-bridge`。

首次自动加载使用 `public/web/PvZ/pvz-loading.css` + `pvz-loading-scene.webp` 的 4:3 游戏启动画面，
进度木牌读取的仍是 `setProgress()` 的真实下载 / WASM 写盘比例，不准换成与下载脱节的假动画。
画面挂在 `#drop-zone.loading` 下，因此必需资源或引擎失败后移除 loading class 就会回到原资源选择页；
不要让视觉层盖住错误回退。外壳由 `scripts/pvz-web/inject-autoplay.mjs` 注入中英文入口，修改后要
同步 bump `SHELL_VERSION`、`src/emulator/adapters/html5.ts` 的 `PVZ_SHELL_VERSION`，再运行
`npm run pvz:sync-snippet`，否则 Pages / iframe 可能继续命中旧 CSS。

PvZ 中英文入口从 `https://download.8bitgo.com/PvZ/properties/` 获取游戏资源；下载域 Worker
会将 `PvZ/properties/` 路径映射到网页游戏资源桶。Pages 构建仍把 `PVZ_DATA_BASE` 改成同源
`/pvz-data/`，再由 `deploy/cloudflare-pages/web-game-worker.js` 从下载域流式转发并保留 Range / ETag。
本地验收必须用 `wrangler pages dev .cloudflare-pages/pvz`，普通静态服务器不会执行这条代理。

⚠️ 清单里的 `properties/` 是可选覆盖配置，全部 404 时允许使用引擎内置默认值；`main.pak` 和
reanim 包才是启动硬条件。旧 `pvz-page.js` 虽然下载层按可选处理，`startGame()` 却又强制要求
`properties/`，结果真实资源跑到 100% 后退回导入页。自动清单成功后只通过
`allowBuiltInProperties` 放宽这一次启动，玩家手动导入仍要求完整 `properties/`，避免误放残包。

验收：

```bash
curl -sI https://8bitgo.com/web/PvZ | head -3
curl -sI https://8bitgo.com/web/PvZ/pvz-portable.wasm | grep -i content-type
npm run pvz:check && npm run test:pvz && npm run pvz:check-assets
```

### 2.28.2 PvZ iPhone / iPad 软键盘：必须在可信触摸事件里再次聚焦

PvZ Portable 的 WASM 会在文字框打开时调用 `WasmStartSoftKeyboard()`，把
`Module.wasmSoftKeyboardState.active` 设为 true，再聚焦 `#pvz-soft-keyboard`。桌面浏览器没问题，
但 SDL 先把触摸放进队列、游戏到下一帧才处理；iOS 此时已经离开用户手势调用栈，会静默拒绝
`focus()`，表现为 New User 页面点名字输入框完全不弹键盘。

修复在 `public/web/PvZ/pvz-page.js` 的 `installMobileSoftKeyboardAssist()`：只在 WASM 已明确进入
文字输入状态时，允许下一次画布触摸在同步事件里重聚焦；同时显示一个 44px 的「打开键盘」按钮
作为兜底。**不要改成每次点 Canvas 都 focus**，否则正常种植物也会反复弹键盘。Canvas 自己有
`tabindex`，会在 pointerdown 后抢回焦点，所以最终还必须在合成 `click` 阶段校正一次。

隐藏输入框也不能用 `display:none` 或完全透明；部分 iOS 版本会把它判定为不可交互。当前保持
1px、`opacity:.01`、`font-size:16px`（避免 Safari 自动放大）并禁用指针命中。改外壳后同步提升
`PVZ_SHELL_VERSION` 和 `pvz-page.js?v=`，否则 Cloudflare 仍可能发旧脚本。回归：
`npm run test:pvz` 的触控用例会验证按钮显隐、按钮聚焦和 Canvas 重聚焦。

### 2.28.3 PvZ 云存档自动同步

PvZ Portable 的游戏存档在跨源 iframe 的 IDBFS `/saves/userdata`。本地仍每 5 秒落 IndexedDB；
站内云同步只在玩家已登录且存档落点明确选为「云端」时开启。由 `pvz-page.js` 对排序后的存档文件
内容计算指纹，实际内容变化并短暂静稳后才打 ZIP，经精确来源的存档桥交给主站；不能把登录令牌传给
PvZ 子页，也不能把每次 IDBFS 检查都当成一次游戏存档。

开局先严格读云端：待补传的本地档优先；云端读失败不能伪装成“云端没有存档”。有版本冲突、
配额阻塞或云端读取不确定时，保留游戏 iframe 的本地进度并暂停自动上传；手动确认覆盖成功后才恢复。
玩家手动从文件 / 本地存档恢复后也要暂停云端回填，避免重启时刚导入的进度被云端盖掉；明确读取云端或
手动云端保存成功后再清除暂停。自动上传使用通用 `pushSave()` 的 revision 条件写和待补传队列。

开局用云端前先比对（2026-11-21，PvZ 与 Gamblers Table 同一套，batterySync 同款）：iframe 在自己的 localStorage
按账号（uid 的 FNV 散列，`cloudSaveAccountTag()`，绝不是令牌）记「上次与云端同步的内容指纹」。本地没变过才用云端；
云端没变过就保留本地并补传；两边都变过（含首次同步两边都有档）记冲突：本地留在游戏里、云端不动、本会话暂停自动同步，
经 `auto-conflict` → `recordAutoSaveConflict()` 走既有冲突提示。只有状态 `saved`（不是 `queued`）才更新指纹。
拆播放器时 `html5.ts` 先发 `auto-final-snapshot`、最多等 1.5 秒 `auto-final-done`，监听再多留 1.5 秒接 pagehide 快照；
播放器的 `onHtml5AutoSaveSnapshot` 因此不能拿 `isCurrent()` 挡上传（换局时会话代次已前进）。
自动推送遇到「本浏览器从没见过的云端版本」按冲突处理，不再拿服务端当前 revision 当父版本；手动「存到云端」仍可覆盖。
改 `pvz-page.js` 或存档桥时同步提升
`PVZ_SHELL_VERSION`、`scripts/pvz-web/inject-autoplay.mjs` / `scripts/check-pvz.mjs` 的版本以及
中英文入口引用，并更新本节；`cn/` 与 `en/` 的运行脚本来自 `pvz-page.js`。

**cs15（CS 1.5 网页移植，2026-09-21 接入中）**：只有 `public/web/cs15/packs/` **不进 git**
（见 `.gitignore`）——`base.zip.gz` 是 550M 的 Valve 游戏数据，超 GitHub 单文件上限，也不能公开发布；
数据包放 R2 / 服务器本地。加载器、引擎和开源 wasm 运行时必须跟踪，否则生产机执行
`git pull && npm run build` 仍会发布旧加载器。`vite.config.ts` 的 `skipHugeStatic` 也只能跳过
`web/cs15/packs`，不能再跳过整个 `web/cs15`。路由不用加：`/web/:name` 是通用的。

⚠️ **生产入口必须有 `<base>`。** 通用路由会把 `/web/cs15/` 规范化成无尾斜杠的
`/web/cs15`；没有 `<base href="/web/cs15/">` 时，浏览器会把 `./cs15.bundle.js` 算成
`/web/cs15.bundle.js`。`helf-life` 同理，且它的 `../cs15/` 会被误算到站点根目录。

⚠️ **基础包必须边解压边写 FS。** 解压后 ZIP 约 1.1GB；若先 `arrayBuffer()` 整包再解析，
550MB gzip + 1.1GB ZIP + Emscripten FS 文件副本会同时驻留，浏览器极易被系统杀掉。
当前 pack 的 ZIP 条目必须保持 `store`（method 0）且不能用 data descriptor，加载器按本地头顺序
流式写入。它还会检查 gzip 魔数，以兼容对象存储下发原始 gzip 和服务器透明解压两种情况。

⚠️ **「没刀 / 没雷达 / 数字键不切枪」先看有没有真的出生。** 2026-09-23 曾把这三个现象
误判成 cs16-client 的 slot 构建缺陷；直接检查 wasm 后，当前客户端其实完整导出了
`CHudAmmo::UserCmd_Slot1..10`、`CHudAmmo::SlotInput`、`g_weaponselect` 和 `CL_CreateMove`。
真凶是加载器用 `+map` 开监听服时没给 `maxplayers`：唯一客户端先占满服务器槽位，T/CT 都报
`team is full`，玩家一直在观察状态，客户端自然没收到 WeaponList / CurWeapon，SlotInput 会按设计返回。

修法已经写进 `cs15.js`：CS 启动参数带 `+maxplayers 8`，并默认 `_vgui_menus 0`（CS1.5 资产
没有完整 CS1.6 VGUI2 资源）；`?vgui=1` 只留作排查。验收不能只看观察视角能否移动：要实际选队、
选人物并出生，然后确认左上雷达出现，数字 3 显示刀、数字 2 显示手枪。无头浏览器实测日志应有
`8 player server started`；若又变回 `Game started`，说明 maxplayers 参数丢了。

当前基础包没有默认三张图对应的 CZ `.nav`，而服务器 wasm 内置了 CZ Bot。默认进入地图后执行
一次 `bot_add`：首次约 20 秒自动分析并生成导航，写入 IndexedDB；以后在加载 pack 后、启动服务器前
把缓存恢复到 `cstrike/maps/<map>.nav`，不会重复分析。主键盘 `+` / 小键盘 `+` 都会执行
`bot_add`，`?bots=0` 才关闭。缓存键必须包含 `ASSET_VERSION`，换地图包或服务器 wasm 时 bump 版本，
不能继续复用旧 nav。

`lib/cstrike/dlls/yapb_emscripten_wasm32.wasm` 不是当前的 Bot 实现：它导出的是 `Meta_Attach`，
属于 Metamod 插件；基础包没有 Metamod，所以仅把它写进 FS 并不会加载。现在实际使用的是
`cs_emscripten_wasm32.wasm` 内置的 CZ Bot（`bot_add` / `bot_quota` / `bot_nav_analyze`）。

### 2.28.2 CS1.5 的 550MB 不是 gzip 不够狠：先去掉 900MB 错装内容，再用 HTTP Brotli

旧 `base.zip.gz` 下载 550MB、展开 1.05GB，其中混入约 283MB 其它地图、完整 289MB
`valve/pak0.pak`、桌面 DLL/SO、回放和大量自定义地图素材。只换 zstd/Brotli 仍会让这些垃圾常驻
MEMFS；而项目里的 `@bokuweb/zstd-wasm` 只有整包 API，会再造一份约 1GB 的 JS 缓冲区。

`npm run cs15:repack` 会先把 PAK 还原成可筛选文件（外层同名散文件优先，保持 GoldSrc 覆盖语义），
再输出公共 CS 运行时 + 三个单地图 store ZIP。当前结果：公共包 158.6MB 原始 / 62.1MB Brotli；
de_dust2、de_dust、cs_office 主包分别约 2.5MB、2.1MB、7.2MB。Brotli 设 quality 11 / window 24，
是发布期一次性成本；`npm run test:cs15` 会把 `.br` / `.gz` 全部解码，逐文件验 CRC，再核对文件数、
展开字节数和整份 ZIP SHA-256。

R2 上 `.zip.br` **必须**设置 `Content-Type: application/zip` + `Content-Encoding: br`。这样浏览器
HTTP 栈原生流式解码，加载器收到的首字节直接是 `PK`；若忘了 Content-Encoding，加载器会明确报错
并自动改用清单里的 `.zip.gz`（gzip 对象故意不设 Content-Encoding，由 DecompressionStream 解）。
包名带内容哈希并可缓存一年，`index.json` 必须最后上传且设 `no-cache`。自动上传：
`npm run cs15:upload -- --bucket <R2桶名>`；完整 CORS/验收说明见 `public/web/cs15/PACKS.md`。

生产加载器默认读 `https://assets.8bitgo.com/web/cs15/packs`，localhost 才读本目录；临时桶可用
`?packsroot=` 覆盖。加载器只接受安全的清单文件名、store ZIP、无 data descriptor 条目，边写 MEMFS
边验 ZIP CRC，并以清单的文件数/总字节作第二道约束。改 `cs15.js` 或 `zip-stream.js` 后必须
`npm run cs15:bundle && node scripts/check-cs15.mjs`；构建前后也会自动查源码与 bundle 是否一致。

### 2.28.3 CS1.6 黑屏：运行时必须随代码部署，基础包必须流式展开

2026-09-23 线上 `/web/cs16` 返回 200，但 `cs16.bundle.js`、引擎 wasm、客户端 wasm 和基础包
全部 404。根因有两层：这些运行文件从未进仓库；根 `.gitignore` 的通用 `dist` 规则还会误伤
`public/web/cs16/engine/dist/`。本地文件齐全不代表生产机执行 `git pull && npm run build` 后也有。
现在引擎、`lib/`、`gfx/`、bundle、Zstd 解码器和 `runtime.json` 必须跟踪，只有
`public/web/cs16/packs/` 保持忽略。构建前后的 `scripts/check-cs16.mjs` 会逐文件核对同源运行时的长度和 SHA-256，
且拒绝历史遗留的「整个 cs16 目录是开发机绝对软链」产物。运行期再查关键文件，缺任一项
直接返回 503 维护页，不能把缺文件伪装成游戏黑屏。

旧 `base.zip.gz` 解压后约 823MB。先整包 `arrayBuffer()`、再展开、再写 MEMFS 会让压缩包、解压包
和虚拟盘副本同时驻留，峰值超过 1.6GB，浏览器渲染进程会被系统杀掉。即使只改成流式，完整
823MB 仍会占满 MEMFS，真实浏览器在 `xash.main()` 处明确报 `Aborted(OOM)`。第一轮只去掉其它地图，
公共包展开后仍有 346MB，真实浏览器照样 OOM，所以不能把“流式解压成功”当成修好。现在拆成约
75MB 的 `packs/base.tar.gz`（展开 132MB）和 `packs/maps/<地图>.tar.gz`（只加载当前一张），并剔除
浏览器永远不会加载的原生 DLL/SO、HL 单人地图/模型/对白、原声、视频、菜单背景和无关天空/WAD。
首次传输从约 430MB 降到约 110–140MB，写盘从 784MB 降到约 135–175MB。

加载器用 `DecompressionStream` + USTAR 解析器边解压边写，每次只额外保留当前文件；解析器还验证
头校验和、总大小和路径，避免外部 `packsroot` 用 `../` 覆盖动态库。查询参数里的地图名有白名单，
不能拼任意包路径。重新生成全部 13 个包用 `npm run cs16:repack`。

`cs16.js` 不是浏览器入口，改完必须跑 `npm run cs16:bundle`；再跑
`npm run cs16:manifest` 更新清单。生产数据包走 R2，不再要求应用服务器保留被忽略的 `packs/`，
所以新机器 `git pull && npm run build` 不会因为缺游戏数据包失败。数据包在打包机单独验收：

```bash
npm run test:cs16
npm run build:client                   # 末尾必须显示 CS16 部署产物完整
curl -I https://8bitgo.com/web/cs16/cs16.bundle.js
curl -I https://8bitgo.com/web/cs16/engine/dist/xash.wasm
curl -I https://assets.8bitgo.com/web/cs16/zstd-v1/catalog.json
```

页面只有探测到第一帧非黑画面后才撤加载层；必需 wasm 404、响应停滞、引擎提前退出、WebGL 上下文
丢失和 60 秒内没有首帧都会显示可读错误，不能再静默露出黑色画布。数据包很大，部署后要清理
Cloudflare 的 `/web/cs16/*` 旧缓存，至少清掉入口、bundle 和所有曾返回 404 的 URL。

⚠️ **首帧后的 WASM 崩溃不能轮询 `xash.exited` 判断。** 包装器只在页面主动调用 `quit()` 时改这个
字段，核心自己的 `abort` / `exit` 不会碰它；旧轮询因此会安静地留下黑屏。启动器必须同时接住
Emscripten 的 `onAbort` / `onExit`，并把已经隐藏的 overlay 重新显示。页面离开期间的正常销毁要用
`beforeunload` / `pagehide` 排除，避免把导航误报成崩溃。

⚠️ **浏览器事件回调里抛出的 WASM trap 也不会走 `onAbort` / `onExit`。** 2026-10-18 的现场是
`RuntimeError: remainder by zero`，主循环停掉后只剩黑屏，符号地址落在旧客户端的
`CHudRadio::Voice` / `MsgFunc_BotVoice` 附近。入口必须同时监听 `error` 与 `unhandledrejection`，但只接
`WebAssembly.RuntimeError` 或明确 trap，不能把 MetaMask 等扩展异常误报为游戏崩溃。

WebGL 默认 framebuffer 没有 `preserveDrawingBuffer` 时，浏览器合成后 `readPixels` 可能一直是黑色，
不能只靠像素探测决定何时撤加载层。`Custom resource propagation complete` / 进入选队脚本说明服务端、
客户端和渲染器均已完成初始化，可作为首帧兜底。原包没有这些地图的导航文件，页面不能承诺
`bot_add` 可用；补齐与当前客户端匹配的导航数据前不要把这句加回来。

⚠️ **Xash 1.2.2 的主 WASM 原版把内存写死为 initial=256MB / maximum=256MB。** 即使公共包已经
压到展开 133MB，地图启动时给渲染器、模型和动态库分配内存仍会 `Aborted(OOM)`。运行
`npm run cs16:engine-patch` 同时把 WASM maximum 原位改为 512MB，并把胶水层原来“任何扩容都
直接 abort”的 `_emscripten_resize_heap` 接到已有的 `growMemory()`；initial 不变，所以浏览器仍
按需增长。两半缺一不可：只改 WASM maximum，真实浏览器仍会 OOM。补丁是幂等的；
`check-cs16.mjs` 会解析 WASM memory section 并检查胶水层扩容分支，少任一半就让构建失败。
引擎和动态库的内部 fetch 也必须带 `ASSET_VERSION` 查询串；只给入口 bundle 加版本不能刷新
已经被浏览器或 Cloudflare 缓存的旧 `xash.wasm`，表现会是补丁明明部署了，玩家仍在 256MB 处 OOM。

### 2.28.4 CS1.6 的 R2 包用 16MB 独立 Zstd 帧，不能压成一个大帧

真实基准（2026-09-23，公共 TAR 140,892,160 字节）：gzip 6 是 79,231,763 字节；Zstd 22
单帧是 53,136,405 字节，但它的解压窗口达到 **128MB**。在 Xash 的 256–512MB WASM 内存、
134MB MEMFS 和浏览器 JS 堆之外再加这块窗口，移动端很容易重现黑屏。现在按 16MB 原始 TAR
切独立 Zstd 22 帧，合计 55,799,442 字节（约 53.2MiB），只多 2.7MB，却把每次解压的输入、
输出和窗口限制在一片内；加载器只并行两片，消费后立刻删除 Promise 引用，不能让整包常驻 JS 堆。

产物格式是 `public/web/cs16/packs/zstd-v1/catalog.json` + `chunks/<压缩SHA256>.zst`。每片同时记录
压缩字节和解压字节的长度、SHA-256；浏览器逐片双校验，失败最多重试三次，再把原始片按顺序喂给
USTAR 解析器。新浏览器优先用原生 `DecompressionStream('zstd')`，不支持时才加载 246KB 的
`zstd.wasm`；不能退回“整个包交给 `@bokuweb/zstd-wasm`”的写法，那会重新制造百 MB 临时缓冲区。

⚠️ 长度校验发生在下载完成后，**不能拿它代替下载上限**。一份误传的 catalog 若把某片长度写成
几 GB，旧加载器会先把整片塞进 JS 堆，随后才比较长度，页面已经 OOM。`pack-guards.js` 同时限制
catalog、单片压缩/解压体积、基础包/地图总量和片数；`fetchBytes` 还要在流读取过程中执行硬上限。
gzip 应急包也必须把对应包上限传给 TAR 解析器，不能只保护 Zstd 主路径。

⚠️ 分片重试救不了解码器或 catalog 的单次失败：曾经兼容解码器在两片大资源开始下载后，才从
应用域名单独取 `zstd.wasm`；部分 HTTP/2 线路会让这个 246KB 小请求连续 30 秒拿不到正文，而 base
与地图共用同一个失败的初始化 Promise，结果两边三次重试一起耗光。现在构建用 esbuild 的 binary
loader 把解码器直接内联进已成功到达的入口包，不能再改回运行时下载。catalog 最终失败仍会清掉
Promise，给随后正式加载一次重新建连机会。

生成、验证、上传：

```bash
npm run cs16:repack
npm run cs16:zstd
npm run test:cs16
npm run cs16:upload -- --bucket <R2桶名>
```

上传器先放所有内容寻址分片，最后才替换 `catalog.json`，避免清单短暂指向 404。分片必须设
`Content-Type: application/zstd` 和一年 immutable，**绝不能设 `Content-Encoding: zstd`**；否则
浏览器网络层会先动字节，应用层 SHA 校验和兼容解码都会失效。`catalog.json` 设 `no-cache`。
生产先走 `https://download.8bitgo.com/web/cs16/zstd-v1/`，失败回退 `https://assets.8bitgo.com/web/cs16/zstd-v1/`（见下条），localhost 默认本地；`?packsroot=`
可指临时域名，`?packformat=gzip` 只用于旧包应急。R2 CORS、Cache Everything 和验收步骤见
`public/web/cs16/PACKS.md`。

**CS1.5 / CS1.6 数据包先走优选线路（2026-11-16）。** `download.8bitgo.com` 是 DNS-only CNAME 到第三方优选 IP
（`youxuan.cf.090227.xyz`），挂的是同一个 ROM Worker，`web/cs15/`、`web/cs16/` 照样读 `8bitgo-webgame` 桶。两个加载器
都把它排第一、`assets.8bitgo.com` 排第二：优选线路 10 秒无响应头、30 秒无新字节、HTTP 错误或 SHA / CRC 不符，本页
剩余请求全部改走 assets（`__probe.info.packRoot` / `packRootFallback` 记录现场），不来回试。两边是同一 R2 对象、
内容校验不变，混用安全；边缘缓存按完整 URL 存，download 上是另一份缓存。它依赖别人的优选域名，**不能去掉 assets 回退**。
PvZ 的 `html5.8bitgo.com` 是 R2 自定义域（必须开代理），且 Pages 版经同源 `/pvz-data/` 在服务端取数，给它做优选 CNAME 无效。

**优选 CNAME 自动换线（2026-11-16）。** `rom.8bitgo.com` 与 `download.8bitgo.com` 同构（DNS-only CNAME 到优选域名，
Worker 路由 `rom.8bitgo.com/*`），目前站内代码还没有引用它。两条记录的 CNAME 目标由生产机上的
`8bitgo-cname-optimizer.timer`（`deploy/cname-optimizer/`）每 5 分钟体检：AliDNS DoH 带大陆三网 ECS 解析、
连每个 IP 以我们的 Host 取 64KB 探针并核对 ETag；连续 3 次不健康才从 BestCF 列表 + 内置保底里换一个健康的，
健康时不因源站测速而换（源站在香港，代表不了大陆）。别手改这两条记录的目标后忘了它会被换掉；
要固定某个目标就停掉 timer。回归：`npm run test:cname-optimizer`。
**2026-11-22 起体检也看大陆玩家的真实回报**：浏览器线路记分板对这两个域名的成败经 `romRouteReport.ts` 每分钟（或离页）
sendBeacon 到 `POST /api/route-health`，`server/src/route-report.js` 只收大陆访客、按 IP 的 HMAC 一人一票、只在内存留 30 分钟；
优选任务从本机读 `GET /api/internal/route-health`（带任何反代头一律 404）。≥5 个访客且 ≥60% 只失败就判不健康（源站看不到的
「香港通、大陆不通」），玩家都连得上则不因源站连通性抖动换线；因回报换掉的目标 6 小时不选回来。隐私政策「下载线路回报」一节写明了，
改上报内容要同步三种语言（`test:legal` 的 `route-reports`）。回归：`cd server && npm run test:route-report && cd .. && npm run test:rom-route-health`。

### 2.28.4.1 CS1.6 首局性能：PK3 要 Deflate，YaPB `.vis` 不能每局重算

`lib/cstrike/extras.pk3` 上游包的 738 个成员曾全部使用 ZIP Store：25,111,596 字节几乎原样
下载，其中还有大量 BMP/WAV。`npm run cs16:extras` 会把值得压缩的成员改成标准 Deflate；另因子站
`Permissions-Policy` 明确禁用麦克风，且旧客户端的 BotVoice 路径会偶发 `remainder by zero`，启动器
把 `voice_enable` 固定为 0、YaPB `yb_radio_mode` 固定为 1（保留普通电台、禁用语音 chatter），并从
PK3 剔除 487 个永远不会读取的 `sound/radio/bot/*.wav` 和 `chatter.cfg`。不要改回 mode 2，也不要把
这些 WAV 塞回首载包；这会同时恢复崩溃路径和约 7MB 无效下载。不要用系统 `zip/unzip` 做构建依赖；
CI/生产机曾因没有 `unzip` 直接让 CS16 检查失败。`check-cs16.mjs` 会真实解压余下成员并逐项验 CRC，
同时拒绝语音 chatter 混回包内或退回超过 8MiB 的大包。

YaPB 的 `.graph` 只解决寻路，不含节点两两可见性。没有
`addons/yapb/data/train/<map>.vis` 时，插件会在每帧切片追踪并打印 `Rebuilding vistable...`；
de_dust2 实测约 78 秒，期间会持续吃主线程，旧页面刷新后还会从头再算。现在 12 张公开地图都随
发布物带 `vis/<map>.vis`（合计约 784KB），启动前只取当前地图并写到 YaPB 的真实路径；若文件缺失
或未来新增地图，首次算完后还会写入独立 IndexedDB，后续开图恢复。缓存代次是
`BOT_VIS_GENERATION`，只有换 YaPB 数据格式或 graph 时才递增，不能跟 UI 版本走。
`.vis` 必须由**同一份 graph + 当前 YaPB**在真实引擎里生成，不能跨版本抄；运行时和构建检查都验
magic、v4、节点平方矩阵、压缩段和每节点 4 字节尾部统计，不完整就保留重建路径。

玩家首帧出现不代表已经出生。启动器在 GameDLL 就绪后分三帧执行 `jointeam 2`、`joinclass 1`，
再 `sv_restart 1`，否则命令挤在同一帧会被旧客户端丢掉，或玩家虽入队仍要等下一轮。`?autojoin=0`
仅用于排查。首载关键路径还会并行预取 extras、HUD 字体、当前地图首片，并按 URL 去重动态库下载；
压缩分片按设备内存 / 核数自适应为 2～4 路，解压结果仍最多保留两片，另加预热中的当前地图一片。
不能为了并发直接把四片都解压后常驻：那会在 Xash 的 256MB 初始堆之外再堆约 64MB 原始数据，
低内存设备更容易丢 WebGL 上下文。加载页的下载量 / 速率 / ETA 只按真实网络字节计算，进度 DOM
最多每帧更新一次；启动器提前取清单时必须在玩家点击开始后重置测速时钟，不能把玩家选地图的时间
算成“下载很慢”。资源域预连接与 13KB catalog 可以提前，60MB 内容包不能在点击开始前偷跑。

### 2.28.4.1.1 大陆访客的 CS1.6 走 EdgeOne 镜像，失败回 Pages（2026-11-22）

cs16.8bitgo.com（Pages）从部分大陆网络打不开，而 cn.8bitgo.com/web/cs16（EdgeOne → 源站）秒开。`adapters/html5.ts` 的
`CN_MIRRORED_PAGES_ENTRIES`（目前只有 cs16）：大陆访客（`coverCdnHint()==='cn'` 或 `onCnSite()`）用 `/web/cs16`（页面本身已由 EdgeOne 提供时同源，
否则 `https://cn.8bitgo.com/web/cs16`），非大陆访客照旧 Pages。20 秒（只数前台）没有生命周期桥信号、同源加载后没有 `#canvas`、iframe error
或桥报 failed，就回 Pages 一次。AI 修补的 `runtimeOrigin` 会关掉镜像。源站 `/web/cs16` 由 `server/src/web-game-html.js` 注入与 Pages 构建相同的
媒体桥 / SDK / 运行时桥（按 sha256 带版本），失败照发原文件。房间与中继按页面同源连接，EdgeOne 上 WebSocket 和子协议已实测 101。
EdgeOne 缓存 `/web/cs16` 一小时且没有清缓存通道：部署后这段时间里，从 8bitgo.com 跨源嵌入 cn 的大陆访客拿不到桥信号，会在 20 秒后回 Pages。
其它 Pages 游戏（PvZ 依赖 Pages 专属 `/pvz-data` 代理和存档桥来源，Terraria / Celeste / GTA VC 要跨源隔离）没有切，切之前要逐文件核对。
回归：`npm run test:html5-pages-bridge`。

### 2.28.4.2 CS1.6 启动页复用原版资产；联机只能走后端已验证目标 WSS↔UDP

启动页的背景与 Logo 不是重新画的：`public/web/cs16/ui/` 来自基础包里的原版 800×600 菜单拼图和
`resource/game_menu.tga`，转换成浏览器能直接显示的 PNG 后随运行时清单发布。配色也按
`cstrike/resource/ClientScheme.res` 的 `255 176 0` 琥珀色 / 黑色半透明面板走。改页面时保留
`map`、`bots`、`difficulty`、`start`、`bar`、`phase`、`net`、`errbox`、`log` 这些 ID；加载器与
故障恢复直接通过它们更新状态。BOT 难度不是装饰：`?difficulty=0..3` 会同时写进地图级配置和
首帧后的 `yb_difficulty` 兜底命令，避免首批 Bot 偷用 `extras.pk3` 里的固定 Expert。

本地训练是默认主操作，创建房间是次操作；房间码生成后必须提供 Cancel，把地图 / BOT / 难度与
本地训练按钮原样恢复。后端会自动回收没有房主 WebSocket 的房间，所以取消不需要伪装成已经删除；
不能再让误点 Create Room 的玩家只能刷新整页。CS1.6 没有本站 HTML5 存档桥或触屏虚拟按键，
详情页不得静态展示 F2/F4，也不能用通用 FAQ 承诺“支持快速存档 / 手机虚拟按键”。它自己的临时
房间上限是 16 人，不走站点通用四人 P2P 字段，详情页的人数与结构化数据要按这条能力单独呈现。

房间 BOT 配额用 YaPB 的 `fill`，不是 `normal`，并开 `yb_autovacate` /
`yb_kick_after_player_connect`。这个 Emscripten listen-server 构建实测**不把本机房主计入 fill 配额**：
玩家选择 N 个 BOT 就必须写 `yb_quota=N`；按普通服务端语义写 N+1 会真实生成 N+1 个 BOT。
远程真人仍会立即替换掉一个，离开再补回。网页端同时关闭 Bot 聊天、喷漆和 graph 在线交换，低配机把
`yb_think_fps` 降到 YaPB 允许的下限 24，普通设备保持 30。

Xash 的 Emscripten 构建会读取浏览器 DPR：1280×720 的 Retina 页面曾实际创建 2560×1440
绘制缓冲，房主还要同线程跑监听服和 BOT，像素量白白变四倍。启动器按设备给 1280×720 / 1600×900
像素预算，通过 `Module.maxDevicePixelRatio` 交给 `engine/dist/generated/xash.js` 里的本站小补丁；
窗口与全屏三条 DPR 路径必须一起走 `cappedDevicePixelRatio()`。同时固定 `fps_max 60`、客户端和
监听服更新率 20/30，并关掉天气、影子等装饰项。升级 xash 胶水时若补丁消失，`check-cs16` 必须报错。

浏览器后台页会节流 Emscripten 主循环，而这里的房主页面本身就是游戏服务器，无法靠普通 cvar
绕开；创建房间与房主 HUD 必须明确提示保持标签页在前台。房主凭证也不能放 WebSocket 查询串
（Cloudflare/nginx 常记录完整请求行），现在走 `Sec-WebSocket-Protocol` 的
`8bitgo.cs16.host.<token>`，后端只从该头读取。首帧 60 秒超时只累计页面在前台的时间：短暂切到
邀请消息或好友页面不能因为后台计时器被节流就误报黑屏并主动关房。

房主的监听服 WebSocket **不能一断就删房**：Cloudflare、Wi-Fi 切换或浏览器心跳的一次瞬断不等于
主动退出。后端按 `CS16_ROOM_HOST_RECONNECT_MS`（默认 90 秒）保留原 room/token 和访客连接，前端
在 60 秒窗口内指数退避重连；重连成功继续用同一组 peerId 路由。只有客户端明确发
`1000 / page closed` 才立即回收。错误页必须带 WebSocket close code / reason，不能再把限流、过期、
服务重启全抹成一句“connection was lost”，否则线上无法取证。

访客也不能在一次 Wi-Fi 瞬断后换 peerId：房主里的 GoldSrc 监听服把虚拟 UDP 地址当连接身份，换 ID
就等于另一个陌生客户端，原会话序号无法续上。首次加入时后端发随机 resume token，浏览器只在后续
WebSocket 的 `8bitgo.cs16.guest.<token>` 子协议头带回；后端按
`CS16_ROOM_GUEST_RECONNECT_MS`（默认 60 秒）保留原 peerId。主动关页立即释放，过期保留项计入房间
容量，避免靠反复断线绕过 15 个访客上限。

⚠️ CS1.6 的正式入口是 `cs16.8bitgo.com` 的 Cloudflare Pages，不是浏览器直连主站。
`deploy/cloudflare-pages/web-game-worker.js` 除了转发二进制帧，还必须把房主/访客的
`Sec-WebSocket-Protocol` 原样带到主站，并在 101 响应里向浏览器确认同一个协议；漏任一边都会出现
“直连后端测试通过、Pages 线上创建房间或断线恢复失败”。改联机鉴权后必须同时跑
`npm run pages:web-games:build -- cs16 && npm run pages:web-games:check -- cs16`。
发布顺序必须是**先主站后端、再 Pages**：后端保留旧查询串 token 的只读兼容，承接已缓存页面；
新客户端只生成子协议凭证。反过来发布时，新 Pages 会先撞上不认识子协议的旧后端，房主无法上线。

`Find Servers` 已接真实目录与传输层：旧 Valve UDP Master 域名已经不稳定解析，默认改查
XCSTRIKE 的免密钥、人工审核 JSON 目录（90 req/min，而本站最多每 5 分钟一次），先拒绝内网/保留地址
与同 IP 大量端口，再用 A2S_INFO 验证
`cstrike`、协议 47/48、无密码和已发布地图；验证结果只以带 TTL 的短 ID 注册。可选的
`CS16_SERVERS_JSON` 最多补 32 个固定目标并排在前面。`GET /api/cs16/servers` 返回人数、地图和
“网关→游戏服”延迟；浏览器的 `public/web/cs16/cs16-net.js` 把 Xash `Net` 数据报接到同源
`/api/cs16/relay?server=<已注册ID>`，后端再用 connected UDP socket 只连目标表里的 host:port。
**不准**把 host / port 改成客户端参数或做通用代理：那会直接变成 UDP 反射/流量滥用入口。
网关还必须保留同源校验、每 IP / 总连接、帧大小、每秒速率、积压、空闲/总时长和 ping/pong 回收。

浏览器拿到的 `netId` 只映射成 Xash 虚拟地址 `101.101.<低8位>.<高8位>`；WSS 连接本身已经绑定
唯一已注册项，发送适配器还会复核虚拟 IP 与公开 port。`Net` 必须在 `xash.init()` **之前**赋到
`xash.net`，但 WSS 要等基础包和地图写完后才 `connect()`，否则首载慢时会在开局前吃掉空闲超时。
联机启动不加本地 `+map`、不改 `liblist.gam` 到 YaPB，也不执行 `sv_restart` / 自动入队；只预载目录
返回的当前地图包后用 `+connect webxash3d.<netId>:<port>`。服务器若轮换到 12 张发布地图之外，目录
会显示真实地图但禁止 Join，不能让玩家下载一大轮后才报缺 BSP。

⚠️ xash3d-fwgs 1.2.2 的 JS `Net` 有两个上游缺陷，适配层的补丁不能删：

- 空接收队列时 `ErrNoLocation()` 把 errno **值**当成指针，原实现会写 WASM 地址 0；现在重新调用
  `getErrnoLocation` 取真实指针再写 EWOULDBLOCK。
- Emscripten 导入找 `sendto_batch`，类却只提供 `sendtoBatch`；现在显式补 snake_case 别名。

自动目录默认开启，部署不必填写服务器；改目录地址/数量或增加固定项只需改 `server/.env` 并重启，
不需要重编前端。示例和所有限额见 `server/.env.example`。验收先跑
`cd server && npm run test:cs16-relay`（本机 UDP echo 证明自动目录过滤、A2S、跨站拒绝和逐数据报
透明），再跑根目录 `npm run test:cs16`。公共目录不可用时 Find Servers 显示空状态，BOT 训练不受影响。

### 2.28.5 /web/diablo：CRA v2 老工具链，WASM 核心走 R2 Brotli 流式代理

上游 d07RiV/diabloweb（devilution 重建源码 → WebAssembly），2026-09-24 接入，地址 `/web/diablo`。
路由不用加：`/web/:name` 是通用的（同 cs15）。

- **不含任何游戏数据**：`DIABDAT.MPQ` 由玩家自己提供，只写进他自己浏览器的 IndexedDB
  （库名 `diablo_fs`，存档 `.sv` 也在同一处）。页面上那句「不会上传到服务器」是实话，
  别再加云端存档的暗示。
- 上游界面里的 **「Play Shareware」按钮已删除**：那条路要 `/web/diablo/spawn.mpq`，
  等于把上游的共享版数据托管到本站、或让页面去外链别人的站点 —— 两者都撞 §版权红线。
  玩家自己手里有 `spawn.mpq` 时仍然可用（走文件选择那条路，会被识别成 shareware 分支）。
- 源码 `diabloweb/`、页面/worker 产物 `public/web/diablo/` **两者都进 git**：产物进 git 的理由同
  cs15/cs16（生产机 `git pull && npm run build` 不会重建它）；但三份 `.wasm` 会在构建末尾从
  `public/` 剥离，只留下 `runtime-manifest.json`，经 `/web/diablo/static/media/<hash>.wasm`
  同源流式代理到 R2 的 `web/diablo/runtime/<hash>.wasm.br`。

五条构建约束，每条都真实踩过一次（`npm run diablo:build` 已把它们固化）：

1. **上游的 `package-lock.json` 里带着 4 处未解决的 git 冲突标记**（node-sass / sass-graph 子树），
   JSON 都解析不了 → `npm ci` 必失败，npm 退化成按 `^` 范围重新解析，于是拿到今天最新的
   `@babel/core`，直接踩上第 2 条。仓库里这份已经修好并重新生成。
2. **`preset-env` 不转译 class 字段，webpack 4 又不认它。** `preset-env` 只在「目标浏览器不支持
   class 字段」时才处理，而 browserslist 数据一年年更新，2026 年的 `>0.2%, not dead` 全都支持 ——
   结果是 `class App { files = new Map() }` 被原样丢给 webpack 4，报
   `Module parse failed: Unexpected token`（有时更直接：`Missing class properties transform`）。
   解法是给 babel 一份**不随 browserslist 漂移的目标**（`package.json` 里 `babel.targets` 写死
   chrome/edge/firefox/safari 版本），并显式加上 `@babel/plugin-proposal-class-properties`。
   副作用要一起记住：目标写死的那个集合必须**原生支持 async/await**，否则 `preset-env` 会把它
   编成 regenerator，而 app 代码这条路没有 `@babel/plugin-transform-runtime` 兜底。
3. **依赖里出现 `#private` 一律炸**（`preset-env` 7.9 不认私有字段，webpack 4 的 acorn 更不认）：
   `peerjs` 从 1.5 起就有 `static #_ = ...`，所以钉在 `1.0.2`（= 上游 lockfile 的版本）。
   升级依赖前先想一下它会不会带私有字段。
4. **Node 17+ 跑 webpack 4 必须 `--openssl-legacy-provider`**：webpack 4 用 md4 算模块哈希，
   OpenSSL 3 默认不提供，报 `error:0308010C:digital envelope routines::unsupported`。
5. **worker-loader 的错误藏在 child compilation。** 旧 CRA 脚本只读顶层 `stats.errors`，
   `game.worker.js` 的 eslint / 语法错误会被漏掉，控制台仍写“Compiled successfully”，最终 build 里
   只有 public 图标、没有 index/JS/wasm。`diabloweb/scripts/build.js` 已把所有 children 的错误合并；
   不要退回上游原版的那段 `stats.toJson({ errors: true })`。

两处内存修复不能退：远程 MPQ 虽然一直发 Range，旧代码却先按 Content-Length 分配整份文件；
本地 MPQ 也先 FileReader 全读再复制进 worker。现在两条路统一成 **1MiB 分块 + 最多 64 块 LRU**，
远程必须严格拿到 `206 + 精确 Content-Range`，否则当场报错；500MB MPQ 不再额外常驻 500MB JS 堆。

三份核心上传前用 **Brotli q11 + 16MiB window** 预压缩，真实结果约为：Diablo 23.1%、
DiabloSpawn 23.6%、MpqCmp 32.6%（合计约 720KB）。R2 `.br` 对象不写 Content-Encoding，
`server/src/r2-runtime-proxy.js` 流式回源后再补，浏览器边收边解码；服务端也不会整包缓冲。
R2 同时保留原始对象，只给不支持 Brotli 的旧客户端与 Range 请求兜底，正常浏览器不会下载它。

另外两处与「构建能不能跑起来」直接相关的改动：`node-sass` 在 Node 22 上根本编不出来
（node-gyp + 老 libsass），换成 dart-sass，并把 `sass-loader` 从 7.1.0 升到 **7.3.1**
（7.1.0 只认 `node-sass`，没有回退分支）；`config/env.js` 的 `VERSION` 改成读**本工程**的
`package.json` —— `npm_package_version` 是「执行 `npm run` 的那个包」的版本，而本站是在仓库根目录
跑 `npm run diablo:build` 再 fork 出子构建，环境变量会被继承，游戏主菜单底部曾印出主站版本 `v0.9.18`。

另外三处刻意的删改，别被上游新版本覆盖回来：

- **不注册 service worker**（webpack 配置里的 workbox `GenerateSW` 已删）。入口文件名不带内容哈希，
  老访客被旧 SW 接管时就是「部署了也不生效、刷新也没用」，同 §2.5 那次事故。
- **删掉 react-ga**：上游在 production 下会往它自己的 `UA-43123589-6` 打点，不该拿本站的流量
  给别人刷数据。
- `diabloweb/config/webpack.config.js` 里的 `WorkboxWebpackPlugin` 引用也一并删了。

⚠️ **`public/web/diablo/` 里约 1.5MB 的 `.map` 是故意留的**：`App.js` 用
`sourcemapped-stacktrace` 把 worker 抛出的栈映射回源码，删了错误框里就只剩压缩后的栈。

验收：

```bash
npm run diablo:build     # 构建 + 同步 public/web/diablo + 自检
npm run test:diablo      # 只自检（prebuild / postbuild:client 里也会跑）
npm run diablo:upload -- --bucket 8bitgo   # q11 预压并上传三份核心；--dry-run 只准备不上传
curl -sI https://8bitgo.com/web/diablo | head -3
curl -sI https://8bitgo.com/web/diablo/static/media/Diablo.<hash>.wasm | grep -i content-type
```

⚠️ **光看 200 不算验收。** 这个页面最典型的故障形态是「页面能打开、游戏起不来」，
而它会白屏或只在控制台留一句含糊报错。要真的走一遍：打开 `/web/diablo`（**不带尾斜杠**，
生产就是不带）→ 选一个 MPQ → 等 `document.querySelector('.App').className` 变成
`App started`（这一步说明 worker + wasm + FS 都起来了），再确认主菜单能出来。

⚠️ 与 `check-cs16.mjs` 同理，`scripts/check-diabloweb.mjs` 会把 index.html 里**每一条**
`/web/diablo/` 引用都拿去磁盘上核对，并检查 wasm 三件套（Diablo / DiabloSpawn / MpqCmp）
与 `*.worker.js`；`--dist` 时再和 `public/` 逐字节比对。构建产物才是线上真正发的文件，
而这些名字不带内容哈希，肉眼分不出新旧。

想上架成游戏：平台选 `html5`、slug 必须是 `diablo`；前端会从 `shared/builtin-web-games.js`
自动识别 `/web/diablo`，不再要求后台手绑 ROM。游戏数据不在站内，游戏详情页**别**写「内置」。

### 2.28.6 /web/terraria：.NET WASM 的 Terraria 移植，运行时在 R2、前端是打过补丁的构建产物

上游 Terrarium（velzie / MercuryWorkshop 的 celeste-wasm 一脉，Terraria 的 Blazor + FNA 移植），
2026-09-24 接入，地址 `/web/terraria`。**这是全站唯一一个把商业游戏本体也一起发的页面**：
`_framework/terraria.<hash>.dll`（20MB）就是 Terraria 客户端的 IL（`Terraria.*` 全套命名空间）。
按运营方的决定按「和站内 ROM 库同样的尺度」处理；页面文案据此写死为「你必须拥有 Terraria」。

**文件放哪儿**（细节见 `public/web/terraria/PACKS.md`）：

| | |
|---|---|
| `public/web/terraria/`（入口 + assets + 图标，约 800KB） | git |
| `_framework/`（134.9MiB，单个 wasm 100,104,513 字节） | R2 `web/terraria/_framework/`，不进 git、也不进 `dist`（已加进 `vite.config.ts` 的 `HUGE_STATIC`） |
| 上游的 `sw.js` / `MILESTONE` | **不发**（前者作用域是站点根，后者只有它用） |

线上取用是**同源**的：`/web/terraria/_framework/<文件>` → `server/src/terraria.js` 优先流式转发
R2 的 `<文件>.br`，缺少时兼容原文件。上传器用 Brotli q11 + 16MiB window；代理全程背压，
并发名额直到响应体真正结束才释放。不直连 R2 的原因：`dotnet.native.worker.<hash>.mjs` 是 pthread 的 Worker 入口，
**跨源 Worker 不允许**；而且这一页跑在 `COEP: require-corp` 下，同源省掉一整套 CORS/CORP 配置。

#### 上游只发布构建产物，所以是「打补丁」而不是改源码

`npm run terraria:patch` 对 `assets/index.js`（217KB，已打包）做定点字符串替换，输入是
`scripts/terraria-web/upstream/`（上游原件的副本）。每处替换都**必须命中一次**，否则直接失败 ——
上游换版本时补丁点会漂移，那时要重新核对，别为了让构建变绿把断言删掉。

⚠️ **补丁之后一定要真解析一遍**（`npm run terraria:check` 里用 esbuild，不打包、只解析）。
这不是洁癖：删 Steam 登录路由时把收尾的 `)` 留在原地，浏览器只报一句 `Unexpected token ')'`，
而**所有字符串检查全绿、构建也成功**。同理，只扫双引号字符串会漏掉藏在组件 CSS 模板串里的
`url(/backdrop.png)`（症状是背景图 404 而界面照常可用，看着像设计如此），所以补丁表里另加了两条
**正则**断言：`url(/…)` 与 `src:"/…"` 里不许出现「不在 /web/terraria 下的根绝对路径」。
（`/tmp`、`/dev`、`/proc` 那些是 Emscripten 虚拟文件系统的路径，不是 URL，别一刀切。）

#### 三件必须记住的事

1. **两处 service worker 注册的作用域都是 `/`。** 上游靠它给缓存响应补 COOP/COEP 头、
   装完再刷新一次。放过去等于给整个 8bitgo.com 装一个第三方 SW。本站改为服务端在这条路由上
   直接发 COOP/COEP（同 `/linux`），SW 一处不留（`sw.js` 也不部署）。
2. **上游会把 `window.fetch` 与 `window.WebSocket` 全局换掉**，走作者自己的 wisp 代理
   （`wss://staging2.velzie.rip/`），并从 jsdelivr 取 `libcurl.wasm`；`preInit()` 里无条件执行。
   本站整段移除（站内请求不该绕道别人的服务器，也违反「引擎自托管」）；实测移除后
   `Program.PreInit()` 照常完成、游戏照常进引导页。
3. **Steam 登录/下载已移除**（原来会让玩家在本页输入 Steam 账号密码，凭据过第三方 staging）。
   只保留「拷贝本机 Content 目录」（Chromium）与「上传归档」两条自带数据的路；
   `.NET` 侧的 `initSteam` / `downloadApp` 也改成直接失败，不给它留下任何能连上代理的入口。

#### 验收（光看 200 不算）

```bash
npm run terraria:patch -- --src <解压后的构建目录>   # 首次导入
npm run terraria:check                              # 补丁在位 + 引用齐全 + 真解析一遍
npm run test:terraria                               # 上面的检查 + 代理回归测试（不联网）
npm run terraria:upload -- --bucket <R2桶名> --zip <构建zip>   # q11 预压 + 原始回退，一起传 R2
```

⚠️ **必须真的在浏览器里开一次**（本地：把上游 `_framework/` 放进 `public/web/terraria/_framework/`，
它已 gitignore，`express.static` 会优先命中）。要看到的是：

- `crossOriginIsolated === true`、`typeof SharedArrayBuffer === 'function'`
  （false 就说明 COOP/COEP 没发出去，游戏会卡在启动且几乎没有报错）；
- `navigator.serviceWorker.getRegistrations()` 长度为 **0**；
- `performance.getEntriesByType('resource')` 里**没有任何跨源请求**（出现 velzie.rip / jsdelivr 就是补丁掉了）；
- 引导页出来、`_framework` 请求约 117 条 / 约 134MB、控制台 0 错误。

⚠️ 页面本身能打开 ≠ 能玩：**上游不提供任何游戏素材**，玩家必须自己给 `Content/`（约 500MB）。
没有素材时停在引导页是正常现象，不要把它当成「没跑起来」。

想上架成游戏：平台选 `html5`、slug 必须是 `terraria`；`shared/builtin-web-games.js` 会自动识别
`/web/terraria`，并把详情页入口切到带 COOP/COEP 的 `/play/terraria` 隔离薄壳，不再要求手绑 ROM。
游戏素材不在站内，详情页别写成「内置」。

### 2.28.7 /web/Minecraft：EaglercraftX 1.8，第三方 Minecraft 1.8 WebGL 移植

上游 lax1dude/eaglercraft-1_8（gitflic.ru），2026-09-24 接入，地址 `/web/Minecraft`。
**这是全站又一个「引擎自托管、游戏数据由玩家自备」的网页游戏，但版权处境比 terraria / diablo
更敏感，务必照下面办。**

- **上游性质先核实清楚**：EaglercraftX 1.8 是 Mojang《Minecraft》1.8 的**第三方逆向/移植**
  （不是官方）。gitflic 那个仓库**只含源码 + 构建脚本，不含任何反编译的 MC 1.8 源码/资源，
  也不含预构建产物**——构建时必须由 operator 自己提供正版 Minecraft 1.8 与 MCP 文件
  （`mcp918/` 与 MC 1.8 由玩家/operator 自备）。产物是 `index.html` + `classes.js` +
  `assets.epk`，由 `window.eaglercraftXOpts` 配置（`assetsURI: "assets.epk"`）。
- **版权红线（同 terraria / diablo，但更紧）**：`classes.js` 是反编译重编译后的 MC 1.8 逻辑、
  `assets.epk` 是 MC 资源——两者都属 Mojang 版权。**本站只托管开源启动壳
  `public/web/Minecraft/index.html`（始终进 git），不托管任何 Eaglercraft 客户端或资源**。
  真正的客户端由 operator 用自己合法拥有的 MC 1.8 构建后，经 `npm run minecraft:fetch` 自托管到
  `public/web/Minecraft/eaglercraft/`；该目录已 gitignore，不进仓库、不分发。
  游戏本体（assets.epk 等）由玩家用自己合法拥有的 MC 1.8 通过上游工具生成后提供——
  页面别写成「内置」，详情页也别暗示本站提供任何 Minecraft 代码或素材。
- **单线程，不需要隔离壳**：Eaglercraft 常规 JS 客户端是单线程，不依赖 SharedArrayBuffer，
  所以 `shared/builtin-web-games.js` 里 `minecraft` 的 `isolated: false`，直接 `/web/Minecraft`
  嵌入（同 PvZ / diablo），服务端不在这条路由上发 COOP/COEP，`vite.config.ts` 也不会给它加头。
  路由不用加：`/web/:name` 是通用的（同 cs15 / PvZ）。
- **自托管硬规则（fetch 脚本已固化）**：
  1. 移除上游任何 `navigator.serviceWorker.register(...)`——不给整站装第三方 SW，
     本站只靠服务端给 `/web/Minecraft` 发头。
  2. 不出现 http(s) 外链（jsdelivr / unpkg / 作者服务器 …）；玩家在游戏里手填的多人服务器
     地址是运行时输入，不在静态文件里，不受影响。fetch 脚本只**报告**外链、不擅自改写路径，
     由 operator 人工确认。
  3. 上游 Site 构建产物本就假定丢进子目录直接跑，路径是相对的，脚本原样拷贝即可。

三步接入（operator 侧）：

```bash
# 1. 用自己正版 MC 1.8 按上游 README 构建出 Eaglercraft（index.html + classes.js + assets.epk …）
# 2. 自托管到本站（剥离第三方 SW、报告外链）
npm run minecraft:fetch -- --src <构建目录>
# 3. 验收：无第三方 SW、无外链资源加载
npm run minecraft:check
```

验收（光看 200 不算）：`npm run minecraft:check` 应「验收通过」；本地把构建目录导进
`public/web/Minecraft/eaglercraft/` 后，浏览器开 `/web/Minecraft` 应直接进游戏，
`performance.getEntriesByType('resource')` 里**没有任何跨源资源请求**（出现 jsdelivr / 作者域名
就是补丁掉了）。Eaglercraft 自带的 multiplayer 服务器地址是玩家运行时手填，不算跨源违规。

- **上线到 8bitgo.com 的部署要点**：`public/web/Minecraft/eaglercraft/` 被 gitignore，
  `redeploy.sh` 的 `git reset --hard` 清不掉它，所以「在部署机上跑过一次 `npm run minecraft:fetch`
  就常驻」，后续 `redeploy` 都会把它带进 `dist/client/`。更省事的做法：在部署机设置环境变量
  `MINECRAFT_CLIENT_SRC` 指向一份已构建好的客户端目录，`redeploy.sh` 会在构建前自动同步
  （不设则跳过，假定之前已就位）。两种情况下客户端都来自 operator 自己正版 MC 1.8 的构建，
  不进 git、不分发。
- **启动壳跳转用绝对路径**：`public/web/Minecraft/index.html` 基于 `location.pathname` 算出
  `/web/Minecraft/eaglercraft/index.html` 再 `location.replace`。**不能写相对 `./eaglercraft/`**——
  路由 `/web/:name` 直接 `sendFile` 吐页面、URL 不留尾斜杠，浏览器会把 `./eaglercraft/` 相对
  `/web/` 解析成 `/web/eaglercraft/index.html`（错一层）→ 永远 404、进不去游戏。改壳时务必保留
  这段绝对路径逻辑。

想上架成游戏：平台选 `html5`、slug 必须是 `minecraft`；`shared/builtin-web-games.js` 会自动识别
`/web/Minecraft`，详情页入口指向它，不再要求手绑 ROM。游戏代码与素材不在站内，详情页别写成「内置」。

### 2.28.8 /web/celeste：Webleste（Celeste 2018 + Everest 的 .NET WASM 移植）

上游 [MercuryWorkshop/celeste-wasm](https://github.com/MercuryWorkshop/celeste-wasm)（与 terraria
同一作者一脉），2026-09-24 接入，地址 `/web/celeste`。**架构与 §2.28.6 完全同构**：.NET WASM + FNA，
`_framework/` 130MiB 放 R2 由 `server/src/celeste.js` 代理回源，页面本体 14MB 进 git。
两处上游结构差异：wasm 被切成 5 片 `dotnet.native.<hash>.wasm0..4`（前端拼回）；且没有
`blazor.boot.json`，唯一不带内容哈希的入口是 `dotnet.js`（启动清单并进了 native 胶水）。
注册表 `shared/builtin-web-games.js` 里 `isolated: true`（pthread/deputy thread 要
SharedArrayBuffer），详情页走 `/play/celeste` 隔离薄壳，`/web/celeste` 路由单独发 COOP/COEP
（与 terraria 同一分支）。版权处境与 terraria 相同（运营方既定尺度），素材由玩家自备。

⚠️ **上游前端带着三样必须打掉的东西**（`scripts/patch-celeste-web.mjs`，8 处定点替换全部
must-hit-once + esbuild 真解析）：

1. **`window.fetch` 被全局劫持**：native fetch 失败回落 epoxy 客户端 → 默认发往 wisp 中继
   `wss://anura.pro`。已整段还原为 native fetch（`/depot/` 下载拦截一并移除）；
   Everest 自动下载里的 `epoxyFetch` 一并换掉。
2. **`window.WebSocket` 被 Proxy 换成 EpxWs/EpxTcpWs**（SteamKit2 的 TCP 也从这儿走 wisp）。
   已还原为原生 WebSocket —— 从此没有任何路径能碰到第三方中继。
3. **index.html 有第三方统计**（`a.r58playz.dev/colonthree.js`）和 **Steam 账号密码登录 UI**
   （SteamKit2 走 wisp TCP，网络断掉后登录永远失败）。统计整行删除（bundle 里的 `event()`
   埋点在 umami 缺席时自动 no-op，删脚本安全）；登录对话框换成说明文字。
   另把 wisp 默认地址改成 `127.0.0.1:9` 黑洞兜底。

其余差异与坑：

- ⚠️ **`<base href="/web/celeste/">` 是必须的**：上游 demo 在根路径，产物里全是相对引用；
  生产 URL 不带尾斜杠时 `./assets/...` 会解析到 `/web/assets/...`（「diablo 当成文件」同源坑）。
- ⚠️ `.wasm0..4` 分片必须归一成 `wasm` 处理（celeste.js 的 `extensionOf` + 上传脚本同款归一），
  否则落到 1 小时缓存且不做 Brotli，边缘每次回源 100MB —— `test:celeste` 有断言钉着。
- ⚠️ celeste 的 `_framework` 里有**带哈希的 .js**（terraria 没有），`EXTRA_CACHE` 必须有 `js` 档。
- 上游 `_headers`（Cloudflare Pages 约定）和 `robots.txt` 不部署；COOP/COEP 由 Express 发。
- 验收同 terraria：`crossOriginIsolated === true`、`performance` 里无跨源请求、
  `_framework` 请求约 220 条 / 约 130MB、控制台 0 错误。**页面能开 ≠ 能玩**：玩家必须
  自己拥有 Celeste (2018) 并在本页交出安装目录；没有素材停在引导页是正常现象。
- 上架：平台 `html5`、slug 必须 `celeste`；`shared/builtin-web-games.js` 自动识别 `/web/celeste`。

```bash
npm run celeste:patch -- --src <webleste-loader 解压目录>   # 首次导入 / 上游换版
npm run celeste:check                                      # prebuild / postbuild:client 都会跑
npm run test:celeste                                       # 纯函数回归 + 上面的检查
npm run celeste:upload -- --bucket <R2桶名> --src .celeste-framework   # q11 预压 + 原始回退
```

### 2.28.9 /web/gta-vc：只发布运行端与引擎，游戏素材来自玩家自己的 PC 版安装

[joncodeofficial/gta-vice-city-wasm](https://github.com/joncodeofficial/gta-vice-city-wasm)，2026-11-16
升级到提交 `5c6cccc56c1df5c3717c0b39953d5fe833f97b73`，专用 Pages 项目 `8bitgo-gta-vc`，入口
`https://gta-vc.8bitgo.com/web/gta-vc/`（DNS 是单独的 CNAME → `8bitgo-gta-vc.pages.dev`；没有它会被
`*.8bitgo.com` 泛解析送到源站，返回 404）。玩家选择自己 PC 版的**安装目录或它的 `.zip`**，上游转换
Worker 在浏览器里读出素材写进 OPFS，Service Worker 再从 `/vcsky/` 与 `/vcbr/` 提供给 WASM。
站点托管 `engine/vc-sky-en-v6.wasm`（DOS Zone 团队的 reVC 移植）和上游 `revc/` 的少量 reVC 文件，
不托管任何 Rockstar / Take-Two 素材。旧版的 `game.tar.gz` 导入、`runtime-config.js` 和本站自写的
`extract-worker.js` 已随上游移除；上游 ZIP 读取按中央目录懒读、大成员流式解压到 OPFS，不会整包进内存。

⚠️ **只有本段明确列出的授权副本可以进固定 R2 对象；其他游戏素材仍不能进 Git、Pages 静态文件或本站代理。** 用户于
2026-11-16 明确授权自托管其获得的 `revcdoseng.7z`，由用户自行放入 R2 key
`web/gta-vc/revcdoseng.7z`。GTA VC Pages 只提供固定同源地址 `/game-data/revcdoseng.7z`，Worker
只代理这个 key，转发 Range，不开放任意 R2 key，也不加跨域读取头；不要由代码上传该素材。
2026-11-16 取证：reVCDOS 默认的
`cdn.dos.zone/vcsky/`、`br.cdn.dos.zone/vcsky/` 全部 404 `NoSuchKey`；dos.zone 现在用 WebTorrent
（`revcdoseng.2.torrent`，860MB，只有 `wss://cloud.dos.zone:8444` tracker、无 HTTP 种子）和
`archive.dos.zone/revcdoseng.7z`（571MB）+ `br.cdn.dos.zone/vcsky/v16.wasm.br`，后两者的 CORS 只放行
`https://dos.zone`。从本站来源连他们的 tracker 能握手，但 70 秒内 0 个 peer。除非对方把本站加进 CORS
白名单，否则不能直接接；不准伪造 Origin 来绕过。本站固定 R2 路由是用户明确批准的独立例外。
v16 引擎的 glue 与文件布局（OPFS `/vc-assets/local/…`、`gta3.img` 拆成目录）和 v6 不同，
换引擎要连 glue 一起移植；当前转换器额外兼容 `.7z`、已展开的 `gta3.img` / `cuts.img` 和 `sfx.raw/`，
并直接复制这份包里用 `.wav` 扩展名保存的 ID3/MP3 音效。

升级步骤见 `public/web/gta-vc/UPSTREAM.md`（`vite build --base /web/gta-vc/`，补回 `noindex`，
改 `check-gta-vc-web.mjs` 的提交号后 `--write-manifest`）。回归：

```bash
npm run gta-vc:check
npm run pages:web-games:build -- gtavc
npm run pages:web-games:check -- gtavc
```

### 2.28.10 /web/undertale：授权分发包只从 8bitgo.com 直达浏览器 OPFS

2026-10-19 接入 [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch) Web 构建提交
`54e10ec4e4a5713130675c7719dda7c437b4f849`，专用 Pages 项目是 `8bitgo-undertale`，入口
`/web/undertale/`。Butterscotch 是 MPL-2.0 的 GameMaker Runner 重实现，上游把 UNDERTALE v1.08 /
WAD 16 列为兼容目标，但仍明确标注早期开发；本站页面必须保留“实验性”提示，不能宣称官方支持。

2026-11-16 运营确认 UNDERTALE 获得分发授权，资源包放在 `https://html5.8bitgo.com/undertale/`。
`public/web/undertale/distribution-manifest.json` 只记录资源路径、长度和 ZIP CRC-32，不含游戏字节。
清单也记录被排除的桌面版 `.exe` / `.dll` 与未上传、且 `data.win` 未引用的 `splash.png`。
启动器从 `https://8bitgo.com` 或其 HTTPS 子域直接跨域读取；R2 CORS 只允许 `https://8bitgo.com` 与
`https://*.8bitgo.com`（Cloudflare 的通配符不包含主域，且可匹配多级子域），不能用 `*` 或放行 `pages.dev`。
启动器本身再次校验 HTTPS 与 `.8bitgo.com` 主机边界，其它来源不能开始远端下载。R2 自定义域 CORS 变更后清理
`html5.8bitgo.com` 缓存。策略源文件为 `deploy/cloudflare-pages/undertale-r2-cors.json`；应用变更后还要刷新
`undertale.8bitgo.com/web/undertale/` 页面缓存。不要经本站 API、Worker 或 Service Worker 代理游戏资源。

⚠️ **游戏字节仍不得进入 Git、Pages 构建包或 Service Worker 缓存。** 只允许从上述授权分发主机直达浏览器，
流式写入当前浏览器私有 OPFS；大文件按 8 MiB HTTP Range 分段并在每段落盘，CRC-32 对齐授权包后才算就绪，
中断后可接着已完成的部分下载。资源请求不带本站 Cookie，也没有上传请求。首页自动下载并只显示一条进度条，
授权资源齐备后自动启动；专用 Pages 子域 `https://undertale.8bitgo.com` 也在白名单内，可从它或主站打开。

OPFS 的 `library-v1` 与 `saves` 故意分开：重新导入或点“清除本机游戏副本”只删游戏库，不删存档。
运行时预编译与资源下载并行，第二次访问从 OPFS 读取并启动；键盘、标准手柄与触屏最终都汇入
Butterscotch 的键盘接口。当前 Web 构建依赖 WebAssembly JSPI、OPFS 和 WebGL 2，不满足时必须在
下载前拦截，不能让玩家先等几百 MB 才发现浏览器不兼容。

2026-11-16 现场反馈：开场按 Esc 后回到 100% 进度条。复现为 Butterscotch 标题画面将长按 Esc 映射成退出，
`_startRunner()` 因此正常结束；`startGame()` 的 `finally` 随后切回启动页，满格进度条让人误以为又在加载。
页面键盘适配现在将 Esc 映射为 Z（确认 / 继续），离开游戏用浏览器自身的返回 / 关闭操作；不要把原始 27
传给运行端。ScriptProcessorNode 弃用提示与未手势解锁的 AudioContext 提示不会终止 runner；声音自动尝试启动，
浏览器若拦截自动播放，则在首个键盘、指针或触摸手势里无提示解锁，不额外显示声音门按钮。Esc 回归需确认仍处于游戏画布、
开场继续推进且没有回到启动页。

上游构建与许可证由 `runtime-manifest.json` 固定哈希；换版时必须同步提交号、归档 SHA-256、两个
运行时文件哈希和 MPL 许可证。替换授权分发包时同步更新资源清单、包版本和 ZIP CRC-32，并先验证远端每个路径、长度及精确 CORS 来源。
Service Worker 只可缓存运行端和小型资源清单，永远不能缓存游戏数据。回归：

```bash
npm run undertale:check
npm run pages:web-games:build -- undertale
npm run pages:web-games:check -- undertale
```

### 2.29 后台能热改的站点级配置：`site_settings` 表（首页公告条是第一个）

为什么不是 `.env`：`config-manifest.js` 那页（后台「配置」）**只读是刻意的**，
它回的是基础设施信息和密钥指纹，不该跟着一张会被运营改的表一起演化。
那张文件的注释里给的出路就是这张表 —— **env 提供默认、库只做覆盖**。
第一个住户是首页公告条（`name = 'notice'`，值是 JSON 文本）。
另有火山翻译额度计数 `translation.volc.used_chars`（数字文本，不是公告配置），复用这张已有表；
它不需要数据库迁移，首次真实翻译前用 `VOLC_TRANSLATE_INITIAL_USED_CHARS` 导入历史用量。

**公告条**（2026-09-21）：显示在首页**搜索框与横幅之间**，两种语气，文案后台写。

| | 接口 | 缓存 |
|---|---|---|
| 公开读 | `GET /api/site-notice` → `{ notice: { level, text } \| null }` | `CACHE.notice`，**只有 30 秒** |
| 后台读 | `GET /api/admin/site-notice`（`site:manage`）→ 含 `enabled` 与关掉时的原文 | `no-store` |
| 后台写 | `PUT /api/admin/site-notice`（`site:manage`）→ 回存下来的那一份 | — |

- `warn` 黄 = **提示**（站点波动、功能在测试）；`error` 红 = **Sorry**（自己搞坏的）。
  关闭不是第三种 level，而是 `enabled: false`；文本为空也等于关闭。
- ⚠️ **公开读和后台读写必须是两个前缀**。公开那份要进边缘缓存，而按身份变内容的接口
  一旦进缓存，管理员读到的原文会被下一个匿名访客拿到 —— 所以没有「加个参数返回完整版」那种设计。
- ⚠️ **公开缓存只有 30 秒**（`CACHE.notice`，见 `npm run test:site-notice` 里那条断言）：
  这条的用途就是「出事了立刻告诉所有人」，沿用其它内容那 5 分钟的 s-maxage
  等于让公告**在它最该出现的时刻迟到五分钟**。
- ⚠️ **公告跟着首页数据一起下发**（`content.js` 里 `loadVisibleNotice()`），不是前端再发一个请求：
  SSR 出来就有，不会在水合后才冒出来把整屏推一下。改完调 `invalidateContent()`，
  服务端那份缓存立刻作废；前面有 CDN 时首页 HTML 最多再晚 5 分钟。
- 文案清洗在 `shared/site-notice.js`（折叠换行与连续空白、按**码点**截断 160、去控制字符）。
  前台正文一律 `text-fg`，颜色只放边框和图标 —— 亮黄 `#ffc800` 在浅底上做正文几乎读不出来，
  而这条是**要人真的读一遍**的东西。
- 后台入口 `/admin/notice`，权限点是 `site:manage` **不是** `content:edit`：
  它是在替**站点本身**说话，不是某款游戏的资料。

⚠️ **部署要跑迁移**（新增了 `site_settings` 表）：

```bash
cd server && npm run migrate
```

没跑的话：首页照常（缺表时按「没有公告」处理，见 `site-notice.js` 的 `readStoredNoticeSoft`），
但后台保存会 500 —— 后台页面会把这句话原样显示给管理员，并提示去跑迁移。

回归：`npm run test:site-notice`（纯函数逐条 + 源码形状：位置在横幅之上、两个后台接口都要权限、
s-maxage 必须很短、迁移里有这张表）。

### 2.29.1 志愿者只写自己的游戏 / 文章库，绝不能把个人草稿混进主表

志愿者权限只有 `games:edit` 和 `posts:edit`；`content:edit`、评论审核、开发商、应用、友情链接、
ROM 存储和其它站级入口全部是管理员权限。后台列表统一带 `library=mine`：管理员仍读主库，
志愿者则按服务端登录身份读 `volunteer_games` / `volunteer_posts`。

⚠️ 个人库**故意是两张独立表**，不是给 `games` / `posts` 加 `owner_id`。公开站点、搜索、首页、
收藏、翻译等有大量主库查询，只要其中一条漏写 `owner_id IS NULL`，个人草稿就会泄漏到公网；
分表后这些代码从结构上根本查不到个人内容。同一个 slug 可以同时存在于主库和多个志愿者库。

⚠️ 任何个人库 SQL 都必须由服务端使用 JWT 中的 `req.user.id`，并同时带 `owner_id`；不接受客户端
传 owner id。删除个人游戏也只删资料行，**不能删 R2 文件**。管理员口令没有账号 id，所以永远
按管理员身份操作主库，不能伪装成某个志愿者。

部署必须 `cd server && npm run migrate`，否则志愿者接口会因缺表 500；启动自检会点名这两张表。
回归：`npm run test:volunteer-libraries` + `npm --prefix server run test:roles`。

### 2.30 部署形态与换机记录（2026-09-21 已迁到 38.76.186.225）

> 2026-11-15 `deploy/redeploy.sh` 的三处自动化（见 `docs/system-optimization-2026-11.md`）：
> - **备份拆两半**：`8bitgo-backup.sh --local-only` 同步 dump + 校验（失败照旧中止），R2 上传用 `--upload-file` 转后台、与构建并行，
>   `trap … EXIT` 保证任何退出路径都等它结束；上传失败只告警。`BACKUP_ASYNC_UPLOAD=0` 退回同步。
>   2026-11-25 曾出现一份有完整 footer 但压缩体量从 7.5MiB 降到 2.8MiB 的快照；不能为发布直接放宽一半体量哨兵。
>   首份仍以退出码 42 拒绝，`redeploy.sh` 等 30 秒后另做一次完整独立快照；第二份也偏小才以 `--confirm-size-drop` 接受，
>   上一份已验证备份继续保留，日志明确记录。任何其他备份错误照旧中止部署。回归：`cd server && npm run test:backup && cd .. && npm run test:redeploy`。
> - **lock 未变跳过 `npm ci`**（`deploy/lib/npm-ci-if-changed.sh`，戳在 `node_modules/.8bitgo-lock-sha256`）；`FORCE_NPM_CI=1` 强制重装。
>   以后若给根目录或 server 加 install / postinstall 钩子，要重新评估这条。
> - **开局冒烟**（可选）：`SMOKE_TEST=1` 时健康检查后跑 `scripts/smoke-start.mjs`，无头 Chrome 把一款 NES、一款 CPS1 街机和一款 GBA 跑到首帧；
>   拦下启动漏斗与游玩计数请求，不污染统计；失败只告警、不回滚。生产机需先装 Chromium（未装时记「跳过」）。

生产机是 **38.76.186.225**（Ubuntu 24.04，4C/4G）。旧机 103.242.13.112 已停服且
`8bitgo.service` 已 disable，**只作回滚后路 —— 它的数据库已冻结，别再在上面改任何内容**，
否则两边分叉。确认稳定后可退租。

- **本机 SSH 登录生产机**：使用 `ssh root@38.76.186.225`（22 端口）。省略 `root@` 会套用本机用户名，
  生产机不会接受该账号的密钥。已验证 root 登录成功，远端主机名为 `ecskbvbd`；不要把私钥、密码或 token 写进仓库。
- **人工发布入口**：登录后执行 `cd /var/www/8bitgo && ./deploy/redeploy.sh`。该脚本负责备份、拉取当前分支、构建、健康检查和失败回滚；
  不要用简化的 `git pull && npm install && npm run build && systemctl restart 8bitgo` 替代它。

- **进程守护是 systemd `8bitgo.service`，不是 pm2**（§1 那行 pm2 是历史遗留，已改）。
  由 `deploy/systemd/install-service.sh` 安装，`WorkingDirectory` 必须是 `server/` ——
  `dotenv/config` 从 `process.cwd()` 找 `.env`，指错就静默全废（见 `deploy/systemd/README.md`）。
- **nginx 站点在 `/etc/nginx/sites-available/8bitgo.com`**，生产版有三个专用 location
  （`^~ /socket.io/`、`^~ /ipx/`、`= /api/netplay/events`）和 `client_max_body_size 32m`
  （云存档 4MB / J2ME 20MB，**丢了上传必挂**）。XFF 用 `$http_cf_connecting_ip`（§2.16）。
  连接槽已由 `deploy/nginx/tune-nginx.sh` 调到 8192 × 4 worker = 32768。
- **两条 SSE 绝不能进入 Cloudflare 缓存。** 2026-10-17 公网取证到
  `/api/netplay/events` 返回 `cf-cache-status: EXPIRED` + `last-modified`，同时浏览器报
  `ERR_HTTP2_PROTOCOL_ERROR`。`sseGuard.js` 现在同时发 `Cache-Control`、
  `CDN-Cache-Control`、`Cloudflare-CDN-Cache-Control: no-store`，并且不再发 HTTP/2 禁止的
  `Connection: keep-alive`。Cloudflare Cache Rules 仍要把 `/api/live/events` 与
  `/api/netplay/events` 两个精确路径设成 Bypass，并排在 Cache Everything **之后**（冲突设置最后
  一条匹配规则生效）；`audit-migration.mjs` 会把
  `cf-cache-status: HIT/MISS/EXPIRED/...` 判为部署失败。
- **来源闸门在 nginx，不在 ufw（2026-10-27 起）**：大陆入口 cn.8bitgo.com 走 EdgeOne，而 EdgeOne
  不再公布回源 IP 段，ufw 只好对 80/443 全开。`/etc/nginx/conf.d/edge-gate.conf`（模板
  `deploy/nginx/edge-gate.conf`）只放行 Cloudflare IP 段、带正确 `X-8bitgo-Edge` 回源密钥的 EdgeOne
  和本机看门狗，其余 403；XFF 改用 `$client_ip`（CF 取 `CF-Connecting-IP`，EdgeOne 取
  `EO-Connecting-IP`）。这仍是采用这两个头换来的代价（否则可被直连源站伪造，见 §2.16）。
  ⚠️ 生效的站点文件是 `sites-enabled/8bitgo.com`，它是**独立副本、不是软链**，改 `sites-available` 没用。
- **备份：`8bitgo-backup.timer` 每 6 小时 → R2**。rclone 的 remote 名是 **`r2-8bitgo:`**，
  unit 里用 `Environment=R2_REMOTE=r2-8bitgo` 覆盖脚本的默认值 `r2`。换机前旧机连定时器
  都没装，备份全靠手动 —— 新机别再退回那个状态。
- **看门狗：`8bitgo-watchdog.timer` 每分钟探测**，探到故障自动重启（认得 systemd 单元；
  conf 全可省，见 `deploy/watchdog/8bitgo-watchdog.conf.example`）。
- **两台机器的 `.env` 除 `DB_PASSWORD` 外一字不差**。`ROM_PACK_SECRET` / `FLASH_SAVE_SECRET` /
  `JWT_SECRET` / `OPEN_*` 必须一致，否则旧 8BG 包解不开、所有人被踢下线；`DB_PASSWORD`
  是每台机器自己的（新机 MySQL 账号 `eightbitgo_app` 用的是独立口令）。
- **机密文件别漏**：`server/secrets/open-jwt.pem`（`OPEN_JWT_PRIVATE_KEY_PATH` 指着它，
  开放平台签令牌用）不在 git 里，换机要单独 rsync。

**下次再迁机照这个顺序**（2026-09-21 实操验证过）：

1. 新机装 node（**版本对齐旧机**，两边都是 v22.23.2）、mysql、nginx、git、rclone；
   顺手核对 `timedatectl` —— 新机 NTP 默认走 IPv6 而机器没有 IPv6 出站，
   `System clock synchronized: no` 会一直挂着（TLS / JWT / TURN 都受影响）。
2. 在**新机**生成一把临时密钥授权到旧机（迁完立刻删，别把本机私钥放上服务器）。
3. `rsync -a --delete` 整个 `/var/www/8bitgo`，排除 `node_modules` 和 `dist`
   （连脏改动一起镜像，保证与生产逐字节一致），并单独带走 `server/secrets/`、
   `server/.env`、`/root/.config/rclone/rclone.conf`。
4. 旧机跑 `deploy/backup/8bitgo-backup.sh --local-only` 出 dump（自带校验），传到新机导入。
5. `npm ci`（根 + server）→ `npm run build` → `npm run migrate` → 用生产 vhost 替换新机的
   （改证书路径）→ `nginx -t` → reload。
6. 切 Cloudflare A 记录（秒级生效），**切完立刻停掉旧机应用再补最后一次 dump 导入** ——
   切换前就连着的长连接（SSE / 联机 / 直播）用户还在往旧库写，这一步不做他们的写入就丢了。

### 2.31 按需翻译页不能把「界面已翻译」冒充成「正文已翻译」

游戏和文章页面允许缺少译文时回退到英文或简体，这是给访客的可用性兜底；对搜索引擎则必须
如实声明正文语言。只翻了导航、按钮和标题的 `/de/games/x` 如果仍 self-canonical，并列出八条
hreflang，Google 会收到多份正文完全相同的 URL，抓取预算和规范页判断都会被拖累。

- 前端：`gameSeoLanguagePlan` / `postSeoLanguagePlan` 算真正有正文的语言，以及当前 URL 实际回退
  到哪门语言；`useSeo` 只输出这些 hreflang，并把 canonical、og:url、JSON-LD URL 一起指到
  同一个版本。文章必须标题、摘要、正文三项都齐才算完整译文。
- 后端：动态 sitemap 使用同一判据。改其中一边必须同步另一边，并跑
  `npm run test:i18n-content && npm run test:sitemap && npm run test:indexnow`。IndexNow / 百度的
  详情页自动推送与全量补交也按这个语言子集过滤；列表、平台、类型页仍推全部语言。
- 图片 sitemap 只接收主域、`image.8bitgo.com`、`assets.8bitgo.com` 这类本站可验证域名；数据库
  里的第三方热链可以继续在页面显示，但不能写进 `<image:loc>`。内部 `covers/` key 走
  `COVER_BASE_URL`（默认 `https://image.8bitgo.com`）。
- `completeMetaDescription` 会给不足 80 个 Unicode 码点的数据库简介补上当前语言的
  `seo.descriptionFallback`，再由 `normalizeMetaDescription` 把 meta / OG / Twitter 摘要收敛到
  160 个码点；页面正文和 JSON-LD 保留全文。不要在调用方各自 `slice()`，否则中英文会按
  UTF-16 截出半个字符。普通页标题统一通过本地化的 `site.titleTemplate` 补足搜索意图关键词。

### 2.32 PSP ISO 后台压缩必须产出可随机读取的 CHD，不能套 8BG 整包

PSP 玩家启动后会持续 Range 随机读扇区，所以大 ISO 不能再套一层必须整包解密/解压的 8BG。
后台上传 `.iso` 时先走浏览器现有的 R2 multipart 断点续传到随机 `psp-staging/<uuid>.iso`，
API 服务器再用 `chdman createdvd -hs 2048 -c zstd` 生成 CHD；完整 `chdman verify` 通过后才用
R2 multipart 发布到最终 `roms/psp/*.chd`。`.cso` / `.chd` 保持直传。

- 任务在 `psp_conversion_jobs` 表里持久化，服务重启会重新排队；前端 localStorage 只负责恢复
  进度显示，不能成为任务唯一状态。部署必须先 `cd server && npm run migrate`。
- 下载临时 ISO 时用创建任务时记住的 ETag + `If-Match` 钉住对象代次，避免 R2 原地覆盖后拼错内容；
  最终对象也记住“任务创建时的 ETag”，发布前与 complete 前各核对一次，转换期间有人上传了新版就中止，
  不能拿几小时前的转换结果覆盖它。写回游戏绑定用 compare-and-swap，并钉住游戏数字主键；slug 改名或
  新建表单撞到旧 slug 都不能把 CHD 绑错游戏。
- 最终 CHD 只在 multipart complete 后可见。complete 响应断线时按目标 ETag 是否变化判定真成功，
  不能无脑重传；发布成功后把输出 ETag 落库，若进程在数据库绑定前重启就凭 ETag 直接收尾，不再压缩
  覆盖一遍。进程崩溃留下的 uploadId 会在重跑前 abort。
- 成功任务先标 completed 再删临时 ISO；失败源保留 24 小时，随后清扫。顺序反过来会在进程退出
  窗口制造既无法重试、状态又未完成的死任务。清扫器先用数据库 CAS 领取源文件，避免和“手动重试”
  同时发生；`source_deleted` 的 0 / 1 / 2 分别是保留 / 已删 / 正在清理。
- 前端创建任务把随机 `source_key` 当幂等键：响应途中断线可以重试，服务端只返回原任务。旧槽是
  `.chd` / `.cso` 而新文件是 `.iso` 时绝不复用旧 key，否则转换服务降级时会把 ISO 字节写进错误扩展名。
- 仓库当前待发布 PPSSPP 是实体目录 v16、Range loader v4：ISO/CSO/CHD 都用 2MB 分块，共用 96MB 内存 LRU，
  并主动带 `If-Match` / `If-Unmodified-Since`
  钉住同一代镜像。播放 URL 同时带 `romv=<ETag>`，Worker 必须在每次 Range 前把它与 R2 当前 ETag 比较；
  不一致返回 412。Range 必须绕过整包 Cache API；Worker 只把 `romv` 锁定、2MB 对齐且校验过 ETag 的
  PSP 分片用私有范围键缓存成 200，命中时再还原 206。任意短 Range、未版本化或条件不一致仍直达 R2。
  **不要再凭 CHD hunk 大小把 Range 改小。** Range v3 曾只给 CHD 改成 512KB，理论伴读是 2MB 的
  四分之一，但当前 loader 是模拟线程里的同步请求，生产 CDN 往返数也变成约四倍。693.6MB 测试盘
  真实冷启动从核心到游戏由约 86 秒退化到约 93 秒，因此 v4 恢复 2MB。以后调分块必须在同一地区、
  冷缓存、同一镜像上以 `Booted` 日志计时；不能用“单次请求更小”推导“启动更快”。
  v11 在 Emscripten Fetch 的同步 XHR 外加一层**自适应滚动预读**。DJMAX 的 1.42GiB CHD 线上取证到
  单个 2MB Range 约 2.4～7.5 秒，旧版 4MB 窗口会被连续音频读取周期性追上；快速网络现在提前
  8～10 块、最多四路并行，单路实测速率低或发生追尾时自动扩窗，连续命中后缓慢收回压力档。
  3G 从双路小窗起步，低内存双核设备最多双路，2G / 省流模式完全关闭；额外缓存上限 24MB，
  不能让预读与核心 96MB LRU 一起无界吃内存。命中后直接交给下一次同步 Range；随机寻道会取消旧方向。
  正式读盘追上预读时必须取消**全部**投机请求，让同步请求独占连接并在完成后重建窗口；取消前先把
  回调锁成终态，避免同步 `onabort` 重入后越过当前自适应并发上限。
  v12 的独立预读 Worker 把分片写入 SharedArrayBuffer，模拟线程同步读取追上它时可直接等待并消费，
  避免同线程异步回调被同步 XHR 阻断后重复下载。但《AIR》实测两条 pthread 都会读盘，预读约
  12 块仅命中 1 块，因此首次需求只用一条小窗口；确认相邻顺序读取才扩窗，连续四块仍低命中就
  收回到单路、4MB，并保留探测流恢复机会。`range-prefetch-worker.js` 必须和 JS/桥在同一个实体目录，
  `runtime.json` 要包含它的哈希。约 2MB 的边缘缓存命中分片在当前测试网络仍可花 4–12 秒，
  这不是音频缓冲能补救的；不要把“能进标题”称作完全消除游戏内停顿。
  v14 让正式读盘追上 SharedArrayBuffer 预读时先取消其它投机连接，只保留当前命中块；
  否则另外几路无用 Range 与当前必需分片争带宽，会把游戏线程的同步等待进一步拉长。
  `scripts/refresh-ppsspp-range-v14.mjs` 从已校验的 v13 生成不可变 v14，不能原地改旧目录。
  v15 修正低命中率永久锁住单路小窗口的反馈陷阱：确认持续顺序读取后只恢复到双路，
  一旦随机寻道立即收回；省流量和 2G 仍禁预读。由 `scripts/refresh-ppsspp-range-v15.mjs`
  从已校验的 v14 生成新实体目录，发布前必须让检查脚本核对源码与产物一致。
  v16（2026-11-04《GT 赛车》）只换 JS 读盘层：带 `romv` 的地址**不再发 If-Match / If-Unmodified-Since**。
  Chromium 的 HTTP 缓存对带这两个头的请求一律直通网络（kPassThroughHeaders），实测同一个已缓存的
  2MB 分片带 If-Match 每次 2.4 秒、不带 15 毫秒 —— 以前每局、每次进选车都把读过的块重下一遍。
  romv 已把代次钉进 URL（Worker 不一致回 412、缓存键也随之换），响应 ETag 仍由 C++ 逐块核对，
  外链（无 romv）照旧带条件头。由 `scripts/refresh-ppsspp-range-v16.mjs` 从 v15 生成（Wasm / data 不变）。
  播放器的「流式传输 / 整包下载」默认流式；整包用 8MB 有界 Range 分片写入 OPFS，
  下载完成后经现有本地光盘 SW 按需读，不把 1GB 镜像合成 JS Blob。只有带 `romv` 的
  完整镜像可复用本地副本；没有版本校验器的外链不得把多个 Range 拼成整盘。
  生成胶水补丁源在
  `vendor/ppsspp/range-read-ahead.js`，构建脚本按唯一片段注入；不要手改压成一行的发布 JS。
- 源站要装近期 MAME 的 `chdman`，并在 `server/.env` 配 `PSP_CONVERT_WORKER_URL`；转换临时盘
  至少留 `2 × ISO + 256MB`。默认并发 1，最多 2，避免压缩任务抢光玩家请求的 CPU / IO；
  `PSP_CONVERT_TIMEOUT_MINUTES` 默认 180，超时会先 SIGTERM、10 秒后 SIGKILL，不能让一个挂死的
  `chdman` 永久堵住整个单并发队列。
- 生产机的系统盘只有 20GB，`PSP_CONVERT_TMP_DIR` 必须指向专用数据盘
  `/var/lib/8bitgo-data/psp-conversions`，不能写回 `/var/lib/8bitgo/psp-conversions`。R2 下载使用
  4MB 背压窗口让网络读取和磁盘写入重叠；中途断线保留本地 ISO，并带 `Range + If-Match` 从已写字节
  继续。不能恢复成“每个网络小块 await 一次磁盘写入”，那会把数万个小写操作串行化。
- `chdman` 显式用 `PSP_CHDMAN_PROCESSORS`（留空按任务并发均分可用 CPU，最多 8；任务并发也不超过可用 CPU 数）。
  转换默认单并发；显式调高时总 chdman 线程仍受可用 CPU 预算约束。
  管理员端按 ISO 头 / 中 / 尾样本摘要续传同一 staging multipart；上传完成后的建任务请求保留到转换完成，
  防止服务端已接单但浏览器没记住任务 ID 时刷新后重复上传。任务失败可在 ROM 栏直接重试，复用已上传 ISO。
  staging 身份还绑定目标 key、当前绑定快照和覆盖授权；两页意图不同不能共用临时 ISO。
  建任务接口明确拒绝且未有任务占用的 ISO 会从 R2 清掉，401/403 与服务端仍在使用的源对象必须保留。
  完整 verify 通过后才记录 `output_size`，发布失败或服务重启会复用这份已校验 CHD，不能再次下载、
  压缩和校验。未通过 verify 的半份输出必须删掉，输入断点与已校验输出最多保留到失败任务 24 小时清扫。
- 最终 CHD 默认四路并发上传 8MB multipart（`PSP_CONVERT_UPLOAD_CONCURRENCY`，最多 8，峰值内存约
  并发数 × 8MB）；完成结果按 partNumber 排序，数据库账本只按可见进度批量落盘。不要把任务并发和
  上传并发混成同一个开关：前者增加压缩 CPU / 磁盘竞争，后者主要隐藏 R2 往返。

回归：`cd server && npm run test:psp-conversion`；再跑根目录 `npm run build`。

**PS1 是另一种光盘，不可借 PSP 的 `createdvd` 当作转换成功。** 后台 PS1 语言槽上传单数据轨
2048-byte `.iso` 会复用同一持久队列（`disc_platform='psx'`），生成固定 CUE 后执行
`chdman createcd -c cdzl`、`verify` 和 CD 轨道元数据检查，再把 `roms/psx/*.chd` 发布到 R2。
源文件仍放旧 Worker 已保护的 `psp-staging/`，不能擅自换成一个公开可读的新前缀。
上传前后都校验 ISO9660 和根目录 `SYSTEM.CNF`；单独 ISO 无法还原 CDDA 音轨，带音轨的原盘
必须先从 BIN/CUE 在本机制作 CHD。预检还要核对 2048-byte 逻辑扇区、根目录与 `SYSTEM.CNF` 的双字节序字段和文件范围，避免上传整张盘后才发现目录损坏。裸 CHD 带固定 `romv` 且 R2/Worker 返回匹配的强 ETag、
正确 206/Content-Range 时，播放器先取首尾 2MB 块，开局后由 Beetle PSX 软件核心按需读盘；
Range 不可用、版本不匹配或 CHD 格式不对时回退完整下载。 `.chd.8bg` 外层容器仍走完整
解包，不能冒称边下边玩。旧 Beetle PSX HW 核心在浏览器触发 WASM `null function`，所以
CHD 固定用自建 `mednafen_psx` 软件核心；该包关闭了上游 Emscripten 的整盘预缓存，
否则模拟器会在开局前读满 CHD。新旧 Beetle 即时存档隔离，不能混用。日本区盘应配置
日本区 BIOS；`scph1001.bin` 是美区 BIOS，不是正式兼容性验收的替代品。
⚠️ **流式读盘的异步预热与同步随机读必须共用主页面源。** EmulatorJS 位于 sandbox `srcdoc` iframe，
其 XHR 是不透明源；若核心缺片时用 iframe 的 `XMLHttpRequest` 发跨域 Range，R2 可能因
`Origin: null` 拒绝，即使父页面的首尾 `fetch` 已成功、日志也显示「Range 已挂载」，游戏仍会黑屏。
`psxRangeDisc.install()` 必须接收并使用外层页面的 `window.XMLHttpRequest`；不要把 iframe `Window`
传给它。回归由 `npm run test:disc-upload` 锁住调用源、`npm run test:psx-range` 覆盖分片读取。
实测样本《J. League Jikkyou Winning Eleven 2000 2nd》319MB CHD 在本地浏览器按需读取，
经过开机、标题、模式选择、手柄分配和球队选择；方向键能切换球队，确认键能进入下一级菜单。
已进入正式比赛，比分变为 0:1、比赛时间走到 1:57；该阶段累计仅请求约 59MB（整盘的 18.5%）。
这证明流式读盘和玩家输入在样本上可用，但尚未完成整场比赛或其它 PS1 游戏的通关验证。
部署前需迁移新增的 `disc_platform` 列；回归：
`npm run test:psx-conversion && npm run test:psx-range && npm run test:disc-upload && npm run test:ejs-cores`。

**PS1 双盘 / 多盘（2026-10-30）**：后台在语言槽 ROM 区提供「上传双盘 / 多盘组」，只收 2–8 张裸 CHD，选择顺序就是盘片顺序。先为每张盘上传到随机、不可变的同目录 key，最后才发布 `discs.m3u` 并改绑当前语言；失败不覆盖旧绑定，成功后仍需保存游戏条目。M3U 每行必须是**相对文件名**（不带 pipe 标签；PCSX 核心会把整行当作文件路径），当前只允许同目录 CHD，不接收 URL / 子目录 / ZIP。玩家侧先校验小于 16KB 的版本化 M3U，再逐盘 HEAD 强 ETag、检查 2MB–1GB 大小，并为每张 CHD 绑定自己的 `romv`；任一盘未发布或 Range 不匹配就明确报错，不能退回“下载 M3U 当单盘”。M3U 固定走 `pcsx_rearmed`（Beetle 不一定认识各盘压缩器）；核心、引擎的磁盘菜单和扩展盘控制接口都必须存在。多盘存档继续用游戏基础 slug，切盘不新建另一份游戏存档。启动只预热每张盘首块与当前盘尾块，非当前盘按需读；32 个 2MB 缓存块按盘数分摊，避免每盘各留 64MB。流式进度必须报真实总盘容量并设 `streaming: true`，不可把已预热块伪报成整盘 100%。

⚠️ EmulatorJS / libretro 的文件读取接口是同步的：Range 缓存未命中时现有同步 XHR 仍可能短暂阻塞主线程；顺序预读与内存上限只能降低概率，不能声称完全消除。要做真正非阻塞随机读，需核心提供异步文件 IO，不能把 `stream_ops.read` 改成返回 Promise。多盘回归：`npm run test:psx-multidisc`，并连跑 `npm run test:psx-range && npm run test:disc-upload && npm run test:psx-conversion`。

🔴 **CHD 不能一律交给 Beetle：自建 `mednafen_psx` 没有 FLAC 解码器（2026-10-25 线上确认）。**
- **现象**：线上全部 5 款 PS1 CHD（含 Range 流式的《实况胜利十一人 2000》）开局都停在 RetroArch「Quick Menu / No Items」，没有报错。
- **原因**：该 wasm 的 libchdr 只编进了 `cdzl` / `cdlz`。chdman createcd 的默认压缩是 cdlz + cdzl + **cdfl**，而 chd_open 要给头里的每个压缩器建解码器，缺一个就整盘打不开。核心日志只有一句 `TOC first(99)/last(0) track numbers bad.`。
- **修法**：`psxChd.ts` 的 `chdCompressors` / `psxChdCoreForCodecs`。读 CHD 头（Range 用首片，完整下载读 blob 头 32 字节）：
  - 压缩器全在 Beetle 认识的集合里 → 走 Beetle；
  - 否则 → 走 `pcsx_rearmed`。PCSX 带全部四种 CD 解码器，实测能按需读取 Range 挂载的 CHD：开到片头只取了约 11MB，60fps。
- **预热**：CHD 预测落到 PCSX。
- **报错**：`track numbers bad` 已进 FATAL_PHRASES，不会再停在空菜单。
- **回归**：`test:disc-upload` 会解包两个核心，取证两边各自有哪些解码器。以后给 Beetle 重编进 FLAC，就要同步放宽 `BEETLE_CHD_CODECS`。
- **数据侧备选**：`chdman extractcd` 后用 `createcd -c cdzl` 重压，可以让这张盘回到 Beetle。

🔴 **自建核心的即时存档胶水：melonDS DS 与 mame-current 必须是 v3（`scripts/patch-ejs-state-glue.mjs`），Beetle PS1 保持 v2（`scripts/patch-psx-save-state.mjs`）**（2026-10-25；mame-current 2026-10-26 补上，胶水是未压缩排版，脚本用空白不敏感正则替换）。

两个核心链接的 EJS RetroArch 1eb5edf 在 `save_state_info()`（tasks/task_save.c）里，把说明写进**栈上的** `char state_data[300]` 再返回其地址。旧胶水因此有三处问题：

- `_free(info)` 释放的是这个栈地址；
- `_free(data)` 传的是 Uint8Array，实际等于 free(0)；
- 真正 malloc 出来的快照从不释放。

线上实测 NDS 每取一次状态就漏约 19.7MB：5 次让 wasm 堆从 858MB 涨到 973MB。换成 v3 胶水后取 10 次堆不再增长，loadState 正常。失败分支读到的说明已被覆盖，控制台出现「Failed to save state! 댟」。

v3 的修法：
- 先复制快照，只释放 dataStart；
- 说明不是可打印 ASCII 时换成固定文字，并降为 warn。

Beetle PS1 的两个包已是 v2（泄漏已修），且 `check-emulatorjs` 按 Range 实玩验收过的 sha256 锁定，所以没上 v3。要上 v3，先重做浏览器实玩验收，再改锁定值。

开局能力探测对这两个核心只调 `supportsStates()`，不再真取一次整机快照，所以开局不会再出现乱码报错。`build-melondsds-core.mjs` 打包时会带上同一补丁。

melonDS DS 的包换了，要同步四处：报告 sha256、`NDS_MODERN_CORE_BUILD`、`EJS_CACHE_GENERATION`、`EJS_RUNTIME_GENERATION`。脚本会一并改好，`test:psx-state` 负责核对。

### 2.32.0.1 PPSSPPSDL.data 必须预压缩；核心下载要算进 engine 进度（2026-11-04《GT 赛车》）

- `PPSSPPSDL.data`（19.4MB，字体 / 图集 / 着色器）是 `application/octet-stream`，**Cloudflare 不压这个类型**，
  线上一直明文传：同一次冷启动 wasm 走 zstd 传 5.6MB，data 实打实 19.4MB、约 20 秒。现在由
  `server/src/precompressed-static.js` 在 express.static 前面接手：白名单路径 + 接受 br + 非 Range + `.br` 存在
  才吐 `PPSSPPSDL.data.br`（Brotli 11，9.2MB，-53%），两条路都带 `Vary: Accept-Encoding`。已实测
  Cloudflare 会把源站的 `Content-Encoding: br` 原样交给浏览器（Terraria 的 `.dat` 同理）。
- 新实体目录（v17 …）发布后跑 `npm run ppsspp:precompress -- <目录>`（v16 已带 `.br`）；`check-ppsspp` 会把 `.br` 解开对 runtime.json 的
  sha256，缺失或过期直接失败。v16 是新 URL，边缘没有旧的明文副本；以后若给**已发布**目录补 `.br`，要在 Cloudflare / EdgeOne 清掉那个 URL。回归：`cd server && npm run test:precompressed-static`。
- 远程流式启动时桥是在 `mount-remote` **之后**才下 36MB 核心。适配器以前 host-ready 一到就报 rom
  （还带探测那 2 字节，速度栏显示「1 B/s」），engine 段一秒走完、核心下载挤在 10% 的 rom 段里，条子停在
  50% 二十秒。现在同源观察桥的 `#status`：「正在下载 PSP 核心资源… NN%」→ engine ratio，换成「正在流式读取
  游戏」或收到第一条 stream-progress 才进 rom。桥文案变了 `test-ppsspp-range` 会报。
- PSP 现在有音量（核心总输出 GainNode `__ppssppAudio.node`，读档 / 重开音频后 1 秒内压回）、截图（captureStream，
  占位 canvas 不能 getContext）和录像（captureSources 早就给直播用）。暂停仍没有：桥没有暂停命令，要改原生补丁。

- **各平台模拟器的 wasm 也预压缩**（2026-11-09，`scripts/precompress-runtimes.mjs`，prebuild 生成、postbuild `--check dist/client` 核对）。
  在生产机上实测 Cloudflare 现场压 wasm 比 Brotli 11 大 25~30%（Ruffle 4.68→3.26MB、Dolphin 4.59→3.22MB、DOSBox-X 2.69→2.02MB、
  Play! 0.96→0.69MB），名单：Ruffle / js-dos（wdosbox、wdosbox-x、jspi、wlibzip）/ Dolphin / Play! / PPSSPP 的 wasm 和
  `emulatorjs/emulator.min.js`，与 `precompressed-static.js` 的 `PRECOMPRESSED_STATIC_PATTERNS` 一一对应（测试核对）。
  EmulatorJS 的 `cores/*.data` 本身是 7z（LZMA2），最强档重压只省约 2%，不预压。生成物 `<文件>.br` + `.br.json`（原文件字节数与 sha256）
  不进 git；按 sha 跳过未变的，相同内容只压一次（首次全量约 1 分钟）。中间件只在原文件字节数与 `.br.json` 一致时才吐 .br，
  wasm 必须带 `Content-Type: application/wasm`，否则流式编译直接失败。⚠️ 这些文件在 Cloudflare / EdgeOne 上是一年长缓存，
  上线新压缩版要清掉对应 URL 的边缘缓存，否则继续吐旧的现场压缩副本。

### 2.32.0.2 PPSSPP v24：两个带 v128 的 `invoke_` 导入改走 Wasm 跳板（2026-11-22，诊断包 #2481《初音未来：歌姬计划》）

`type incompatibility when transforming from/to JS` 不是 QQ 浏览器特有：WebAssembly JS API 任何浏览器都不让 v128 过 JS 边界。
核心里只有 `invoke_iiViijjji` / `invoke_iiViijjjij` 两个导入签名带 v128，调用点全在 `GamepadEmuView` 构造（PPSSPP 自带触屏按键，
`bShowTouchControls`；桌面 SDL 构建默认关）。玩家在 PPSSPP 菜单里打开触屏按键就崩，且设置按游戏存在 IDBFS，之后每次开局都崩。
v24（`scripts/refresh-ppsspp-simd-v24.mjs` 从 v23 生成，Wasm / data 不变）在胶水里造一个 145 字节的辅助模块，导出同签名函数、
经自己的表 `call_indirect`，`receiveInstance` 后把主表拷过去；构建失败就保留原包装并记日志。i64 / BigInt 不是原因（构建用 WASM_BIGINT，
缺 BigInt 集成会在开机就失败）。根治要改 `GamepadEmu.cpp` 不按值传那个被打包成 v128 的结构，或用原生 Wasm 异常重编。
回归：`node scripts/test-ppsspp-simd-trampoline.mjs`（并入 `test:ppsspp`）。还没在真浏览器里开过触屏按键验证。

### 2.32.0.3 PPSSPP v25：弱网 Range 时限不能固定 20/30 秒（2026-11-26，CN 0.2–0.25 Mbps 慢启动）

2 MiB 在 0.2 Mbps 上理论就要约 84 秒；固定 20 秒预读 / 30 秒正式 Range 会中止并丢弃已收字节，再从块头重拉，
使有效吞吐进一步下降。`vendor/ppsspp/range-read-ahead.js` 现在取 Network Information 的 downlink 与本局已完成块速率中
较保守的一项，按“预计传输时长 × 1.5 + 10 秒”计算，限制在 20–180 秒；同步 XHR、普通预读、共享预读 Worker
共用这一时限。省流量与 2G 仍关闭投机预读，只有正式按需块会使用自适应时限。

桥的 300 秒挂盘计时改为**无进度空闲时限**：只在核心下载百分比变化或真实 ROM Range 字节到达时续期，单纯心跳不续期，
所以仍无进展 5 分钟会失败，但低速且仍在前进的开局不会因总耗时超过 5 分钟被误杀。诊断快照里的
`__8bitgoPspRangeWarmStats().rangeTimeoutMs` 用于确认当前估算。修复发布为不可变 `v25/`；
`paths.ts`、旧入口 302、`check-ppsspp` 与 `test:ppsspp` 必须一起换代。回归：`npm run test:ppsspp`。

### 2.32.1 PSP 必须留在普通详情页内启动，不能再复用 PS2 的独立播放器外壳

PPSSPP 的 pthread 仍然需要 `Cross-Origin-Opener-Policy: same-origin` 与
`Cross-Origin-Embedder-Policy: require-corp`，但这不等于必须跳到 `/play/psp/<slug>`。
正常 `/games/<slug>` 本来就是顶层文档：SSR 取到游戏数据并确认平台为 `psp` 后，直接给这份详情页
加隔离头，`GameDetailPage` 同时绕过 `IsolatedPlayCard`、原地挂载 `EmulatorPlayer`。这样玩家点开始后
仍能看到标题、资料、侧栏和普通播放器尺寸；旧 `/play/psp/*` 只为历史链接保留。站内 SPA 跳转不会
重新请求响应头，所以第一次从列表进入 PSP 详情页时要自动完整刷新一次，并防住错误配置导致的刷新循环。

⚠️ 开了 `require-corp` 后，跨域封面、视频和 ROM 响应必须明确允许被隔离页加载。公开 R2 Worker
除了 `Access-Control-Allow-Origin: *`，还必须发
`Cross-Origin-Resource-Policy: cross-origin`；否则页面本身正常，封面/媒体却会被浏览器静默拦截。
后台手填的第三方封面 / 视频通常不带这两个头，不能指望对方配合：`GameCover` 对完整外链统一改走
`/api/games/:slug/media/:kind` 同源代理。代理目标必须按 slug + kind 回查数据库，并在每次跳转前挡住
内网 / 保留地址；不准改成接收任意 `?url=` 的开放代理。视频 Range 必须透传，否则卡片循环预览会反复整包下载。
回归：`npm run test:game-media`。
隔离页也不加载字节的外部收录脚本，避免第三方响应缺 CORP 反复报错。改这套响应头后要同时部署
站点和 `worker/standalone/rom-worker.js`，并清理 Cloudflare 已缓存的 PSP 详情页 HTML；旧缓存没有
COOP/COEP，前端再新也拿不到 `SharedArrayBuffer`。

PPSSPP iframe 的入口必须保留完整的 `/ppsspp/<版本>/index.html`。`server/src/url-normalize.js`
只可把站点页面的 `index.html` 归一掉；`dolphin` / `j2me` / `ppsspp` / `web` 下的是公开运行时真文件，
删掉会 301 到不存在的目录 URL 再返回 404。`test:robots` 同时守住 SEO 规范化和这条例外。
修规则后还要提升适配器里 iframe URL 的入口代次，绕开 Cloudflare 已缓存的旧 301。

⚠️ Emscripten 5 的 `IDBFS` 不是页面全局变量，挂载必须从 `FS.filesystems.IDBFS` 取；
否则核心下载完会在 `preRun` 直接报 `IDBFS is not defined`，玩家只看到 40% 后失败。
`WORKERFS` 虽然也在 `FS.filesystems` 下，但它的 `mount()` 明确断言只能在 Worker 运行；
`PROXY_TO_PTHREAD` 的 `preRun` 却在页面线程，因此选本地 ISO 必然中止。`FS.createLazyFile`
同样不可替代：它会在页面线程发同步 XHR，现代浏览器直接拒绝。v13 改用同源 Service Worker
把 PPSSPP 的 HTTP Range 请求转发给当前 iframe 持有的 `File.slice()`，只传所需分片、不上传 ROM，
且本地盘也要等核心 `Booted` 才报告成功。回归：`npm run test:ppsspp-local-disc`。
CMake 还必须显式链接 `-lidbfs.js`，只写桥代码
不够；`scripts/check-ppsspp.mjs` 会同时检查 host 引用方式和二进制是否真的含 IDBFS。缓存代次按
下方 PSP 性能小节的实体目录规则更新，桥、核心和 data 必须作为同一代原子发布。

⚠️ `-sPROXY_TO_PTHREAD=1` 和 `-sOFFSCREEN_FRAMEBUFFER=1` 还不等于 GL 会自动跨线程工作。
SDL 的 Emscripten EGL 入口把整个 `eglCreateContext` 代理到主线程，只在那里建立真实上下文，
PPSSPP 所在的 pthread 仍没有 `GLctx`；首次 `glGetString` / `glGetIntegerv` 就会报
`Cannot read properties of undefined (reading 'getParameter')`。浏览器构建必须在
`SDL/SDLGLGraphicsContext.cpp` 直接调用 `emscripten_webgl_create_context`，设置
`EMSCRIPTEN_WEBGL_CONTEXT_PROXY_FALLBACK` + `renderViaOffscreenBackBuffer=false`。配合
`-sOFFSCREENCANVAS_SUPPORT=1`，支持的浏览器会把 canvas 直接转交 Worker；不能转交时才回退到
主线程代理。v6 的 `PROXY_ALWAYS + OffscreenFramebuffer` 每条 GL 调用都跨线程，虽然能出画面，
却会给 framebuffer-heavy 游戏增加不必要的排队与拷贝；v8 的直接 Worker 上下文才是主路径。

PPSSPP 原来的 `gl3stub.c` 把 GLES3 核心函数声明成动态函数指针，和 OffscreenFramebuffer 的
Emscripten GL 导出发生符号类型冲突；补丁因此让浏览器构建直接使用 `<GLES3/gl3.h>` 的核心入口，
只有可选扩展继续走 `SDL_GL_GetProcAddress`。验收以 `PPSSPPSDL.js` 同时含
`transferControlToOffscreen` / `offscreenCanvases`，并保留作为回退的 `createOffscreenFramebuffer` /
`proxyContextToMainThread` / `emscripten_webgl_do_create_context` 为准；构建与发布检查都会拦截错误产物。

⚠️ SDL2 的 Emscripten 音频驱动虽然用 `MAIN_THREAD_EM_ASM_INT` 在主线程创建 `AudioContext`，
但 2.32.10 读取原生采样率的那一处却用了普通 `EM_ASM_INT`。`PROXY_TO_PTHREAD` 下它会去工作线程的
`Module.SDL2` 读主线程对象，开局在首帧前报
`Cannot read properties of undefined (reading 'audioContext')`。`0002-sdl2-pthread-audio.patch`
把该读取也代理回主线程；`scripts/build-ppsspp.mjs` 会先解出并打补丁，再精确失效
`libSDL2-mt.a` 和最终链接产物。不要只手改构建机缓存，否则 emsdk 清缓存后故障会原样回来。

⚠️ 只修采样率仍不够：SDL 的 `ScriptProcessor` 随后会在浏览器主线程直接 `dynCall` C 音频回调，
而 PPSSPP 的 main 和 `thread_local` 音频状态都在 pthread，不能让浏览器主线程进入那份 Wasm 线程状态。
`0003-pthread-audio-ring.patch` 因此绕过 SDL WebAudio 设备：PPSSPP 工作线程在主循环里产出 float stereo
PCM 到共享 Wasm 环形缓冲区，浏览器音频线程只用 `Atomics` 取样播放，绝不再回调 Wasm。`0006-web-performance.patch`
把消费端从会被页面布局、聊天和直播 UI 长任务打断的 `ScriptProcessor` 升成 `AudioWorklet`；旧浏览器才回退。
运行时 JS 必须同时包含 `__ppssppAudio` / `AudioWorkletNode` / `createScriptProcessor`，`runtime.json` 必须声明
`pthreadAudioContext=shared-ring-buffer-worklet-fade-v2`；缺任一项都拒绝发布。Range 偶发卡住时，
AudioWorklet 会把最后一个有效采样衰减到 0，恢复时用 32 帧淡入，并上报真实缺失帧数；它只消除
波形断点的爆音，不扩大音频缓冲或伪造采样，所以不会给 DJMAX 这类音游额外增加判定延迟。

这份自建音频节点同时是 PSP 直播的声音采集源：`adapters/ppsspp.ts` 每次开播都从同源 iframe
现取 canvas 与 `Module.__ppssppAudio`，再交给全站 `captureFeed`。不能只返回 canvas，否则主播本机
有声音、观众端会永久静音；也不能缓存第一次拿到的节点，音频设备重建后旧节点已经失效。AudioWorklet
模块加载是异步的，所以 `__ppssppAudio.node` 必须是一开始就创建的稳定 Gain 总线；worklet / fallback
只替换总线的输入源。若把 `node` 留成 null，玩家在首帧后立刻开播会永久漏掉本次音轨。

### 2.32.2 PSP 性能：不能让 Retina 尺寸决定 WebGL 后备缓冲

PSP 原生只有 480×272。旧 Web 壳让 SDL 带 `ALLOW_HIGHDPI`，在桌面 Retina 上实测创建到
1948×1096；但 PPSSPP 内部仍只渲染 960×544，代理 WebGL 每帧白复制、合成并给直播编码器输入
约 4 倍无新增细节的像素。`host.js` 按设备能力固定三档后备缓冲：480×272（移动/省流/弱网/低配）、
640×360（默认）和最高 720×408（明确高配桌面设备）；核心内部分辨率统一固定 1x，三档只改变最终呈现画布。
不要再按 CSS 尺寸、DPR 或浏览器全屏尺寸回写 canvas 的 width/height。

浏览器 SDL 窗口不再启用 `SDL_WINDOW_ALLOW_HIGHDPI`，启动参数显式带 `--windowed --xres --yres`。
这和页面 CSS 的响应式铺满是两件事：CSS 仍可把 960×544 画面放大到播放器宽度，只有昂贵的后备缓冲
被限制。原有 960×544 上限从 2,135,008 像素降到 522,240（少 75.5%）；v22 再将最高档限制到 293,760 像素，
普通设备 640×360（230,400 像素），移动/弱网/低配设备固定在 PSP 原生 480×272（130,560 像素）。

发布核心还必须保持 `WASM_ENABLE_LTO=ON`，pthread 预热池限制在 4–8 条；浏览器报 16/32 核时
预建同等数量 Worker 只会拖慢启动，而当前 PPSSPP Web 实测总线程不超过 6。核心每 300 帧上报一次
VPS/FPS、实际 FPS、画布尺寸和音频模式，供真机确认选档与掉速，不能逐帧跨线程发消息。
`runtime.json` 以 `performanceProfile=adaptive-performance-first-device-v1`、`maxCanvasPixels=293760`、
`pthreadPoolMax=8`、`lto=true` 和 `performanceTelemetry=true` 固化验收。

⚠️ 自适应只选最终画布与 SAS 线程，不再提高游戏的内部分辨率。v8 给**所有 PSP**统一写入
`InternalResolution=1`、`SkipBufferEffects=False`、`SkipGPUReadbackMode=0`、`HighQualityDepth=True`、
`FrameSkip=0` / `AutoFrameSkip=False`。不要再按某款游戏加一串 slug 特判：完整缓冲/回读是正确性
基线，代价只是少一点放大画质和性能捷径。

⚠️ 《寂静岭：起源》冷启动时出现的彩色花屏不是 CHD、Range 或 framebuffer 损坏，而是 Web 构建
曾固定 `USE_FFMPEG=OFF`：游戏已经 Booted，但开场 PSMF 的 H.264 帧没有解码器。参考站能直接到标题
是因为页面自动读取了旧进度，跳过开场，不能拿它和无存档冷启动比较。`0010-wasm-ffmpeg.patch` 让
Makefile 接受锁定的 FFmpeg 目录；`scripts/build-ppsspp.mjs` 从 PPSSPP 自己固定的 ffmpeg 子模块提交
`1e3b4965632f60b1d85360261d1b9dd45444bc71` 构建最小 wasm 静态库，只保留 H.264、AAC、ATRAC3、
ATRAC3+ 和 MP3 解码。构建/发布检查必须同时看到 `USE_FFMPEG:BOOL=ON`、Wasm 中的 `H.264` 标记与
`runtime.json.mediaEngine=ffmpeg-h264-audio-minimal`，否则会复发“能启动、视频却花屏”。

⚠️ 核心代码、桥和约 19MB 的 `PPSSPPSDL.data` 必须作为**一个实体目录原子换代**。Web 构建会通过
`0008-web-cold-start.patch` 排除不会在播放器中开放的 `assets/debugger/`（React 调试器、source map
和图标接近 3MB）；游戏字体、VFPU 表、语言、控制器表和兼容数据库全部保留。2026-09-25 线上取证发现，
Cloudflare 对这组静态文件的缓存键**忽略查询串**：请求 `PPSSPPSDL.data?r=17` 仍命中旧的 r16
（22,417,304B，`CF-Cache-Status: HIT`），而新清单需要 19,434,861B。查询参数不能再承担版本隔离，
否则新 JS、旧 data 和旧 Wasm 会被拼在同一局里。当前整套资源发布在
`public/ppsspp/v0dbfaca/v25/`（上一版为 v24）；下次桥、JS、Wasm、data、Range 胶水或 AudioWorklet 任一项改变就
复制/构建到 `v26/`，并同步 `PPSSPP_RUNTIME_GENERATION` 和服务端旧地址 302。旧目录保留给旧页面，
不原地覆盖。

**v26 是仅校验壳的窄例外（2026-11-27）**：这次只给桥和入口加入核心完整性校验，核心 JS/Wasm/data 的字节没有变化。
`v26/` 的入口与桥显式从 `../v25/` 读取核心，并在 `runtime.json` 记录 `coreAssetGeneration=v25`；这样不会让玩家因
校验代码更新而重新下载约 38MB 的核心。v25 仍是完整、不可变的一代，v26 不复制或修改它。v26 用 SRI 检查核心 JS，
Wasm 在浏览器流式编译期间并行校验 2MiB SHA-256 块，data 在既有下载缓冲上校验同一清单；`check-ppsspp` 检查 v25 核心、
v26 清单、入口 SRI、运行时校验块以及 dist 拷贝一致。此例外只允许复用**字节完全相同且 manifest 哈希相同**的核心：以后
只要 JS / Wasm / data 任一字节改变，就必须先建新的 `PPSSPP_CORE_ASSET_GENERATION`，重新生成核心分块与 SRI，再发布新的桥目录；
不能把旧 v26 桥指向一代未经验证的核心，也不能原地改写 v25。
v13 只修桥和新增本地光盘 Service Worker；v14/v15/v16 只修预读胶水，Wasm/data 与 v13 的 SHA-256 相同。
v17 只改桥（`scripts/refresh-ppsspp-edge-v17.mjs` 从 v16 生成）：iframe 地址带 `edge=cn`（大陆访客，
`paths.ts` 的 `ppssppFrameUrl`）时，`PPSSPPSDL.wasm` / `.data` 改从 `cn.<裸域>/_cn/ppsspp/...` 取。只能挪这两份：
`PPSSPPSDL.js` 是 pthread Worker 入口，预读 Worker、Service Worker 也都必须同源；wasm 只在主线程编译后传给 Worker。
胶水没有 wasm 加载钩子（流式编译失败会用同一 URL 再取），所以桥只对这两个地址包一层 fetch：首次走 EdgeOne，
失败或同一文件第二次被请求就回同源。`cache.js` 对 `req.cnEdge` 发 `CORP: cross-origin`，否则跨源隔离页会拦下。
v18 只换 JS 读盘层（`scripts/refresh-ppsspp-retry-v18.mjs` 从 v17 生成，Wasm / data 不变）：正式的同步 Range 读
遇到网络层失败（status 0）时，`range-read-ahead.js` 先就地退避重试 4 次（0.8 / 2 / 4 / 8 秒，单次请求累计超过
45 秒不再重试），失败的那几次不让 Emscripten 看到，最后一次才原样交回 C++。2026-11-10 后台：阿尔及利亚、智利玩家
进游戏几十秒后报「Range request failed: HTTP 0」整局失败，C++ 自己的三次 250 / 500ms 重试扛不住跨洲线路的短暂断流。
诊断看 `__8bitgoPspRangeWarmStats()` 的 `syncRetries` / `syncRecovered` / `syncTimeouts`。
v19（`refresh-ppsspp-retry-v19.mjs` 从 v18 生成）：**超时**后的重试把时限翻倍（30 → 60 → 120 秒，整个请求最多
3 分钟）。慢线路上 2MB 分片本来就要 30 秒以上，用同样的 30 秒重试只会再超时；游戏会卡住等盘，但不再整局失败。
已排除的方向：assets / cn-assets 两条线路的 206 在 MISS 与 HIT 下都带 ACAO 与 CORP，HTTP 0 不是缓存丢头。
`scripts/refresh-ppsspp-js-runtime.mjs` 仍是生成 v12 的历史入口，不要用它覆盖 v13～v23。
下一次重新构建核心前，先把 `scripts/build-ppsspp.mjs` 的历史目标代次（当前仍指 v12）和对应清单模板一起升到 v26；
构建必须从 v25 完整目录复制桥、入口、AudioWorklet 和 Service Worker，再替换核心产物，不能只留下 3 个核心文件。

v20（`scripts/refresh-ppsspp-stability-v20.mjs` 从 v19 生成，Wasm / data 不变）修 2026-11-15 QQ Browser 21
《初音未来：歌姬计划》现场暴露的两件事：实际 canvas 报 1533×777，超过 profile 规定的 960×544，说明只传
`--xres/--yres` 没有约束 Emscripten 最终 backing buffer；现在在主线程和 Worker 的 canvas 尺寸入口都按宽高比例封顶，
慢网再降到 480×272。此前性能档只看 CPU 核数 / 内存，1.3 Mbps、800ms 的 3G 设备仍启用高分辨率和独立 SAS 线程；
现在 `saveData`、2G、弱 3G（downlink ≤3 Mbps 或 RTT ≥400ms）、downlink ≤1.5 Mbps 或 RTT ≥800ms 都关闭额外 SAS 线程，
并用低画布档减少呈现开销。它针对现场的 FPS 与音频欠载做缓解，不能保证消除由同步 Range 等待造成的声音中断。

该现场最后的 `type incompatibility when transforming from/to JS` 是 V8 的 Wasm/JS 边界类型转换异常；ROM 已启动且只按需读了
73.6 MB，报告没有原始 worker 调用栈，所以**不能据此断言 CHD、FFmpeg 或音频桥是 TypeError 根因**。v20 将 Emscripten pthread 的
`ErrorEvent.error.stack`、文件行列号一路送进启动诊断包；后续同类现场先看这段 worker 栈再定位具体回调，不按错误字符串猜补丁。

v21（`scripts/refresh-ppsspp-compat-v21.mjs` 从 v20 生成，Wasm / data 不变）根据该现场补了两层保护：QQ Browser
（含 `QQBrowser`、`MQQBrowser`、`QQ/` UA）固定 480×272 画布并关闭额外 SAS 线程，避免继续走高性能档；运行时错误上报前
先触发一次 IDBFS 存档冲刷，最多等 1.5 秒，IndexedDB 卡住时仍会继续报错。v20 的 worker 栈采集保留，因此后续复现可以
从调用栈继续定根因。性能档是兼容性缓解，不代表确认了 QQ Browser 的 Wasm 类型转换根因。

v22（`scripts/refresh-ppsspp-performance-v22.mjs` 从 v21 生成，Wasm / data 不变）改为性能优先的三档设备画布：
移动端、QQ Browser、省流/弱网与可识别低配设备固定 480×272；普通或设备信息不完整的设备用 640×360；只有桌面设备
同时报告至少 8 个逻辑核和 8 GB 内存才升到 720×408 并启用独立 SAS 线程。主线程和 Worker 的实际 canvas
backing buffer 使用同一条件，`scale <= 1` 不会放大原始尺寸。最高绘图缓冲从 v21 的 522,240 像素降到 293,760，
PSP 游戏内部分辨率仍固定 1x。旧 v21 运行时保持不可变。

v23（`scripts/refresh-ppsspp-routes-v23.mjs` 从 v22 生成，Wasm / data 不变）给真实游戏盘的同步 Range 读增加同一内容版本下的主站 / 镜像候选：异步探测谁先读到有效响应，核心线程正式读盘中途遇到网络失败后也可换线路。原始 QQ Browser 现场的 `type incompatibility when transforming from/to JS` 仍没有 worker 栈，v20 的 `ErrorEvent.error.stack` 采集保留到 v23；该机制不是对类型异常的根因修复。下一份同类诊断先核对 worker 调用栈再定因。

Emscripten
自带的 preload fetch 没有重试，`host.js` 用 `getPreloadedPackage` 接管：优先读浏览器缓存，连续
30 秒无字节才中止当前连接，最多自动重试 3 次；已知长度时直接写进最终 ArrayBuffer，不能先存分片
再复制一整份（移动端会在解包前多出约 19MB 峰值）。每次失败进入重试前还要主动 abort 旧 controller；
长度越界等错误发生在流中途时，单纯离开 reader 循环不会保证旧的 19MB 响应立刻释放。
Emscripten 5 的生成胶水默认不会等待 `getPreloadedPackage` 返回的 Promise，会把 Promise 直接当
ArrayBuffer 解包并报 `bad input to processPackageData Promise`；构建脚本会在锁定的生成片段上补
`await`，结构对不上就拒绝发布。验收必须用真实浏览器走完一次核心 data 下载，不能只看 HTTP 200。

桌面端玩家把鼠标移到“开始游戏”时，`prewarmRuntime('ppsspp')` 会在非省流/非 2G 网络并行预热
入口、桥、JS、Wasm、data 和 AudioWorklet，尽量把约 34MB 的核心下载移出点击关键路径。触摸设备的
focus 和点击发生在同一刻，没有真实提前量，只预热小入口与桥，禁止同时抢拉大核心造成重复下载。

输入延迟不能只靠“把画质调低”。老访客的单游戏配置还会覆盖新默认；`host.js` 因此在 Wasm
文件系统写入一次性的 `8bitgo-performance.ini`，并通过 `--appendconfig=` 让它在全局/单游戏配置
之后合并。v10 不再用最激进的单帧呈现：`InflightFrames=2`、`VerticalSync=False`、
`LowLatencyPresent=False`，同时固定 `FrameSkip=0` / `AutoFrameSkip=False`。这会多一点输入延迟，
但给浏览器的代理 framebuffer 呈现留出余量；弱机与四核设备仍关闭独立 SAS 音频仿真线程，减少
pthread 争用，强机才开。这份策略在
`runtime.json.inputLatencyProfile=inflight-2-vsync-off-buffered-native` 与
`graphicsCompatibilityProfile=buffered-native-v1` 固化，改值要同步发布代次与回归。

⚠️ 光盘路径与记忆棒必须是两个命名空间。远程盘作为 `https://…` 交给 Range loader，本地盘只挂在
`/game`；`host.js` 另用 `--memstick=/home/web_user/.config/ppsspp` 强制记忆棒根目录，并只把这一棵
挂到 IDBFS。这样既接近实体 UMD，也避免 DJMAX 一类会检查记忆棒中是否存在镜像的游戏把本站盘误判
为 ms0 文件。PPSSPP 的长参数必须写成一个带等号的 argv；拆成 `--memstick`、路径两个 argv 会把路径
误认成第二个启动文件并报 `Can only boot one file`。不要把 ISO/CSO/CHD 复制到 `SAVE_ROOT`，也不要靠
修改 ROM 的反盗版补丁解决路径问题。

IDBFS 挂到 `SAVE_ROOT` 后、移除 run dependency 之前必须预建 `PSP/SYSTEM`、`PSP/SAVEDATA`、
`PSP/PPSSPP_STATE` 和 `PSP/GAME`。PPSSPP 会在 main 的最早阶段立即保存 `ppsspp.ini` 与
`controls.ini`；只创建挂载根目录会让首次启动虽然能进游戏，却在控制台报无法保存配置，之后改键和
存档也处于不确定状态。`controls.ini` 的保存逻辑还会先读旧文件，首次安装必须补一个空文件；只在
`FS.stat` 确认缺失时创建，绝不能覆盖玩家已有改键。目录准备放在 `try/finally` 内，失败仍要解除依赖，
不能把页面永久卡在加载中。

开局、打开改键页和工具栏交互后统一走 `focusFrame(iframe)`，避免焦点留在外层按钮造成“第一次按键
没反应”；手柄枚举也必须走 `frameGamepads(iframe)`，因为浏览器按文档隔离手柄激活权限。

PSP 即时存档和改键不是靠模拟快捷键完成的。`0005-web-save-controls-bridge.patch` 在 PPSSPP 工作线程
主循环里轮询共享命令槽：0 号槽存/读调用原生 `SaveState`，改键调用原生
`SHOW_CONTROL_MAPPING`。浏览器导出的 `.ppssppstate` 带站内游戏身份、长度和格式头，导入前会先
让当前游戏生成自己的真实槽位路径；不允许相信外部文件名直接覆盖，避免地区版/汉化版互相串档。
本地统一存档允许 96MB，云端仍受 4MB 单份配额；超出云端配额时必须保住浏览器本地副本并明确提示。
PPSSPP 自己的 SAVEDATA、原生状态和按键配置仍由 IDBFS 每 30 秒及离页时同步。

⚠️ 远程盘的“启动成功”不能只等 `__ppssppRangeProgress`。该回调从 pthread 经
`MAIN_THREAD_EM_ASM` 回页面，在部分浏览器里会晚到或完全看不到；v5 因此出现过镜像仍在正常 Range
读取、外层却在 180 秒报“PPSSPP 响应超时”。也不能恢复“canvas 尺寸变化后一秒算成功”，那只是 SDL
创建了黑窗口。v11 在 stdout 与 stderr 两路都等待 PPSSPP 成功打开内容后固定输出的
`Booted <path>...` 日志，并把大型 CHD 的
mount 上限放到 300 秒；Range 回调只负责进度、对象大小校验和明确错误。`runtime.json` 用
`startupReadinessProfile=core-boot-log-v1` 固化这条判据。

PPSSPP 的 immutable 缓存只认**物理目录代次**，不再分 `?r=` 四层：`v11/` 内的 index、host、
AudioWorklet、JS、Wasm、data 与 runtime.json 必须同批发布。虽然某次可能只改 20KB 的桥，仍要换到
下一个目录；这是用少量重复存储换取边缘缓存绝不会混代。不要重新引入 `RUNTIME_REVISION` / `DATA_REVISION`
或给文件补查询参数假装失效，它们在当前 Cloudflare 规则下不生效。
构建验收还要确认 `runtime.json.webFeaturesBridge=savestate-controls-v1`，并跑
`npm run test:ppsspp && npm run test:keymap && npm run test:capture-feed`。

⚠️ `-sFULL_ES3=1` 会注册一条每帧维护临时 VBO 的 JS 钩子，但 `PROXY_TO_PTHREAD` 的 Worker 侧
`GL.currentContext` 只是主线程真实 WebGL 上下文的**整数令牌**，没有 `tempVertexBufferCounters1`。
首帧因此会报 `Cannot set properties of undefined (setting '0')`，而 C++ 的帧回调一次都没进入。
`0004-emscripten-proxied-webgl-preloop.patch` 只让这条本地 VBO 钩子跳过代理上下文；真实 GL 调用仍照常代理，
不能靠禁用 `FULL_ES3` 或把整数令牌伪造成 JS 上下文。构建和发布检查会核对生成 JS 里的保护条件。

⚠️ 已发布过一版把 `VITE_PPSSPP_PATH` 目录直接塞进 iframe，老 bundle 会请求
`/ppsspp/v0dbfaca?embed=1&r=2`（没有 `index.html`）。静态中间件关闭目录重定向后它必然 404，
玩家要白等 120 秒才看到超时。`server/src/index.js` 为这个精确旧地址保留了 `no-store` 302，
跳到当前 `v11/index.html`；以后换实体目录时必须同步那条跳转和回归断言。

回归：`npm run test:ppsspp && npm run test:worker`。

---

### 2.33 Microsoft Clarity 必须等访客明确同意后再加载

Clarity 通过 `@microsoft/clarity` 接入，公开项目 ID 放在 `.env.production` 的
`VITE_CLARITY_PROJECT_ID`；它不是密钥，但属于构建期配置，不能只写 `.env.local`（§2.1）。

初始化统一走 `src/services/clarity.ts`：只有本地授权值为 `granted` 才动态加载 npm 分包，
拒绝或未选择时不得向 `clarity.ms` 发请求。不要把脚本标签直接塞进 `index.html`，也不要在别处
直接调用 `Clarity.init()`；页脚「分析设置」必须始终允许访客撤回选择。本站不投广告，
`ad_Storage` 固定为 `denied`，并且**不调用 `identify`**，避免把账号 ID、邮箱等登录身份交给第三方。

改动授权流程或隐私政策后至少运行：

```bash
npm run test:legal
npm run build:client
npm run build:server
```

验收时 `dist/client/index.html` 不应出现 `clarity.ms` 或项目 ID；Clarity SDK 应只存在于独立的
`clarity-*.js` 动态分包中。项目 ID 可能出现在主入口分包里，这是运行时授权判断所需，不等于已请求第三方。

### 2.34 Wrangler 的 Undici 安全补丁暂时由根级 override 固定

2026-09-29 的 `wrangler@4.141.0` 经 `miniflare@5.20260925.0-alpha` 精确依赖了存在
GHSA-3wwx-pv8p-q78v 的 `undici@7.29.0`。npm 自动修复会建议把 Wrangler 大幅回退到 4.101.0，
所以根 `package.json` 暂用 `overrides` 把 Undici 固定到官方修复版；截至 2026-11-09 为 7.30.1，
它同时修复 2026-10 月新增的多项高危 / 中危公告。这只影响开发/部署工具，
不进入主站或 Worker 的发布脚本。

升级 Wrangler 后先看 `npm ls wrangler miniflare undici`：如果上游已经依赖 7.29.1 或更高的
安全兼容版本，可以删除 override；删除前后都要运行 `npm audit`、`npm run test:worker`，以及：

```bash
WRANGLER_LOG_PATH=/tmp/8bitgo-wrangler-dry-run.log npx wrangler deploy --dry-run --config worker/wrangler.toml
```

### 2.35 在线 ROM 检查只允许一层重试；同语言候选要并行探测

详情页的「正在准备在线版本」由 `src/services/roms.ts` 的 `useRomUrl()` 驱动。播放器自己按
600ms / 1800ms 做两轮退避，因此它调用 `probeRom()` 时必须传 `retry:false`；`probeRom` 默认的
一次快速重试只留给后台独立检查。两层重试叠在一起会把一次 4 秒超时放大到几十秒。

同一语言的派生 `.8bg`、原包、主源和备用源同时发 HEAD，但仍按原顺序消费结果；不同语言继续
逐组回退，不能为了省一轮 RTT 一次轰完八种语言。页面切换必须用 AbortSignal 真正终止旧 HEAD，
不能只挡 `setState`。外链 HTML5 入口直接交给 iframe，不用 HEAD 证明存在：跨域 HEAD 被拒不等于
页面不能嵌入。双源路径测速只给大文件，样本保持 128 KiB、3 秒上限；测速失败保守走主源。

回归：`npm run test:rom-probe`。它锁住确定性缓存、播放器单层重试和页面取消会传到真实 fetch。

### 2.36 大陆入口 cn.8bitgo.com：腾讯 EdgeOne，封面跟着站点域名换

Cloudflare 免费版把大陆访客送到 LAX（实测 `loc=CN → colo=LAX`），所以另开 `cn.8bitgo.com`：
Cloudflare DNS 里只做灰云 CNAME 到 EdgeOne，EdgeOne 回源 `38.76.186.225:443`。8bitgo.com 没有 ICP 备案，
EdgeOne 只能用境外（香港）节点。主站、ROM、Pages 子域都不受影响。

- **回源 Host 必须是 `8bitgo.com`**：应用对不认识的子域一律 404（`server/src/url-normalize.js` 的未知子域规则）。
  代价是源站看不到 cn 这个 Host，于是 nginx 在 EdgeOne 回源密钥校验通过时补 `X-8bitgo-Site: cn`，
  SSR 只认这个头（`shared/cn-host.js`）。canonical 仍指 8bitgo.com。
- **EdgeOne 规则引擎**：「修改 HTTP **回源**请求头」加 `X-8bitgo-Edge`（选成「节点响应头」会把密钥发给每个访客，
  源站也收不到）；WebSocket 要单独开，否则 socket.io 升级在 EdgeOne 边缘就是 400。
- **封面由边缘按国家决定，不再测速**（2026-11-04，`shared/cover-cdn-hint.js`）：Cloudflare 有一条
  URL Rewrite 规则（Transform Rules，免费版可用），`8bitgo.com` 上 `ip.src.country eq "CN"` 的页面请求在
  进缓存前追加 `__cdn=cn` —— 改写后的查询串进缓存键，大陆访客和其他人各一份页面缓存，地址栏不变。
  源站在 `normalizeUrl` **之前**剥掉这个参数（否则 301 会把它写进 Location），SSR 直接用 `image-cn`，
  并写 `<meta name="8bitgo-cover-cdn">` 给客户端 hydrate 用；非大陆访客按 `CF-IPCountry` 标成 main。
  只有边缘没给结论时客户端才退回旧的 16px 测速（`src/services/coverCdn.ts`）。
  ⚠️ 大陆访客没带参数时**绝不能**按 `CF-IPCountry` 渲染成 cn：那份会进所有人共用的缓存键。
  任一封面域 15 秒内 3 张不同的图加载失败，本页会话切到另一个域（`reportCoverCdnFailure`）。
  主域是 `image.8bitgo.com`，大陆加速域 `image-cn.8bitgo.com`（EdgeOne 回源主域）；`/cdn-cgi/image/` 缩放
  照样回源给 Cloudflare 做，但大陆域固定 `format=webp`：EdgeOne 缓存键不看 Accept，`format=auto` 会把
  第一个访客拿到的 AVIF 发给不认 AVIF 的浏览器。回归：`npm run test:cover-cdn`。
- **主站上的大陆访客整页送到 cn.8bitgo.com**（2026-11-20，`public/edge-route-v3.js` → 当前 `edge-route-v4.js`）：以前的 `edge-route-v2.js` 用两个 180ms 测速探针决定去留，
  从大陆直连实测探已连上的 8bitgo.com 要 1.0 秒、第一次连 cn.8bitgo.com（含握手）要 1.4～3.2 秒，两个探针永远超时、按规则留在原地 ——
  上线以来没把一个大陆访客送去 EdgeOne。同一时刻经 Cloudflare 美国节点：首页 HTML 2.4～4.2 秒（偶尔 60 秒无响应）、入口 JS 7.9 秒、
  一张封面 15.3 秒；经 EdgeOne：JS 1.5 秒、封面 3.1 秒。v3 改看 Cloudflare 已给的地域结论：SSR 把 `coverHint` 写进
  `<html data-8bitgo-cdn>`（`<meta name="8bitgo-cover-cdn">` 在 `</head>` 前，路由脚本运行时还没解析到）。
  - 主站 + `cn`：没有登录态、没有本地游玩痕迹（`8bitgo.recents`、`ejs-*`、各类电池存档键、Ruffle 的 `/flash-frames/` 键、
    缓存库以外的任何 IndexedDB）、cn.8bitgo.com 的 favicon 3 秒内取得到、用户还没点过 / 按过键，才 `location.replace` 过去。
    不比快慢；探针带凭据，跳转能复用那条已握手的连接。查不了 IndexedDB（报错 / 卡住）按「有存档」留下。
  - 主站 + `main`：不测速、不跨域（v2 每两小时对海外访客多开一条到香港的冷连接）。
  - **大陆入口上不测速、不跨域，一律留下**（v4）。v3 在这里还走 v2 的 180ms 测速：2026-11-20 大陆直连（出口 CN、Cloudflare LAX）
    打开 cn.8bitgo.com，探针约 0.45 秒就判主站赢、整页送回 8bitgo.com —— 小请求只量握手（Cloudflare TLS 约 0.5 秒、EdgeOne 0.6～2.6 秒），
    量不出丢包：同一时刻主站首页 HTML 已 HIT 仍要 4～25 秒、经 EdgeOne 2.5～3.5 秒；被送回的访客又被主站按地域送回 cn，三次加载。
    代价：从分享链接直接打开 cn.8bitgo.com 的海外访客也留在 EdgeOne。主站上没有结论（本地开发、规则没配）时照旧走 v2 的测速。
  - 带 `__assets=origin`（EdgeOne 取不下 chunk 后改从主站整页载入）的这一页留下，并写 `8bitgo.edge.pin` 钉在主站两小时，
    否则下一次整页加载又被按地域送回同一条坏线路。
  - ⚠️ 已经在主站上玩过的访客会一直留在主站（本地存档跨不了域）；没做迁移。第一次访问要多加载一次页面（主站 HTML + 跳转后的大陆入口 HTML），
    之后站内跳转都在 cn.8bitgo.com 上；从搜索结果回到 8bitgo.com 时再走一遍判断。
  - **v5（2026-11-22，为 NS 迁出 Cloudflare 准备，见 `deploy/saas/README.md`）**：迁移后大陆访客经 DNS 分线路直接由 EdgeOne 打开 8bitgo.com，
    地址栏是主域。SSR 在 nginx 校验过回源密钥（`X-8bitgo-Site: cn`）时给 `<html>` 加 `data-8bitgo-site="cn"`（`shared/cn-host.js` 的 `CN_SITE_ATTR`）：
    边缘路由见到它就和在 cn 子域上一样留下；前端 `onCnSite()` 也认它，API / 运行时 / 密钥请求都走同源，不再跨域去 `cn.<裸域>/_cn`。
    迁移前 Cloudflare 那边的 HTML 永远不带这个属性，行为与 v4 相同。⚠️ 属性名在 edge-route 脚本里是写死的字符串，改名要同步（`test:cover-cdn` 核对）。
  - `edge-route-vN.js` 按版本号长期缓存（`cache.js`）：改逻辑必须新建 v6，v2～v4 留给边缘缓存里的旧 HTML。新文件要先 `git add`，`check-runtime-syntax` 只看已跟踪的文件。
    回归：`npm run test:edge-route && npm run test:cover-cdn`。
- **8bitgo.com 上的大陆访客，JS / CSS / 字体 / 只读 API 也走 EdgeOne**（2026-11-04，`server/src/cn-edge.js`）：
  同一份「大陆页面」缓存里，SSR 把模板的 `/assets/`、`/fonts/` 改指 `https://cn.8bitgo.com/_cn/...`；
  `api.ts` 的非后台 GET 走 `https://cn.8bitgo.com/_cn/api/...`。地址栏不变，只剩 HTML 本身还去 Cloudflare。
  - ⚠️ 必须带 `/_cn` 前缀：EdgeOne 已缓存过大陆入口同源请求的 `/assets/*`（**没有** CORS 头），缓存键不看 Origin，
    我们又清不了 EdgeOne。换前缀等于一组新缓存键，源站对它固定发 `Access-Control-Allow-Origin: https://8bitgo.com`
    和 CORP。同理 CSS 里写死的 `url(/fonts/...)` 由 cn-edge.js 现场改成 `/_cn/fonts/`。
  - ⚠️ `vite.config.ts` 的 `renderBuiltUrl` 让 JS / CSS 里的产物引用相对引用方解析；去掉它，懒加载 chunk 的
    modulepreload 会解析回 8bitgo.com，同一个 chunk 被下两遍。**Worker 例外**（文件名 `*Worker-<hash>.js`）：
    浏览器禁止跨源启动 Worker，所以它们固定用 `self.location.origin + /assets/...`；新增 Worker 时文件名要带 `Worker`。
  - 兜底：入口脚本 / 样式表 `onerror` 退回同源；API 网络错误或 502–504 退回同源，网络错误后本次会话不再走加速入口。
  - ⚠️ **主站不发 Early Hints 的 `Link`**（2026-11-18 /rooms）：Cloudflare 按浏览器看到的地址缓存 Early Hints，
    `__cdn=cn` 不进它的键，大陆 / 非大陆两份资源写法互相覆盖。大陆访客收到的 103 从 8bitgo.com 预载入口包，HTML 却从
    EdgeOne 取，下两遍还报「preloaded … but not used」。`ssr.js` 在有大陆加速入口时（`cnEdgeOrigin` 非空、非 cnSite）
    不发 Link；已缓存的旧 103 要在 Cloudflare 关掉 `early_hints` 或清缓存才消失。回归：`npm run test:seo-performance`。
    写操作、后台请求、socket.io、SSE、OAuth 跳转都留在同源。
  - **直播的 socket.io 客户端打进前端包**（2026-11-20；前一天的做法是从 EdgeOne 现取脚本，生产上始终没上线）：
    以前 `src/services/live.ts` 运行时从后端取 `/socket.io/socket.io.min.js`（`serveClient: true`）。那个地址 `max-age=0`，
    Cloudflare 每次回源复验（`cf-cache-status: REVALIDATED`），8bitgo.com 上的大陆访客走洛杉矶实测 11～40 秒，
    客户端 8 秒就放弃，开播、看直播全部失败；同一台机器上带哈希的 `/assets/` 分块 3 秒、经 EdgeOne 1 秒。
    现在用 npm 的 `socket.io-client`，**版本钉死**与 `server/` 的 socket.io 同一个 major.minor（`test:live-io` 核对两边装的版本，
    升级服务端 socket.io 要一起升前端），`loadIo` 里 `import('socket.io-client')` 按需加载、走 `importWithRetry`。
    不能改成静态 import：`live.ts` 经 `services/allRooms.ts` 被侧栏房间数带进几乎每个页面，静态引入等于全站多下约 13KB（gzip）。
    `vite.config.ts` 的 `codeSplitting` 给它起名 `socket-io-client-<哈希>.js`，诊断包里一眼认得出。
    页面全局一个字节都不读，以前被 UMD 分支（别人占了 define / module）和 js-dos 泄漏的同名 `io` 坑过的两类问题也就没了，
    `src/lib/umd.ts` 已删。信令**连接**仍连同源（线上实测从大陆直连 2.5 秒连上 websocket）。
    `cn-edge.js` 发 socket.io 客户端的那段路由留着，给仍从后端取脚本的模拟器 iframe 联机
    （`netplay.ts` 的 `socketIoScriptUrl`，同样慢）以后改走加速入口用。
    自动开播网络类失败 15 秒、45 秒后各补一次，满员 / 年龄门 / 未知游戏等确定拒绝不补（`src/emulator/autoLiveRetry.ts`）；
    等待期间玩家自己开播或关播就不再插手。回归：`npm run test:live-io && cd server && npm run test:cn-edge`。
  - **EmulatorJS 引擎与核心也在内**（2026-11-08，《合金弹头 2》大陆玩家反馈加载极慢）：ROM 早已走 cn-assets，
    loader / emulator.min.js / FBNeo 8MB 核心却还从 Cloudflare 洛杉矶取。`paths.ts` 的 `ejsBase()` 给大陆访客返回
    `https://cn.<裸域>/_cn/emulatorjs/`，`ejsRuntimeAsset` / `ejsCoreAsset` / `EJS_pathtodata` 都走它；iframe 是不带 sandbox
    的同源 srcdoc，7z Worker 是 blob URL，跨域无碍。开局前失败（`failLoad` / loader 注入失败）就 `markEjsEdgeFailed()`，
    自动重试退回同源。引擎 IndexedDB 核心缓存以 URL 为键，大陆老访客换线路后会重下一次核心。
    ⚠️ `/_cn` 下的静态文件**不能带 `Vary: Origin`**（cors 中间件会加，cn-edge 对非 API 路径删掉）：预热 fetch 带 Origin、
    `<script>` / `<link>` 不带，Vary 会让同一 URL 存两条缓存、预热白做。EdgeOne 已缓存过带这个头的副本，所以换过一代 `-cnedge1`。
    - **EmulatorJS 主入口导入失败要按运行时线路故障处理**（2026-11-17，诊断包 #1012，《忍者龟 3》）：`loader.js` 捕获
      `emulator.min.js` 动态导入失败后只写控制台，并继续请求本站不发布的 `emulator.js`；适配器若漏掉这两条错误，启动看门狗会等约 30 秒，
      报成卡在 `fceumm`，播放器还会把同一个引擎故障误判为英文 ROM 失败并切西语 ROM。现在把入口失败纳入致命错误，归类 `runtime`，
      立即标记当前 EdgeOne 线路失败并让播放器用同一 ROM 从主站重试。现场没有记录失败请求的 HTTP 状态，故只能确认入口加载链失败，
      不能仅凭这份样本断言是 EdgeOne 缓存、瞬时链路还是浏览器拦截。
    - **主入口的第一次失败不是最终失败**（2026-11-17，诊断包 #1094–#1104）：Chrome / Safari、Android / iOS / ChromeOS、多个地区都在
      `Failed to load emulator.min.js` 后紧接着尝试回退；适配器此前在第一条日志就拆掉 iframe，抢断回退流程。并且上游默认回退到未发布的
      `src/emulator.js`。现在只在 loader.js 发出最终 `EmulatorJS failed to load` 后报致命错误；`EJS_paths` 把回退入口指向同一引擎构建的独立
      `?fallback=1` URL，绕过失败的动态 import URL / 边缘缓存键。现场没留原始异常与失败状态，具体是哪一跳首次失败仍无法断言。
  - **Ruffle（Flash）与 js-dos（DOS）同理**（2026-11-08）：`ruffleBase()` / `jsdosBase()` 与 `ejsBase()` 共用
    `paths.ts` 的 `runtimeBase`。线路**每页只定一次**（预热与正式加载必须同一个 URL）；大陆访客一律走 EdgeOne。
    入口脚本取不到当场换同源；开局前报错标记失败，自动重试走同源（EmulatorJS 的「卡住」不算）。
    ⚠️ **不能拿 ROM 线路测速决定运行时线路**（2026-11-10，拳皇 97 大陆玩家卡在「下载游戏核心」）：ROM 探针是
    assets.8bitgo.com 上的 64KB，量的是延迟（实测 Cloudflare 1.4s 对 EdgeOne 1.9s，Cloudflare「更快」）；
    同一时刻大陆宽带下 8bitgo.com 的 8MB 核心走 Cloudflare 只有 1.5～43KB/s（cf HIT 也一样），
    cn.8bitgo.com/_cn 约 0.8～1MB/s。以前「测出 Cloudflare 更快就不走 EdgeOne」把这批玩家送去了几 KB/s 的线路。
    js-dos 的 DOSBox Worker 本来就是 fetch 后转 blob 启动，跨域无碍；`emulators.js` 整页只注入一次，换线路时要同步
    `window.emulators.pathPrefix`。Play! 从 2026-11-15 起仅把版本化 `Play.wasm` 走 `/_cn/play/`：`Play.js` 和 pthread
    Worker 仍同源；EdgeOne 请求 12 秒无响应或失败时，同一次启动会退回同源并标记本页不再走 EdgeOne。新增 Play! 运行版本时
    `cn-edge.js` 的窄白名单按路径模式覆盖，但仍只允许 `Play.wasm`。Dolphin 仍未接入：它的 iframe 消息校验要求同源，
    核心 JS / Worker 又按相对路径互相加载；不能只加白名单或把 iframe 整体改到 EdgeOne。
  - 回归：`cd server && npm run test:cn-edge`。
- **ROM 线路：所有平台开局前选一次 assets / cn-assets**（2026-11-07，`romRoute.ts` 的 `chooseRomHost`）：
  两边取同一个 64KB 固定探针 `roms/_route-probe/v1.bin?v=1`（R2 上的随机字节，两边边缘都长缓存），
  不再拿 ROM 自己的前 128KB 测——冷门 ROM 在 EdgeOne 上第一次必然 MISS，测到的是回源，会系统性偏向主域。
  大陆访客（`coverCdnHint() === 'cn'`）**不跑小探针、默认走镜像**，其他人默认主域、镜像要快 15% 才赢；两边都测不出或
  省流量 / 2G 直接用默认。⚠️ 2026-11-14 大陆 Android Chrome《仙剑奇侠传》：64KB 探针判 Cloudflare 更快，
  3.2MB ROM 从 assets 下了 16.8 秒（1.6Mbps，本机网络 9.3Mbps）—— 探针量的是延迟，量不出 Cloudflare
  往大陆的吞吐，和下面运行时线路是同一个坑。首段 256KiB 低于 3Mbps 时会测另一域同 ROM 的 64KiB；
  只有备用实测速率至少快 15%（ROM ≥512KiB，且非 2G / 省流量），或下载重试用尽时，`alternateUrl` 才整局换域。
  诊断包记录所选线路、首段吞吐、备用线路速度和切换原因。
  仅 ROM ≥512KiB 且非 2G / 省流量时比较线路；实际下载证明的线路短时覆盖探针结论 5 分钟，其余探针结论仍按域名对存 30 分钟
  （内存 + localStorage `8bitgo.rom-host.v1`）。
  探针上限 8 秒（详情页刚打开时要和封面 / 脚本抢连接，实测 2.5 秒会两边一起超时），但开局只在 HEAD 之后
  再等 `ROM_HOST_WAIT_MS`（1.5 秒），没结论先用默认，测速在后台跑完并缓存给下一局。
  ROM 本体仍走 8MB 对齐 Range（带 romv 的都是），实测 EdgeOne 免费版按片缓存 98MB 的大包，不会因整包大被拒。
  ⚠️ 探针对象**不能删、不能原地覆盖**；要换就上传 v2 并改 `ROM_ROUTE_PROBE_PATH`。回归：`npm run test:rom-probe`。
- **BIOS / Windows 系统盘 / Sockdrive 也跟着线路走**（2026-11-07，`src/services/romHosts.ts`）：
  `platformBios.ts` 的地址和播放器收到的 `dosSystemUrl` 经 `routeRomAssetUrl` 换到已测线路（没测完时大陆默认镜像）。
  - ⚠️ 凡是拿 URL 当身份的地方都要先 `canonicalRomUrl()` 换回主域写法：`romCacheKey`（ROM / 系统盘的 IndexedDB 缓存，
    否则换一次线路整份重下）、`sockdriveVersionedSaveKey`（否则存档键变了）。
  - ⚠️ Sockdrive 存档包里**写着盘的 URL**（js-dos `traverseSockdriveChanges`：`[u32 LE 长度][URL][u32 LE 长度][扇区差异]` 重复），
    开机只认完全相同的地址。读档时 `retargetSockdriveChanges` 把同一块盘的另一种写法改成当前地址；漏了就是换线路后存档静默消失。
  - Sockdrive 每块盘在每个浏览器里**钉死一条线路**（`pinnedSockdriveUrl`，localStorage `8bitgo.sockdrive-host.v1`，30 天）：
    js-dos 的 OPFS 扇区缓存按 URL 存，来回切会存两份。播放器 onError 时 `clearSockdrivePin`，下次按新线路重选。
  - 实测 EdgeOne 原样转发 `.raw` / `sockdrive.metaj` 的 `Content-Encoding: br`，解码后与主域逐字节一致并会 HIT；
    BIOS、系统盘两边 ETag 相同。回归：`npm run test:rom-hosts`。
- ⚠️ **`http://cn.8bitgo.com` 会回 200 整页**（2026-11-15 实测；主站 Cloudflare 会 301 到 HTTPS，EdgeOne 不会）。
  Android 模拟器 Chrome 110 那台设备 HTTPS 连不上（模拟器系统时间不对最常见），Chrome 退回 http:// 并提示
  「该网站不支持 HTTPS」，页面在明文里跑：没有 `crypto.subtle`（8BG 解不了），写死 https:// 的资源 / 接口全连不上，
  最后崩到「页面暂时没有正常打开」。`index.html` 最前面的内联脚本：明文 HTTP 先换 HTTPS，一分钟内又被退回就不再跳、
  在页面顶部提示「检查日期时间 / 关掉代理」（sessionStorage 防循环，只写 ES5，本机与局域网开发地址不动）。
  回归：`npm run test:https-guard`。**还应在 EdgeOne 控制台打开「强制 HTTPS」并配 HSTS**，那样连页面都不会以明文发出。
- ⚠️ 加速域名**不能带下划线**（`image_cn` 这种）：公共 CA 不为含 `_` 的主机名签证书，HTTPS 永远起不来。
- 两个域名的本地存档、IndexedDB 和登录态互不相通（按 origin 隔离），云存档不受影响。

回归：`npm run test:game-media && npm run test:seo-performance && npm run test:tv-host`。

### 2.36.1 启动诊断包：后台「错误诊断」页（2026-11-11）

启动漏斗（`game_startup_events`）每局只有阶段时间点和 160 字摘要，查不出「哪个浏览器、卡在哪一步」。
现在一局**失败 / 超时 / 慢启动**时，`startupFunnel.ts` 自动附上 `startupDiagnostics.ts` 采的诊断包：
环境（内存、核数、网络、屏幕、语言、跨源隔离、本局在后台多久）、本局阶段时间线、外层页面 warn/error、
EmulatorJS 引擎日志与加载阶段文字（`diagLog`）、下载器的重试（`loadProgress.ts`）、慢 / 大 / 失败的网络请求
（外层 + 登记过的 iframe，`watchFramePerformance`；核心是在 iframe 里下的）。服务端 `startup-diagnostics.js`
按白名单重建、二次脱敏，从请求头归出「Safari 26 / macOS / desktop」后**丢掉原始 UA**，按「事件 · 运行时 ·
抹掉数字后的错误原文」算特征归组，存 `game_startup_diagnostics`，保留 30 天。后台 `/admin/diagnostics`
按影响访问数排组，「复制给 AI」拼出概况 + 最近 5 份完整现场的 Markdown。

- 要给别的运行时补日志：调 `diagLog('<来源>', level, …)`；iframe 里下载的运行时调 `watchFramePerformance(win)`，
  销毁时调用它的返回值（会先拍快照）。不要改 EmulatorPlayer 的上报路径，漏斗是唯一出口。
- PSP（2026-11-11 接入）：桥的 `#status` 阶段文字、核心 stdout/stderr 里的 `E[`/`W[`/Booted 等关键行、iframe 里的
  核心下载请求；读盘 Range 跑在 pthread Worker 里看不到单个请求，靠 `registerDiagnosticSnapshot` 在打包时给出
  模式、镜像大小、已读字节、桥状态和最近一次 `performance` 采样（帧率 + 预读命中）。新运行时有类似「只有汇总、
  没有日志」的状态，也走 snapshot。终端颜色码（`ESC[91m`）在前后端都会去掉。
- 隐私边界写在隐私政策（`test:legal` 的 `startup-diagnostics` 两条）：不存 IP、完整 UA、ROM 地址、账号；
  ROM 文件名一律 `[ROM]`。加新字段先改白名单 `normalizeDiagnostics()`，否则服务端会直接丢掉。
- **漏斗有失败但诊断包缺失时要留安全摘要**（2026-11-21）：生产近 7 天曾有 201 次失败、29 次超时没有关联诊断包；旧路由只在客户端带包且完整包限流通过时保存，缺包 / 限流会静默丢失现场。现在每个首次写入的 failed / timeout / slow_start / recovered 都尝试保存：完整包沿用每 IP 6 / 全站 120 每分钟；缺包、无效包、保存失败或被限流时，单独用每 IP 12 / 全站 240 的更严摘要闸，保留漏斗事件已有的安全错误摘要和阶段时间线。摘要 `capture.level=summary` 必须在后台明确显示「详细浏览器现场未收到」；设备能力等详细环境（`env`）、部署版本、开局序号、日志和资源都留空，数据库仍只存从请求头归纳的浏览器 / 系统 / 设备类别，不能把缺失信息编造出来。历史回填只生成同样的摘要，默认 dry-run，写库用 `cd server && npm run backfill-startup-diagnostics -- --days=7 --apply`，且禁止触发报警 / 飞书 / AI 分诊。回归：`npm run test:startup-diagnostics`。
- **回填必须带故障发生时间**（2026-11-21）：第一次回填没传，1150 条旧现场的 `created_at` 全写成了回填那一刻，后台「最近出现」挤在同一分钟，
  聚集报警 / AI 分诊的时间窗和 30 天清理也跟着错。`recordStartupDiagnostics(..., { occurredAt })` 在真插入后把 `created_at` 改成漏斗事件时间
  （只接受过去 30 天内）；回填脚本传 `row.createdAt`。已有错位数据用 `game_startup_events` 按 (visit_id, attempt_id, event) 对回。
- **2026-11-21 逐组复查的结论与修补**（详见提交说明）：
  - 120 秒看门狗只**上报**超时、不拆局（《经典食人花》在超时后 35 秒出画面）。慢但仍在推进的阶段必须报 `onStartupActivity`：js-dos 被压住的系统盘 / ROM 进度、
    Windows 客体建盘与开机（`startAdapterOwnedTimeout`，前台每 15 秒心跳，真卡死仍按适配器自己的阶段超时报错）、Ruffle 核心预热的字节进度、PPSSPP mount 期间。
  - EdgeOne 上的 `js-dos.js` / `ruffle.js` 25 秒取不到就换同源，迟到的脚本有闩挡住，不会建两个播放器。
  - html5 适配器先 append 后设 src，iframe 会同步触发一次 about:blank 的 load：以前被当成「已加载」，诊断里出现 5ms 的 iframe_loaded。现在忽略这次 load。
  - 45d661f 合并时丢了 html5 运行时桥的 `progress` 分支，PvZ 每秒一条 progress 被兜底分支当成失败，**每局约 10 秒报错**；现在 `dispatchHtml5RuntimeSignal` 逐类型显式匹配，只有 `failed` 报错。
  - **绝对旧入口也要按本站域名迁移**（2026-11-21，生产 PvZ 冒烟）：大陆 `cn.8bitgo.com` 进入时，数据库里的 `https://8bitgo.com/web/PvZ/en?shell=20260923-save2` 与当前 origin 不同，旧逻辑漏过迁移，iframe 继续加载没有生命周期桥的主站副本，240 秒没首帧。`versionHtml5Entry()` 对精确的 8BitGo HTTPS 域名统一迁到 Pages，并更新 shell 代次；非本站域名和跨源 HTTP 仍不迁。回归：`npm run test:html5-pages-bridge`。
  - 核心下载「正文在流、后来停了」（20 秒无新数据 / XHR 兜底停滞）不再标记 EdgeOne 线路坏，重试留在 EdgeOne 续传；HTTP 错误、截断、头超时照旧换线（`ejsEngineErrors.ts`）。
    引擎本地化的「启动游戏失败」等先归一成英文再判 scope。
  - 已出画面后的核心崩溃，上报原因前缀「运行中崩溃（已出画面）」，不再和启动失败归成一组。
  - React #185（最大更新深度）：上报时组件栈排在说明前面，保证组件名进得了 160 字摘要；同一页**原地重挂一次**，再次出现才停在兜底页。具体更新源仍待下一份带组件栈的现场确认。
- 部署要 `cd server && npm run migrate`；缺表时漏斗照常，诊断包不入库，后台该页 503。
- **慢启动要分清「还在下载」和「下载完卡在启动」**（2026-11-10 阿联酋《心灵之金》：42MB 的 NDS ROM 跑在 6～10Mbps
  的线路上，物理上就要 35～60 秒；诊断包却只有 start_click → slow_start 和一条第 0 片，后续分片还没进 Resource Timing）。
  `startupProgressTrace.ts` 记下最后进度：slow_start 的原因原文带上阶段（后台归组时两类自然分开），快照行带字节数与平均速率。
  ROM Worker 发 `Timing-Allow-Origin`，否则跨源请求的传输量恒为 0；边缘已缓存的旧响应要等过期才带上。
- **诊断归组要给出可审阅的判断，不要把相关性写成根因**（2026-11-18）：前端持续观察 Resource Timing，缓冲区写满时先保留慢 / 大 / 失败候选，再逐步扩容且不清除历史记录（页面资源自修复和 J2ME 看门狗也读取该列表）；资源型 `error` 事件另外记录失败的脚本 / 样式 / 媒体入口，避免快速失败不进性能表。服务端 `diagnoseStartupFailure()` 用脱敏后的现场按固定规则标出类别、阶段、把握度与安全的核心名；明确区分 ROM 下载、ROM 内容、街机 ROM 集 / BIOS、引擎资源、WebGL、内存、存储、输入权限和核心运行时错误。`table index` 等运行时陷阱只标「待确认」，不能仅凭一条错误断言 ROM 损坏。后台现场和「复制给 AI」同时展示分类与把握度；新增字段必须在 `normalizeDiagnostics()` 白名单和隐私政策中同步维护。
- **页面资源失败必须能关联到本站和本次开局**（2026-11-24，诊断包 #3978 / #3929 / #3018）：第三方统计脚本 `onerror` 和 `start_click` 前的旧页面脚本失败不能升级成高把握度 `page_asset`，否则会盖过仍在推进的 ROM 下载。只有明确的动态模块 / Vite CSS 错误，或开局期间本站 JS/CSS 失败，才归为页面资源；其它资源错误继续按 HTTP 状态和进度证据判断。回归：`npm run test:startup-diagnostics`。
- **HTML5 超时先区分 iframe 文档是否到达**（2026-11-25，生产诊断 #4154）：适配器挂载前已会记录 `starting`；只有 `iframe_loaded` / HTML5 的 `download_complete` 时间线事件能证明入口文档 load。缺少两者时，诊断应写“入口页面未确认加载”，不能说“页面已加载但尚未可玩”。#4154 只有 `start_click → timeout`，没有 iframe 资源请求或失败状态，足以修正误导性标签，但不足以断言 Pages、EdgeOne 或浏览器网络是根因；后续要靠 iframe 导航失败的现场证据再决定是否换线路。回归：`npm run test:startup-diagnostics`。
- **CN 入口上的整张静态模块图也要有主站退路**（2026-11-25，生产诊断 #4162，《植物大战僵尸》Edge 157 / Windows / CN）：`cn.8bitgo.com` 自身的入口脚本是同源 `/assets/...`，旧 `assetsFromCnEdge()` 只认主站页上的 `/_cn/assets/...`，所以重复懒加载失败后不会切换资源域。现在只对配置主站的精确 `cn.` 子域识别；先整页刷新一次，仍失败才带 `__assets=origin` 把整套 JS/CSS/字体切到主站，避免只替换单个 chunk 导致重复执行入口 / React；该 CN 回退 HTML 禁止缓存，避免 CDN 忽略查询串时串给正常访客。现场能证明回退资格缺失，不能证明最初的请求失败由 EdgeOne、缓存或玩家网络中的哪一项造成。回归：`npm run test:asset-repair && npm run test:cn-edge`。
- **诊断不能把旧阶段当成当前失败**（2026-11-21，生产诊断 #2744：《黄金太阳》本地 ROM 首帧后约 13 分钟 mGBA 报 `RuntimeError: Aborted(undefined)`，却因历史日志里的「下载游戏核心」被归为核心下载失败）。仅当有明确失败措辞时才按核心下载归类；可确认发生在可玩 / 首帧之后的 WASM 错误归到运行时阶段，阶段日志若比失败早 30 秒以上不再参与停滞分类。时间戳缺失的旧诊断包仍兼容原规则。回归：`npm run test:startup-diagnostics`。
- **DOSBox-X / MAME 的致命初始化失败要在看门狗前结束**（2026-11-22，生产诊断 #2974–#2978）：WinDepth 两次都在 ci-ready 前先报 WASM `RuntimeError: unreachable`，但只剩 7 分钟建盘超时；Windows 客体适配器现在只在完整 Windows 客体的 ci 阶段捕获这类带 `RuntimeError` 对象的 WASM 陷阱，报告运行时失败并在销毁时移除监听器。现场同时有 32 位浏览器 / 4GB 设备，但不能据此断言陷阱根因已证实。MAME-current 的 7z Worker `abort()` 曾导致一次 120 秒看门狗超时，随后另一现场明确报 WASM OOM、余量 128–256MB；现在 MAME 启动期错误捕获会合并浏览器错误栈，仅在 `Uncaught exception: abort()` 与 `_extract` 同时出现时提前失败，说明中保留「根因未确认」且不自动重复启动大核心；单独确认的 OOM 也跳过同页重试，交给播放器已有的一次干净页面恢复。不能把前一条现场直接断言为 OOM；MAME 没有可安全替换的低内存核心，不改驱动覆盖，也不降级到会破坏游戏支持的核心。回归：`npm run test:dos-load && npm run test:ejs-failure-reasons`。
- **慢启动先看进度快照还在不在动，别一律标「停滞」**（2026-11-18 诊断包 #1155 / #1156）：slow_start 只是「20 秒还没出画面」的时间点。
  #1155《MDK》iOS Safari：114MB 普通 DOS 整包（无 Sockdrive），第 19.9 秒仍以 31 Mbps 在下，被标成「ROM 下载或流式读取停滞」；
  #1156《西游释厄传》：21MB ROM 被 `effectiveType=3g` 压成单路串行下了 19.4 秒，第 19.7 秒进 assets、0.3 秒后上报，被标成「模拟器依赖资源加载停滞」。
  `diagnoseSlowStartProgress()` 读 snapshot 行（`readProgressSnapshot`，行的 t 即上报时刻）：最后进度在上报前 3 秒内、ROM 未下完 →
  `progress.rom_downloading`「ROM 仍在下载，进度正常」；ROM 刚下完且下载用掉一半以上时间 → `progress.rom_dominated`。两者都带体积分档
  artifact（`rom-64-256mb` 等），大包和小包慢网分开归组。流式读盘、命中缓存、进度几秒没动、下完很久仍卡在后面阶段，维持原「停滞」归类；
  只作用于 slow_start，失败 / 超时有自己的原文。改 `startupProgressTrace.ts` 的 snapshot 格式要同步这个解析器。
  这类「未停滞」组的行动方向是：大 DOS / Windows 包做 Sockdrive（§2.8.7），小包慢网查下载并发与线路，而不是找卡死点。
- **下载完成事件会淘汰旧 ROM 阶段**（2026-11-21 诊断包 #2761）：ROM 在 19 秒完成，1.2 秒后上报 slow_start；快照仍把阶段写成 rom，且下载前的一次分片预取失败已由后续请求恢复。诊断不能因此说 ROM 停滞或网络失败；非 HTML5 的 `download_complete` 是资源已到手的阶段证据（HTML5 同名事件只代表 iframe 文档 load），之后优先判断「慢在 ROM」或「仍在启动」。回归：`npm run test:startup-diagnostics`。
- 回归：`npm run test:startup-diagnostics`。
- **聚集报警**（2026-11-15，`server/src/diag-alert.js`）：同一特征 60 分钟内来自 ≥10 个不同访问就给 `DIAG_ALERT_EMAIL` 发一封
  （复用 Resend），同一特征 6 小时内不重复，冷却记在 `site_settings` 的 `diag.alert.<特征>`。没配邮箱完全不启用。
  2026-11-25 生产的 mysql2 连接启用了 `CLIENT_FOUND_ROWS`：条件 UPSERT 没改值也会报「命中一行」，旧代码把它当抢锁成功，
  于是同一特征绕过 6 小时冷却重复刷飞书。`cooldown-claim.js` 现在写入「时间戳:随机令牌」后读回比对，旧的纯时间戳值仍能被
  `CAST(... AS UNSIGNED)` 正确判过期。即时失败通知 `diag-lark.js` 与聚集通知必须共用这套逻辑；不要再按 `affectedRows` 判定冷却成功。
  slow_start 的 `progress.rom_downloading` / `progress.rom_dominated` 是下载仍在推进的正常慢启动，只留诊断包、不能聚类报警；`stage.rom`
  等无进度信号仍须报警。阈值见 `server/.env.example` 的 `DIAG_ALERT_*`。回归：`npm run test:startup-diagnostics`、`cd server && npm run test:diag-alert && npm run test:diag-lark`。

### 2.36.1.1 AI 临时修补：MiniMax 只能「选开关」，不能写代码（2026-11-18）

后台「AI 修补」（`/admin/ai`）填 MiniMax API Key。同一启动故障特征（只看加载失败 / 启动超时，慢启动可选）在窗口内来自
≥ minVisits 个不同访问时，`server/src/ai-hotfix.js` 把聚合信息 + 最近 3 份脱敏诊断包交给 MiniMax 分诊，结果存 `ai_hotfixes`：
诊断、临时修补、固化建议。生效中的修补由 `/api/hotfixes`（30 秒缓存）下发，详情页开局前套用；每条都能「复制给 Claude」导出
Markdown 交给人做永久修复，修好后点「已固化」。错误诊断页每组有「AI 分诊」按钮可手动触发。

- ⚠️ **AI 的输出永远是数据，不是代码**。诊断包的 reason / 日志来自玩家浏览器，可以伪造；让 AI 写代码再下发，等于开了
  「伪造诊断包 → 全站执行任意 JS」的口子。AI 只能从 `shared/hotfix.js` 的白名单里挑**播放器早就有的退路**：
  `runtime_origin`（运行时不走 cn 加速入口）、`rom_host`、`disable_engine_cache`、`memory_rom`、`player_notice`（八种语言模板，不收自由文本）、
  `set_core`（按平台限定的核心表）、`set_runtime`（目前只有 NES jsnes ↔ emulatorjs）。服务端校验一次、浏览器再校验一次；
  `scope.games` 只能是这个特征的诊断包里真出现过的游戏 —— 伪造的诊断包最多影响它自己报上来的那款游戏。
  **加新动作 = 改 `shared/hotfix.js` + `src/services/hotfixes.ts` 的执行 + 测试**，不要放宽成「AI 给参数就照做」。
- 档位：`safe`（默认）只自动生效 safe 档动作，`set_core` / `set_runtime` 等批准；`all` 全部自动；`off` 只建议。低于 minConfidence 一律等批准。
  有效期最长 72 小时，到期自动 `expired`。诊断包带上生效中的修补 id（`hotfix_ids` 列）：同特征仍失败 ≥ revokeAfterVisits 个访问、
  或带修补的失败总数 ≥ 3 倍时自动撤销（提示条不参与）。同一特征分诊后 6 小时内不再自动分诊，每小时预算 maxCallsPerHour。
  撤销计数（`countHotfixFailures`）只算命中修补范围的访问（`scope.games`、浏览器 / 系统、`cnOnly` 按服务端判出的国家），同一访问去重；
  多游戏范围时单款游戏最多贡献阈值的 60%，失败全来自同一个国家时阈值翻倍 —— 诊断包可以伪造，这是降低「伪造包撤掉好修补」的门槛，
  不是根治（不存 IP；真要防需要给诊断接口加挑战或签名）。重新批准已撤销 / 过期的修补会重置 `applied_at`，旧失败不再计入。
  只有真正生效（没被更新的修补覆盖）的动作才把修补 id 写进诊断包。
- 浏览器端：`useGameHotfix`（`src/services/hotfixes.ts`）最多等 1.5 秒；**ready 之前详情页把 ROM 当「检查中」**，不让一局开到一半被换核心。
  开关放在零依赖的 `src/services/hotfixFlags.ts`，`paths.ts`（runtimeBase / Play wasm）、EmulatorJS 适配器（`readEngineCacheStall` / `romBlobBrokenNow`）、
  `romRoute.ts`（`chooseRomHost`，最多等 1.2 秒）、诊断包都读它。目前只接了游戏详情页；嵌入页 / TV / 隔离页（PS2 等）不套用修补。
- Key：`server/src/secret-box.js` 用 `AI_SETTINGS_SECRET`（没配用 `JWT_SECRET`）HKDF 派生的 AES-256-GCM 加密后存 `site_settings` 的 `ai.minimax`；
  后台只显示末四位，`publicAiConfig` 永不含 Key。只允许国际站 / 国内站两个官方入口，不收任意 URL。env 默认 `MINIMAX_API_KEY` / `MINIMAX_REGION` / `MINIMAX_MODEL`。
- 隐私：发给 MiniMax 的是已脱敏的诊断包（不含 IP、完整 UA、账号、ROM 地址、visit id）。隐私政策三种语言已在「不登录」「第三方」「保存期限」三节写明（`test:legal` 的 `ai-fault-analysis*` 三条守着）；已结束的修补记录保留 365 天（`AI_HOTFIX_RETENTION_DAYS`），改其一要同步另一处。
- 手动分诊接口等 50 秒没结果就回 202（nginx 默认 60 秒读超时），分析在后台继续落库。
- 部署要 `cd server && npm run migrate`（新表 `ai_hotfixes`、新列 `game_startup_diagnostics.hotfix_ids`）；缺列时诊断包照存，只是统计不到修补效果。
- **代码层边界**（`applyBoundaryGuards`，任何档位都生效）：runtime 为 `page` 的页面崩溃动作全部作废，只记录；错误原文命中 romset / CRC / BIOS / CHD 等 ROM 数据特征时 `set_core` / `set_runtime` 作废 —— 换核心修不了数据，只会把能玩的人也弄坏。
- **冷却期内故障变大会重新分诊**（`triageGate`）：玩家侧看门狗超时的原文统一是「连续 120 秒没有启动进度或可玩信号」，所有原因归成同一个特征；
  只按「6 小时一次」会让前半夜几次弱网超时挡住后半夜的大故障。访问数涨到上次分诊时的 3 倍且至少多 3 个、距上次 ≥ 1 小时就再分诊。
- **安全档位下混合提案拆开**（`planApplication`）：安全动作立即生效，换核心 / 换运行时拆成 `source = 'ai-split'` 的待批准记录（不占每小时预算）。
- 故障面分析（哪类问题 AI 看得到、修得了）、最近三起故障的推演与完整边界见 `docs/ai-hotfix.md`。
- 回归：`npm run test:ai-hotfix`。

### 2.36.2 download.8bitgo.com 与 rom.8bitgo.com：授权下载和站内明文资源的优选线路（2026-11-16）

DNS 是**不走代理**的 CNAME，指向 BestCF 名单里的 `youxuan.cf.090227.xyz`（CMLiussss 维护，按三网分别解析）。
流量打到 Cloudflare IP 后按 Host 匹配 ROM Worker 的 `download.8bitgo.com/*` 与 `rom.8bitgo.com/*` 路由（证书与线路由生产配置维护）。
站内播放器用 `VITE_ROM_DOWNLOAD_URL=https://rom.8bitgo.com` 优先读取明文 ROM / BIOS / 系统镜像；旧 `.8bg` 与
开放平台短期凭据下载仍走 `download.8bitgo.com`。两条线路失败时继续回退到主资源域或 EdgeOne 镜像。

- **后台“打开/检查”也比较真实正文速度**：普通链接原先是 `romUrlForKey()` 生成的单域 `<a>`，浏览器接管下载后页面无法换线。`src/admin/RomOpenLink.tsx` 左键同步开新标签，再用同一对象 8KiB Range 样本、600ms 对冲和 4.5 秒单线路上限，在 `rom` / `download` / `cn-assets` 中选先读完的线路；完整文件仍只从一个域名下载。外链和中键、修饰键点击保留浏览器行为。不要把优选 IP 直接写成 HTTPS URL：继续使用有证书且 Worker 按 Host 路由的域名。

- `/roms/...` 等对象路径与 `assets` 完全一样（同一个 Worker，私有前缀 401、`romv` 校验、Range 边缘缓存都在；边缘缓存按完整 URL，多个域名各存一份）。
- `/api/open/v1/rom-plain/{grant}`、`/api/open/v1/bundle-plain/{grant}/...`、`/api/diag` 由 Worker 原样转发到源站
  （`PLAIN_PROXY_HOSTS` / `PLAIN_PROXY_ORIGIN`），凭据校验、限流、8BG 解密都在源站，Worker 不持有 ROM 密钥；
  其它 `/api/*` 一律 404，不转发 Cookie / Authorization，响应不进边缘缓存。
- ⚠️ Worker 子请求到源站时 CF-Connecting-IP 是 **Worker 出口**（实测 `2a06:98c0:3600::103`）。Worker 带
  `X-8BitGo-Client-IP` + 共享密钥，源站只在密钥对上时才采信（`server/src/download-proxy.js`）。两边密钥必须一致：
  Worker `PLAIN_PROXY_SECRET`（`wrangler secret put`）、源站 `DOWNLOAD_PROXY_SECRET`。核对：`curl https://download.8bitgo.com/api/diag`
  的 `ip.downloadProxyClientIp` 应是你自己的 IP，为 null 就是密钥没配或对不上。
- **`download.8bitgo.com` 不直接吐明文**：开放平台明文只经短期凭据接口授权；站内播放器的明文对象走独立的 `rom.8bitgo.com`。
- 明文转码受 `ROM_TRANSCODE_CONCURRENCY`（默认 2）全局并发限制，超额回 503 `server_busy`。
- 回滚：删掉 `download` 这条 CNAME，域名回落到开代理的 `*.8bitgo.com` 通配记录，Worker 路由照常生效，只是不再走优选 IP。
- 回归：`npm run test:worker`（`plain-proxy.test.mjs`）、`cd server && npm run test:download-proxy`。

### 2.37 SSR 页面在 Cloudflare 缓存一天，靠「改内容就清」保证新鲜

源站渲染只要 20～100ms，TTFB 慢在回源：页面原来只在边缘缓存 5 分钟，游戏 × 八语言的长尾页几乎
次次回源。现在 SSR 响应同时发两套缓存头：

- `Cache-Control: s-maxage=300`：浏览器与 cn.8bitgo.com（EdgeOne）照旧，EdgeOne 没有清缓存通道；
- `Cloudflare-CDN-Cache-Control: max-age=86400`：只有 Cloudflare 认，**仅在 `server/.env` 配了
  `CF_ZONE_ID` + `CF_PURGE_API_TOKEN` 时才发**（令牌只有该区域的 Cache Purge 权限）。

所有页面带 `Cache-Tag: html`。`invalidateContent()`（后台所有写路径都调它）延迟 3 秒、合并后按标签
清全部 HTML（`server/src/edge-purge.js`；`CF_ZONE_ID` 可写多个区域、逗号分隔，NS 迁出前后都写 8bitgo.com 与 SaaS 区域 8bitgo.top 两个，迁出后旧区域的永久报错不判失败）；`deploy/redeploy.sh` 发布成功后也清一次，否则新前端
要等一天。⚠️ 新增「会改变公开页面内容」的写路径必须调 `invalidateContent()`，漏了就是旧页面挂一天。
游玩次数这类高频写故意不清。`PAGE_EDGE_MAXAGE=0` 可整体退回 5 分钟。回归：
`cd server && npm run test:edge-purge`。

### 2.37.1 Cloudflare Rocket Loader：本站脚本必须带 `data-cfasync="false"`（2026-11-06）

区域里开着 Rocket Loader，它把 HTML 里每个 `<script>`（包括 Vite 的模块入口、`edge-route-v2.js`、
SSR 的 `window.__8BITGO__` 注水）改写成 `<随机前缀>-module` / `-text/javascript`，等 **window load**
（所有首屏封面图 + Cloudflare Insights 的 beacon.min.js）之后才补执行。《铁拳》详情页实测：入口 JS
4.86s 就下完了，React 到 8.1s 才开始跑，`/api/auth/me`、ROM 探测、「开始游戏」按钮全部顺延 3 秒多。

- `shared/rocket-loader-optout.js` 的 `optOutRocketLoader()` 给可执行脚本补 `data-cfasync="false"`
  （JSON-LD 不碰、幂等）。三处都要有：vite 插件 `rocket-loader-optout`（post 阶段，**排在 legacy() 之后**，
  才能覆盖它注入的 nomodule 脚本，已用同版本 vite 8.3.5 + plugin-legacy 8.2.3 构建核对）、SSR 读模板时再兜一次、
  SSR 注水脚本本身。
- `retargetStaticToCnEdge`（大陆入口改写）和 Early Hints 都按标签文本解析 HTML，新属性不能打断它们的正则。
- **J2ME 的 run.html 与 j2me-web 的 embed.html 也要退出**（2026-11-14《仙剑奇侠传 2004》）：run.html 不走 SSR 模板，
  CheerpJ 的 loader.js 被改写后在 load 之后才执行，适配器 load 时看不到 `cheerpjInit`，**每一局**都误判成「loader 没加载上」，
  CDN 探测 ok、重载一次也照旧，最后报「Java 运行时卡住了」。`patch-j2me-runtime.mjs`（setup-j2me / prebuild）给 run.html 补标记，
  `vite.j2me-web.config.ts` 给 embed.html 补；`cheerpjLoaderMissing` 只在 loader 是普通同步脚本时才下结论。
  run.html 在 Cloudflare 有 1 小时边缘缓存，部署后要清 `/j2me/run.html`。
- **2026-11-14 已用 `cf zones settings edit rocket_loader -z 8bitgo.com --body '{"value":"off"}'` 关掉**（改写发生在出边缘时，
  已缓存页面无需清缓存即恢复原样）。`data-cfasync` 标记继续保留，防止有人再打开。查看：`cf zones settings get rocket_loader -z 8bitgo.com`。
- 根治是 Cloudflare 后台关掉 Rocket Loader（Speed → Optimization → Content Optimization）；`/web/*`
  下独立部署的网页游戏不经过这条模板，开着时仍会被改写（PvZ 的 check 脚本已在拦它的残留）。
- 回归：`npm run test:rocket-loader`。

### 2.37.2 浏览器整页翻译会让 React 崩在 removeChild（2026-11-15）

大陆 Edge 157 两份现场（《愤怒的小鸟》《JoJo》详情页）：`NotFoundError: Failed to execute 'removeChild' on 'Node'`，
组件栈落在侧栏房间数徽标 `SidebarCounts`。Edge / Chrome 自带翻译把文本节点挪进 `<font>`，徽标在「0」与「• N」间切换时
React 仍从原父元素删那个文本节点 → 整页崩到兜底页（facebook/react#11538，上游不修）。两处修法：
`src/services/translatorDomGuard.ts` 在两个入口**首次渲染前**给 `Node.prototype.removeChild / insertBefore` 加「已不是直接子节点」
的纠正分支（正常路径不变，只 warn 一次）；纯数字徽标加 `translate="no"`，两种形态用不同 key 整块替换。
新写会在文字与元素之间切换的组件时，把可变文字包进自己的元素里。回归：`npm run test:translator-dom-guard`。

### 2.38 浏览器兼容下限：页面 Chrome 64，模拟器运行时 Chrome 80（2026-11-15）

两层下限不一样，别混为一谈：

- **页面**（React、路由、详情页）：`vite.config.ts` 的 `LEGACY_BROWSER_TARGETS`（Chrome 64 / Safari 12 / Firefox 67）。
  `@vitejs/plugin-legacy` 的运行时检测要求 `import.meta.resolve`（Chrome 105 / Safari 16.4 / Firefox 106），
  不满足的浏览器自动改走转译好的 legacy 包。2026-11-15 用 Chromium 强制走 legacy 包实测线上《拳皇97》：
  详情页正常渲染、能开局、FBNeo 起来了。
- **模拟器运行时**是第三方预编译产物、原样发布，不经过 Vite。acorn 取证的最低语法：EmulatorJS 引擎 ES2020，
  各核心胶水 ES2022（类字段 + `?.` / `??`），binjgb / js-dos ES2022，Ruffle ES2021 —— 合起来要
  **Chrome 80 / Safari 14 / Firefox 74**。更老的浏览器页面打得开，点开始后在 iframe / Worker 里静默语法错误，
  只剩看门狗超时。`src/emulator/browserSupport.ts` 用 `new Function` 探一次（只认 SyntaxError，CSP 的 EvalError 不算）：
  NES 改走 jsnes（随 Vite 转译），其它运行时在 `begin()` 一开头报 `browserTooOld`，不下载核心和 ROM。
  **没有 WebAssembly 的浏览器**（Edge 增强安全性、iOS 锁定模式、关了 JIT 的安卓模拟器）另算：2026-11-15 Android 模拟器
  Chrome 110 打开《拳皇97》崩到兜底页，兜底页的技术细节写着 `ReferenceError: WebAssembly is not defined at romPack`
  —— @bokuweb/zstd-wasm 的胶水在**模块求值时**就碰 WebAssembly，`romPack.ts` 静态 import 它，详情页一加载就崩。
  现在 zstd 在 `readyZstd()` 里按需 `import()`；**没有 WebAssembly 时改用纯 JS 的 `fzstd`（MIT，0.1.1 钉版本）解 8BG**，
  所以 NES 走 jsnes 照样能玩本站的 8BG ROM（2026-11-15 实测《坦克大战》在关掉 WebAssembly 的 Chromium 110 里正常出画面；
  《魂斗罗》是 mapper 2 / submapper 2，jsnes 不收，退回 EmulatorJS 后按 `browserNoWasm` 提示）。
  选浏览器内解包而不是让后端吐明文：明文接口等于拆掉 8BG 防成批离线读取这道门，还得绕源站、走不了 CDN / 大陆镜像。
  `begin()` 先查 `webAssemblyAvailable()`：jsnes、直播、云游戏、网页游戏放行，其余报 `browserNoWasm`。
  GB/GBC 没有 WebAssembly 时走 binjgb 的纯 JavaScript 构建（见 §2.8.0.1）；GBA 改用自托管 IodineGBA 纯 JavaScript 核心，
  它必须拿到正好 16 KiB 的平台 BIOS，未配置时开局前报配置错误。IodineGBA 没有即时存档 ABI，游戏内电池存档只写独立的
  `8bitgo.iodinegba.battery.v1` 本地键，不与 EmulatorJS 的 SRAM / 云存档槽互相覆盖。上游源码钉在 `vendor/iodinegba/`，
  `npm run iodinegba` 重新生成 `public/iodinegba/iodinegba.js` 与内容哈希版本；更新核心时必须同时改 URL 版本。
  BIOS 管理页 `src/admin/PlatformBiosPanel.tsx` 必须保留 GBA 行（`NEED_BIOS`）：它只服务没有 WebAssembly 的 IodineGBA 退路，正常 mGBA 开局不依赖；删掉这一行会让管理员无法通过后台解决玩家的 BIOS 缺失诊断。回归：`npm run test:platform-bios-admin`。
  **EmulatorJS 的 GBA/mGBA 不得设置 `EJS_biosUrl`，也不要为它预热平台 BIOS**：mGBA 自带 HLE，BIOS 下载失败会被引擎当作启动错误传播；可选 Gitee BIOS 断网曾让 Chrome Android 玩家在 ROM 与核心都已就绪后仍整局失败。保持 GBA BIOS 只给 IodineGBA 读取；`usesBuiltInGbaHleBios()` 与 `npm run test:gba-fallback` 守住这条边界。
  js-dos 本身就是 WebAssembly，没有纯 JS 退路。
  回归：`npm run test:js-zstd-fallback`（fzstd 逐字节解开 @bokuweb/zstd-wasm 等级 19 的 frame，含 8MB 满块）。
  用 Chromium 110 加 `--js-flags=--noexpose-wasm` 可以原样复现（线上旧版崩到兜底页，修后页面正常、点开始给出提示）。
  **别在主包模块顶层碰 WebAssembly / 静态 import 任何 wasm 胶水**，`test:browser-support` 守着 romPack。
  核心胶水封在 7z 里、随核心更新，**别去转译它们**；升级引擎 / 核心后跑 `npm run test:browser-support`，
  它会重新取证，超过 ES2022 就红，提醒改下限和文案。

**没有 WebAssembly 时只列能玩的内容**（2026-11-15）：平台名单在 `shared/wasm-free-platforms.js`
（nes / gb / gbc / gba）；Flash 单独按 `WASM_FREE_GAME_SLUGS` 逐款过滤，当前只放 `fireboy-and-watergirl`。
给新平台加纯 JS 退路就同步平台名单和 `browserSupport.ts`；给 AwayFL 加游戏必须先满足 §2.24.0b 的实玩门槛。
探测只是一次 `typeof WebAssembly`，正常访客零开销：
- `src/services/noWasm.ts` 的 `useNoWasmMode()` 走 useSyncExternalStore，**服务端快照固定 false** —— SSR HTML、
  Cloudflare 页面缓存对所有人仍是同一份，水合也不会不匹配；这类浏览器水合后才切换。别改成按 UA / 请求头在服务端判断。
- 水合后 `usePageData` / `fetchPageData` 给 `/api/page` 加 `nowasm=1`，`loadForRoute` 按名单查首页、游戏库、平台、类型、
  相关推荐（缓存 key 前缀 `nw:`，`total` / 分页由 SQL 算准）；Flash 平台计数也只算通过 slug 名单的游戏，类型计数仍是全库数。
- 组件兜底：GameCard / GameCardWide / GameRankCard / PlatformCard 返回 null，首页横幅、类型样例、侧栏最近玩、搜索联想按平台过滤；
  `Layout` 顶部挂 `NoWasmNotice`（`site.noWasmNotice`）。详情页仍可打开，点开始由播放器给 `browserNoWasm`。
- 回归：`cd server && npm run test:nowasm-lists`。用 Chromium 110 加 `--js-flags=--noexpose-wasm` 实测首页只剩 NES / GB、
  平台入口只剩 nes / gb / gbc、请求带 `nowasm=1`、顶部出提示；正常浏览器不变。

### 2.39 坏 chunk 自修复：出错时按 SHA-256 清单核对、重取，正常加载零开销（2026-11-15）

PK / TH 两份现场：`The requested module './live-Cqhc9j-k.js' does not provide an export named 'x'`。源站那份有这个导出，
同一提交构建两次逐字节相同，改导出名也会换文件名 —— 浏览器拿到的字节被某一跳缓存换掉了，具体哪一跳无法从现场判定。
`/assets/` 一年 immutable，普通刷新只会从缓存拿回同一份坏字节。

- **构建**：`scripts/lib/vite-asset-integrity.mjs` 在 writeBundle 里读磁盘字节，写 `assets/integrity-<入口哈希>.json`
  （现代版 /assets/ 下所有 js / css / wasm 的 SHA-256，约 8KB）。入口哈希随任何 chunk 变化，修复脚本只看入口 src 就能找到本版清单。
  `postbuild:client` 跑 `check-asset-integrity.mjs` 逐个核对，清单错了会把好文件判坏（反复重取、刷新、清边缘），所以宁可构建失败。
- **正常访问**：`index.html` 里一段 ES5 内联钩子，不发请求。只在 localStorage `8bitgo.asset-remap` 有未过期记录时插一张 import map；
  定义 `window.__8bitgoAssetRepair`，并监听 window 的 `SyntaxError`（入口模块链接失败时 React 起不来，兜底页接不住）。
  钩子必须排在任何模块脚本之前，import map 才来得及生效。
- **出错时**：才加载 `public/assets/asset-repair-v7.js`（文件名即代次，长期缓存；改逻辑新建 v8，旧版留给已打开的旧页面）。
  首页按入口脚本所在资源域加载，所以大陆入口 `cn.8bitgo.com/_cn/assets/` 的自修复也走 EdgeOne；该路 5 秒超时或失败后再回主站
  `/assets/` 重试，每次的地址 / 结果 / 耗时记在 `window.__8bitgoAssetRepairLoad`，诊断包写成「加载失败 812ms」「5 秒超时」
  「已加载、核对 20 秒内没有结束」。只核对本页 Resource Timing 里用过的
  chunk、点名 chunk 的静态 JS 依赖和错误点名的那个，先 `cache: 'force-cache'` 读浏览器缓存算 SHA-256，三种结果：
  浏览器缓存坏了 → `cache: 'reload'` 重取（同时覆盖缓存里的坏副本）→ 刷新一次；
  重取还是坏（CDN 边缘那份坏了）→ 带 `?asset-repair=1` 直接回源核对，好的话记进 `8bitgo.asset-remap`（7 天）、
  `POST /api/asset-repair` 请服务端清 Cloudflare 上那个 URL → 刷新后 import map 把它改指到回源地址；
  回源也坏（部署本身坏了）→ 不刷新，留在兜底页并上报。一分钟内同一页最多自动刷新一次。
  取不下来（网络错误 / HTTP 错误）→ 绕过缓存重试一次，好了记 `recovered`；仍失败时再带 `?asset-repair=1` 回源核对，
  回源正常就记 `remapped`、请服务端清 Cloudflare；仍不可达且文件在大陆加速入口上，再取主站同名文件对照，主站正常记 `edgeOnly`，
  主站也不行记 `failed`。`trace` 记录每一步的 HTTP 状态 / 网络错误 / 超时。
  v7 起 `.js` 还核对 Content-Type（不是 JavaScript 记「类型错误」，按字节不符处理）；点名文件字节和类型都对时只记 `inDocument`，
  不改地址、不清边缘（见本节末 #1285 / #1368 / #1393）。
- 用 SHA-256 不用 MD5：`crypto.subtle` 只有 SHA 系列，原生实现比 JS 版 MD5 快。没上全量 SRI：那要把约 110 个哈希塞进每份 HTML。
- `AppErrorBoundary` 对 SyntaxError 与旧 chunk 404 都先走修复：修好了刷新一次（2026-11-19 起报告留到刷新后再发，
  好了记 `recovered`、又坏了并成一份 `failed_again`，见本节末）；没发现坏文件的 404 照旧静默刷新一次；其余上报。
  诊断包里的「资源核对：…」一行分得清浏览器缓存坏、CDN 边缘坏、源站坏、失败只在本页模块表里。
- `/api/asset-repair` 不用登录：只认磁盘上这一版清单里、且磁盘 SHA-256 与清单一致的文件，按 IP 6 次 / 小时、全站 60 次 / 小时、
  同一文件 15 分钟一次。只清 Cloudflare；大陆入口 EdgeOne 没有清缓存通道，靠客户端 import map 绕过。
  没配 `CF_ZONE_ID` / `CF_PURGE_API_TOKEN` 时只打日志（`[asset-repair]`）。
- 本地复现：静态服务 `dist/client`，把某个懒加载 chunk 末尾的 `export{…}` 去掉再回给浏览器（立即 immutable 缓存）。
  2026-11-15 已在 Chrome 里实测三条路径：缓存坏（/blog 的 posts chunk）→ 重取后自动恢复；边缘坏（/games 的 Pagination）→
  回源地址 + import map 后恢复；入口模块链接失败 → window 收到 SyntaxError，钩子解析出导入方和被导入方。
- 回归：`npm run test:asset-repair`。⚠️ 测试桩里 `__8bitgoAssetRepairRun` 必须在「脚本加载成功」时才定义：
  2026-11-16 以前预先定义好它，钩子直接运行、不加载脚本，「出错时跟随入口资源域加载修复脚本」那条断言从 168e2e4 起就没过过。

**诊断包 #850 / #851（Chrome 145，《合金弹头2》详情页）：懒加载播放器失败，内部 `live-*.js` 连续 HTTP 500。**

- 现场能确认是依赖脚本请求返回 500；资源清单里 55/57 正常，不能据此断定 500 是源站还是边缘节点产生。
- v3 对 HTTP 错误只在原 URL `cache: 'reload'` 重取；连续失败且入口本来就在主站时直接记 `failed`，不会走已存在的查询串回源分支。
- v4 在连续错误后也试 `?asset-repair=1`：回源正常就记 import map remap 并请求清 Cloudflare；回源仍失败才结束诊断。详情页、播放器及其它懒加载页面共用该恢复路径。

**诊断包 #872（Safari 27 / iOS 18，MA，《拳皇2001》详情页）：懒加载页 chunk 与修复脚本均加载失败。**

- 现场确认 `GameDetailPage-*.js` 动态模块导入失败，随后同源 `/assets/asset-repair-v3.js` 在 1ms 内触发加载错误；没有 HTTP 状态、响应体或资源耗时，不能据此断言 chunk 或修复脚本具体在哪一层损坏。
- v3 首页钩子对主站 URL 去重后只尝试一次；修复脚本本身也失败时，React 兜底页只能刷新同一份页面，仍会拿到原来的缓存副本。
- 首页钩子现在先试入口资源域、再试主站；两条都失败时，对主站地址和入口地址各追加一次随机查询串重试。此逻辑不依赖外部修复脚本，详情页、其它懒加载页和播放器共享同一路径。
- 查询串重试仍失败时保留原错误兜底与诊断记录；它可绕过按完整 URL 缓存的失败副本，但无法修复源站持续不可达或浏览器策略拦截。
- 复查（2026-11-17）：#872 的构建是 `index-LISdmsjV.js`（v3 钩子），chunk 与修复脚本都在 1ms 内失败、且一分钟内的自动刷新已用掉（才会上报），最像设备那一刻整体连不上网，页面来自缓存。旧 `lazyNamed` 一失败就进错误边界，刷新时网络还没回来，第二次照样失败。
- 现在 `lazyNamed` 经 `importWithRetry`（`moduleLinkRecovery.ts`）就地重试：首次用原 URL，0.5 秒和 1.8 秒后分别用唯一 `?chunk-retry=<随机>` 地址；不再重复导入可能已被模块表记成失败的原 URL。`navigator.onLine === false` 时先等 `online`（最多 20 秒）。SyntaxError 不重试，仍交修复脚本。查询串只加在顶层 chunk 上，它的 `./x.js` 依赖按原地址解析，不会出现两份 React。
- 错误边界在离线时不核对、不刷新、不上报，挂 `online` 一次性监听后再刷新，不占用一分钟一次的自动刷新名额。回归：`npm run test:asset-repair`（含每次使用新 URL、静态依赖图修复、离线等待、SyntaxError 不重试）。

**诊断包 #917（Chrome 150 / Linux / 3G，《哈利波特与魔法石》）：播放器懒加载失败。**

- 现场清单核对 57 项、55 项正常；被点名的 `EmulatorPlayer-*.js` 在日志里重复强制重取两次，`failed` 与 `trace` 都为空。随后线上同名 chunk 返回 200，且 SHA-256 与该 build 的清单一致。证据不支持持续的发布缺文件 / 错字节；无法从现场分辨当时是瞬时网络、边缘响应还是静态依赖链接失败。
- 发现恢复逻辑有两个缺口：懒加载先用同一个 ESM URL 重试两次，浏览器可能已把这个 URL 的失败模块结果记在模块表里；修复器只核对错误点名 chunk 和 Resource Timing 记录，没有构建时静态依赖图，某个失败子模块可能不会被检查。第三次 `chunk-retry` URL 又和原 URL 被当作两个目标，弱网下同一个播放器会被诊断重复下载。
- v5 改为每次网络重试都用唯一 `chunk-retry` URL；完整性清单升为 v2，记录每个 JS chunk 的静态 imports，出错时只递归核对点名 chunk 的依赖图。诊断按原始构建文件去重，但保留 `asset-repair=1` 等有意义的查询参数。旧 v4 留给已打开的页面；生产构建检查清单版本、依赖引用与修复脚本逐字节一致。
- 回归：`npm run test:asset-repair`（依赖损坏修复、重复重试去重、唯一 URL 重试、旧 manifest / 服务端接口兼容）。

**诊断包 #1108（Chrome 150 / Linux / US / 3G，《黄金矿工》）：播放器懒加载失败。**

- 清单查了 56 项、55 项正常；点名的 `EmulatorPlayer-*.js` 强制重取后 SHA-256 正确，`failed` / `trace` 为空。现场只能确认动态模块请求失败后，普通 URL 的文件字节可取且正确；具体是瞬时网络、CDN 响应头还是浏览器模块加载路径，现有数据分不出来。
- 旧恢复在普通 URL 内容正确后直接整页刷新。Chrome 仍会沿同一个 CDN URL 重试，若故障在该 URL 的边缘缓存 / 请求路径，刷新可能重复失败。v6 在同源懒加载失败且普通 URL 已校验正确时，额外用 5 秒上限核对 `?asset-repair=1` 地址；只有查询串副本也与 SHA-256 清单一致，才保存 import map remap、请求清 Cloudflare，并刷新到该副本。查询串未通过时维持原恢复行为。
- ⚠️ 2026-11-19 复查：v6 的前提不成立，它清的是健康文件；v7 已撤掉这一支。见本节末 #1285 / #1368 / #1393。
- 回归：`npm run test:asset-repair`。

**诊断包 #761（微信 iOS 27，CN，《超级玛丽》详情页，`TypeError: Importing a module script failed.`）：旧 build，但根因当时没修。**

- **为什么是旧 build**：现场 `index-BuArTvEC.js`、2026-11-15T21:11Z；改「按入口资源域加载修复脚本」的 168e2e4 在 11-16T04:50Z，
  线上 `asset-repair-v2.js` 修改时间 05:25Z。旧钩子从主站根路径取 `/asset-repair-v1.js`（经 Cloudflare 洛杉矶），所以只有一句
  「修复脚本没有运行（加载失败或超时）」。
- **失败的是哪个 chunk（证据）**：组件栈 `Lazy@unknown:0:0 < vt@…react-vendor-Igr6niNW.js:11:4269 < Mt@…:11:7818`。
  Playwright WebKit 26.6 让 EdgeOne 上的 `GameDetailPage-*.js` 回 502，报出同一句错误、同样的偏移：是 `/games/:slug`
  直接挂的 `GameDetailPage` 路由 chunk（`<Route element={<GameDetailPage />}>`，vt / Mt 是 react-router）。
  会上报说明一分钟内已经自动刷新过一次（`stale && reloadOnce()` 成功时不上报），即同一处**连续失败两次**。
- **没查清的（推断，未验证）**：EdgeOne 那一路对这位访客返回了错误或断流。11-16 从一处网络逐个核对两版构建在
  `/_cn/assets/` 上的 317 个文件，状态码 / MIME / CORS / SHA-256 全对；别的 EdgeOne 节点、微信 WebView 自身的因素都没法在本地复现。
- **旧版为什么救不回来**：懒加载 chunk 按「相对引用方」解析（`renderBuiltUrl`），入口在 EdgeOne 上，整张模块图就在 EdgeOne 上。
  入口脚本有 `onerror` 退回主站，懒加载 chunk 没有；v2 对「取不下来」只记失败，普通刷新又回到同一条 EdgeOne 路。
- **现在**：
  - `lazyNamed` 失败时从加载函数的源码里取出 chunk 文件名（产物里是 ``import(`./GameDetailPage-xxx.js`)``）挂在错误上。
    Safari 这句错误不带地址，全靠它点名。
  - 兜底页按核对结果决定下一步：
    - `edgeOnly` → 上报，带 `__assets=origin` 整页重新载入；
    - 修好了 → 普通刷新；
    - 没证据 → 先普通刷新，一分钟内又坏才换主站；
    - 两种刷新各自每分钟一次，第三次停在兜底页。
  - 服务端在 `normalizeUrl` 之前剥掉 `__assets`，SSR 这次不调用 `retargetStaticToCnEdge`。
  - 入口（`entry-client.tsx`）在渲染前去掉参数，之后的刷新也留在主站。
- ⚠️ **不能只把失败的文件或目录用 import map 换到主站**：页面 chunk 会反过来 import 入口 `./index-<哈希>.js`。
  换了目录的 chunk 会按主站地址再拉一份入口，入口重复执行、React 出现两份。只能整页换。
- ⚠️ **去 `__assets` 参数不能放进首页内联钩子**：钩子后面的语言跳转脚本和 `edge-route-v2.js` 用 `location.search` 拼跳转地址，
  先去掉的话一跳就丢了「改用主站」。
- ⚠️ **依赖 Cloudflare 改写规则保留原查询串**（11-16 实测大陆请求 `?page=2` 拿到 `canonical …?page=2` 和 `cover-cdn=cn`）。
  规则哪天改成整段替换，`__assets` 会被吃掉，兜底退化成「再坏一次就停」。服务端和前端要同一次部署。
- ⚠️ 主站兜底对大陆访客很慢：11-16 从大陆经洛杉矶取一份 180KB 的页面 90 秒没下完。所以只在有证据或普通刷新已失败时才用，不能当默认。
- 诊断包：
  - 服务端 `scrub()` 的邮箱规则以前把 Safari 栈帧 `vt@https://cn.8bitgo.com/...` 整段吞成 `[邮箱]`（网址先被缩短成 `vt@cn.8bitgo.com/…`），
    现在邮箱后面紧跟路径或 `:行号` 的不算邮箱。
  - 页面崩溃（runtime `page`）的资源列表改从页面打开起算。以前从上报那一刻算，#761 一条请求都没有。
- 端到端（11-16，Playwright Chromium 153 / WebKit 26.6，`127.0.0.1` 当主站、`localhost/_cn/` 当 EdgeOne，真实构建产物）：
  - EdgeOne 502 → 主站恢复；
  - 修复脚本在 EdgeOne 上也 502 → 改从主站取修复脚本，结论相同；
  - 只坏第一次 → 普通刷新恢复；
  - 两边都坏 → 两次自动刷新后停在兜底页，两份上报都带经过。
  - 微信 iOS 本身没有验证。
- 2026-11-17 复查：播放器触屏手柄 `LazyTouchPad` 还是裸 `lazy()`（移动端会话必下），没有就地重试、也不点名 chunk。现已改走 `importWithRetry` + `tagLazyFailure`；`test:asset-repair` 扫描 `src/` 里所有 `lazy(() => …)`，不经 `importWithRetry`（或 `lazyNamed`）就失败。
- **诊断包 #1196 / #1201（Chrome 97 / Android 15 / CN，《恐龙快打》）：legacy 懒加载 chunk 加载失败。** #1201 点名 `EmulatorPlayer-legacy-J-EQUy6G.js`，错误来自 SystemJS 的 `HTMLScriptElement` 加载回调；请求记录为 0 传输 / 0 内容。现有现场不能判断底层是瞬时网络、缓存还是 EdgeOne 响应，也不能从单次事件确认服务端缺文件。
  Vite legacy 包把 `import()` 编成 `System.import()`；SystemJS 的通用错误不匹配现代 ESM 重试列表，失败 URL 也可能藏在 `__vite__mapDeps` 运行时映射里，旧 `lazyChunkFile()` 因此拿不到文件名。结果是只尝试原 URL 一次，错误边界也不把它当 chunk 加载失败。现在识别 SystemJS 加载错误，从错误 URL 取出 legacy chunk 文件名，用新的 `chunk-retry` 查询串通过 `System.import()` 重试；仍失败时先整页刷新，重复失败再从 CN 加速入口切到主站。legacy 产物不在现代版 SHA-256 清单中，不能用现代清单给它作完整性结论。
  2026-11-19 复核：#1201 就是 6b23db2（11-18 17:04 +0800）据以修复的那份现场，构建 `index-Co6eB-5S.js` 早于修复，当时没有任何重试。
  当前构建产物里 legacy 懒加载编成 ``()=>_(()=>t.import(`./GameDetailPage-legacy-….js`),void 0,t.meta.url)``，`lazyChunkFile` 认得出；
  重试走 `t.import(url)`（SystemJS 上下文导入），`import.meta.url` 编成 `t.meta.url`，查询串只加在入口上，依赖仍按原地址解析 —— 修复是完整的。
  同时出错的 `lf1-cdn-tos.bytegoofy.com/…/push.js`（头条推送脚本）说明那一刻设备整体断流，不是我们一个文件的问题。
  补充：SystemJS 失败的加载也会留在注册表里（`load.er`），和原生模块表一样；SystemJS 错误点名的文件不是懒加载入口时说明失败在依赖，
  就地重试入口同样没用，现在按模块图证据直接交给兜底页刷新（下一条）。

**诊断包 #1285 / #1368 / #1393（2026-11-18～19，Chrome 150 / Linux / desktop / US，`Failed to fetch dynamically imported module: …/GameDetailPage-*.js`）：不是 CDN 坏，是自动化客户端 + 静态依赖失败被模块表记住。**

- **画像**：三份与 #917 / #1108 一模一样 —— 90 个逻辑核、32GB、1440x900、zh-CN、美国、网络报 3G（0.4～1.45Mbps、rtt 300～350ms）、
  上报时页面在后台，三天里换游戏（三国志 3、狂野飙车 6、FIFA 97、黄金矿工……）、换部署反复出现。90 不是任何桌面 CPU 的线程数（云主机切出来的 CPU 集），
  数据中心出口不会只有 0.4Mbps（开着网络限速），版本停在 Chrome 150（自动化集群常钉旧版浏览器）、页面在后台（多标签抓取）。
  结论：一台跑在美国机房、按中文内容配置的抓取 / 测试机。诊断包不存 IP / ASN / 完整 UA，所以只能从这些特征推断，不能百分之百确认；
  以前也没采 `navigator.webdriver`，现在采了（下面）。
- **为什么「原 URL 内容正常、查询串副本正常，但 import() 失败」**：2026-11-19 用 Chromium 153 与 WebKit 26.6 的最小复现
  （入口 `Page.js` 静态 import `dep.js`；`dep.js` 404 / 错误 MIME / 被 `route.abort` 中止 / `window.stop()` 一次）实测：
  1. Chrome 报 `Failed to fetch dynamically imported module: …/Page.js` —— **写的是入口，不是真正失败的依赖**；Safari 只有 `Importing a module script failed.`。
  2. 失败的依赖被**这一份文档的模块表**记住：换查询串重导入口（`?chunk-retry=1`、`=2`）、原地址重导都失败，依赖请求根本不再发；
     整页刷新（新文档）后导入成功。入口自己失败（503）时换查询串重导就能好 —— 就地重试只对这种情况有用。SystemJS 也一样（`load.er`）。
  3. 同一时刻 `fetch()` 入口、依赖、查询串副本全是 200。
  所以 v6 看到的「入口字节对、查询串副本对」恰恰是这个机制，不是边缘缓存坏了；它写 import map、请求清 Cloudflare，清的是健康的
  `GameDetailPage-*.js`（每次都让全球边缘回源一遍）。#1368 的 `gradients-*.js`（1KB 的 `src/lib/gradients.ts`）连修复脚本的 fetch、
  强制重取、查询串回源都取不下来，只能是那台客户端自己拦 / 中止了请求；另外 6 个「改走回源」的文件同理是误判。
  依赖第一次为什么失败，在我们这边查不到（客户端中止、拦截或它自己的代理），不是我们能修的。
- **改动**：
  - `importWithRetry` 第一次失败后读**模块图证据**（`importGraphEvidence`）：Resource Timing 里入口原地址那条已完整下载（有正文、非错误状态）
    就说明失败在依赖，不再换查询串白下两遍入口（3G 上就是几百 KB、两秒多），直接交给兜底页刷新；Chrome 会给失败的依赖留一条
    `responseStatus` 0 / ≥400、无正文的记录，据此点名（WebKit 不记失败请求，只能判入口下完了）。跨源无 TAO 时看不出，照旧重试。
    legacy 看 SystemJS 错误里的文件是不是入口。证据挂在错误上，兜底页写进诊断包（「模块图：入口已完整下载、失败在静态依赖…」），
    失败的依赖也交给修复脚本强制重取。不按时间筛：悬停预取（`preloadPlayer`）更早失败的依赖正是被记住的那个。
  - `asset-repair-v7.js`：撤掉 v6 的「点名文件正常 → 查询串副本 → remap + 清 Cloudflare」，改记 `inDocument`；多核对 `.js` 的 Content-Type，
    边缘把错误类型挂在 `.js` 上（fetch 拿得到字节、模块会被拒）才算地址本身异常，走查询串回源 / remap —— 这才是 v6 想覆盖的故障。
    依赖真取不下来时不标 `inDocument`（入口只是被连累）。`check-asset-integrity.mjs` 改核 v7。
  - **报告留到刷新后**（`src/services/pageRecovery.ts`）：兜底页要自动刷新时不再「先上报」，把报告（诊断包当场采）存进 sessionStorage，
    刷新后的页面：同一个 chunk（按去哈希的名字比）加载上了 → 补报 `recovered`（漏斗新事件，不算 failures）；没点名 chunk、20 秒没再崩也算；
    又崩了 → 那份报告带 `recovery.outcome = failed_again` 和「刷新前：…」，一次故障只记一行；换了页 / 等不到点名 chunk → `failed` + `unconfirmed`。
    不跟刷新的自动化客户端、刷新前就关了标签页的，这份就不报了（少一份噪音）。sessionStorage 不可用时退回先报再刷新。
    静默刷新（旧 chunk 404）好了照旧不报，只留前情。`importWithRetry` 成功时经 `onLazyChunkLoaded` 通知，路由与触屏手柄都覆盖。
  - **来源分组**（`server/src/startup-diagnostics.js`）：前端多采 `env.auto`（`navigator.webdriver`、窗口外框 0×0、语言列表为空，几个开关、无标识符）；
    服务端 `classifyAutomation` 当场用原始 UA（`isCrawlerUa`，与 SSE 拒爬虫同一张表）判 `bot`，桌面报 >64 核等判 `suspect`；不看 IP / 地区 / 语言。
    `cohort` 存新列（`npm run migrate`；缺列时退回旧写法），也进特征：自动化、刷新后未确认、刷新后又坏各成一组，普通访客的特征与以前完全一样。
    `needsAttention` 挡掉自动化 / `recovered` / `unconfirmed`：不发飞书、不聚集报警、不触发 AI 分诊、不计入 AI 修补的失败统计。
    后台「错误诊断」默认不列已恢复和自动化（只数个数），点「显示」才列；类型筛选多了「已自动恢复」。隐私政策三种语言已写明新增的开关与刷新后补报。
- **各样本结论**：#1285 / #1368 / #1393 = 疑似自动化客户端（`suspect`，桌面 90 核），自愈与否原现场不可知（旧版先报后刷）；
  按新代码它们会进单独一组、不叫人。#1201 = 真实玩家、旧构建、已由 6b23db2 覆盖。
- **端到端**（2026-11-19，Playwright Chromium 153 + 真实构建产物 + 只给 `/startup` 打桩的静态服务器，`route.abort` 让 `GameDetailPage` 的静态依赖 `AgeGate-*.js` 失败）：
  - 失败一次 → 0 个 `chunk-retry` 请求、0 次清缓存、不写 import map，刷新一次后补报一份 `recovered`（带模块图证据；`env.auto` 是 `webdriver`）；
  - 只有普通地址一直失败 → 查询串回源正常 → remap + 请求清缓存，刷新后经 import map 恢复，补报 `recovered`；
  - 所有地址都失败 → 刷新一次后停在兜底页，只有一份 `failed` + `failed_again`，带刷新前的经过。
- 回归：`npm run test:asset-repair`（模块图证据按两家浏览器的真实 Resource Timing 形状、证据驱动的重试、v7 的 inDocument / MIME、刷新后补报）、
  `npm run test:startup-diagnostics`（来源分类、特征分组、噪音分区、`recovered` 事件），`cd server && npm run test:diag-alert && npm run test:diag-lark`。

**懒加载导入系统性加固（2026-11-19，同一天的后续）：依赖失败一次不再拖垮整页。**

- **问题规模**：详情页 chunk 在首屏之外还要 21 个 chunk（14 个不到 4KB），播放器 21 个，各运行时适配器 21～29 个。
  Vite 的预加载助手（`\0vite/preload-helper.js`）给每个依赖插 `<link rel=modulepreload>`，不等、不重试；任何一个失败一次就被本页模块表记住。
- **四种做法实测**（Chromium 153 / WebKit 26.6，入口 + 一个静态依赖，依赖第一次 503；数字是服务器收到的请求数）：

  | 做法 | 不出错时 | 依赖 503 一次后 |
  |---|---|---|
  | modulepreload（Vite 默认） | 两家都 1 次 | 两家都导入失败（被记住） |
  | `fetch()` 先暖缓存再 `import()` | Chromium 1 次；WebKit 有磁盘缓存 1 次、**临时会话 2 次** | 两家都恢复 |
  | `<link rel=preload as=script crossorigin>` | 两家都 1 次（被模块加载器复用） | 两家都失败（失败的预加载也被复用，重试无效） |
  | 合并小 chunk（codeSplitting 组） | 详情页扇出 21→10 | — 但首屏 644KB→1016KB、房间页被拖进 232KB 播放器代码，**否决** |

- **现在**：`scripts/lib/vite-resilient-preload.mjs`（vite.config.ts 里 `resilientPreloadPlugin()`）用 transform 钩子把 Vite 助手的
  `export const __vitePreload` 改名成 `__vitePreloadVite` 保留，接上包装：**Chromium 内核**（`navigator.userAgentData`）上，懒加载的 JS 依赖
  （连同目标 chunk 本身）先 `fetch()` 完整读进 HTTP 缓存，网络错误 / 5xx 重试一次（600ms），404 等确定性错误不重试，响应头 15 秒、
  正文停滞 15 秒中止；全部取到才交回 Vite（只剩 CSS）和真正的 `import()`，模块加载器读的全是缓存。还取不下来就抛带
  `__8bitgoPreloadFailure` 标记的错误、**不碰模块表**，`importWithRetry` 见到它就再走一遍原加载函数（又会先暖缓存），不换查询串。
  安全边：这一页 fetch() 从没成功过（策略 / 扩展拦了 fetch）时原样交回 Vite（含 modulepreload）；Safari / Firefox / legacy 完全不碰。
  Safari 不开是因为无痕模式下每个依赖下两遍，弱网 iOS 多下一倍不划算；WebKit 依赖失败仍走上一条的「刷新一次 + 补报 recovered」。
- **CSS 依赖也要有限重试（2026-11-24，诊断包 #1005 / #3959）**：Windows / Chromium 的详情页多次在 `Unable to preload CSS for …GameDetailPage-*.css` 失败；现场没有关联的 CSS HTTP 状态，当前同一路径可正常返回样式，不能据此认定构建缺文件。旧包装只预热 JS，Vite 的失败 stylesheet 会留在文档里，重导入时没有可靠重取路径。现在 Chromium 包装也自行插入 stylesheet、等待 `load`，失败就删掉失败 link，600ms 后用唯一查询串重试一次；成功后不再让 Vite 重插 CSS。每次等待上限 15 秒，仍失败时写 `__8bitgoPreloadFailure`（仅文件名）并由现有加载恢复流程重试；Safari / Firefox / legacy 路径不变。服务端把 `Unable to preload CSS for …css` 明确归为高把握度 `page_asset / error.lazy_css`，不会被几分钟前 Clarity 等第三方 HTTP 400 抢分类。回归在 `npm run test:lazy-imports` 和 `npm run test:startup-diagnostics`。
- **构建检查** `scripts/check-lazy-imports.mjs`（postbuild:client）：每个懒加载目标（现代 `import("./X.js")`、legacy `.import("./X-legacy-….js")`）
  在磁盘上、现代目标连同静态依赖闭包都在 SHA-256 清单里；预加载助手确实进了现代包（Vite 升级冲掉补丁就红）；扇出预算 40 个 chunk、
  首屏预算 820KB（未压缩；当前约 631KB、最大扇出 29）。预算是「明显变坏」的报警线，放宽要在提交里写原因。上面那次合并实验就会被首屏预算拦下。
- **运行时适配器导入也要走同一套有限重试**（2026-11-26，生产诊断 #4295，Chrome 154 / macOS / JP，《口袋妖怪 白》）：20ms 内 `Failed to fetch dynamically imported module: …/emulatorjs-*.js`，真实访客开局直接失败；同一带哈希文件随后从公网返回 200，不能据此说 CDN 持续缺文件。`lazyNamed` / `EmulatorPlayer` 里的懒加载已用 `importWithRetry`，但 `runtimes.ts` 的 `LOADERS[id]()` 曾直接 `import()`，正好漏了玩家点击开始后才加载的模拟器适配器。现在 `loadMountOf` 用 `lazyChunkFile` 取出构建后的文件名，再经 `importWithRetry` 做有限、唯一 URL 重试；外层 `raceModuleLoad` 的进展超时和失败清除仍保留。给新运行时加 `LOADERS` 时不要绕过这层。回归：`npm run test:runtime-edge-route` + `npm run test:lazy-imports`。
- **ROM 完整性清单不可因单域故障锁死一局**（2026-11-27，诊断 #4330，街机 ROM / PGM BIOS）：播放器固定访问 `roms.8bitgo.com/integrity`；该域暂时不可达时，旧逻辑把版本化 URL 的 `null` 永久缓存在当前页面，重试不会再请求清单，Worker 又会按必校验策略拒绝 ROM。现在清单请求按可信的同桶读取域有限回退（总计最多 6 秒），只有验证通过的版本化清单永久缓存；缺失或网络失败最多缓存 30 秒，安全校验仍不降级。PS1 / PS2 的缓存标签不能在下载后同步等清单再写，否则会卡住开局；ROM Blob 先开始缓存，标签后台补写，强制刷新要等完整待写任务结束再清理，避免迟到回调复活旧缓存。后台只在日志明确说「必校验对象的 SHA-256 清单不可用」时归为高把握度 ROM 完整性拦截，可选清单预警不算根因；旧通用超时现场在回读时也会更新为已证实的完整性 / PSP 流式挂盘分类。回归：`npm run test:rom-integrity` + `npm run test:startup-diagnostics`。
- 未标记为必校验的旧 ROM 对象，下载完成后最多等待可选 SHA-256 清单 150ms；清单及时返回仍校验并修复坏块，超时先启动游戏且让清单请求在后台完成。只有下载器实际校验过的 Blob 才能带本地缓存印记，迟到清单不能给未校验字节背书；缓存印记更新还要匹配 Blob 记录代次，避免迟到的旧校验标记新文件。必校验对象路径不变，仍等待有效清单并失败关闭。`scripts/test-rom-integrity.mjs` 覆盖快速 / 慢速清单、迟到清单与坏字节；`scripts/test-rom-cache.mjs` 覆盖同尺寸换盘后的迟到印记。
- 必校验对象的清单主域 150ms 无响应时，最多并发一条可信同桶备用域；首个有效清单胜出后立即取消慢请求，剩余候选仍顺序兜底，总上限 6 秒不变。主域快速失败不额外等 150ms；只有一个地址时必须继续等待它，不能把竞速延迟当总超时。`npm run test:rom-integrity` 覆盖这些边界。
- 多个后台 ROM 上传并发命中同一 Worker 时，完整性能力探测按 Worker 地址共用一个在途任务；各文件只取消自己的等待，不可取消共享请求，成功能力仍按原 TTL 缓存。这样多盘 / 多 ROM 不会同时发重复 `/ping`，且探测失败前仍不开始发 ROM。回归：`npm run test:r2-upload-client`。
- **测试**：`npm run test:lazy-imports`（进 `npm test`：在 VM 里跑真助手代码——重试 / 404 不重试 / 去重 / 停滞中止 / 不碰模块表 / 非 Chromium 与 legacy 原样交回；
  Vite 助手模板没变；importWithRetry 暖缓存失败后整套重来；构建检查的五种拦截）。
  `npm run test:lazy-imports-browser [-- --dist <目录>]`（手动，要 Playwright 与构建产物，`PLAYWRIGHT_MODULE` / `WEBKIT_EXECUTABLE` 可指向本机已装的）：
  真构建 + `route.abort` 让详情页的一个依赖失败，Chromium 失败一 / 两次在页面里就好（不刷新、不上报），WebKit 刷新一次后补报 `recovered`，
  一直失败两家都停在兜底页只报一份 `failed_again`，不出错时每个懒加载依赖只下一次。拿 2026-11-19 之前的构建跑，Chromium「失败一次」那条会红。
  ⚠️ Playwright 一开 `page.route` 就关 HTTP 缓存，「只下一次」只能在不拦截的那一轮量。
- **升级 Vite 时**：`test:lazy-imports` 先核对 `node_modules/vite` 里助手模板（`export const ${preloadMethod} =`、`assetsURL`、`isCssPreloadUrl`）；
  对不上就改 `vite-resilient-preload.mjs`，别删插件让懒加载退回「失败一次整页坏掉」。

### 2.39.1 模拟器核心、BIOS 与 ROM 的下载完整性（2026-11-27）

**不用 MD5，统一用 SHA-256。** 传输完整性必须在字节交给模拟器前验证；构建机上的哈希清单不能代替浏览器运行时校验。

- 站内 R2 的 ROM / BIOS 用按 ETag 绑定的 2 MiB SHA-256 分块清单。新上传在清单发布前不可读；有清单的整包下载、Range 读盘和浏览器缓存都会校验，发现坏块只重取对应块一次，仍不匹配就停止开局。
- 旧 R2 对象没有清单时仍走兼容读取，避免未盘点前突然让老游戏无法启动。迁移时先用 `npm run rom:integrity-backfill -- --prefix=roms/ --require-complete` 做全量只读门禁；有缺项时用 `--apply` 回填后重跑门禁，确认零缺项再把 `worker/wrangler.toml` 的 `REQUIRE_ALL_ROM_INTEGRITY` 从 `"false"` 改为 `"true"` 并部署。全局严格模式会对 R2 全部 `roms/` 对象 fail closed，且不增加玩家开局往返；Worker `/ping` 会报告开关状态。回填记录的是当前 R2 字节，**只能保护之后的传输一致性，不能证明存量对象原本就是正确 ROM / BIOS**。要验证源内容正确，必须另有可信发布方摘要或人工验收。
- 外站直链与玩家本地文件没有独立可信摘要时，不能把“下载后计算出的摘要”当成原件校验。格式 / 长度检查只能筛掉明显错误，不能确认 BIOS / ROM 内容正确；不得伪造可信哈希。
- 运行时覆盖：EmulatorJS 核心 `.data`、PPSSPP、Play!、Ruffle、Dolphin、EKA2L1 的核心大文件有 SHA-256 / SRI 校验；EKA2L1 的 wasm/data 在完整长度接收后、交给 Emscripten 前按 `build_id.js` 的可信摘要校验。Binjgb 的 JS 用 SRI、WASM 在传给 Emscripten 前校验，IodineGBA 的 JS 用 SRI。小核心改版要更新摘要并跑 `npm run test:core-asset-integrity`。
- 游戏 ROM 与 BIOS：详情页适配器统一走 `loadGameBytes()`；带 `X-8BitGo-Integrity-Required` 标记的 R2 文件必须有 ETag 绑定的分块 SHA-256 清单，下载、Range 和本地缓存读取均先校验再交给核心。EKA2L1 独立说明页自动安装的站内 R2 固件也并行取清单并在写入设备前逐块校验；清单缺失但对象被标记为必校验时停止。外站直链、本地文件和未回填的旧 R2 对象没有可信摘要时，仍不能声称其内容正确；回填只保护后续传输，不替代来源验收。
- `js-dos` 的固定版本主入口 `js-dos.js` 在浏览器中用 SRI 校验（同一次请求，不额外下载）；其余 JS 胶水、CSS 和完整运行时包由 `runtime.json` / `check-jsdos.mjs` 在构建期核对。DOSBox、DOSBox-X（含 JSPI / debug）、wlibzip、webrtcnet 的 Emscripten WASM 则在各自 `instantiateAsync` 入口单次流式下载到固定长度缓冲区，SHA-256 匹配最终构建产物后才编译。哈希在 `wdosbox.wasm` 的鼠标二进制补丁之后生成；构建门禁逐个对照所有 WASM 清单、加载器和最终产物。该路径在 SHA-256 不可用、长度错误、HTTP 失败或摘要不符时停止，绝不回落未校验的 `instantiateStreaming` / ArrayBuffer 路径。它不改页面或 Worker 的全局 `fetch` / WASM API。改 js-dos 产物必须提升 `JSDOS_ASSET_VERSION` 并运行 `npm run test:jsdos-runtime`。

### 2.39.2 EmulatorJS 单人开局不等待联机辅助资源（2026-11-27）

单人开局不加载 socket.io，也不请求 ICE，避免给 ROM / 核心首传增加无关请求；邀请链接带联机会话时才在 ROM 准备期间并行预取。单人和邀请局都不能为首帧等待联机资源；room-token 与 WebRTC 钩子仍必须在 `loader.js` 前安装，开 / 加入房间前再由 `startNetplay()` 等 socket.io 和新鲜 ICE。联机资源失败只终止联机尝试，不拆正在运行的游戏。`npm run test:arcade-runtime` 必须覆盖单人不发请求、邀请预取不阻塞首帧、钩子早装和实际开房等待。

### 2.40 塞班 / N-Gage：卡带转储 ZIP 由本站脚本导入 E 盘（2026-11-19）

第一代 N-Gage 游戏的 No-Intro 转储是 MMC 卡上的原始目录（`game.id`、`nokia.dat`、`System/Apps/<代号>/…`），
不是 `.sis` / `.n-gage` 安装包：「安装 SIS」装不上，「文件管理」只能把文件平铺进一个目录。桌面版 EKA2L1 的
`system_impl::install_ngage_game_card` 网页版没有导出，所以 `scripts/eka2l1-ngage-card.js` 照它的规则用 JS 重做：
以最浅的 `system/apps/` 定位卡带根；System/Apps 下只能有 `<代号>`，或 `<代号>` + `<代号>_1`（`_1` 的 `.app` 过了
E32 头校验才运行它，否则运行 `<代号>`，不运行的那份不写 `.aif`，因为两份是同一个 UID）；整张卡复制到 `E:\`，
`System/Libs`、`System/Programs` 再复制一份进 `E:\System\Apps\<代号>\`。目标路径一律小写（网页版虚拟盘区分大小写，
客体只认小写物理名）。先全部解压进内存核对 CRC-32，不对就不落盘；落盘后用 `EKA2L1.savePaths` 只持久化这些文件，
然后刷新页面 —— 应用列表服务只在核心启动时扫描 System\Apps。刷新后按 AIF 里的应用 UID 核对列表，没出现会明说。

- 本站随附进运行时的脚本统一登记在 `scripts/lib/eka2l1-site-scripts.mjs`（完整构建、`npm run eka2l1:repackage`、
  `npm run eka2l1:check` 共用）。**改了这些脚本必须重跑 `npm run eka2l1:repackage`**：运行时目录按内容哈希命名、长期缓存，
  检查脚本会拦住「仓库里的脚本和发布目录不一致」。重复打包时删掉中途生成又没用上的 `v<哈希>` 目录。
  ⚠️ 重新打包以 `eka2l1Runtime.ts` 里**当前**的 `EKA2L1_BUILD_ID` 目录为基准：先打包、再删旧目录；先删了就把常量改回上一个已提交的目录再打。
- 回归：`npm run test:eka2l1-ngage-card`（合成 ZIP 覆盖版本选择、外层文件夹、大小写、路径穿越、ZIP64、加密、CRC、
  解压超量、只差大小写的重名、写盘冲突与持久化；设 `NGAGE_CARD_ZIP=<卡带 zip>` 时再跑真实转储）。
- 2026-11-19 浏览器实测（真实 Emscripten FS、`EKA2L1.savePaths`、原生 DecompressionStream，《模拟人生：脱颖而出》15 MiB
  转储）：50 个文件写进 E 盘并全部存进 IndexedDB，读回 CRC 与 ZIP 一致，旧 `_1` AIF 从 FS 和 IndexedDB 都删掉了。
  线上没有配置 N-Gage QD 默认固件（`/api/platform-bios` 里没有 `symbian`）。
- 同日用原版 N-Gage（NEM-4，V 4.03）的 SYM.ROM 本地实测：固件 2 秒装好，导入后游戏出现在程序列表、刷新后的 UID 核对提示正确，
  游戏能开机、过片头、进主菜单、跑演示画面（窗格可见时约 25 FPS）。站内文案写的是 N-Gage QD，但原版 N-Gage 的 ROM 同样能用。
- **《模拟人生：脱颖而出》（6RAK）在没有存档的设备上，标题画面报「Game deck memory full」**（2026-11-19 查清并绕开）：
  用带日志的诊断核心确认，存档 `C:\System\Apps\6RAK\THESIMS.SAV` 不存在时，游戏走「新建存档」那条路，让 ESTLIB 从
  `0x40FEAC` 起一块 1024 字节地写。这段地址是这个线程 64KB 栈（`0x400000–0x410000`，chunk 预留 1MB 只是按 1MB 对齐）的顶部，
  内容是栈帧；再往上是没提交的页，Posix 服务的 `valid_guest_range` 拒绝，返回 EFAULT，存档只剩 0 字节。
  **排除过的方向**：目录在不在（预建目录后照样失败）；GGEMU 往 Z: 放的 `100058ec.ini`（那是「常规设置」，放了照样失败）；
  客体内存跨 chunk 不连续（尾页根本没映射，拆分拷贝帮不上）；把未映射尾部补 0（第一块能写，游戏接着从 `0x4102AC` 写下一块，
  整块都在未映射区）。是游戏这条路径上的指针指进了栈区，模拟器层面没有干净的通用修法。
  **已有存档（哪怕 0 字节）时**游戏改从堆上的缓冲每次写 8 字节，存档正常写成 6176 字节（`ASIE0000` 开头），标题显示
  「Press 5 to start」，主菜单正常 —— 以前「目录已存在就能用」的观察，其实是那台设备上已经留着一个 0 字节存档。
  **修法**：卡带导入（`scripts/eka2l1-ngage-card.js` 的 `KNOWN_EMPTY_SAVES`）给已知游戏在 `C:\System\Apps\<代号>\` 放一个空存档，
  已有同名文件（不论大小写和内容）一律不动；程序库页和详情页播放器共用这段代码。目前名单只有 `6RAK → THESIMS.SAV`，
  别的游戏遇到同样的报错，先用诊断核心看 Posix 写入参数，确认是同一类再加进名单。
  诊断核心的做法：在本机构建目录的 `posix.cpp` 里临时加 `LOG_WARN`，`cmake --build build_wasm_8bitgo --target eka2l1_wasm` 增量约 1 分钟，
  把 `bin/eka2l1.wasm` + `eka2l1.js` 放进 `public/eka2l1/` 下的临时目录测（胶水要手动补 `Module["IDBFS"]=IDBFS`），用完删掉、源码恢复原样。
- 实测要点：按键要按住约 1 秒以上，游戏按帧采样键状态，低帧率下短按会丢；内置浏览器窗格隐藏时 rAF 可能完全停住，
  模拟器卡在「Symbian 系统引导中」后报启动超时，这不是运行时的毛病。完整 SVC/IPC 追踪可在播放页控制台调
  `EKA2L1.module.ccall('wasm_set_trace_logging', null, ['number'], [1])` 打开（极慢、日志量很大，用完关掉）。
### 2.40.1 🔴 EKA2L1 核心一启动就报 `reading 'IDBFS'`：新版 Emscripten 的胶水不兼容上游 boot.js（2026-11-19 修）

**经过**：2026-11-16 起发布的运行时（含线上 `vce3dcea2a438`）全部起不来。玩家在「安装设备固件」里选好 ROM 点安装，
立即报 `Cannot read properties of undefined (reading 'IDBFS')`，ROM 还没读就失败，整个 `/symbian` 走不到第一步
（本地与 https://8bitgo.com 都复现）。上游 `js/boot.js` 按老 Emscripten 写：`mod.FS.mount(mod.FS.filesystems.IDBFS, …)`，
`patchIDBFS` 还读 `IDBFS.DB_VERSION` / `IDBFS.DB_STORE_NAME`。本站用 emcc 7.0.0 构建，胶水里**没有 `FS.filesystems`**、
**没有把 IDBFS 挂到 Module 上**，版本和存储名也成了模块常量（`IDBFS_DB_VERSION=21`、`IDBFS_DB_STORE_NAME="FILE_DATA"`）——
就算只修挂载那一行，`patchIDBFS` 换上去的 `getDB` 也会不带版本号打开库、建出一个叫 `undefined` 的存储，存档全写不进去。

**修法**（运行时 `vcfbeb38ddde3`）：补丁表新增两条，完整构建和 `npm run eka2l1:repackage` 走同一个 `applyReplacePatch`：
- `idbfs-current-emscripten`（boot.js）：`idbfsOf(mod)` 优先取 `Module.IDBFS`，缺省版本 21、存储名 `FILE_DATA`，与胶水和 `savePaths` 一致；
- `idbfs-module-export`（`EKA2L1_GLUE_PATCHES`，改链接产物 `eka2l1.js`）：在 `Module["FS"]=FS;` 旁边导出 `Module["IDBFS"]=IDBFS`。
  完整构建在链接后对 `bin/eka2l1.js` 打；重新打包对已发布胶水打。

重新打包现在会把所有「改页面 / 改胶水」的补丁打到已发布文件上（已在位的跳过，顺带复核），基准运行时缺的 C++ 补丁会当场要求完整重建；
`check-eka2l1-web.mjs` 逐条核对这些补丁的替换文本在产物里，并单独拦住旧的 `mod.FS.mount(mod.FS.filesystems.IDBFS` 一行。
**以后换 Emscripten 版本，先查胶水还剩哪些 `Module[...]` 导出、IDBFS 的常量是不是还叫这个名字**，别只看构建通过。

验收（2026-11-19，本地浏览器）：用 1KB 假 ROM 走玩家的安装流程，核心正常启动、`/eka2l1` 挂成 IDBFS、库版本 21 且只有 `FILE_DATA`，
最后报「ROM 文件损坏」（假 ROM 的正确结果）；写一份文件走 `syncfs`、再导入一张卡带走 `savePaths`，刷新后重新启动核心，两边都完整恢复。
回归：`npm run test:eka2l1-patches`（拿仓库里出事那版 `vce3dcea2a438` 当修之前的样本）。真实固件下的完整开机与游戏运行仍未验证。

### 2.40.2 塞班 / N-Gage：游戏详情页内嵌播放器，点开始就玩（2026-11-19）

照 GGEMU 的做法：玩家不用自备固件、不用进 /symbian 程序库装机，详情页点「开始游戏」就开局。

- **形态**：平台 `symbian` 的运行时是 `eka2l1`（`src/emulator/adapters/eka2l1.ts`），收 `.zip`（N-Gage 卡带转储）、`.sis`
  （老塞班安装包）。`.sisx` / `.n-gage` 识别得出来，但开局前以 `config` 报 S60 第三版不支持。适配器建一个**同源 iframe**
  `${EKA2L1_RUNTIME_DIR}play.html`，由它加载 `eka2l1.js` + `js/boot.js` + 卡带导入脚本 + `js/8bitgo-player.js`
  （源码 `scripts/eka2l1-player.html` / `scripts/eka2l1-player.js`，登记在 `eka2l1-site-scripts.mjs`，`inject: false`，不进程序库页）。
- **每局在内存里装机**：播放页把 `createEKA2L1Module` 包一层，让 `FS.mount('/eka2l1')` 变成空操作，整台机器都在 MEMFS 里，
  不碰程序库页的 IndexedDB 设备。顺序不能乱：卡带文件必须在 `initDevice` **之前**写进 E:（EKA1 固件装好就激活，
  应用列表只在激活时扫描一次）；SIS 在装机之后 `installPackage`，再比较前后的应用列表找出新装的那个。
- **固件**：来自后台平台 BIOS 的 `symbian` 键（`options.biosUrl`），游戏来自 ROM 地址，下载、缓存、8BG 解包都走 `loadGameBytes`
  （固件上限 128MiB、游戏 256MiB，和 SWF 一样并行下载）。**线上还没配 `symbian` 的平台 BIOS**，没配时以 `config` 报 `eka2l1NoFirmware`，
  不下载游戏。站内文案写的是 N-Gage QD 固件；原版 N-Gage（NEM-4）的 SYM.ROM 实测同样能用。
- **跨源隔离**：pthread 构建要 SharedArrayBuffer。详情页内嵌隔离的平台名单在 `shared/inline-isolated-platforms.js`（psp、symbian），
  SSR 的隔离头和详情页「SPA 跳转进来先整页刷新一次」都读它，新增平台只改这一处。
- **存档**：开局后给 C: / E: 拍一份快照，之后游戏新建或改过的文件打成一个小包（magic `8BGSYM1\0`，上限 2MB / 4096 个文件；
  系统服务自己改写的位置排除，见 `EXCLUDED_PREFIXES`）。包存在 localStorage `8bitgo.eka2l1.save.v1:<slug>`，登录后经 `batterySync`
  同步云端（emulatorjs / slug / slot 9，与 GB / GBA 电池存档同一套）。每 30 秒、切后台、离页、销毁时保存；开局在启动游戏前写回。
  读档时拒绝越界路径、Z: / D: 路径和只差大小写的重名。
- **按键**：方向键 / Enter·空格（OK）/ Q·F1（左软键）/ E·F2（右软键）/ 0–9 / X·C（* #）/ Backspace（C 键），按下保持、松开才放，
  带修饰键的不接管。手柄：a = 5、b = 7、select = 左软键、start = OK（N-Gage 游戏多用 5 / 7 当动作键）。操作说明在 `src/lib/emulator.ts`，
  测试会核对它和播放页键位一致。
- **画面里那行 `Build / Commit / Channel`**：上游 `src/emu/web/src/protection.cpp` 画进窗口右下角的构建水印，注释写明 Release 构建
  不能关掉（用来追泄露的构建）。窗口每帧都被 `sync_canvas_to_screen` 强制成游戏画面的原始尺寸，所以水印必然压在游戏画面底部
  （176×208 的 N-Gage 画面会被盖住底部约 24 像素）。不重编核心就挪不开；要不要改是运营的决定，别擅自删。
- **2026-11-19 本地实测**（Vite 开发服务器、真实 `adapters/eka2l1.ts`、原版 N-Gage SYM.ROM、《模拟人生》卡带 ZIP）：页面已跨源隔离，
  挂载到出画面 0.7 秒（wasm 已在缓存）/ 7.6 秒（换了运行时地址、要重新下载）；EA / Maxis 片头正常，截图 PNG、音量、暂停、
  手柄按键、本地存档都可用。加了空存档的绕法后（见 §2.40），全新一局写出 6176 字节存档、标题显示「Press 5 to start」、能进主菜单，存档被打进存档包。片头要按一下键才往下走。SIS 那条路还没有用真实安装包测过。
- 回归：`npm run test:eka2l1-player`（包类型识别、存档包格式与安全校验、快照比较、键位、接线），另跑 `test:eka2l1-ngage-card`、
  `test:eka2l1-patches`、`eka2l1:check`。

## 3. 常用命令

```bash
npm run dev            # 全栈开发：同时启动 Vite 与 8788 后端（predev 自动准备资源）
npm run dev:web        # 仅启动 Vite；另有 BACKEND_URL / 后端进程时才用
npm run build          # prebuild 会跑 check-emulatorjs.mjs 体检，缺东西直接失败
npm run lint           # oxlint
npm run test:worker    # Worker 全套自测（分片 / Range / 缓存策略 / 代理，内存版 R2 mock，不联网）
npm run test:play      # Play! JS / WASM / 许可证完整性与接口特征
npm run rompack -- <ROM> [输出.8bg]  # 制作 Zstd 19 + AES-GCM 的 8BG 容器
npm run test:rompack   # 8BG 打包、解密、解压与摘要往返
npm run test:flash-online-save # AGI 桥完整性 + Flash 在线存档契约

npm run ejspatch       # 重打 blob 文件名补丁（升级引擎后必跑，幂等）
npm run ejscores       # 重新复制核心（仅升级核心时）
npm run romsets <dir>  # 重新生成街机 romset 索引，需 FBNeo 源码，见脚本头注释

cd server && npm run migrate   # 补数据库表 / 列，幂等
cd server && npm run test:psp-conversion # PSP ISO → CHD 参数、校验与接线回归
```

发信与验证码（都在 server 目录，都不联网）：

```bash
npm run test:mail -- you@example.com   # 真发一封，只测发信这一段（绕开限流和验证码表）
npm run test:mail:resend               # Resend 返回体分类 / 请求体字段 / 三种用途文案
npm run test:mail:parse                # Cloudflare 那条通路的同类测试
npm run test:codes                     # 验证码状态机（要连库；连不上自动跳过）
npm run test:translate                 # 火山翻译：V4 签名 / 语言映射 / 错误码（本地 mock，不联网）
npm run test:presence                  # 房主名片：设备 / 地区 / 网络（不联网、不用数据库）
```

`prebuild` 里的 `scripts/check-emulatorjs.mjs` 会检查五件事：引擎文件在不在、
是不是自建版（有无 `dontExtractIfCore`）、blob 补丁打没打、**存档 ABI 补丁打没打**、
核心在不在；`scripts/check-play.mjs` 同时检查 Play! 的三份文件及其哈希。任一缺失 → 构建失败。

---

## 4. 街机能不能跑的验收标准

打开任意街机游戏，控制台必须出现这三行（缺一不可）：

```
[EJS Core] Downloading core: fbneo-...-wasm.data          ← 从 /emulatorjs/cores/ 本地取，不是 cdn.emulatorjs.org
[EJS ROM]  Core fbneo requires special handling, will not attempt to extract if compressed.
[EJS BIOS] Core fbneo requires special handling, will not attempt to extract if compressed.
```

注意写的是**核心名 `fbneo`**，不是平台名 `arcade`。

---

## 5. 当前进度（2026-09-16，有时效性）

### 本轮改动：8BG ROM 压缩加密容器（**尚未部署，需要配置密钥**）

后台单文件 ROM 上传默认改成 Zstd 19 + AES-256-GCM 的 `.8bg`；旧 ROM 保持可玩，可逐款重传。
容器按 codec 分派，后续加入 LZMA2 不改数据库，Zstd 和 LZMA2 包可以长期共存。PS2、HTML5 和
多文件 Flash 包不走这条路径。部署前在 `server/.env` 配 `ROM_PACK_SECRET`，重新构建并重启 API；
Worker 的 MIME 更新也要部署。无需数据库迁移。

---

### 本轮改动：游戏简介 + 文章的按需翻译（**尚未部署，需要跑迁移**）

游戏详情页「游戏简介」和文章详情页正文右上角都加了「翻译」按钮：非中文界面的访客点一下，
后端依次调用 MyMemory、Lingva；两者失败后才用火山 `TranslateText` 兜底，结果写进新的 `*_i18n` JSON 列，
**同一篇内容同一语言永不再调接口**（§2.17 / §2.17.1）。文章因为**没有英文基准列**，连 `en`
界面也显示按钮（把中文翻成英文）；游戏有 `description_en`，`en` 界面不需要。

改动清单：

| 位置 | 内容 |
| --- | --- |
| `server/schema-v2.sql`、`8bitgo-v2-install.sql`、`scripts/migrate.mjs` | 新列 `games.description_i18n` + `posts.excerpt_i18n` + `posts.content_i18n`（都是 JSON NULL） |
| `server/src/translate.js` | MyMemory → Lingva → 火山兜底；火山 V4 签名 + `TranslateText` + 语言映射；新增 `translateMarkdown()` 按段落分块并发翻译 |
| `server/src/games-repo.js` | `writeDescriptionTranslation()`；`upsertGame` / `patchGame` 改基准时清缓存 |
| `server/src/routes/games.js` | `POST /api/games/:slug/translate-description`（不需登录） |
| `server/src/mappers.js` | `gameRowToApi` 读 `descriptionI18n`；`postRowToApi` 读 `excerptI18n` / `contentI18n`（都不开放写入） |
| `server/src/routes/posts.js` | 新增 `POST /api/posts/:slug/translate`；PUT handler 改基准时清 `excerpt_i18n` / `content_i18n` |
| `src/services/i18nData.ts` | `gameDescription()` 三层回退 + `needsTranslation()`；新增 `postExcerpt` / `postContent` / `needsPostTranslation()` |
| `src/components/game/TranslateButton.tsx` | **通用化**：接受 `endpoint` + 泛型 `onTranslated`，游戏和文章共用 |
| `src/pages/GameDetailPage.tsx` | 按钮挂 h2 右侧；翻译结果局部覆盖简介 |
| `src/pages/PostPage.tsx` | 按钮挂标题右侧；翻译结果覆盖正文 Markdown |
| 八个 `src/locales/*.ts` | `game.translate` / `translating` / `translateRetry` / `translateFailed` / `translatedJustNow` |

**部署这一版必须先跑迁移**，否则 `description_i18n` / `excerpt_i18n` / `content_i18n` 缺列 →
翻译接口 500（页面其余部分不受影响，简介 / 正文照常显示原文）。迁移幂等，可重复跑。

```bash
cd server && npm run migrate     # 幂等，给三张表加 i18n 列
```

**可选配置**：在 `server/.env` 填 `VOLC_AK` + `VOLC_SK`（火山控制台 → 访问控制 → API 访问密钥）。
不配也能正常跑，按钮会显示「翻译失败 [503] 翻译服务未配置」。

---

### 上一轮：登录 + 个人中心（**尚未部署，需要跑迁移**）

发信换成 **Resend**（`server/.env` 已填 `RESEND_API_KEY` + `MAIL_FROM=noreply@8bitgo.com`）。
验证码从进程内存搬到 `login_codes` 表并改存哈希（§2.13）；JWT 加了 `token_version`（§2.14）；
补上了 v2 漏掉的 `saves` 表（§2.15）。

新接口（全部要登录，见 `server/src/routes/me.js`）：

| 接口 | 干什么 |
| --- | --- |
| `GET /api/me/stats` | 个人中心顶部的统计卡片 |
| `POST /api/me/email/request-code` → `POST /api/me/email` | 换绑邮箱（码发到**新**邮箱） |
| `PUT /api/me/password` | 设置 / 修改密码（有密码的必须报旧密码） |
| `POST /api/me/logout-all` | 退出其它所有设备 |
| `POST /api/me/delete/request-code` → `DELETE /api/me` | 注销账号（邮箱验证码二次确认） |

前端：`/me` 改成三个分栏（我的游戏 / 云存档 / 账号与安全），新组件在
`src/components/profile/`；登录弹窗多了「密码登录」那一栏（之前能在个人中心设密码却没地方用）。
八种语言文案已同步（`Translation` 类型由 zh-Hans 推导，缺键会在 `tsc` 时报错）。

**部署这一版必须先跑迁移**，否则：`token_version` 缺列 → 改密码 / 退出所有设备 500；
`login_codes` 缺表 → 验证码退回内存（能用但重启丢码）；`saves` 缺表 → 云存档全 500。

```bash
cd server && npm run migrate     # 幂等
```

顺带修掉的一个真 bug：`ProfilePage` 原来把 `useGamesBySlugs` 写在 `if (!user) return` **后面**，
登录态一确定下来 hook 数量就变了，React 会抛「Rendered more hooks than during the previous render」。
现在所有 hook 都提到提前 return 之前，**别再挪回去**。

### Resend 上线前必须确认的一件事

`8bitgo.com` 要在 Resend 的 **Domains** 页面显示 **Verified**（DNS 加 SPF + DKIM）。
没验证完的话只能用 `onboarding@resend.dev`，而它**只能发给注册 Resend 的那个邮箱** ——
症状是「我自己能收到，别人都收不到」，很容易误判成代码问题。

验收：

```bash
cd server && npm run test:mail -- 你的邮箱@example.com   # 真发一封
npm run test:mail:resend                                # 不联网，锁住返回体分类
npm run test:codes                                      # 验证码状态机（要连库）
```

### 更早的改动（已上线）

| 提交 | 内容 |
|---|---|
| `378573c` | 引擎自托管，`EJS_PATH` 默认 `/emulatorjs/` 不再依赖环境变量；`.env.production` 进 git；`/api/platform-bios` 缓存降到 30s；`schema-check` 补齐 v2 全部表 |
| `78b6bfe` | 12 个核心（24 个 `.data` + 12 个 report）直接进 git，撤掉 npm 依赖 |
| `97db215` | 清除被污染的 `EmulatorJS-Cache`；语言包码改成自建构建的两字码（`zh`/`fr`…） |
| `aba17b6` | 播放器状态栏去掉「云端 ROM · 文件名」和常驻的运行时标签 |
| `4a2fb9f` | blob URL 文件名补丁 + `npm run ejspatch` + 体检把关 |
| `7aaaf67` | 街机 ROM 上传时自动识别 romset（`public/arcade-romsets.bin`，9377 个 romset / 13.8 万条 CRC，含跨行 ROM 宏展开） |

### 待办

1. **《白色房间》(`white-chamber`) 还是坏的**——线上 `roms` 仍是单文件
   `roms/flash/white-chamber.en.swf`，而它是多 SWF 游戏（运行时去拉 `main21.swf` → 404）。
   修法：后台用 **zip 整包**重传，见 §2.11。
2. **`POST /api/games/:slug/play` 线上 500**（游玩数永远是 0）。推测是缺 `game_plays` 表，
   但**未在库上确认**。确认办法：看服务端日志那条 500 的原文是不是
   `Table '...game_plays' doesn't exist`；是的话 `cd server && npm run migrate`。
3. 有一个错 key 待清理：`roms/nes/the-king-of-fighters-97-(ngh-2320).en.zip`
   （错平台目录 + 错 romset 名）。现在有自动识别了，重传一次即可；旧对象需手动从 R2 删。
   （孤儿 `roms/bios/arcade.zip` 已确认 404，不用管了。）
4. `npm run lint` 本轮没跑过（oxlint 是 macOS 二进制）。
5. 曾提过但没动的：MySQL 每日备份、云存档搬到 R2、Cloudflare D1 迁移
   （方案在 `server/schema-d1.sql` + `server/scripts/export-d1.mjs`，尚未执行 `wrangler d1 create`）。

### 版权红线

**不要帮忙寻找、下载或链接受版权保护的商业 ROM。** 站点自身的措辞是「请只运行你拥有合法
备份权利的游戏，或自制 / 开源 ROM」，代码和文档都应保持这个立场。
