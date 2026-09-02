# 8bitgo-roms · Cloudflare Worker

把 R2 桶里的 ROM 以「可公开 GET」的方式提供给网站，并附带：

- CORS（EmulatorJS 需要跨域读取文件）
- Range 请求（大文件断点 / 分段加载）
- 长缓存头（走 Cloudflare CDN）
- `/list` 列表接口（后台「ROM 存储」页用来一键匹配游戏，需口令）

## 部署

```bash
cd worker
npx wrangler login                    # 首次
npx wrangler secret put ADMIN_TOKEN   # 输入一个口令，后台列文件时要用
npx wrangler deploy
```

部署完成后会得到一个地址，例如 `https://8bitgo-roms.<你的子域>.workers.dev`。
把它填到网站 `.env` 的 `VITE_ROM_BASE_URL`，或在后台「ROM 存储」页里直接保存。

`wrangler.toml` 里的 `bucket_name` 已写为 `8bitgo`，如桶名不同请修改。

## 接口

| 路径 | 说明 |
| --- | --- |
| `GET /ping` | 健康检查，返回 JSON（`writable` 表示是否已设置 ADMIN_TOKEN） |
| `GET /<key>` | 读取对象，路径即 key，例如 `/roms/nes/contra.zip`，支持 HEAD 与 Range |
| `PUT /<key>` | 上传对象（`Authorization: Bearer <ADMIN_TOKEN>`），请求体即文件内容；后台「上传 ROM」用的就是它 |
| `POST /<key>?uploads` | 开始分片上传，返回 `uploadId` 与标记对象（需口令） |
| `PUT /<key>?uploadId=&partNumber=` | 传一片，返回该片 `etag`（需口令） |
| `POST /<key>?uploadId=` | 合并，body 为 `{parts:[{partNumber,etag}]}`（需口令） |
| `DELETE /<key>?uploadId=` | 放弃这次分片上传（需口令） |
| `GET /multipart` | 列出未完成的分片上传（需口令） |
| `DELETE /<key>` | 删除对象（需口令） |
| `GET /list?prefix=&cursor=` | 列出对象（需口令） |

### 大文件必须走分片

Cloudflare 的请求体上限是**平台级的、由边缘节点执行**（Free / Pro 100 MB，Business 200 MB，
Enterprise 500 MB），在 Worker 代码之前就生效。超限时边缘直接 reset 连接，
浏览器**拿不到 413**，只会看到一句「无法连接 Worker」—— 而 `wrangler tail` 里
连这次请求的日志都没有。这正是后台传 100MB 游戏「有时候连不上」的真实原因。

所以后台对超过 24MB 的文件自动改走上面那套分片接口：上限按**单个请求**算，
8MB 一片离上限很远，还顺带支持断点续传（分片的 etag 记在浏览器的 localStorage 里，
所以换浏览器续不上，只能重传）。GBA / NES / SNES 的 ROM 远小于阈值，仍走一次 PUT。

没合并的分片会**一直按存储计费**，而 binding 没有 `listMultipartUploads`，
所以 create 时会在 `_uploads/` 下写一个标记对象，后台「ROM 存储」页的
「未完成的分片上传」面板靠它列出并清理残留。建议再给桶加一条 lifecycle 规则
（Cloudflare 控制台 → R2 → 桶 → Settings → Object lifecycle rules），
把「未完成的分片上传」设成 7 天后自动放弃，兜住没人去点的那些。

改动 `src/index.js` 的分片部分后，在仓库根目录跑 `npm run test:multipart` 自测。

## 与自定义域名配合

公开读取可以走 R2 的自定义域名（例如 `assets.8bitgo.com`，在桶上配置 CORS 允许 GET/HEAD），
Worker 只用来做后台的上传、删除和列表。网站后台「ROM 存储」页里把两者分开填写即可。

## 不用 Worker 的替代方案

在 Cloudflare 控制台给桶开启公开访问（r2.dev 子域或自定义域名），并在桶的 CORS 策略里允许你的站点来源
（AllowedMethods 至少包含 GET、HEAD）。这种方式没有 `/list` 接口，后台需要手动填写每款游戏的 ROM key，
或按约定路径 `<platform>/<slug>.zip` 命名文件让前台自动探测。
