/**
 * React 侧接入「坏 chunk 自修复」（public/assets/asset-repair-v2.js）。
 *
 * 2026-11-15 PK / TH 两位玩家打开详情页就崩：
 * `SyntaxError: The requested module './live-Cqhc9j-k.js' does not provide an export named 'x'`。
 * 源站那份 live-Cqhc9j-k.js 明明导出了 x，同一构建两次打出的产物逐字节相同，改导出名也会换文件名 ——
 * 所以是浏览器手里那份内容和源站不一样（某一跳缓存给了别的字节）。文件名带内容哈希、一年 immutable，
 * 普通刷新不会重新取它，只会原样再崩一次。
 *
 * 修复逻辑不放在这个 bundle 里：bundle 自己坏了时它也跑不起来。首页内联钩子定义
 * `window.__8bitgoAssetRepair`，出错时才从入口脚本所在资源域加载那份独立脚本；这里只负责调用和把结果写进诊断包。
 */

/** 各家浏览器的措辞：Chrome / Firefox / Safari */
const LINK_ERROR_PATTERNS: readonly RegExp[] = [
  /The requested module ['"]([^'"]+)['"] does not provide an export named ['"]([^'"]+)['"]/,
  /import not found: (\S+)/,
  /Importing binding name ['"]([^'"]+)['"] is not found/,
]

export interface ModuleLinkFailure {
  /** 出错的模块（相对 import 的写法，例如 ./live-Cqhc9j-k.js）；Firefox / Safari 不给 */
  specifier: string | null
  /** 缺的导出名 */
  exportName: string
}

export function moduleLinkFailure(message: string): ModuleLinkFailure | null {
  const chrome = LINK_ERROR_PATTERNS[0].exec(message)
  if (chrome) return { specifier: chrome[1], exportName: chrome[2] }
  for (const pattern of LINK_ERROR_PATTERNS.slice(1)) {
    const hit = pattern.exec(message)
    if (hit) return { specifier: null, exportName: hit[1] }
  }
  return null
}

/** 相对 import 以入口脚本所在目录为基准（大陆入口是 cn.8bitgo.com/_cn/assets/）。 */
export function resolveChunkUrl(specifier: string, entrySrc: string): string | null {
  if (!/^\.\.?\/[\w.-]+\.js$/.test(specifier) || !entrySrc) return null
  try {
    return new URL(specifier, entrySrc).href
  } catch {
    return null
  }
}

/** 与 public/assets/asset-repair-v2.js 的返回值一致 */
export interface AssetRepairResult {
  manifest: boolean
  checked: number
  ok: number
  /** 浏览器缓存里那份坏了，绕过缓存重取后对上了 */
  repaired: string[]
  /** 错误点名的文件，缓存里那份看着没问题，仍强制重取覆盖了一遍 */
  refreshed: string[]
  /** CDN 边缘那份就是坏的：改用回源地址（下次开页由 import map 生效），并已通知服务端清边缘缓存 */
  remapped: string[]
  /** 回源那份也对不上：多半是部署本身的问题 */
  bad: string[]
  /** 取不下来（网络 / HTTP 错误） */
  failed: string[]
  reloaded: boolean
  ms: number
}

interface RepairOptions {
  reason: string
  urls: string[]
}

type RepairHook = (opts: RepairOptions & { reload: boolean }) => Promise<AssetRepairResult | null>

const REPAIR_TIMEOUT_MS = 20_000

/**
 * 调首页内联钩子；钩子不在（旧模板、SSR 外的嵌入页）返回 null，调用方退回原来的处理。
 * 刷新由调用方决定（reload: false）：要先把诊断包发出去。
 */
export function repairAssets(opts: RepairOptions): Promise<AssetRepairResult | null> | null {
  const hook = typeof window === 'undefined'
    ? undefined
    : (window as unknown as { __8bitgoAssetRepair?: RepairHook }).__8bitgoAssetRepair
  if (typeof hook !== 'function') return null
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), REPAIR_TIMEOUT_MS) })
  const run = Promise.resolve()
    .then(() => hook({ ...opts, reload: false }))
    .catch(() => null)
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer))
}

export function repairFixedSomething(result: AssetRepairResult | null): boolean {
  return Boolean(result && result.repaired.length + result.refreshed.length + result.remapped.length > 0)
}

/** 写进诊断包的一行：后台按这行就分得清「浏览器缓存坏了」「CDN 边缘坏了」「源站就是坏的」 */
export function summarizeRepair(result: AssetRepairResult | null): string {
  if (!result) return '资源核对：修复脚本没有运行（加载失败或超时）'
  const list = (names: string[]) => names.slice(0, 4).join('、') + (names.length > 4 ? ` 等 ${names.length} 个` : '')
  const parts = [`资源核对：${result.manifest ? '有' : '没有'}校验清单，查了 ${result.checked} 个，${result.ok} 个正常`]
  if (result.repaired.length) parts.push(`浏览器缓存里的坏副本已重取：${list(result.repaired)}`)
  if (result.refreshed.length) parts.push(`已强制重取：${list(result.refreshed)}`)
  if (result.remapped.length) parts.push(`CDN 边缘副本是坏的，已改走回源地址并请求清缓存：${list(result.remapped)}`)
  if (result.bad.length) parts.push(`回源也对不上：${list(result.bad)}`)
  if (result.failed.length) parts.push(`取不下来：${list(result.failed)}`)
  parts.push(`${result.ms}ms`)
  return parts.join('；')
}
