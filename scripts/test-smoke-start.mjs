/**
 * 开局冒烟脚本的纯函数与 redeploy 接线（2026-11-15 #4）。跑：npm run test:smoke-start
 * 真正开一局要 Chrome 和网络，不放进常规测试；手动：node scripts/smoke-start.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  adultGateReason,
  CHROME_CANDIDATES,
  devToolsUrlOf,
  findChrome,
  MAME_CHD_TIMEOUT_MS,
  startupEventOf,
  timeoutForGame,
  verdictOf,
  waitWithin,
} from './smoke-start.mjs'

assert.equal(verdictOf('first_frame'), 'pass')
assert.equal(verdictOf('failed'), 'fail')
assert.equal(verdictOf('timeout'), 'fail')
assert.equal(verdictOf('slow_start'), '', '慢启动不是结论，继续等')
assert.equal(verdictOf('game_playable'), '')
assert.equal(startupEventOf(JSON.stringify({ event: 'first_frame', elapsedMs: 3 })), 'first_frame')
assert.equal(startupEventOf('not json'), '')
assert.equal(startupEventOf(undefined), '')

// 未登录冒烟被年龄门拦下时，播放器根本没有挂载；不能写成“没有首帧”。
assert.equal(adultGateReason({ adult: true, allowed: false, reason: 'login' }), '年龄门：login')
assert.equal(adultGateReason({ adult: true, allowed: true }), '')
assert.equal(adultGateReason({ adult: false, allowed: false }), '')
assert.equal(timeoutForGame({ arcadeMameDisks: [{ storedBytes: 40 * 1024 * 1024 }] }, 150_000), MAME_CHD_TIMEOUT_MS)
assert.equal(timeoutForGame({ arcadeMameDisks: [{ storedBytes: 1 }] }, 150_000), 150_000)
assert.equal(await waitWithin(Promise.resolve('ok'), 1, '不应超时'), 'ok')
await assert.rejects(waitWithin(new Promise(() => {}), 1, '测试超时'), /测试超时/)

assert.equal(findChrome({ CHROME_PATH: '/x/chrome' }, (p) => p === '/x/chrome'), '/x/chrome', 'CHROME_PATH 优先')
assert.equal(findChrome({}, (p) => p === CHROME_CANDIDATES.at(-1)), CHROME_CANDIDATES.at(-1))
assert.equal(findChrome({ CHROME_PATH: '/missing' }, () => false), '', '都找不到返回空串（脚本据此退出码 2）')

const src = readFileSync(new URL('./smoke-start.mjs', import.meta.url), 'utf8')
assert.match(src, /urlPattern: '\*\/api\/games\/\*\/startup\*'/, '启动漏斗请求必须拦下，冒烟不能进生产统计')
assert.match(src, /urlPattern: '\*\/api\/games\/\*\/play\*'/, '游玩次数也不能被冒烟刷高')
assert.match(src, /Fetch\.fulfillRequest/)
assert.match(src, /Target\.createTarget/, '每款仍通过独立 DevTools 标签页隔离运行')
assert.match(src, /测试标签页不可用/, '标签页创建失败必须按测试基础设施归因')
assert.match(src, /TARGET_CLOSE_TIMEOUT_MS/, '关闭标签页不能无限阻塞，避免吞掉已经得出的首帧结论')
assert.match(src, /PAGE_NAVIGATION_COMMAND_TIMEOUT_MS/, '公网详情页 SSR 回包可慢于普通 CDP 命令，导航要保留独立预算')
assert.match(src, /infrastructureFailed \? 2 : 0/, '测试基础设施失败走退出码 2，不能触发生产回滚')
assert.match(src, /const target = await sendWithin[\s\S]*?targetId = target\.targetId[\s\S]*?const attached = await sendWithin[\s\S]*?sessionId = attached\.sessionId/, '创建和附加标签页要用明确赋值，避免连续括号解构触发 ASI 函数调用')

/*
  收尾不能改写冒烟结论（2026-11-18 生产两次部署：两款游戏都到了首帧，删 Chrome profile 报 ENOTEMPTY，
  退出码变成 2，redeploy 记成「冒烟没有运行」、发飞书告警、/tmp 留下 30MB）。
*/
const launch = src.slice(src.indexOf('async function launchChrome'), src.indexOf('async function smokeOne'))
assert.match(launch, /\{ stdio: 'ignore', detached: true \}/, 'Chrome 必须 detached 自成进程组，整组才能一起停')
assert.match(launch, /process\.kill\(-proc\.pid, signal\)/, '关 Chrome 时按进程组发信号，渲染 / GPU 子进程一起停')
const remove = launch.slice(launch.indexOf('const removeProfile'), launch.indexOf('const portFile'))
assert.match(remove, /try \{\s*rmSync\(profile, \{[^}]*maxRetries: \d+[^}]*\}\)\s*\} catch/, '删 profile 要带重试，并且吞掉错误')
const close = launch.slice(launch.indexOf('async close()'))
assert.doesNotMatch(close, /^\s*rmSync\(/m, '关 Chrome 时不能直接 rmSync：抛错会冒到 main().catch 变成退出码 2')
assert.match(close, /killGroup\('SIGKILL'\)[\s\S]*removeProfile\(\)/, '整组 SIGKILL 之后再删目录')
// 2026-11-21 生产巡检：DevToolsActivePort 已建出、还没写内容就被读走 → ws://127.0.0.1:undefined → Invalid URL
assert.equal(devToolsUrlOf(''), '', '空文件 = 还没写完')
assert.equal(devToolsUrlOf('9222'), '', '只有端口、缺路径 = 还没写完')
assert.equal(devToolsUrlOf('9222\n/devtools/bro'), '', '路径没写完')
assert.equal(devToolsUrlOf('0\n/devtools/browser/abc'), '', '端口 0 不算')
assert.equal(devToolsUrlOf('40123\n/devtools/browser/0f6e-1\n'), 'ws://127.0.0.1:40123/devtools/browser/0f6e-1')
assert.doesNotMatch(src, /readFileSync\(portFile[^)]*\)\.trim\(\)\.split/, '不能文件一出现就直接拆端口')

const watch = readFileSync(new URL('../deploy/smoke-watch/8bitgo-smoke-watch.sh', import.meta.url), 'utf8')
assert.match(watch, /-name '8bitgo-smoke-\*' -mmin \+\d+ -exec rm -rf/, '定时巡检兜底清掉以前没删掉的 profile')

const redeploy = readFileSync(new URL('../deploy/redeploy.sh', import.meta.url), 'utf8')
// 2026-11-17 全站 EmulatorJS 事故后改成默认打开、失败重试一次、仍失败回滚（健康检查 200 拦不住「游戏全打不开」）。
// 细节断言在 test-redeploy.mjs；这里只钉住与本脚本退出码的约定：2 = 环境不满足，只告警不回滚。
assert.match(redeploy, /SMOKE_TEST:-1/, '默认打开')
const smokeAt = redeploy.indexOf('scripts/smoke-start.mjs')
assert.ok(smokeAt > redeploy.indexOf('if health_ok && ps2_headers_ok'), '健康检查通过之后才冒烟')
const smokeBlock = redeploy.slice(smokeAt, redeploy.indexOf('log "✅ 部署完成', smokeAt))
assert.match(smokeBlock, /2\)\n\s*log "⚠️⚠️ 开局冒烟没有运行[^\n]*\n\s*notify [^\n]*\n\s*;;/, '退出码 2（没有 Chrome / 脚本自身出错）只告警，不能回滚')
assert.match(smokeBlock, /\*\)\n\s*if \[ "\$\{SMOKE_ROLLBACK:-1\}" = "1" \]; then[\s\S]*?rollback/, '只有真的跑了且失败（退出码 1）才回滚')
assert.doesNotMatch(smokeBlock, /\bdie /, '冒烟失败走回滚，不是 die（die 不回滚，会把坏版本留在线上）')
console.log('✔ 开局冒烟：判据、找 Chrome、拦截统计、redeploy 默认运行且失败回滚、没有 Chrome 只告警')
