/**
 * Windows 3.x 客体：开机前改系统盘里的 C:\WINDOWS\SYSTEM.INI。
 *
 * ── 为什么（2026-10-27，《经典食人花》Zeek the Geek）──────────────
 * 游戏一启动就用 MCI 播 MIDI。Win3.1 的 MIDI 音序器（MCISEQ.DRV）发现曲子不是按微软的
 * 「通用 MIDI 制作规范」写的，就弹「This file may not play correctly with the default MIDI
 * setup」。这个提示框**被游戏主窗口压在下面**，而游戏的 MCI 调用要等它关掉才返回 ——
 * 玩家看到的是一扇纯白的「Zeek Part 1」窗口，没菜单、没棋盘、没有报错，点哪儿都没反应。
 * 线上实测：把游戏窗口最小化才露出那个对话框；勾「不再提示」后 Windows 往 SYSTEM.INI 写的
 * 正是 `[mciseq.drv] disablewarning=true`，带上这一行开机，片头后直接进棋盘。
 *
 * 2026-09-11 曾把它当成「16 色游戏在真彩桌面上画不出来」，换了 VGA 镜像
 * （system-win311-vga-v1），但白窗口其实一直都在 —— 根因是这个对话框。
 *
 * ── 怎么改 ──────────────────────────────────────────────────────
 * 系统盘是包在 .jsdos 里的 qcow2。这里在主线程解出那一项、按 qcow2 → MBR → FAT16
 * 找到 SYSTEM.INI，原地写回，再把系统包里的 qcow2 **换成**改好的这份（stored，不再压缩）。
 * 系统包整体在 wc-run 时才由 worker 解开，所以 DOS 开机时看到的就是新文件，不存在和
 * SMARTDRV 缓存赛跑的问题。
 *
 * ⚠️ 不能用 initFs 的 `{ path, contents }` 单独覆盖：js-dos 先把 file 层直接写进 worker，
 * bundle 层要到 wc-run 才解，系统包里那份原版 qcow2 会反过来盖掉它（2026-10-27 实测）。
 *
 * 只做「不分配新簇」的修改：新内容必须装得进文件现有簇链（INI 的最后一簇几乎总有余量），
 * 装不下、遇到压缩簇、不是 FAT16 …… 一律原样放行，只在控制台记一句 —— 镜像在这条路上
 * 出任何意外，最坏也只是退回今天的行为，绝不能把能开机的系统改坏。
 */
import { crc32, extractZipEntry, listZipEntries } from '@/lib/unzip'

export interface IniSetting {
  section: string
  key: string
  value: string
}

/** 所有 Win3.x 客体都要的设置。见文件头。 */
export const WIN3X_SYSTEM_INI_SETTINGS: readonly IniSetting[] = [
  { section: 'mciseq.drv', key: 'disablewarning', value: 'true' },
]

/* ---------------- INI 文本 ---------------- */

/**
 * 确保 `[section] key=value`。已有同值返回原文；已有不同值就改那一行；
 * 没有这一节就追加在文件末尾。行尾一律 CRLF（Windows 3.x 的 INI 就是这样写的）。
 */
export function ensureIniSetting(text: string, { section, key, value }: IniSetting): string {
  const lines = text.split(/\r\n|\n/)
  const sectionRe = /^\s*\[([^\]]*)\]\s*$/
  let inSection = false
  let sectionEnd = -1
  for (let i = 0; i < lines.length; i++) {
    const head = sectionRe.exec(lines[i])
    if (head) {
      if (inSection) break
      inSection = head[1].trim().toLowerCase() === section.toLowerCase()
      if (inSection) sectionEnd = i + 1
      continue
    }
    if (!inSection) continue
    const eq = lines[i].indexOf('=')
    if (eq > 0 && lines[i].slice(0, eq).trim().toLowerCase() === key.toLowerCase()) {
      if (lines[i].slice(eq + 1).trim().toLowerCase() === value.toLowerCase()) return text
      lines[i] = `${key}=${value}`
      return lines.join('\r\n')
    }
    if (lines[i].trim()) sectionEnd = i + 1
  }
  if (sectionEnd >= 0) {
    lines.splice(sectionEnd, 0, `${key}=${value}`)
    return lines.join('\r\n')
  }
  const body = text.replace(/[\r\n]*$/, '')
  return `${body}${body ? '\r\n\r\n' : ''}[${section}]\r\n${key}=${value}\r\n`
}

/* ---------------- qcow2：按客体偏移读写（只认已分配、未压缩的簇） ---------------- */

class Qcow2 {
  private readonly bytes: Uint8Array
  private readonly dv: DataView
  readonly clusterSize: number
  private readonly l1Size: number
  private readonly l1Offset: number
  private readonly l2Entries: number

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (bytes.length < 72 || this.dv.getUint32(0) !== 0x514649fb) throw new Error('不是 qcow2')
    const version = this.dv.getUint32(4)
    if (version !== 2 && version !== 3) throw new Error(`不支持的 qcow2 版本 ${version}`)
    if (this.dv.getUint32(32) !== 0) throw new Error('qcow2 是加密的')
    const clusterBits = this.dv.getUint32(20)
    if (clusterBits < 9 || clusterBits > 21) throw new Error('qcow2 簇大小异常')
    this.clusterSize = 2 ** clusterBits
    this.l1Size = this.dv.getUint32(36)
    this.l1Offset = this.u64(40)
    this.l2Entries = this.clusterSize / 8
  }

  private u64(at: number): number {
    return this.dv.getUint32(at) * 2 ** 32 + this.dv.getUint32(at + 4)
  }

  /**
   * L1 / L2 表项里的宿主偏移（bit 9..55）。高位是标志（bit 63 = COPIED，bit 62 = 压缩），
   * 必须先在 32 位整数上屏蔽掉再拼 —— 直接拼成 64 位浮点数会因为 bit 63 丢掉低位精度。
   */
  private entryOffset(at: number): number {
    const hi = this.dv.getUint32(at) & 0x00ffffff
    const lo = this.dv.getUint32(at + 4) & 0xfffffe00
    return hi * 2 ** 32 + (lo >>> 0)
  }

  /** 客体偏移 → 宿主偏移；未分配返回 null。标志位按 qcow2 规范屏蔽（bit 62 = 压缩簇） */
  private host(off: number): number | null {
    const perL1 = this.clusterSize * this.l2Entries
    const l1i = Math.floor(off / perL1)
    const l2i = Math.floor(off / this.clusterSize) % this.l2Entries
    if (l1i >= this.l1Size) return null
    const l2Table = this.entryOffset(this.l1Offset + l1i * 8)
    if (!l2Table) return null
    if (l2Table + (l2i + 1) * 8 > this.bytes.length) throw new Error('qcow2 L2 表越界')
    if (this.dv.getUint32(l2Table + l2i * 8) & 0x40000000) throw new Error('遇到压缩簇')
    // qcow2 v3 的 bit 0 = 「这一簇读出来全是 0」，哪怕表项里还留着宿主偏移；当未分配处理
    if (this.dv.getUint32(l2Table + l2i * 8 + 4) & 1) return null
    const cluster = this.entryOffset(l2Table + l2i * 8)
    if (!cluster) return null
    return cluster + (off % this.clusterSize)
  }

  read(off: number, n: number): Uint8Array {
    const out = new Uint8Array(n)
    let at = 0
    while (at < n) {
      const step = Math.min(n - at, this.clusterSize - (off % this.clusterSize))
      const h = this.host(off)
      if (h !== null) {
        if (h + step > this.bytes.length) throw new Error('qcow2 数据簇越界')
        out.set(this.bytes.subarray(h, h + step), at)
      }
      off += step
      at += step
    }
    return out
  }

  write(off: number, data: Uint8Array): void {
    let at = 0
    while (at < data.length) {
      const step = Math.min(data.length - at, this.clusterSize - (off % this.clusterSize))
      const h = this.host(off)
      if (h === null) throw new Error('目标位置没有分配簇')
      this.bytes.set(data.subarray(at, at + step), h)
      off += step
      at += step
    }
  }
}

/* ---------------- FAT16 ---------------- */

interface FatFile {
  /** 目录项在客体盘上的偏移 */
  entryAt: number
  firstCluster: number
  size: number
}

class Fat16 {
  private readonly disk: Qcow2
  private readonly bps: number
  private readonly fat: number
  private readonly root: number
  private readonly rootEntries: number
  private readonly data: number
  readonly clusterBytes: number
  private readonly clusterCount: number

  constructor(disk: Qcow2) {
    this.disk = disk
    const mbr = disk.read(0, 512)
    if (mbr[510] !== 0x55 || mbr[511] !== 0xaa) throw new Error('没有 MBR')
    const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)
    let part = -1
    for (let i = 0; i < 4; i++) {
      const e = 446 + i * 16
      const type = mbr[e + 4]
      // 0x04 / 0x06 / 0x0E 是 FAT16；别的分区类型不碰
      if ((type === 0x04 || type === 0x06 || type === 0x0e) && dv(mbr).getUint32(e + 12, true)) {
        part = dv(mbr).getUint32(e + 8, true) * 512
        break
      }
    }
    if (part < 0) throw new Error('找不到 FAT16 分区')
    const b = disk.read(part, 512)
    const v = dv(b)
    this.bps = v.getUint16(11, true)
    const spc = b[13]
    const reserved = v.getUint16(14, true)
    const fats = b[16]
    this.rootEntries = v.getUint16(17, true)
    const fatSectors = v.getUint16(22, true)
    const totalSectors = v.getUint16(19, true) || v.getUint32(32, true)
    if (this.bps !== 512 || !spc || !fats || !fatSectors || !this.rootEntries) throw new Error('BPB 不像 FAT16')
    this.fat = part + reserved * this.bps
    this.root = this.fat + fats * fatSectors * this.bps
    this.data = this.root + Math.ceil((this.rootEntries * 32) / this.bps) * this.bps
    this.clusterBytes = spc * this.bps
    this.clusterCount = Math.floor((totalSectors - (this.data - part) / this.bps) / spc)
    if (this.clusterCount < 4085 || this.clusterCount >= 65525) throw new Error('不是 FAT16')
  }

  private next(n: number): number | null {
    const raw = this.disk.read(this.fat + n * 2, 2)
    const v = raw[0] | (raw[1] << 8)
    return v >= 0xfff8 || v < 2 ? null : v
  }

  /** 簇链 → 每簇在客体盘上的偏移 */
  chain(first: number): number[] {
    const out: number[] = []
    const seen = new Set<number>()
    for (let n: number | null = first; n !== null; n = this.next(n)) {
      if (seen.has(n) || n >= this.clusterCount + 2) throw new Error('FAT 簇链异常')
      seen.add(n)
      out.push(this.data + (n - 2) * this.clusterBytes)
    }
    return out
  }

  private *entries(regions: Array<[number, number]>): Generator<{ name: string; attr: number; cluster: number; size: number; at: number }> {
    for (const [start, length] of regions) {
      const raw = this.disk.read(start, length)
      const v = new DataView(raw.buffer)
      for (let i = 0; i + 32 <= raw.length; i += 32) {
        if (raw[i] === 0) return
        if (raw[i] === 0xe5 || raw[i + 11] === 0x0f) continue
        const text = (a: number, b: number) => String.fromCharCode(...raw.subarray(a, b)).trimEnd()
        const ext = text(i + 8, i + 11)
        yield {
          name: (text(i, i + 8) + (ext ? `.${ext}` : '')).toUpperCase(),
          attr: raw[i + 11],
          cluster: v.getUint16(i + 26, true),
          size: v.getUint32(i + 28, true),
          at: start + i,
        }
      }
    }
  }

  find(path: string): FatFile {
    const parts = path.toUpperCase().split('/')
    let regions: Array<[number, number]> = [[this.root, this.rootEntries * 32]]
    for (let depth = 0; depth < parts.length; depth++) {
      let hit: { attr: number; cluster: number; size: number; at: number } | null = null
      for (const e of this.entries(regions)) {
        if (e.name === parts[depth]) {
          hit = e
          break
        }
      }
      if (!hit) throw new Error(`找不到 ${path}`)
      if (depth === parts.length - 1) {
        if (hit.attr & 0x10) throw new Error(`${path} 是目录`)
        return { entryAt: hit.at, firstCluster: hit.cluster, size: hit.size }
      }
      if (!(hit.attr & 0x10)) throw new Error(`${parts[depth]} 不是目录`)
      regions = this.chain(hit.cluster).map((o) => [o, this.clusterBytes])
    }
    throw new Error('路径为空')
  }

  readFile(file: FatFile): Uint8Array {
    const out = new Uint8Array(file.size)
    let at = 0
    for (const o of this.chain(file.firstCluster)) {
      if (at >= file.size) break
      const part = this.disk.read(o, Math.min(this.clusterBytes, file.size - at))
      out.set(part, at)
      at += part.length
    }
    if (at < file.size) throw new Error('簇链比文件短')
    return out
  }

  /** 只在现有簇链里重写，不分配新簇；同时改目录项里的大小 */
  rewriteFile(file: FatFile, data: Uint8Array): void {
    const offsets = this.chain(file.firstCluster)
    if (data.length > offsets.length * this.clusterBytes) throw new Error('现有簇链装不下新内容')
    let at = 0
    for (const o of offsets) {
      if (at >= data.length) break
      const part = data.subarray(at, Math.min(data.length, at + this.clusterBytes))
      this.disk.write(o, part)
      at += part.length
    }
    const size = new Uint8Array(4)
    new DataView(size.buffer).setUint32(0, data.length, true)
    this.disk.write(file.entryAt + 28, size)
  }
}

/* ---------------- 对外 ---------------- */

const latin1 = (bytes: Uint8Array) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return s
}
const fromLatin1 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff)

/**
 * 在 qcow2 镜像（会被原地修改）里确保 SYSTEM.INI 含有给定设置。
 * 返回是否真的改了；任何结构异常都抛错，由调用方决定放行。
 */
export function patchWin3xSystemIni(
  qcow2: Uint8Array,
  settings: readonly IniSetting[] = WIN3X_SYSTEM_INI_SETTINGS,
): boolean {
  const fs = new Fat16(new Qcow2(qcow2))
  const file = fs.find('WINDOWS/SYSTEM.INI')
  const before = latin1(fs.readFile(file))
  const after = settings.reduce((text, setting) => ensureIniSetting(text, setting), before)
  if (after === before) return false
  fs.rewriteFile(file, fromLatin1(after))
  return true
}

/**
 * 把 zip 里名为 `name` 的成员换成新的未压缩内容，其它成员的本地头和数据原样保留。
 * 旧成员若不在末尾，它的数据会留在文件里，但中央目录不再指向它，解包器不会读到。
 */
export function replaceZipEntryStored(zip: Uint8Array, name: string, data: Uint8Array): Uint8Array {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip: 找不到中央目录')
  const count = dv.getUint16(eocd + 10, true)
  const centralSize = dv.getUint32(eocd + 12, true)
  const centralOffset = dv.getUint32(eocd + 16, true)
  if (centralOffset + centralSize > zip.length) throw new Error('zip: 中央目录越界')

  const kept: Uint8Array[] = []
  let replaced = 0
  let oldLocal = -1
  let oldEnd = -1
  for (let p = centralOffset, i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip: 中央目录损坏')
    const size = 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true)
    const entryName = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + dv.getUint16(p + 28, true)))
    if (entryName === name) {
      replaced++
      oldLocal = dv.getUint32(p + 42, true)
      if (oldLocal + 30 <= zip.length && dv.getUint32(oldLocal, true) === 0x04034b50) {
        oldEnd = oldLocal + 30 + dv.getUint16(oldLocal + 26, true) + dv.getUint16(oldLocal + 28, true) + dv.getUint32(p + 20, true)
      }
    } else kept.push(zip.subarray(p, p + size))
    p += size
  }
  if (replaced !== 1) throw new Error(`zip: ${name} 应该正好一项，找到 ${replaced}`)
  // 旧成员恰好是中央目录前的最后一块（系统包就是这样）：直接从它的本地头处截断，省掉一整份旧镜像
  const keepUntil = oldEnd === centralOffset ? oldLocal : centralOffset

  const nameBytes = new TextEncoder().encode(name)
  const crc = crc32(data)
  const keptBytes = kept.reduce((n, k) => n + k.length, 0)
  const out = new Uint8Array(keepUntil + 30 + nameBytes.length + data.length + keptBytes + 46 + nameBytes.length + 22)
  const ov = new DataView(out.buffer)
  out.set(zip.subarray(0, keepUntil), 0)
  // 本地文件头（30 字节 + 名字），stored、无扩展字段
  const local = keepUntil
  ov.setUint32(local, 0x04034b50, true)
  ov.setUint16(local + 4, 20, true) // version needed
  ov.setUint16(local + 6, 0, true) // flags：名字是 ASCII
  ov.setUint16(local + 8, 0, true) // method = stored
  ov.setUint16(local + 10, 0, true) // time
  ov.setUint16(local + 12, 0x0021, true) // date = 1980-01-01
  ov.setUint32(local + 14, crc, true)
  ov.setUint32(local + 18, data.length, true)
  ov.setUint32(local + 22, data.length, true)
  ov.setUint16(local + 26, nameBytes.length, true)
  ov.setUint16(local + 28, 0, true)
  out.set(nameBytes, local + 30)
  out.set(data, local + 30 + nameBytes.length)
  let p = local + 30 + nameBytes.length + data.length
  // 中央目录：其它成员的记录原样抄（它们的 localOffset 都在 centralOffset 之前，没动过）
  const newCentral = p
  for (const k of kept) {
    out.set(k, p)
    p += k.length
  }
  ov.setUint32(p, 0x02014b50, true)
  ov.setUint16(p + 4, 20, true) // version made by
  ov.setUint16(p + 6, 20, true) // version needed
  ov.setUint16(p + 8, 0, true)
  ov.setUint16(p + 10, 0, true) // stored
  ov.setUint16(p + 12, 0, true)
  ov.setUint16(p + 14, 0x0021, true)
  ov.setUint32(p + 16, crc, true)
  ov.setUint32(p + 20, data.length, true)
  ov.setUint32(p + 24, data.length, true)
  ov.setUint16(p + 28, nameBytes.length, true)
  // extra / comment / disk / 内外属性都为 0（新数组本来就是 0）
  ov.setUint32(p + 42, local, true)
  out.set(nameBytes, p + 46)
  p += 46 + nameBytes.length
  ov.setUint32(p, 0x06054b50, true)
  ov.setUint16(p + 8, kept.length + 1, true)
  ov.setUint16(p + 10, kept.length + 1, true)
  ov.setUint32(p + 12, p - newCentral, true)
  ov.setUint32(p + 16, newCentral, true)
  return out
}

/**
 * Win3.x 系统包：返回 SYSTEM.INI 已补好设置的新系统包。
 * 不需要改（已经有那一行）或者改不了时返回 null —— 调用方照旧用原包启动即可。
 */
export async function win3xPatchedSystemLayer(systemBundle: Uint8Array): Promise<Uint8Array | null> {
  // listZipEntries 要的是 ArrayBuffer；系统包通常就是整块 buffer，别白复制几 MB
  const whole = systemBundle.byteOffset === 0 && systemBundle.byteLength === systemBundle.buffer.byteLength
  const buf = (whole ? systemBundle.buffer : systemBundle.slice().buffer) as ArrayBuffer
  const disks = listZipEntries(buf).filter((e) => /^[^/]+\.qcow2$/i.test(e.name))
  if (disks.length !== 1) return null
  const extracted = await extractZipEntry(buf, disks[0])
  // stored 成员返回的是系统包的视图：必须复制，否则改到的是 zip 里那份
  const qcow2 = extracted.buffer === buf ? extracted.slice() : extracted
  if (!patchWin3xSystemIni(qcow2)) return null
  return replaceZipEntryStored(new Uint8Array(buf), disks[0].name, qcow2)
}
