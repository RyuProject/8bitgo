# nginx 连接槽调优

## 为什么要动它

2026-09-09 线上实测，源站是 Ubuntu 出厂值：

```
worker_processes auto;          → 解出 2
worker_connections 768;         → 合计 1536 个槽
```

**一条被反代出去的 SSE 占 nginx 两个连接槽**（面向客户端一个 + 面向 upstream 一个），
而侧边栏挂在每个页面上、一次页面加载开两条 SSE。于是：

| | |
|---|---|
| 连接槽合计 | 2 × 768 = **1536** |
| 能撑的并发反代连接 | ≈ **768** |
| 能撑的并发访客 | ≈ **384**（每人 2 条 SSE） |

槽位耗尽之后 nginx 接得下 TCP 却**完不成 TLS 握手** —— Cloudflare 那头看到的是
**525**，不是 502。502 是「后端挂了」，525 是「握不上手」，这里属于后者：
nginx 活着，只是没资源了。

⚠️ **爬虫是压垮它的那一批**。修法的第一、二道在代码里（`public/robots.txt` 的
`Disallow: /api/` 和 `server/src/sseGuard.js` 的准入闸），这里是第三道：把天花板抬起来。
三道缺一不可 —— 闸门挡的是「谁能进」，槽位决定的是「最多进多少」。

## 跑

```bash
sudo ./tune-nginx.sh
```

默认改成 `worker_connections 8192` + `worker_rlimit_nofile 65535`，两个 worker 就是
16384 个槽、约 8000 条并发反代连接。要别的值：

```bash
sudo CONNECTIONS=16384 NOFILE=131072 ./tune-nginx.sh
```

脚本会：备份 → 改值 → 补 systemd 的 `LimitNOFILE` → `nginx -t` → **平滑 reload**
（不断现有连接）→ 打印改完的实际值。`nginx -t` 不过就自动回滚。幂等，重复跑没事。

## 三个值为什么不能放进 conf.d/

它们分处两个上下文，而 `conf.d/*.conf` 和 `sites-enabled/*` 那两个 include
**都在 `http { }` 里面**，够不着：

| 指令 | 上下文 |
|---|---|
| `worker_processes` | main（文件顶层） |
| `worker_rlimit_nofile` | main |
| `worker_connections` | **events** |

所以只能改 `/etc/nginx/nginx.conf` 本体。脚本干的就是这件事。

## 为什么 rlimit 要一起抬

每条连接吃一个 fd。只抬槽位不抬 fd，故障会换个马甲回来：

```
accept() failed (24: Too many open files)
```

症状和槽位不够几乎一样（新连接进不来），但错误信息完全不同。而且 nginx 自己
`setrlimit` **只能抬到硬上限为止** —— systemd 给服务的默认硬上限可能低于我们要的值，
那样 `worker_rlimit_nofile` 会被**静默截断**。所以脚本同时下了一个
`/etc/systemd/system/nginx.service.d/nofile.conf`。

## 抬完之后，真正的governor 是 sseGuard

nginx 的槽位从此不再是瓶颈，**Node 那侧的 `SSE_MAX_TOTAL` 就变成了真正的上限**
（默认 600 条，≈ 300 个并发访客）。这是刻意的：保护 Node 进程比保护 nginx 重要，
它是那个会真的死掉的。

看着 `/api/diag` 的 `sse.total` 调：

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://8bitgo.com/api/diag | jq .sse
```

`total` 长期贴着 `maxTotal` 说明闸在扛，可以在 `server/.env` 里往上调
（比如 `SSE_MAX_TOTAL=1500`），**但别超过 `worker_connections × worker 数 ÷ 2` 的一半**，
给普通 HTTP 请求留出余量。

## 验证

```bash
nginx -T | grep -E "worker_processes|worker_rlimit_nofile|worker_connections"
pgrep -c -f "nginx: worker"                     # worker 进程数
ss -tnH state established "dport = :8788" | wc -l   # 现在挂着多少条到后端的连接
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://8bitgo.com/api/diag | jq .sse
```
