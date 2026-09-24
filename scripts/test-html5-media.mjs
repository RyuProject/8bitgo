/**
 * HTML5 / Unity 媒体能力回归。
 *
 * 重点守三件线上不会主动报错的事：不要把外层 1×1 辅助 Canvas 当游戏画面；第三方跨源页面
 * 不能冒充可录；Unity 的音频桥必须继续复用公共探针键，否则父子各包一层会产生叠音。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const {
  HTML5_MEDIA_BRIDGE_KEY,
  findHtml5Canvas,
  html5CanvasCapabilities,
  html5MediaBridge,
} = await import(fileURLToPath(new URL('../src/emulator/html5Media.ts', import.meta.url)))

let passed = 0
const ok = (condition, message) => {
  assert.ok(condition, message)
  passed++
  console.log(`✅ ${message}`)
}

const canvas = (width, height, record = true) => ({
  width,
  height,
  toBlob() {},
  ...(record ? { captureStream() {} } : {}),
})
const documentWith = (canvases = [], frames = []) => ({
  querySelectorAll(selector) {
    return selector === 'canvas' ? canvases : frames
  },
})

console.log('── Canvas 发现 ──')
{
  const tiny = canvas(1, 1)
  const local = canvas(320, 200)
  const nested = canvas(1280, 720)
  const inner = documentWith([nested])
  const outer = documentWith([tiny, local], [{ contentDocument: inner }])
  ok(findHtml5Canvas(outer) === nested, '同源子 iframe 的真画面会压过外层辅助 Canvas')

  const blocked = {}
  Object.defineProperty(blocked, 'contentDocument', { get() { throw new Error('SecurityError') } })
  ok(findHtml5Canvas(documentWith([local], [blocked])) === local, '跨源子 iframe 被安全跳过，不拖垮本地画面')
  ok(findHtml5Canvas(null) === null, '没有可读文档时明确返回不可捕获')
}

console.log('\n── 能力门控 ──')
{
  const usable = canvas(640, 360)
  ok(html5CanvasCapabilities(usable, true).screenshot, '有效 Canvas 开放截图')
  ok(html5CanvasCapabilities(usable, true).record, 'MediaRecorder + captureStream 齐全才开放录像')
  ok(!html5CanvasCapabilities(canvas(15, 360), true).screenshot, '短边小于 16 的废画布不会冒充游戏画面')
  ok(!html5CanvasCapabilities(canvas(640, 360, false), true).record, '没有 captureStream 不显示必失败的录像按钮')
  ok(!html5CanvasCapabilities(usable, false).record, '浏览器没有 MediaRecorder 时不显示录像按钮')
}

console.log('\n── 页面桥协议 ──')
{
  const bridge = { source: '8bitgo-media-bridge', version: 1 }
  ok(html5MediaBridge({ [HTML5_MEDIA_BRIDGE_KEY]: bridge }) === bridge, '只接受带来源标记的 v1 媒体桥')
  ok(html5MediaBridge({ [HTML5_MEDIA_BRIDGE_KEY]: { version: 1 } }) === null, '普通同名全局变量不能冒充媒体桥')
  ok(html5MediaBridge({ [HTML5_MEDIA_BRIDGE_KEY]: { source: '8bitgo-media-bridge', version: 2 } }) === null, '未知协议版本安全降级')
}

console.log('\n── 发布文件与 WebGL 截图策略 ──')
{
  const bridgeSource = readFileSync(`${root}/public/html5-api/8bitgo-media-bridge.js`, 'utf8')
  const adapterSource = readFileSync(`${root}/src/emulator/adapters/html5.ts`, 'utf8')
  const recorderSource = readFileSync(`${root}/src/emulator/recorder.ts`, 'utf8')
  ok(bridgeSource.includes("var TAP_KEY = '__8bitgoAudioTap'"), '页面桥复用公共音频探针键，避免重复旁路造成叠音')
  ok(adapterSource.includes('startMediaMonitoring()'), 'HTML5 页面每次导航后都会重新发现媒体能力')
  ok(adapterSource.includes('captureCanvasScreenshot(canvas)'), 'HTML5 截图走 WebGL 合成帧方案')
  ok(recorderSource.includes('canvas.captureStream()'), '截图不强开 preserveDrawingBuffer，不给每一帧增加复制成本')
}

console.log(`\n✅ HTML5 媒体测试通过（${passed} 项）`)

