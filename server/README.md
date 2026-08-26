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
