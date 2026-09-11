# 8BitGo 开放平台 · 嵌入式（ESP）接入速查

> 面向**设备端**（ESP32 / ESP8266 之类）的接口速查。
> 协议设计与取舍见 `docs/open-platform.md`；这一份只回答一件事：
> **固件里要发什么请求、会收到什么、出错了怎么认。**
>
> 每条数字和字段都标了源码出处。和设计稿冲突的地方**以源码为准**，
> 并在正文里显式标出来（见 §7 的限流一节）。
>
> 核对基线：`server/src/routes/open.js` + `server/src/open/*`，2026-09-11。

---

## 0. 先说清楚：四件事里今天只有两件能做

| 你要做的 | 状态 | 说明 |
|---|---|---|
| 拉游戏列表 / 详情 | ✅ **可用** | `games.read`，自助创建应用当场就有这个权限 |
| 下载 ROM 到设备 | ✅ **可用** | `games.rom`，但这个 scope **要人工审核**才批；另见下面的 ⚠️ |
| 云存档读写 | ❌ **不存在** | 开放平台**一个 saves 端点都没有**（`open.js` 里 grep 不到 saves/library）。它属于用户级 scope，而用户级授权（OIDC 授权码 + PKCE）**整个没实现** —— `server/src/routes/oauth.js` 这个文件不存在，`/api/oauth` 也没在 `index.js` 里挂过 |
| 上报在玩 / 心跳 | ❌ **不存在** | 开放平台没有这个端点。站内有 `POST /api/games/:slug/play`，但那是站内接口，不认开放平台令牌 |

后两件要怎么办，见 §9。**别照着设计稿写固件** —— `docs/open-platform.md` 里
`saves.read` / `saves.write` / `library.*` 是设计稿，`server/src/open/scopes.js` 里
确实有这些常量，但**没有任何路由消费它们**。

⚠️ ROM 那条还有一个必须知道的前提：`assets.8bitgo.com` 目前是**公开可读**的。
签名凭据这一层现在只是「我们不主动给地址」，**不是访问控制** ——
任何人打开一次游戏、从浏览器网络面板抄走 ROM 地址就能无限下载。
源码里对此有明确注释（`server/src/open/sign.js` 文件头、`open.js` 的 `/v1/games/:slug/rom`）。
这不影响你的固件怎么写，但影响你怎么对外描述这个功能。

---

## 1. 前提与环境

| 项 | 值 |
|---|---|
| Base URL | `https://8bitgo.com/api/open/v1` |
| 拿 AppID / key | 站点页脚 → **`/open`** 开发者控制台（⚠️ 不是 `/developers`，那是站内的「开发商」浏览页） |
| 客户端类型 | 必须选 **`confidential`**（有 key）。`public` 客户端**不能**用 `client_credentials`，会被 400 `unauthorized_client` 挡掉 |
| AppID 形状 | `app_` + 24 位十六进制 |
| key | 32 字节随机、Base64URL，**只在创建/轮换时显示一次** |
| CORS | `/api/open/*` 放开到任意 Origin，且**不带 cookie**。设备端用不上，但说明这套接口不依赖任何浏览器状态 |

**服务端没开的话会怎样**：所有端点直接回 `501 temporarily_unavailable`。
这不是你的请求写错了，是部署上没配 `OPEN_JWT_PRIVATE_KEY`（整套）或
`OPEN_ROM_SECRET`（只影响 ROM 两条）。接线之前先用一条 curl 探一下：

```bash
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

需要 `games.read`。

### 查询参数

| 参数 | 说明 |
|---|---|
| `page` | 从 1 开始，默认 1 |
| `page_size` | 默认 24，**上限 50**（超了按 50 截断，不报错） |
| `platform` | 平台 id，如 `nes` / `dos` |
| `genre` | 类型 id |
| `q` | 关键词。传了 `q` 且没显式指定 `sort` 时按相关度排 |
| `sort` | `popular`（默认）/ `newest` / `name` / `rating` / `home` |
| `lang` | 见 §8。不传默认 **`en`** ⚠️ |

⚠️ `lang` 默认是 `en` 而不是 `zh-Hans`，这是**刻意**的（`open/i18n.js` 的
`OPEN_DEFAULT_LANG`）：开放接口的调用方是第三方，默认给中文会让人以为整库都是中文。
要中文界面就**每次都显式传 `lang=zh-Hans`**。

⚠️ 开放平台**没有** facets / 平台列表端点。`platform` 和 `genre` 的可选值只能从
返回的 items 里认，或者去站点上看。

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

需要 `games.read`。参数只有 `lang`。返回体**就是上面那个游戏对象**（不是包一层）。

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

## 7. 限流与错误

### 实际的限流数字

全部来自 `open.js` 里的 `take(key, limit, windowMs)` 调用，窗口都是**一小时**：

| 桶 | 上限/小时 | 位置 |
|---|---|---|
| 取令牌 · 按 IP | 120 | `open:token:ip:<ip>` |
| 取令牌 · 按 AppID | 60 | `open:token:<client_id>` |
| 普通接口 · 按 AppID | **3600** | `open:api:<app_id>` |
| ROM 换凭据 · 按 AppID | **600** | `open:rom:<app_id>` |

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

## 8. 语言码

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

## 9. 那两件今天做不到的事

### 云存档

开放平台里没有任何存档端点，而且这条路是**用户级**的（存档跟着账号走，
不是跟着应用走），需要 OIDC 授权码 + PKCE —— 而那一整套没实现。

现在只有一条路能通，**代价很大**：站内接口 `/api/saves/*` 用站内登录令牌
（`requireUser`）。意味着设备上要存**用户的登录令牌**，而那枚令牌是**全权限**的 ——
能改邮箱、能删号。在一台可以被 dump Flash 的设备上放这个，比放 client_secret 严重得多。
**不建议**。

站内那套的形状（仅供参考，随时可能改、没有版本承诺）：

```
GET    /api/saves/                          列出全部
GET    /api/saves/:runtime/:slug/meta?slot=0  只要大小和时间
GET    /api/saves/:runtime/:slug?slot=0       下载（二进制）
PUT    /api/saves/:runtime/:slug?slot=0       上传（请求体就是原始字节）
DELETE /api/saves/:runtime/:slug?slot=0
```

- `runtime` 白名单：`emulatorjs` `jsdos` `cloudgame` `jsnes` `ruffle` `webretro` `j2me`
- `slot` 0–9，DOS 只用 0
- 单份上限 4 MB，每人最多 200 份、总共 64 MB

要让设备端正经用上云存档，得先做两件事：实现 OIDC 那半（设备端还得走
设备码流程 RFC 8628，因为 ESP 上没有浏览器），再在 `/api/open/v1` 下补一套
`saves.*` 端点。这是两个独立的工程，不是配置问题。

### 在玩上报 / 心跳

开放平台没有这个端点。站内的 `POST /api/games/:slug/play` 认的是站内登录态
（`optionalUser`，不登录也能记，按 IP 归并），**不认开放平台令牌**。

真要做，正确的形状是在 `/api/open/v1` 下加一条应用级的上报端点
（`games.read` 就够 —— 它不读写任何用户数据），顺带解决按应用归因的统计。
改动很小，但**现在确实没有**，别在固件里预留一个猜出来的路径。

---

## 10. 一条能跑通的最小链路

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
```

每一步的失败都认 `error` 字段，不认 `error_description`。
`401 invalid_token` 回第 1 步一次；`410 grant_expired` 回第 4 步一次；
`429` 按 `Retry-After` 退避。其余的错误直接报给用户看，别自动重试。
