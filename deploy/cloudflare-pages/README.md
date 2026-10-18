# 独立网页游戏 Pages 项目

这些游戏各自使用一个 Cloudflare Pages 项目，避免隔离头、运行时代理和缓存策略互相污染。

| 游戏 | Pages 项目 | 自定义域名 |
|---|---|---|
| Digiverse (`gamblers-table`) | `8bitgo-gamblers-table` | `gamblers-table.8bitgo.com` |
| PvZ | `8bitgo-pvz` | `pvz.8bitgo.com` |
| Diablo | `8bitgo-diablo` | `diablo.8bitgo.com` |
| Minecraft | `8bitgo-minecraft` | `minecraft.8bitgo.com` |
| Celeste | `8bitgo-celeste` | `celeste.8bitgo.com` |
| Terraria | `8bitgo-terraria` | `terraria.8bitgo.com` |
| Counter-Strike 1.6 | `8bitgo-cs16` | `cs16.8bitgo.com` |

## 发布

这些项目使用 **Direct Upload**，不要连接 Git 自动构建。Minecraft 的 operator 自建客户端按版权规则不进 Git；Git 构建会得到只有提示壳、不能游玩的残缺项目。

```bash
npm run pages:web-games:build
npm run pages:web-games:check
npm run pages:web-game:deploy -- pvz
```

最后一条把游戏名依次换成 `gamblers-table`、`diablo`、`minecraft`、`celeste`、`terraria`、`cs16`。已经建立的项目以后只需重新发布改过的游戏。表中前六个自定义域名与代理 CNAME 已于 2026-09-26 在线验收；CS1.6 于 2026-10-17 接入。下面保留目标值供以后复核或重建。

各域名的 CNAME 目标分别是：

- `pvz` → `8bitgo-pvz.pages.dev`
- `diablo` → `8bitgo-diablo.pages.dev`
- `minecraft` → `8bitgo-minecraft.pages.dev`
- `celeste` → `8bitgo-celeste.pages.dev`
- `terraria` → `8bitgo-terraria.pages.dev`
- `cs16` → `8bitgo-cs16.pages.dev`

Diablo、Celeste、Terraria 的大 WASM/.NET 文件不会复制进 Pages：各自的 `_worker.js` 会从 `https://assets.8bitgo.com` 取 R2 对象并同源转发。若以后更换 R2 域名，在对应 Pages 项目里设置 `RUNTIME_ASSET_BASE_URL`。

PvZ 的 `main.pak` 和动画包仍存放在 `html5.8bitgo.com`，但该历史自定义域没有 CORS 响应头，
浏览器不能直接读取。构建后的中英文页面会把数据基址改成同源 `/pvz-data/`，由 Pages Worker
流式转发并保留 Range / ETag；可用 `PVZ_DATA_BASE_URL` 更换上游。Pages 静态包本身仍只承载网页
外壳和约 7MB WASM。Minecraft 的 Pages 包只能由拥有合法自建产物的 operator 在本机生成和上传。

CS1.6 的内容寻址 Zstd 分片继续由 `assets.8bitgo.com` 的 R2 Worker 提供；Pages 包明确排除
`public/web/cs16/packs/`。`_worker.js` 只把 `/api/cs16/*` 同源转发到主站，公共服务器的 UDP
校验与中继仍留在生产机上，不能迁进不提供任意公网 UDP Socket 的 Pages Functions。
临时房间的房主凭证和玩家恢复凭证走 `Sec-WebSocket-Protocol`，Pages Worker 必须在浏览器握手、
主站握手两边选择并转发同一个子协议；只转发二进制帧而漏掉该头会让 Pages 域名下的房间联机失效。
发布顺序固定为后端先、Pages 后。新后端会兼容旧客户端的查询串凭证，但新 Pages/客户端只生成
子协议凭证；这样滚动发布期间旧页面不会全部断房，同时不让新访问继续把凭证写进 URL 日志。
