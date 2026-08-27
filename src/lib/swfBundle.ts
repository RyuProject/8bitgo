/**
 * Flash 多 SWF 游戏包：把一个 zip 理成「要上传哪些文件、哪个是主 SWF」。
 *
 * 为什么需要这个：当年的大型 Flash 游戏基本不是一个 swf 走天下，主文件在运行时
 * 用**相对路径**去拉同目录的其它 swf 和素材（`loadMovie('CG.swf')`、
 * `loadMovie('sound/1.swf')`）。比如《金庸群侠传3》一共五个 swf，root.swf 启动后
 * 立刻去拉 CG / UI / map / war，缺一个就卡在片头。
 *
 * 所以这类游戏没法按站里「一个游戏 = 一个对象」的老约定上传，得整包传到
 * **同一个目录**下，再把主 SWF 绑成 ROM。Ruffle 适配器加载远程 ROM 时会把 base
 * 设成该 URL 所在目录（见 emulator/adapters/ruffle.ts），相对路径正好解析得回来。
 *
 * 这个模块只做「理清楚」这件事，不碰网络；上传由 admin/swfUpload.ts 负责。
 */
import { listZipEntries, type ZipFileEntry } from './unzip'

export interface SwfBundleFile {
  /** 相对包目录的路径，上传时直接接在包目录后面 */
  path: string
  size: number
  entry: ZipFileEntry
  /** 默认是否上传 */
  include: boolean
  /** 默认不传的原因，显示给管理员看 */
  note?: string
}

export interface SwfBundlePlan {
  files: SwfBundleFile[]
  /** 猜出来的主 SWF（相对路径），后台可以改 */
  main: string
  /** 被剥掉的公共顶层目录；zip 里套了一层文件夹时不为空 */
  strippedRoot: string
}

/**
 * 一看就不该进 R2 的东西。
 *
 * 重点是 .exe —— 中文 Flash 游戏包里几乎必然躺着一个 Flash 投影播放器
 *（《金庸群侠传3》那个 root.exe 有 11 MB），网页端一个字节都用不上，
 * 传上去纯粹浪费流量和存储。
 */
const NOT_FOR_WEB = /\.(exe|dll|bat|cmd|com|msi|scr|lnk|url|rar|7z|zip|iso|dmg)$/i

/** 打包时顺手带进来的系统垃圾 */
const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i

/** 主文件的常见叫法，越靠前越像 */
const MAIN_NAMES = ['root.swf', 'main.swf', 'index.swf', 'game.swf', 'start.swf', 'play.swf', 'loader.swf', 'preloader.swf']

/**
 * 猜主 SWF。
 *
 * 判据按重要性排：名字和 slug 一样 > 是 root/main/index 这类常见主文件名 >
 * 越靠近包的根目录越可能是主文件（素材 swf 通常躺在 sound/、skill/ 这些子目录里）。
 * 猜错也不要紧 —— 后台面板上是个下拉框，管理员可以直接改。
 */
export function pickMainSwf(paths: string[], slug = ''): string {
  const swfs = paths.filter((p) => /\.swf$/i.test(p))
  if (swfs.length <= 1) return swfs[0] ?? ''
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1).toLowerCase()
  const score = (p: string) => {
    const b = base(p)
    let s = 0
    if (slug && b === `${slug.toLowerCase()}.swf`) s += 12
    const idx = MAIN_NAMES.indexOf(b)
    if (idx >= 0) s += 10 - idx
    s -= (p.split('/').length - 1) * 4
    s -= b.length * 0.02
    return s
  }
  return [...swfs].sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0]
}

/**
 * 剥掉公共顶层目录。
 *
 * 在 Finder / 资源管理器里右键压缩一个文件夹，包里就会多套一层
 *（`金庸群侠传3/root.swf`）。这一层要是留着，主 SWF 的 URL 会多一段目录，
 * 素材照样能对上（都在同一层），但对象 key 里多一截没意义的中文目录名，
 * 而且和「包目录 = 游戏 slug」的约定对不上。最多剥三层，防着有人套娃。
 */
function stripCommonRoot(names: string[]): { names: string[]; stripped: string } {
  let out = names
  const parts: string[] = []
  for (let i = 0; i < 3; i++) {
    const first = out[0]?.split('/')[0]
    if (!first || !out.every((n) => n.startsWith(`${first}/`))) break
    parts.push(first)
    out = out.map((n) => n.slice(first.length + 1))
  }
  return { names: out, stripped: parts.join('/') }
}

/** 把 zip 的条目列表理成一份上传计划 */
export function planSwfBundle(entries: ZipFileEntry[], slug = ''): SwfBundlePlan {
  const usable = entries.filter((e) => e.name && !e.name.endsWith('/') && !JUNK.test(e.name))
  const { names, stripped } = stripCommonRoot(usable.map((e) => e.name))
  const files: SwfBundleFile[] = usable
    .map((entry, i) => {
      const path = names[i]
      const skip = NOT_FOR_WEB.test(path)
      return {
        path,
        size: entry.uncompressedSize,
        entry,
        include: !skip,
        note: skip ? '网页里用不上（Flash 投影播放器 / 压缩包之类），默认不传' : undefined,
      }
    })
    .filter((f) => f.path)
    .sort((a, b) => a.path.localeCompare(b.path))
  return { files, main: pickMainSwf(files.filter((f) => f.include).map((f) => f.path), slug), strippedRoot: stripped }
}

/** 直接从 zip 文件内容理出上传计划 */
export function planSwfBundleFromZip(buf: ArrayBuffer, slug = ''): SwfBundlePlan {
  const entries = listZipEntries(buf)
  if (!entries.length) throw new Error('压缩包是空的，或者不是有效的 zip')
  return planSwfBundle(entries, slug)
}

/** 勾选上传的文件一共多少字节 */
export function bundleBytes(files: SwfBundleFile[]): number {
  return files.reduce((s, f) => (f.include ? s + f.size : s), 0)
}

/**
 * 上传前值得提醒管理员的几件事。
 *
 * 都不是硬错误（除了「一个 swf 都没有」），但每一条都对应一种「传上去玩不了」的现场：
 * 主文件不在包根目录时，同层素材的相对路径仍然对得上，可数据里那截目录名纯属噪音；
 * 非 ASCII 文件名要过一次 URL 编码，个别老 SWF 拼相对路径时会翻车。
 */
export function bundleWarnings(plan: SwfBundlePlan): string[] {
  const on = plan.files.filter((f) => f.include)
  const out: string[] = []
  if (!on.some((f) => /\.swf$/i.test(f.path))) out.push('这个包里没有 .swf 文件，Ruffle 跑不了')
  else if (!plan.main) out.push('还没选主 SWF')
  if (plan.main && plan.main.includes('/')) out.push(`主 SWF 在子目录 ${plan.main.slice(0, plan.main.lastIndexOf('/'))}/ 里，确认素材也在同一层`)
  const nonAscii = on.filter((f) => /[^\x20-\x7e]/.test(f.path)).map((f) => f.path)
  if (nonAscii.length) out.push(`${nonAscii.length} 个文件名含非 ASCII 字符（如 ${nonAscii[0]}），会以 URL 编码存放`)
  if (on.length > 300) out.push(`一共 ${on.length} 个文件，逐个 PUT 会比较久`)
  return out
}
