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

- 用 Codex 内置浏览器复查线上 `/ja/games` 与 `/ja/games?romLanguage=ja`：目录显示 660 款，日语 ROM 计数为 147，且有指向 `/ja/rom-language/ja` 的普通链接；筛选页实际显示 147 款、每页 24 款，并有可点击的分页链接。首屏高人气样本仍显示 `Pokémon FireRed`、`Contra`、`Rhythm Heaven` 等英文原名。由此确认当前 UI 没有充分展示日文标题；仅凭页面无法区分是 `title_localized` 未填，还是响应数据未带该字段，覆盖报告仍需连到数据库核实。
- **线上 `/ja/rom-language/ja` 当前有真实故障**：本地化 `<title>`、H1 和说明正常，但列表区域显示“服务器内部错误”。详情页入口和筛选页能正常加载，故障限于稳定专题路由。工作区代码中该路由引用了在 `/games` 条件分支内部声明的 `visiblePlatforms`，会触发 `ReferenceError`；本轮已将它提升到共享作用域，并把 `/rom-language/ja` 加入 `test:nowasm-lists` 回归覆盖。修复还在工作区，尚未部署，线上该错误仍未消除。
- 同一专题页浏览器 DOM 有 self-canonical、8 个语言 `hreflang` 与 `x-default`、日文 meta description；错误内容由客户端加载后显示。不能仅凭浏览器 DOM 推断直接访问的 HTTP 状态或索引结果：`server/src/ssr.js` 的 SSR 失败分支会回 `503`、`no-store` 和 `Retry-After: 60`，本次浏览器工具无法读取线上响应状态。另已让平台、类型与 ROM 语言目录在站内数据请求失败时切换为 `noindex,follow`，减少客户端路由失败后残留的空错误页被索引的风险。修复部署后仍须检查 147 款清单是否出现在真实 SSR HTML。
- 日文游戏库卡片仍显示不少英文原名，例如 `The King of Fighters ’97`、`Pokémon FireRed`。这与“字段可按 ROM 语言录入”不是同一问题：标题选择逻辑已支持日文名，线上实际填充覆盖率仍需数据库报告确认。
- 外部 `site:` 搜索本轮能看到 `/ja/games`、`/ja/genres/adventure` 等日文 URL，但没有返回 `/ja/rom-language/ja`；可见游戏库快照约两个月前且只报 305 款，浏览器此刻实际显示 660 款。聚合搜索的快照不是 Google Search Console 数据，不能据此断言 Google 当前收录数或抓取延迟；但足以把 sitemap 处理时间、页面 lastmod 和 URL 检查列为上线后验收项。
- 浏览器将 `/robots.txt` 和 API 路径拦为 `ERR_BLOCKED_BY_CLIENT`，搜索工具也无法读取线上 `robots.txt`、sitemap XML；这是当前检查通道的限制，不能当作线上文件错误或成功的证据。页面本身的 UI 访问则已验证专题错误。

### 本次公开抓取发现的内容质量风险

- 首页公开合集区出现过标题只有 “pokemon” / “Game” 且只含 1–2 款游戏的用户合集；目前 sitemap 会提交所有 `hidden = 0` 的合集详情。它们可能有社区价值，但作为搜索落地页的独立信息量偏少。建议单独定义可解释的收录门槛，并让首页合集区采用更严格的质量筛选。不要只按标题字数自动删页；先确定有用的描述、游戏数量和维护状态规则，再对低信息页 noindex 并从 sitemap 排除。
- `/robots.txt` 和 `/sitemap.xml` 在本次公开抓取工具中无法读取。仓库配置看起来允许公开爬虫，但线上 HTTP 状态、重定向、CDN/WAF 拦截仍未验证。
- 仓库 `robots.txt` 只有通用 `User-agent: *` 组，允许公开目录里的搜索爬虫与 AI 搜索爬虫，且 `/api/` 继续屏蔽；同一规则目前也允许 GPTBot、ClaudeBot 等 AI 训练爬虫。搜索引用抓取与模型训练是不同用途，之后应根据站长偏好分别定策略；更改时必须保留后台/个人页的禁止规则，不能用一个点名 `Allow: /` 的专属组绕过它们。OpenAI 当前说明 OAI-SearchBot 用于 ChatGPT 搜索发现，GPTBot 则可由站长选择排除训练；若依赖 robots 控制搜索收录，还必须允许 OAI-SearchBot 读取页面，单靠 robots 放行也不能代替对 CDN/WAF/挑战页的实测。见[发布者说明](https://help.openai.com/en/articles/12627856-publishers-and-developers-faq)和[爬虫访问指南](https://help.openai.com/en/articles/20001243-advertiser-guidance-for-allowing-openai-web-crawlers)。

### 当前仓库具备的实现（线上状态需逐项验收）

- 工作区游戏后台已有 `title_localized` 字段，只在游戏绑定对应站点语言 ROM 时显示标题框。英文和简体中文仍使用原有字段；繁体优先人工校对名，再回退自动转换名。本轮没有在生产后台编辑或保存数据，也没有核实有多少条已填写。
- `gameTitle()` 已用于首页、游戏卡片、详情页、搜索联想、最近游戏和云存档等界面；校对后的本地化标题也会写入站内搜索倒排索引，并进入详情页 JSON-LD 的 `name`，原题保留为 `alternateName`。标题译文本身不会扩大该语言页面的 sitemap / hreflang 覆盖。
- 评分足够且页面确实免费可玩的游戏，结构化数据同时声明 `VideoGame` 与 `WebApplication`。Google 文档指出，仅有 `VideoGame` 类型不会显示 Software App 富结果；FAQ 标记不再承诺普通游戏站能获得 FAQ 富结果。
- 新增按 ROM 语言浏览的稳定专题页 `/rom-language/:language`。页面只列实际绑定了该站点语言 ROM 槽的游戏，通用 `*` ROM 不会被误认为日文、法文等专属版本；空语言页返回 404。页面由 SSR 直接输出，具备本地化标题/正文、分页、canonical/hreflang、Breadcrumb 与游戏清单结构化数据。
- 游戏库新增 ROM 语言筛选及带真实数量的语言专题链接；筛选参数页 `noindex`，稳定专题页才进入动态分类 sitemap。游戏新增、修改、删除时会推送受影响的 ROM 语言专题 URL。
- 游戏库与 ROM 语言专题共用已开放平台白名单，避免把最终会返回 404 的下架平台游戏列进可抓取目录。
- 上线前必须先执行数据库迁移，否则新查询会因缺少 `games.title_localized` 报错：`cd server && npm run migrate`。

### 本轮代码审计修复

- 类型 sitemap 原先只过滤 `hidden = 0`，可能把只有下架平台游戏的类型页提交给搜索引擎。现在类型聚合只统计前台开放平台。
- SSR 的首页、类型页与公开目录列表此前可能混入白名单外平台的游戏，产生无法打开的详情链接。现在普通访问与 noWasm 访问都分别按各自开放平台范围取数；类型计数同样应用此范围，`/genres` 不再链接到零款游戏的空类型页。
- 回归检查：`npm run test:indexnow`（41 项）、`cd server && npm run test:nowasm-lists`、`cd server && npm run test:ssr-parallel`、`npm run test:i18n-content`（9 项）、`npm run test:seo-meta` 均通过。语言内容覆盖报告已做语法检查，但因本机 MySQL `127.0.0.1:3307` 没有监听，未能生成真实覆盖率。
- 随后给游戏库、平台/类型/开发商目录与平台/类型/ROM 语言列表的客户端取数错误态加了 `noindex,follow`，站内跳转遇到接口失败时会同步移除 canonical、hreflang 与 JSON-LD；新增回归断言后 `npm run test:seo-meta` 再次通过。
- 本轮修复后 `npm run build:server` 成功；`npm run build:client` 随后通过前置隔离、613 模块打包及全部 postbuild 检查（运行时语法、EmulatorJS 字节一致、浏览器兼容、资源完整性和懒加载图均通过）。
- `npx tsc -b --pretty false` 受当前未跟踪的 `src/emulator/dosTouchInput.ts` 阻挡：第 12、13 行触发 `erasableSyntaxOnly` 的 TS1294；该文件不属于本轮改动，保留原样。

### 目前最明显的产品缺口

ROM 语言目录和筛选入口已在线可见，但当前稳定专题页的列表请求报错，需先部署本轮修复并在线复核。随后剩余的主要短板是内容覆盖：专题页的数量由真实 ROM 槽自动生成，但单款游戏的本地化标题与独立简介仍要由管理员校对/补齐；日文游戏库仍能看到不少英文原题，所以标题框需要持续填充才会改变这些条目的显示名。

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
5. 为公开合集制定可解释的搜索收录规则；首页合集区只突出信息完整、确有整理价值的作品，避免低信息量条目成为重点入口。
6. 分别验证 OAI-SearchBot、Perplexity、Claude Search 等搜索抓取，以及 GPTBot / ClaudeBot 等训练抓取是否符合站长意愿；robots 放行只是源站策略，Cloudflare/WAF 与区域 CDN 日志才证明真实请求成功。OpenAI 还维护公开的搜索爬虫 IP 清单；配置白名单时用其最新官方清单或供应商验证的机器人身份，不依赖短期日志里看到的 IP。
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
