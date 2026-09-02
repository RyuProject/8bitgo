# 云端联机服务端（cloud-game）—— 付费会员通道

> **默认的联机方案不是这个。** 站点默认走 P2P（游戏在房主自己的浏览器里跑，画面直推给其他人，
> 零服务器成本），见 `deploy/netplay/README.md`。cloud-game 是另一条路：游戏跑在服务器上，
> 房主离开也不影响、画质稳定，代价是每个房间占一个 CPU 核，所以留给付费会员。
>
> 它由 `src/config/features.ts` 的 `cloudGame` 控制，**默认关闭**。接入会员判断后，
> 把那个开关改成按用户等级返回即可。


前端的「联机模式」需要一台跑着 [cloud-game](https://github.com/giongto35/cloud-game) 的 Linux 服务器：
游戏在服务器上由 libretro 核心运行，画面经 WebRTC 推到浏览器，同一房间的人看同一路流、各控各的手柄。

```
浏览器 ──wss /ws──► coordinator(:8000) ──► 挑一个空闲 worker
浏览器 ◄──WebRTC 音视频 + 手柄 DataChannel──► worker(:8443/udp) ──libretro──► ROM（./games）
浏览器 ──心跳──► 本站 Node 后端 /api/rooms（房间列表，供侧边栏「联机玩」展示）
```

## 一、服务器要求

- Linux x86_64，Docker + docker compose
- CPU 与带宽怎么估、能开几个房间，见下面第三节（**双核也不止两个房间**）
- 公网 IP，开放端口：`8000/tcp`（信令，或经 Caddy 的 443）、每个 worker 一个 UDP 端口（默认 8443～8446）、`3478/udp+tcp` 与 `49160-49200/udp`（TURN）
- 用户主要在国内就把服务器放国内云，延迟 = 用户到服务器的 RTT + 编码耗时

## 二、部署步骤

```bash
cd deploy/cloudgame
git clone --depth 1 https://github.com/giongto35/cloud-game.git      # 源码放在同目录，compose 会 build 它
cp .env.example .env && vi .env                                       # PUBLIC_IP、TURN_SECRET、R2_BUCKET
./render-config.sh                                                    # 生成 config.yaml
./sync-roms.sh                                                        # R2 → ./games（需要 rclone，见脚本头部）
docker compose up -d --build                                          # 第一次 build gstreamer 要十几分钟
docker compose logs -f worker-1                                       # 首次启动会自动下载 libretro 核心
```

`docker-compose.yml` 里预置了 **4 个 worker**（= 最多 4 个同时进行的房间，每房最多 4 人）。
双核机器只跑 8/16 位平台的话这个数量是合适的；要加就照抄一段改端口（8447、8448…），
要减就注释掉，具体怎么定见下面第三节。

### HTTPS

前端站点是 https 时，浏览器只允许 `wss://`。装 Caddy，把 `Caddyfile` 里的域名换成你的（解析到服务器），
`caddy run --config Caddyfile`，然后前端 `.env`：

```
VITE_CLOUDGAME_URL=https://cg.8bitgo.com
VITE_API_URL=https://8bitgo.com          # 房间列表走本站后端，server/ 已内置 /api/rooms
```

本地调试不用 HTTPS：`VITE_CLOUDGAME_URL=http://localhost:8000`，`.env` 里 `PUBLIC_IP=127.0.0.1`。

## 三、容量与成本（部署前先算这笔账）

联机和现在的浏览器模拟是**两种完全不同的成本模型**：浏览器模拟里服务器只发一次 ROM，
联机则是每个房间都在你的服务器上跑一个模拟器 + 实时编码。

**先记住一件事：一个房间最多 4 个人，不是 1 个。** 2 个房间可以同时服务 8 位玩家。

**并发房间数 = worker 进程数**，一个 worker 同时只跑一个房间
（`pkg/coordinator/worker.go` 里写死的：`Workers support only one game at a time`，没有配置项）。
但**一台机器上能起多少个 worker 不受限制**，瓶颈是 CPU 和带宽，不是核数本身。

### CPU：别按「一核一房间」算

那是按 N64 / PS1 估的保守值。真实消耗几乎全在视频编码，而编码量取决于**分辨率**：

| 平台 | 分辨率 | 单房间大致占用 |
| --- | --- | --- |
| GBA | 240×160 | 很轻，约 0.1 核 |
| NES / SNES | 256×240 | 很轻，约 0.1～0.2 核 |
| MD / 街机 | 320×224 | 约 0.2 核 |
| PS1 | 320×240～640×480 | 0.3～0.6 核 |
| N64 | 320×240 + OpenGL | 0.5～1 核 |
| DOS | 640×480 | 0.5～1 核 |

也就是说，**双核机器只跑 NES / SNES / GBA，起 4～6 个 worker 是现实的**；
但如果开了 N64 / PS1 / DOS，2～3 个就到顶了。数字只是起点，务必实测（见下）。

### 带宽：小机器上这才是真正的天花板

每个连进来的人一条流。默认 3.2 Mbps 的话：

- 6 个房间 × 每房 2 人 = 12 条流 ≈ **38 Mbps 上行**
- 国内常见的 2 核小机器只有 3～5 Mbps 带宽 → **连 2 条流都吃不下**

所以带宽通常比 CPU 先卡死。好消息是像素游戏根本不需要 3.2 Mbps：
`config.template.yaml` 里已经把 `target-bitrate` 调到 **1.2 Mbps**，
NES / SNES / GBA 这种低分辨率低运动量的画面几乎无损，带宽直接省到三分之一。
还嫌大可以降到 800000，画面才开始能看出来。跑 N64 / PS1 再调回 2500000~3200000。

按流量计费的话：3.2 Mbps ≈ 1.4 GB/小时/人，1.2 Mbps ≈ 0.54 GB/小时/人。

### 怎么定 worker 数量：实测，别猜

先按上表起一个保守的数量，跑真实游戏，然后看：

```bash
docker stats                      # 每个 worker 的 CPU% 和网络
docker compose logs -f worker-1   # 有没有丢帧 / 编码跟不上的警告
```

判断标准：**所有 worker 的 CPU 总和别超过核数的 70%**（留出突发和 coordinator 的余量）。
没超就往上加 worker，超了就减，或者调 `cpu-used`（见 `config.template.yaml` 里的注释，
调大更省 CPU、画质略降，比降码率对观感的伤害小）。

worker 数量可以适度超过核数 —— 房间不是时刻满负荷。但超卖过头是所有房间一起卡，
不是排队等候，所以宁可少开一两个。

### 还能怎么省

- **只让轻量平台上云**：在 `src/emulator/adapters/cloudgame.ts` 的 `CLOUD_PLATFORM_CORES` 里
  删掉 n64 / psx / dos，联机只留 8/16 位平台。这些平台的游戏本来也最适合两个人一起玩
- **硬件编码**：机器有核显 / GPU 时，把 `encoder.list` 换成 `vaapivp8enc`（Intel QSV）或
  `nvh264enc`（NVIDIA），CPU 占用能降一个数量级。云上 2 核小机型一般没有，值得升配时考虑
- **`threads: 1`**：跑多个 worker 时限制每个的编码线程数，避免互相抢 CPU（已在模板里设好）

所以「同时能有多少人联机」由 CPU 和带宽共同决定。前端已经做了兜底：
**没有空闲机位时会自动退回浏览器本地运行**（提示一句「联机服务器暂时用不了，已改为本地运行」），
玩家不会因为服务器满了就玩不了，只是这一局没有房间。

前端默认策略：**只有多人游戏（`players > 1`）和点邀请链接进来的人默认走联机**，
单人游戏默认仍在浏览器里跑（可手动切联机，相当于开个直播）。
想改这个策略，见 `src/emulator/EmulatorPlayer.tsx` 里的 `onlineByDefault`。

## 四、ROM 约定

cloud-game 只能跑它文件系统里的游戏，**不能上传本地文件**。`sync-roms.sh` 把 R2 的
`roms/<platform>/<slug>.<ext>` 同步成 `./games/<platform 小写>/<slug>.<ext>`：

- 游戏名 = 文件名去后缀 = slug。前端 `GAME_START` 发的就是 slug，所以 R2 里的 key 必须按约定命名
- 目录名用来选核心（`config.template.yaml` 的 `cores.list` 键 / `folder`）
- 除街机 / DOS 外，zip 会被解开 —— cloud-game 只让 fbneo / dosbox 核心吃 zip
- 街机（fbneo）需要 BIOS zip（如 `neogeo.zip`）也放进 `games/arcade/`

新增支持平台：在 `config.template.yaml` 的 `cores.list` 加核心，同时在前端
`src/emulator/adapters/cloudgame.ts` 的 `CLOUD_PLATFORM_CORES` 加一行，再把平台加进 `sync-roms.sh` 的 `PLATFORMS`。

## 五、前端如何使用

- 多人游戏（`players > 1`）默认「联机模式」：点开始 → 自动创建房间 → 出现在侧边栏「联机玩」
- 单人游戏默认在浏览器里跑，播放器上有「切换到联机模式」可手动开房间
- 没有空闲机位时自动退回浏览器本地运行，不会让玩家卡住
- 房间卡片：封面 = 正在玩的游戏，显示房主与 `已加入/最大人数`；点进去自动分到空闲手柄位
- 邀请链接：`/games/<slug>?room=<roomId>`（播放器工具栏「复制邀请链接」）
- 键位与本地模拟器一致：方向键、Z=A、X=B、A=X、S=Y、Q=L、E=R、Enter=Start、V/Shift=Select，支持手柄

## 六、常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 一直「正在建立视频通道」 | 大概率 UDP 端口没放行，或 `PUBLIC_IP` 填错；看 `docker compose logs worker-1` 里的 ICE 日志 |
| 玩家说「怎么变成本地运行了」 | worker 满了触发了自动兜底，看日志确认，加 worker |
| 找不到游戏 / 房间创建失败 | `./games/<platform>/` 里没有 `<slug>.<ext>`，或扩展名不在该核心的 `roms` 列表里 |
| N64 黑屏 | 需要 xvfb 服务正常；`docker compose logs xvfb` |
| 房间列表是空的但能联机 | 前端没配 `VITE_API_URL`，或后端没起来（房间列表由本站后端维护，不是 cloud-game） |
| iOS Safari 不行 | cloud-game 官方明确不支持 iOS |

## 七、许可证

cloud-game 为 Apache-2.0；各 libretro 核心许可证不同（多数 GPL），它们作为独立进程在服务器上运行，不与前端代码混合。
服务器上托管 ROM 的版权责任由部署者自行承担。
