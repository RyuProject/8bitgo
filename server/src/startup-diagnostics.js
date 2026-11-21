/**
 * 启动诊断包（后台「错误诊断」页的数据源）。
 *
 * 启动漏斗（startup-metrics.js）每局只留阶段时间点和一句 160 字的摘要；这里在一局
 * **失败 / 超时 / 慢启动**时多存一份结构化的现场：浏览器与系统（从请求头归成「Safari 26 / macOS」
 * 这一级，不存完整 UA）、设备与网络、这一局的阶段时间线、引擎最后几十行日志、慢 / 失败的网络请求。
 * 前端见 src/services/startupDiagnostics.ts。
 *
 * 隐私边界（隐私政策第 4 / 10 节，`npm run test:legal` 对账）：不存 IP、完整 User-Agent、账号、
 * ROM 地址；所有文本入库前再脱敏一遍（前端已经洗过，但不能信客户端）；保留 30 天。
 */
import { createHash } from 'node:crypto'
import { query } from './db.js'
import { maybeAlertSignature } from './diag-alert.js'
import { notifyLarkFailure } from './diag-lark.js'
import { classifyUserAgent } from '../../shared/user-agent.js'

export const DIAGNOSTIC_EVENTS = new Set(['failed', 'timeout', 'slow_start'])
export const DIAGNOSTICS_RETENTION_DAYS = 30
const PAYLOAD_MAX_BYTES = 32_000

const IPV4_RE = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g
// 完整 8 段，或带 :: 的压缩写法；不会误伤 18:15:39 这种时间
const IPV6_RE = /(?<![\w:])(?:(?:[\da-f]{1,4}:){7}[\da-f]{1,4}|(?:[\da-f]{1,4}:){1,6}:(?:[\da-f]{1,4}(?::[\da-f]{1,4}){0,5})?|::[\da-f]{1,4}(?::[\da-f]{1,4}){0,6})(?![\w:])/gi

/** 网址只留「主机 + 最后一段」，ROM 目录下的换成 [ROM]（与前端 shortenUrl 同一规则） */
function shortenUrl(raw) {
  try {
    const url = new URL(raw)
    if (url.protocol === 'blob:') return 'blob:[本地文件]'
    if (url.protocol === 'data:') return 'data:[内联]'
    if (url.protocol === 'file:') return 'file:[本地文件]'
    const segments = url.pathname.split('/').filter(Boolean)
    let last = segments.at(-1) ?? ''
    try { last = decodeURIComponent(last) } catch { /* 保留原文 */ }
    if (segments.includes('roms') || segments.includes('_route-probe')) {
      const ext = last.includes('.') ? last.slice(last.indexOf('.')) : ''
      last = `[ROM]${ext.slice(0, 16)}`
    }
    const dir = segments.length > 1 ? `${segments[0]}/…/` : ''
    return `${url.host}/${dir}${last}`.slice(0, 120)
  } catch {
    return '[URL]'
  }
}

/** 所有入库文本都过这一层：控制字符、网址、令牌、口令、IP */
export function scrub(value, max = 300) {
  // PPSSPP 输出带终端颜色码（ESC[91m），只留文字
  // eslint-disable-next-line no-control-regex
  return Array.from(String(value ?? '').replace(/\u001b?\[\d{1,3}(?:;\d{1,3})*m/g, ''), (char) => {
    const code = char.codePointAt(0) ?? 0
    return code <= 31 || code === 127 || code === 0x2028 || code === 0x2029 ? ' ' : char
  }).join('')
    .replace(/\b(?:blob|data|file):[^\s"'<>)\]]+/gi, (url) => shortenUrl(url))
    .replace(/(?:https?|wss?):\/\/[^\s"'<>)\]]+/gi, (url) => shortenUrl(url))
    .replace(/\b(bearer)\s+[^\s,;]+/gi, '$1 [已隐藏]')
    .replace(/\b(authorization|cookie|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|token|key)\b(\s*[:=]\s*)[^\s,;&]+/gi, '$1$2[已隐藏]')
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, '[令牌]')
    /*
      邮箱后面不能紧跟路径或「:行号」。Safari / Firefox 的调用栈写成 `vt@https://cn.8bitgo.com/_cn/assets/x.js:11:4269`，
      网址缩短后是 `vt@cn.8bitgo.com/_cn/…/x.js:11:4269` —— 以前整段被当成邮箱换成 [邮箱]，
      函数名和资源域名一起丢了（2026-11-16 诊断包 #761）。真邮箱后面跟的是空白、标点或行尾。
    */
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+(?![\w-]|\.[\w-]|[/:]\S)/g, '[邮箱]')
    .replace(IPV4_RE, '[IP]')
    .replace(IPV6_RE, '[IP]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

const num = (value, min = 0, max = 3_600_000) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n * 100) / 100)) : null
}
const int = (value, min = -3_600_000, max = 3_600_000) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : 0
}
const arr = (value, limit) => (Array.isArray(value) ? value.slice(0, limit) : [])
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)

const DIAGNOSIS_CODES = new Set([
  'offline', 'network_http', 'network_failure', 'page_asset', 'engine_asset', 'engine_assets', 'engine_load', 'core_download', 'rom_download',
  'rom_invalid', 'bios_romset', 'webgl', 'memory', 'storage', 'input_api', 'wasm_runtime', 'runtime_trap',
  'timeout', 'unsupported', 'unknown',
])

/**
 * 最后一次加载进度离上报时刻在这个秒数以内，就算「还在动」。播放器每收到一份下载进度都会刷新它，
 * 8 MiB 分片在 3 Mbps 上也是几十毫秒就报一次，3 秒没动静才像停住。
 */
const LIVE_PROGRESS_S = 3

/**
 * 解析 startupProgressTrace（src/emulator/startupProgressTrace.ts）写的 snapshot 行。只取数字和标记，不保留原文。
 * 格式：「加载进度：阶段 rom，ROM 71.6MB/108.9MB，ROM 起于 0.6s，ROM 完成于 19.7s，平均 31.1Mbps，最后进度 19.9s」；
 * 这一行的 t 就是打包（上报）时刻。别的运行时也会往 snapshot 写现场，按前缀挑。
 */
export function readProgressSnapshot(logs) {
  const row = [...(Array.isArray(logs) ? logs : [])].reverse()
    .find((item) => item?.s === 'snapshot' && String(item?.m ?? '').startsWith('加载进度：阶段 '))
  if (!row) return null
  const text = String(row.m)
  const seconds = (label) => {
    const match = new RegExp(`${label} (\\d+(?:\\.\\d+)?)s`).exec(text)
    return match ? Number(match[1]) : null
  }
  const rom = /ROM (\d+(?:\.\d+)?)MB(?:\/(\d+(?:\.\d+)?)MB)?/.exec(text)
  return {
    phase: /^加载进度：阶段 (\w+)/.exec(text)?.[1] ?? '',
    atS: Number(row.t) / 1000,
    loadedMb: rom ? Number(rom[1]) : 0,
    totalMb: rom?.[2] ? Number(rom[2]) : 0,
    cached: text.includes('（缓存）'),
    streaming: text.includes('（流式）'),
    romStartS: seconds('ROM 起于'),
    romDoneS: seconds('ROM 完成于'),
    lastS: seconds('最后进度'),
  }
}

/** ROM 体积分档写进归组：大包（该做流式盘）和小包慢网（线路 / 并发问题）不是一类事 */
function romSizeArtifact(totalMb) {
  if (!(totalMb > 0)) return 'rom-size-unknown'
  if (totalMb < 16) return 'rom-lt16mb'
  if (totalMb < 64) return 'rom-16-64mb'
  if (totalMb < 256) return 'rom-64-256mb'
  return 'rom-ge256mb'
}

/**
 * 慢启动（20 秒还没出画面）只是一个时间点，不等于卡住。按进度快照区分三种情况
 * （2026-11-18 两份现场都被误标成「停滞」）：
 * - ROM 还在下、最后进度就在上报前一刻 → 没停，耗时由体积和带宽决定（诊断包 #1155：《MDK》114MB 普通 DOS 整包，
 *   第 19.9 秒仍以 31 Mbps 在下，却归进了「ROM 下载或流式读取停滞」）；
 * - ROM 刚下完、下载占了大半个 20 秒 → 慢的是 ROM 下载，后面的阶段才刚开始（#1156：《西游释厄传》21MB ROM
 *   单路串行下了 19.4 秒，第 19.7 秒进 assets，0.3 秒后上报，却归进了「模拟器依赖资源加载停滞」）；
 * - 其它（进度几秒没动、流式读盘、下完很久还在后面阶段）→ 维持原来按阶段的「停滞」归类。
 * 只看 slow_start：失败 / 超时的现场有自己的错误原文，不能被「还在动」盖掉。
 */
function diagnoseSlowStartProgress(event, logs, hit) {
  if (event !== 'slow_start') return null
  const progress = readProgressSnapshot(logs)
  if (!progress || !Number.isFinite(progress.atS) || progress.atS <= 0 || progress.cached || progress.streaming) return null
  const { phase, atS, loadedMb, totalMb, romStartS, romDoneS, lastS } = progress
  if (phase === 'rom' && lastS !== null && atS - lastS <= LIVE_PROGRESS_S && (!totalMb || loadedMb < totalMb)) {
    return { ...hit('rom_download', 'ROM 仍在下载，进度正常（未停滞，耗时取决于体积与带宽）', 'rom_download', 'high', 'progress.rom_downloading'), artifact: romSizeArtifact(totalMb) }
  }
  if (phase !== 'rom' && romStartS !== null && romDoneS !== null && atS - romDoneS <= LIVE_PROGRESS_S && romDoneS - romStartS >= atS / 2) {
    return { ...hit('rom_download', 'ROM 下载占去大半启动时间，后续阶段刚开始（未停滞）', 'rom_download', 'medium', 'progress.rom_dominated'), artifact: romSizeArtifact(totalMb) }
  }
  return null
}

/**
 * 从一份已脱敏现场提取最可能的故障类别。只保存规则编号和固定标签，不把额外原文复制进诊断结论，
 * 避免归类字段绕开日志的脱敏边界；顺序按更具体、可行动的错误优先。
 */
export function diagnoseStartupFailure({ event, platform, detail, diagnostics }) {
  const logs = Array.isArray(diagnostics?.logs) ? diagnostics.logs : []
  const resources = Array.isArray(diagnostics?.resources) ? diagnostics.resources : []
  const stage = [...logs].reverse().find((row) => row?.s === 'stage')?.m ?? ''
  const text = [detail, diagnostics?.reason, ...logs.map((row) => row?.m), stage]
    .filter(Boolean).join('\n').slice(-12_000).toLowerCase()
  const combined = `${text}\n${resources.map((row) => row?.n).filter(Boolean).join('\n')}`
  const has = (pattern) => pattern.test(text)
  const hit = (code, label, phase, confidence, signal) => ({ code, label, phase, confidence, signals: [signal] })

  // 内容名只从自托管核心包名提取；不会把任意错误原文写进归组标签。
  const core = combined.match(/\b([a-z][a-z0-9_-]{0,30})-(?:legacy-)?wasm\.data\b/i)?.[1]?.toLowerCase() ?? ''
  const withCore = (result) => core ? { ...result, artifact: core } : result

  if (has(/out of memory|cannot allocate wasm|wasm memory.*(?:alloc|fail)|allocation failed|内存不足|无法分配.*内存/)) {
    return withCore(hit('memory', 'WebAssembly 内存分配失败', 'runtime', 'high', 'error.wasm_memory'))
  }
  if (has(/glctx|webglcontextlost|webgl.*(?:unavailable|not supported|failed|error|could not|unable)|(?:failed|error|unable|cannot).*webgl|无法创建.*webgl|不支持.*webgl|webgl.*(?:失败|不可用)/)) {
    return hit('webgl', 'WebGL 初始化失败或不可用', 'graphics', 'high', 'error.webgl')
  }
  if (has(/(?:indexeddb|idbfs).*(?:error|failed|blocked|denied|unavailable|timeout)|(?:error|failed|blocked|denied|unavailable|timeout).*?(?:indexeddb|idbfs)|quotaexceeded|notreadableerror|storageerror|blob.{0,30}(?:read|reading|decode|读取).{0,30}(?:fail|error|失败)|(?:fail|failed|error|unable|cannot).{0,30}(?:read|reading|decode).{0,30}blob|存储.*(?:失败|不可用)/)) {
    return hit('storage', '浏览器存储或 Blob 读写失败', 'browser', 'high', 'error.storage')
  }
  if (has(/getgamepads|gamepad.*(?:securityerror|permission)|third-party iframes are not allowed|权限策略.*手柄/)) {
    return hit('input_api', '手柄接口被浏览器权限限制', 'browser', 'high', 'error.gamepad_permission')
  }
  if (has(/failed to load (?:emulator(?:\.min)?\.js|loader\.js)|(?:emulator(?:\.min)?\.js|loader\.js).{0,40}(?:failed|not found|missing|404)|emulatorjs failed to load|failed to load emulatorjs/)) {
    return hit('engine_asset', '模拟器引擎入口加载失败', 'engine_asset', 'high', 'error.engine_asset')
  }
  if (has(/the emulator failed to load|failed to load the emulator|模拟器没能加载|模拟器加载失败|no se pudo cargar el emulador|émulateur n.{0,12}a pas pu se charger|emulator konnte nicht geladen werden|emulatore non si è caricato|エミュレーターを読み込めませんでした/)) {
    return hit('engine_load', '模拟器整体加载失败（具体环节待定位）', 'engine', 'low', 'error.engine_load')
  }
  if (has(/downloading engine files|download engine files|descargando archivos del motor|téléchargement des fichiers du moteur|engine-dateien werden geladen|download dei file del motore|エンジンのファイルをダウンロード|正在下载引擎资源|正在下載引擎資源/)) {
    return hit('engine_assets', '模拟器依赖资源加载停滞', 'engine_asset', 'medium', 'stage.engine_assets')
  }
  if (has(/loading chunk .{0,80} failed|chunkloaderror|failed to fetch dynamically imported module|importing a module script failed|does not provide an export named|import not found:/)) {
    return hit('page_asset', '页面懒加载模块导入失败', 'page_asset', 'high', 'error.lazy_module')
  }
  if (has(/(?:script|link) 加载失败/) && /\.(?:js|css)(?:\b|$)/i.test(combined)) {
    return hit('page_asset', '页面脚本或样式资源加载失败', 'page_asset', 'high', 'error.page_asset')
  }
  if (has(/romset is unknown|missing bios|bios.*(?:missing|缺少)|缺少.*(?:bios|rom)|romdata.*(?:failed|error|missing)|(?:failed|error|missing).*romdata/)
    || (platform === 'arcade' && has(/missing files|缺少文件/))) {
    return hit('bios_romset', '街机 ROM 集、成员或 BIOS 不匹配', 'content_config', 'high', 'error.romset_or_bios')
  }
  if (has(/table index is out of bounds|runtimeerror:.*(?:out of bounds|unreachable)|index out of bounds/)) {
    return withCore(hit('runtime_trap', '模拟器运行时陷阱（ROM / 核心原因待确认）', 'runtime', 'medium', 'error.runtime_trap'))
  }
  if (has(/invalid rom|corrupt rom|rom checksum|unknown mapper|unsupported mapper|rom.*(?:truncated|malformed)|rom.*(?:损坏|校验失败|格式错误)/)) {
    return hit('rom_invalid', 'ROM 内容或映射格式异常', 'content', 'high', 'error.rom_format')
  }
  if (has(/failed to load.*(?:core|核心)|error downloading core|download game core|下载游戏核心|核心.*(?:下载|加载).*失败/)) {
    return withCore(hit('core_download', '模拟器核心下载或加载失败', 'core_download', 'high', 'error.core_download'))
  }
  if (has(/error loading emulatorjs runtime|runtimeerror|compileerror|ejs_runtime|instantiate(?:streaming)?|wasm.*(?:error|failed|unavailable|memory|instantiate)|(?:error|failed|unavailable).*wasm/)) {
    return withCore(hit('wasm_runtime', '模拟器核心初始化或运行时异常', 'core_init', 'medium', 'error.wasm_runtime'))
  }
  const slowProgress = diagnoseSlowStartProgress(event, logs, hit)
  if (slowProgress) return slowProgress
  if (has(/加载进度：阶段 rom|loading progress: phase rom/)) {
    return hit('rom_download', 'ROM 下载或流式读取停滞', 'rom_download', 'medium', 'stage.rom')
  }
  if (has(/加载进度：阶段 (?:engine|assets)|loading progress: phase (?:engine|assets)/)) {
    return hit('engine_assets', '模拟器依赖资源加载停滞', 'engine_asset', 'medium', 'stage.engine_assets')
  }
  if (has(/加载进度：阶段 starting|loading progress: phase starting/)) {
    if (platform === 'html5') {
      return hit('timeout', '网页游戏页面已加载，但尚未确认可玩', 'startup', 'medium', 'stage.html5_starting')
    }
    return withCore(hit('timeout', 'ROM 完成后模拟器启动停滞', 'core_init', 'medium', 'stage.starting'))
  }
  const failedResource = [...resources].reverse().find((row) => Number(row?.st) >= 400 && /^(?:fetch|xmlhttprequest|script|link|other)$/i.test(String(row?.i ?? '')))
  if (failedResource && /\[ROM\]|\/roms\//i.test(String(failedResource.n ?? ''))) {
    return { ...hit('rom_download', 'ROM 请求返回 HTTP 错误', 'rom_download', 'high', 'resource.rom_http_status'), artifact: `http-${Number(failedResource.st)}` }
  }
  if (failedResource && /emulatorjs|wasm\.data/i.test(String(failedResource.n ?? ''))) {
    return withCore(hit('core_download', '模拟器核心请求返回 HTTP 错误', 'core_download', 'high', 'resource.core_http_status'))
  }
  if (failedResource && /^(?:script|link)$/i.test(String(failedResource.i ?? '')) && /\.(?:js|css)$/i.test(String(failedResource.n ?? ''))) {
    return hit('page_asset', '页面脚本或样式资源请求返回 HTTP 错误', 'page_asset', 'high', 'resource.page_asset_status')
  }
  if (failedResource) {
    return { ...hit('network_http', '资源请求返回 HTTP 错误（与本次故障的关系待确认）', 'network', 'medium', 'resource.http_status'), artifact: `http-${Number(failedResource.st)}` }
  }
  if (has(/\[rom\]|\/roms\/|rom download|rom.*(?:下载失败|线路失败|分片.*失败|仍在下载)|仍在下载 rom|正在下载(?: rom|游戏)|正在下載(?: rom|遊戲)|downloading (?:the )?(?:game|rom)|download(?:ing)? (?:del gioco|the game)|descargando (?:el )?(?:juego|la rom)|téléchargement (?:du jeu|de la rom)|spiel wird heruntergeladen|ゲームをダウンロード/)) {
    return hit('rom_download', 'ROM 下载或读取失败', 'rom_download', 'medium', 'error.rom_download')
  }
  if (diagnostics?.env?.online === false) return hit('offline', '浏览器报告设备离线', 'network', 'medium', 'environment.offline')
  if (has(/failed to fetch|networkerror|net::err_|connection reset|connection refused|dns_probe|request failed|网络请求失败|连接(?:超时|失败)/)) {
    return hit('network_failure', '网络请求失败', 'network', 'medium', 'error.network')
  }

  const lastStage = stage.toLowerCase()
  if (/rom/.test(lastStage) && /download|下载|讀取|读取|descarg|télécharg|herunterlad|ダウンロード/.test(lastStage)) {
    return hit('rom_download', 'ROM 下载或读取停滞', 'rom_download', 'medium', 'stage.rom')
  }
  if (/core|核心|núcleo|noyau|kern|コア/.test(lastStage) && /download|下载|decompress|解压|descarg|télécharg|herunterlad|ダウンロード/.test(lastStage)) {
    return withCore(hit('core_download', '模拟器核心下载或解压停滞', 'core_download', 'medium', 'stage.core'))
  }
  if (event === 'timeout' || has(/timeout|timed out|超时|stalled|卡住|没有启动进度|loading got stuck at|carga se ha quedado atascada|chargement est bloqué|das laden hängt|読み込みが.{0,12}止まり|載入在.{0,12}停住|加载在.{0,12}停住/)) {
    return hit('timeout', '启动流程超时或停滞', 'startup', 'medium', 'event.timeout')
  }
  if (has(/unsupported|not supported|不支持|无法运行此格式/)) {
    return hit('unsupported', '当前核心或浏览器不支持该功能', 'configuration', 'low', 'error.unsupported')
  }
  return hit('unknown', '原因未能自动识别', 'unknown', 'low', 'no_specific_signal')
}

/**
 * 按白名单重建整个诊断包：未知字段一律丢弃，字符串逐个脱敏截短，数组限长。
 * 客户端发什么都不能原样进库。
 */
export function normalizeDiagnostics(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const env = raw.env && typeof raw.env === 'object' ? raw.env : {}
  const net = env.net && typeof env.net === 'object' ? env.net : null
  const attempt = raw.attempt && typeof raw.attempt === 'object' ? raw.attempt : {}
  const out = {
    v: 1,
    build: scrub(raw.build, 40).replace(/[^\w.-]/g, ''),
    reason: scrub(raw.reason, 600),
    env: {
      mem: num(env.mem, 0, 1024),
      cores: num(env.cores, 0, 256),
      net: net ? {
        type: scrub(net.type, 8).replace(/[^\w-]/g, ''),
        downlink: num(net.downlink, 0, 10_000),
        rtt: num(net.rtt, 0, 60_000),
        saveData: Boolean(net.saveData),
      } : null,
      screen: scrub(env.screen, 24).replace(/[^\dx@.]/g, ''),
      touch: int(env.touch, 0, 32),
      lang: scrub(env.lang, 16).replace(/[^\w-]/g, ''),
      coi: Boolean(env.coi),
      sab: Boolean(env.sab),
      bits: pick(env.bits, ['32', '64'], null),
      online: env.online !== false,
      hiddenMs: int(env.hiddenMs, 0),
      visible: env.visible !== false,
    },
    attempt: {
      index: int(attempt.index, 0, 1000),
      sinceStartMs: int(attempt.sinceStartMs, 0),
    },
    // 这一局生效着的 AI 临时修补 id（shared/hotfix.js）。自动撤销与「修补后还失败多少」靠它统计
    hotfixes: [...new Set(arr(raw.hotfixes, 8).map((id) => String(id ?? '')).filter((id) => /^\d{1,12}$/.test(id)))],
    timeline: arr(raw.timeline, 40).map((row) => ({
      t: int(row?.t),
      e: scrub(row?.e, 24).replace(/[^\w-]/g, ''),
    })).filter((row) => row.e),
    // 日志留最后 60 行：越靠近失败的越有用，运行时现场快照也在最后
    logs: (Array.isArray(raw.logs) ? raw.logs.slice(-60) : []).map((row) => ({
      t: int(row?.t),
      s: scrub(row?.s, 16).replace(/[^\w-]/g, ''),
      l: pick(row?.l, ['error', 'warn', 'log', 'info'], 'log'),
      m: scrub(row?.m, 300),
    })).filter((row) => row.m),
    resources: arr(raw.resources, 30).map((row) => ({
      n: scrub(row?.n, 120),
      i: scrub(row?.i, 16).replace(/[^\w-]/g, ''),
      at: int(row?.at),
      d: int(row?.d, 0),
      tx: int(row?.tx, 0, 4_000_000_000),
      sz: int(row?.sz, 0, 4_000_000_000),
      st: int(row?.st, 0, 999),
      p: scrub(row?.p, 12).replace(/[^\w./-]/g, ''),
    })).filter((row) => row.n),
  }
  const diagnosis = raw.diagnosis && typeof raw.diagnosis === 'object' ? raw.diagnosis : null
  if (diagnosis) {
    out.diagnosis = {
      code: pick(diagnosis.code, [...DIAGNOSIS_CODES], 'unknown'),
      label: scrub(diagnosis.label, 80),
      phase: scrub(diagnosis.phase, 24).replace(/[^\w-]/g, ''),
      confidence: pick(diagnosis.confidence, ['high', 'medium', 'low'], 'low'),
      signals: arr(diagnosis.signals, 6).map((signal) => scrub(signal, 40).replace(/[^\w.-]/g, '')).filter(Boolean),
      ...(typeof diagnosis.artifact === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(diagnosis.artifact)
        ? { artifact: diagnosis.artifact.toLowerCase() }
        : {}),
    }
  }
  while (JSON.stringify(out).length > PAYLOAD_MAX_BYTES && (out.logs.length || out.resources.length)) {
    if (out.logs.length > 10 || !out.resources.length) out.logs.shift()
    else out.resources.pop()
  }
  return out
}

/**
 * 从 User-Agent 归出「浏览器 + 大版本」「系统」「设备类型」三个粗粒度字段，原始 UA 不落库。
 * 实现挪到 shared/user-agent.js：AI 临时修补（shared/hotfix.js）要在浏览器里按同一套规则判断
 * 「这条修补管不管我」，两边各写一份迟早会分家。这里保留导出，旧的 import 与测试照常用。
 */
export { classifyUserAgent } from '../../shared/user-agent.js'

/**
 * 归类用的「错误特征」：把会变的部分（数字、百分比、引号里的内容、十六进制）抹掉，
 * 同一类故障才能合并成一组。慢启动没有错误原文，用最后停在的加载阶段代替。
 */
export function errorSignature({ event, runtime, platform, detail, diagnostics }) {
  const diagnosis = diagnostics?.diagnosis ?? diagnoseStartupFailure({ event, runtime, platform, detail, diagnostics })
  if (diagnosis.code !== 'unknown') {
    const stage = event === 'slow_start'
      ? scrub([...((diagnostics?.logs ?? []))].reverse().find((row) => row?.s === 'stage')?.m ?? '', 120)
        .replace(/\d+(?:[.,]\d+)?/g, '#').replace(/\s+/g, ' ').trim()
      : ''
    const key = [diagnosis.artifact, stage ? `停在：${stage}` : ''].filter(Boolean).join(' · ')
    const text = `${event} · ${runtime || 'unknown'} · ${diagnosis.label}${key ? ` · ${key}` : ''}`
    const signature = createHash('sha1').update(`${event}|${runtime || 'unknown'}|${diagnosis.code}|${diagnosis.artifact ?? ''}|${stage}`).digest('hex').slice(0, 16)
    return { signature, text: text.slice(0, 200) }
  }
  let basis = String(detail ?? '')
  if (event === 'slow_start' || !basis) {
    const stage = [...(diagnostics?.logs ?? [])].reverse().find((row) => row.s === 'stage')?.m
    basis = stage ? `停在：${stage}` : basis || '无错误原文'
  }
  const normalized = scrub(basis, 400)
    .replace(/0x[\da-f]+/gi, '0x#')
    .replace(/\b[\da-f]{8,}\b/gi, '#')
    .replace(/[\d]+(?:[.,]\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
  const safeNormalized = normalized.replace(/(["'«「“])[^"'»」”]{1,80}(["'»」”])/g, '$1…$2')
  const text = `${event} · ${runtime || 'unknown'} · ${safeNormalized}`
  const signature = createHash('sha1').update(text).digest('hex').slice(0, 16)
  return { signature, text: text.slice(0, 200) }
}

let nextCleanupAt = 0
function scheduleCleanup() {
  const now = Date.now()
  if (now < nextCleanupAt) return
  nextCleanupAt = now + 6 * 60 * 60_000
  void query(`DELETE FROM game_startup_diagnostics WHERE created_at < UTC_TIMESTAMP() - INTERVAL ${DIAGNOSTICS_RETENTION_DAYS} DAY`)
    .catch((error) => console.warn('[startup] 清理过期诊断包失败：', error?.message || error))
}

let missingTableWarned = false
let hotfixColumnMissing = false

/**
 * 写一份诊断包。调用方已经写好了漏斗事件（同一个 visit/attempt/event 唯一键挡重放）。
 * 任何失败都只记日志：诊断是锦上添花，不能让漏斗接口 500。
 */
export async function recordStartupDiagnostics(slug, event, rawDiagnostics, { country = 'XX', userAgent = '' } = {}) {
  if (!DIAGNOSTIC_EVENTS.has(event?.event)) return false
  const diagnostics = normalizeDiagnostics(rawDiagnostics)
  if (!diagnostics) return false
  // 分类在服务端按白名单现场重算，避免客户端自行声明故障类型导致归组失真。
  diagnostics.diagnosis = diagnoseStartupFailure({ ...event, runtime: event.runtime, diagnostics })
  while (JSON.stringify(diagnostics).length > PAYLOAD_MAX_BYTES && (diagnostics.logs.length || diagnostics.resources.length)) {
    if (diagnostics.logs.length > 10 || !diagnostics.resources.length) diagnostics.logs.shift()
    else diagnostics.resources.pop()
  }
  const { browser, os, device } = classifyUserAgent(userAgent)
  const { signature, text } = errorSignature({ ...event, diagnostics })
  const hotfixIds = diagnostics.hotfixes.join(',')
  const values = [
    event.visitId, event.attemptId, event.event, event.runtime, event.platform,
    /^[A-Z]{2}$/.test(country) ? country : 'XX', event.elapsedMs,
    signature, text, browser.slice(0, 40), os.slice(0, 40), device,
    JSON.stringify(diagnostics),
  ]
  try {
    let result
    if (!hotfixColumnMissing) {
      try {
        result = await query(
          `INSERT IGNORE INTO game_startup_diagnostics
             (game_id, visit_id, attempt_id, event, runtime, platform, country, elapsed_ms,
              signature, signature_text, browser, os, device, payload, hotfix_ids)
           SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             FROM games
            WHERE slug = ? AND hidden = 0
            LIMIT 1`,
          [...values, hotfixIds, slug],
        )
      } catch (error) {
        // 先上代码、后跑迁移：缺 hotfix_ids 列时退回旧写法，诊断包照存（只是统计不到修补效果）
        if (error?.code !== 'ER_BAD_FIELD_ERROR') throw error
        hotfixColumnMissing = true
        console.warn('[startup] game_startup_diagnostics 缺 hotfix_ids 列，AI 修补的效果统计 / 自动撤销暂停 —— cd server && npm run migrate')
      }
    }
    if (!result) {
      result = await query(
        `INSERT IGNORE INTO game_startup_diagnostics
           (game_id, visit_id, attempt_id, event, runtime, platform, country, elapsed_ms,
            signature, signature_text, browser, os, device, payload)
         SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM games
          WHERE slug = ? AND hidden = 0
          LIMIT 1`,
        [...values, slug],
      )
    }
    scheduleCleanup()
    const inserted = Number(result?.affectedRows ?? 0) > 0
    // 同一特征短时间内聚集就发邮件（没配 DIAG_ALERT_EMAIL 时立即返回）；不 await，不拖慢接口
    if (inserted) void maybeAlertSignature(signature)
    // 新加载失败立即通知 Lark；诊断仍先入库，通知失败或超时不影响玩家接口
    if (inserted && (event.event === 'failed' || event.event === 'timeout')) {
      void notifyLarkFailure({
        event: event.event,
        signature,
        signatureText: text,
        slug,
        runtime: event.runtime,
        platform: event.platform,
        country,
        browser,
        os,
        device,
        elapsedMs: event.elapsedMs,
      })
    }
    /*
      AI 临时修补（ai-hotfix.js）：聚集了就让 MiniMax 分诊；带着修补还失败就数一数、够多自动撤销。
      动态 import：ai-hotfix.js 反过来要用这里的 diagnosticSamples / scrub，静态互相 import 会成环。
      都不 await，任何失败只在那边记日志。
    */
    if (inserted) {
      void import('./ai-hotfix.js').then((m) => {
        void m.maybeTriageSignature(signature, event.event)
        if (diagnostics.hotfixes.length && event.event !== 'slow_start') void m.noteHotfixFailure(diagnostics.hotfixes)
      }).catch((error) => console.warn('[startup] 加载 AI 修补模块失败：', error?.message || error))
    }
    return inserted
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE') {
      if (!missingTableWarned) console.warn('[startup] game_startup_diagnostics 表不存在，诊断包没有保存 —— cd server && npm run migrate')
      missingTableWarned = true
      return false
    }
    console.warn('[startup] 保存诊断包失败：', error?.message || error)
    return false
  }
}

/* ---------- 后台查询 ---------- */

const clampDays = (raw) => Math.max(1, Math.min(DIAGNOSTICS_RETENTION_DAYS, Math.round(Number(raw) || 7)))
const topN = (map, n = 5) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }))
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)

/** 按错误特征归组：次数最多的排前面，每组带涉及的游戏 / 浏览器 / 系统 / 地区分布 */
export async function diagnosticGroups(rawDays = 7, rawQuery = '', rawEvent = '') {
  const days = clampDays(rawDays)
  const search = scrub(rawQuery, 80)
  const event = DIAGNOSTIC_EVENTS.has(rawEvent) ? rawEvent : ''
  const rows = await query(
    `SELECT d.id, d.signature, d.signature_text AS signatureText, d.event, d.runtime, d.platform,
            d.country, d.browser, d.os, d.device, d.elapsed_ms AS elapsedMs, d.visit_id AS visitId,
            d.created_at AS createdAt, g.slug, COALESCE(NULLIF(g.title_zh, ''), g.title) AS title
       FROM game_startup_diagnostics d
       JOIN games g ON g.id = d.game_id
      WHERE d.created_at >= UTC_TIMESTAMP() - INTERVAL ? DAY
        AND (? = '' OR d.event = ?)
        AND (? = '' OR LOWER(CONCAT_WS(' ', g.slug, g.title, g.title_zh, d.signature_text, d.browser, d.os, d.runtime)) LIKE LOWER(?))
      ORDER BY d.created_at DESC
      LIMIT 20000`,
    [days, event, event, search, `%${search}%`],
  )
  const groups = new Map()
  for (const row of rows) {
    let group = groups.get(row.signature)
    if (!group) {
      group = {
        signature: row.signature,
        text: row.signatureText,
        event: row.event,
        runtime: row.runtime,
        count: 0,
        visits: new Set(),
        games: new Map(),
        gameTitles: new Map(),
        browsers: new Map(),
        os: new Map(),
        countries: new Map(),
        firstSeen: row.createdAt,
        lastSeen: row.createdAt,
        latestId: String(row.id),
      }
      groups.set(row.signature, group)
    }
    group.count++
    group.visits.add(row.visitId)
    bump(group.games, row.slug)
    group.gameTitles.set(row.slug, row.title)
    bump(group.browsers, row.browser || 'Other')
    bump(group.os, row.os || 'Other')
    bump(group.countries, row.country || 'XX')
    group.firstSeen = row.createdAt
  }
  return {
    days,
    total: rows.length,
    groups: [...groups.values()]
      .sort((a, b) => b.visits.size - a.visits.size || b.count - a.count)
      .slice(0, 200)
      .map((g) => ({
        signature: g.signature,
        text: g.text,
        event: g.event,
        runtime: g.runtime,
        count: g.count,
        visits: g.visits.size,
        games: topN(g.games).map(({ name, count }) => ({ slug: name, title: g.gameTitles.get(name) ?? name, count })),
        browsers: topN(g.browsers),
        os: topN(g.os),
        countries: topN(g.countries),
        firstSeen: g.firstSeen,
        lastSeen: g.lastSeen,
        latestId: g.latestId,
      })),
  }
}

function shapeSample(row) {
  let payload = null
  try {
    payload = JSON.parse(row.payload)
  } catch {
    payload = null
  }
  const diagnostics = normalizeDiagnostics(payload)
  if (diagnostics && !diagnostics.diagnosis) {
    diagnostics.diagnosis = diagnoseStartupFailure({ event: row.event, runtime: row.runtime, platform: row.platform, detail: diagnostics.reason, diagnostics })
  }
  return {
    id: String(row.id),
    slug: row.slug,
    title: row.title,
    event: row.event,
    runtime: row.runtime,
    platform: row.platform,
    country: row.country,
    browser: row.browser,
    os: row.os,
    device: row.device,
    elapsedMs: row.elapsedMs == null ? null : Number(row.elapsedMs),
    signature: row.signature,
    signatureText: row.signatureText,
    createdAt: row.createdAt,
    // 历史数据也过一遍当前的白名单与脱敏规则
    diagnostics,
  }
}

const SAMPLE_COLUMNS = `d.id, d.event, d.runtime, d.platform, d.country, d.browser, d.os, d.device,
  d.elapsed_ms AS elapsedMs, d.signature, d.signature_text AS signatureText, d.payload,
  d.created_at AS createdAt, g.slug, COALESCE(NULLIF(g.title_zh, ''), g.title) AS title`

/** 一组里最近的若干份完整诊断包 */
export async function diagnosticSamples(signature, rawLimit = 10) {
  if (!/^[\da-f]{16}$/.test(String(signature ?? ''))) return []
  const limit = Math.max(1, Math.min(30, Math.round(Number(rawLimit) || 10)))
  const rows = await query(
    `SELECT ${SAMPLE_COLUMNS}
       FROM game_startup_diagnostics d
       JOIN games g ON g.id = d.game_id
      WHERE d.signature = ?
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT ${limit}`,
    [signature],
  )
  return rows.map(shapeSample)
}

/** 按漏斗事件找对应的诊断包（后台「最近启动故障」表格点进来用） */
export async function diagnosticById(rawId) {
  const id = String(rawId ?? '')
  if (!/^\d{1,20}$/.test(id)) return null
  const rows = await query(
    `SELECT ${SAMPLE_COLUMNS}
       FROM game_startup_diagnostics d
       JOIN games g ON g.id = d.game_id
      WHERE d.id = ?
      LIMIT 1`,
    [id],
  )
  return rows[0] ? shapeSample(rows[0]) : null
}
