# GTA: Vice City WASM 运行端

- 上游：<https://github.com/joncodeofficial/gta-vice-city-wasm>
- 固定提交：`10dd677cc55574da98e9be2433a3c5c668b39954`
- 许可证：MIT，见 `LICENSE.upstream.txt`
- 构建基址：`/web/gta-vc/`

这里仅包含开源网页运行端，不包含 `game.tar.gz`、原版游戏素材或其他 Rockstar / Take-Two 数据。
玩家必须使用自己合法拥有的 PC 版制作并导入归档。`runtime-config.js` 的下载地址默认留空；只有在
归档来源、授权和长期可用性都核验完成后才允许填写，不能热链、镜像或绕过第三方来源限制。

相对上游的本地修复：

1. 归档地址改为独立运行时配置，未配置时隐藏下载按钮；
2. `game.tar.gz` 改为边解压边写 OPFS，避免压缩包、完整 TAR 与 OPFS 副本同时占用数 GB 内存；
3. TAR 文件头、路径、体积、文件数量和必需文件在写入就绪标记前全部校验；失败会清理半成品；
4. 所有网页资源固定到 `/web/gta-vc/`，以便从独立 Cloudflare Pages 项目部署。
5. 数据来源未核验前页面保持 `noindex,nofollow`，避免搜索引擎把运行端误当成游戏发行页。

更新运行端后执行：

```bash
node scripts/check-gta-vc-web.mjs --write-manifest
node scripts/check-gta-vc-web.mjs
npm run pages:web-games:build -- gtavc
npm run pages:web-games:check -- gtavc
```
