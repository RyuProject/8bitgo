# SAS3 / SmartFoxServer 1.x 旁路部署

这套部署把联机拆成三层，SFS 故障不会拖垮主项目：

```text
Ruffle 中的 SAS3.swf（写死 sas3server.ninjakiwi.com:444）
  → Ruffle socketProxy
  → wss://8bitgo.com/sfs/sas3
  → 8BitGo Node 字节桥
  → 127.0.0.1:8044
  → FlashPrivateServer Java sidecar
```

Node 默认 `SFS_ENABLED=0`。即使 Java 没装、没启动或升级失败，Express、MySQL、直播、P2P、
DOS IPX 和其它单机游戏仍照常工作。不要把 Java 进程并进主站的 `8bitgo.service`。

## 1. 安装 Java sidecar

Ubuntu / Debian：

```bash
sudo apt update
sudo apt install -y git openjdk-17-jdk maven
cd /var/www/8bitgo
sudo ./deploy/sfs/install-sidecar.sh
sudo systemctl enable --now 8bitgo-sfs
sudo systemctl status 8bitgo-sfs --no-pager
```

安装脚本固定使用 FlashPrivateServer `v4.3`（发布提交 `7cd3983`，标签漂移会拒绝安装），源码保留在
`/opt/8bitgo-sfs/source`，构建出的 jar 单独放在 `/opt/8bitgo-sfs/flashserver.jar`。
模板只启 SAS3/8044，其它协议端口全部关闭。systemd 再用 IP 过滤把 sidecar 锁到 loopback，
所以 8044 即使监听在 `0.0.0.0` 也不能从公网直连。

上游启动器还会尝试开 Flash policy 的 843 端口；这里以非 root 用户和
`NoNewPrivileges=true` 运行，843 打不开是预期行为。Ruffle 的 WebSocket 代理不依赖它。

## 2. 打开 Node 桥

在 `/var/www/8bitgo/server/.env` 增加：

```dotenv
SFS_ENABLED=1
SFS_TCP_HOST=127.0.0.1
SFS_TCP_PORT=8044
SFS_WS_PATH=/sfs/sas3
SFS_ALLOWED_ORIGINS=https://8bitgo.com,https://www.8bitgo.com
```

然后重启主 API：

```bash
sudo systemctl restart 8bitgo
```

这是纯运行时开关，不用重建前端。Ruffle 会短期缓存 `/api/sfs/config`：有效配置 5 分钟，
关闭状态 30 秒，请求失败 5 秒后重试。取不到配置仍继续单机启动，旁路恢复后新开的 Flash 游戏
会自动重新取配置，不需要玩家整页刷新。

## 3. Nginx 与 Cloudflare

把 [`nginx-sfs.conf`](./nginx-sfs.conf) 的 `location /sfs/` 放进正式域名的 `server {}`，
检查并重载 Nginx：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

站点在 Cloudflare 后面时保留橙云即可，浏览器这条链只走标准 443 WebSocket。
Cloudflare 控制台需允许 WebSockets。配置里的 `X-Forwarded-For` 按本项目现有约定使用
`$http_cf_connecting_ip`；如果源站不在 Cloudflare 后面，改成 `$proxy_add_x_forwarded_for`。
`/api/` 的反代也要传 `X-Forwarded-Proto $scheme`，否则 HTTPS 页面可能拿到 `ws://` 地址并被
浏览器按 mixed content 拦截；代码另有 `CF-Visitor` 兜底，但显式传协议更容易排查。

## 4. 验收

```bash
curl -s https://8bitgo.com/api/sfs/config | jq
curl -s https://8bitgo.com/api/sfs/status | jq
journalctl -u 8bitgo-sfs -n 100 --no-pager
```

必须看到：

- `config.enabled = true`
- `ruffle.socketProxy[0].host = "sas3server.ninjakiwi.com"`
- `ruffle.socketProxy[0].port = 444`
- `status.ready = true`

再打开 SAS3，浏览器 Network 应出现 `/sfs/sas3` 的 `101 Switching Protocols`。如果接口 ready
但游戏仍停在地图加载，先检查游戏引用的外部地图 SWF；SFS 只补联机协议，不会凭空补齐游戏资源。

## 5. 外部地图文件

分析到的 SAS3 客户端会从 `sas3maps.ninjakiwi.com/sas3maps/` 取多个地图 SWF。只有在你有权使用
这些文件时，才把完整文件放到自己的静态目录，并设置：

```dotenv
SFS_SAS3_MAP_BASE_URL=https://assets.8bitgo.com/roms/flash/sas3maps
```

接口会给 Ruffle 下发 `urlRewriteRules`。不要只放主 `SAS3.swf` 就把“能进标题画面”当成完整验收。

## 6. Linux / 原生 Flash 客户端（可选）

原生 Flash 不读取 `/api/sfs/config`，也不支持 Ruffle 的 WebSocket 代理。未修改的 SAS3.swf 写死
`sas3server.ninjakiwi.com:444`，所以必须满足下面一种：

1. 给启动器加 hosts/DNS 重定向，让该域名指向你的 DNS-only 子域/IP，并公开 TCP 444；
2. 重打包 SWF，把主机和端口改成你的入口；
3. 自己的 Linux 客户端先读 `/api/sfs/config` 响应里的 `native`，再连接返回的地址。

公开 TCP 时使用 [`native-tcp-stream.conf`](./native-tcp-stream.conf) 让 Nginx stream 在 444 接入、
再转到 `127.0.0.1:8044`。普通 Cloudflare 橙云不能代理任意 TCP；使用 DNS-only 并加防火墙/限流，
或使用支持 TCP 的代理产品。随后在 Node 环境中填写：

```dotenv
SFS_PUBLIC_TCP_HOST=sas3.example.com
SFS_PUBLIC_TCP_PORT=444
```

原生客户端的游玩次数不要按 TCP 连接数统计：掉线重连、进大厅和开一局都会重复连，而且 SFS 不知道
8BitGo 登录账号。启动器应在游戏**真正可玩后**，用用户级开放平台令牌上报一次：

```http
POST /api/open/v1/games/<8BitGo 中的 SAS3 slug>/play
Authorization: Bearer <带 library.write 的用户级 token>
```

服务端按账号跨设备永久去重；同一用户换 Linux、Windows 或浏览器再次上报会返回 `counted:false`，
同时仍会刷新“最近玩过”。设备码取令牌与完整响应见 [`../../docs/esp-open-api.md`](../../docs/esp-open-api.md)。

## 7. 回滚与隔离

联机有问题时最快回滚：

```bash
# server/.env
SFS_ENABLED=0
sudo systemctl restart 8bitgo
sudo systemctl disable --now 8bitgo-sfs
```

`/api/sfs/config` 仍返回 200，但 `enabled=false`；前端不会注入 socketProxy。无需改数据库、无需迁移，
也不会动现有游戏和存档。

## 8. 许可

FlashPrivateServer 使用 AGPL-3.0。部署和修改前请核对其许可要求；若修改了上游代码并通过网络
向用户提供服务，应向这些用户提供对应源码。本仓库的安装脚本保留了精确标签的源码目录，
但这不替代你自己的合规义务。上游项目：<https://github.com/GlennnM/FlashPrivateServer>。

本项目不提交 SAS3 游戏或地图资产；请只使用你有权运行和分发的文件。

## 9. 接口定义

机器可读规格在 [`openapi.yaml`](./openapi.yaml)：

- `GET /api/sfs/config`：Ruffle `socketProxy`、可选地图改写、可选原生 TCP 地址
- `GET /api/sfs/status`：sidecar 可达性、当前/累计连接、拒绝数与桥接字节数
- `WS /sfs/sas3`：二进制 WebSocket 帧与 SmartFox TCP 的透明双向桥
