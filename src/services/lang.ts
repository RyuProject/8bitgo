/**
 * 当前站点语言。
 *
 * 语言由 URL 路径前缀决定（/en/games、/ja/games；默认语言无前缀），
 * 而不是 localStorage —— 这样每种语言都有自己的可收录 URL，搜索引擎才能分别索引。
 * localStorage 只保留「上次选过的语言」，用于访客打开裸域名时跳到他熟悉的语言。
 *
 * SSR 说明：服务端每次请求前调用 setLangForRender(lang) 设定当前语言。
 * renderToString 是同步的，期间不会有别的请求插进来，所以这个模块级变量是安全的。
 */
import { useSyncExternalStore } from 'react'
import type { Lang } from '@/config/languages'
import { DEFAULT_LANG, langFromPath, localizedPath } from '@/config/languages'

const KEY = '8bitgo.lang'
const listeners = new Set<() => void>()

/** 当前渲染使用的语言。浏览器端在启动时按 URL 设定；服务端每次请求设定。 */
let current: Lang = DEFAULT_LANG

export function getLang(): Lang {
  return current
}

/** 由入口（客户端启动 / 服务端每次请求）调用，按 URL 设定当前语言 */
export function setLangForRender(lang: Lang) {
  current = lang
}

/** 记住用户偏好，仅用于以后访问裸域名时的跳转建议 */
export function rememberLang(lang: Lang) {
  try {
    localStorage.setItem(KEY, lang)
  } catch {
    /* 隐私模式下写不进去，忽略 */
  }
}

export function preferredLang(): Lang | null {
  try {
    const v = localStorage.getItem(KEY) as Lang | null
    return v ?? null
  } catch {
    return null
  }
}

/**
 * 切换语言：记住偏好并跳到对应语言的同一个页面。
 * 这里刻意用整页跳转而不是前端路由 —— 服务端渲染会直接吐出目标语言的 HTML，
 * 首屏就是正确语言，也避免 basename 变化带来的路由状态问题。
 */
export function setLang(lang: Lang) {
  rememberLang(lang)
  if (typeof window === 'undefined') {
    current = lang
    return
  }
  const target = localizedPath(window.location.pathname, lang) + window.location.search + window.location.hash
  window.location.assign(target)
}

/** 把当前语言同步到 <html lang> */
export function syncHtmlLang() {
  try {
    document.documentElement.lang = current
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

/**
 * 组件里读当前语言。
 * 语言在一次页面生命周期里不会变（切换靠整页跳转），
 * 所以三个快照函数返回同一个值，SSR 与客户端首次渲染必然一致，不会出现 hydration 不匹配。
 */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang)
}

export { langFromPath }
