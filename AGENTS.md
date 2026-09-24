# 8BitGo — 给接手的 AI 助手 / 开发者

> Codex 会自动读取仓库根目录的 `AGENTS.md`，所以工程约定和「踩过的坑」都写在这儿。
> 最后更新：2026-09-24。**「当前进度」一节有时效性，其余部分是长期有效的约定。**

---

## 1. 项目速览

复古游戏模拟器站点，线上 <https://8bitgo.com>。

| | |
|---|---|
| 前端 | Vite + React 19 + TypeScript，带 SSR（`vite.config.server.ts` → `dist/server`） |
| 后端 | `server/`，Express + MySQL，和前端**同源**（一个进程同时提供 `/api` 和静态资源） |
| 存储 | Cloudflare R2 + Worker（`worker/`），公开读走 `assets.8bitgo.com` |
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

### 2.7 升级引擎后必须重跑 `npm run ejspatch`

引擎写虚拟文件系统时用 `url.split('/').pop()` 当文件名。「玩本地 ROM」页拖入的文件是
`blob:` URL，pop 出来是一串 UUID，FBNeo 拿到名为 UUID 的 romset → `Romset is unknown`。
补丁让 blob 的游戏 URL 改用 `EJS_gameName`，http(s) 不受影响。

脚本里现在有**两组**补丁：blob 文件名（这一节）+ 存档 ABI 回退（§2.5）。两组各自幂等，
一条命令全打；位置对不上会当场退出并打印排查思路，见 `scripts/patch-emulatorjs.mjs` 头注释。

### 2.8 街机靠**压缩包文件名**认游戏

叫 `kof97.zip` 才会跑 kof97 驱动，叫别的就 `Romset is unknown`，和内容对不对无关。
所以 `src/services/roms.ts` 里 `FILENAME_IS_IDENTITY` 把 arcade 列为「保留原文件名」。

现在后台上传街机 ROM 会**自动识别**（`src/lib/arcadeRomset.ts`）：读 zip 中央目录里每个成员的
CRC-32（不用解压），比对 `public/arcade-romsets.bin`（8721 个 romset / 12.7 万条 CRC）。
完全命中才自动改名；部分命中只列候选——拿父集的名字去套残缺包只会换来 missing files。

**不在驱动表里的包（汉化版、修改版）走 RomData**，别去改名硬套。FBNeo 给这种包留了口子：
一份 `.dat` 写明 `ZipName`（包名）、`DrvName`（借哪个驱动跑）和**整份** ROM 清单，
核心会把该驱动的包名「寄生」成 ZipName，并整个改用 dat 里的清单 ——
汉化包里那几个和原版对不上的 GFX ROM 就是这样加载的。

触发方式挑的是最省事的一条：核心的 `retro_dat_romset_path()` 在内容名查不到驱动时，
**先找和内容同目录的 `<basename>.dat`**，找不到才去 `<system>/fbneo/romdata/`。
EmulatorJS 把 ROM 写在文件系统根目录（`callMain(["/" + fileName])`），
所以 `/wofcn.zip` 配 `/wofcn.dat` 就够了 —— 不必打开 `fbneo-allow-patched-romsets`，
也不必先加载原版 romset 再去核心选项里勾（那是 RetroArch 的交互，网页上没法要求玩家做）。

落地在三处：后台 `games.arcade_romdata` 列存 dat 文本；
`src/emulator/adapters/emulatorjs.ts` 的 `installFsInjector()` 在 loader.js 之前给
`window.EJS_emulator` 装 setter，包一层 `startGame()` 先把 dat 写进 FS；
骨架用 `npm run romdata -- <包.zip> --drv <基础驱动> --fbneo <FBNeo>/src/burn/drv` 生成。

⚠️ 第四列的类型**必须写**。FBNeo 独立版在类型留空时会用 `RDSetRomsType()` 按驱动名 + 长度猜，
但 libretro 版没有这个函数（对照 `libretro/FBNeo` 的 `src/burner/libretro/romdata.cpp`），
类型为 0 的行会被直接丢掉。生成脚本按 CRC 对照基础驱动源码把类型抄准，
对不上的（也就是改版包换掉的那几个）留成 `TODO_TYPE` 由人来定。

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
`emulatorjs.ts` 里的 `MAME_ROMSET_ALIASES`（mxsqy → mxsqy102tw）纠偏。
⚠️ mame-current 必须 **non-merged** 单包自洽；缺一个成员就是一行
`v-102tw.u39 NOT FOUND (tried in mxsqy102tw mxsqy)` 然后照样回菜单，别只盯着路径查。

⚠️ **上传的 zip 里成员必须在顶层，不能套一层目录。** 2026-09-20 那份明星三缺一 ROM 的
7 个成员里，`v-102tw.u39` 被放在 `mxsqy102tw/` 子目录下（其余 6 个在顶层）——MAME 只读
zip 顶层条目，于是照旧报 `v-102tw.u39 NOT FOUND` 回菜单。拍平（去掉顶层目录前缀）后
7 个成员全在顶层，本地与线上都直接进游戏。**踩坑点：8BG 只做外层包装（zstd + AES），
内层 zip 的文件名与嵌套结构原样保留**，所以后台看 `originalName` / 文件大小都对，
问题却在内层清单里——验收要列出 zip 成员看，别只看外层。

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

### 2.8.4 NDS：已硬切 melonDS DS 1.3.1，旧 melonDS 不再发布

本站 NDS 默认核心是自构建 `melondsds-wasm.data`（上游 melonDS DS v1.3.1），
`src/data/platforms.ts` 与后台下拉都直接写 `melondsds`。历史游戏数据若仍填 `nds` / `melonds`，
`emulatorJsCoreForGame()` 会在开局时硬归一到新核心；旧 `melonds-*.data` 已删除，不留双跑窗口。
用户确认没有 NDS 存档，所以没有做 `.sav` → `.srm` 或旧即时存档的迁移桥。

普通游戏详情页没有全站 COOP/COEP，因此发布的是**非 pthread 软件渲染版**：JIT、OpenGL、
threaded renderer 都在构建时关闭，避免 SharedArrayBuffer 初始化失败。间接 Wi-Fi 保留，
pcap 直连网络在浏览器构建里关闭。可复现构建入口：`npm run build:melondsds`。
DeSmuME / DeSmuME 2015 仍是逐游戏兜底，不会自动回落到旧 melonDS。

音频的第一处瓶颈不是插值：旧核心默认 `melonds_audio_interpolation=None`，再关也没有收益。
真正能直接修的是 EmulatorJS 写死的 `audio_latency = 64`：NDS 遇到超过 64ms 的
主线程长任务时 RWebAudio 队列见底，听起来就是“一卡一卡”。`src/emulator/ndsAudio.ts`
把 NDS 单独调到 96ms（MAME 仍是 128ms）；96 是稳定与《节奏天国》节拍延迟之间的折中。
验收看核心日志：48kHz 下 `[RWebAudio] Buffer size: 36864 bytes`。回归：
`npm run test:nds-audio`。若整台机器连 60fps 都跑不到，缓冲不能补算力，应逐游戏换轻核心。

melonDS DS 自带 `rotate-left` / `rotate-right` 布局，优先用“双屏布局”里的原生旋转；
它会连触控坐标一起转。《节奏天国黄金版 / Rhythm Heaven》这类游戏本来就要求把 DS 横拿。不要给 canvas 套
`transform: rotate(...)`：那只转视觉，触控坐标、截图和直播都会错 90°。核心在原生旋转布局里
自己调 libretro `set_screen_rotation` 并同步触控矩阵；玩家选择按游戏持久化，切换后重新实测画布几何。

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

### 2.11 Flash 大游戏是多 SWF 的，不能只传主文件

当年的游戏在运行时用**相对路径**拉同目录的其它 swf（`loadMovie('main21.swf')`）。
只传一个 swf 的话，Ruffle 会去 `roms/flash/` 根目录找它 → 404。
后台选 `.zip` 走整包上传，文件落在 `roms/flash/<slug>[.<lang>]/` 下，相对路径才对得上。
**别图省事把缺的 swf 单独补到 `roms/flash/` 根目录**——那是所有 Flash 游戏共用的目录，迟早撞名。

### 2.12 「连不上 Worker」很可能是**文件太大**，而且 Worker 日志里查不到

后台传 100MB 的游戏时报「网络错误：无法连接 Worker（检查地址与 CORS）」——
Worker 是好的，地址和 CORS 也是对的。真凶是 **Cloudflare 的请求体上限**：
Free / Pro 100 MB，Business 200 MB，Enterprise 500 MB，**由边缘节点执行，在 Worker 代码之前**。
超限时边缘直接 reset 连接，浏览器拿不到 413，XHR 只触发 `onerror`，
所以 `worker/src/index.js` 里那句 `Content-Length > MAX_UPLOAD_MB → 413` 一次都没运行过
（`MAX_UPLOAD_MB` 默认写着 512，是个管不到平台上限的空承诺）。

**诊断指纹**：失败时开 `npx wrangler tail`，被边缘拦掉的请求**一条日志都不会有**。
日志里能看到这次 PUT，才说明问题在 Worker 侧。

现在超过 24MB（`MULTIPART_THRESHOLD`）的文件自动改走**分片上传**：
8MB 一片、3 并发、单片失败重试、`localStorage` 记账后可断点续传（`src/services/romMultipart.ts`）。
上限是按**单个请求**算的，所以分片顺带把 100MB 这道墙也绕开了。三个必须记住的约束：

1. R2 要求**除最后一片外所有片等大**、最小 5MB、最多 10000 片 —— 改 `PART_SIZE` 会让旧的续传记录作废；续传还校验文件名、字节数、修改时间和头/中/尾内容指纹，防止把同名的另一份文件拼进旧分片
2. binding **没有 `listParts`**：complete 时必须把每片的 `{partNumber, etag}` 全报回去，所以这份账只能记在前端 —— **换浏览器就续不上**
3. binding 也**没有 `listMultipartUploads`**：没合并的分片在 R2 默认 7 天自动中止之前仍占用存储；自定义生命周期可能改变期限。Worker 在 `_uploads/` 下写标记对象，后台「ROM 存储」页靠它列出并清理残留；R2 自动中止后标记对象仍需手动清理

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
调火山引擎 `TranslateText` 翻一次 → 写进 `description_i18n[lang]` → **之后所有人都是读库，
不再调接口**。

⚠️ **为什么是 JSON 列而不是 `description_es` / `description_fr` 各一列**：八列里有六列
99% 的游戏永远是 NULL，而 schema 注释里早就定过「一个基准 + 一个译文」这条线（就是为了避免
每加一种语言就 ALTER 一次表）。JSON 列加语言不用改库，键名直接就是站点语言代码。

⚠️ **改基准必须清缓存**。`description` / `description_en` 一改，所有语言的译文都失去锚点 ——
否则玩家看到的是「后台改过简介、但翻译缓存里还是旧的」。`upsertGame` 无条件清、`patchGame`
在请求里带了这两个字段时清（见 `server/src/games-repo.js`）。**新增写路径时别忘了这一条。**

⚠️ **火山 API 的语言码是 ISO 639-1 短码，不是 BCP-47**。它**没有** `zh-Hans` / `zh-Hant`，
只有 `zh`。映射表在 `server/src/translate.js` 的 `LANG_MAP` 里，加语种改那一处。
`zh-Hant` 是唯一不完美的一个：后台填了英文版就把英翻成 `zh` 存进 `i18n['zh-Hant']`
（简繁偶尔差几个字），没填英文版就不翻译、退回中文原文 —— 繁体用户看简体中文没问题，
但别指望它是真·繁体。

⚠️ **AK/SK 放 `server/.env`，永远不进 git**（§2.1）。不配也能跑：按钮会变成「翻译失败
[503] 翻译服务未配置（缺 VOLC_AK / VOLC_SK）」，所有游戏照旧走原文回退。
机器翻译**按量计费、会欠费**，上线前去火山控制台开「用量预警」。

自测：`cd server && npm run test:translate`（13 项，起本地 mock，不真打火山）。
端到端：
```bash
curl -X POST http://127.0.0.1:8788/api/games/<slug>/translate-description \
     -H 'Content-Type: application/json' -d '{"lang":"es"}'
# 第一次 cached:false（真调火山并落库），第二次 cached:true（读库，不再调）
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

官方构建固定启用 pthread / SharedArrayBuffer，所以游戏详情页不直接挂模拟器，而是整页跳到
`/play/ps2/:slug`。Express 与 Vite 开发服务器只给这条顶层文档发 COOP / COEP；改成 SPA
内部跳转或 iframe 后，响应头不会生效，运行时会在 worker 初始化阶段崩掉。

PS2 光盘通常数 GB，播放器通过 `src/emulator/remoteDisc.ts` 按 2MB 块发送 Range 请求，不能
整份下载。后台直接上传 `.iso` / `.chd` / `.cso`，不要再包一层 ZIP；外链至少要正确响应
`Range: bytes=0-0`，返回 206、`Content-Range` 和真实总大小。当前 R2 Worker 已支持这些头。

Play! 浏览器版仍是实验性支持：90 秒内没有产生首帧就提示该镜像可能不兼容。不要为了让某个
商业游戏通过而查找或分发 ROM；只测试站长有权使用的备份、自制程序或开源镜像。

### 2.20 新 ROM 用 8BG 容器，不要把 Zstd 写死进数据库

除 PS2、HTML5 目录和多文件 Flash 包外，后台新上传的单文件 ROM 会先按 8MB 原文分块，
每块 **Zstd 19 + AES-256-GCM**，再上传成 `<原 key>.8bg`。文件头保存原文件名、codec、
codecVersion、keyId 和每块 SHA-256；播放器解包后仍把 `.zip` / `.nes` / `.nds` 等原名交给核心。
Zstd 解码前还必须核对 frame 自报的 content size 与分块表完全一致；只在解压后比大小挡不住
恶意 frame 先诱导 WASM 申请几十 GB 内存。校验在 `assertZstdFrameContentSize()`，不要绕过。

这里故意用自己的版本化容器，而不是直接上传 `.zst` 或 `.7z`：以后切 LZMA2 时只需在
`scripts/pack-rom.mjs`、`scripts/unpack-rom.mjs`、`src/workers/romPackWorker.ts` 和 `src/services/romPack.ts` 的 codec
分发表增加实现。文件头会写 `codec: lzma2`，现有 `codec: zstd` 的包继续读取；数据库只存对象
key，所以**不用改表，也不用同一晚重压整个库**。不要把默认 codec 变成“旧包也按新算法解”。

密钥根放 `server/.env` 的 `ROM_PACK_SECRET`（至少 32 字节）。轮换时保留旧密钥：
`ROM_PACK_KEY_ID=v2` + `ROM_PACK_SECRET_V1` + `ROM_PACK_SECRET_V2`。匿名试玩意味着浏览器最终会拿到
单包数据密钥，这层加密用于阻止 R2 对象被直接离线批量读取，不应宣传成不可破解 DRM。

旧 ROM URL 完全兼容；数据库仍绑定 `a.zip` 时也会先探同目录 `a.zip.8bg`、再回退 `a.zip`，
所以批量转换只需把新对象放在旧对象旁边，不必同时批量改库。没有数据库绑定的游戏会先探
`<slug>.<ext>.8bg`，再探历史文件。
后台第一次把旧对象重传成 8BG 时会保留旧对象并填入同语言备用槽，确认线上能玩后再清理。
cloud-game 的 libretro 不认识 8BG；`deploy/cloudgame/sync-roms.sh` 会先在隔离暂存目录解密，
全部成功后才替换 `games/`。云联机机的 `.env` 必须保留同一套 `ROM_PACK_SECRET[_Vn]`，
否则同步应失败并继续使用上一份游戏库，不能把密文直接交给核心。
本地打包与往返测试：

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

### 2.24 Ruffle 运行时必须带版本目录，Flash / 街机按键由后台配置

Ruffle 从 npm 复制到 `public/ruffle/v<version>/`，`runtime.json` 保存每个文件的长度和 SHA-256。
版本路径可以安全缓存一年；升级 `@ruffle-rs/ruffle` 时必须同时改
`src/emulator/paths.ts` 里的 `RUFFLE_VERSION`，否则 `npm run build` 会直接失败。不要把新文件覆盖到
旧版本目录，否则边缘缓存会把新旧 WASM / JS 混在一起。

Ruffle 固定走「流畅优先」：配置 `quality: low`，并只在它自己的 iframe realm 内把
`devicePixelRatio` 钳到 1（DPR 2 的画布像素量会降到四分之一）。前台不再给档位下拉；别重新加回
`performanceProfile`。也不要用 `frameRate` 冒充性能优化（会直接改游戏时间轴），不要钉
`preferredRenderer`（官方只把它当排错项，浏览器 / Ruffle 升级后最优后端会变）。

冷启动的三条重资源必须并行：游戏 SWF、短期在线存档会话、Ruffle loader/WASM；不得把
`loadGameBytes()` 放回 `script.onload` 后面才开始。鼠标悬停会依据 Ruffle 自己的五项 WASM 能力探针，
只预热正确的一套 core JS + 约 14 MB WASM；`scripts/copy-ruffle.mjs` 从官方 loader 解析对应关系写进
新 URL `bootstrap.json`，解析失败必须中止升级，不能同时预拉两份核心。省流量模式 / 2G 不预拉。
不要把这份数据塞进同版本的 `runtime.json`：它已经被长期缓存过，原地加字段会让旧访客永远读不到。

SmartFoxServer 配置只有 `shared/sfs-games.js` 里的游戏能请求（当前 `sas3`）；其它 Flash 一律直接空配置，
否则旁路故障会把每一款游戏启动拖住 1.5 秒。`api.load()` 返回也不代表舞台已经创建，必须等
`loadedmetadata/loadeddata` 再撤加载层；不等会偶发黑框并永久漏掉本局截图 / 录制 / 直播能力。
详细取证和升级约束见 `docs/ruffle-performance.md`。

EmulatorJS 的悬停预热不能直接拿平台配置里的 `core` 拼文件名：`gb`、`gba`、`psx` 等是
`EJS_core` 接受的**平台别名**，公开目录里实际是 `gambatte-wasm.data`、`mgba-wasm.data`、
`pcsx_rearmed-wasm.data`。统一走 `paths.ts` 的 `emulatorJsCoreFileFor()`；`test:ejs-cores`
会把它和自托管 `emulator.min.js` 里的真实别名表逐项核对，避免悬停必打一条 404。

Flash 手柄键位存在 `games.flash_controls` JSON，街机屏幕手柄的动作键数存在
`games.arcade_buttons`（2 / 4 / 6）。这两列都是可空的：旧 Flash 游戏仍可用鼠标，旧街机默认六键，
所以可以先迁移再慢慢在后台补配置。部署这版必须先跑 `cd server && npm run migrate`；
自测用 `npm run test:ruffle-runtime && npm run test:game-controls && npm run test:keymap`。

### 2.24.1 js-dos 的 JS / DOSBox / DOSBox-X 必须整套更新，stop 必须真清理

js-dos 运行时从 npm 复制到 `public/jsdos/v<version>/`，版本同时写在
`src/emulator/paths.ts` 的 `JSDOS_VERSION`。这不是目录整理：`js-dos.js`、`wdosbox.wasm`、
`wdosbox-x.wasm` 和 JSPI 版是配套产物，固定 URL 覆盖升级会被浏览器 / Cloudflare 拼成新旧混合，
症状通常只有黑屏。升级 `js-dos` 时必须同步改版本常量并跑 `npm run jsdos`；
`scripts/check-jsdos.mjs` 会在构建前、复制到 `dist/client` 后各验一次清单、长度和 SHA-256。

`scripts/copy-jsdos.mjs` 还打三项补丁，任何一项对不上都必须让构建失败：

1. IIFE 隔离上游数百个顶层变量，尤其不能再让它的 `io` 覆盖 socket.io；
2. IPX 地址去掉写死的 1900 端口，联机中继才能走 Cloudflare 后面的主站 443；
3. 上游每次 `Dos()` 注册的 `fullscreenchange` / `pointerlockchange` / `visibilitychange` 要在
   `stop()` 移除，并释放 `navigator.keyboard` 锁。原版只停核心、不拆这三条监听；多开几局后一次
   切后台会唤醒所有历史 Redux store，完整模拟器对象也无法回收。

普通 DOS 的 EXE / COM / BAT 若不是 8.3 文件名，不能直接在 autoexec 里加引号：DOSBox 那条命令
不会可靠剥掉，引擎照样报 ready，实际只停在 `C:\>`。`makeJsdosBundle()` 会保留原文件，再在同目录
补一个真实的 `8BITGO.EXE`（撞名时递增）供启动。ZIP 的绝对路径、盘符和 `../` 也在重打包前拒绝，
否则能覆盖虚拟盘里的 `.jsdos/dosbox.conf`。

Windows 系统镜像、游戏包和资料片从同一刻下载；ROM 进度在系统镜像完成前暂存，避免进度条先冲到
80% 再长时间不动。资料片最多三路并发，并走共用的失速中止。回归：
`npm run test:jsdos-runtime && npm run test:dos-bundle && npm run test:dos-extras && npm run test:system-source`。

共享 Windows 系统模式必须有 `.jsdos` 系统镜像、游戏 ZIP，以及默认 EXE 或每个已绑定语言各自的
EXE。不能只在后台表单拦：批量导入和直接 API 会绕过页面。`server/src/dos-game-config.js` 在
PUT / PATCH 前按关联表的真实重写语义校验；启动时 `schema-check.js` 还会点名历史坏记录。

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
`https://html5.8bitgo.com/PvZ/properties/`，所以清单只能写 `main.pak` / `en-main.pak` /
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

验收：

```bash
curl -sI https://8bitgo.com/web/PvZ | head -3
curl -sI https://8bitgo.com/web/PvZ/pvz-portable.wasm | grep -i content-type
npm run pvz:check && npm run test:pvz && npm run pvz:check-assets
```

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
生产默认根是 `https://assets.8bitgo.com/web/cs16/zstd-v1/`，localhost 默认本地；`?packsroot=`
可指临时域名，`?packformat=gzip` 只用于旧包应急。R2 CORS、Cache Everything 和验收步骤见
`public/web/cs16/PACKS.md`。

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

### 2.29 后台能热改的站点级配置：`site_settings` 表（首页公告条是第一个）

为什么不是 `.env`：`config-manifest.js` 那页（后台「配置」）**只读是刻意的**，
它回的是基础设施信息和密钥指纹，不该跟着一张会被运营改的表一起演化。
那张文件的注释里给的出路就是这张表 —— **env 提供默认、库只做覆盖**。
第一个住户是首页公告条（`name = 'notice'`，值是 JSON 文本）。

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

生产机是 **38.76.186.225**（Ubuntu 24.04，4C/4G）。旧机 103.242.13.112 已停服且
`8bitgo.service` 已 disable，**只作回滚后路 —— 它的数据库已冻结，别再在上面改任何内容**，
否则两边分叉。确认稳定后可退租。

- **进程守护是 systemd `8bitgo.service`，不是 pm2**（§1 那行 pm2 是历史遗留，已改）。
  由 `deploy/systemd/install-service.sh` 安装，`WorkingDirectory` 必须是 `server/` ——
  `dotenv/config` 从 `process.cwd()` 找 `.env`，指错就静默全废（见 `deploy/systemd/README.md`）。
- **nginx 站点在 `/etc/nginx/sites-available/8bitgo.com`**，生产版有三个专用 location
  （`^~ /socket.io/`、`^~ /ipx/`、`= /api/netplay/events`）和 `client_max_body_size 32m`
  （云存档 4MB / J2ME 20MB，**丢了上传必挂**）。XFF 用 `$http_cf_connecting_ip`（§2.16）。
  连接槽已由 `deploy/nginx/tune-nginx.sh` 调到 8192 × 4 worker = 32768。
- **防火墙 ufw 已启用：22 对外，80/443 只对 Cloudflare IP 段** —— 这不是可选项，
  是采用 `$http_cf_connecting_ip` 换来的代价（否则该头可被直连源站伪造，见 §2.16）。
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

---

## 3. 常用命令

```bash
npm run dev            # 开发（predev 自动准备 ruffle / js-dos / 字体）
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
后端调火山引擎 `TranslateText` 翻成他的本地语言，结果写进新的 `*_i18n` JSON 列，
**同一篇内容同一语言永不再调接口**（§2.17 / §2.17.1）。文章因为**没有英文基准列**，连 `en`
界面也显示按钮（把中文翻成英文）；游戏有 `description_en`，`en` 界面不需要。

改动清单：

| 位置 | 内容 |
| --- | --- |
| `server/schema-v2.sql`、`8bitgo-v2-install.sql`、`scripts/migrate.mjs` | 新列 `games.description_i18n` + `posts.excerpt_i18n` + `posts.content_i18n`（都是 JSON NULL） |
| `server/src/translate.js` | 火山 V4 签名 + `TranslateText` + 语言映射；新增 `translateMarkdown()` 按段落分块并发翻译 |
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
| `7aaaf67` | 街机 ROM 上传时自动识别 romset（`public/arcade-romsets.bin`，8721 个 romset / 12.7 万条 CRC） |

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
