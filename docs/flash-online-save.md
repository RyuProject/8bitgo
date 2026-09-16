# Flash 在线存档接口设计

本文定义 8BitGo 为旧 Flash 游戏提供在线存档时使用的站内接口，以及替代第三方 API SWF
需要实现的 ActionScript 契约。第一款接入游戏是 Infectonator 2 v1.6。

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
    "bridgeUrl": "/flash-api/armor-games/AGI.swf",
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

没有登录时不申请令牌，游戏仍可使用原本的本地 3 槽。第一版中点击游戏内“Login”可以提示玩家
先在站点登录并重新进入游戏；以后再通过仅对该游戏开启的 `ExternalInterface` 接入登录弹窗。

## 4. Ruffle 启动参数

页面拿到会话后，通过 Ruffle 的 `parameters` 传给根 SWF：

```ts
{
  parameters: {
    eightbitgo_save_endpoint: 'https://8bitgo.com/api/flash-saves/v1/infectonator-2',
    eightbitgo_save_token: sessionToken,
    eightbitgo_username: username,
    eightbitgo_avatar_url: 'https://8bitgo.com/ui/logo-mark.png',
  },
  urlRewriteRules: [
    [
      'http://agi.armorgames.com/assets/agi/AGI.swf',
      'https://8bitgo.com/flash-api/armor-games/AGI.swf',
    ],
    [
      'https://agi.armorgames.com/assets/agi/AGI.swf',
      'https://8bitgo.com/flash-api/armor-games/AGI.swf',
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

不传 `key` 时返回所有完整槽。只有 profile 和 data 都存在的槽才会返回：

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
  "success": true
}
```

删除必须幂等。槽原本不存在时仍返回成功。

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

- `init` 接受旧的 devKey/gameKey，但它们不能作为身份凭据；可以核对 gameKey 是否为 `infect-2`。
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

- 未登录时第一版调用：

```as3
cb({ success: true, loggedIn: false });
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
兼容 SWF 将任意一个调用映射成删除整个 N 槽，并在 2 秒内合并同一槽的重复删除，避免中间刚写入的
新存档被第二次删除。服务端删除本身仍然保持幂等。

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
