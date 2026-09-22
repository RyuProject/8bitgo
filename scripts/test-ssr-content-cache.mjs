import assert from 'node:assert/strict'

// 缩短共享查询的过期时间，只为稳定复现「旧查询晚到」的真实竞态。
process.env.SSR_INFLIGHT_MAX_MS = '10'
process.env.SSR_CACHE_MS = '5000'
const { cached, invalidateContent } = await import('../server/src/content.js')

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function startExpiredPair(key) {
  invalidateContent()
  const old = deferred()
  const fresh = deferred()
  const oldRequest = cached(key, () => old.promise)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const freshRequest = cached(key, () => fresh.promise)
  return { old, fresh, oldRequest, freshRequest }
}

// 旧查询比新查询后结束：不能把已经写好的新值盖掉。
{
  const pair = await startExpiredPair('late-old')
  pair.fresh.resolve('fresh')
  assert.equal(await pair.freshRequest, 'fresh')
  pair.old.resolve('old')
  assert.equal(await pair.oldRequest, 'old')
  assert.equal(await cached('late-old', () => { throw new Error('不应重新查询') }), 'fresh')
}

// 旧查询先结束：也不能让后续请求绕过仍在运行的新查询。
{
  const pair = await startExpiredPair('early-old')
  pair.old.resolve('old')
  assert.equal(await pair.oldRequest, 'old')
  const shared = cached('early-old', () => { throw new Error('不应再开第三次查询') })
  pair.fresh.resolve('fresh')
  assert.equal(await shared, 'fresh')
  assert.equal(await pair.freshRequest, 'fresh')
  assert.equal(await cached('early-old', () => { throw new Error('不应重新查询') }), 'fresh')
}

console.log('SSR 共享查询超时竞态：通过')
