# 8BitGo 国际搜索与 AI 可发现性方案

更新日期：2026-11-28

目标：让玩家用自己的语言、游戏名、平台、类型和版本信息找到真正能玩的游戏；让搜索引擎与 AI 抓取器能直接读懂页面、语言、可玩版本和实体关系。

## 先看结论

### 2026-11-28 当前生产复核

本节更新生产现状；下方 11-26 的抓取、性能与数据库记录保留为历史快照，不能再当作当前标题覆盖状态。

- **ROM 版本哈希复核（2026-11-28）**：生产 `gold-miner-2-player` SWF 解包后的 SHA-256 为 `0b308628f086cad2fb659ebb3f292f995d210e9b801a0bbcc53410126ed0a4e2`，与[Flash 保存计划馆藏](https://cf.flash.homes/flash/1CR8-CA7G-GV5D)完全一致，确认是同一份文件；馆藏只列来源 `Villivateur`，没有开发者署名。生产 `cat-mario-flash` 的 8BG ROM 在内存中解包后为 3,632,676 字节，Internet Archive 同名 SWF 为 3,664,333 字节；两份都是 CWS，解压并重建 FWS 头后仍不同，标准化 SHA-256 分别为 `54ec5ca401521319a9ac2a023ab25473920f780b21072f67e7621ada9f606c79` 和 `a2838971d09f8dc1d2470082eb6f7a91398cd885afe61b83e1f8d687493a3bae`。因此不能把另一版本日期或署名套用到本站 ROM。

- **补充核对两款 Flash 游戏的署名与版本（2026-11-28）**：[4399《猫里奥》原始游戏页](https://www.4399.com/flash/58508.htm)列 2011-05-19、3.51M，并显示账号 `wyc`；页面说明游戏由 4399 用户提供，这能证明投稿来源，不能证明原始开发者。[FlashArch 归档条目](https://flasharch.com/en/archive/play/e5aab9bd8115117b7d6d13758563544d)将作者、发行商、版本和年份标为未知；2009 年已有 Flash 版实况视频，因此 2011 只能确认是 4399 页面的日期，不能当作原作首发年。本站 ROM 经 CWS 解压标准化后仍与 Internet Archive 文件不同，故生产 `cat-mario-flash` 暂保留 `year=0`、开发者未知。[4399《黄金矿工双人版》原始页](https://www.4399.com/flash/3883.htm)列 2008-01-24，显示账号 `wyc`，并说明由 4399 用户提供；这支持页面所记年份，但不能证明开发者，故开发者继续未知。

- **黄金矿工双人版的游玩模式与简介纠错（2026-11-28）**：生产 SWF 指纹匹配[Flash 保存计划馆藏](https://cf.flash.homes/flash/1CR8-CA7G-GV5D)，馆藏提取的按键为方向键与 WASD；[Y8 同名游戏页](https://www.y8.com/games/gold_miner_two_players)明确描述两人共用键盘游玩。生产记录原先把它设成强制在线联机，详情因此错误显示“最高 2 人联机”。已通过生产后台 API 将在线联机设为关闭、联机玩家数归为单人，并更新中英文简介，明确说明这是本地同屏游玩、不支持在线联机。八种 UI 语言的公开 SSR 均返回 HTTP 200，分别显示本地化的“本站联机 / 不支持”语义，避免把“不支持 8BitGo 在线房间”误写为“单人游戏”；中英文 `VideoGame` JSON-LD 的简介也包含本地游玩说明。

- **《1944》NES 文件指纹与标题复核（2026-11-28）**：在生产机内存中逐块解密并通过 8BG 块校验后，简中 ROM 为 131,088 字节、SHA-256 `789cea9066e8af96ed418dac87cb8eb50ac5266d6242662dcb0677d78c935de1`、整文件 CRC-32 `6BE23DA5`；日文 ROM 为同样大小、SHA-256 `ce66de0e4532d024096293781e84faba288fe5ac294b5e1df4e60ba9371ee5b2`、整文件 CRC-32 `960EF77E`。两份是不同文件。[ScreenScraper 的 NES ROM 目录](https://www.screenscraper.fr/romsinfos.php?action=openclosezoneopen&alpha=Z&numpage=0&plateforme=3&zone=helpzone)列出一个 128.02 KiB、CRC `C832792E` 的 1944 ROM，并说明带英文道具菜单的日文版是对 1943 改版的翻译；本站两个文件的整文件 CRC 与去除 16 字节 iNES 头后的 CRC（简中 `A8155777`、日文 `55F99DAC`）都不匹配该条目。[MAME NES 软件目录](https://mame.spludlow.co.uk/SoftwareLists.aspx?Exact=true&List=nes)把 `1944` 标作 `1944 (1943 pirate)`、父项为 `1943`、年份未知；[VGDB](https://www.vgdb.com.br/nes-nintendo-entertainment-system/jogos/1944-hack/)也将它归为 NES《1943》改版，但未给出年份；[Museum of the Game 的街机记录](https://www.arcade-museum.com/tech-center/machine/1944u)所列《1944: The Loop Master》则是 2000 年街机作品。生产页面已通过后台 PATCH 修正：英文标题为 `1944 (1943 Hack)`，日文标题为 `1944（『1943』改造版）`，两种简介都说明 NES 改版并与街机作品区分；简中标题与简介保留。三种语言的公开 SSR 均返回 HTTP 200，标题、H1、Open Graph 与 `VideoGame.name` 均反映对应语言；英文和日文 H1 / JSON-LD 名称与各自标题一致，站内搜索索引已确认包含 `1943`、`1944`、`hack`。哈希仍未匹配到目录 ROM，因此生产年份 1990 暂按游戏条目层级保留、开发商仍未知；该年份是否精确对应这两个文件继续待核。

- **逐语言标题和简介待办已清空**：生产机 `npm --prefix server run seo:coverage -- --review --limit 12` 显示 663 款公开游戏；对每个有精确语言 ROM 的条目，八种语言的标题、简介和非自动内容校验均无待办。对应语言 ROM 数为简中 299、繁中 37、英文 558、西语 111、法语 62、意大利语 52、德语 57、日语 148。此结果表示字段覆盖与报告规则通过，不代表每段简介都已由母语编辑做事实校对。
- **本地化游戏标题已进入真实页面**：日文《火红》详情现在的 `<title>` 与 H1 均使用「ポケットモンスター ファイアレッド」；可见证据表明后台标题、SSR 与详情页标题信号的链路已经生效。用户最初提出的“按 UI 语言显示对应游戏标题”已在线解决。
- **合集索引仍有可收敛的抓取路径**：生产有 16 个公开合集，其中 4 个达到详情页 / 首页 / sitemap 索引门槛，12 个为 `noindex`；`/collections` 仍链接到这 12 个 noindex 页面。作者自建合集的描述属于作者表达，本计划不代作者改写；下一步应评估目录是否只把可索引合集作为搜索入口，同时保留玩家访问方式。
- **元数据准确性仍有缺口**：生产公开游戏中 3 款仍缺开发商或发行年份（只读 SQL 复核）。《黄金矿工双人版》当前数据库与带唯一参数的 SSR 均显示 2008；[4399 游戏页](https://www.4399.com/flash/3883_2.htm)明确记为 2008-01-24，并说明双人操作；[Flash 保存计划档案](https://cf.flash.homes/flash/1CR8-CA7G-GV5D)保存的同名 SWF 来源字段为 Villivateur，但这是档案来源而非开发者署名，故开发商仍未知。旧搜索快照中的 1990 不是当前线上值。对 `cat-mario-flash`，[对应的 FlashArch 归档条目](https://flasharch.com/en/archive/play/e5aab9bd8115117b7d6d13758563544d)将开发者、发行商、版本和发行时间均标为 Unknown，且明确注明首位上传者不一定是原作者；原作 Syobon Action 的作者/年份不足以证明这个 Flash 改编版的署名与年份，因此暂不套用原作资料。Kartboard 的创作者为 David Ronai（Makio64）；[BrowserGaming 的核实记录](https://browsergaming.com/games/kartboard/)引用了创作者 2026-11-16 的发布帖。已将生产年份从 0 补为 2026，数据库与公开 SSR 的 `datePublished` 都确认；搜索 tokens 已重建，IndexNow 接收 33 个 URL，Cloudflare HTML 缓存已清。同期百度推送返回 HTTP 400 配额已满，未重试。《1944: The Loop Master》数据库平台是 NES；本站页面与[ScreenScraper 的 NES 条目](https://www.screenscraper.fr/gamesinfos.php?alpha=0&numpage=0&plateforme=3)均指向以《1943》为基础的改版，ScreenScraper 列出 1990、Dismac 与 Unknown Developer；[巴西游戏资料库](https://videogamebrasileiro.fandom.com/pt-br/wiki/1944)也确认这是《1943》改版，并引用 1990 年杂志和 1991 年报纸的发行记录。基于对应 NES 版本的证据，已把年份恢复为 1990，开发商仍未知；生产数据库和 SSR JSON-LD 的 `datePublished` 均确认，IndexNow 接收 42 个 URL，Cloudflare HTML 缓存已清。生产复核仍有 3 款公开游戏缺开发商或年份：`cat-mario-flash` 缺两项，`gold-miner-2-player` 与 `1944-the-loop-master` 缺开发者。对 Pokecatch，[开发者账号的 2026 年试玩帖](https://www.reddit.com/r/pokemonfr/comments/1x94jmr/pokecatch_besoin_de_vos_avis_jeu_navigateur/)自述正在开发 Poke'Catch 并附游戏链接；其玩法与本站条目简介相符。生产年份由 0 补为 2026，开发者记为公开署名 `SireChaussette`；数据库与 SSR JSON-LD 的 `datePublished` / `author` 均已确认，搜索 tokens 已重建，IndexNow 接收 33 个 URL，Cloudflare HTML 缓存已清。另据[2006 年新浪报道](https://tech.sina.com.cn/i/2006-07-01/02051016612.shtml)，“Q宠打靶”属于腾讯旗下 QQ 宠物嘉年华；[17173 同期报道](https://news.17173.com/content/2006-11-29/20061129150410184.shtml)将嘉年华、冒险岛等附加互动小游戏列为 QQ 宠物项目配套研发内容；[Flash 保存计划](https://www.flash.homes/flash/MPM4-C0HE-46YF)记录《QQ宠物冒险岛 1：起航》首发于 2006-06-22。基于这组来源，已将宠物打靶、冒险岛 1 和冒险岛 2 的开发者从未知补为 Tencent；生产数据库与三页 SSR JSON-LD 均确认开发者和 2006 年份，IndexNow 接收 43 个 URL，HTML 缓存已清。来源未给出更具体的内部工作室名称，未补写团队名。对 Java 条目 Game Store Simulator，[Java 游戏档案](https://java.owoemu.com/784.html)列出了日文 240×320 JAR、Kairosoft、2005 年发行与 15 年经营街角游戏店玩法；和本站 Java 条目的名称、语言与玩法相符。生产年份由 0 补为 2005、开发者补为 Kairosoft；数据库和 SSR JSON-LD 的 `datePublished` / `author` 均确认，IndexNow 接收 33 个 URL，HTML 缓存已清。当前仍有 3 款缺开发商或年份。
- **生产部署与 SSH 入口复核（2026-11-28 12:48 UTC）**：通过 `ssh root@38.76.186.225` 登录生产机，`/var/www/8bitgo` 位于 `main` 分支、当前提交 `b158d0b0`，`8bitgo.service` 健康检查 `/api/health` 返回成功。与 `origin/main` 对比，应用代码没有差异；剩余差异仅为本计划的三笔文档提交，因此无需为文档更新重启线上服务。需要发布代码时，登录后执行 `cd /var/www/8bitgo && ./deploy/redeploy.sh`；该入口已在 `AGENTS.md` 留档，勿将 SSH 私钥或口令写入仓库。
- **授权发布结果（2026-11-28 13:17 UTC）**：使用上面的 SSH 地址与 `./deploy/redeploy.sh` 完成生产发布；最终生产仓库为 `721c2426`，包含本计划的 SSH 记录提交 `866e32e`。构建检查、数据库迁移、服务健康检查均通过，NES `super-mario-bros`、CPS1 `cadillacs-and-dinosaurs`、GBA `pokemon-sapphire` 均达到 `game_playable`，显示首帧并收到首次输入；部署日志记录“部署完成”，备份已上传 R2。期间其他会话也排队发布，部署锁按顺序串行执行；最终 `721c2426` 已通过完整冒烟。
- **联机事实文案发布结果（2026-11-28 14:04 UTC）**：SEO/UI 修正提交 `deaa92d` 已进入生产主线；在其后续主线 `44bc94ea` 上执行官方 `./deploy/redeploy.sh` 完成部署。构建、迁移和健康检查通过；NES `super-mario-bros`、CPS1 `cadillacs-and-dinosaurs`、GBA `pokemon-sapphire` 均通过开局冒烟并收到首次输入。八种语言详情 SSR、中文与英文 `VideoGame` JSON-LD 已逐项核对，本站联机状态与简介均与实际能力一致。
- **站长侧指标仍缺数据源**：Search Console、Bing Webmaster、Cloudflare/WAF 日志仍未接入，所以真实收录、查询曝光、验证爬虫状态和边缘缓存清理结果未知。普通 UA 或伪装搜索 UA 的 HTTP 200 不能证明真实搜索爬虫已通过。
- **抓取入口与首屏性能仍需持续监控**：11-26 的巡检读到 robots 与 sitemap，但两次遇到不同语言 sitemap 的 `fetch failed`；这没有收到失败 HTTP 状态，应继续区分公网链路抖动与源站响应故障。此前 PSI / CrUX 的性能记录仍是定位线索，需用更新后的真实用户数据复测，不能把旧报告视为本次部署效果。

**最近一次代码改进**：首页与目录首图优先级、按玩家数隐藏不适用的 2P 键位、稳定的 VideoGame 实体 ID、逐语言内容覆盖报告、Unicode 站内搜索分词和公网抓取巡检都已进入生产主分支；当前生产服务健康。之后新增的内容质量问题应按确切 ROM 版本和可信来源处理，不以批量翻译或原作资料替代本站版本核验。

**2026-11-26 代码改进摘要**：首页/游戏库/合集首张封面与视频 poster 提高加载优先级；控制键说明按游戏真实玩家数隐藏不适用的 2P 键位；VideoGame JSON-LD 在各语言详情间共用稳定实体 ID；只读报告覆盖逐语言人工字段，并统计合集索引门槛与列表页链接到的 noindex 合集；外链启动按钮的无障碍名称现在也使用当前 UI 语言标题；站内搜索现能为日文假名、韩文、泰文/老挝文/高棉文/缅甸文等无空格文字建 n-gram，并把西里尔、阿拉伯、天城文等按 Unicode 字母词索引；搜索全量重建脚本也会导入 `title_i18n` / `title_localized`，且只给明确的中文标题生成拼音。15 分钟公网巡检检查 robots、索引中的全部子 sitemap、默认/日文首页与代表页面，验证 HTML SSR、语言、canonical、noindex 和游戏 JSON-LD，并抽查首页推荐合集是否仍可索引。游戏详情抽样还会核对浏览器标题、Open Graph、Twitter、H1 与 `VideoGame.name` 是否使用同一个本地化游戏名；若 SSR 数据已有该语言标题，则另外要求 H1 使用该值。它也接受 `VideoGame` 与 `WebApplication` 组合类型，验证 hreflang 自指和 `x-default`。巡检独立告警，不把普通 UA 的结果当成已验证搜索爬虫状态。相关 SEO、sitemap / IndexNow、抓取巡检与站内搜索分词改动目前已在生产主分支，2026-11-28 的 SSH 健康检查确认服务正常。

### 2026-11-26 生产只读数据库复核（历史快照；当前字段覆盖见上方 11-28 复核）

通过生产机现有 `seo:coverage` 脚本和只读 SQL 检查；没有输出游戏 ROM key、玩家数据或数据库凭据。

| UI / ROM 语言 | 精确语言 ROM | 人工标题 | 有简介（含自动翻译） | ROM + 简介 sitemap 候选 | 标题 + 简介 + ROM |
|---|---:|---:|---:|---:|---:|
| 简体中文 | 299 | 288 | 284 | 284 | 280 |
| 繁体中文 | 37 | 0 | 4 | 4 | 0 |
| English | 558 | 558 | 520 | 520 | 520 |
| Español | 111 | 0 | 22 | 22 | 0 |
| Français | 61 | 0 | 17 | 17 | 0 |
| Italiano | 52 | 0 | 14 | 14 | 0 |
| Deutsch | 57 | 0 | 16 | 16 | 0 |
| 日本語 | 149 | 0 | 26 | 26 | 0 |

生产库共有 667 款游戏。2026-11-28 部署后已执行幂等 `npm run backfill-search`，为 667 款重建 46,160 条搜索索引，纳入新分词规则与人工校对的多语言标题；平均每款 69.2 条。随后运行生产 `seo:coverage -- --review`，8 种语言均无标题、简介或精确 ROM 覆盖待办。`games.title_localized` 与 `game_search_tokens` 已存在，部署无需新增 schema；以后改动分词规则或绕过后台直接更新标题数据时，仍需重跑回填脚本。

## 审计结论

### 已具备的基础

- `/en`、`/ja` 首页和英文游戏详情页经公开抓取验证，能读到服务端渲染的标题、正文和普通站内链接，不依赖先运行客户端 JavaScript 才出现目录内容。
- 页面有语言前缀、canonical、hreflang、Open Graph、JSON-LD；游戏、文章、分类等 sitemap 由服务端维护。
- 游戏详情页的 hreflang 按页面是否有独立正文生成；详情 sitemap 还会额外校验存在对应或通用 ROM，JSON-LD 单独声明实际绑定的 ROM 语言。ROM 语言专题页只统计显式语言槽，不把通用 `*` ROM 算作日文等专属版本。
- `robots.txt` 的仓库版本允许公开页面和通用爬虫，避开后台、个人页、登录页和 API；媒体接口例外允许抓图。2026-11-26 受控只读公网 GET 已确认线上 `robots.txt` 与仓库文件逐字节一致，robots、sitemap index 和全部 26 个子 sitemap 均为 HTTP 200；Search Console URL 检查仍用于核实搜索引擎实际处理结果。
- 内容变更已有 IndexNow、百度推送队列与每日补交脚本；生产环境是否启用由 `server/.env` 决定，本次无法检查运行时环境。
- 现有 SEO 回归覆盖页面标题、描述、noindex/follow、图片 alt、canonical、sitemap 语言门控等。

### 本轮公开页面抽查（2026-11-25）

- 本轮通过可见浏览器再次复查线上 `/ja/rom-language/ja`：147 款、每页 24 款、7 页分页和普通详情链接均正常；首屏 `Pokémon FireRed`、`Contra`、`Rhythm Heaven` 等标题仍为英文。随后抽查 `/ja/games/pokemon-firered`，浏览器标题与 H1 都是 `Pokémon FireRed`；日文正文是自动翻译，仍有生硬或不准确表达。由此确认用户可见的本地化缺口，不把它误判成专题页抓取故障。
- **线上 `/ja/rom-language/ja` 曾有真实故障**：本地化 `<title>`、H1 和说明正常，但列表区域显示“服务器内部错误”。根因是该路由引用了 `/games` 条件分支里的局部变量 `visiblePlatforms`，触发 `ReferenceError`；修复已将平台范围提升到共享路由数据作用域，并把 `/rom-language/ja` 加入 `test:nowasm-lists`。部署记录标记 `23d74ce` 于 2026-11-25 发布，并记录直接请求为 HTTP 200、SSR 有 147 款总数、首屏 24 款清单及第 2–7 页链接。本轮浏览器复查独立确认页面能显示 147 款、24 款首屏和 7 页导航；浏览器工具没有提供响应头或原始 HTML，因此本轮不独立断言状态码与 SSR 源码。
- 部署后复核 `/api/health` 返回 HTTP 200 且 `db: true`。专题 HTML 保留 self-canonical、8 个语言 `hreflang` 与 `x-default`、日文 meta description；这只验证了站点实际响应与 SSR 输出，搜索引擎是否抓取和收录仍需在 Search Console / Bing Webmaster 查看。平台、类型与 ROM 语言目录在站内数据请求失败时会切换为 `noindex,follow`，降低临时错误页被索引的风险。
- 日文游戏库卡片仍显示不少英文原名，例如 `The King of Fighters ’97`、`Pokémon FireRed`。对《火红》的直接 SSR HTML 检查确认页面没有 `titleLocalized` 字段；其它游戏是否缺值仍需覆盖报告确认。源码已包含按 ROM 槽显示标题框、保存/读取 `title_localized`、`gameTitle()` 消费本地化标题的完整链路；迁移位于 `server/scripts/migrate.mjs`，schema 检查也会守住该列。本轮本地 MySQL 无监听，公开 API TLS 握手超时，因此生产列状态、实际写入能力和标题总体覆盖率仍未核实。
- 再次复核日文详情 `/ja/games/pokemon-firered`：本轮直接取得完整 SSR HTML（HTTP 200，约 146 KB，含 `</html>`）。`html lang="ja"`、self-canonical、`index,follow` 与 8 组 hreflang 都在首响 HTML 中；但 `<title>`、Open Graph / Twitter 标题和 H1 仍是英文 `Pokémon FireRed`，HTML 里没有 `titleLocalized` 字段。任天堂[官方日文商品页](https://www.nintendo.co.jp/n08/bprj/index.html)将单款包装名写作「ポケットモンスター ファイアレッド」；[Pokémon 官方资料](https://www.pokemon.co.jp/ex/switch-frlg/)把新增岛屿称为「ナナシマ」，而当前自动译文出现「セビリア諸島」，说明需要人工校对，不应原样当作高质量日文正文。页面还把单人游戏配上通用 2P 操作键位。抓取链路可读，首要缺口是给真实日文 ROM 填经核实的正式标题，并校对简介、人数和操作说明。
- 后续在浏览器重新打开同一日文详情页，浏览器标题仍为「Pokémon FireRed（GBA）をオンラインでプレイ｜8BitGo」，H1 仍是 `Pokémon FireRed`；页面主体能直接读到 1 人游戏信息，却同时列出 2P 键位。简介还提到 Wireless Adapter 交易和 `FireRed 386` hack，但页面没有说明实际 ROM 是否包含这些内容或对应哪个版本。需把“这份 ROM 实际是什么”作为内容核验项；不要只翻译模板，或把另一版本的特征写到当前 ROM 上。
- 同一份 PageSpeed 报告的 Lighthouse 单次模拟结果为手机性能 66、桌面 67；手机 LCP 20.4 秒 / TBT 310 毫秒 / 总网络负载约 4.99 MB，桌面 LCP 3.5 秒 / TBT 310 毫秒 / 总网络负载约 4.96 MB。诊断列出主线程工作 3.1 秒、约 168–169 KiB 未使用 JS、64 KiB 未使用 CSS、缓存生命周期与图片传送可优化；这些是一次合成实验，不等同真实访客指标。Lighthouse SEO 为 100、实验性 agentic browsing 为 2/2，只证明其有限自动检查通过，不能抵消真实 CWV 未通过或 Search Console 未收录。
- 同日对日文首页、游戏库、ROM 语言专题各新跑了一次移动端 PSI：[首页报告](https://pagespeed.web.dev/analysis/https-8bitgo-com-ja/qcs2lruiemmi0k4wset1mc?form_factor=mobile) `/ja` Lighthouse 性能 62、LCP 21.1 秒、总负载 4,765 KiB、6 个长任务；[游戏库报告](https://pagespeed.web.dev/analysis/https-8bitgo-com-ja-games/x4zthmsvoer60tkoxexytx?form_factor=mobile) `/ja/games` 性能 74、LCP 14.3 秒、负载 3,640 KiB、2 个长任务；[ROM 语言专题报告](https://pagespeed.web.dev/analysis/https-8bitgo-com-ja-rom-language-ja/s109bhdopydh4vahoyzkbk?form_factor=mobile) `/ja/rom-language/ja` 性能 71、LCP 14.6 秒、负载 3,819 KiB、4 个长任务。三页实验室 CLS 均为 0，FCP 为 1.1–1.4 秒；SEO 分数分别为 100、100、100。每份报告的 CrUX 区域都明确退回到“源站”而非该 URL，所以相同的真实用户值（移动 LCP 3.9 秒、INP 262 毫秒、CLS 0.64）只能说明域名聚合体验未通过，不能拿来断言某条路由的实际 CWV。
- PSI 的 LCP 元素检查指出日文首页与 `/ja/games` 的最大元素是《拳皇 97》游戏卡 `<video>` 的静态 poster；ROM 语言专题最大元素是首张《火红》封面图。专题图虽然已 `loading="eager"`，但 `fetchpriority="auto"`；视频 poster 没有显式高优先级。三个报告都建议对 LCP 图像采用高优先级。代码审计发现 `GameCover` 已支持 `priority`，首页 Hero 已使用，但列表页只传 `eager`、首页“最新上线”卡也没有传 `priority`。本轮已将首页、游戏库、ROM 语言专题首张封面设为高优先级，并对首屏视频 poster 发出高优先级图片预加载；其余首屏图仍只 eager，避免争抢带宽。
- `/ja/games` 这次报告里 LCP 总值 14.3 秒，但同一报告的 LCP 细分行合计约 340 毫秒；两者互相矛盾。因此将其作为需要实测复跑的方向提示，不当作完整根因证明。PSI 还分别提示图片传送可节省约 243–463 KiB、缓存生命周期约 103–203 KiB、渲染阻塞请求约 380–450 毫秒；优化前应展开资源清单，按真实 LCP URL 与线上 cache header 排序，不能仅凭估算数字批量改压缩或缓存。
- 2026-11-25 再次按精确路径查询公开搜索：没有返回 `/ja/rom-language/ja` 或 `/ja/games/pokemon-firered`；`/ja/games` 和 `/ja/genres/adventure` 仍能被搜到，但快照约两个月前，卡片标题仍大量为英文。`/ja/games/pokemon-pearl` 的搜索快照约一周前，正文已有日文内容，但结果标题仍显示英文 `Pokémon Pearl`；默认 `/games/pokemon-firered` 的快照约四周前则显示中文标题与正文。搜索快照可能滞后或不完整，这些结果不能证明 URL 未收录或 Google 当前采用的页面标题，只能作为 Search Console URL Inspection 的核对样本。
- 2026-11-26 单独重查 `/ja/games/pokemon-firered`，公开搜索现在返回该日文详情页；但结果快照仍约两个月旧，标题显示「Pokémon FireRed をオンラインでプレイ」，主体片段为英文长简介，H1 仍是 `Pokémon FireRed`。因此现在有“搜索结果能发现该 URL”的正面证据，也有页面标题与正文语言信号不一致的内容质量线索；旧快照不能代替当前 SSR、Google 选用标题或 Search Console 索引状态。此前 11-25 未返回同一路径，说明公开搜索查询结果有波动，不应把一次未命中记成未收录。
- 2026-11-26 对同一游戏的德语页检索也返回 `/de/games/pokemon-firered`，但约一个月旧的快照正文仍是英文长简介，只有页面框架与操作标签为德语；说明语言 UI 本地化不等于主体内容本地化。西班牙语、法语详情页的精确路径查询没有返回对应详情，但同时检索到当地语言的游戏库与首页，不能据此断言详情未收录。法语游戏库快照中《火红》卡片名仍为英文。跨语言搜索快照仅作发现/语言质量线索，需用各引擎站长工具检查真实 URL 状态。
- 2026-11-25 的公开搜索快照可搜到日文首页（当天抓取），但卡片标题仍有大量英文；快照里还出现了 `pokemon` 等单款清单。随后直接抓到的日文首页 SSR 片段只链接 `/ja/collections/1`–`4`，没有 `/ja/collections/14`，说明首页门槛已线上生效；公开搜索片段仍可能滞后。日文、德文、西班牙文快照中的模板说明也需要按真实正文覆盖率抽查。
- 2026-11-26 再查公开搜索时，日文首页结果片段列出多份单款合集并显示自动生成的通用简介；同一工具打开首页的完整快照却标注“抓取于 4 周前”，与 11-25 直接 SSR 中合集已过滤的现场证据冲突。故这只能作为“搜索索引/缓存可能仍保留旧首页链接”的线索，不能断言当前线上首页仍输出薄合集。工作区的首页推荐、合集详情 noindex、sitemap 与 IndexNow 已共用同一门槛；本轮将公网 smoke-watch 扩充为明确抽查 `/`、`/ja` 和首页最多 8 个合集链接，遇到 `noindex` 推荐即失败告警。
- 2026-11-26 当时的公开搜索接口把日文首页标为“今天抓取”，片段列出只有 1 款的合集；同一工具打开的完整页面却标为 4 周前。当时审计环境直接请求遇到 DNS 问题、内置浏览器请求超时，因此不能把任一快照当作源站 HTML。**同日稍后受控只读公网 GET 与现场浏览器均成功**，确认首页仅链接 4 个达标合集；早先的连接失败是读取通道限制，已由后续请求补证，不代表目前源站不可达。
- 同日源码核对发现 `/collections` SSR 列表和分页 API 仍返回所有公开合集；不达内容门槛的详情虽然 `noindex`、不进首页和 sitemap，仍会从这个列表被链接。为了不先牺牲玩家浏览全部清单的能力，新增只读覆盖报告计数：公开合集、可索引合集、noindex 合集，以及仍从 `/collections` 链出的 noindex 条目；等数据库连接后再按数量和真实抓取日志决定是否需要改列表入口。
- 早先 Web 文本读取器和可见浏览器对 robots / sitemap 的拦截属于读取通道限制，不代表源站故障；本轮通过只读公网 GET 读取 robots、sitemap index 与全部 26 个子 sitemap，并将线上 robots 与 `public/robots.txt` 逐字节比较确认相同（5,938 字节）。公开搜索快照的抓取时间与当前页面仍可能滞后，索引状态以 Search Console / Bing URL 检查为准。只读覆盖报告仍因本机 `127.0.0.1:3307` 没有 MySQL 服务监听而无法生成数据库层的人工 / 自动字段数字；SSR 全量分页已提供 ROM 和本地化标题数量。
- **2026-11-26 现场浏览器复查**：`/ja`、`/ja/rom-language/ja` 和 `/ja/games/pokemon-firered` 均成功打开。首页 ROM 语言入口当前显示 DE 57、EN 558、ES 111、FR 61、IT 52、JA 149、简中 299、繁中 37；日文专题实际显示 149 款、每页 24 款、7 页，列表使用普通详情链接。首页合集块当前只有 4 个合集，分别有 7、16、17、10 款，低信息合集过滤在线生效。搜索工具曾返回带单款合集的日文首页片段，但展开快照标注为 4 周前，因此不覆盖现场页面证据。
- 同一现场页面仍有明确的日文本地化缺口：浏览器标题为「Pokémon FireRed（GBA） をオンラインでプレイ｜8BitGo」，H1 和首屏游戏名仍为 `Pokémon FireRed`。简介虽为日文机翻，却把「七之岛」写成「セビリア諸島」，并提到尚未核实的 Wireless Adapter 交易和 `FireRed 386` 改版；页面人数为 1 人，却同时列出 1P / 2P 键位。工作区已修改详情页：有 `game.players` 元数据且小于 2 时隐藏 2P 说明；本地 ROM 没有游戏人数元数据，仍保留平台键位。该修复尚未部署。
- **2026-11-26 新一轮八语言详情页核查**：同一 slug 的简中、繁中、英、西、法、意、德、日页面都能返回 `index,follow`、self-canonical 和 9 个 hreflang（8 个语言 + `x-default`），说明语言 URL 的技术标注齐全。可见标题层面只有简中使用中文名；繁中仍显示简体「口袋妖怪 火红」，其余 6 个非英文语种及英文页都显示 `Pokémon FireRed`。八页简介随界面语言变化，但日/德版本内容仍有未核实的 ROM 特性。线上 JSON-LD 的 `VideoGame.@id` 在这 8 页均缺失；仓库已加入稳定 `@id`，证明该修正尚未发布。
- **2026-11-26 公共搜索快照复核（不是站长工具索引证据）**：按日文标题 / 精确详情 URL 查询时未返回日文《火红》页，结果展示的是默认中文与德语版本；这只能说明当前搜索快照未显出该结果，不能证明 Google 未收录。搜索结果中的[德文《火红》页](https://8bitgo.com/de/games/pokemon-firered)快照上月抓取，标题、H1 和简介正文都是英文；[日文《珍珠》页](https://8bitgo.com/ja/games/pokemon-pearl)上周快照标题仍为 `Pokémon Pearl`，正文则已是日文；[日文首页](https://8bitgo.com/ja)今天的快照里热门游戏名仍大多是英文。它与公开目录的标题覆盖统计互相印证：入口、SSR 和 hreflang 能工作，但用户按当地游戏名搜索时标题信号与内容语言不足；先补真实 ROM 对应的本地名和经核验简介，再看站长工具 URL Inspection 的最新 canonical / 索引结论。
- **2026-11-26 00:07–00:09 UTC 只读公网复核**：再次从线上读取 `robots.txt` 并与仓库逐字节比对，SHA-256 均为 `d9f1ab3c728b75d7d5b247890d23ddda3f2ca609839d359115bc68e5bf19444f`；重新运行 `node scripts/smoke-seo-crawl.mjs`，进程以退出码 0 完成，确认 robots、sitemap index、全部 26 个子 sitemap 可读且 XML 有效，并检查静态 sitemap 抽样、各非空 sitemap 代表页、首页、日文首页及其推荐合集。另从 hreflang 链接逐一获取《火红》八种语言详情页，均 HTTP 200；繁中 H1 仍为简体「口袋妖怪 火红」，西/法/意/德/日 H1 仍为英文 `Pokémon FireRed`。对日文页的 JSON-LD 做实际解析，`VideoGame` 存在但没有 `@id`。这次复核确认线上抓取入口稳定，也再次确认数据/部署缺口仍在；抽样通过不代表全量详情无错误、真实搜索爬虫身份已验证或页面已被索引。
- **后续公网重试结果未定**：另一轮完整巡检在读取 `/sitemaps/taxonomy-it.xml` 时超时；随后本机外网 DNS 开始返回 `Could not resolve host`，Node `fetch` 也立即报 `fetch failed`。这轮不能判断是 8bitgo 源站/CDN、当前测试出口还是传输编码造成，也不能覆盖上面那次成功巡检；需从生产巡检机或另一个稳定公网出口重跑后再判断是否存在持续故障。本地 `npm run test:seo-crawl` 16 项仍通过，只验证监控规则。
- 此次直接在日文 ROM 专题确认 149 款、首屏 24 个普通详情链接、7 页分页链接，且页面有本地化 title/description、self-canonical、`index,follow` 和完整 hreflang。日/德详情页当前都仍列出单人游戏的 2P 键位；工作区的 `game.players` 修复尚未部署。
- **2026-11-26 线上 robots / sitemap 复核**：用普通 Chrome 请求头从公开网络读取，`/robots.txt` 返回 HTTP 200、`text/plain`、5,938 字节；仓库文件也为 5,938 字节。`/sitemap.xml` 返回 HTTP 200、`application/xml`、3,132 字节，包含 26 个子 sitemap；`/sitemaps/games-ja.xml` 返回 HTTP 200、6,501 字节、26 个游戏详情 URL。和现场日文 ROM 目录 149 款相比，只有 26 款出现在日文详情 sitemap（约 17.4%）；目录页本身仍提供 149 款的普通详情链接和分页。另一次使用 Python 默认请求头时，robots 与日文 sitemap 返回 403；相同网络通道改用普通 Chrome 请求头后返回 200。后续同日逐字比对确认线上 robots 与仓库完全一致；再次 UA 对比未复现 Python 403。历史 UA 差异仍可留意，但不能当成当前阻断证据；模拟请求头也不等同于已验证爬虫身份。
- **2026-11-26 搜索快照补查**：公开结果中的[日文首页](https://8bitgo.com/ja)标注今天抓取，推荐卡片仍出现 `Pokémon FireRed`、`Contra` 等英文名；[日文游戏库](https://8bitgo.com/ja/games)结果标注约两个月前抓取，展示的游戏名也大多是英文；[德文《火红》详情](https://8bitgo.com/de/games/pokemon-firered)结果标注上月抓取，标题模板是德语，但 H1 和主体介绍仍为英文。它们是搜索引擎快照而非本轮直取的源站 HTML，因此只能补强“本地化标题/正文值得优先处理”的线索，不能替代生产数据库覆盖率或 URL Inspection。
- **2026-11-26 本地名称精确检索补查**：以 `site:8bitgo.com` 分别检索西语「Pokémon Edición Rojo Fuego」、法语「Pokémon Version Rouge Feu」、德语「Pokémon Feuerrot」和意大利语「Pokémon Versione Rosso Fuoco」，公开搜索本次均未返回结果。名称可能存在地区写法差异，且该搜索接口不是站长工具；这不能证明对应 URL 未收录，只提示应先在后台为真实 ROM 录入经核实的当地标题，再用 Google / Bing URL 检查核对。
- **同日续查限制（后续已补证）**：较早一次从审计运行环境请求 `/sitemap.xml`，10 秒未完成 TLS/响应而超时；同日稍后的受控公网 GET 已读取 sitemap index 和全部 26 个子 sitemap，故早先超时不再是当前线上状态。抓取入口巡检代码仍待部署；真实搜索爬虫身份与 WAF 放行仍需 Cloudflare / EdgeOne 日志确认。
- **本次搜索快照续查（快照线索，非实时源站结论）**：公开搜索工具再次将[日文首页](https://8bitgo.com/ja)标为今天抓取，但首屏热门游戏仍显示 `Pokémon FireRed`、`Contra`、`Age of Empires` 等英文名；用任天堂官方日文标题「ポケットモンスター ファイアレッド」和 `/ja/games/pokemon-firered` 精确检索时，没有返回该日文详情页，结果仍指向默认中文详情。该搜索工具的索引不是 Google/Bing Search Console，未命中不能证明未收录；这是“日文标题数据与本地搜索词覆盖不足”的新线索，需由站长工具 URL Inspection 核验。搜索结果还继续列出单款 `pokemon` 玩家合集（如 `/ja/collections/14`、`/de/collections/14`），而直接 SSR 与 sitemap 已确认这些合集 noindex / 排除。早先同一执行通道重新请求 `robots.txt` 失败，后续只读公网 GET 已确认 robots 与 sitemap 均可读；旧搜索结果应视为索引快照残留/新旧快照差异，不能覆盖最新源站检查。
- **西、法、意页面抽样补充**：公开搜索工具返回的[法文](https://8bitgo.com/fr/games/pokemon-firered)和[西班牙文](https://8bitgo.com/es/games/pokemon-firered)快照约上月，[意大利文](https://8bitgo.com/it/games/pokemon-firered)约两个月前；三页的游戏 H1 和长简介都仍是英文，只有标题模板、FAQ、操作说明等界面文字已本地化。这说明此前的日/德现象可能覆盖更多 UI 语言，但旧快照不能证明当前 SSR 内容，须与语言 ROM 绑定数据及覆盖报告核对。

### 本次公开抓取发现的内容质量风险

- 历史搜索快照中的 `/ja/collections/14` 标题只有 `pokemon`、没有说明、只含 1 款游戏。本轮直接抽查该 URL 返回 HTTP 200 与 `noindex,follow`；`/sitemaps/collections.xml` 返回 HTTP 200，只有合集 1–4，没有 14。由此确认低信息合集仍可直接访问，但详情 noindex、合集 sitemap 和首页入口过滤已在线生效。统一门槛为至少 5 款可见游戏，或至少 3 款并有 120 个字符说明，或至少 1 款并有 300 个字符说明；它是运营启发式，拿到 GSC 展示/点击与合集互动数据后应复核，不把字符数当作内容质量的唯一判据。
- 11-25 的读取曾得到英语游戏 sitemap 520 条、日语 26 条。11-26 普通 Chrome 请求头重新读取 `/sitemap.xml`，确认是 HTTP 200 的 sitemap index、含 26 个子 sitemap；日文 taxonomy 目录在索引内。对八份游戏 sitemap 的当前批量抽样结果如下：

| ROM 语言 | 首页显示 ROM 数 | 游戏 sitemap URL | 当前读取结果 |
|---|---:|---:|---|
| 简体中文 | 299 | 284 | HTTP 200 |
| 繁体中文 | 37 | 4 | HTTP 200 |
| English | 558 | 520 | HTTP 200 |
| Español | 111 | 22 | HTTP 200 |
| Français | 61 | 17 | HTTP 200 |
| Italiano | 52 | 14 | HTTP 200 |
| Deutsch | 57 | 16 | HTTP 200 |
| 日本語 | 149 | 26 | HTTP 200 |

这些是 sitemap 提交的 URL 数，不是搜索引擎的收录数。最新 2026-11-26 受控直连巡检确认上述八份游戏 sitemap 全部返回 HTTP 200、XML 有效；它们按“本地化正文 + 对应 ROM”门控。繁中、西、德、日目录与 sitemap 数差距较大，需用数据库覆盖报告确认其它游戏是缺正文、缺 ROM，还是被其它门槛排除。
- 仓库 `robots.txt` 只有通用 `User-agent: *` 组，允许公开目录里的搜索爬虫与 AI 搜索爬虫，且 `/api/` 继续屏蔽；同一规则目前也允许 GPTBot、ClaudeBot 等 AI 训练爬虫。搜索引用抓取与模型训练是不同用途，之后应根据站长偏好分别定策略；更改时必须保留后台/个人页的禁止规则，不能用一个点名 `Allow: /` 的专属组绕过它们。OpenAI 当前说明 OAI-SearchBot 用于 ChatGPT 搜索发现，GPTBot 则可由站长选择排除训练；若依赖 robots 控制搜索收录，还必须允许 OAI-SearchBot 读取页面，单靠 robots 放行也不能代替对 CDN/WAF/挑战页的实测。见[发布者说明](https://help.openai.com/en/articles/12627856-publishers-and-developers-faq)。

### 当前仓库具备的实现（线上状态需逐项验收）

- 当前 `main` 分支游戏后台已有 `title_localized` 字段，只在游戏绑定对应站点语言 ROM 时显示标题框；对应 ROM 槽变化时表单会即时增减输入框，保存时保留仍绑定或暂时解绑过的已校对标题。该标题框只覆盖当前 8 种 UI 语言；虽然 ROM 层能保存额外 BCP-47 语言槽，但还没有对应 UI locale 时就没有该语言的页面或标题框。英文和简体中文仍使用原有字段；繁体优先人工校对名，再回退自动转换名。本轮没有在生产后台编辑或保存数据，也没有核实生产列是否已迁移、已有多少条标题。
- `gameTitle()` 已用于首页、游戏卡片、详情页、搜索联想、最近游戏和云存档等界面；校对后的本地化标题也会写入站内搜索倒排索引，并进入详情页 JSON-LD 的 `name`，原题保留为 `alternateName`。标题译文本身不会扩大该语言页面的 sitemap / hreflang 覆盖。
- 评分足够且页面确实免费可玩的游戏，结构化数据同时声明 `VideoGame` 与 `WebApplication`。Google 文档指出，仅有 `VideoGame` 类型不会显示 Software App 富结果；FAQ 标记不再承诺普通游戏站能获得 FAQ 富结果。
- 新增按 ROM 语言浏览的稳定专题页 `/rom-language/:language`。页面只列实际绑定了该站点语言 ROM 槽的游戏，通用 `*` ROM 不会被误认为日文、法文等专属版本；空语言页返回 404。页面由 SSR 直接输出，具备本地化标题/正文、分页、canonical/hreflang、Breadcrumb 与游戏清单结构化数据。
- 游戏库新增 ROM 语言筛选及带真实数量的语言专题链接；筛选参数页 `noindex`，稳定专题页才进入动态分类 sitemap。游戏新增、修改、删除时会推送受影响的 ROM 语言专题 URL。
- 游戏库与 ROM 语言专题共用已开放平台白名单，避免把最终会返回 404 的下架平台游戏列进可抓取目录。
- 公开合集内容门槛共用 `shared/collection-seo.js`：有 5 款可见游戏；或 3 款以上且说明至少 120 字；或至少 1 款且说明至少 300 字。其余合集继续公开访问，但详情页返回 `noindex`，并从合集 sitemap、sitemap 索引、IndexNow 补交和首页推荐中排除；可见游戏数不把已下架游戏算进去。
- 后台保存 `title_localized` 前必须确认数据库已运行迁移 `cd server && npm run migrate`。本轮线上列表正常，但没有通过后台保存测试或 schema 检查来独立确认该列在生产库中可写。

### 本轮代码审计修复

- 类型 sitemap 原先只过滤 `hidden = 0`，可能把只有下架平台游戏的类型页提交给搜索引擎。现在类型聚合只统计前台开放平台。
- SSR 的首页、类型页与公开目录列表此前可能混入白名单外平台的游戏，产生无法打开的详情链接。现在普通访问与 noWasm 访问都分别按各自开放平台范围取数；类型计数同样应用此范围，`/genres` 不再链接到零款游戏的空类型页。
- 回归检查：`npm run test:indexnow`（41 项）、`cd server && npm run test:nowasm-lists`、`cd server && npm run test:ssr-parallel`、`npm run test:i18n-content`（9 项）、`npm run test:seo-meta` 均通过。语言内容覆盖报告已做语法检查，但因本机 MySQL `127.0.0.1:3307` 没有监听，未能生成真实覆盖率。
- 本轮重跑通过：`npm run test:seo-meta`、`npm run test:seo-performance`、`npm run test:indexnow`（41 项）、`npm run test:sitemap`、`npm run test:i18n-content`（9 项）、`cd server && npm run test:nowasm-lists`、`cd server && npm run test:ssr-parallel`。`npm run build` 与 `npx tsc -b --pretty false` 也均通过。
- 随后给游戏库、平台/类型/开发商目录与平台/类型/ROM 语言列表的客户端取数错误态加了 `noindex,follow`，站内跳转遇到接口失败时会同步移除 canonical、hreflang 与 JSON-LD；新增回归断言后 `npm run test:seo-meta` 再次通过。
- 本轮针对 PSI 报告暴露的封面优先级问题，将首页最新卡、游戏库和 ROM 语言专题首卡提升为高优先级；视频封面改为预加载静态 poster，不提前加载 MP4。`npm run test:seo-performance`（新增首卡优先级断言）、`npx tsc -b --pretty false` 与 `git diff --check` 通过。未重新跑 PSI，性能改善仍需部署后用同一报告复测，并观察 CrUX 趋势。
- 2026-11-25 收口合集质量门槛：首页推荐、详情页 `noindex`、合集 sitemap 与 IndexNow 补交共用同一可见游戏数 / 原创说明判据；首页不会被新建的低信息清单挤满，卡片数量也不会把下架游戏算入。`npm --prefix server run test:collections`（101 项）、`npm run test:i18n-content`（9 项）、`npm run test:sitemap`、`npm run test:indexnow`（41 项）、`npm run test:seo-meta`、`npm run test:seo-performance`、`npm run test:robots`（42 项）、`npx tsc -b --pretty false`、`npm run build:server`、改动脚本语法检查与 `git diff --check` 均通过。
- 2026-11-26 重新运行 `npm run test:seo-meta`、`npm run test:sitemap`、`npm run test:robots`（42 项）、`npm run test:i18n-content`（9 项）、`npm run test:seo-performance`，均通过；`git diff --check` 通过。本轮只改方案文档，没有改动抓取运行时代码；这些回归证明仓库规则一致，不证明线上 robots / sitemap 当前可读或搜索引擎已收录。
- 2026-11-26 后续为每个 `VideoGame` JSON-LD 增加固定在 `/games/:slug#game` 的 `@id`，让不同 UI 语言的实体使用同一标识，同时各自保留当前 canonical URL；新增 SEO meta 回归断言并通过。一次类型检查当时因 `src/services/romMultipart.ts:409` 的用户改动提示 `part.contentHash` 可能为 `undefined`，后续检查结果见下一条。
- 2026-11-26 现场复查后，详情页键位按 `game.players` 隐藏单人游戏的 2P 组；新增 `test:keymap` 断言。`npm run test:keymap`（799 项）、`npm run test:seo-meta`、`npm run test:i18n-content`（9 项）、`npm --prefix server run test:seo-coverage`（现 6 项覆盖与合集检查）、`npm run test:sitemap`、`npx tsc -b --pretty false` 和 `git diff --check` 均通过。合集服务端回归第一次受受限环境拦截 loopback（EPERM），经受控权限重跑后 101 项通过。
- 本轮继续加固公网抓取巡检：现在会解析 JSON-LD（支持 `@graph` 与 `VideoGame` / `WebApplication` 多类型），并要求游戏页浏览器标题、Open Graph、Twitter、H1 与 `VideoGame.name` 同属页面标题；若 SSR 序列化数据已保存该语言的人工标题或繁体转换标题，也要求 H1 使用该值。这样可抓到“后台本地化标题已填、搜索信号却仍统一回退另一语言”的情况；尚未录入标题的内容由覆盖报告处理。巡检还验证 hreflang 自指和 `x-default`。新增日文标题正常、已保存标题未进入 H1、JSON-LD 标题错位、浏览器标题回退英文、hreflang 指错 URL 五类回归；`npm run test:seo-crawl` 16 项、`npm run test:i18n-content` 9 项、`npm run test:seo-meta`、`npm --prefix server run test:seo-coverage` 6 项、`npm run test:smoke-watch`、脚本语法检查和 `git diff --check` 通过。2026-11-26 00:07–00:09 UTC 的只读公网巡检再次确认线上 robots、全部子 sitemap 与代表页面可读，详见下方最新记录。
- `npm run build` 与 `npx tsc -b --pretty false` 均通过；完整构建包括 614 模块客户端构建、495 模块 SSR 构建、运行时语法门禁、EmulatorJS 产物一致性、浏览器兼容、资源完整性、懒加载图和预构建模拟器回归门禁。
- 2026-11-26 扩展公网抓取巡检：读取索引列出的全部子 sitemap（静态、合集、游戏、文章、平台 / 类型目录），从静态 sitemap 抽查最多 8 个 URL，并从每个非空子 sitemap 抽查 1 个页面；另外固定检查默认与日文首页，并验证最多 8 个首页推荐合集详情没有 `noindex`。严格要求 HTTP 200、HTML Content-Type、SSR title/H1、页面语言、预期 canonical 和未声明 noindex；合集的本地化 UI 路由按产品规则 canonical 到默认中文页，游戏详情应有 VideoGame JSON-LD。robots 守卫确认单一通配规则组、公开路径可抓、`/api/` 受限、游戏媒体代理可抓。覆盖非 200、noindex 首页推荐、站外 URL 和危险 robots 规则等回归后，`npm run test:seo-crawl`（14 项）与 `git diff --check` 通过。巡检仍用普通浏览器 UA，不能证明已验证爬虫的 CDN/WAF 访问状态。
- 2026-11-26 复核 Google / OpenAI / Bing 官方资料：Google 当前 AI 搜索指南明确不需要额外的 AI 专用文件或 schema；OpenAI 明确把 OAI-SearchBot 搜索引用与 GPTBot 训练抓取分开控制；Bing AI Performance 显示引用与 grounding query，不是排名指标。Google 于 2026-08-31 宣布生成式 AI Search / Discover 专项表现报告已向全球站点推出。当时浏览器通道未连通且站长工具账户未连接；随后以受控只读 GET 完成线上抓取复核，但 Search Console / Bing 的索引和表现数据仍不可用。
- 2026-11-26 随后完成最新只读公网巡检：`robots.txt`、sitemap index 和全部 26 个子 sitemap 均 HTTP 200、XML 有效；包括 73 个静态 URL、4 个合集 URL、284 个简中 / 4 个繁中 / 520 个英文 / 22 个西语 / 17 个法语 / 14 个意大利语 / 16 个德语 / 26 个日语游戏详情 URL，以及文章和 taxonomy sitemap。脚本从每个非空 sitemap 抽样并检查首页、默认与日文首页、代表游戏/文章/平台/分类页：服务端 HTML、title/H1、页面语言、canonical、robots 状态通过；游戏页的 title、OG、Twitter、H1、VideoGame.name 一致，hreflang 自指与 x-default 存在。首页推荐合集（含本地化 UI 路径）均返回可索引页；本地化合集路由按产品规则 canonical 回默认中文路径，巡检已据此验收。`npm run test:seo-crawl` 14 项全部通过。以上只验证当前普通浏览器 UA 的公开 HTTP 路径，不等同 Googlebot/Bingbot/OAI-SearchBot 身份验证、收录状态或标题已按用户语言翻译；公开搜索快照和站长工具数据仍需单独核对。
- 较早一次审计尝试运行公网巡检、直接读取页面和浏览器访问时，在连接/浏览器策略层失败，未取得新的 HTTP 响应；这不能据此判断网站故障，也不覆盖同日稍后成功取得的线上快照。后续复核不再把这次通道失败记录为当前抓取状态。
- 较早一次独立公网抓取 `node scripts/smoke-seo-crawl.mjs` 在请求 `https://8bitgo.com/robots.txt` 时以 `fetch failed` 退出；随后通过受控只读公网请求重跑并成功检查全部 sitemap 与代表页面。分词 52 项、SEO 覆盖逻辑 6 项、抓取巡检规则 14 项、SEO meta 和 robots 42 项均通过，但代码回归与线上抓取证据仍分别记录。
- 本次将后台逐语言标题与简介的编辑说明补充为先核实 ROM 地区/版本、只填写该 ROM 可核验的玩法/多人/无线/改版信息，避免把原版资料误贴到改版或其它语言 ROM。`npm run test:i18n-content` 9 项与差异格式检查通过；定向 oxlint 对该文件仅报告原有其他行的 3 条警告。
- 本次让 `cd server && npm run seo:coverage` 按语言单独列出“精确 ROM + 本语言简介”的详情 sitemap 候选数，以及已有精确 ROM 但缺本语言简介的数量；标题缺失仍进校对待办，但不单独阻断已有正文页。覆盖测试现在会把报表正文判据与 sitemap 的 `hasIndexableGameLanguage()` 对照，防止两套口径漂移。`npm --prefix server run test:seo-coverage` 6 项、`npm run test:sitemap`、脚本语法检查、定向 lint 和差异格式检查通过；生产数据库未连接，当前仍无覆盖数字。
- 2026-11-26 本次再跑 `npm run test:seo-crawl`（16 项）、`npm run test:seo-meta`、`npm run test:seo-performance`、`npm run test:sitemap`、`npm run test:robots`（42 项）、`npm run test:i18n-content`（9 项）、`npm --prefix server run test:seo-coverage`（6 项）和 `git diff --check`，均通过。这里的抓取测试使用本地模拟响应，只验证巡检规则，不代表访问了生产站点。随后本次 Web 读取器打开线上 `robots.txt` 与 `sitemap.xml` 均返回内部读取错误；这不是源站 HTTP 状态，且不能覆盖 00:07–00:09 UTC 成功巡检与随后 Node DNS 失败的两份相反证据。当前仍需从生产巡检机或稳定公网出口复跑，确认实时线上可读性。

### 2026-11-26 当时的产品缺口（历史快照）

- **搜索 UA 访问复核（2026-11-26）**：普通浏览器、Googlebot、Bingbot、OAI-SearchBot、Python UA 读取 `/robots.txt` 与 `/sitemap.xml` 都返回 HTTP 200；四类爬虫/脚本 UA 读取日文《火红》页也返回 200。普通浏览器在并发检查中有一次详情请求超时，单独重试返回 200。此前记录的 Python UA 403 本轮无法复现。UA 字符串可以伪造，这只能说明当前测试出口对这些请求没有按 UA 拦截，不能验证搜索引擎真实 IP / 身份是否通过 WAF。
- **robots 发布一致性（2026-11-26）**：线上 `/robots.txt` 与当前 `public/robots.txt` 逐字相同，均为 5,938 字节、SHA-256 `d9f1ab3c728b75d7d5b247890d23ddda3f2ca609839d359115bc68e5bf19444f`；可以排除“仓库规则正确、线上仍是旧 robots”的部署漂移。
- **八语言标题对照（2026-11-26）**：同一款《火红》的八种 UI 语言页面均返回 200、self-canonical 和 9 个 hreflang（八种语言加 `x-default`）。英文页使用英文名，简中页显示简体名；繁中页仍以简体名作 H1 / VideoGame.name；西、法、意、德、日页面的游戏名与 H1 / VideoGame.name 仍是英文 `Pokémon FireRed`，只有标题模板文案本地化。线上八页均未看到 `VideoGame.@id`，与工作区已改、尚未发布的稳定实体 ID 一致。技术 hreflang 完整，但本地化游戏标题数据没有随 UI 语言补齐；不能只翻译“在线玩”模板来覆盖当地游戏名查询。
- **本地名称搜索复核（2026-11-26）**：回归前，`tokenize('ポケットモンスター ファイアレッド')`、`tokenize('한국어')`、`tokenize('Красный ФайрРед')` 和 `tokenize('العاب')` 全为空；根因是仅识别 Han 与 `[a-z0-9]`。现已按 Unicode Script / Letter / Mark / Number 扩展分词，支持无空格脚本 n-gram 和其它文字的词分组；归一化只移除拉丁重音，避免将俄语 `й` 改成 `и`、将韩文音节拆成 Jamo。运行时局部重建和全库 `backfill-search` 都会纳入逐语言标题；后者过去只查原名与中文名，本轮补上 `title_i18n` / `title_localized`。`cd server && node scripts/test-search.mjs` 目前 52 项通过。生产索引仍需部署后全量回填；本地 MySQL 不可用，尚未验证生产倒排表。

ROM 语言目录和筛选入口已在线可见；2026-11-26 现场浏览器看到 `/ja/rom-language/ja` 有 149 款并提供 7 页普通链接。同日读取的 `games-ja.xml` 只有 26 个日文详情页（约为目录的 17.4%）。这不是单凭计数就能判定的 sitemap 错误：详情 URL 门槛要求该语言正文和 ROM 都存在；但应检查另 123 款具体缺正文、缺 ROM 还是因其它门槛被排除。热门卡片和详情仍有英文原名，逐语言标题人工校对率也未读取。下一步应按游玩量和 Search Console 查询需求，优先补真实日文标题与经校对简介，再检查各页 hreflang / canonical 和站长工具中的索引状态。

**标题待办队列（截至 11-26 的历史状态）**：当时公开目录有精确西语 ROM 的 111 款、法语 61 款、意大利语 52 款、德语 57 款、日语 149 款，共 430 个非中文/英文语言-ROM 条目没有 `titleLocalized`；简中另有 11/299 缺中文显示名，繁中 36/37 仍回退简体名称。2026-11-28 生产报告显示这些字段待办现已清空；标题是否准确匹配每个 ROM 地区 / 修订版仍应按编辑标准抽查。标题只能改善当地名称呈现与搜索匹配信号；没有经校对的本地语言正文时，不应单靠标题扩大该语言详情 sitemap。

日文目录首屏可作为第一批人工校对队列（按页面显示的累计游玩次数排序，不代表搜索展示量）：Pokémon FireRed（330）、Contra（289）、JoJo's Bizarre Adventure: Heritage for the Future（242）、Pokémon Emerald（215）、Super Mario Bros.3（150）。这些数来自 2026-11-25 UTC 最新公开 API 快照，可能随玩家游玩变化。为每款填后台日文标题前，先核验对应日文 ROM 的正式发行名与版本；不能只根据游戏系列名或文件名翻译。Search Console 的日文查询/点击与真实标题覆盖率接入后，应重新排序。

2026-11-26 再次读取 `/ja/rom-language/ja` 的 SSR `ItemList`，当前首屏顺序仍是上述五款；按官方资料核对后，这五款可作为第一批 `titleLocalized.ja` 候选值。它们均列在日文 ROM 专题中，录入前仍需在后台确认该游戏的 `ja` 槽与实际 ROM 版本相符：

| slug | 线上日文 ROM 标题候选 | 官方核验来源 |
|---|---|---|
| `pokemon-firered` | ポケットモンスター ファイアレッド | [任天堂《ポケットモンスター ファイアレッド》产品页](https://www.nintendo.co.jp/n08/bprj/index.html) |
| `contra` | 魂斗羅 | [KONAMI《魂斗羅》官方系列页](https://www.konami.com/games/50th/ac/contra/jp/ja/)，其中将北美 NES 版称为 `CONTRA`、日版称为「魂斗羅」 |
| `jojos-bizarre-adventure` | ジョジョの奇妙な冒険 未来への遺産 | [CAPCOM 官方街机产品列表](https://www.capcom.co.jp/arcade/news/operator/20140930.html)列出原街机名；该候选不带 HD 移植版限定后缀 |
| `pokemon-emerald` | ポケットモンスター エメラルド | [任天堂《ポケットモンスター エメラルド》产品页](https://www.nintendo.co.jp/n08/bpej/index.html) |
| `super-mario-bros3` | スーパーマリオブラザーズ3 | [任天堂《スーパーマリオブラザーズ3》产品页](https://www.nintendo.co.jp/clv/sp/detail/supermario3.html) |

这是可供后台录入的官方名称候选，不代表已经写入生产数据库。录入后复查对应日文页的 H1、`<title>`、OG、Twitter 与 `VideoGame.name`；如果该游戏的 `ja` 槽实际绑定的是不同地区/改版，则先核实版本名称再录，避免把官方原版标题贴到改版 ROM 上。

《火红》的其它语言标题也可用来验收后台输入框与前台标题链路。任天堂官方页面列出了英、法、意、德、西五种语言版本及各自名称；日文名见任天堂日本产品页。只有对应语言槽的 ROM 确认为该语言正式版时才录入：

| UI / ROM 语言 | 标题候选 | 官方来源 |
|---|---|---|
| `en` | Pokémon FireRed | [任天堂多语言版本目录](https://www.nintendo.com/fr-fr/Divers/Pokemon-Version-Rouge-Feu-et-Pokemon-Version-Vert-Feuille-3028413.html) |
| `es` | Pokémon Edición Rojo Fuego | [任天堂多语言版本目录](https://www.nintendo.com/fr-fr/Divers/Pokemon-Version-Rouge-Feu-et-Pokemon-Version-Vert-Feuille-3028413.html) |
| `fr` | Pokémon Version Rouge Feu | [任天堂法语商品页](https://www.nintendo.com/fr-fr/Jeux/Jeux-a-telecharger-sur-Nintendo-Switch/Pokemon-Version-Rouge-Feu-3031244.html) |
| `it` | Pokémon Versione Rosso Fuoco | [任天堂多语言版本目录](https://www.nintendo.com/fr-fr/Divers/Pokemon-Version-Rouge-Feu-et-Pokemon-Version-Vert-Feuille-3028413.html) |
| `de` | Pokémon Feuerrot | [任天堂多语言版本目录](https://www.nintendo.com/fr-fr/Divers/Pokemon-Version-Rouge-Feu-et-Pokemon-Version-Vert-Feuille-3028413.html) |
| `ja` | ポケットモンスター ファイアレッド | [任天堂日文产品页](https://www.nintendo.co.jp/n08/bprj/index.html) |

这些名称最初是后台录入候选。2026-11-28 已确认对应语言标题字段在生产覆盖报告中无待办，且日文《火红》SSR 页面已显示本地化标题；其余具体发行版仍需按 ROM 槽抽查，不能仅凭候选来源推断本站 ROM 一定是同一修订版。

仓库的只读覆盖报告 `cd server && npm run seo:coverage` 已用于生产复核。它按八种站点语言统计可见游戏中的精确 ROM、标题、语言简介（含自动翻译）和“ROM+标题+简介”完整度，并单列非自动字段覆盖；默认只输出汇总数量，不输出游戏名或对象存储地址。追加 `-- --todo --limit 20` 会按游玩量列出缺本地化标题/简介的游戏；追加 `-- --review --limit 20` 会把已有自动译文但缺人工标题/简介的项目也列入校对队列。报告把通用 `*` ROM 单列，不冒充语言目录覆盖；`cd server && npm run test:seo-coverage` 验证机翻与人工校对队列的区别。无数据库连接时，覆盖报告仍不能生成真实覆盖率。

## 要达到的语言搜索体验

一个语言专题页应回答四个问题：

1. 这页列出的游戏是否真的有该语言 ROM？
2. 游戏名、简介、类型和操作说明是否是页面语言，而非只翻了 UI？
3. 点击游戏后，是否会优先启动对应语言 ROM，并明确显示缺失时的回退？
4. 这页是否有稳定 URL、唯一标题和描述、self-canonical、互相对应的 hreflang，以及只收录非空内容的 sitemap 条目？

现已增加按 ROM 语言筛选的目录入口和稳定落地页，例如 `/ja/rom-language/ja`、`/fr/rom-language/fr`。页面服务于“日语 UI 下找日文 ROM”这类场景，也允许用户在任一 UI 语言中筛选目标 ROM 语言。只有实际存在游戏的语言才进入 sitemap；任意筛选组合不提交给搜索引擎。

## 每款游戏需要提供的信息

| 信息 | 当前情况 | 优先级与采集规则 |
|---|---|---|
| 原始发行名 / slug | `title` 与 `slug` 已有 | **必填**。保留可核验的发行名；跨平台同名条目使用稳定且唯一的 slug，平台差异写进详情 SEO 标题而不是污染可见游戏名 |
| 简体中文名、英文名 | `titleZh` 与 `title` 已有 | **必填其一，优先补齐两者**。以发行版惯用名为准；没有官方译名时留空比编造名字好 |
| 对应 ROM 的逐语言标题 | `titleLocalized` 后台字段已有；输入框只对已绑定该语言 ROM 的游戏显示 | **优先语言的质量门槛**。仅给真正绑定该语言 ROM 的游戏填；用当地玩家实际搜索的正式标题，避免把纯音译当唯一名称。该标题须同步用于页面 `<title>`、首个主 H1、OG title 与 `VideoGame.name`，原发行名放 `alternateName`；标题书写系统应与页面主要正文一致，降低搜索引擎改写标题链接的概率。若正文确有独立译文且 ROM 真实存在，单独缺标题不自动触发 `noindex`，但应列为优先补齐项。 |
| 别名、罗马字、地区标题 | 还没有独立字段；部分散落在 tags / 标题中 | **高优先级**。新增规范化别名数据供站内搜索与实体消歧，保存 alias 类型和语言；只展示对玩家有用的别名，不隐藏堆词 |
| 简介 | `description`、`descriptionEn`、自动翻译与 `descriptionLocalized` 已有 | **每个要收录的语言都要有人工校对正文**。写游戏核心玩法、版本差别和“为什么这一版可玩”；避免只替换游戏名的模板句 |
| ROM 语言、地区、修订版 | `roms` 可按语言绑定；地区/修订版无统一字段 | **ROM 语言必填且实测**；地区、世界版/日版、PAL/NTSC、修订号要在可区分发行版时补，不能从封面或文件名猜 |
| 平台、受控类型、年份、开发商 | 平台/类型/年份/开发商已有 | **推荐补齐**。平台和类型来自受控词表；年份区分首次发行年份与本站上架时间；开发商与发行商分开记录 |
| 发行商、系列、权威实体 ID / 来源 | 无统一字段 | **第二阶段**。有权威来源再新增，保留 source URL 与核验时间；`sameAs` 只指向确实唯一识别该游戏的权威实体 |
| 玩家数、多人模式、控制、存档提示 | 玩家数 / 联机能力已有，操作与电池存档提示不完整 | **推荐补齐真实验证信息**。分别写本地同屏/在线联机、支持人数、键位、即时存档与游戏内存档，不要把引擎理论能力当游戏支持 |
| 封面、截图、视频 | 封面和卡片视频已有，缺少多张游戏截图字段 | **优先封面与 2–4 张真实画面截图**。图片需可匿名访问、稳定且压缩合理；alt 描述画面内容。仅在视频有真实标题、说明、缩略图和时长时标 VideoObject |
| 人工评分与评价 | 站内有真实评分聚合 | 只在页面同时展示同一批评分、人数和平均分时输出 `AggregateRating`；从未评分的游戏不输出。不得用站点编辑分冒充用户评价 |

逐语言标题要留可追溯来源：记录对应 ROM 的地区 / 发行版、该标题来源 URL 和核验日期。官方名字会因地区、发行年代和平台再发行而异，不能只按 UI 语言批量翻译。例如任天堂日本旧 GBA 页面写「ポケットモンスター ファイアレッド」，任天堂德国旧 GBA 页面写「Pokémon Feuerrote Edition」；任天堂 2026 年多语言再发行页列出法语「Pokémon Rouge Feu」、意大利语「Pokémon Rosso Fuoco」、西班牙语「Pokémon Rojo Fuego」，而 Pokémon 拉美新闻稿又使用「Pokémon Edición Rojo Fuego」。这些官方页面证明名称有地区 / 发行版差异，不代表可以把 Switch 标题直接抄给本站 GBA ROM；录入时以当前 ROM 的发行地区、游戏标题画面 / 包装或同版权威页面核准，并把确实有用的别名另存为别名。参考：[任天堂日本旧 GBA 页面](https://www.nintendo.co.jp/n08/bprj/index.html)、[任天堂德国旧 GBA 页面](https://www.nintendo.com/de-de/Spiele/Game-Boy-Advance/Pokemon-Feuerrote-Edition-267123.html)、[任天堂多语言再发行页](https://www.nintendo.com/de-de/Diverses/Pokemon-Feuerrote-Edition-und-Pokemon-Blattgrune-Edition-3028413.html)、[宝可梦拉美官方新闻稿](https://press.pokemon.com/es-MX/releases/Pokemon-Continues-30th-Celebrations-with-the-Unveiling-of-Pokemon-Wind)。目前 `title_localized` 只保存标题，没有保存逐语言来源与核验日期；在正式扩展数据模型前，内容待办表应保留这两项，避免未来无法追溯标题由来。

Google 不使用 `meta keywords` 作为排名捷径。关键词应体现在准确的标题、可见正文、类别、站内链接和可验证的游戏属性中。

当前实现的 hreflang / 游戏 sitemap 门槛接受非空的自动译文 `descriptionI18n` 或人工简介 `descriptionLocalized`，并另外要求该语言 ROM；**还没有“人工校对已完成”的机器门槛**。覆盖报告会把独立简介总数与人工校对数分开。所以上表“优先语言要人工校对”是内容运营的质量目标，不应误读成当前代码已经自动过滤所有机翻页；若未来决定把人工校对作为硬索引门槛，先看各语言覆盖和搜索数据，再渐进调整，避免一次性撤掉有真实帮助的本地化页面。Google 的 AI 搜索指南同样强调原创、可靠、对访客有帮助，并反对为覆盖所有查询变体批量制造近似页。

### 必须分开的三种“语言”

这套站点里，“界面语言”“游戏 ROM 语言”和“发行地区/版本”不是同一个字段：

1. **界面语言**由 URL 前缀决定，例如 `/ja/`。它决定按钮、说明、页面标题和简介使用哪种语言。
2. **ROM 语言**决定玩家实际运行的是哪份游戏内容，例如游戏的 `roms.ja`。日语界面可以选择英语 ROM；英语界面也可以找到日语 ROM。目录筛选必须看真实 ROM 槽，不能看访客的 UI 语言或通用 ROM。
3. **发行地区与修订版**说明 ROM 属于哪个地区、修订或改版，例如日版、北美版、Rev 1、汉化补丁版。地区不等于语言，地区名也不能仅凭文件名推断。

详情页的本地化标题应跟随 UI 语言；可玩筛选则跟随 ROM 语言；对确实不同的发行版，再显示地区/修订信息。这能回答玩家“我现在看哪种语言的站点、这款游戏能不能用目标语言玩、是不是我想要的那一版”三个不同问题。

搜索索引门槛也应把这几项分开处理：详情页 hreflang / sitemap 继续要求独立正文和对应语言 ROM；本地化标题是强优先级的内容质量项，必须同步到 `<title>`、H1、OG 和结构化数据，但标题缺失本身不应机械地把有真实译文正文的页面从索引中剔除。Google 的 hreflang 规范关注页面是否是语言/区域版本；标题语言或书写系统和正文不匹配时，Google 可能自行改写结果标题。上线时应优先补标题并抽查搜索结果，不把标题缺失误当成 robots 或抓取故障。[hreflang 指南](https://developers.google.com/search/docs/specialty/international/localized-versions) · [搜索标题链接指南](https://developers.google.com/search/docs/appearance/title-link)

### 全球语言发现的内容完成度

把每种语言下的游戏分为三档，便于编辑先补最能帮助玩家找到正确版本的信息：

| 完成度 | 最低信息 | 对玩家与搜索的作用 |
|---|---|---|
| 可发现 | 真实可打开的页面、当地常用标题、准确平台、真实 ROM 语言 | 能按游戏名和目标语言找到可玩的条目；标题和卡片锚文本能被理解 |
| 可判断 | 上述信息 + 经核验的本地化简介 + 地区/修订/改版说明（适用时） + 玩家数/操作/设备限制 | 玩家能判断是否是想找的版本、是否能在当前设备上玩；详情页对搜索查询更具体 |
| 可引用 | 上述信息 + 本地化别名/罗马字、开发商/发行商、可靠来源、真实截图及有意义的页面内链 | 搜索引擎和 AI 能更清楚地区分同名作品与 ROM 变体，并引用具体证据 |

别名应记录语言与用途，例如官方本地名、罗马字、简称、地区发行名、系列编号；只把玩家确实会用的称呼展示在可见页面或可见的“其他名称”区域，不能把隐藏关键词塞进 Schema。地区/版本字段只在能由 ROM、说明书或权威来源核验时填写。公开资料只需提供可读的版本属性，不公开 ROM 二进制、对象存储 key 或内部校验细节。

补齐顺序不按“八种语言平均分摊”：先用真实游玩量、Search Console 的当地查询/点击、精确 ROM 覆盖和校对能力，挑一个市场把热门游戏做到“可判断”；再扩长尾或增加新 UI 语言。若暂无搜索数据，先从已有 ROM 覆盖与游玩量生成待办，不能把机器翻译条数当成语言市场需求。

### 单款游戏内容录入卡

编辑一款游戏时按这张卡收集资料；没有证据的字段写“未知/待核验”，不要按文件名、封面或系列印象补猜测。

```text
游戏身份
- 稳定 slug / 平台：
- 原始发行标题 / 对应发行版：
- 开发商 / 发行商 / 首发年份：
- 事实来源 URL（优先官方发行页、说明书或可信目录）：
- 最近核验日期：

每份可玩 ROM（每个 ROM 槽单独记录）
- 实际游戏语言（不是站点 UI 语言）：
- 发行地区 / 修订号 / 是否含汉化或改版：
- 玩家能识别的版本名称：
- 运行验证：是否到达可玩画面、设备/浏览器、验证日期：
- 真实支持：人数与联机方式、操作方式、存档类型、设备限制：

每种目标 UI 语言（只为有证据支持的语言填写）
- 页面显示标题（当地惯用正式名）：
- 标题核验来源 URL / 对应 ROM 地区或发行版 / 核验日期：
- 其他常用名（名称、语言、类别：官方名 / 罗马字 / 简称 / 地区名）：
- 经本地化编辑的简介：玩法、这份 ROM 的实际版本差异、玩家为何选它：
- 页面内可展示的来源或版本说明：

媒体
- 封面替代文字：
- 真实游戏画面截图与各自说明：
```

当前 `game_roms` 的主键是 `(game_id, lang)`，意味着一款游戏、一个语言槽目前只能绑定一份 ROM；同一语言下的多个地区版/修订版无法在现有槽位中单独表示。不要通过覆盖或错误标注来伪装多版本支持。若玩家确实需要在多个同语言版本间选择，P2 应先设计发行版实体/ROM 变体关系与前台选择器；只有每个独立落地页能提供足够独特且有用的版本信息时才拆成可索引 URL，否则保留一个游戏页、在页内区分可玩变体，避免造出内容近似的重复页。

## 分阶段实施

### P0：标题本地化链路（已部署；站长工具索引验证待补）

1. `games.title_localized`、后台按 ROM 语言显示标题框、SSR 标题选择与站内搜索索引链路已进入生产主分支；生产迁移与服务健康通过。
2. 生产 `seo:coverage -- --review` 的八种语言待办均为空；日文《火红》详情已验证 `<title>` 与 H1 显示「ポケットモンスター ファイアレッド」。
3. 后续抽查其它语言游戏时，仍需核对标题、H1、正文、Open Graph、Twitter、JSON-LD `name` / `alternateName` 与实际 ROM 版本一致。
4. Google URL Inspection、Bing URL Inspection 与实际收录状态尚未通过站长工具验证；不能仅凭 SSR 或本地测试推断搜索引擎已收录。

### P1：按可玩语言找游戏（功能已部署；收录效果待站长工具验证）

1. 游戏库“ROM 语言”筛选已支持分页、计数、SSR 首屏与可分享 URL。
2. 非空 ROM 语言均有专属目录页；页面标题和说明跟随 UI 语言，列表严格按 ROM 语言筛选。
3. 目录页已有稳定 canonical、互相引用的 hreflang；sitemap 只收非空且满足内容门槛的语言落地页。
4. 游戏详情继续采用正文语言门控：ROM 语言决定“可玩筛选”，只有真实本地化正文才让详情成为该语言的 hreflang / sitemap 页面。
5. 首页、游戏库、平台总览和类型总览都提供可抓取的普通链接；专题页分页与语言链接输出真实 `<a href>`，筛选按钮只负责交互。

### P2：补齐游戏实体与语言信息

1. 建立别名表，支持原名、地区名、译名、罗马字和常见简称；站内搜索按语言索引，避免把所有名称塞进页面标题。
2. 增加发行商、系列、地区/版本、产品编号与可验证外部实体 ID。现有 `game_roms` 每款游戏每种语言只支持一个槽位；同语言多个地区/修订版需要发行版实体或 ROM 变体模型。只有独立版本有足够独特内容时才建立独立可索引 URL，否则在同一详情页选择，避免相似页互相竞争。
3. 增加逐语言标签/关键词别名；页面显示本地化标签，搜索索引也能从别名找到游戏。
4. 八种 ROM 语言的标题与简介字段已通过生产 `seo:coverage -- --review` 检查；后续抽查翻译事实、游戏版本和当地惯用名，优先处理高游玩量条目。机器翻译可供玩家临时理解，但不能把批量翻译本身当作可索引价值；标题与正文须符合本站 ROM 实际版本。
5. 添加来源与核验时间字段，优先记录发行商、游戏手册或可信数据库来源，方便修正年份、发行地区和正式名称。
6. 只读覆盖报告已统计“有 ROM 但缺标题 / 简介”与仅有自动翻译的待办；后台是否需要同类计数视编辑流程再决定。字段覆盖全绿也不代表免于事实和语言质量校对。
7. 新语言的优先级由三项证据共同决定：Search Console 当地语言查询与国家需求、该语言真实 ROM 覆盖、标题/简介校对能力。葡萄牙语（巴西）、韩语、俄语、阿拉伯语、印地语、印度尼西亚语、土耳其语、越南语等可以进入候选队列，但当前没有当地查询与 ROM 覆盖数据，不能据语言人口直接排定先后顺序；上线一种新 UI 语言必须同时具备稳定 locale、完整 UI（含 RTL 等适用支持）、足量可玩条目和互相返回的 hreflang。

### P3：搜索与 AI 的机器可读实体图

1. 保留页面上能看见的 `VideoGame`、BreadcrumbList、WebSite、Organization 等信息；`VideoGame` 已通过稳定的 slug `@id` 关联不同语言页面，页面 `url` 仍遵循各自 canonical。该 ID 用于实体关联，不代表搜索引擎保证合并或收录这些 URL。
2. 在属性真实、页面可见且有可靠数据时增加 `alternateName`、发行商、系列、发行地区、玩家人数等 Schema.org 字段；不要用猜测或隐藏字段制造实体信息。
3. 只有真实免费可玩的网页游戏、并满足评分/评价门槛时，才组合 `VideoGame` 和 `WebApplication`，并发布与页面可见评分一致的 Offer 和 AggregateRating。
4. FAQPage 可以保留为问答语义信息，但不以 Google FAQ 富结果作为目标；Google 目前把该富结果限于少数权威政府/医疗网站。
5. 不依赖 `llms.txt`、AI 专用 schema 或隐藏提示替代 HTML。Google 官方说明 AI 搜索仍依赖普通搜索技术资格、索引和可显示摘要，不需要特殊文件或专用 schema；当前另有 Search Console 的“Search generative AI features”纳入状态和生成式 AI 表现报告，需单独确认。优先保证 SSR 正文、稳定 URL、普通内链、真实可抓取图片和与可见内容一致的结构化数据。Bing/Copilot grounding 同样依赖传统抓取、索引、清晰内容和权威信号。

### P4：监控抓取与收录，按数据迭代

1. 在 Google Search Console 验证站点属性并提交 sitemap；检查 Pages、Sitemaps、抓取统计、手动措施、安全问题、富媒体报告和各语言查询。另确认站点已纳入 “Search generative AI features”，读取生成式 AI 搜索/Discover 专门表现报告中的曝光 URL、国家、设备和时间趋势，并与常规 Search Performance 对照。Google 官方说明生成式 AI 曝光也计入整体表现；不能把专门报告缺失直接推断为零曝光，需先确认该属性/报告是否可用。
2. 在 Bing Webmaster Tools 导入 Search Console 数据并检查 sitemap、URL Inspection、IndexNow 接收/抓取状态；同时查看 AI Performance 中的引用页面、主题和趋势（若账号已开放相应报告），观察 Bing 与 Copilot grounding 的 URL 质量和新鲜度。IndexNow 只通知支持它的搜索引擎，不代替 Google Search Console。
3. 核对百度普通收录配置与每日任务，按中文站点情况监控提交接受数。
4. 检查 Cloudflare/WAF 是否让 Googlebot、Bingbot、OAI-SearchBot 等读取 HTML 和图片；`robots.txt` 放行不代表 CDN 一定放行。OpenAI 也要求主机/CDN 允许其公布的搜索爬虫 IP。
5. ✅ 已为公开合集制定可解释的索引与首页推荐规则：详情、sitemap、IndexNow 和首页推荐共用门槛；不达标合集仍可直接访问，不进入重点推荐。
6. 分别验证 OAI-SearchBot、Perplexity、Claude Search 等搜索抓取，以及 GPTBot / ClaudeBot 等训练抓取是否符合站长意愿；robots 放行只是源站策略，Cloudflare/WAF 与区域 CDN 日志才证明真实请求成功。OpenAI 官方把 OAI-SearchBot（搜索引用）和 GPTBot（潜在训练）分开控制；应根据站长对搜索发现和训练使用的偏好分别配置。若需要按 IP 验证 OpenAI 搜索爬虫，请使用其[官方 SearchBot IP 清单](https://openai.com/searchbot.json)，不要依赖短期日志中观察到的 IP。**2026-10-30 Microsoft 公布了跨提供商的 `__usage_ai-training` robots 偏好 token；2026-11-16 的 IETF Internet-Draft 仍属工作草案、不是正式 RFC。Microsoft 从 2027-02-01 起在重新抓取时开始遵守训练/grounding 偏好；训练偏好只控制内容用途，不改变 Bingbot 抓取资格，未设置时默认为允许。偏好规则要等 Microsoft 重新抓取页面后才生效；IndexNow 可以通知有更新，但不保证何时重抓。若希望新偏好继续限制原先由 `NoArchive` / `NoCache` 限制的用途，需在 2027-03-01 前完成设置；仅对 2026-12-15 仍使用旧指令的站点，Bing Webmaster 才提供过渡性的 grounding 设置。Bing AI Grounding 是独立的页面级设置，`DisallowExtended` 只允许 Microsoft 自营体验使用。**仓库 robots 当前只声明通用爬虫规则，按默认策略允许搜索、grounding 与训练；生产 CDN 响应头尚未核实，站长也尚未选择是否限制训练，所以本轮不加 AI 使用偏好。若选择“允许搜索引用、禁止训练”，后续应保留通用公开抓取规则，只添加训练用途偏好，并同步更新站内 robots 守卫和回归，不能用 `Disallow: /` 阻断搜索抓取。
7. 每月按语言、国家、平台、ROM 语言、展示、点击、CTR、平均排名和索引状态复盘；把“有 ROM 但无当地标题/简介”的游戏作为内容待办队列。
8. 用 Search Console Core Web Vitals / CrUX 真实用户数据检查首页、游戏库、ROM 语言专题和游戏详情，按移动端/桌面端及主要地区拆分。目标是第 75 百分位 LCP ≤ 2.5 秒、INP ≤ 200 毫秒、CLS ≤ 0.1；实验室 Lighthouse 用来定位问题，不能替代真实用户数据，也不要为追满分牺牲主内容质量。⚠️ 本轮 CrUX 源站级基线两端未通过，移动端 CLS 0.64 / LCP 3.9 秒、桌面 LCP 3.6 秒；先取到分路由的现场数据并修根因，再看趋势。

## 完成验收标准

- 每个公开详情页的标题、H1、canonical、描述和结构化数据一致；本地化名与页面可见内容一致。
- 用户能从目录页筛出真正含目标语言 ROM 的游戏；筛选结果的 SSR HTML 和普通链接可直接被爬虫理解。
- sitemap 只含返回 200、可索引、canonical 正确且内容达标的 URL；没有空语言 sitemap、重复回退页或下线游戏。
- hreflang 只关联内容真实本地化的版本，并在每个版本间互相返回。
- Google、Bing、百度和 AI 爬虫在实际线上环境中不被 robots、WAF、登录态、区域规则或 CDN 挑战拦截。
- Search Console / Bing Webmaster 中已检查 URL 和索引状态，而不仅是本地测试通过或推送接口返回成功。

## 历史验收快照（2026-11-26；当前状态请看上方 2026-11-28 生产复核）

| 目标 | 当时证据 | 当时状态 |
|---|---|---|
| 页面可被发现与抓取 | 2026-11-26 只读公网巡检：`robots.txt`、sitemap index 与全部 26 个子 sitemap 均 HTTP 200；全部 XML 可解析；抽查游戏、博客、分类、平台、首页和首页推荐合集均有 SSR、正确 canonical 且未被 noindex；五类 UA 的 robots / sitemap 也均为 200 | 普通 UA 与伪装的搜索 UA 可读取；真实搜索爬虫身份、实际边缘策略仍需 Cloudflare/WAF 日志确认。历史 Python 403 本轮未复现 |
| 按 ROM 语言找游戏 | 全量 SSR 目录：简中299、繁中37、英文558、西语111、法语61、意大利语52、德语57、日语149；全部分页均有普通详情链接。对应详情 sitemap 为284、4、520、22、17、14、16、26 | 目录入口和 SSR 抓取通过；简体 / 英文覆盖高，其它语言详情仍受正文门槛限制；数字不代表收录量 |
| 游戏标题与正文本地化 | 全量目录中：简中 288/299 有中文名；繁中 0 个手工标题、1 个自动繁体名、36 个回退简体名；英文 558/558 有原题；西、法、意、德、日 0/430 有对应语言标题。日文、西语未缓存详情的 H1 / title / OG / Twitter / VideoGame.name 仍全为英文 | 后台标题表单存在于工作区，线上标题数据缺失；人工正文质量仍需核对。详情标题信号“彼此一致”不能保证语言正确 |
| 用本地标题站内搜索 | 旧分词器对日文假名、韩文、俄文、阿拉伯文实测为 0 个 token；工作区 Unicode 分词与 52 项回归通过，回填脚本已纳入逐语言标题 | 代码已修复；未部署，且生产 `game_search_tokens` 尚未全量回填 |
| 页面实体标识 | 本轮 Cloudflare `MISS` 的日文 / 西语源站详情 JSON-LD 均未见 `VideoGame.@id`；工作区已有稳定 slug ID 改动 | 线上尚未反映该改动，需部署后复查 |
| 搜索与 AI 的实际收录 | 公开搜索快照只能作线索；没有 Search Console / Bing Webmaster 的 URL Inspection、查询与索引报告，也未确认 Search Console 的生成式 AI 纳入状态/报告或 Bing AI Performance 可用性 | 未验证 |
| AI 搜索与训练偏好 | 仓库 robots 只有 `User-agent: *`，公开路径允许；没有 `__usage_ai-training` 偏好 token，也没有 `NoArchive` / `NoCache` 配置。生产响应头、meta 与站长对训练用途的偏好未确认 | 当前默认允许搜索和训练。Microsoft 自 2027-02-01 起在重新抓取时执行偏好；若生产仍用 `NoArchive` / `NoCache` 且要保留相关限制，需在 2027-03-01 前完成过渡 |
| 爬虫访问权限 | 最新普通浏览器 UA 巡检访问 robots 与 26 个 sitemap 均成功；普通浏览器、Googlebot、Bingbot、OAI-SearchBot、Python UA 的只读对比均返回 200；工作区 15 分钟巡检检查同一组公开入口 | 当前测试出口与 UA 组合均可读；真实搜索爬虫身份是否放行仍需日志，定时巡检部署状态另行核实 |
| 页面体验 | CrUX 源站移动与桌面均未通过；首屏封面优先级代码调整已通过回归与类型检查 | 代码已调整、未部署复测；真实 CLS 根因未定位 |

## 下一步执行顺序

1. 为《黄金矿工双人版》的 2008 年份保留 4399 来源记录；其生产英文 ROM 已与 Flash 保存计划馆藏精确匹配，但公开资料只证明 `Villivateur` 是档案来源、`wyc` 是 4399 投稿账号，不能作为开发者署名。对《1944》，英文和日文标题已改为 NES《1943》改版的名称；继续核验两个 ROM 的确切版本，以及现有 1990 年是否适用于本站文件，开发者保持未知。
2. 按 2026-11-28 生产只读 SQL 确认的当前缺口逐条核验：`cat-mario-flash` 缺年份和开发者，`gold-miner-2-player` 与 `1944-the-loop-master` 缺开发者。优先找发行商、说明书、可信游戏数据库或作品官网证据；缺乏可靠来源时保留“未知”，不要为填满字段而猜测。旧计划中的“8 款”已过期；Kartboard、Pokecatch、腾讯 Flash 小游戏和 Game Store Simulator 的已核实字段均已补齐。
3. 评估 `/collections` 到 noindex 合集的普通链接是否值得作为搜索入口；保留用户直接访问路径与合集的社区用途，不代作者改写描述。
4. 用生产 `seo:coverage -- --review` 做上线前后的字段回归；当前报告无待办，新增或替换 ROM 后再复核对应语言的标题、简介和 ROM 绑定。
5. 连接 Search Console / Bing Webmaster 的只读数据源，取近 3 个月按国家、查询词、落地页、语言和设备拆分的表现与索引状态；同时检查生成式 AI 表现报告是否可用，并从 Cloudflare / EdgeOne 取近 7 天真实爬虫状态码。
6. 更新 PSI 报告并用 Search Console 路由级 CWV 与真实页面布局位移记录定位 CLS；实验室 CLS=0 不能替代真实用户数据。
7. 对 Googlebot、Bingbot、OAI-SearchBot 等搜索抓取与 GPTBot 等训练抓取分别核验 robots 意图、CDN/WAF 状态和站长偏好；搜索引用抓取与模型训练政策分开记录。Microsoft 从 2027-02-01 起按重新抓取结果执行新偏好；生产是否使用旧 `NoArchive` / `NoCache` 尚未核验，若使用且希望原有限制继续生效，按 2027-03-01 过渡截止日期处理。

## 尚需站长侧证据

截至 2026-11-28，已通过 SSH 只读运行生产 `seo:coverage` 并核对公开 SSR 页面；数据库层标题 / 简介覆盖和合集索引门槛已有最新值。Search Console、Bing Webmaster、百度搜索资源平台与 Cloudflare / EdgeOne 日志仍未连接，生产推送任务是否启用也尚未读取。当前未验证各平台真实收录量、重复 / 抓取失败 URL、查询词、生成式 AI 报告可用性、推送接收情况及真实爬虫的 WAF 放行状态。普通浏览器或伪装 UA 返回 200 不足以证明真实爬虫已成功访问。若后续接入站长工具只读数据，可按国家、查询词和落地页继续量化。

要完成线上结果审计，请提供最近 3 个月的 Search Console「效果」与「网页索引」导出、Sitemaps/URL Inspection 的代表性结果，以及 Bing Webmaster 的 IndexNow/Site Explorer 状态；若可用，再补 Cloudflare 最近 7 天 Googlebot/Bingbot/OAI-SearchBot 请求的状态码分布。导出前移除账号、令牌和用户隐私信息。

## 参考标准

- [Google JavaScript SEO](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics)：内容放在初始 SSR HTML、链接使用可解析的 `<a href>`，降低渲染阶段对抓取的依赖。
- [Google 多语言/区域版本](https://developers.google.com/search/docs/specialty/international/localized-versions)：同一正文的语言版本需互相声明 hreflang；只翻导航等模板、主体仍是同一语言时不能当作充分本地化内容。
- [Google 搜索如何工作](https://developers.google.com/search/docs/fundamentals/how-search-works)：sitemap 有助于发现 URL，但不保证抓取、收录或排名；最终需看 Search Console 里的真实处理结果。
- [Google 搜索标题链接](https://developers.google.com/search/docs/appearance/title-link)与[搜索摘要](https://developers.google.com/search/docs/appearance/snippet)：标题链接会综合 `<title>`、H1、显著文本、OG title 和外部锚文本；标题语言/书写系统与正文不匹配时可能被改写，meta description 也不保证成为最终摘要。
- [Google AI 搜索功能说明](https://developers.google.com/search/docs/appearance/ai-features)：进入 AI 搜索结果仍需普通搜索的技术资格和可索引页面，没有额外的 AI 标记或专用文件要求。
- [Google 生成式 AI 搜索优化指南](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)：说明 AI 搜索依赖普通搜索与有用内容、无需 `llms.txt`/特殊 schema，并介绍 Search Console 的生成式 AI 纳入状态和专门表现报告（页面最近于 2026-07-10 更新）。
- [Google Search Generative AI 表现报告公告](https://developers.google.com/search/blog/2026/06/gen-ai-performance-reports)：报告查看生成式 AI Search / Discover 曝光、页面、国家、设备与时间；官方公告称 2026-08-31 起向全球站点开放。
- [Google 搜索垃圾内容政策](https://developers.google.com/search/docs/essentials/spam-policies)：政策不按“是否用了 AI/机器翻译”单独判定；风险在于大量近似、难读或缺少实际帮助的页面。上线语言页前要核实标题、ROM 版本、玩法说明和正文确实对该语言玩家有用，不能靠批量翻译把八种 URL 都塞进 sitemap。
- [Google Core Web Vitals](https://developers.google.com/search/docs/appearance/core-web-vitals)：以真实用户第 75 百分位评估 LCP、INP、CLS 的建议阈值，并按移动/桌面观察。
- [Google 结构化数据政策](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)与 [SoftwareApplication 指南](https://developers.google.com/search/docs/appearance/structured-data/software-app)：结构化数据必须对应页面可见内容；VideoGame 单一类型没有 Software App 富结果，组合类型也仍需满足评价/价格条件，不能承诺展示。
- [OpenAI 爬虫文档](https://developers.openai.com/api/docs/bots)与[发布者说明](https://help.openai.com/en/articles/12627856-publishers-and-developers-faq)：OAI-SearchBot 搜索引用抓取与 GPTBot 训练抓取是分开的站长控制项，CDN/防火墙也需放行发布的 IP 范围。
- [Microsoft 训练 / grounding 偏好说明](https://blogs.bing.com/search/2026/10/your-content-your-choice-clearer-preferences-for-training-and-grounding)与[IETF 训练偏好草案](https://datatracker.ietf.org/doc/draft-kelley-aipref-training-preference-signal/)：`__usage_ai-training` 是内容使用偏好 token，不是新的抓取机器人；Microsoft 表示从 2027-02-01 起随抓取执行新偏好，未设置时默认允许，偏好须等重新抓取后才会生效；IndexNow 能提示更新但不保证重抓时间。训练 / grounding 使用偏好不改变传统 Bing 搜索资格。2027-03-01 的过渡截止只关系到旧 `NoArchive` / `NoCache` 限制的延续；过渡性 grounding 设置仅向 2026-12-15 仍使用旧指令的站点开放。IETF 文件仍是工作草案，应在实际采用前再次核对版本。
- [Bing Webmaster 指南](https://www.bing.com/webmasters/help/webmaster-guidelines-30fba23a)：sitemap 应只列规范 URL 并保持 lastmod 准确；IndexNow 用于通知更新，不替代索引状态检查。
- [Bing Webmaster AI Performance 帮助页](https://www.bing.com/webmasters/help/?topicid=9f8e7d6c)：若账号已开放报告，可看页面引用、主题和趋势；它衡量可被 Bing 索引并出现在 AI 搜索/grounding 中的内容，不能替代传统索引与抓取诊断。
