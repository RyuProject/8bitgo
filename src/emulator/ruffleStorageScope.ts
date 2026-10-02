/**
 * Flash SharedObject 的存储隔离与路径固定。
 *
 * Ruffle 把 SharedObject 存进同源 localStorage，键是 `<影片 hostname>/<localPath>/<名字>`。
 * 真 Flash 时代每款游戏各有自己的域名，在本站则**所有 Flash 共用一个源**，于是有两个坑：
 *
 * 1. `SharedObject.getLocal("save", "/")` 是当年极常见的写法（让存档不随 SWF 路径变）。
 *    它的键落在 `8bitgo.com//save`，不在任何一款游戏的 `/flash-frames/<slug>/…` 下面：
 *      · 两款都叫 "save" 的游戏会**互相覆盖进度**；
 *      · 播放器的「存档 / 云存档」只导出本局路径下的槽，这类存档**一份都导不出来**，
 *        玩家看到「没有可保存的存档」，换设备后进度全丢。
 * 2. 默认 localPath 带 SWF 文件名。后台把单 SWF 重新上传成 8BG（文件名换成管理员本地的
 *    原始名）、改成多 SWF 包（`root.swf`），存档路径就跟着变，老玩家的进度**无声消失**。
 *
 * 做法：在 ruffle.js 加载之前，把 iframe realm 里的 `window.localStorage` 换成一个 Proxy。
 * Ruffle 读写的每个键都被翻译到本局的**规范前缀**下：
 *   · 本局自己的槽（`…/<任意 swf 名>/<槽>`）→ `<规范前缀><槽>`
 *   · 其余在本站域名下的键（祖先 localPath）→ `<规范前缀>~shared/<原路径>`
 * 读不到新键时回退读一次旧键并顺手拷过来，已有存档不会丢；删除时若旧键还在，写一个空串
 * 墓碑，避免下一次回退把删掉的档读回来。和 audioTap / DPR 钳制一样，只改这个 iframe 自己的
 * realm；装不上就返回 false，调用方退回旧路径，最坏也只是今天的行为。
 */
import { readFlashEntries } from './ruffleSaves'

/** 删除墓碑。Ruffle 存的是 base64 SOL，永远不会是空串；导出也会跳过它。 */
export const FLASH_SAVE_TOMBSTONE = ''
/** 祖先 localPath（如 "/"）的存档在规范前缀下的槽名前缀 */
export const FLASH_SHARED_SLOT_PREFIX = '~shared/'

export interface FlashStorageScope {
  /** `8bitgo.com/`：Ruffle 用影片 URL 的 hostname（不含端口）拼键 */
  hostPrefix: string
  /** `flash-frames/<slug>/`：播放壳所在目录，不带前导斜杠 */
  gameDir: string
  /** 规范存档前缀，例如 `8bitgo.com/flash-frames/<slug>/<slug>.swf/` */
  savePrefix: string
}

/** Ruffle 生成的键 → 实际存储键；不归本站 Flash 管的键返回 null（原样透传）。 */
export function scopedFlashKey(scope: FlashStorageScope, raw: string): string | null {
  if (!raw.startsWith(scope.hostPrefix)) return null
  const rest = raw.slice(scope.hostPrefix.length)
  if (rest.startsWith(scope.gameDir)) {
    const tail = rest.slice(scope.gameDir.length)
    const cut = tail.indexOf('/')
    // 本局自己的槽：<swf 段>/<槽名>。swf 段不能为空，也不会以 # 开头（那是 Ruffle 给含 / 的名字加的前缀）
    if (cut > 0 && !tail.startsWith('#')) {
      const slot = tail.slice(cut + 1)
      if (slot) return scope.savePrefix + slot
    }
  }
  return scope.savePrefix + FLASH_SHARED_SLOT_PREFIX + rest
}

/** 包一层按 scope 翻译键名的 Storage。scope 为 null 时完全透传。 */
export function createScopedFlashStorage(real: Storage, getScope: () => FlashStorageScope | null): Storage {
  const mapped = (raw: string): string | null => {
    const scope = getScope()
    const key = scope ? scopedFlashKey(scope, raw) : null
    return key && key !== raw ? key : null
  }
  const read = (raw: string): string | null => {
    const key = mapped(raw)
    if (!key) return real.getItem(raw)
    const value = real.getItem(key)
    if (value !== null) return value === FLASH_SAVE_TOMBSTONE ? null : value
    const legacy = real.getItem(raw)
    if (legacy) {
      try {
        real.setItem(key, legacy)
      } catch {
        /* 配额满：照样把旧值交给游戏，下次再迁 */
      }
    }
    return legacy || null
  }
  const write = (raw: string, value: string) => real.setItem(mapped(raw) ?? raw, value)
  const remove = (raw: string) => {
    const key = mapped(raw)
    if (!key) return real.removeItem(raw)
    if (real.getItem(raw) !== null) {
      try {
        real.setItem(key, FLASH_SAVE_TOMBSTONE)
        return
      } catch {
        /* 写不进墓碑就退回普通删除 */
      }
    }
    real.removeItem(key)
  }

  const proto = Object.getPrototypeOf(real) as object
  const methods: Record<string, unknown> = {
    getItem: (key: unknown) => read(String(key)),
    setItem: (key: unknown, value: unknown) => write(String(key), String(value)),
    removeItem: (key: unknown) => remove(String(key)),
    key: (index: number) => real.key(index),
    clear: () => real.clear(),
  }
  /*
    Ruffle（web-sys 的 Storage::get / set / delete）走的是**具名属性**：`storage[key]`、
    `storage[key] = v`、`delete storage[key]`，不经过 getItem；所以 get / set / delete 三个
    陷阱都要拦。原型上的成员（length、constructor…）照常转给真正的 Storage。
  */
  return new Proxy(real, {
    get(target, prop) {
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(methods, prop)) return methods[prop]
      if (prop === 'length') return target.length
      if (typeof prop !== 'string' || prop in proto) {
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      }
      const value = read(prop)
      return value === null ? undefined : value
    },
    set(_target, prop, value) {
      if (typeof prop !== 'string') return false
      write(prop, String(value))
      return true
    },
    deleteProperty(_target, prop) {
      if (typeof prop === 'string') remove(prop)
      return true
    },
    has(target, prop) {
      if (typeof prop !== 'string' || prop in proto) return Reflect.has(target, prop)
      return read(prop) !== null
    },
  })
}

/**
 * 必须在 ruffle.js 加载之前调用。成功返回 true；拿不到 localStorage、属性不可改写等情况
 * 返回 false 且不改任何东西，调用方要按旧路径计算存档前缀。
 */
export function installFlashStorageScope(
  win: Window,
  getScope: () => FlashStorageScope | null,
): boolean {
  try {
    const real = win.localStorage
    if (!real) return false
    const scoped = createScopedFlashStorage(real, getScope)
    Object.defineProperty(win, 'localStorage', { configurable: true, enumerable: true, get: () => scoped })
    return win.localStorage === scoped
  } catch {
    return false
  }
}

/**
 * 把旧路径（按当时的 SWF 文件名）下的槽搬到规范前缀。旧路径是 Ruffle **当前**会读的那份，
 * 所以同名槽以它为准覆盖；全部写成功后才删旧键，写到一半配额满就原样保留旧键下次再搬。
 */
export function moveFlashEntries(store: Storage, from: string, to: string): number {
  if (!from || from === to) return 0
  const entries = Object.entries(readFlashEntries(store, from))
  for (const [slot, value] of entries) {
    try {
      store.setItem(to + slot, value)
    } catch {
      return 0
    }
  }
  for (const [slot] of entries) store.removeItem(from + slot)
  return entries.length
}
