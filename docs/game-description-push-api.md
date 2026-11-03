# 游戏多语言简介推送 API

供豆包、OpenClaw 或自建 MCP 查询待补语言简介，并在外部完成翻译后将译文直接写入游戏后台。翻译由调用方完成；本站不调用模型，也不把密钥发给浏览器。

## 启用

在服务器 `server/.env` 配置一个独立的高熵密钥，然后重启 8BitGo：

```dotenv
GAME_DESCRIPTION_PUSH_TOKEN=<至少 32 字节的随机密钥>
```

可在可信终端生成密钥：

```bash
openssl rand -hex 32
```

不要把密钥粘贴进提示词、公开聊天或网页前端；不要复用 `JWT_SECRET` / `ADMIN_TOKEN`。未配置或密钥不合规时，接口会保持关闭。

## 查询待补简介

```http
GET https://8bitgo.com/api/integrations/game-descriptions?status=missing&limit=100
Authorization: Bearer <GAME_DESCRIPTION_PUSH_TOKEN>
```

默认只列出已绑定对应语言 ROM、但还没有人工本地化简介的游戏。每项也会附上英文简介（没有英文时回退中文）作为翻译源；响应中的 `text` 为 `null`，`missing` 为 `true`：

```json
{
  "items": [
    {
      "slug": "rallyprocontest",
      "lang": "ja",
      "text": null,
      "missing": true,
      "sourceText": "A rally racing game...",
      "sourceLang": "en",
      "translatable": true
    }
  ],
  "status": "missing",
  "lang": null,
  "limit": 100,
  "hasMore": false,
  "nextCursor": null
}
```

筛选参数：

- `status=missing`（默认）：只取未填写的语言简介。
- `status=filled`：只取已填写的语言简介，并返回当前 `text`。
- `status=all`：返回两类；每项含 `missing` 和 `text`。
- `lang=ja`：只看一种语言；可用值为 `zh-Hant`、`es`、`fr`、`it`、`de`、`ja`。
- `limit=1..200`：每页条数，默认 100。
- `cursor=<nextCursor>`：继续下一页。游标绑定了当前 `status` 和 `lang` 筛选，不要换筛选条件复用。
- `sourceText` / `sourceLang`：供 AI 翻译的原始简介及其语言；没有可用源简介时为 `null`，`translatable` 为 `false`。

## 写入一条简介

```http
PUT https://8bitgo.com/api/integrations/game-descriptions
Authorization: Bearer <GAME_DESCRIPTION_PUSH_TOKEN>
Content-Type: application/json

{
  "slug": "rallyprocontest",
  "lang": "ja",
  "text": "ゲームの日本語紹介文。"
}
```

成功响应：

```json
{
  "ok": true,
  "slug": "rallyprocontest",
  "lang": "ja",
  "characters": 12
}
```

`lang` 必须是本站已支持且该游戏已绑定 ROM 的语言：`zh-Hant`、`es`、`fr`、`it`、`de`、`ja`。简体中文和英文仍分别使用游戏的基础简介字段，不能通过此接口覆盖。`text` 是调用方已经翻译好的纯文本，最多 4000 个字符；同一游戏、同一语言再次调用会覆盖该语言旧简介，但不会动其它语言或游戏字段。

只有已绑定对应语言 ROM 的游戏才接受写入，以免生成没有对应可玩版本的独立语言页。保存后会使 SSR 内容缓存失效，并触发本站已启用的搜索引擎更新推送。成功响应只回传状态与字符数，不回显译文。

## 调用示例

```bash
curl --fail-with-body \
  -X PUT 'https://8bitgo.com/api/integrations/game-descriptions' \
  -H "Authorization: Bearer ${GAME_DESCRIPTION_PUSH_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"slug":"rallyprocontest","lang":"ja","text":"ゲームの日本語紹介文。"}'
```

把 `docs/game-description-push.openapi.json` 导入支持 OpenAPI 的 HTTP/MCP 工具时，认证方式选 HTTP Bearer。先调用 `listGameLocalizedDescriptions` 获取缺失项，再由模型翻译，最后调用 `pushGameLocalizedDescription` 写入。工具说明应要求模型只翻译 `status=missing` 返回的目标项，不要猜 slug 或语言。

## 错误

| HTTP | 含义 |
|---|---|
| 400 | slug、语言或简介内容不合法 |
| 401 | Bearer 密钥错误 |
| 404 | 游戏 slug 不存在 |
| 409 | 游戏未绑定该语言 ROM |
| 429 | 查询或写入频率过高，稍后重试 |
| 503 | 服务端未配置有效的推送密钥 |
