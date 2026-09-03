# 直播（一人玩、多人看）

给**本来就没法联机的游戏**用的。GBA 是最典型的例子：当年的联机靠连接线，
浏览器里的 mGBA 核心没有那套东西，所以「一起玩」做不到 ——「一起看」是能做的那一半。

和另外两条联机路子的关系：

| | 游戏在哪跑 | 观众能操作 | 服务器成本 |
|---|---|---|---|
| netplay（P2P 联机） | 房主浏览器 | 能（有手柄位） | 只转发握手 |
| cloud-game | 服务器 | 能 | 高（跑游戏 + 转流） |
| **live（直播）** | 主播浏览器 | **不能，只看** | 只转发握手 |

## 它不依赖 EmulatorJS 的 netplay

netplay 需要自建 EmulatorJS **4.3.0-pre**（CDN 上的 stable 还是 4.2.3，不含 netplay）。
直播不需要 —— 它要的只是「主播那边的画布 + 声音」，也就是 `RuntimeHandle.captureSources()`，
和录像用的是同一份东西。所以任何能录像的引擎都能开播：

    EmulatorJS（GBA/GB/NES/SNES…）、js-dos、Ruffle、FreeJ2ME、jsnes

## 组成

    server/src/live.js            信令（socket.io 命名空间 /live）+ 房间登记
    server/scripts/test-live.mjs  信令的端到端测试（18 项）
    src/services/live.ts          客户端：连信令、ICE、观看链接、房间列表
    src/emulator/broadcast.ts     主播侧：captureStream -> N 条 RTCPeerConnection
    src/emulator/adapters/liveview.ts  观众侧：收流塞进 <video>（一个普通 Runtime）
    src/emulator/LiveControls.tsx 播放器工具栏里的开播按钮

画面和声音**不经过服务器**，只有 SDP / ICE 借道：

    浏览器(主播) ──WebRTC 音视频──► 浏览器(观众) × N
           └──── 只有握手信息经过 /live ────┘

## 部署

信令走的是**和 netplay 同一个 socket.io 服务**，只是换了命名空间，所以
只要 `/socket.io/` 已经反代好了就不用额外配置。nginx 里那条别忘了 WebSocket 升级头：

```nginx
location /socket.io/ {
    proxy_pass http://127.0.0.1:8788;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    # ↓ 少这一行，房间卡片上每个人的国旗都会是 ❓，而且不报错
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 3600s;
    proxy_buffering off;
}
```

**`X-Forwarded-For` 不是可选的。** 房间卡片上房主的国旗是后端拿握手时的 IP 查出来的
（server/src/presence.js）。反代不传真实 IP 的话，后端看到的每个人都是 `127.0.0.1`，
查不出国家，于是全站永远显示 ❓ —— 而且这条路径不会报任何错，只会「就是不显示」，
排查起来非常费劲。`/api/` 那个 location 同理。

后端信不信这个头由 `TRUST_PROXY` 控制（默认 `loopback`，即「前面有一层自己人的反代」）。
取的是 XFF 的**最后一段** —— nginx 的 `$proxy_add_x_forwarded_for` 把它亲眼看到的对端追加在末尾，
前面那些是客户端自己带来的，`curl -H 'X-Forwarded-For: 1.1.1.1'` 谁都能伪造。

TURN 和 netplay 共用 `/api/netplay/ice`（后端现签短期凭证，密码不进前端包）。

环境变量（都有默认值，可以不配）：

```bash
LIVE_MAX_ROOMS=200          # 同时在播的房间上限
LIVE_MAX_VIEWERS=12         # 单场观众上限，见下面「上行」
VITE_LIVE_MAX_BITRATE=1500000  # 单路视频码率上限
```

## 上行是唯一的硬约束

没有 SFU，是「主播直连每个观众」的星型结构：

    主播上行 = 单路码率 × 观众数

GBA 才 240×160，1.5 Mbps 已经很宽裕，但 10 个观众就是 15 Mbps ——
家宽上行大概到十来路就满了，所以 `LIVE_MAX_VIEWERS` 默认给 12。
真要做几十上百人，得在中间加一层转发（主播只推一路，服务器扇出到 N 路），
mediasoup / LiveKit 都行；或者干脆走 cloud-game 那条路，游戏本来就在服务器上。

## 用法

- **开播**：跑起一个单人游戏（`players <= 1`），工具栏出现 📡，点一下开播，
  旁边的 🔗 复制观看链接。换游戏、离开页面会自动下播。
- **观看**：观看链接是 `/games/<slug>?live=<房间号>`，打开即是观众。
  观众侧只有音量、截图、录像 —— 没有暂停也没有存档，因为本机根本没有模拟器在跑。

## 接口

```
GET /api/live/rooms          正在播的房间（?game=<slug> 只看某个游戏）
GET /api/live/rooms/:roomId  单个房间
```

socket.io 命名空间 `/live` 的事件见 `server/src/live.js` 顶部注释。

## 测试

```bash
cd server && node scripts/test-live.mjs
```

跑的是真的 http server + socket.io，两个客户端走完整流程：开播、进房、双向转发、
越权拦截（观众之间不能互发、房间外不能发）、离开、下播、主播掉线散场。
