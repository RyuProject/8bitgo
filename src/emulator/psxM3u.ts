/** PS1 多盘清单只允许同目录裸 CHD，避免路径穿越、跨源取盘或误把整盘下载到内存。 */
export const PSX_M3U_MAX_DISCS = 8
export const PSX_M3U_MAX_BYTES = 16 * 1024

export interface PsxM3uEntry {
  filename: string
  label: string
}

function validDiscName(value: string): boolean {
  return value.length > 4 && value.length <= 160 && /\.chd$/i.test(value) &&
    !/[\\/:?#|\u0000-\u001f\u007f]/.test(value) && value !== '.' && value !== '..' &&
    !value.startsWith('.') && value.trim() === value
}

/**
 * EmulatorJS / libretro 的 M3U 逐行解析；本站限定 2–8 张同目录 CHD。
 * 不接受注释、URL、子目录或盘符，避免核心打开了未版本化的任意地址。
 */
export function parsePsxM3u(text: string): PsxM3uEntry[] {
  if (typeof text !== 'string' || !text.length || new TextEncoder().encode(text).byteLength > PSX_M3U_MAX_BYTES) {
    throw new Error('PS1 多盘清单为空或超过 16KB')
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length < 2 || lines.length > PSX_M3U_MAX_DISCS) {
    throw new Error(`PS1 多盘清单必须包含 2–${PSX_M3U_MAX_DISCS} 张 CHD`)
  }
  const seen = new Set<string>()
  return lines.map((line, index) => {
    const filename = line
    if (!validDiscName(filename)) throw new Error(`PS1 第 ${index + 1} 张盘必须是同目录 CHD 文件名`)
    const identity = filename.toLocaleLowerCase()
    if (seen.has(identity)) throw new Error(`PS1 多盘清单重复引用了 ${filename}`)
    seen.add(identity)
    return { filename, label: `Disc ${index + 1}` }
  })
}

/** 生成不含 BOM / 注释的最小 M3U，兼容核心与 EmulatorJS 自己的盘片菜单。 */
export function buildPsxM3u(entries: readonly PsxM3uEntry[]): string {
  if (entries.length < 2 || entries.length > PSX_M3U_MAX_DISCS) throw new Error('PS1 多盘组必须有 2–8 张盘')
  const text = entries.map(({ filename }) => {
    if (!validDiscName(filename)) throw new Error(`无效的 PS1 CHD 文件名：${filename}`)
    // libretro 的 M3U 按每行原样打开路径；人类可读盘名已包含在安全生成的文件名中。
    return filename
  }).join('\n') + '\n'
  // 复用解析器，确保写出的清单没有重复盘和不安全路径。
  parsePsxM3u(text)
  return text
}

export function isPsxM3uUrl(value: string): boolean {
  try { return /\.m3u$/i.test(new URL(value, 'https://8bitgo.com/').pathname) }
  catch { return false }
}
