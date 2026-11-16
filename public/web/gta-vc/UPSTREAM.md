# GTA: Vice City WASM 运行端

- 上游：<https://github.com/joncodeofficial/gta-vice-city-wasm>
- 固定提交：`5c6cccc56c1df5c3717c0b39953d5fe833f97b73`（2026-11-12）
- 许可证：MIT，见 `LICENSE.upstream.txt`
- 构建基址：`/web/gta-vc/`（`vite build --base /web/gta-vc/`）

这里包含开源网页运行端、引擎 `engine/vc-sky-en-v6.wasm`（DOS Zone 团队的 reVC WASM 移植）
和上游 `revc/` 目录里 reVC 项目自带的少量文件（手柄图标、`revc.ini` 等）。游戏素材不进 Git
或 Pages 静态包。用户可以选择自己的 PC 安装目录、`.zip` 或 `.7z`；转换在浏览器里写入 OPFS，
不会上传玩家选择的文件。用户另已明确授权把其取得的 `revcdoseng.7z` 放进 R2，固定 key 为
`web/gta-vc/revcdoseng.7z`；游戏页从同源 `/game-data/revcdoseng.7z` 下载该对象。Pages Worker
只代理这个固定 key、支持 Range，不接受用户传入的对象路径，也不开放跨域读取。

`.7z` 由单独的 Worker 使用 `un7z-opfs` / 7-Zip WASM 流式写入临时 OPFS，再交给上游目录转换器；
不把 545 MB 压缩包整体读进 JavaScript 内存。转换器同时识别 `models/gta3.img/` 和
`anim/cuts.img/` 这类已展开目录，并按 `.dir` 索引逐个读取其中的成员；也支持 `audio/sfx.raw/`
里已编码的 MP3，并直接复制带 ID3 标记、但文件扩展名为 `.wav` 的音效，不再误按 WAV 转码。

相对上游的本地改动：

1. 构建基址改为 `/web/gta-vc/`，以便从独立 Cloudflare Pages 项目部署；
2. `index.html` 加 `noindex,nofollow`，避免搜索引擎把运行端误当成游戏发行页；
3. `scripts/patch-gta-vc-7z.mjs` 为目录转换器增加展开 IMG / SFX 目录、`.7z` 与转换进度事件支持；
4. `scripts/copy-gta-vc-7z.mjs` 从锁定的 npm 依赖复制 7z WASM、许可证和对应源码。

旧版（`10dd677`）导入 `game.tar.gz` 的流程、`runtime-config.js` 与本站自写的流式 TAR 解包器
都已随上游一起移除；上游现在的 ZIP 读取按中央目录懒读、大文件流式解压到 OPFS 临时目录，
不会把整个安装包读进内存。

更新运行端：

```bash
git clone https://github.com/joncodeofficial/gta-vice-city-wasm && cd gta-vice-city-wasm
git checkout <提交> && pnpm install --frozen-lockfile && npx vite build --base /web/gta-vc/
# 用 dist/ 替换 public/web/gta-vc/，保留 UPSTREAM.md，复制 LICENSE 为 LICENSE.upstream.txt，补回 noindex
# 然后把 scripts/check-gta-vc-web.mjs 里的 upstreamCommit 改成新提交
node scripts/patch-gta-vc-7z.mjs
node scripts/copy-gta-vc-7z.mjs
node scripts/check-gta-vc-web.mjs --write-manifest
npm run gta-vc:check
npm run pages:web-games:build -- gtavc && npm run pages:web-games:check -- gtavc
```
