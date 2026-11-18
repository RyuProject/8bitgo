import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WEB_GAME_PAGES } from '../deploy/cloudflare-pages/web-games-config.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const outputRoot = resolve(repo, '.cloudflare-pages')
const bridgeSource = readFileSync(resolve(repo, 'public/html5-api/8bitgo-runtime-bridge.js'))
const gameSdkSource = readFileSync(resolve(repo, 'public/html5-api/8bitgo-game-sdk.min.js'))
const mediaBridgeSource = readFileSync(resolve(repo, 'public/html5-api/8bitgo-media-bridge.js'))
const bridgeVersion = createHash('sha256').update(bridgeSource).digest('hex').slice(0, 16)
const gameSdkVersion = createHash('sha256').update(gameSdkSource).digest('hex').slice(0, 16)
const mediaBridgeVersion = createHash('sha256').update(mediaBridgeSource).digest('hex').slice(0, 16)
const names = process.argv.slice(2).filter((value) => !value.startsWith('-'))
const selected = names.length ? names : Object.keys(WEB_GAME_PAGES)

const walk = (root) => {
  const files = []
  const visit = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, item.name)
      if (item.isDirectory()) visit(path)
      else if (item.isFile()) files.push(path)
    }
  }
  visit(root)
  return files
}

for (const name of selected) {
  const config = WEB_GAME_PAGES[name]
  assert.ok(config, `未知 Pages 游戏：${name}`)
  const root = resolve(outputRoot, name)
  assert.ok(existsSync(root), `${name} 尚未构建`)
  assert.ok(existsSync(resolve(root, config.entry.replace(/^\//, ''), 'index.html')) ||
    existsSync(resolve(root, config.entry.replace(/^\//, '').replace(/\/$/, '/index.html'))), `${name} 入口缺失`)
  assert.ok(existsSync(resolve(root, '_worker.js')), `${name} 缺少 _worker.js`)
  assert.deepEqual(readFileSync(resolve(root, 'html5-api/8bitgo-runtime-bridge.js')), bridgeSource, `${name} 运行桥与主仓库版本不一致`)
  assert.deepEqual(readFileSync(resolve(root, 'html5-api/8bitgo-game-sdk.min.js')), gameSdkSource, `${name} 压缩游戏 SDK 与主仓库版本不一致`)
  assert.deepEqual(readFileSync(resolve(root, 'html5-api/8bitgo-media-bridge.js')), mediaBridgeSource, `${name} 媒体桥与主仓库版本不一致`)
  assert.ok(gameSdkSource.toString('utf8').includes('window.EightBitGoGameSDK'), `${name} 游戏包缺少 8BitGo SDK API`)
  assert.ok(!existsSync(resolve(root, 'web', config.sourceDir, '_framework')), `${name} 错把超大 _framework 打进 Pages`)
  for (const excluded of config.excludeDirs || []) {
    assert.ok(!existsSync(resolve(root, 'web', config.sourceDir, excluded)), `${name} 错把 ${excluded} 打进 Pages`)
  }

  const files = walk(root)
  assert.ok(files.length <= 20_000, `${name} 文件数超过 Pages 免费版上限`)
  for (const file of files) {
    assert.ok(statSync(file).size <= 25 * 1024 * 1024, `${name}/${relative(root, file)} 超过 25 MiB`)
  }

  for (const [file] of config.html) {
    const html = readFileSync(resolve(root, 'web', config.sourceDir, file), 'utf8')
    assert.ok(html.includes(`/html5-api/8bitgo-runtime-bridge.js?v=${bridgeVersion}`), `${name}/${file} 没有当前内容指纹的 Pages 运行桥`)
    if (name === 'pvz') {
      assert.match(html, /h==='8bitgo-pvz\.pages\.dev'/, `${name}/${file} 没有放行自己的固定 Pages 域名`)
      if (file === 'cn/index.html' || file === 'en/index.html') {
        assert.match(html, /PVZ_DATA_BASE=location\.origin\+'\/pvz-data\/'/, `${name}/${file} 没有使用 Pages 同源数据代理`)
        assert.doesNotMatch(html, /PVZ_DATA_BASE='https:\/\/download\.8bitgo\.com/, `${name}/${file} 未使用 Pages 同源数据代理`)
        assert.ok(html.includes(`/html5-api/8bitgo-game-sdk.min.js?v=${gameSdkVersion}`), `${name}/${file} 没有加载当前版本 8BitGo SDK`)
        assert.match(html, /data-canvas-selector="body\.game-mode canvas#canvas"/, `${name}/${file} 没有把 PvZ 主画布登记给 SDK`)
        assert.ok(html.indexOf('8bitgo-media-bridge.js?v=') >= 0 && html.indexOf('8bitgo-media-bridge.js?v=') < html.indexOf('pvz-wasm-loader.js'), `${name}/${file} 必须在 PvZ 音频运行时前安装媒体桥`)
      }
    } else if (name === 'minecraft') {
      assert.ok(html.includes(`/html5-api/8bitgo-game-sdk.min.js?v=${gameSdkVersion}`), `${name}/${file} 没有加载当前版本 8BitGo SDK`)
      assert.match(html, /data-canvas-selector="body#game_frame canvas"/, `${name}/${file} 没有把 Minecraft 画布登记给 SDK`)
      assert.ok(html.indexOf('8bitgo-media-bridge.js?v=') >= 0 && html.indexOf('8bitgo-media-bridge.js?v=') < html.indexOf('src="classes.js"'), `${name}/${file} 必须在 Eaglercraft 初始化前安装媒体桥`)
    } else if (name === 'cs16') {
      assert.ok(html.includes(`/html5-api/8bitgo-game-sdk.min.js?v=${gameSdkVersion}`), `${name}/${file} 没有加载当前版本 8BitGo SDK`)
      assert.match(html, /data-canvas-selector="#canvas"/, `${name}/${file} 没有把 CS1.6 主画布登记给 SDK`)
      assert.ok(html.indexOf('8bitgo-media-bridge.js?v=') >= 0 && html.indexOf('8bitgo-media-bridge.js?v=') < html.indexOf('cs16.bundle.js'), `${name}/${file} 必须在 Xash 初始化前安装媒体桥`)
    } else if (name === 'subway') {
      const bootstrap = readFileSync(resolve(root, 'web/subway-surfers/js/8bitgo.js'), 'utf8')
      assert.ok(bootstrap.includes(`/html5-api/8bitgo-game-sdk.min.js?v=${gameSdkVersion}`), `${name}/${file} 没有加载当前版本 8BitGo SDK`)
      assert.ok(html.includes(`/html5-api/8bitgo-media-bridge.js?v=${mediaBridgeVersion}`), `${name}/${file} 没有加载当前版本 8BitGo 媒体桥`)
      assert.ok(html.indexOf('8bitgo-media-bridge.js?v=') < html.indexOf('src="js/boot.js"'), `${name}/${file} 必须在游戏引擎前安装媒体桥`)
    } else {
      assert.doesNotMatch(html, /\/html5-api\/8bitgo-game-sdk\.min\.js\?v=/, `${name}/${file} 不应被 PvZ SDK 改动影响`)
    }
    if (name === 'gtavc') {
      assert.match(html, /<meta name="robots" content="noindex,nofollow" \/>/, 'GTA VC 运行端不得被收录')
      assert.match(html, /\/web\/gta-vc\/manifest\.json/, 'GTA VC PWA 清单路径没有带 Pages 基址')
      assert.doesNotMatch(html, /\/gta-vice-city-wasm\//, 'GTA VC 仍引用上游 GitHub Pages 路径')
      assert.match(html, /gta-vc-7z-import\.js/, 'GTA VC 缺少 .7z 与 R2 导入脚本')
    }
    if (name === 'undertale') {
      assert.match(html, /aria-label="游戏加载进度"/, 'UNDERTALE 首页必须只显示自动启动进度条')
      assert.doesNotMatch(html, /下载授权版并启动|选择游戏文件夹/, 'UNDERTALE 首页不得要求玩家手动点击启动')
    }
  }

  if (name === 'gtavc') {
    assert.ok(existsSync(resolve(root, 'web/gta-vc/engine/vc-sky-en-v6.wasm')), 'GTA VC Pages 包缺少引擎')
    assert.ok(readdirSync(resolve(root, 'web/gta-vc/assets')).some((file) => /^worker-[\w-]+\.js$/.test(file)),
      'GTA VC Pages 包缺少 PC 安装目录转换 Worker')
    assert.ok(existsSync(resolve(root, 'web/gta-vc/7z-extractor.worker.js')), 'GTA VC Pages 包缺少 7z 解包 Worker')
    assert.ok(existsSync(resolve(root, 'web/gta-vc/vendor/un7z-opfs/dist/7zz.wasm')), 'GTA VC Pages 包缺少 7z WASM')
    assert.ok(!files.some((file) => /(?:^|\/)(?:game\.tar\.gz|gta3\.img|[^/]+\.(?:7z|rar))$/i.test(relative(root, file).replaceAll('\\', '/'))),
      'GTA VC Pages 包不得包含游戏数据')
  }
  if (name === 'undertale') {
    const app = readFileSync(resolve(root, 'web/undertale/app.js'), 'utf8')
    const distribution = JSON.parse(readFileSync(resolve(root, 'web/undertale/distribution-manifest.json'), 'utf8'))
    assert.match(app, /navigator\.storage\.getDirectory/, 'UNDERTALE Pages 丢失 OPFS 本地存储')
    assert.match(app, /file\.stream\(\)\.getReader\(\)/, 'UNDERTALE Pages 丢失流式本地导入')
    assert.deepEqual(distribution.allowedPageOrigins, ['https://8bitgo.com', 'https://*.8bitgo.com'], '授权包只允许本站 HTTPS 主域与子域读取')
    assert.match(app, /host === '8bitgo\.com' \|\| host\.endsWith\('\.8bitgo\.com'\)/, '非本站 Pages 域名必须禁用授权包下载')
    assert.ok(!files.some((file) => /(?:^|\/)(?:data\.win|game\.(?:unx|ios|droid)|[^/]+\.(?:ogg|rar|7z))$/i
      .test(relative(root, file).replaceAll('\\', '/'))), 'UNDERTALE Pages 不得包含商业游戏内容')
  }
  if (name === 'subway') {
    const textFiles = files.filter((file) => /\.(?:html|js|json|webmanifest)$/i.test(file))
    for (const file of textFiles) assert.doesNotMatch(readFileSync(file, 'utf8'), /ggemu/i, `${relative(root, file)} 不得包含旧游戏平台引用`)
    const bootstrap = readFileSync(resolve(root, 'web/subway-surfers/js/8bitgo.js'), 'utf8')
    assert.match(bootstrap, /EightBitGoGameSDK/, 'Subway Surfers 必须接入 8BitGo Game SDK')
    assert.doesNotMatch(bootstrap, /https:\/\/8bitgo\.com\/html5-api\//, 'Subway Surfers SDK 应从 Pages 同源加载')
  }
  const workerUrl = `${pathToFileURL(resolve(root, '_worker.js')).href}?check=${Date.now()}`
  const worker = (await import(workerUrl)).default
  const originalFetch = globalThis.fetch
  const fetched = []
  globalThis.fetch = async (url, init) => {
    fetched.push({
      url: url instanceof Request ? url.url : String(url),
      headers: new Headers(url instanceof Request ? url.headers : init?.headers),
      init,
    })
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': '3',
        'Accept-Ranges': 'bytes',
        ETag: '"test"',
      },
    })
  }
  try {
    const assets = {
      fetch: async () => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }),
    }
    const redirect = await worker.fetch(new Request(`https://${config.domain}/`), { ASSETS: assets })
    assert.equal(redirect.status, 302)
    assert.equal(new URL(redirect.headers.get('location')).pathname, config.entry)

    const staticResponse = await worker.fetch(new Request(`https://${config.domain}${config.entry}`), { ASSETS: assets })
    assert.equal(staticResponse.headers.get('x-content-type-options'), 'nosniff')
    if (config.isolated) {
      assert.equal(staticResponse.headers.get('cross-origin-opener-policy'), 'same-origin')
      assert.equal(staticResponse.headers.get('cross-origin-embedder-policy'), 'require-corp')
    }

    if (config.runtime === 'diablo') {
      const response = await worker.fetch(new Request(`https://${config.domain}/web/diablo/static/media/Diablo.1234abcd.wasm`, {
        headers: { 'Accept-Encoding': 'br' },
      }), { ASSETS: assets })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-encoding'), 'br')
      assert.match(fetched.at(-1).url, /web\/diablo\/runtime\/Diablo\.1234abcd\.wasm\.br$/)
    }
    if (config.runtime === 'celeste' || config.runtime === 'terraria') {
      const response = await worker.fetch(new Request(`https://${config.domain}/web/${config.runtime}/_framework/dotnet.js`), { ASSETS: assets })
      assert.equal(response.status, 200)
      assert.match(fetched.at(-1).url, new RegExp(`web/${config.runtime}/_framework/dotnet\\.js$`))
    }
    if (name === 'pvz') {
      const response = await worker.fetch(new Request(`https://${config.domain}/pvz-data/packs/reanim-test.pvzpack.gz`, {
        headers: { Range: 'bytes=0-2097151' },
      }), { ASSETS: assets })
      assert.equal(response.status, 200)
      assert.equal(fetched.at(-1).url, 'https://download.8bitgo.com/PvZ/properties/packs/reanim-test.pvzpack.gz')
      assert.equal(fetched.at(-1).headers.get('range'), 'bytes=0-2097151')
      assert.equal(fetched.at(-1).headers.get('accept-encoding'), 'identity')
      assert.equal(response.headers.get('access-control-allow-origin'), '*')
      assert.equal(response.headers.get('accept-ranges'), 'bytes')

      const rejected = await worker.fetch(new Request(`https://${config.domain}/pvz-data/reanim.pak`, {
        method: 'POST',
      }), { ASSETS: assets })
      assert.equal(rejected.status, 405)
    }
    if (name === 'cs16') {
      const response = await worker.fetch(new Request(`https://${config.domain}/api/cs16/servers`, {
        headers: { Authorization: 'Bearer must-not-leak', Cookie: 'session=must-not-leak' },
      }), { ASSETS: assets })
      assert.equal(response.status, 200)
      assert.equal(fetched.at(-1).url, 'https://8bitgo.com/api/cs16/servers')
      assert.equal(fetched.at(-1).headers.get('origin'), 'https://8bitgo.com')
      assert.equal(fetched.at(-1).headers.has('authorization'), false)
      assert.equal(fetched.at(-1).headers.has('cookie'), false)

      // Node 自带 Response 不接受 101；用最小 Worker WebSocket 模型锁住专用路径与上游地址。
      const NativeResponse = globalThis.Response
      const NativeWebSocket = globalThis.WebSocket
      const NativeWebSocketPair = globalThis.WebSocketPair
      let upstreamSocket
      let browserSocket
      const roomProtocol = `8bitgo.cs16.guest.${'r'.repeat(32)}`
      class MockSocket {
        static CONNECTING = 0
        static OPEN = 1
        static CLOSING = 2
        static CLOSED = 3
        constructor(url = '') {
          this.url = String(url)
          this.readyState = MockSocket.CONNECTING
          this.listeners = new Map()
          this.sent = []
        }
        accept() { this.readyState = MockSocket.OPEN }
        addEventListener(type, listener) { this.listeners.set(type, listener) }
        send(data) { this.sent.push(data) }
        close() { this.readyState = MockSocket.CLOSED }
        emit(type, event = {}) { this.listeners.get(type)?.(event) }
      }
      try {
        globalThis.WebSocket = class extends MockSocket {}
        Object.assign(globalThis.WebSocket, {
          CONNECTING: MockSocket.CONNECTING,
          OPEN: MockSocket.OPEN,
          CLOSING: MockSocket.CLOSING,
          CLOSED: MockSocket.CLOSED,
        })
        globalThis.WebSocketPair = class {
          constructor() {
            browserSocket = new MockSocket()
            return { 0: new MockSocket(), 1: browserSocket }
          }
        }
        globalThis.Response = class {
          constructor(body, init = {}) {
            this.body = body
            this.status = init.status || 200
            this.headers = new Headers(init.headers)
            this.webSocket = init.webSocket
          }
        }
        globalThis.fetch = async (url, init = {}) => {
          const headers = new Headers(init.headers)
          assert.equal(headers.get('upgrade'), 'websocket')
          assert.equal(headers.get('sec-websocket-protocol'), roomProtocol, 'Pages 必须把玩家恢复凭证转发给主站')
          upstreamSocket = new MockSocket(String(url))
          return new globalThis.Response(null, {
            status: 101,
            headers: { 'Sec-WebSocket-Protocol': roomProtocol },
            webSocket: upstreamSocket,
          })
        }
        const socketResponse = await worker.fetch(
          new Request(`https://${config.domain}/api/cs16/room?room=ABC234&role=guest`, {
            headers: {
              Upgrade: 'websocket',
              'Sec-WebSocket-Protocol': roomProtocol,
            },
          }),
          { ASSETS: assets },
        )
        assert.equal(socketResponse.status, 101)
        assert.ok(socketResponse.webSocket)
        assert.equal(socketResponse.headers.get('sec-websocket-protocol'), roomProtocol, 'Pages 必须向浏览器确认同一个子协议')
        assert.equal(upstreamSocket.url, 'https://8bitgo.com/api/cs16/room?room=ABC234&role=guest')
        upstreamSocket.emit('open')
        browserSocket.emit('message', { data: new Blob([new Uint8Array([9, 8, 7])]) })
        await new Promise((resolve) => setTimeout(resolve, 0))
        assert.deepEqual(new Uint8Array(upstreamSocket.sent[0]), new Uint8Array([9, 8, 7]), 'Blob 二进制帧必须转成 ArrayBuffer 再上行')
        upstreamSocket.emit('message', { data: new Uint8Array([1, 2, 3]).buffer })
        assert.deepEqual(new Uint8Array(browserSocket.sent[0]), new Uint8Array([1, 2, 3]), '后端二进制帧必须原样下行')
      } finally {
        globalThis.Response = NativeResponse
        globalThis.WebSocket = NativeWebSocket
        globalThis.WebSocketPair = NativeWebSocketPair
      }
    }
    if (name === 'gtavc') {
      const pagesDevReads = fetched.length
      const blockedHost = await worker.fetch(new Request('https://8bitgo-gta-vc.pages.dev/web/gta-vc/'), { ASSETS: assets })
      assert.equal(blockedHost.status, 403, 'GTA VC 必须拒绝非 8bitgo.com Pages 主机')
      assert.equal(fetched.length, pagesDevReads, '被拒绝的 pages.dev 请求不得继续读取静态或 R2 资源')

      const response = await worker.fetch(new Request(`https://${config.domain}/game-data/revcdoseng.7z`, {
        headers: { Range: 'bytes=0-1023' },
      }), { ASSETS: assets, RUNTIME_ASSET_BASE_URL: 'https://assets.example.com', RUNTIME_UNUSED: 'ignored' })
      assert.equal(response.status, 200)
      assert.equal(fetched.at(-1).url, 'https://download.8bitgo.com/web/gta-vc/revcdoseng.7z')
      assert.equal(fetched.at(-1).headers.get('range'), 'bytes=0-1023')
      assert.equal(fetched.at(-1).headers.get('accept-encoding'), 'identity')
      assert.equal(response.headers.get('content-type'), 'application/x-7z-compressed')
      assert.equal(response.headers.get('access-control-allow-origin'), null, '资源代理不应开放跨域读取')

      const rejected = await worker.fetch(new Request(`https://${config.domain}/game-data/revcdoseng.7z`, {
        method: 'POST',
      }), { ASSETS: assets })
      assert.equal(rejected.status, 405)

      const arbitrary = await worker.fetch(new Request(`https://${config.domain}/game-data/other.7z`), { ASSETS: assets })
      assert.equal(arbitrary.headers.get('x-content-type-options'), 'nosniff', 'Pages 不得把任意 R2 key 作为代理参数')
    }
  } finally {
    globalThis.fetch = originalFetch
  }
  console.log(`${name}: Pages 包与 Worker 检查通过`)
}
