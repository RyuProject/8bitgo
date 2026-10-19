# Funkin Cloudflare Pages

这套文件给独立项目 `8bitgo-funkin` 增加渐进加载与版本化缓存，不把授权游戏资源提交进主仓库。

- `sw.js`：正在请求的资源直接流给游戏，同时在后台写入 Cache Storage；相同 URL 的并发请求只下载一次。
- `8bitgo-streaming.js`：按网络状况选择预热策略；省流量/2G 不预热，3G 只预热谱面元数据，快网低优先级预热教学曲。
- `_worker.js`：保留 43.6MB 宣传视频的 R2 Range 代理，并为静态资源设置适合版本切换的缓存头。
- `scripts/build-funkin-pages.mjs`：从获授权的上游源码和已经生成的 `Funkin.js` 组装 Direct Upload 目录。

生成与检查示例：

```bash
node scripts/build-funkin-pages.mjs \
  --source /path/to/Funkin-0.8.6 \
  --main-js /path/to/Funkin.js \
  --flixel-zip /path/to/flixel.zip \
  --flixel-addons-zip /path/to/flixel-addons.zip \
  --out /private/tmp/funkin-pages
node scripts/check-funkin-pages.mjs --dir /private/tmp/funkin-pages
node scripts/test-funkin-streaming.mjs
```

构建器会拒绝 Pages 超过 25MiB 的文件，并确认大视频没有误进静态目录。每次修改流式逻辑都要提升
`STREAM_VERSION`，让新 Service Worker 删除旧代缓存，避免不同发布版本的同名资源混用。
