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
export async function confirmUpload(key: string, file: Blob): Promise<boolean> {
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

/* ---------------- 光盘镜像 ---------------- */

/**
 * 用光盘的平台。这类平台的「ROM」是几百 MB 到几 GB 的整张盘，
 * 和卡带机那种几 MB 的文件不是一回事，上传前得多问一句。
 */
const DISC_PLATFORMS = new Set(['psx', 'ps2'])

/** 超过这个大小就提醒一次。PS1 用 .chd 压完通常在这条线以下 */
const DISC_WARN_BYTES = 700 * 1024 * 1024

/** 压缩包。光盘平台上这三种基本都是死路，见 confirmDiscImage 里那段说明 */
const ARCHIVE_EXTS = new Set(['.zip', '.7z', '.rar'])

/**
 * 浏览器里解压这一步的内存预算。
 *
 * EmulatorJS 的解压器是 public/emulatorjs/compression/extractzip.js —— 一个很老的
 * emscripten 构建，**压缩包本身和解出来的全部内容挤在同一块线性内存里**，
 * 而那块内存的硬上限是 2GB（文件里那个 `2147483648 - WASM_PAGE_SIZE` 就是它）。
 * 留一半余量给分配器碎片和 JS 侧的那几份拷贝，所以这里按 1.2GB 卡。
 */
const EXTRACT_BUDGET = 1.2 * 1024 * 1024 * 1024

/** 光盘平台推荐的转换命令。chdman 是 MAME 自带的 */
const chdmanHint = (cueName: string, outName: string) =>
  `chdman createcd -i "${cueName}" -o "${outName}"`

/**
 * 只读压缩包**末尾**的中央目录，拿到每一项的原始大小。
 *
 * 为什么不整个读进来：这里的文件动辄几百 MB，为了看一眼目录把它全读进内存，
 * 光这一下就可能把标签页顶掉 —— 而我们正是在防「内存不够」这件事。
 * EOCD 在文件最后 22 + 至多 65535 字节内，顺着它就能定位中央目录。
 *
 * 读不出来（.7z / .rar / 畸形包）返回 null，调用方按「不知道多大」处理。
 */
async function zipDirectorySummary(file: File): Promise<{ names: string[]; uncompressed: number } | null> {
  try {
    const tailLen = Math.min(file.size, 22 + 65535)
    const tail = new Uint8Array(await file.slice(file.size - tailLen).arrayBuffer())
    const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tv.getUint32(i, true) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) return null
    const count = tv.getUint16(eocd + 10, true)
    const size = tv.getUint32(eocd + 12, true)
    const offset = tv.getUint32(eocd + 16, true)
    // zip64 的哨兵值；真到了 4GB 以上就不猜了，交给下面的体积判断
    if (offset === 0xffffffff || size === 0xffffffff) return null
    if (offset + size > file.size) return null

    const cd = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer())
    const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength)
    const names: string[] = []
    let uncompressed = 0
    let at = 0
    for (let i = 0; i < count && at + 46 <= cd.length; i++) {
      if (cv.getUint32(at, true) !== 0x02014b50) break
      uncompressed += cv.getUint32(at + 24, true)
      const nameLen = cv.getUint16(at + 28, true)
      const extraLen = cv.getUint16(at + 30, true)
      const commentLen = cv.getUint16(at + 32, true)
      names.push(new TextDecoder().decode(cd.subarray(at + 46, at + 46 + nameLen)))
      at += 46 + nameLen + extraLen + commentLen
    }
    return names.length ? { names, uncompressed } : null
  } catch {
    return null
  }
}

/**
 * 上传光盘镜像前的格式与体积提醒。返回 false 表示这一份不传。
 *
 * 三件事在这里说清楚，因为**上传之后再发现就晚了** —— 玩家那一侧要真的把这些字节
 * 下载下来，几百 MB 的差别直接决定这款游戏能不能玩：
 *
 * 1. **压缩包在光盘平台上是死路**，而且死得极其难查 —— 见下面 ARCHIVE_EXTS 那一段。
 * 2. **裸 .bin/.cue 是次差的选择**：不压缩，而且是两个文件 —— 我们一个槽位只存一个对象，
 *    单传 .cue 的话核心找不到数据轨，单传 .bin 则丢掉了音轨和分轨信息。
 *    .chd 是无损压缩的单文件（CD 音轨常能压到三分之一），两个 PS1 核心都直接认。
 * 3. **.iso 对 PS1 也不合适**：ISO9660 只装得下数据轨，带 CDDA 音轨的游戏
 *    （很多 PS1 游戏的 BGM 就是音轨）会没有音乐。PS2 用 .iso 才是正常的。
 * 4. **体积要让管理员心里有数**：这不是存储费的问题，是玩家开局要等多久的问题。
 *
 * ⚠️ 除了「一定装不下」的那一档，其余只提醒、不阻拦：压缩工具不是人人都有，
 * 先把游戏传上去能跑，比卡在这里强。
 */
export async function confirmDiscImage(platform: string, file: File): Promise<boolean> {
  if (!DISC_PLATFORMS.has(platform)) return true
  const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] ?? '').toLowerCase()
  const stem = file.name.replace(/\.[a-z0-9]+$/i, '')
  const notes: string[] = []

  /*
    ⚠️ 压缩包这一条是 2026-09-11 站长上传《Gran Turismo》时踩出来的，症状是
    `Size is zero`（mednafen_psx_hw 核心的原文）—— 而进度条一路正常走到底。

    链路是这样：我们把整个 zip 当成一份光盘镜像下下来交给引擎 → 引擎按魔数认出是 zip →
    交给 compression/extractzip.js 解 → 那是个老 emscripten 构建，**压缩包和解出来的
    内容共用一块 2GB 上限的线性内存**。PS1 一张盘解出来就是几百 MB，加上压缩包本身，
    分配一失败它并不报错，而是把那个条目写成**长度 0** 的文件。
    于是核心顺着 .cue 找到 .bin，打开一看是 0 字节 —— 「Size is zero」。

    也就是说：错误信息指向的是「文件」，真正的原因在「解压那一步的内存」，
    两者隔着三层，谁也不会往那儿想。所以必须在**上传之前**拦住。
  */
  if (ARCHIVE_EXTS.has(ext)) {
    const summary = ext === '.zip' ? await zipDirectorySummary(file) : null
    const need = file.size + (summary?.uncompressed ?? file.size * 2)
    const inner = summary?.names.length ? `\n\n包里是：${summary.names.slice(0, 6).join('、')}` : ''
    const cue = summary?.names.find((n) => /\.cue$/i.test(n)) ?? `${stem}.cue`
    const how = `\n\n正确做法：把 .cue + .bin 转成**一个 .chd** 再上传 ——\n  ${chdmanHint(cue, `${stem}.chd`)}\nchdman 是 MAME 自带的。无损、单文件、通常还能小一半，核心直接认，连解压这一步都省了。`

    if (need > EXTRACT_BUDGET) {
      window.alert(
        `${file.name}（${human(file.size)}）${inner}\n\n` +
          `光盘平台不能传压缩包，这一份**一定跑不起来**。\n\n` +
          `浏览器里解压这一步的内存上限是 2GB，而压缩包和解出来的内容要挤在同一块内存里；` +
          `这一份大约需要 ${human(need)}。分配失败之后解压器不会报错，只会写出一个 0 字节的文件，` +
          `核心报的是「Size is zero」，而进度条看起来一切正常。${how}`,
      )
      return false
    }
    return window.confirm(
      `${file.name}（${human(file.size)}）${inner}\n\n` +
        `光盘平台上的压缩包很容易跑不起来：浏览器里解压这一步内存上限是 2GB，` +
        `压缩包和解出来的内容挤在同一块内存里，不够的时候它不报错，只会写出一个 0 字节的文件，` +
        `核心报「Size is zero」。这一份大约需要 ${human(need)}，勉强在线内，但换台设备就说不准了。${how}\n\n` +
        `仍然按压缩包上传吗？`,
    )
  }

  if (ext === '.cue') {
    notes.push('.cue 只是一张目录清单，真正的数据在同名 .bin 里 —— 单传它核心一定报找不到轨道。')
  } else if (ext === '.bin' || ext === '.img') {
    notes.push('裸 .bin/.img 不压缩，而且丢掉了 .cue 里的分轨信息，多轨游戏会没有音乐。')
  } else if (ext === '.iso' && platform === 'psx') {
    notes.push('.iso 只装得下数据轨，PS1 上带 CDDA 音轨的游戏会整局没有 BGM。')
  }

  if (notes.length) {
    notes.push(`建议先用 chdman（MAME 自带）转成 .chd：\`${chdmanHint(`${stem}.cue`, `${stem}.chd`)}\`。无损、单文件，两个 PS1 核心都认。`)
  }
  if (file.size > DISC_WARN_BYTES) {
    notes.push(`这份镜像有 ${human(file.size)}，玩家每次开局都要下这么多。转成 .chd 通常能省掉一半以上。`)
  }
  if (!notes.length) return true
  return window.confirm(`${file.name}\n\n${notes.join('\n\n')}\n\n仍然按现在这份上传吗？`)
}
