# 定时开局巡检（smoke-watch）

每 15 分钟用无头 Chrome 走公网真实路径（`https://8bitgo.com`），把一款 NES、一款 CPS1 街机跑到首帧；
跑不通先等 60 秒复核，仍失败就发飞书（`server/scripts/notify-lark.mjs`），恢复时再发一条「已恢复」。
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
