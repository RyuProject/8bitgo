# Flash 在线存档接口设计

本文定义 8BitGo 为旧 Flash 游戏提供在线存档时使用的站内接口，以及替代第三方 API SWF
需要实现的 ActionScript 契约。第一款接入游戏是 Infectonator 2 v1.6。

> 📌 **接口本身的参考手册另有一篇：`docs/agi-bridge-api.md`。**
> 那篇按「AGI1 / AGI2」两代方言逐方法、逐字段地列接口（含参数语义、回调形状、
> 错误码、校验限额、排查线索）。**本文讲的是设计取舍与踩坑经过**（为什么分两套、
> 为什么令牌不落盘、R01/R02 两条并发问题是怎么来的），改接口前建议两篇对照着看。
> AGI 与 SFS 的统一速查入口是 `docs/agi-sfs-api.md`。

## 1. 已核对的游戏行为

核对文件：`603478_Infectonator2ver1.6.swf`

- SHA-256：`fb7e7a20d06cd41fda3f14c74c4b20b787623ce80fbf5b25f628bbd31056d61a`
- 外层是 MochiCrypt 3.2c，真实游戏 SWF 位于加密 payload 内。
- 游戏在两个地方加载 `http://agi.armorgames.com/assets/agi/AGI.swf`：主菜单和存档页。
- 两处都调用 `init("854b4e92ca10ca37da032c09e036d353", "infect-2")`。
- 游戏有 3 个在线槽，键固定为：
  - `profileonline0`、`dataonline0`
  - `profileonline1`、`dataonline1`
  - `profileonline2`、`dataonline2`
- `profile` 与 `data` 是普通对象、数组、字符串、有限数字和布尔值，可以安全转为 JSON。
- 游戏写档时连续调用两次 `submitUserData`，先 profile、后 data；回调错误被游戏静默忽略。
- 游戏读档页会一次取回所有键，并且只要 profile 存在就把槽标成可加载。因此服务端不能暴露
  只有 profile 或只有 data 的半份存档。
- 内置站点锁配置的 `siteLockOn2` 为 `0`，实际判断代码也会最终放行，不需要修改站点锁 XML。
- 游戏已经有“Copy Save”按钮，会把 3 个本地槽复制到在线槽，可以直接作为旧本地存档的迁移入口。

## 2. 接入边界

新增接口与现有 `/api/saves` 并行存在：

- `/api/saves` 继续保存 Ruffle SharedObject 的整份快照，其他 Flash 游戏行为不变。
- `/api/flash-saves/v1` 保存游戏主动调用的在线槽。
- 两套数据不共用表、不共用 slot，也不互相覆盖。
- 只为后台明确启用在线存档的 Flash 游戏签发会话令牌。

不直接改 MochiCrypt 包。Ruffle 按游戏配置 `urlRewriteRules`，把失效的 Armor Games AGI 地址
改写到本站托管的兼容 SWF。这样不需要重打加密外壳，也不会影响其他 Flash 游戏。

## 3. 身份模型

完整站内 JWT 只能由 React 页面使用，绝不交给 SWF。页面在启动 Ruffle 前申请一枚 Flash
存档会话令牌：

```http
POST /api/flash-saves/v1/session
Authorization: Bearer <8BitGo 登录令牌>
Content-Type: application/json

{
  "gameSlug": "infectonator-2"
}
```

成功响应：

```json
{
  "success": true,
  "data": {
    "sessionToken": "eyJ...",
    "expiresAt": 1789545600000,
    "endpoint": "/api/flash-saves/v1/infectonator-2",
    "username": "玩家昵称",
    "bridgeUrl": "/flash-api/armor-games/20260925-r03/AGI.swf",
    "avatar_url": "/ui/logo-mark.png"
  }
}
```

令牌必须使用独立的 `FLASH_SAVE_SECRET` 签名，建议有效期 8 小时。声明固定为：

```json
{
  "iss": "8bitgo",
  "aud": "8bitgo-flash-save",
  "sub": "用户 id",
  "game": "infectonator-2",
  "scope": ["save:read", "save:write"],
  "tv": 0,
  "iat": 1789516800,
  "exp": 1789545600
}
```

服务端每次都校验：签名、`aud`、过期时间、路径里的 game slug、用户是否存在、账号状态及
`token_version`。请求体里的用户 id 一律忽略，因为用户身份只能来自令牌。

没有登录时不申请令牌，游戏仍可使用原本的本地 3 槽。玩家在游戏内主动点
“Login”、写在线槽或删在线槽时，桥通过仅对已审核游戏开启的 `ExternalInterface`
通知页面，页面打开站内登录弹窗并提示登录后重新进入本局。AGI2 开局自动读槽不弹，
避免每次启动都打断玩家。

## 4. Ruffle 启动参数

页面拿到会话后，通过 Ruffle 的 `parameters` 传给根 SWF：

```ts
{
  parameters: {
    eightbitgo_save_endpoint: 'https://8bitgo.com/api/flash-saves/v1/infectonator-2',
    eightbitgo_save_token: sessionToken,
    eightbitgo_username: username,
    eightbitgo_avatar_url: 'https://8bitgo.com/ui/logo-mark.png',
    eightbitgo_save_mode: 'authenticated',
    eightbitgo_login_callback: '__eightbitgoFlashSaveLoginRequired',
    eightbitgo_game_slug: 'infectonator-2',
    eightbitgo_save_protocol: 'agi1',
    eightbitgo_agi_game_key: 'infect-2',
  },
  urlRewriteRules: [
    [
      'http://agi.armorgames.com/assets/agi/AGI.swf',
      'https://8bitgo.com/flash-api/armor-games/20260925-r03/AGI.swf',
    ],
    [
      'https://agi.armorgames.com/assets/agi/AGI.swf',
      'https://8bitgo.com/flash-api/armor-games/20260925-r03/AGI.swf',
    ],
  ],
}
```

兼容 SWF 从 `stage.root.loaderInfo.parameters` 读取这些值。传给 Ruffle 的桥地址、API 地址和头像
地址都先转成绝对 URL，避免远程 ROM 的 `base` 把 `/api` 错解到资源域名。API、播放器页面和兼容 SWF 都使用
`https://8bitgo.com` 同源地址，因此不依赖 `crossdomain.xml`，也不需要放开跨域 Cookie。

头像字段必须是真实可加载的 HTTPS PNG/JPEG 地址。当前站内头像是 emoji，不能原样传给 Flash
的 `Loader`；第一版统一返回本站默认 PNG。

## 5. SWF 到服务端的接口

旧 Flash 的 `URLLoader` 对 GET/POST 最稳定，下面的数据操作统一使用 POST。会话令牌放 JSON
请求体，不放 URL，避免进入访问日志、Referer 或缓存键。

### 5.1 读取

```http
POST /api/flash-saves/v1/infectonator-2/read
Content-Type: application/json

{
  "sessionToken": "eyJ..."
}
```

不传 `key` 时返回所有完整槽。只有 profile 和 data 都存在的槽才会返回。
响应顶层还会带一个 `revisions`（`{"0": 4, "2": 1}`，槽 → 当前版本号），**是给桥做条件更新用的**，
游戏侧不看它。空槽不出现在里面（按 0 处理）。

```json
{
  "success": true,
  "data": {
    "profileonline0": {
      "name": "Player",
      "index": "online0",
      "saved": 1
    },
    "dataonline0": {
      "index": "online0"
    },
    "PremiumEnabled": 0,
    "PremiumEnabled_Price": 0
  }
}
```

读取单键：

```http
POST /api/flash-saves/v1/infectonator-2/read
Content-Type: application/json

{
  "sessionToken": "eyJ...",
  "key": "dataonline0"
}
```

成功且存在：

```json
{
  "success": true,
  "data": {
    "index": "online0"
  }
}
```

槽不存在或不完整时仍是正常查询，返回：

```json
{
  "success": true,
  "data": null
}
```

`PremiumEnabled` 和 `PremiumEnabled_Price` 由服务端权益系统生成，永远不从玩家存档读取，
也不能通过写档接口修改。未接权益系统前固定返回 `0`。

### 5.2 原子写入一槽

```http
POST /api/flash-saves/v1/infectonator-2/write-slot
Content-Type: application/json

{
  "sessionToken": "eyJ...",
  "slot": 0,
  "profile": {
    "name": "Player",
    "index": "online0",
    "saved": 1
  },
  "data": {
    "index": "online0"
  }
}
```

成功响应：

```json
{
  "success": true,
  "data": {
    "slot": 0,
    "revision": 4,
    "updatedAt": 1789516800000
  }
}
```

服务端在一个事务中同时覆盖 profile 和 data。必须验证：

- `slot` 只能是 `0`、`1`、`2`。
- `profile`、`data` 必须是普通 JSON 对象，不能是数组或 `null`。
- `profile.index` 与 `data.index` 都必须等于 `online<slot>`。
- `profile.saved` 必须等于 `1`。
- 单部分序列化后不超过 1 MiB，整槽不超过 2 MiB。
- JSON 最大深度 32，拒绝 `__proto__`、`prototype`、`constructor` 这类危险键。

同一用户的写入要锁 `users` 行再计算配额，沿用现有云存档的并发配额做法。每个账号建议最多
32 MiB Flash 在线存档；覆盖成更小的档案始终允许。

**两个可选字段（2026-09-20 起的写入并发保护，见「附三」）：**

| 字段 | 作用 |
| --- | --- |
| `expectedRevision` | 条件更新：只有服务端当前版本等于它才落库，否则 `409 stale_write`。不发就没有并发保护（旧桥兼容） |
| `opId` | 幂等重放：同一个 ID 再来一次不会重复写，返回当前版本。客户端超时重试必须复用它 |

响应里的 `revision` 是**代次表**里的版本号（不是本行自增），客户端拿它做下一次的条件更新。

### 5.3 删除一槽

```http
POST /api/flash-saves/v1/infectonator-2/delete-slot
Content-Type: application/json

{
  "sessionToken": "eyJ...",
  "slot": 0
}
```

响应：

```json
{
  "success": true,
  "data": { "revision": 7 }
}
```

删除必须幂等。槽原本不存在时仍返回成功。

`data.revision` 是删除**之后**的版本号：删档也推进代次（否则「删掉再存」会让版本号回到 1，
一个基于旧版本 1 的迟到请求又能通过条件更新，即 ABA）。客户端要把它记下来，否则删档之后的
第一次正常保存会带着删除前的版本撞条件更新，白丢一次。

## 6. 兼容 AGI.swf 的 ActionScript 契约

游戏实际调用的方法如下。方法名、参数顺序和同步/异步性质必须保持一致：

```as3
init(devKey:String, gameKey:String):void
isLoggedIn():Boolean
getUserData():Object
getUserName():String
showLogin(callback:Function):void
submitUserData(key:String, data:Object, callback:Function):void
retrieveUserData(callback:Function, key:String = null):void
deleteUserData(key:String):void
initAGUI(options:Object = null):void
showScoreboardSubmit(score:Number, username:String, board:String, columns:Array):void
showScoreboardList(columns:Array, board:String):void
```

特别注意：真实游戏的 `retrieveUserData` 是 `callback` 在前、`key` 在后，不是常见的
`(key, callback)`。

### 登录方法

- `init` 接受旧的 devKey/gameKey，但它们不能作为身份凭据；gameKey 要与
  共用接入表的 `agiGameKey` 相同（通过 `eightbitgo_agi_game_key` 下发）。
- `isLoggedIn` 必须同步返回。兼容 SWF 在初始化时根据 FlashVars 是否含有效格式的会话令牌设置状态。
- `getUserData` 返回 `{ username, avatar_url }`。
- `getUserName` 返回昵称字符串。
- 已登录时，`showLogin(cb)` 立即调用：

```as3
cb({
  success: true,
  loggedIn: true,
  username: username,
  avatar_url: avatarUrl
});
```

- 未登录时**也是同一个形状**（只是 `loggedIn:false`、两个字符串为空 —— 桥照实回填，不另做形状）：

```as3
cb({ success: true, loggedIn: false, username: "", avatar_url: "" });
```

网络或桥接错误必须调用一次 `cb({ success:false, loggedIn:false })`，不能让游戏永久等待。

### 保存桥接

游戏连续提交同一槽的 profile 和 data，但服务端只接受完整槽。兼容 SWF 应按槽暂存：

1. 收到 `profileonlineN` 时缓存 profile 和它的回调。
2. 收到 `dataonlineN` 时缓存 data 和它的回调。
3. 两部分都到齐后调用一次 `write-slot`。
4. 服务端成功后，对两个原始回调各调用一次 `{ success:true }`。
5. 任意失败时，对两个回调各调用一次 `{ success:false, error:"..." }`。
6. 1.5 秒仍未凑齐一对时判为 `pair_incomplete`，清掉该槽的暂存，避免下一次保存混入旧半份。

只接受正则 `^(profile|data)online[0-2]$`。其他 key 直接回调失败。

每个槽还要有自己的先进先出队列：一对数据凑齐后立刻移入不可变的写入任务，再开始收下一对。
同一槽的任务必须按顺序提交，不能让较慢的旧请求在较新的存档之后落库，把进度倒退回去。

### 读取桥接

- `retrieveUserData(cb)` 调用全量读取，将服务端返回体原样传给回调。
- `retrieveUserData(cb, key)` 调用单键读取。
- HTTP 非 2xx、JSON 无法解析、超时或网络失败时都必须调用
  `cb({success:false, data:null, error:"..."})`。
- 同一个回调只能执行一次。

### 删除桥接

游戏会连续调用 `deleteUserData("profileonlineN")` 和 `deleteUserData("dataonlineN")`。
兼容 SWF 将任意一个调用映射成删除整个 N 槽，并按「**这个槽已经排了删除**」这个标记合并重复调用
（`MainTimeline.as` 的 `deleteQueued`），避免中间刚写入的新存档被第二次删除。服务端删除本身仍然保持幂等。

> ⚠️ 这里以前是「2 秒时间窗内去重」，2026-09-19 改掉了：时间窗会把「删档 → 重新存 → 再删」
> 里的第二次删除一起吞掉，玩家删完看到槽空了、其实档还在。写入入队时会清掉这个标记。

### 排行榜空实现

在线存档第一版不实现排行榜，但不能让方法完全空转：

- `initAGUI(options)` 保存 `options.onClose`。
- `showScoreboardSubmit(...)` 应立即调用保存的 `onClose`，否则游戏会把“提交”按钮永久隐藏。
- `showScoreboardList(...)` 可以直接返回。

## 7. 数据库

```sql
CREATE TABLE flash_save_slots (
  user_id       VARCHAR(40)      NOT NULL,
  game_slug     VARCHAR(160)     NOT NULL,
  slot          TINYINT UNSIGNED NOT NULL,
  profile_json  JSON             NOT NULL,
  data_json     JSON             NOT NULL,
  size          INT UNSIGNED     NOT NULL,
  revision      INT UNSIGNED     NOT NULL DEFAULT 1,
  created_at    TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP
                                   ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, game_slug, slot),
  INDEX idx_flash_save_user_time (user_id, updated_at),
  CONSTRAINT fk_flash_save_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

`revision` 每次写入显式加一，`updated_at` 也显式更新，避免内容相同时 MySQL 不更新时间。

权益不要塞进这张表。以后需要付费或会员权益时单独建表，由读取接口把服务端计算结果映射成
`PremiumEnabled == 2` 和 `PremiumEnabled_Price`。

## 8. 错误格式

所有端点都返回 JSON，错误体保持同一形状：

```json
{
  "success": false,
  "error": {
    "code": "invalid_session",
    "message": "在线存档会话已失效"
  }
}
```

建议状态码：

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `invalid_request` | 字段、slot、index 或 JSON 结构不合法 |
| 401 | `invalid_session` | 令牌无效或过期 |
| 403 | `game_mismatch` | 令牌不能访问路径里的游戏 |
| 404 | `game_not_enabled` | 该游戏未启用 Flash 在线存档 |
| 409 | `quota_exceeded` | 用户总配额不足 |
| 413 | `save_too_large` | 单槽超过大小上限 |
| 429 | `rate_limited` | 请求过于频繁 |
| 503 | `not_configured` | 服务端未配置 Flash 存档签名密钥 |

## 9. 验收清单

1. 未登录进入游戏，本地 3 槽照常可玩、可保存、可加载。
2. 登录后进入游戏，在线 3 槽可见，昵称正常，头像加载失败也不能阻止槽位出现。
3. 新建 online0，退出并换浏览器登录，online0 可以加载。
4. 模拟 profile 请求成功、data 请求失败，读取接口不得返回该半份新槽。
5. 快速连续保存同一槽，最终 profile 和 data 来自同一批提交。
6. 删除槽时两次 `deleteUserData` 都成功，重复删除不报错。
7. “Copy Save”能把已有本地槽复制到在线槽。
8. 修改请求体中的 game slug 或尝试 key `PremiumEnabled`，服务端拒绝。
9. 令牌过期、退出所有设备或账号被封禁后，旧 SWF 会话不能继续读写。
10. 点击排行榜提交后，提交按钮会恢复，不会因为空实现永久消失。
11. 其他 Flash 游戏仍走原来的 Ruffle SharedObject 云存档，没有额外请求或 URL 改写。

---

# 附：AGI2 方言（Kingdom Rush Frontiers）

第二款接入的游戏是 Kingdom Rush Frontiers。它用的是 **Armor Games AGI2**，和上面
Infectonator 2 的 AGI1 是两套完全不同的外部接口，所以桥、存储形状和响应格式都另起一套。

## A1. 两代的关键差异

| | AGI1（Infectonator 2） | AGI2（Kingdom Rush Frontiers） |
| --- | --- | --- |
| 桥文件 | `AGI.swf` | `AGI2.swf` |
| 接口风格 | 方法式：`init / isLoggedIn / submitUserData / retrieveUserData / deleteUserData` | 对象式：`connect()` 返回 `user / storage / content / quests` 四个命名空间 |
| 一次提交 | 连调两次（profile + data），服务端拼成一槽 | 一个 `key → value`，value 就是整份进度 |
| 键 | `profileonline0..2` / `dataonline0..2` | `slot1` / `slot2` / `slot3` |
| 读全量返回 | `{ success, data: { profileonlineN, dataonlineN, … } }` | `{ success, keys: { slot1, slot2, slot3 } }` |
| 存储表 | `flash_save_slots`（成对覆盖） | `flash_save_kv`（key→value 覆盖） |
| 入口参数 | `init(devKey, gameKey)` | `connect({ stage, apiKey })` |

方言逐游戏绑定在 `shared/flash-save-games.js` 的 `FLASH_SAVE_GAMES`；它是前后端共用的唯一接入表。

## A2. 服务端接口

会话申请沿用 `POST /api/flash-saves/v1/session`，响应里多了 `protocol`，`bridgeUrl` 按方言给：

```json
{ "success": true, "data": {
  "sessionToken": "eyJ...", "expiresAt": 1789545600000,
  "endpoint": "/api/flash-saves/v1/kingdom-rushfrontiers",
  "protocol": "agi2",
  "bridgeUrl": "/flash-api/armor-games/20260925-r03/AGI2.swf",
  "username": "玩家昵称", "avatar_url": "/ui/logo-mark.png"
} }
```

### 读

```http
POST /api/flash-saves/v1/kingdom-rushfrontiers/read
{ "sessionToken": "eyJ..." }
```

```json
{ "success": true, "keys": { "slot1": { …进度对象… }, "slot3": { … } } }
```

带 `key` 时只回那一个：`{ "success": true, "keys": { "slot1": { … } } }`；
槽不存在就是 `{ "success": true, "keys": {} }`。

两代一致：顶层还有 `revisions`（`{"slot1": 2}`，给桥做条件更新，游戏侧不看），
写入也带同样的 `opId` / `expectedRevision` —— 见「附三」。两代桥都会在读档后对齐代次、
重试时复用同一个 `opId`，防止迟到的旧写入把新档覆盖掉。

> ⚠️ **只输出 slot1~3。** 真 Armor 服务当年会在 `keys` 里塞
> `kingdomRushPremiumContentEnabled`，KRF 见到它等于 2 就解锁付费内容。白名单过滤写在
> `agi2SaveMap()` 里，不要改成「原样透传」。

### 写

```http
POST /api/flash-saves/v1/kingdom-rushfrontiers/write-slot
{ "sessionToken": "eyJ...", "key": "slot1", "value": { …整份进度… } }
```

```json
{ "success": true, "data": { "key": "slot1", "revision": 4, "updatedAt": 1789516800000 } }
```

校验：`key` 只能是 `slot1/2/3`；`value` 必须是普通 JSON 对象（非数组、非 null）；深度 ≤ 32；
拒绝 `__proto__` / `prototype` / `constructor`；单个 value ≤ 2 MiB。

### 删

```http
POST /api/flash-saves/v1/kingdom-rushfrontiers/delete-slot
{ "sessionToken": "eyJ...", "key": "slot1" }
```

幂等：槽不存在也返回 `{ "success": true }`。

### 配额

AGI1 与 AGI2 分表存放，但**配额按账号统一计算**（两张表之和，见路由里的
`FLASH_SAVE_TOTAL_SQL`）。只统计一张会给另一张留下绕过配额的后门。

## A3. 数据库

```sql
CREATE TABLE IF NOT EXISTS flash_save_kv (
  user_id       VARCHAR(40)      NOT NULL,
  game_slug     VARCHAR(160)     NOT NULL,
  save_key      VARCHAR(64)      NOT NULL,
  value_json    JSON             NOT NULL,
  size          INT UNSIGNED     NOT NULL,
  revision      INT UNSIGNED     NOT NULL DEFAULT 1,
  created_at    TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, game_slug, save_key),
  INDEX idx_flash_save_kv_user_time (user_id, updated_at),
  CONSTRAINT fk_flash_save_kv_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

`cd server && npm run migrate` 会补建（老库和空库都能跑；`schema-v2.sql` 也已同步）。

## A4. 桥接 AGI2.swf

源码：`flash-api/armor-games/src-agi2/KrfAgiBridge.as`；产物：
`public/flash-api/armor-games/AGI2.swf`，随 Git 部署。构建见
`flash-api/armor-games/README.md`（**AGI2 用自己的种子模板，不能换成 Ruffle 空壳**——
游戏依赖文档类名 `KrfAgiBridge`）。

### 对外接口（已按产物反编译核对，逐字不能改）

```as3
// 文档类 KrfAgiBridge（顶层类，extends Sprite）
connect(options:Object = null):void          // 读 FlashVars；options.callback 回调 {success:true}

// 四个命名空间是**公开属性**，游戏从 Loader.content 直接取
user.isGuest():Boolean
user.getUsername():String
user.getAvatarURL():String
user.getUID():String

storage.user.retrieve(options:Object):void   // { key?, callback } -> 回调 { success, keys }
storage.user.submit(options:Object):void     // { key, value, callback }
storage.user.erase(options:Object):void      // { key, callback }

content.retrievePurchases(options)           // { success:true, purchases:[] }
content.retrieveProducts(options)            // { success:true, products:[] }
content.showStore(options)                   // { success:false, error:{code:'store_unavailable'} }
content.RESPONSE_USER_CANCELLED / RESPONSE_PURCHASE_FAILED / RESPONSE_PURCHASE_SUCCESS
quests.submit(options)                       // { success:true, quest:{ progress, status:'completed' } }

// 私有：readParameters / enqueue / pump / submitWrite / retriable / errorCode / post / callOnce
```

三条固定约定（改桥时别动）：**回调一律放在 `options.callback`**（不是第二个参数）；
`retrieve` 的响应是 `{success, keys}`，没有槽时给 `keys:{}` 而不是 null；
`content` 的三个响应常量必须原样保留。

### 与 AGI1 桥一致的三处加固

| 加固 | 为什么 |
| --- | --- |
| 失败回调里也解析 `loader.data` | 4xx/5xx 在 Ruffle 里走 `ioError`，不解析就把 `invalid_session` 一律报成 `network_error` |
| 收到 `invalid_session` 就摘掉登录态 | 游戏据此把在线槽标成不可用，这是唯一能让玩家看见的反馈 |
| 写失败重试一次（800ms，会话失效不重试） | 游戏忽略回调里的错误，一次抖动 = 玩家这一程白跑；服务端 upsert 幂等 |

队列是**全局串行**（不是每槽一条）：AGI2 一次提交就是一份完整档，串行化保证「后点的保存」在「先点的保存」之后落库。

## A5. 页面侧

`src/services/flashOnlineSave.ts` 不再自己维护桥表，改为读 **`shared/flash-save-games.js`**
（前后端唯一一份「游戏 → 方言 → 桥文件名」映射）：

- `kingdom-rushfrontiers → agi2 → /flash-api/armor-games/20260925-r03/AGI2.swf`；
- `urlRewriteRules` 按桥文件名生成，只改写这款游戏真正会加载的那一代
  （被补丁过的副本直接请求本站地址，规则是给仍指向 `agi.armorgames.com` 的副本兜底）。

## A6. 验收清单

1. 未登录进游戏：本地 3 槽可玩，在线槽禁用（半透明不可点）。
2. 登录后进游戏：3 个在线槽可见，昵称正常，头像加载失败不影响槽位出现。
3. 世界地图 / 过关 / 升级后自动保存，换浏览器登录能读回同一进度。
4. 删除按钮清空该槽；重复删除不报错。
5. `read` 响应里**绝不出现** `kingdomRushPremiumContentEnabled`，游戏内不出现 premium 内容。
6. 请求体里把 `key` 换成 `slot4` / `PremiumEnabled` 一律 400。
7. Infectonator 2 的 AGI1 流程与响应形状完全不受影响。

---

# 附二：静默失败的防护（审计后加固，2026-09-19）

这套功能最危险的从来不是崩溃，而是**悄无声息地不工作**：游戏照跑、界面照常显示在线槽，
只有玩家的进度没上去。下面每一条都在堵这一类。

## B1. 唯一一份接入表

`shared/flash-save-games.js` 是「游戏 → 方言 → 桥文件名」的**唯一来源**，前端和服务端都读它。
以前这份信息散在三处（前端 `BRIDGES`、后端 `GAME_PROTOCOLS`、env 白名单），漏改一处的症状是
「桥能加载、也能连上，就是读不到档」。

`scripts/test-flash-save-consistency.mjs` 钉死四处一致（注册表 / 服务端读出的值 / 桥文件名与
方言的配套关系 / 前端没有再写一份），并已并入 `npm run test:flash-online-save`。
白名单默认值也改成从这张表推导，不再手写字符串。

## B2. AGI1 桥（`AGI.swf`）

| 加固 | 为什么 |
| --- | --- |
| 写失败**重试一次**（800ms，会话失效不重试） | 游戏忽略 `submitUserData` 回调里的错误，一次网络抖动等于这一关白打。服务端是 upsert，重试幂等 |
| 失败时也解析 `loader.data` | 4xx/5xx 在 Ruffle 里走 `ioError`，不解析就把 `invalid_session` 一律报成 `network_error`，分不清「网断了」和「会话过期」 |
| 收到 `invalid_session` 就摘掉登录态 | 让游戏把在线槽重新标成不可用 —— 这是「游戏忽略回调错误」前提下唯一可见的反馈 |
| 读之前等**在飞的写**落库（上限 3s） | 刚过关触发保存、紧接着打开存档页时，不等会读到写之前那一份，像「刚存的档没生效」 |
| 删除按「该槽已排了删除」去重 | 原先是 2 秒时间窗，会把「删档 → 重新存 → 再删」里的第二次删除吞掉，玩家以为删了其实还在 |
| `gameKey` 校验失败时 `trace` 一条 | 校验失败是静默关闭整条链的，留个能在控制台查的线索 |

## B3. 服务端

- 会话限流 120 → **600/小时**：重开局 / 切布局 / 换语言都会重新挂载播放器并各申请一次会话，
  原来的额度可能打满，之后整小时退游客态且无提示。
- 配额改成**分表查**：一条 SQL 同时查两张表时，老库缺 `flash_save_kv` 会让本来好用的 AGI1
  每次保存都 500；分开查时缺表只当 0。
- 限额改走 `resource-limits.js` 的 `envNumber()`，三层上限按 **半份 ≤ 整槽 ≤ 账号总量** 约束。
  原来写的 `Number(process.env.X || 默认)` 有个静默坑：`FLASH_SAVE_TOTAL_MAX_BYTES=abc` 得到
  NaN，而 NaN 参与的所有比较都是 false —— **等于把限额整个关掉**，日志里一个字都没有。
  现在非法值夹到最近边界或退回默认值，并且每次都 `console.warn` 出声。
  > ⚠️ 和审计包给的版本有一处**刻意**差别：那边遇到非法值是抛异常让进程起不来。
  > 这台 Express 同时扛着整站，配额填错属于「某个功能配置有误」，不该演成整站 502；
  > 而退回默认值并不会让保护消失 —— 默认值就是安全的那一档。见 `resource-limits.js` 顶部注释。
- **每次请求复核白名单**：会话令牌 8 小时有效，只在签发时查的话，游戏被停用后旧令牌
  还能继续读写满 8 小时。中间件里每请求查一次 `flashSaveGameEnabled()`。
- **删档进事务 + 重锁用户行**：中间件那次会话复核在事务外，账号注销 / 被封 / 令牌吊销
  可能就发生在它和删除之间，而删除不可逆。两个方言的删除都走 `withTransaction` +
  `SELECT … FOR UPDATE` 复核 `status` / `token_version`。

## B4. 页面侧

- 会话在**内存里按「游戏 + 当前登录令牌」复用**（离到期不足 5 分钟不用）：省掉重复申请，
  也避免打满限流。键里带登录令牌，所以登出 / 换号自动失效，不会留下可写窗口。
- 会话申请失败区分两类：网络类失败重试一次；4xx（令牌失效 / 限流 / 未启用）直接退不可用模式，不白打请求。
- 桥上报登录意图时，页面只对 `mode=guest` 打开登录框；`mode=unavailable`
  代表用户已登录但存档会话服务失败，不能把故障误报成「请登录」。
- **临期提示**：运行时把会话到期时间报给播放器（`onFlashSaveSession`），
  播放器在到期前 10 分钟提示一次（`player.flashSaveExpiringSoon`）。令牌经 FlashVars 进入 SWF
  后换不掉，到期只能重进一局 —— 不说的话症状是「后半局的档都没了」。

## B5. 产物校验

`scripts/check-flash-save-bridge.mjs` 按源码存在性**逐代**强校验：源码在时，规范产物或当前发布代次副本
任一缺失都会让构建失败。以前只认 `AGI.swf`，AGI2 源码落地却漏提交 SWF 时构建照样全绿。

## B6. 仍然存在的限制

- 会话到期后**必须玩家手动重进**（FlashVars 只读一次）。ExternalInterface 已用于登录意图，
  但要真正原地续期还得增加「页面向 SWF 反向更新令牌」的通道。
- 两代桥的读前等写上限都是 3 秒：极端情况下（后台标签页被节流）仍可能读到旧档。
- 桥修复必须提升 `FLASH_SAVE_BRIDGE_RELEASE` 并发布新目录；当前会话返回不可变版本 URL，
  不再等待旧固定地址的边缘缓存过期。

---

# 附三：写入并发（R01 / R02，2026-09-20）

审计报告把「存档写入的时序问题」列为本轮**没有**被局部修复消除的风险，这里补上。
两条是不同的问题，一条解决在协议上，另一条只能在客户端做到「宁可失败、不许写坏」。

## C1. R01：迟到的旧请求不许覆盖新存档

**问题**：原实现是纯 upsert（`ON DUPLICATE KEY UPDATE`）——谁最后到谁说了算。
一次被网络拖住的旧保存（比如客户端 12 秒超时后放弃、请求却还在路上）可以在一次更新的保存
**之后**才到达服务端，把新档覆盖成旧状态。玩家看到的症状是「进度倒退了」。

**设计**（两端一起改，字段全部**可选**，旧桥照样能写）：

| 角色 | 做什么 |
| --- | --- |
| 服务端 | 每 (账号, 游戏, 槽) 维护一个**代次**：`flash_save_seqs.revision` + `last_op_id`（见 A3 后面的 SQL） |
| 服务端 | 写入带 `expectedRevision`：不等于当前代次就 `409 stale_write`，**不落库**，并在 `error.currentRevision` 返回当前代次 |
| 服务端 | 写入带 `opId`：等于 `last_op_id` 就是重试，回当前版本、不再写（幂等重放） |
| 服务端 | 读档回 `revisions`；删档也要推进代次（否则就是 ABA，见下），并在响应里回新版本 |
| 客户端（桥） | 读档 / 写成功 / 删成功时同步本地 `revisions[slot]`；写入带上 `expectedRevision` 与 `opId` |

版本号存在**代次表**而不是存档行上，是因为删除会把行删掉：如果版本号随行消失，
「删档 → 再存」之后版本又从 1 开始，一个基于旧版本 1 的迟到请求恰好又能通过条件更新 ——
这就是 ABA。代次表只有几行（每账号每游戏每槽一行），代价可以忽略。

```sql
CREATE TABLE IF NOT EXISTS flash_save_seqs (
  user_id       VARCHAR(40)      NOT NULL,
  game_slug     VARCHAR(160)     NOT NULL,
  save_key      VARCHAR(64)      NOT NULL,   -- AGI1: "0"~"2"；AGI2: "slot1"~"slot3"
  revision      INT UNSIGNED     NOT NULL DEFAULT 0,
  last_op_id    VARCHAR(64)      NULL,       -- 最后一次成功应用的 opId；同 ID 再来 = 重试
  updated_at    TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, game_slug, save_key),
  CONSTRAINT fk_flash_save_seqs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

写入和**删除**都让 `revision` 前进一格：写入是 upsert 存档行 + 推进代次；删除是删行 + 推进代次。
删除不会清掉最近一次成功写入的 `last_op_id`，否则那次写入的超时重放可能在删档后把档复活。
存档行上的 `revision` 现在等于代次表的值（不再是自己 `+1`），两处一致便于排查。

**幂等重放**解决的是另一半：客户端超时重试是常态，没有 `opId` 的话「重试」等于「再写一遍」。
桥的重试复用同一个 `opId`，服务端认出后回**当前**版本（不是当时那个），让客户端的本地版本
重新对齐 —— 否则它下次会带着过期版本撞条件更新。

**冲突之后**：桥不重试这份旧档；服务端把当前代次放进 `error.currentRevision`，桥直接同步它，
因此下一次保存仍带条件更新，不会退化成无保护写入，也不需要为了恢复代次再补一次读档。

**残余**：不带 `expectedRevision` 的客户端没有并发保护。这是协议上二选一的事
（「旧客户端照样能写」vs「迟到写入不许覆盖」不能同时成立），所以字段是可选的，
而不是服务端硬性要求。

## C2. R02：两半包的代际

**先澄清一个事实**：本仓库的 AGI1 桥**不是**分两次请求提交的 —— `submitUserData` 收齐
profile / data 两半后合成**一个** `/write-slot` 请求（`MainTimeline.as` 的 `enqueue`），
所以服务端拿到的永远是原子的一对。审计报告里「服务端无法推断两半是否同属一次保存」
在**游戏 → 桥**这一段仍然成立：游戏不给我们保存操作的 ID。

桥原来的配对规则是「每槽每半各留一个，先到先配」，于是「profile 重复到达」时会出问题：
`P1, P2, D1` 这种序列会把 **P2 和 D1** 配成一对（跨代次），而这份档表面完全正常。

**现在的规则**：一旦检测到同一半重复到达，说明这次保存的两半归属已经不可判定，
于是**丢掉旧的那一半，并把下一个到达的 data 半也丢掉**（`resync`），要求重新凑一对。
在 `P1, P2, D1, D2` 下正好配对出 `P2 + D2`（一次都不丢）；在 `P1, P2, D1` 下丢掉这次保存。

为什么敢丢：游戏每次送的都是**全量状态**，不是增量。少存一次只是云端的档晚一个保存点，
而「旧 profile + 新 data」拼出来的坏档是玩家点开才发现的。

另外，写入现在带 `opId`（两半共用同一个 ID），服务端把它落在 `last_op_id` 上 ——
这份档从此有了一致的代次标识，重放和迟到都能被识别。

**残余**：从根上证明两半同属一次保存，需要**游戏**给出保存 ID（我们改不了游戏内部）。
现状是「客户端严格配对 + 服务端记录代次 + 宁可丢掉不配对」这三层兜底。

## C3. 上线顺序

```bash
cd server && npm run migrate      # 建 flash_save_seqs（缺了的话写入直接 500，读档只降级）
cd .. && npm run flashbridge      # 重编译 AGI.swf（客户端侧改动只有它）
npm run test:flash-online-save    # 桥校验 + 一致性 + 契约
npm --prefix server run test:flash-routes   # 路由级：条件更新 / 重放 / ABA
```

部署后注意两点：

1. **桥要等边缘缓存过期**（约 1 小时）才全球生效：过期的旧桥不带新字段，
   行为等于「没有并发保护」—— 不会出错，只是保护还没到位。
2. 迁移完成前后**不要重启**：`write-slot` 依赖 `flash_save_seqs`，缺表会 500；
   读档路径刻意只降级（拿不到 `revisions` 而已）。

## C4. 验收清单

1. 同一浏览器两个标签页同时存档：后保存的那份胜出，先保存的迟到请求返回 `409 stale_write`，
   且**不改变**已存内容。
2. 断网 → 存档 → 恢复：桥重试沿用同一个 `opId`，服务端的 `revision` 只前进一格（不是两格）。
3. 删档后立刻再存：能存上，且不出现「删完又冒出旧档」。
4. 旧标签页（缓存里的旧桥）继续能存：不带 `expectedRevision` 时写入仍然成功。
5. `read` 响应里 `revisions` 与随后的写入版本号能对上（`revision` 单调递增）。
