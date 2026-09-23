# AGI1 / AGI2 兼容桥接口文档

替代已停服的 Armor Games 在线存档服务：老 Flash 游戏照旧去加载
`agi.armorgames.com/assets/agi/AGI*.swf`，Ruffle 按 `urlRewriteRules` 把这次加载改写到本站的
兼容桥；桥再把游戏调用翻译成站内 `/api/flash-saves/v1/...`。原游戏的加密外壳不用动。

**这份文档回答什么**：两代桥各自的接口长什么样、每个参数什么语义、
**哪些地方会静默失败**（这是这套功能最危险的部分）。

不在这里的内容：

| 想知道 | 去看 |
| --- | --- |
| 为什么分两套方言、为什么令牌不落盘、代次表怎么来的（R01 / R02） | `docs/flash-online-save.md` |
| 桥怎么编译、模板为什么不能换 | `flash-api/armor-games/README.md` |
| 站点云存档（Ruffle SharedObject 快照） | `docs/flash-online-save.md` 第 2 节 |

涉及的文件：

| 角色 | 文件 |
| --- | --- |
| 接入表（**唯一一份**「游戏 → 方言 → 桥文件名」） | `shared/flash-save-games.js` |
| 服务端契约、校验、限额 | `server/src/flash-save-contract.js` |
| 路由 | `server/src/routes/flash-saves.js` |
| 页面侧：申请会话 → 拼 FlashVars → 改写 URL | `src/services/flashOnlineSave.ts` |
| 桥源码 | `flash-api/armor-games/src/test_fla/MainTimeline.as`（AGI1）、`flash-api/armor-games/src-agi2/KrfAgiBridge.as`（AGI2） |
| 桥产物 + manifest | `public/flash-api/armor-games/AGI.swf`、`AGI2.swf`、`runtime.json`、`runtime-agi2.json` |

---

## 1. 两代对照

两代**接口不兼容**，是两个独立产物，不能互相顶替。

| | AGI1 | AGI2 |
| --- | --- | --- |
| 接入的游戏 | Infectonator 2（`infectonator-2`） | Kingdom Rush Frontiers（`kingdom-rush-frontiers`） |
| 桥文件 | `/flash-api/armor-games/AGI.swf` | `/flash-api/armor-games/AGI2.swf` |
| 文档类（**不能改**） | `test_fla.MainTimeline` | `KrfAgiBridge`（包外顶层类） |
| 源码 | `src/test_fla/MainTimeline.as` | `src-agi2/KrfAgiBridge.as` |
| 模板 | 借 Ruffle 的开源回归测试 SWF 空壳 | 仓库里的 `template-agi2.swf`（名字的载体） |
| 接口风格 | **方法式**：直接挂在实例上 | **对象式**：`connect()` 后经四个命名空间调用 |
| 一次保存 | 连调两次 `submitUserData`（profile + data），桥配成一对 | 一次 `submit`，`key → value` 就是整份进度 |
| 存档键 | `profileonline0..2` / `dataonline0..2` | `slot1` / `slot2` / `slot3` |
| 服务端存储 | `flash_save_slots`（一槽一行、成对覆盖） | `flash_save_kv`（一行一个键值） |
| 读全量返回 | `{ success, data: {...}, revisions }` | `{ success, keys: {...}, revisions }` |
| 回调位置 | 独立参数（`submitUserData(k, d, cb)`） | `options.callback` |
| `error` 形状 | **字符串**（`"not_logged_in"`） | **对象**（`{ code: "not_logged_in" }`） |
| 队列粒度 | **每槽一条 FIFO** | **全局一条串行队列** |
| 写入并发保护（`opId` / `expectedRevision`） | 有 | 有 |

> 接入表里查不到的 slug 一律**退回 AGI1**（`flashSaveProtocolOf`），这是为了不让新方言
> 悄悄改掉老游戏的历史行为。白名单同时会挡住会话签发，所以表外游戏拿不到桥。

---

## 2. 一次完整回合

```
① 页面（React）
   prepareFlashOnlineSave(slug)
     ├─ 查接入表：没接在线存档 → 直接返回 null，下面全部不发生
     ├─ 未登录 / 没配 API → 游客模式（桥照常加载，令牌为空串）
     └─ 已登录 → POST /api/flash-saves/v1/session 换短期令牌
② 页面 → Ruffle
   parameters: { eightbitgo_save_endpoint, eightbitgo_save_token,
                 eightbitgo_username, eightbitgo_avatar_url,
                 eightbitgo_save_mode, eightbitgo_login_callback,
                 eightbitgo_game_slug, eightbitgo_save_protocol,
                 eightbitgo_agi_game_key }
   urlRewriteRules: agi.armorgames.com/assets/agi/<这一代>.swf → 本站桥
③a 游客在游戏内主动点在线存档 / 登录
   桥 → ExternalInterface → 页面打开站内登录弹窗
③ 游戏 → 桥
   游戏从 Loader.content 拿到桥实例，调它那一代的方法
④ 桥 → 服务端
   POST <endpoint>/read | /write-slot | /delete-slot（body 里带 sessionToken）
⑤ 回程
   桥把服务端响应**原样**（只做必要的兜底）交给游戏的回调
```

桥只读 `stage.root.loaderInfo.parameters`（取不到才退回自己的 `loaderInfo`）——
桥是子 `Loader`，FlashVars 挂在最外层游戏身上。

---

## 3. 公共约定（两代都适用）

### 3.1 会话

```http
POST /api/flash-saves/v1/session
Authorization: Bearer <8BitGo 登录令牌>   ← 完整 JWT，绝不进 SWF
Content-Type: application/json

{ "gameSlug": "infectonator-2" }
```

```json
{ "success": true, "data": {
  "sessionToken": "eyJ...",
  "expiresAt": 1789545600000,
  "endpoint": "/api/flash-saves/v1/infectonator-2",
  "protocol": "agi1",
  "bridgeUrl": "/flash-api/armor-games/AGI.swf",
  "username": "玩家昵称",
  "avatar_url": "/ui/logo-mark.png"
} }
```

- `sessionToken` 用独立的 `FLASH_SAVE_SECRET` 签名，声明固定为
  `{iss:"8bitgo", aud:"8bitgo-flash-save", sub, game, scope:["save:read","save:write"], tv, iat, exp}`。
  服务端**每次请求**都复核：签名、`aud`、过期、路径里的 slug、用户是否存在、账号状态、
  `token_version`，以及**该游戏是否还在白名单里**。
- `username` 取 `users.nickname || 'Player'`；`avatar_url` 固定是站内 PNG ——
  `users.avatar` 存的是 emoji，Flash 的 `Loader` 拿它当图片会失败。
- `protocol` 只是给排查看的；桥地址是按方言定好的。
- **限流**：会话申请 **600 次/小时/账号**；数据接口 **600 次/分钟/账号**（超了 `rate_limited`）。
  会话在页面侧按「游戏 + 当前登录令牌」在内存里复用（离到期 < 5 分钟才重新申请），
  所以正常游玩打不满。

### 3.2 FlashVars

| 键 | 出处 | 说明 |
| --- | --- | --- |
| `eightbitgo_save_endpoint` | `data.endpoint` | 已转成**绝对地址**（拼在 `apiBase()` 上）。旧 SWF 的 `URLLoader` 会把根相对地址按 ROM 源站解析，可能打到 `assets.8bitgo.com/api` |
| `eightbitgo_save_token` | `data.sessionToken` | 游客模式是**空串**，桥据此把登录态判为 false |
| `eightbitgo_username` | `data.username` | |
| `eightbitgo_avatar_url` | `data.avatar_url` | 也已转绝对地址 |
| `eightbitgo_save_mode` | 页面 | `authenticated` / `guest` / `unavailable`。最后一种是已登录但会话申请失败，不能误弹登录 |
| `eightbitgo_login_callback` | 页面 | 桥向同源 Ruffle iframe 上报登录意图的 `ExternalInterface` 函数名 |
| `eightbitgo_game_slug` | 共用接入表 | 给自建 Flash 游戏和排查日志用；权限仍以短期令牌里的 `game` 为准 |
| `eightbitgo_save_protocol` | 共用接入表 | `agi1` / `agi2`，仅供桥与新游戏自检 |
| `eightbitgo_agi_game_key` | 共用接入表 | AGI1 `init` 应当接受的 gameKey；AGI2 为空 |

两个桥的登录判据都是 `endpoint && token` 都非空；AGI1 还要求游戏传入的
`gameKey == eightbitgo_agi_game_key`。老页面没下发新参数时保留 `infect-2` 作兼容回退。

`allowScriptAccess` **只对接入表里的游戏开放**；桥只在 `save_mode == guest`
且玩家主动使用在线槽时回调。AGI2 开局自动 `retrieve` 不弹窗，
否则玩家每次进游戏都会先被登录框挡住。

### 3.3 桥 → 服务端的请求纪律（检查桥改动时照这条对照）

1. **一律 POST + `application/json`**，令牌放 body（不进 URL，避免落进访问日志 / Referer / 缓存键）。
2. **超时 12 秒**，超时就把 `loader.close()` 并回调 `timeout`。
3. **失败回调里也要解析 `loader.data`**：HTTP 4xx/5xx 在 Ruffle 里走 `ioErrorEvent`，
   响应体仍躺在 `loader.data` 上。不解析就会把 `invalid_session` 一律报成 `network_error`，
   而这两者玩家要做的事完全不同。
4. **收到 `invalid_session` 立刻摘掉登录态**：游戏据此把在线槽标成不可用。
   在「游戏普遍忽略回调里的错误」这个前提下，这是唯一能让玩家看见的反馈。
5. **写失败重试一次**（800ms；`network_error` / `timeout` / `bad_response` / `request_failed`
   才重试，会话失效、参数错、超限重试多少次都一样）。
6. **响应必须是 `success !== undefined` 的 JSON**，否则桥判为 `bad_response`。
7. 回调只执行一次（`callOnce`），且游戏回调抛异常不能卡住后续任务。

### 3.4 错误格式与错误码

```json
{ "success": false, "error": { "code": "invalid_session", "message": "在线存档会话已失效" } }
```

| HTTP | code | 含义 | 桥会重试吗 |
| --- | --- | --- | --- |
| 400 | `invalid_request` | 字段 / slot / key / JSON 结构不合法 | 否 |
| 401 | `invalid_session` | 令牌无效或过期 | 否（并摘登录态） |
| 403 | `game_mismatch` | 令牌不能访问路径里的游戏 | 否 |
| 404 | `game_not_enabled` | 该游戏未启用（白名单里没有） | 否 |
| 409 | `quota_exceeded` | 账号总配额不足 | 否 |
| 409 | `stale_write` | 条件更新失败：这份写入基于旧版本 | 否（并丢弃本地版本） |
| 413 | `save_too_large` | 单个存档超限 | 否 |
| 429 | `rate_limited` | 请求过于频繁 | 否 |
| 503 | `not_configured` | 服务端没配 `FLASH_SAVE_SECRET` | 否 |
| — | `network_error` | 连接失败 / 拿不到可解析的响应（**桥自己产生**） | 是 |
| — | `timeout` | 12 秒没回来（**桥自己产生**） | 是 |
| — | `bad_response` | 响应不是我们那套 JSON（**桥自己产生**） | 是 |
| — | `request_failed` | `URLRequest` 直接抛（**桥自己产生**） | 是 |

所有响应都带 `Cache-Control: no-store`。

### 3.5 限额（服务端校验，`server/src/flash-save-contract.js`）

| 项 | 默认 | env |
| --- | --- | --- |
| 单个数据半份（AGI1 的 profile 或 data） | 1 MiB | `FLASH_SAVE_PART_MAX_BYTES` |
| 单个槽（AGI1 一整对 / AGI2 一个 value） | 2 MiB | `FLASH_SAVE_SLOT_MAX_BYTES` |
| 账号总量（**两表之和**） | 32 MiB | `FLASH_SAVE_TOTAL_MAX_BYTES` |
| JSON 嵌套深度 | ≤ 32 | — |
| 危险键 | 拒绝 `__proto__` / `prototype` / `constructor` | — |
| 槽数量 | 3（AGI1 `online0..2` / AGI2 `slot1..3`） | — |

三个上限是**包含关系**（半份 ≤ 整槽 ≤ 总量），配置非数字时会夹到最近边界并 `console.warn`，
不会退化成 NaN——NaN 参与的比较全是 false，等于把限额整个关掉。

配额比较允许「覆盖成更小或等大」，否则玩家顶到上限后连删档以外的任何操作都做不了。

### 3.6 写入并发（`opId` / `expectedRevision` / `revisions`）

两个字段**都是可选的**，服务端不做硬性要求——「旧桥照样能写」和「迟到写入不许覆盖」
在协议上不能同时成立，取前者。

| 字段 | 作用 |
| --- | --- |
| 响应顶层 `revisions` | `{"0": 4}`（AGI1 槽号）/ `{"slot1": 2}`（AGI2）。**给桥用的**，游戏侧不看。空槽不出现 |
| 请求 `expectedRevision` | 条件更新：服务端当前代次 ≠ 它就 `409 stale_write`，不落库 |
| 请求 `opId` | 幂等重放：与 `last_op_id` 相同即认为「这份已经写过了」，回当前版本、不再写。**重试必须复用同一个 ID** |

代次记在 `flash_save_seqs`（账号 + 游戏 + 键一行），**不在存档行上**：
删档会删行，版本号跟着消失的话「删档 → 再存」之后又能用旧版本通过条件更新（ABA）。
**删除也推进代次**，所以删档成功后要把它回的新版本记下来。

---

## 4. AGI1（方法式）

游戏玩法：先交 `profileonlineN`、紧接着交 `dataonlineN`，桥把两半配成一对提交。

### 4.1 游戏侧契约

方法挂在桥实例上（`Loader.content` 直接可见）。**方法名、参数顺序、同步/异步性质都不能改。**

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

| 方法 | 行为 | 回调 |
| --- | --- | --- |
| `init(devKey, gameKey)` | 读 FlashVars；`gameKey` 要和接入表下发的 `agiGameKey` 一致 | — |
| `isLoggedIn()` | **同步**返回布尔 | — |
| `getUserData()` | `{ username, avatar_url }` | — |
| `getUserName()` | 昵称字符串 | — |
| `showLogin(cb)` | 已登录直接回调；游客同时通知页面打开站内登录弹窗 | `{success:true, loggedIn, username, avatar_url}`。**未登录时也是这个形状**，只是 `loggedIn:false` 且两个字符串为空 |
| `submitUserData(key, data, cb)` | 缓存这一半，两半齐了才发请求 | 见 4.2 |
| `retrieveUserData(cb, key?)` | 全量或单键读 | 服务端响应原样（`{success, data, revisions}`） |
| `deleteUserData(key)` | **没有回调**，静默 | — |
| `initAGUI(options)` | 只记下 `options.onClose` | — |
| `showScoreboardSubmit(...)` | 立即调 `onClose`（**不调它，游戏的「提交」按钮会永久隐藏**） | — |
| `showScoreboardList(...)` | 空实现 | — |

⚠️ **`retrieveUserData` 的参数顺序是 `(callback, key)`**，不是常见的 `(key, callback)`。
这是原游戏真实的调用方式，写反了会静默拿不到数据。

键只接受 `^(profile|data)online([0-2])$`（`parseKey`），其它键回调 `invalid_key`。

### 4.2 桥内部语义（改桥时别破坏这些）

**配对（每槽一个 `pendingPairs`）**

| 情形 | 结果 |
| --- | --- |
| 两半在 1.5 秒内到齐 | 移入写入队列，两半的回调各回调一次 |
| 1.5 秒没凑齐 | `pair_incomplete`，清掉该槽暂存（否则下次保存会把旧的一半拼进来） |
| 同一半**重复到达** | 旧的一半丢弃 + `resync`：**下一个到达的 data 半也丢掉**（`ambiguous_pair`） |

最后的 `resync` 是刻意的：`P1, P2, D1` 这种序列按「先到先配」会拼出 **P2 + D1** ——
一份表面正常、实际错位的档。游戏每次送的都是全量状态，宁可丢一次保存
（云端晚一个保存点），也不要坏档。`P1, P2, D1, D2` 正好配出 `P2 + D2`，一次都不丢。

**写入队列**：每槽一条 FIFO（`queues[slot]` + `busy[slot]`），保证「后点的保存」在
「先点的保存」之后落库，不会让慢的旧请求把进度写回去。任务里的两半共用一个 `opId`。

**删除合并**：`deleteQueued[slot]` 标记「这个槽已经排了删除」，游戏连发的两次
`deleteUserData`（profile + data）只发一次请求。⚠️ **不要改回时间窗去重**：
时间窗会把「删档 → 重新存 → 再删」里的第二次删除一起吞掉，玩家删完看到槽空了、其实档还在。
写入入队时会清掉这个标记（`enqueue` 里 `deleteQueued[slot] = false`），删除任务结束也清。

**读之前等在飞的写**（`waitForWrites`）：轮询（60ms）到 `writesInFlight` 归零再发读请求，
**上限 3 秒**。玩家刚过关触发保存、紧接着打开存档页时，不等就会读到写之前那一份，
看起来像「刚存的档没生效」。超过 3 秒放行：宁可给一份可能略旧的档，
也不能把游戏卡在读档界面（那个界面上的「等待」和「坏了」长得一模一样）。

**写入重试**：失败（仅可重试错误码）等 800ms 重试一次，重试期间该槽 `busy` 不清，
不会和下一次保存交叉；`writesInFlight` 只在第一次尝试时加、结束时还一次，
所以读继续等它。

**版本对齐**：读档响应里的顶层 `revisions` 会并进本地表（`mergeRevisions`），
写入带 `expectedRevision`，成功后回写新版本；`stale_write` 时**丢掉**本地版本，
下一次保存退化成无保护写入（不为它多跑一趟读档 —— 那会再加一个往返，
而游戏忽略错误，玩家只会觉得更卡）。

### 4.3 服务端接口（AGI1）

```http
POST /api/flash-saves/v1/infectonator-2/read
{ "sessionToken": "eyJ...", "key": "dataonline0" }        // key 可省 = 全量
```

```json
// 全量：只有 profile 和 data 都存在的槽才会出现
{ "success": true,
  "data": { "profileonline0": {...}, "dataonline0": {...},
            "PremiumEnabled": 0, "PremiumEnabled_Price": 0 },
  "revisions": { "0": 4, "2": 1 } }

// 单键命中 → data 是那一半；槽不存在/不完整 → { "success": true, "data": null }
```

`PremiumEnabled` / `PremiumEnabled_Price` 由服务端权益系统生成，**永远不从玩家存档读**，
也不能通过写档接口修改；未接权益系统时固定 `0`。

```http
POST /api/flash-saves/v1/infectonator-2/write-slot
{ "sessionToken": "eyJ...", "slot": 0, "profile": {...}, "data": {...},
  "expectedRevision": 4, "opId": "s1a2b3c4d5e6-7" }      // 后两个可选
```

```json
{ "success": true, "data": { "slot": 0, "revision": 5, "updatedAt": 1789516800000 } }
```

校验（不满足任一 → `invalid_request`）：

- `slot` 只能是 `0` / `1` / `2`（且必须是数字，不接受 `null`/`""`）。
- `profile`、`data` 都必须是普通 JSON 对象（非数组、非 null）。
- `profile.index` 与 `data.index` 必须**都**等于 `online<slot>`，且 `Number(profile.saved) === 1`。
- 半份 ≤ 1MiB、两半之和 ≤ 2MiB、账号总量 ≤ 32MiB。

```http
POST /api/flash-saves/v1/infectonator-2/delete-slot
{ "sessionToken": "eyJ...", "slot": 0 }
```

```json
{ "success": true, "data": { "revision": 7 } }
```

删除**幂等**（槽不存在也成功），但**推进代次**并返回删后版本 —— 客户端要记下来，
否则删档后的第一次保存会带着删除前的版本撞条件更新、白丢一次。

### 4.4 排查线索（AGI1）

| 现象 | 先看 |
| --- | --- |
| 在线槽一直是灰的 | 控制台有没有 `[8bitgo-flash-save] gameKey 不匹配（收到 xxx）`；再看 FlashVars 里 token/endpoint 是不是空 |
| 存档像没生效 | 桥在控制台 trace「保存基于旧版本，已丢弃」= 撞了 `stale_write`；查是不是多标签页在写同一槽 |
| 刚存的档读不到 | 看是不是走了 `waitForWrites` 的 3 秒上限（后台标签页被节流时可能发生） |
| 提交按钮消失 | `initAGUI` 的 `onClose` 没被调到 |

---

## 5. AGI2（对象式）

### 5.1 游戏侧契约

`connect()` 之后，游戏从 `Loader.content` 上**直接读四个公开属性**：

```as3
// 文档类 KrfAgiBridge（顶层类，extends Sprite）
connect(options:Object = null):void          // 读 FlashVars；options.callback 收 {success:true}

user.isGuest():Boolean
user.getUsername():String
user.getAvatarURL():String
user.getUID():String                         // 未登录返回 "guest"
user.showLogin(options:Object):void           // 游客打开站内登录框

storage.user.retrieve(options:Object):void   // { key?, callback } → callback({success, keys})
storage.user.submit(options:Object):void     // { key, value, callback }
storage.user.erase(options:Object):void      // { key, callback }

content.retrievePurchases(options)           // → {success:true, purchases:[]}
content.retrieveProducts(options)            // → {success:true, products:[]}
content.showStore(options)                   // → {success:false, error:{code:'store_unavailable'}}
content.RESPONSE_USER_CANCELLED              // "cancelled"
content.RESPONSE_PURCHASE_FAILED             // "failed"
content.RESPONSE_PURCHASE_SUCCESS            // "success"

quests.submit(options)                       // { progress?, callback } → {success:true, quest:{progress, status:'completed'}}
```

三条**必须保持的形状**（游戏直接依赖，改一处就是 undefined）：

1. `user` / `storage` / `content` / `quests` 是**公开属性**，不是方法。
2. 所有参数走一个 `options` 对象，**回调是 `options.callback`**（不是第二个参数）。
3. `storage.user.retrieve` 的回调是 `{success, keys}`，**没有槽时也必须是 `keys:{}`**
   （不是 `null`：游戏会直接 `for-in`）。桥自己还兜了一层：
   即使服务端漏了 `keys`，也会补成 `{}`。

**`options.key` 被刻意忽略**：`retrieveFn` 永远取全量。服务端支持单键读，
但游戏是整份拿的，不在这里改语义。

回调三种形状：

```as3
// 成功
{ success: true }
// 失败（注意 error 是对象，不是字符串 —— 和 AGI1 不一样）
{ success: false, error: { code: "network_error" } }
// 未登录
{ success: false, error: { code: "not_logged_in" } }
```

### 5.2 桥内部语义

- **全局一条串行队列**（`queue` + `busy`），不是每槽一条：AGI2 一次提交就是一份完整档，
  串行化保证「后点的保存」在「先点的保存」之后落库。
- 写入失败等 800ms **重试一次**（同一套可重试错误码），重试期间 `busy` 不清。
- 会话失效（`invalid_session`）摘登录态，同 AGI1。
- 每次逻辑写入生成 `opId`，超时重试复用它；读响应合并 `revisions`，
  后续写带 `expectedRevision`。迟到的旧请求因此不会覆盖新档。
- 读前等全局变更队列清空（上限 3 秒），避免「刚存完立刻读」拿到旧档。

### 5.3 服务端接口（AGI2）

```http
POST /api/flash-saves/v1/kingdom-rush-frontiers/read
{ "sessionToken": "eyJ..." }
```

```json
{ "success": true,
  "keys": { "slot1": { "…整份进度…": 1 }, "slot3": { } },
  "revisions": { "slot1": 2 } }
```

带 `key` 时同样回 `keys` 形状（只含那一个）；槽不存在是 `{success:true, keys:{}}`。

> ⚠️ **只输出 `slot1` ~ `slot3`。** 真 Armor 服务当年会在 `keys` 里塞
> `kingdomRushPremiumContentEnabled`，KRF 见到它等于 2 就解锁付费内容。
> 白名单过滤在 `agi2SaveMap()`（`server/src/flash-save-contract.js`），**不要改成原样透传**。

```http
POST /api/flash-saves/v1/kingdom-rush-frontiers/write-slot
{ "sessionToken": "eyJ...", "key": "slot1", "value": { …整份进度… } }
```

```json
{ "success": true, "data": { "key": "slot1", "revision": 4, "updatedAt": 1789516800000 } }
```

校验：`key` 只能是 `slot1`/`slot2`/`slot3`；`value` 必须是普通 JSON 对象（非数组、非 null）；
深度 ≤ 32；拒绝危险键；单个 value ≤ 2MiB。

```http
POST /api/flash-saves/v1/kingdom-rush-frontiers/delete-slot
{ "sessionToken": "eyJ...", "key": "slot1" }
```

```json
{ "success": true, "data": { "revision": 5 } }
```

### 5.4 排查线索（AGI2）

| 现象 | 先看 |
| --- | --- |
| 控制台 `[8bitgo-flash-save] 未登录：在线槽不可用（endpoint 有/无，token 有/无）` | 这行是**正常**状态下的线索；两者任一为「无」就说明会话没下来 |
| 游戏里读档拿到 `keys == null` | 桥的兜底应该已经补成 `{}`；出现 null 说明有人把兜底删了 |
| 出现付费内容 | `keys` 里混进了 `kingdomRushPremiumContentEnabled` 一类的键 —— 检查 `agi2SaveMap` |
| 桥加载了但游戏取不到实例 | 文档类名被改了（必须是 `KrfAgiBridge`），多半是拿 Ruffle 空壳当模板编的 |

---

## 6. 两代差异：最容易被"顺手统一"改坏的地方

| 别动 | 为什么 |
| --- | --- |
| `error` 的形状（AGI1 字符串 / AGI2 对象） | 游戏是按自己那一代的形状读的；统一成一种会让另一代的错误显示成 undefined |
| 读返回（AGI1 `data` / AGI2 `keys`） | 同上，形状是游戏定的 |
| 空结果的表示（AGI1 单键 `data:null`；AGI2 `keys:{}`） | AGI2 的 `{}` 是为了让游戏能直接 `for-in` |
| 队列粒度 | AGI1 需要按槽排序（两半各自到达），AGI2 是整份提交 |
| 文档类名与模板配套 | AGI2 不能换 Ruffle 空壳；AGI1 必须叫 `test_fla.MainTimeline` |
| 接入表只有一份 | 前端/后端各写一份的后果是「桥能加载、能连上，就是读不到档」，且不报错 |

---

## 7. 给一款新游戏接入

### 7.1 新开发的 Flash 游戏（推荐）

新游戏不用仿写 Armor Games API。加载 `AGI2.swf`、调一次 `connect()`，然后用
`Loader.content.eightbitgo` 这个简化命名空间：

```as3
var api:Object = loader.content;
api.connect({ callback: function(result:Object):void {
  var save:Object = api.eightbitgo;

  // 用户主动点「在线存档」时先查；未登录会打开 8BitGo 登录框。
  if (!save.isLoggedIn()) {
    save.showLogin(function(status:Object):void {});
    return;
  }

  save.write("slot1", { level: 12, coins: 300 }, function(result:Object):void {});
  save.read("slot1", function(result:Object):void {
    if (result.success && result.value != null) trace(result.value.level);
  });
  // save.remove("slot1", callback);
}});
```

简化接口固定为：

```as3
eightbitgo.isLoggedIn():Boolean
eightbitgo.getUser():Object
eightbitgo.showLogin(callback:Function = null):void
eightbitgo.read(key:String, callback:Function):void
eightbitgo.write(key:String, value:Object, callback:Function):void
eightbitgo.remove(key:String, callback:Function):void
```

`key` 只能是 `slot1` / `slot2` / `slot3`，`value` 必须是可 JSON 序列化的对象，单槽最大 2MiB。
完整站点 JWT 永远不会进入 SWF：页面只下发限定到当前游戏的短期存档令牌。

### 7.2 现有 Armor Games 游戏

1. **判断是第几代**：看游戏加载的是 `AGI.swf` 还是 `AGI2.swf`，
   以及它调的是方法式还是对象式接口。拿不准就看游戏 SWF 的反编译结果（对照第 4、5 节的方法名）。
2. **加进接入表**：`shared/flash-save-games.js` 的 `FLASH_SAVE_GAMES`
   （AGI2：`slug → { protocol, bridge }`；AGI1 再加 `agiGameKey`）。这是**唯一一处**，前后端都读它；
   服务端的 env 白名单 `FLASH_SAVE_GAMES` 默认值就是这张表的全量，不用手写。
3. **核对键与形状**：AGI1 的键是不是 `profileonlineN` / `dataonlineN`？
   AGI2 的键是不是 `slot1..3`？游戏有没有读 `PremiumEnabled` 一类的权益键
   （那必须由服务端生成，不能从玩家存档读）。
4. **AGI1 的 gameKey**：把游戏真实传给 `init` 的值写到该条目的 `agiGameKey`。
   页面会通过 `eightbitgo_agi_game_key` 下发；**不要删掉校验**，它挡的是
   「别的 Armor Games SWF 被半兼容实现接管」。
5. **有源码/产物改动就重建**：`npm run flashbridge`，然后**把产物和 manifest 一起提交**
   （`AGI*.swf` + `runtime*.json`，随 Git 部署，线上不编译 Flash）。
6. **跑回归**：`npm run test:flash-online-save`（见下）。它会核对源码 → 产物的哈希，
   改了源码没重建会直接红。

---

## 8. 回归命令

```bash
# 桥产物校验 + 接入表一致性 + 服务端契约
npm run test:flash-online-save

# 路由级：会话 / 读 / 写 / 删 / 条件更新 / 幂等重放 / ABA
npm --prefix server run test:flash-routes
npm --prefix server run test:flash-saves

# 改了桥源码之后
npm run flashbridge
```

`scripts/test-flash-save-consistency.mjs` 钉死四处一致：
注册表里的方言都受支持且每款都带站内桥地址；**桥文件名与方言配套**；
服务端契约读出的值与注册表一致（表外 slug 退回 agi1）；前端没有再自己维护一份桥表。

---

## 9. 已知限制

- **会话到期只能重进一局**：FlashVars 只读一次，SWF 换不掉令牌。
  播放器会在到期前 10 分钟提示一次（`player.flashSaveExpiringSoon`），
  但根治需要 `ExternalInterface` 一类的续期通道。
- **读档等写的 3 秒上限**：两代在极端情况下（后台标签页被节流）仍可能读到旧档。
- **桥的修复要等边缘缓存过期**（约 1 小时）才全球生效：产物地址固定、不带内容哈希。
- **游戏忽略回调里的错误**：AGI1 的 `submitUserData`、AGI2 的 `submit` 都可能在玩家毫无察觉时
  失败。桥的重试、`invalid_session` 摘登录态、控制台 trace 都是为这一点加的 ——
  改桥时别把它们当成冗余代码删掉。
