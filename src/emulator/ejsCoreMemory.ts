/**
 * EmulatorJS 核心在 WASM memory section 里声明的起步内存，以及开局前的同规格分配预检。
 *
 * 为什么要预检：V8 实例化核心时要一次性提交起步页数那么多的内存；分配不出来就是
 * `Out of memory: Cannot allocate Wasm memory for new instance`。而引擎是在**我们把 ROM 下完、解完之后**
 * 才去实例化核心的 —— 2026-11-16 大陆 3G 玩家先下了 15 分钟 358MB 的 PS1 镜像，才在实例化这一步失败
 * （诊断包 #780，见 psxLowmem.ts）。`new WebAssembly.Memory` 和实例化走的是同一条分配路径
 * （V8 的 WasmMemoryObject::New，失败前同样会先做一轮 GC 再重试），所以用相同的起步 / 上限页数
 * 先建一块、马上丢掉引用，就能在下载前知道这一刻给不给得出来。
 *
 * 只对起步 ≥ 256 MiB 的核心做：其余核心起步 128 MiB 以下，预检省下的时间抵不上多分配一次的代价。
 * 表里的数字由 test:psx-lowmem 对着 public/emulatorjs/cores 里的真实 WASM 逐个核对，换核心后表跟着改。
 */

export const WASM_PAGE_BYTES = 64 * 1024
/** 上面这些核心的上限都是 32768 页（2 GiB，Emscripten ALLOW_MEMORY_GROWTH 的默认上限） */
export const EJS_CORE_MAXIMUM_PAGES = 32768
/** 预检门槛：起步低于它的核心不预检 */
export const PREFLIGHT_MIN_INITIAL_PAGES = 4096

/** 核心文件名（不含 -wasm.data） → 起步页数；只收起步 ≥ 256 MiB 的核心 */
export const EJS_LARGE_CORE_INITIAL_PAGES: Readonly<Record<string, number>> = Object.freeze({
  genesis_plus_gx: 8192,
  mednafen_psx: 8192,
  mednafen_psx_hw: 8192,
  mupen64plus_next: 8192,
  pcsx_rearmed: 8192,
  picodrive: 8192,
})

/** 这个核心开局前要不要做分配预检；要的话返回它的起步页数。 */
export function preflightPagesFor(coreFile: string): number | null {
  const pages = EJS_LARGE_CORE_INITIAL_PAGES[coreFile]
  return pages !== undefined && pages >= PREFLIGHT_MIN_INITIAL_PAGES ? pages : null
}

/**
 * 能不能按核心的声明新建一块 WASM 内存。建出来的立即丢掉引用：真正实例化时 V8 分配失败会先做一轮
 * 关键级 GC 再重试，这块空内存会在那时被回收，不会和核心抢地址空间。
 * 浏览器不支持 WebAssembly 时返回 null（交给原有的 browserNoWasm 提示）。
 */
export function canAllocateWasmMemory(
  initialPages: number,
  maximumPages: number = EJS_CORE_MAXIMUM_PAGES,
  memoryCtor: (typeof WebAssembly)['Memory'] | null = typeof WebAssembly === 'undefined' ? null : WebAssembly.Memory,
): boolean | null {
  if (typeof memoryCtor !== 'function') return null
  try {
    // eslint-disable-next-line no-new
    new memoryCtor({ initial: initialPages, maximum: maximumPages })
    return true
  } catch {
    return false
  }
}
