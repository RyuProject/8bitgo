import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import vm from 'node:vm'

const source = readFileSync(new URL('../public/ppsspp/v0dbfaca/v15/local-disc-sw.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('../public/ppsspp/v0dbfaca/v15/host.js', import.meta.url), 'utf8')
const events = new Map()
const channels = new Map()
const file = Uint8Array.from({ length: 2048 }, (_, index) => index & 255)
class Channel {
  constructor(name) {
    this.name = name
    const peers = channels.get(name) || new Set()
    peers.add(this)
    channels.set(name, peers)
  }
  postMessage(data) {
    for (const peer of channels.get(this.name) || []) {
      if (peer !== this) queueMicrotask(() => peer.onmessage?.({ data }))
    }
  }
  close() {
    channels.get(this.name)?.delete(this)
  }
}

const scope = 'https://8bitgo.test/ppsspp/v0dbfaca/v15/'
const context = {
  URL, Response, ArrayBuffer, BroadcastChannel: Channel, crypto: webcrypto, setTimeout, clearTimeout,
  self: {
    location: { origin: 'https://8bitgo.test' },
    registration: { scope },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
    addEventListener(type, listener) { events.set(type, listener) },
  },
}
vm.runInNewContext(source, context, { filename: 'local-disc-sw.js' })
const session = '00000000-0000-4000-8000-000000000001'
const page = new Channel(`8bitgo-psp-local-disc-v1:${session}`)
page.onmessage = ({ data }) => {
  if (data.type !== 'read') return
  const bytes = data.head ? null : file.slice(data.start, data.end + 1).buffer
  page.postMessage({ source: data.source, type: 'reply', id: data.id, size: file.length, bytes })
}
const request = async (method, range, suffix = `local-disc/${session}/game.iso`) => {
  let response
  events.get('fetch')({
    request: new Request(new URL(suffix, scope), { method, headers: range ? { Range: range } : {} }),
    respondWith(promise) { response = promise },
  })
  return response ? await response : null
}

const valid = await request('GET', 'bytes=8-15')
assert.equal(valid.status, 206)
assert.equal(valid.headers.get('content-range'), 'bytes 8-15/2048')
assert.equal(valid.headers.get('content-length'), '8')
assert.deepEqual([...new Uint8Array(await valid.arrayBuffer())], [...file.slice(8, 16)])
const head = await request('HEAD')
assert.equal(head.status, 200)
assert.equal(head.headers.get('content-length'), '2048')
assert.equal((await request('GET')).status, 416, '不能回退成整张盘下载')
assert.equal((await request('GET', 'bytes=0-4194304')).status, 416, '单片不能无限大')
assert.equal((await request('GET', 'bytes=2048-2049')).status, 416, '越界不能返回短 206')
assert.equal(await request('GET', 'bytes=0-1', 'PPSSPPSDL.js'), null, '不能拦截核心静态资源')
assert.match(host, /localDisc = await openLocalDisc\(file\)/)
assert.match(host, /if \(!gameBootConfirmed\) return/, '本地镜像必须等核心真正 Booted')
assert.doesNotMatch(host, /FS\.mount\([^\n]*WORKERFS|FS\.createLazyFile\(/)
page.close()
console.log('✔ PSP 本地镜像：浏览器内 Range、HEAD、有界分片、越界拒绝与 Booted 判据')
