# 独立网页游戏 Pages 项目

这六款游戏各自使用一个 Cloudflare Pages 项目，避免隔离头、运行时代理和缓存策略互相污染。

| 游戏 | Pages 项目 | 自定义域名 |
|---|---|---|
| Digiverse (`gamblers-table`) | `8bitgo-gamblers-table` | `gamblers-table.8bitgo.com` |
| PvZ | `8bitgo-pvz` | `pvz.8bitgo.com` |
| Diablo | `8bitgo-diablo` | `diablo.8bitgo.com` |
| Minecraft | `8bitgo-minecraft` | `minecraft.8bitgo.com` |
| Celeste | `8bitgo-celeste` | `celeste.8bitgo.com` |
| Terraria | `8bitgo-terraria` | `terraria.8bitgo.com` |

## 发布

这些项目使用 **Direct Upload**，不要连接 Git 自动构建。Minecraft 的 operator 自建客户端按版权规则不进 Git；Git 构建会得到只有提示壳、不能游玩的残缺项目。

```bash
npm run pages:web-games:build
npm run pages:web-games:check
npm run pages:web-game:deploy -- pvz
```

最后一条把游戏名依次换成 `gamblers-table`、`diablo`、`minecraft`、`celeste`、`terraria`。六个项目已经建立；以后只需重新发布改过的游戏。表中自定义域名与代理 CNAME 已于 2026-09-26 在线验收，下面保留目标值供以后复核或重建。

各域名的 CNAME 目标分别是：

- `pvz` → `8bitgo-pvz.pages.dev`
- `diablo` → `8bitgo-diablo.pages.dev`
- `minecraft` → `8bitgo-minecraft.pages.dev`
- `celeste` → `8bitgo-celeste.pages.dev`
- `terraria` → `8bitgo-terraria.pages.dev`

Diablo、Celeste、Terraria 的大 WASM/.NET 文件不会复制进 Pages：各自的 `_worker.js` 会从 `https://assets.8bitgo.com` 取 R2 对象并同源转发。若以后更换 R2 域名，在对应 Pages 项目里设置 `RUNTIME_ASSET_BASE_URL`。

PvZ 的 `main.pak` 和动画包继续由 `html5.8bitgo.com` 提供；Pages 只承载网页外壳和 7MB WASM。Minecraft 的 Pages 包只能由拥有合法自建产物的 operator 在本机生成和上传。
