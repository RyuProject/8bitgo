/**
 * 后台上传资源时的两道守卫：别把同一个位置重复传一遍，也别在换 key 之后
 * 把旧文件孤零零丢在 R2 里。ROM（按语言）、封面 / 视频、平台 BIOS 三个入口共用。
 *
 * 要守住的约束是「一个游戏 + 一个语言 = 一个 ROM」「一个游戏 = 一张封面」
 * 「一个平台 = 一份 BIOS」—— 原来三处都是不问直接 PUT，管理员看不到自己盖掉了什么。
 */
import { deleteRom, deleteRomDir, dirOfKey, getRomConfig, headRom, isBundleKey } from '@/services/roms'

// 封面图常常不到 1MB，一律按 MB 显示会变成一排「0.00 MB」，看不出差别
export const human = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`)

/**
 * 上传前的重复检查。返回 false 表示管理员选择放弃。
 *
 * 「一个游戏 + 一个语言 = 一个 ROM」「一个游戏 = 一张封面」是这里要守住的约束。
 * 原来是不问直接 PUT：目标位置有没有东西、盖掉的是什么，管理员完全看不到。
 *
 * 大小完全相同基本就是同一份文件又传了一遍（真换版本时字节数几乎不可能分毫不差），
 * 所以这两种情况的措辞要分开——一个是「你可能重复操作了」，一个是「你在换版本」。
 *
 * ⚠️ 探测本身失败（Worker 不通、CORS 没配好）一律放行：它只是个提示，
 * 不该因为探测挂了就把上传功能也堵死。
 */
export async function confirmUpload(key: string, file: File): Promise<boolean> {
  const head = await headRom(key).catch(() => null)
  if (!head?.exists) return true
  if (head.size === file.size) {
    return window.confirm(
      `${key}\n\n这个位置已经有一个大小完全相同的文件（${human(file.size)}），很可能是同一份、重复上传了。\n\n仍要覆盖吗？`,
    )
  }
  return window.confirm(
    `${key}\n\n这个位置已有文件（${human(head.size ?? 0)}），上传会把它覆盖成 ${human(file.size)}。\n\n继续吗？`,
  )
}

/**
 * 上传成功后，清理被顶替的那个旧文件。
 *
 * 什么时候会产生旧文件：字段里的 key 被手工改过、原来填的是完整 URL、
 * 或者清空后换了个扩展名重传（zip → gba）。这几种情况新 key 和旧 key 不一样，
 * 数据库指向新的，旧对象就成了没人引用的孤儿留在 R2 里 ——
 * 「一个游戏上传多份同语言 ROM」正是这么来的。
 *
 * 两道保险：
 *   1. 同一个 key 被这款游戏的多个槽位共用时不删（比如 en 和 ja 指向同一份）
 *   2. 删之前弹确认，并且明说「别的游戏也在用就选取消」——
 *      前端只看得到当前这一款游戏，跨游戏的引用它判断不了
 *
 * 返回真正删掉的 key，没删就返回 null。
 */
export async function cleanupSuperseded(oldKey: string, newKey: string, allBoundKeys: string[]): Promise<string | null> {
  const old = oldKey.trim()
  if (!old || old === newKey || /^https?:/i.test(old)) return null
  if (allBoundKeys.filter((k) => k === old).length > 1) return null
  const exists = await headRom(old).then((h) => h.exists).catch(() => false)
  if (!exists) return null
  const ok = window.confirm(
    `旧文件 ${old}\n\n已被新上传的 ${newKey} 顶替，这款游戏不再引用它。\n\n从 R2 删除吗？此操作不可恢复；如果别的游戏也在用这个文件，请选取消。`,
  )
  if (!ok) return null
  await deleteRom(old)
  return old
}

/**
 * 这个 key 指向的是不是「我们能删的 R2 对象」。
 *
 * 完整 URL（别人家的地址）和以 / 开头的站内路径（如 /bios/neogeo.zip，那是构建产物）
 * 都不归对象存储管，删不了也不该删。
 */
export function isDeletableKey(key: string): boolean {
  const k = key.trim()
  return Boolean(k) && !/^https?:/i.test(k) && !k.startsWith('/')
}

/**
 * 删掉一批 ROM key 背后的 R2 对象。
 *
 * 三件事调用方不用自己操心：
 *   1. 去重 —— 多个语言槽可能指向同一份文件
 *   2. 多 SWF 包 —— key 指向包里的某个文件时，整个包目录一起删，
 *      不然会留下一堆没人引用的 swf（见 lib/swfBundle.ts）
 *   3. 删不了的 key（完整 URL / 站内路径）直接跳过
 *
 * 返回真正删掉的 key。单个文件删失败不会中断整批 —— 收集到 failed 里一起报，
 * 否则删到一半停下，剩下的孤儿文件谁也不知道叫什么。
 */
export async function deleteRomObjects(keys: string[]): Promise<{ removed: string[]; failed: string[] }> {
  const cfg = getRomConfig()
  if (!cfg.api || !cfg.token) throw new Error('未配置 Worker 地址或口令，无法删除 R2 上的文件')

  const removed: string[] = []
  const failed: string[] = []
  const doneDirs = new Set<string>()
  const doneKeys = new Set<string>()

  for (const raw of keys) {
    const key = raw.trim()
    if (!isDeletableKey(key) || doneKeys.has(key)) continue
    doneKeys.add(key)
    try {
      if (isBundleKey(key)) {
        const dir = dirOfKey(key)
        if (doneDirs.has(dir)) continue
        doneDirs.add(dir)
        removed.push(...(await deleteRomDir(dir)))
      } else {
        await deleteRom(key)
        removed.push(key)
      }
    } catch {
      failed.push(key)
    }
  }
  return { removed, failed }
}
