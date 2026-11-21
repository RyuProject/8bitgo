/**
 * 后台「错误诊断」页的数据类型，以及「复制给 AI」那段 Markdown 的拼装（纯函数，
 * `npm run test:startup-diagnostics` 覆盖）。
 *
 * 复制出来的文字要能直接贴给 AI 开工：先说清这是哪一类故障、影响多少人、集中在哪些游戏 / 浏览器，
 * 再附几份完整现场（环境、阶段时间线、引擎日志、慢 / 失败请求），最后提示该去看哪些代码。
 */

export type DiagnosticEvent = 'failed' | 'timeout' | 'slow_start'

export interface DiagnosticCount { name: string; count: number }

export interface DiagnosticDiagnosis {
  code: string
  label: string
  phase: string
  confidence: 'high' | 'medium' | 'low'
  signals: string[]
  artifact?: string
}

export interface DiagnosticGroup {
  signature: string
  text: string
  event: DiagnosticEvent
  runtime: string
  count: number
  visits: number
  games: Array<{ slug: string; title: string; count: number }>
  browsers: DiagnosticCount[]
  os: DiagnosticCount[]
  countries: DiagnosticCount[]
  firstSeen: string
  lastSeen: string
  latestId: string
}

export interface DiagnosticGroupsResponse {
  days: number
  total: number
  groups: DiagnosticGroup[]
}

export interface DiagnosticPayload {
  v: 1
  build: string
  reason: string
  diagnosis?: DiagnosticDiagnosis
  env: {
    mem: number | null
    cores: number | null
    net: { type: string; downlink: number | null; rtt: number | null; saveData: boolean } | null
    screen: string
    touch: number
    lang: string
    coi: boolean
    sab: boolean
    bits?: '32' | '64' | null
    online: boolean
    hiddenMs: number
    visible: boolean
  }
  attempt: { index: number; sinceStartMs: number }
  timeline: Array<{ t: number; e: string }>
  logs: Array<{ t: number; s: string; l: 'error' | 'warn' | 'log' | 'info'; m: string }>
  resources: Array<{ n: string; i: string; at: number; d: number; tx: number; sz: number; st: number; p: string }>
}

export interface DiagnosticSample {
  id: string
  slug: string
  title: string
  event: DiagnosticEvent
  runtime: string
  platform: string
  country: string
  browser: string
  os: string
  device: string
  elapsedMs: number | null
  signature: string
  signatureText: string
  createdAt: string
  diagnostics: DiagnosticPayload | null
}

export const EVENT_LABEL: Record<DiagnosticEvent, string> = {
  failed: '加载失败',
  timeout: '启动超时',
  slow_start: '慢启动（>20 秒）',
}

export const fmtMs = (ms: number | null | undefined): string => {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const sign = ms < 0 ? '-' : ''
  const abs = Math.abs(ms)
  return abs >= 1000 ? `${sign}${(abs / 1000).toFixed(1)}s` : `${sign}${Math.round(abs)}ms`
}

export const fmtBytes = (n: number): string => {
  if (!n) return '0'
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)}MB`
  if (n >= 1024) return `${Math.round(n / 1024)}KB`
  return `${n}B`
}

const DIAGNOSIS_SIGNAL_LABEL: Record<string, string> = {
  'environment.offline': '浏览器报告离线',
  'error.wasm_memory': '日志出现 WebAssembly 内存分配错误',
  'error.webgl': '日志出现 WebGL 初始化错误',
  'error.storage': '日志出现浏览器存储或 Blob 读写错误',
  'error.gamepad_permission': '日志出现手柄权限错误',
  'error.engine_asset': '日志指向模拟器引擎入口资源',
  'error.engine_load': '错误摘要报告模拟器整体加载失败',
  'stage.engine_assets': '最后阶段文字指向模拟器依赖资源',
  'stage.html5_starting': 'HTML5 页面已加载，但没有可玩信号',
  'error.lazy_module': '日志指向页面懒加载模块导入失败',
  'error.page_asset': '日志指向页面脚本或样式资源',
  'error.romset_or_bios': '日志出现街机 ROM 集或 BIOS 错误',
  'error.runtime_trap': '日志出现模拟器运行时陷阱',
  'error.rom_format': '日志出现 ROM 格式或映射错误',
  'error.core_download': '日志指向模拟器核心下载 / 加载',
  'error.wasm_runtime': '日志指向 WebAssembly 核心初始化 / 运行',
  'resource.rom_http_status': 'ROM 请求返回 HTTP 错误状态',
  'resource.core_http_status': '模拟器核心请求返回 HTTP 错误状态',
  'resource.page_asset_status': '页面脚本或样式请求返回 HTTP 错误状态',
  'resource.http_status': '资源请求返回 HTTP 错误状态',
  'error.rom_download': '日志或请求指向 ROM 下载 / 读取',
  'error.network': '日志出现网络请求错误',
  'stage.rom': '最后阶段文字指向 ROM 下载 / 读取',
  'progress.rom_downloading': '上报时 ROM 仍在下载且进度刚刷新过（不是停滞）',
  'progress.rom_dominated': 'ROM 下载用掉了大半启动时间，后续阶段刚开始',
  'stage.core': '最后阶段文字指向核心下载 / 解压',
  'event.timeout': '启动事件或错误文字报告超时',
  'error.unsupported': '日志出现不支持的功能 / 格式',
  no_specific_signal: '没有命中具体错误规则',
}

export const diagnosisSignalLabel = (signal: string): string => DIAGNOSIS_SIGNAL_LABEL[signal] ?? signal

const DIAGNOSIS_PHASE_LABEL: Record<string, string> = {
  network: '网络', graphics: '图形初始化', browser: '浏览器功能', engine_asset: '模拟器资源',
  page_asset: '页面资源', content_config: '街机 ROM / BIOS 配置', engine: '模拟器加载', runtime: '模拟器运行时',
  content: '游戏文件', core_download: '核心下载 / 解压', rom_download: 'ROM 下载 / 读取',
  core_init: '核心启动', startup: '启动流程', configuration: '兼容性配置', unknown: '未定位',
}

export const diagnosisPhaseLabel = (phase: string): string => DIAGNOSIS_PHASE_LABEL[phase] ?? phase

const counts = (items: DiagnosticCount[]): string => items.map((i) => `${i.name}×${i.count}`).join('、') || '—'

export function formatEnvironment(sample: DiagnosticSample): string {
  const env = sample.diagnostics?.env
  const parts = [`${sample.browser || '未知浏览器'} / ${sample.os || '未知系统'} / ${sample.device || '未知设备'}`, `地区 ${sample.country}`]
  if (env) {
    if (env.mem != null) parts.push(`内存 ${env.mem}GB`)
    if (env.cores != null) parts.push(`${env.cores} 核`)
    if (env.net) parts.push(`网络 ${env.net.type || '?'}${env.net.downlink != null ? ` ${env.net.downlink}Mbps` : ''}${env.net.rtt != null ? ` rtt ${env.net.rtt}ms` : ''}${env.net.saveData ? ' 省流量' : ''}`)
    parts.push(`屏幕 ${env.screen}`, `触点 ${env.touch}`, `语言 ${env.lang}`)
    parts.push(`跨源隔离 ${env.coi ? '是' : '否'}`, `SharedArrayBuffer ${env.sab ? '有' : '无'}`)
    if (env.bits) parts.push(`${env.bits} 位浏览器`)
    if (!env.online) parts.push('离线')
    if (env.hiddenMs > 0) parts.push(`本局在后台 ${fmtMs(env.hiddenMs)}`)
    if (!env.visible) parts.push('上报时页面在后台')
  }
  return parts.join('，')
}

export function formatSample(sample: DiagnosticSample, index?: number): string {
  const d = sample.diagnostics
  const lines: string[] = []
  lines.push(`### 样本${index != null ? ` ${index + 1}` : ''}：${sample.title}（${sample.slug}）· ${EVENT_LABEL[sample.event] ?? sample.event} · ${fmtMs(sample.elapsedMs)}`)
  lines.push(`- 时间：${sample.createdAt}（UTC），诊断包 #${sample.id}`)
  lines.push(`- 平台 / 运行时：${sample.platform || '?'} / ${sample.runtime || '?'}`)
  lines.push(`- 环境：${formatEnvironment(sample)}`)
  if (!d) {
    lines.push('- （诊断包内容无法解析）')
    return lines.join('\n')
  }
  lines.push(`- 部署版本：${d.build || '未知'}；本次访问第 ${d.attempt.index} 次开局`)
  if (d.reason) lines.push(`- 失败原因原文：${d.reason}`)
  if (d.diagnosis) {
    const certainty = d.diagnosis.confidence === 'high' ? '高' : d.diagnosis.confidence === 'medium' ? '中' : '低'
    lines.push(`- 自动识别：${d.diagnosis.label}；阶段 ${diagnosisPhaseLabel(d.diagnosis.phase)}；把握 ${certainty}${d.diagnosis.artifact ? `；对象 ${d.diagnosis.artifact}` : ''}`)
    if (d.diagnosis.signals.length) lines.push(`- 识别依据：${d.diagnosis.signals.map(diagnosisSignalLabel).join('；')}`)
  }
  if (d.timeline.length) {
    lines.push('', '阶段时间线（距点击开始）：', '```')
    for (const row of d.timeline) lines.push(`${fmtMs(row.t).padStart(7)}  ${row.e}`)
    lines.push('```')
  }
  if (d.logs.length) {
    lines.push('', '日志（page=外层页面，resource=浏览器捕获的失败资源，ejs=EmulatorJS 引擎，stage=加载阶段文字，download=下载器，adapter=适配器）：', '```')
    for (const row of d.logs) lines.push(`${fmtMs(row.t).padStart(7)} [${row.s}/${row.l}] ${row.m}`)
    lines.push('```')
  }
  if (d.resources.length) {
    lines.push('', '慢 / 大 / 失败的网络请求（传输 0 = 命中缓存或跨域不可见）：', '```')
    for (const r of d.resources) {
      lines.push(`${fmtMs(r.at).padStart(7)}  ${fmtMs(r.d).padStart(7)}  ${r.st || '-'}  ${r.p || '-'}  传输 ${fmtBytes(r.tx)} / 内容 ${fmtBytes(r.sz)}  ${r.i}  ${r.n}`)
    }
    lines.push('```')
  }
  return lines.join('\n')
}

export function formatGroupForAi(group: DiagnosticGroup, samples: DiagnosticSample[]): string {
  const lines = [
    `# 8BitGo 启动故障：${EVENT_LABEL[group.event] ?? group.event} · ${group.runtime || 'unknown'}`,
    '',
    '请根据下面的真实玩家现场找出根因并修复（仓库根目录的 AGENTS.md 记录了工程约定和历史踩坑，先读相关章节）。',
    '',
    `- 错误特征：${group.text}`,
    `- 次数：${group.count} 次，涉及 ${group.visits} 次访问；首次 ${group.firstSeen}，最近 ${group.lastSeen}（UTC）`,
    `- 游戏：${group.games.map((g) => `${g.title}（${g.slug}）×${g.count}`).join('、') || '—'}`,
    `- 浏览器：${counts(group.browsers)}`,
    `- 系统：${counts(group.os)}`,
    `- 地区：${counts(group.countries)}`,
    '',
    `## 最近 ${samples.length} 份现场`,
  ]
  samples.forEach((sample, i) => lines.push('', formatSample(sample, i)))
  return lines.join('\n')
}
