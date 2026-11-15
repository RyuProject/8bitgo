/**
 * 开局冒烟脚本的纯函数与 redeploy 接线（2026-11-15 #4）。跑：npm run test:smoke-start
 * 真正开一局要 Chrome 和网络，不放进常规测试；手动：node scripts/smoke-start.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { findChrome, startupEventOf, verdictOf, CHROME_CANDIDATES } from './smoke-start.mjs'

assert.equal(verdictOf('first_frame'), 'pass')
assert.equal(verdictOf('failed'), 'fail')
assert.equal(verdictOf('timeout'), 'fail')
assert.equal(verdictOf('slow_start'), '', '慢启动不是结论，继续等')
assert.equal(verdictOf('game_playable'), '')
assert.equal(startupEventOf(JSON.stringify({ event: 'first_frame', elapsedMs: 3 })), 'first_frame')
assert.equal(startupEventOf('not json'), '')
assert.equal(startupEventOf(undefined), '')

assert.equal(findChrome({ CHROME_PATH: '/x/chrome' }, (p) => p === '/x/chrome'), '/x/chrome', 'CHROME_PATH 优先')
assert.equal(findChrome({}, (p) => p === CHROME_CANDIDATES.at(-1)), CHROME_CANDIDATES.at(-1))
assert.equal(findChrome({ CHROME_PATH: '/missing' }, () => false), '', '都找不到返回空串（脚本据此退出码 2）')

const src = readFileSync(new URL('./smoke-start.mjs', import.meta.url), 'utf8')
assert.match(src, /urlPattern: '\*\/api\/games\/\*\/startup\*'/, '启动漏斗请求必须拦下，冒烟不能进生产统计')
assert.match(src, /urlPattern: '\*\/api\/games\/\*\/play\*'/, '游玩次数也不能被冒烟刷高')
assert.match(src, /Fetch\.fulfillRequest/)

const redeploy = readFileSync(new URL('../deploy/redeploy.sh', import.meta.url), 'utf8')
assert.match(redeploy, /SMOKE_TEST:-0/, '默认关闭')
const smokeAt = redeploy.indexOf('scripts/smoke-start.mjs')
assert.ok(smokeAt > redeploy.indexOf('if health_ok && ps2_headers_ok'), '健康检查通过之后才冒烟')
assert.doesNotMatch(redeploy.slice(smokeAt, redeploy.indexOf('部署完成', smokeAt)), /rollback|die /, '冒烟失败只告警，不回滚、不中止')
console.log('✔ 开局冒烟：判据、找 Chrome、拦截统计、redeploy 只在 SMOKE_TEST=1 时告警式运行')
