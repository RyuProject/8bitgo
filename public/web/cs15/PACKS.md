# CS15 数据包：打包与 R2 发布

历史 `base.zip.gz` 下载约 550MB、展开约 1.05GB。它不只是“gzip 压得不够”：包里还混入了
其它地图、完整 `pak0.pak`、桌面 DLL/SO、回放和大量自定义地图资源。新的打包流程会把
`pak0.pak` 还原成可筛选的散文件，只保留浏览器 CS 对局真正会用的公共资源，再把每张地图的
BSP、雷达、天空盒和 WAD 单独打包。

生成最终包：

```bash
brew install brotli                    # Ubuntu: apt install brotli
npm run cs15:repack                    # Brotli 11 + gzip 9 兜底
npm run test:cs15                      # 每条 CRC、文件数、总字节和 SHA-256 全部复核
```

产物写到被 Git 忽略的 `public/web/cs15/packs/`：

- `base-cs.<hash>.zip.br`：R2 主包；必须设置 `Content-Type: application/zip` 和
  `Content-Encoding: br`。浏览器网络层会原生流式解码，不引入会产生 1GB 缓冲区的 zstd WASM。
- `*.zip.gz`：R2 头配错、代理剥掉 Brotli 编码时的兜底；故意不设置 `Content-Encoding`，
  由页面的 `DecompressionStream` 流式解压。
- `index.json`：包名和展开后的文件数/字节数。它必须最后上传，并设 `no-cache`。

自动上传（需要本机已登录 Wrangler）：

```bash
npm run cs15:upload -- --bucket <你的R2桶名>
```

默认对象前缀是 `web/cs15/packs`，生产加载器默认读取
`https://assets.8bitgo.com/web/cs15/packs`；临时验证其它桶可在页面地址追加
`?packsroot=https://你的域名/前缀`。上传脚本会在清单发布后从公开域名 HEAD 每个主包，检查
状态码、长度、CORS 和 `Content-Encoding: br`；测试域名可传 `--public-base https://…`。

R2 桶还必须允许站点跨域 GET/HEAD。最小 CORS 规则：

```json
[
  {
    "AllowedOrigins": ["https://8bitgo.com", "https://www.8bitgo.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Length", "ETag"],
    "MaxAgeSeconds": 86400
  }
]
```

上线前检查主包响应头；`Content-Encoding: br` 少了时页面会自动改用 gzip，但传输体积会变大：

```bash
curl -sI https://assets.8bitgo.com/web/cs15/packs/<清单里的主包名>
```

最终验收不是“能下载完”就算成功：实际进入 `de_dust2`，选 CT/T 出生，确认刀、雷达、数字键切枪
和自动 Bot 都正常；再在浏览器网络面板确认主包命中 `.zip.br`，没有请求 `.zip.gz`。
