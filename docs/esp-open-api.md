# 8BitGo 开放平台 · 嵌入式（ESP）接入速查

> 面向**设备端**（ESP32 / ESP8266 之类）的接口速查。
> 协议设计与取舍见 `docs/open-platform.md`；这一份只回答一件事：
> **固件里要发什么请求、会收到什么、出错了怎么认。**
>
> 每条数字和字段都标了源码出处。和设计稿冲突的地方**以源码为准**，
> 并在正文里显式标出来（见 §7 的限流一节）。
>
> 核对基线：`server/src/routes/open.js` + `server/src/open/*`，2026-09-13。

---

## 0. 先说清楚：哪些今天能用

| 你要做的 | 状态 | 说明 |
|---|---|---|
| 拉游戏列表 / 详情 | ✅ **可用，且不需要 AppID** | 2026-09-13 起整个目录公开匿名可读，连令牌都不用取。固件里可以直接 GET |
| 下载 ROM 到设备 | ✅ **可用** | `games.rom`，但这个 scope **要人工审核**才批；另见下面的 ⚠️ |
| 云存档**读取** | ✅ **可用**（2026-09-12 加的） | `saves.read`，用户级 scope。要先走**设备码流程**拿一枚用户级令牌，见 §6.5 |
| 收藏 / 最近在玩 | ✅ **可用**（2026-09-12 加的） | `library.read`，同上 |
| 云存档**写入** | ❌ 还没有 | `saves.write` 在 `scopes.js` 里标着 sensitive，这一轮只做了只读。写入要连着配额、覆盖保护、删除审计一起想清楚 |
| 上报在玩 / 心跳 | ❌ **不存在** | 开放平台没有这个端点。站内有 `POST /api/games/:slug/play`，但那是站内接口，不认开放平台令牌 |

写入和心跳要怎么办，见 §10。

> 📌 **2026-09-12 之前，云存档那两行是 ❌。** 当时的状况是：`scopes.js` 里声明了
> `library.read` / `saves.read`，而 `routes/open.js` 里**连路由都没有**；
> 更要命的是就算有也没人调得到 —— 用户级令牌的签发函数 `issueUserToken`
> 当时**一个调用方都没有**。现在两边都补上了：路由在 §7，取令牌的路在 §6.5。

⚠️ ROM 那条还有一个必须知道的前提：`assets.8bitgo.com` 目前是**公开可读**的。
签名凭据这一层现在只是「我们不主动给地址」，**不是访问控制** ——
任何人打开一次游戏、从浏览器网络面板抄走 ROM 地址就能无限下载。
源码里对此有明确注释（`server/src/open/sign.js` 文件头、`open.js` 的 `/v1/games/:slug/rom`）。
这不影响你的固件怎么写，但影响你怎么对外描述这个功能。

---

## 0.5 端点清单（全量速查）

所有路由都挂在 Base URL `https://8bitgo.com/api/open/v1` 下。「需要 scope」一栏为「无 / —」表示只要令牌有效即可（不卡具体 scope）。

「鉴权」一栏三种取值：

- **公开** —— 不带 `Authorization` 头就能调。**带了就必须是有效的**，见下面那条 ⚠️。
- **要令牌** —— 任何有效的开放平台令牌都行，不卡具体 scope。
- **`<scope>`** —— 要一枚带这个 scope 的令牌。

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| `POST` | `/v1/token` | — | 换应用级 / 用户级令牌（`client_credentials` 或 `device_code`） |
| `POST` | `/v1/device/code` | — | 设备码流程：拿 `user_code` / `device_code` |
| `GET` | `/v1/health` | **公开** | 健康检查：服务存活 + 数据库连通（规格见 `/.well-known/openapi.json`） |

另外两条**不在** `/v1` 下（它们按惯例挂在站点根）：

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| `GET` | `/.well-known/oauth-authorization-server` | **公开** | RFC 8414 元数据：端点地址、支持的 grant type 和 scope。现成的 OAuth 库会自己读 |
| `GET` | `/.well-known/jwks.json` | **公开** | access token 的验签公钥。设备端**用不上**（你不需要验我们签的令牌，直接带上就行）；这是给要自己验签的服务端接入方的 |

> ⚠️ **没有 `/.well-known/openid-configuration`，这是故意的。** 这套是 OAuth 2.0 不是 OIDC：
> 只签 `access_token`，没有 `id_token` / `userinfo` / `refresh_token` / revoke。
> 给出一份 OIDC 发现文档会让你的库去要那些不存在的东西，然后在一个和真正原因无关的地方失败。
> RFC 8414 那份里有 `x-not-supported` 明说缺哪四样。
| `GET` | `/v1/games` | **公开** | 游戏列表（分页 / 筛选） |
| `GET` | `/v1/games/:slug` | **公开** | 游戏详情 |
| `GET` | `/v1/platforms` | **公开** | 平台目录：`runtime` / `core` / `romExtensions` / `native` 建议 / `enabled`，本地客户端挑模拟器用（见 §12） |
| `GET` | `/v1/genres` | **公开** | 游戏类型枚举（客户端画筛选器用） |
| `GET` | `/v1/languages` | **公开** | 游戏语言枚举（客户端画筛选器用） |
| `GET` | `/v1/live/rooms` | **公开** | 在播直播房间列表（`?game=<slug>` 可筛某一款） |
| `GET` | `/v1/live/rooms/:roomId` | **公开** | 单个直播房间快照（已脱敏，无 IP / token） |
| `GET` | `/v1/collections` | **公开** | 公开合集列表（分页） |
| `GET` | `/v1/collections/:id` | **公开** | 单个合集 + 里面的游戏（游戏走白名单映射） |
| `GET` | `/v1/games/:slug/rom` | `games.rom` | 换 ROM 短期下载凭据（两步式第一步） |
| `GET` | `/v1/rom/:grant` | — | 兑现 ROM 凭据（两步式第二步，302 不带 `Authorization`） |
| `GET` | `/v1/games/:slug/embed` | `games.read` | 换带签名、会过期的嵌入播放器地址 |
| `GET` | `/v1/me` | 要令牌 | 自查令牌的 `client_id` / `scope` / `expires_at` |
| `GET` | `/v1/library` | `library.read` | 用户收藏 / 最近在玩（用户级令牌） |
| `GET` | `/v1/saves` | `saves.read` | 用户存档清单（用户级令牌） |
| `GET` | `/v1/saves/:runtime/:slug` | `saves.read` | 取一份存档（用户级令牌） |

> ### ⚠️ 「公开」的准确含义：可以不带令牌，但不能带错的
>
> **不带 `Authorization` 头 = 匿名，正常返回。
> 带了这个头但令牌无效 / 已过期 = `401 invalid_token`，不会降级成匿名。**
>
> 这一条是专门写给固件作者的，因为反过来的设计会坑死人：坏令牌要是被当成匿名放行，
> 你的设备在令牌过期之后**列表照常刷新**，一切看起来正常，直到某天用户点下载 ——
> 那时报的错指向 ROM 权限，而真正的原因是两小时前令牌就过期了。
>
> 所以固件里的写法是：**要么完全不带这个头，要么保证带的是新鲜的令牌。**
> 别在取令牌失败的时候把旧的那枚接着用。
>
> 另外，`games.read` 这个 scope 现在只剩 `/v1/games/:slug/embed` 在用。
> 光要拉列表的应用**不需要申请任何 scope，也不需要创建应用**。

> 全部路由的响应错误体一致（见 §8）；`/v1/rom/:grant` 和上面标「公开」的那些
> 都可以不带 `Authorization` 调。
>
> 🤖 **机器可读规格**：完整的 OpenAPI 3.1 挂在 `/.well-known/openapi.json`（公开、匿名、CORS 放开），agents / 代码生成器可直接消费，对应源文件 `server/openapi.json`。

## 1. 前提与环境

| 项 | 值 |
|---|---|
| Base URL | `https://8bitgo.com/api/open/v1` |
| 拿 AppID / key | 站点页脚 → **`/open`** 开发者控制台（⚠️ 不是 `/developers`，那是站内的「开发商」浏览页） |
| 客户端类型 | 必须选 **`confidential`**（有 key）。`public` 客户端**不能**用 `client_credentials`，会被 400 `unauthorized_client` 挡掉 |
| AppID 形状 | `app_` + 24 位十六进制 |
| key | 32 字节随机、Base64URL，**只在创建/轮换时显示一次** |
| CORS | `/api/open/*` 放开到任意 Origin，且**不带 cookie**。设备端用不上，但说明这套接口不依赖任何浏览器状态 |

**服务端没配密钥的话会怎样**（2026-09-13 起分成两半）：

| | 没配 `OPEN_JWT_PRIVATE_KEY` 时 |
|---|---|
| 公开目录（`/v1/games*`、`/v1/platforms`、`/v1/genres`、`/v1/languages`、`/v1/live/rooms*`、`/v1/collections*`、`/v1/health`） | **照常可用**。它们只查数据库，一把密钥都用不上 |
| `/v1/token`、`/v1/device/code`、`/v1/me`、`/v1/library`、`/v1/saves*` | `501 temporarily_unavailable` |
| `/v1/games/:slug/rom`、`/v1/rom/:grant` | `501`（另外没配 `OPEN_ROM_SECRET` 时也单独 501） |
| `/v1/games/:slug/embed` | `501`（另外要 `OPEN_EMBED_SECRET`） |

> 📌 **以前是「没配密钥就整套 501」。** 那会让「游戏列表公开」依赖一个和它完全无关的
> 环境变量 —— 目录根本不签也不验任何东西。2026-09-13 拆开了。

接线之前先各探一条：

```bash
# 公开目录：不带任何令牌，应该直接回 200 + 一页游戏
curl -i 'https://8bitgo.com/api/open/v1/games?page_size=1'

# 要令牌的那半：501 就是部署上还没配密钥，不是你的请求写错了
curl -i -X POST https://8bitgo.com/api/open/v1/token \
  -H 'Content-Type: application/json' \
  -d '{"grant_type":"client_credentials","client_id":"app_...","client_secret":"..."}'
```

### ⚠️ 把 client_secret 烧进固件这件事

`client_credentials` 的整个安全模型建立在「secret 只在服务端」上。
烧进 ESP 之后，**拿到一块板子 = 拿到你的 key**（Flash 可以直接 dump，
除非开了 Flash 加密 + Secure Boot，而那会改变你的量产流程）。

现实一点的三条路，按代价排：

1. **自己架一层中转**：ESP 只认自己的服务端，secret 留在服务端。
   多一跳，但也顺带解决了限流、ROM 缓存、和「换 key 不用重刷固件」。
2. **一台设备一把 key**：一把泄露只废一把。但开放平台**每个账号最多 10 个应用**，
   量产这条走不通。
3. **接受风险 + 可吊销**：key 烧进去，出事了在 `/open` 控制台撤销那把密钥。
   支持同时有两把有效密钥（轮换期），所以换 key 不会让所有设备同时挂 ——
   但仍然要能给设备推新 key，否则撤销就等于砖化。

自用几台，第 3 条够了；要卖出去，走第 1 条。

---

## 2. 取令牌 `POST /v1/token`

### 两种写法都收

| Content-Type | 说明 |
|---|---|
| `application/x-www-form-urlencoded` | **RFC 6749 §4.1.3 规定的那种**。现成的 OAuth 客户端库默认发这个 |
| `application/json` | 非标准的扩展写法，设备端手写 HTTP 时更省事 |

两种取到的东西完全一样（scope、`expires_in` 都一致，有测试钉住）。
请求体上限 **16 KB**，超了回 `413 invalid_request`。

> 📌 **2026-09-11 之前这里是坏的**：服务端全局只挂了 `express.json`，
> form-encoded 发过去 `req.body` 是空的 → `grant_type` 读不到 →
> 回一句 `400 unsupported_grant_type`，而那句话完全看不出真正的原因
> （它说「不支持这个 grant_type」，可你明明传了 `client_credentials`）。
> 现成的 OAuth 库一律接不上。已在 `routes/open.js` 的 token 路由上单独补了解析器。
> 如果你对着的是旧版本服务端，**发 JSON**。

### 请求（JSON 写法）

```http
POST /api/open/v1/token HTTP/1.1
Host: 8bitgo.com
Content-Type: application/json

{"grant_type":"client_credentials","client_id":"app_xxxx","client_secret":"yyyy"}
```

### 请求（form 写法）

```http
POST /api/open/v1/token HTTP/1.1
Host: 8bitgo.com
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=app_xxxx&client_secret=yyyy
```

带凭据有两种写法，二选一：

| 写法 | 怎么发 |
|---|---|
| **放 body**（推荐，ESP 上最省事） | `client_id` / `client_secret` 两个字段写在 JSON 里 |
| **HTTP Basic** | `Authorization: Basic base64(client_id + ":" + client_secret)`，body 里只留 `grant_type`。⚠️ 两段按 RFC 6749 §2.3.1 要先做 URL 编码 |

`scope` 字段**可以不传**：不传就给「已获批 ∩ 应用级」的全部。
传了就必须是已获批的子集 —— **不会静默降级**，少一个就整个请求 400，
错误信息里会写明差哪个。

### 响应 `200`

```json
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 900,
  "scope": "games.read games.rom"
}
```

`expires_in` = **900 秒**（`open/tokens.js` 的 `OPEN_ACCESS_TTL_SEC`）。

### 设备端缓存策略

令牌只有 15 分钟，但**取令牌本身是有限流的**（见 §7），所以不能每次请求都去换一次。

```
if (now - tokenIssuedAt > (expires_in - 60) * 1000) refreshToken();
```

- 提前 60 秒续期，别卡着过期边界。
- ⚠️ **不需要 NTP 对时**：`expires_in` 是相对秒数，用 `millis()` 算就够了。
  设备没有 RTC、开机时钟从 0 开始，照样能正确判断过期。
  （只有校验 JWT 里的 `exp` 才需要真实时间，而设备端**不需要**自己校验令牌 ——
  那是服务端的事。）
- 收到 `401 invalid_token` 就立刻续一次再重试一遍，**只重试一次**。

---

## 3. 用令牌 + 自检 `GET /v1/me`

之后所有请求都带：

```http
Authorization: Bearer eyJ...
```

排错第一站，接线时先打这一条：

```json
{
  "client_id": "app_xxxx",
  "kind": "app",
  "scope": "games.read",
  "expires_at": "2026-09-11T12:34:56.000Z"
}
```

`GET /v1/me` **不要求任何 scope**，只要令牌有效就回。
「为什么我调那个接口 403」——先看这里的 `scope` 里有没有那一个。

---

## 4. 游戏列表 `GET /v1/games`

公开可读，不需要令牌。带令牌时仍会校验；无效令牌返回 401。

### 查询参数

| 参数 | 说明 |
|---|---|
| `page` | 从 1 开始，默认 1 |
| `page_size` | 默认 24，**上限 50**（超了按 50 截断，不报错） |
| `platform` | 机型 id，如 `nes` / `gba`；可选值见 `GET /v1/platforms` |
| `requires_windows` | `false` 排除需要 Windows 3.x / 95 / 98 客体的 DOS 游戏；`true` 只看这类游戏。不传则都包含 |
| `genre` | 类型 id，如 `action` / `rpg`；可选值见 `GET /v1/genres` |
| `q` | 关键词。传了 `q` 且没显式指定 `sort` 时按相关度排 |
| `sort` | `popular`（默认）/ `newest` / `name` / `rating` / `home` |
| `lang` | 见 §8。不传默认 **`en`** ⚠️ |

⚠️ `lang` 默认是 `en` 而不是 `zh-Hans`，这是**刻意**的（`open/i18n.js` 的
`OPEN_DEFAULT_LANG`）：开放接口的调用方是第三方，默认给中文会让人以为整库都是中文。
要中文界面就**每次都显式传 `lang=zh-Hans`**。

`platform` 和 `genre` 可以分别传，也可以同时传；同时传时只返回同时属于该机型和类型的游戏。
筛选在分页和计算 `total` 之前完成。例如：

```text
GET /api/open/v1/games?platform=nes
GET /api/open/v1/games?genre=action
GET /api/open/v1/games?platform=nes&genre=action&page_size=10&page=1
GET /api/open/v1/games?platform=dos&requires_windows=false
```

后台「Windows 3.x / 95 / 98（DOSBox-X）」复选框决定这个标记。低性能设备建议在每次拉列表时传
`requires_windows=false`；筛选发生在分页和 `total` 计算之前，避免一页里出现无法运行的游戏。

⚠️ 开放平台**没有**站内那种 facets 聚合端点（`/api/games/facets` 是站内的）。
但平台目录有专门的只读端点 `GET /v1/platforms`（见 §12）：它返回每个平台的
`runtime` / `core` / `romExtensions` 和 `native` 建议，本地客户端挑模拟器就靠它。
类型目录 `GET /v1/genres` 返回可用于 `genre` 的 id。

⚠️ 成人内容（`adult=1`）**整体排除**，下架的游戏对外也不存在。

### 响应

```json
{
  "items": [ /* 见下 */ ],
  "page": 1,
  "page_size": 24,
  "total": 1234,
  "total_pages": 52
}
```

### 单个游戏对象（白名单，`open/mapper.js`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `slug` | string | **对外唯一标识**，所有别的端点都用它。没有数字 id |
| `title` | string | 已按 `lang` 取好的单语言字符串 |
| `description` | string | 同上 |
| `lang_requested` | string | 你要的那门 |
| `lang_actual` | `{title, description}` | 这两段文字**实际**是哪一门。`und` = 原名，没有语言可言 |
| `platform` | string | |
| `requires_windows` | bool | `true` = 这款 DOS 游戏需要 Windows 3.x / 95 / 98 客体与 DOSBox-X；其它游戏为 `false` |
| `genres` | string[] | |
| `tags` | string[] | |
| `year` | number | 0 = 没填 |
| `developer` | string | |
| `players` | number | |
| `multiplayer` | bool | |
| `icon` | string | emoji，没封面时的兜底 |
| `cover` | string \| **null** | 绝对地址。给不出来时是 `null`，**不会给一个必然 404 的 URL** |
| `rating` | number | 一位小数，0 = 还没人评 |
| `rating_count` | number | |
| `plays` | number | |
| `added_at` | `YYYY-MM-DD` \| null | |
| `updated_at` | ISO 8601 \| null | |
| `adult` | bool | 列表里恒为 false（整体已排除） |
| `rom_langs` | string[] | 这款有哪些 ROM 语言可选，`*` = 通用件。**只报语言码，绝不报存储 key**。没有 `games.rom` 权限也看得到 |

**绝不会出现的字段**（`mapper.js` 的 `FORBIDDEN_OUT_KEYS`，有测试逐个断言）：
`id`、`rom` / `roms` / `object_key`、`hidden`、`core`、`dos_*`、`arcade_romdata`、
`coin_reward`、`home_rank`、`video`、以及各种内部多语言列。
**别在固件里依赖这些名字**。

### ESP 侧的三条建议

1. **`page_size` 开小**。默认 24 条带简介的 JSON 轻松上 20–40 KB，
   ESP32 上一次性 `String` 接完很容易碰到堆上限。翻页拉 `page_size=5`，一次几 KB。
2. **流式解析**，别整包读进内存。`ArduinoJson` 可以直接吃 `WiFiClient` 流，
   配 `JsonDocument` 的 filter 只留你要的字段（`slug` / `title` / `cover` / `rom_langs`），
   能把内存占用压掉一个数量级。
3. **只认 `slug`**。这是唯一承诺稳定的标识。

---

## 5. 游戏详情 `GET /v1/games/:slug`

公开可读。参数只有 `lang`。返回体**就是上面那个游戏对象**（不是包一层）。

下架 / 成人 / 不存在，对外一律同一个 `404 not_found` ——
区分开就成了「这游戏是不是被下架了」的查询器。

---

## 6. ROM：两步式短期凭据

需要 `games.rom`（**这个 scope 要人工审核**；自助创建的应用只有 `games.read`）。

### 第一步：换凭据 `GET /v1/games/:slug/rom?lang=ja`

```json
{
  "url": "https://8bitgo.com/api/open/v1/rom/eyJ...xxx.yyy",
  "expires_in": 300,
  "lang_requested": "ja",
  "lang_actual": "*",
  "filename": "zeekthegeek.zip"
}
```

- `expires_in` = **300 秒**（`open/sign.js` 的 `ROM_GRANT_TTL_SEC`）。
- 凭据绑死 **app + slug + 这一个文件 + 过期时间**，URL 里**没有**存储 key ——
  抄走也只能下这一款、这几分钟。
- **ROM 语言回退**：精确语言 → 通用件（`*`）。**不做跨语言回退** ——
  要日文版给不了，就给通用件或者干脆没有，**绝不悄悄发一份别的语言的 ROM**。
  所以 `lang_actual` 必须看：它可能是 `*` 而不是你要的那门。
- 这款没有可下载的 ROM → `404 rom_unavailable`。

### 第二步：兑现 `GET /v1/rom/:grant`

**这一条不要求 `Authorization` 头** —— 凭据本身就是授权。

响应是 **`302` 重定向**到对象存储的真实地址，外加 `Cache-Control: private, no-store`。

### ⚠️ 设备端三个坑

1. **必须跟随 302，而且目标是另一个主机**（`assets.8bitgo.com`）。
   `HTTPClient` 要么开 `setFollowRedirects(HTTPC_FORCE_FOLLOW_REDIRECTS)`，
   要么自己读 `Location` 再发一次。
   ⚠️ 换主机意味着**换一张 TLS 证书**：如果你在 `WiFiClientSecure` 上钉了
   `8bitgo.com` 的叶子证书或公钥，第二跳会直接握手失败。
   设备端请钉**根 CA**（两个主机同一家 CA 签的话一张就够），别钉叶子证书 ——
   叶子证书 90 天一换，钉了等于给自己埋了个定时炸弹。
2. **五分钟窗口是给「开始下载」的**。ROM 动辄几十 MB，ESP 走 WiFi 下几分钟很正常；
   拿到凭据就立刻发起下载，别先去做别的事。窗口过了是 `410 grant_expired`，
   重新走第一步换一张就行（不用重新取令牌）。
3. **没有断点续传的承诺**。第二跳是对象存储，通常支持 `Range`，但这是它的行为、
   不是这套接口的承诺。要断点续传就自己在第二跳的地址上试 `Range`，
   失败了退回整包重下 —— 别把它当成协议的一部分。

---

### 6.5 设备码流程：怎么拿到**用户级**令牌

`client_credentials` 换来的令牌**背后没有用户**，所以它永远拿不到 `library.*` /
`saves.*`。要读某个玩家的收藏和存档，得让**那个玩家**授权一次。

而设备上没有浏览器 —— 弹不出授权页，也接不住回调地址。所以走的是 RFC 8628
设备码流程：设备显示一串码，人在手机上输进去点同意，设备这边一直轮询。

```
1. POST /v1/device/code          ← 设备要一串码（带 AppID + key）
   └─ 拿到 user_code（给人看）、device_code（给机器用）、interval

2. 屏幕上显示 user_code + verification_uri
   （能画二维码的话直接编 verification_uri_complete，用户不用手打）

3. POST /v1/token 反复轮询       ← grant_type=urn:ietf:params:oauth:grant-type:device_code
   ├─ 400 authorization_pending  → 还没人确认，按 interval 接着等
   ├─ 400 slow_down              → 轮太快了，把间隔加大
   ├─ 400 access_denied          → 用户点了拒绝，停
   ├─ 400 expired_token          → 码过期了，回第 1 步
   └─ 200 {access_token,…}       → 成了，这是一枚用户级令牌
```

#### `POST /v1/device/code`

请求（JSON 或 form，和 token 端点一样）：

```json
{"client_id":"app_xxxx","client_secret":"yyyy","scope":"library.read saves.read"}
```

`scope` 可以不传（= 已获批的全部）；传了就必须是子集，**不静默降级**。

响应：

```json
{
  "device_code": "…",
  "user_code": "BCDF-GHJK",
  "verification_uri": "https://8bitgo.com/open/device",
  "verification_uri_complete": "https://8bitgo.com/open/device?code=BCDF-GHJK",
  "expires_in": 900,
  "interval": 5
}
```

`user_code` 的字母表刻意去掉了元音和 `0/O`、`1/I/L` —— 用户是照着你的小屏幕
一个字符一个字符念出来手打的。显示时**保留中间那道横线**，比对时横线会被忽略。

#### 轮询

```json
{"grant_type":"urn:ietf:params:oauth:grant-type:device_code",
 "client_id":"app_xxxx","client_secret":"yyyy","device_code":"…"}
```

⚠️ **`authorization_pending` 和 `slow_down` 不是失败。** 它们的 HTTP 状态是 400
（协议规定的），但意思是「接着等」。把 400 一律当错误退出的固件，会在用户
明明已经点了同意的时候放弃 —— 这是接入这套流程最常见的一个错。

⚠️ 一串 `device_code` **只能兑现一次**。拿到令牌之后那条记录就没了，
再轮询回 `invalid_grant`。令牌自己存好（15 分钟，到期要重新走一遍流程）。

⚠️ 沙箱应用只能授权给**开发者本人和登记过的测试账号**。别人输码会看到一句
「这个应用还在沙箱阶段」，点不了同意。上产之后才对所有人开放。

## 7. 用户数据（只读，要用户级令牌）

需要走完 §6.5 拿到的那枚令牌，请求头照旧 `Authorization: Bearer …`。

### `GET /v1/library` —— 收藏与最近在玩

需要 `library.read`。

```json
{
  "favorites": [ /* 和 /v1/games 的元素同一个形状 */ ],
  "recent": [ /* 同上，最多 12 条 */ ],
  "favorites_total": 37
}
```

回的是**完整的游戏对象**而不是一串 slug：否则你拿到十个 slug 之后还得再发十次请求
去换标题和封面。收藏一次最多给 100 条，`favorites_total` 告诉你有没有被截断。

### `GET /v1/saves` —— 存档清单

需要 `saves.read`。**只给元信息，不带内容**（一份 DOS 变更包几百 KB）。

```json
{"items":[{"runtime":"jsdos","game_slug":"contra","slot":0,
           "size":8,"created_at":"…","updated_at":"…"}]}
```

### `GET /v1/saves/:runtime/:slug?slot=0` —— 取一份存档

需要 `saves.read`。回的是 `application/octet-stream` 原始字节，
外加 `x-save-updated-at`（毫秒时间戳）和 `Cache-Control: private, no-store`。

- `runtime` 白名单：`emulatorjs` `jsdos` `cloudgame` `jsnes` `ruffle` `webretro` `j2me`
- `slot` 0–9，DOS 只用 0
- 没有这一份 → `404 not_found`；引擎名或档位不合法 → `400 invalid_request`

⚠️ 写入（`saves.write`）**还没有**，见 §9。

## 8. 限流与错误

### 实际的限流数字

全部来自 `open.js` 里的 `take(key, limit, windowMs)` 调用：

| 桶 | 上限 | 窗口 | 位置 |
|---|---|---|---|
| 取令牌 · 按 IP | 120 | 1 小时 | `open:token:ip:<ip>` |
| 取令牌 · 按 AppID | 60 | 1 小时 | `open:token:<client_id>` |
| 设备码 · 按 IP / AppID | 60 | 1 小时 | `open:device:ip:<ip>` / `open:device:<client_id>` |
| **带令牌**的接口 · 按 AppID | **3600** | 1 小时 | `open:api:<app_id>` |
| **匿名**（公开接口）· 按 IP | **300** | 1 分钟 | `open:pub:ip:<ip>` |
| **匿名** · 全站兜底 | **3000** | 1 分钟 | `open:pub:global` |
| ROM 换凭据 · 按 AppID | **600** | 1 小时 | `open:rom:<app_id>` |
| ROM **兑现** · 按票 | 10 | 5 分钟（= 票的寿命） | `open:romdl:<grant>` |
| ROM **兑现** · 按 IP | 60 | 1 分钟 | `open:romdl:ip:<ip>` |

> 📌 **匿名那两档是 2026-09-13 随公开化一起加的。** 在那之前每一条接口背后都有一个
> AppID 可以计数；公开之后没有了，只剩 IP。而 IP 这个维度本身不可靠 ——
> 反代没把真实访客地址透传下来时所有人会塌缩成同一个值，
> 那种情况下代码会**跳过按 IP 那一道**（宁可放宽也不误伤真实用户），
> 全站那一道就成了唯一的下限。所以两档缺一不可。
>
> 📌 **一张 ROM 凭据最多兑 10 次。** 上面 600/小时 那道限的是**领票**，不是**兑票** ——
> 领一张之后在它活着的五分钟里兑多少次，2026-09-13 之前完全不设限。
> 正常一次就够，10 次是留给断点续传和失败重试的余量。
>
> 📌 **带令牌反而比匿名宽松**（3600/小时 ≈ 1 QPS，独享；匿名 300/分钟但要和所有人
> 共享全站那 3000/分钟）。设备量大的话还是建议创建应用、带令牌调。

> ⚠️ **和 `docs/open-platform.md` §1.3 不一致**。那张表写的是
> 「沙箱 QPS 5 / 日 10 000，生产 QPS 50 / 日 200 000，按 tier 可调」，
> 而代码里是**不分 tier 的固定小时桶**：`rate_tier` 字段查出来了
> （`open/apps.js` 的 `authenticateApp`），但没有任何地方用它。
> 按代码写固件：**平均 1 QPS，ROM 一小时 600 张凭据**。

平均下来普通接口约 1 QPS。设备端正常轮询（几分钟一次）离这个上限很远，
但**开机时连续翻页**很容易短时间打满 —— 列表拉完就缓存在 Flash/NVS 里，别每次开机重拉。

### `429` 长什么样

```json
{ "error": "rate_limited", "error_description": "请求过于频繁", "retry_after": 1800 }
```

同时带 `Retry-After:` 响应头（秒）。**照着它退避**，别写死重试间隔。

### 错误体（OAuth 风格，所有端点一致）

```json
{
  "error": "insufficient_scope",
  "error_description": "需要 games.rom",
  "error_uri": "https://8bitgo.com/developers/docs/errors#insufficient_scope",
  "scope": "games.rom"
}
```

⚠️ `error_description` 是**中文**的，别在固件里做英文匹配 —— **认 `error` 字段**。
（`error_uri` 指向的那个文档页现在还不存在，忽略它。）

| HTTP | `error` | 什么意思 / 怎么办 |
|---|---|---|
| 400 | `invalid_request` | 请求体解析不了（畸形 JSON / 畸形表单）。413 也是这个码，表示**请求体超过 16 KB** |
| 400 | `unsupported_grant_type` | 只支持 `client_credentials` |
| 400 | `unauthorized_client` | 这个应用是 `public` 类型，不能用 `client_credentials` |
| 400 | `invalid_scope` | 不认识的 scope / 要了用户级 scope / 应用没获批。描述里写了差哪个 |
| 401 | `invalid_client` | AppID 或 key 不对。⚠️ 两种失败**回同一句话**（防 AppID 枚举），别指望从这里区分 |
| 401 | `invalid_token` | 令牌无效或过期 → 续一次，重试一次 |
| 403 | `insufficient_scope` | 令牌没这个权限。响应里带 `scope` 字段告诉你差哪个 |
| 403 | `invalid_grant` | ROM 凭据签名不对 |
| 404 | `not_found` | 没这款游戏（下架 / 成人 / 真不存在，对外不区分） |
| 404 | `rom_unavailable` | 这款游戏没有可下载的 ROM |
| 410 | `grant_expired` | ROM 凭据过期 → 回第一步再换一张 |
| 429 | `rate_limited` | 看 `Retry-After` |
| 413 | `invalid_request` | 请求体超过 16 KB |
| 500 | `server_error` | 服务端自己的问题。**不会带任何内部信息**，重试或者联系我们 |
| 501 | `temporarily_unavailable` | 服务端没配密钥，整套或 ROM 那部分没启用。**你改不了，去看部署** |

---

## 9. 语言码

`lang` 只认这八个（`shared/site-languages.js`）：

```
zh-Hans  zh-Hant  en  es  fr  it  de  ja
```

- 认不出来的**不报错**，一律退到默认值 `en`。
- 宽松匹配一层：`zh-hans` / `ZH_HANT` / `en-US` 这类写法认得出来。
- ⚠️ 库里的译文是**残缺的**。标题在非中文界面下**刻意用原名**（`lang_actual: "und"`）；
  简介 es / fr 目前基本是空的，会退到英文、再退到中文。
  所以设备上要显示「暂无译文」之类的提示，**靠 `lang_actual`，别靠 `lang_requested`**。

---

## 10. 还做不到的事

### 云存档的**写入**

读取已经能用了（§7）。写入（`saves.write`）还没做 —— 它在 `scopes.js` 里标着
sensitive，而且要连着三件事一起想清楚才能上：单份 4 MB / 每人 200 份 / 总共 64 MB
的配额怎么在第三方这条路上算、覆盖别人正在用的档位怎么防、删除要不要留审计。
只读那条路错了最多是读到旧数据，写错了是**把玩家的进度盖掉**。

在那之前，设备端能做的是「读云端的档 + 写本地」，或者把存档导出成文件
（DOS 那一路见站内工具栏的「导出存档文件」）。

⚠️ **不要**为了绕开这一点去用站内的 `/api/saves/*`：那套认的是**站内登录令牌**，
而那枚令牌是全权限的 —— 能改邮箱、能删号。在一台可以被 dump Flash 的设备上放它，
比放 client_secret 严重得多。

### 在玩上报 / 心跳

开放平台没有这个端点。站内的 `POST /api/games/:slug/play` 认的是站内登录态
（`optionalUser`，不登录也能记，按 IP 归并），**不认开放平台令牌**。

真要做，正确的形状是在 `/api/open/v1` 下加一条应用级的上报端点
（`games.read` 就够 —— 它不读写任何用户数据），顺带解决按应用归因的统计。
改动很小，但**现在确实没有**，别在固件里预留一个猜出来的路径。

---

## 11. 一条能跑通的最小链路

```
1. POST /v1/token                      ← JSON 或 form，两种都行
   └─ 存 access_token + millis() + expires_in

2. GET  /v1/me                          ← 接线时打一次，确认 scope 对
                                           Authorization: Bearer <token>

3. GET  /v1/games?page_size=5&page=1&lang=zh-Hans
   └─ 流式解析，只留 slug / title / cover / rom_langs，写进 NVS

4. GET  /v1/games/<slug>/rom?lang=*     ← 需要 games.rom
   └─ 拿到 url，5 分钟内用掉

5. GET  <那个 url>                       ← 不带 Authorization
   └─ 跟随 302 → assets 主机 → 写进 SD / SPIFFS

要读玩家自己的收藏和存档，在第 1 步之前再插一段（见 §6.5）：

```
0a. POST /v1/device/code                ← 拿 user_code + device_code
0b. 屏幕显示 user_code 和 8bitgo.com/open/device
0c. POST /v1/token 每 interval 秒轮一次  ← grant_type=…:device_code
    （authorization_pending / slow_down 都是「接着等」，不是失败）
0d. 拿到用户级令牌 → GET /v1/library、GET /v1/saves
```

每一步的失败都认 `error` 字段，不认 `error_description`。
`401 invalid_token` 回第 1 步一次；`410 grant_expired` 回第 4 步一次；
`429` 按 `Retry-After` 退避。其余的错误直接报给用户看，别自动重试。

---

## 12. 本地 / Linux 客户端：下载 ROM 后用本机模拟器跑

这套接口对「能联网的本地机器（Linux 小主机、x86 PC、单板机）」完全够用：
机器经 WiFi 拿 AppID + Key 换令牌，拉游戏列表，取 ROM 签名地址，下载 ROM，
再交给本机模拟器运行。和 ESP 嵌入式的区别是：机器有完整的 CPU / 存储 / 文件系统，
不用在固件里抠内存，所以**整套接口都能直接用**，没有 ESP 那边的流式解析约束。

### 12.1 先拉平台目录，决定能不能跑、用什么跑

```
GET /v1/platforms          ← 只要令牌有效就回，不限 scope
```

返回 `items`，每个平台带：

| 字段 | 含义 |
|---|---|
| `runtime` | 站内用的运行环境：`emulatorjs` / `jsdos` / `ruffle` / `html5` / `play` / `j2me` |
| `core` | emulatorjs 的核心名（`nes` / `snes` / `arcade` …），本地客户端据此选模拟器 |
| `romExtensions` | 这个平台 ROM 的扩展名，下载后按它判断怎么喂给模拟器 |
| `native.runnable` | **能不能拿这个平台的 ROM 在本机模拟器上跑**（见下面 12.2 的三档） |
| `native.emulator` | runnable 时推荐的 Linux 原生模拟器项目名 |
| `native.note` | 格式上的坑，或者 runnable=false 的原因。**这一句是写给用户看的**，客户端可以直接显示 |
| `enabled` | 这个平台在站上开着没有。`false` = 前台 404、列表里查不到东西，客户端应当整个隐藏 |

`game.platform` 字段就是这里的 `id`。客户端拿 `id` 查这张表即可，
**别把 16 个平台的映射硬编码进客户端**——站上加平台时旧客户端就认不出了。

### 12.2 哪些平台「下载即跑」，哪些不是

- ✅ **下载即跑**：`runtime=emulatorjs` 那 11 个（nes / snes / gba / gb / gbc / n64 /
  nds / psx / segaMD / ws / arcade）+ `java`（`runtime=j2me`，FreeJ2ME），一共 12 个。
  ROM 是单个文件（`.nes` / `.sfc` / `.zip` romset / `.jar` …），`filename` 字段直接
  告诉你文件名，按 `romExtensions` 交给对应模拟器。

  > ⚠️ **这 12 个里有几个站上是关着的。** 每一行都带 `enabled`，它跟着站点的平台
  > 白名单走：`enabled:false` 的平台在前台是 404，`/v1/games?platform=<id>` 也查不到东西。
  > **客户端要按 `enabled` 过滤**，别照着这份名单给用户列出永远没有内容的分类。
  > 这个名单是会变的（NDS 就是后来才补进去的），所以别在代码里写死「有哪几个」。
- ⚠️ **能跑但要处理格式**：
  - `dos`：ROM 是 **jsdos 包**（Web 专用格式）。本地 DOSBox 要先解包、把内部目录结构
    整理成裸 DOS 游戏目录才能跑，不是直接喂 zip。
  - `flash`：`.swf` 用 **Ruffle**（有 Linux 原生构建）跑。
- ❌ **本地跑不了**：
  - `html5`：根本不是 ROM，是一个网页，没有可下载的执行文件。
  - `ps2`：**不是「没有模拟器」，是「拿不到盘」。** PS2 是 DVD，一张 1~4.7GB，
    站上根本不提供整份下载 —— 浏览器里那个实验性的 Play! 走 HTTP Range 只读游戏
    真正读到的扇区。所以 `/v1/games/:slug/rom` 这条路对 PS2 不成立。
    （Linux 上 PCSX2 很成熟，但盘得你自己准备。）

  客户端应当把这两个平台整个隐藏，别让用户点进去下载一堆用不了的东西。

### 12.3 一个游戏的完整本地流程

```
1. GET  /v1/platforms                              ← 缓存整张表（很少变）
2. POST /v1/token  (client_credentials)             ← 拿应用级令牌
3. GET  /v1/games?platform=arcade&lang=zh-Hans      ← 列表
4. GET  /v1/games/:slug                             ← 详情，拿到 platform
5. GET  /v1/games/:slug/rom?lang=*                  ← 需要 games.rom
    └─ 回 { url, filename, lang_actual }，5 分钟内用掉
6. GET  <url>   （不带 Authorization，跟随 302）      ← 下载 ROM 到本地
7. 查 /v1/platforms 里 platform 的 native.emulator   ← 选模拟器
8. 用对应模拟器打开下载下来的 filename               ← 开玩
```

ROM 那一步（`/v1/rom/:grant`）是 302 到 `assets.8bitgo.com`，下载工具要**跟随重定向且接受换主机**
（TLS 钉根 CA，别钉叶子证书——见 §6 的设备端三个坑，对本地客户端同样成立）。

要读玩家自己的收藏和存档、做到「续上云端进度」：走 §6.5 设备码流程拿用户级令牌，
再 `GET /v1/library`、`GET /v1/saves/:runtime/:slug`。⚠️ **写回**（`saves.write`）还没有，
本地进度暂时不能推回云端——只读能续，写入要等这一轮补齐。

### 12.4 AppKey 别烧死在分发的客户端里

§1 说的「secret 只能留服务端」对分发的 Linux 客户端同样是硬约束：把 AppKey 编译进
要给别人装的包，等于任何人拿到一份就能用你的配额、还能在 `/open` 控制台撤销那把 key 砖化所有设备。
自用几台无所谓；要做成产品，走「自己架一层中转、secret 留服务端」那一条。
