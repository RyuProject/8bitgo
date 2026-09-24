# /web/terraria 的运行数据（`_framework/`）怎么放

页面本身（入口 + `assets/` + 图标字体，约 800KB）随 git 发布，`_framework/` **不进 git**。

## 为什么不在 git 里

`_framework/` 共 **134.9MiB**，103 个 dll + 3 份 ICU 数据 + .NET 运行时；其中
`dotnet.native.<hash>.wasm` 单文件 **100,104,513 字节**，已经贴着 GitHub 的单文件上限。
按仓库既有取舍（qemu-wasm 的 140MB、cs15 的 packs）一律走对象存储，避免每次 clone / pull 搬 135MB。

| 文件 | 在哪 |
|---|---|
| `index.html`、`assets/index.js`（打过补丁）、`assets/index.css`、`app.ico`、`backdrop.png`、`logo.png`、`AndyBold.ttf` | git（`public/web/terraria/`） |
| `_framework/**` | R2：`web/terraria/_framework/` |
| 上游的 `sw.js`、`MILESTONE` | **都不发**（前者作用域是站点根，后者只有它用） |

线上取用路径是**同源**的：`https://8bitgo.com/web/terraria/_framework/<文件>`
→ `server/src/terraria.js` 优先流式转发 R2 的 `<文件>.br`，旧桶没有预压缩对象时再退回原文件。

为什么不用浏览器直连 R2：`_framework/dotnet.native.worker.<hash>.mjs` 是 pthread 的 Worker 入口，
**跨源 Worker 不允许**；而且这一页跑在 `COEP: require-corp` 下，同源转发省掉一整套 CORS/CORP 配置。

## 上传

```bash
npm run terraria:upload -- --bucket <R2桶名> --zip ~/Downloads/terraria-wasm-build.zip
```

- 依赖 wrangler 已登录（`npx wrangler login`）或已配 `CLOUDFLARE_API_TOKEN`。
- 上传器用浏览器原生可解的最高档 **Brotli q11 + 16MiB window**，并按源文件 SHA-256 复用结果；
  100MB wasm 没变时不会每次重压。R2 同时保留原始回退对象与独立的 `<文件>.br`。
- `.br` 对象故意不写 `Content-Encoding`；服务端拿到原始压缩字节后再补这个响应头，
  避免 Node 在回源时先整包解压。浏览器收到后边下载边解压，不在 Node 堆里攒 100MB。
- 加 `--dry-run` 会完成压缩并打印前后体积，但不真上传；压缩缓存默认在 `.terraria-framework-br/`。
- 加 `--src <目录>` 指定已解压的构建目录（默认 `.terraria-framework/`，已 gitignore）。
- 类型与缓存策略直接复用 `server/src/terraria.js` 的 `frameworkAsset()` —— 脚本和线上**不可能分叉**。
- 顺序上两个入口（`dotnet.js`、`blazor.boot.json`）**最后**上传：它们不带内容哈希，
  先传就会有一段时间清单指向还不存在的对象。

传完脚本会对这两个入口做一次公网 HEAD 自检；`--skip-public-check` 可跳过（临时桶用）。

## 本机要能玩

只有两种情况需要 `_framework/` 在本地：

1. **离线调试**：把上游那份放到 `public/web/terraria/_framework/`（已 gitignore）。
   `express.static` 会优先命中本地文件，代理根本不会被调用。
2. **不想上传就想试**：直接跑 `npm run start:ssr`，代理会去 `assets.8bitgo.com` 取 —— 前提是已经传过。

⚠️ 别把 `_framework/` 留在 `public/` 里就提交：`.gitignore` 只挡了这一个路径，
而 135MB 进仓库的历史很难清干净。也不要用软链（cs16 踩过：开发机绝对软链的产物被当成正常文件发布）。

## 相关脚本

```bash
npm run terraria:patch      # 从 scripts/terraria-web/upstream 重新生成打过补丁的 assets/index.js
npm run terraria:check      # 校验补丁在位、引用齐全（prebuild / postbuild:client 都会跑）
npm run test:terraria       # 代理回归测试（stub 掉对象存储，不联网）+ 上面的检查
```
