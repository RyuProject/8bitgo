# StarCraft Sockdrive 发布流程

StarCraft 的原始 ZIP 解开后约 1.5GB，不能再让玩家浏览器整包下载、解密和复制。日常发布现在直接
在后台上传原始 ZIP：生产机自动把它做成 FAT32/QCOW2 游戏盘，再用 js-dos 官方 `sockify` 切成
按需读取的静态分块。下面的命令行流程保留作故障恢复和离线制作兜底。

## 1. 日常发布：后台自动完成

1. 先保存游戏资料，确认平台是 DOS、后端是 DOSBox-X，已经填写共享 Windows 系统镜像；
2. 填写游戏盘内的「默认 Windows 自启动 EXE」为 `StarCraft.exe`；不要使用旧整合包的
   `Brood.exe` / `brood-c.exe` 第三方启动链；
3. 清空 DOS 附加文件。补丁必须提前放进原始 ZIP，远程只读盘不能在浏览器里再叠文件；
4. 在「原始大 ZIP 自动转 Sockdrive」选择 ZIP，并确认开始。

浏览器会把 1GB+ 文件分片上传到私有 staging，然后只创建一条 MySQL 任务。之后可以关闭页面：服务器
会继续下载、检查 ZIP、制盘、发布、公开复核并绑定。重新打开编辑页会恢复进度；失败时可在 24 小时内
点击「重试后台任务」。发布目录自动使用不可复用的时间版本，避免 js-dos 的 OPFS 把两代磁盘混在一起。

生产机依赖：

- 独立工作盘挂载到 `/var/lib/8bitgo-data`，队列目录为 `/var/lib/8bitgo-data/sockdrive-builds`；
- 官方 Sockdrive CLI 位于 `/opt/sockdrive/cli`；
- `guestfs-tools`、`qemu-utils`、`7zip`、`brotli` 已安装；
- `server/.env` 配置 `SOCKDRIVE_CONVERT_TMP_DIR` 与 `SOCKDRIVE_CLI`，Worker 地址和口令可复用 PSP 转换配置；
- Worker 必须部署支持 staging 私有读取和 `Content-Encoding` 的版本。

队列只跑一个转换，避免制作镜像拖垮生产机。`sockdrive.metaj` 最后上传，只有公开元数据、热点清单、
分块编码都复核成功后才会绑定到游戏；管理员若在转换期间改过该游戏配置，任务会保留新配置而不强行覆盖。

官方 Sockdrive CLI 2.0.10 只接受两种精确镜像：252,370,944 字节（FAT16-256MB）或
2,147,483,648 字节（FAT32-2GB）。制作脚本会按解压大小自动选模板，不再生成任意容量镜像；默认给
游戏保留至少 128MB 可写空间。原始 ZIP 最大 1900MB，解压内容加预留空间仍超过 2GB 时会明确失败，
不能靠加服务器硬盘突破这个上游格式限制。

## 2. 制作机准备（手工兜底）

保留**加密打包前的原始 ZIP**；R2 上的 `.8bg` 不能直接转换。Ubuntu/Debian 安装：

```bash
sudo apt install guestfs-tools brotli qemu-system-i386 qemu-utils 7zip
sudo chmod +r /boot/vmlinuz-*
```

从 <https://github.com/caiiiycuk/sockdrive/releases> 下载与当前 js-dos 8.5.x 匹配的 Linux `cli`，
赋予执行权限。制作目录至少预留“原始解压文件 + QCOW2 + Sockdrive 分块”的空间；StarCraft 建议
预留 12GB 以上。转换必须由后台任务或独立命令执行，不能塞进某个 HTTP 请求的生命周期。

## 3. 一条命令制作、上传并绑定（手工兜底）

浏览器后台重新上传原始包时请保留本地 ZIP；后台生成并上传的是加密 `.8bg`，它不能反向拿来制盘。
上传完成后，在装好上述工具的 Linux 制作机执行：

```bash
read -s EIGHTBITGO_ADMIN_JWT
export EIGHTBITGO_ADMIN_JWT
npm run sockdrive:prepare -- \
  --source /data/StarCraft-1.16.1.zip \
  --slug starcraft \
  --version v1 \
  --exe StarCraft.exe \
  --work-dir /data/8bitgo-sockdrive-builds \
  --cli /opt/sockdrive/cli \
  --encoding br \
  --publish \
  --bucket '<R2 桶名>' \
  --bind
```

脚本会依次执行：

1. 解包前拒绝绝对路径、盘符和 `..`，解包后拒绝符号链接与 FAT32 不支持的超大单文件；
2. 确认官方 `StarCraft.exe` 与静默安装路径所需的 `STAR.REG` 确实存在；
3. 生成带 MBR 的 VFAT/QCOW2 游戏盘，自动对齐官方 256MB / 2GB 模板并默认保留至少 128MB 空间；
4. 调官方 `sockify -b` 生成 Brotli 分块；
5. 没有真实游玩轨迹时，先从 `sockdrive.metaj` 复制一份保守的独立热点清单，避免线上 404；
6. 用现有发布器逐块解码、核对长度，先上传数据，最后上传 `sockdrive.metaj`；
7. 从公开域名重新读取元数据和热点清单，全部通过后才 PATCH `games.dos_sockdrive`。

令牌只从环境变量读取，避免进入 shell 历史。目录固定为 `sockdrives/starcraft-v1`，下一次内容有任何
变化都要改成 `v2`，不能覆盖 v1；玩家本地 OPFS 会把目录 URL 当磁盘身份。

## 4. 分步执行与恢复

不带 `--publish --bind` 时只制作并做本地完整性校验，末尾会打印上传和绑定命令：

```bash
npm run sockdrive:prepare -- --source /data/StarCraft.zip --slug starcraft --version v1 \
  --exe StarCraft.exe --work-dir /data/builds --cli /opt/sockdrive/cli
```

如果上传完成但绑定失败，**不要重新上传或覆盖目录**，直接重试绑定：

```bash
read -s EIGHTBITGO_ADMIN_JWT
export EIGHTBITGO_ADMIN_JWT
npm run sockdrive:bind -- --slug starcraft --prefix sockdrives/starcraft-v1
```

绑定器是幂等的：已经绑定到同一路径会直接成功。它也支持 `--dry-run`，只验证公开资源和游戏配置。

## 5. 首次发布后的进一步弱网优化

首次发布使用的是 sockify 自带的保守热点集合，已经可以运行，但不一定是 StarCraft 的最优集合。
正式试玩时把 Sockdrive Preload 设为 `None`，从开机一直操作到进入一局游戏，再在控制台运行
`brotliRanges()` 取得真实热点。把该数组做成 `preload_ranges.metaj` 后，用 **v2 新目录**重新发布；
不要给 v1 原地换分块或热点清单。
