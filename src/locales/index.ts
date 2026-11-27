/**
 * 多语言文案注册表。
 *
 * zh-Hans 是基准语言，`Translation` 类型由它推导：
 * 其它语言文件写成 `const xx: Translation = {...}`，
 * 少一个键、多一个键或结构不符，都会在编译期报错。
 *
 * 新增一种语言：
 *   1. 在 src/config/languages.ts 的 Lang 与 LANGUAGES 里加上它
 *   2. 复制 zh-Hans.ts 改名，翻译内容
 *   3. 在下面 LOADERS 里加一行
 *
 * ── 为什么其它语言是动态 import ──
 * 八种语言的文案加起来，在打包产物里占 227 KB（gzip 75 KB），
 * 而任何一个访客只会用到其中一种。以前是八种全部静态引入，等于每个人
 * 都要下载七份自己永远看不到的文案 —— 这是首屏包里最大的一块无效体积。
 *
 * 简体中文也按需加载：类型只在编译期引用，不会把整份中文文案带进所有语言的首屏包。
 * 若当前语言下载失败，再动态加载简体中文兜底；这一步在入口渲染前完成，不会让水合期间闪语言。
 *
 * 切换语言走的是整页跳转（见 services/lang.ts 的 setLang），
 * 所以一次页面生命周期里只会用到一种语言，不存在「加载完 A 又要 B」的情况。
 */
import type { Lang } from '@/config/languages'
import type zhHans from './zh-Hans'

/** 全站文案的结构（由简体中文推导） */
export type Translation = typeof zhHans

const LOADERS: Record<Lang, () => Promise<{ default: Translation }>> = {
  'zh-Hans': () => import('./zh-Hans'),
  'zh-Hant': () => import('./zh-Hant'),
  en: () => import('./en'),
  es: () => import('./es'),
  fr: () => import('./fr'),
  it: () => import('./it'),
  de: () => import('./de'),
  ja: () => import('./ja'),
}

/** 已经拿到的语言包；入口会在渲染前填好当前语言。 */
const loaded: Partial<Record<Lang, Translation>> = {}
/** 仅临时回退的语言要在后续请求重试，不能让一次短暂断网污染 SSR 常驻进程。 */
const retryRequestedLang = new Set<Lang>()

/**
 * 同步取已加载的语言包。没加载过返回 undefined —— 调用方自己决定退回哪种。
 * 渲染路径上只该用这个：渲染本身是同步的，不能在中途等网络。
 */
export function getLoadedLocale(lang: Lang): Translation | undefined {
  return loaded[lang]
}

/**
 * 加载某种语言的文案。已加载过就直接返回，不会重复请求。
 *
 * 失败时退回基准语言而不是抛错：语言包下不下来（网络抖动、部署换了文件名）
 * 顶多是文案退回中文（中文包也取不到时再退回英文），不该只因某一种语言包失败就白屏。
 */
export async function loadLocale(lang: Lang): Promise<Translation> {
  const hit = loaded[lang]
  if (hit && !retryRequestedLang.has(lang)) return hit

  // 简体中文不再静态驻留主包；目标语言失败时按顺序动态加载兜底，且避免重复尝试同一语言。
  const fallbacks = [...new Set<Lang>([lang, 'zh-Hans', 'en'])]
  for (const fallbackLang of fallbacks) {
    try {
      const mod = await LOADERS[fallbackLang]()
      loaded[fallbackLang] = mod.default
      loaded[lang] = mod.default
      if (fallbackLang === lang) retryRequestedLang.delete(lang)
      else retryRequestedLang.add(lang)
      return mod.default
    } catch {
      // 网络失败时尝试下一份兜底；入口仍会在任何 React 渲染前等待结果。
    }
  }

  throw new Error(`无法加载界面语言包：${lang}`)
}
