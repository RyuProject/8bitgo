/**
 * 往 Emscripten 虚拟文件系统里写文件之前，把父目录一级一级建出来。
 *
 * ── 为什么必须显式建 ─────────────────────────────────────────
 * `FS.writeFile` **不会**创建中间目录：父目录不存在时它直接抛 ENOENT。
 * 2026-09-20 在真实引擎里实测过这一条（本地测试页，mame-current）：
 *
 *   fs.writeFile('/nodir_test/x.zip', …)  →  抛错 ENOENT
 *   fs.mkdir('/nodir_test') 之后同一个调用  →  成功
 *
 * ── 它为什么会变成致命缺陷 ───────────────────────────────────
 * 调用方（`emulatorjs.ts` 的 installFsInjector）用**一个 try 包住整个注入循环**，
 * 所以一条写失败会连带后面所有注入都不写，而回报只有一句笼统的注入失败。
 *
 * mame-current 就正好踩在这里：它的内容必须待在 `/roms`（核心拿父目录当 rompath
 * 和 system dir，实测 `GET_SYSTEM_DIRECTORY: "/roms"`），于是 BIOS 也要写进 `/roms`；
 * 而 `/roms` 是 `relocateMameRom` 才建的，注入却跑在它**之前**。
 * blob 游戏那条路 `/roms` 会被引擎写 ROM 时顺带建出来（引擎自己那段 writeFile 建目录），
 * **直链游戏**那条路引擎把 ROM 写在根目录 —— `/roms` 根本还不存在，BIOS 一条都写不进去。
 * 症状是 Neo Geo / PGM 报「缺文件」，而文件**看上去确实写进去了**。
 *
 * 抽成独立模块是为了能在 node 里测（`npm run test:fs-write`）：
 * 这段逻辑在引擎启动流程里没法复现，而它失败起来是静的。
 */

/** 只需要 mkdir —— 调用方那边是 Emscripten 的 FS，这里不想把它的类型拖进来 */
export interface MutableDirFs {
  mkdir?: (path: string) => void
}

/**
 * 把 `target` 的父目录逐级建出来（已存在的当没事）。
 *
 * - `target` 没有父目录（`/x.zip`、`x.zip`）时什么都不做；
 * - 每一级单独 mkdir：Emscripten 的 `mkdir` 是**非递归**的，一次 `mkdir('/a/b')`
 *   在 `/a` 不存在时照样抛 ENOENT；
 * - mkdir 抛错一律吞掉：EEXIST 是正常情况（目录已在那儿），其它错误也不该
 *   在这一步把调用方带崩 —— 真正写不进去时，后面的 writeFile 会自己报。
 */
export function ensureParentDir(fs: MutableDirFs, target: string): void {
  const cut = target.lastIndexOf('/')
  // cut === -1：没有斜杠；cut === 0：写在根目录下（'/x.zip' 的父目录就是根）
  if (cut <= 0) return
  let acc = ''
  for (const segment of target.slice(0, cut).split('/')) {
    if (!segment) continue
    acc += `/${segment}`
    try {
      fs.mkdir?.(acc)
    } catch {
      /* 目录已存在（EEXIST）或这个 FS 不支持建目录：交给后面的 writeFile 报 */
    }
  }
}
