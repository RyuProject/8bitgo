# 浏览器兼容范围

最后核对：2026-09-26。

## 支持分层

| 层级 | 浏览器 | 预期 |
|---|---|---|
| 推荐 | 当前两个大版本的 Chrome、Edge、Firefox、Safari / iOS Safari | 主站与设备能力允许的模拟器功能完整 |
| 兼容 | Chrome / Android WebView 64+、Edge 79+、Firefox 67+、Safari / iOS 12+、Samsung Internet 9+ | 主站浏览、登录、搜索、后台可用；旧内核自动收到降级脚本与补丁，动画或局部视觉效果允许简化 |
| 不支持 | IE 11、更老的 Android Browser / WebView、关闭 JavaScript 的浏览器 | SSR 文本可能仍可阅读，但不保证交互和模拟器运行 |

这张表说的是**站点外壳**。游戏能不能运行还取决于 WebAssembly、WebGL、Web Audio、可用内存、
SharedArrayBuffer 和 WebRTC；旧设备即使能正常浏览游戏库，也不代表能承受 PS2、PSP、GameCube、
Wii 或大型网页游戏。不要为了让页面脚本“看起来能解析”而向不具备这些底层能力的浏览器承诺开局。

## 已有降级

- 生产构建同时生成现代 ESM 包和旧浏览器 SystemJS 包；现代浏览器不会下载后者。
- 旧包按实际用法注入 ES 语言补丁，并额外补 `inert` 与可取消 `fetch`。
- `100dvh` 退回 `100vh`；`ResizeObserver` 退回窗口 resize；媒体查询订阅兼容旧 WebKit。
- 剪贴板 API 不可用时退回选区复制；`CSS.escape`、`replaceChildren`、`createImageBitmap` 都有退路。
- DOS 在没有 `WeakRef` 的浏览器里只关闭直播音频抓取，不影响本机游戏声音与开局。

## 验收

```bash
npm run test:browser-compat
npm run build:client
```

第二条命令的构建后检查会确认 HTML 里存在 `nomodule` / legacy polyfill 入口，而且每个引用的旧版
chunk 都真实存在。新增浏览器 API 时，优先做能力检测和局部降级；不要只按 User-Agent 猜浏览器。
