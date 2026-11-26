# 优选 CNAME 自动换线（8bitgo-cname-optimizer）

`download.8bitgo.com`、`rom.8bitgo.com` 是 **DNS-only** CNAME，指向第三方 Cloudflare 优选域名
（BestCF 汇总的那批，例如 `youxuan.cf.090227.xyz`）；Worker 路由 `download.8bitgo.com/*`、`rom.8bitgo.com/*`
把请求交给 `8bitgo-roms`。优选域名是别人维护的，随时可能失效、解析到非 Cloudflare IP，或者对我们的 Host 回 403。
这个定时任务负责：发现当前目标坏了，就自动换成另一个健康的优选域名。

## 怎么判

1. 基线：先直连 `assets.8bitgo.com` 取 64KB 探针 `roms/_route-probe/v1.bin`，拿到 ETag。基线都失败说明是我们自己或源站网络的问题，本轮不动 DNS。
2. 解析：用 AliDNS DoH 带大陆三网 ECS（电信 / 联通 / 移动）解析候选域名 —— 优选域名按运营商分线，源站直接解析拿到的是海外答案。某运营商 DoH 请求失败时结果记为「未知」，本轮不会把剩余线路当成三网健康，也不会因此累加当前目标故障次数；明确 NXDOMAIN / 无 IPv4 答案才算目标故障。
3. 体检：每个运营商取 2 个 IP，分别用即将被配置的 `rom.8bitgo.com` 或 `download.8bitgo.com` 作为 SNI / Host 取探针；长度和 ETag 都对才算通，超时 / 重置会重试一次。DNS 结果可以复用，但不同托管域名的 TLS / HTTP 结果必须分开测。
4. 健康 = 三网 DoH 均有明确答案、没有非 Cloudflare IP、每个运营商至少一个 IP 能用、整体至少一半能用。
5. 当前目标**连续 3 次**（约 15 分钟）不健康才换线。新目标从「BestCF 列表 + 内置保底」里挑健康的，优先不和另一个托管域名共用同一个目标，再按源站测到的耗时取快的。
6. 当前目标健康就**一直不动**：源站在香港，测出来的快慢代表不了大陆玩家，不拿它当换线理由。

### 负载（2026-11-22 优化）

- 平时每轮只体检当前目标：同一个目标、同一个 IP 一轮只测一次，约十来个 64KB 请求。
- 只有某个域名**这一轮就会到换线阈值**时才去找候选；候选按实际托管域名逐个验证，单轮最多 4 个候选并发，凑够 3 个健康候选就停。
  以前第一次不健康就把全部候选同时打出去（几百个并发 TLS 连接），而真正换线要等第三次。
- 找过一次一个健康候选都没有，30 分钟内不再全量体检。
- 每个探测有整体硬时限，慢连接拖不住整轮；systemd 单元低优先级运行并限 CPU / 内存。
- `--dry-run` 不写状态文件，手动试跑不会影响定时器的失败计数；默认状态路径和单元一致。
- 改 DNS 失败只影响那一个域名，状态照常保存。
- 环境变量的域名、探针大小、并发和超时在启动时校验；Cloudflare API 查询必须精确返回一条预期的 DNS-only CNAME，否则 fail closed，不改 DNS。
- 外部 BestCF 候选列表按 UTF-8 字节流最多读取 256 KiB；超限或流中断就取消正文并退回内置候选，不把整份异常响应读入内存，也不使用截断域名。

## 大陆玩家的真实回报（2026-11-22）

源站在香港，体检只能发现「死了 / 不是 CF / 对我们的 Host 报错」，看不到「香港通、大陆不通」。所以浏览器的线路记分板
（`src/services/romRouteHealth.ts`）每记一次 `rom.8bitgo.com` / `download.8bitgo.com` 的成败，`romRouteReport.ts` 就攒一个计数，
最多一分钟或离开页面时用 sendBeacon 发到 `POST /api/route-health`。服务端（`server/src/route-report.js`）只收大陆访客，
按 IP 的 HMAC（进程内随机密钥）一人一票，只在内存里留 30 分钟。本任务每轮从 `GET /api/internal/route-health?since=…` 读汇总
（只允许本机直连，经 nginx 进来带 X-Forwarded-For 的一律 404）：

- 只算当前目标生效 10 分钟之后的回报（DNS TTL + 运营商缓存期间玩家还在连旧目标）；
- 至少 5 个不同访客才下结论：≥60% 只失败 → 判不健康（哪怕源站体检正常）；≥80% 有成功 → 源站体检的连通性失败按玩家的算
  （解析到非 CF IP 这种硬伤除外）；其余维持源站结论；
- 照旧要连续 3 轮不健康才换线；因玩家回报换掉的目标 6 小时内不再选回来（源站看它多半还是健康）；
- 新目标仍必须先过源站体检。伪造回报最坏只会把线路换成另一条同样健康的候选。

读不到回报（服务没起来、端口不对）只打一行日志，本轮按原来的源站体检判。服务端端口不是 8788 时设 `CNAME_OPT_REPORT_URL`。

浏览器端本来就会在优选线路失败时回退到 `assets.8bitgo.com`，这个任务只是把「整条线路坏掉」的时间缩短。

## 装（生产机）

```bash
# 1. Cloudflare 控制台建一个 API 令牌：权限 Zone → DNS → Edit，只限 8bitgo.com
sudo install -d -m 755 /etc/8bitgo
sudo install -m 600 deploy/cname-optimizer/cname-optimizer.env.example /etc/8bitgo/cname-optimizer.env
sudo editor /etc/8bitgo/cname-optimizer.env          # 填 CF_DNS_API_TOKEN

# 2. 先手动看一遍
set -a; . /etc/8bitgo/cname-optimizer.env; set +a
node deploy/cname-optimizer/cname-optimizer.mjs --status     # 只体检、列出全部候选排名
node deploy/cname-optimizer/cname-optimizer.mjs --dry-run    # 走完整判定，但不改 DNS

# 3. 挂定时
sudo cp deploy/cname-optimizer/8bitgo-cname-optimizer.{service,timer} /etc/systemd/system/
# 换成 8bitgo.service 正在用的 node（nvm 装的不在 /usr/local/bin）
NODE_BIN=$(readlink -f /proc/$(systemctl show -p MainPID --value 8bitgo)/exe)
sudo sed -i "s#/usr/local/bin/node#$NODE_BIN#" /etc/systemd/system/8bitgo-cname-optimizer.service
sudo systemctl daemon-reload && sudo systemctl enable --now 8bitgo-cname-optimizer.timer
```

## 看日志

```bash
journalctl -u 8bitgo-cname-optimizer -n 50          # 每轮的体检结果；换线会打「[换线]」
cat /var/lib/8bitgo-cname-optimizer/state.json      # 连续失败次数、最近 50 次换线记录
```

换线时 DNS 记录的备注会写上切换时间和原因；记录 TTL 是 300 秒，加上运营商 DNS 缓存，玩家侧通常 5～10 分钟内生效。

回归：`npm run test:cname-optimizer`（纯函数，不联网）、`cd server && npm run test:route-report`、`npm run test:rom-route-health`。
