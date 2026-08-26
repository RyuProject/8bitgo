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
  reset: () => void
  upsert: (item: T) => void
  remove: (id: string) => void
  update: (id: string, patch: Partial<T> | ((item: T) => T)) => void
  find: (id: string) => T | undefined
  subscribe: (listener: () => void) => () => void
  useAll: () => T[]
  hasLocalChanges: () => boolean
  exportJson: () => string
  importJson: (json: string) => number
}

interface Options<T> {
  key: string
  initial: T[]
  getId: (item: T) => string
  validate: (x: unknown) => x is T
}

export function createLocalStore<T>({ key, initial, getId, validate }: Options<T>): LocalStore<T> {
  let cache: T[] | null = null
  const listeners = new Set<() => void>()

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
    if (!cache) cache = read() ?? initial
    return cache
  }

  const save = (list: T[]) => {
    cache = list
    try {
      localStorage.setItem(key, JSON.stringify(list))
    } catch (err) {
      console.warn(`保存 ${key} 到 localStorage 失败`, err)
    }
    notify()
  }

  const reset = () => {
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

  const hasLocalChanges = () => {
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

  return { key, load, save, reset, upsert, remove, update, find, subscribe, useAll, hasLocalChanges, exportJson, importJson }
}

/** 生成一个足够用的随机 id */
export function randomId(prefix = ''): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return prefix ? `${prefix}_${rand}` : rand
}
