# Ruffle 性能与稳定性基线

最后核对：2026-11-05。Ruffle 版本以 `node_modules/@ruffle-rs/ruffle/package.json` 和
`src/emulator/paths.ts` 为准，运行文件位于对应的 `public/ruffle/v<version>/`。

## 1. 自适应策略

站点不再向玩家展示「运行档位」。Ruffle iframe 在加载时按浏览器公开的粗略硬件信号选择初始档，
游戏运行后再用 iframe 自身的动画回调耗时与掉帧比例调整画布像素密度：

- 极低配置（≤2 个逻辑核心或 ≤2 GB 设备内存）：DPR 上限 0.8；
- 中低配置（≤4 个核心或 ≤4 GB 内存）、高 DPR 触屏设备、或浏览器隐藏硬件信息：DPR 上限 1；
- 其它设备：DPR 上限 1.25；
- 连续两个 3 秒采样窗显示明显的高回调耗时 / 帧节奏异常时降一档；持续约 30 秒有余量才恢复一档；
- Ruffle 检测到 `window.devicePixelRatio` 变化后会在下一次 tick 重建画布 backing store，因此切档不重载 SWF；
- 不覆写 `frameRate`：它会改变游戏逻辑速度，不是安全的性能开关；
- 默认不固定 `preferredRenderer`。⚠️ 注意 Ruffle 0.7.1 的默认顺序是 wgpu-webgl → webgl → canvas，
  **不会自己选 WebGPU**（浏览器有 `navigator.gpu` 也一样，控制台写的是 `Used renderer: wgpu-webgl`）；
- 唯一例外：SWF 引用了 `flash.display3D`（Starling / Away3D 等 Stage3D 内容）且浏览器有 WebGPU 时，
  给 `preferredRenderer: 'webgpu'`（`src/emulator/flashStage3D.ts`，CWS 边解边找，命中即停，最坏约 80ms，
  与旧 SDK 规则并行）。WebGPU 建不起来 Ruffle 会自己退回 wgpu-webgl；
- 降档是试验：之后两个有效窗口没有可测改善（回调或帧间隔 p90 降 15%，或不再过载）就退回原档，并锁为本局下限；
  回调 ≥ 150ms 的窗口算加载长任务，不参与判断，降档试验期间遇到它也直接退回（前后负载不可比）；
- 页面隐藏且无人观看直播时暂停；确实有观众时才允许后台继续出帧。

Ruffle 没有公开 FPS 或 GPU 呈现时间 API；适配器在**专用同源 iframe**内包装 requestAnimationFrame，
统计渲染回调 p90 执行时间和 RAF 间隔分布。它是主线程工作量 / 帧节奏的代理指标，不等价于屏幕实际呈现
FPS，也不能单独定位显卡瓶颈。统计每 3 秒聚合一次，使用固定环形区和可复用排序缓冲；稳定回调函数复用
包装器，不在每次重复排帧时重复分配包装闭包。至少 12 个间隔样本才判断，使低帧率游戏也能进入控制，
同时不让极少样本触发误降档。启动加载动画、SWF 解码和首屏建纹理完成后会清空预热样本，再开始首个窗口。
暂停、切后台或样本不足时会清空样本及连续判定计数，避免把不连续时段拼成“连续过载”；销毁时清理计时器并
还原原生 RAF。被浏览器拒绝覆盖 DPR 或 RAF 时自动
退回初始硬件档，不影响启动。

帧节奏按「游戏目标帧间隔」与「窗口内稳定 RAF 间隔」中的较宽值判断，不把稳定 30 Hz 显示 / 内容误判成掉帧；
连续慢窗降档，恢复要求持续余量。浏览器节能限帧、系统合成器和 GPU 计时不能从普通 RAF 完全区分；因此这项
策略只按可观测的回调负载与明显不均匀间隔调整像素比，不宣称能识别所有 GPU 瓶颈或保证任何设备满帧。

注意：Ruffle v0.7.1 的 `Stage.quality` 目前只保存 Flash 脚本可读取的值，Ruffle renderer 暂未用它改变
抗锯齿或位图过滤；因此不把它当作性能开关，也不向 Flash 脚本写入 LOW/MEDIUM 等值，避免改变游戏可见状态。
真正起作用的档位是 backing-store 像素比。动态切档只改变内部画布分辨率，游戏时间轴、输入、音频、存档、
舞台 CSS 尺寸与渲染后端均不动。

DPR 2 的屏幕原本会创建宽高各两倍的画布，也就是四倍像素量。中低档钳到 1 后可比旧的 1.25 档少
约 36% 像素填充；高档仍保留 1.25 上限，既比原生 DPR 2 少约 61%，也维持大屏清晰度。播放器按
`ruffleStageRenderPlan` 把 CSS 渲染面积封顶，再由 DPR 选择额外像素密度。

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

### 严重：高分屏像素量失控与低配画质固定过高

旧做法选择 `Stage.quality`，但 Ruffle 目前不会据此改变渲染质量。现在依据 `deviceMemory`、
`hardwareConcurrency`、触屏高 DPR 等提示决定初始 backing-store 像素上限，再结合 iframe 动画回调负载
自动降 / 升档。高档到均衡档减少约 36% 像素填充；均衡档到省资源档再减少 36%，两档累计约 59%。
未知设备从均衡档起步；若 RAF / DPR 接口被限制，沿用初始档位，绝不让优化造成启动失败。

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
- 高配置 Retina 设备上 Ruffle canvas 使用 1.25× 上限；低配 / 信息未知设备从 0.8× / 1×起步；
- Ruffle iframe RAF 回调耗时与异常帧间隔触发连续降档；长时间有余量后再恢复，且不重载游戏 / 改游戏 FPS；
- 稳定 30 Hz 与 5 FPS SWF 不被样本门槛误伤；启动样本隔离，采样器使用固定缓冲、暂停时清样本，销毁还原 RAF；
- 切换游戏后旧 SWF 下载停止、旧声音停止；
- 截图、录制、直播在首局加载后仍能识别 canvas；
- 在线存档游戏仍能加载 AGI1 / AGI2 桥。


## Stage3D 与渲染后端（2026-11-05《传染恐慌：幸存者》）

SWF v25、17.5MB（CWS，解开 28.6MB）、960×640 @ 60 FPS，Starling。Apple M 系 Mac，120Hz 屏，同一局对照：

| 场景 | wgpu-webgl（默认） | webgpu |
| --- | --- | --- |
| 主菜单每帧回调 | 24ms → 只有约 40 FPS | 0.2～3ms，满 60 FPS |
| 关卡内每帧回调 | — | 5～6ms（按 60 FPS 隔帧出现） |
| 加载「Resurrecting Zombies」 | 670ms / 帧，单帧最长 3.9～5.2s | 相同（是 AVM2 解析，不是渲染） |
| 画布像素 1.25× vs 0.8× | 菜单都是 24ms，降分辨率没用 | — |

- `webgl` / `canvas` 后端：`createContext3D` 报 "Not yet implemented"，游戏黑屏且每帧刷一条错误。
- WebGPU 画布的 `captureStream()` 截图 / 录像 / 直播实测有真实像素。
- 旧的自适应逻辑在加载长任务里把画布降到 0.8×，进游戏后回调 5～6ms 达不到「≤ 预算 20%」的恢复门槛，
  整局都糊；现在长任务窗口不参与，且降档无效会退回。
