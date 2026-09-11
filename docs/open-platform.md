# 8BitGo 开放平台 · 接口设计

> 状态：**应用级那半已有可跑的骨架**（`/api/open/v1`，见文末「已落地的部分」）；
> 用户级（OIDC 授权码 + PKCE）仍是设计稿。
> 一旦发出去的 appkey 有人在用，协议就改不动了 —— 所以先争论文档，别先写代码。
>
> **2026-09-11 修订**：站长要求开放 ROM。原方案的「ROM 不出站」被推翻，改为
> **短期签名凭据**（§4.3）。这是本文档唯一一次方向性改动，前后的理由都留着，别再来回翻。

面向的两件事：

1. **用 8BitGo 账号登录第三方网站** —— 8BitGo 做身份提供方（OIDC Provider）。
2. **调用 8BitGo 的游戏资源** —— 游戏元数据 + 可嵌入的播放器。

已定的边界（`2026-09` 与产品确认，ROM 一行于 `2026-09-11` 修订）：

| 项目 | 结论 |
|---|---|
| 游戏资源 | 元数据 + 封面 + 可嵌入播放器 + **ROM（短期签名凭据，单独 scope、单独审核）** |
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
| 拿到 key | **创建时当场发**，明文只显示一次 | 同一把，不用换 |
| 可用 scope | 只有 `games.read` | 审核人批的那些 |
| 回调地址 | 最多 3 个，允许 `http://localhost` | 最多 10 个，**仅 https** |
| 可授权用户 | 仅应用所有者本人 + 最多 5 个测试账号 | 不限 |
| QPS | 5 | 50（按 tier 可调） |
| 日调用量 | 10 000 | 200 000（按 tier 可调） |
| 云存档写 | 100 次/日 | 按 tier |
| 嵌入播放器 | 可用，页面带「沙箱」水印 | 无水印 |

⚠️ **沙箱限定授权对象，是这套「先沙箱后审核」模型的立足点**，不是配额优化：
没有它，一把没审过的 key 就能拿去向任意用户请求授权（钓鱼）。
每个账号最多 10 个应用；创建有按账号的限流，而且**额度比这个上限宽** ——
两者一样的话，用户永远撞不到「最多 10 个」那句提示，他先撞上「建得太频繁」，
而这两句话的下一步动作完全不同（「等一小时」 vs 「先删一个」）。

### 1.4 申请与审核（2026-09-11 实现）

```
                        ┌─────────────── 申请人（登录用户） ───────────────┐
  建应用 ──当场──> sandbox + 一把 key（明文只显示一次）
                          │  approved = games.read        ← 自助只给这一个
                          │  requested = 他勾的全部        ← 其余等审
                          ├─ 加测试账号（≤5）、改资料、轮换 key
                          └─ 提交上产申请（用途说明 ≥30 字）
                                    │
                              sandbox + pending          ← ⚠️ 沙箱**照旧可用**
                                    │
        ┌───────────── 审核人（apps:review，当下只给 admin）─────────────┐
        ├─ 通过（可只批一部分 scope）──> live + approved = 批的那份
        └─ 打回（理由必填，原样给申请人看）──> sandbox + rejected
                                              └─ 改完可以再提交
        任意时刻：停用 ──> suspended ──恢复──> **回到停用前那一档**
```

**两个状态字段，不是一个枚举**（`status` = 能力，`review_state` = 流转）。
合成一个看着更简单，但会丢掉一件事：*正在申请上产的应用仍然是可用的沙箱应用*。
合并之后 `status === 'pending'` 那一刻，所有「这个应用能不能用」的判断都得跟着改，
而漏改一处的症状是「提交申请之后沙箱突然不能用了」。

几条硬规则（全在 `server/src/open/review.js`，纯函数、有测试）：

| 规则 | 不这么做会怎样 |
|---|---|
| 自助只发 `games.read`，其余一律进 `requested_scopes` | 注册个号就能领 ROM 凭据，审核这层当场作废 |
| **审核中锁住** `requested_scopes` / 回调 / 嵌入域名 / 客户端类型 | 提交后把 scope 换成 `saves.write` —— **审的是 A，批的是 B** |
| 名字、简介、logo **不锁** | 填错一个字要先撤回申请 |
| 批准的 scope **可以少于、不能多于**申请的 | 批了人家没申请的东西：他不知道自己有，出事时说不清是谁要的 |
| 打回**不动** `approved_scopes` | 被打回一次，连沙箱调试环境一起没了 |
| 打回 / 停用**理由必填**，原样显示给申请人 | 没有理由的「已拒绝」只换来一次一模一样的重新提交 |
| 恢复回到**停用前那一档** | 从沙箱被停用的应用，恢复之后直接进生产 —— 绕过了审核 |
| 上产要求 https 回调（沙箱的 `http://localhost` 不能带上产） | 授权码被重定向到某人本机的任意端口 |
| 每一个动作写一条 `oauth_app_reviews` | 「这把 key 当初凭什么发的」事后查不出来 |
| 别人的应用一律 **404，不是 403** | 403 顺带确认了「这个 id 存在」，而 id 是可以枚举着试的 |
| 撤销最后一把有效 key 要挡下 | 应用彻底取不到令牌，而界面上看不出为什么 |

**为什么是「先沙箱后审核」而不是「审核通过才发 key」**（站长 09-11 拍板）：
后者让开发者在审核前一行代码都跑不了，于是申请单上写的只能是意向（「我想做个聚合站」），
而你无从判断 —— 批或不批都是猜。先给沙箱之后，你审的是能查证的三件事：
**主页打不打得开、回调/嵌入域名是不是他自己的、勾的权限和他说的事对不对得上**。
而「拿 key 去钓鱼」这条路在审核前也走不通 —— 沙箱应用只能向白名单账号请求授权
（`apps-repo.js` 的 `canAuthorize`，OIDC 同意页实现时**必须**调它）。

### 1.5 两个页面

- **`/open`** —— 开发者控制台：建应用、拿 key、轮换、加测试账号、提交上产、看审核记录。
  ⚠️ **不叫 `/developers/apps`**（早期设计稿里的路径）：`/developers` 已经是站内的
  「开发商」浏览页（科乐美、SNK 那种）。两个 developer 完全不是一回事，挂一起只会两边都难认。
  入口在页脚。
- **`/admin/open-apps`** —— 审核队列：默认只看待审、**按提交时间正序**（先交的先审，
  倒序会让早上交的那一份永远压在下面）。敏感 scope 直接标在标题行，
  key 的「最近使用时间」摆在详情里 —— 那是判断「他真的接了吗」最直接的证据。

这两页**刻意都是中文**（和 `/admin` 一样不走 i18n）：它们管理的东西本身只有中文一份 ——
这份设计稿、scope 的语义说明、服务端的 OAuth 错误体。给页面翻八种语言而文档还是中文，
是一种更糟的体验。等有了对外文档站再一起做（记在第 12 节的待办里）。

### 1.6 `/me/authorized-apps`（还没做）

用户侧：看自己授权过哪些应用、各自拿了什么 scope、一键解除。
**这一页必须和 OIDC 同期上线**，不能等 P3 —— 用户能授权却不能撤销，是不能接受的。

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
| `games.rom` | **ROM 的短期下载凭据** | —（应用级） | P0.5，**需人工审核** |
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
- ⚠️ **`games.rom` 绝不能并进 `games.read`**。两者的风险不在一个量级：前者是
  「把整库游戏本体带出站」，后者是「读一段简介」。合并的后果是，一个只想展示游戏列表的应用
  会顺带拿到全库 ROM 的下载权 —— 那不是授权，那是疏忽。
  代码里这是两个不同的 `requireApp(scope)`，测试里有一条专门验「`games.read` 要不到 ROM」。
- ⚠️ 已获批的 scope 里可能同时有应用级和用户级（一个既做登录又展示游戏库的应用很常见）。
  `client_credentials` 只能拿到其中的**应用级**那部分 —— 背后没有用户，一枚带 `profile` 的
  应用级令牌拿去调用户接口时，`sub` 会是 client_id，那是一个不存在的用户。

---

## 4. 游戏资源

应用级，`Authorization: Bearer <app access token>`。令牌用 **AppID + key** 换：

```
POST /api/open/v1/token
Content-Type: application/json

{ "grant_type": "client_credentials",
  "client_id": "app_0123456789abcdef01234567",
  "client_secret": "…",
  "scope": "games.read games.rom" }        ← 可省；省了就给「已获批 ∩ 应用级」的全部

→ { "access_token": "eyJ…", "token_type": "Bearer", "expires_in": 900,
    "scope": "games.read games.rom" }
```

`Authorization: Basic base64(client_id:client_secret)` 也认 —— 现成的 OAuth 库默认发这一种，
只支持 body 里那种的话，接入方会卡在一个「照文档写了却 401」的地方。

⚠️ **认不出来一律回同一句话**（`invalid_client`，连响应体都一样）：区分「没这个应用」和
「key 不对」，这个端点就顺带变成了 AppID 探针。

### 4.1 元数据与多语言

| 端点 | 说明 |
|---|---|
| `GET /v1/games` | 分页列表。`platform` / `genre` / `q` / `sort` / `page` / `page_size≤50` / `lang` |
| `GET /v1/games/{slug}` | 详情 |
| `GET /v1/me` | 这枚令牌是谁的、有哪些 scope、什么时候过期（排错的第一站） |

**多语言：`?lang=` 给一门，外加一个「实际是哪一门」。**

```
GET /api/open/v1/games/contra?lang=fr

{ "slug": "contra",
  "title": "Contra",
  "description": "Two commandos versus aliens.",
  "lang_requested": "fr",
  "lang_actual": { "title": "und", "description": "en" },   ← ⚠️ 这一栏是关键
  "platform": "nes", "genres": ["action"], "tags": ["经典"],
  "year": 1987, "developer": "Konami", "players": 2, "multiplayer": true,
  "icon": "🎮",
  "cover": "https://assets.8bitgo.com/covers/contra.jpg",
  "rating": 4.5, "rating_count": 9, "plays": 120,
  "added_at": "1987-02-20", "updated_at": "2026-02-01T00:00:00.000Z",
  "adult": false,
  "rom_langs": ["*", "ja"] }
```

为什么不是「把八种语言一次全发出去」：库里的译文是**残缺的，而且残缺得不均匀** ——
`title_i18n` 只有 `zh-Hant` 一个键（非中文界面刻意用原名），`description_i18n` 按需生成、
es/fr 目前整门是空的（见项目记忆「多语言正文其实是同一份」）。把这么一张稀疏表原样发出去，
等于把「该退到哪一门」这个**只有我们知道**的规则丢给接入方猜。他多半会写成
`i18n[lang] ?? title`，于是繁体读者看到简体、法语读者看到中文，而我们站内其实是退到英文的。

回退链（和站内 `src/services/i18nData.ts` **逐格一致**，有测试两边都跑一遍比对）：

| 请求 | 标题 | 简介 |
|---|---|---|
| `zh-Hans` | `title_zh` → `title` | `description` |
| `zh-Hant` | `title_i18n['zh-Hant']` → `title_zh` → `title` | `description_i18n['zh-Hant']` → `description` |
| `en` | `title`（原名） | `description_en` → `description` |
| 其余 6 门 | `title`（原名） | `description_i18n[lang]` → `description_en` → `description` |

- `lang_actual` 里的 `und` = 游戏原名，没有语言可言（`Contra` / `魂斗羅` 都可能）。
  接入方拿它决定要不要显示「暂无译文」、页面该打什么 hreflang。
- **不传 `lang` 时默认 `en`**，刻意和站内的 `zh-Hans` 不同：调用方是第三方开发者，
  默认给中文只会让没读文档的人以为「这库全是中文」。用站内 hreflang 的 x-default 一致。
- 认不出来的语言码（`pt-BR`）退到默认，**不报 400** —— 一个拼错的语言码不该让整次请求失败。

**封面**永远是绝对地址，给不出来时是 `null`。**绝不发对象 key 原文** ——
那是内部寻址，泄露它等于把存储结构和其它文件的位置一起送出去。

**成人内容（`adult`）整体排除**，除非应用单独申请并过审。默认排除而不是默认包含：
接入方不会想到要过滤，而我们知道它存在。下架的游戏对外**不存在**，和「没这款」同一个 404 ——
区分开就成了「这游戏是不是被下架了」的查询器。

### 4.2 ⚠️ 对外的形状必须单独一层 mapper

`server/src/mappers.js` 的 `gameRowToApi` 是**给站内前端用的**，它的前提是「调用方是自己人」，
所以原样带着 `hidden`、`arcade_romdata`、`dos_*`、以及 **ROM 和封面的对象 key 原文**。
把它直接发给第三方，等于把前面那一整套签名凭据绕过去。

所以对外走 `server/src/open/mapper.js`，而且是**白名单**：想加字段必须在那个文件里显式写一行。
反过来（黑名单「删掉几个不该给的」）在这种地方是错的做法 —— 明天 `games` 表加一列，
黑名单不会报错，它会直接把新列发出去。测试里有一条逐个断言 `FORBIDDEN_OUT_KEYS` 都不在响应里。

### 4.3 ROM：短期签名凭据（2026-09-11 推翻了原来的「不出站」）

```
GET /api/open/v1/games/contra/rom?lang=ja      （scope: games.rom）

→ { "url": "https://8bitgo.com/api/open/v1/rom/eyJhIjoi…～.Xk9…",
    "expires_in": 300,
    "lang_requested": "ja",
    "lang_actual": "ja",
    "filename": "contra-ja.zip" }
```

凭据是 `base64url(JSON).base64url(HMAC-SHA256)`，**自包含、不落库**（寿命只有五分钟，
落库就要配清理和同步）。里面绑死四样东西：

| 绑什么 | 防的是什么 |
|---|---|
| `app_id` | 转手给别人也查得出是从哪把 key 漏出去的 |
| `slug` + 对象 key | 换个 slug 就验不过 —— 不能拿一张票下整库 |
| `exp`（5 分钟） | 抄走地址的窗口就是这么长 |
| 随机串 `n` | 同一分钟反复领票也各不相同，便于按票追踪单次下载 |

兑现地址 `GET /v1/rom/{grant}` **不要求 Bearer**：凭据自己就是授权，而下载多半发生在
浏览器或 curl 里，带不上 Authorization 头。兑现时 302 到存储地址（几十上百 MB 的东西
没必要全走源站带宽），响应带 `Cache-Control: private, no-store`。

**ROM 的语言不做跨语言回退**：要日文、没有日文，就给通用件（`*`）或者 404，
**绝不悄悄发一份别的语言的**。玩家开进去是另一套文字，而接入方无从得知 ——
他要的是 `de`，我们回 200，他没有任何理由去怀疑。

`rom_langs` 这一栏（元数据里就有）**只报语言码、不报 key**，没有 `games.rom` 的应用也看得到：
它是「这款有没有日文版」的展示信息，不是下载凭据。

#### ⚠️⚠️ 这层签名现在还不是真的门 —— P-1 必须先做

`assets.8bitgo.com` 目前是**公开读**的对象存储：任何人打开一次游戏、从网络面板抄走 ROM 地址，
就能无限次直接下载，**跟有没有 appkey 毫无关系**。所以在把 ROM 写进对外承诺之前必须先做：

1. ROM 对象改为**不可公开读**，只能经 Worker（`worker/`）或 R2 预签名取；
2. 兑现那一步把 302 的目标换成预签名地址（调用方无感，只改我们这一侧）；
3. **站内播放器同步改造** —— 它现在也是直接拿公开地址的。

在 P-1 完成之前，这套凭据只是「我们不主动给」，**别对外宣传成访问控制**。
第一个认真的接入方会在半小时内发现「其实我不用你的凭据也能拿到 ROM」。

#### 版权与计量

- ROM 一律**逐个应用人工审核**（`games.rom` 是敏感 scope，自助创建拿不到）。
  审的不是技术，是「这家凭什么分发这些文件」。
- ROM 单独一层配额（默认 600 次/小时/应用），和元数据那层分开：这是整套接口里
  唯一按 GB 计费的东西。
- 想更进一步（按款控制哪些 ROM 可分发），加一列 `games.rom_open` 逐款勾选 ——
  设计上留了位置，本期不做。

### 4.4 嵌入播放器

```
GET /api/open/v1/games/kof97/embed?lang=zh-Hans
→ { "url": "https://8bitgo.com/embed/kof97?a=app_xxx&e=1788600000&s=<hmac>&lang=zh-Hans",
    "expires_in": 3600,
    "allow": "fullscreen; gamepad; autoplay; clipboard-write" }
```

- `/embed/:slug` 是一个新的整页外壳，照抄 `server/src/routes/play.js` 的思路：
  不走 SSR、不引 React、不引任何第三方资源 —— 跨源隔离头（COOP/COEP）会掐掉外部资源，
  内容越少越安全。区别是它多一个 8BitGo 角标和签名校验。
- 签名用 `OPEN_EMBED_SECRET`，**不是** app secret（库里只有 secret 的 bcrypt 哈希，我们自己都签不出来），
  也**不是** ROM 那把 —— 一把密钥泄露不该把另一件事一起带走，而且两者的吊销节奏完全不同。
- **防盗链靠 `frame-ancestors`**：`/embed/*` 的响应头带
  `Content-Security-Policy: frame-ancestors <该应用登记的嵌入域名>`。这是浏览器强制的，
  比 Referer 判断可靠得多。Referer / `Sec-Fetch-Site` 只作为服务端侧的弱校验和用量归因。
- 嵌入域名与 OAuth 回调域名**分开登记**：一个网站可能只嵌游戏不接登录，反过来也一样。
- 想让嵌入的游戏带上玩家身份（存档、收藏），在 URL 上再挂一个短期的用户票据，
  由 `/embed` 页换成会话 —— 不要直接把 access token 放进 iframe 地址，它会进浏览器历史和 Referer。

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
# 开放平台的签名密钥。三把各司其职，**一把都不能复用**，也都与 JWT_SECRET 无关
OPEN_JWT_PRIVATE_KEY_PATH=   # RS256 私钥（PEM）。签 access token
OPEN_JWT_KID=                # 轮换时靠它区分，JWKS 里同时挂新旧两把
OPEN_ROM_SECRET=             # ROM 短期凭据的 HMAC 密钥
OPEN_EMBED_SECRET=           # 嵌入地址的 HMAC 密钥
OPEN_ISSUER=https://8bitgo.com
```

生成私钥：`openssl genpkey -algorithm RSA -pkcs8 -out open-jwt.pem -pkeyopt rsa_keygen_bits:2048`

⚠️ **配不全就整块关掉**（501），不要用空密钥把接口跑起来 ——
「跑起来了但签名谁都能伪造」是最坏的一种状态：看着正常，没人会去查。
`OPEN_ROM_SECRET` 没配时 ROM 那两个端点单独 501，其余照常。

---

## 9. 分期

| 阶段 | 内容 | 完成的标志 | 状态 |
|---|---|---|---|
| **P0.1** | 应用级令牌（AppID + key）+ `games.read` + 对外 mapper | 一把 key 能列出游戏，且响应里没有任何内部字段 | **已落地** |
| **P0.2** | 申请 / 审核（`/open` + `/admin/open-apps` + `apps:review`）| 一个玩家能自助建应用拿到沙箱 key，管理员能批上产 | **已落地** |
| **P-1** | ROM 私有化 + 预签名发放 | **直接拿 ROM 地址下不到东西** | 未做（阻塞对外承诺 ROM） |
| **P0** | OIDC（`openid/profile/email`）+ `/me/authorized-apps` | 一个外部站点能用 8BitGo 账号登录并看到昵称 | 未做 |
| **P0.5** | `games.rom` 审核流 + 嵌入播放器 + `frame-ancestors` | 外部站点能列游戏、嵌进去玩、按票下 ROM | 部分（凭据已通，`/embed` 外壳未做） |
| **P1** | `library.read/write` | 收藏在两边同步 | 未做 |
| **P2** | `saves.read/write` + 独立配额 | 进度在两边同步，且写坏了能查到是哪个应用 | 未做 |
| **P3** | 上产审核流、用量面板、开发者文档站 | 可以对外宣传 | 未做 |

⚠️ **P-1 是对外承诺 ROM 的前提**，不是可选项。凭据那一层已经写完了，但只要对象存储还是
公开读，它就只是一道礼貌的门。顺序上可以先给少数几家白名单接入方试用，
但**在 P-1 之前不要在任何对外文档里写「ROM 受保护」**。

---

## 10. 测试

`cd server && npm run test:openapi` —— 真的起一个 express、真的签真的验：
db.js 换成内存假库，RSA 密钥当场生成，路由挂的是真的 `routes/open.js`。

已经在跑的（**每一条都做过变异检查**：把那道闸手动去掉，确认测试真的红，再还原）：

1. ⚠️ 站内 JWT 进不了开放接口；开放平台令牌进不了 `verifyToken`；**两个方向都断言**。
2. ⚠️ 带 `aud`/`scope`/`cid` 的 HS256 令牌站内一律拒绝（纵深防御那一条）。
3. ⚠️ 算法混淆：拿**公钥**当 HMAC 密钥签的令牌必须被拒。
   （jsonwebtoken 9 自己就拦得住，所以这条行为测不出差别 —— 用源码断言守住白名单，
   理由写在测试里。**源码断言前先剥注释**，不然文件头那段说明会让它假绿。）
4. ⚠️ 没有 `typ=at+jwt` 的令牌不算 access token（同一把私钥将来还要签 id_token）。
5. AppID + key 换令牌；Basic 那种写法也认；key 错和应用不存在回**同一个响应体**。
6. ⚠️ scope 超出已获批 → `invalid_scope`，**不静默降级**；用户级 scope 不能用
   client_credentials 取；不传 scope 时也只给应用级那部分。
7. ⚠️ 对外响应里不含 `FORBIDDEN_OUT_KEYS` 里的任何一个；ROM / 封面的对象 key 原文不出现。
8. ⚠️ 多语言按 `lang` 返回 + `lang_actual`；**回退链与站内 `i18nData.ts` 逐格比对**
   （两边各跑一遍，漂了就红）。
9. ⚠️ `games.read` 要不到 ROM；ROM 凭据不含对象 key、分钟级过期、改一个字节就失效；
   过期兑现回 410、伪造回 403；合法兑现 302 且 `no-store`。
10. ⚠️ ROM 不做跨语言回退：只有日文版时要德文必须 404。
11. 下架的游戏：详情、ROM、嵌入**三条路各测各的**（它们查的不是同一条 SQL）。
12. ⚠️ 开放接口 CORS 放开到任意 Origin，而站内白名单**没有**跟着变松。

用户级那半（OIDC）实现时要补的：

13. `redirect_uri` 差一个斜杠 / 差 www / 多一个查询参数 → 全部拒绝。
14. 没有 `code_challenge` → 拒绝；`plain` → 拒绝；`code_verifier` 对不上 → 拒绝。
15. 授权码用第二次 → 拒绝，**且该用户在该应用下的 refresh token 全部失效**。
16. 用已轮换掉的 refresh token → 拒绝并吊销整条链。
17. 只有 `profile` 的 token 调 `/me/saves` → 403。
18. 被封禁用户：换 token 与刷新 token 都被拒。
19. 沙箱应用给非白名单用户授权 → 拒绝。
20. `/oauth/authorize` 的响应头带 `frame-ancestors 'none'`；`/embed` 的与登记域名一致。

---

## 11. 明确不做

- 不提供**批量导出**（「把你们全库的元数据/ROM 打个包给我」）。逐个 slug、逐张票、逐次计量，
  是这套东西能追责的前提。
- 不发**永久** ROM 直链，不发对象存储的 key 原文。ROM 只经分钟级凭据。
- 不开放 G 币的查询与增减。
- 不开放任何后台能力点（`content:edit` / `users:manage` / `site:manage` …）。
- 不做隐式流、密码模式、`prompt=none` 静默续期。
- 不允许第三方应用代替用户改邮箱、改密码、注销账号 —— 这些永远只在 8bitgo.com 上做。

---

## 12. 已落地的部分（2026-09-11）

应用级那半有可跑的骨架，用户级（OIDC）仍只有设计。

```
server/src/open/
  scopes.js     scope 表、子集判定（纯函数）
  i18n.js       lang 规整 + 标题/简介/ROM 的回退链（纯函数）
  tokens.js     RS256 签发与验证。**两种令牌互不相认的那一半**
  sign.js       ROM 凭据与嵌入地址的 HMAC 短期签名（纯函数）
  mapper.js     对外形状的白名单 + FORBIDDEN_OUT_KEYS
  apps.js       AppID + key 的校验（bcrypt，支持两把并存轮换）
  config.js     三把密钥的读取；配不全就整块关掉
  review.js     ⭐ 申请 / 审核状态机（纯函数）—— 第 1.4 节那张表的全部规则都在这儿
  apps-repo.js  应用的读写、发 key、留痕、沙箱白名单
server/src/routes/
  open.js             /api/open/v1（第三方用 key 调，CORS 放开到任意 Origin）
  open-apps.js        /api/open-apps（**站内**：开发者管自己的应用，登录态）
  admin-open-apps.js  /api/admin/open-apps（审核，权限点 apps:review）
src/pages/OpenPlatformPage.tsx   /open 开发者控制台
src/admin/AdminOpenApps.tsx      /admin/open-apps 审核队列
src/services/openApps.ts         两套端点的客户端
server/scripts/test-openapi.mjs    npm run test:openapi    （28 项）
server/scripts/test-open-apps.mjs  npm run test:open-apps  （32 项）
```

⚠️ **`/api/open` 和 `/api/open-apps` 是两套东西，别混**：前者是第三方拿 key 调的
（CORS 任意 Origin、RS256 令牌），后者是本站用户管理自己应用的页面接口（登录态 + 站内 CORS）。
把后者挂到 openRouter 下面会顺带把「建应用、轮换密钥」也放开到任意 Origin ——
那等于任何网站都能拿着受害者的登录态替他建应用。测试里有一条守着这件事。

连带改动：

- `server/src/auth.js` 的 `verifyToken` 收紧（算法白名单 + 拒绝带 `aud`/`scope`/`cid` 的令牌）。
  这是第 0 节那条铁律的站内一半，**不做的话开放平台再小心也没用**。
- `server/schema-v2.sql` 与 `server/scripts/migrate.mjs` 加了第 7 节那五张表。
  ⚠️ 另外四份 schema（`schema.sql` / `schema-d1.sql` / `8bitgo-v2-install.sql` /
  两份 `8bitgo-setup*.sql`）**还没同步** —— 上线前按仓库惯例补齐。

连带改动（这一轮）：

- `shared/roles.js` 加了权限点 **`apps:review`**（只给 admin）。顺手修了一个既有漂移：
  手写的 `shared/roles.d.ts` 少了 `collections:review` —— 前端引用那个权限点时 TS 会报
  「不可赋值」，于是很容易被人用 `as` 断言绕过去，而那一刀下去整张权限表在前端就不再受
  类型保护了。`test:roles` 现在有一条断言守着 d.ts 和 ABILITIES 一致。
- `oauth_apps` 加了 8 列（`review_state` / `requested_scopes` / `review_note` /
  `review_reason` / `submitted_at` / `reviewed_by` / `reviewed_at` / `suspended_from`），
  新增 `oauth_app_reviews`（审核流水）和 `oauth_app_testers`（沙箱白名单）。
  migrate 的补丁**逐列判断**，不是一条 ALTER 加八列 —— 一条失败会让后面七列一个都加不上。

还差的（按优先级）：

1. **P-1**：ROM 私有化（见 4.3），这是对外承诺 ROM 的前提。
2. OIDC 那半：`/oauth/authorize` 同意页、`/api/oauth/token`、JWKS、`/me/authorized-apps`。
   ⚠️ 同意页**必须**调 `apps-repo.js` 的 `canAuthorize` —— 沙箱应用只能向白名单账号
   请求授权，那是「先沙箱后审核」模型唯一的防钓鱼屏障。
   ⚠️ 「用户能授权却不能撤销」是不能接受的，`/me/authorized-apps` 必须同期上线。
3. `/embed/:slug` 外壳与 `frame-ancestors`；沙箱水印。
4. 全站基础安全头（`/oauth/authorize` 必须 `frame-ancestors 'none'`，见第 6 节）。
5. 用量曲线（控制台和审核页都想要「他这周调了多少次」）。现在只有 key 的
   `last_used_at` 能当一个粗糙的「有没有真的在用」。
6. 两个页面的 i18n（见 1.5：等对外文档站一起做）。
7. 申请状态变化时发一封邮件（现在只能靠他自己回控制台看）。Resend 已经接好了，
   见 [[发信与功能开关]]。
8. 另外四份 schema 同步（`schema.sql` / `schema-d1.sql` / `8bitgo-v2-install.sql` /
   两份 `8bitgo-setup*.sql`）。
