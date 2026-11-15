/**
 * EmulatorJS 电池存档（/data/saves，IDBFS + autoPersist）的运行时保护。
 *
 * ── 为什么要有它 ─────────────────────────────────────────────
 * 核心的 IDBFS 每次持久化都是「把内存里的目录树镜像进 IndexedDB」：
 *   1. 本地没有、库里有的条目 → 从库里**删掉**；
 *   2. 时间戳和库里**不同**的条目 → 用本地那份**覆盖**（不比新旧）。
 * 两条在浏览器里都会静默丢档：
 *
 * - **整库被清空**（2026-11-12 实测）：引擎 exit 处理里先 saveSaveFiles 排一次同步、
 *   紧接着 FS.unmount("/data/saves")；排队的同步随后走到的是卸载后的空目录，于是把
 *   IndexedDB 里**所有游戏**的 .srm 全删了。刷新、切游戏、返回都会触发 exit。
 *   引擎侧已由 scripts/patch-emulatorjs.mjs 第十三节删掉那句 unmount，这里是第二道闸：
 *   引擎升级忘了重跑补丁，或者别的路径又让本地树变空，库也不会被清。
 * - **多标签页互相回滚**：标签页 A 开局时把整个库读进内存；B 之后在另一款游戏里存了档；
 *   A 再自动落盘时，B 的新文件 A 内存里没有 → 被删；B 改过的旧文件 A 里时间戳不同 → 被 A 的
 *   旧副本覆盖。
 *
 * ── 改法 ─────────────────────────────────────────────────────
 * 只在「内存 → IndexedDB」这个方向收紧 reconcile：
 *   - 不删除库里的任何条目（核心和 RetroArch 都不会主动删存档，没有正当的删除来源）；
 *   - 只写本地**更新**（mtime 更大）或库里还没有的条目。
 * 「IndexedDB → 内存」（开局 populate）保持原样。同一台机器上 mtime 来自同一个时钟，
 * 刚写的文件时间戳必然大于库里那份，正常存档不受影响。
 */

/** IDBFS reconcile 用到的条目：只关心时间戳 */
export interface IdbfsEntry {
  timestamp: Date | number
}

export interface IdbfsSet {
  type: 'local' | 'remote' | string
  entries: Record<string, IdbfsEntry>
  [key: string]: unknown
}

type Reconcile = (src: IdbfsSet, dst: IdbfsSet, callback: (err: unknown) => void) => unknown

export interface IdbfsLike {
  reconcile?: Reconcile & { __8bgSaveGuard?: true }
}

const stamp = (e: IdbfsEntry): number => (e.timestamp instanceof Date ? e.timestamp.getTime() : Number(e.timestamp))

/**
 * 持久化方向（src 本地 → dst 库）要交给原 reconcile 的两份集合：
 * src 只留「库里没有或本地更新」的条目；dst 只留 src 里出现的键 —— 原实现于是既算不出删除，
 * 也不会拿旧副本覆盖新档。其它方向原样返回。
 */
export function guardedPersistSets(src: IdbfsSet, dst: IdbfsSet): { src: IdbfsSet; dst: IdbfsSet } {
  if (dst.type !== 'remote') return { src, dst }
  const srcEntries: Record<string, IdbfsEntry> = {}
  const dstEntries: Record<string, IdbfsEntry> = {}
  for (const [key, local] of Object.entries(src.entries)) {
    const remote = dst.entries[key]
    if (!remote) {
      srcEntries[key] = local
    } else if (stamp(local) > stamp(remote)) {
      srcEntries[key] = local
      dstEntries[key] = remote
    }
  }
  return { src: { ...src, entries: srcEntries }, dst: { ...dst, entries: dstEntries } }
}

/**
 * 给核心 Module 里的 IDBFS 装上保护。幂等；拿不到 reconcile（核心换了实现）返回 false，
 * 调用方记一条日志即可，不拦开局。
 */
export function guardIdbfsPersist(idbfs: IdbfsLike | undefined | null): boolean {
  const original = idbfs?.reconcile
  if (!idbfs || typeof original !== 'function') return false
  if (original.__8bgSaveGuard) return true
  const guarded = ((src: IdbfsSet, dst: IdbfsSet, callback: (err: unknown) => void) => {
    const sets = guardedPersistSets(src, dst)
    return original.call(idbfs, sets.src, sets.dst, callback)
  }) as Reconcile & { __8bgSaveGuard?: true }
  guarded.__8bgSaveGuard = true
  idbfs.reconcile = guarded
  return true
}

/*
 * ── 电池存档的文件名 ─────────────────────────────────────────
 * RetroArch 按「内容文件名去掉扩展名」命名存档：/data/saves/<核心>/<名字>.srm。8BG 包解开后
 * 交给引擎的名字原来是 8BG 头里的 originalName —— 管理员**本机的文件名**。线上 GBA 实测
 * （2026-11-12）大量是「德文.gba」「英语.gba」「日文.gba」这种：凡是这样上传的游戏，同一语言共用
 * 同一个 .srm，开 A 游戏读到 B 游戏的存档、存一下就把 B 的覆盖掉；管理员换个本机文件名重传，
 * 存档又整个对不上。
 *
 * 现在按本站的存档 slug 命名：slug 本来就是「这份 ROM 二进制」的身份（第一语言用原 slug，
 * 其它语言带 `~rom-<语言>`，和即时存档同一套规则），换线路 / 走备用源 / 重传都不变。
 * 核心变体后缀（`:melonds-compat`、`:beetle-soft-chd`）不进文件名：兼容核心兜底时游戏内存档
 * 必须还是同一份。扩展名照抄 originalName，核心靠它认格式。压缩包（引擎会解开、真正交给核心的
 * 是包里的文件名）和玩家本地文件不改。
 */
const ARCHIVE_EXT = new Set(['zip', '7z', 'rar'])

export function batterySaveGameName(saveSlug: string | undefined, originalName: string | undefined): string | undefined {
  if (!saveSlug || !originalName || saveSlug.startsWith('local:')) return undefined
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(originalName)?.[1]
  if (!ext || ARCHIVE_EXT.has(ext.toLowerCase())) return undefined
  const base = saveSlug
    .split(':')[0]
    .replace(/[^A-Za-z0-9._~-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120)
  return base ? `${base}.${ext}` : undefined
}

const stripExt = (name: string): string => name.replace(/\.[^./]+$/, '')

/** Emscripten FS 里迁移要用到的几样 */
export interface SaveFsLike {
  readdir(path: string): string[]
  stat(path: string): { mode: number; mtime?: Date | number }
  isDir(mode: number): boolean
  analyzePath(path: string): { exists: boolean }
  readFile(path: string): Uint8Array
  writeFile(path: string, data: Uint8Array): void
}

/**
 * 把旧名字下的电池存档（.srm / .rtc 等）复制一份到新名字下。只在新名字还没有存档时复制，
 * 旧文件原样留着。
 *
 * 只认「旧名字以游戏 slug 开头」的情形（`pokemon-firered.zh-Hans` → `pokemon-firered`）：
 * 「德文.srm」这种通用名可能是另一款游戏的存档，复制过来等于把别人的进度塞给这款游戏，
 * 宁可不迁。返回复制了几个文件。
 */
export function migrateLegacyBatterySaves(
  fs: SaveFsLike,
  legacyName: string | undefined,
  nextName: string,
  saveSlug: string,
  root = '/data/saves',
): number {
  if (!legacyName) return 0
  const legacyBase = stripExt(legacyName.split('/').pop() ?? '')
  const nextBase = stripExt(nextName)
  const slugRoot = saveSlug.split(/[~:]/)[0]
  if (!legacyBase || !slugRoot || legacyBase === nextBase || !legacyBase.startsWith(slugRoot)) return 0
  let copied = 0
  const visit = (dir: string, depth: number) => {
    let names: string[]
    try {
      names = fs.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name === '.' || name === '..') continue
      const path = `${dir}/${name}`
      let isDir = false
      try {
        isDir = fs.isDir(fs.stat(path).mode)
      } catch {
        continue
      }
      if (isDir) {
        if (depth < 2) visit(path, depth + 1)
        continue
      }
      if (!name.startsWith(`${legacyBase}.`)) continue
      const ext = name.slice(legacyBase.length + 1)
      if (!ext || ext.includes('.')) continue
      const target = `${dir}/${nextBase}.${ext}`
      if (fs.analyzePath(target).exists) continue
      try {
        fs.writeFile(target, fs.readFile(path))
        copied++
      } catch {
        /* 单个文件失败不影响开局 */
      }
    }
  }
  visit(root, 0)
  return copied
}

/*
 * ── 引擎的逐游戏设置跟着改名走 ───────────────────────────────
 * EmulatorJS 把改键、金手指、核心选项存在 localStorage 的 `ejs-<gameId>-<系统>-<gameName>-settings`。
 * batterySaveGameName 把 8BG 游戏交给引擎的 gameName 从 originalName 换成了存档 slug 名，旧键就再也
 * 读不到了 —— 玩家调好的按键、金手指、核心选项在 2026-11-12 那次部署后看起来「全没了」。
 * 开局前把旧键复制一份到新键（新键已有就不动，旧键保留）。
 */
interface KeyedStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function migrateEngineSettingsKey(
  storage: KeyedStorage | null | undefined,
  gameId: number | undefined,
  legacyName: string | undefined,
  nextName: string,
): number {
  if (!storage || !legacyName || legacyName === nextName) return 0
  const prefix = `ejs-${gameId || 1}-`
  const suffix = `-${legacyName}-settings`
  const found: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key && key.startsWith(prefix) && key.endsWith(suffix) && key.length > prefix.length + suffix.length) found.push(key)
  }
  let copied = 0
  for (const key of found) {
    const system = key.slice(prefix.length, key.length - suffix.length)
    const target = `${prefix}${system}-${nextName}-settings`
    if (storage.getItem(target) !== null) continue
    const value = storage.getItem(key)
    if (value === null) continue
    storage.setItem(target, value)
    copied++
  }
  return copied
}

/**
 * 开机那一刻跟「这个玩家」有关的状态，写进诊断包。
 * 2026-11-13 一例《火红》开局 `table index is out of bounds`、自动重试同样失败，诊断包里却看不出
 * 开机时有没有电池存档、有没有存过引擎设置 / 金手指 —— 这几样都会在 callMain 里被核心读进去，
 * 也都只存在这个浏览器里。只记有无、大小、条数，不记内容。
 */
export function describeBootState(
  fs: Pick<SaveFsLike, 'readdir' | 'stat' | 'isDir'> | undefined,
  engineGameName: string,
  settingsJson: string | null,
): string {
  const base = stripExt(engineGameName.split('/').pop() ?? '')
  const saves: string[] = []
  if (fs) {
    try {
      for (const dir of fs.readdir('/data/saves')) {
        if (dir === '.' || dir === '..') continue
        const path = `/data/saves/${dir}`
        let names: string[] = []
        try {
          if (!fs.isDir(fs.stat(path).mode)) continue
          names = fs.readdir(path)
        } catch {
          continue
        }
        for (const name of names) {
          if (!name.startsWith(`${base}.`)) continue
          let size = -1
          try {
            size = (fs.stat(`${path}/${name}`) as { size?: number }).size ?? -1
          } catch {
            /* ignore */
          }
          saves.push(`${dir}/*${name.slice(base.length)} ${size}B`)
        }
      }
    } catch {
      /* /data/saves 还没建 */
    }
  }
  let settings = '无'
  if (settingsJson) {
    try {
      const parsed = JSON.parse(settingsJson) as { settings?: Record<string, unknown>; cheats?: unknown[]; controlSettings?: unknown }
      const changed = Object.keys(parsed.settings ?? {})
      const cheats = Array.isArray(parsed.cheats) ? parsed.cheats.length : 0
      settings = `${changed.length} 项（${changed.slice(0, 12).join(', ') || '-'}）、金手指 ${cheats} 条、改键${parsed.controlSettings ? '有' : '无'}`
    } catch {
      settings = `无法解析（${settingsJson.length} 字节）`
    }
  }
  return `开机状态：电池存档 ${saves.length ? saves.join('; ') : '无'}；引擎设置 ${settings}`
}
