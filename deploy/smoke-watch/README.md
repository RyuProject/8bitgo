# 定时开局与搜索抓取入口巡检（smoke-watch）

每 15 分钟用无头 Chrome 走公网真实路径（`https://8bitgo.com`），把一款 NES、一款 CPS1 街机跑到首帧；
并检查 `robots.txt`、动态 sitemap 索引和索引列出的所有子 sitemap（静态、合集、游戏、文章、平台 / 类型目录）。robots 检查确认公开路径可抓、`/api/` 仍被限制、游戏媒体代理可抓，并保持单一通配爬虫组。抓取巡检还会抽查默认与日文首页、从静态 sitemap 最多抽查 8 个页面、从每个非空子 sitemap 抽查 1 个页面，验证 HTTP 200、HTML Content-Type、SSR 标题 / H1、语言、self-canonical 和可索引状态；另从首页推荐中抽查最多 8 个合集详情，确保首页没有推荐被标记为 `noindex` 的低信息合集；游戏详情页另外检查 VideoGame JSON-LD。
游戏开局失败先等 60 秒复核；抓取入口探测各请求最多重试一次。持续故障发飞书
（`server/scripts/notify-lark.mjs`），恢复时分别发「已恢复」。抓取巡检使用普通浏览器请求头，
只证明公开入口可读，**不证明已验证 Googlebot、Bingbot 或 AI 搜索爬虫没有被 CDN/WAF 拦截**。
来由见 AGENTS.md §2.7.2（2026-11-17 全站 EmulatorJS 事故：健康检查一直 200，几个小时没人知道）。

## 前提

- 生产机装了 Chrome / Chromium（**不能用 snap 版**：snap 的私有 `/tmp` 让脚本读不到 DevTools 端口）。
  2026-11-18 装的是 Google 官方 `.deb`：`/usr/bin/google-chrome-stable`。
- `server/.env` 里配了 `ALERT_LARK_WEBHOOK`（飞书机器人地址，不进 git）。验收：
  `node server/scripts/notify-lark.mjs --test --strict`

## 安装 / 更新

```bash
install -m 644 deploy/smoke-watch/8bitgo-smoke-watch.service deploy/smoke-watch/8bitgo-smoke-watch.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now 8bitgo-smoke-watch.timer
```

脚本本身直接跑仓库里的文件，`git pull` 之后自动生效；只有改了 `.service` / `.timer` 才要重新 install。

## 看状态

```bash
systemctl list-timers 8bitgo-smoke-watch.timer
tail -n 30 /var/log/8bitgo-smoke-watch.log
cat /var/lib/8bitgo/smoke-watch/status           # ok / down
cat /var/lib/8bitgo/smoke-watch/last-run.txt     # 最近一次巡检的完整输出
cat /var/lib/8bitgo/smoke-watch/seo-status       # ok / down
cat /var/lib/8bitgo/smoke-watch/seo-last-run.txt # robots / sitemap 最近一次检查
systemctl start 8bitgo-smoke-watch.service       # 立刻跑一次
```

## 可调（写进 service 的 `Environment=`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SMOKE_WATCH_BASE` | `https://8bitgo.com` | 巡检的站点 |
| `SMOKE_WATCH_GAMES` | `super-mario-bros,cadillacs-and-dinosaurs` | 逗号分隔的 slug |
| `SMOKE_WATCH_REMIND_SEC` | `7200` | 故障持续期间多久提醒一次 |
| `SMOKE_WATCH_RECHECK_SEC` | `60` | 第一次失败后隔多久复核 |

冒烟会拦下启动漏斗和游玩计数请求，不污染统计；Chrome 的临时 profile 每次跑完都会删掉。
