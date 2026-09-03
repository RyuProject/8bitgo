/**
 * ROM 探测缓存的回归测试。
 *
 * 盯的是这个坑：`probeRomUrl` 以前把**所有**失败都永久缓存，包括超时和 5xx。
 * 于是一次网络抖动就能让一款 ROM 好端端躺在 R2 上的游戏，在整个单页应用会话里
 * 一直显示「游戏没有当前语言版本 / 选择 ROM 开始游戏」—— 切来切去都没用，
 * 只有整页刷新才恢复。区分「服务器说没有」和「这次没问出来」是这里的全部重点。
 *
 * 跑：cd .. && npm run test:rom-probe
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

/* ---- 浏览器环境的最小桩：模块里用的是 window.setTimeout ---- */
globalThis.window = { setTimeout: setTimeout.bind(globalThis), clearTimeout: clearTimeout.bind(globalThis) }

/** 按脚本排好的响应依次回，并记下发了几次请求 */
let plan = []
let calls = 0
globalThis.fetch = async () => {
  calls++
  const step = plan.shift()
  if (!step) throw new Error('fetch 次数超出脚本预期')
  if (step.throw) throw new Error(step.throw)
  return {
    ok: step.status >= 200 && step.status < 300,
    status: step.status,
    headers: { get: (k) => step.headers?.[k.toLowerCase()] ?? null },
  }
}
const script = (...steps) => {
  plan = steps
  calls = 0
}

const { probeRomUrl, clearRomProbeCache } = await import(
  fileURLToPath(new URL('../src/services/roms.ts', import.meta.url))
)

let url = 0
const next = () => `https://assets.example.com/roms/nes/game-${++url}.zip`

/* ---------- 1. 服务器明确说没有 → 缓存，不重复问 ---------- */
{
  const u = next()
  script({ status: 404 })
  assert.equal(await probeRomUrl(u), '', '404 就是没有')
  assert.equal(await probeRomUrl(u), '', '再问一次仍然是没有')
  assert.equal(calls, 1, '确定性的「没有」要缓存，不该重复发请求')
}

/* ---------- 2. 没问出来 → 不缓存，下次真的会重新问 ---------- */
{
  const u = next()
  script({ status: 503 }, { status: 503 })
  assert.equal(await probeRomUrl(u), '')
  assert.equal(calls, 2, '没问出结论时当场重试一次')

  // 关键：这一次必须真的重新发请求，而不是复读上面那个失败
  script({ status: 200, headers: { etag: '"abc"' } })
  const again = await probeRomUrl(u)
  assert.ok(again.includes('romv=abc'), '网络恢复后要能探到，而不是被上一轮的失败钉死')
  assert.equal(calls, 1)
}

/* ---------- 3. 抖一下就好 → 内部重试直接救回来 ---------- */
{
  const u = next()
  script({ throw: '模拟断网' }, { status: 200, headers: { etag: 'W/"v2"' } })
  const got = await probeRomUrl(u)
  assert.ok(got.includes('romv=v2'), '第一次连不上、第二次成功，应当返回可播放地址')
  assert.equal(calls, 2)
}

/* ---------- 4. 超时（abort）也算「没问出来」 ---------- */
{
  const u = next()
  script({ throw: 'The operation was aborted' }, { throw: 'The operation was aborted' })
  assert.equal(await probeRomUrl(u), '')
  script({ status: 200, headers: { etag: '"late"' } })
  assert.ok((await probeRomUrl(u)).includes('romv=late'), '超时过的地址下次必须重新探')
}

/* ---------- 5. 200 但回的是 HTML → 确定性的假阳性，要缓存 ---------- */
{
  const u = next()
  script({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  assert.equal(await probeRomUrl(u), '', '落到 SSR 兜底路由的 HTML 不算 ROM')
  assert.equal(await probeRomUrl(u), '')
  assert.equal(calls, 1, '这是确定的结论，不用反复问')
}

/* ---------- 6. 手动清缓存 → 刚传上去的 ROM 不用刷新整页就能被认出来 ---------- */
{
  const u = next()
  script({ status: 404 })
  assert.equal(await probeRomUrl(u), '')
  clearRomProbeCache([u])
  script({ status: 200, headers: { etag: '"just-uploaded"' } })
  assert.ok((await probeRomUrl(u)).includes('romv=just-uploaded'), '清掉缓存后应重新探测')
}

/* ---------- 7. 没有 ETag 就不加 romv，避免把地址弄脏 ---------- */
{
  const u = next()
  script({ status: 200 })
  assert.equal(await probeRomUrl(u), u, '拿不到 ETag 时原样返回')
}

console.log('✅ ROM 探测缓存测试通过：区分「确定没有」与「没问出来」/ 自动重试 / 手动清缓存')
