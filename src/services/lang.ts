/**
 * 当前站点语言。持久化在 localStorage(8bitgo.lang)，并同步到 <html lang>。
 * 目前界面文字未翻译，语言主要用于「按语言自动选 ROM」；后续再逐步接入界面翻译。
 */
import { useSyncExternalStore } from 'react'
import type { Lang } from '@/config/languages'
import { DEFAULT_LANG, LANGUAGES } from '@/config/languages'

const KEY = '8bitgo.lang'
const listeners = new Set<() => void>()
let current: Lang | null = null

function read(): Lang {
  try {
    const v = localStorage.getItem(KEY) as Lang | null
    if (v && LANGUAGES.some((l) => l.code === v)) return v
  } catch {
    /* ignore */
  }
  return DEFAULT_LANG
}

export function getLang(): Lang {
  if (!current) current = read()
  return current
}

export function setLang(lang: Lang) {
  current = lang
  try {
    localStorage.setItem(KEY, lang)
  } catch {
    /* ignore */
  }
  syncHtmlLang()
  for (const l of listeners) l()
}

/** 把当前语言同步到 <html lang>（开机时调用一次） */
export function syncHtmlLang() {
  try {
    document.documentElement.lang = getLang()
  } catch {
    /* ignore */
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang)
}
