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

## 四、STUN / TURN：不配的话很多人根本连不上

这一节是**直播和联机连不上的头号原因**，别跳过。

### 先搞清楚两件事在干嘛

- **STUN**：浏览器问「我在公网上长什么样」。问不到就只有一堆局域网地址。
- **TURN**：直连实在打不通时的中继。只有这部分连接的流量会过服务器，能直连的照旧点对点。

⚠️ **代码里内置的默认 STUN 是 Google 和 Twilio 的**（`server/src/routes/ice.js` 的 `DEFAULT_STUN`）。
这几台在部分地区**根本不可达** —— 后果不是「慢一点」，而是浏览器连自己的公网地址都问不出来，
候选里只有 `host`（局域网地址），于是**除非两个人在同一个路由器下面，否则必然连不上**。
症状就是观众等满超时、报「连不上主播」，而主播那边一切正常显示 0 人在看。
面向国内用户就一定要用 `STUN_URLS` 换掉它们——自建的 coturn 本身就能当 STUN 用。

### 主用：自建 coturn（短期凭证，密码不出服务器）

**别再用 `VITE_NETPLAY_ICE` 填 TURN 账号密码** —— 那是构建时注入的，会明晃晃打进 JS 包里，
任何人打开 DevTools 就能抄走当免费流量中转。配在**后端** `server/.env` 里，
服务端按请求现算一份短期凭证下发（`GET /api/netplay/ice`），密码永远不出服务器。

`turnserver.conf`（关键就是 `use-auth-secret`，不需要建任何用户）：

```conf
listening-port=3478
tls-listening-port=5349
external-ip=你的公网IP
realm=8bitgo.com
use-auth-secret
static-auth-secret=<和 server/.env 里的 TURN_SECRET 一模一样>
min-port=49160
max-port=49200
fingerprint
no-cli
# 有证书就配上，turns:443 能穿掉大部分企业防火墙
cert=/etc/letsencrypt/live/turn.你的域名/fullchain.pem
pkey=/etc/letsencrypt/live/turn.你的域名/privkey.pem
```

```bash
docker run -d --name coturn --network host --restart unless-stopped \
  -v /etc/coturn/turnserver.conf:/etc/coturn/turnserver.conf:ro \
  -v /etc/letsencrypt:/etc/letsencrypt:ro \
  coturn/coturn:4 -c /etc/coturn/turnserver.conf
```

防火墙要放行：`3478/udp`、`3478/tcp`、`5349/tcp`，以及中继端口段 `49160-49200/udp`。
**中继端口段没放行是最常见的坑** —— 握手能过、一到传数据就卡死。

`server/.env`：

```bash
TURN_URLS=turn:turn.你的域名:3478?transport=udp,turns:turn.你的域名:5349?transport=tcp
TURN_SECRET=<node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
TURN_TTL_SEC=3600
# 顺手把 STUN 也指到自己这台，别再依赖 Google
STUN_URLS=stun:turn.你的域名:3478
```

### 兜底之一：Cloudflare Realtime TURN（推荐，按流量计费）

⚠️ **先别拿错产品。** Cloudflare 仪表盘的 Realtime 下面有两样完全不同的东西：

| 建出来的 | 给你什么 | 是什么 | 能不能当 TURN |
|---|---|---|---|
| **TURN Server / TURN key** | Key ID + API token | 真正的 TURN 中继 | ✅ 就是它 |
| **Realtime App（SFU）** | App ID + App Secret | 媒体服务器（推流/拉流） | ❌ 塞不进 `iceServers` |

SFU 的 App ID 长得跟 TURN key 很像，但它走的是 `/v1/apps/<id>/sessions`，
是「大家把流推给它、再从它那儿拉」的架构，和 NAT 穿透完全是两回事。
填进下面这两行不会报错，只会**静默地什么都不做**。

建好 TURN key 之后：

```bash
TURN_CF_KEY_ID=<Key ID>
TURN_CF_API_TOKEN=<API token>
TURN_CF_TTL_SEC=86400     # 领来的凭证有效期，默认 24 小时
TURN_CF_TIMEOUT_MS=2500   # 领凭证的超时，见下
```

服务端拿这两个去 CF 现领短期凭证（`POST /v1/turn/keys/<id>/credentials/generate-ice-servers`），
**token 永远不出服务器**。领来的会缓存住，不是每个请求都去撞人家接口；换了 key 缓存立刻作废。

三件做对了的事，改这块之前先知道：

1. **CF 挂了不能拖垮开局。** 这个接口在关键路径上 —— 玩家点「开始游戏」就在等它。
   领凭证有 2.5 秒超时（`AbortSignal`），失败后冷却 30 秒再试，期间其余几路照常下发。
   测试里专门验了「CF 返回 500」和「CF 干脆不回包」两种，接口都不能变慢、更不能 500。
2. **顺带解决 STUN 不可达。** CF 的响应里带 `stun.cloudflare.com`，会自动并进 STUN 那一格 ——
   本节开头那个「默认 STUN 在部分地区连不上、只有 host 候选」的老问题跟着一起解决了。
3. **计费。** CF TURN 按中继流量收费。它排在自建后面，只有「直连不通 **且** 自建也配不上」
   才会真的走它 —— 见下面那段关于顺序的说明。

### 兜底之二：别家托管 TURN（固定账号密码）

```bash
TURN_BACKUP_URLS=turn:xxx.relay.metered.ca:80,turns:xxx.relay.metered.ca:443?transport=tcp
TURN_BACKUP_USERNAME=<厂商给的>
TURN_BACKUP_CREDENTIAL=<厂商给的>
# 厂商也用 coturn 那套 static-auth-secret 约定时改填这个（填了就忽略上面的固定账号）
TURN_BACKUP_SECRET=
```

**两路是一起下发的，不是「主的挂了才用备的」。** WebRTC 没有那种串行回退：它从所有 ICE 服务器
一起收集候选，再按优先级配对。中继候选的优先级本来就最低（只有直连全部失败才会用上），
两路中继之间排在前面的本地优先级更高 —— 所以托管那路只在**直连不通、而且自建 coturn 也配不上**时
才真的吃流量。按流量计费的服务这样配才不会白烧钱，同时自建挂掉的那段时间站点不会整个瘫掉。

### 验证

```bash
curl -s http://127.0.0.1:8788/api/netplay/ice | jq
```

看三样：`hasTurn` 是不是 `true`、`turnSources` 里有没有你配的那几路、`expiry` 在不在将来。

```json
{ "hasTurn": true, "turnCount": 2, "turnSources": ["self-hosted", "cloudflare"], "expiry": 1757203200 }
```

**`turnSources` 就是给运维自查用的**：线上打开这个接口就知道每一路到底生效没有，
不用等用户来报「连不上」。CF 那路配了却没出现在里面，看后端日志有没有
`[ice] 向 Cloudflare 领 TURN 凭证失败` —— 多半是 key/token 填错，或者拿的是 SFU 的 App ID。

再去 <https://icetest.info>（或 Chrome 的 `chrome://webrtc-internals`）把上面那份
`iceServers` 贴进去测一遍，要能看到 `srflx`（STUN 通了）和 `relay`（TURN 通了）两种候选。
**只有 `host` 就说明 STUN 根本没通**，这时先别查别的，回头看本节开头那段。

观众侧现在会自己做这个判断：一个公网候选都没收集到时，报的是「你和主播的网络之间没有通路」
而不是含糊的「可能是网络限制或对方已经下播」，控制台还会留一行 `[live] 只收集到 host 候选`。

### ⚠️ 必须从**公网域名**验，不能从 127.0.0.1

上面那句「`expiry` 在不在将来」是这一节最容易被跳过、代价又最大的一条检查 ——
而**从 `127.0.0.1` 打是查不出问题的**：那条路绕开了 Cloudflare 和 nginx，源站永远给你一份新鲜的。

2026-09-07 线上就是这么坏的：

```bash
# 裸 URL —— 拿到的是 13.7 小时前签的那一份
curl -s https://你的域名/api/netplay/ice | jq '.expiry, .hasTurn'
# 带个随便什么 query（= 另一个 cache key，必然回源）—— 这一份是新鲜的
curl -s "https://你的域名/api/netplay/ice?cb=$RANDOM" | jq '.expiry, .hasTurn'
```

两个 `expiry` 差了十几个小时，就是**这个接口被缓存住了**。看响应头确认是哪一层：

```bash
curl -sI "https://你的域名/api/netplay/ice" | grep -iE "cf-cache-status|age|cache-control|x-cache"
```

`cf-cache-status: HIT` + 一个很大的 `age` = Cloudflare 在缓存；`x-cache`/`age` 而没有 cf 头 = nginx 的 `proxy_cache`。

**后果比看起来严重得多，而且完全不报错：**

- 自建 coturn 走 `use-auth-secret`，凭证的 username 就是 `<过期时间戳>:label`，
  coturn 会校验那个时间戳 —— **过期就直接 401 拒绝分配**，这一路对所有人都废了。
  `TURN_TTL_SEC=3600` 意味着缓存超过 1 小时它就死了。
- Cloudflare 那路 TTL 是 24 小时，所以它还能撑一阵，**于是故障被掩盖成
  「偶尔有一两成人连不上、第二天又好了」**，而 `hasTurn` 一路如实报 `true`。
- 缓存对象的年龄一旦超过 24 小时，两路中继同时死光，`hasTurn` 照样 `true`。
- `expiry` 落在过去还会让前端那份内存缓存彻底失效（续期判断永远不成立），
  **每建一条 PeerConnection 都真发一次 HTTP**。

**怎么修（按重要性排）：**

1. **把 `/api/` 排除出缓存规则**，这是根治。Cloudflare 侧：Caching → Cache Rules 新建一条
   `URI Path starts with /api/` → **Bypass cache**，并把它排在那条 "Cache Everything" 的**前面**
   （规则是从上往下匹配的，顺序错了等于没加）。nginx 侧：确认 `/api/` 那个 location 里没有
   `proxy_cache`，或者显式 `proxy_no_cache 1; proxy_cache_bypass 1;`。
2. 代码里已经加了两道闸，但**别拿它们当修复**：
   - 后端多发了 `CDN-Cache-Control` 和 `Cloudflare-CDN-Cache-Control`（优先级高于 `Cache-Control`，
     但 Edge TTL 被设成固定值时一样会被无视）；
   - 前端请求带一个**分钟桶**参数 `?t=<floor(now/60000)>`（见 `src/services/netplay.ts` 的 `iceBucket`），
     把陈旧上限钉死在 60 秒；
   - 前端还会检查「拿到的凭证是不是已经过期」，是就把 `hasTurn` 拉回 `false`、控制台打一行
     指得出原因的警告、并在 60 秒后重试（`npm run test:ice-config` 钉住这几条）。
3. 顺手把 `TURN_TTL_SEC` 从 3600 调到 `43200`（12 小时）—— 让自建这路和 CF 那路的
   抗缓存能力对齐，别再出现「CF 还活着、自建早死了」这种半死不活、最难查的状态。
   凭证仍然是短期的、仍然不出服务器，只是别把有效期设得比任何一层缓存都短。

### coturn 本身到底通不通（和上面那条分开查）

上面那个是**凭证**的问题，coturn 的配置可能一点毛病没有。要单独验它，
**一定要用一份新鲜的凭证**（带 query 的那个 URL 取），否则你验的还是 401：

```bash
curl -s "https://你的域名/api/netplay/ice?cb=$RANDOM" | jq '.iceServers[] | select(.username)'
```

把其中**自建那一条**（`turn:turn.你的域名:...`）单独贴到 <https://icetest.info>，
只留它、把别的都删掉，然后看有没有 `relay` 候选：

- 出 `relay` → coturn 是好的，问题纯粹在凭证/缓存。
- 一个 `relay` 都没有 → 按这个顺序查：
  1. `docker logs coturn | grep -i "401\|check_stun_auth\|realm"` —— 满屏 401 = 凭证时间戳过期（回上一节），
     `realm` 不匹配 = `turnserver.conf` 的 `realm` 和签发时用的不一致；
  2. `static-auth-secret` 和 `server/.env` 的 `TURN_SECRET` **必须一模一样**（末尾多个空格/换行也不行）；
  3. **中继端口段 `49160-49200/udp` 有没有放行** —— 这是最常见的一条，握手能过、一传数据就卡死；
  4. `external-ip` 填的是不是真的公网 IP（云服务器上是 NAT 的话必须显式填）；
  5. `turns:5349` 那条要证书对得上域名，Let's Encrypt 续期后记得让 coturn 重新加载。

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
