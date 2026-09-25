# Ruffle 性能与稳定性基线

最后核对：2026-09-25。当前使用稳定版 `@ruffle-rs/ruffle@0.6.0`，运行文件位于
`public/ruffle/v0.6.0/`。

## 1. 固定策略

站点不再向玩家展示「运行档位」。所有 Flash 游戏固定使用：

- `quality: high`：提高舞台抗锯齿；
- iframe 内 `devicePixelRatio ≤ 1.25`：不改变页面和游戏时间轴，给高抗锯齿保留性能余量；
- 不覆写 `frameRate`：它会改变游戏逻辑速度，不是安全的性能开关；
- 不固定 `preferredRenderer`：让 Ruffle 按浏览器能力在 WebGPU / WebGL / Canvas 间自行选择；
- 页面隐藏且无人观看直播时暂停；确实有观众时才允许后台继续出帧。

DPR 2 的屏幕原本会创建宽高各两倍的画布，也就是四倍像素量。钳到 1.25 后是 1.5625 倍像素量：
比旧 1× 策略多渲染 56.25%，同时仍比原生 DPR 2 少约 61%。节省出的 GPU 余量用于 `high`
抗锯齿，以更低的像素成本改善斜线和曲线边缘。

## 2. 本轮发现并修复的问题

### 严重：冷启动被错误串行化

旧代码的注释说 SWF 与会话并行，实际却要等 `ruffle.js` 加载、自定义元素注册、在线存档和 SFS
配置全部完成，才调用 `loadGameBytes()`。慢链路上的等待时间被直接相加。

现在 `mount()` 一开始就启动游戏字节读取，和 iframe、loader、WASM、在线存档会话并行；退出或脚本
加载失败会用同一个 `AbortController` 取消未完成的 SWF 下载。

### 严重：所有 Flash 都被 SAS3 旁路拖住

SmartFoxServer 只服务 SAS3，旧代码却让每款 Flash 都请求 `/api/sfs/config`。sidecar 或接口异常时，
普通单机游戏也可能白等 1.5 秒。现在游戏白名单统一放在 `shared/sfs-games.js`，不在表里的游戏不会
发请求；前后端共用同一份名单，避免服务端声明与客户端门控漂移。

### 致命竞态：假 ready 导致黑框和能力永久缺失

Ruffle 的 `api.load()` 可能在字节交给 WASM 后就返回，而舞台元数据和 canvas 在后续任务才建立。
旧代码立即撤掉加载层并检查 canvas：玩家会偶发看到黑框，截图、录制和直播能力也会因为一次空查询
整局不出现。

现在调用前先监听 `loadedmetadata/loadeddata`，事件后再等一次合成帧；隐藏标签页不跑 rAF 时有定时
兜底，老 SWF 超过 8 秒也会放行，避免兼容性优化反过来卡死启动。

### 严重：高分屏像素量失控

`quality: high` 只影响舞台抗锯齿，不能阻止 Ruffle 按 DPR 建大画布。iframe 级 DPR 上限使 Retina
屏从 4× 像素量降到 1.5625×，同时解决旧 1× 策略在大屏上的模糊；覆盖失败时安全保留浏览器原值，
不影响启动。

### 较重：预热只拉 454 KB loader，遗漏 14 MB 核心

真正占冷启动的是 Ruffle WASM。同步脚本会从官方 `ruffle.js` 解析现代 / 兼容两套 core JS 与 WASM，
写进首次发布的 `bootstrap.json`。桌面鼠标悬停时复用 Ruffle 相同的五项能力探针，只预热正确的一套；
省流量与 2G 网络跳过大文件预热。升级后 loader 结构若变化，同步脚本会明确失败，避免静默猜错。
不能把字段原地加进已长期缓存的 `runtime.json`，否则已有访客可能一年都拿不到新清单。

### 较重：异常销毁可能残留音频线程

正常断开会让 Ruffle 自己释放 AudioContext；异常启动或 teardown 时不应只依赖 iframe GC。销毁流程
现在会在移除 iframe 后检查并关闭仍存活的 AudioContext，关闭失败只忽略，不阻塞换游戏。

## 3. 升级和验收

升级 Ruffle：

```bash
npm install
npm run ruffle
npm run test:ruffle-runtime
npm run build
```

`npm run ruffle` 必须重新生成 `bootstrap.json`；`check-ruffle.mjs` 会验证两套入口都恰好包含
一份 core JS 和一份 WASM，且目标确实在发布清单中。

回归至少覆盖：

- 参考图中的运行档位控件不再出现；
- 普通 Flash 启动不请求 `/api/sfs/config`，SAS3 仍可取得 socketProxy；
- Retina 设备上 Ruffle canvas 使用 1.25× 像素倍率，不回退到旧 1×，也不直接采用设备 DPR；
- 切换游戏后旧 SWF 下载停止、旧声音停止；
- 截图、录制、直播在首局加载后仍能识别 canvas；
- 在线存档游戏仍能加载 AGI1 / AGI2 桥。
