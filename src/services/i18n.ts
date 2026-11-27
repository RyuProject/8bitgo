/**
 * 界面翻译。
 *
 * 用法（组件里）：
 *   const t = useT()
 *   <p>{t.common.all}</p>
 *   <p>{fmt(t.games.total, { n: 12 })}</p>       // 共 12 款游戏
 *
 * 非组件里（services / 工具函数）用 getT()：
 *   throw new Error(getT().errors.emailInvalid)
 *
 * 语言切换由 services/lang.ts 驱动，切换后所有用了 useT() 的组件会自动重渲染。
 *
 * 所有语言的文案都按需加载（见 locales/index.ts）。入口在渲染前已经
 * await 过 loadLocale()，因此这里同步取一定拿得到；加载失败时由 loader
 * 在渲染前切到简体中文或英文兜底。
 */
import { useLang, getLang } from './lang'
import { getLoadedLocale, type Translation } from '@/locales'

/** 当前语言的文案表（组件内用，语言切换会触发重渲染） */
export function useT(): Translation {
  const lang = useLang()
  const translation = getLoadedLocale(lang)
  if (!translation) throw new Error(`界面语言尚未加载：${lang}`)
  return translation
}

/** 当前语言的文案表（非组件内用，取一次即时值） */
export function getT(): Translation {
  const lang = getLang()
  const translation = getLoadedLocale(lang)
  if (!translation) throw new Error(`界面语言尚未加载：${lang}`)
  return translation
}

/**
 * 占位符替换：把 {name} 换成 vars.name。
 * 找不到的占位符原样保留，方便发现漏传的变量。
 */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole,
  )
}
