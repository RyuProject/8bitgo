import test from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { createGameMediaProxy, isPublicMediaAddress } from '../src/game-media.js'

function fakeLookup(hostname) {
  if (hostname === 'private.example') return Promise.resolve([{ address: '127.0.0.1', family: 4 }])
  return Promise.resolve([{ address: '203.0.114.8', family: 4 }])
}

class MockResponse extends Writable {
  constructor() {
    super()
    this.statusCode = 200
    this.headers = new Map()
    this.chunks = []
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk))
    callback()
  }

  status(code) {
    this.statusCode = code
    return this
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), String(value))
    return this
  }

  getHeader(name) {
    return this.headers.get(String(name).toLowerCase())
  }

  send(value = '') {
    this.end(value)
    return this
  }

  get body() {
    return Buffer.concat(this.chunks).toString()
  }
}

function makeProxy({ games, upstream }) {
  const calls = []
  const proxy = createGameMediaProxy({
    loadGameMedia: async (slug) => games[slug],
    lookupImpl: fakeLookup,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return upstream(url, init)
    },
  })
  return { proxy, calls }
}

async function request(proxy, slug, kind, { method = 'GET', headers = {} } = {}) {
  const res = new MockResponse()
  await proxy({ params: { slug, kind }, method, headers }, res)
  return res
}

test('公网 / 内网地址分界不会把媒体代理变成 SSRF 通道', () => {
  for (const value of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888']) {
    assert.equal(isPublicMediaAddress(value), true, value)
  }
  for (const value of [
    '127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1',
    '192.168.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    '::1', 'fc00::1', 'fe80::1', '2001:db8::1',
  ]) assert.equal(isPublicMediaAddress(value), false, value)
})

test('封面从数据库记录的 URL 同源流出，并补齐 COEP 所需响应头', async () => {
  const { proxy, calls } = makeProxy({
    games: { alias: { cover: 'https://media.example/cover.webp', video: '', hidden: 0 } },
    upstream: () => new Response('cover-bytes', {
      headers: { 'content-type': 'image/webp', etag: '"cover-v1"' },
    }),
  })
  const response = await request(proxy, 'alias', 'cover')
  assert.equal(response.statusCode, 200)
  assert.equal(response.body, 'cover-bytes')
  assert.equal(response.getHeader('cross-origin-resource-policy'), 'same-origin')
  assert.match(response.getHeader('cache-control'), /s-maxage=86400/)
  assert.equal(calls[0].url, 'https://media.example/cover.webp')
})

test('视频 Range 与 206 响应原样透传，避免循环预览反复整包下载', async () => {
  const { proxy } = makeProxy({
    games: { clip: { cover: '', video: 'https://media.example/clip.mp4', hidden: 0 } },
    upstream: (_url, init) => {
      assert.equal(init.headers.range, 'bytes=10-19')
      return new Response('0123456789', {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-range': 'bytes 10-19/100',
          'accept-ranges': 'bytes',
        },
      })
    },
  })
  const response = await request(proxy, 'clip', 'video', { headers: { range: 'bytes=10-19' } })
  assert.equal(response.statusCode, 206)
  assert.equal(response.getHeader('content-range'), 'bytes 10-19/100')
  assert.equal(response.getHeader('accept-ranges'), 'bytes')
})

test('隐藏游戏、字段错位与跳到内网的重定向都拒绝', async () => {
  const { proxy, calls } = makeProxy({
    games: {
      hidden: { cover: 'https://media.example/secret.webp', hidden: 1 },
      wrong: { cover: 'covers/local.webp', video: 'https://media.example/clip.mp4', hidden: 0 },
      redirect: { cover: 'https://media.example/start.webp', hidden: 0 },
    },
    upstream: () => new Response(null, { status: 302, headers: { location: 'http://private.example/secret' } }),
  })
  assert.equal((await request(proxy, 'hidden', 'cover')).statusCode, 404)
  assert.equal((await request(proxy, 'wrong', 'cover')).statusCode, 404)
  assert.equal((await request(proxy, 'redirect', 'cover')).statusCode, 502)
  assert.equal(calls.length, 1, '内网跳转必须在第二次 fetch 之前被挡住')
})

test('上游把 HTML 错误页伪装成 200 时不转给图片标签', async () => {
  const { proxy } = makeProxy({
    games: { broken: { cover: 'https://media.example/broken.webp', hidden: 0 } },
    upstream: () => new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } }),
  })
  assert.equal((await request(proxy, 'broken', 'cover')).statusCode, 502)
})
