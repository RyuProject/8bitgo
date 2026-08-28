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

const te = new TextEncoder()

/* ---------------- zip 读 ---------------- */

interface ZipEntry {
  name: string
  method: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
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
  const eocd = findEocd(v)
  if (eocd < 0) return null
  const count = v.getUint16(eocd + 10, true)
  let at = v.getUint32(eocd + 16, true)
  const out: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.byteLength || v.getUint32(at, true) !== CEN_SIG) return null
    const nameLen = v.getUint16(at + 28, true)
    const extraLen = v.getUint16(at + 30, true)
    const commentLen = v.getUint16(at + 32, true)
    const name = new TextDecoder().decode(new Uint8Array(buf, at + 46, nameLen))
    out.push({
      name,
      flags: v.getUint16(at + 8, true),
      method: v.getUint16(at + 10, true),
      crc: v.getUint32(at + 16, true),
      compressedSize: v.getUint32(at + 20, true),
      uncompressedSize: v.getUint32(at + 24, true),
      localOffset: v.getUint32(at + 42, true),
    })
    at += 46 + nameLen + extraLen + commentLen
  }
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

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(data: Uint8Array<ArrayBuffer>): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface OutEntry {
  name: string
  method: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  data: Uint8Array<ArrayBuffer>
}

function buildZip(entries: OutEntry[]): Blob {
  const parts: BlobPart[] = []
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

  return new Blob([...parts, ...central, eocd], { type: 'application/zip' })
}

/* ---------------- dosbox.conf ---------------- */

const RUNNABLE = /\.(exe|com|bat)$/i
/** 一看就不是游戏本体的东西，排在后面 */
const NOT_GAME = /(^|\/)(install|setup|config|setsound|readme|uninst|dos4gw|cwsdpmi)/i

/** 从文件列表里猜一个启动程序 */
export function pickExecutable(names: string[]): string | null {
  const runnable = names.filter((n) => RUNNABLE.test(n) && !n.startsWith('.jsdos/'))
  if (runnable.length === 0) return null
  const score = (n: string) => {
    let s = 0
    if (NOT_GAME.test(n)) s -= 10
    if (/\.bat$/i.test(n)) s += 3 // 作者自己写的启动批处理通常最靠谱
    if (/\.exe$/i.test(n)) s += 2
    s -= (n.split('/').length - 1) * 2 // 越靠近根目录越可能是主程序
    s -= n.length * 0.01
    return s
  }
  return runnable.sort((a, b) => score(b) - score(a))[0]
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
  if (dir) lines.push(`cd ${dir.replace(/\//g, '\\')}`)
  if (file) lines.push(file)
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
}

/**
 * 把一份 DOS 游戏（zip / exe / com，或已经打好的 .jsdos）变成 js-dos 能跑的 bundle。
 * conf 允许外部覆盖（例如用户在界面上手动选了启动程序）。
 */
export function makeJsdosBundle(name: string, buf: ArrayBuffer, conf?: string): BundleResult {
  const entries = readZipEntries(buf)

  // 已经是 bundle：原样返回
  if (entries?.some((e) => e.name === '.jsdos/dosbox.conf')) {
    return { blob: new Blob([buf], { type: 'application/zip' }), executable: null, passthrough: true }
  }

  const out: OutEntry[] = []
  let exe: string | null = null

  if (entries) {
    exe = pickExecutable(entries.map((e) => e.name))

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
    const data = new Uint8Array(buf) as Uint8Array<ArrayBuffer>
    exe = file
    out.push({ name: file, method: 0, crc: crc32(data), compressedSize: data.length, uncompressedSize: data.length, data })
  }

  const confBytes = te.encode(conf ?? buildDosboxConf(exe)) as Uint8Array<ArrayBuffer>
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
