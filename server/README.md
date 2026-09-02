# 8BitGo 后端（连接 MySQL）

前端是纯浏览器应用，**不能直接连 MySQL**（浏览器不能开数据库 TCP，且密码会被打进前端包）。
所以由这个 Node 后端拿着数据库密码，前端通过 HTTP 调它：

```
浏览器前端  ──HTTP──►  Node 后端(server/)  ──►  MySQL
```

数据库密码只放在 `server/.env`，不进前端、不进 git。

---

## 一、准备

- Node 18+（`node -v` 确认）
- 一个能连到你 MySQL 的机器。**推荐把后端和 MySQL 放同一台服务器**，用 `127.0.0.1` 连，
  不用对公网放行 3306，最安全。

## 二、装依赖 & 配置

```bash
cd server
npm install
cp .env.example .env
# 编辑 .env，至少填：DB_PASSWORD、JWT_SECRET、ADMIN_TOKEN
```

`.env` 关键项：

| 变量 | 说明 |
| --- | --- |
| `DB_HOST` | 与 MySQL 同机填 `127.0.0.1` |
| `DB_USER` / `DB_PASSWORD` | 数据库账号密码。**建议新建一个只对 `8bitgo` 库有权限的专用账号，别用 root** |
| `DB_NAME` | 默认 `8bitgo` |
| `PORT` | 后端端口，默认 `8788` |
| `ALLOWED_ORIGINS` | 允许跨域的前端地址，逗号分隔（如 `https://8bitgo.com`）。同源部署可留 `*` |
| `JWT_SECRET` | 登录令牌签名密钥，务必改成随机长串：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ADMIN_TOKEN` | 后台写操作口令，前端后台「数据」页填同一个 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 可选，seed 时自动建一个管理员账号 |

> ⚠️ 你在聊天里发过 root 密码，建议**改掉它**，并给本项目单独建一个数据库账号：
> ```sql
> CREATE DATABASE IF NOT EXISTS `8bitgo` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
> CREATE USER '8bitgo'@'127.0.0.1' IDENTIFIED BY '换成你的强密码';
> GRANT ALL PRIVILEGES ON `8bitgo`.* TO '8bitgo'@'127.0.0.1';
> FLUSH PRIVILEGES;
> ```
> 然后 `.env` 里用 `8bitgo` 这个账号。

## 三、建表 & 导入内置数据

```bash
npm run migrate   # 建库建表（执行 schema.sql）
npm run seed      # 写入内置的 91 款游戏、6 篇文章；填了 ADMIN_EMAIL/PASSWORD 会顺便建管理员
```

> 也可以不跑 `seed`：先启动后端，用前端「后台 → 数据 → 导入内置数据到数据库」按钮完成。

## 四、启动

```bash
npm start          # 前台运行，看日志
# 或用 pm2 常驻：
npm i -g pm2
pm2 start src/index.js --name 8bitgo-api
pm2 save
```

自检：`curl http://127.0.0.1:8788/api/health` 应返回 `{"service":"8bitgo-api","db":true}`。

## 五、让前端用上后端

前端通过环境变量 `VITE_API_URL` 找后端（**填站点地址，不带 `/api`**，前端会自动加）：

```bash
# 项目根目录（不是 server/）
echo 'VITE_API_URL=https://你的域名' >> .env    # 或 http://服务器IP:8788
npm run build                                    # 重新构建前端
```

构建后前端就会从数据库读游戏 / 文章、注册登录写进数据库。
`VITE_API_URL` 留空则前端退回「浏览器本地存储」模式，不连数据库（方便无后端时开发）。

### 用 Nginx 反代（推荐，同源、免跨域）

把 `/api` 转给后端，其余给前端静态文件；这样 `VITE_API_URL` 直接填你的域名即可：

```nginx
server {
  listen 80;
  server_name 8bitgo.com;

  root /var/www/8bitgo/dist;      # 前端 npm run build 的产物
  location / { try_files $uri /index.html; }

  location /api/ {
    proxy_pass http://127.0.0.1:8788;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
  }
}
```

---

## 接口一览

| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/api/health` | 健康检查 | 无 |
| GET | `/api/games` `/api/games/:slug` | 游戏列表 / 单个 | 无 |
| PUT/PATCH/DELETE | `/api/games/:slug` | 新增覆盖 / 局部改 / 删 | 管理员 |
| GET | `/api/posts` `/api/posts/:slug` | 文章列表 / 单篇 | 无 |
| PUT/DELETE | `/api/posts/:slug` | 保存 / 删 | 管理员 |
| POST | `/api/auth/register` `/api/auth/login` | 注册 / 登录（返回 JWT） | 无 |
| GET | `/api/auth/me` | 用当前 token 取用户信息 | 用户 |
| PATCH | `/api/me` | 改昵称 / 头像 | 用户 |
| POST | `/api/me/favorites/:slug` | 收藏 / 取消 | 用户 |
| POST | `/api/me/recents/:slug` | 记录最近游玩 | 用户 |
| GET | `/api/users` | 用户列表 | 管理员 |
| PATCH/DELETE | `/api/users/:id` | 调金币 / 封禁 / 删 | 管理员 |
| POST | `/api/admin/import` | 批量导入游戏 / 文章 | 管理员 |
| GET | `/api/saves` | 我的云存档清单（不含存档内容） | 用户 |
| GET | `/api/saves/:runtime/:slug` | 取存档（二进制）；加 `/meta` 只要体积和时间 | 用户 |
| PUT | `/api/saves/:runtime/:slug` | 存档（请求体是二进制） | 用户 |
| DELETE | `/api/saves/:runtime/:slug` | 删存档 | 用户 |

“管理员”鉴权：请求头 `Authorization: Bearer <ADMIN_TOKEN>`，或用 `role=admin` 的账号登录后的 JWT。

## 游玩次数（一个人只算一次）

`games.plays` 现在的含义是**有多少人玩过**，不是被点开了多少次。

计数发生在模拟器**真的跑起来**（`onReady`）的时候，不是打开详情页 ——
否则爬虫、链接预取和随手点开都会被算成一次游玩。

### 去重规则

| 状态 | 按什么去重 | 效果 |
| --- | --- | --- |
| 已登录 | 账号（`user_id`） | 换设备、换网络、换 IP 都算同一个人 |
| 未登录 | 客户端 IP | 同一个 IP 只算一次 |

**已登录时不再看 IP**，这是有意的：同一个出口 IP 后面可能是一整栋宿舍、一家公司、
一个手机热点，甚至运营商 NAT。把 IP 也算进去的话，那些人里只有第一个会被记上。
代价是「先以游客身份玩过、后来注册登录再玩同一款」会被算两次 ——
每人每游戏最多多算一次，比误伤一整栋楼划算。

### 存在哪

`game_plays` 表，主键 `(game_id, kind, identity)`，去重就是这个主键本身：

```sql
INSERT IGNORE INTO game_plays (game_id, kind, identity)
SELECT id, ?, ? FROM games WHERE slug = ? AND hidden = 0;
-- 真插进去了（affectedRows = 1）才 UPDATE games SET plays = plays + 1
```

并发的两次上报不会双记 —— 谁先插进去谁算数，这是数据库保证的，不是应用层
「先查再写」判出来的（那中间有窗口，压测时必翻车）。

> 以前这张表在**内存**里，30 分钟窗口 + `IP|UA|slug` 做 key。问题是进程一重启就全忘了，
> 多实例部署更是各记各的 —— 换句话说，重启一次全站所有人都能再刷一遍。

`identity` 存的是 **HMAC-SHA256 摘要**（base64url，43 字符），不是明文 IP：
库被拖走也反查不回具体地址，密钥在 `.env` 的 `PLAY_HASH_SECRET`（留空则复用 `JWT_SECRET`）。

> ⚠️ 换掉 `PLAY_HASH_SECRET` / `JWT_SECRET` 等于把已有去重记录作废 ——
> 老玩家指纹对不上，每个人会被重新算一次，`plays` 会明显往上跳。

⚠️ 列的排序规则必须是 `ascii_bin`。用默认的 `utf8mb4_unicode_ci` 的话
`aB…` 和 `Ab…` 会被当成同一个人，不同的玩家互相顶掉 —— 症状是「数字看着偏小」，
没有任何报错。`schema-v2.sql` 和 `migrate.mjs` 两边都写死了，改的时候别只改一处。

### 升级已有的库

```bash
npm run migrate      # 建 game_plays，现有 plays 数字原样保留
```

旧数据没有去重记录，所以**老玩家回来还会被算一次**，此后就不会再重复计了。
想让数字从头干净，可以在跑完 migrate 后手动 `UPDATE games SET plays = 0`。

### 表会长多大

行数 = 玩过的人数 × 人均玩过的游戏数，每行约 70 字节。一万个访客人均玩 3 款
大约是 3 万行 / 2 MB —— 相对整个库可以忽略。真要控制体积，可以定期删掉
很久以前的 `kind='i'` 行（IP 本来就会被重新分配），代价是那批游客会被重新计一次。

### 自测

```bash
npm run test:play    # 不连数据库：身份指纹 + 去重语义（内存 SQLite）+ 排序规则，共 20 个用例
```


## 验证码邮件（当前走 Resend）

三个地方会发验证码信，共用同一套通路和同一份配额（`src/codes.js`）：

| 用途 | 接口 | 码发给谁 |
| --- | --- | --- |
| `login` | `POST /api/auth/email/request-code` | 要登录的那个邮箱 |
| `bind` | `POST /api/me/email/request-code` | **新**邮箱（收得到才说明这个邮箱是他的） |
| `delete` | `POST /api/me/delete/request-code` | 账号当前邮箱 |

发信通路在 `src/mail.js`，按环境变量自动选：

| 优先级 | 条件 | 走哪条 |
| --- | --- | --- |
| 1 | `RESEND_API_KEY` | Resend REST API（**现在用的是这条**） |
| 2 | `CF_ACCOUNT_ID` + `CF_EMAIL_TOKEN` | Cloudflare Email Service REST API |
| 3 | `SMTP_HOST` + `SMTP_USER` | SMTP（需要 `nodemailer`） |
| 4 | 都没配 | 只把验证码打印到服务器日志 |

**启动日志里会写明当前用的是哪条**（`[mail] 验证码走 …`）。「用户收不到验证码但服务器一切正常」
基本都是配置写错静默退回了最后一条，先看那一行。

### Resend 开通步骤

1. Resend 后台 → **Domains** → 添加 `8bitgo.com`，把它给的 SPF / DKIM 记录加到 DNS
   （域名托管在 Cloudflare，去 DNS 页面加就行），等状态变成 **Verified**
2. **API Keys** 建一个有发信权限的 Key
3. 填进 `server/.env`：

```bash
RESEND_API_KEY=re_xxx
MAIL_FROM=noreply@8bitgo.com     # 域名必须和 Verified 的那个一致
MAIL_FROM_NAME=8BitGo
```

4. 单独测发信（不经过限流和验证码表）：

```bash
npm run test:mail -- you@example.com
```

> ⚠️ 域名还没验证完时，只能用 Resend 自带的 `onboarding@resend.dev` 发信，
> 而它**只能发给你注册 Resend 的那个邮箱**，发给别人一律 403。
> 症状是「我自己能收到，别人都收不到」—— 别以为是代码问题，去 Domains 页面看状态。

配额：免费版每天 100 封 / 每月 3000 封。`.env` 里 `CODE_SEND_GLOBAL_PER_HOUR` 默认 **500**，
跑满远超这个额度 —— 真开放注册前按实际量级调小（两位数更合适）。

### 为什么还留着 Cloudflare 那条

只用 `fetch`，不需要任何依赖 —— 也是将来后端搬进 Workers 时**唯一不用重写**的发信方式。
SMTP 走的是 TCP 465，Workers 根本连不出去。真到那一步时，`sendViaCloudflare()` 里
换掉 fetch 那几行改成 `env.EMAIL.send()` 绑定就行，消息体字段名两边完全一致。

### 开通步骤

1. 域名托管在 Cloudflare DNS（`8bitgo.com` 已经是了）
2. Dashboard → **Email Service → Email Sending**，把 `8bitgo.com` 走一遍 onboarding
   （自动写 SPF / DKIM / DMARC，以及用于**收退信**的 MX 记录；通常 5–15 分钟生效）
3. 建 API Token，权限勾 **Email Sending: Edit**
4. 填进 `server/.env`：

```bash
CF_ACCOUNT_ID=<Dashboard 右侧栏的账号 ID>
CF_EMAIL_TOKEN=<上一步的 Token>
MAIL_FROM=noreply@8bitgo.com     # 域名必须和 onboarding 的一致
MAIL_FROM_NAME=8BitGo
```

5. 单独测发信（不经过限流和验证码表）：

```bash
npm run test:mail -- you@example.com
```

### 配额与费用

- 公测中（2026-04 起）。给**任意地址**发信需要 Workers 付费版（$5/月）
- 付费版每月含 **3000 封**，超出 **$0.35 / 1000 封**
- 发给「已验证的目的地址」（账号里验过的那几个）免费、不占配额 ——
  域名 onboarding 完成前也只能发给这些地址，正好拿来联调
- 日发送量有个不公开的上限，随发信记录和退信率逐步放开。新域名别一上来就群发
- ⚠️ `.env` 里 `CODE_SEND_GLOBAL_PER_HOUR` 默认 **500**，跑满就是 36 万封/月，
  远超月度配额。真开放注册前把它调到跟配额匹配的量级（比如 100/小时 ≈ 7.2 万/月 还是太多，
  按实际注册量给个两位数更合适）

### 失败了会怎样

`sendLoginCode()` 抛 `MailError`，带 `kind`，`routes/auth.js` 按 kind 翻译：

| kind | 什么情况 | 回给前端 |
| --- | --- | --- |
| `suppressed` | 地址退过信 / 被标过垃圾邮件 / 收件地址不合法，再发也不会到 | 400「这个邮箱地址无法投递，请换一个邮箱」 |
| `ratelimit` | 月配额或日限额到顶 | 429 |
| `sender` | 发件域没验证、密钥没权限、依赖没装 | 500（细节只进日志） |
| `network` | 连不上 / 超时，可重试 | 502 |

⚠️ `sender` 和 `suppressed` 千万别混：前者是我们的部署问题（叫用户换邮箱是白费功夫，
换多少个都发不出去），后者用户换个邮箱立刻就好。Resend 这两种都可能是 403 / 422，
只看状态码分不出来 —— 判据在 `resendKind()` 里，用的是 `body.name` 加一次消息文本嗅探。

**发信失败时会把刚生成的验证码从 `login_codes` 表里撤掉。** 不撤的话，用户既收不到信，
又被 `COOLDOWN` 挡在门外一分钟 —— 这是之前的行为。

> ⚠️ Cloudflare 对**硬退信**返回的是 HTTP 200 + `success: true`，收件地址躺在
> `result.permanent_bounces` 里。只看状态码会把它当成功，用户对着一封永远不会到的邮件
> 干等十分钟，而服务器日志里一切正常。`scripts/test-mail-parsing.mjs` 专门锁住了这条分支：
>
> ```bash
> node scripts/test-mail-parsing.mjs   # 不联网，起本地 mock 跑 13 个用例
> ```

Resend 那条通路有自己的一份回归测试（同样不联网）：

```bash
npm run test:mail:resend   # 返回体分类、请求体字段、三种用途的文案、网络失败
npm run test:codes         # 验证码状态机（要连库；连不上就自动跳过）
```

### 验证码存在哪

`login_codes` 表，主键 `(email, purpose)`，存的是 **sha256(email + purpose + code)** 而不是明文 ——
一次 `mysqldump` 泄露就等于把所有人（含管理员）的账号送出去。哈希拌了 email 和 purpose，
所以一条哈希只在「这个邮箱的这个用途」上成立，拿不去别处重放。

以前这些码放在进程内存的一个 Map 里，有两个真实的坑：`pm2 restart` 会把待验证的码全清空
（用户刚收到信，回来填却被告知「验证码已过期」）；多开实例时发码和验码不是同一个进程，
登录会随机失败一半。**表还没建时会自动退回内存版并在日志里喊一声** —— 缺一张表不该让整站登录不了，
但看到那行 `[codes] login_codes 表不存在` 就该去跑 `npm run migrate`。

换绑 / 注销的码还绑了 `user_id`：不绑的话，A 拿自己那封「换绑到 x@y」的信里的码，
就能去把 B 的账号也换绑成 x@y。


## 云存档

**云存档跟着账号走，所以必须登录。** 没登录的玩家不进这张表 —— 他们的存档落在自己浏览器里
（IndexedDB），或者下载成文件自己保管，见 `src/services/saves.ts`。

两种引擎的存档不是一回事，用 `runtime` 分开存、互不覆盖：

| runtime | 存的是什么 | 什么时候能存 | 体积 |
| --- | --- | --- | --- |
| `emulatorjs` | 内存快照 —— 整台机器某一帧的状态 | 随时 | NES 约 20KB、GBA 几十 KB |
| `jsdos` | DOS 文件系统的**变更包** —— 盘上被改过的文件 | 玩家得先在游戏里存盘 | 几 KB 到几百 KB |

所以界面上是两个不同的按钮：快照式引擎给「存档 / 读档 / 另存为文件」，
DOS 只给一个「保存进度」，提示写的是「先在游戏里存盘，再点这里」。

`:slug` 一般就是游戏的 slug；玩家自己上传的 ROM 没有 slug，前端会传 `local:文件名`
（文件名可能是中文的，也可能带 `%`，所以服务端只挡斜杠和空白，不限定 ASCII）。

上限用 `SAVE_MAX_BYTES`（默认 4MB）和 `SAVE_MAX_PER_USER`（默认 200 份）控制。
覆盖已有存档永远放行，只有「新开一份」时才查配额 —— 不然玩家玩到一半突然存不上，
比拒绝新建难受得多。

### 回归测试

```bash
cd server && node scripts/test-saves.mjs
```

30 项，覆盖必须登录 / 存取删 / 覆盖同一格 / 引擎与存档位之间互不覆盖 /
看不到别人的存档 / 参数校验 / 超大存档回 413 / 中文与带 `%` 的文件名。
**需要数据库**，连不上会整组跳过并正常退出。

## 安全提醒

- 数据库密码只在 `server/.env`，别提交、别填进前端。
- `JWT_SECRET`、`ADMIN_TOKEN` 换成随机长串。
- 尽量用专用数据库账号而非 root；MySQL 尽量只监听 `127.0.0.1`。
- `/api/games`、`/api/posts` 会返回全部条目（含隐藏 / 草稿，带标记，前端自行过滤）——
  自用站点足够；若要严格隐藏，可自行在这两个接口加过滤。

---

## 服务端渲染（SSR）与多语言路由

### 部署步骤

```bash
# 1. 项目根目录：构建前端（会同时产出客户端与服务端两份产物）
npm install
npm run build          # -> dist/client（浏览器资源） + dist/server（渲染函数）

# 2. 启动后端（它同时负责 API、静态资源和 SSR）
cd server && npm install && npm start
```

后端启动时会打印 `[ssr] 已启用服务端渲染`。如果打印的是「未找到 dist/client 或 dist/server」，
说明还没在根目录跑 `npm run build`，此时只提供 API，网站打不开。

根目录构建环境里的 **`VITE_SITE_URL`** 和 `server/.env` 里的 **`PUBLIC_SITE_URL`** 都必须填正式域名。
前者供 canonical / og:url / hreflang 使用，后者供数据库实时游戏 sitemap 与 IndexNow 使用。

### 搜索引擎发现：sitemap + IndexNow + 百度普通收录

完整说明和排查表见 **[deploy/seo/README.md](../deploy/seo/README.md)**，这里只列要点。

**sitemap**（上架即生效，不用重新构建）

- `/sitemaps/games-<语言>.xml` 共 8 份，每次请求都现查数据库。
- `/sitemap.xml` 索引由后端接管，游戏 sitemap 的 `lastmod` 取库里可见游戏的最新更新时间 ——
  构建期那份静态文件的 lastmod 停在构建当天，搜索引擎据此认为子 sitemap 没动过就不会回来重抓。
- `/sitemap-static.xml`（首页 / 平台页 / 类型页 / 文章）仍是构建期产物。新游戏带出一个此前
  完全没有游戏的平台或类型时，那张列表页要等下次 `npm run build` 才进 sitemap，
  但它已经在上架推送的 URL 列表里，不影响被发现。

**主动推送**（两条通道，互不影响，任一失败都不会让内容保存失败）

| | IndexNow（Bing / Yandex …） | 百度普通收录 |
|---|---|---|
| 凭证 | key，公开放在 `/<key>.txt` | 准入密钥 token，**私密**，只放 `server/.env` |
| 每日配额 | 实际没有 | 有，站点级，新站常见 10~100 条/天 |
| 推送语言 | 全部 8 种 | 默认只推简体中文（百度不索引 `/en`、`/ja` 等前缀页） |

- 后台新增、修改、上下架或删除游戏后，详情页及相关聚合页进入内存队列，约 1 秒后合并成一次请求发出。
- 队列在内存里，进程重启会丢；百度还可能当天配额用完。所以有每日兜底任务
  `deploy/seo/push-daily.sh`（cron 配置见那份 README）。
- 手动补交：`cd server && npm run baidu -- --all`（首次启用跑一次）、`npm run indexnow`。
  排查配置先用 `npm run baidu -- --dry-run`，它只打印将要提交的 URL，一条都不发。
- Google 的 Indexing API 只允许招聘与直播活动页，普通游戏页不能使用；Google 发现游戏页依赖 sitemap、SSR 链接与 Search Console。

启用前确认 `https://8bitgo.com/b8b81a59fab843acaa590586b6733da0.txt` 能直接返回 key，
并在**线上**的 `server/.env` 里设置：

```ini
PUBLIC_SITE_URL=https://8bitgo.com
INDEXNOW_ENABLED=1
BAIDU_PUSH_ENABLED=1
BAIDU_PUSH_TOKEN=<搜索资源平台的准入密钥>
```

本机开发的 `server/.env` 里这两个开关刻意留 0：本机连的是线上库，
调试时存半成品也会拿正式域名去通知搜索引擎，还白吃百度当天配额。
后端启动时会把两条通道的状态各打印一行，配没配对看那两行，不要等推送日志。

### 语言与 URL

| 语言 | 网址 |
|---|---|
| 简体中文（默认） | `/`、`/games` |
| 其它语言 | `/en/games`、`/ja/games`、`/de/games` … |

默认语言不带前缀，所以首页 `/` 直接出内容，不用 301 跳转。
语言由 URL 决定，每种语言都有自己可被收录的地址，页面上会输出全部 9 条 hreflang（8 种语言 + x-default）。

### 几个注意点

- **改完数据最多 60 秒生效**：SSR 用了内存缓存（`SSR_CACHE_MS`，默认 60000 毫秒）。
  想立刻生效就重启后端，或把这个值调小。
- **`npm run dev` 不走 SSR**，是纯客户端的 Vite 开发服务器，改代码热更新更快。
  要验证 SSR 效果，用 `npm run build && cd server && npm start`。
- **登录态不参与 SSR**：服务端统一按未登录渲染，浏览器接管后再恢复登录状态。
  这是刻意的——否则每个用户的页面都不一样，没法缓存，也会造成 hydration 不匹配。
- **导入 SQL 一定要用 utf8mb4**：`server/8bitgo-setup.sql` 开头已经写了 `SET NAMES utf8mb4;`。
  有些 mysql 客户端默认 latin1，缺这行会把中文存成双重编码的乱码。

## 迁移到 Cloudflare D1

站点的终点是全 Cloudflare（Workers + D1 + R2 + Durable Objects），D1 这一步现在做最便宜：
11 张表、几百 KB 数据、写入量约等于零，越往后拖越贵。

两个文件：

| 文件 | 干什么 |
| --- | --- |
| `schema-d1.sql` | `schema-v2.sql` 的 SQLite 版，表 / 列 / 索引 / 外键一一对应 |
| `scripts/export-d1.mjs` | 连现有 MySQL 按行读，导出 D1 能直接执行的 INSERT |

```bash
npx wrangler d1 create 8bitgo
npx wrangler d1 execute 8bitgo --local --file=schema-d1.sql   # 先在本地试
npm run export-d1 -- --clean --out d1-data.sql                # 从 MySQL 导数据
npx wrangler d1 execute 8bitgo --local --file=d1-data.sql
# 本地验完再换成 --remote 打到线上
```

**过渡期怎么并行**：D1 只能给 Workers 用（Express 走 REST API 每条 SQL 都要跨互联网往返，
是反模式）。所以现在这台 Node 服务器继续连 MySQL 照常跑，Worker 那边连 D1 并行开发；
后台改了内容就重跑一次 `npm run export-d1` 覆盖过去。等 Worker 功能齐了一次切换，MySQL 退休。
写入量小的时候这个笨办法完全够用，还省掉了 Hyperdrive + Cloudflare Tunnel 那一整套。

**四个和 MySQL 不一样的地方**（`schema-d1.sql` 文件头有完整说明）：

1. **一条语句最多 100 个绑定参数。** `games-repo.js` 里 token 批量插入的 `CHUNK = 200`
   （200×3 = 600 个占位符）在 D1 上会被拒，改成 `33`。
2. **没有交互式事务。** `withTransaction` 的 4 个调用点里，`upsertGame` / `patchGame` 是真交互
   （INSERT → `SELECT id` → 用这个 id 写子表）。D1 只有 `batch()`，原子但中途读不到结果。
   改法：用 `INSERT ... ON CONFLICT(slug) DO UPDATE SET ... RETURNING id` 一条语句拿到 id，
   再把子表写入放进一个 `batch()`，原子性还在。
3. **排序规则默认区分大小写。** MySQL 那边是 `utf8mb4_unicode_ci`。`email` 已经在
   `schema-d1.sql` 里加了 `COLLATE NOCASE`；`slug` 由 `slugify()` 生成、搜索 token 由
   `normalize()` 统一小写，本来就不依赖排序规则。
4. **外键默认强制，且关不掉**（没有 `SET FOREIGN_KEY_CHECKS=0`）。所以导入必须父表在前 ——
   `export-d1.mjs` 的表顺序已经排好，别重排。

## Cloudflare 缓存

服务端已经按资源类型给好了 `Cache-Control`（规则集中在 `server/src/cache.js`）：

| 资源 | 策略 | 说明 |
| --- | --- | --- |
| `/assets/*`（带哈希的构建产物） | 一年 + immutable | 文件名变了才算新文件，可以永久缓存 |
| `/fonts/*` | 一年 + immutable | 换字体请顺手改文件名 |
| `/ruffle/*`、`/emulatorjs/*`、`/j2me/*` | 浏览器 1 天，边缘 30 天 | 体积大、更新少；升级引擎后清一次 Cloudflare 缓存 |
| 图片、favicon | 浏览器 1 小时，边缘 7 天 | |
| `robots.txt`、`sitemap.xml` | 浏览器 5 分钟，边缘 1 小时 | |
| SSR 页面 | 浏览器不缓存，边缘 `PAGE_S_MAXAGE`（默认 300 秒） | 页面是匿名的，登录态在客户端，不会串号 |
| `/api/games`、`/api/posts`（公开视角） | 浏览器 30 秒，边缘 `API_S_MAXAGE` | 带 `?all=1` 的管理员视角不缓存 |
| 其余 `/api/*`、`/admin`、SSR 降级空壳 | `no-store` | 默认不缓存，漏配只会少一层缓存而不会泄漏数据 |

所有能被边缘缓存的响应都带了 `stale-while-revalidate`：过期之后 Cloudflare 先把旧的返给用户，
同时自己回源更新 —— 用户不会为了等一次回源而卡住。

### ⚠️ 必须在 Cloudflare 加一条 Cache Rule

**Cloudflare 默认只缓存静态后缀，HTML 和 `/api` 是完全不缓存的**，上面的 `s-maxage` 不会自己生效。
去控制台 → 你的域名 → Caching → Cache Rules → Create rule：

- 规则名：`Cache HTML and public API`
- 匹配：`(not starts_with(http.request.uri.path, "/admin")) and (not starts_with(http.request.uri.path, "/api/auth")) and (not starts_with(http.request.uri.path, "/api/me")) and (not starts_with(http.request.uri.path, "/api/users")) and (not starts_with(http.request.uri.path, "/api/rooms"))`
- Cache eligibility：**Eligible for cache**
- Edge TTL：**Use cache-control header if present**（关键，别选固定 TTL，否则会盖掉上面的策略）
- Browser TTL：同样选 Respect origin

这样 `no-store` 的响应仍然不会被缓存（Cloudflare 认这个头），而页面和公开接口会被边缘接管。

### 内容更新后如何立刻生效

后台改完游戏或文章，边缘上的旧页面最多还会存活 `PAGE_S_MAXAGE` 秒。要立刻生效有两种办法：

1. Cloudflare 控制台 → Caching → Configuration → Purge Everything（最省事）
2. 调 API 定点清理（适合接进后台的保存流程）：

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/purge_cache" \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  --data '{"purge_everything":true}'
```

注意服务端自己还有一层 60 秒的内存缓存（`server/src/content.js`），后台写操作会主动
调 `invalidateContent()` 让它立刻失效，所以清完 Cloudflare 就是最新的了。

## DOS 联机（IPX）

当年的 DOS 局域网游戏（毁灭战士、毁灭公爵 3D、魔兽争霸 2、命令与征服）靠 IPX 协议通信。
js-dos 把 IPX 隧道化到了浏览器里，有两种拓扑：

**一、中继（推荐，自己就能部署）**

所有玩家的浏览器连到同一台 IPX 服务器，服务器按房间转发数据包。`server/src/ipx.js`
就是这个服务器 —— 它是 [dosbox-ipx-server](https://github.com/caiiiycuk/dosbox-ipx-server)（Go）
的 Node 移植，协议完全一致，好处是不用再单独部署一个 Go 服务。

开启方式：`.env` 里设 `IPX_ENABLED=1`，重启后端。它会在**主站同一个端口**上
提供 `/ipx/<房间名>`，也就是说走的是 443、橙云代理、现成的证书 —— 什么都不用额外配。

这里有个细节值得知道：js-dos 客户端原本把 IPX 服务器的端口**写死成 1900**
（它拼的是 `<地址>:1900/ipx/<房间>`），而 1900 不在 Cloudflare 代理的端口列表里
（只代理 80/443/2053/2083/2087/2096/8443）。照原样用的话，只能给 IPX 单开一个
灰云（DNS only）子域名直连源站 —— 那等于把源站 IP 暴露出去，整站的 Cloudflare
防护都能被绕过 —— 或者在源站另配一套监听 1900 的 TLS。

所以 `scripts/copy-jsdos.mjs` 在复制资源时会顺手把那一处端口去掉（整个
`js-dos.js` 里只出现一次；将来上游改了写法脚本会明确报错，不会静默留下一个连不上的功能）。
不想打补丁就加 `--no-ipx-patch`，同时把 `.env` 里的 `IPX_PORT` 设成 1900 退回独立端口模式。

玩家侧目前需要手动操作：在播放器里打开 js-dos 的设置面板 → Network，填入
Server（`wss://你的域名`）和 Room（房间名），双方填同一个房间就在同一个 IPX 网络里了。
之所以要手动，是因为 **js-dos 没有对外暴露「连接到 IPX 服务器」的编程接口** ——
`Dos()` 返回的 props 里只有 stop / save / setVolume 这些，没有 IPX 相关的方法。

**二、P2P（浏览器直连，需要一台撮合服务器）**

一个玩家的浏览器当 IPX 服务器，其他人经 WebRTC 直连过去。这条路**可以用代码控制**：
`Dos()` 的 `startIpxServer` / `connectIpxAddress` 两个选项就是干这个的，适配器
（`src/emulator/adapters/jsdos.ts`）已经接好，通过 `MountOptions.ipx` 传进去。

它需要一台「撮合服务器」（peer-server）来交换连接信息，默认用的是 js-dos 官方的
`https://net.dos.zone`。想自建的话要部署 [WebRTC-NET](https://github.com/caiiiycuk/WebRTC-NET)
的 peer-server（Go + FlatBuffers），然后设 `VITE_JSDOS_PEER_SERVER` 指过去。
NAT 穿透用的 STUN/TURN 已经接到了本站自己的 `/api/netplay/ice`，跟 P2P 联机共用一套凭据。
