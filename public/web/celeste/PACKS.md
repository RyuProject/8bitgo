# /web/celeste 的运行数据（`_framework/`）怎么放

页面本身（入口 + `assets/` + 字体 + 图标，约 14MB，含打过补丁的 index.html 与 bundle）
随 git 发布，`_framework/` **不进 git**。上游是 [MercuryWorkshop/celeste-wasm](https://github.com/MercuryWorkshop/celeste-wasm)
（Webleste）的 GitHub Release 产物 `webleste-loader.tar.zst`（40.9MB 压缩包）。

| 文件 | 在哪 |
|---|---|
| `index.html`（打过补丁）、`assets/*`、`fonts/`、`*.webp` | git（`public/web/celeste/`） |
| `_framework/**`（130MiB：5 片 `dotnet.native.<hash>.wasm0..4` + 204 dll + 3 ICU） | R2：`web/celeste/_framework/` |
| 上游的 `_headers`、`robots.txt` | **都不发**（前者是 Cloudflare Pages 约定，本站头部由 Express 发；后者会顶掉主站 robots） |

线上取用路径是**同源**的：`https://8bitgo.com/web/celeste/_framework/<文件>`
→ `server/src/celeste.js` 优先流式转发 R2 的 `<文件>.br`，旧桶没有预压缩对象时再退回原文件。

为什么不用浏览器直连 R2：`_framework/dotnet.native.worker.<hash>.mjs` 是 pthread 的 Worker 入口，
**跨源 Worker 不允许**；而且这一页跑在 `COEP: require-corp` 下，同源转发省掉一整套 CORS/CORP 配置。

## 上传

```bash
tar --zstd -xf webleste-loader.tar.zst -C .celeste-framework   # 或 --src 指向解压目录
npm run celeste:upload -- --bucket <R2桶名> --src .celeste-framework
```

- 依赖 wrangler 已登录（`npx wrangler login`）或已配 `CLOUDFLARE_API_TOKEN`。
- Brotli q11 + 按 SHA-256 复用；`.wasm0..4` 分片与 dll 都会压缩。
- 唯一不带内容哈希的入口 `dotnet.js` **最后**上传（.NET 10 产物没有 blazor.boot.json）。
- 传完脚本对 `dotnet.js` 做公网 HEAD 自检；`--skip-public-check` 可跳过。

## 本机要能玩

1. **离线调试**：把上游 `_framework/` 放到 `public/web/celeste/_framework/`（已 gitignore），
   `express.static` 会优先命中本地文件，代理根本不会被调用。
2. **不想上传就想试**：直接跑 `npm run start:ssr`，代理会去 `assets.8bitgo.com` 取 —— 前提是已经传过。

⚠️ 别把 `_framework/` 留在 `public/` 里就提交：135MB 级别的二进制进仓库历史很难清干净
（vite.config.ts 的 `HUGE_STATIC` 已把 `web/celeste/_framework` 排除出 dist，git 里靠 .gitignore）。

## 相关脚本

```bash
npm run celeste:patch      # 上游产物拷入 public/web/celeste/ 并打补丁（--src <解压目录>）
npm run celeste:check      # 校验补丁在位、引用齐全、bundle 真解析（prebuild / postbuild:client 都会跑）
npm run test:celeste       # 代理纯函数回归 + 上面的检查
```

## 玩家需要什么

**上游不提供任何游戏素材**：玩家必须拥有 Celeste (2018)（Steam / itch），用页面里的
「打开 Celeste 目录」把本机安装目录交给浏览器（或拖入归档）。没有素材时停在引导页是正常现象。
页面里已按站内纪律移除：第三方统计、wisp 代理（fetch / WebSocket 劫持）、Steam 登录（补丁细节
见 `scripts/patch-celeste-web.mjs` 头注释）。
