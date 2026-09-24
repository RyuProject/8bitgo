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

## 边界

- 游戏入口必须与 8BitGo 同源；浏览器禁止父页面读取第三方跨域 iframe 的 Canvas。
- Canvas 从跨域图片/视频取材时，对方资源必须正确返回 CORS，否则画布会被污染，截图会失败。
- 纯 DOM/CSS 游戏没有可录制的 Canvas，目前不会显示截图和录像按钮。
- 多线程 Unity 仍需走跨源隔离页面，并配置 COOP/COEP；媒体桥不能替代这些响应头。

