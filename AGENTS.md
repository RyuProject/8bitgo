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

### 2.5 引擎会把**坏核心缓存进 IndexedDB**，清浏览器缓存没用

库名 `EmulatorJS-Cache`。缓存命中时日志是 `[EJS Core] Data is already decompressed cache item`
——它压根不再下载，硬刷新、清 HTTP 缓存全都无效。
`src/emulator/adapters/emulatorjs.ts` 里的 `purgePoisonedEngineCache()` 按「代次」清一次，
每个访客只清一回。**引擎构建再出现不兼容更换时，把 `EJS_CACHE_GENERATION` 加一。**

### 2.6 升级引擎后必须重跑 `npm run ejspatch`

引擎写虚拟文件系统时用 `url.split('/').pop()` 当文件名。「玩本地 ROM」页拖入的文件是
`blob:` URL，pop 出来是一串 UUID，FBNeo 拿到名为 UUID 的 romset → `Romset is unknown`。
补丁让 blob 的游戏 URL 改用 `EJS_gameName`，http(s) 不受影响。幂等，见
`scripts/patch-emulatorjs.mjs` 头注释。

### 2.7 街机靠**压缩包文件名**认游戏

叫 `kof97.zip` 才会跑 kof97 驱动，叫别的就 `Romset is unknown`，和内容对不对无关。
所以 `src/services/roms.ts` 里 `FILENAME_IS_IDENTITY` 把 arcade 列为「保留原文件名」。

现在后台上传街机 ROM 会**自动识别**（`src/lib/arcadeRomset.ts`）：读 zip 中央目录里每个成员的
CRC-32（不用解压），比对 `public/arcade-romsets.bin`（8721 个 romset / 12.7 万条 CRC）。
完全命中才自动改名；部分命中只列候选——拿父集的名字去套残缺包只会换来 missing files。

### 2.8 平台 BIOS 的边缘缓存会骗人

后台改完 BIOS 绑定只调 `invalidateContent()`（清进程内缓存），**够不着 Cloudflare 边缘**。
症状：后台明明配好了，前台还报缺 BIOS，刷新清缓存都没用。
已把 `/api/platform-bios` 的缓存降到 30 秒（`server/src/cache.js` 的 `CACHE.bios`）。
**部署后仍建议在 Cloudflare 控制台 Purge Everything 一次。**

### 2.9 数据库缺表不会让服务起不来，只会让**某一条接口**莫名 500

`server/src/schema-check.js` 启动时查全部 v2 表并点名。缺表补法一律：

```bash
cd server && npm run migrate      # 幂等
```

### 2.10 Flash 大游戏是多 SWF 的，不能只传主文件

当年的游戏在运行时用**相对路径**拉同目录的其它 swf（`loadMovie('main21.swf')`）。
只传一个 swf 的话，Ruffle 会去 `roms/flash/` 根目录找它 → 404。
后台选 `.zip` 走整包上传，文件落在 `roms/flash/<slug>[.<lang>]/` 下，相对路径才对得上。
**别图省事把缺的 swf 单独补到 `roms/flash/` 根目录**——那是所有 Flash 游戏共用的目录，迟早撞名。

---

## 3. 常用命令

```bash
npm run dev            # 开发（predev 自动准备 ruffle / js-dos / 字体）
npm run build          # prebuild 会跑 check-emulatorjs.mjs 体检，缺东西直接失败
npm run lint           # oxlint

npm run ejspatch       # 重打 blob 文件名补丁（升级引擎后必跑，幂等）
npm run ejscores       # 重新复制核心（仅升级核心时）
npm run romsets <dir>  # 重新生成街机 romset 索引，需 FBNeo 源码，见脚本头注释

cd server && npm run migrate   # 补数据库表 / 列，幂等
```

`prebuild` 里的 `scripts/check-emulatorjs.mjs` 会检查四件事：引擎文件在不在、
是不是自建版（有无 `dontExtractIfCore`）、blob 补丁打没打、核心在不在。任一缺失 → 构建失败。

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

## 5. 当前进度（2026-08-28，有时效性）

### 已完成并**已上线**

| 提交 | 内容 |
|---|---|
| `378573c` | 引擎自托管，`EJS_PATH` 默认 `/emulatorjs/` 不再依赖环境变量；`.env.production` 进 git；`/api/platform-bios` 缓存降到 30s；`schema-check` 补齐 v2 全部表 |
| `78b6bfe` | 12 个核心（24 个 `.data` + 12 个 report）直接进 git，撤掉 npm 依赖 |
| `97db215` | 清除被污染的 `EmulatorJS-Cache`；语言包码改成自建构建的两字码（`zh`/`fr`…） |
| `aba17b6` | 播放器状态栏去掉「云端 ROM · 文件名」和常驻的运行时标签 |
| `4a2fb9f` | blob URL 文件名补丁 + `npm run ejspatch` + 体检把关 |

线上已验证：`/emulatorjs/version.json` 200、`/emulatorjs/cores/fbneo-wasm.data` 可取、
`emulator.min.js` 含 blob 补丁、`/api/platform-bios` → `{"arcade":"roms/bios/neogeo.zip"}`。

### 已完成但**还没推送**

- **`7aaaf67` feat(admin): 街机 ROM 上传时自动识别 romset** ← 本地领先 origin/main 一个提交
  - 新增 `public/arcade-romsets.bin`（628KB）、`scripts/build-arcade-romsets.mjs`、`src/lib/arcadeRomset.ts`
  - `src/lib/unzip.ts` 的 `ZipFileEntry` 加了 `crc32` 字段
  - 用真实 kof97.zip 验证：13/13 命中 `kof97`，克隆集 `kof97h`/`kof97k` 12/13 被正确排除；
    11 项断言（含残缺包、无关包、单 CRC 蒙中三种反例）全部通过
  - **下一步：`git push`，然后服务器 pull + build + 重启**

### 待办

1. **《白色房间》(`white-chamber`) 还是坏的**——线上 `roms` 仍是单文件
   `roms/flash/white-chamber.en.swf`，而它是多 SWF 游戏（运行时去拉 `main21.swf` → 404）。
   修法：后台用 **zip 整包**重传，见 §2.10。
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
