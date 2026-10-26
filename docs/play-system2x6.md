# Play! System 2x6 街机包

Play! 的浏览器构建现在可以启动它自带的 System 246 / System 147 驱动。普通街机 ROM 仍继续走 EmulatorJS；只有后台把逐游戏运行时明确选为 **Play! System 2x6**，播放器才会读取下面这种原始 ZIP 包。

## 打包与上传

1. 从 Play! 的游戏定义仓库取得对应的 `.arcadedef`，并准备定义里声明的 dongle ZIP 与盘镜像。
2. 用 `scripts/create-play-arcade-bundle.mjs` 生成包。对 Tekken 5.1，GDDD 硬盘 CHD 会先校验、提取，再重建为 Play! 所需的 DVD CHD；脚本会比对源盘和成品的逻辑 Data SHA1。`sys256.zip` 不是这份游戏定义引用的文件，不应塞进包里。
3. 在后台把游戏平台设为“街机”，模拟器引擎选“Play! System 2x6”，再上传生成的 `*-play.zip`。包会以原始 ZIP 上传，不能经过 8BG 加密，也不能自动拍平目录。

示例：

```sh
node scripts/create-play-arcade-bundle.mjs \
  --id tekken51 \
  --dongle /path/to/tekken51.zip \
  --disk /path/to/te51-dvd0.chd \
  --out /path/to/tekken51-play.zip
```

## 浏览器与资源限制

这个版本不是“CHD 按需流式读取”：Play! 上游的 libchdr 使用同步文件读取，而浏览器 HTTP Range 不能直接满足它。包最多 768 MiB，开局时先完整下载，再按 8 MiB 小块写入 WASM 虚拟文件系统；这样不会额外申请一块 460 MiB 的 JS 连续数组，但 WASM 内存仍需容纳整份 CHD。建议桌面浏览器至少有 1 GiB 空闲内存，手机端不建议使用。播放中读取 CHD 才进入真实游戏流程；仅看到模拟器画布或第一帧不能算通过。

Play! 官方 Web 构建仍属实验版本，目标游戏必须实机验证到可操作画面后才能标为可玩。

## Play! Web 核心构建

仓库里的 JS/WASM 是配套的一组，来源锁定在上游提交 `505dac73149fece41b04dd961078ce3011a8bed5`，并在其上添加网页 ArcadeUtils 启动入口。上游的 SQLite 静态库在 pthread 链接时缺少 shared-memory 所需的 WASM 原子特性，因此额外补了编译标志。补丁分别在 `patches/play/system2x6-web.patch` 和 `patches/play/sqlite-wasm-pthreads.patch`；更新时不要只换一个产物。

在已安装并启用 Emscripten 的上游 checkout 中，初始化子模块并应用补丁后运行：

```sh
git apply /path/to/8bitgo/patches/play/system2x6-web.patch
git -C deps/Dependencies apply /path/to/8bitgo/patches/play/sqlite-wasm-pthreads.patch
emcmake cmake --preset wasm-ninja --fresh
cmake --build --preset wasm-ninja-release --target Play -j 4
```

把 `build_cmake/build/wasm-ninja/Source/ui_js/Release/Play.js` 与 `Play.wasm` 成对复制到 `public/play/<PLAY_RUNTIME_GENERATION>/`，更新 `src/emulator/paths.ts` 的 `PLAY_RUNTIME_GENERATION` 和 `public/play/runtime.json`，再运行 `node scripts/check-play.mjs`。代次目录确保即使 CDN 忽略查询串，浏览器与边缘节点也会同时换到配套新文件。

## 来源

- Tekken 5.1 游戏定义来自 [Play! 官方 `tekken51.arcadedef`](https://github.com/jpd002/Play-/blob/master/arcadedefs/tekken51.arcadedef)。该文件随上游 Play! 的 BSD 风格许可证分发。
- Play! System 246 / 147 网页入口由上游 ArcadeUtils 的驱动实现提供；其 CHD 读取使用 libchdr 的同步文件流。
