# 在自己的 Mac 上先跑通联机（不用服务器、不用 Docker）

`docker-compose.yml` 那一套是给 Linux 服务器的：官方镜像里 gstreamer 的路径写死了 x86_64，
Apple Silicon 上得靠 QEMU 模拟，60fps 编码根本跑不动。**Mac 上直接编译原生二进制反而更简单**，
cloud-game 官方支持 darwin/arm64，核心也会自动下载 `.dylib` 版本。

下面三个终端窗口跑三样东西，全部在你自己的 macOS 终端里执行（不是容器里）。

---

## 0. 一次性准备

```bash
brew install go pkg-config gstreamer gst-plugins-base gst-plugins-good
```

拉源码（放在项目外面，别放进 8bitgo 仓库）：

```bash
cd ~/Documents
git clone --depth 1 https://github.com/giongto35/cloud-game.git
cd cloud-game
make build          # 产出 bin/coordinator 和 bin/worker，第一次几分钟
```

## 1. 准备一个 ROM

**文件名必须等于本站的游戏 slug**，因为前端就是拿 slug 去启动游戏的。
比如站上有个游戏 slug 是 `super-mario-bros`，那就：

```bash
mkdir -p ~/Documents/cloud-game/assets/games/nes
cp /路径/你的.nes ~/Documents/cloud-game/assets/games/nes/super-mario-bros.nes
```

不确定 slug 是什么，打开对应游戏详情页，URL 里 `/games/` 后面那段就是。
先拿 NES / SNES / GBA 试，别用 N64（OpenGL 核心在 Mac 上还要额外折腾）。

## 2. 配置 cloud-game

把本项目的 `deploy/cloudgame/config.local.yaml` 复制过去（本机跑，不需要 TURN 和公网 IP）：

```bash
mkdir -p ~/Documents/cloud-game/configs
cp ~/Documents/8bitgo/deploy/cloudgame/config.local.yaml ~/Documents/cloud-game/configs/config.yaml
```

## 3. 启动（三个终端）

**终端 A —— coordinator（信令）**

```bash
cd ~/Documents/cloud-game && ./bin/coordinator
```

**终端 B —— worker（跑游戏 + 推流）**

```bash
cd ~/Documents/cloud-game && ./bin/worker
```

第一次启动会从 libretro buildbot 下载核心（nestopia / snes9x / mgba 的 .dylib），等它下完。
日志里出现 `New room` 之类才算正常。

**终端 C —— 8BitGo 的 Node 后端（房间列表）**

```bash
cd ~/Documents/8bitgo/server && npm install && npm start
```

房间列表是纯内存的，**不需要 MySQL**；没配数据库也能跑，只是登录相关接口不可用。

## 4. 前端 .env

在 `~/Documents/8bitgo/.env` 里加上（没有这个文件就 `cp .env.example .env`）：

```
VITE_CLOUDGAME_URL=http://localhost:8000
VITE_API_URL=http://127.0.0.1:8788
```

改完 **必须重启 `npm run dev`** —— Vite 的环境变量是构建时注入的，热更新不会生效。

## 5. 验证

```bash
curl http://localhost:8000/           # coordinator 有响应
curl http://127.0.0.1:8788/api/rooms  # 返回 []
```

然后打开那个游戏的详情页，播放器上应该显示「开始游戏 · 自动创建房间」。点下去：

1. 左上角依次出现「正在连接联机服务器 → 正在建立视频通道 → 正在启动游戏」
2. 画面出来后，侧边栏「联机玩」里就有你这个房间了
3. 工具栏点「复制邀请链接」，用另一个浏览器（或无痕窗口）打开，就能以 2P 加入

## 常见问题

| 现象 | 原因 |
| --- | --- |
| 播放器上没有联机按钮 | `.env` 没配 `VITE_CLOUDGAME_URL`，或没重启 dev server，或这个平台不支持联机（Flash / J2ME / NDS / WS） |
| `/rooms` 说「联机功能尚未开启」 | `VITE_CLOUDGAME_URL` 或 `VITE_API_URL` 少了一个 |
| 一直「正在启动游戏」然后超时 | worker 日志里看 —— 多半是 `assets/games/<平台>/` 下没有叫 `<slug>.<后缀>` 的文件 |
| 一直「正在建立视频通道」 | 本机一般不会；真出现就看 worker 日志的 ICE 部分 |
| 侧边栏没有房间但游戏能玩 | Node 后端没起来，或 `VITE_API_URL` 没配 |
| 声音没出来 | 浏览器拦了自动播放，点一下画面即可 |

跑通之后再照 `README.md` 部署到 Linux 服务器，那边才需要 Docker、TURN 和公网 IP。
