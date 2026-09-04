# 8BitGo 开放平台 · 接口设计

> 状态：**设计稿，尚未实现**。写在动手之前，用来把几个不可逆的决定钉死。
> 一旦发出去的 appkey 有人在用，协议就改不动了 —— 所以先争论文档，别先写代码。

面向的两件事：

1. **用 8BitGo 账号登录第三方网站** —— 8BitGo 做身份提供方（OIDC Provider）。
2. **调用 8BitGo 的游戏资源** —— 游戏元数据 + 可嵌入的播放器。

已定的边界（`2026-09` 与产品确认）：

| 项目 | 结论 |
|---|---|
| 游戏资源 | 元数据 + 可嵌入播放器。**ROM 不出站** |
| 用户数据 | 基本资料 / 收藏与最近在玩 / 云存档读写 |
| G 币 | **不开放**（虚拟资产，将来单独审核，不走自助） |
| 后台能力 | **永不开放**（`content:edit` 这类权限点与开放平台完全隔离） |
| 接入方式 | 自助创建 + 沙箱配额，申请上产时人工审一次 |

规范基线：授权码流程 [RFC 6749](https://www.rfc-editor.org/rfc/rfc6749)、PKCE [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)、安全实践 [RFC 9700](https://www.rfc-editor.org/info/rfc9700/)、身份层 OpenID Connect Core 1.0。
OAuth 2.1 目前仍是 Internet-Draft（`draft-ietf-oauth-v2-1-15`），不作为规范引用，但它移除的东西（隐式流、密码模式）我们一开始就不做。

---

## 0. 最重要的一条：两种令牌必须互不相认

站内登录令牌（`signToken`，HS256 + `JWT_SECRET`，payload `{uid, tv}`）和开放平台的 access token
**绝对不能长得一样**。如果开放平台也用 `JWT_SECRET` 签、payload 里也放 `uid`，那么现有的
`requireUser` 会原样接受它 —— 第三方应用拿到一个「只读昵称」的令牌，转手就能调
`/api/me` 改邮箱、调 `/api/saves` 删存档、甚至在 `ADMIN_AUTH_DISABLED` 开着的机器上进后台。
一个字段的疏忽，等于把整个账号系统送出去。

所以硬性约定三条，实现时先写这三条的测试：

1. 开放平台 access token 用**独立的 RSA 密钥对 RS256 签名**（`OPEN_JWT_PRIVATE_KEY`），
   与 `JWT_SECRET` 无任何关系。
2. 它的 header 带 `typ: "at+jwt"`，payload 必须有 `aud`（= client_id）、`scope`、`cid`。
3. 现有的 `verifyToken`（`server/src/auth.js`）显式**拒绝**任何带 `aud` 或 `scope` 的令牌，
   并且把算法**写死**成 `algorithms: ['HS256']`；开放平台的中间件反过来只接受
   RS256 + `typ=at+jwt`。两边都做「白名单式」判断，不要写成「不是 A 就当 B」。

已在本仓库实测（`jsonwebtoken` 9）：

| 拿什么令牌去调现有的 `verifyToken` | 结果 |
|---|---|
| RS256 签的（独立密钥） | `invalid algorithm` —— 拒绝 ✅ |
| **HS256 签的，payload 带 `uid` + `aud` + `scope`** | **接受，`uid` 原样取出** ⚠️ |

所以第 1 条（换算法换密钥）本身就够挡住越权，这是选 RS256 的实际理由，不只是「规范推荐」。
而第二行说明：**只要开放平台图省事复用了 `JWT_SECRET`，第三方令牌立刻等价于完整账号令牌** ——
多加的 `aud` / `scope` 字段一个都拦不住，因为现在没人检查它们。第 3 条是纵深防御：
`jsonwebtoken` 是「密钥是字符串就默认只认 HS」，这是它的实现细节而非承诺，别把安全边界押在上面。

同理，开放平台的接口一律挂在 `/api/open/*` 下，**不复用**任何现有的 `/api/me`、`/api/saves`
路由对象 —— 复用实现函数可以，复用路由（连带它的鉴权中间件）不行。

---

## 1. 应用与密钥

### 1.1 概念

- **App Key**（= OIDC 的 `client_id`）：`app_` + 24 位十六进制。公开，会出现在授权地址里。
- **App Secret**（= `client_secret`）：32 字节随机，Base64URL。**只在创建/轮换时显示一次**，
  库里只存 bcrypt 哈希 + 末 6 位提示（用来在列表里认出是哪一把）。
- 客户端类型二选一，创建时定死、不可改：
  - `confidential`（有 secret）：接入方有自己的服务端。
  - `public`（无 secret）：纯前端 / 移动端。**只靠 PKCE + 精确回调地址**，不发 secret。
    很多人会想「我是纯前端但我也要 secret」—— 不给，前端藏不住密钥，给了只会制造假的安全感。

### 1.2 密钥轮换

密钥单独一张表，允许**同时有两把有效**：新建一把 → 两边都能用 → 接入方换完 → 撤销旧的。
不做轮换的后果已经在别处见过：密钥一到期，所有用户同时登不上，而且没有回退路径。

### 1.3 沙箱与上产

| | sandbox（自助，立即可用） | live（人工审核后） |
|---|---|---|
| 回调地址 | 最多 3 个，允许 `http://localhost` | 最多 10 个，**仅 https** |
| 可授权用户 | 仅应用所有者本人 + 最多 5 个测试账号 | 不限 |
| QPS | 5 | 按 tier |
| 日调用量 | 10 000 | 按 tier |
| 云存档写 | 100 次/日 | 按 tier |
| 嵌入播放器 | 可用，页面带「沙箱」水印 | 无水印 |

沙箱限定授权对象，是为了让「拿 appkey 去钓鱼」这条路在审核前走不通。

### 1.4 开发者后台

- `/developers/apps` —— 站内页面，登录即可用：建应用、看 key、轮换密钥、填回调地址与嵌入域名、看用量曲线、申请上产。
- `/me/authorized-apps` —— 用户侧：看自己授权过哪些应用、各自拿了什么 scope、一键解除。
  **这一页必须和开放平台同期上线**，不能等 P3。用户能授权却不能撤销，是不能接受的。

---

## 2. 登录（OIDC 授权码 + PKCE）

### 2.1 端点

| 端点 | 方法 | 说明 |
|---|---|---|
| `/.well-known/openid-configuration` | GET | 发现文档，接入方的现成库会自己读 |
| `/.well-known/jwks.json` | GET | id_token / access token 的验签公钥 |
| `/oauth/authorize` | GET | **前端页面**：登录态检查 + 授权同意界面 |
| `/api/oauth/token` | POST | 换 token / 刷新 token |
| `/api/open/v1/userinfo` | GET | OIDC 标准用户信息 |
| `/api/oauth/revoke` | POST | 撤销 refresh token（RFC 7009） |

`/oauth/authorize` 做成前端路由而不是后端 302，是为了直接复用站内现有的登录弹窗和
多语言外壳：未登录时走本站正常登录流程，登完回到同一页继续同意，不用再造一套登录页。
它读完 query 参数后调 `GET /api/oauth/authorize/preview` 拿应用名称、logo、请求的 scope，
用户点同意后 `POST /api/oauth/authorize/consent`，后端返回 `{ redirectTo }`，前端整页跳转。

### 2.2 流程

```
接入方后端/前端
  ├─ 生成 code_verifier（43–128 随机字符）、code_challenge = BASE64URL(SHA256(verifier))
  ├─ 生成 state、nonce，存在自己的会话里
  └─ 浏览器跳转：
     https://8bitgo.com/oauth/authorize
       ?client_id=app_xxx
       &response_type=code
       &redirect_uri=https://partner.com/callback   ← 必须与登记的**完全一致**
       &scope=openid%20profile%20email%20library.read
       &state=<随机>
       &nonce=<随机>
       &code_challenge=<challenge>
       &code_challenge_method=S256

8BitGo
  ├─ 未登录 → 走站内登录 → 回到本页
  ├─ 首次授权 → 显示同意页（可逐项取消可选 scope）
  ├─ 已授权且 scope 无新增 → 直接放行，不再打扰
  └─ 302 → https://partner.com/callback?code=<一次性码>&state=<原样>

接入方后端
  └─ POST https://8bitgo.com/api/oauth/token
        grant_type=authorization_code
        code=…  redirect_uri=…  code_verifier=…
        client_id=app_xxx  client_secret=…（confidential 才有）
     ← { access_token, token_type:"Bearer", expires_in:900,
         refresh_token, id_token, scope }
```

### 2.3 硬性规则

- **PKCE 强制**，`S256` only（不接受 `plain`），**保密客户端也要**。RFC 9700 的要求，
  它挡的是授权码在回跳链路上被截走后直接兑换。
- `redirect_uri` **精确字符串匹配**，不做前缀匹配、不做通配符。前缀匹配是开放重定向的经典入口。
- 授权码：**60 秒**、一次性、绑定 `client_id` + `redirect_uri` + `code_challenge`。
  **重复使用一个已用过的码 → 立刻吊销该用户在该应用下的全部 refresh token**，并给应用所有者发信。
  这是检测「码被偷了」的唯一信号，不能只是简单报错了事。
- access token：**15 分钟**，无状态 JWT，不入库。
- refresh token：30 天，**每次刷新都轮换**（旧的立即失效）。
  用一个已经轮换掉的 refresh token → 判定为泄露 → 吊销整条链。
- 不支持：隐式流、密码模式、`client_credentials` 换用户身份。
- 不支持 `prompt=none` 的静默续期（前期没有必要，且要额外防 iframe 点击劫持）。

### 2.4 id_token

RS256 签名（不是 HS256）。理由：公开客户端手里没有 secret，用对称算法它就没法验签；
而且 RS256 + JWKS 是所有现成库的默认路径，接入方几行代码就能接。

```json
{
  "iss": "https://8bitgo.com",
  "sub": "u_a1b2c3d4e5f6",       // 站内用户 id，跨应用相同
  "aud": "app_xxx",
  "exp": 1788600000, "iat": 1788599700,
  "nonce": "…",
  "name": "小明",                 // scope 含 profile
  "picture": "🕹️",               // 头像是 emoji，不是 URL —— 见下
  "email": "a@b.com",            // scope 含 email
  "email_verified": true
}
```

> ⚠️ `users.avatar` 是 `VARCHAR(16)`，存的是 emoji，不是图片地址。OIDC 的 `picture`
> 按规范应该是 URL，直接塞 emoji 会让接入方的头像组件炸掉。两个选项：
> (a) 不发 `picture`，另发一个自定义声明 `bitgo_avatar`；(b) 服务端把 emoji 渲染成
> 一个稳定的 PNG/SVG 地址再发。**建议 (a)**，改动小且不撒谎。实现前需拍板。

`sub` 用站内 user id 而不是每个应用一个匿名 id：本站的定位是「把 8BitGo 账号带出去」，
跨应用可关联是特性不是缺陷。但要在开发者条款里写明这一点。

---

## 3. Scope

| scope | 给什么 | 用户可否单独取消 | 阶段 |
|---|---|---|---|
| `openid` | 签发 id_token。必需 | 否 | P0 |
| `profile` | 昵称、头像、注册时间 | 否（登录的最小集） | P0 |
| `email` | 邮箱 + 是否已验证 | 可 | P0 |
| `games.read` | 游戏元数据、封面、嵌入地址 | —（应用级，不涉及用户） | P0 |
| `library.read` | 收藏列表、最近在玩 | 可 | P1 |
| `library.write` | 加/取消收藏、写最近在玩 | 可 | P1 |
| `saves.read` | 列出、下载云存档 | 可 | P2 |
| `saves.write` | 上传、覆盖、删除云存档 | 可 | P2 |

规则：

- 请求的 scope 必须是**该应用已获批列表**的子集；超出的部分直接报 `invalid_scope`，
  不做「静默降级只发能给的那部分」—— 静默降级会让接入方以为自己拿到了权限，
  直到线上某个功能莫名其妙失效才发现。
- access token 的 `scope` 声明是唯一依据，每个接口自己声明需要哪个 scope。
- `saves.write` 是破坏力最大的一个：它能覆盖玩家几十小时的进度。所以它
  **单独限速、单独配额**，且写入前强制走现有的「存档落点」语义（见
  `project_8bitgo_saves` 的记忆：没选过云存档的用户绝不默认上云）。

---

## 4. 游戏资源

### 4.1 元数据（应用级，`Authorization: Bearer <app access token>`）

应用级令牌走 `grant_type=client_credentials`（仅 confidential 客户端），
或者 public 客户端直接用 `client_id` + Referer 校验的只读通道（限速更严）。

| 端点 | 说明 |
|---|---|
| `GET /api/open/v1/games` | 分页列表。`platform` / `genre` / `q` / `sort` / `page` / `page_size≤50` |
| `GET /api/open/v1/games/{slug}` | 详情：标题（多语言）、简介、平台、类型、开发商、封面、是否支持联机 |
| `GET /api/open/v1/facets` | 有游戏的平台与类型 |
| `GET /api/open/v1/games/{slug}/embed` | 换一个签名的嵌入地址（见下） |

实现上直接复用 `server/src/games-repo.js`，但**输出走一层独立的 mapper**：
后台字段（`hidden`、`arcade_romdata`、`dos_*`、对象 key 原文）一个都不能漏出去。
现有 `mappers.js` 是给站内前端用的，它认为调用方是自己人 —— 不要直接拿来对外。

成人内容（`games.adult`）默认从开放接口里**整体排除**，除非应用单独申请并通过审核。

### 4.2 嵌入播放器

```
GET /api/open/v1/games/kof97/embed?lang=zh-Hans
→ {
    "url": "https://8bitgo.com/embed/kof97?a=app_xxx&e=1788600000&s=<hmac>",
    "expires_at": "2026-09-05T12:00:00Z",
    "aspect_ratio": "4/3",
    "allow": "fullscreen; gamepad; autoplay; clipboard-write"
  }
```

- `/embed/:slug` 是一个新的整页外壳，照抄 `server/src/routes/play.js` 的思路：
  不走 SSR、不引 React、不引任何第三方资源 —— 因为跨源隔离头（COOP/COEP）会掐掉外部资源，
  内容越少越安全。区别是它多一个 8BitGo 角标和签名校验。
- 签名 `s = HMAC-SHA256(OPEN_EMBED_SECRET, app_id|slug|exp)`，服务端自己的密钥，
  **不是** app secret（服务端只存 secret 的哈希，签不出来）。有效期建议 1 小时。
- **防盗链靠 `frame-ancestors`**：`/embed/*` 的响应头带
  `Content-Security-Policy: frame-ancestors <该应用登记的嵌入域名>`。
  这是浏览器强制的，比 Referer 判断可靠得多。Referer / `Sec-Fetch-Site` 只作为
  服务端侧的弱校验和用量归因，不作为唯一屏障。
- 嵌入域名与 OAuth 回调域名**分开登记**：一个网站可能只嵌游戏不接登录，反过来也一样。
- 想让嵌入的游戏带上玩家身份（存档、收藏），在 URL 上再挂一个短期的用户票据，
  由 `/embed` 页换成会话 —— 不要直接把 access token 放进 iframe 地址，它会进浏览器历史和 Referer。

### 4.3 ⚠️ 「ROM 不出站」目前只是「我们不主动给」

现在 `assets.8bitgo.com` 是**公开读**的对象存储：任何人打开一次游戏、从网络面板抄走
ROM 地址，就能无限次直接下载，跟有没有 appkey 毫无关系。所以在开放平台对外承诺
「ROM 不出站」之前，必须先补上这一层：

- ROM 对象改为**不可公开读**，由 Worker（`worker/`）或 R2 预签名发放短期地址；
- 地址与会话绑定（app_id / user / slug / exp），有效期以分钟计；
- 现有站内播放器同步改造。

这是开放平台的**前置改造**，不是可选项 —— 否则第一个接入方就会发现
「其实我不用你的播放器也能拿到 ROM」，而那正是我们选「元数据 + 嵌入播放器」方案想避免的事。

---

## 5. 用户数据接口

全部在 `/api/open/v1/me/*` 下，鉴权中间件 `requireAppUser(scope)`。

| 端点 | scope |
|---|---|
| `GET /userinfo` | `openid` |
| `GET /me/library` | `library.read` |
| `POST /me/favorites/{slug}` / `DELETE` | `library.write` |
| `POST /me/recents/{slug}` | `library.write` |
| `GET /me/saves` | `saves.read` |
| `GET /me/saves/{runtime}/{slug}` | `saves.read` |
| `PUT /me/saves/{runtime}/{slug}` | `saves.write` |
| `DELETE /me/saves/{runtime}/{slug}` | `saves.write` |

实现复用 `server/src/userdata.js` 和 `routes/saves.js` 里的**函数**，路由和中间件另起。
云存档的三道配额（单份字节数、每人份数、每人总字节）继续生效，
再叠加一层「每应用每日写入次数」。

被封禁的用户（`status='banned'`）在 token 端点和每次刷新时都要重新判定，
不能只在登录时判一次 —— access token 15 分钟寿命就是这个判定的粒度。

---

## 6. 限流、配额与错误

- 限流键：`app_id` + 客户端 IP，两层都要（只按 app 限，一个坏用户能拖垮整个应用；
  只按 IP 限，应用的服务端出口 IP 会互相挤占）。
- 响应头：`X-RateLimit-Limit` / `-Remaining` / `-Reset`，超限 `429` + `Retry-After`。
- 错误体统一 OAuth 风格，便于现成库解析：

```json
{ "error": "invalid_scope",
  "error_description": "应用未获批 saves.write",
  "error_uri": "https://8bitgo.com/developers/docs/errors#invalid_scope" }
```

- `error_description` 面向开发者，可以说具体原因；**不要**把用户是否存在、是否被封禁
  这类信息漏进去（那是账号枚举）。

### CORS

`/api/open/*` 必须允许**任意 Origin**（第三方站点的浏览器会直接调），
这和站内 `ALLOWED_ORIGINS` 白名单是两套策略，要单独一段中间件，
**不能**为了省事把站内的白名单改成 `*` —— 那会把 `/api/me`、`/api/admin` 一起放开。

`/api/oauth/token` 只接受服务端调用（confidential）或公开客户端的跨域调用，
两者都不带 cookie：开放平台全程 **Bearer**，不碰 cookie，因此天然没有 CSRF 面。

### 点击劫持：同意页必须禁止被嵌

本站目前**没有任何 CSP / X-Frame-Options**（`server/src/index.js` 里只有 cors，没挂 helmet）。
也就是说 `/oauth/authorize` 默认可以被任意站点嵌进 iframe —— 攻击者用一个透明 iframe 盖在
「领取奖励」按钮上，用户点一下就把 scope 授出去了，全程没有任何提示。

所以 `/oauth/authorize` 必须带 `Content-Security-Policy: frame-ancestors 'none'`
（外加 `X-Frame-Options: DENY` 兼容老浏览器）。这条和 4.2 的 `frame-ancestors <登记域名>`
是同一个机制的两个方向：嵌入播放器**只准**登记过的域名嵌，同意页**谁都不准**嵌。
顺带建议给全站补一套基础安全头，但那是另一件事，别和开放平台捆在一起做。

---

## 7. 数据表

新增 5 张，`users` 表不动。补丁照 `server/scripts/migrate.mjs` 的清单追加，六份 schema 同步。

```sql
-- 应用
oauth_apps(
  id VARCHAR(40) PK,               -- app_xxx，即 client_id
  owner_id VARCHAR(40),            -- users.id
  name VARCHAR(60), description TEXT, homepage VARCHAR(300),
  logo VARCHAR(500),               -- 对象 key，渲染前过 romUrlForKey
  privacy_url VARCHAR(300),
  client_type ENUM('confidential','public'),
  redirect_uris TEXT,              -- JSON 数组，精确匹配
  embed_origins TEXT,              -- JSON 数组，用于 frame-ancestors
  approved_scopes TEXT,
  status ENUM('sandbox','live','suspended'),
  rate_tier VARCHAR(16),
  created_at TIMESTAMP,
  KEY idx_owner (owner_id)
)

-- 密钥（允许同时两把，支持轮换）
oauth_app_secrets(
  id VARCHAR(40) PK, app_id VARCHAR(40),
  secret_hash VARCHAR(200),        -- bcrypt
  hint CHAR(6),                    -- 末 6 位，仅用于识别
  created_at TIMESTAMP, expires_at TIMESTAMP NULL, revoked_at TIMESTAMP NULL,
  last_used_at TIMESTAMP NULL,
  KEY idx_app (app_id)
)

-- 用户对应用的长期授权（用于「已授权应用」列表与一键解除）
oauth_authorizations(
  user_id VARCHAR(40), app_id VARCHAR(40),
  scopes TEXT, created_at TIMESTAMP, updated_at TIMESTAMP,
  PRIMARY KEY (user_id, app_id)
)

-- 授权码：一次性、60 秒
oauth_codes(
  code_hash CHAR(64) PK,           -- sha256(code)，明文不入库
  app_id VARCHAR(40), user_id VARCHAR(40),
  scopes TEXT, redirect_uri VARCHAR(500),
  code_challenge VARCHAR(128), nonce VARCHAR(128),
  expires_at TIMESTAMP, used_at TIMESTAMP NULL,
  KEY idx_expire (expires_at)
)

-- refresh token：轮换 + 重放检测
oauth_tokens(
  token_hash CHAR(64) PK,
  app_id VARCHAR(40), user_id VARCHAR(40), scopes TEXT,
  rotated_from CHAR(64) NULL,      -- 上一枚，用来识别「用了已轮换的令牌」
  expires_at TIMESTAMP, revoked_at TIMESTAMP NULL, last_used_at TIMESTAMP NULL,
  created_at TIMESTAMP,
  KEY idx_user_app (user_id, app_id), KEY idx_expire (expires_at)
)
```

授权码和 refresh token **都只存哈希**：库被读走时，明文令牌不能直接拿去用。
过期行由定时任务清理（可以复用 `login_codes` 的清理路径）。

---

## 8. 新增环境变量

```
# 开放平台的签名密钥（与 JWT_SECRET 无关，绝不能复用）
OPEN_JWT_PRIVATE_KEY_PATH=   # RS256 私钥，PEM
OPEN_JWT_KID=                # 轮换时靠它区分，JWKS 里同时挂新旧两把
OPEN_EMBED_SECRET=           # 嵌入地址的 HMAC 密钥
OPEN_ISSUER=https://8bitgo.com
```

---

## 9. 分期

| 阶段 | 内容 | 完成的标志 |
|---|---|---|
| **P-1** | ROM 签名发放改造（见 4.3） | 直接拿 ROM 地址下不到东西 |
| **P0** | 应用注册 + 开发者后台 + OIDC（`openid/profile/email`）+ `/me/authorized-apps` | 一个外部站点能用 8BitGo 账号登录并看到昵称 |
| **P0.5** | `games.read` + 嵌入播放器 + `frame-ancestors` | 外部站点能列游戏并嵌进去玩 |
| **P1** | `library.read/write` | 收藏在两边同步 |
| **P2** | `saves.read/write` + 独立配额 | 进度在两边同步，且写坏了能查到是哪个应用 |
| **P3** | 上产审核流、用量面板、开发者文档站 | 可以对外宣传 |

P-1 排在 P0 前面不是洁癖：它是「元数据 + 嵌入播放器」这个方案唯一的立足点。

---

## 10. 实现时必须先写的测试

照 `server/scripts/test-oauth.mjs` 的路子（假库 + 假 fetch + 真密钥），新建 `test-openapi.mjs`：

1. 站内 JWT **不能**通过开放平台中间件；开放平台 access token **不能**通过 `requireUser`；
   两个方向都要断言。
2. `redirect_uri` 差一个斜杠 / 差 www / 多一个查询参数 → 全部拒绝。
3. 没有 `code_challenge` → 拒绝；`plain` → 拒绝；`code_verifier` 对不上 → 拒绝。
4. 授权码用第二次 → 拒绝，**且该用户在该应用下的 refresh token 全部失效**。
5. 用已轮换掉的 refresh token → 拒绝并吊销整条链。
6. 请求超出已获批 scope → `invalid_scope`，不静默降级。
7. 只有 `profile` 的 token 调 `/me/saves` → 403。
8. 被封禁用户：换 token 与刷新 token 都被拒。
9. 沙箱应用给非白名单用户授权 → 拒绝。
10. `/embed` 的签名过期 / 被改 app_id → 拒绝；`frame-ancestors` 头与登记域名一致。
11. 开放接口的游戏详情里不含 `hidden`、`arcade_romdata`、`dos_*` 等内部字段。
12. `/oauth/authorize` 的响应头带 `frame-ancestors 'none'`。
13. 开放接口的 CORS 放开到任意 Origin 之后，`/api/me`、`/api/admin` 的白名单**没有**跟着变松。

---

## 11. 明确不做

- 不发 ROM 直链，不提供「下载游戏」接口。
- 不开放 G 币的查询与增减。
- 不开放任何后台能力点（`content:edit` / `users:manage` / `site:manage` …）。
- 不做隐式流、密码模式、`prompt=none` 静默续期。
- 不允许第三方应用代替用户改邮箱、改密码、注销账号 —— 这些永远只在 8bitgo.com 上做。
