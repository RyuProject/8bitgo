# CS1.6 Zstd 分片包：生成、上传与验收

公共运行时的原始 TAR 约 134MB。单个 Zstd 22 帧虽然能压到约 51MB，但帧窗口会增到
128MB；浏览器还要同时保留引擎、MEMFS 和地图，峰值内存过高。本站使用 **16MB 原始数据一片**的
独立 Zstd 22 帧：公共包约 53MB，单次解压窗口不超过 16MB，并能单片重试和逐片校验。

## 生成和验证

```bash
brew install zstd                       # Ubuntu: apt install zstd
npm run cs16:repack                     # 从历史包生成确定性 TAR+gzip
npm run cs16:zstd                       # 生成 zstd-v1/catalog.json + chunks/*.zst
npm run test:cs16                       # 逐片 SHA、解压 SHA、TAR 与 gzip 原包一致性
```

产物在被 Git 忽略的 `public/web/cs16/packs/zstd-v1/`。每个分片用自身 SHA-256 命名；加载器会同时
核对压缩字节和解压字节的 SHA-256，长度或内容有一位不符都会重试，三次失败后给出明确错误。

## 上传 R2

先让 Wrangler 登录，再执行：

```bash
npm run cs16:upload -- --bucket <你的R2桶名>
```

只核对产物而不联网上传可加 `--dry-run`。

默认前缀是 `web/cs16/zstd-v1`。脚本先上传所有分片，最后上传清单，避免新清单指向尚未存在的
对象。响应元数据必须是：

- `chunks/*.zst`：`Content-Type: application/zstd`，`Cache-Control: public, max-age=31536000, immutable`
- `catalog.json`：`Content-Type: application/json`，`Cache-Control: no-cache, max-age=0, must-revalidate`
- **不要**给分片设置 `Content-Encoding: zstd`；网页需要读取原始 Zstd 字节做逐片完整性校验。

R2 桶的 CORS 最少允许：

```json
[
  {
    "AllowedOrigins": ["https://8bitgo.com", "https://www.8bitgo.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Length", "ETag", "CF-Cache-Status"],
    "MaxAgeSeconds": 86400
  }
]
```

生产环境把 `assets.8bitgo.com` 接到本仓库的 ROM Worker；`worker/wrangler.toml` 的
`WEBGAMES` 绑定必须指向 `8bitgo-webgame`。Worker 会按 `/web/cs15/`、`/web/cs16/` 前缀从
这个桶读取，并给内容寻址分片返回一年 immutable、补正确的 `application/zstd`：

```bash
cd worker && npx wrangler deploy
```

## 上线验收

```bash
curl -sI https://assets.8bitgo.com/web/cs16/zstd-v1/catalog.json
curl -sI https://assets.8bitgo.com/web/cs16/zstd-v1/chunks/<清单里的SHA>.zst
```

确认分片没有 `Content-Encoding`，第二次请求出现 `CF-Cache-Status: HIT`。再分别打开 `de_dust2`
和最大的 `de_inferno`，确认网络请求来自 `assets.8bitgo.com`、控制台的 `packFormat` 是
`zstd-native` 或 `zstd-wasm`，并实际选 CT/T 出生，检查刀、HUD、雷达、声音和数字键切枪。
