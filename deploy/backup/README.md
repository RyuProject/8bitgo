# 数据库备份 → R2

`8bitgo-backup.sh` 的说明。脚本本体里的注释解释了每一处「多余写法」在防哪种坏备份，
这里只讲**怎么把它跑起来**。

`redeploy.sh` 的步骤 1/7 调用的就是它，所以这份配置缺了会让**整个部署在第一步中止**
（这是刻意的：改动之前必须先有一份可回滚的快照）。

## 1. rclone 的 `r2` remote

备份靠 rclone 上传，remote 默认叫 `r2`（可用 `R2_REMOTE` 覆盖）。

⚠️ **配在 root 下**：`redeploy.sh` 用 `sudo -E` 跑、systemd 单元也是 `User=root`，
rclone 读的是 `$HOME/.config/rclone/rclone.conf` —— sudo 下 `$HOME=/root`。
给普通用户配的 remote，root 看不见，症状是：

```
Failed to create file system for "r2:8bitgo/backups/db/": didn't find section in config file
```

（配置文件里连 `[r2]` 段都没有时，rclone 报的就是这句话。）

```bash
# 凭据在 Cloudflare R2 控制台，**不要进仓库**
sudo rclone config create r2 s3 provider=Cloudflare \
  access_key_id='<R2_ACCESS_KEY_ID>' \
  secret_access_key='<R2_SECRET_ACCESS_KEY>' \
  endpoint='https://<ACCOUNT_ID>.r2.cloudflarestorage.com' \
  acl=private

# 验一下：应该能列出历史备份
sudo rclone config file
sudo rclone listremotes
sudo rclone lsd r2:8bitgo/backups/db/
```

如果这份配置本来在别的用户家目录下，两条路：`sudo cp` 到
`/root/.config/rclone/rclone.conf`（推荐 —— systemd timer 不会带上 `RCLONE_CONFIG`），
或者每次都 `RCLONE_CONFIG=/home/<user>/.config/rclone/rclone.conf` 覆盖。

## 2. 跑一次

```bash
sudo -E ./8bitgo-backup.sh --local-only   # 只验 dump 能不能出来，不碰 R2
sudo -E ./8bitgo-backup.sh --dry-run      # 全流程但不上传、不轮转
sudo -E ./8bitgo-backup.sh                # 真正跑：上传 R2 + 两侧轮转
```

上传完会回头 `rclone size` 核对字节数，对不上就报错退出 —— **「以为传上去了」是备份里最贵的错**。

## 3. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ENV_FILE` | `/var/www/8bitgo/server/.env` | 读 `DB_*` 的地方 |
| `BACKUP_DIR` | `/var/backups/8bitgo` | 本地备份目录 |
| `R2_REMOTE` / `R2_BUCKET` / `R2_PREFIX` | `r2` / `8bitgo` / `backups/db` | 上传目标 |
| `KEEP_LOCAL_DAYS` / `KEEP_REMOTE_DAYS` | `7` / `30` | 两侧保留天数 |
| `LOG` | `/var/log/8bitgo-backup.log` | 日志 |

没装 rclone 时脚本**降级成只留本地**并打警告，不会整个失败；
但那样就没有「异地一份」了，别把这当成正常状态。

## 4. 定时

`deploy/systemd/8bitgo-backup.{service,timer}`：每天 04:15（低峰，避开 00:00 的日期切换）。
安装：

```bash
sudo cp deploy/systemd/8bitgo-backup.* /etc/systemd/system/
sudo systemctl enable --now 8bitgo-backup.timer
sudo systemctl list-timers 8bitgo-backup.timer
```

## 5. 自检

`npm --prefix server run test:backup`：用假的 mysqldump / rclone 桩程序把各种失败路径逼出来
（dump 截断、上传后大小不符、`.env` 读不到、同秒重跑……）。**不碰真数据库、不碰真 R2。**
