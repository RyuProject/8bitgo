# 源站看门狗（8bitgo-watchdog）

**探到故障才重启，坏哪层修哪层。** 平时零打扰，出事时日志里留下「是哪一层坏的」的证据。

## 为什么不是无条件定时重启

- 525 的故障点在 **前置代理的 443（TLS 握手）**，502 的故障点在 **Node（8788）**。
  无差别重启两边，等于每次都在没病的那层上制造几秒真空。
- 更要紧的是：定时重启会把「多久坏一次、坏在哪层」这个信息**抹掉**，
  以后永远只能靠猜。这个脚本每一轮探测都写日志，下次再出 525 直接翻日志就有答案。

## 装

```bash
sudo install -m 755 8bitgo-watchdog.sh /usr/local/bin/8bitgo-watchdog.sh
sudo cp 8bitgo-watchdog.conf.example /etc/8bitgo-watchdog.conf   # 按注释改
sudo /usr/local/bin/8bitgo-watchdog.sh --status                   # 先看探测结果对不对
sudo /usr/local/bin/8bitgo-watchdog.sh --dry-run                  # 只探不动手，跑一两天更稳
```

`--status` 里 **TLS 和后端两行都必须是「正常」**，才能挂上定时。有一行是「失败」
而站点其实是好的，说明探测姿势不对（最常见是开了 Authenticated Origin Pulls，
见 conf 里 `CLIENT_CERT`），这时候挂上去等于每分钟重启一次。

装定时（二选一）：

```bash
# systemd timer（推荐，日志进 journal）
sudo cp 8bitgo-watchdog.service 8bitgo-watchdog.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now 8bitgo-watchdog.timer

# 或者 cron
* * * * * /usr/local/bin/8bitgo-watchdog.sh >/dev/null 2>&1
```

## 日志在哪

| 看什么 | 命令 |
|---|---|
| 看门狗自己 | `tail -f /var/log/8bitgo-watchdog.log` |
| 看门狗（systemd 那份） | `journalctl -u 8bitgo-watchdog -f` |
| 当前状态一览 | `8bitgo-watchdog.sh --status` |
| 重启次数 / 冷却 | `ls -l /var/lib/8bitgo-watchdog/` |

## 三道刹车

| 参数 | 默认 | 作用 |
|---|---|---|
| `FAIL_STREAK` | 2 | 连续 2 次探失败才动手，滤掉单次抖动 |
| `COOLDOWN` | 600 | 同一层两次重启至少隔 10 分钟 |
| `MAX_PER_DAY` | 4 | 同一层一天最多 4 次，超了**只记日志不动手** |

`MAX_PER_DAY` 被打满 = 这不是抖动，是真故障，重启救不了，去查根因。这是刻意的：
看门狗的职责是止血，不是替你把病瞒下去。

## 它不会做的事

- **nginx -t 不过时不重启**。配置写错的话 `restart` 会让 nginx 彻底起不来，
  比 525 严重得多；脚本会把 `nginx -t` 的报错抄进日志然后停手。
- **裸跑（nohup/screen）的 Node 不去拉**。没有守护进程就没法安全拉起来，
  脚本只报 PID 并提示你配 systemd 或 pm2。
- 不碰证书、不碰 Cloudflare、不清缓存。

## 已知的两个坑

1. **pm2 的进程列表是按用户存的。** root 跑 timer 时看不到你自己那份，
   必须在 conf 里填 `PM2_USER=<你的部署用户>`，否则脚本会以为没有 pm2。
2. **开了 Authenticated Origin Pulls 必须填客户端证书。**
   nginx 配了 `ssl_verify_client on` 之后，本机不带客户端证书去探会被直接拒 ——
   看门狗会把「AOP 正常工作」误判成故障，然后每分钟重启一次 nginx。
