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
  /**
   * 玩家自己决定要不要加载（行首一个 `?`）。
   *
   * 资料片动辄几百 MB —— 《命令与征服》的隐秘行动就有 500 MB —— 不该让每个
   * 路过点开的人都先把它下一遍。所以大件标成可选，开始界面上给一个开关，默认不加载。
   * 补丁这类「不打就是另一个游戏」的必须保持强制，不给选。
   */
  optional: boolean
}

/** 播放器拿到的那一份：解析好的清单 + 已经算成可下载的地址 */
export interface DosExtraSource extends DosExtraRef {
  url: string
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

/**
 * 一行 → { key, path, optional }。空行 / 落点非法都返回 null。
 *
 * 行首的 `?` 是「可选」标记，必须在其它一切之前剥掉 —— 它后面才是 key。
 */
export function parseDosExtra(line: string): DosExtraRef | null {
  let raw = String(line ?? '').trim()
  const optional = raw.startsWith('?')
  if (optional) raw = raw.slice(1)
  const bar = raw.indexOf('|')
  const key = (bar < 0 ? raw : raw.slice(0, bar)).trim().replace(/^\/+/, '')
  if (!key) return null
  const path = (bar < 0 ? '' : normalizeExtraPath(raw.slice(bar + 1))) || defaultExtraPath(key)
  return path ? { key, path, optional } : null
}

export function parseDosExtras(lines: readonly string[] | undefined | null): DosExtraRef[] {
  const out: DosExtraRef[] = []
  for (const line of lines ?? []) {
    const ref = parseDosExtra(line)
    if (ref) out.push(ref)
  }
  return out
}

/** { key, path, optional } → 存回后台的一行。落点就是默认值时省掉后半段，别把噪音写进库 */
export function formatDosExtra(ref: DosExtraRef): string {
  const path = normalizeExtraPath(ref.path)
  const body = !path || path === defaultExtraPath(ref.key) ? ref.key : `${ref.key}|${path}`
  return ref.optional ? `?${body}` : body
}

/* ---------------- 后台上传时用的（放这里是为了能被测试直接 import） ---------------- */

/**
 * 路径的每一段都过一遍对象 key 的字符集。`/` 要留着 —— 子目录得跟着进存储。
 * 整段被滤空（比如中文文件名）时那一段就没了，调用方要判空。
 */
export function extraObjectName(path: string): string {
  return path
    .split('/')
    .map((seg) => seg.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .join('/')
}

/**
 * 从网上下下来的资料片压缩包里，哪些条目不该当成附加文件。
 *
 * ⚠️ `__MACOSX/` 和 `._xxx` 这两类必须滤掉：macOS 上重新压过的包一定带着它们，
 * 而它们会原样落进游戏目录。DOS 那边不认这种名字，轻则多几个垃圾文件，
 * 重则把 8.3 名空间搞乱 —— 而且没有任何提示。
 */
export function skipExtraEntry(name: string): boolean {
  if (!name || name.endsWith('/')) return true
  if (/^__MACOSX\//i.test(name)) return true
  return name.split('/').some((seg) => seg.startsWith('.'))
}

/** 8.3：DOS 真正认得的名字。和 jsdosBundle 里那条同源，这里只用来给后台提示 */
const DOS_83 = /^[A-Za-z0-9_^$~!#%&{}@'()-]{1,8}(\.[A-Za-z0-9_^$~!#%&{}@'()-]{1,3})?$/

/**
 * 这个落点拿到 DOS 里会不会出事。后台上传时提前说出来，别等玩家进游戏才发现。
 *
 * 分两档，因为严重程度差得远：
 *   blocking —— 名字里有非 ASCII / 空格之类。它既进不了对象 key（会被滤成 `.MIX`
 *     这种一碰就撞的名字），在 FAT 盘上也是一团乱码，**必须先改名**。
 *   非 blocking —— 只是不合 8.3。DOSBox 会给它编一个 8.3 别名，
 *     所以文件在盘上；但游戏内部如果按原名去找就读不到。这种只提醒，不拦 ——
 *     确实有包用长名字，而且拦掉的代价（功能完全用不了）比读不到大。
 */
export function extraPathProblem(path: string): { blocking: boolean; text: string } | null {
  const p = normalizeExtraPath(path)
  if (!p) return { blocking: true, text: `「${path}」不是合法的路径` }
  const segments = p.split('/')
  const bad = segments.find((seg) => !/^[A-Za-z0-9_^$~!#%&{}@'().-]+$/.test(seg))
  if (bad) {
    return {
      blocking: true,
      text: `「${p}」里的「${bad}」含有 DOS 认不了的字符（中文、空格等）。请先把文件改成英文名再上传。`,
    }
  }
  const notDos = segments.find((seg) => !DOS_83.test(seg))
  if (notDos) {
    return {
      blocking: false,
      text: `「${p}」里的「${notDos}」不是 DOS 的 8.3 短名（最多 8 个字符 + 3 位扩展名）。文件会进游戏目录，但游戏按原名找可能读不到。`,
    }
  }
  return null
}
