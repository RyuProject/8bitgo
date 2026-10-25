/**
 * js-dos 的 DOSBox-X 用哪一份 wasm：Asyncify（`wdosbox-x.wasm`）还是 JSPI（`wdosbox-x-jspi.wasm`）。
 *
 * ── js-dos 从哪里读这个开关 ────────────────────────────────
 * js-dos 8.5 的 store 在**模块求值时**读一次，之后没有任何 `Dos()` 参数能改它：
 *
 *     jspi: "true" === $r.getItem("jspi") && "function" == typeof WebAssembly.promising
 *
 * ⚠️ `$r` **不是** localStorage，而是带前缀的包装（`new class{…}(void 0, "jsdos.8.")`），
 * 真正的键是 `jsdos.8.jspi`。2026-10-26 以前这里一直写裸键 `jspi`：js-dos 从没读到过，
 * 线上所有 Win9x / DOSBox-X 会话其实一直跑 Asyncify；而悬停预热却按「会用 JSPI」去拉
 * `wdosbox-x-jspi.wasm`，每次冷启动都白下一份 7.9MB（gzip 后约 2.7MB）核心，真正要用的
 * `wdosbox-x.wasm` 反倒排在系统盘和游戏包**之后**才开始下载，正好压在开局关键路径上。
 *
 * ── 默认为什么是 Asyncify ──────────────────────────────────
 * 站上所有 Windows / DOSBox-X 游戏（帝国时代、星际争霸、凯撒 3、天之痕、辐射……）的兼容性
 * 都是在 Asyncify 上验收的；同机 A/B 实测《帝国时代》从点击到主菜单两者都在 12～13 秒，
 * JSPI 没有可见收益。所以默认保持已验收的那一份，`?jspi=1` 仍可在同一台机器上做对照。
 * 预热器与正式开局共用 jspiEnabled()，两边永远拉同一份核心。
 *
 * ── 影响面 ────────────────────────────────────────────────
 * js-dos 挑后端的那一行是字符串拼出来的：
 *
 *     let h = "dosbox"
 *     if ("dosboxX" === backend) { h = "dosboxX"; jspi && (h += "Jspi") }
 *     emulators[h + (worker ? "Worker" : "Direct")](…)
 *
 * `backend: 'dosbox'`（纯 DOS）那条路**永远拼不出 Jspi**，所以这个开关只影响 DOSBox-X
 * （Win 3.x / 95 / 98、PC-98、静态 Sockdrive）。
 */

/** js-dos 8 的 localStorage 前缀 + 键名。换 js-dos 大版本时 test:jspi 会对着运行时校验它。 */
export const JSDOS_STORAGE_PREFIX = 'jsdos.8.'
export const JSDOS_JSPI_STORAGE_KEY = `${JSDOS_STORAGE_PREFIX}jspi`
/** 旧代码误写的裸键；js-dos 从不读它，清掉免得误导排查。 */
const LEGACY_JSPI_KEY = 'jspi'

/** 浏览器认不认 JSPI */
export function jspiSupported(): boolean {
  const wasm = (globalThis as { WebAssembly?: { promising?: unknown } }).WebAssembly
  return typeof wasm?.promising === 'function'
}

/**
 * 从查询串里读人工开关，用来在**同一台机器**上 A/B：
 *   ?jspi=1 / on / true   → 强制开（浏览器不支持时仍然是关，不然 js-dos 会弹 alert）
 *   ?jspi=0 / off / false → 强制关
 * 其它情况返回 null = 用默认（Asyncify）。
 */
export function jspiOverride(search: string): boolean | null {
  let value: string | null = null
  try {
    value = new URLSearchParams(search).get('jspi')
  } catch {
    return null
  }
  if (value === null) return null
  const v = value.trim().toLowerCase()
  if (v === '1' || v === 'on' || v === 'true') return true
  if (v === '0' || v === 'off' || v === 'false') return false
  return null
}

/**
 * 算出这一局最终会不会选 JSPI，但不碰 localStorage。
 *
 * 预热器要用同一份判断去选 `wdosbox-x-jspi.wasm` / `wdosbox-x.wasm`；若在那里
 * 另抄一遍条件，两边一旦分叉就会在悬停时白下 7.9 MB，真正开局还得再下一套。
 */
export function jspiEnabled(search = typeof location === 'undefined' ? '' : location.search): boolean {
  return jspiOverride(search) === true && jspiSupported()
}

/**
 * 在加载 js-dos.js **之前**调用。返回这一局实际会不会用 JSPI。
 *
 * ⚠️ 关的时候也要**明确写 'false'**：js-dos 自己的设置面板会往同一个键写 'true'，
 * 留在玩家本地就会悄悄换成未验收的那份核心，且预热永远拉错文件。
 */
export function armJspi(search = typeof location === 'undefined' ? '' : location.search): boolean {
  const on = jspiEnabled(search)
  try {
    localStorage.setItem(JSDOS_JSPI_STORAGE_KEY, on ? 'true' : 'false')
  } catch {
    // 无痕 / 禁用站点数据：js-dos 读不到就按默认（关）走，正好与预热一致
  }
  try {
    localStorage.removeItem?.(LEGACY_JSPI_KEY)
  } catch {
    /* 清理旧键失败不影响开局 */
  }
  return on
}
