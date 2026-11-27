#!/usr/bin/env node
/**
 * 真实开局冒烟（2026-11-15 系统优化 #4）：用无头 Chrome 打开几款游戏的详情页，
 * 先关掉默认公开直播，再点「开始游戏」，等播放器报「首帧」才算过。
 *
 *   node scripts/smoke-start.mjs                                   默认测 https://8bitgo.com
 *   node scripts/smoke-start.mjs --base http://127.0.0.1:8788      测本机 / 刚重启的生产进程
 *   SMOKE_GAMES=super-mario-bros,cadillacs-and-dinosaurs node scripts/smoke-start.mjs
 *
 * 为什么要有它：/api/health 200 只说明进程活着。2026-09 以来好几次事故都是「站点一切正常、
 * 游戏打不开」—— 引擎补丁没进 dist（§2.5）、核心回落坏地址（§2.4）、Rocket Loader 改写脚本（§2.37.1）。
 * 这些只有真把一局跑到首帧才看得出来。
 *
 * 判据取自播放器自己的启动漏斗：它在出首帧时 POST /api/games/<slug>/startup {event:'first_frame'}，
 * 失败 / 超时时发 failed / timeout。这里用 Chrome DevTools 协议的 Fetch 域**拦下**这些请求读出事件，
 * 再回一个假的 200 —— 冒烟不会进生产的启动漏斗、诊断包和游玩次数（/play 一并拦下）。
 *
 * 不引入任何依赖：Chrome 自带 DevTools 协议，Node 22 自带 WebSocket。找 Chrome 的顺序：
 * 环境变量 CHROME_PATH → 常见安装位置。找不到就退出码 2（redeploy 据此只记一行「跳过」）。
 *
 * 退出码：0 全部到首帧；1 有游戏失败；2 环境不满足（没有 Chrome 等）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { sanitizeStartupDetail } from '../server/src/startup-metrics.js'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const BASE = argOf('--base', process.env.SMOKE_BASE_URL || 'https://8bitgo.com').replace(/\/+$/, '')
// GBA 样例专门守 mGBA 的 HLE BIOS 路径；第三款游戏能拦住“ROM 可读、可选 BIOS 外链却阻断开局”这类回归。
export const DEFAULT_SMOKE_GAMES = 'super-mario-bros,cadillacs-and-dinosaurs,pokemon-sapphire'
// NES（jsnes / EmulatorJS）、CPS1（FBNeo + 8BG 解包）和 GBA（mGBA）各覆盖一条不同启动链。
const GAMES = argOf('--games', process.env.SMOKE_GAMES || DEFAULT_SMOKE_GAMES)
  .split(',').map((s) => s.trim()).filter(Boolean)
const TIMEOUT_MS = Number(argOf('--timeout', process.env.SMOKE_TIMEOUT_MS || 150_000))
const DISABLE_WEBGL = process.env.SMOKE_DISABLE_WEBGL === '1'
/** 带大 CHD 的 MAME 柜台不能沿用普通 ROM 的 150 秒预算。 */
export const MAME_CHD_TIMEOUT_MS = 420_000
/** DevTools 自己没回应时，不能把测试机问题写成游戏启动失败。 */
export const CDP_COMMAND_TIMEOUT_MS = 15_000
// Page.navigate 的回包要等服务端先交出主文档；公网 SSR 在高峰可超过普通 CDP 指令预算。
const PAGE_NAVIGATION_COMMAND_TIMEOUT_MS = 60_000
/** 页面必须先确认「不公开」再开局；控件文案没认出来就停测，不能冒险公开推流。 */
export const PRIVATE_START_TIMEOUT_MS = 90_000
const TARGET_CLOSE_TIMEOUT_MS = 5_000

/**
 * 在页面内安全开局：新标签默认会自动公开直播，必须先点成不公开并确认状态已翻转。
 * 文案覆盖本站支持的七种界面语言；遇到未识别的启用中开关时失败关闭，避免误公开。
 */
export const PRIVATE_START_EXPRESSION = String.raw`(() => {
  const normalize = value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim()
  const startLabels = ['开始游戏', 'Start game', 'ゲームを開始', 'Lancer le jeu', 'Empezar a jugar', 'Spiel starten', 'Avvia il gioco']
  const buttons = Array.from(document.querySelectorAll('button'))
  const startButton = buttons.find(button => !button.disabled && startLabels.some(label => normalize(button.innerText).includes(normalize(label))))
  if (!startButton) return { state: 'waiting' }

  const toggles = buttons.filter(button => button.hasAttribute('aria-pressed'))
  const livePattern = /live|stream|broadcast|直播|配信|ライブ|transmi|diffus|directo|diretta|übertrag/i
  const liveButton = toggles.find(button => livePattern.test([button.title, button.getAttribute('aria-label'), button.innerText].join(' ')))
  const enabledUnknownToggle = toggles.some(button => button.getAttribute('aria-pressed') === 'true' && button !== liveButton)
  if (enabledUnknownToggle) return { state: 'unsafe-toggle' }

  if (liveButton && liveButton.getAttribute('aria-pressed') === 'true') {
    if (!window.__8bgSmokePrivateRequested) {
      window.__8bgSmokePrivateRequested = true
      liveButton.click()
    }
    return { state: 'waiting-private' }
  }

  if (liveButton && liveButton.getAttribute('aria-pressed') !== 'false') return { state: 'waiting-private' }
  startButton.click()
  return { state: 'started-private' }
})()`

export const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
]

export function findChrome(env = process.env, exists = existsSync) {
  if (env.CHROME_PATH && exists(env.CHROME_PATH)) return env.CHROME_PATH
  return CHROME_CANDIDATES.find((p) => exists(p)) || ''
}

/** 拦下的启动漏斗请求体 → 事件名列表；兼容合并了阶段与首帧的批量请求。 */
export function startupEventsOf(postData) {
  try {
    const body = JSON.parse(postData || '{}')
    if (typeof body.event === 'string') return [body.event]
    if (Array.isArray(body.events)) {
      return body.events.flatMap((event) => typeof event?.event === 'string' ? [event.event] : [])
    }
    return []
  } catch {
    return []
  }
}

/** 单事件兼容入口，供既有调用方和纯函数测试使用。 */
export function startupEventOf(postData) {
  return startupEventsOf(postData)[0] || ''
}

/** 启动事件里的原因摘要沿用服务端脱敏规则，避免冒烟日志泄露 URL、IP 或访问凭据。 */
export function startupDetailOf(postData) {
  try {
    const body = JSON.parse(postData || '{}')
    return sanitizeStartupDetail(body?.detail) || ''
  } catch {
    return ''
  }
}

/** 一局的结论：首帧 = 过；failed / timeout = 不过；其它事件继续等 */
export function verdictOf(event) {
  if (event === 'first_frame') return 'pass'
  if (event === 'failed' || event === 'timeout') return 'fail'
  return ''
}

/** DevToolsActivePort 的内容 → ws 地址；没写完（空、缺路径、端口不对）返回空串 */
export function devToolsUrlOf(text) {
  const [port, path] = String(text || '').trim().split('\n').map((s) => s.trim())
  if (!/^\d{1,5}$/.test(port || '') || Number(port) < 1 || Number(port) > 65535) return ''
  if (!/^\/devtools\/browser\/\S+$/.test(path || '')) return ''
  return `ws://127.0.0.1:${port}${path}`
}

/**
 * Promise 本身没有取消能力；这里仅收回等待权。超时后的 CDP 命令会随 Chrome 进程组一起结束。
 *
 * 2026-11-25 批量复测曾把 Target.createTarget 的异常记成游戏 load_fail。更糟的是，重载
 * MAME + CHD 时 DevTools 偶尔不回应 Target.closeTarget，原先即使已经等满首帧预算，也会卡在
 * finally 而不打印结论。所有 CDP 命令因此必须有独立上限。
 */
export function waitWithin(promise, timeoutMs, message) {
  let timer = 0
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** 无登录态的冒烟不能越过年龄门；这是可说明的跳过，不是游戏加载失败。 */
export function adultGateReason(access) {
  if (!access || access.adult !== true || access.allowed === true) return ''
  const reason = typeof access.reason === 'string' ? access.reason : ''
  return reason ? `年龄门：${reason}` : '年龄门未放行'
}

/** 已知大 CHD 的 MAME 柜台会先完整下载媒体盘，再能交给核心启动。 */
export function timeoutForGame(game, fallback) {
  const disks = Array.isArray(game?.arcadeMameDisks) ? game.arcadeMameDisks : []
  return disks.some((disk) => Number(disk?.storedBytes) >= 32 * 1024 * 1024)
    ? Math.max(fallback, MAME_CHD_TIMEOUT_MS)
    : fallback
}

async function fetchJsonWithin(url, timeoutMs = 10_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) return { status: response.status, value: null }
    return { status: response.status, value: await response.json() }
  } catch {
    // 预检只用于改善归因；接口暂时不可用时仍让真实页面自行验证。
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function smokePreflight(slug) {
  const gameUrl = `${BASE}/api/games/${encodeURIComponent(slug)}`
  const [gameResult, accessResult] = await Promise.all([fetchJsonWithin(gameUrl), fetchJsonWithin(`${gameUrl}/access`)])
  const game = gameResult?.value ?? null
  return {
    game,
    gameNotFound: gameResult?.status === 404,
    adultGate: adultGateReason(accessResult?.value),
    timeoutMs: timeoutForGame(game, TIMEOUT_MS),
  }
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    this.ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data))
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`))
        else resolve(msg.result)
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg)
      }
    })
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('连不上 Chrome DevTools')), { once: true })
    })
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  on(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  close() {
    try { this.ws.close() } catch { /* 已断开 */ }
  }
}

function sendWithin(cdp, method, params = {}, sessionId, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
  return waitWithin(cdp.send(method, params, sessionId), timeoutMs, `Chrome DevTools 在 ${Math.ceil(timeoutMs / 1000)} 秒内没有响应：${method}`)
}

/** 等播放器按钮出现，并在同一页面里先关公开直播，再点开始。 */
export async function startSmokeGamePrivately(cdp, sessionId, timeoutMs = PRIVATE_START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await sendWithin(cdp, 'Runtime.evaluate', {
      expression: PRIVATE_START_EXPRESSION,
      returnByValue: true,
    }, sessionId)
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '无法检查开局隐私状态')
    const state = result.result?.value?.state
    if (state === 'started-private') return
    if (state === 'unsafe-toggle') throw new Error('页面有未识别的启用开关，已停止冒烟以避免公开开局')
    await sleep(150)
  }
  throw new Error('没有在时限内确认不公开状态并开始游戏')
}

async function launchChrome(chrome) {
  const profile = mkdtempSync(join(tmpdir(), '8bitgo-smoke-'))
  const proc = spawn(chrome, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    // 默认用软件 WebGL 覆盖服务器没有 GPU 的情况；专门验 Canvas 2D 退路时显式禁用 WebGL。
    ...(DISABLE_WEBGL ? ['--disable-webgl'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    '--window-size=1280,800',
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    'about:blank',
    // detached：Chrome 自成一个进程组，收尾时整组终止 —— 只杀主进程的话，渲染 / GPU 子进程还会往 profile 里写一会儿，
    // 删目录就撞上 ENOTEMPTY（2026-11-18 生产机实测：两款都到了首帧，却因此被报成「冒烟没能运行」）
  ], { stdio: 'ignore', detached: true })
  const killGroup = (signal) => {
    try { process.kill(-proc.pid, signal) } catch { try { proc.kill(signal) } catch { /* 已退出 */ } }
  }
  const removeProfile = () => {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch (error) {
      // 收尾失败不能改写冒烟结论（通过 / 失败已经定了）；只留一句，下次巡检前的 /tmp 清理兜底
      console.warn(`⚠️ Chrome 临时目录没删掉：${profile}（${error?.code || error?.message || error}）`)
    }
  }
  const portFile = join(profile, 'DevToolsActivePort')
  /*
    文件「存在」不等于「写完」：Chrome 先建文件再写端口和路径。2026-11-21 生产巡检读到空文件，
    拼出 ws://127.0.0.1:undefined，WebSocket 报「TypeError: Invalid URL」，记成「冒烟没能运行」。
    所以等到内容能解析成端口 + 路径才算启动好。
  */
  let url = ''
  for (let i = 0; i < 100 && !url; i++) {
    url = devToolsUrlOf(existsSync(portFile) ? readFileSync(portFile, 'utf8') : '')
    if (!url) await sleep(100)
  }
  if (!url) {
    killGroup('SIGKILL')
    removeProfile()
    throw new Error('Chrome 没有启动 DevTools（10 秒）')
  }
  return {
    url,
    /*
      必须等 Chrome 真退出、再同步删 profile，然后调用方才能 process.exit。
      以前是 unref 的 1 秒定时器：进程马上 exit，定时器根本不跑，每次在 /tmp 留下几十 MB 的 profile
      （生产机实测 76MB）。定时巡检每 15 分钟一次的话，一天就是好几 GB，系统盘只有 20GB。
    */
    async close() {
      const exited = proc.exitCode !== null || proc.signalCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => proc.once('exit', resolve))
      killGroup('SIGTERM')
      await Promise.race([exited, sleep(3000)])
      killGroup('SIGKILL')
      await Promise.race([exited, sleep(2000)])
      // 主进程退了，组里的子进程可能还要一点时间才真正结束
      await sleep(300)
      removeProfile()
    },
  }
}

async function smokeOne(cdp, slug) {
  const started = Date.now()
  const preflight = await smokePreflight(slug)
  if (preflight.gameNotFound) {
    return { slug, verdict: 'skip', event: '游戏详情接口返回 404', seconds: Math.round((Date.now() - started) / 1000), events: [], errors: [] }
  }
  if (preflight.adultGate) {
    return { slug, verdict: 'skip', event: preflight.adultGate, seconds: Math.round((Date.now() - started) / 1000), events: [], errors: [] }
  }
  let targetId = ''
  let sessionId = ''
  const events = []
  const errors = []
  let settle
  let timer = 0
  const done = new Promise((resolve) => { settle = resolve })
  let off = () => {}
  try {
    const target = await sendWithin(cdp, 'Target.createTarget', { url: 'about:blank' })
    targetId = target.targetId
    const attached = await sendWithin(cdp, 'Target.attachToTarget', { targetId, flatten: true })
    sessionId = attached.sessionId
  } catch (error) {
    if (targetId) await sendWithin(cdp, 'Target.closeTarget', { targetId }, undefined, TARGET_CLOSE_TIMEOUT_MS).catch(() => {})
    return {
      slug,
      verdict: 'infrastructure',
      event: `测试标签页不可用：${error instanceof Error ? error.message : String(error)}`,
      seconds: Math.round((Date.now() - started) / 1000),
      events,
      errors,
    }
  }
  off = cdp.on(async (msg) => {
    if (msg.sessionId !== sessionId) return
    if (msg.method === 'Fetch.requestPaused') {
      const { requestId, request } = msg.params
      let pathname = ''
      try { pathname = new URL(request.url).pathname } catch { /* 拦到的地址解析不了：当作不是漏斗请求，照样放过 */ }
      if (/\/startup(?:\?|$)/.test(pathname)) {
        let body = request.postData
        if (!body && request.hasPostData) {
          body = (await sendWithin(cdp, 'Fetch.getRequestPostData', { requestId }, sessionId).catch(() => ({}))).postData
        }
        const eventsInRequest = startupEventsOf(body)
        const detail = startupDetailOf(body)
        for (const event of eventsInRequest) {
          events.push(`${event}${detail ? ` (${detail})` : ''}@${Math.round((Date.now() - started) / 1000)}s`)
          const verdict = verdictOf(event)
          if (verdict) settle({ verdict, event })
        }
      }
      // 回假的 200：不进生产漏斗、诊断包、游玩次数
      await sendWithin(cdp, 'Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from('{"ok":true}').toString('base64'),
      }, sessionId).catch(() => {})
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails?.exception?.description?.split('\n')[0] || msg.params.exceptionDetails?.text)
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args?.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
    }
  })
  try {
    await sendWithin(cdp, 'Fetch.enable', {
      patterns: [
        { urlPattern: '*/api/games/*/startup*', requestStage: 'Request' },
        { urlPattern: '*/api/games/*/play*', requestStage: 'Request' },
      ],
    }, sessionId)
    await sendWithin(cdp, 'Runtime.enable', {}, sessionId)
    await sendWithin(cdp, 'Page.enable', {}, sessionId)
    await sendWithin(cdp, 'Page.navigate', { url: `${BASE}/games/${encodeURIComponent(slug)}` }, sessionId, PAGE_NAVIGATION_COMMAND_TIMEOUT_MS)
    timer = setTimeout(() => settle({ verdict: 'fail', event: `${Math.round(preflight.timeoutMs / 1000)} 秒内没有首帧` }), preflight.timeoutMs)
    await startSmokeGamePrivately(cdp, sessionId)
    const result = await done
    return { slug, ...result, seconds: Math.round((Date.now() - started) / 1000), events, errors: errors.filter(Boolean).slice(-5) }
  } catch (error) {
    return {
      slug,
      verdict: 'infrastructure',
      event: `测试环境未能启动页面：${error instanceof Error ? error.message : String(error)}`,
      seconds: Math.round((Date.now() - started) / 1000),
      events,
      errors: errors.filter(Boolean).slice(-5),
    }
  } finally {
    if (timer) clearTimeout(timer)
    off()
    if (targetId) await sendWithin(cdp, 'Target.closeTarget', { targetId }, undefined, TARGET_CLOSE_TIMEOUT_MS).catch(() => {})
  }
}

async function main() {
  const chrome = findChrome()
  if (!chrome) {
    console.error('✖ 找不到 Chrome / Chromium（设 CHROME_PATH 指定）；跳过开局冒烟')
    process.exit(2)
  }
  if (typeof WebSocket !== 'function') {
    console.error('✖ 这个 Node 没有全局 WebSocket（需要 Node 22+）；跳过开局冒烟')
    process.exit(2)
  }
  console.log(`开局冒烟：${BASE}，${GAMES.join('、')}（${DISABLE_WEBGL ? '禁用 WebGL；' : ''}普通游戏最多 ${Math.round(TIMEOUT_MS / 1000)} 秒；大 CHD 柜台最多 ${Math.round(MAME_CHD_TIMEOUT_MS / 1000)} 秒）`)
  const browser = await launchChrome(chrome)
  const cdp = new Cdp(browser.url)
  let failed = 0
  let infrastructureFailed = 0
  try {
    await cdp.open()
    // 逐款串行：并行几局会互相抢 CPU（无头 Chrome 是软件 WebGL），慢的那款容易被误判超时
    for (const slug of GAMES) {
      const r = await smokeOne(cdp, slug)
      const mark = r.verdict === 'pass' ? '✔' : r.verdict === 'skip' ? '○' : r.verdict === 'infrastructure' ? '⚠' : '✖'
      const line = `${mark} ${slug}：${r.event}（${r.seconds} 秒；漏斗 ${r.events.join(' → ') || '无'}）`
      if (r.verdict === 'pass') console.log(line)
      else if (r.verdict === 'skip') console.log(line)
      else if (r.verdict === 'infrastructure') {
        infrastructureFailed++
        console.error(line)
      }
      else {
        failed++
        console.error(line)
        for (const e of r.errors) console.error(`    ${e}`)
      }
    }
  } finally {
    cdp.close()
    await browser.close()
  }
  // 退出码 2 与“没有 Chrome”一致：部署不能因测试机自身失效误回滚，但仍需告警。
  process.exit(failed ? 1 : infrastructureFailed ? 2 : 0)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error('✖ 冒烟脚本出错：', e?.message || e)
    process.exit(2)
  })
}
