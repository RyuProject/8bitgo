#!/usr/bin/env node
/**
 * 直播信令客户端（socket.io）的回归测试。
 *
 * 2026-11-20 起 socket.io-client 打进前端包（npm，版本钉死与服务端一致），连 /live 时才按需加载那个分块。
 * 以前是运行时从后端 /socket.io/socket.io.min.js 现取：那个地址 max-age=0，Cloudflare 每次回源复验，
 * 8bitgo.com 上的大陆访客走洛杉矶要 11～40 秒，8 秒超时一到开播 / 看直播就全失败；
 * 再往前还被页面全局的 define / module（UMD 分支）和 js-dos 泄漏的同名 io 坑过。
 * 这个测试守着：版本对齐、不再回到运行时取脚本、真能连上真的 socket.io 服务端。
 *
 * 跑：npm run test:live-io
 */
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

/**
 * 子进程场景：live.ts 在模块加载时就定下后端地址、并缓存已装好的 io，
 * 所以每个场景必须是一个新进程。场景里起一个真的 socket.io 服务端（server/ 装的那个版本），
 * 前端那份 socket.io-client 去连它 —— 两边版本不兼容、或者分块加载坏了，这里会连不上。
 */
const SCENARIO = process.argv.find((a) => a.startsWith('--scenario='))?.split('=')[1]
if (SCENARIO) {
  const out = {}
  globalThis.window = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
  if (SCENARIO === 'capacity') {
    globalThis.__viteEnv = { VITE_API_URL: 'same-origin' }
    globalThis.fetch = (_url, init = {}) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
    const { canAutoStartLive } = await import('../src/services/live.ts')
    const started = Date.now()
    out.capacity = await canAutoStartLive()
    out.ms = Date.now() - started
  } else {
    const { Server } = createRequire(join(root, 'server/package.json'))('socket.io')
    const io = new Server(0, { serveClient: false })
    if (SCENARIO === 'connect') {
      io.of('/live').on('connection', (socket) => {
        out.serverSawAuth = typeof socket.handshake.auth === 'object'
      })
    }
    const port = io.httpServer.address().port
    globalThis.__viteEnv = { VITE_API_URL: `http://127.0.0.1:${port}` }
    const { connectLive } = await import('../src/services/live.ts')
    const started = Date.now()
    try {
      const socket = await connectLive()
      out.connected = socket.connected === true
      socket.close()
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e)
    }
    out.ms = Date.now() - started
    io.close()
  }
  console.log(JSON.stringify(out))
  process.exit(0)
}

let pass = 0
const fails = []
const ck = (name, ok, detail = '') => {
  if (ok) pass++
  else fails.push(name)
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail ? `  — ${detail}` : ''}`)
}
const runScenario = (name) => {
  const res = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), `--scenario=${name}`], { encoding: 'utf8', timeout: 30_000 })
  try {
    return JSON.parse(res.stdout.trim().split('\n').pop())
  } catch {
    return { error: `${res.stdout}\n${res.stderr}`.slice(0, 800) }
  }
}
/** 去掉注释再查源码：注释里讲历史的句子不能让断言误通过 */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

console.log('① 前端 socket.io-client 与服务端 socket.io 版本对齐')
{
  const declared = JSON.parse(read('package.json')).dependencies?.['socket.io-client']
  const client = JSON.parse(read('node_modules/socket.io-client/package.json')).version
  const server = JSON.parse(read('server/node_modules/socket.io/package.json')).version
  const minor = (v) => v.split('.').slice(0, 2).join('.')
  ck('package.json 钉死精确版本（不用 ^ / ~ 范围）', /^\d+\.\d+\.\d+$/.test(declared ?? ''), String(declared))
  ck('装上的就是声明的版本', declared === client, `声明 ${declared}，装的 ${client}`)
  ck('与服务端 socket.io 同一个 major.minor（升级服务端时一起升前端）', minor(client) === minor(server), `前端 ${client}，服务端 ${server}`)
}

console.log('② 不再运行时现取脚本，也不读页面全局')
{
  const live = code('src/services/live.ts')
  ck('按需 import 打包好的 socket.io-client', /import\('socket\.io-client'\)/.test(live))
  ck('分块取不下来走 importWithRetry（换新地址就地重试）', /importWithRetry\(loadSocketIoClient, socketIoClientChunk, import\.meta\.url\)/.test(live))
  ck('不再请求后端的 /socket.io/socket.io*.js', !/socket\.io\/socket\.io/.test(live))
  ck('不读 window.io（js-dos 泄漏的同名全局碍不着）', !/\bwin(dow)?\.io\b/.test(live))
  ck('不用 new Function / <script> 装 UMD', !/new Function/.test(live) && !/createElement\('script'\)/.test(live))
  ck('UMD 帮手 src/lib/umd.ts 已删除', !existsSync(join(root, 'src/lib/umd.ts')))
  ck('加载失败会清掉共享 Promise，下次还能重试', /ioLoading = null/.test(live))
  ck('不静态 import（本文件经侧栏房间数进几乎每个页面）', !/^import[^\n]*from 'socket\.io-client'/m.test(read('src/services/live.ts')))
}

console.log('③ 真连一次：前端 socket.io-client ↔ 服务端 socket.io')
{
  const ok = runScenario('connect')
  ck('连上 /live 命名空间', ok.connected === true, JSON.stringify(ok))
  ck('握手带着 auth（登录令牌经它传给服务端）', ok.serverSawAuth === true, JSON.stringify(ok))
  const miss = runScenario('no-namespace')
  ck('后端没有 /live 时立刻失败，不白等 15 秒', typeof miss.error === 'string' && miss.ms < 5_000, JSON.stringify(miss))
}

console.log('④ 首次连接遇到瞬时网络错误不会立刻放弃')
{
  const live = code('src/services/live.ts')
  ck('Invalid namespace 这种确定错误仍然立即失败', /if \(\/invalid namespace\/i\.test\(msg\)\) finishError\(err\)/.test(live))
  ck('其余 connect_error 先记下，给 Socket.IO 留自动重连预算', /else lastError = err/.test(live))
  ck('总预算到期才真正关闭首连', /finishError\(lastError \?\? new Error\(getT\(\)\.runtime\.liveTimeout\)\)/.test(live))
}

console.log('⑤ 容量预检不能无限挂起')
{
  const live = code('src/services/live.ts')
  ck('容量预检最多等 4 秒', /LIVE_CAPACITY_TIMEOUT_MS = 4_000/.test(live) && /signal: controller\.signal/.test(live))
  const cap = runScenario('capacity')
  ck('预检超时后按 fail-open 返回，自动开播仍由服务端最终限额', cap.capacity === true && cap.ms < 6_000, JSON.stringify(cap))
}

console.log('⑥ 自动开播网络类失败有限补试，确定的拒绝不补')
{
  const { AUTO_LIVE_RETRY_DELAYS_MS, autoLiveRetryable } = await import('../src/emulator/autoLiveRetry.ts')
  ck('最多补两次，间隔递增', AUTO_LIVE_RETRY_DELAYS_MS.length === 2 && AUTO_LIVE_RETRY_DELAYS_MS[0] < AUTO_LIVE_RETRY_DELAYS_MS[1])
  for (const msg of [
    'Failed to fetch dynamically imported module: https://cn.8bitgo.com/_cn/assets/index-abc.js',
    'Importing a module script failed.',
    'websocket error',
    'xhr poll error',
    'go-live timeout',
    'failed',
    'disconnected',
    'SRS service unavailable',
    'rate limited',
  ]) ck(`补试：${msg}`, autoLiveRetryable(new Error(msg), '后端还没有直播功能'))
  for (const msg of [
    'server is full',
    'too many rooms',
    'unknown game',
    'already in a room',
    'adult age restricted',
    'adult login required',
    'no capture source',
    '后端还没有直播功能',
  ]) ck(`不补：${msg}`, !autoLiveRetryable(new Error(msg), '后端还没有直播功能'))

  const lc = code('src/emulator/LiveControls.tsx')
  ck('失败分支按 autoLiveRetryable 判断、按表里的间隔排下一次', /const delay = AUTO_LIVE_RETRY_DELAYS_MS\[failures\]/.test(lc) && /autoLiveRetryable\(e, getT\(\)\.runtime\.liveNoServer\)/.test(lc))
  ck('补试复用 effect 的 timer，换游戏 / 关直播时 cleanup 一并清掉', /timer = window\.setTimeout\(\(\) => \{\s*if \(cancelled \|\| liveRef\.current \|\| manualAttemptRef\.current !== manualAt\) return/.test(lc) && /window\.clearTimeout\(timer\)/.test(lc))
  ck('等待期间玩家手动开播 / 关播（manualAttemptRef 变了）就不再插手', /const manualAt = manualAttemptRef\.current/.test(lc))
}

console.log(`\n${pass}/${pass + fails.length} 通过`)
if (fails.length) {
  console.error('失败：', fails.join(' / '))
  process.exit(1)
}
console.log('直播 socket.io 客户端测试通过')
