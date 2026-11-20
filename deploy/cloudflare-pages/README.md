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
| GTA Vice City | `8bitgo-gta-vc` | `gta-vc.8bitgo.com` |
| UNDERTALE | `8bitgo-undertale` | `undertale.8bitgo.com` |
| Subway Surfers | `8bitgo-subway-surfers` | `subway-surfers.8bitgo.com` |

## 发布

这些项目使用 **Direct Upload**，不要连接 Git 自动构建。Minecraft 的 operator 自建客户端按版权规则不进 Git；Git 构建会得到只有提示壳、不能游玩的残缺项目。

```bash
npm run pages:web-games:build
npm run pages:web-games:check
npm run pages:web-game:deploy -- pvz
```

最后一条把游戏名换成表中的 Pages 项目短名，例如 `gamblers-table`、`diablo`、`minecraft`、`cs16`、`gtavc`。已经建立的项目以后只需重新发布改过的游戏。下面保留目标值供以后复核或重建。

各域名的 CNAME 目标分别是：

- `gamblers-table` → `8bitgo-gamblers-table.pages.dev`
- `pvz` → `8bitgo-pvz.pages.dev`
- `diablo` → `8bitgo-diablo.pages.dev`
- `minecraft` → `8bitgo-minecraft.pages.dev`
- `celeste` → `8bitgo-celeste.pages.dev`
- `terraria` → `8bitgo-terraria.pages.dev`
- `cs16` → `8bitgo-cs16.pages.dev`
- `gta-vc` → `8bitgo-gta-vc.pages.dev`
- `undertale` → `8bitgo-undertale.pages.dev`
- `subway-surfers` → `8bitgo-subway-surfers.pages.dev`

Diablo、Celeste、Terraria 的大 WASM/.NET 文件不会复制进 Pages：各自的 `_worker.js` 会从 `https://assets.8bitgo.com` 取 R2 对象并同源转发。若以后更换 R2 域名，在对应 Pages 项目里设置 `RUNTIME_ASSET_BASE_URL`。

PvZ 的 `main.pak` 和动画包仍存放在网页游戏资源桶，玩家从 `download.8bitgo.com/PvZ/properties/`
读取。构建后的中英文页面会把数据基址改成同源 `/pvz-data/`，由 Pages Worker 从下载域
流式转发并保留 Range / ETag；可用 `PVZ_DATA_BASE_URL` 更换上游。Pages 静态包本身仍只承载网页
外壳和约 7MB WASM。Minecraft 的 Pages 包只能由拥有合法自建产物的 operator 在本机生成和上传。

CS1.6 的内容寻址 Zstd 分片继续由 `assets.8bitgo.com` 的 R2 Worker 提供；Pages 包明确排除
`public/web/cs16/packs/`。`_worker.js` 只把 `/api/cs16/*` 同源转发到主站，公共服务器的 UDP
校验与中继仍留在生产机上，不能迁进不提供任意公网 UDP Socket 的 Pages Functions。
临时房间的房主凭证和玩家恢复凭证走 `Sec-WebSocket-Protocol`，Pages Worker 必须在浏览器握手、
主站握手两边选择并转发同一个子协议；只转发二进制帧而漏掉该头会让 Pages 域名下的房间联机失效。
发布顺序固定为后端先、Pages 后。新后端会兼容旧客户端的查询串凭证，但新 Pages/客户端只生成
子协议凭证；这样滚动发布期间旧页面不会全部断房，同时不让新访问继续把凭证写进 URL 日志。

GTA VC 用户授权的 `revcdoseng.7z` 固定放在 R2 key `web/gta-vc/revcdoseng.7z`；页面通过同源
`/game-data/revcdoseng.7z` 读取，Pages Worker 从 `download.8bitgo.com` 获取对象，以使用该域名的
CNAME 优选入口，并保留 Range、只允许这个对象键。该文件不进 Git 或 Pages 静态包。

UNDERTALE 游戏资源留在 R2 `8bitgo-webgame` 桶的 `undertale/` 前缀，Pages 包只含运行端与元数据。
启动页在 `https://undertale.8bitgo.com/web/undertale/` 自动下载、校验并从本机 OPFS 启动；R2 CORS
来源只允许 `https://8bitgo.com` 与 `https://*.8bitgo.com`。修改 CORS 后分别刷新 `html5.8bitgo.com/undertale/`
资源前缀与 Pages 启动器路径缓存。策略记录在 `undertale-r2-cors.json`，可在仓库的 `worker/` 目录运行
`../node_modules/.bin/wrangler r2 bucket cors set 8bitgo-webgame --file ../deploy/cloudflare-pages/undertale-r2-cors.json`。
