# 系统级异步化 / 自动化审视（2026-11-15）

范围：前端启动链路、SSR 取数、后台写路径与边缘清缓存、构建脚本、部署脚本、服务端转换队列。
原则：AGENTS.md 里刻意的串行和限制（PSP / Sockdrive 转换单并发、ROM 下载并发上限与 8MB 分块、
PSP Range 2MB、`emptyOutDir: false`、`/_cn` 前缀、Rocket Loader 退出标记等）**一律不动**，
它们每一条都对应过一次线上事故。

评分：收益 / 风险 / 工作量都按 高 · 中 · 低 三档；「状态」一栏写本轮是否已落地。

## 一、本轮已实现

| # | 项目 | 收益 | 风险 | 工作量 | 回归 |
|---|---|---|---|---|---|
| 1 | EmulatorJS 引擎入口按内容版本，去掉「改引擎手动换 `EJS_RUNTIME_GENERATION`」 | 高 | 低 | 低 | `npm run test:ejs-cores`、`check-emulatorjs` |
| 2 | SSR `/games` 列表与筛选面板并行取数 | 中 | 低 | 低 | `cd server && npm run test:ssr-parallel` |
| 3 | redeploy：package-lock 未变就跳过 `npm ci` | 中 | 低 | 低 | `npm run test:redeploy` |

### 1. 引擎入口按内容版本（自动化）

- **以前**：核心早已按内容哈希取 `?v=`（`ejsCoreVersionsData.ts`），但 `emulator.min.js` / css、`loader.js`、
  `compression/extract7z.js`、`localization/*.json` 仍跟手写的 `EJS_RUNTIME_GENERATION`。
  AGENTS.md 里至少六处写着「改了要换代」；忘了换，边缘就把旧引擎再发一年（§2.5 就是这么栽的），
  换了又让没变的 css / 语言包跟着重下。
- **现在**：`scripts/gen-ejs-core-versions.mjs` 把这几份引擎文件一起写进版本表；`ejsRuntimeAsset()`
  查表拼 `?v=<哈希>.<EJS_ENGINE_URL_EPOCH>`，表里没有时退回旧代号。`npm run ejspatch` 打完补丁
  自动重生成表；构建期 `check-emulatorjs` 已经在用 `--check` 拦过期的表。
- `EJS_ENGINE_URL_EPOCH`：内容没变、只想绕开某个边缘的坏缓存时改它（2026-11-08 EdgeOne
  `Vary: Origin` 那种），只换引擎入口，不动核心。
- `EJS_RUNTIME_GENERATION` 保留：存档元数据 `build` 字段与 NDS 偏好键还在用它，语义没变。
- 上线影响：引擎入口 URL 一次性换新（引擎 + 7z 解压脚本 + css 约 0.8MB 未压缩，重下一次），核心 URL 不变。

### 2. SSR `/games` 并行取数（异步化）

`loadForRoute` 的 `/games` 分支原来 `list: await listGames(q), facets: await loadFacets()` 串行，
缓存未命中（含所有带搜索词的请求，它们不进缓存）时 TTFB 是两段 SQL 往返之和。改成 `Promise.all`。
测试用带延迟的假库量峰值并发，并和两者单独跑时的峰值比较——改回串行会直接失败。
首页 `loadHome`、相关推荐 `loadRelatedGames`、`loadFacets` 本来就是并行的，测试顺带守住首页。

### 3. redeploy 跳过不必要的 `npm ci`（自动化）

每日定时部署绝大多数不动依赖，但 `npm ci` 每次删光 node_modules 重装，部署多几分钟，期间和线上
进程抢 4GB 机器的内存与 IO。现在 `deploy/lib/npm-ci-if-changed.sh` 以「上次成功安装时 lock 的
sha256」（戳文件放在 node_modules 里）判断；node_modules 丢失、安装失败、lock 变化、
`FORCE_NPM_CI=1` 都会重装。两个仓库都没有 install 钩子，跳过不会漏生成步骤。
两套 `npm ci` 仍串行（4GB 机器上并行会抢内存）。

## 二、第二轮（2026-11-15，按清单 #4–#11 继续）

| # | 项目 | 状态 | 回归 |
|---|---|---|---|
| 4 | 部署后真实开局冒烟 | ✅ 可选脚本 | `npm run test:smoke-start`；实跑 `npm run smoke:start` |
| 5 | 备份：本地 dump 同步、R2 上传转后台与构建并行 | ✅ | `cd server && npm run test:backup`、`npm run test:redeploy` |
| 6 | 迁移漏项检查进 prebuild | ✅ | `cd server && npm run test:schema-drift` |
| 7 | 构建检查并行化 | ⏸ 维持不做 | 整段约 8 秒，收益太小（做法见下） |
| 8 | 其它运行时自动换代 | ✅ js-dos 加「版本号 ↔ 字节」锁；PPSSPP / Ruffle 只写方案 | `npm run test:jsdos-asset-lock` |
| 9 | ROM 换绑后自动清 CDN | ⏸ 维持不做 | ROM 都是新 key + `romv`；唯一需要清的大陆 EdgeOne 没有清缓存通道 |
| 10 | 启动诊断聚类报警 | ✅（没配 `DIAG_ALERT_EMAIL` 时不启用） | `cd server && npm run test:diag-alert` |
| 11 | 服务端串行 await 普查 | ✅ 6 处并行 | `cd server && npm run test:parallel-reads` |

### 4. 开局冒烟（`scripts/smoke-start.mjs`）

无头 Chrome 打开 `/games/<slug>?autoplay=1`，等播放器自己的启动漏斗报 `first_frame` 才算过，
`failed` / `timeout` / 150 秒没有首帧算失败。用 Chrome DevTools 协议的 Fetch 域拦下
`/api/games/*/startup` 与 `/play` 请求、读出事件、回假的 200 —— 冒烟**不会**进生产漏斗、诊断包和游玩次数。
不加依赖（DevTools 协议 + Node 22 自带 WebSocket），软件 WebGL（swiftshader）。
默认测《超级马里奥兄弟》（NES）和《恐龙快打》（CPS1，无 BIOS）。

- 2026-11-15 对线上实测：两款分别 13 秒、17 秒到首帧；不存在的 slug 按超时判失败、退出码 1。
- redeploy 只在 `SMOKE_TEST=1` 时于健康检查之后运行，默认测 `http://127.0.0.1:8788`（可用 `SMOKE_BASE_URL` 改）；
  失败只告警、不回滚；没有 Chrome 时退出码 2，记一行「跳过」。
- **未验证**：生产机还没装 Chromium，也没有对 `127.0.0.1:8788` 这个源跑过一次。打开前先在生产机手动跑一遍。

### 5. 备份上传与构建并行

`8bitgo-backup.sh` 新增 `--upload-file <已验过的 .sql.gz>`（只上传、核对大小、轮转 R2，不连库），
`--local-only` 结束时在 stdout 打 `BACKUP_FILE=<路径>`。redeploy 步骤 1 先同步做 dump + 校验（失败照旧中止），
再把上传放到后台；`trap … EXIT` 保证成功、回滚、die 任何一条退出路径都会等上传结束
（systemd oneshot 退出会杀掉子进程）。上传失败只告警。`BACKUP_ASYNC_UPLOAD=0` 退回旧的同步行为。

### 6. 迁移漏项检查（`server/scripts/check-schema-drift.mjs`，prebuild 里跑）

不连库，静态对账 `schema-check.js` 的期望清单、`migrate.mjs` 与 `schema-v2.sql`：
期望的表必须有人建；期望的列必须由 `migrate.mjs` 补（只写在 schema-v2 里旧库永远补不上）；
反过来，`migrate.mjs` 建的表 / 补的列都要登记进 schema-check。
首次对账发现 **2 张表、23 个列**是迁移在补、启动自检却从没查过的，已全部登记（每条写了缺了会怎样）。
白名单只有 `oauth_authorizations` / `oauth_tokens` 两张（代码不读写，登记会误报），各写了原因。

### 8. 其它运行时的换代

- **js-dos**：没有改成内容哈希目录。`JSDOS_ASSET_VERSION` 同时是目录名和 DOS 存档元数据的 `build`，
  还有 4 个脚本按它找目录，牵动面大。真正要防的是「改了补丁、忘了换版本号」→ 同一 URL 新字节、
  一年缓存的访客拿不到。现在 `scripts/jsdos-asset-lock.json` 记「版本号 → 产物指纹」：
  `copy-jsdos` 生成新版本号时自动写锁、同号换字节时拒绝；`check-jsdos` 在构建前同样核对。
  已在本机删掉产物重新生成，指纹一致（产物是确定性的）。
- **PPSSPP**（只写方案，不动）：实体目录 `public/ppsspp/<提交>/vN/` 进 git，`check-ppsspp` 已逐文件核对
  runtime.json 的哈希，原地改文件会被它发现；缺的只是「改了某一代目录里的文件却没开新目录」的提醒。
  做法同 js-dos：给每个 vN 记一份指纹锁，已发布的代次指纹变化即失败。因为 Cloudflare 忽略查询串（§2.32.2），
  不能退回 `?v=`。
- **Ruffle**：版本目录 = npm 包版本，`check-ruffle` 已要求 `RUFFLE_VERSION` 跟随包版本，本身就不会忘，不需要改。

### 10. 启动诊断聚类报警（`server/src/diag-alert.js`）

诊断包入库后（不 await）看同一特征在 `DIAG_ALERT_WINDOW_MIN`（默认 60）分钟内来自多少**不同访问**，
≥ `DIAG_ALERT_MIN_VISITS`（默认 10）就用现有发信配置（Resend）给 `DIAG_ALERT_EMAIL` 发一封；
同一特征 `DIAG_ALERT_COOLDOWN_HOURS`（默认 6）小时内不重复。冷却记在 `site_settings`，
用带条件的 UPSERT 抢占，多进程 / 重启都不会重复发；同一特征每分钟最多查一次库。
邮件只含已脱敏入库的内容（特征文本、slug、浏览器 / 系统归类）。没配邮箱时完全不启用。

### 11. 服务端并行读

| 位置 | 改动 | 热度 |
|---|---|---|
| `games-repo.js` `getGameBySlug` | 关联数据 ‖ 最新评论时间 | 详情页 SSR 与 `/api/games/:slug` |
| `routes/comments.js` `GET /` | 总数 ‖ 本页 | 每个详情页 / 文章页，不缓存 |
| `routes/ratings.js` `GET /` | 汇总 ‖ 我的分 | 每个详情页 |
| `routes/ratings.js` `POST /` | 写入后两次只读并行 | 打分 |
| `routes/collections.js` `GET /`、`listPublicCollections` | 总数 ‖ 本页 | 合集列表、开放平台 |

测试用带延迟的假库记录每条 SQL 的起止时间，断言两条区间重叠；已验证改回串行会失败。
连接池上限 10，每个请求最多多占 1 个连接，没有压力。
**没做**：Flash 存档读取（数据和代次先后读，有轻微的一致性语义，并行会丢掉「代次不早于数据」）、
`open.js` 的 `/play` 两次写（写路径）、后台用户列表（低频）。

### 7 的做法备忘

如果以后检查脚本变慢，按三段跑：
1. 准备（现有 `copy-ruffle` … `setup-qemu-wasm`，会写 public/，保持串行）；
2. 生成（`sync-emulatorjs-core-metadata`、`precompress-runtimes`、`prepare-pvzge`、`gen-sitemap`，
   会写文件，串行，且必须在所有 check 之前——`check-emulatorjs` / `test:ejs-cores` 读 metadata，
   `check-pvzge` 读 prepare 的产物）；
3. 只读检查（其余全部，经核对只在 `--write*` 参数下才写文件），按 `min(CPU-1, 4)` 并发，
   每个任务缓冲输出、结束时整段打印，失败汇总后统一退出码 1。
`postbuild:client` 全部是只读检查，可整段并行。

## 三、审视过、确认**不该**改的

| 看起来可以优化的地方 | 为什么不改 |
|---|---|
| PSP / PS1 / Sockdrive 转换任务改多并发 | 与玩家请求抢 CPU / IO；内部已经用上传并发（默认 4–6 路）隐藏 R2 往返（§2.32、§2.8.8） |
| `invalidateContent()` 立即清边缘 | 必须延迟 3 秒：写库前开始的渲染会把旧页面重新塞回缓存（`edge-purge.js` 头注释） |
| `loadGamePage` 里 `getGameBySlug` 与相关推荐并行 | 相关推荐依赖游戏的厂商 / 类型 / 平台，有真实依赖 |
| ROM 下载默认并发拉高 | 按吞吐 / RTT / 省流量 / 内存动态 1–4 路是取证后的结果（§2.12） |
| `emptyOutDir` 改回 true | 构建期间 SSR 读不到模板会 500（§2.25.3） |
| 构建时自动重生成 `ejsCoreVersionsData.ts` 而不是 `--check` 失败 | 表是提交进 git 的源码；构建悄悄改源码会让线上与仓库不一致。改成「ejspatch 自动生成 + 构建只校验」 |
| 两套 `npm ci` 并行 | 生产机 4GB，和线上进程抢内存 |
