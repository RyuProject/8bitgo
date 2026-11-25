# 8BitGo 国际搜索与 AI 可发现性方案

更新日期：2026-11-25

目标：让玩家用自己的语言、游戏名、平台、类型和版本信息找到真正能玩的游戏；让搜索引擎与 AI 抓取器能直接读懂页面、语言、可玩版本和实体关系。

## 审计结论

### 已具备的基础

- `/en`、`/ja` 首页和英文游戏详情页经公开抓取验证，能读到服务端渲染的标题、正文和普通站内链接，不依赖先运行客户端 JavaScript 才出现目录内容。
- 页面有语言前缀、canonical、hreflang、Open Graph、JSON-LD；游戏、文章、分类等 sitemap 由服务端维护。
- 游戏详情页的 hreflang 按页面是否有独立正文生成；详情 sitemap 还会额外校验存在对应或通用 ROM，JSON-LD 单独声明实际绑定的 ROM 语言。ROM 语言专题页只统计显式语言槽，不把通用 `*` ROM 算作日文等专属版本。
- `robots.txt` 的仓库版本允许公开页面和通用爬虫，避开后台、个人页、登录页和 API；媒体接口例外允许抓图。公开抓取工具无法直接读取线上 `robots.txt` 和 sitemap XML，因此线上文件内容与 HTTP 状态仍需在 Search Console URL 检查中复核。
- 内容变更已有 IndexNow、百度推送队列与每日补交脚本；生产环境是否启用由 `server/.env` 决定，本次无法检查运行时环境。
- 现有 SEO 回归覆盖页面标题、描述、noindex/follow、图片 alt、canonical、sitemap 语言门控等。

### 本轮公开页面抽查（2026-11-25）

- 本轮通过可见浏览器再次复查线上 `/ja/rom-language/ja`：147 款、每页 24 款、7 页分页和普通详情链接均正常；首屏 `Pokémon FireRed`、`Contra`、`Rhythm Heaven` 等标题仍为英文。随后抽查 `/ja/games/pokemon-firered`，浏览器标题与 H1 都是 `Pokémon FireRed`；日文正文是自动翻译，仍有生硬或不准确表达。由此确认用户可见的本地化缺口，不把它误判成专题页抓取故障。
- **线上 `/ja/rom-language/ja` 曾有真实故障**：本地化 `<title>`、H1 和说明正常，但列表区域显示“服务器内部错误”。根因是该路由引用了 `/games` 条件分支里的局部变量 `visiblePlatforms`，触发 `ReferenceError`；修复已将平台范围提升到共享路由数据作用域，并把 `/rom-language/ja` 加入 `test:nowasm-lists`。部署记录标记 `23d74ce` 于 2026-11-25 发布，并记录直接请求为 HTTP 200、SSR 有 147 款总数、首屏 24 款清单及第 2–7 页链接。本轮浏览器复查独立确认页面能显示 147 款、24 款首屏和 7 页导航；浏览器工具没有提供响应头或原始 HTML，因此本轮不独立断言状态码与 SSR 源码。
- 部署后复核 `/api/health` 返回 HTTP 200 且 `db: true`。专题 HTML 保留 self-canonical、8 个语言 `hreflang` 与 `x-default`、日文 meta description；这只验证了站点实际响应与 SSR 输出，搜索引擎是否抓取和收录仍需在 Search Console / Bing Webmaster 查看。平台、类型与 ROM 语言目录在站内数据请求失败时会切换为 `noindex,follow`，降低临时错误页被索引的风险。
- 日文游戏库卡片仍显示不少英文原名，例如 `The King of Fighters ’97`、`Pokémon FireRed`。当前源码的 `gameTitle()` 与服务端 mapper 都支持读取 `titleLocalized`，因此更像是这些游戏的日文校对标题尚未填；但生产公开 API 在本轮浏览器中被拦截，且本地数据库报告无法连接，所以暂不能把“数据未填”当作已证实根因。标题覆盖率仍需数据库报告和生产后台保存抽查确认。
- 再次复核日文详情 `/ja/games/pokemon-firered`：浏览器标题和 H1 都仍是英文 `Pokémon FireRed`；简介是长篇日文自动翻译，存在不自然表达；“1人用”与通用操作说明里列出 2P 键位也不一致。当前首要内容缺口是为真实日文 ROM 补人工标题，并校对简介、人数和操作说明，而不是继续扩写模板文字。
- 2026-11-25 再次按精确路径查询公开搜索：没有返回 `/ja/rom-language/ja` 或 `/ja/games/pokemon-firered`；`/ja/games` 和 `/ja/genres/adventure` 仍能被搜到，但快照约两个月前，卡片标题仍大量为英文。`/ja/games/pokemon-pearl` 的搜索快照约一周前，正文已有日文内容，但结果标题仍显示英文 `Pokémon Pearl`；默认 `/games/pokemon-firered` 的快照约四周前则显示中文标题与正文。搜索快照可能滞后或不完整，这些结果不能证明 URL 未收录或 Google 当前采用的页面标题，只能作为 Search Console URL Inspection 的核对样本。
- 2026-11-25 的公开搜索快照可搜到日文首页（当天抓取），但卡片标题仍有大量英文；首页推荐区还出现了 `pokemon` 等单款清单，且日文、德文、西班牙文快照均展示按 UI 语言拼出的模板说明。现已部署首页推荐索引门槛，搜索结果和旧快照不会即时刷新。
- 浏览器将 `/robots.txt` 和 API 路径拦为 `ERR_BLOCKED_BY_CLIENT`，搜索工具也无法读取线上 `robots.txt`、sitemap XML；本轮直接请求还因当前执行环境无法解析 `8bitgo.com` 而失败。以上都是检查通道限制，不能当作线上文件错误或成功的证据。专题页当前 UI 可读，错误状态是部署前的历史记录。

### 本次公开抓取发现的内容质量风险

- 线上抽查 `/ja/collections/14`：标题只有 `pokemon`、没有说明、只含 1 款游戏；页面依然公开，且旧规则会将所有 `hidden = 0` 合集提交到 sitemap。现在工作区加了统一的内容门槛：至少 5 款可见游戏，或至少 3 款并有 120 个字符说明，或至少 1 款并有 300 个字符说明。门槛只影响索引信号、sitemap / IndexNow 补交和首页推荐；不隐藏合集、不改变玩家直接访问。以共享函数同步详情 `noindex`、sitemap、IndexNow 和首页推荐筛选，避免规则漂移。这个规则是保守的运营启发式，拿到 GSC 展示/点击与合集互动数据后应复核，不把字符数当作内容质量的唯一判据。
- `/robots.txt` 和 `/sitemap.xml` 在本次公开抓取工具中无法读取。仓库配置看起来允许公开爬虫，但线上 HTTP 状态、重定向、CDN/WAF 拦截仍未验证。
- 仓库 `robots.txt` 只有通用 `User-agent: *` 组，允许公开目录里的搜索爬虫与 AI 搜索爬虫，且 `/api/` 继续屏蔽；同一规则目前也允许 GPTBot、ClaudeBot 等 AI 训练爬虫。搜索引用抓取与模型训练是不同用途，之后应根据站长偏好分别定策略；更改时必须保留后台/个人页的禁止规则，不能用一个点名 `Allow: /` 的专属组绕过它们。OpenAI 当前说明 OAI-SearchBot 用于 ChatGPT 搜索发现，GPTBot 则可由站长选择排除训练；若依赖 robots 控制搜索收录，还必须允许 OAI-SearchBot 读取页面，单靠 robots 放行也不能代替对 CDN/WAF/挑战页的实测。见[发布者说明](https://help.openai.com/en/articles/12627856-publishers-and-developers-faq)。

### 当前仓库具备的实现（线上状态需逐项验收）

- 当前 `main` 分支游戏后台已有 `title_localized` 字段，只在游戏绑定对应站点语言 ROM 时显示标题框。英文和简体中文仍使用原有字段；繁体优先人工校对名，再回退自动转换名。本轮没有在生产后台编辑或保存数据，也没有核实有多少条已填写。
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
- 2026-11-25 收口合集质量门槛：首页推荐、详情页 `noindex`、合集 sitemap 与 IndexNow 补交共用同一可见游戏数 / 原创说明判据；首页不会被新建的低信息清单挤满，卡片数量也不会把下架游戏算入。`npm --prefix server run test:collections`（101 项）、`npm run test:i18n-content`（9 项）、`npm run test:sitemap`、`npm run test:indexnow`（41 项）、`npm run test:seo-meta`、`npm run test:seo-performance`、`npm run test:robots`（42 项）、`npx tsc -b --pretty false`、`npm run build:server`、改动脚本语法检查与 `git diff --check` 均通过。
- `npm run build` 与 `npx tsc -b --pretty false` 均通过；完整构建包括 614 模块客户端构建、495 模块 SSR 构建、运行时语法门禁、EmulatorJS 产物一致性、浏览器兼容、资源完整性、懒加载图和预构建模拟器回归门禁。

### 目前最明显的产品缺口

ROM 语言目录和筛选入口已在线可见；部署后 `/ja/rom-language/ja` 已可见完整清单。当前最明显的短板转为内容覆盖：日文 ROM 目录有 147 款，但热门列表和详情仍显示英文原名，逐语言标题与独立简介的实际填充率尚未读取。下一步应取得数据库覆盖报告，按游玩量先补标题和经校对的简介；同时在 Google/Bing 站长工具确认专题页索引状态。

当前仓库新增了只读覆盖报告：`cd server && npm run seo:coverage`。它按八种站点语言统计可见游戏中的精确 ROM、标题、独立简介、人工校对稿和“ROM+标题+简介”完整度；默认只输出汇总数量，不输出游戏名或对象存储地址。追加 `-- --todo --limit 20` 会按游玩量列出每种语言最值得先补的标题/简介缺口。报告把通用 `*` ROM 单列，不冒充语言目录覆盖。

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
| 对应 ROM 的逐语言标题 | `titleLocalized` 后台字段已有 | **语言落地页必填**。仅给真正绑定该语言 ROM 的游戏填；用当地玩家实际搜索的正式标题，避免把纯音译当唯一名称 |
| 别名、罗马字、地区标题 | 还没有独立字段；部分散落在 tags / 标题中 | **高优先级**。新增规范化别名数据供站内搜索与实体消歧，保存 alias 类型和语言；只展示对玩家有用的别名，不隐藏堆词 |
| 简介 | `description`、`descriptionEn`、自动翻译与 `descriptionLocalized` 已有 | **每个要收录的语言都要有人工校对正文**。写游戏核心玩法、版本差别和“为什么这一版可玩”；避免只替换游戏名的模板句 |
| ROM 语言、地区、修订版 | `roms` 可按语言绑定；地区/修订版无统一字段 | **ROM 语言必填且实测**；地区、世界版/日版、PAL/NTSC、修订号要在可区分发行版时补，不能从封面或文件名猜 |
| 平台、受控类型、年份、开发商 | 平台/类型/年份/开发商已有 | **推荐补齐**。平台和类型来自受控词表；年份区分首次发行年份与本站上架时间；开发商与发行商分开记录 |
| 发行商、系列、权威实体 ID / 来源 | 无统一字段 | **第二阶段**。有权威来源再新增，保留 source URL 与核验时间；`sameAs` 只指向确实唯一识别该游戏的权威实体 |
| 玩家数、多人模式、控制、存档提示 | 玩家数 / 联机能力已有，操作与电池存档提示不完整 | **推荐补齐真实验证信息**。分别写本地同屏/在线联机、支持人数、键位、即时存档与游戏内存档，不要把引擎理论能力当游戏支持 |
| 封面、截图、视频 | 封面和卡片视频已有，缺少多张游戏截图字段 | **优先封面与 2–4 张真实画面截图**。图片需可匿名访问、稳定且压缩合理；alt 描述画面内容。仅在视频有真实标题、说明、缩略图和时长时标 VideoObject |
| 人工评分与评价 | 站内有真实评分聚合 | 只在页面同时展示同一批评分、人数和平均分时输出 `AggregateRating`；从未评分的游戏不输出。不得用站点编辑分冒充用户评价 |

Google 不使用 `meta keywords` 作为排名捷径。关键词应体现在准确的标题、可见正文、类别、站内链接和可验证的游戏属性中。

## 分阶段实施

### P0：核验标题本地化并安全上线

1. 先迁移生产数据库，再构建和重启应用。
2. 用后台编辑一款至少有英文、简体中文和另一语言 ROM 的游戏，检查语言标题框只随实际绑定的 ROM 出现，并保存、刷新后仍保留。
3. 分别检查该游戏各语言详情页：`<title>`、H1、正文、Open Graph、JSON-LD 的 `name` / `alternateName` 与玩家可见标题一致。
4. 用 Google URL Inspection 和 Rich Results Test 验证线上 HTML、canonical、hreflang、图片抓取与结构化数据；不要只凭本地单测推断线上结果。

### P1：让人按可玩语言找游戏（工作区已实现，待部署验收）

1. 在游戏库添加“ROM 语言”筛选，支持分页、计数、SSR 首屏和可分享 URL。
2. 建立每种非空 ROM 语言的专属目录页；页面标题与说明按 UI 语言翻译，游戏列表严格按 ROM 语言过滤。
3. 为这些目录页添加稳定 canonical、完整且互相引用的 hreflang；只把非空、返回 200 的落地页加入 sitemap。
4. 游戏详情保留现有正文语言门控：ROM 语言可决定“可玩筛选”，但只有真实本地化正文才能让详情页成为该语言的独立 hreflang / sitemap 页面。
5. 首页、游戏库、平台总览和类型总览现在都提供可抓取的普通链接入口；专题页分页与语言链接输出真实 `<a href>`，筛选按钮只用于交互筛选。

### P2：补齐游戏实体与语言信息

1. 建立别名表，支持原名、地区名、译名、罗马字和常见简称；站内搜索按语言索引，避免把所有名称塞进页面标题。
2. 增加发行商、系列、地区/版本、产品编号与可验证外部实体 ID。对会改变 ROM 内容的地区版本，必要时拆成独立条目或发行版子实体。
3. 增加逐语言标签/关键词别名；页面显示本地化标签，搜索索引也能从别名找到游戏。
4. 为优先市场的游戏补人工简介、别名和真实 ROM 语言。先覆盖真实可玩的热门目录，再扩展长尾；机翻结果要经过抽样人工复核。
5. 添加来源与核验时间字段，优先记录发行商、游戏手册或可信数据库来源，方便修正年份、发行地区和正式名称。
6. 后台按“有真实 ROM 但缺本地化标题/简介/别名”的语言显示内容待办计数；先翻译有真实玩家需求的热门游戏，不要把 587 款目录机械地机器翻译成 8 份薄页。
7. 新语言的优先级由三项证据共同决定：Search Console 当地语言查询与国家需求、该语言真实 ROM 覆盖、标题/简介校对能力。葡萄牙语（巴西）、韩语等可以进入候选队列，但在数据出来前不承诺先后顺序；上线一种新 UI 语言必须同时具备稳定 locale、完整 UI、足量可玩条目和互相返回的 hreflang。

### P3：搜索与 AI 的机器可读实体图

1. 保留页面上能看见的 `VideoGame`、BreadcrumbList、WebSite、Organization 等信息；同一游戏的不同语言页面共享稳定实体 ID，页面 URL 仍遵循各自 canonical。
2. 在属性真实、页面可见且有可靠数据时增加 `alternateName`、发行商、系列、发行地区、玩家人数等 Schema.org 字段；不要用猜测或隐藏字段制造实体信息。
3. 只有真实免费可玩的网页游戏、并满足评分/评价门槛时，才组合 `VideoGame` 和 `WebApplication`，并发布与页面可见评分一致的 Offer 和 AggregateRating。
4. FAQPage 可以保留为问答语义信息，但不以 Google FAQ 富结果作为目标；Google 目前把该富结果限于少数权威政府/医疗网站。
5. 不依赖一个 AI 专用文件或隐藏提示替代 HTML。优先保证 SSR 正文、稳定 URL、可抓取图片、普通内链、真实结构化数据和更新推送。

### P4：监控抓取与收录，按数据迭代

1. 在 Google Search Console 提交 sitemap，检查 Pages、Sitemaps、抓取统计、手动措施、安全问题、富媒体报告和各语言查询。
2. 在 Bing Webmaster Tools 导入 Search Console 数据并检查 sitemap、URL Inspection、IndexNow 接收/抓取状态；IndexNow 只通知支持它的搜索引擎，不代替 Google Search Console。
3. 核对百度普通收录配置与每日任务，按中文站点情况监控提交接受数。
4. 检查 Cloudflare/WAF 是否让 Googlebot、Bingbot、OAI-SearchBot 等读取 HTML 和图片；`robots.txt` 放行不代表 CDN 一定放行。OpenAI 也要求主机/CDN 允许其公布的搜索爬虫 IP。
5. ✅ 已为公开合集制定可解释的索引与首页推荐规则：详情、sitemap、IndexNow 和首页推荐共用门槛；不达标合集仍可直接访问，不进入重点推荐。
6. 分别验证 OAI-SearchBot、Perplexity、Claude Search 等搜索抓取，以及 GPTBot / ClaudeBot 等训练抓取是否符合站长意愿；robots 放行只是源站策略，Cloudflare/WAF 与区域 CDN 日志才证明真实请求成功。若需要按 IP 验证 OpenAI 搜索爬虫，请使用其[官方 SearchBot IP 清单](https://openai.com/searchbot.json)，不要依赖短期日志中观察到的 IP。
7. 每月按语言、国家、平台、ROM 语言、展示、点击、CTR、平均排名和索引状态复盘；把“有 ROM 但无当地标题/简介”的游戏作为内容待办队列。

## 完成验收标准

- 每个公开详情页的标题、H1、canonical、描述和结构化数据一致；本地化名与页面可见内容一致。
- 用户能从目录页筛出真正含目标语言 ROM 的游戏；筛选结果的 SSR HTML 和普通链接可直接被爬虫理解。
- sitemap 只含返回 200、可索引、canonical 正确且内容达标的 URL；没有空语言 sitemap、重复回退页或下线游戏。
- hreflang 只关联内容真实本地化的版本，并在每个版本间互相返回。
- Google、Bing、百度和 AI 爬虫在实际线上环境中不被 robots、WAF、登录态、区域规则或 CDN 挑战拦截。
- Search Console / Bing Webmaster 中已检查 URL 和索引状态，而不仅是本地测试通过或推送接口返回成功。

## 尚需站长侧证据

本轮没有连接 Search Console、Bing Webmaster、百度搜索资源平台或 Cloudflare 账户，也没有读取服务器 `.env`。只读语言覆盖脚本语法通过，但运行时本机数据库 `127.0.0.1:3307` 拒绝连接，因此没有真实数据库覆盖数字。以下结论尚未验证：各平台实际收录量、重复/抓取失败 URL、真实查询词、推送任务是否启用、WAF 对 AI 爬虫的放行情况。

要完成线上结果审计，请提供最近 3 个月的 Search Console「效果」与「网页索引」导出、Sitemaps/URL Inspection 的代表性结果，以及 Bing Webmaster 的 IndexNow/Site Explorer 状态；若可用，再补 Cloudflare 最近 7 天 Googlebot/Bingbot/OAI-SearchBot 请求的状态码分布。导出前移除账号、令牌和用户隐私信息。

## 参考标准

- [Google JavaScript SEO](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics)：内容放在初始 SSR HTML、链接使用可解析的 `<a href>`，降低渲染阶段对抓取的依赖。
- [Google 多语言/区域版本](https://developers.google.com/search/docs/specialty/international/localized-versions)：同一正文的语言版本需互相声明 hreflang；只翻导航等模板、主体仍是同一语言时不能当作充分本地化内容。
- [Google 搜索如何工作](https://developers.google.com/search/docs/fundamentals/how-search-works)：sitemap 有助于发现 URL，但不保证抓取、收录或排名；最终需看 Search Console 里的真实处理结果。
- [Google 结构化数据政策](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)与 [SoftwareApplication 指南](https://developers.google.com/search/docs/appearance/structured-data/software-app)：结构化数据必须对应页面可见内容；VideoGame 单一类型没有 Software App 富结果，组合类型也仍需满足评价/价格条件，不能承诺展示。
- [OpenAI 发布者说明](https://help.openai.com/en/articles/12627856-publishers-and-developers-faq)：OAI-SearchBot 搜索引用抓取与 GPTBot 训练抓取是分开的站长控制项。
- [Bing Webmaster 指南](https://www.bing.com/webmasters/help/webmaster-guidelines-30fba23a)：sitemap 应只列规范 URL 并保持 lastmod 准确；IndexNow 用于通知更新，不替代索引状态检查。
