/**
 * 远程「外层 ZIP → 单个 ROM」的显式标记。
 *
 * 用 fragment 而不是查询串：#rom=... 只给本站选成员，浏览器不会把它发给文件站；
 * 普通 .zip（尤其街机 romset、DOS 游戏包）仍按原样交给核心，绝不能自动拆。
 * 外站不暴露 ETag 时可加 &v=版本号；管理员更新源文件时必须同步改 v，避免旧缓存复活。
 */
export interface RomArchiveRef {
  sourceUrl: string
  entry: string
  version: string
  name: string
  auto: boolean
}

/** `foo.nds.zip` 暗示解包后应是 `foo.nds`；缓存命中时也用这个稳定文件名。 */
export function impliedRomName(sourceUrl: string): string {
  const encoded = sourceUrl.split('?')[0].split('/').pop() ?? ''
  let outer: string
  try { outer = decodeURIComponent(encoded) } catch { outer = encoded }
  if (!/\.zip$/i.test(outer)) return ''
  const inner = outer.slice(0, -4)
  return /\.[a-z0-9]{2,6}$/i.test(inner) && !/\.zip$/i.test(inner) ? inner : ''
}

export function romArchiveRef(url: string): RomArchiveRef | null {
  const hashAt = url.indexOf('#')
  if (hashAt < 0) return null
  const params = new URLSearchParams(url.slice(hashAt + 1))
  if (!params.has('rom')) return null
  const entry = params.get('rom') ?? ''
  const version = params.get('romv') || params.get('v') || ''
  const sourceUrl = url.slice(0, hashAt)
  const auto = entry === 'auto'
  return { sourceUrl, entry, version, auto, name: auto ? impliedRomName(sourceUrl) : entry.split('/').pop() ?? '' }
}

export function assertRomArchiveRef(ref: RomArchiveRef): void {
  // 路径必须精确指向 ZIP 的一个成员；拒绝目录穿越与空段，免得后台的笔误选错文件。
  const { entry, version } = ref
  if (ref.auto) {
    if (!ref.name) throw new Error('自动识别需要类似 game.nds.zip 的外层文件名；否则请填写 ZIP 内文件名')
    if (version.length > 100) throw new Error('ZIP 缓存版本号过长')
    return
  }
  if (!entry || entry.length > 500 || entry.startsWith('/') || entry.includes('\\') ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f]/.test(entry) || entry.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('ZIP 内 ROM 路径无效：请填写压缩包内的相对文件名')
  }
  if (version.length > 100) throw new Error('ZIP 缓存版本号过长')
}
