# P2P 联机（默认方案）

游戏在**房主自己的浏览器里**跑，画面和声音用 WebRTC 直接推给加入的人，访客的按键走 DataChannel
回到房主、注入到对应手柄位。**画面不经过你的服务器**，服务端只有一个转发握手的信令端点。

```
浏览器(房主) ══WebRTC 音视频══► 浏览器(访客 2P/3P/4P)
浏览器(访客) ──DataChannel 按键──► 浏览器(房主) ──simulateInput──► 模拟器
      └────── 只有 SDP / ICE 经过 8BitGo 后端的 /netplay ──────┘
```

和 cloud-game 的分工：**P2P 是所有人的默认**（零服务器成本）；cloud-game 游戏跑在服务器上、
每个房间占一个 CPU 核，用于「当前没人在线也能玩」和付费会员的稳定画质，
由 `src/config/features.ts` 的 `cloudGame` 控制（现已打开）。
房主掉线不再需要靠云端兜底 —— 见下面的「房主迁移」。

---

## 一、必须先自建 EmulatorJS（这一步绕不开）

netplay 是 EmulatorJS **4.3.0-pre** 才有的功能，而官方 CDN 的 `stable` 和 `nightly`
目前都还是 **4.2.3**，**不含 netplay**。所以必须自己构建一份放到 `public/emulatorjs/`：

```bash
cd ~/Documents
git clone --depth 1 https://github.com/EmulatorJS/EmulatorJS.git
cd EmulatorJS
npm install
npm run build            # 产物在 data/

# 复制到本项目
rsync -a --delete data/ ~/Documents/8bitgo/public/emulatorjs/
```

> **`public/emulatorjs/` 已经提交在仓库里了**，上面这几步只在需要升级 EmulatorJS 时才做。
> 拉下代码直接 `npm run build` 就是自建版，不需要额外下载，也不需要配 `VITE_EJS_PATH`。

验证**别看 version.json 的版本号** —— main 分支到今天仍然写着 `"version": "4.2.3"`，
和 CDN 的 stable 一模一样，看版本号根本分不出来。看有没有那两个特性：

```bash
grep -c dontExtractIfCore public/emulatorjs/emulator.min.js   # 自建 = 1，CDN 版 = 0
grep -c netplay           public/emulatorjs/emulator.min.js   # 自建 > 0
```

`dontExtractIfCore` 是街机能不能玩的关键：没有它，`neogeo.zip` 这个 BIOS 会被
EmulatorJS 先解压再喂给核心，FBNeo 拿到一堆散文件，报「四个 Neo Geo BIOS 成员缺失」。

**核心（cores/）必须一起自托管**，已和运行时一起提交在 `public/emulatorjs/cores/`
（升级：`npm i --no-save @emulatorjs/cores@latest && npm run ejscores`，结果照旧进 git）。
别指望引擎的 CDN 回落：这个构建自称 4.3.0-pre，回落到 cdn.emulatorjs.org/4.3.0-pre/
取回的核心起不来，报「Error loading EmulatorJS runtime」。

跑起来之后，浏览器控制台里的验收标志是这三行（缺一不可）：

```
[EJS Core] Downloading core: fbneo-wasm.data      ← 从 /emulatorjs/cores/ 本地取，不是 cdn.emulatorjs.org
[EJS ROM] Core fbneo requires special handling, will not attempt to extract if compressed.
[EJS BIOS] Core fbneo requires special handling, will not attempt to extract if compressed.
```

注意写的是核心名 `fbneo`，不是平台名 `arcade`。

构建完两件事不能忘（都幂等，多跑无害）：

```bash
npm run ejspatch    # blob URL 文件名补丁：不打的话拖入本地街机 ROM 报 Romset is unknown
npm run ejscores    # 核心（升级核心才需要，平时 git 里已有）
```

prebuild 的 check-emulatorjs.mjs 会把这两样都查一遍，漏了构建直接失败。

> main 是开发分支，官方口径「不建议用于生产」，且**跨版本的核心与存档不通用**。
> 上线后再升级要考虑老用户的存档。

## 二、起信令服务器

就是本项目的 Node 后端，`server/src/netplay.js` 已经挂好了，只需要装依赖：

```bash
cd server
npm install              # 会装上新增的 socket.io
npm start
```

房间列表是纯内存的，**不需要 MySQL**；只想跑联机的话不配数据库也能起。

## 三、前端 .env

```
# VITE_EJS_PATH 不用配了，代码里默认就是 /emulatorjs/（见 adapters/emulatorjs.ts）
VITE_NETPLAY_URL=http://127.0.0.1:8788/netplay # 信令，线上换成 https://你的域名/netplay
VITE_API_URL=http://127.0.0.1:8788             # 房间列表 / 用户接口
```

改完**必须重启 `npm run dev`** —— Vite 的环境变量是构建时注入的。

## 四、TURN：不配的话会有一两成的人连不上

P2P 要穿 NAT。只有 STUN 时，对称型 NAT、部分企业网和移动网络的组合连不通，
这时需要 TURN 中继兜底 —— **只有这部分连接的流量会过服务器**，其余仍是直连。

`deploy/cloudgame/docker-compose.yml` 里那个 coturn 可以直接复用；单独跑也行：

```bash
docker run -d --network host coturn/coturn:4 -n --log-file=stdout \
  --listening-port=3478 --external-ip=你的公网IP --realm=8bitgo \
  --lt-cred-mech --user=8bitgo:你的密码 \
  --min-port=49160 --max-port=49200 --no-tls --no-dtls --no-cli --fingerprint
```

前端 `.env`：

```
VITE_NETPLAY_ICE=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:你的IP:3478","username":"8bitgo","credential":"你的密码"}]
```

国内部署时 Google 的 STUN 可能不通，换成国内的 STUN 或直接只留自己的 TURN。

## 五、验证

```bash
curl http://127.0.0.1:8788/api/netplay/rooms      # []
curl http://127.0.0.1:8788/socket.io/socket.io.js # socket.io 客户端脚本（iframe 要用）
```

打开一款**多人游戏**的详情页（`players > 1`，且有云端 ROM），应该看到「开始游戏 · 自动创建房间」：

1. 点开始 → 游戏在你的浏览器里跑起来
2. 侧边栏「联机玩」里出现你的房间
3. 工具栏点「复制邀请链接」（形如 `/games/<slug>?p2p=<房间id>`）
4. 换个浏览器 / 无痕窗口打开链接 → 「加入房间」→ 看到的是**房主那边的画面**，按键能操作 2P

## 六、房主掉线会怎样：自动换人接着玩

游戏跑在房主的浏览器里，房主一走这局本来就该没了。所以做了房主迁移：

1. **房主每 25 秒**把存档（gzip 后 NES 约 20KB、GBA 几十 KB）POST 到信令服务器，
   只存最新一份，**不向访客广播**，所以带宽可以忽略
2. 房主掉线时房间**不立刻解散**，进入「等待新房主」状态保留 **60 秒**，
   按加入顺序选出最早进来的那位访客
3. 被选中的人先 **认领**（`POST /claim`，凭自己的成员令牌）。认领之后轮询暂停、
   他断线房间也不散 —— 接手要重新挂载引擎，旧连接必断；没有这一步，双人房会在这一刻被当成
   「没人了」解散掉，老邀请链接跟着死
4. 然后取存档 → 载入自己的模拟器 → 重新开房 → 凭 **认领令牌 + 新房间令牌** 调 `/migrate`，
   其他人跟过去。**原来的邀请链接继续有效**（服务器把旧房间 id 做成别名）
5. 60 秒内没人接手（比如大家都走了）、或者认领了却没在 `NETPLAY_CLAIM_WINDOW_MS`（默认 60 秒）
   内接完，才真的解散，提示「房主已离开」

对玩家来说：画面黑几秒，然后接着玩，进度最多回退 25 秒。界面上会提示
「房主掉线了，正在由你接手」/「房主换人了，正在重新连接」。

所有鉴权都走服务端下发的房间令牌（`room-token` 事件）：上传存档、认领、迁移、切身份。
**不再接受 userid** —— 那是客户端自己填的、还随 `users-updated` 广播给全屋，以前拿它就能
覆盖房主存档、把整屋人劫到自己的房间里。

服务端还会过滤 `data-message`：`pause` / `play` / `restart` 只有房主能发（EmulatorJS 收到就直接
执行）；`sync-control` 观众一个键都不许发，玩家只能发自己手柄位的键。信令只走星型（访客 ↔ 房主）。
每个 IP 最多同时开 `NETPLAY_MAX_ROOMS_PER_IP`（默认 4）个房间。

调宽限期用环境变量 `NETPLAY_HOST_GRACE_MS`（毫秒，默认 60000）。

### 回归测试

信令服务器这部分不需要浏览器就能验：

```bash
cd server && npm install
NETPLAY_HOST_GRACE_MS=400 NETPLAY_CLAIM_WINDOW_MS=500 node scripts/test-netplay.mjs
node scripts/test-netplay-hardening.mjs
```

前者覆盖开房 / 加入 / 信令定向转发 / 满员 / 密码 / 存档托管 / 掉线选新房主 / 认领 /
迁移后老链接仍有效 / 双人房唯一访客接手 / 超时解散 / 认领窗口过期 / 跨房间信令隔离；
后者覆盖令牌鉴权 / 控制消息过滤 / 按键越权 / 星型信令 / 每 IP 上限 / SSE / ICE。
改了 `src/netplay.js` 两个都跑一遍。

## 七、观众席（= 直播）

房主那边本来就在「抓画面 → WebRTC 推给房间里的每个人」，这已经是一套推流系统了。
所以直播不用另起炉灶，只要把进房的人分成两类：

| | 占手柄位 | 能操作 | 上限 |
| --- | --- | --- | --- |
| player（玩家） | 是 | 是 | 游戏自己的玩家数，最多 4 |
| spectator（观众） | 否 | 否 | `NETPLAY_MAX_SPECTATORS`，默认 12 |

**手柄位满了不再把人拒之门外**，而是自动转成观众。想主动只看的，进房前点「只看不玩」，
进去之后也能在工具栏「上场玩 / 退到观众席」之间来回切，不用断线重连。

怎么保证观众按键不生效：EmulatorJS 的链路是
`键盘 → GameManager.simulateInput → netplay.simulateInput`，
最后这一步既把输入喂给本地模拟器、又发 `sync-control` 给房主。
观众这一侧我们把 `netplay.simulateInput` 换成空实现（`adapters/emulatorjs.ts`），
两条路一起断掉。服务端的 `role` 只是记账 —— 按键走 WebRTC 直连房主、根本不经过服务器，
所以**真正管用的是客户端这一下**。

界面上：

* 侧边栏「直播」→ `/rooms?live=1`，就是同一批房间按「几个人在看」排序
* 房间卡片右下角 `👥 玩家数/上限`，左下角 `👀 在看人数`；满员的卡片显示「👀 观看」而不是灰掉的「已满」
* 邀请链接照旧是 `?p2p=<房间id>`；从直播入口进去的链接多带一个 `&watch=1`，表示默认只看

接口（都在 `server/src/netplay.js`）：

```
POST /api/netplay/rooms/:roomId/role   { role: 'player' | 'spectator' }
     头 x-netplay-token: <进房时服务端下发的房间令牌>
     409 = 手柄位满了 / 房主不能变观众 / 观众席满了
GET  /api/netplay/rooms                每个房间多了 spectators、maxSpectators，members[].role
```

### 观众能有多少人

每个观众都是**房主那台机器**的一条 WebRTC 上行流。家宽上行大约撑到十来路，
所以默认上限给了 12。真要做几十上百人的直播，得在中间加一层 SFU
（房主只推一路给服务器，服务器复制成 N 路），那就不是零成本了。

### 回归测试

```bash
cd server && node scripts/test-spectator.mjs
```

24 项，覆盖满员转观众 / 观众不占 current / 玩家↔观众互切 / 房主不能变观众 /
令牌鉴权 / 观众席上限 / 换房主优先找玩家。

## 八、限制（都是这个方案的固有特性）

| | 说明 |
| --- | --- |
| 房主关页面 | 有人接手就继续（见上一节），进度回退最多 25 秒；没人接手则 60 秒后解散 |
| 房主的上行带宽 | 每个访客一条流。家宽上行通常够 1～3 个访客，人多会卡 |
| 房主的机器 | 编码由浏览器做（一般有硬件加速），但房主卡 = 所有人卡 |
| 引擎 | 只有 EmulatorJS 支持。`.nes` 现在默认走 jsnes，联机时会自动改用 EmulatorJS |
| 需要云端 ROM | 房主和访客都要能下载同一个 ROM，所以本地文件不能联机 |
| 延迟 | 访客的按键要走一个来回，和云游戏同量级 |

## 九、房间列表是怎么来的

信令服务器天然知道有哪些房间、几个人，所以 P2P 房间直接从 `/api/netplay/rooms` 读，
不需要心跳。cloud-game 的房间仍走 `/api/rooms` 心跳，两边在
`src/services/allRooms.ts` 里合并成一个列表，侧边栏和 `/rooms` 页都用它。

房间和游戏的对应关系：EmulatorJS 要求 `gameId` 是数字，所以前端用 FNV-1a 把 slug 散列成数字
（`services/netplay.ts` 的 `gameIdFor`），列表里再反查回 slug。不需要额外存储。
