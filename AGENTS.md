# 8BitGo — 给接手的 AI 助手 / 开发者

> Codex 会自动读取仓库根目录的 `AGENTS.md`，所以工程约定和「踩过的坑」都写在这儿。
> 最后更新：2026-08-28。**「当前进度」一节有时效性，其余部分是长期有效的约定。**

---

## 1. 项目速览

复古游戏模拟器站点，线上 <https://8bitgo.com>。

| | |
|---|---|
| 前端 | Vite + React 19 + TypeScript，带 SSR（`vite.config.server.ts` → `dist/server`） |
| 后端 | `server/`，Express + MySQL，和前端**同源**（一个进程同时提供 `/api` 和静态资源） |
| 存储 | Cloudflare R2 + Worker（`worker/`），公开读走 `assets.8bitgo.com` |
| 部署 | 服务器上 `git pull && npm install && npm run build && pm2 restart 8bitgo-api`，前面挂 Cloudflare |
| 模拟器 | EmulatorJS（主机/掌机/街机）、Ruffle（Flash）、js-dos、jsnes、webretro、FreeJ2ME |
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
`src/emulator/adapters/emulatorjs.ts` 的 `installRomDataInjector()` 在 loader.js 之前给
`window.EJS_emulator` 装 setter，包一层 `startGame()` 先把 dat 写进 FS；
骨架用 `npm run romdata -- <包.zip> --drv <基础驱动> --fbneo <FBNeo>/src/burn/drv` 生成。

⚠️ 第四列的类型**必须写**。FBNeo 独立版在类型留空时会用 `RDSetRomsType()` 按驱动名 + 长度猜，
但 libretro 版没有这个函数（对照 `libretro/FBNeo` 的 `src/burner/libretro/romdata.cpp`），
类型为 0 的行会被直接丢掉。生成脚本按 CRC 对照基础驱动源码把类型抄准，
对不上的（也就是改版包换掉的那几个）留成 `TODO_TYPE` 由人来定。

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

1. R2 要求**除最后一片外所有片等大**、最小 5MB、最多 10000 片 —— 改 `PART_SIZE` 会让旧的续传记录作废（身份校验带了 `partSize`，会自动作废，不会拼出坏文件）
2. binding **没有 `listParts`**：complete 时必须把每片的 `{partNumber, etag}` 全报回去，所以这份账只能记在前端 —— **换浏览器就续不上**
3. binding 也**没有 `listMultipartUploads`**：没合并的分片会一直计费且任何界面都看不见，所以 Worker 在 `_uploads/` 下写标记对象，后台「ROM 存储」页靠它列出并清理残留

改 `worker/src/index.js` 的分片部分后跑 `npm run test:multipart`（内存版 R2 mock，23 项断言）。

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

---

## 3. 常用命令

```bash
npm run dev            # 开发（predev 自动准备 ruffle / js-dos / 字体）
npm run build          # prebuild 会跑 check-emulatorjs.mjs 体检，缺东西直接失败
npm run lint           # oxlint
npm run test:multipart # Worker 分片上传接口的自测（内存版 R2 mock，不联网）

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
```

`prebuild` 里的 `scripts/check-emulatorjs.mjs` 会检查五件事：引擎文件在不在、
是不是自建版（有无 `dontExtractIfCore`）、blob 补丁打没打、**存档 ABI 补丁打没打**、
核心在不在。任一缺失 → 构建失败。

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

## 5. 当前进度（2026-09-02，有时效性）

### 本轮改动：登录 + 个人中心（**尚未部署，需要跑迁移**）

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
