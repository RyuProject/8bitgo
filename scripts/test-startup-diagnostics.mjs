#!/usr/bin/env node
/**
 * 启动诊断包（后台「错误诊断」页）回归：不联网、不连数据库。
 *
 *   - 服务端：白名单重建 + 脱敏（ROM 文件名、令牌、IP、邮箱）、大小上限、User-Agent 只归到
 *     「浏览器 + 大版本 / 系统 / 设备」、错误特征把变量抹掉后同类合并；
 *   - 前端采集：阶段时间线、只取本局日志、网址缩短、只在失败 / 超时 / 慢启动时附带；
 *   - 「复制给 AI」的 Markdown 包含概况和完整现场；
 *   - 路由 / 迁移 / 后台入口都接上了。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  classifyUserAgent,
  DIAGNOSTICS_RETENTION_DAYS,
  errorSignature,
  normalizeDiagnostics,
  scrub,
} from '../server/src/startup-diagnostics.js'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

/* ---------- 服务端：脱敏与白名单 ---------- */
{
  assert.equal(
    scrub('GET https://assets.8bitgo.com/roms/nes/super-mario-bros.en.nes.8bg?romv=abc failed'),
    'GET assets.8bitgo.com/roms/…/[ROM].en.nes.8bg failed',
    'ROM 地址只留主机和扩展名',
  )
  assert.equal(scrub('https://8bitgo.com/emulatorjs/cores/fceumm-wasm.data?v=1'), '8bitgo.com/emulatorjs/…/fceumm-wasm.data')
  assert.doesNotMatch(scrub('Authorization: Bearer abc.def.ghi token=SECRET123'), /abc\.def|SECRET123/, '令牌必须抹掉')
  assert.equal(scrub('peer 203.0.113.9 / 2001:db8:85a3::8a2e:370:7334 mail a@b.com'), 'peer [IP] / [IP] mail [邮箱]')
  assert.equal(scrub('PPSSPP 流式读盘失败： \u001b[0m \u001b[91midle0 E[LOADER]: x [0m'), 'PPSSPP 流式读盘失败： idle0 E[LOADER]: x', '终端颜色码去掉')
  assert.equal(scrub('at 18:15:39 std::bad_alloc error::Fatal fe80::1'), 'at 18:15:39 std::bad_alloc error::Fatal [IP]', '时间和 C++ 名字不能被当成 IPv6')

  const big = normalizeDiagnostics({
    build: 'index-AbC12.js<script>',
    reason: 'x'.repeat(2000),
    secret: 'should vanish',
    env: { mem: 8, cores: 10, net: { type: '4g', downlink: 9.5, rtt: 150, saveData: false }, screen: '1920x1080@2', touch: 0, lang: 'es-SV', coi: false, sab: true, online: true, hiddenMs: 1200, visible: true, ua: 'Mozilla' },
    attempt: { index: 3, sinceStartMs: 62_545 },
    timeline: [{ t: 0, e: 'start_click' }, { t: 430, e: 'download_complete' }],
    logs: Array.from({ length: 200 }, (_, i) => ({ t: i, s: 'ejs', l: 'warn', m: `line ${i} ${'y'.repeat(400)}` })),
    resources: [{ n: 'cdn.example/x', i: 'fetch', at: 10, d: 30_000, tx: 0, sz: 0, st: 0, p: 'h2' }],
  })
  assert.equal(big.secret, undefined, '未知字段丢弃')
  assert.equal(big.env.ua, undefined, '环境里也不收 UA')
  assert.equal(big.build, 'index-AbC12.jsscript')
  assert.equal(big.reason.length, 600)
  assert.ok(big.logs.length <= 60, '日志最多 60 行')
  assert.ok(big.logs.every((row) => row.m.length <= 300))
  assert.ok(JSON.stringify(big).length <= 32_000, '入库前封顶 32KB')
  assert.equal(big.timeline[1].e, 'download_complete')
  assert.equal(normalizeDiagnostics('nope'), null)
  assert.equal(normalizeDiagnostics([1]), null)
  assert.equal(DIAGNOSTICS_RETENTION_DAYS, 30)
}

/* ---------- 服务端：User-Agent 只归到粗粒度 ---------- */
{
  const cases = [
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Safari/605.1.15', 'Safari 26', 'macOS', 'desktop'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36', 'Chrome 150', 'macOS', 'desktop'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1', 'Safari 18', 'iOS 18', 'mobile'],
    ['Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36', 'Samsung 25', 'Android 14', 'mobile'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 'Edge 130', 'Windows', 'desktop'],
    ['Mozilla/5.0 (Linux; Android 13; V2219A Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.47', 'WeChat 8', 'Android 13', 'mobile'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36', 'Chrome 156', 'ChromeOS', 'desktop'],
    ['', 'Other', 'Other', 'desktop'],
  ]
  for (const [ua, browser, os, device] of cases) {
    assert.deepEqual(classifyUserAgent(ua), { browser, os, device }, ua)
  }
}

/* ---------- 服务端：错误特征 ---------- */
{
  const a = errorSignature({ event: 'failed', runtime: 'emulatorjs', detail: 'Error downloading core (fceumm-wasm.data) after 30000 ms, 42%' })
  const b = errorSignature({ event: 'failed', runtime: 'emulatorjs', detail: 'Error downloading core (fceumm-wasm.data) after 12000 ms, 7%' })
  assert.equal(a.signature, b.signature, '数字不同的同一类错误要合并')
  assert.match(a.signature, /^[\da-f]{16}$/)
  const c = errorSignature({ event: 'timeout', runtime: 'emulatorjs', detail: 'Error downloading core (fceumm-wasm.data) after 30000 ms, 42%' })
  assert.notEqual(a.signature, c.signature, '失败和超时分开')
  const slowA = errorSignature({ event: 'slow_start', runtime: 'emulatorjs', detail: '等待 game_playable 已超过 20 秒', diagnostics: { logs: [{ s: 'stage', m: 'Download Game Core 37%' }] } })
  const slowB = errorSignature({ event: 'slow_start', runtime: 'emulatorjs', detail: '等待 game_playable 已超过 20 秒', diagnostics: { logs: [{ s: 'stage', m: 'Decompress Game Core 12%' }] } })
  assert.notEqual(slowA.signature, slowB.signature, '慢启动按停在哪一步归组')
  assert.match(slowA.text, /停在：Download Game Core #%/)
}

/* ---------- 前端采集 ---------- */
{
  const listeners = {}
  const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  define('window', {
    addEventListener: (type, fn) => { listeners[type] = fn },
    devicePixelRatio: 2,
    crossOriginIsolated: false,
  })
  define('document', {
    visibilityState: 'visible',
    addEventListener: (type, fn) => { listeners[`doc:${type}`] = fn },
    querySelector: () => ({ src: 'https://8bitgo.com/assets/index-Xy12AB.js' }),
  })
  define('location', { href: 'https://8bitgo.com/es/games/super-mario-bros' })
  define('screen', { width: 1440, height: 900 })
  define('navigator', { hardwareConcurrency: 8, language: 'es-SV', maxTouchPoints: 0, onLine: true, deviceMemory: 8, connection: { effectiveType: '4g', downlink: 10, rtt: 100, saveData: false } })

  const hub = await import('../src/services/startupDiagnostics.ts')
  hub.resetStartupDiagnosticsForTest()
  const visit = 'visit-0001'
  hub.noteStartupEvent(visit, undefined, 'detail_view')
  console.warn('[emulatorjs] 早于点击的告警')
  hub.noteStartupEvent(visit, 'attempt-0001', 'start_click')
  hub.diagLog('stage', 'info', 'Descargando Núcleo del Juego')
  hub.diagLog('stage', 'info', 'Descargando Núcleo del Juego')
  hub.diagLog('ejs', 'warn', '[EJS Cache] get 超过 15 秒，本局停用缓存', 'https://8bitgo.com/emulatorjs/cores/fceumm-wasm.data?v=x')
  hub.diagLog('download', 'warn', '分片 3 失败', new TypeError('Failed to fetch'), 'https://assets.8bitgo.com/roms/nes/smb.nes.8bg?romv=1')
  hub.noteStartupEvent(visit, 'attempt-0001', 'download_complete')
  document.visibilityState = 'hidden'
  listeners['doc:visibilitychange']()

  const bundle = hub.collectStartupDiagnostics('attempt-0001', 'La carga se ha quedado atascada en «Descargando Núcleo del Juego»')
  assert.ok(bundle)
  assert.equal(bundle.build, 'index-Xy12AB.js')
  assert.deepEqual(bundle.timeline.map((r) => r.e), ['start_click', 'download_complete'])
  assert.equal(bundle.attempt.index, 1)
  assert.equal(bundle.env.lang, 'es-SV')
  assert.equal(bundle.env.mem, 8)
  assert.equal(bundle.env.visible, false)
  assert.equal(bundle.logs.filter((r) => r.s === 'stage').length, 1, '连续重复的同一行只留一条')
  assert.ok(bundle.logs.some((r) => r.s === 'page' && /早于点击/.test(r.m)), '点击前几秒的页面告警也带上')
  const cacheLine = bundle.logs.find((r) => r.s === 'ejs')
  assert.match(cacheLine.m, /8bitgo\.com\/emulatorjs\/…\/fceumm-wasm\.data/)
  assert.doesNotMatch(cacheLine.m, /\?v=/)
  const dl = bundle.logs.find((r) => r.s === 'download')
  assert.match(dl.m, /TypeError: Failed to fetch/)
  assert.match(dl.m, /\[ROM\]\.nes\.8bg/)
  assert.doesNotMatch(dl.m, /smb/, 'ROM 文件名不能出现')
  assert.ok(JSON.stringify(bundle).length <= 24_000)
  assert.equal(hub.collectStartupDiagnostics('unknown-attempt'), null, '没有这一局的记录就不发')

  // 运行时现场快照：打包时调用，排在日志最后；注销后不再出现
  const stop = hub.registerDiagnosticSnapshot(() => 'PSP 现场：模式 stream，已读 12.0MB https://assets.8bitgo.com/roms/psp/gt.chd?romv=1')
  hub.registerDiagnosticSnapshot(() => { throw new Error('取不到') })
  const withSnap = hub.collectStartupDiagnostics('attempt-0001')
  const snap = withSnap.logs.at(-1)
  assert.equal(snap.s, 'snapshot')
  assert.match(snap.m, /已读 12\.0MB assets\.8bitgo\.com\/roms\/…\/\[ROM\]\.chd/)
  assert.equal(withSnap.logs.filter((r) => r.s === 'snapshot').length, 1, '抛错的快照被跳过')
  assert.ok(withSnap.logs.length <= 60)
  stop()
  assert.ok(!hub.collectStartupDiagnostics('attempt-0001').logs.some((r) => /PSP 现场/.test(r.m)))
  hub.diagLog('ppsspp', 'error', '\u001b[91midle0 E[LOADER]: Range request failed')
  assert.equal(hub.collectStartupDiagnostics('attempt-0001').logs.at(-1).m, 'idle0 E[LOADER]: Range request failed')

  hub.noteStartupEvent(visit, 'attempt-0002', 'start_click')
  assert.equal(hub.collectStartupDiagnostics('attempt-0002').attempt.index, 2, '同一次访问的第二次开局')
  assert.equal(hub.shortenUrl('blob:https://8bitgo.com/1234'), 'blob:[本地文件]')
}

/* ---------- 「复制给 AI」 ---------- */
{
  const { formatGroupForAi } = await import('../src/admin/diagnosticsReport.ts')
  const group = {
    signature: '0123456789abcdef', text: 'failed · emulatorjs · 卡在下载核心', event: 'failed', runtime: 'emulatorjs',
    count: 3, visits: 2, games: [{ slug: 'super-mario-bros', title: '超级玛丽奥兄弟', count: 3 }],
    browsers: [{ name: 'Safari 26', count: 3 }], os: [{ name: 'macOS', count: 3 }], countries: [{ name: 'SV', count: 3 }],
    firstSeen: '2026-11-10 01:02:26', lastSeen: '2026-11-10 18:18:26', latestId: '9',
  }
  const sample = {
    id: '9', slug: 'super-mario-bros', title: '超级玛丽奥兄弟', event: 'failed', runtime: 'emulatorjs', platform: 'nes',
    country: 'SV', browser: 'Safari 26', os: 'macOS', device: 'desktop', elapsedMs: 62_545,
    signature: group.signature, signatureText: group.text, createdAt: '2026-11-10 18:18:26',
    diagnostics: normalizeDiagnostics({
      build: 'index-Xy12AB.js', reason: '卡在下载核心',
      env: { mem: 8, cores: 8, net: null, screen: '1440x900@2', touch: 0, lang: 'es-SV', coi: false, sab: true, online: true, hiddenMs: 0, visible: true },
      attempt: { index: 3, sinceStartMs: 62_545 },
      timeline: [{ t: 0, e: 'start_click' }, { t: 538, e: 'download_complete' }],
      logs: [{ t: 600, s: 'stage', l: 'info', m: 'Descargando Núcleo del Juego' }],
      resources: [{ n: '8bitgo.com/emulatorjs/…/fceumm-wasm.data', i: 'fetch', at: 700, d: 30_000, tx: 0, sz: 0, st: 0, p: 'h2' }],
    }),
  }
  const md = formatGroupForAi(group, [sample])
  for (const needle of ['# 8BitGo 启动故障', 'AGENTS.md', 'Safari 26×3', 'SV×3', '超级玛丽奥兄弟（super-mario-bros）×3', '阶段时间线', '538ms  download_complete', '[stage/info] Descargando Núcleo del Juego', 'fceumm-wasm.data', '本次访问第 3 次开局', '内存 8GB']) {
    assert.ok(md.includes(needle), `复制给 AI 的文本缺「${needle}」`)
  }
}

/* ---------- 接线 ---------- */
{
  const funnel = read('src/services/startupFunnel.ts')
  assert.match(funnel, /DIAGNOSTIC_EVENTS = new Set<StartupEventName>\(\['failed', 'timeout', 'slow_start'\]\)/)
  assert.match(funnel, /collectStartupDiagnostics\(payload\.attemptId, payload\.detail\)/)
  const games = read('server/src/routes/games.js')
  assert.match(games, /if \(result\.recorded && req\.body\?\.diagnostics\)/, '只在漏斗事件首次入库时写诊断包')
  assert.match(games, /userAgent: req\.headers\['user-agent'\]/)
  const admin = read('server/src/routes/admin.js')
  for (const path of ["'/startup-diagnostics'", "'/startup-diagnostics/samples'", "'/startup-diagnostics/:id'"]) {
    assert.ok(admin.includes(`adminRouter.get(${path}, requireAbility('content:edit')`), `${path} 必须要后台权限`)
  }
  assert.ok(admin.indexOf("'/startup-diagnostics/samples'") < admin.indexOf("'/startup-diagnostics/:id'"), 'samples 必须注册在 :id 之前')
  assert.match(read('server/scripts/migrate.mjs'), /CREATE TABLE IF NOT EXISTS game_startup_diagnostics/)
  assert.match(read('server/schema-v2.sql'), /CREATE TABLE IF NOT EXISTS game_startup_diagnostics/)
  assert.match(read('server/src/schema-check.js'), /table: 'game_startup_diagnostics'/)
  assert.match(read('src/AppRoutes.tsx'), /path="diagnostics" element=\{<RouteChunk><AdminDiagnostics \/>/)
  assert.match(read('src/admin/AdminLayout.tsx'), /to: '\/admin\/diagnostics', label: '错误诊断', need: 'content:edit'/)
  const ejs = read('src/emulator/adapters/emulatorjs.ts')
  assert.match(ejs, /diagLog\('ejs'/, '引擎日志进诊断包')
  assert.match(ejs, /diagLog\('stage', 'info', stage\)/, '加载阶段进诊断包')
  assert.match(ejs, /stopFramePerf = watchFramePerformance\(win\)/, 'iframe 的网络记录（核心下载）进诊断包')
  assert.match(read('server/src/cn-edge.js'), /res\.setHeader\('Timing-Allow-Origin', siteOrigin\)/, '加速入口要让诊断包看得到传输字节')
  const psp = read('src/emulator/adapters/ppsspp.ts')
  assert.match(psp, /registerDiagnosticSnapshot\(/, 'PSP 读盘字节数与帧率 / 预读采样进快照')
  assert.match(psp, /stopFramePerf = watchFramePerformance\(win\)/, 'PSP 核心下载请求进诊断包')
  assert.match(psp, /diagLog\('ppsspp'/, 'PSP 核心错误输出进诊断包')
  assert.match(psp, /diagLog\('stage', 'info', text\)/, 'PSP 桥的阶段文字进诊断包')
  assert.match(psp, /message\.type === 'performance'/)
  assert.match(psp, /stopSnapshot\(\)/, '销毁时注销快照')
}

/* ---------- 慢启动要看得出卡在下载还是启动 ---------- */
{
  const { createStartupProgressTrace } = await import('../src/emulator/startupProgressTrace.ts')
  let clock = 1_000
  const trace = createStartupProgressTrace(1_000, () => clock)
  assert.equal(trace.snapshot(), null, '没有进度就不出快照')
  assert.match(trace.phaseNote(), /还没有任何加载进度/)
  clock = 1_500; trace.accept({ phase: 'engine', ratio: 1 })
  assert.match(trace.phaseNote(), /仍在加载引擎/)
  clock = 2_000; trace.accept({ phase: 'rom', loaded: 0, total: 42 * 1048576 })
  clock = 22_000; trace.accept({ phase: 'rom', loaded: 16 * 1048576, total: 42 * 1048576 })
  assert.match(trace.phaseNote(), /仍在下载 ROM：16\.0MB\/42\.0MB，平均 6\.7Mbps/, '心灵之金现场：慢网上的大 ROM')
  assert.match(trace.snapshot(), /阶段 rom，ROM 16\.0MB\/42\.0MB，ROM 起于 1\.0s/)
  clock = 30_000; trace.accept({ phase: 'rom', loaded: 42 * 1048576, total: 42 * 1048576 })
  clock = 33_000
  assert.match(trace.phaseNote(), /下载已完成，正在启动，下载完已 3\.0 秒/)
  assert.match(trace.snapshot(), /ROM 完成于 29\.0s/)
  const disc = createStartupProgressTrace(0, () => clock)
  disc.accept({ phase: 'rom', loaded: 4 * 1048576, total: 600 * 1048576, streaming: true })
  assert.match(disc.phaseNote(), /流式读盘中/, '流式读盘不能说成「仍在下载」')

  const player = read('src/emulator/EmulatorPlayer.tsx')
  assert.match(player, /reportStartup\('slow_start', `等待 game_playable 已超过 20 秒\$\{progressTrace\.phaseNote\(\)\}`\)/)
  assert.match(player, /progressTrace\.accept\(next\)/)
  assert.equal(player.match(/stopProgressSnapshot\(\)/g)?.length, 2, '挂载失败与卸载都要注销快照')
  assert.match(read('worker/src/common.js'), /'Timing-Allow-Origin'\] = '\*'/, 'ROM 对象要让诊断包看得到传输字节')
}

/* ---------- 浏览器位数：32 位 Chrome 分配不出 WASM 内存（2026-11-11 Chrome 109 / Win7） ---------- */
{
  const { bitnessFromUserAgent } = await import('../src/emulator/browserBitness.ts')
  assert.equal(bitnessFromUserAgent('Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 Chrome/109.0.0.0'), '32', 'WOW64 = 64 位系统上的 32 位浏览器')
  assert.equal(bitnessFromUserAgent('Mozilla/5.0 (Windows NT 6.1) AppleWebKit/537.36 Chrome/109.0.0.0'), '32', '32 位 Windows')
  assert.equal(bitnessFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0'), null, 'UA 精简后写着 x64 不作数')
  assert.equal(bitnessFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), null)
  const env = (bits) => normalizeDiagnostics({ env: { mem: 8, bits } }).env.bits
  assert.equal(env('32'), '32')
  assert.equal(env('64'), '64')
  assert.equal(env('16; drop table'), null, '位数走白名单')
  assert.match(read('src/admin/diagnosticsReport.ts'), /位浏览器/)
  const ejs = read('src/emulator/adapters/emulatorjs.ts')
  assert.match(ejs, /void probeBrowserBitness\(\)/, '开局先发高熵查询')
  assert.match(ejs, /bits === '32' \? failLoad\(rt\.ejsOutOfMemory32bit, 'config'\)/, '32 位浏览器内存不足：换浏览器提示，不原地重试')
  for (const lang of ['zh-Hans', 'zh-Hant', 'en', 'es', 'de', 'it', 'fr', 'ja']) {
    assert.match(read(`src/locales/${lang}.ts`), /ejsOutOfMemory32bit: '/, `${lang} 有 32 位提示`)
  }
}

console.log('✔ 启动诊断包：脱敏与白名单、UA 粗粒度、错误归组、前端采集、复制给 AI、PSP 现场、接线')
process.exit(0)
