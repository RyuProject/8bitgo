# 8bitgo-roms · 审计修复版

审计日期：2026-09-20。原包两个 Worker 的接口、桶绑定和兼容日期保留；重点修复错误请求误删/覆盖最终对象、跨桶分页、续传故障恢复、HTTP 条件请求及资源反代边界。

**这是经过离线回归的部署候选，不是 Cloudflare 线上验收结果。** 详细证据、性能取舍和剩余风险见 `AUDIT.md`。没有接入或修改你的 Cloudflare 账户、R2 数据和域名路由。

## 文件与使用方式

`src/index.js` 是 ROM Worker 入口，同时依赖 `src/common.js`、`src/http.js`；必须一起部署。`embed-vc/` 是独立的游戏静态托管/反代 Worker，不要将两个入口混用。

使用 Wrangler 时保留整个工程。使用控制台单文件编辑器时，使用完整的 `standalone/rom-worker.js`；它由上述三个模块生成，没有外部 import。`standalone/embed-worker.js` 对应另一个 Worker，但仍需要配置 `ASSETS`、变量和静态资源。不要在控制台直接只粘贴模块化 `src/index.js`。

## 本地检查

需要 Node.js 22 或更新版本。运行时代码没有第三方依赖；测试使用 Node 内置工具，不必先执行 npm install。

```bash
cd worker
npm run check
npm test
npm run test:original
npm run benchmark
npm run build:standalone
```

`npm test` 是离线模型测试。`test:original` 在本地夹具中对照原版与修复版；`benchmark` 只统计 R2 调用和数据读取次数，不测量真实云延迟。`tests/original/` 是供比较的未修复原代码，不能作为部署入口。

## 部署

先使用测试桶和独立测试 Worker 名称验证；确认后再恢复生产名称发布。下列命令会实际访问 Cloudflare，请在自己的环境中执行：

```bash
cd worker
npx wrangler login
# 已有 ADMIN_TOKEN 时不用重设；新部署需要通过 secret 配置。
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy --dry-run
npx wrangler deploy
```

原配置保留 `ROMS → 8bitgo`、`COVERS → 8bitgo-image`，`compatibility_date = "2026-01-01"`。缺省无 COVERS 的旧部署仍回退 ROMS。部署前核对控制台已有变量、Secret、路由和桶名称，不要把生产 ADMIN_TOKEN 写到公开仓库、前台构建变量或请求 URL。

网站可继续把 ROM Worker 地址用作 `VITE_ROM_BASE_URL` 或后台 ROM 存储服务地址。公开读取仍无需口令；修改、列表和上传仍只接受 `Authorization: Bearer <ADMIN_TOKEN>`。CORS 不是权限控制，不阻止非浏览器请求。

## 接口（原有路径保留）

| 方法与路径 | 用途 |
|---|---|
| `GET/HEAD /ping` 或 `/` | 健康检查，保留 writable / multipart 字段 |
| `GET/HEAD /<key>` | 公开读取；ETag、条件请求和单段 Range |
| `PUT /<key>` | 单次上传；需要 Bearer |
| `DELETE /<key>` | 删除最终对象；需要 Bearer |
| `POST /bulk` | `{ "keys": [...] }`，1～1000 个合法 key，去重后按桶批量删除 |
| `GET /list?prefix=...&cursor=...` | 管理员分页列表 |
| `POST /<key>?uploads` | 新建分片；JSON 可含 contentType、size、name |
| `PUT /<key>?uploadId=<非空ID>&partNumber=<编号>` | 上传一片 |
| `POST /<key>?uploadId=<非空ID>` | 合并；JSON 含 parts 数组及可选 marker |
| `DELETE /<key>?uploadId=<非空ID>&marker=<可选标记>` | 中止分片，成功后清理对应标记 |
| `GET /multipart?cursor=...` | 管理员分片标记列表 |
| `DELETE /multipart?marker=...` | **仅删除标记，不中止实际分片**；独立管理动作 |

分片参数一旦出现，必须完整且与方法匹配。空 uploadId、缺少 uploadId 的 partNumber、重复参数等返回 400，**不再降级为普通 PUT/DELETE**。这是防止把一个分片写到最终对象或误删完整文件的必要变化。

## 上传、续传与失败处理

单次 PUT 的 `MAX_UPLOAD_MB` 默认 512，单位实际为 MiB；这只是应用上限，不能绕过 Cloudflare 的入口请求体上限。有 Content-Length 时走定长流，长度缺失时使用有界缓冲，单次未知长度上传上限为 `min(MAX_UPLOAD_MB, 32 MiB)`。分片仍最多 32 MiB；前端原来采用的 8 MiB 分片方案可以保留。

平台文档截至审计时列出的入口请求限制：Free/Pro 100 MB、Business 200 MB、Enterprise 可自助调至 5 GB；超限可返回 413，不能将所有网络错误归咎于固定的连接 reset。具体以账户、域名配置和最新平台文档为准。[1]

已知长度流使用 Cloudflare `FixedLengthStream`，不先调用 request.arrayBuffer()；未知长度请求为了兼容 R2 仍会有有界内存分配，并非所有输入都是零拷贝。Workers 的 128 MB 内存限制针对 isolate，多个并发请求可能共享它；前端仍应限制上传并发。[1][2]

发生 `503` 且 `retryable:true` / `fatal:false` 时保留 uploadId、marker、已完成分片的 etag，做有次数上限的指数退避，不要清空进度。只有明确识别为 NoSuchUpload 才返回 fatal=true；未知错误不擅自宣布会话失效。一般参数错误仍为 400/413。

`complete` 成功但 `markerRemoved:false` 表示最终对象已经生成，只需清理标记，不能重新上传来“修复”。`abort` 失败会保留标记；标记写入和补偿 abort 同时失败时，返回 cleanupRequired 和会话身份供管理端处理。

`MAX_UPLOAD_MB` **不是整个 multipart 会话的总大小配额**。create 中的 size 是展示信息，完整会话额度、租户限额和全局并发控制尚未实现。合并成功但客户端丢失响应的跨请求幂等恢复也未实现。前端继续保管完整的 partNumber / etag 列表；这份包没有网站前端或后台上传器。

新标记 `_uploads/v2-<SHA256>.marker` 可按 key 和 uploadId 直接定位。旧随机标记兼容：优先验证客户端给定 marker，否则逐页搜索，最多 24 页；达到预算时返回清理未完成，不伪装“找不到就是已删除”。R2 默认会自动中止一定时间内未完成的分片，文档默认值为 7 天，但标记对象本身仍需管理；核对桶的实际生命周期配置。[3]

## 分页与删除的兼容变化

`/list` 与 `/multipart` 使用 `v2.` 复合 cursor，分别保存各桶位置。前端把 cursor 视为不透明字符串，URL 编码后原样传回，按 `truncated` 决定是否继续，**不要根据数组为空或少于 1000 条就提前结束**。旧版 cursor 失效后从第一页重新读取即可，不要删除 R2 对象。[3]

返回行新增 `bucket` 字段。同一 key 在两个桶是两个物理对象，可能返回两行；未做逻辑去重或跨页全局时间排序。前端若要合并展示，应明确覆盖优先级，不要把重复 key 误判成同一记录。

删除 `covers/...` 现在同时删除 COVERS 当前副本与 ROMS 中的迁移副本，避免删完回退读出旧封面。普通 ROM 仍只删 ROMS。此操作不是跨桶事务；部分失败返回 503 及 deleted/failed 列表，按 failed 重试。若业务只是迁移并保留旧副本，请不要把该删除接口当迁移工具。

## 缓存和范围读取

缓存分两档，判据是**请求 URL 有没有版本戳**（不是 key）：带 `?romv=<etag>` / `?v=` 走
`VERSIONED_CACHE_CONTROL`（默认浏览器 1 天 / 边缘 30 天），其余走 `OBJECT_CACHE_CONTROL`
（默认 `public, max-age=300, s-maxage=600, must-revalidate`）。

为什么分档而不是一刀切：

- ROM 的播放地址由前端按对象 ETag 拼上 `?romv=`（`src/services/roms.ts` 的 `probeRomUrl`），
  覆盖同名对象后 URL 跟着变，属于内容寻址 —— 长缓存是安全的。
- 封面 / 视频 / logo 的地址没有版本戳（`romUrlForKey` 只拼 `covers/xxx.webp`），而后台替换封面时
  **故意复用同一个 key** —— 长 TTL 的后果是「管理员换了封面，玩家看到的还是旧图」。
  300s/600s 这个窗口能吃掉一次浏览会话里的重复请求，同时把「换封面多久生效」压在 10 分钟内。
- 所以**不要**盲目恢复「对所有 key 生效的长缓存」；要恢复，先让封面也变成内容哈希 key。

两档都能用 `OBJECT_CACHE_CONTROL` / `VERSIONED_CACHE_CONTROL` 覆盖，不必改代码重新部署。[4]

历史浏览器/CDN 缓存和 R2 自定义域名的缓存不会因部署自动消失，需要按资源更新版本或失效缓存。Worker 默认策略也不能覆盖另一个直连 R2 域名已有对象的旧 metadata。

不带 Range 和条件头、首次查找即命中的普通 GET 仍只调用一次 R2 get。Range/条件请求一般先 head 再按 ETag 读取：是正确性换取额外一次存储调用；若对象被并发覆盖最多重试 3 次。If-Range 仅强 ETag 匹配时继续分段；弱 ETag、日期形式无法确认强验证能力时保守返回完整 200。多段 Range 未实现，返回完整内容；有效但不可满足的单段返回 416。[3][4]

## 公开域名替代方案

可继续用 R2 自定义域名公开读取，Worker 只承担管理接口；独立配置该域名的 CORS、缓存和访问规则。直接访问 R2 域名不会自动执行此 Worker 的鉴权、范围修复、封面回退或缓存策略。是否选择这种部署结构需要与前端 URL 配置一起验证。

## 官方依据

[1] https://developers.cloudflare.com/workers/platform/limits/
[2] https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/
[3] https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
[4] https://www.rfc-editor.org/rfc/rfc9110.html
