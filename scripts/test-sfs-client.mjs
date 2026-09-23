/**
 * Ruffle 的 SFS 运行时配置缓存回归。跑：npm run test:sfs
 *
 * 迁机时 sidecar 往往比主站晚启动；第一次请求失败若永久缓存，玩家在这个标签页里之后打开
 * 多少次 SAS3 都不会再有 socketProxy。这里把失败、关闭、成功三种缓存寿命分别钉住。
 */
import assert from 'node:assert/strict'

globalThis.__viteEnv = { VITE_API_URL: 'same-origin' }
globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
}

const realNow = Date.now
let now = 1_800_000_000_000
Date.now = () => now

const { prepareSfsRuffleConfig, invalidateSfsRuffleConfig } = await import('../src/services/sfs.ts')
const good = {
  enabled: true,
  ruffle: {
    socketProxy: [{ host: 'sas3server.ninjakiwi.com', port: 444, proxyUrl: 'wss://8bitgo.com/sfs/sas3' }],
    urlRewriteRules: [['^https://old/(.*)$', 'https://assets.8bitgo.com/$1']],
  },
}
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

try {
  let calls = 0
  const urls = []

  console.log('── 普通 Flash 不碰 SFS 旁路 ──')
  globalThis.fetch = async () => {
    calls++
    return response(good)
  }
  invalidateSfsRuffleConfig()
  assert.deepEqual(await prepareSfsRuffleConfig('infectonator-2'), {})
  assert.equal(calls, 0, '普通 Flash 不应为了 SAS3 配置多发请求')

  console.log('── 失败后能自愈 ──')
  globalThis.fetch = async (url) => {
    calls++
    urls.push(String(url))
    if (calls === 1) throw new Error('temporary gateway failure')
    return response(good)
  }
  invalidateSfsRuffleConfig()
  assert.deepEqual(await prepareSfsRuffleConfig('sas3'), {})
  now += 4_999
  assert.deepEqual(await prepareSfsRuffleConfig('sas3'), {}, '5 秒退避期内不应反复打故障接口')
  assert.equal(calls, 1)
  now += 2
  const recovered = await prepareSfsRuffleConfig('sas3')
  assert.equal(calls, 2, '失败缓存过期后必须重新请求')
  assert.equal(recovered.socketProxy[0].port, 444)
  assert.match(urls[1], /\/api\/sfs\/config\?_=/, '请求应带时间桶，绕过迁机遗留的错误边缘缓存规则')

  console.log('── 成功配置缓存与刷新 ──')
  now += 299_999
  await prepareSfsRuffleConfig('sas3')
  assert.equal(calls, 2, '有效配置 5 分钟内复用')
  now += 2
  await prepareSfsRuffleConfig('sas3')
  assert.equal(calls, 3, '有效配置过期后刷新，运维修改能在当前页面生效')

  console.log('── 关闭状态不能永久缓存 ──')
  globalThis.fetch = async () => {
    calls++
    return response(calls === 4 ? { enabled: false, ruffle: {} } : good)
  }
  invalidateSfsRuffleConfig()
  assert.deepEqual(await prepareSfsRuffleConfig('sas3'), {})
  now += 29_999
  assert.deepEqual(await prepareSfsRuffleConfig('sas3'), {})
  assert.equal(calls, 4)
  now += 2
  assert.equal((await prepareSfsRuffleConfig('sas3')).socketProxy[0].host, 'sas3server.ninjakiwi.com')
  assert.equal(calls, 5, 'sidecar 启用后，已打开页面最多 30 秒即可取得配置')

  console.log('── 并发挂载只发一份请求 ──')
  invalidateSfsRuffleConfig()
  let resolveFetch
  globalThis.fetch = () => {
    calls++
    return new Promise((resolve) => { resolveFetch = resolve })
  }
  const before = calls
  const a = prepareSfsRuffleConfig('sas3')
  const b = prepareSfsRuffleConfig('sas3')
  assert.equal(calls, before + 1, '多个 Flash 同时挂载不能把配置接口打成并发风暴')
  resolveFetch(response(good))
  assert.deepEqual(await a, await b)

  console.log('SFS 前端配置自测通过：逐游戏门控、失败恢复、短期缓存、关闭刷新、并发去重')
} finally {
  Date.now = realNow
  delete globalThis.fetch
  delete globalThis.window
  delete globalThis.__viteEnv
}
