# 8bitgo.com 的 NS 迁到 DNSPod：操作手册

目标：权威 DNS 换成 DNSPod，按线路分流 —— **境内**解析到 EdgeOne，**默认**（境外）解析到 Cloudflare SaaS
（`cname.8bitgo.top`）。为什么不迁到 EdgeOne 自己的 DNS、SaaS 区域怎么搭的，见同目录 `README.md`。

记录值取自 2026-11-22 的 Cloudflare 8bitgo.com 区域与 8bitgo.top 自定义主机名。迁移前用
`cf dns records list -z 8bitgo.com` 再核对一遍，尤其是 `rom` / `download` 这两条：它们由 cname-optimizer 自动换目标。

---

## 一、迁 NS 之前必须做完的（按顺序）

### 1. 时间窗口

- 9 个自定义主机名 11-22 建的，一直 pending 约 7 天后会被 Cloudflare 删除：**最好 11-28 前迁完**，晚了先重跑 `create-hostnames.sh`。
- Cloudflare 侧证书 2027-02-19 到期，约 2027-01-20 开始续期：第 5 步的证书分工要在这之前落实。
- 挑海外访问量最低的时段（北京时间下午到傍晚，对应美洲凌晨）。

### 2. DNSPod 准备

1. DNSPod 控制台添加域名 `8bitgo.com`，记下分配的两台 NS（形如 `xxx.dnspod.net`）。
2. **确认三件事**（控制台添加记录时就能看到，文档里说法不一）：
   - 免费版的「线路」下拉里有没有 **境内**（有「境外」也行，此时 EdgeOne 记录放「默认」、Cloudflare 记录放「境外」，反过来不行）。
   - **根域（`@`）能不能加 CNAME**，以及 `@` 上的 CNAME 能否和 Google 的 TXT 共存。不能共存时，先在 Search Console
     换成「HTML 文件」或「HTML 标记」方式验证，再删这条 TXT，否则会掉 Search Console 验证。
   - TTL 最小值：免费版 600 秒。迁移当月建议开**专业版**（60 秒），出问题时改记录 / 回滚能快 10 倍。
3. 按「二、记录清单」把记录全部建好（这一步不影响线上：注册商的 NS 还没改）。
4. **改 NS 前直接问 DNSPod 核对**（记录错了在这一步就能发现，零风险）：

   ```bash
   dig @<DNSPod 的 NS> 8bitgo.com CNAME +short                      # 默认线路，应是 cname.8bitgo.top
   dig @<DNSPod 的 NS> 8bitgo.com CNAME +subnet=114.114.114.0/24 +short   # 模拟大陆，应是 EdgeOne 的 CNAME
   dig @<DNSPod 的 NS> _cf-custom-hostname.assets.8bitgo.com TXT +short
   dig @<DNSPod 的 NS> resend._domainkey.8bitgo.com TXT +short
   ```

   `+subnet` 要 DNSPod 支持 ECS 才有效；不支持时用大陆机器 `dig @<DNSPod 的 NS>` 实测。

### 3. EdgeOne 准备（大陆线路的落点）

在现有站点（`cn.8bitgo.com` 所在的那个 CNAME 接入站点）里新增加速域名 **`8bitgo.com`**（以及 `www.8bitgo.com`，见下）：

- 回源配置照抄 `cn.8bitgo.com`：回源 IP `38.76.186.225:443`、回源 Host `8bitgo.com`、HTTPS 回源、WebSocket 打开、
  规则引擎「修改 HTTP **回源**请求头」带 `X-8bitgo-Edge`（值在生产机 `/root/edgeone-origin-secret.txt`）。
- ⚠️ **漏了 `X-8bitgo-Edge`，源站 nginx 把 EdgeOne 当直连，大陆整站 403**（`deploy/nginx/edge-gate.conf`）。
- 加速区域：全球可用区（不含中国大陆）—— 没有 ICP 备案，和 cn 一样走香港节点。
- 缓存规则照抄 cn（HTML 按源站 `s-maxage=300`，`/api/` 不缓存）。
- 记下 EdgeOne 给这两个域名的 CNAME 目标（形如 `8bitgo.com.eo.dnse3.com`），填进记录清单。
- **证书必须在迁 NS 之前签好**，见第 5 步。没签好就切，大陆访客打开 HTTPS 直接报证书错误。
- **验证回源**：改 NS 前就能测，强制把域名解析到 EdgeOne 的地址：

  ```bash
  curl -sI --resolve 8bitgo.com:443:<dig EdgeOne CNAME 得到的 IP> https://8bitgo.com/ | head -5
  ```

  要 200，且不是 403。

### 4. 生产机配置（迁移前改好，当天不用动）

- `server/.env`：`CF_ZONE_ID=8b681704ebdc7249aec1b9d18669a78f,513afef951fc4989dfcff6f741d96fc9`，
  `CF_PURGE_API_TOKEN` 加上 8bitgo.top 的 Cache Purge 权限，重启服务。不改的话迁移后海外页面要过一天才更新。
- 准备一个给激活脚本用的令牌：8bitgo.com Zone Read；8bitgo.top Zone Read + **SSL and Certificates Edit**。
  先跑一遍确认：`CLOUDFLARE_API_TOKEN=<令牌> node deploy/saas/activate-hostnames.mjs --now --dry-run`。

### 5. 证书分工：`_acme-challenge` 一个名字只能给一家

Cloudflare 和 EdgeOne 都要给 **`8bitgo.com`、`www.8bitgo.com`** 签证书，两家默认都用 `_acme-challenge.<名字>` 这条记录，
而同一个名字只能指向一边。EdgeOne 的「自动 HTTP 验证」又要求不按地区解析，和本方案冲突。分工：

| 名字 | `_acme-challenge` 给谁 | 另一家怎么验证 |
|---|---|---|
| `8bitgo.com`、`www.8bitgo.com` | **EdgeOne**（DNS 委派验证：CNAME 到 EdgeOne 给的地址） | Cloudflare 改用 **HTTP 验证**：CA 的验证服务器在海外，按默认线路解析到 Cloudflare，能通过 |
| 其余 7 个（assets、image、rom、download、roms、html5、tv） | **Cloudflare**（CNAME 委派到 `<名字>.7336034047451951.dcv.cloudflare.com`） | 只走 Cloudflare，无冲突 |

做法：
1. EdgeOne 控制台给 `8bitgo.com` / `www.8bitgo.com` 选免费证书 + DNS 委派验证，拿到委派目标，写进 DNSPod。
   因为改 NS 前 DNSPod 还不生效，这一步要么**在 Cloudflare 的 8bitgo.com 区域**临时把 `_acme-challenge.8bitgo.com`
   / `_acme-challenge.www.8bitgo.com` 换成 EdgeOne 的委派 CNAME（Cloudflare 侧这两张证书已签发、2027-02 才到期，暂时不需要这条记录），
   让 EdgeOne 先签好；要么改 NS 后再签（大陆会有一段证书空窗，不推荐）。
2. 迁移完成、主机名 active 之后，把 Cloudflare 上 `8bitgo.com`、`www.8bitgo.com` 两个自定义主机名的验证方式改成 HTTP
   （8bitgo.top → Custom Hostnames → Edit → 证书验证方式），必须在 **2027-01-20 前**完成，否则续期失败。
3. ⚠️ 不要给域名加 CAA 记录；要加就同时允许两家的 CA（Cloudflare 用 ssl.com / Google Trust Services / Let's Encrypt，EdgeOne 以控制台为准）。

### 6. 备份与回滚准备

- 导出 Cloudflare 8bitgo.com 区域：DNS → Records → Export（BIND 文件），连同 `cf dns records list -z 8bitgo.com` 的 JSON 存好。
- 记住：**改 NS 后 Cloudflare 免费版会在区域被标成 moved 的 7 天后删除它**，删除后无法恢复，「改回 NS 就回滚」只在 7 天内有效。
  删除会一起带走：Pages 子域的绑定、Worker 自定义域（roms / image）、R2 自定义域（assets / html5）、规则、DNS。

---

## 二、DNSPod 记录清单

`<EO:…>` 是 EdgeOne 控制台给的 CNAME 目标；线路「默认」= 境外 + 其它，「境内」= 中国大陆。TTL 迁移期间用最小值。

### 主站与 SaaS 主机名

| 主机记录 | 类型 | 线路 | 记录值 | 说明 |
|---|---|---|---|---|
| `@` | CNAME | 默认 | `cname.8bitgo.top` | 海外 → Cloudflare SaaS |
| `@` | CNAME | 境内 | `<EO:8bitgo.com>` | 大陆 → EdgeOne |
| `www` | CNAME | 默认 | `cname.8bitgo.top` | |
| `www` | CNAME | 境内 | `<EO:www.8bitgo.com>` | 只是 301 到主域；不想在 EdgeOne 加 www 就只留默认线路，大陆访客多一次慢跳转 |
| `tv` | CNAME | 默认 | `cname.8bitgo.top` | |
| `assets` | CNAME | 默认 | `cname.8bitgo.top` | Worker 路由在 8bitgo.top 上 |
| `image` | CNAME | 默认 | `cname.8bitgo.top` | 原来是 `AAAA 100::`（Worker 自定义域占位），换掉 |
| `roms` | CNAME | 默认 | `cname.8bitgo.top` | 同上 |
| `html5` | CNAME | 默认 | `cname.8bitgo.top` | 原来是 R2 自定义域 |
| `rom` | CNAME | 默认 | 迁移当天 `cf dns records list` 里的值（11-22 是 `bestcf.030101.xyz`） | 优选 IP，不走代理；迁移后 cname-optimizer 不再生效，值会固定 |
| `download` | CNAME | 默认 | 同上（11-22 是 `cf.0sm.com`） | |

### SaaS 主机名的所有权与证书验证（缺一条，那个主机名就激活不了）

| 主机记录 | 类型 | 记录值 |
|---|---|---|
| `_cf-custom-hostname` | TXT | `f6c47a28-fbf9-46b7-8aba-e8777fc6e74a` |
| `_cf-custom-hostname.www` | TXT | `deca2cad-4e12-43ba-8ed5-18929b1794ee` |
| `_cf-custom-hostname.tv` | TXT | `c89eee1d-bde7-481b-9358-6098924a4dc2` |
| `_cf-custom-hostname.assets` | TXT | `0000d2c7-cbf8-4b00-9bf1-b013e7a146b7` |
| `_cf-custom-hostname.image` | TXT | `346f6480-8f82-4245-a3f3-bea5831daa1a` |
| `_cf-custom-hostname.rom` | TXT | `e2c4fd24-b6a6-41bb-90a3-2222ef6aa4ba` |
| `_cf-custom-hostname.download` | TXT | `3958f5da-54f1-4f6a-ad8e-0dbf6c1595fc` |
| `_cf-custom-hostname.roms` | TXT | `4c90a6b3-f6ab-4bd9-97cd-e8e6d0a5088a` |
| `_cf-custom-hostname.html5` | TXT | `1680b339-d799-4372-9911-50fd7a0eaafb` |
| `_acme-challenge.tv` | CNAME | `tv.8bitgo.com.7336034047451951.dcv.cloudflare.com` |
| `_acme-challenge.assets` | CNAME | `assets.8bitgo.com.7336034047451951.dcv.cloudflare.com` |
| `_acme-challenge.image` | CNAME | `image.8bitgo.com.7336034047451951.dcv.cloudflare.com` |
| `_acme-challenge.rom` | CNAME | `rom.8bitgo.com.7336034047451951.dcv.cloudflare.com` |
| `_acme-challenge.download` | CNAME | `download.8bitgo.com.7336034047451951.dcv.cloudflare.com` |
| `_acme-challenge.roms` | CNAME | `roms.8bitgo.com.7336034047451951.dcv.cloudflare.com` |
| `_acme-challenge.html5` | CNAME | `html5.8bitgo.com.7336034047451951.dcv.cloudflare.com` |
| `_acme-challenge` | CNAME | `<EdgeOne 给 8bitgo.com 的证书委派目标>` |
| `_acme-challenge.www` | CNAME | `<EdgeOne 给 www.8bitgo.com 的证书委派目标>` |

`image`、`roms` 在 Cloudflare 上现在是 TXT 验证，迁过去**不要照抄那两条 TXT**，用上表的 CNAME 委派，否则 90 天后续不了期。
所有 `_cf-custom-hostname` / `_acme-challenge` 只放「默认」线路即可（线路只影响查询来源，验证方在海外）。

### 原样搬的记录

| 主机记录 | 类型 | 线路 | 记录值 |
|---|---|---|---|
| `cn` | CNAME | 默认 | `cn.8bitgo.com.eo.dnse3.com` |
| `cn-assets` | CNAME | 默认 | `cn-assets.8bitgo.com.eo.dnse3.com` |
| `image-cn` | CNAME | 默认 | `image-cn.8bitgo.com.eo.dnse3.com` |
| `turn` | A | 默认 | `85.137.247.31` |
| `edgeonereclaim` | TXT | 默认 | `reclaim-t9fxyld566lym6vfapr6uja8oom4b95e` |
| `@` | TXT | 默认 | `google-site-verification=5ywN_F-GAsQ4cZ3-z9yMHl-xBXEOCtHANuyVWXZxUcU`（和 `@` 的 CNAME 冲突时见一、2） |
| `send` | MX | 默认 | `feedback-smtp.ap-northeast-1.amazonses.com`，优先级 10 |
| `send` | TXT | 默认 | `v=spf1 include:amazonses.com ~all` |
| `resend._domainkey` | TXT | 默认 | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDS5qT92BwASQP3UCvC+8xicYIdM/oN+FPuJ6DrSA0/kjR64Q2Az1Yhitizw30Qzn7DgFjm+c+hyozZo3JIy4mSNINVPvKA+vK7Yq/uSYwoZDP9ozHy78wGLC/uUlrp2QNM/gGAEa//8Y0pAvWL465EjAvq+Jn8ajKtFobneEOd3QIDAQAB` |

⚠️ 最后三条是 **Resend 发信**用的（登录验证码靠它）。写错一个字符，所有人收不到验证码、登录不了；迁完立刻在 Resend 的 Domains 页面确认仍是 Verified。

### Pages 子域

| 主机记录 | 类型 | 线路 | 记录值 |
|---|---|---|---|
| `celeste` | CNAME | 默认 | `8bitgo-celeste.pages.dev` |
| `cs16` | CNAME | 默认 | `8bitgo-cs16.pages.dev` |
| `diablo` | CNAME | 默认 | `8bitgo-diablo.pages.dev` |
| `gamblers-table` | CNAME | 默认 | `8bitgo-gamblers-table.pages.dev` |
| `gta-vc` | CNAME | 默认 | `8bitgo-gta-vc.pages.dev` |
| `minecraft` | CNAME | 默认 | `8bitgo-minecraft.pages.dev` |
| `pvz` | CNAME | 默认 | `8bitgo-pvz.pages.dev` |
| `terraria` | CNAME | 默认 | `8bitgo-terraria.pages.dev` |
| `undertale` | CNAME | 默认 | `8bitgo-undertale.pages.dev` |

这些现在是「Cloudflare 区域内」绑定的 Pages 自定义域。区域迁走后 Pages 要按外部 DNS 重新验证，可能短暂显示 inactive；
迁移后逐个看 Pages 项目的 Custom domains，失效的删掉重加。

### 不迁的

- `*.8bitgo.com`（通配）：只是给未知子域回 404，迁后未知子域直接解析不到，效果相同。
- `saas-test`、`_cf-custom-hostname.saas-test`、`_acme-challenge.saas-test`：测试用，迁移稳定后在 8bitgo.top 上删掉这个主机名。
- 代码里引用了但 DNS 里本来就没有的 `digiverse`、`subway-surfers`：要上线时再加。

---

## 三、迁移当天

1. 开着激活脚本（生产机上）：

   ```bash
   CLOUDFLARE_API_TOKEN=<令牌> node deploy/saas/activate-hostnames.mjs --notify
   ```

2. 在 Dynadot 把 NS 改成 DNSPod 给的两台。.com 的 NS 记录 TTL 是 2 天，各地解析器陆续换过去；这段时间两边 DNS 都在答，
   旧的 Cloudflare 区域仍是 active，照常服务，不断站。
3. 等 Cloudflare 把 8bitgo.com 区域标成 moved（Cloudflare 自己检测，时间不定），脚本会立刻激活全部主机名并核对 `X-8bitgo-Via: saas`；
   退出 0 才算海外切换完成。在大陆网络上跑会因为走 EdgeOne 而核对失败，加 `--no-probe` 或在海外机器上核对。
4. 逐项验收：

   ```bash
   # 海外（在海外机器 / 生产机上）
   curl -sI https://8bitgo.com/ | grep -iE '^HTTP|x-8bitgo-via'          # 200 + saas
   curl -sI https://assets.8bitgo.com/roms/_route-probe/v1.bin | head -1
   curl -s https://download.8bitgo.com/api/diag | head -c 300
   # 大陆（大陆网络）
   curl -sI https://8bitgo.com/ | grep -iE '^HTTP|eo-'                    # 200，来自 EdgeOne
   curl -s https://8bitgo.com/ | grep -o 'data-8bitgo-site="cn"'          # SSR 认出是 EdgeOne 回源
   ```

   再在浏览器里各开一款 NES、街机、Flash、DOS 游戏，登录一次（收验证码 = Resend 正常）。

## 四、迁移后（稳定 1～2 天内）

- `worker/wrangler.toml` 删掉属于 8bitgo.com 区域的 6 条路由（见 `README.md` 第 5 步），否则区域被删后 `wrangler deploy` 失败。
- 停掉或改造 `deploy/cname-optimizer`（它改的是 Cloudflare 上已经作废的记录）。
- 把 Cloudflare 上 `8bitgo.com`、`www.8bitgo.com` 的证书验证改成 HTTP（一、5），2027-01-20 前必须完成。
- 检查 Pages 子域都恢复正常。
- 考虑之后是否把 `cn.8bitgo.com` 301 到主域（老用户本地存档要先迁，README 待办第 6 条）。
- 稳定后再考虑在 DNSPod 开 DNSSEC；**迁移期间别开**（注册商加了 DS 而记录对不上，整个域名对校验型解析器失效）。

## 回滚

7 天内：Dynadot 把 NS 改回 `dax.ns.cloudflare.com` / `sofia.ns.cloudflare.com`，Cloudflare 区域会从 moved 变回 active，
记录、规则、路由原样恢复。超过 7 天区域已被删，只能重新添加并手工恢复全部配置（用一、6 的导出文件）。
