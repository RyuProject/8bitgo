/**
 * DOS 附加文件（扩展包 / 补丁 / 配置）的清单解析。
 *
 * 站长 2026-09-11：给一款已经上线的 DOS 游戏加资料片（《命令与征服》的隐秘行动 SC-002.MIX），
 * 要求「在后台就能解决」—— 上传游戏的常常是运维，不会 cd / curl / unzip，
 * 更不该为了一个 1 MB 的资料片重打一份 17 MB 的 ROM 再全站刷缓存。
 *
 * 所以后台只存一份清单，一行一个附加文件，形状是：
 *   `对象key`            —— 落到游戏根目录，文件名取 key 的最后一段
 *   `对象key|游戏里的路径` —— 需要落进子目录时才写后半段
 * 播放器加载时把它们并进游戏 ZIP（见 lib/jsdosBundle.ts 的 mergeExtraFiles），
 * 仓库里的 ROM 一个字节都不动。
 */
export interface DosExtraRef {
  /** ROM 存储里的对象 key（也接受站内路径 / 完整 URL，和 dosSystem 一致） */
  key: string
  /** 并进游戏 ZIP 之后的相对路径 */
  path: string
}

/** 路径里一段都不能是空 / . / ..，也不收控制字符 —— 这个值最终会变成 ZIP 里的路径 */
export function normalizeExtraPath(v: string | undefined | null): string {
  const s = String(v ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  if (!s || s.length > 200 || s.endsWith('/')) return ''
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(s)) return ''
  return s.split('/').some((seg) => !seg || seg === '.' || seg === '..') ? '' : s
}

/**
 * 没写落点时的默认落点：对象 key 的最后一段，放在游戏根目录。
 *
 * 绝大多数资料片和补丁就是这么装的 —— 和本体的 .MIX / .DAT 躺在同一层。
 * 先切掉 ?query#hash，是因为这个字段也允许直接填完整 URL。
 */
export function defaultExtraPath(key: string): string {
  const noQuery = String(key ?? '').split(/[?#]/)[0]
  return normalizeExtraPath(noQuery.replace(/\/+$/, '').split('/').pop() ?? '')
}

/** 一行 → { key, path }。空行 / 落点非法都返回 null */
export function parseDosExtra(line: string): DosExtraRef | null {
  const raw = String(line ?? '')
  const bar = raw.indexOf('|')
  const key = (bar < 0 ? raw : raw.slice(0, bar)).trim().replace(/^\/+/, '')
  if (!key) return null
  const path = (bar < 0 ? '' : normalizeExtraPath(raw.slice(bar + 1))) || defaultExtraPath(key)
  return path ? { key, path } : null
}

export function parseDosExtras(lines: readonly string[] | undefined | null): DosExtraRef[] {
  const out: DosExtraRef[] = []
  for (const line of lines ?? []) {
    const ref = parseDosExtra(line)
    if (ref) out.push(ref)
  }
  return out
}

/** { key, path } → 存回后台的一行。落点就是默认值时省掉后半段，别把噪音写进库 */
export function formatDosExtra(ref: DosExtraRef): string {
  const path = normalizeExtraPath(ref.path)
  return !path || path === defaultExtraPath(ref.key) ? ref.key : `${ref.key}|${path}`
}
