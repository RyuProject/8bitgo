# 把后端收进 systemd

## 为什么

2026-09-09，看门狗的 `--status` 报：

```
后端守护    : pid:385543
```

这个格式的意思是**既没有 pm2 也没有 systemd unit** —— Node 是裸跑的（nohup / screen）。

后果是那次事故里最关键、也最容易被漏掉的一条：**01:39:28 进程死掉之后，
没有任何东西会把它拉起来。** 站点一直 502 到有人手动去看为止。所谓
「`npm ci` + `build` 之后就恢复了」，本质就是**你手动重启了它** —— 那两条命令
本身跟 525 / 502 都没关系。

裸跑还有两个连带问题：

- 开机不自启。机器重启（比如现在待重启的那次内核升级）之后站点不会自己回来。
- 看门狗对裸跑进程**刻意不动手** —— 没有守护进程就没法安全地拉起来，它只会报 PID。
  也就是说「后端」那一层的自愈能力目前是零。

## 跑

```bash
sudo ./install-service.sh
```

它会：探测当前占着 8788 的进程（确认是 node 才动）→ 按同一个用户和 node 路径写
`/etc/systemd/system/8bitgo.service` → 停掉裸跑的那个 → `enable --now` →
轮询 `/api/health` 直到起来。**有 2~5 秒 502**，nginx 侧会立刻恢复。

自定义：

```bash
sudo UNIT_NAME=8bitgo APP_DIR=/var/www/8bitgo/server NOFILE=65535 ./install-service.sh
```

## 两个容易写错的地方

**`WorkingDirectory` 必须是 `server/`。** `index.js` 顶上是 `import 'dotenv/config'`，
而 dotenv 是从 **`process.cwd()`** 找 `.env` 的 —— 指到仓库根目录会静默地一个环境变量
都读不到（数据库、Resend、JWT、OIDC 全废），而且不报错，只会表现成「什么都连不上」。

反过来，`dist/client` 的路径**不受 cwd 影响**：`ssr.js` 用的是
`fileURLToPath(new URL('../..', import.meta.url))`，按模块自身位置算。所以只有 .env 这一处敏感。

**`Restart=always` 要配 `StartLimitBurst`。** 光有 always，遇到「起来就崩」的
真故障时会无限重启刷爆日志。现在是 5 分钟内 10 次就停下 —— 那种情况本来就该
让它停在那儿等人看，而不是假装还活着。

## 装完之后

看门狗的 `detect_backend` 会认出 `8bitgo.service`，后端那一层从此真的具备自愈能力：

```bash
/usr/local/bin/8bitgo-watchdog.sh --status   # 「后端守护」应当变成 systemd:8bitgo.service
```

日常：

```bash
systemctl restart 8bitgo
journalctl -u 8bitgo -f
journalctl -u 8bitgo --since "-1h" | grep -i error
```

部署流程也跟着变：`npm run build` 之后用 `systemctl restart 8bitgo`，不要再 `kill` + `nohup`。
