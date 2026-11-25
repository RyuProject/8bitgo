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
  classifyAutomation,
  classifyUserAgent,
  DIAGNOSTICS_RETENTION_DAYS,
  diagnoseStartupFailure,
  errorSignature,
  hasUsefulDiagnostics,
  needsAttention,
  normalizeDiagnostics,
  partitionNoise,
  scrub,
  shapeSample,
} from '../server/src/startup-diagnostics.js'
import { normalizeStartupEvent, sanitizeStartupDetail } from '../server/src/startup-metrics.js'
import { componentPath, errorHead, isReactUpdateLoop, stackFrames } from '../src/services/renderErrorText.ts'

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
  assert.equal(scrub('data:text/plain,private-payload file:///Users/player/private.rom'), 'data:[内联] file:[本地文件]', '内联与本地文件地址不进入现场')
  // 2026-11-16 诊断包 #761：Safari 调用栈 `vt@https://cn.8bitgo.com/...` 缩短后整段被当成邮箱，函数名和域名都丢了
  assert.equal(
    scrub('组件：Lazy@unknown:0:0 < vt@https://cn.8bitgo.com/_cn/assets/react-vendor-Igr6niNW.js:11:4269'),
    '组件：Lazy@unknown:0:0 < vt@cn.8bitgo.com/_cn/…/react-vendor-Igr6niNW.js:11:4269',
  )
  assert.equal(scrub('Mt@cn.8bitgo.com/_cn/…/react-vendor-Igr6niNW.js:11:7818'), 'Mt@cn.8bitgo.com/_cn/…/react-vendor-Igr6niNW.js:11:7818', '前端已缩短过的栈帧也不是邮箱')
  assert.equal(scrub('联系 a.b+c@mail.example.co.uk。或 x@y.com, 或 z@w.cn.'), '联系 [邮箱]。或 [邮箱], 或 [邮箱].', '真邮箱照样抹掉（含句末标点）')
  assert.equal(scrub('to: user@example.com: 发信失败'), 'to: [邮箱]: 发信失败')
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
  const summary = normalizeDiagnostics({
    capture: { level: 'summary', note: 'missing', ignored: 'drop me' },
    build: 'index-fake.js', reason: 'React error #185', env: { mem: 8, cores: 8 },
    attempt: { index: 9 }, logs: [{ m: 'must not be retained' }], resources: [{ n: 'secret.example/path' }],
  })
  assert.deepEqual(summary.capture, { level: 'summary', note: 'missing' })
  assert.equal(summary.env, null, '摘要不伪造详细环境')
  assert.equal(summary.build, '', '摘要不伪造部署版本')
  assert.deepEqual(summary.attempt, { index: 0, sinceStartMs: 0 }, '摘要不伪造开局序号')
  assert.equal(summary.logs.length, 0, '摘要不包含未收到的日志')
  assert.equal(summary.resources.length, 0, '摘要不包含未收到的网络请求')
  assert.equal(hasUsefulDiagnostics({}), false, '空对象不能冒充完整现场')
  assert.equal(hasUsefulDiagnostics({ build: 'index-current.js' }), false, '只有版本号不能冒充完整现场')
  assert.equal(hasUsefulDiagnostics({ env: { mem: 8 } }), true, '有实测设备信息时视为完整现场')
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
    ['Mozilla/5.0 (Linux; Android 12; NOH-AN00; HMSCore 6.13.0.302) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.196 HuaweiBrowser/15.0.4.312 Mobile Safari/537.36', 'Huawei Browser 15', 'Android 12', 'mobile'],
    ['Mozilla/5.0 (Linux; U; Android 12; zh-cn; 22081212C Build/SKQ1.220303.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/112.0.5615.136 Mobile Safari/537.36 XiaoMi/MiuiBrowser/18.1.170911', 'Mi Browser 18', 'Android 12', 'mobile'],
    ['Mozilla/5.0 (Linux; U; Android 12; zh-CN; V2172A Build/SP1A.210812.003) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.58 Quark/6.9.0.380 Mobile Safari/537.36', 'Quark 6', 'Android 12', 'mobile'],
    ['Mozilla/5.0 (Linux; Android 12; PFEM10 Build/SKQ1.211019.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36 aweme_290100', 'Android WebView 114', 'Android 12', 'mobile'],
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

  const genericMissing = diagnoseStartupFailure({ event: 'failed', platform: 'nes', detail: 'Missing files while opening content' })
  assert.notEqual(genericMissing.code, 'bios_romset', '非街机的通用 missing files 不能被判成街机 BIOS 故障')
  assert.equal(diagnoseStartupFailure({ event: 'failed', platform: 'arcade', detail: 'Missing files for this romset' }).code, 'bios_romset')
  const gbaBiosMissing = diagnoseStartupFailure({
    event: 'failed', runtime: 'iodinegba', platform: 'gba',
    detail: 'IodineGBA 启动需要 16 KiB GBA BIOS；请先在后台配置 GBA 平台 BIOS。',
  })
  assert.deepEqual(
    { code: gbaBiosMissing.code, phase: gbaBiosMissing.phase, confidence: gbaBiosMissing.confidence, signal: gbaBiosMissing.signals[0] },
    { code: 'bios_config', phase: 'platform_config', confidence: 'high', signal: 'error.platform_bios_config' },
    'IodineGBA 明确报告缺少 GBA BIOS 时应指向平台配置，不能归为未知或街机 BIOS 故障',
  )
  const oldUnknownGbaBiosSample = shapeSample({
    id: '4210', event: 'failed', runtime: 'iodinegba', platform: 'gba', payload: JSON.stringify({
      v: 1, capture: { level: 'full' }, reason: 'IodineGBA 启动需要 16 KiB GBA BIOS；请先在后台配置 GBA 平台 BIOS。',
      diagnosis: { code: 'unknown', label: '原因未能自动识别', phase: 'unknown', confidence: 'low', signals: ['no_specific_signal'] },
    }),
  })
  assert.equal(oldUnknownGbaBiosSample.diagnostics.diagnosis.code, 'bios_config',
    '读回旧现场时应把已有的 unknown 重算为新识别出的明确 BIOS 配置错误')
  assert.notEqual(diagnoseStartupFailure({ event: 'failed', runtime: 'emulatorjs', platform: 'gba', detail: 'GBA ROM failed to load' }).code, 'bios_config',
    '普通 GBA ROM 故障不能被误判成平台 BIOS 配置错误')
  assert.notEqual(diagnoseStartupFailure({ event: 'failed', platform: 'gba', detail: 'Failed to load ROM from blob URL' }).code, 'storage',
    '普通 Blob URL 加载失败不能直接推断为浏览器存储故障')
  assert.equal(diagnoseStartupFailure({ event: 'failed', platform: 'gba', detail: 'NotReadableError while reading Blob' }).code, 'storage')
  assert.deepEqual(
    { code: diagnoseStartupFailure({ event: 'failed', runtime: 'page', detail: 'TypeError: Importing a module script failed.' }).code,
      signal: diagnoseStartupFailure({ event: 'failed', runtime: 'page', detail: 'TypeError: Importing a module script failed.' }).signals[0] },
    { code: 'page_asset', signal: 'error.lazy_module' },
    '懒加载 chunk 的导入失败不能被粗略归成网络错误',
  )
  assert.deepEqual(
    { code: diagnoseStartupFailure({ event: 'failed', runtime: 'page', detail: 'Error: Unable to preload CSS for cn.8bitgo.com/_cn/assets/GameDetailPage-C2JSNwpA.css' }).code,
      signal: diagnoseStartupFailure({ event: 'failed', runtime: 'page', detail: 'Error: Unable to preload CSS for cn.8bitgo.com/_cn/assets/GameDetailPage-C2JSNwpA.css' }).signals[0],
      confidence: diagnoseStartupFailure({ event: 'failed', runtime: 'page', detail: 'Error: Unable to preload CSS for cn.8bitgo.com/_cn/assets/GameDetailPage-C2JSNwpA.css' }).confidence },
    { code: 'page_asset', signal: 'error.lazy_css', confidence: 'high' },
    'Vite 懒加载 CSS 错误要直接归为页面样式资源，不能被无关的历史 HTTP 400 抢走',
  )
  assert.equal(diagnoseStartupFailure({
    event: 'failed', runtime: 'page', diagnostics: { resources: [{ n: '8bitgo.com/assets/…/GameDetailPage.js', i: 'script', at: 0, st: 404 }] },
  }).code, 'page_asset', '脚本本身的 HTTP 失败按页面资源定位')
  assert.equal(diagnoseStartupFailure({
    event: 'failed', runtime: 'page', diagnostics: { resources: [{ n: 'stats.example/request', i: 'fetch', at: 0, st: 404 }] },
  }).confidence, 'medium', '无法确定关联的普通资源错误要显示中把握度')
  const jsdosDependencyFailure = diagnoseStartupFailure({
    event: 'failed', runtime: 'jsdos', platform: 'dos',
    detail: 'DOSBox 运行出错：DOSBox did not start',
    diagnostics: {
      logs: [
        { t: 4000, s: 'download', l: 'info', m: 'ROM 首段 262072 字节 / 3010ms： cn-assets.8bitgo.com/roms/…/[ROM].zh-Hant.zip.8bg' },
        { t: 50_500, s: 'stage', l: 'info', m: '游戏包下载完成' },
        { t: 58_900, s: 'page', l: 'error', m: 'Unable to init emulators.js ReferenceError: emulators is not defined | at cn.8bitgo.com/_cn/…/js-dos.js:21:73612' },
        { t: 65_600, s: 'page', l: 'error', m: 'TypeError: Failed to fetch | at Mi (cn.8bitgo.com/_cn/…/js-dos.js:21:74374)' },
      ],
      resources: [
        { n: 'cn-assets.8bitgo.com/roms/…/[ROM].zh-Hant.zip.8bg', i: 'fetch', at: 41_900, d: 8700, st: 206 },
        { n: 'cn.8bitgo.com/_cn/…/emulators.js', i: 'script', at: 50_600, d: 15_000, st: 0 },
      ],
    },
  })
  assert.deepEqual(
    { code: jsdosDependencyFailure.code, signal: jsdosDependencyFailure.signals[0], phase: jsdosDependencyFailure.phase, confidence: jsdosDependencyFailure.confidence },
    { code: 'engine_asset', signal: 'error.jsdos_emulators_asset', phase: 'engine_asset', confidence: 'high' },
    'ROM 已下载后 emulators.js 初始化失败，应优先于残留 ROM URL 归为 js-dos 依赖故障（#1518）',
  )
  assert.notEqual(diagnoseStartupFailure({
    event: 'failed', runtime: 'emulatorjs', platform: 'nes', detail: 'ReferenceError: emulators is not defined',
  }).code, 'engine_asset', 'js-dos 专属的 emulators.js 规则不能误判其他运行时')
  assert.equal(diagnoseStartupFailure({
    event: 'failed', runtime: 'page', diagnostics: { resources: [{ n: 'stats.example/widget.js', i: 'script', at: 0, st: 404 }] },
  }).code, 'network_http', '近期第三方脚本失败不能被升级成本站页面资源故障')
  const thirdPartyTrackerDuringRomDownload = diagnoseStartupFailure({
    event: 'slow_start', runtime: 'emulatorjs', platform: 'arcade', elapsedMs: 20_088,
    detail: '等待 game_playable 已超过 20 秒',
    diagnostics: {
      logs: [
        { t: 17_488, s: 'resource', l: 'error', m: 'script 加载失败 lf1-cdn-tos.bytegoofy.com/goofy/…/push.js' },
        { t: 20_088, s: 'snapshot', l: 'info', m: '加载进度：阶段 rom，ROM 22.3MB/27.4MB，ROM 起于 1.2s，平均 10.1Mbps，最后进度 19.8s' },
      ],
      resources: [{ n: 'lf1-cdn-tos.bytegoofy.com/goofy/…/push.js', i: 'script', at: 17_488, st: 0 }],
    },
  })
  assert.deepEqual(
    { code: thirdPartyTrackerDuringRomDownload.code, signal: thirdPartyTrackerDuringRomDownload.signals[0] },
    { code: 'rom_download', signal: 'progress.rom_downloading' },
    '第三方统计脚本加载失败不能盖过仍在正常下载的 ROM（生产诊断 #3978）',
  )
  const previousPageAssetDuringRomDownload = diagnoseStartupFailure({
    event: 'slow_start', runtime: 'emulatorjs', elapsedMs: 20_472,
    detail: '等待 game_playable 已超过 20 秒',
    diagnostics: {
      logs: [
        { t: -3149, s: 'resource', l: 'error', m: 'link 加载失败 8bitgo.com/assets/…/index-ppM98XEK.js' },
        { t: 20_472, s: 'snapshot', l: 'info', m: '加载进度：阶段 rom，ROM 41.4MB/71.7MB，ROM 起于 0.5s，平均 17.4Mbps，最后进度 20.4s' },
      ],
      resources: [{ n: '8bitgo.com/assets/…/index-ppM98XEK.js', i: 'link', at: -3149, st: 0 }],
    },
  })
  assert.equal(previousPageAssetDuringRomDownload.signals[0], 'progress.rom_downloading',
    '开局前的旧页面资源失败不能被归为本次页面资源故障（生产诊断 #3018）')
  assert.equal(diagnoseStartupFailure({
    event: 'slow_start', runtime: 'emulatorjs', elapsedMs: 20_000,
    diagnostics: { logs: [{ t: 1000, s: 'resource', l: 'error', m: 'link 加载失败 cn.8bitgo.com/_cn/assets/GameDetailPage-C2JSNwpA.css' }] },
  }).code, 'page_asset', '开局期间本站 JS/CSS 加载失败仍应定位为页面资源故障')
  const reactUpdateLoop = diagnoseStartupFailure({
    event: 'failed', runtime: 'page', platform: 'nes',
    detail: 'Error: Minified React error #185; at fi (react-vendor.js:8:27488)',
    diagnostics: { resources: [{ n: 'u.clarity.ms/collect', i: 'xmlhttprequest', at: -459_500, st: 400 }] },
  })
  assert.deepEqual(
    { code: reactUpdateLoop.code, signal: reactUpdateLoop.signals[0], phase: reactUpdateLoop.phase, confidence: reactUpdateLoop.confidence },
    { code: 'react_update_loop', signal: 'error.react_update_loop', phase: 'page_render', confidence: 'high' },
    'React #185 的直接异常优先于整页缓冲里过期的第三方请求错误（#1533）',
  )
  assert.notEqual(diagnoseStartupFailure({
    event: 'failed', runtime: 'page', diagnostics: { resources: [{ n: 'u.clarity.ms/collect', i: 'xmlhttprequest', at: -459_500, st: 400 }] },
  }).code, 'network_http', '数分钟前的第三方 HTTP 400 不归到当前开局')
  const ruffleInitWithRomRequest = {
    event: 'failed', runtime: 'ruffle', platform: 'flash',
    detail: 'Flash 内容载入失败：Ruffle 未正确初始化',
    diagnostics: {
      logs: [
        { t: 1360, s: 'download', l: 'info', m: 'ROM 首段 282606 字节 / 919ms： cn-assets.8bitgo.com/roms/…/[ROM].en.swf.8bg' },
        { t: 160, s: 'snapshot', l: 'info', m: 'Ruffle 现场：卡在「ruffle.js 已加载」，线路 同源，SWF 未到，核心预热 未开始/失败' },
      ],
      resources: [{ n: 'cn-assets.8bitgo.com/roms/…/[ROM].en.swf.8bg', i: 'fetch', at: 76, d: 4950, st: 0, sz: 0 }],
    },
  }
  const ruffleInit = diagnoseStartupFailure(ruffleInitWithRomRequest)
  assert.deepEqual(
    { code: ruffleInit.code, label: ruffleInit.label, signal: ruffleInit.signals[0] },
    { code: 'engine_asset', label: 'Ruffle 运行时初始化失败', signal: 'error.ruffle_init' },
    'Ruffle API 未初始化时，诊断包里的并行 ROM URL 不能把错误误归为 ROM 下载失败（#2887 / #2889）',
  )
  assert.match(errorSignature({ ...ruffleInitWithRomRequest, diagnostics: { ...ruffleInitWithRomRequest.diagnostics, diagnosis: ruffleInit } }).text,
    /Ruffle 运行时初始化失败/, '错误诊断分组文案应与现场原始错误一致')
  assert.notEqual(diagnoseStartupFailure({
    event: 'failed', runtime: 'ruffle', platform: 'flash',
    diagnostics: { resources: [{ n: 'cn-assets.8bitgo.com/roms/…/[ROM].en.swf.8bg', i: 'fetch', at: 76, d: 4950, st: 0, sz: 0 }] },
  }).code, 'rom_download', '只有 ROM 资源 URL、没有失败信号时不能归为 ROM 下载失败')
  assert.equal(diagnoseStartupFailure({
    event: 'failed', runtime: 'ruffle', platform: 'flash', detail: 'ROM 下载失败：无法读取完整文件',
  }).code, 'rom_download', '明确的 ROM 下载错误仍应归为 ROM 故障')
  assert.equal(diagnoseStartupFailure({
    event: 'failed', runtime: 'page', diagnostics: { resources: [{ n: '8bitgo.com/api/events', i: 'fetch', at: -1200, st: 400 }] },
  }).code, 'network_http', '开局附近的本站 HTTP 错误仍可识别')
  const trap = diagnoseStartupFailure({
    event: 'failed', platform: 'gba', detail: 'RuntimeError: table index is out of bounds',
    diagnostics: { resources: [{ n: '8bitgo.com/emulatorjs/…/mgba-wasm.data' }] },
  })
  assert.deepEqual(
    { code: trap.code, confidence: trap.confidence, artifact: trap.artifact },
    { code: 'runtime_trap', confidence: 'medium', artifact: 'mgba' },
    '运行时陷阱保留核心线索，但不把 ROM 写成已确认根因',
  )
  const goldenSunLateAbort = diagnoseStartupFailure({
    event: 'failed', runtime: 'emulatorjs', platform: 'gba', elapsedMs: 913_472,
    detail: 'RuntimeError: Aborted(undefined). Build with -sASSERTIONS for more info.',
    diagnostics: {
      attempt: { sinceStartMs: 913_472 },
      timeline: [
        { t: 0, e: 'start_click' },
        { t: 96_448, e: 'game_playable' },
        { t: 96_450, e: 'first_frame' },
        { t: 913_472, e: 'failed' },
      ],
      logs: [
        { t: 94_674, s: 'stage', l: 'info', m: '下载游戏核心' },
        { t: 94_716, s: 'ejs', l: 'log', m: '[EJS Core] Downloading core: mgba-legacy-wasm.data' },
        { t: 913_472, s: 'adapter', l: 'warn', m: '[core-crash] mgba: RuntimeError: Aborted(undefined)' },
      ],
    },
  })
  assert.deepEqual(
    { code: goldenSunLateAbort.code, phase: goldenSunLateAbort.phase, signal: goldenSunLateAbort.signals[0], artifact: goldenSunLateAbort.artifact },
    { code: 'wasm_runtime', phase: 'runtime', signal: 'error.wasm_runtime', artifact: 'mgba-legacy' },
    '首帧后发生的 WASM 崩溃不能被过期的「下载游戏核心」阶段误归为核心下载失败',
  )
  assert.equal(diagnoseStartupFailure({
    event: 'failed', runtime: 'emulatorjs', platform: 'gba', detail: 'Error downloading core (mgba-legacy-wasm.data)',
    diagnostics: { logs: [{ t: 100, s: 'stage', l: 'info', m: '下载游戏核心' }] },
  }).code, 'core_download', '明确的核心下载失败仍保持原分类')
  assert.equal(diagnoseStartupFailure({
    event: 'failed', runtime: 'emulatorjs', platform: 'gba', detail: 'Error loading core (mgba-legacy-wasm.data)',
  }).code, 'core_download', '明确的核心加载失败仍保持原分类')
  const trapOtherCore = errorSignature({
    event: 'failed', runtime: 'emulatorjs', platform: 'gba', detail: 'RuntimeError: table index is out of bounds',
    diagnostics: { resources: [{ n: '8bitgo.com/emulatorjs/…/melonds-wasm.data' }] },
  })
  const trapMgbaCore = errorSignature({
    event: 'failed', runtime: 'emulatorjs', platform: 'gba', detail: 'RuntimeError: table index is out of bounds',
    diagnostics: { resources: [{ n: '8bitgo.com/emulatorjs/…/mgba-wasm.data' }] },
  })
  assert.notEqual(trapOtherCore.signature, trapMgbaCore.signature, '不同核心的运行时陷阱不能合成一组')

  // 慢启动按进度快照区分「还在动」与「停住」（2026-11-18 诊断包 #1155 / #1156 都被误标成停滞）
  const slow = (snapshot, extra = []) => ({
    event: 'slow_start',
    runtime: 'jsdos',
    platform: 'dos',
    detail: '等待 game_playable 已超过 20 秒（仍在下载 ROM：71.6MB/108.9MB，平均 31.1Mbps）',
    diagnostics: { logs: [...extra, { t: 20_000, s: 'snapshot', l: 'info', m: snapshot }] },
  })
  const mdkLive = diagnoseStartupFailure(slow('加载进度：阶段 rom，ROM 71.6MB/108.9MB，ROM 起于 0.6s，平均 31.1Mbps，最后进度 19.9s', [
    { t: 1000, s: 'download', l: 'info', m: 'ROM 首段 409582 字节 / 425ms（7.7 Mbps）： download.8bitgo.com/roms/…/[ROM].en.zip.8bg' },
  ]))
  assert.deepEqual(
    { code: mdkLive.code, signal: mdkLive.signals[0], artifact: mdkLive.artifact, confidence: mdkLive.confidence },
    { code: 'rom_download', signal: 'progress.rom_downloading', artifact: 'rom-64-256mb', confidence: 'high' },
    '上报前 0.1 秒还在以 31 Mbps 下载的 109MB 整包不是停滞（#1155《MDK》）',
  )
  assert.match(mdkLive.label, /未停滞/)
  const mdkStalled = diagnoseStartupFailure(slow('加载进度：阶段 rom，ROM 31.0MB/108.9MB，ROM 起于 0.6s，平均 12.4Mbps，最后进度 9.0s'))
  assert.deepEqual({ code: mdkStalled.code, signal: mdkStalled.signals[0] }, { code: 'rom_download', signal: 'stage.rom' },
    '进度 11 秒没动仍然按停滞归类')
  assert.match(mdkStalled.label, /停滞/)
  assert.doesNotMatch(mdkStalled.label, /未停滞/)
  assert.equal(diagnoseStartupFailure(slow('加载进度：阶段 rom，ROM 42.0MB（流式），ROM 起于 0.6s，平均 12.4Mbps，最后进度 19.9s')).signals[0],
    'stage.rom', '流式读盘没有「下完」这回事，不套用正常下载的判断')
  assert.equal(diagnoseStartupFailure({ ...slow('加载进度：阶段 rom，ROM 71.6MB/108.9MB，ROM 起于 0.6s，平均 31.1Mbps，最后进度 19.9s'), event: 'timeout' }).signals[0],
    'stage.rom', '超时 / 失败有自己的原文，进度快照不能把它们改判成「没停」')
  assert.notEqual(
    errorSignature(slow('加载进度：阶段 rom，ROM 71.6MB/108.9MB，ROM 起于 0.6s，平均 31.1Mbps，最后进度 19.9s')).signature,
    errorSignature(slow('加载进度：阶段 rom，ROM 31.0MB/108.9MB，ROM 起于 0.6s，平均 12.4Mbps，最后进度 9.0s')).signature,
    '还在下载和真停住不能合成一组',
  )
  assert.notEqual(
    errorSignature(slow('加载进度：阶段 rom，ROM 71.6MB/108.9MB，ROM 起于 0.6s，平均 31.1Mbps，最后进度 19.9s')).signature,
    errorSignature(slow('加载进度：阶段 rom，ROM 3.1MB/6.2MB，ROM 起于 0.6s，平均 1.3Mbps，最后进度 19.9s')).signature,
    '大包和小包慢网按体积分组',
  )

  const xiyou = (snapshot) => diagnoseStartupFailure({
    event: 'slow_start', runtime: 'emulatorjs', platform: 'arcade', detail: '等待 game_playable 已超过 20 秒（仍在加载资源）',
    diagnostics: {
      logs: [
        { t: 19_700, s: 'adapter', l: 'warn', m: '[netplay] socket.io 脚本加载失败：/socket.io/socket.io.js' },
        { t: 19_900, s: 'ejs', l: 'log', m: '[EJS Core] Downloading core: fbneo-legacy-wasm.data' },
        { t: 20_000, s: 'snapshot', l: 'info', m: snapshot },
      ],
    },
  })
  const xiyouDominated = xiyou('加载进度：阶段 assets，ROM 20.9MB/20.9MB，ROM 起于 0.3s，ROM 完成于 19.7s，平均 9.0Mbps，最后进度 20.0s')
  assert.deepEqual(
    { code: xiyouDominated.code, signal: xiyouDominated.signals[0], artifact: xiyouDominated.artifact },
    { code: 'rom_download', signal: 'progress.rom_dominated', artifact: 'rom-16-64mb' },
    'ROM 下了 19.4 秒、assets 才开始 0.3 秒，慢在 ROM 不在依赖资源（#1156《西游释厄传》）',
  )
  const assetsReallySlow = xiyou('加载进度：阶段 assets，ROM 20.9MB/20.9MB，ROM 起于 0.3s，ROM 完成于 5.0s，平均 36.0Mbps，最后进度 5.2s')
  assert.deepEqual({ code: assetsReallySlow.code, signal: assetsReallySlow.signals[0] }, { code: 'engine_assets', signal: 'stage.engine_assets' },
    'ROM 5 秒就下完、之后 15 秒卡在资源阶段，仍按依赖资源停滞归类')
  const assetsStillLoading = xiyou('加载进度：阶段 assets，ROM 20.9MB/20.9MB，ROM 起于 0.3s，ROM 完成于 5.0s，平均 36.0Mbps，最后进度 19.9s')
  assert.deepEqual({ code: assetsStillLoading.code, signal: assetsStillLoading.signals[0] }, { code: 'engine_assets', signal: 'progress.assets_loading' },
    '引擎依赖资源仍有近期进度时按加载中保留现场，不归成停滞')
  assert.equal(xiyou('加载进度：阶段 assets，ROM 20.9MB/20.9MB（缓存），ROM 起于 0.3s，ROM 完成于 0.4s，最后进度 0.4s').signals[0],
    'stage.engine_assets', 'ROM 命中缓存时慢在别处')

  const jsdosAssetProgress = (lastProgress) => diagnoseStartupFailure({
    event: 'slow_start', runtime: 'jsdos', platform: 'dos', detail: '等待 game_playable 已超过 20 秒（仍在加载资源）',
    diagnostics: { logs: [{ t: 20_000, s: 'snapshot', l: 'info', m: `加载进度：阶段 assets，ROM 44.4MB/44.4MB，ROM 起于 1.1s，ROM 完成于 3.3s，最后进度 ${lastProgress}s` }] },
  })
  const jsdosAssetsLive = jsdosAssetProgress('18.4')
  assert.deepEqual(
    { code: jsdosAssetsLive.code, signal: jsdosAssetsLive.signals[0], artifact: jsdosAssetsLive.artifact, confidence: jsdosAssetsLive.confidence },
    { code: 'engine_assets', signal: 'progress.assets_loading', artifact: 'active-progress', confidence: 'high' },
    'JSDOS 系统盘 / 游戏资源在上报前仍有进度时不能误诊为依赖停滞（#4170）',
  )
  assert.match(jsdosAssetsLive.label, /未停滞/)
  assert.equal(needsAttention('slow_start', { diagnosis: jsdosAssetsLive }), false,
    '资源仍有进度的慢启动只留诊断现场，不参与故障聚集报警')
  const jsdosAssetsStalled = jsdosAssetProgress('5.2')
  assert.deepEqual(
    { code: jsdosAssetsStalled.code, signal: jsdosAssetsStalled.signals[0] },
    { code: 'engine_assets', signal: 'stage.engine_assets' },
    '引擎 / 资源阶段 14 秒没有新进度仍保留停滞诊断',
  )
  assert.notEqual(
    errorSignature({ event: 'slow_start', runtime: 'jsdos', platform: 'dos', detail: '等待 game_playable 已超过 20 秒（仍在加载资源）', diagnostics: { logs: [{ t: 20_000, s: 'snapshot', l: 'info', m: '加载进度：阶段 assets，ROM 44.4MB/44.4MB，ROM 起于 1.1s，ROM 完成于 3.3s，最后进度 18.4s' }] } }).signature,
    errorSignature({ event: 'slow_start', runtime: 'jsdos', platform: 'dos', detail: '等待 game_playable 已超过 20 秒（仍在加载资源）', diagnostics: { logs: [{ t: 20_000, s: 'snapshot', l: 'info', m: '加载进度：阶段 assets，ROM 44.4MB/44.4MB，ROM 起于 1.1s，ROM 完成于 3.3s，最后进度 5.2s' }] } }).signature,
    '资源正在推进与资源真正停滞不能合成一个诊断组',
  )

  const lateRomSnapshot = diagnoseStartupFailure({
    event: 'slow_start', runtime: 'emulatorjs', platform: 'arcade', elapsedMs: 20_207,
    detail: '等待 game_playable 已超过 20 秒（下载已完成，正在启动，下载完已 1.2 秒）',
    diagnostics: {
      timeline: [{ t: 0, e: 'start_click' }, { t: 19_033, e: 'download_complete' }, { t: 20_206, e: 'slow_start' }],
      logs: [
        { t: 6, s: 'stage', l: 'info', m: 'emulatorjs 运行时模块加载完成' },
        { t: 632, s: 'download', l: 'warn', m: '首片期间的提前分片失败，后续会按常规重试： TypeError: Failed to fetch' },
        { t: 20_207, s: 'snapshot', l: 'info', m: '加载进度：阶段 rom，ROM 38.5MB/38.5MB，ROM 起于 0.1s，ROM 完成于 19.0s，平均 17.0Mbps，最后进度 20.2s' },
      ],
      resources: [{ at: 632, st: 400, i: 'xmlhttprequest', n: 'u.clarity.ms/collect' }],
    },
  })
  assert.deepEqual(
    { code: lateRomSnapshot.code, signal: lateRomSnapshot.signals[0], artifact: lateRomSnapshot.artifact },
    { code: 'rom_download', signal: 'progress.rom_dominated', artifact: 'rom-16-64mb' },
    'ROM 已下载、占去大半启动时间时，残留的 rom 阶段与下载前线路告警不能说成停滞（#2761）',
  )
  const staleRomStage = diagnoseStartupFailure({
    event: 'slow_start', runtime: 'emulatorjs', platform: 'arcade', elapsedMs: 20_207,
    detail: '等待 game_playable 已超过 20 秒（下载已完成，正在启动）',
    diagnostics: {
      timeline: [{ t: 0, e: 'start_click' }, { t: 19_033, e: 'download_complete' }],
      logs: [{ t: 6, s: 'stage', l: 'info', m: '加载进度：阶段 rom' }],
    },
  })
  assert.deepEqual(
    { code: staleRomStage.code, signal: staleRomStage.signals[0], phase: staleRomStage.phase },
    { code: 'timeout', signal: 'event.timeout', phase: 'startup' },
    '有下载完成漏斗事件时，没更新的 ROM 阶段只能归到后续启动等待',
  )
  const html5DocumentLoad = diagnoseStartupFailure({
    event: 'slow_start', runtime: 'html5', platform: 'html5', elapsedMs: 20_000,
    detail: '网页游戏页面已加载，但尚未确认可玩',
    diagnostics: {
      timeline: [{ t: 0, e: 'start_click' }, { t: 1_000, e: 'download_complete' }],
      logs: [{ t: 1_001, s: 'stage', l: 'info', m: '加载进度：阶段 starting' }],
    },
  })
  assert.deepEqual(
    { code: html5DocumentLoad.code, signal: html5DocumentLoad.signals[0] },
    { code: 'timeout', signal: 'stage.html5_starting' },
    'HTML5 的 download_complete 只表示 iframe 文档已加载，仍需按网页游戏启动阶段判断',
  )
  const html5EntryPending = diagnoseStartupFailure({
    event: 'timeout', runtime: 'html5', platform: 'html5', elapsedMs: 120_004,
    detail: '连续 120 秒没有启动进度或可玩信号',
    diagnostics: {
      timeline: [{ t: 0, e: 'start_click' }, { t: 120_004, e: 'timeout' }],
      logs: [{ t: 2, s: 'stage', l: 'info', m: 'html5 运行时模块加载完成' },
        { t: 120_004, s: 'snapshot', l: 'info', m: '加载进度：阶段 starting，最后进度 0.0s' }],
    },
  })
  assert.deepEqual(
    { code: html5EntryPending.code, label: html5EntryPending.label, signal: html5EntryPending.signals[0] },
    { code: 'timeout', label: 'HTML5 游戏入口页面未确认加载', signal: 'stage.html5_entry_pending' },
    '没有 iframe_loaded / download_complete 的现场不能声称游戏页面已加载（#4154）',
  )
  const unknownRuntimeCompletion = diagnoseStartupFailure({
    event: 'slow_start', platform: 'arcade', elapsedMs: 20_000,
    detail: '等待游戏可玩状态超时',
    diagnostics: {
      timeline: [{ t: 0, e: 'start_click' }, { t: 19_000, e: 'download_complete' }],
      logs: [{ t: 1_000, s: 'stage', l: 'info', m: '加载进度：阶段 rom' }],
    },
  })
  assert.deepEqual(
    { code: unknownRuntimeCompletion.code, signal: unknownRuntimeCompletion.signals[0] },
    { code: 'rom_download', signal: 'stage.rom' },
    '旧诊断包缺 runtime 时，不把含义不明的 download_complete 当作下载完成证据',
  )
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
  const originalWarn = console.warn
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
  assert.equal(hub.scrubDiagnosticText('peer 203.0.113.9 mail a.b+c@example.co.uk'), 'peer [IP] mail [邮箱]', '浏览器上报前先去掉 IP 与邮箱')
  assert.equal(hub.scrubDiagnosticText('fn@cn.8bitgo.com/_cn/assets/chunk.js:11:42'), 'fn@cn.8bitgo.com/_cn/assets/chunk.js:11:42', '栈帧邮箱样式不能吞掉资源名')
  assert.ok(JSON.stringify(bundle).length <= 24_000)
  assert.equal(hub.collectStartupDiagnostics('unknown-attempt'), null, '没有这一局的记录就不发')
  assert.equal(hub.shortenUrl('data:text/plain,private-payload'), 'data:[内联]')
  assert.equal(hub.shortenUrl('file:///Users/player/private.rom'), 'file:[本地文件]')
  const pageStarted = Date.now() - 1000
  define('performance', {
    timeOrigin: pageStarted,
    getEntriesByType: () => [
      ...Array.from({ length: 40 }, (_, i) => ({
        name: `https://assets.8bitgo.com/assets/large-${i}.data`, initiatorType: 'fetch',
        startTime: 990, duration: 900, transferSize: 600_000, decodedBodySize: 1_000_000,
        responseStatus: 200, nextHopProtocol: 'h2',
      })),
      { name: 'https://download.8bitgo.com/roms/nes/private.nes.8bg', initiatorType: 'fetch',
        startTime: 995, duration: 25, transferSize: 200, decodedBodySize: 0,
        responseStatus: 404, nextHopProtocol: 'h2' },
      { name: 'https://203.0.113.9/private/a.b+c@example.co.uk', initiatorType: 'fetch',
        startTime: 996, duration: 250, transferSize: 0, decodedBodySize: 0,
        responseStatus: 0, nextHopProtocol: 'h2' },
    ],
  })
  const withFailedResource = hub.collectStartupDiagnostics('attempt-0001')
  assert.ok(withFailedResource.resources.some((row) => row.st === 404 && row.n.includes('[ROM]')),
    '大量慢资源不能把快速失败请求挤出诊断包')
  assert.doesNotMatch(JSON.stringify(withFailedResource.resources), /203\.0\.113\.9|a\.b\+c@example\.co\.uk/,
    '资源请求在浏览器本地就完成 IP / 邮箱脱敏')

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

  let observerCount = 0
  let disconnectCount = 0
  let bufferListenerAdds = 0
  let bufferListenerRemoves = 0
  let bufferListener
  let clearTimingCalls = 0
  const bufferSizes = []
  const frameObservers = []
  class FakePerformanceObserver {
    constructor(callback) { observerCount += 1; this.callback = callback; frameObservers.push(this) }
    observe() {}
    disconnect() { disconnectCount += 1 }
  }
  const framePerf = {
    timeOrigin: 0,
    setResourceTimingBufferSize(size) { bufferSizes.push(size) },
    getEntriesByType() { return [] },
    addEventListener(_type, listener) { bufferListenerAdds += 1; bufferListener = listener },
    removeEventListener() { bufferListenerRemoves += 1 },
    clearResourceTimings() { clearTimingCalls += 1 },
  }
  const frameWin = { performance: framePerf, PerformanceObserver: FakePerformanceObserver }
  const stopFrameA = hub.watchFramePerformance(frameWin)
  const stopFrameB = hub.watchFramePerformance(frameWin)
  assert.equal(observerCount, 1, '同一 iframe 的重复登记共用一个 PerformanceObserver')
  frameObservers[0].callback({ getEntries: () => [{
    name: 'https://cdn.example/core.data', initiatorType: 'fetch', startTime: 1, duration: 900,
    transferSize: 600_000, decodedBodySize: 600_000, responseStatus: 200, nextHopProtocol: 'h2',
  }] })
  assert.equal(frameWin.__8bitgoResourceCount, 1, 'iframe 观察器提供单调递增的请求数')
  bufferListener()
  assert.equal(clearTimingCalls, 0, '诊断缓冲区扩容时不清除 Resource Timing 历史')
  assert.deepEqual(bufferSizes, [1000, 2000], '缓冲区写满后扩容并保留已有记录')
  stopFrameA()
  stopFrameA()
  assert.equal(disconnectCount, 0, '还有登记方使用时不能提前断开观察器')
  stopFrameB()
  assert.equal(disconnectCount, 1, '最后一个登记方退出时断开观察器')
  assert.equal(bufferListenerAdds, 1)
  assert.equal(bufferListenerRemoves, 1, 'iframe 拆除时移除缓冲区监听')
  hub.resetStartupDiagnosticsForTest()
  assert.equal(console.warn, originalWarn, '测试重置会还原全局 console 钩子')
}

/* ---------- 「复制给 AI」 ---------- */
{
  const { diagnosisSignalLabel, formatGroupForAi, formatSample } = await import('../src/admin/diagnosticsReport.ts')
  assert.equal(diagnosisSignalLabel('stage.html5_entry_pending'), 'HTML5 游戏入口页尚未确认加载', '后台与复制给 AI 都要显示新分类依据的中文说明')
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
  const summaryMd = formatSample({
    ...sample,
    diagnostics: normalizeDiagnostics({ capture: { level: 'summary', note: 'missing' }, reason: 'React error #185' }),
  })
  assert.match(summaryMd, /现场级别：摘要/)
  assert.match(summaryMd, /浏览器日志、网络请求和详细环境未收到/)
  assert.doesNotMatch(summaryMd, /本次访问第|内存 8GB|index-Xy12AB/)
}

/* ---------- 接线 ---------- */
{
  const funnel = read('src/services/startupFunnel.ts')
  assert.match(funnel, /DIAGNOSTIC_EVENTS = new Set<StartupEventName>\(\['failed', 'timeout', 'slow_start', 'recovered'\]\)/)
  assert.match(funnel, /collectStartupDiagnostics\(payload\.attemptId, payload\.detail, \{\s*resourcesSincePageStart: payload\.runtime === 'page',/, '页面崩溃带上页面打开以来的资源请求（诊断包 #761 的资源列表是空的）')
  const games = read('server/src/routes/games.js')
  assert.match(games, /if \(result\.recorded && DIAGNOSTIC_EVENTS\.has\(result\.event\.event\)\)/, '首次漏斗事件总是进入诊断保存流程')
  // 诊断包一份最多 32KB，必须有自己的闸，不能只靠漏斗那道每分钟 12000 的总量
  assert.match(games, /takeAnonymous\(req, 'startup-diagnostics', \{ perIp: 6, global: 120 \}\)\.ok/)
  assert.match(games, /startup-diagnostic-summary', \{ perIp: 12, global: 240 \}/, '缺少完整现场时仍有更严格的摘要限流兜底')
  assert.match(games, /save_failed/, '完整现场写入失败时摘要需保留真实原因标记')
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
  assert.match(ejs, /const beat = \(\) => \{[\s\S]{0,240}options\.onStartupActivity\?\.\(\)/,
    'EmulatorJS 活动同步给播放器外层启动看门狗')
  assert.match(read('src/emulator/EmulatorPlayer.tsx'), /onStartupActivity: \(\) => \{[\s\S]{0,100}noteStartupActivity\(\)/,
    '播放器收到引擎活动后刷新启动看门狗')
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

/* ---------- 已自动恢复 / 自动化客户端 / 真实失败分开（2026-11-19 #1285 / #1368 / #1393 / #1201） ---------- */
{
  const LINUX_CHROME_150 = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
  const lazyReason = 'TypeError: Failed to fetch dynamically imported module: https://8bitgo.com/assets/GameDetailPage-AbCd1234.js'
  // #1393 / #1368 / #1285 与 #917 / #1108 的同一画像：90 核、32GB、1440x900、zh-CN、3G、上报时页面在后台
  const crawlerEnv = { mem: 32, cores: 90, net: { type: '3g', downlink: 0.4, rtt: 350, saveData: false }, screen: '1440x900@1', touch: 0, lang: 'zh-CN', coi: false, sab: true, online: true, hiddenMs: 18_000, visible: false }
  const bundle = (env, extra = {}) => normalizeDiagnostics({ build: 'index-JjUktQWI.js', reason: lazyReason, env, attempt: { index: 1, sinceStartMs: 1 }, timeline: [], logs: [], resources: [], ...extra })
  const ua = classifyUserAgent(LINUX_CHROME_150)
  assert.deepEqual(ua, { browser: 'Chrome 150', os: 'Linux', device: 'desktop' })

  const crawler = bundle(crawlerEnv)
  assert.deepEqual(classifyAutomation(crawler, { userAgent: LINUX_CHROME_150, device: ua.device }), { cohort: 'suspect', signals: ['automation.server_cpu'] }, '桌面 90 核 = 服务器 CPU，疑似自动化')
  assert.deepEqual(classifyAutomation(bundle({ ...crawlerEnv, auto: ['webdriver'] }), { userAgent: LINUX_CHROME_150, device: 'desktop' }).cohort, 'bot', 'navigator.webdriver 为 true 就是自动化')
  assert.equal(classifyAutomation(bundle({ ...crawlerEnv, cores: 8 }), { userAgent: LINUX_CHROME_150.replace('Chrome/', 'HeadlessChrome/'), device: 'desktop' }).cohort, 'bot', '无头 Chrome 的 UA')
  assert.equal(classifyAutomation(bundle({ ...crawlerEnv, cores: 8 }), { userAgent: 'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse', device: 'mobile' }).cohort, 'bot', 'PageSpeed / Lighthouse')
  assert.equal(classifyAutomation(bundle({ ...crawlerEnv, cores: 16, hiddenMs: 0, visible: true }), { userAgent: LINUX_CHROME_150, device: 'desktop' }).cohort, '', '普通桌面不算')
  assert.equal(classifyAutomation(bundle({ ...crawlerEnv, cores: 128 }), { userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/97.0 Mobile Safari/537.36', device: 'mobile' }).cohort, '', '核数规则只看桌面')
  // #1201：Chrome 97 / Android 15 / 4G / 中国，是真实玩家
  const android = bundle({ mem: 4, cores: 8, net: { type: '4g', downlink: 10, rtt: 100, saveData: false }, screen: '393x873@2.75', touch: 5, lang: 'zh-CN', online: true, hiddenMs: 0, visible: true })
  assert.equal(classifyAutomation(android, { userAgent: 'Mozilla/5.0 (Linux; Android 15; V2309A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.98 Mobile Safari/537.36', device: 'mobile' }).cohort, '')
  assert.deepEqual(bundle({ ...crawlerEnv, auto: ['webdriver', 'no-outer', 'evil<script>', 'webdriver'] }).env.auto, ['webdriver', 'no-outer'], '自动化特征只收白名单、去重')
  assert.deepEqual(bundle(crawlerEnv).env.auto, [], '旧前端不发也没关系')

  // 刷新结论：只收白名单字段
  const recovered = bundle(crawlerEnv, { recovery: { outcome: 'recovered', via: 'reload', afterMs: 2345.6, previous: 'x https://evil.example/a?token=1', junk: 1 } })
  assert.deepEqual(recovered.recovery, { outcome: 'recovered', via: 'reload', afterMs: 2346, previous: 'x evil.example/a' })
  assert.equal(bundle(crawlerEnv, { recovery: { outcome: 'whatever' } }).recovery, undefined)
  // 服务端判的来源读回历史数据时保留（入库时由 recordStartupDiagnostics 重算覆盖）
  assert.deepEqual(bundle(crawlerEnv, { automation: { cohort: 'suspect', signals: ['automation.server_cpu'] } }).automation, { cohort: 'suspect', signals: ['automation.server_cpu'] })
  assert.equal(bundle(crawlerEnv, { automation: { cohort: 'admin' } }).automation, undefined)

  // 归组：普通访客的特征和以前一样；自动化、刷新后未确认、刷新后又坏各成一组
  const withDiagnosis = (d) => ({ ...d, diagnosis: diagnoseStartupFailure({ event: 'failed', runtime: 'page', detail: lazyReason, diagnostics: d }) })
  const plainSig = errorSignature({ event: 'failed', runtime: 'page', detail: lazyReason, diagnostics: withDiagnosis(bundle(crawlerEnv)) })
  const suspectSig = errorSignature({ event: 'failed', runtime: 'page', detail: lazyReason, diagnostics: withDiagnosis({ ...bundle(crawlerEnv), automation: { cohort: 'suspect', signals: [] } }) })
  const againSig = errorSignature({ event: 'failed', runtime: 'page', detail: lazyReason, diagnostics: withDiagnosis({ ...bundle(crawlerEnv), recovery: { outcome: 'failed_again', via: 'reload', afterMs: 1 } }) })
  const unconfirmedSig = errorSignature({ event: 'failed', runtime: 'page', detail: lazyReason, diagnostics: withDiagnosis({ ...bundle(crawlerEnv), recovery: { outcome: 'unconfirmed', via: 'reload', afterMs: 1 } }) })
  const recoveredSig = errorSignature({ event: 'recovered', runtime: 'page', detail: lazyReason, diagnostics: withDiagnosis({ ...bundle(crawlerEnv), recovery: { outcome: 'recovered', via: 'reload', afterMs: 1 } }) })
  assert.equal(plainSig.text, 'failed · page · 页面懒加载模块导入失败')
  assert.equal(new Set([plainSig, suspectSig, againSig, unconfirmedSig, recoveredSig].map((x) => x.signature)).size, 5, '五种现场五个组')
  assert.equal(suspectSig.text, 'failed · page · 页面懒加载模块导入失败 · 疑似自动化')
  assert.equal(againSig.text, 'failed · page · 页面懒加载模块导入失败 · 自动刷新后再次失败')
  assert.equal(recoveredSig.text, 'recovered · page · 页面懒加载模块导入失败', 'recovered 本身就是事件名，不再重复')
  assert.equal(
    errorSignature({ event: 'failed', runtime: 'page', detail: lazyReason, diagnostics: withDiagnosis({ ...bundle(crawlerEnv), automation: { cohort: '', signals: [] } }) }).signature,
    plainSig.signature,
    '普通访客显式带空来源也是同一组（历史分组不变）',
  )

  // 叫不叫人：只有普通访客、确实没恢复的才报警 / 发飞书 / 让 AI 分诊
  assert.equal(needsAttention('failed', bundle(crawlerEnv)), true)
  assert.equal(needsAttention('failed', { ...bundle(crawlerEnv), automation: { cohort: 'suspect', signals: [] } }), false)
  assert.equal(needsAttention('failed', { ...bundle(crawlerEnv), automation: { cohort: 'bot', signals: [] } }), false)
  assert.equal(needsAttention('recovered', bundle(crawlerEnv)), false)
  assert.equal(needsAttention('failed', { ...bundle(crawlerEnv), recovery: { outcome: 'unconfirmed', via: 'reload', afterMs: 1 } }), false)
  assert.equal(needsAttention('failed', { ...bundle(crawlerEnv), recovery: { outcome: 'failed_again', via: 'reload', afterMs: 1 } }), true, '刷新后又坏是真故障')
  assert.equal(needsAttention('slow_start', { diagnosis: { signals: ['progress.rom_downloading'] } }), false, 'ROM 仍有新字节时只留现场，不能聚合报警')
  assert.equal(needsAttention('slow_start', { diagnosis: { signals: ['progress.rom_dominated'] } }), false, 'ROM 刚下载完、启动尚短时不能聚合报警')
  assert.equal(needsAttention('slow_start', { diagnosis: { signals: ['progress.assets_loading'] } }), false, '启动资源仍有进度时只留现场，不能聚合报警')
  assert.equal(needsAttention('slow_start', { diagnosis: { signals: ['stage.rom'] } }), true, '没有新进度的 ROM 阶段仍需要叫人')

  // 后台默认不列噪音，只数个数
  const rows = [
    { signature: 'a', event: 'failed', cohort: '' },
    { signature: 'b', event: 'failed', cohort: 'suspect' },
    { signature: 'c', event: 'recovered', cohort: '' },
    { signature: 'd', event: 'failed', cohort: 'bot' },
    { signature: 'e', event: 'timeout', cohort: 'weird' },
  ]
  const hiddenNoise = partitionNoise(rows)
  assert.deepEqual(hiddenNoise.kept.map((r) => [r.signature, r.cohort]), [['a', ''], ['e', '']], '未知来源当普通访客')
  assert.deepEqual(hiddenNoise.hidden, { recovered: 1, automation: 2 })
  assert.equal(partitionNoise(rows, true).kept.length, 5)

  // 漏斗收 recovered 事件
  assert.equal(normalizeStartupEvent({ event: 'recovered', visitId: 'visit-12345678', attemptId: 'attempt-12345678', runtime: 'page' }).event, 'recovered')

  // 接线
  const server = read('server/src/startup-diagnostics.js')
  assert.match(server, /diagnostics\.automation = classifyAutomation\(diagnostics, \{ userAgent, device \}\)/, '来源在服务端按原始 UA 当场判，UA 不落库')
  assert.match(server, /const attention = inserted && !suppressSideEffects && needsAttention\(event\.event, diagnostics\)/)
  assert.match(server, /captureLevel === 'summary'/, '摘要不包含详细环境字段')
  assert.match(server, /summaryDiagnosticsFor\(event, summaryNote\)/, '缺包和历史回填生成安全摘要')
  assert.match(server, /if \(attention\) void maybeAlertSignature\(signature\)/)
  assert.match(server, /if \(attention && \(event\.event === 'failed' \|\| event\.event === 'timeout'\)\)/, '飞书只报普通访客的真失败')
  assert.match(server, /if \(attention\) \{\s*void import\('\.\/ai-hotfix\.js'\)/, 'AI 分诊同理')
  assert.match(server, /if \(event\.runtime !== 'page'\) delete diagnostics\.recovery/, '刷新结论只认兜底页的报告')
  assert.match(read('server/src/routes/admin.js'), /diagnosticGroups\(req\.query\.days, req\.query\.q, req\.query\.event, req\.query\.noise\)/)
  assert.match(read('server/scripts/migrate.mjs'), /ADD COLUMN `cohort` VARCHAR\(12\)/)
  assert.match(read('server/schema-v2.sql'), /cohort VARCHAR\(12\)/)
  assert.match(read('server/src/schema-check.js'), /table: 'game_startup_diagnostics', column: 'cohort'/)
  const client = read('src/services/startupDiagnostics.ts')
  assert.match(client, /navigator as Navigator & \{ webdriver\?: boolean \}\)\.webdriver === true\) hints\.push\('webdriver'\)/)
  assert.match(client, /auto: automationHints\(\)/)
  const page = read('src/admin/AdminDiagnostics.tsx')
  assert.match(page, /if \(showNoise\) params\.set\('noise', 'show'\)/, '后台默认隐藏噪音，点了才显示')
  assert.match(page, /\{ id: 'recovered', label: '已自动恢复' \}/)
  assert.match(page, /仅有安全摘要/)
  assert.match(read('server/scripts/backfill-startup-diagnostics.mjs'), /if \(!apply\)/, '历史摘要回填默认只预览')
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
  // 详情页渲染崩溃（兜底页）也进「错误诊断」：只在 /games/<slug>，旧 chunk 自救刷新的不报
  const boundary = read('src/components/AppErrorBoundary.tsx')
  assert.match(boundary, /const previous = takeRecoveryForFailure\(\)\s*if \(!recoverBrokenAsset\(error, info, previous\)\) reportRenderCrash\(error, info, '', previous\)/)
  // 坏 chunk（缺具名导出 / 404）先核对修复再决定刷新还是上报，细节见 scripts/test-asset-repair.mjs
  assert.match(boundary, /event: 'failed',\s*runtime: 'page'/)
  assert.match(boundary, /games\\\/\(\[\^\/\?#\]\+\)/, '只在游戏详情页上报')
  assert.match(boundary, /<details/, '兜底页把错误原文摆出来')
  assert.match(ejs, /if \(bits === '32'\) return failLoad\(rt\.ejsOutOfMemory32bit, 'config'\)/, '32 位浏览器内存不足：换浏览器提示，不原地重试')
  assert.match(ejs, /if \(core === FBNEO_LOWMEM_CORE \|\| core === PSX_LOWMEM_CORE\) \{[\s\S]{0,600}return failLoad\(lowmemOomMessage\(vendor\), 'config'\)/, '低内存核心（FBNeo / PS1）也内存不足：不再原地重试同一个核心')
  assert.match(ejs, /probeWasmMemoryCeilingMB\(\)/, '失败时实测还能分配多少 WASM 内存，写进诊断包')
  assert.match(ejs, /\|\| isLowmemOomMessage\(message\)/, '低内存核心的内存不足同样不把大陆加速入口判坏')
  for (const lang of ['zh-Hans', 'zh-Hant', 'en', 'es', 'de', 'it', 'fr', 'ja']) {
    assert.match(read(`src/locales/${lang}.ts`), /ejsOutOfMemory32bit: '/, `${lang} 有 32 位提示`)
    assert.match(read(`src/locales/${lang}.ts`), /ejsOutOfMemoryLowmem: ['"]/, `${lang} 有低内存核心失败提示`)
    assert.match(read(`src/locales/${lang}.ts`), /ejsOutOfMemoryVendor: ['"][^\n]*\{browser\}/, `${lang} 有厂商浏览器提示`)
    assert.match(read(`src/locales/${lang}.ts`), /memoryCleanRetry: '/, `${lang} 有干净页面重开提示`)
  }
}

// React 更新循环（#185，2026-11-17 / 11-20 两份大陆现场）：摘要只留 160 字，以前全被 React 的套话占满、组件栈没进库
{
  const loopError = new Error('Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.')
  loopError.stack = `${loopError.name}: ${loopError.message}\n    at f (https://8bitgo.com/assets/react-vendor-a.js:1:2)\n    at g (https://8bitgo.com/assets/react-vendor-a.js:1:3)\n    at h (https://8bitgo.com/assets/react-vendor-a.js:1:4)`
  assert.equal(errorHead(loopError), 'Error: Minified React error #185')
  assert.equal(isReactUpdateLoop(loopError), true)
  assert.equal(isReactUpdateLoop(new Error('Maximum update depth exceeded. This can happen when…')), true, '开发版原文也认')
  assert.equal(isReactUpdateLoop(new Error('Minified React error #418; visit https://react.dev/errors/418')), false, '水合不匹配不是更新循环')
  assert.equal(isReactUpdateLoop(new TypeError('Failed to fetch dynamically imported module')), false)
  assert.equal(errorHead(new Error('Minified React error #418; visit https://react.dev/errors/418?args[]=x for the full message')), 'Error: Minified React error #418', '套话被截断也能压掉')
  assert.equal(errorHead(new TypeError('Failed to fetch dynamically imported module: https://x/a.js')), 'TypeError: Failed to fetch dynamically imported module: https://x/a.js', '其它错误原样保留')
  assert.deepEqual(stackFrames(loopError, 2), ['at f (https://8bitgo.com/assets/react-vendor-a.js:1:2)', 'at g (https://8bitgo.com/assets/react-vendor-a.js:1:3)'])
  const stack = '\n    at Bar (https://8bitgo.com/assets/GameDetailPage-a.js:1:1)\n    at Foo (https://8bitgo.com/assets/GameDetailPage-a.js:1:2)\n    at Suspense (<anonymous>)'
  assert.equal(componentPath(stack, 2), 'at Bar (https://8bitgo.com/assets/GameDetailPage-a.js:1:1) < at Foo (https://8bitgo.com/assets/GameDetailPage-a.js:1:2)')
  // 拼成兜底页报告的样子再过一遍服务端摘要清洗：组件名必须留在 160 字里
  const summary = sanitizeStartupDetail([errorHead(loopError), `组件：${componentPath(stack, 8)}`].join('\n'))
  assert.match(summary, /^Error: Minified React error #185 组件：at Bar \(\[URL\] < at Foo/, '组件栈进了 160 字摘要')
  assert.equal(diagnoseStartupFailure({ event: 'failed', runtime: 'page', platform: '', detail: summary, diagnostics: null }).code, 'react_update_loop', '服务端照旧归成更新循环')

  const boundary = read('src/components/AppErrorBoundary.tsx')
  assert.match(boundary, /const loop = isReactUpdateLoop\(error\)[\s\S]{0,400}\? \[errorHead\(error\), component, note, \.\.\.stackFrames\(error, 2\)\]/, '更新循环：组件栈排在调用栈前面')
  assert.match(boundary, /if \(isReactUpdateLoop\(error\)\) \{\s*this\.retryUpdateLoop\(error, info, takeRecoveryForFailure\(\)\)\s*return/, '更新循环先上报再原地重挂')
  assert.match(boundary, /if \(updateLoopRemounted\) \{\s*reportRenderCrash\(error, info, '原地重新挂载一次后再次出现更新循环', previous\)\s*return/, '每页只重挂一次，第二次停在兜底页')
  assert.match(boundary, /updateLoopRemounted = true\s*reportRenderCrash\(error, info, '页面更新循环：已原地重新挂载一次', previous\)\s*window\.setTimeout\(\(\) => this\.setState\(\{ failed: false, detail: '' \}\), 0\)/)
}

console.log('✔ 启动诊断包：脱敏与白名单、UA 粗粒度、错误归组、前端采集、复制给 AI、PSP 现场、接线')
process.exit(0)
