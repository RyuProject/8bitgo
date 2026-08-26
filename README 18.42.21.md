# 8BitGo — 在线复古模拟器游戏站

基于 **Vite + React 19 + TypeScript + Tailwind CSS v4 + React Router 7** 搭建的复古游戏网站，
内置 **EmulatorJS** 集成，可以在浏览器中直接运行本地 ROM。

## 快速开始

```bash
npm install        # 安装依赖
npm run dev        # 启动开发服务器 http://localhost:5173
npm run build      # 类型检查 + 生产构建，输出到 dist/
npm run preview    # 本地预览构建结果
```

## 字体

- **英文 / 数字：Geist Pixel**，通过 Google Fonts 引入（`index.html`），SIL OFL 许可。
- **中文：方舟像素字体（Ark Pixel Font）12px 比例宽度 简体中文版**，SIL OFL 1.1 许可，
  字体文件与许可证已放在 `public/fonts/ark-pixel/`（随项目一起提交即可）。
  想更新到最新版本时执行 `npm run fonts`，它会从
  [GitHub Releases](https://github.com/TakWolf/ark-pixel-font/releases) 下载；`npm run dev` / `npm run build`
  前也会自动检查，文件缺失时才会下载。
- 访问 GitHub 不顺畅时：手动下载 `ark-pixel-font-12px-proportional-otf.woff2-v*.zip`，然后
  `ARK_PIXEL_ZIP=/path/to/that.zip npm run fonts`；下载失败不会阻塞启动，只是先回退到系统字体。
- 两套字体都在 `src/index.css` 的 `--font-sans` / `--font-pixel` 里配置：Geist Pixel 只含拉丁字符，
  中文和中文标点会自动回退到 Ark Pixel。像素字体在 12px 的整数倍（12 / 24 / 36px）下最清晰。

## 视觉风格

配色参考 Duolingo：亮白底 + 亮绿主色，圆角、活泼、柔和。令牌都在 `src/index.css` 的 `@theme` 里：

- 底色 `#ffffff`，浅灰面板 `#f7f7f7`，边框 `#e5e5e5`；主色亮绿 `#58cc02`（hover / 底部阴影 `#46a302`）。
- 文字深灰 `#3c3c3c`，次要 `#777`。点缀：黄 `#ffc800`、红 `#ff4b4b`。
- 按钮是 Duolingo 那种圆角 + 底部实心「3D」阴影，按下时整体下沉、阴影收起（`components/ui/Button.tsx`）。
- 游戏封面卡保留彩色底（像 App 图标），播放器画面保持黑色。
- 换主题只改这些颜色令牌即可，组件里尽量用 `bg-surface`/`text-fg`/`border-line` 这些语义类。

## 开放的平台

`src/config/platforms.ts` 控制前台展示哪些平台。不在名单里的平台及其游戏，前台一律不显示（后台仍可管理全部）：

```ts
export const ENABLED_PLATFORMS = ['nes', 'flash', 'gba', 'gb', 'java']
// GBC 并入 gb（Game Boy / Color），WebGame/网页游戏 即 flash。清空 [] 恢复全部平台。
```

## 功能开关

`src/config/features.ts` 统一控制尚未开放的功能，相关 UI 会整块隐藏（代码仍保留）：

```ts
export const FEATURES = {
  live: false,   // 直播：首页直播区块、侧边栏「直播」、页脚 8BitGo TV
  coins: false,  // G 币：顶栏余额、卡片角标、每日任务、详情页奖励卡、「赢取 G 币」筛选、个人页余额
}
```

想上线时把对应的值改成 `true` 即可。（后台 `/admin` 仍可查看 / 修改 G 币字段。）

## 接入数据库（可选后端）

默认前端把数据存在浏览器 localStorage（换设备 / 清缓存会丢）。想让游戏、文章、用户存进 **MySQL**、跨设备共享、后台改动对所有人生效，就部署 `server/` 里的 Node 后端：

1. `cd server && npm install && cp .env.example .env`，填数据库密码等（详见 `server/README.md`）。
2. `npm run migrate`（建表）、`npm run seed`（导入内置数据）、`npm start`（启动，建议 pm2 常驻）。
3. 前端根目录 `.env` 里设 `VITE_API_URL=你的站点地址`（不带 `/api`），`npm run build` 重新构建。

设了 `VITE_API_URL` 后：开机从数据库拉游戏 / 文章，注册登录 / 收藏 / 最近游玩 / 后台改动全部走数据库；
留空则仍用本地存储（行为不变）。后台「数据」页有连接自检、管理员口令、一键导入内置数据。
完整部署与接口说明见 **`server/README.md`**。


## 多语言与各语言 ROM

- **语言切换器**：侧边栏顶部的地球按钮，支持 8 种语言（简体 / 繁体中文、English、Español、Français、Italiano、Deutsch、日本語）。当前语言存在 `localStorage(8bitgo.lang)`，并同步到 `<html lang>`。配置在 `src/config/languages.ts`。
  - 目前**界面文字暂未翻译**（保留中文），语言主要驱动「按语言选 ROM」；界面翻译后续分批接入。
- **各语言 ROM**：游戏可为 简体中文 / 繁体中文 / English / 日本語 分别上传 ROM（English 即通用/回退 ROM，不再单独设通用项）（后台游戏编辑里的「ROM 文件（按语言）」）。
  玩家游玩时按当前语言自动加载：`游戏.roms[当前语言] → English ROM（英语即通用/回退）`。
  没有专属 ROM 的语言（西/法/意/德等）统一回退到英语 ROM。数据存在 `Game.roms`（DB 里是 `games.roms` JSON 列）。


## 布局：仪表盘式应用壳

- **左侧固定侧边栏**（`src/components/layout/Sidebar.tsx`）：顶部是「随机玩一个游戏」按钮（`getRandomGame()`，只抽可在线运行的平台）
  和「玩家社区」卡片（一行社交图标，地址在 `nav.ts` 的 `communityLinks` 里改），下面是导航 / 游戏库两组，底部是用户区。桌面端可折叠为 72px 图标栏（状态记在 localStorage），
  折叠后悬停显示提示；移动端变为抽屉。
- **顶栏**（`Topbar.tsx`）：搜索、玩本地 ROM、G 币余额、通知、登录；页脚链接里也有「玩本地 ROM」入口；移动端有菜单按钮和可展开的搜索行。
- **沉浸模式**：游戏详情页点「沉浸模式」会隐藏侧边栏和顶栏，只保留游戏画面，`Esc` 或右上角按钮退出；
  切换路由自动退出。状态由 `ShellContext.tsx` 统一管理（`useShell()`）。
- **首页**：顶部是标题、一句话说明和类型快捷入口（`HomeIntro`），类型下面保留一个 banner 位（`HomeBanner`：主横幅 + 「每日任务」小组件），再往下是直播、热门、平台、最新等区块。

## ROM 存储（Cloudflare R2）

两个地址，各司其职：

| 配置 | 用途 | 示例 |
| --- | --- | --- |
| `VITE_ROM_BASE_URL` 公开根地址 | 玩家读取 ROM。R2 自定义域名或 r2.dev 域名，需在桶上配置 CORS（允许 GET、HEAD） | `https://assets.8bitgo.com` |
| `VITE_ROM_API_URL` Worker 地址 | 后台上传 / 删除 / 列表。部署 `worker/` 得到 | `https://8bitgo-roms.xxx.workers.dev` |
| `VITE_ROM_PREFIX` key 前缀 | 桶里的目录，对应 `roms/gba`、`roms/nes` … | `roms` |

三项都可以在后台「ROM 存储」页里运行时修改（存 localStorage），Worker 口令存 sessionStorage。
R2 的 S3 API 地址（`*.r2.cloudflarestorage.com`）需要签名请求，浏览器不能直接访问，不要填在这里。

**部署 Worker**（上传功能必需）：

```bash
cd worker
npx wrangler login
npx wrangler secret put ADMIN_TOKEN   # 后台填同一个口令
npx wrangler deploy                   # 桶名在 wrangler.toml，默认 8bitgo
```

**桶的 CORS 策略**（控制台 → R2 → 桶 → 设置 → CORS，域名换成你的站点）：

```json
[{ "AllowedOrigins": ["http://localhost:5173", "https://8bitgo.com"], "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["*"], "ExposeHeaders": ["Content-Length", "Content-Range", "ETag"], "MaxAgeSeconds": 86400 }]
```

**怎么把 ROM 和游戏对上**：

- **后台上传**：「游戏」页 → 编辑 → ROM 文件 → 「☁️ 上传到 R2」。文件会通过 Worker 存到
  `<前缀>/<platform>/<slug>.<后缀>`（如 `roms/nes/contra.zip`）并自动填入 key，保存后详情页即显示「开始游戏」。
- **已有文件**：「ROM 存储」页 → 列出文件 → 自动匹配（按文件名对 slug）或手动绑定；也可以直接手填 key。
- **约定路径**：文件本来就叫 `<前缀>/<platform>/<slug>.zip` 的话，前台会自动探测，无需绑定。

绑定过的游戏在卡片上显示「☁️ 即点即玩」；玩家仍然可以在播放器里改选本地文件。

## 用户系统

- `/login` 注册 / 登录（注册送 100 G 币），`/me` 个人中心：编辑昵称与头像、我的收藏、最近浏览、G 币余额。
- 登录后顶栏显示头像与昵称（下拉菜单：个人中心 / 收藏 / 退出），侧边栏底部与 G 币胶囊同步显示。
- 游戏详情页的「收藏」按钮生效，访问详情页会记录到「最近浏览」。
- **纯前端实现**：用户列表保存在 localStorage（`8bitgo.users`），密码只保存「随机盐 + SHA-256」哈希；
  登录态在 `8bitgo.session`。只在同一浏览器内有效，上线时把 `src/services/auth.ts` 里的
  `register / login / logout` 换成后端接口即可，组件不需要改。

## 博客

- `/blog` 文章列表（按标签筛选）、`/blog/:slug` 文章页。内置 6 篇原创文章（`src/data/posts.ts`）。
- 正文支持简化 Markdown：`## 标题`、`- 列表`、`> 引用`、`**加粗**`、`` `代码` ``、`[链接](url)`，
  渲染器在 `src/lib/markdown.tsx`，不使用 innerHTML。
- 在后台「文章」里写作，可保存草稿或直接发布，带预览。

## 后台管理 `/admin`

自用的简易后台，无需额外服务：

- **概览**：游戏 / 用户 / 文章等统计，Top 10、平台与类型分布、最近上线。
- **游戏**：搜索、按平台 / 状态筛选；新增、编辑、上架 / 下架、删除。修改立即反映到前台。
- **文章**：写文章（Markdown、预览）、发布 / 转草稿、删除。
- **用户**：查看本浏览器注册的账号，调整 G 币、封禁 / 解封、删除。
- **数据**：游戏 JSON 导出 / 导入 / 重置，文章与用户数据的导出 / 重置。

游戏与文章数据保存在浏览器 localStorage（`8bitgo.admin.games` / `8bitgo.admin.posts`）；想固化到代码里，
导出 JSON 后替换 `src/data/*.ts` 即可。默认无需登录；在 `.env` 里设置 `VITE_ADMIN_KEY=你的口令` 后，
进入后台需输入一次口令（存于 sessionStorage）。正式上线前建议再加真正的服务端鉴权。

## 页面一览

| 路由 | 说明 |
| --- | --- |
| `/` | 首页：标题与类型入口、banner 位（横幅 + 每日任务）、直播、最多人玩、按平台、最新上线、一起玩、赢取 G 币、评分最高、按类型探索（大分类卡片 + 分栏样例）、精选轮播、FAQ |
| `/games` | 游戏库：平台 / 类型 / 特性筛选、搜索、排序、分页（所有条件都保存在 URL 参数中） |
| `/games/:slug` | 游戏详情：模拟器播放器、简介、操作说明、相关推荐 |
| `/play-local` | 玩本地 ROM：选择平台 → 拖入文件 → 直接运行 |
| `/platforms` `/genres` `/developers` | 按平台 / 类型 / 开发商浏览 |
| `/blog` `/blog/:slug` | 博客列表与文章页 |
| `/login` `/me` | 登录 / 注册、个人中心 |
| `/apps` `/about` `/terms` … | 占位页（Coming Soon），后续可替换为真实功能 |
| `/admin` … | 后台：概览 / 游戏 / 文章 / 用户 / ROM 存储 / 数据 |

## 目录结构

```
src/
├── data/            模拟数据：platforms / genres / games / posts / streams / faq
├── services/        games.ts（查询）、store.ts（游戏持久化）、posts.ts（文章）、auth.ts（用户与登录）、roms.ts（ROM 存储）、localStore.ts（通用存储）
├── admin/           后台页面：AdminLayout / AdminOverview / AdminGames / GameForm / AdminPosts / AdminUsers / AdminRoms / AdminData
server/              Node 后端：连接 MySQL 的 REST API（游戏 / 博客 / 用户），见 server/README.md
worker/              Cloudflare Worker：R2 ROM 代理（CORS / Range / 列表接口），见 worker/README.md
├── lib/             工具：emulator.ts（EmulatorJS 集成）、format.ts、gradients.ts
├── components/
│   ├── layout/      Sidebar / Topbar / Layout / ShellContext / Footer / Logo / nav（导航配置）
│   ├── ui/          Button / Badge / Rating / HScroll / Accordion / Pagination / SectionHeader
│   ├── game/        GameCard / GameCardWide / GameCover / PlatformCard / StreamCard
│   ├── home/        首页各区块（HomeIntro / HomeBanner / sections / FeaturedCarousel）
│   └── player/      EmulatorPlayer（通用播放器：ROM 选择、拖拽、类型识别、全屏、状态栏）
├── runtimes/        运行时注册表：registry / emulatorjs / ruffle / detect（ROM 类型嗅探）
├── pages/           路由页面
├── types.ts         类型定义
└── index.css        Tailwind 主题令牌（颜色、字体、动画）与自定义工具类
```

## 运行时：按平台 / 文件自动选择模拟器

`src/runtimes/` 是一个小型注册表，播放器不关心具体用哪个模拟器：

| 运行时 | 负责的平台 | 资源 |
| --- | --- | --- |
| **EmulatorJS** | NES / SNES / GBA / GB / N64 / PS1 / NDS / MD / WonderSwan / 街机 / DOS（`platforms.ts` 里 `runtime: 'emulatorjs'`，`core` 指定核心） | 官方 CDN 或自托管（`VITE_EJS_PATH`） |
| **Ruffle** | Flash `.swf`（`runtime: 'ruffle'`） | `npm run ruffle` 从 npm 包 `@ruffle-rs/ruffle` 复制到 `public/ruffle/`（dev / build 前自动执行），或 `VITE_RUFFLE_PATH` 指向 CDN |

选择逻辑：

1. **按平台**：`resolveRuntime(platformId)` 读取 `src/data/platforms.ts` 的 `runtime` 字段 → 拿到实现。
   游戏详情页、云端 ROM、玩本地 ROM 都走这一条。
2. **按文件**（玩本地 ROM 页默认「自动识别」）：`detectRom(file)` 读文件头 + 扩展名判断平台
   （iNES / SWF / N64 / GB / GBA / SEGA 等文件头；zip 会解析中央目录看压缩包里的文件名；多段文件视为街机），
   再交给第 1 步。详情页里如果拖入的文件明显属于别的平台（例如在 GBA 页拖了 .swf），也会切到正确的运行时并提示。

新增一个运行时只需三步：在 `src/runtimes/` 实现 `Runtime` 接口（`supports / engineLabel / mount`），
在 `registry.ts` 注册，在 `platforms.ts` 把平台的 `runtime` 指向它。所有运行时都在独立 iframe 里运行，
切换游戏直接销毁，互不干扰。

## EmulatorJS 集成说明

- 默认从官方 CDN（`https://cdn.emulatorjs.org/stable/data/`）加载模拟器，**需要联网**。
- 模拟器运行在一个同源的 `srcdoc` iframe 中（见 `src/lib/emulator.ts`），
  切换游戏或离开页面时直接销毁 iframe，不会残留全局变量、声音或 WebAssembly 内存。
- ROM 文件通过 `blob:` URL 交给模拟器，**只在浏览器本地读取，不会上传**。
- 平台与核心的映射在 `src/data/platforms.ts` 的 `core` 字段中：
  `nes / snes / gba / gb / n64 / psx / nds / segaMD / arcade / dos / ws`。
  `core: null` 的平台（Flash、Java）会显示「暂不支持在线运行」。
- 若需要自托管资源（内网 / 国内访问更快）：
  1. 从 [EmulatorJS Releases](https://github.com/EmulatorJS/EmulatorJS/releases) 下载发行包；
  2. 把其中的 `data/` 目录放到 `public/emulatorjs/`；
  3. 复制 `.env.example` 为 `.env`，设置 `VITE_EJS_PATH=/emulatorjs/`。

## 替换为真实数据

- 游戏数据在 `src/data/games.ts`，字段说明见 `src/types.ts` 中的 `Game` 接口。
  给某款游戏填写 `cover` 字段即可使用真实封面图，留空则使用程序生成的渐变封面。
- 所有页面都通过 `src/services/games.ts` 取数（`queryGames`、`getGame`、`getPlatforms` …）。
  接入后端时把这些函数改成 `fetch` 即可（建议同时把返回值改为 `Promise` 并在页面中配合
  `useEffect` / React Query 使用）。
- 站点名称可通过 `.env` 中的 `VITE_SITE_NAME` 修改。

## 版权提示

本项目不包含、也不分发任何受版权保护的游戏 ROM。请只运行你拥有合法备份权利的游戏，
或自制 / 开源 ROM。站内展示的游戏名称、平台、年份与开发商均为公开信息，简介为原创文案。
