/**
 * 通用的 localStorage 列表存储。
 *
 * 用法：
 *   const store = createLocalStore<Game>({ key: '8bitgo.admin.games', initial: builtinGames, getId: g => g.slug, validate: isGame })
 *   store.load() / store.save(list) / store.upsert(item) / store.remove(id) / store.reset()
 *   const list = store.useAll()   // React 内订阅
 *
 * 接入真实后端时，把这里换成接口调用即可，上层代码不需要改。
 */
import { useSyncExternalStore } from 'react'

export interface LocalStore<T> {
  key: string
  load: () => T[]
  save: (list: T[]) => void
  /** 用服务端渲染时注入的数据灌满内存缓存；不写 localStorage，也不当作「本地修改」 */
  seed: (list: T[]) => void
  reset: () => void
  upsert: (item: T) => void
  remove: (id: string) => void
  update: (id: string, patch: Partial<T> | ((item: T) => T)) => void
  find: (id: string) => T | undefined
  subscribe: (listener: () => void) => () => void
  useAll: () => T[]
  hasLocalChanges: () => boolean
  /** 远端模式下：是否已经从服务端取到过数据（用来区分「还没加载」和「服务端确实是空的」） */
  isLoaded: () => boolean
  exportJson: () => string
  importJson: (json: string) => number
}

interface Options<T> {
  key: string
  initial: T[]
  getId: (item: T) => string
  validate: (x: unknown) => x is T
  /**
   * 返回 true 时进入「以服务端为准」模式：
   * 不读也不写 localStorage，也不回退到内置数据——服务端返回什么就是什么，
   * 返回空就显示空。避免出现「数据库是空的，后台却列着一堆内置游戏」这种假象。
   */
  remote?: () => boolean
}

export function createLocalStore<T>({ key, initial, getId, validate, remote }: Options<T>): LocalStore<T> {
  let cache: T[] | null = null
  const listeners = new Set<() => void>()

  // 远端模式用的独立缓存。EMPTY 必须是固定引用：
  // useSyncExternalStore 要求 getSnapshot 每次返回同一个对象，否则会无限重渲染。
  const EMPTY: T[] = []
  let remoteCache: T[] | null = null
  let loaded = false
  const isRemote = () => (remote ? remote() : false)

  const read = (): T[] | null => {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return null
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed) || !parsed.every(validate)) return null
      return parsed
    } catch {
      return null
    }
  }

  const notify = () => {
    for (const l of listeners) l()
  }

  const load = () => {
    if (isRemote()) return remoteCache ?? EMPTY
    if (!cache) cache = read() ?? initial
    return cache
  }

  const save = (list: T[]) => {
    if (isRemote()) {
      // 服务端数据只放内存：写进 localStorage 会在下次打开时抢在请求前面显示旧数据
      remoteCache = list
      loaded = true
      notify()
      return
    }
    cache = list
    try {
      localStorage.setItem(key, JSON.stringify(list))
    } catch (err) {
      // 服务端渲染时没有 localStorage —— 内存缓存已经更新，静默跳过即可
      if (typeof localStorage !== 'undefined') console.warn(`保存 ${key} 到 localStorage 失败`, err)
    }
    notify()
  }

  /**
   * SSR 注入的数据只灌内存。
   *
   * 之所以不能直接用 save()：非 remote 模式下 save() 会写 localStorage，
   * 服务端给的是空数组时就会把「空」永久存进访客浏览器。
   * 之所以必须灌（哪怕是空数组）：客户端首帧要和服务端渲染的 HTML 完全一致，
   * 否则 load() 会回退到内置的 91 款，和服务端渲染的 0 款对不上，hydration 直接失败。
   */
  const seed = (list: T[]) => {
    if (isRemote()) {
      remoteCache = list
      loaded = true
    } else {
      cache = list
    }
    notify()
  }

  const reset = () => {
    if (isRemote()) {
      remoteCache = null
      loaded = false
      notify()
      return
    }
    cache = initial
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
    notify()
  }

  const find = (id: string) => load().find((x) => getId(x) === id)

  const upsert = (item: T) => {
    const list = load()
    const idx = list.findIndex((x) => getId(x) === getId(item))
    save(idx >= 0 ? list.map((x, i) => (i === idx ? item : x)) : [item, ...list])
  }

  const remove = (id: string) => save(load().filter((x) => getId(x) !== id))

  const update = (id: string, patch: Partial<T> | ((item: T) => T)) =>
    save(load().map((x) => (getId(x) === id ? (typeof patch === 'function' ? patch(x) : { ...x, ...patch }) : x)))

  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  const useAll = () => useSyncExternalStore(subscribe, load, load)

  // 远端模式下没有「本地修改版」这回事
  const hasLocalChanges = () => {
    if (isRemote()) return false
    try {
      return localStorage.getItem(key) !== null
    } catch {
      return false
    }
  }

  const exportJson = () => JSON.stringify(load(), null, 2)

  const importJson = (json: string) => {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed) || !parsed.every(validate)) {
      throw new Error('JSON 格式不正确：需要一个对象数组，且每一项都包含必需字段')
    }
    save(parsed)
    return parsed.length
  }

  const isLoaded = () => (isRemote() ? loaded : true)

  return { key, load, save, seed, reset, upsert, remove, update, find, subscribe, useAll, hasLocalChanges, isLoaded, exportJson, importJson }
}

/** 生成一个足够用的随机 id */
export function randomId(prefix = ''): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return prefix ? `${prefix}_${rand}` : rand
}
