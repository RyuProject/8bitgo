# UNDERTALE authorized web distribution runner

8BitGo 已获 UNDERTALE 分发授权。游戏资源保存在 `https://html5.8bitgo.com/undertale/`，不进入 Git、
Pages 构建包或 Service Worker。`https://8bitgo.com` 及其 HTTPS 子域直接从该地址读取资源并流式写入浏览器
Origin Private File System（OPFS）；启动器没有游戏文件上传请求。远端 R2 CORS 来源仅允许
`https://8bitgo.com` 与 `https://*.8bitgo.com`，启动器也会在其它来源禁用远端分发。首页自动开始下载，只显示一条进度条；
授权资源完整校验并写入 OPFS 后自动启动，包括从 `https://undertale.8bitgo.com/web/undertale/` 打开。

`distribution-manifest.json` 是授权 ZIP 的元数据清单，只含相对路径、字节数和 CRC-32，不含游戏内容；
它记录并排除桌面版 `.exe` / `.dll` 和未上传、且 `data.win` 未引用的 `splash.png`。
大文件按 8 MiB Range 分段写入 OPFS，校验完整后才切换为就绪版本；页面刷新后会从已落盘的文件段继续。
游戏文件不经本站 API、Worker 或 Service Worker 代理。

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
提交号/哈希。替换授权分发包时更新 `distribution-manifest.json` 的包版本和每个 ZIP CRC-32，并核对
远端路径、字节数与 CORS 响应。不要把游戏文件或归档复制进 Git、Pages 构建包、Service Worker 缓存或本站代理。
