# UNDERTALE local-only web runner

本站只发布开源运行端与本地文件导入界面，不含 UNDERTALE 的 `data.win`、`game.unx`、音乐、贴图、
剧情或其它商业游戏内容。玩家必须从自己合法取得的安装目录中选择文件；文件直接写入浏览器的
Origin Private File System（OPFS），不会上传到 8BitGo。

## 开源运行端

- Project: <https://github.com/ButterscotchRunner/Butterscotch>
- Commit: `54e10ec4e4a5713130675c7719dda7c437b4f849`
- Build artifact: `butterscotch-web.zip` from the upstream GitHub Actions `main` workflow
- Artifact SHA-256: `19a18cad3727eb817463ab51a39fba882d3148aa53c2a05fed50c3d7447597ad`
- License: Mozilla Public License 2.0（见 `LICENSE.butterscotch.txt`）

运行端仍处于早期开发阶段。上游明确把 UNDERTALE v1.08 / WAD 16 作为兼容目标，但没有承诺所有
场景都完全正确；本站界面因此保持“实验性”提示，不把兼容性描述成官方支持。

## 更新规则

更新上游构建时必须同时更新 `runtime-manifest.json`、许可证与 `scripts/check-undertale-web.mjs` 的
提交号/哈希。任何商业游戏文件、第三方重打包下载地址或 CDN 热链都不得进入 Git、Pages、R2、
Service Worker 缓存清单或本站代理。
