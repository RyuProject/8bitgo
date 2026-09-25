import type { PlatformId } from '@/types'
import {
  ARCADE_GENERIC_BUTTONS,
  EJS_ARCADE_KEY_BY_ID,
  EJS_DPAD,
  EJS_INDEX,
  EJS_KEY_BY_ID,
  EJS_PLATFORM_BUTTONS,
} from '@/lib/keymapData'

export type EmulatorJsKeyboardMap = Readonly<Record<number, string>>

interface StoredKeymap {
  /** 默认键位的代次。以后改默认值时，只迁移没自定义过的记录。 */
  defaultVersion: number
  customized: boolean
  updatedAt: number
  keys: Record<string, string>
}

interface KeymapStore {
  schemaVersion: 1
  entries: Record<string, StoredKeymap>
}

const STORE_KEY = '8bitgo.emulatorjs.keymaps'
const STORE_SCHEMA_VERSION = 1
const MAX_ENTRIES = 100
const CHANGE_EVENT = '8bitgo:emulatorjs-keymap-change'

/**
 * 默认键位的迁移代次。改某个平台的默认映射时只加对应的一项：
 * 没改过键的玩家会跟到新默认；主动改过的会原样保留。
 */
const DEFAULT_VERSION: Readonly<Partial<Record<PlatformId | 'default', number>>> = {
  default: 1,
  arcade: 1,
}

const EMPTY_STORE = (): KeymapStore => ({ schemaVersion: STORE_SCHEMA_VERSION, entries: {} })

function scopeOf(gameSlug: string | undefined, platform: PlatformId): string {
  const slug = gameSlug?.trim()
  // 本地 ROM 在开局前没有 slug；按平台留一份最近映射，至少让同一页停止后仍显示真实键位。
  return slug ? `game:${platform}:${slug}` : `platform:${platform}`
}

function defaultVersionOf(platform: PlatformId): number {
  return DEFAULT_VERSION[platform] ?? DEFAULT_VERSION.default ?? 1
}

function loadStore(): KeymapStore {
  if (typeof window === 'undefined') return EMPTY_STORE()
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (!raw) return EMPTY_STORE()
    const parsed = JSON.parse(raw) as Partial<KeymapStore>
    if (parsed.schemaVersion !== STORE_SCHEMA_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
      return EMPTY_STORE()
    }
    return parsed as KeymapStore
  } catch {
    // 隐私模式、配额满或旧数据损坏都只退回默认键位，绝不能影响开局。
    return EMPTY_STORE()
  }
}

function saveStore(store: KeymapStore): void {
  if (typeof window === 'undefined') return
  try {
    const ordered = Object.entries(store.entries).sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    store.entries = Object.fromEntries(ordered.slice(0, MAX_ENTRIES))
    window.localStorage.setItem(STORE_KEY, JSON.stringify(store))
  } catch {
    // 键位提示是增强项；存储不可用时不能连带让模拟器失败。
  }
}

function cleanKeys(keys: EmulatorJsKeyboardMap): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, label] of Object.entries(keys)) {
    const n = Number(id)
    const value = String(label).trim().slice(0, 32)
    if (Number.isInteger(n) && n >= 0 && n < 30 && value) out[String(n)] = value
  }
  return out
}

/** 把 EmulatorJS keyMap 里的内部名字变成键帽上适合显示的写法。 */
export function emulatorJsKeyLabel(engineName: string): string {
  const key = engineName.trim().toLowerCase()
  const fixed: Record<string, string> = {
    'up arrow': '↑',
    'down arrow': '↓',
    'left arrow': '←',
    'right arrow': '→',
    'escape': 'Esc',
    'ctrl': 'Ctrl',
    'alt': 'Alt',
    'shift': 'Shift',
    'enter': 'Enter',
    'tab': 'Tab',
    'space': 'Space',
    'backspace': 'Backspace',
    'delete': 'Delete',
    'insert': 'Insert',
    'home': 'Home',
    'end': 'End',
    'page up': 'Page Up',
    'page down': 'Page Down',
  }
  if (fixed[key]) return fixed[key]
  if (/^[a-z]$/.test(key) || /^f\d{1,2}$/.test(key)) return key.toUpperCase()
  const numpad = key.match(/^numpad (\d)$/)
  if (numpad) return `Num ${numpad[1]}`
  return key.replace(/\b\w/g, (c) => c.toUpperCase())
}

/** 当前平台会展示、也值得参与“是否自定义”判断的 libretro 按钮下标。 */
export function emulatorJsRelevantKeyIds(platform: PlatformId): readonly number[] {
  if (platform === 'arcade') {
    return [...new Set([...EJS_DPAD, ...ARCADE_GENERIC_BUTTONS, EJS_INDEX.select, EJS_INDEX.start])]
  }
  const rows = EJS_PLATFORM_BUTTONS[platform]
  if (!rows) return Object.keys(EJS_KEY_BY_ID).map(Number)
  return [...new Set(rows.flatMap(([, id]) => (Array.isArray(id) ? [...id] : [id as number])))]
}

function defaultsOf(platform: PlatformId): EmulatorJsKeyboardMap {
  return platform === 'arcade' ? EJS_ARCADE_KEY_BY_ID : EJS_KEY_BY_ID
}

function isCustomized(platform: PlatformId, keys: Record<string, string>): boolean {
  const defaults = defaultsOf(platform)
  return emulatorJsRelevantKeyIds(platform).some((id) => {
    const actual = keys[String(id)]
    return actual !== undefined && actual.toLowerCase() !== defaults[id]?.toLowerCase()
  })
}

/** 开始页 / 操作说明读取上一次从真实引擎同步回来的键位。 */
export function getEmulatorJsKeymap(gameSlug: string | undefined, platform: PlatformId): EmulatorJsKeyboardMap | null {
  const entry = loadStore().entries[scopeOf(gameSlug, platform)]
  if (!entry) return null
  // 默认值换代时，未自定义记录先显示新默认；真正开局后适配器会同步迁移引擎里的键盘绑定。
  if (entry.defaultVersion !== defaultVersionOf(platform) && !entry.customized) return null
  return Object.fromEntries(Object.entries(entry.keys).map(([id, label]) => [Number(id), label]))
}

/**
 * 引擎加载完旧设置后写回本站缓存。相同内容不重复写 localStorage，避免调音量时的
 * saveSettings 顺带制造无意义的同步写入。
 */
export function publishEmulatorJsKeymap(
  gameSlug: string | undefined,
  platform: PlatformId,
  keys: EmulatorJsKeyboardMap,
): void {
  const cleaned = cleanKeys(keys)
  if (!Object.keys(cleaned).length) return
  const store = loadStore()
  const scope = scopeOf(gameSlug, platform)
  const next: StoredKeymap = {
    defaultVersion: defaultVersionOf(platform),
    customized: isCustomized(platform, cleaned),
    updatedAt: Date.now(),
    keys: cleaned,
  }
  const previous = store.entries[scope]
  if (
    previous?.defaultVersion === next.defaultVersion &&
    previous.customized === next.customized &&
    JSON.stringify(previous.keys) === JSON.stringify(next.keys)
  ) return
  store.entries[scope] = next
  saveStore(store)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { scope } }))
  }
}

/** 默认键位升级时，只有明确记录为“未自定义”的旧代次才允许自动迁移。 */
export function shouldMigrateEmulatorJsDefaults(gameSlug: string | undefined, platform: PlatformId): boolean {
  const entry = loadStore().entries[scopeOf(gameSlug, platform)]
  return Boolean(entry && entry.defaultVersion !== defaultVersionOf(platform) && !entry.customized)
}

export function onEmulatorJsKeymapChange(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onLocal = () => listener()
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORE_KEY) listener()
  }
  window.addEventListener(CHANGE_EVENT, onLocal)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onLocal)
    window.removeEventListener('storage', onStorage)
  }
}
