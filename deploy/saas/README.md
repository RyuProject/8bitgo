# 8bitgo.com 的 Cloudflare for SaaS（SaaS 区域：8bitgo.top）

目标：NS 迁出 Cloudflare（换成能分「境内 / 境外」线路的 DNS）后，海外访客仍经 Cloudflare 访问
**同一个** `8bitgo.com`，大陆访客经 EdgeOne。origin 不变，登录、localStorage、IndexedDB 存档都不受影响。

## 现状（2026-11-17 已配好，未切流量）

| 项 | 值 |
|---|---|
| SaaS 区域 | `8bitgo.top`（zone `513afef951fc4989dfcff6f741d96fc9`） |
| 回源（fallback origin） | `origin.8bitgo.top` → A `38.76.186.225`，代理 |
| custom hostname 的 CNAME 目标 | `cname.8bitgo.top` |
| DCV 委派 | `_acme-challenge.<主机名>` CNAME `<主机名>.7336034047451951.dcv.cloudflare.com` |
| 区域设置 | 已与 8bitgo.com 对齐（0-RTT、Always Online、Always HTTPS、Early Hints、Hotlink、TLS 1.3 zrt…），SSL = Full，图片变换已开 |
| 规则 | 5 个阶段的自定义规则已原样复制；另加响应头 `X-8bitgo-Via: saas`，用来确认请求真的走了 SaaS 区域 |
| Worker 路由 | `assets` / `image` / `download` / `rom` / `roms` `.8bitgo.com/*` → `8bitgo-roms`（见 `worker/wrangler.toml`） |
| 已验证 | 测试主机名 `saas-test.8bitgo.com`：证书签发、回源到应用、Worker 路由读 R2、`/cdn-cgi/image/` 缩放都正常 |

⚠️ 8bitgo.com 还在 Cloudflare 时，custom hostname **激活不了**：Cloudflare 报
`The hostname is using Cloudflare and cannot be activated with an TXT or HTTP validation token`。
这保证了准备期不会接管线上流量；证书照样能先签好（`tv.8bitgo.com` 已验证）。
但一直 pending 的主机名会在 **7 天**后被删除（[backoff schedule](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/backoff-schedule/)），
所以正式主机名在迁移前 1～2 天用 `create-hostnames.sh` 一次建好。被删了就重跑脚本，或对它发一次空 PATCH 重新进入 pending。

## 额度：只用 9 个（免费 100）

| 主机名 | 为什么必须是 custom hostname |
|---|---|
| `8bitgo.com`、`www.8bitgo.com` | 主站（境外线路） |
| `tv.8bitgo.com` | TV 版，同一个应用 |
| `assets` / `image` / `rom` / `download` / `roms` | 走 `8bitgo-roms` Worker；`rom` / `download` 虽解析到优选 IP，Cloudflare 仍要靠 custom hostname 认出它们 |
| `html5.8bitgo.com` | 只读 Worker 路由（`WEBGAMES` 桶），仍占一个 SaaS 自定义主机名 |

**不占额度的：**

- Pages 子域（`cs16`、`pvz`、`terraria`、`celeste`、`diablo`、`minecraft`、`undertale`、`gta-vc`、`gamblers-table`）：
  Pages 自己支持外部 DNS 的自定义域（HTTP 验证），新 DNS 里 CNAME 到 `8bitgo-<名>.pages.dev` 即可。
- EdgeOne 的 `cn` / `cn-assets` / `image-cn`、`turn`、邮件记录：纯 DNS，原样搬。
- 通配 `*.8bitgo.com` **不迁**：它只是给未知子域回 404，迁后未知子域直接解析不到，效果相同。

## 迁移前准备

1. **已完成：`html5.8bitgo.com`**（2026-11-17）：`worker/src/html5.js` 只读整桶 `WEBGAMES`，CORS 白名单与
   R2 策略一致（`HTML5_ALLOWED_ORIGINS`），8bitgo.top 上已有 `html5.8bitgo.com/*` 路由。线上用一条单文件临时路由
   核对过：与 R2 自定义域同字节、同 ETag，Range 和预检正常，预检拒绝未授权来源，写请求拒绝。实际素材仍是公开 GET；
   CORS 只限制浏览器脚本读取，不能当作访问控制。迁移后可在 R2 控制台删掉 `8bitgo-webgame` 桶的 `html5.8bitgo.com`
   自定义域。差异：Range 请求不进边缘缓存（整份 ≤64MB 的 GET 才缓存）。
2. **待办：`deploy/cname-optimizer/`** 现在改的是 Cloudflare 上 8bitgo.com 的 `rom` / `download` 记录，NS 迁走后要改成调新 DNS 的 API。
3. **代码已支持（2026-11-22），生产配置待改：`server/.env` 的 `CF_ZONE_ID`**（按标签清 HTML 缓存，§2.37）现在可写多个区域。迁移前就改成
   `8b681704ebdc7249aec1b9d18669a78f,513afef951fc4989dfcff6f741d96fc9`，并给 `CF_PURGE_API_TOKEN` 加上 8bitgo.top 的 Cache Purge 权限，重启服务；
   迁移当天不用再动。迁走后旧区域清缓存会报错，代码只告警、不判失败。
4. **待办：EdgeOne** 新增加速域名 `8bitgo.com`，配置照搬 `cn.8bitgo.com`（回源 IP、回源 Host、`X-8bitgo-Edge` 回源头、WebSocket）。
5. **已完成：应用代码**（2026-11-22）：经 EdgeOne 回源的页面 SSR 标 `<html data-8bitgo-site="cn">`；`public/edge-route-v5.js` 见到它不再跳去 cn 子域，
   前端 `onCnSite()` 也认它，JS / CSS / API / 运行时都走同源。前提是 EdgeOne 给 8bitgo.com 回源时带同一个 `X-8bitgo-Edge` 回源头（第 4 条），
   ⚠️ 少了这个头，源站 nginx 的来源闸门（`deploy/nginx/edge-gate.conf`）把 EdgeOne 的回源当成直连，**一律回 403，大陆整站打不开**。
   切换前用 `curl -sI -H 'Host: 8bitgo.com' https://<EdgeOne 给的 CNAME 目标>/` 之类的方式先确认 EdgeOne 回源能拿到 200。
6. **待办：老 `cn.8bitgo.com` 用户的本地存档迁移**，确认完再把 cn 301 到主域。

## 迁移当天的顺序

1. `CLOUDFLARE_API_TOKEN=… ./create-hostnames.sh`：建好全部主机名，在 Cloudflare 的 8bitgo.com 区域写入所有权 TXT 与 DCV 记录，并等证书签好。
   `8bitgo.com`、`image`、`roms` 自己的证书在 8bitgo.com 区域用 TXT 验证续期，这三个名字的 `_acme-challenge` 不能放 CNAME，
   脚本对它们改用 TXT 验证；迁到新 DNS 时，再换成上面的 DCV 委派 CNAME，否则 90 天后续不了期。
2. 在新 DNS 里建好全部记录（境外线路指向 `cname.8bitgo.top`，并带上所有 `_cf-custom-hostname` TXT 与 `_acme-challenge` CNAME），把 TTL 调低。
3. **改 NS 之前**，在生产机（或本机终端）开着激活脚本，让它等着接手：
   ```bash
   CLOUDFLARE_API_TOKEN=<令牌> node deploy/saas/activate-hostnames.mjs --notify
   ```
   改完 NS，Cloudflare 过一段时间才会把 8bitgo.com 区域标成 moved；在那之前旧区域照常服务。一旦变成 moved，访问就交给
   这里的自定义主机名，而 pending 的主机名要等 Cloudflare 按退避节奏复查（7 天内 75 次、越往后间隔越长），迁移当天可能要等几个小时
   —— 这段时间海外打不开。脚本每分钟查一次区域状态，一变 moved 立刻对每个未激活的主机名 PATCH（带原样的 ssl 对象，立即重新验证并重置退避），
   之后每 2 分钟补一次直到全部 active，再请求每个主机名核对 `X-8bitgo-Via: saas`。
   令牌要有：8bitgo.com 区域 Zone Read；8bitgo.top 区域 Zone Read + SSL and Certificates **Edit**。先跑一次
   `--once` 确认令牌权限（缺权限会以退出码 2 直接说明），再跑 `--now --dry-run` 看要发的 PATCH。
   ⚠️ 在大陆网络上跑时，最后的核对会因为走了 EdgeOne 线路而报「没有 saas」，加 `--no-probe` 或换海外机器核对。
4. 在注册商处改 NS，盯着脚本输出；它退出 0 才算海外切换完成。脚本没开着的话，就手动在 8bitgo.top 的自定义主机名页面逐个点 Refresh。
5. 稳定后：删掉 `worker/wrangler.toml` 里属于 8bitgo.com 区域的**全部**路由，删掉测试主机名 `saas-test.8bitgo.com`。
   要删的是六条：`zone_name = "8bitgo.com"` 的 `assets` / `image` / `download` / `rom` 四条，**加上**两条没写
   `zone_name` 的 `custom_domain = true` 路由 `roms.8bitgo.com`、`image.8bitgo.com`。后两条也挂在 8bitgo.com 区域，
   只删带 `zone_name` 的那组的话它们会留下，NS 迁走后 `wrangler deploy` 直接失败。`zone_name = "8bitgo.top"` 的路由保留
   （`roms` / `image` 在那里已有普通路由，不再需要 custom_domain）。

回滚：在注册商处把 NS 改回 Cloudflare（dax / sofia）。8bitgo.com 区域的记录、规则、路由都还在，会自动恢复。
