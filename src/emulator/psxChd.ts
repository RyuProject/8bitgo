/** HW 版在浏览器会触发 WASM 表陷阱；实机验证通过的软件版保留 CHD 能力且不整盘预缓存。 */
export const PSX_CHD_CORE = 'mednafen_psx'
/** 此核心走引擎的 legacy 分支；预热同一份文件，避免悬停和开局各下载一遍。 */
export const PSX_CHD_ARCHIVE = 'mednafen_psx-legacy-wasm.data'
/** Beetle 比默认 PCSX 重；多留 64ms 音频队列吸收短时主线程抖动，代价是音画延迟。 */
export const PSX_CHD_AUDIO_LATENCY_MS = 128
const PSX_CHD_SAVE_SUFFIX = ':beetle-soft-chd'
const PSX_CHD_OLD_SAVE_SUFFIX = ':beetle-chd'

function pathWithoutQuery(value: string): string {
  const path = String(value || '').split(/[?#]/, 1)[0]
  try { return decodeURIComponent(path) } catch { return path }
}

/** 上传时可包 8BG；这只影响下载/续传判断，不代表核心能直接读取外层容器。 */
export function isPsxChdTransfer(value: string): boolean {
  return /\.chd(?:\.8bg)?$/i.test(pathWithoutQuery(value))
}

/**
 * 自建 Beetle（mednafen_psx）链接的 libchdr **只编进了 zlib / LZMA**：wasm 里只有
 * `cdzl (CD Deflate)` 与 `cdlz (CD LZMA)` 两个 CD 编解码器，没有 `cdfl (CD FLAC)`、`cdzs`。
 * 而 chdman createcd 的默认压缩是 cdlz + cdzl + **cdfl**，带音轨的盘几乎必然用到 FLAC。
 * libchdr 在 chd_open 时就为头里列出的**每一个**压缩器建解码器，缺一个整盘打不开，
 * Beetle 只打一句 `TOC first(99)/last(0) track numbers bad.`，RetroArch 随后停在
 * 「Quick Menu / No Items」—— 2026-10-25 线上全部 5 款 PS1 CHD（含 Range 流式的
 * 实况胜利十一人 2000）都是这样，玩家看到的是一个空菜单，没有任何报错。
 *
 * PCSX ReARMed（站点默认 PS1 核心）的 wasm 带全部四种 CD 编解码器，实测能按需读取
 * Range 挂载的 CHD（不整盘预缓存），所以头里有 Beetle 不认识的压缩器时改走它。
 */
export const PSX_CHD_COMPAT_CORE = 'pcsx_rearmed'
const BEETLE_CHD_CODECS: ReadonlySet<string> = new Set(['cdzl', 'cdlz', 'zlib', 'lzma', 'huff'])

/**
 * 读 CHD v5 头里的压缩器（偏移 16 起 4 个四字符标签，全 0 表示该槽为空）。
 * 不是 CHD v5 或字节不够时返回 null（= 不知道）。
 */
export function chdCompressors(head: Uint8Array | null | undefined): string[] | null {
  if (!head || head.length < 32) return null
  if (String.fromCharCode(...head.subarray(0, 8)) !== 'MComprHD') return null
  const version = ((head[12] << 24) | (head[13] << 16) | (head[14] << 8) | head[15]) >>> 0
  if (version !== 5) return null
  const codecs: string[] = []
  for (let at = 16; at < 32; at += 4) {
    const tag = head.subarray(at, at + 4)
    if (tag.every((b) => b === 0)) continue
    codecs.push(String.fromCharCode(...tag))
  }
  return codecs
}

/**
 * CHD 该交给哪个核心：头里的压缩器 Beetle 全都认识 → 实机验证过的 Beetle 软件核心；
 * 有它不认识的（cdfl / cdzs …）或读不出头 → 编解码器齐全的 PCSX ReARMed。
 */
export function psxChdCoreForCodecs(codecs: readonly string[] | null | undefined): string {
  return codecs && codecs.every((codec) => BEETLE_CHD_CODECS.has(codec)) ? PSX_CHD_CORE : PSX_CHD_COMPAT_CORE
}

/**
 * 悬停 / 开局预热只能看到传输地址，还读不到 CHD 头。站内现有 CHD 都是 chdman 默认压缩
 * （带 cdfl），实际会落到 PCSX，所以预拉它；服务端转出的纯 cdzl 盘会多拉约 1MB 的 PCSX。
 */
export function psxCoreForTransfer(platform: string, core: string | null | undefined, url: string): string | null | undefined {
  // 多盘 M3U 会在虚拟文件系统里同时挂载多张 CHD；PCSX 的 CD 解码器覆盖全部本站支持的压缩格式。
  if (platform === 'psx' && /\.m3u(?:[?#]|$)/i.test(url)) return PSX_CHD_COMPAT_CORE
  return platform === 'psx' && isPsxChdTransfer(url) ? PSX_CHD_COMPAT_CORE : core
}

/**
 * 必须在 8BG 解包后用真正的内层文件名判断，不能把一个伪装成 CHD 的 ISO 交错核心；
 * 是 CHD 时再按头里的压缩器挑核心（见 psxChdCoreForCodecs）。
 */
export function psxCoreForPreparedName(platform: string, core: string, name: string, head?: Uint8Array | null): string {
  if (platform !== 'psx' || !/\.chd$/i.test(pathWithoutQuery(name))) return core
  return psxChdCoreForCodecs(chdCompressors(head))
}

/** 软件版与旧 HW 版快照不混用，避免 ABI/渲染状态差异损坏既有存档。 */
export function psxChdSaveSlug(gameSlug: string, transferUrl: string): string {
  return gameSlug.startsWith('local:') || !isPsxChdTransfer(transferUrl)
    ? gameSlug
    : `${gameSlug}${PSX_CHD_SAVE_SUFFIX}`
}

/** 个人页只用基础 slug 查游戏；云端实际存档键仍保留完整后缀。 */
export function parsePsxChdSaveSlug(value: string): string {
  if (value.startsWith('local:')) return value
  const suffix = [PSX_CHD_SAVE_SUFFIX, PSX_CHD_OLD_SAVE_SUFFIX].find(item => value.endsWith(item))
  return suffix ? value.slice(0, -suffix.length) : value
}
