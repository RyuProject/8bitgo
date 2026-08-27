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

“管理员”鉴权：请求头 `Authorization: Bearer <ADMIN_TOKEN>`，或用 `role=admin` 的账号登录后的 JWT。

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

`.env` 里 **`VITE_SITE_URL` 必须填正式域名**，canonical、og:url、hreflang、sitemap 都依赖它。

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
