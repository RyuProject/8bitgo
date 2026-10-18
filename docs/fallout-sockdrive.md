# Fallout DOS 版边下边玩发布流程

Fallout 当前完整包约 503MB，解压后约 544MB。普通 js-dos bundle 必须把 ZIP 下载完成才能启动；
真正的“边下边玩”需要把同一份游戏目录制成静态 Sockdrive，由 DOSBox-X 按磁盘扇区读取。

这仍然是纯 DOS 版，不会下载或启动 Win95：播放器把 Sockdrive 直接挂成 C:，然后运行
`FALLOUT.EXE`。原完整 ZIP 必须保留，清空流式盘字段即可立即回退整包模式。

## 后台发布

1. 部署包含纯 DOS Sockdrive 支持的前后端代码。
2. 编辑 `fallout`：平台保持 DOS，运行环境选择 DOSBox-X，共享 Windows 系统镜像留空。
3. English 启动文件填写 `FALLOUT.EXE`，原来的完整 ROM 地址保持不变并保存。
4. 在 English ROM 下方选择“生成流式盘”，上传加密前的原始 `fallout-dosbox-ultra.zip`。
   不要上传 `.8bg`；后台会把 ZIP 分片写入私有 staging，并在生产机持久队列中继续转换。
5. 等任务完成。它会发布到类似 `sockdrives/fallout-en-v<时间>` 的不可覆盖目录，并原子绑定
   English 完整回退包、`FALLOUT.EXE` 和同语言 Sockdrive。

解压内容超过 256MB 模板容量，制作机会自动使用官方 FAT32-2GB 模板；这是稀疏盘，玩家不会下载
2GB。首屏只按网络等级预热最多 16MB，之后由游戏的真实文件读取触发相应 `.raw` 分块下载。

## 上线验收

- 页面启动时不应再请求 `roms/dos/fallout.en.zip.8bg` 正文。
- 应先读取版本化目录里的 `sockdrive.metaj`、`preload_ranges.metaj` 和少量 `.raw`。
- DOSBox-X 启动后应直接进入 Fallout，配置保持 32MB、`core=normal`、`cycles=fixed 30000`。
- 新建角色、切换地图和播放音乐时可以继续请求新分块，但已经落入 OPFS 的分块不应重复下载。
- 游戏内保存一次，再点站点“保存进度”；刷新后应从 Sockdrive 专用存档槽恢复。
- 临时清空 English 流式盘后应能回到完整 ZIP 模式，证明回退包仍有效。

## 第二版启动热点

首版使用官方转换器的保守热点清单。正式试玩一次，从启动一直操作到进入 Vault 外地图，随后在
控制台运行 `brotliRanges()` 获取真实读取范围。用这份范围发布 **新的 v2 目录**；禁止覆盖 v1，
否则浏览器 OPFS 可能把两代磁盘分块混在一起。
