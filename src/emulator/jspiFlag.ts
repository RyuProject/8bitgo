/**
 * 让 js-dos 用 JSPI 版的 dosbox-X。
 *
 * ── 为什么值得 ────────────────────────────────────────────
 * 另一条路是 Asyncify：靠**改写整个 wasm**、手工保存/恢复调用栈来实现阻塞调用，
 * 开销摊在每一次函数调用上 —— 正是 DOSBox 这种热循环最吃亏的地方。
 * JSPI（`WebAssembly.promising`）是浏览器原生支持，不用改写代码。
 * js-dos 两份都发了：`wdosbox-x.wasm`（Asyncify）和 `wdosbox-x-jspi.wasm`。
 *
 * ── 为什么只能走 localStorage ──────────────────────────────
 * js-dos 8.4.1 的 store 在**模块求值时**就把开关读死了：
 *
 *     jspi: "true" === localStorage.getItem("jspi") && typeof WebAssembly.promising === "function"
 *
 * 而它认的 `Dos()` options 键里没有 jspi（只有 pathPrefix / url / dosboxConf / initFs …），
 * 也就是说**没有任何参数能覆盖它**。所以只能在 `<script>` 插进去**之前**把这个 key 写好。
 * 这也正是 js-dos 自己设置面板里那个 JSPI 勾选框做的事。
 *
 * ── 影响面 ────────────────────────────────────────────────
 * js-dos 挑后端的那一行是字符串拼出来的：
 *
 *     let u = "dosbox"
 *     if ("dosboxX" === backend) { u = "dosboxX"; jspi && (u += "Jspi") }
 *     emulators[u + (worker ? "Worker" : "Direct")](…)
 *
 * `backend: 'dosbox'`（纯 DOS）那条路**永远拼不出 Jspi**，所以这个开关对纯 DOS 游戏
 * 没有任何影响 —— 它也确实没有 jspi 版的 wasm。只影响 Win 3.x / 95 / 98。
 */

/** 浏览器认不认 JSPI */
export function jspiSupported(): boolean {
  const wasm = (globalThis as { WebAssembly?: { promising?: unknown } }).WebAssembly
  return typeof wasm?.promising === 'function'
}

/**
 * 从查询串里读人工开关，用来在**同一台机器**上 A/B：
 *   ?jspi=1 / on / true   → 强制开（浏览器不支持时仍然是关，不然 js-dos 会弹 alert）
 *   ?jspi=0 / off / false → 强制关
 * 其它情况返回 null = 按浏览器支持情况自动决定。
 *
 * 这一条不是锦上添花：JSPI 的收益必须实测，而「换台机器换个浏览器再比」是量不出东西的。
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
 * 在加载 js-dos.js **之前**调用。返回这一局实际会不会用 JSPI。
 *
 * ⚠️ 不支持时要**明确写 'false'**，不能只是不写：这个 key 留在玩家本地，
 * 以前开过（或者 js-dos 自己的设置面板写过）的话会一直留着，
 * 而 js-dos 的 dosJspi 动作在不支持的浏览器上会 `alert()` 一句英文报错弹窗。
 */
export function armJspi(search = typeof location === 'undefined' ? '' : location.search): boolean {
  const forced = jspiOverride(search)
  const on = forced === null ? jspiSupported() : forced && jspiSupported()
  try {
    localStorage.setItem('jspi', on ? 'true' : 'false')
  } catch {
    // 无痕 / 禁用站点数据：js-dos 读不到就按默认（关）走，不影响能不能玩
  }
  return on
}
