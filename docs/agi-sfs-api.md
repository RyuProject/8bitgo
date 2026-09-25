# 8BitGo AGI1 / AGI2 / SFS 接口总览

> 公网基址：`https://8bitgo.com`  
> 文档基线：2026-09-25  
> 面向对象：Flash 游戏开发者、播放器接入方和 8BitGo 运维人员

这三套接口解决的是两类完全不同的问题：

| 接口 | 用途 | 传输 | 身份 |
| --- | --- | --- | --- |
| AGI1 | 旧 Armor Games 方法式在线存档 | HTTPS + JSON | 站内登录 JWT 换逐游戏短期令牌 |
| AGI2 | Armor Games 对象式在线存档；也提供新游戏简化接口 | HTTPS + JSON | 同 AGI1 |
| SFS | SAS3 的 SmartFoxServer 1.x 联机字节桥 | WSS ↔ TCP | 不使用 8BitGo 令牌；浏览器检查 Origin |

AGI 和 SFS 互不共用令牌、连接或数据表。不要把存档令牌放进 WebSocket，也不要把 SFS 数据当 JSON 发送。

详细资料：

- AGI1 / AGI2 逐方法契约、校验和排障：[`agi-bridge-api.md`](./agi-bridge-api.md)
- AGI 在线存档的架构、并发保护与历史取舍：[`flash-online-save.md`](./flash-online-save.md)
- SFS 完整接入说明：[`smartfoxserver-api.md`](./smartfoxserver-api.md)
- SFS OpenAPI 3.1：[`../deploy/sfs/openapi.yaml`](../deploy/sfs/openapi.yaml)
- SFS 私有化部署：[`../deploy/sfs/README.md`](../deploy/sfs/README.md)

---

## 1. 先判断该接哪一套

| 场景 | 应选接口 |
| --- | --- |
| 旧游戏加载 `AGI.swf`，直接调用 `submitUserData` | AGI1 |
| 旧游戏加载 `AGI2.swf`，调用 `connect()` 后访问 `storage.user` | AGI2 |
| 新开发的 Flash 游戏需要三槽在线存档 | AGI2 的 `eightbitgo` 简化接口 |
| SAS3 或兼容客户端需要 SmartFoxServer 1.x 联机 | SFS |
| 保存整个 Ruffle SharedObject 或模拟器快照 | 不是本文接口；使用站点 `/api/saves` |

当前已审核接入：

| 游戏 | slug | 协议 | 桥 |
| --- | --- | --- | --- |
| Infectonator 2 | `infectonator-2` | AGI1 | `/flash-api/armor-games/20260925-r03/AGI.swf` |
| Kingdom Rush Frontiers | `kingdom-rushfrontiers` | AGI2 | `/flash-api/armor-games/20260925-r03/AGI2.swf` |
| SAS: Zombie Assault 3 | `sas3`、`sas-zombie-assault-3` | SFS 1.x | 运行时从 `/api/sfs/config` 发现 |

游戏标识必须与 `games.slug` 完全一致。AGI 服务端还会检查游戏是否是 `flash` 平台以及是否位于审核接入表中。

---

## 2. AGI 公共流程

### 2.1 页面换取短期会话

完整登录 JWT 只能由宿主页面持有，绝不能传给 SWF。页面先申请一枚限定到当前游戏的短期令牌：

```http
POST /api/flash-saves/v1/session
Authorization: Bearer <8BitGo 登录 JWT>
Content-Type: application/json

{ "gameSlug": "infectonator-2" }
```

```json
{
  "success": true,
  "data": {
    "sessionToken": "eyJ...",
    "expiresAt": 1789545600000,
    "endpoint": "/api/flash-saves/v1/infectonator-2",
    "protocol": "agi1",
    "bridgeUrl": "/flash-api/armor-games/20260925-r03/AGI.swf",
    "username": "Player",
    "avatar_url": "/ui/logo-mark.png"
  }
}
```

后续 `/read`、`/write-slot`、`/delete-slot` 不再使用完整 JWT，而是在 JSON body 中携带
`sessionToken`。响应和存档内容均为 `Cache-Control: no-store`。

### 2.2 未登录时的行为

- 桥仍会加载，本地存档继续可用；`sessionToken` 是空串，在线状态为未登录。
- 只有玩家主动点击登录、在线保存或删除在线槽时，桥才通知宿主页面打开登录框。
- AGI2 开局自动读档不会弹登录框，避免每次进入游戏都被打断。
- 登录完成后需要重新进入本局；当前桥的 FlashVars 只在加载时读取，不能在运行中替换令牌。

### 2.3 写入并发字段

```json
{
  "opId": "s1a2b3c4d5e6-7",
  "expectedRevision": 4
}
```

| 字段 | 说明 |
| --- | --- |
| `opId` | 一次逻辑写入的幂等 ID；网络重试必须复用同一个值 |
| `expectedRevision` | 条件更新版本；与服务端当前版本不同时返回 `stale_write` |
| 响应 `revisions` | 读档时返回各槽当前版本，供桥后续写入使用 |

两字段为兼容旧桥而保持可选。新接入必须发送它们，否则迟到请求仍可能覆盖新进度。

---

## 3. AGI1 快速参考

### 3.1 Flash 游戏侧方法

```as3
init(devKey:String, gameKey:String):void
isLoggedIn():Boolean
getUserData():Object
getUserName():String
showLogin(callback:Function):void
submitUserData(key:String, data:Object, callback:Function):void
retrieveUserData(callback:Function, key:String = null):void
deleteUserData(key:String):void
```

AGI1 一份存档由两次连续提交组成：

```text
profileonline0 + dataonline0 → slot 0
profileonline1 + dataonline1 → slot 1
profileonline2 + dataonline2 → slot 2
```

`retrieveUserData` 的参数顺序固定为 `(callback, key)`。桥只会把完整的 profile/data 对暴露给游戏，半份存档不会出现在读档结果里。

### 3.2 HTTP 接口

读取全部或一个键：

```http
POST /api/flash-saves/v1/infectonator-2/read
Content-Type: application/json

{ "sessionToken": "eyJ...", "key": "dataonline0" }
```

写入完整槽：

```http
POST /api/flash-saves/v1/infectonator-2/write-slot
Content-Type: application/json

{
  "sessionToken": "eyJ...",
  "slot": 0,
  "profile": { "index": "online0", "saved": 1 },
  "data": { "index": "online0", "level": 12 },
  "expectedRevision": 4,
  "opId": "s1a2b3c4d5e6-7"
}
```

删除槽：

```http
POST /api/flash-saves/v1/infectonator-2/delete-slot
Content-Type: application/json

{ "sessionToken": "eyJ...", "slot": 0 }
```

写入成功返回：

```json
{ "success": true, "data": { "slot": 0, "revision": 5, "updatedAt": 1789516800000 } }
```

---

## 4. AGI2 快速参考

### 4.1 Armor Games 对象式接口

```as3
connect(options:Object = null):void

user.isGuest():Boolean
user.getUsername():String
user.getAvatarURL():String
user.getUID():String
user.showLogin(options:Object):void

storage.user.retrieve(options:Object):void
storage.user.submit(options:Object):void
storage.user.erase(options:Object):void
```

所有异步回调都放在 `options.callback`。读档结果始终是 `{ success, keys }`，没有存档时也必须返回 `keys:{}`。

### 4.2 新 Flash 游戏简化接口

新游戏推荐加载 AGI2 桥后使用 `eightbitgo`：

```as3
var api:Object = loader.content;
api.connect({ callback: function(result:Object):void {
  var save:Object = api.eightbitgo;
  if (!save.isLoggedIn()) {
    save.showLogin(function(status:Object):void {});
    return;
  }
  save.write("slot1", { level: 12 }, function(written:Object):void {});
  save.read("slot1", function(read:Object):void {
    if (read.success && read.value != null) trace(read.value.level);
  });
}});
```

```as3
eightbitgo.isLoggedIn():Boolean
eightbitgo.getUser():Object
eightbitgo.showLogin(callback:Function = null):void
eightbitgo.read(key:String, callback:Function):void
eightbitgo.write(key:String, value:Object, callback:Function):void
eightbitgo.remove(key:String, callback:Function):void
```

键只允许 `slot1`、`slot2`、`slot3`。

### 4.3 HTTP 接口

```http
POST /api/flash-saves/v1/kingdom-rushfrontiers/read
{ "sessionToken": "eyJ..." }

POST /api/flash-saves/v1/kingdom-rushfrontiers/write-slot
{ "sessionToken": "eyJ...", "key": "slot1", "value": { "level": 12 },
  "expectedRevision": 2, "opId": "s7f8e9d0c1b2-3" }

POST /api/flash-saves/v1/kingdom-rushfrontiers/delete-slot
{ "sessionToken": "eyJ...", "key": "slot1" }
```

典型读响应：

```json
{
  "success": true,
  "keys": { "slot1": { "level": 12 } },
  "revisions": { "slot1": 2 }
}
```

服务端只输出三个合法槽键，不会把旧 Armor Games 的付费内容标记当作玩家存档透传。

---

## 5. AGI 校验、限额与错误

默认限额：单个 AGI1 半份 1 MiB；一个完整槽 2 MiB；每账号所有 AGI 存档合计 32 MiB；JSON 深度不超过 32。存档根值必须是普通对象，不能是数组或 `null`；对象内部可以包含数组，但非有限数字以及 `__proto__`、`prototype`、`constructor` 等危险键会被拒绝。

错误统一为：

```json
{ "success": false, "error": { "code": "invalid_session", "message": "在线存档会话已失效" } }
```

| HTTP | code | 客户端处理 |
| --- | --- | --- |
| 400 | `invalid_request` | 修正参数，不重试 |
| 401 | `invalid_session` | 清除在线状态，提示重新登录/进入本局 |
| 403 | `game_mismatch` | 停止请求；令牌与路径游戏不一致 |
| 404 | `game_not_enabled` | 停止请求；游戏未审核接入或已下线 |
| 409 | `quota_exceeded` | 提示清理存档或联系管理员 |
| 409 | `stale_write` | 使用 `error.currentRevision` 对齐版本，不重放旧数据 |
| 413 | `save_too_large` | 缩小数据，不重试 |
| 429 | `rate_limited` | 遵守 `Retry-After` |
| 503 | `not_configured` | 在线存档不可用，本地游戏继续 |

只有网络失败、超时、坏响应可以复用同一 `opId` 重试一次。参数、权限、配额和版本冲突不应自动重试。

---

## 6. SFS 快速参考

### 6.1 发现配置

```http
GET /api/sfs/config
Accept: application/json
```

```json
{
  "enabled": true,
  "protocol": "SmartFoxServer 1.x",
  "games": ["sas3", "sas-zombie-assault-3"],
  "websocket": {
    "path": "/sfs/sas3",
    "url": "wss://8bitgo.com/sfs/sas3"
  },
  "native": null,
  "ruffle": {
    "socketProxy": [{
      "host": "sas3server.ninjakiwi.com",
      "port": 444,
      "proxyUrl": "wss://8bitgo.com/sfs/sas3"
    }]
  }
}
```

必须先判断 `enabled`。关闭时接口仍返回 HTTP 200，但 `websocket:null`、`ruffle:{}`；联机不可用不应阻塞单机游戏。

### 6.2 Ruffle 接入

```js
let sfs = {}
try {
  const response = await fetch('https://8bitgo.com/api/sfs/config', {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  const config = response.ok ? await response.json() : null
  if (config?.enabled) sfs = config.ruffle || {}
} catch {
  // SFS 是可选旁路，发现失败时继续以单机模式启动。
}

await player.ruffle().load({
  url: swfUrl,
  ...sfs,
})
```

SAS3 仍连接它原本的 `sas3server.ninjakiwi.com:444`，Ruffle 的 `socketProxy` 会把连接转到 8BitGo WSS。

### 6.3 自定义 WebSocket 客户端

```js
const socket = new WebSocket(config.websocket.url)
socket.binaryType = 'arraybuffer'
socket.addEventListener('message', (event) => {
  sfsParser.push(new Uint8Array(event.data))
})
```

- 只发送 SmartFoxServer 1.x 原始二进制字节，不发送 JSON 或 Base64。
- WebSocket 帧边界不等于 SFS 消息边界；接收端必须使用流式解析器。
- 浏览器 Origin 必须同时进入 HTTP CORS 和 `SFS_ALLOWED_ORIGINS` 白名单。
- 离开游戏、换号或重连前必须主动关闭旧 WebSocket。

### 6.4 状态检查

```http
GET /api/sfs/status
```

关键字段：

| 字段 | 含义 |
| --- | --- |
| `enabled` | 运行时开关是否打开 |
| `ready` | 开关打开且最近一次 sidecar TCP 探测成功 |
| `connections.active` | 当前连接数 |
| `connections.limit` / `perIpLimit` | 全局 / 单 IP 并发上限 |
| `traffic.fromClient` / `fromUpstream` | 当前 Node 进程生命周期累计字节 |

握手结果：`101` 成功；`403` Origin 不允许；`429` 连接超限；`503` 旁路关闭。连接建立后常见关闭码：`1013` 上游暂不可用或拥塞，`1011` 上游关闭，`1006` 网络或心跳异常断开。

推荐对可恢复错误使用 1s、2s、4s、8s、最高 30s 的带抖动指数退避。不要重试 `403`；`429` 至少等待 10 秒；`503` 时先继续单机，30 秒后重新读取配置。

---

## 7. 发布前检查

### AGI

- 游戏 slug 已加入 `shared/flash-save-games.js`，且与数据库完全一致；
- AGI1 已核对真实 `gameKey`，AGI2 已核对对象和回调形状；
- 没有把完整登录 JWT 传给 SWF；
- 写入使用同一 `opId` 重试，并携带 `expectedRevision`；
- 修改桥后运行 `npm run flashbridge`，同时提交规范产物、版本目录副本和 manifest；
- 运行 `npm run test:flash-online-save` 与 `npm --prefix server run test:flash-routes`。

### SFS

- 每次启动前读取 `/api/sfs/config`，没有写死 WSS 地址；
- 网页精确 Origin 已加入两份白名单；
- 收发的是 SFS 1.x 原始字节，并按流解析；
- 处理连接上限、上游故障、指数退避与主动断开；
- SFS 不可用时单机仍能启动；
- 运行 `npm run test:sfs`。

---

## 8. 版本与兼容约定

- Flash 存档 HTTP 路径带 `/v1`；破坏性协议变化必须新增版本，不能原地改变响应形状。
- AGI1 与 AGI2 的方法名、参数顺序、回调结构和文档类名属于游戏 ABI，不能“顺手统一”。
- 桥升级时修改 `FLASH_SAVE_BRIDGE_RELEASE` 并发布新目录；不要覆盖旧 URL 后等待 CDN 缓存过期。
- SFS 的 WSS 地址、游戏列表和 Ruffle 配置属于运行时信息，以 `/api/sfs/config` 为准。
- 调用方必须忽略响应中不认识的新字段，不要对整个 JSON 做完全等值比较。
