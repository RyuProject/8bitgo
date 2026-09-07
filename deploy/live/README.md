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
    #   ⚠️ 在 Cloudflare 后面时**必须换成下面那一行**，见本节末尾「在 Cloudflare 后面的话」
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # proxy_set_header X-Forwarded-For $http_cf_connecting_ip;   # ← CF 后面用这个
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 3600s;
    proxy_buffering off;
}
```

### 国旗 / 网络格子是 ❓ 时先跑这一条

```bash
curl -s https://你的域名/api/diag | jq '{ip, country, geo}'
```

- `ip.isPrivate: true` → **反代没把真实 IP 传进来**，看下面那条 `X-Forwarded-For`。
  注意 `/socket.io/` 那个 location 是**单独**的一块，很多人只在 `/api/` 里加了头，
  而房间卡片的名片恰恰是在 socket 握手时定的。
- `geo.loaded: false` → 离线国家库没装好（`npm i` 一遍）。
- `country.byIp` 和 `country.byHeader` **都是 null** → 两条路都没戏，国旗只能是 ❓。

站点在 Cloudflare 后面的话，`CF-IPCountry` 会自动兜底 —— 就算 XFF 没配好，
国旗照样出得来（`country.byHeader`）。但 IP 还是该配对：它对每一跳都成立，
换掉 CF 也不受影响。

网络那格（👌🀄️👎）是长连接上的心跳时延，`/api/diag` 里看不到，要看房间接口：

```bash
curl -s https://你的域名/api/netplay/rooms | jq '.[0].presence'
```

连上**一秒内**就该有 `rtt`（服务端会主动补一个 engine.io 心跳，不等 10 秒那一轮）。
一直是 `null` 就说明 pong 没回来——多半是反代把 WebSocket 的帧截断了，检查 `Upgrade` / `Connection` 那两行。

**`X-Forwarded-For` 不是可选的。** 房间卡片上房主的国旗是后端拿握手时的 IP 查出来的
（server/src/presence.js）。反代不传真实 IP 的话，后端看到的每个人都是 `127.0.0.1`，
查不出国家，于是全站永远显示 ❓ —— 而且这条路径不会报任何错，只会「就是不显示」，
排查起来非常费劲。`/api/` 那个 location 同理。

### ⚠️ 在 Cloudflare 后面的话：那一行要换

`$proxy_add_x_forwarded_for` 的含义是「客户端带来的那串 + **nginx 亲眼看到的对端**」，
追加在末尾；后端取的正是最后一段（那一段伪造不了）。这套在 nginx **直面用户**时是对的。

但站点在 Cloudflare 后面时，nginx 看到的对端就是 **CF 的 anycast 节点**，
于是最后一段变成了 CF 的地址，真实访客反而在前面那一段：

```
xff       : "203.0.113.7, 104.22.100.106"    ← 前者是访客，后者是 Cloudflare
effective : "104.22.100.106"                  ← 后端采用了 CF 节点
```

2026-09-07 线上实测就是这个状态（`curl -s https://你的域名/api/diag | jq .ip`），
后果一串，而且**每一条都不报错、功能看着都还"能用"**：

- 每 IP 房间上限（`LIVE_MAX_ROOMS_PER_IP` / `NETPLAY_MAX_ROOMS_PER_IP`）对着 CF 节点算
  → **同一个 CF 机房后面的所有玩家共用一个额度**；`NETPLAY_MAX_MEMBERS_PER_IP` 同理，
  同机房后面只有几个人能进同一个联机房；
- 房间卡片的国旗查的是 CF 的 anycast 地址（多半登记在美国）→ **全站显示同一个国家**，
  而且 `resolveCountry` 先用 IP、查到了就不再看网关头，那份**正确**的 `CF-IPCountry` 永远轮不上；
- 限流的 key、匿名评分的 `anon_ip` 一并从「按人」塌缩成「按机房」。

**修法：每个 location 都换成**

```nginx
proxy_set_header X-Forwarded-For $http_cf_connecting_ip;
```

`/`、`/api/`、`/socket.io/`、`/api/netplay/events` —— 有几块就改几块，漏一块那一块的功能还是错的。
改完 `sudo nginx -t && sudo systemctl reload nginx`，再 `curl -s https://你的域名/api/diag | jq .ip`：
`usingCdnEdgeIp` 要变成 `false`，`effective` 要等于 `cfConnectingIp`。

⚠️ **同时把源站防火墙锁到 Cloudflare 的 IP 段**（`https://www.cloudflare.com/ips/`，或用
Authenticated Origin Pulls / cloudflared）。不锁的话 `CF-Connecting-IP` 是可以被**直连源站**的人
伪造的 —— 而原来那套「取最后一段」恰恰不怕伪造，所以这一步不是可选项，是换来的代价。

代码这边不会替你猜：`presence.js` 检测到「采用的 IP ≠ CF 说的访客」会告警一次并写明该换哪一行，
`/api/diag` 里也有 `usingCdnEdgeIp` 和 `hint`（`npm run test:presence` 钉住了这两条）。
**行为故意不改成信 `CF-Connecting-IP`** —— 那等于默认开一个伪造口子。

后端信不信这个头由 `TRUST_PROXY` 控制（默认 `loopback`，即「前面有一层自己人的反代」）。
取的是 XFF 的**最后一段** —— nginx 的 `$proxy_add_x_forwarded_for` 把它亲眼看到的对端追加在末尾，
前面那些是客户端自己带来的，`curl -H 'X-Forwarded-For: 1.1.1.1'` 谁都能伪造。

### STUN / TURN：观众连不上主播，九成是这里没配

TURN 和 netplay 共用 `/api/netplay/ice`（后端现签短期凭证，密码不进前端包），
配法见 [deploy/netplay/README.md 第四节](../netplay/README.md#四stun--turn不配的话很多人根本连不上)。

直播比联机更依赖它：联机的人多半是朋友之间对着邀请链接连，直播是**随便谁点进来都要连得上**。

⚠️ 内置的默认 STUN 是 Google / Twilio 的，部分地区不可达 —— 那种情况下浏览器
连自己的公网地址都问不出来，只剩局域网候选，**除非两个人在同一个路由器下面否则必然连不上**。
典型症状：观众等满超时报「连不上主播」，而主播那边完全正常、显示 0 人在看。
一条 `STUN_URLS=stun:turn.你的域名:3478` 就能解决，别让它拖着。

自查：`curl -s http://127.0.0.1:8788/api/netplay/ice | jq '{hasTurn, turnCount, expiry}'`。
观众那边连不上时控制台会留一行 `[live] 只收集到 host 候选，拿不到公网地址（STUN 不可达？）`，
看到这句就是这个问题，不用再查别的。

环境变量（都有默认值，可以不配）：

```bash
LIVE_MAX_ROOMS=200          # 同时在播的房间上限
LIVE_MAX_ROOMS_PER_IP=20    # 同一个出口 IP 同时能开几间（见下面）
LIVE_MAX_VIEWERS=12         # 单场观众上限，见下面「上行」
VITE_LIVE_MAX_BITRATE=1500000  # 单路视频码率上限
```

`LIVE_MAX_ROOMS_PER_IP` 别照着「一个人开几间」去想 —— 这个站是**玩就是播**，每个正在玩的人都占一间，
而手机网络、学校、公司的一大群人共用同一个出口 IP。设成 3 的话，同一个运营商 NAT 后面第四个开始玩的人
自动开播就静默失败（只在浏览器控制台留一行 `[live] 自动开播失败 … too many rooms`）。
内网 / 回环地址不计数：那说明反代没把 `X-Forwarded-For` 传进来，服务端日志会提醒一次 ——
以前这种配置错误会让**全站所有主播共用同一个额度**，整个站同时只能开 3 间。

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
