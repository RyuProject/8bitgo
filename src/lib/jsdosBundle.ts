/**
 * 把普通的 DOS 游戏文件打包成 js-dos 能跑的 .jsdos bundle。
 *
 * js-dos 只认「带 .jsdos/dosbox.conf 的 zip」，直接丢一个普通 zip 给它是起不来的。
 * 所以这里在浏览器里现场重打一个包：
 *   - 已经是 .jsdos bundle（zip 里有 .jsdos/dosbox.conf）→ 原样使用，不动它
 *   - 普通 zip → **不解压**，把原有条目的压缩数据整段照抄进新 zip，再补一个 dosbox.conf
 *   - 单个 .exe / .com → 新建一个 zip 装进去，再补 dosbox.conf
 *
 * 「照抄压缩数据」是关键：DOS 游戏的 zip 里常有几十兆的 deflate 数据，
 * 解压再压一遍既慢又费内存，而 zip 的结构允许我们把条目连同它的 CRC、
 * 压缩前后大小一起搬过去，完全不用碰数据本身。
 */

import { extractZipEntry, crc32, decodeZipName } from './unzip'
import { mergeDosboxConfigOverride } from '../../shared/dosbox-config.js'

const te = new TextEncoder()

/* ---------------- zip 读 ---------------- */

interface ZipEntry {
  name: string
  method: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  centralOffset: number
  flags: number
}

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const ZIP32_MAX = 0xffffffff
// 0xffff 在 EOCD 中是 ZIP64 哨兵；少用一个槽位，保证本站写出的包也能被自己的解析器读回。
const ZIP32_MAX_ENTRIES = 0xfffe

/** 从后往前找 EOCD（可能带注释，所以要扫一段） */
function findEocd(v: DataView): number {
  const max = Math.min(v.byteLength, 0xffff + 22)
  for (let i = 22; i <= max; i++) {
    const at = v.byteLength - i
    if (at < 0) break
    if (v.getUint32(at, true) === EOCD_SIG) return at
  }
  return -1
}

export function readZipEntries(buf: ArrayBuffer): ZipEntry[] | null {
  const v = new DataView(buf)
  if (v.byteLength < 22) return null
  const eocd = findEocd(v)
  if (eocd < 0) return null
  const disk = v.getUint16(eocd + 4, true)
  const centralDisk = v.getUint16(eocd + 6, true)
  const diskCount = v.getUint16(eocd + 8, true)
  const count = v.getUint16(eocd + 10, true)
  const centralSize = v.getUint32(eocd + 12, true)
  const centralOffset = v.getUint32(eocd + 16, true)
  const commentLength = v.getUint16(eocd + 20, true)
  if (disk !== 0 || centralDisk !== 0 || diskCount !== count || count === 0 || count === 0xffff) return null
  if (eocd + 22 + commentLength > v.byteLength) return null
  if (centralOffset + centralSize > eocd || centralOffset + centralSize > v.byteLength) return null

  let at = centralOffset
  const centralEnd = centralOffset + centralSize
  const out: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (at + 46 > centralEnd || v.getUint32(at, true) !== CEN_SIG) return null
    const nameLen = v.getUint16(at + 28, true)
    const extraLen = v.getUint16(at + 30, true)
    const commentLen = v.getUint16(at + 32, true)
    const next = at + 46 + nameLen + extraLen + commentLen
    if (next > centralEnd) return null
    const flags = v.getUint16(at + 8, true)
    /*
      ⚠️ 条目名不能硬按 UTF-8 解，也不能留着反斜杠 —— 这两条 unzip.ts 早就写对了，
      这个解析器一直是另一套。后果：
        · 中文 Windows 打的包（无 UTF-8 标志、名字是 GBK）会解成一串 U+FFFD，
          再 te.encode() 写回去就是另一个名字，游戏运行时找不到自己的数据文件；
          同一个包里两个不同的中文名还会塌成**同一串**替换符 → 重名条目互相覆盖。
        · 老式 Windows 打包器用 `\` 当分隔符，按 `/` 切推不出任何父目录 →
          js-dos 的解包器不补父目录 → 写文件 ENOENT → DOSBox 退出，**而且不发任何 error 事件**。
      顺带把 macOS 归档产生的 __MACOSX / ._* 一起滤掉，别让它们进游戏盘。
    */
    const name = decodeZipName(new Uint8Array(buf, at + 46, nameLen), Boolean(flags & 0x800)).replace(/\\/g, '/')
    const compressedSize = v.getUint32(at + 20, true)
    const localOffset = v.getUint32(at + 42, true)
    if (localOffset + 30 > v.byteLength || v.getUint32(localOffset, true) !== 0x04034b50) return null
    const dataStart = localOffset + 30 + v.getUint16(localOffset + 26, true) + v.getUint16(localOffset + 28, true)
    if (dataStart > v.byteLength || dataStart + compressedSize > v.byteLength) return null
    if (name.startsWith('__MACOSX/') || name.split('/').pop()?.startsWith('._')) {
      at = next
      continue
    }
    out.push({
      name,
      flags,
      method: v.getUint16(at + 10, true),
      crc: v.getUint32(at + 16, true),
      compressedSize,
      uncompressedSize: v.getUint32(at + 24, true),
      localOffset,
      centralOffset: at,
    })
    at = next
  }
  if (at > centralEnd) return null
  return out
}

/**
 * 读取 ZIP 里的一个小文件，给启动前的兼容补丁使用。
 *
 * 不把 ZipEntry 暴露出去：调用方只该关心「包里这份文件的真实名字和解压后字节」，
 * 不能绕过本文件里的路径归一化、压缩算法与 CRC 校验各自再写一套 ZIP 解析器。
 */
export async function readZipFile(
  buf: ArrayBuffer,
  wantedPath: string,
): Promise<{ path: string; data: Uint8Array<ArrayBuffer> } | null> {
  const wanted = safeArchivePath(wantedPath)
  if (!wanted) throw new Error(`要读取的 DOS 压缩包路径不安全：${wantedPath}`)
  const parsed = readZipEntries(buf)
  if (!parsed) throw new Error('DOS ROM 不是一个可读的 ZIP')
  const entries = normalizeArchiveEntries(parsed)
  assertRepackable(entries)
  const entry = entries.find((candidate) => !candidate.name.endsWith('/') && candidate.name.toLowerCase() === wanted.toLowerCase())
  if (!entry) return null
  const data = await extractZipEntry(buf, {
    name: entry.name,
    method: entry.method,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    crc32: entry.crc,
    offset: entry.localOffset,
  })
  return { path: entry.name, data: data as Uint8Array<ArrayBuffer> }
}

/** 取某条目「压缩后」的原始字节：本地头的长度字段跟中央目录可能不一样，必须现读 */
function rawData(buf: ArrayBuffer, e: ZipEntry): Uint8Array<ArrayBuffer> {
  const v = new DataView(buf)
  const nameLen = v.getUint16(e.localOffset + 26, true)
  const extraLen = v.getUint16(e.localOffset + 28, true)
  const start = e.localOffset + 30 + nameLen + extraLen
  return new Uint8Array(buf, start, e.compressedSize)
}

/* ---------------- zip 写 ---------------- */

interface OutEntry {
  name: string
  method: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  data: Uint8Array<ArrayBuffer>
}

/**
 * 拼出 ZIP 的所有分片。`buildZip` 和 `buildZipBytes` 共用。
 *
 * ⚠️ 为什么要有 `buildZipBytes`：Windows 客体那条路以前是
 * `buildZip()` → Blob → `await blob.arrayBuffer()` → Uint8Array，
 * 一份几十到几百 MB 的游戏包因此在堆上同时存在**三份**（原 ArrayBuffer、Blob、读回来的字节），
 * 再加上近百 MB 的系统镜像那两份，`Dos()` 被调用的那一刻峰值轻松三四百 MB。
 * 手机上这就是「加载到一半页面白掉」—— 标签页被系统回收，玩家看不到任何错误。
 * 直接拼字节能省掉一整份。
 */
function zipParts(entries: OutEntry[]): Uint8Array<ArrayBuffer>[] {
  if (entries.length > ZIP32_MAX_ENTRIES) {
    throw new Error(`DOS 压缩包文件过多（${entries.length} 个）；当前浏览器打包器不支持 ZIP64`)
  }
  const parts: Uint8Array<ArrayBuffer>[] = []
  const central: Uint8Array<ArrayBuffer>[] = []
  let offset = 0

  for (const e of entries) {
    const name = te.encode(e.name) as Uint8Array<ArrayBuffer>
    if (name.length > 0xffff) throw new Error(`DOS 压缩包路径过长：${e.name}`)
    if (e.compressedSize !== e.data.length) {
      throw new Error(`DOS 压缩包条目长度不一致：${e.name}`)
    }
    if (e.compressedSize > ZIP32_MAX || e.uncompressedSize > ZIP32_MAX) {
      throw new Error(`DOS 压缩包条目超过 4 GB；当前浏览器打包器不支持 ZIP64：${e.name}`)
    }
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // version needed
    /*
      条目名是 TextEncoder 生成的 UTF-8，必须打通用标志 bit 11。
      以前这里写 0：ASCII 游戏看不出来，中文文件名却会被解包器按本地代码页再解一次，
      轻则乱码，重则游戏运行时找不到数据文件。bit 3 仍保持关闭，因为长度已经写在头里。
    */
    lv.setUint16(6, 0x0800, true)
    lv.setUint16(8, e.method, true)
    lv.setUint16(10, 0, true) // 时间
    lv.setUint16(12, 0x21, true) // 日期（1980-01-01）
    lv.setUint32(14, e.crc, true)
    lv.setUint32(18, e.compressedSize, true)
    lv.setUint32(22, e.uncompressedSize, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)
    local.set(name, 30)

    parts.push(local, e.data)

    const cen = new Uint8Array(46 + name.length)
    const cv = new DataView(cen.buffer)
    cv.setUint32(0, CEN_SIG, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, e.method, true)
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0x21, true)
    cv.setUint32(16, e.crc, true)
    cv.setUint32(20, e.compressedSize, true)
    cv.setUint32(24, e.uncompressedSize, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    cen.set(name, 46)
    central.push(cen)

    offset += local.length + e.data.length
    if (offset > ZIP32_MAX) {
      throw new Error('DOS 压缩包超过 4 GB；当前浏览器打包器不支持 ZIP64')
    }
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0)
  if (centralSize > ZIP32_MAX || offset + centralSize + 22 > ZIP32_MAX) {
    throw new Error('DOS 压缩包超过 4 GB；当前浏览器打包器不支持 ZIP64')
  }
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, EOCD_SIG, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  return [...parts, ...central, eocd]
}

function buildZip(entries: OutEntry[]): Blob {
  return new Blob(zipParts(entries) as BlobPart[], { type: 'application/zip' })
}

/** 和 buildZip 同样的字节，但不经过 Blob —— 少复制一整份包，见 zipParts 的注释 */
function buildZipBytes(entries: OutEntry[]): Uint8Array<ArrayBuffer> {
  const parts = zipParts(entries)
  const total = parts.reduce((n, part) => n + part.length, 0)
  const out = new Uint8Array(total) as Uint8Array<ArrayBuffer>
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/* ---------------- dosbox.conf ---------------- */

const RUNNABLE = /\.(exe|com|bat)$/i
/**
 * 一看就不是游戏本体的东西，排在后面。
 * 后半截（eval / order / regist / vendor / catalog）是共享软件时代的常客：
 * 「做一份评估版软盘给朋友」「打印订购单」之类的随包工具。
 * Paranoid 就是教训 —— 包里 MAKEEVAL.COM 和 PARANOID.COM 打分打成平手，
 * 按 zip 里的顺序取第一个，玩家点开游戏看到的是个安装界面。
 * ⚠️ 别把 demo 加进来：太多游戏本体就叫 XXDEMO.EXE。
 */
const NOT_GAME = /(^|\/)(install|setup|config|setsound|readme|uninst|dos4gw|cwsdpmi|eval|order|regist|vendor|catalog)/i

/**
 * 从文件列表里猜一个启动程序。
 * hint 是包的文件名（去掉扩展名和语言后缀），可执行文件和它同名的几乎必是本体 ——
 * paranoid.zip 里的 PARANOID.COM、doom.zip 里的 DOOM.EXE。这是最强的信号，
 * 比任何后缀加分都可靠，所以给的分也最高。
 */
export function pickExecutable(names: string[], hint?: string): string | null {
  const runnable = names.filter((n) => RUNNABLE.test(n) && !n.startsWith('.jsdos/'))
  if (runnable.length === 0) return null
  // need-for-speed.en.zip → need-for-speed；比对时去掉连字符差异（NEED4SPD 这类缩写救不了，不强求）
  const base = (hint ?? '').replace(/\.[^.]+$/, '').replace(/\.(zh-Han[st]|en|ja|fr|de|es|it)$/i, '')
  const norm = (x: string) => x.toLowerCase().replace(/[-_ ]/g, '')
  const wanted = norm(base)
  const score = (n: string) => {
    let s = 0
    const stem = norm(n.split('/').pop()!.replace(/\.[^.]+$/, ''))
    if (wanted && stem === wanted) s += 6
    if (NOT_GAME.test(n)) s -= 10
    if (/\.bat$/i.test(n)) s += 3 // 作者自己写的启动批处理通常最靠谱
    if (/\.(exe|com)$/i.test(n)) s += 2 // .com 和 .exe 在 DOS 里同级，以前漏了 .com，才会出现平局
    s -= (n.split('/').length - 1) * 2 // 越靠近根目录越可能是主程序
    s -= n.length * 0.01
    return s
  }
  return runnable.sort((a, b) => score(b) - score(a))[0]
}

/**
 * 重打包之前先确认每个条目我们**搬得动**。
 *
 * 这两条路都是「压缩数据整段照抄」，只有 store(0) 和 deflate(8) 能被 js-dos 的 wasm
 * 解包器读回去。deflate64(9)、LZMA(14)、以及带密码的条目（通用标志 bit 0）照抄进去之后，
 * 解包会在那一条上断掉 —— `GAME/` 半空或全空，而 **js-dos 这一路不发任何 error 事件**：
 * 玩家看到的是一个闪一下就没的 DOS 框，状态却写着「运行中」。
 * 这里抛出来是在 `Dos()` 之前，能吃到那次自动重试，最后给玩家一句看得懂的话。
 * （同一个仓库的 unzip.ts:163 早就有这道关卡，重打包这条路一直没有。）
 */
function assertRepackable(entries: ZipEntry[]): void {
  const encrypted = entries.find((e) => e.flags & 0x1)
  if (encrypted) throw new Error(`ZIP 里的「${encrypted.name}」带密码，无法解包。请去掉密码后重新打包`)
  const bad = entries.find((e) => e.method !== 0 && e.method !== 8)
  if (bad) {
    throw new Error(
      `ZIP 里的「${bad.name}」用了不支持的压缩方式（method ${bad.method}）。` +
        '请用标准 deflate 重新打包（WinRAR/7-Zip 里选「普通」压缩，别用 deflate64 或 LZMA）',
    )
  }
}

/**
 * 路径的每一段是不是合法的 DOS 8.3 名。
 * 合法 → DOSBox 的 CD 能直接进；不合法（空格、超过 8 个字符、非法字符）
 * → 只能单独挂成另一个盘，详见 buildDosboxConf 里的注释。
 */
const DOS_83_SEGMENT = /^[A-Za-z0-9_^$~!#%&{}@'()-]{1,8}(\.[A-Za-z0-9_^$~!#%&{}@'()-]{1,3})?$/
function isDos83Path(path: string): boolean {
  const segments = path.split('/')
  return segments.length > 0 && segments.every((segment) => DOS_83_SEGMENT.test(segment))
}

/** 生成一份能跑起来的 dosbox.conf */
export function buildDosboxConf(exe: string | null, startupCommands?: string): string {
  const dir = exe && exe.includes('/') ? exe.slice(0, exe.lastIndexOf('/')) : ''
  const file = exe ? exe.slice(exe.lastIndexOf('/') + 1) : ''
  const lines = [
    '[sdl]',
    'autolock=false',
    '',
    '[dosbox]',
    // 不能只依赖内核默认值：部分浏览器构建在只给精简配置时没有把完整 XMS 暴露给游戏。
    // Heroes II 这类 DOS4GW 游戏会在进图形界面前检查 XMS，失败时只留下一句“内存不足”。
    'memsize=16',
    '',
    '[cpu]',
    // auto：先按 DOS 时代的速度跑，遇到保护模式游戏自动放开
    'cycles=auto',
    '',
    '[mixer]',
    'rate=44100',
    'blocksize=1024',
    'prebuffer=25',
    '',
    '[dos]',
    // 显式打开三种 DOS 内存接口，避免普通 ZIP 因没有自带 dosbox.conf 而依赖运行时隐式默认值。
    'xms=true',
    'ems=true',
    'umb=true',
    '',
    '[autoexec]',
    'mount c .',
    'c:',
  ]
  // 光盘先于程序挂载；若放到 EXE 后面，带光盘校验的游戏已经弹出无盘提示。
  if (startupCommands?.trim()) lines.push(...startupCommands.trim().replace(/\r\n?/g, '\n').split('\n'))
  /*
    ⚠️ 这里绝不能给 CD 加引号。
    DOSBox 的 CD 是 shell 内建命令，`DoCommand` 把整段原文直接交给 `CMD_CHDIR`，
    **不走** CommandLine 解析，也就不会剥引号——`cd "caeser"` 会真的去找一个
    叫 `"caeser"`（连引号一起）的目录，然后打印 `Unable to change to: "caeser".`。
    wdosbox.wasm 里的格式串是 `Unable to change to: %s.`，本身不含引号，
    屏幕上看到的那对引号就是参数自己带进去的。

    而带空格的目录加不加引号都进不去：空格在 DOS 文件名里本来就非法，
    DOSBox 只会提示你改用 `PRINCE~1` 这种 8.3 别名。所以两种情况要分开处理：
      · 名字本身就是合法 8.3 → 直接 `cd DIR`，不加引号；
      · 带空格 / 超长 / 带非法字符 → 把那层目录单独挂成 D: 盘。
        MOUNT 走的是 CommandLine 解析，**会**剥引号，是唯一稳的写法；
        C: 仍然留着，EXE 目录之外的数据照样能访问。

    麻烦的地方在于这一切发生在 DOSBox **正常启动之后**：ci-ready 照常到、遮罩照常撤，
    玩家对着一个 `C:\>` 提示符，没有任何错误提示。
    末尾那句 @echo 是同一个道理：真没跑起来时，黑屏至少变成一句人话。
  */
  if (dir) {
    if (isDos83Path(dir)) lines.push(`cd ${dir.replace(/\//g, '\\')}`)
    else {
      // 引号无法转义进 MOUNT 的参数；宁可在进游戏前报一句人话，也不能挂错目录。
      if (dir.includes('"')) throw new Error(`DOS 游戏目录名里带引号，无法挂载：${dir}`)
      lines.push(`mount d "./${dir}"`, 'd:')
    }
  }
  if (file) {
    /*
      DOSBox 的命令执行和上面的 CD 一样不会可靠地把长文件名 / 引号还原成宿主文件名。
      这里没有 ZIP 清单，算不出一个不会撞名的别名，所以宁可明确拒绝。makeJsdosBundle
      会先给这类启动文件补一个真实存在的 8.3 别名，再拿那个别名调用到这里。
    */
    if (!isDos83Path(file)) throw new Error(`DOS 启动文件名不是 8.3 格式，必须先生成启动别名：${file}`)
    lines.push(file)
    // DOS 文本模式不是 UTF-8；把中文塞进 autoexec 只会变成玩家截图里那串乱码。
    lines.push(`@echo ${file} exited. If no game appeared, files or dependencies may be missing.`)
  }
  else lines.push('@echo No executable was found. Run the game manually.')
  return lines.join('\n') + '\n'
}

/* ---------------- 对外接口 ---------------- */

export interface BundleResult {
  blob: Blob
  /** 猜出来的启动程序，界面上可以显示出来 */
  executable: string | null
  /** true = 传进来的本来就是 bundle，没有重新打包 */
  passthrough: boolean
  /**
   * 包里所有文件是不是都在启动程序那一层目录里（只有 makeWindowsGameLayer 会给）。
   *
   * Windows 3.x 那条路会把游戏盘的**盘根**收窄到 EXE 的父目录，好让 File Manager 的
   * Run 直接继承正确的工作目录。代价是：EXE 目录之外的东西（`GAME/DATA/`、根上的 .INI）
   * 在客体里**根本不存在**，游戏能启动然后立刻报找不到数据文件。
   * 所以只有这个为 true 时才准收窄。
   */
  singleDir?: boolean
}

/**
 * 把系统 bundle 自带的 dosbox.conf 改名为同长度的备份文件，供它作为 initFs 文件层使用。
 *
 * js-dos 会按顺序解开多层 bundle，后解开的系统 conf 会覆盖播放器生成的自动启动配置。
 * 这里直接在已经下载好的 ZIP 中原地改两个文件名（本地头 + 中央目录），不碰那份近百 MB 的
 * qcow2 数据，也不再分配一份同样大的新数组。真正要执行的 conf 会作为最后一层传入。
 *
 * ⚠️ 这件事和**条目用什么压缩方式无关** —— 改的是文件名那 36 个 ASCII 字节，
 * store 和 deflate 都一样成立。2026-09-11 把 system-win95-v1.jsdos 从 store 重打成
 * deflate（93.1 MiB → 38.3 MiB）时验过这一条，见 scripts/repack-jsdos.mjs 的 verify()。
 */
export function hideJsdosConfigForLayer(buf: ArrayBuffer): Uint8Array<ArrayBuffer> {
  const entries = readZipEntries(buf)
  const entry = entries?.find((item) => item.name.toLowerCase() === '.jsdos/dosbox.conf')
  if (!entry) throw new Error('Windows 系统镜像缺少 .jsdos/dosbox.conf')

  const original = te.encode(entry.name)
  const replacement = te.encode('.jsdos/dosbox.orig')
  const view = new DataView(buf)
  const localNameLength = view.getUint16(entry.localOffset + 26, true)
  const centralNameLength = view.getUint16(entry.centralOffset + 28, true)
  if (original.length !== replacement.length || localNameLength !== original.length || centralNameLength !== original.length) {
    throw new Error('Windows 系统镜像的 dosbox.conf 文件名结构异常')
  }

  const bytes = new Uint8Array(buf) as Uint8Array<ArrayBuffer>
  bytes.set(replacement, entry.localOffset + 30)
  bytes.set(replacement, entry.centralOffset + 46)
  return bytes
}

/**
 * 共享 Windows 系统镜像约定的游戏层目录。
 *
 * 系统 bundle、游戏 bundle 会一起解到 js-dos 的虚拟根目录；多套系统复用时必须给
 * 游戏再套一层固定目录，否则游戏自己的 README.TXT 之类很容易覆盖系统 bundle 的文件。
 */
export const WINDOWS_GAME_ROOT = 'GAME'
/** 自动启动时永远敲这一条固定、纯 ASCII 的路径，真实 EXE 路径写在批处理内部。 */
export const WINDOWS_LAUNCHER_PATH = '8BITGO/RUN.BAT'

function safeArchivePath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/')
  // 去掉 `./` 是安全的常见归档写法；绝对路径和盘符会逃出游戏层，必须拒绝而不是悄悄削掉。
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) return null
  const clean = normalized.replace(/^(?:\.\/)+/, '').replace(/\/+$/g, '')
  if (!clean) return null
  // 解包发生在模拟器的虚拟文件系统里，但 ../ 仍能覆盖系统层和最终 dosbox.conf。
  if (clean.split('/').some((part) => !part || part === '.' || part === '..')) return null
  // 客体 Windows 本身也处理不了文件名里的控制字符，越早报错越容易定位到包的问题。
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f:]/.test(clean)) return null
  return clean
}

/**
 * DOS 盘大小写不敏感，文件也不能同时充当目录。
 *
 * ZIP 却允许 `DATA` + `DATA/LEVEL.DAT`、`GAME.EXE` + `game.exe` 甚至同名文件写两遍。
 * 这种包交给 js-dos 后谁覆盖谁取决于解包顺序，父路径是文件时还会直接 ENOENT；两种情况
 * 都只表现为黑屏。所以在重打包前把歧义变成一句明确错误。
 */
function assertNoPathCollisions(entries: readonly { name: string }[], label: string): void {
  const seen = new Map<string, { name: string; directory: boolean }>()
  for (const entry of entries) {
    const directory = entry.name.endsWith('/')
    const plain = directory ? entry.name.slice(0, -1) : entry.name
    const key = plain.toLowerCase()
    const previous = seen.get(key)
    if (previous) {
      // 重复目录没有歧义，后面的目录条目直接由 normalizeArchiveEntries 去重。
      if (previous.directory && directory) continue
      throw new Error(`${label} 路径冲突：「${previous.name}」与「${entry.name}」在 DOS 中是同一个位置`)
    }
    seen.set(key, { name: entry.name, directory })
  }
  for (const entry of seen.values()) {
    const plain = entry.directory ? entry.name.slice(0, -1) : entry.name
    const parts = plain.split('/')
    for (let i = 1; i < parts.length; i++) {
      const parent = seen.get(parts.slice(0, i).join('/').toLowerCase())
      if (parent && !parent.directory) {
        throw new Error(`${label} 路径冲突：「${parent.name}」是文件，不能同时作为「${entry.name}」的目录`)
      }
    }
  }
}

/** 把 ZIP 条目统一成安全的相对路径；普通 DOS 和 Windows 客体必须共用这道边界。 */
function normalizeArchiveEntries(entries: ZipEntry[]): ZipEntry[] {
  const normalized = entries.map((entry) => {
    const directory = entry.name.endsWith('/')
    const safe = safeArchivePath(entry.name)
    if (!safe) throw new Error(`ZIP 含不安全的绝对路径、盘符或 ../ 路径：${entry.name}`)
    return { ...entry, name: directory ? `${safe}/` : safe }
  })
  assertNoPathCollisions(normalized, 'ZIP')
  const directories = new Set<string>()
  return normalized.filter((entry) => {
    if (!entry.name.endsWith('/')) return true
    const key = entry.name.toLowerCase()
    if (directories.has(key)) return false
    directories.add(key)
    return true
  })
}

interface DosLaunchTarget {
  /** 写进 autoexec 的真实路径。 */
  path: string
  /** 长文件名需要额外写进 ZIP 的 8.3 别名；原文件仍保留，避免破坏游戏自己的引用。 */
  alias: OutEntry | null
}

/**
 * DOS shell 不能可靠执行带空格、中文或超过 8.3 的文件名。归档里有真实清单时，为启动文件
 * 增加一个同目录的 8.3 别名，内容直接复用原条目的压缩字节，不做解压 / 重压。
 */
function dosLaunchTarget(entries: ZipEntry[], buf: ArrayBuffer, executable: string): DosLaunchTarget {
  const wanted = safeArchivePath(executable)
  if (!wanted) throw new Error(`DOS 启动程序路径不安全：${executable}`)
  const source = entries.find((entry) => !entry.name.endsWith('/') && entry.name.toLowerCase() === wanted.toLowerCase())
  if (!source) throw new Error(`ZIP 里找不到后台配置的启动程序：${executable}`)

  const slash = source.name.lastIndexOf('/')
  const dir = slash >= 0 ? source.name.slice(0, slash + 1) : ''
  const file = source.name.slice(slash + 1)
  if (isDos83Path(file)) return { path: source.name, alias: null }

  const ext = file.slice(file.lastIndexOf('.') + 1).toUpperCase()
  if (!/^(EXE|COM|BAT)$/.test(ext)) throw new Error(`DOS 启动文件扩展名无效：${file}`)
  const occupied = new Set(entries.map((entry) => entry.name.toLowerCase()))
  let aliasName = ''
  for (let i = 0; i < 100; i++) {
    const stem = i === 0 ? '8BITGO' : `8BITG${String(i).padStart(2, '0')}`
    const candidate = `${stem}.${ext}`
    if (!occupied.has(`${dir}${candidate}`.toLowerCase())) {
      aliasName = candidate
      break
    }
  }
  if (!aliasName) throw new Error(`DOS 启动目录里没有可用的 8.3 别名：${dir || '/'}`)
  return {
    path: `${dir}${aliasName}`,
    alias: {
      name: `${dir}${aliasName}`,
      method: source.method,
      crc: source.crc,
      compressedSize: source.compressedSize,
      uncompressedSize: source.uncompressedSize,
      data: rawData(buf, source),
    },
  }
}

/**
 * 把“只有游戏文件”的普通 ZIP 变成可叠加到共享 Windows 系统镜像上的 js-dos 文件层。
 *
 * 和 makeJsdosBundle 不同，这里**故意不写 .jsdos/dosbox.conf**：最终配置来自系统镜像，
 * 再由 windowsGuest.ts 只改 autoexec。游戏层只负责两件事：
 *   1. 所有文件放进 GAME/，供 DOSBox-X 动态转换成客体 Windows 看得见的 FAT 盘；
 *   2. 生成固定的 8BITGO/RUN.BAT，把后台填写的真实 EXE 路径变成正确工作目录后再运行。
 */
export interface WindowsGameLayer {
  /** 客体这条路不经过 Blob，见 zipParts 的注释 */
  blob: null
  bytes: Uint8Array<ArrayBuffer>
  executable: string | null
  passthrough: false
  singleDir: boolean
}

export function makeWindowsGameLayer(buf: ArrayBuffer, executable: string, drive = 'd'): WindowsGameLayer {
  const parsed = readZipEntries(buf)
  const bytes = new Uint8Array(buf)
  const zipLike = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
  if (!zipLike || !parsed) throw new Error('Windows 客体游戏必须上传完整 ZIP，不能只上传单个 EXE')
  const entries = normalizeArchiveEntries(parsed)
  assertRepackable(entries)

  const files = entries
    .filter((entry) => !entry.name.endsWith('/'))
    .map((entry) => ({ entry, name: safeArchivePath(entry.name) }))
  if (files.some((file) => file.name === null)) throw new Error('Windows 游戏 ZIP 含不安全的绝对路径或 ../ 路径')

  const wanted = safeArchivePath(executable)
  if (!wanted || !/\.exe$/i.test(wanted)) throw new Error('Windows 自启动程序必须是 ZIP 内的 .exe 相对路径')
  const actual = files.find((file) => file.name!.toLowerCase() === wanted.toLowerCase())?.name
  if (!actual) throw new Error(`Windows 游戏 ZIP 里找不到自启动程序：${wanted}`)

  const out: OutEntry[] = []
  const dirs = new Set<string>([`${WINDOWS_GAME_ROOT}/`, `${WINDOWS_GAME_ROOT}/8BITGO/`])
  for (const file of files) {
    const parts = file.name!.split('/')
    let prefix = `${WINDOWS_GAME_ROOT}/`
    for (let i = 0; i < parts.length - 1; i++) {
      prefix += `${parts[i]}/`
      dirs.add(prefix)
    }
  }

  const empty = new Uint8Array(0) as Uint8Array<ArrayBuffer>
  for (const dir of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))) {
    out.push({ name: dir, method: 0, crc: 0, compressedSize: 0, uncompressedSize: 0, data: empty })
  }
  for (const file of files) {
    const e = file.entry
    out.push({
      name: `${WINDOWS_GAME_ROOT}/${file.name}`,
      method: e.method,
      crc: e.crc,
      compressedSize: e.compressedSize,
      uncompressedSize: e.uncompressedSize,
      data: rawData(buf, e),
    })
  }

  const exeSlash = actual.lastIndexOf('/')
  const exeDir = exeSlash >= 0 ? actual.slice(0, exeSlash + 1) : ''
  // 盘根能不能收窄到 EXE 那一层：只有当包里没有任何东西落在那一层之外时才行
  const singleDir = files.every((file) => file.name!.startsWith(exeDir))

  const slash = actual.lastIndexOf('/')
  const dir = slash >= 0 ? `\\${actual.slice(0, slash).replace(/\//g, '\\')}` : '\\'
  const file = actual.slice(slash + 1)
  const quote = (value: string) => (/\s/.test(value) ? `"${value}"` : value)
  if (!/^[d-z]$/i.test(drive)) throw new Error('Windows 游戏盘符必须是 D-Z')
  const launcher = te.encode(['@echo off', `${drive.toLowerCase()}:`, `cd ${quote(dir)}`, quote(file), 'exit'].join('\r\n') + '\r\n') as Uint8Array<ArrayBuffer>
  out.push({
    name: `${WINDOWS_GAME_ROOT}/${WINDOWS_LAUNCHER_PATH}`,
    method: 0,
    crc: crc32(launcher),
    compressedSize: launcher.length,
    uncompressedSize: launcher.length,
    data: launcher,
  })

  // 客体那条路只要字节，不要 Blob（见 zipParts 的注释：Blob 那一趟会白复制一整份包）
  return { blob: null, bytes: buildZipBytes(out), executable: actual, passthrough: false, singleDir }
}

/* ---------------- 附加文件（扩展包 / 补丁 / 配置） ---------------- */

export interface ExtraFile {
  /** 在游戏目录里的路径。`SC-002.MIX` 落到根上，`CDROM/FOO.MIX` 落到子目录 */
  path: string
  data: Uint8Array<ArrayBuffer>
}

function planExtraFiles(extras: readonly ExtraFile[]): Map<string, ExtraFile> {
  const wanted = new Map<string, ExtraFile>()
  for (const extra of extras) {
    const path = safeArchivePath(extra.path)
    if (!path) throw new Error(`附加文件含不安全的绝对路径、盘符或 ../ 路径：${extra.path}`)
    const key = path.toLowerCase()
    const previous = wanted.get(key)
    if (previous) throw new Error(`附加文件路径重复：「${previous.path}」与「${extra.path}」`)
    wanted.set(key, { path, data: extra.data })
  }
  return wanted
}

/** 原包里被覆盖的文件先排除，再检查附加文件加入后是否产生 DOS 路径歧义。 */
function assertExtrasFit(entries: readonly ZipEntry[], wanted: ReadonlyMap<string, ExtraFile>): void {
  if (!wanted.size) return
  const effective = entries
    .filter((entry) => !wanted.has(entry.name.toLowerCase()))
    .map((entry) => ({ name: entry.name }))
  for (const extra of wanted.values()) effective.push({ name: extra.path })
  assertNoPathCollisions(effective, 'ZIP 与附加文件')
}

/** 把附加文件及其缺失的父目录写成 ZIP 条目；文件本体保持 store，避免主线程同步压缩。 */
function extraOutEntries(wanted: ReadonlyMap<string, ExtraFile>, existing: Iterable<string>): OutEntry[] {
  const have = new Set([...existing].map((name) => name.toLowerCase()))
  const out: OutEntry[] = []
  const empty = new Uint8Array(0) as Uint8Array<ArrayBuffer>
  for (const { path, data } of wanted.values()) {
    const segments = path.split('/')
    for (let i = 1; i < segments.length; i++) {
      const directory = segments.slice(0, i).join('/') + '/'
      if (have.has(directory.toLowerCase())) continue
      have.add(directory.toLowerCase())
      out.push({ name: directory, method: 0, crc: 0, compressedSize: 0, uncompressedSize: 0, data: empty })
    }
    have.add(path.toLowerCase())
    out.push({
      name: path,
      method: 0,
      crc: crc32(data),
      compressedSize: data.length,
      uncompressedSize: data.length,
      data,
    })
  }
  return out
}

/**
 * 把附加文件并进游戏的 ZIP。
 *
 * 站长 2026-09-11 要在后台就能给 DOS 游戏加扩展包（C&C 的 `SC-002.MIX`）：
 * 那类东西是**纯数据**，只要和本体躺在同一个目录里就行，为它重打一份十几 MB 的 ROM
 * 既费事又容易出错（放错层、用了 LZMA、覆盖了缓存…）。所以改成加载时现并。
 *
 * ⚠️ **同名就替换**，不是两条并存。ZIP 允许重名条目，而 js-dos 的解包器是逐条往虚拟盘
 * 写的 —— 两条同名只会变成「后写的赢」，取决于顺序，那是碰运气。这里明确地删掉旧的。
 * 顺带这也让附加文件能**覆盖**本体里的文件（打补丁正是要这个）。
 *
 * ⚠️ **父目录条目必须补齐**。js-dos 的 wasm 解包器不会替文件补建父目录：
 * 轮到 `CDROM/FOO.MIX` 时前面没出现过 `CDROM/`，写文件直接 ENOENT，
 * DOSBox 当场退出，而**这条路不发任何 error 事件** —— 玩家看到的是一块黑屏。
 * （同一个坑在这个文件下面重打包那一段里已经栽过一次，见那段注释里的极品飞车。）
 *
 * ⚠️ 附加文件按 **store（不压缩）** 写进去。扩展包多半本来就是压好的数据（.MIX/.DAT），
 * 再压一遍省不下什么，而浏览器里同步 deflate 要么没有要么慢。
 */
export function mergeExtraFiles(buf: ArrayBuffer, extras: readonly ExtraFile[]): ArrayBuffer {
  if (!extras.length) return buf
  const parsed = readZipEntries(buf)
  if (!parsed) throw new Error('要加附加文件的 ROM 不是一个可读的 ZIP')
  const entries = normalizeArchiveEntries(parsed)
  assertRepackable(entries)

  const wanted = planExtraFiles(extras)
  if (!wanted.size) return buf
  assertExtrasFit(entries, wanted)

  const out: OutEntry[] = []
  for (const e of entries) {
    // 同名的让位给附加文件
    if (wanted.has(e.name.toLowerCase())) continue
    out.push({
      name: e.name,
      method: e.method,
      crc: e.crc,
      compressedSize: e.compressedSize,
      uncompressedSize: e.uncompressedSize,
      data: rawData(buf, e),
    })
  }

  out.push(...extraOutEntries(wanted, out.map((entry) => entry.name)))

  const bytes = buildZipBytes(out)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/**
 * 把一份 DOS 游戏（zip / exe / com，或已经打好的 .jsdos）变成 js-dos 能跑的 bundle。
 * conf 允许外部覆盖（例如用户在界面上手动选了启动程序）。
 */
export async function makeJsdosBundle(
  name: string,
  buf: ArrayBuffer,
  conf?: string,
  configOverride?: string,
  /** 后台填的启动程序；存在时既做校验，也覆盖自动猜测。 */
  dosExecutable?: string,
  /** 有命令时不透传包内旧 autoexec，否则语言槽填写的挂盘命令会被静默忽略。 */
  startupCommands?: string,
  /** 普通 DOS 直接在最终 bundle 里并入附加文件，避免先复制一遍完整 ROM 再重打包。 */
  extras: readonly ExtraFile[] = [],
): Promise<BundleResult> {
  const parsed = readZipEntries(buf)
  const entries = parsed ? normalizeArchiveEntries(parsed) : null
  const bytes = new Uint8Array(buf)
  const zipLike = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
  if (zipLike && !entries) throw new Error('DOS 压缩包为空、已损坏或下载不完整')

  if (entries) assertRepackable(entries)
  if (extras.length && !entries) throw new Error('单个 DOS 可执行文件不能附加资料片；请先把游戏打成 ZIP')
  const wantedExtras = planExtraFiles(extras)
  if (entries) assertExtrasFit(entries, wantedExtras)

  /*
    启动程序、CUE 和 bundle 配置会参与下面的控制流。极少数管理员若真用附加文件替换它们，
    先走旧的完整合并路径以保持语义；常见的 MIX/DAT/地图/补丁则走零整包复制的快路径。
  */
  if ([...wantedExtras.values()].some((extra) => /(^\.jsdos\/|\.(?:exe|com|bat|cue)$)/i.test(extra.path))) {
    const merged = mergeExtraFiles(buf, extras)
    return makeJsdosBundle(name, merged, conf, configOverride, dosExecutable, startupCommands)
  }
  /*
    ⚠️ 后台填的启动程序，包里必须真有。
    以前一个字都不验，直接拼进 [autoexec]：管理员填错一个字母（或者游戏换了个包），
    DOSBox 照常起来、ci-ready 照常到、遮罩照常撤，玩家对着一个 `C:\>` 提示符 ——
    这类反馈只会以「这游戏打不开」的形式回来，没人查得到是配置写错了。
    在这里抛是在 Dos() 之前，能吃自动重试，最后给出一句指名道姓的错误。
    对照组：makeWindowsGameLayer 早就有同一道校验（找不到就 throw）。
  */
  let configuredExecutable: string | null = null
  if (entries && dosExecutable?.trim()) {
    const wanted = safeArchivePath(dosExecutable.trim())?.toLowerCase()
    configuredExecutable = entries.find((e) => !e.name.endsWith('/') && e.name.toLowerCase() === wanted)?.name ?? null
    if (!configuredExecutable) {
      throw new Error(`ZIP 里找不到后台配置的启动程序：${dosExecutable.trim()}`)
    }
  }

  if (startupCommands?.trim() && /\bimgmount\b[^\n]*\.cue\b/i.test(startupCommands) && !entries) {
    throw new Error('CUE 光盘镜像必须与 DOS 游戏放在同一个 ZIP 内')
  }
  if (entries && startupCommands?.trim()) {
    const byName = new Map<string, ZipEntry | null>(entries.map((entry) => [entry.name, entry]))
    for (const extra of wantedExtras.values()) byName.set(extra.path, null)
    for (const line of startupCommands.split(/\r?\n/)) {
      if (!/^\s*imgmount\b/i.test(line) || !/\.cue\b/i.test(line)) continue
      const match = /^\s*imgmount\s+[a-z]\s+(?:"([^"]+)"|(\S+))/i.exec(line)
      if (!match) throw new Error(`CUE 挂载命令格式无效：${line.trim()}`)
      const cuePath = (match[1] ?? match[2]).replace(/\\/g, '/').replace(/^\.\//, '')
      if (cuePath.startsWith('/') || cuePath.includes(':') || cuePath.split('/').includes('..')) {
        throw new Error(`CUE 镜像必须填写 ZIP 内的相对路径：${cuePath}`)
      }
      // IMGMount 读的是 Web 虚拟宿主文件系统，路径大小写敏感；DOS 程序名那套大小写宽容不适用。
      const cue = byName.get(cuePath)
      if (!cue) throw new Error(`ZIP 里找不到挂载命令指定的 CUE 镜像（大小写须一致）：${cuePath}`)
      if (cue.uncompressedSize > 65536) throw new Error(`CUE 文件大小异常：${cuePath}`)
      const data = await extractZipEntry(buf, {
        name: cue.name,
        method: cue.method,
        compressedSize: cue.compressedSize,
        uncompressedSize: cue.uncompressedSize,
        crc32: cue.crc,
        offset: cue.localOffset,
      })
      const cueText = new TextDecoder().decode(data)
      const cueDir = cuePath.includes('/') ? cuePath.slice(0, cuePath.lastIndexOf('/') + 1) : ''
      for (const cueLine of cueText.split(/\r?\n/)) {
        const track = /^\s*FILE\s+(?:"([^"]+)"|(\S+))/i.exec(cueLine)
        if (!track) continue
        const trackPath = (track[1] ?? track[2]).replace(/\\/g, '/')
        if (trackPath.startsWith('/') || trackPath.includes(':') || trackPath.split('/').includes('..')) {
          throw new Error(`CUE 音轨必须引用 ZIP 内的相对文件：${trackPath}`)
        }
        // CUE 的 FILE 相对自身目录，不是相对 ZIP 根；漏音轨时先报错才不会无盘进菜单。
        if (!byName.has(cueDir + trackPath)) {
          throw new Error(`ZIP 里找不到 CUE 引用的音轨文件：${cueDir + trackPath}`)
        }
      }
    }
  }

  const bundledConf = entries?.find((e) => e.name.toLowerCase() === '.jsdos/dosbox.conf')
  /*
    没有高级覆盖、**也没有指定启动程序**时才零拷贝透传；避免仅仅为了换一份几 KB 的
    配置复制整块系统镜像。

    ⚠️ 以前这里只看 configOverride，于是后台「启动程序」那一栏（提示语写着「猜错时
    填这里一锤定音」）对**自带 dosbox.conf 的 .jsdos 包完全无效**，而且一声不吭：
    管理员填了 PARANOID.COM 保存，玩家点开进的还是包里 conf 指向的安装界面，
    改三次配置清三次缓存都找不到原因。
  */
  if (bundledConf && !wantedExtras.size && !configOverride?.trim() && !conf && !configuredExecutable && !startupCommands?.trim()) {
    return { blob: new Blob([buf], { type: 'application/zip' }), executable: null, passthrough: true }
  }

  if (entries && bundledConf) {
    if (bundledConf.uncompressedSize > 1024 * 1024) throw new Error('ROM 内的 dosbox.conf 大小异常')
    const extracted = await extractZipEntry(buf, {
      name: bundledConf.name,
      method: bundledConf.method,
      compressedSize: bundledConf.compressedSize,
      uncompressedSize: bundledConf.uncompressedSize,
      crc32: bundledConf.crc,
      offset: bundledConf.localOffset,
    })
    const picked = configuredExecutable ?? (startupCommands?.trim() ? pickExecutable(entries.map((e) => e.name)) : null)
    const launch = picked ? dosLaunchTarget(entries, buf, picked) : null
    // 后台指定了启动程序就以我们生成的那份为基底，否则用包里自带的。
    // 长文件名必须改用真实写进包里的别名，不能继续沿用调用方提前生成的坏命令。
    const base = launch?.alias
      ? buildDosboxConf(launch.path, startupCommands)
      : conf ?? (configuredExecutable
          ? buildDosboxConf(launch?.path ?? configuredExecutable, startupCommands)
          : startupCommands?.trim()
            ? buildDosboxConf(launch?.path ?? picked, startupCommands)
            : new TextDecoder().decode(extracted))
    const merged = te.encode(mergeDosboxConfigOverride(base, configOverride)) as Uint8Array<ArrayBuffer>
    const out: OutEntry[] = []
    for (const e of entries) {
      if (e.name.toLowerCase() === '.jsdos/dosbox.conf') continue
      if (wantedExtras.has(e.name.toLowerCase())) continue
      out.push({
        name: e.name,
        method: e.method,
        crc: e.crc,
        compressedSize: e.compressedSize,
        uncompressedSize: e.uncompressedSize,
        data: rawData(buf, e),
      })
    }
    if (launch?.alias) out.push(launch.alias)
    out.push(...extraOutEntries(wantedExtras, out.map((entry) => entry.name)))
    if (!entries.some((e) => e.name.toLowerCase() === '.jsdos/')) {
      out.push({ name: '.jsdos/', method: 0, crc: 0, compressedSize: 0, uncompressedSize: 0, data: new Uint8Array(0) as Uint8Array<ArrayBuffer> })
    }
    out.push({
      name: '.jsdos/dosbox.conf',
      method: 0,
      crc: crc32(merged),
      compressedSize: merged.length,
      uncompressedSize: merged.length,
      data: merged,
    })
    return { blob: buildZip(out), executable: null, passthrough: false }
  }

  const out: OutEntry[] = []
  let exe: string | null = null
  let launchExe: string | null = null

  if (entries) {
    exe = configuredExecutable ?? pickExecutable(entries.map((e) => e.name), name)
    if (!exe) throw new Error('DOS 压缩包里没有可运行的 .exe、.com 或 .bat 文件')

    /**
     * 目录条目必须保留，缺的还要补齐 —— 这里原来是一行
     * `if (e.name.endsWith('/')) continue`，注释写着「js-dos 不需要」，恰恰说反了。
     *
     * js-dos 的 wasm 解包器（emulators 的 extract bundle 那一步）逐条往虚拟盘上写，
     * **不会替文件补建父目录**：轮到 SIMDATA/MISC/TR2.TRI 时，前面若没出现过
     * SIMDATA/、SIMDATA/MISC/ 两个目录条目，写文件直接 ENOENT，DOSBox 当场 exit(1)，
     * 而且 js-dos 不发任何 error 事件 —— 玩家看到的就是一块黑屏。
     * 极品飞车（needfspd.zip）就是这么挂的：原包目录条目本来齐全，被这行全扔了。
     *
     * 做法：不依赖原包目录条目的有无与顺序，从**所有文件路径**推导出完整目录集合
     * （原有目录条目也并进来 —— 只有这样空目录才不会丢，有的游戏要往里写存档），
     * 按深度排好放在最前面，保证解到任何文件时它的父目录都已经建好。
     */
    const dirs = new Set<string>()
    for (const e of entries) {
      if (e.name.endsWith('/')) {
        dirs.add(e.name)
        continue
      }
      const parts = e.name.split('/')
      let prefix = ''
      for (let i = 0; i < parts.length - 1; i++) {
        prefix += parts[i] + '/'
        dirs.add(prefix)
      }
    }
    for (const extra of wantedExtras.values()) {
      const parts = extra.path.split('/')
      let prefix = ''
      for (let i = 0; i < parts.length - 1; i++) {
        prefix += parts[i] + '/'
        dirs.add(prefix)
      }
    }
    const empty = new Uint8Array(0) as Uint8Array<ArrayBuffer>
    for (const dir of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))) {
      out.push({ name: dir, method: 0, crc: 0, compressedSize: 0, uncompressedSize: 0, data: empty })
    }
    for (const e of entries) {
      if (e.name.endsWith('/')) continue // 目录都在上面统一发过了
      if (wantedExtras.has(e.name.toLowerCase())) continue
      out.push({
        name: e.name,
        method: e.method,
        crc: e.crc,
        compressedSize: e.compressedSize,
        uncompressedSize: e.uncompressedSize,
        data: rawData(buf, e), // 压缩数据整段照抄，不解压
      })
    }
    const launch = dosLaunchTarget(entries, buf, exe)
    launchExe = launch.path
    if (launch.alias) out.push(launch.alias)
    out.push(...extraOutEntries(wantedExtras, out.map((entry) => entry.name)))
  } else {
    // 不是 zip：当成单个可执行文件塞进去
    const file = name.split(/[\\/]/).pop() || 'game.exe'
    if (!/\.(exe|com|bat)$/i.test(file)) throw new Error('DOS 游戏必须是 ZIP、JSDOS、EXE、COM 或 BAT 文件')
    if (buf.byteLength === 0) throw new Error('DOS 游戏文件为空')
    const safe = safeArchivePath(file)
    if (!safe) throw new Error(`DOS 游戏文件名不安全：${file}`)
    const data = new Uint8Array(buf) as Uint8Array<ArrayBuffer>
    exe = file
    const ext = file.slice(file.lastIndexOf('.') + 1).toUpperCase()
    launchExe = isDos83Path(file) ? file : `8BITGO.${ext}`
    out.push({ name: launchExe, method: 0, crc: crc32(data), compressedSize: data.length, uncompressedSize: data.length, data })
  }

  // conf 参数来自旧调用方时只适用于原文件名；别名场景必须重建 autoexec，否则已修好的别名不会被执行。
  const baseConf = launchExe !== exe ? buildDosboxConf(launchExe, startupCommands) : conf ?? buildDosboxConf(launchExe, startupCommands)
  const confBytes = te.encode(
    mergeDosboxConfigOverride(baseConf, configOverride),
  ) as Uint8Array<ArrayBuffer>
  // conf 自己的父目录同理要先建好（单个 exe 的分支也走到这里，那边一个目录条目都没有）
  out.push({ name: '.jsdos/', method: 0, crc: 0, compressedSize: 0, uncompressedSize: 0, data: new Uint8Array(0) as Uint8Array<ArrayBuffer> })
  out.push({
    name: '.jsdos/dosbox.conf',
    method: 0, // 存储，不压缩：几百字节而已
    crc: crc32(confBytes),
    compressedSize: confBytes.length,
    uncompressedSize: confBytes.length,
    data: confBytes,
  })

  return { blob: buildZip(out), executable: exe, passthrough: false }
}
