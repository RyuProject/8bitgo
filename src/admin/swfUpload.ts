/**
 * 把一个 Flash 多 SWF 包整包传到 R2 的同一个目录下。
 *
 * 单文件 ROM 是「一次 PUT 完事」，多 SWF 包得逐个文件 PUT ——
 * Worker 那边一个 key 一个对象，没有「上传整个目录」这种接口。所以这里做三件事：
 *   1. 传之前看目录里有没有旧文件，有就问一句（重传同一个包属于原地覆盖，很正常；
 *      但传成了另一个包就会两份混在一起，谁也跑不起来）
 *   2. 逐个解压 + 上传，把整体进度按字节算出来给界面
 *   3. 传完清理「这次没传、上次留下的」孤儿文件 —— 版本换了、文件改名了都会留下这种
 *
 * 界面上的确认弹窗留在这里而不是组件里：和 uploadGuards.ts 一个路数，
 * 上传相关的守卫集中在一处，组件只管画。
 */
import { extractZipEntry } from '@/lib/unzip'
import type { SwfBundleFile } from '@/lib/swfBundle'
import { deleteRom, listRomDir, uploadRom } from '@/services/roms'
import { human } from './uploadGuards'

export interface BundleUploadProgress {
  /** 已经传完的文件数 */
  done: number
  total: number
  /** 正在传的那个（相对包目录的路径） */
  path: string
  /** 整体百分比，按字节算 —— 按文件数算的话 10MB 的 war.swf 和 2KB 的配置文件一样重 */
  pct: number
}

export interface BundleUploadResult {
  /** 要绑到游戏上的主 SWF 的 key */
  mainKey: string
  keys: string[]
  bytes: number
  /** 顺手清掉的孤儿文件 */
  removed: string[]
}

/** 传一个文件，失败重试一次 —— 几十个文件里偶发一个网络抖动就整包失败太脆了 */
async function putOnce(blob: Blob, key: string, onPct: (p: number) => void) {
  try {
    return await uploadRom(blob, key, onPct)
  } catch (err) {
    // 口令 / 地址不对这类问题重试多少次都一样，直接抛
    if (err instanceof Error && /被拒绝|不可用|尚未配置/.test(err.message)) throw err
    return await uploadRom(blob, key, onPct)
  }
}

/**
 * 整包上传。返回 null 表示管理员在确认弹窗里选了取消。
 *
 * @param zip   压缩包的完整内容（解压是逐个文件现解的，不会一次性把整包展开在内存里）
 * @param files 上传计划里的文件（只传 include 为 true 的）
 * @param main  主 SWF 的相对路径
 * @param dir   包目录的对象 key 前缀，如 roms/flash/jyqx3
 */
export async function uploadSwfBundle({
  zip,
  files,
  main,
  dir,
  onProgress,
}: {
  zip: ArrayBuffer
  files: SwfBundleFile[]
  main: string
  dir: string
  onProgress?: (p: BundleUploadProgress) => void
}): Promise<BundleUploadResult | null> {
  const picked = files.filter((f) => f.include)
  if (!picked.length) throw new Error('一个文件都没勾选')
  if (!main) throw new Error('还没选主 SWF')
  if (!picked.some((f) => f.path === main)) throw new Error(`主 SWF ${main} 没有被勾选上传`)

  const base = dir.replace(/\/+$/, '')
  const keyOf = (path: string) => `${base}/${path}`

  // 探测失败（Worker 不通）不该把上传堵死，和 uploadGuards 里一个态度
  const existing = await listRomDir(base).catch(() => [])
  if (existing.length) {
    const incoming = new Set(picked.map((f) => keyOf(f.path)))
    const stale = existing.filter((o) => !incoming.has(o.key))
    const ok = window.confirm(
      `${base}/\n\n这个目录里已经有 ${existing.length} 个文件（${human(existing.reduce((s, o) => s + o.size, 0))}）。\n` +
        `继续会用新包里的 ${picked.length} 个文件覆盖同名的那些` +
        (stale.length ? `，另外 ${stale.length} 个新包里没有的文件会在传完后询问是否删除` : '') +
        '。\n\n继续吗？',
    )
    if (!ok) return null
  }

  const totalBytes = picked.reduce((s, f) => s + f.size, 0) || 1
  const keys: string[] = []
  let doneBytes = 0

  for (let i = 0; i < picked.length; i++) {
    const f = picked[i]
    const key = keyOf(f.path)
    onProgress?.({ done: i, total: picked.length, path: f.path, pct: Math.round((doneBytes / totalBytes) * 100) })
    try {
      const data = await extractZipEntry(zip, f.entry)
      const blob = new Blob([data as BlobPart])
      await putOnce(blob, key, (pct) => {
        onProgress?.({
          done: i,
          total: picked.length,
          path: f.path,
          pct: Math.round(((doneBytes + (f.size * pct) / 100) / totalBytes) * 100),
        })
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`第 ${i + 1}/${picked.length} 个文件 ${f.path} 失败：${msg}（前 ${i} 个已经传上去了，修好后重传整包即可覆盖）`)
    }
    keys.push(key)
    doneBytes += f.size
  }
  onProgress?.({ done: picked.length, total: picked.length, path: '', pct: 100 })

  // 清理孤儿：上一版包里有、这一版没有的文件。留着不影响加载，但会一直占空间，
  // 而且下次有人来看目录会以为它们还在被引用。
  const removed: string[] = []
  const uploaded = new Set(keys)
  const stale = existing.filter((o) => !uploaded.has(o.key))
  if (stale.length) {
    const ok = window.confirm(
      `${base}/\n\n目录里还剩 ${stale.length} 个这次没传的旧文件：\n` +
        stale.slice(0, 8).map((o) => `  ${o.key.slice(base.length + 1)}`).join('\n') +
        (stale.length > 8 ? `\n  …还有 ${stale.length - 8} 个` : '') +
        '\n\n从 R2 删掉吗？（不确定就选取消，它们不影响游戏加载）',
    )
    if (ok) {
      for (const o of stale) {
        try {
          await deleteRom(o.key)
          removed.push(o.key)
        } catch {
          /* 删不掉就算了，不能让清理失败把整次上传判成失败 */
        }
      }
    }
  }

  return { mainKey: keyOf(main), keys, bytes: totalBytes, removed }
}
