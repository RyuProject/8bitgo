# HTML5 / Unity WebGL 截图与录像

8BitGo 会在同源 HTML5 游戏出现有效 Canvas 后自动开放截图和录像：截图为 PNG，录像优先
MP4、浏览器不支持时退回 WebM，最长 60 秒并直接下载到玩家设备，不上传服务器。

## 接入带声音的录像

普通页面不改代码也能录画面。要让 Unity、Emscripten 或其它 WebAudio 游戏的录像和直播带声音，
在**游戏引擎的第一个脚本之前**加入：

```html
<script src="/html5-api/8bitgo-media-bridge.js"></script>
```

时序是硬要求：桥需要先看到引擎创建 `AudioContext`，才能把送往扬声器的最终一级旁路一份给
录制器。放在 Unity 的 `*.loader.js` 后面，即使页面能正常发声，录像仍可能是静音。

这段桥只在当前游戏 iframe 内生效，不改玩家听到的音量，不上传媒体，也不会影响别的游戏。
游戏没有接桥时，播放器会在页面加载后做一次尽力补装；如果引擎还没创建声音上下文也能成功，
但不能作为从第一声开始完整录音的保证。

## 游戏加载器报告就绪（可选）

8BitGo 的播放器会自动观察有效 Canvas；由独立 Pages 部署的游戏也可以加载运行桥，并用选择器明确
告诉播放器什么时候出现可玩界面：

```html
<script src="/html5-api/8bitgo-runtime-bridge.js" data-ready-selector="#game-root"></script>
```

如果游戏没有稳定的 DOM 选择器，可在引擎首帧和加载失败时主动报告：

```js
window.EightBitGoBridge?.reportFirstFrame()
window.EightBitGoBridge?.reportPlayable()
window.EightBitGoBridge?.reportFailure('游戏资源加载失败')
```

只有在玩家确实能开始操作时才调用 `reportPlayable()`。`reportFirstInteraction()` 可在游戏确认第一次有效输入时调用；
播放器会把真实玩家操作用于启动统计。桥只向嵌入它的 8BitGo 页面报告当前游戏状态。截图、录像和直播继续走
播放器现有链路，游戏脚本不接触账号令牌，也不会另开一条推流。已接入 `data-ready-selector` 的页面无需再调用 `reportPlayable()`。

普通 HTML5 页面若要录入游戏声音，还需在游戏引擎脚本前另外加载上面的媒体桥；运行桥只处理生命周期。

## Unity 原生截图扩展（可选）

默认截图走 `canvas.captureStream()`，因此不需要打开 `preserveDrawingBuffer`，不会为了偶尔一次
截图给每一帧增加显存复制成本。如果某个 Unity 构建仍需使用自己的截图方法，可以登记一个
返回 PNG `Blob` 的函数：

```js
window.__8bitgoMediaBridge?.setScreenshotProvider(async () => {
  return myUnityScreenshotBlob()
})
```

不登记或返回 `null` 时自动退回通用 Canvas 截图。

## 接入 8BitGo 游戏 SDK（可选）

SDK 由 8BitGo 自己托管，不会再加载外部游戏平台脚本。只在需要 8BitGo 生命周期报告、跨域截图或跨域本地录制的游戏里主动加入；
不要把它自动注入所有游戏。页面可以从本站或独立 Pages 项目读取：

```html
<!-- 需要把游戏声音带入跨域录制时，必须放在引擎脚本前。 -->
<script src="/html5-api/8bitgo-media-bridge.js"></script>
<script src="/html5-api/8bitgo-game-sdk.min.js"></script>
```

SDK 会观察 Canvas，但不改 WebGL 创建参数、不包游戏循环，也不常驻抓帧。播放器收到截图、录制或直播请求后，才让游戏页执行对应采集。录像最长 60 秒，累计超过 96 MiB 会立即停止并丢弃，避免异常高码率占满浏览器内存：

```js
window.EightBitGoGameSDK?.on('ready', (state) => console.log('游戏已就绪', state))
window.EightBitGoGameSDK?.reportFirstFrame()
window.EightBitGoGameSDK?.reportPlayable()
window.EightBitGoGameSDK?.reportFailure('游戏资源加载失败')
```

游戏也可指定主画布或自定义录制流：

```js
window.EightBitGoGameSDK?.registerCanvas(document.querySelector('#game canvas'))
window.EightBitGoGameSDK?.registerCaptureStream((canvas, fps) => canvas.captureStream(fps))
```

播放器会在游戏明确接入 SDK 后开放截图和录制按钮，操作仍由 8BitGo 工具栏发起。跨域录制在游戏页本地生成 MP4/WebM Blob，再只回传给嵌入它的播放器；不上传录制内容，不传递账号、令牌或玩家存档。

PvZ 的 Pages 中英文游戏入口和 Minecraft Eaglercraft Pages 游戏页会加载同一个 SDK，并在游戏音频初始化前安装媒体桥。Minecraft 从主站进入时直接嵌入 Eaglercraft 游戏页，避免中间启动壳的导航丢掉父页来源校验。用户开始游玩时，SDK 才以最高 30fps 将受限尺寸的 `ImageBitmap` 转给当前播放器；浏览器支持跨页音轨转移时也会带上游戏声音。播放器把它接入原有 8BitGo 直播推流。停播、页面跳转或播放器销毁时会停止帧循环并释放接收资源。浏览器不支持画帧传递或 Canvas 读取时，保留现有「分享标签页」兜底。其它游戏页面不会自动加载 SDK。

消息同时核对当前 iframe、游戏页的精确来源、协议版本和请求编号。顶层单独打开 SDK 页面时不会建立父页通信；referrer 缺失或浏览器限制 Canvas 读取时，SDK 的可选能力会关闭，游戏本身仍可运行。

## 边界

- 浏览器禁止父页面直接读取第三方跨域 iframe 的 Canvas；经精确来源校验的 8BitGo SDK 可选择转移画帧。
- Canvas 从跨域图片/视频取材时，对方资源必须正确返回 CORS，否则画布会被污染，截图会失败。
- 纯 DOM/CSS 游戏没有可录制的 Canvas，目前不会显示截图和录像按钮。
- 多线程 Unity 仍需走跨源隔离页面，并配置 COOP/COEP；媒体桥不能替代这些响应头。
