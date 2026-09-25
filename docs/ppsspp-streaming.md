# PSP / PPSSPP 流式读盘

## 结论

PSP 不走 EmulatorJS。站点使用独立 PPSSPP WebAssembly 运行时，远程 ISO / CSO / CHD
以 URL 直接交给核心，由 `WasmRangeFileLoader` 发 HTTP Range 请求：

- 固定 2 MiB 一块；
- 内存 LRU 上限 96 MiB（48 块；给固定 512 MiB 的 PPSSPP 共享堆留出游戏/JIT 空间）；
- 每个响应必须是 `206`，且 `Content-Range` 必须与请求完全一致；
- 只对网络错误、408、429 和 5xx 退避重试，永久性 4xx 不空转；
- 第一段优先锁定强 ETag（其次 Last-Modified），后续请求带 `If-Match` /
  `If-Unmodified-Since`；对象即使被同尺寸覆盖也会中止，避免把两个版本拼成一张盘；
- 核心把真实取回字节和致命错误回传给页面，页面等到“真实读盘 + 首帧”后才宣布启动成功；
- 主程序由 `PROXY_TO_PTHREAD` 放进 Worker，同步 Range 只阻塞模拟线程，不阻塞页面。

本地文件仍走 WORKERFS；游戏内存档和 PPSSPP 设置挂到 IDBFS，每 30 秒及离开页面时同步。
同步请求会串行合并，避免定时器与离页写入互相踩踏；初次读取 IDBFS 失败时本局禁用回写，
防止用空目录覆盖玩家已有存档。

## 为什么不接 EmulatorJS 的 PSP 核心

EmulatorJS 会先下载完整 ROM，再把它交给 Emscripten 文件系统。PSP 镜像常见 1–1.8 GiB，
下载缓冲、Blob / ArrayBuffer 和 WASM 内存会重叠，移动端非常容易在进游戏前就被系统杀掉。
Range 接入必须落在 PPSSPP 的 `FileLoader::ReadAt()` 层，网页壳里做一个“分段下载进度条”并不能
改变核心最终仍需要完整文件这一事实。

## 构建核心

运行时锁定：

- 源码：`https://github.com/root-hunter/ppsspp-wasm`
- 分支：`wasm`
- 提交：`0dbfaca62a8a924abc2c5dd5dd0733b668e5e68a`
- Emscripten：`5.0.7`

先完整检出上游（含子模块），激活 Emscripten 5.0.7，然后执行：

```bash
npm run ppsspp:build -- --source /absolute/path/to/ppsspp-wasm
npm run ppsspp:check
```

建议在 Linux 构建机或上游同款 `emscripten/emsdk:5.0.7` 容器中执行；macOS arm64 的
emsdk 清单没有这版预编译工具链，现场从 LLVM 源码编译既慢又会消耗大量磁盘。

构建脚本会幂等应用 `vendor/ppsspp/patches/0001-range-streaming.patch`，把同一批
`PPSSPPSDL.js/.wasm/.data` 放入 `public/ppsspp/v0dbfaca/`，并把每个文件的
字节数和 SHA-256 写回 `runtime.json`。Range v2 还会在清单里写入 96 MiB 缓存、遥测和对象
校验能力；缺任何一个文件、缺核心标记或混入另一批产物，检查都会失败。

Emscripten 5.0.7 的 pthread Worker 复用 `PPSSPPSDL.js` 自身，不会生成旧版工具链常见的
`PPSSPPSDL.worker.js`。检查脚本会验证主 JS 中的自身 Worker 启动标记，确保
`PROXY_TO_PTHREAD` 确实生效。

`v0dbfaca` 目录发的是 immutable 缓存，页面用 `?r=2` 给 HTML 桥和三件套做内容代次。
改桥或重编核心时必须递增 `host.js` 里的 `RUNTIME_REVISION` 以及 `index.html` 的查询串，
否则老访客会继续运行浏览器里缓存一年的旧文件。

`runtime.json.rangeLoaderRevision` 是二进制能力的真值。值为 1 时，桥层的首帧判定、旧核心
错误接管、探测超时和存档保护已经生效，但核心仍使用 192 MiB 缓存，并靠播放 URL 的
`romv` + 文件大小避免版本混读；重新执行上述构建后会写成 2，才表示 96 MiB、条件请求和
原生遥测已经编进 WASM。检查脚本会对 v1 明确告警，不能把源码补丁误当成已发布二进制。

不要在生产机的普通 `npm run build` 里现场编译 PPSSPP；它需要完整 Emscripten 工具链和大量
临时空间。和 EmulatorJS 自建引擎一样，应当在构建机生成并提交（或完整同步）版本目录。

## 启用

二进制生成并通过 `npm run ppsspp:check` 后，才在 `.env.production` 加：

```dotenv
VITE_PPSSPP_PATH=/ppsspp/v0dbfaca/
```

不配置时 PSP 平台仍可管理和上传，但前台明确显示运行时未部署；这是故意的，防止核心漏文件时
把一个 404 变成玩家看到的白屏。

## R2 要求

直接上传 `.iso`、`.cso` 或 `.chd`，不要再套 ZIP、7z、RAR 或 8BG。现有 Worker 已满足：

- `Range` 请求返回 `206`；
- 返回准确的 `Content-Range`、`Content-Length`、`Accept-Ranges`；
- CORS 暴露上述响应头；
- `Access-Control-Allow-Headers` 允许 `Range`、`If-Match`、`If-Unmodified-Since`；
- CORS 要暴露 `ETag` 或 `Last-Modified`，否则只能退回 URL 的 `romv` + 大小校验。

后台“检测”会真的发一个 Range 请求验证，不是只做 HEAD。验证失败的地址不会交给 PPSSPP。

## 验收

```bash
npm run test:ppsspp
npm run test:disc-upload
npm run test:rom-probe
npm run test:platforms
npm run test:open-platforms
```

浏览器 Network 面板中，游戏请求应持续出现多个 `206`，单次响应通常为 2 MiB；不能出现一条
覆盖整个镜像的 `200`。第一次启动后应在 IndexedDB 中看到 PPSSPP 存档目录。
