# StarCraft Sockdrive 发布流程

StarCraft 的原始 ZIP 解开后约 1.5GB，不能再让浏览器整包下载、解密和复制。正确做法是在 Linux
制作机上把它做成 FAT32/QCOW2 游戏盘，再用 js-dos 官方 `sockify` 切成按需读取的静态分块。

## 1. 制作机准备

保留**加密打包前的原始 ZIP**；R2 上的 `.8bg` 不能直接转换。Ubuntu/Debian 安装：

```bash
sudo apt install guestfs-tools brotli qemu-system-i386 qemu-utils 7zip
sudo chmod +r /boot/vmlinuz-*
```

从 <https://github.com/caiiiycuk/sockdrive/releases> 下载与当前 js-dos 8.5.x 匹配的 Linux `cli`，
赋予执行权限。制作目录至少预留“原始解压文件 + QCOW2 + Sockdrive 分块”的空间；StarCraft 建议
预留 8GB 以上。不要在生产 Web 进程的请求里做转换。

## 2. 一条命令制作、上传并绑定

浏览器后台重新上传原始包时请保留本地 ZIP；后台生成并上传的是加密 `.8bg`，它不能反向拿来制盘。
上传完成后，在装好上述工具的 Linux 制作机执行：

```bash
read -s EIGHTBITGO_ADMIN_JWT
export EIGHTBITGO_ADMIN_JWT
npm run sockdrive:prepare -- \
  --source /data/StarCraft-1.16.1.zip \
  --slug starcraft \
  --version v1 \
  --exe StarCraft/Brood.exe \
  --work-dir /data/8bitgo-sockdrive-builds \
  --cli /opt/sockdrive/cli \
  --encoding br \
  --publish \
  --bucket '<R2 桶名>' \
  --bind
```

脚本会依次执行：

1. 解包前拒绝绝对路径、盘符和 `..`，解包后拒绝符号链接与 FAT32 不支持的超大单文件；
2. 确认 `StarCraft/Brood.exe` 确实存在；
3. 生成带 MBR 的 VFAT/QCOW2 游戏盘，默认保留约 256MB 空间；
4. 调官方 `sockify -b` 生成 Brotli 分块；
5. 没有真实游玩轨迹时，先从 `sockdrive.metaj` 复制一份保守的独立热点清单，避免线上 404；
6. 用现有发布器逐块解码、核对长度，先上传数据，最后上传 `sockdrive.metaj`；
7. 从公开域名重新读取元数据和热点清单，全部通过后才 PATCH `games.dos_sockdrive`。

令牌只从环境变量读取，避免进入 shell 历史。目录固定为 `sockdrives/starcraft-v1`，下一次内容有任何
变化都要改成 `v2`，不能覆盖 v1；玩家本地 OPFS 会把目录 URL 当磁盘身份。

## 3. 分步执行与恢复

不带 `--publish --bind` 时只制作并做本地完整性校验，末尾会打印上传和绑定命令：

```bash
npm run sockdrive:prepare -- --source /data/StarCraft.zip --slug starcraft --version v1 \
  --exe StarCraft/Brood.exe --work-dir /data/builds --cli /opt/sockdrive/cli
```

如果上传完成但绑定失败，**不要重新上传或覆盖目录**，直接重试绑定：

```bash
read -s EIGHTBITGO_ADMIN_JWT
export EIGHTBITGO_ADMIN_JWT
npm run sockdrive:bind -- --slug starcraft --prefix sockdrives/starcraft-v1
```

绑定器是幂等的：已经绑定到同一路径会直接成功。它也支持 `--dry-run`，只验证公开资源和游戏配置。

## 4. 首次发布后的进一步弱网优化

首次发布使用的是 sockify 自带的保守热点集合，已经可以运行，但不一定是 StarCraft 的最优集合。
正式试玩时把 Sockdrive Preload 设为 `None`，从开机一直操作到进入一局游戏，再在控制台运行
`brotliRanges()` 取得真实热点。把该数组做成 `preload_ranges.metaj` 后，用 **v2 新目录**重新发布；
不要给 v1 原地换分块或热点清单。
