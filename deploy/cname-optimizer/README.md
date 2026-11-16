# 优选 CNAME 自动换线（8bitgo-cname-optimizer）

`download.8bitgo.com`、`rom.8bitgo.com` 是 **DNS-only** CNAME，指向第三方 Cloudflare 优选域名
（BestCF 汇总的那批，例如 `youxuan.cf.090227.xyz`）；Worker 路由 `download.8bitgo.com/*`、`rom.8bitgo.com/*`
把请求交给 `8bitgo-roms`。优选域名是别人维护的，随时可能失效、解析到非 Cloudflare IP，或者对我们的 Host 回 403。
这个定时任务负责：发现当前目标坏了，就自动换成另一个健康的优选域名。

## 怎么判

1. 基线：先直连 `assets.8bitgo.com` 取 64KB 探针 `roms/_route-probe/v1.bin`，拿到 ETag。基线都失败说明是我们自己或源站网络的问题，本轮不动 DNS。
2. 解析：用 AliDNS DoH 带大陆三网 ECS（电信 / 联通 / 移动）解析候选域名 —— 优选域名按运营商分线，源站直接解析拿到的是海外答案。DoH 不可用时退回本机解析。
3. 体检：每个运营商取 2 个 IP，连该 IP、SNI / Host 用我们的域名取探针；长度和 ETag 都对才算通，超时 / 重置会重试一次。
4. 健康 = 没有非 Cloudflare IP、每个运营商至少一个 IP 能用、整体至少一半能用。
5. 当前目标**连续 3 次**（约 15 分钟）不健康才换线。新目标从「BestCF 列表 + 内置保底」里挑健康的，优先不和另一个托管域名共用同一个目标，再按源站测到的耗时取快的。
6. 当前目标健康就**一直不动**：源站在香港，测出来的快慢代表不了大陆玩家，不拿它当换线理由。

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

回归：`npm run test:cname-optimizer`（纯函数，不联网）。
