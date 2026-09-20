# 从这里开始

这是 `worker.zip` 的完整修复工程，不是 ROM/模拟器核心包。优先阅读 `AUDIT.md` 的“关键缺陷”和“上线前必须接受的兼容变化”。

**模块工程：** ROM 用 `src/index.js` + `src/common.js` + `src/http.js`；embed 用 `embed-vc/src/index.js`。不要只覆盖 ROM 的 index.js。

**控制台单文件：** ROM 用 `standalone/rom-worker.js`；embed 用 `standalone/embed-worker.js`。单文件不包含配置、Secret、桶、路由或游戏资源，需要保留对应 Worker 的原绑定。

**缺少资源：** 原包与修复包都没有 `embed-vc/dist/`。该 Worker 托管完整游戏前，必须补齐合法静态构建产物并验证主站 iframe 集成。

**测试：** Node.js 22+，在本目录运行 `npm run check`、`npm test`；无需安装第三方依赖。105 项测试是离线模型测试，不是 Cloudflare/R2 线上通过证明。

**部署风险：** 原生产 Worker 名称和桶名仍保留在 wrangler.toml。先改成测试名称/桶在 staging 验证，再发布生产。原代码快照在 `audit/original-project/` 与 `tests/original/`，仅用于核对，不能作为修复版部署入口。

**数据语义：** cover 删除现在同时移除新旧两桶副本；旧分页 cursor 要从第一页重新获取；503/retryable 应保留上传进度；未知长度单次上传最多 32 MiB；默认可覆盖对象不再长期免验证缓存。详见 README。
