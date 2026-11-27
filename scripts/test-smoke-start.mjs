/**
 * 开局冒烟脚本的纯函数与 redeploy 接线（2026-11-15 #4）。跑：npm run test:smoke-start
 * 真正开一局要 Chrome 和网络，不放进常规测试；手动：node scripts/smoke-start.mjs
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  adultGateReason,
  CHROME_CANDIDATES,
  DEFAULT_SMOKE_GAMES,
  DISABLE_WASM_SCRIPT,
  devToolsUrlOf,
  findChrome,
  MAME_CHD_TIMEOUT_MS,
  PRIVATE_START_EXPRESSION,
  PRIVATE_START_TIMEOUT_MS,
  startSmokeGamePrivately,
  summarizeSmokeNetwork,
  startupDetailOf,
  startupEventOf,
  startupEventsOf,
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
assert.deepEqual(
  startupEventsOf(JSON.stringify({ events: [{ event: 'runtime_ready' }, { event: 'first_frame' }] })),
  ['runtime_ready', 'first_frame'],
  '冒烟必须能从合并上报中识别 NDS 首帧',
)
assert.equal(startupEventOf(JSON.stringify({ events: [{ event: 'runtime_ready' }, { event: 'first_frame' }] })), 'runtime_ready')
assert.deepEqual(startupEventsOf('not json'), [])
assert.equal(startupEventOf('not json'), '')
assert.equal(startupEventOf(undefined), '')
assert.equal(startupDetailOf(JSON.stringify({ detail: '仍在下载 ROM：6.2MB/8.6MB，平均 2.9Mbps' })), '仍在下载 ROM：6.2MB/8.6MB，平均 2.9Mbps')
assert.equal(
  startupDetailOf(JSON.stringify({ detail: 'ROM https://assets.example/game.zip token=secret 192.168.1.2' })),
  'ROM [URL] token=[已隐藏] [IP]',
  '冒烟日志要复用服务端脱敏规则，不能把 URL、凭据或 IP 写出来',
)
assert.equal(startupDetailOf(JSON.stringify({ detail: 'x'.repeat(200) })).length, 160, '详情沿用服务端 160 字符上限')
assert.equal(startupDetailOf('not json'), '')

// 未登录冒烟被年龄门拦下时，播放器根本没有挂载；不能写成“没有首帧”。
assert.equal(adultGateReason({ adult: true, allowed: false, reason: 'login' }), '年龄门：login')
assert.equal(adultGateReason({ adult: true, allowed: true }), '')
assert.equal(adultGateReason({ adult: false, allowed: false }), '')
assert.equal(timeoutForGame({ arcadeMameDisks: [{ storedBytes: 40 * 1024 * 1024 }] }, 150_000), MAME_CHD_TIMEOUT_MS)
assert.equal(timeoutForGame({ arcadeMameDisks: [{ storedBytes: 1 }] }, 150_000), 150_000)
assert.deepEqual(
  summarizeSmokeNetwork([
    { url: 'https://rom.8bitgo.com/game.nds?token=secret', startedAt: 1000, durationMs: 8000, bytes: 2048 },
    { url: 'https://assets.8bitgo.com/core.data?token=private', startedAt: 1000, durationMs: 200, bytes: 8 * 1048576 },
    { url: 'https://assets.8bitgo.com/bad.data?key=secret', startedAt: 1000, durationMs: 500, bytes: 0, error: 'net::ERR_FAILED' },
    { url: 'https://assets.8bitgo.com/tiny.css', startedAt: 1000, durationMs: 50, bytes: 100 },
  ], 10_000),
  [
    { path: 'assets.8bitgo.com/bad.data', status: 0, bytes: 0, durationMs: 500, error: 'net::ERR_FAILED' },
    { path: 'rom.8bitgo.com/game.nds', status: 0, bytes: 2048, durationMs: 8000, error: '' },
    { path: 'assets.8bitgo.com/core.data', status: 0, bytes: 8 * 1048576, durationMs: 200, error: '' },
  ],
  '失败冒烟要列出慢请求和失败请求，但不暴露查询参数',
)
assert.equal(await waitWithin(Promise.resolve('ok'), 1, '不应超时'), 'ok')
await assert.rejects(waitWithin(new Promise(() => {}), 1, '测试超时'), /测试超时/)

assert.equal(findChrome({ CHROME_PATH: '/x/chrome' }, (p) => p === '/x/chrome'), '/x/chrome', 'CHROME_PATH 优先')
assert.equal(findChrome({}, (p) => p === CHROME_CANDIDATES.at(-1)), CHROME_CANDIDATES.at(-1))
assert.equal(findChrome({ CHROME_PATH: '/missing' }, () => false), '', '都找不到返回空串（脚本据此退出码 2）')

const src = readFileSync(new URL('./smoke-start.mjs', import.meta.url), 'utf8')
assert.deepEqual(DEFAULT_SMOKE_GAMES.split(','), ['super-mario-bros', 'cadillacs-and-dinosaurs', 'pokemon-sapphire'],
  '部署冒烟必须覆盖 NES、CPS1 与 mGBA 的 GBA 路径')
assert.match(src, /process\.env\.SMOKE_GAMES \|\| DEFAULT_SMOKE_GAMES/, '仍允许巡检或人工覆盖冒烟游戏')
assert.match(src, /process\.env\.SMOKE_DISABLE_WASM === '1'/, '无 WebAssembly 能力测试必须显式开启')
assert.match(src, /Page\.addScriptToEvaluateOnNewDocument/, '关闭 WebAssembly 的探针必须早于页面脚本运行')
const noWasmWindow = { WebAssembly: {} }
new Function('globalThis', DISABLE_WASM_SCRIPT)(noWasmWindow)
assert.equal(noWasmWindow.WebAssembly, undefined, '无 WebAssembly 冒烟必须确实让能力探针走纯 JS 退路')
assert.match(src, /页面状态：\$\{JSON\.stringify\(r\.pageState\)\}/, '真实开局失败时要保留页面按钮与错误提示，便于区分能力门禁和启动故障')
assert.match(src, /urlPattern: '\*\/api\/games\/\*\/startup\*'/, '启动漏斗请求必须拦下，冒烟不能进生产统计')
assert.match(src, /urlPattern: '\*\/api\/games\/\*\/play\*'/, '游玩次数也不能被冒烟刷高')
assert.match(src, /Fetch\.fulfillRequest/)
assert.match(src, /Network\.loadingFailed/, '启动失败时要保留网络错误与卡住的资源请求')
assert.doesNotMatch(src, /\/games\/\$\{encodeURIComponent\(slug\)\}\?autoplay=1/, '不能用 autoplay 跳过开局前的不公开设置')
assert.equal(PRIVATE_START_TIMEOUT_MS, 90_000)
assert.ok(
  PRIVATE_START_EXPRESSION.indexOf('liveButton.click()') < PRIVATE_START_EXPRESSION.indexOf('startButton.click()'),
  '必须先关闭默认公开直播，再启动游戏',
)
assert.match(PRIVATE_START_EXPRESSION, /aria-pressed/)
assert.match(PRIVATE_START_EXPRESSION, /unsafe-toggle/)
const runPrivateStart = new Function('window', 'document', `return ${PRIVATE_START_EXPRESSION}`)
{
  const actions = []
  const start = {
    innerText: '▶\n开始游戏', disabled: false, title: '',
    hasAttribute: () => false, getAttribute: () => null,
    click: () => actions.push('start'),
  }
  const live = {
    innerText: '开局自动直播', disabled: false,
    title: '开始游戏后会自动公开直播', ariaLabel: '开局自动直播', pressed: 'true',
    hasAttribute: (name) => name === 'aria-pressed',
    getAttribute(name) { return name === 'aria-pressed' ? this.pressed : null },
    click() { actions.push('private'); this.pressed = 'false' },
  }
  const window = {}
  const document = { querySelectorAll: () => [start, live] }
  assert.deepEqual(runPrivateStart(window, document), { state: 'waiting-private' })
  assert.deepEqual(actions, ['private'], '启用直播时首轮只能切到不公开，不能开局')
  assert.deepEqual(runPrivateStart(window, document), { state: 'started-private' })
assert.deepEqual(actions, ['private', 'start'], '确认不公开后才能开始')
}
{
  let evaluations = 0
  let started = false
  const cdp = {
    send(method, params) {
      assert.equal(method, 'Runtime.evaluate')
      assert.equal(params.expression, PRIVATE_START_EXPRESSION)
      evaluations++
      return Promise.resolve({ result: { value: { state: 'started-private' } } })
    },
  }
  setTimeout(() => { started = true }, 240)
  assert.equal(await startSmokeGamePrivately(cdp, 'test-session', 1000, () => started), 'started-private')
  assert.ok(evaluations >= 2, 'SSR 的空点击后必须继续重试，直到开局请求被观察到')
}
{
  let started = false
  const start = { innerText: 'Start game', disabled: false, hasAttribute: () => false, click: () => { started = true } }
  const unknown = { innerText: 'Layout', title: '', disabled: false, pressed: 'true', hasAttribute: () => true, getAttribute: () => 'true', click() {} }
  assert.deepEqual(runPrivateStart({}, { querySelectorAll: () => [start, unknown] }), { state: 'unsafe-toggle' })
  assert.equal(started, false, '识别不了启用开关时必须停止，不能冒险开局')
}
assert.match(src, /startSmokeGamePrivately\(cdp, sessionId, PRIVATE_START_TIMEOUT_MS,/, '必须等到实际开局请求后才开始判定首帧')
assert.match(src, /gameNotFound: gameResult\?\.status === 404/)
assert.match(src, /if \(preflight\.gameNotFound\)/, '游戏 API 确认 404 时立即跳过，不空等启动超时')
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
assert.match(launch, /DISABLE_WEBGL \? \['--disable-webgl'\]/, '可显式关闭 WebGL，回归 Canvas 2D 退路')
assert.match(src, /const DISABLE_WEBGL = process\.env\.SMOKE_DISABLE_WEBGL === '1'/, '禁 WebGL 只由专用验收环境变量触发')
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
const profileCleanup = readFileSync(new URL('../deploy/lib/cleanup-smoke-profiles.sh', import.meta.url), 'utf8')
assert.match(watch, /cleanup_stale_smoke_profiles "\$\{TMPDIR:-\/tmp\}" 1800/, '定时巡检调用 profile 清理助手')
assert.match(watch, /deploy\/lib\/cleanup-smoke-profiles\.sh/, '巡检从仓库载入可测试的清理逻辑')
assert.match(profileCleanup, /kill -TERM -- "-\$pgid"/, '陈旧 Chrome 必须先整组优雅退出')
assert.match(profileCleanup, /kill -KILL -- "-\$pgid"/, '优雅退出超时后要结束整组，避免打开文件继续占磁盘')

// 用假的进程表和 kill 函数做行为测试，避免测试意外触碰开发机上的浏览器。
const cleanupFixture = mkdtempSync(join(tmpdir(), '8bitgo-smoke-cleanup-'))
try {
  const tempRoot = join(cleanupFixture, 'tmp')
  const bin = join(cleanupFixture, 'bin')
  const staleRunning = join(tempRoot, '8bitgo-smoke-stale-running')
  const staleDirectory = join(tempRoot, '8bitgo-smoke-stale-directory')
  const fresh = join(tempRoot, '8bitgo-smoke-fresh')
  const killLog = join(cleanupFixture, 'kill.log')
  const psCount = join(cleanupFixture, 'ps-count')
  const psInitial = join(cleanupFixture, 'ps-initial')
  const psRefresh = join(cleanupFixture, 'ps-refresh')
  mkdirSync(tempRoot)
  mkdirSync(bin)
  for (const profile of [staleRunning, staleDirectory, fresh]) mkdirSync(profile)
  const old = new Date(Date.now() - 60 * 60 * 1000)
  utimesSync(staleDirectory, old, old)
  writeFileSync(psInitial, [
    `4242 4242 1901 /opt/google/chrome/chrome --user-data-dir=${staleRunning}`,
    `4444 4444 1901 /opt/google/chrome/chrome --user-data-dir=${staleRunning}-suffix`,
    `4343 4343 25 /opt/google/chrome/chrome --user-data-dir=${fresh}`,
  ].join('\n') + '\n')
  writeFileSync(psRefresh, `4343 4343 26 /opt/google/chrome/chrome --user-data-dir=${fresh}\n`)
  writeFileSync(join(bin, 'ps'), [
    '#!/usr/bin/env bash',
    'n=0',
    '[ ! -f "$PS_COUNT" ] || n="$(cat "$PS_COUNT")"',
    'n=$((n + 1))',
    'printf \'%s\\n\' "$n" > "$PS_COUNT"',
    'if [ "$n" = 1 ]; then cat "$PS_INITIAL"; else cat "$PS_REFRESH"; fi',
  ].join('\n') + '\n')
  chmodSync(join(bin, 'ps'), 0o755)

  const cleanupCommand = [
    'kill() {',
    '  if [ "$1" = "-0" ]; then',
    '    n=0',
    '    [ ! -f "$KILL_CHECKS" ] || n="$(cat "$KILL_CHECKS")"',
    '    n=$((n + 1))',
    '    printf \'%s\\n\' "$n" > "$KILL_CHECKS"',
    '    [ "$n" != 1 ] || return 0',
    '    return 1',
    '  fi',
    '  printf \'%s\\n\' "$*" >> "$KILL_LOG"',
    '}',
    'sleep() { :; }',
    '. "$CLEANUP_HELPER"',
    'cleanup_stale_smoke_profiles "$TEMP_ROOT" 1800',
  ].join('\n')
  const cleanup = spawnSync('bash', ['--noprofile', '--norc', '-c', cleanupCommand], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      CLEANUP_HELPER: fileURLToPath(new URL('../deploy/lib/cleanup-smoke-profiles.sh', import.meta.url)),
      TEMP_ROOT: tempRoot,
      KILL_LOG: killLog,
      KILL_CHECKS: join(cleanupFixture, 'kill-checks'),
      PS_COUNT: psCount,
      PS_INITIAL: psInitial,
      PS_REFRESH: psRefresh,
    },
  })
  assert.equal(cleanup.status, 0, `profile 清理行为测试失败：${cleanup.stderr}`)
  assert.equal(existsSync(staleRunning), false, '运行超时的 Chrome 进程组停止后应删除 profile')
  assert.equal(existsSync(staleDirectory), false, '过期且无人使用的 profile 应删除')
  assert.equal(existsSync(fresh), true, '仍在使用中的新 profile 必须保留')
  assert.match(readFileSync(killLog, 'utf8'), /^-TERM -- -4242\n-KILL -- -4242\n$/, '只向匹配陈旧 profile 的 Chrome 进程组发送 TERM，再升级到 KILL')
  for (const file of ['deploy/lib/cleanup-smoke-profiles.sh', 'deploy/smoke-watch/8bitgo-smoke-watch.sh']) {
    const syntax = spawnSync('bash', ['-n', fileURLToPath(new URL(`../${file}`, import.meta.url))], { encoding: 'utf8' })
    assert.equal(syntax.status, 0, `${file} shell 语法错误：${syntax.stderr}`)
  }
} finally {
  rmSync(cleanupFixture, { recursive: true, force: true })
}

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
console.log('✔ 开局冒烟：判据、找 Chrome、统计隔离、部署回滚、孤儿 Chrome 清理与 profile 保留')
