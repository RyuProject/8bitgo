# UI 按钮外框 CSS 化 QA

## 对照来源与实现

- 来源图 1：`/Users/zhangwenyu/Downloads/截屏2026-11-04 15.17.17.png`（原始尺寸 758 × 124 px）
- 来源图 2：`/Users/zhangwenyu/Downloads/截屏2026-11-04 15.17.25.png`（原始尺寸 758 × 124 px）
- 绿色按钮第一次补充参考：`/var/folders/hg/rws3swzs2gnc5zs48b6ln5r80000gn/T/TemporaryItems/NSIRD_screencaptureui_CrFI08/截屏2026-11-04 18.07.33.png`（476 × 258 px；已由更新参考取代）
- 白色按钮当前参考：`/var/folders/hg/rws3swzs2gnc5zs48b6ln5r80000gn/T/TemporaryItems/NSIRD_screencaptureui_NvarPd/截屏2026-11-04 19.06.36.png`（362 × 164 px）
- 绿色按钮当前参考：`/var/folders/hg/rws3swzs2gnc5zs48b6ln5r80000gn/T/TemporaryItems/NSIRD_screencaptureui_HKPQKi/截屏2026-11-04 19.06.50.png`（728 × 152 px）
- 实现页面：`http://127.0.0.1:4173/`
- 实现截图：Codex In-app Browser 在上述页面、简体中文首页状态下的现场截图，视口约 735 × 910 px；截图在当前对话中展示，CUA 没有提供可保存的本地截图路径。
- 状态：窄视口首页横幅中两个主 CTA 可见；类型快捷按钮复用同一 CSS 组件。侧栏“随机游戏”按钮也已移除三段 SVG 外框，使用 CSS 圆角框并保持原配色。

## 比对结果

- 字体与文案：中文 CTA 未裁切；链接名称和目标仍分别为「浏览游戏库」→ `/games`、「运行我的 ROM」→ `/play-local`。
- 间距与形状：白色按钮使用圆角矩形、细灰描边与浅灰下沿；绿色按钮使用较大的圆角、亮绿面和更明显的深绿底沿。按下时按钮压低。
- 颜色：白色按钮为白底、浅灰描边/下沿和灰色文案；绿色主按钮采用 `#58cc02` 填充、`#46a302` 底沿与白色文案。
- 图片与图标：按钮外框不再引用 `public/ui/pixel-buttons/` 或 `public/ui/random-button/` 中的 SVG；运行 ROM、平台、类型和品牌图标仍可使用 SVG，它们不是外框。
- 交互：两个 CTA 仍为可访问链接，保留 hover、active、键盘焦点和减少动态效果支持。
- 绿色 CTA 的常态匹配亮绿圆角块与深色下沿；按下时按钮下沉、阴影缩短，保留 Duolingo 式按压反馈。
- 完整页面截图中，横幅下方的游戏类型请求返回 HTTP 502；这不影响按钮渲染或链接行为，属于本地预览 API 状态，不纳入本次样式修复。

## 发现与迭代

- 对 18:07 参考的第一轮绿色样式颜色和文字对比不准确；按用户 19:06 提供的白/绿两张新参考重做后，窄屏预览符合当前目标。
- 全仓检查运行时代码后，主 CTA、类型快捷按钮与侧栏随机游戏按钮均不再使用 SVG 外框；生产客户端构建、TypeScript、oxlint 与 SSR preload 回归通过。

**final result: passed**
