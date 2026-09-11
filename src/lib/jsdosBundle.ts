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
  const parts: Uint8Array<ArrayBuffer>[] = []
  const central: Uint8Array<ArrayBuffer>[] = []
  let offset = 0

  for (const e of entries) {
    const name = te.encode(e.name) as Uint8Array<ArrayBuffer>
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0, true) // flags：不用数据描述符，长度都写在头里
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
    cv.setUint16(8, 0, true)
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
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0)
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
export function buildDosboxConf(exe: string | null): string {
  const dir = exe && exe.includes('/') ? exe.slice(0, exe.lastIndexOf('/')) : ''
  const file = exe ? exe.slice(exe.lastIndexOf('/') + 1) : ''
  const lines = [
    '[sdl]',
    'autolock=false',
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
    '[autoexec]',
    'mount c .',
    'c:',
  ]
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
    lines.push(file.includes(' ') ? `"${file}"` : file)
    lines.push(`@echo ${file} 已退出。如果刚才画面上什么都没发生，多半是找不到文件或缺少依赖。`)
  }
  else lines.push('@echo 没有找到可执行文件，请手动运行游戏。')
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
  const clean = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!clean) return null
  // 解包发生在模拟器的虚拟文件系统里，但 ../ 仍能覆盖系统层和最终 dosbox.conf。
  if (clean.split('/').some((part) => !part || part === '.' || part === '..')) return null
  // 客体 Windows 本身也处理不了文件名里的控制字符，越早报错越容易定位到包的问题。
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(clean)) return null
  return clean
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
  const entries = readZipEntries(buf)
  const bytes = new Uint8Array(buf)
  const zipLike = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
  if (!zipLike || !entries) throw new Error('Windows 客体游戏必须上传完整 ZIP，不能只上传单个 EXE')
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
  const entries = readZipEntries(buf)
  if (!entries) throw new Error('要加附加文件的 ROM 不是一个可读的 ZIP')
  assertRepackable(entries)

  const clean = (p: string) => p.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^\/+/, '')
  const wanted = new Map<string, ExtraFile>()
  for (const e of extras) {
    const path = clean(e.path)
    if (!path || path.endsWith('/')) continue
    wanted.set(path.toLowerCase(), { path, data: e.data })
  }
  if (!wanted.size) return buf

  const out: OutEntry[] = []
  const have = new Set<string>()
  for (const e of entries) {
    // 同名的让位给附加文件
    if (wanted.has(e.name.toLowerCase())) continue
    have.add(e.name.toLowerCase())
    out.push({
      name: e.name,
      method: e.method,
      crc: e.crc,
      compressedSize: e.compressedSize,
      uncompressedSize: e.uncompressedSize,
      data: rawData(buf, e),
    })
  }

  const dir = (name: string): OutEntry => ({
    name,
    method: 0,
    crc: 0,
    compressedSize: 0,
    uncompressedSize: 0,
    data: new Uint8Array(0) as Uint8Array<ArrayBuffer>,
  })

  for (const { path, data } of wanted.values()) {
    // 缺的父目录逐层补上，见上面那条 ⚠️
    const segments = path.split('/')
    for (let i = 1; i < segments.length; i++) {
      const d = segments.slice(0, i).join('/') + '/'
      if (have.has(d.toLowerCase())) continue
      have.add(d.toLowerCase())
      out.push(dir(d))
    }
    out.push({
      name: path,
      method: 0,
      crc: crc32(data),
      compressedSize: data.length,
      uncompressedSize: data.length,
      data,
    })
  }

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
  /** 后台填的启动程序原文，只用来做存在性校验（conf 已经由调用方生成好了） */
  dosExecutable?: string,
): Promise<BundleResult> {
  const entries = readZipEntries(buf)
  const bytes = new Uint8Array(buf)
  const zipLike = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
  if (zipLike && !entries) throw new Error('DOS 压缩包为空、已损坏或下载不完整')

  if (entries) assertRepackable(entries)
  /*
    ⚠️ 后台填的启动程序，包里必须真有。
    以前一个字都不验，直接拼进 [autoexec]：管理员填错一个字母（或者游戏换了个包），
    DOSBox 照常起来、ci-ready 照常到、遮罩照常撤，玩家对着一个 `C:\>` 提示符 ——
    这类反馈只会以「这游戏打不开」的形式回来，没人查得到是配置写错了。
    在这里抛是在 Dos() 之前，能吃自动重试，最后给出一句指名道姓的错误。
    对照组：makeWindowsGameLayer 早就有同一道校验（找不到就 throw）。
  */
  if (entries && dosExecutable?.trim()) {
    const wanted = dosExecutable.trim().replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase()
    if (!entries.some((e) => e.name.toLowerCase() === wanted)) {
      throw new Error(`ZIP 里找不到后台配置的启动程序：${dosExecutable.trim()}`)
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
  if (bundledConf && !configOverride?.trim() && !conf) {
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
    // 后台指定了启动程序就以我们生成的那份为基底，否则用包里自带的
    const base = conf ?? new TextDecoder().decode(extracted)
    const merged = te.encode(mergeDosboxConfigOverride(base, configOverride)) as Uint8Array<ArrayBuffer>
    const out: OutEntry[] = []
    for (const e of entries) {
      if (e.name.toLowerCase() === '.jsdos/dosbox.conf') continue
      out.push({
        name: e.name,
        method: e.method,
        crc: e.crc,
        compressedSize: e.compressedSize,
        uncompressedSize: e.uncompressedSize,
        data: rawData(buf, e),
      })
    }
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

  if (entries) {
    exe = pickExecutable(entries.map((e) => e.name), name)
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
    const empty = new Uint8Array(0) as Uint8Array<ArrayBuffer>
    for (const dir of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))) {
      out.push({ name: dir, method: 0, crc: 0, compressedSize: 0, uncompressedSize: 0, data: empty })
    }
    for (const e of entries) {
      if (e.name.endsWith('/')) continue // 目录都在上面统一发过了
      out.push({
        name: e.name,
        method: e.method,
        crc: e.crc,
        compressedSize: e.compressedSize,
        uncompressedSize: e.uncompressedSize,
        data: rawData(buf, e), // 压缩数据整段照抄，不解压
      })
    }
  } else {
    // 不是 zip：当成单个可执行文件塞进去
    const file = name.split(/[\\/]/).pop() || 'game.exe'
    if (!/\.(exe|com|bat)$/i.test(file)) throw new Error('DOS 游戏必须是 ZIP、JSDOS、EXE、COM 或 BAT 文件')
    if (buf.byteLength === 0) throw new Error('DOS 游戏文件为空')
    const data = new Uint8Array(buf) as Uint8Array<ArrayBuffer>
    exe = file
    out.push({ name: file, method: 0, crc: crc32(data), compressedSize: data.length, uncompressedSize: data.length, data })
  }

  const confBytes = te.encode(
    mergeDosboxConfigOverride(conf ?? buildDosboxConf(exe), configOverride),
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
