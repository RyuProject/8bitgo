/**
 * HTML5 / Unity 媒体能力回归。
 *
 * 重点守三件线上不会主动报错的事：不要把外层 1×1 辅助 Canvas 当游戏画面；第三方跨源页面
 * 不能冒充可录；Unity 的音频桥必须继续复用公共探针键，否则父子各包一层会产生叠音。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const {
  HTML5_MEDIA_BRIDGE_KEY,
  findHtml5Canvas,
  html5CanvasCapabilities,
  html5MediaBridge,
} = await import(fileURLToPath(new URL('../src/emulator/html5Media.ts', import.meta.url)))
const {
  HTML5_RUNTIME_BRIDGE_SOURCE,
  HTML5_RUNTIME_BRIDGE_VERSION,
  html5CanvasHasFrame,
  html5RuntimeSignal,
} = await import(fileURLToPath(new URL('../src/emulator/html5Lifecycle.ts', import.meta.url)))

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

console.log('\n── 游戏侧 8BitGo API ──')
{
  const bridgeSource = readFileSync(`${root}/public/html5-api/8bitgo-runtime-bridge.js`, 'utf8')
  const createFrame = ({ referrer = 'https://8bitgo.com/game/example', selector = '#game-root', matches = false, queryThrows = false, moduleScript = false } = {}) => {
    const messages = []
    const listeners = new Map()
    const documentListeners = new Map()
    const frameCallbacks = []
    const observers = []
    const timers = new Map()
    let nextTimerId = 0
    let visibility = 'visible'
    let now = 0
    const parent = { postMessage: (...args) => messages.push(args) }
    const win = {
      parent,
      addEventListener(type, handler) {
        const list = listeners.get(type) || []
        list.push(handler)
        listeners.set(type, list)
      },
      removeEventListener(type, handler) {
        listeners.set(type, (listeners.get(type) || []).filter((candidate) => candidate !== handler))
      },
      clearTimeout(timerId) { timers.delete(timerId) },
      requestAnimationFrame(callback) { frameCallbacks.push(callback) },
      setTimeout(callback, delay) {
        const timerId = ++nextTimerId
        timers.set(timerId, { callback, delay })
        return timerId
      },
    }
    let selectorMatches = matches
    const bridgeScript = {
      dataset: { readySelector: selector },
      getAttribute(name) { return name === 'data-ready-selector' ? selector : null },
    }
    const doc = {
      referrer,
      currentScript: moduleScript ? null : bridgeScript,
      documentElement: {},
      get visibilityState() { return visibility },
      addEventListener(type, handler) {
        const list = documentListeners.get(type) || []
        list.push(handler)
        documentListeners.set(type, list)
      },
      removeEventListener(type, handler) {
        documentListeners.set(type, (documentListeners.get(type) || []).filter((candidate) => candidate !== handler))
      },
      querySelector(scriptSelector) {
        if (scriptSelector.startsWith('script[')) return bridgeScript
        if (queryThrows) throw new Error('Invalid selector')
        return selectorMatches ? {} : null
      },
    }
    class Observer {
      constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this) }
      observe() {}
      disconnect() { this.disconnected = true }
    }
    class TestDate extends Date {
      static now() { return now }
    }
    const execute = () => runInNewContext(bridgeSource, {
      window: win,
      document: doc,
      URL,
      Date: TestDate,
      MutationObserver: Observer,
    })
    execute()
    return {
      messages,
      listeners,
      documentListeners,
      frameCallbacks,
      observers,
      win,
      timeout: () => [...timers.values()].find((timer) => timer.delay === 120_000)?.callback,
      flushTimer: (delay) => {
        const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay)
        if (!entry) return
        const [timerId, timer] = entry
        timers.delete(timerId)
        timer.callback()
      },
      hasTimer: (delay) => [...timers.values()].some((timer) => timer.delay === delay),
      execute,
      setSelectorMatches: (value) => { selectorMatches = value },
      setVisibility: (value) => {
        visibility = value
        for (const handler of documentListeners.get('visibilitychange') || []) handler()
      },
      setNow: (value) => { now = value },
    }
  }

  const frame = createFrame()

  const api = frame.win.EightBitGoBridge
  ok(api?.source === HTML5_RUNTIME_BRIDGE_SOURCE && api.version === 1, '运行桥提供带版本的游戏侧 EightBitGoBridge API')
  const earlyInputFrame = createFrame()
  earlyInputFrame.listeners.get('pointerdown')?.[0]?.()
  ok(!earlyInputFrame.messages.some(([message]) => message.type === 'first-interaction'), '加载界面的点击不会提前记成首次有效操作')
  earlyInputFrame.win.EightBitGoBridge.reportPlayable()
  earlyInputFrame.listeners.get('pointerdown')?.[0]?.()
  ok(earlyInputFrame.messages.at(-1)?.[0]?.type === 'first-interaction', '游戏可玩后才采集首次操作')
  api.reportFirstFrame()
  api.reportPlayable()
  api.reportPlayable()
  ok(frame.messages.map(([message]) => message.type).join(',') === 'first-frame,game-playable', '首帧和可玩信号幂等，重复调用不会重复记游玩')
  ok(frame.messages.every(([, origin]) => origin === 'https://8bitgo.com'), '生命周期消息只发往精确的 8BitGo 来源')
  api.reportFailure('x'.repeat(300))
  ok(frame.messages.length === 2, '游戏已可玩后迟到的失败信号不会误拆播放器')
  api.reportFirstInteraction()
  const pointerHandler = frame.listeners.get('pointerdown')?.[0]
  pointerHandler?.()
  ok(frame.messages.filter(([message]) => message.type === 'first-interaction').length === 1, '首次输入信号只上报一次')
  ok(api.getState().playable && api.getState().firstInteraction, '游戏可以读取桥接状态快照')
  ok(frame.observers[0].disconnected && !frame.timeout(), '游戏就绪后立即释放 DOM 观察器和超时器')
  ok(frame.documentListeners.get('visibilitychange')?.length === 0, '游戏就绪后移除后台计时监听')
  const duplicateFrame = createFrame()
  duplicateFrame.execute()
  ok(duplicateFrame.listeners.get('pointerdown')?.length === 1 && duplicateFrame.observers.length === 1, '同一页面重复加载运行桥不会重复装监听器')

  const selectorFrame = createFrame({ matches: false })
  const selectorObserver = selectorFrame.observers[0]
  selectorFrame.setSelectorMatches(true)
  selectorFrame.observers[0].callback()
  ok(selectorFrame.frameCallbacks.length === 0, 'DOM 变化先合并到低频检查，避免每帧查询游戏页面')
  selectorFrame.flushTimer(100)
  ok(!selectorObserver.disconnected && selectorFrame.messages.length === 0, '两帧确认期间继续保护启动观察与超时')
  selectorFrame.frameCallbacks.shift()()
  selectorFrame.frameCallbacks.shift()()
  ok(selectorFrame.messages.map(([message]) => message.type).join(',') === 'first-frame,game-playable', '异步出现的就绪选择器在两帧确认后报告')
  ok(selectorObserver.disconnected, '确认可玩后释放 DOM 观察器')

  const transientSelectorFrame = createFrame({ matches: true })
  transientSelectorFrame.setSelectorMatches(false)
  transientSelectorFrame.frameCallbacks.shift()()
  transientSelectorFrame.frameCallbacks.shift()()
  ok(transientSelectorFrame.messages.length === 0 && !transientSelectorFrame.observers[0].disconnected, '短暂出现后消失的加载节点不会误报可玩')
  transientSelectorFrame.setSelectorMatches(true)
  transientSelectorFrame.observers[0].callback()
  transientSelectorFrame.flushTimer(100)
  transientSelectorFrame.frameCallbacks.shift()()
  transientSelectorFrame.frameCallbacks.shift()()
  ok(transientSelectorFrame.messages.at(-1)?.[0]?.type === 'game-playable', '后续稳定出现的游戏界面仍能完成就绪确认')

  const noSelectorFrame = createFrame({ selector: '' })
  ok(noSelectorFrame.messages.length === 0, '没有就绪选择器时不会把脚本加载误判为游戏可玩')
  noSelectorFrame.win.EightBitGoBridge.reportPlayable()
  ok(noSelectorFrame.messages.map(([message]) => message.type).join(',') === 'first-frame,game-playable', '无选择器游戏可通过 API 明确报告可玩')

  const matchingFrame = createFrame({ matches: true })
  ok(matchingFrame.messages.length === 0 && matchingFrame.frameCallbacks.length === 1, '就绪选择器匹配后仍等待两帧再确认')
  matchingFrame.frameCallbacks.shift()()
  matchingFrame.frameCallbacks.shift()()
  ok(matchingFrame.messages.map(([message]) => message.type).join(',') === 'first-frame,game-playable', '等待两帧后才发送成功信号')
  ok(matchingFrame.observers[0].disconnected && !matchingFrame.timeout(), '选择器确认就绪后立即停止监听和计时')

  const moduleFrame = createFrame({ matches: true, moduleScript: true })
  moduleFrame.frameCallbacks.shift()()
  moduleFrame.frameCallbacks.shift()()
  ok(moduleFrame.messages.at(-1)?.[0]?.type === 'game-playable', '模块脚本环境也能从 DOM 找到自己的就绪选择器')

  const backgroundFrame = createFrame({ selector: '' })
  backgroundFrame.setVisibility('hidden')
  ok(!backgroundFrame.timeout(), '浏览器后台时暂停启动超时，避免标签页冻结后误报失败')
  backgroundFrame.setVisibility('visible')
  ok(typeof backgroundFrame.timeout() === 'function', '回到前台后恢复剩余启动等待时间')
  const expiredBackgroundFrame = createFrame({ selector: '' })
  expiredBackgroundFrame.setNow(120_001)
  expiredBackgroundFrame.setVisibility('hidden')
  expiredBackgroundFrame.setVisibility('visible')
  ok(expiredBackgroundFrame.win.EightBitGoBridge.getState().failed, '超时已到但回调被浏览器延后时，恢复前台会明确失败')

  const timeoutFrame = createFrame({ selector: '' })
  timeoutFrame.flushTimer(120_000)
  ok(timeoutFrame.messages[0]?.[0]?.type === 'failed' && timeoutFrame.win.EightBitGoBridge.getState().failed, '120 秒无就绪报告会明确失败并收尾')

  const invalidSelectorFrame = createFrame({ queryThrows: true })
  ok(invalidSelectorFrame.messages[0]?.[0]?.type === 'failed' && invalidSelectorFrame.messages[0]?.[0]?.detail === '网页游戏就绪选择器无效', '无效 CSS 选择器被转成明确启动错误')

  const untrustedFrame = createFrame({ referrer: 'https://example.org/' })
  ok(!untrustedFrame.win.EightBitGoBridge, '非 8BitGo 父页不会安装可通信的游戏桥')
  for (const host of ['cn.8bitgo.com', 'tv.8bitgo.com']) {
    const siteFrame = createFrame({ referrer: `https://${host}/game` })
    ok(Boolean(siteFrame.win.EightBitGoBridge), `${host} 本站入口可使用运行桥`)
  }
  ok(Boolean(createFrame({ referrer: 'http://localhost:5173/game' }).win.EightBitGoBridge), '本地回环开发页可联调运行桥')
  ok(!createFrame({ referrer: 'http://example.org/game' }).win.EightBitGoBridge, '普通 HTTP 站点不能绕过 HTTPS 来源限制')
  ok(!bridgeSource.includes('preserveDrawingBuffer = true') && !bridgeSource.includes('startLive'), '游戏侧桥不强制 WebGL 缓冲或重复创建直播链路')

  const hiddenMutationFrame = createFrame({ matches: false })
  hiddenMutationFrame.setVisibility('hidden')
  hiddenMutationFrame.observers[0].callback()
  ok(!hiddenMutationFrame.hasTimer(100), '后台标签页的 DOM 变化不会创建检查任务')
  hiddenMutationFrame.setVisibility('visible')
  ok(hiddenMutationFrame.hasTimer(100), '回到前台后恢复一次低频就绪检查')
}

console.log('\n── 启动就绪协议 ──')
{
  const playable = html5RuntimeSignal({
    source: HTML5_RUNTIME_BRIDGE_SOURCE,
    version: HTML5_RUNTIME_BRIDGE_VERSION,
    type: 'game-playable',
  })
  ok(playable?.type === 'game-playable', '运行时桥能把 game_playable 与 iframe load 分开')
  ok(html5RuntimeSignal({ source: HTML5_RUNTIME_BRIDGE_SOURCE, version: 2, type: 'game-playable' }) === null, '未知就绪协议版本不会误报成功')
  ok(html5RuntimeSignal({ source: 'other', version: 1, type: 'game-playable' }) === null, '其它 postMessage 不能冒充游戏就绪')
  ok(html5CanvasHasFrame({ width: 640, height: 360 }), '同源游戏的有效画布可作首帧兜底')
  ok(!html5CanvasHasFrame({ width: 1, height: 1 }), '占位画布不会被算成首帧')
}

console.log('\n── 发布文件与 WebGL 截图策略 ──')
{
  const bridgeSource = readFileSync(`${root}/public/html5-api/8bitgo-media-bridge.js`, 'utf8')
  const gameSdkSource = readFileSync(`${root}/public/html5-api/8bitgo-game-sdk.js`, 'utf8')
  const minifiedSdk = readFileSync(`${root}/public/html5-api/8bitgo-game-sdk.min.js`, 'utf8')
  const expectedMinifiedSdk = `${transformSync(gameSdkSource, { minify: true, target: 'es2017', legalComments: 'none' }).code.trim()}\n`
  const adapterSource = readFileSync(`${root}/src/emulator/adapters/html5.ts`, 'utf8')
  const recorderSource = readFileSync(`${root}/src/emulator/recorder.ts`, 'utf8')
  ok(bridgeSource.includes("var TAP_KEY = '__8bitgoAudioTap'"), '页面桥复用公共音频探针键，避免重复旁路造成叠音')
  ok(adapterSource.includes('startMediaMonitoring()'), 'HTML5 页面每次导航后都会重新发现媒体能力')
  const loadHandler = adapterSource.split("iframe.addEventListener('load'")[1].split("iframe.addEventListener('error'")[0]
  ok(loadHandler.includes('options.onIframeLoaded?.()'), 'iframe load 只上报独立的 iframe_loaded 阶段')
  ok(loadHandler.includes('options.onReadinessVisibilityChange?.(Boolean(frameDocument()))'), '每次导航都更新 HTML5 的同源可观测状态')
  ok(adapterSource.includes('let firstInteractionReported = false') && adapterSource.includes("iframe.addEventListener('focus', reportFirstInteraction)"), 'iframe 焦点与游戏桥共用一次性首次操作上报，避免重复统计')
  const playerSource = readFileSync(new URL('../src/emulator/EmulatorPlayer.tsx', import.meta.url), 'utf8')
  ok(playerSource.includes("session.runtime.id === 'html5' ? 'unknown' : 'observable'"), 'HTML5 等待 iframe 首次导航时不误记慢启动')
  ok(playerSource.includes("readinessState === 'unobservable'"), '跨源页面超时会记录为无法观测，而非游戏失败')
  ok(playerSource.includes('reportSlowStartupIfNeeded()'), '同源页面晚于 20 秒加载时仍补记真实慢启动')
  ok(!loadHandler.includes('options.onReady?.()'), 'iframe 第一次 load 不再冒充 game_playable')
  ok(adapterSource.includes('captureCanvasScreenshot(canvas)'), 'HTML5 截图走 WebGL 合成帧方案')
  ok(recorderSource.includes('canvas.captureStream()'), '截图不强开 preserveDrawingBuffer，不给每一帧增加复制成本')
  ok(gameSdkSource.includes('window.EightBitGoGameSDK'), '独立游戏 SDK 发布 8BitGo API')
  ok(minifiedSdk === expectedMinifiedSdk && minifiedSdk.length < gameSdkSource.length, '发布压缩版与可维护源码一致且体积更小')
  ok(!gameSdkSource.includes('createElement(\'script\')') && !gameSdkSource.includes('fetch('), '游戏 SDK 不下载或动态加载外部代码')
  /*
    父页消息桥的来源校验按行为测，不按写法测：9b842b6 为排查 PvZ 握手把 origin 判断拆成单独一段
    （不匹配时打一行日志），原来那条整行字符串断言就红了，而校验本身没变。这里把适配器里真实的
    处理函数抽出来，在 VM 里用伪造消息打一遍：别的窗口、同一 iframe 但 origin 不精确相等的都必须被丢掉。
  */
  const adapterHandler = (name, scope) => {
    const start = adapterSource.indexOf(`const ${name} = (event: MessageEvent) => {`)
    const end = adapterSource.indexOf(`\n  }\n  window.addEventListener('message', ${name})`, start)
    assert.ok(start >= 0 && end > start, `适配器里缺 ${name}`)
    const code = transformSync(`${adapterSource.slice(start, end)}\n  }`, { loader: 'ts' }).code
    runInNewContext(`${code};globalThis.handler = ${name}`, scope)
    return scope.handler
  }
  const constOf = (name) => {
    const raw = adapterSource.match(new RegExp(`const ${name} = ('[^']+'|\\d+)`))?.[1]
    assert.ok(raw, `适配器里缺 ${name}`)
    return raw.startsWith("'") ? raw.slice(1, -1) : Number(raw)
  }
  const gameFrame = {}
  const forgedOrigins = ['https://evil.example', 'http://pvz.8bitgo.com', 'https://pvz.8bitgo.com:8443', 'https://8bitgo.com']
  {
    let inits = 0
    const scope = {
      destroyed: false,
      gameSdkOrigin: 'https://pvz.8bitgo.com',
      iframe: { contentWindow: gameFrame },
      GAME_SDK_SOURCE: constOf('GAME_SDK_SOURCE'),
      GAME_SDK_VERSION: constOf('GAME_SDK_VERSION'),
      sendGameSdkInit: () => { inits++ },
      console: { info() {}, warn() {} },
    }
    const onGameSdkMessage = adapterHandler('onGameSdkMessage', scope)
    const hello = { source: scope.GAME_SDK_SOURCE, version: scope.GAME_SDK_VERSION, type: 'hello' }
    onGameSdkMessage({ source: {}, origin: scope.gameSdkOrigin, data: hello })
    for (const origin of forgedOrigins) onGameSdkMessage({ source: gameFrame, origin, data: hello })
    ok(inits === 0, '父页只接受当前游戏 iframe 的精确来源消息（游戏 SDK：别的窗口、相近 origin 都不会触发握手）')
    onGameSdkMessage({ source: gameFrame, origin: scope.gameSdkOrigin, data: hello })
    ok(inits === 1, '当前 iframe + 精确 origin 的 SDK 握手照常初始化')
    scope.destroyed = true
    onGameSdkMessage({ source: gameFrame, origin: scope.gameSdkOrigin, data: hello })
    ok(inits === 1, '销毁后不再响应 SDK 消息')
  }
  {
    let capsReports = 0
    const scope = {
      destroyed: false,
      saveBridgeOrigin: 'https://pvz.8bitgo.com',
      saveBridgeReady: false,
      iframe: { contentWindow: gameFrame },
      SAVE_BRIDGE_SOURCE: constOf('SAVE_BRIDGE_SOURCE'),
      SAVE_BRIDGE_VERSION: constOf('SAVE_BRIDGE_VERSION'),
      caps: new Set(),
      options: { onCaps: () => { capsReports++ } },
    }
    const onSaveBridgeMessage = adapterHandler('onSaveBridgeMessage', scope)
    const ready = { source: scope.SAVE_BRIDGE_SOURCE, version: scope.SAVE_BRIDGE_VERSION, type: 'ready' }
    onSaveBridgeMessage({ source: {}, origin: scope.saveBridgeOrigin, data: ready })
    for (const origin of forgedOrigins) onSaveBridgeMessage({ source: gameFrame, origin, data: ready })
    ok(!scope.saveBridgeReady && !scope.caps.has('saveState') && capsReports === 0, '存档桥同样只认当前 iframe 的精确 origin，伪造消息拿不到存档能力')
    onSaveBridgeMessage({ source: gameFrame, origin: scope.saveBridgeOrigin, data: ready })
    ok(scope.saveBridgeReady && scope.caps.has('saveState') && capsReports === 1, '当前 iframe + 精确 origin 的存档桥就绪后开放存档')
  }
  ok(adapterSource.includes("type: 'live-frame-ack'") && gameSdkSource.includes("message.type === 'live-frame-ack'"), '跨源直播等父页消费完画面再发送下一帧')
}

console.log('\n── 独立游戏 SDK 截图与录制 RPC ──')
{
  const sdkSource = readFileSync(`${root}/public/html5-api/8bitgo-game-sdk.min.js`, 'utf8')
  const messages = []
  const listeners = new Map()
  const parent = {
    postMessage(message, origin, transfer) {
      messages.push({ message, origin, transfer })
      if (message.type === 'hello') {
        for (const callback of listeners.get('message') || []) callback({
          source: parent,
          origin: 'https://8bitgo.com',
          data: { source: '8bitgo-host', version: 1, type: 'init', token: 'test-token' },
        })
      }
    },
  }
  const canvas = {
    tagName: 'CANVAS', width: 640, height: 360,
    toBlob(callback) { callback(new Blob(['png'], { type: 'image/png' })) },
    captureStream() { return new TestMediaStream([new TestTrack('video')]) },
  }
  const doc = {
    referrer: 'https://8bitgo.com/game/test', readyState: 'complete', currentScript: null,
    documentElement: {}, querySelectorAll: (selector) => selector === 'canvas' ? [canvas] : [],
    querySelector: () => null,
  }
  const win = {
    parent, GAME_CONFIG: {},
    addEventListener(type, callback) {
      const list = listeners.get(type) || []
      list.push(callback)
      listeners.set(type, list)
    },
    removeEventListener(type, callback) { listeners.set(type, (listeners.get(type) || []).filter((item) => item !== callback)) },
    setTimeout, clearTimeout,
  }
  const rafQueue = []
  const requestFrame = (callback) => { rafQueue.push(callback); return rafQueue.length }
  const cancelFrame = (id) => { if (id > 0 && id <= rafQueue.length) rafQueue[id - 1] = null }
  class TestTrack {
    constructor(kind) { this.kind = kind; this.stopped = false; this.readyState = 'live' }
    clone() { return new TestTrack(this.kind) }
    stop() { this.stopped = true; this.readyState = 'ended' }
  }
  class TestMediaStream {
    constructor(tracks = []) { this.tracks = [...tracks] }
    getTracks() { return [...this.tracks] }
    getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video') }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio') }
  }
  class TestMediaRecorder {
    static latest = null
    static isTypeSupported() { return false }
    constructor(stream, options) { this.stream = stream; this.mimeType = options?.mimeType || 'video/webm'; this.state = 'inactive'; TestMediaRecorder.latest = this }
    start() { this.state = 'recording' }
    stop() {
      this.state = 'inactive'
      const data = TestMediaRecorder.nextChunk || new Blob(['video'], { type: this.mimeType })
      TestMediaRecorder.nextChunk = null
      this.ondataavailable?.({ data })
      this.onstop?.()
    }
  }
  let liveAudioTrack = null
  let audioDisconnects = 0
  win.__8bitgoMediaBridge = {
    source: '8bitgo-media-bridge', version: 1,
    captureSources: () => ({
      audioNode: { connect() {}, disconnect() { audioDisconnects++ } },
      audioContext: {
        state: 'running',
        createMediaStreamDestination() {
          liveAudioTrack = new TestTrack('audio')
          return { stream: new TestMediaStream([liveAudioTrack]), disconnect() {} }
        },
      },
    }),
  }
  runInNewContext(sdkSource, {
    window: win, document: doc, MutationObserver: undefined, MediaRecorder: TestMediaRecorder,
    MediaStream: TestMediaStream, Blob, performance, console, URL,
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame,
    createImageBitmap: async () => ({ width: 640, height: 360, close() { this.closed = true } }),
  })
  const sdk = win.EightBitGoGameSDK
  ok(sdk?.source === '8bitgo-game-sdk' && sdk.version === 1, '游戏页获得自托管 8BitGo SDK API')
  ok(messages.some(({ message, origin }) => message.source === '8bitgo-game-sdk' && message.type === 'ready' && origin === 'https://8bitgo.com'), '游戏画布能力只报告给本站父页')
  const strictParent = { postMessage() {} }
  const strictWindow = { parent: strictParent, GAME_CONFIG: {}, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout }
  const strictDocument = {
    referrer: 'https://8bitgo.com/game/pvz', readyState: 'complete',
    currentScript: { dataset: { canvasSelector: 'body.game-mode canvas#canvas' } },
    documentElement: {}, querySelector: () => null, querySelectorAll: () => [canvas],
  }
  runInNewContext(sdkSource, {
    window: strictWindow, document: strictDocument, HTMLCanvasElement: class HTMLCanvasElement {},
    MutationObserver: undefined, Blob, performance, console, URL,
  })
  ok(!strictWindow.EightBitGoGameSDK.getState().ready, 'PvZ 选择器未出现时不会把隐藏启动画布当成直播画面')
  const deliver = (type, requestId, options) => {
    for (const callback of listeners.get('message') || []) callback({
      source: parent,
      origin: 'https://8bitgo.com',
      data: { source: '8bitgo-host', version: 1, type, token: 'test-token', requestId, options },
    })
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  deliver('request-screenshot', 1)
  await settle()
  const shot = messages.find(({ message }) => message.type === 'response' && message.requestId === 1)
  ok(shot?.message.ok && shot.message.result.type === 'image/png', '当前游戏页能安全回传截图 Blob')
  deliver('record-start', 2)
  await settle()
  ok(messages.some(({ message }) => message.type === 'response' && message.requestId === 2 && message.ok && message.result === true), '播放器可以按需启动游戏页本地录制')
  deliver('record-stop', 3)
  await settle()
  const recording = messages.find(({ message }) => message.type === 'response' && message.requestId === 3)
  ok(recording?.message.ok && recording.message.result.type === 'video/webm', '播放器可以取回游戏页完成的 WebM 录制')
  deliver('record-stop', 6)
  await settle()
  const repeatedStop = messages.find(({ message }) => message.type === 'response' && message.requestId === 6)
  ok(repeatedStop?.message.ok && repeatedStop.message.result === null, '录像交给播放器后立即释放 SDK 引用，重复停止不会返回旧录像')
  deliver('record-start', 4)
  await settle()
  TestMediaRecorder.latest.ondataavailable({ data: { size: 96 * 1024 * 1024 + 1 } })
  await settle()
  deliver('record-stop', 5)
  await settle()
  const oversized = messages.find(({ message }) => message.type === 'response' && message.requestId === 5)
  ok(oversized?.message.ok && oversized.message.result === null, '录像达到 96 MiB 后立即停止并丢弃，避免继续堆积内存')

  const audioDisconnectsBeforeLive = audioDisconnects
  deliver('live-start', 7, { sessionId: 'pvz-test-session', fps: 30 })
  const firstFrame = rafQueue.findIndex((callback) => typeof callback === 'function')
  const runQueuedFrame = (index, now) => {
    const callback = rafQueue[index]
    rafQueue[index] = null
    callback?.(now)
  }
  runQueuedFrame(firstFrame, 1000)
  await settle()
  const liveFrame = messages.find(({ message }) => message.type === 'live-frame')
  const liveStarted = messages.find(({ message }) => message.type === 'response' && message.requestId === 7)
  ok(liveFrame?.message.bitmap?.width === 640 && liveFrame.message.sessionId === 'pvz-test-session', 'SDK 只把当前直播会话的 ImageBitmap 帧转给播放器')
  ok(liveFrame?.transfer?.includes(liveFrame.message.bitmap) && liveFrame.transfer.includes(liveAudioTrack), '直播画帧和可用音轨使用可转移对象，避免跨页复制媒体数据')
  ok(liveStarted?.message.ok && liveStarted.message.result === true, '播放器收到首帧后 SDK 才确认直播采集启动')
  ok(rafQueue.filter((callback) => typeof callback === 'function').length === 0, '父页确认前不排队抓取第二帧')
  for (const callback of listeners.get('message') || []) callback({
    source: parent,
    origin: 'https://8bitgo.com',
    data: { source: '8bitgo-host', version: 1, type: 'live-frame-ack', token: 'test-token', sessionId: 'pvz-test-session', frameId: liveFrame.message.frameId },
  })
  const nextFrameIndex = rafQueue.findIndex((callback) => typeof callback === 'function')
  ok(nextFrameIndex >= 0, '父页 ACK 后才唤醒下一次画面采集')
  const liveFrameCountBeforeAckedCapture = messages.filter(({ message }) => message.type === 'live-frame').length
  runQueuedFrame(nextFrameIndex, 1034)
  await settle()
  ok(messages.filter(({ message }) => message.type === 'live-frame').length === liveFrameCountBeforeAckedCapture + 1, '每次 ACK 最多产生一帧，不会让 ImageBitmap 在途堆积')
  deliver('live-stop', 8, { sessionId: 'pvz-test-session' })
  await settle()
  ok(messages.some(({ message }) => message.type === 'response' && message.requestId === 8 && message.ok && message.result === true), '播放器停止直播后 SDK 结束帧循环')
  ok(audioDisconnects === audioDisconnectsBeforeLive + 1, '停播时 SDK 断开本地 WebAudio 旁路')

  const canvaslessMessages = []
  const canvaslessWindow = { parent: { postMessage: (...args) => canvaslessMessages.push(args) }, GAME_CONFIG: {}, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout }
  const canvaslessDocument = { referrer: 'https://8bitgo.com/game/dom-only', readyState: 'complete', currentScript: null, documentElement: {}, querySelector: () => null, querySelectorAll: () => [] }
  runInNewContext(sdkSource, { window: canvaslessWindow, document: canvaslessDocument, MutationObserver: undefined, Blob, performance, console, URL })
  canvaslessWindow.EightBitGoGameSDK.reportPlayable()
  ok(canvaslessMessages.some(([message]) => message.source === '8bitgo-runtime-bridge' && message.type === 'game-playable'), '纯 DOM 游戏仍可独立上报可玩状态')

  const untrustedMessages = []
  const untrustedWindow = { ...win, parent: { postMessage: (message) => untrustedMessages.push(message) } }
  runInNewContext(sdkSource, {
    window: untrustedWindow, document: { ...doc, referrer: 'https://example.org/' }, MutationObserver: undefined,
    MediaRecorder: TestMediaRecorder, MediaStream: TestMediaStream, Blob, performance, console, URL,
  })
  ok(untrustedMessages.length === 0, '非 8BitGo 父页不会收到游戏画面或录制结果')
}

console.log(`\n✅ HTML5 媒体测试通过（${passed} 项）`)
