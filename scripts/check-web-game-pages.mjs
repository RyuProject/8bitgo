import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WEB_GAME_PAGES } from '../deploy/cloudflare-pages/web-games-config.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const outputRoot = resolve(repo, '.cloudflare-pages')
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
    assert.match(html, /\/html5-api\/8bitgo-runtime-bridge\.js/, `${name}/${file} 没有 Pages 运行桥`)
    if (name === 'pvz') {
      assert.match(html, /h==='8bitgo-pvz\.pages\.dev'/, `${name}/${file} 没有放行自己的固定 Pages 域名`)
      if (file === 'cn/index.html' || file === 'en/index.html') {
        assert.match(html, /PVZ_DATA_BASE=location\.origin\+'\/pvz-data\/'/, `${name}/${file} 没有使用 Pages 同源数据代理`)
        assert.doesNotMatch(html, /PVZ_DATA_BASE='https:\/\/html5\.8bitgo\.com/, `${name}/${file} 仍在浏览器直连无 CORS 的 R2 域名`)
      }
    }
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
      assert.equal(fetched.at(-1).url, 'https://html5.8bitgo.com/PvZ/properties/packs/reanim-test.pvzpack.gz')
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
  } finally {
    globalThis.fetch = originalFetch
  }
  console.log(`${name}: Pages 包与 Worker 检查通过`)
}
