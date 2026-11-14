/**
 * hedgedRequest：慢线路对冲（2026-11-14《僵尸盒子 2》密钥在 cn.8bitgo.com 上走了 17.3 秒）。
 * 运行：node --experimental-strip-types --import ./scripts/helpers/ts-register.mjs scripts/test-hedged-request.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { hedgedRequest } from '../src/services/hedgedRequest.ts'

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
}
const delay = (ms, value, signal, fail = false) => new Promise((resolve, reject) => {
  const t = setTimeout(() => (fail ? reject(new Error(value)) : resolve(value)), ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) })
})

await check('第一条够快：不发第二条', async () => {
  const calls = []
  const v = await hedgedRequest(['a', 'b'], (u, s) => { calls.push(u); return delay(5, u, s) }, { hedgeDelayMs: 50 })
  assert.equal(v, 'a')
  await delay(80)
  assert.deepEqual(calls, ['a'])
})

await check('⭐ 第一条卡住：过了对冲延时发第二条，第二条赢，第一条被中止', async () => {
  const aborted = []
  const v = await hedgedRequest(['slow', 'fast'], (u, s) => {
    s.addEventListener('abort', () => aborted.push(u))
    return delay(u === 'slow' ? 1000 : 5, u, s)
  }, { hedgeDelayMs: 20 })
  assert.equal(v, 'fast')
  assert.deepEqual(aborted, ['slow'])
})

await check('⭐ 第一条直接失败：不等对冲延时，立刻发第二条', async () => {
  const started = Date.now()
  const v = await hedgedRequest(['bad', 'ok'], (u, s) => delay(1, u, s, u === 'bad'), { hedgeDelayMs: 5_000 })
  assert.equal(v, 'ok')
  assert.ok(Date.now() - started < 1_000)
})

await check('全部失败时报第一条线路的错误', async () => {
  await assert.rejects(
    hedgedRequest(['a', 'b'], (u, s) => delay(1, `err-${u}`, s, true), { hedgeDelayMs: 5 }),
    /err-a/,
  )
})

await check('单条超时只中止那一条；只有一条时超时即失败', async () => {
  await assert.rejects(hedgedRequest(['only'], (u, s) => delay(1_000, u, s), { hedgeDelayMs: 5, attemptTimeoutMs: 20 }), /aborted/)
})

await check('重复 / 空地址去掉，外部中止整组', async () => {
  const calls = []
  const v = await hedgedRequest(['a', '', 'a'], (u, s) => { calls.push(u); return delay(1, u, s) }, { hedgeDelayMs: 1 })
  assert.equal(v, 'a')
  assert.deepEqual(calls, ['a'])
  const ac = new AbortController()
  const p = hedgedRequest(['a'], (u, s) => delay(1_000, u, s), { hedgeDelayMs: 1, signal: ac.signal })
  ac.abort()
  await assert.rejects(p)
})

await check('romPack 的密钥请求走对冲，且同源在前', () => {
  const src = readFileSync(new URL('../src/services/romPack.ts', import.meta.url), 'utf8')
  assert.match(src, /hedgedRequest\(\s*romPackKeyUrls\(/)
  assert.match(src, /const urls = \[`\$\{apiBase\(\)\}\$\{path\}`\]/)
  assert.match(src, /KEY_HEDGE_DELAY_MS = 3_000/)
})

console.log(failed ? `\n${failed} 项失败` : '\n对冲请求回归通过 ✅')
process.exit(failed ? 1 : 0)
