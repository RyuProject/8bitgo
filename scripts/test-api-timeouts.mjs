// 普通 API 的网络断流不能让验证码、评论等操作无限转圈；正文读取也必须受时限约束。
import assert from 'node:assert/strict'

globalThis.__viteEnv = {
  VITE_API_URL: 'same-origin',
  VITE_SITE_URL: 'https://8bitgo.com',
}
globalThis.window = {
  location: { hostname: '8bitgo.com', origin: 'https://8bitgo.com' },
}
globalThis.document = {
  documentElement: { getAttribute: () => null },
  querySelector: (selector) => selector.includes('8bitgo-cover-cdn')
    ? { getAttribute: () => 'cn' }
    : null,
}

const calls = []
let behavior = 'edge-hangs'
globalThis.fetch = (url, init = {}) => {
  calls.push({ url: String(url), signal: init.signal })
  if (String(url).startsWith('https://cn.8bitgo.com/')) return new Promise(() => {})
  if (behavior === 'origin-hangs') return new Promise(() => {})
  if (behavior === 'body-hangs') {
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => new Promise(() => {}),
    })
  }
  if (behavior === 'abort-aware') {
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true }),
  })
}

const { api, ApiTimeoutError } = await import('../src/services/api.ts')

// EdgeOne 首字节挂死时，在本地短时限后切回同源并成功完成请求。
{
  const result = await api.get('/api/test', false, undefined, 40)
  assert.deepEqual(result, { ok: true })
  assert.equal(calls.length, 2)
  assert.match(calls[0].url, /^https:\/\/cn\.8bitgo\.com\/_cn\/api\/test$/)
  assert.equal(calls[1].url, '/api/test')
}

// 源站连响应头都没有时，调用方仍须在配置时限内得到可显示的错误。
{
  behavior = 'origin-hangs'
  calls.length = 0
  await assert.rejects(
    api.post('/api/test', {}, false, 20),
    (error) => error instanceof ApiTimeoutError && error.name === 'ApiTimeoutError',
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].signal.aborted, true)
}

// 收到响应头但正文流不结束，是独立的常见断流形态，同样不能永久 pending。
{
  behavior = 'body-hangs'
  calls.length = 0
  await assert.rejects(api.get('/api/test', false, undefined, 20), ApiTimeoutError)
  assert.equal(calls[0].signal.aborted, true)
}

// 页面离开等调用方主动取消必须保留 AbortError 语义，不能误报成网络超时。
{
  behavior = 'abort-aware'
  calls.length = 0
  const controller = new AbortController()
  const request = api.get('/api/test', false, controller.signal, 1_000)
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(request, (error) => error?.name === 'AbortError' && !(error instanceof ApiTimeoutError))
  assert.equal(calls.length, 1)
}

console.log('✅ API 响应头/正文超时、EdgeOne 回退与主动取消语义正常')
