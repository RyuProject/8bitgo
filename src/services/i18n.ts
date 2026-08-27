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
 * 非基准语言的文案是按需加载的（见 locales/index.ts）。入口在渲染前
 * 已经 await 过 loadLocale()，所以这里同步取一定拿得到；万一没拿到
 * （加载失败）就退回简体中文，而不是让页面炸掉。
 */
import { useLang, getLang } from './lang'
import { getLoadedLocale, zhHans, type Translation } from '@/locales'

/** 当前语言的文案表（组件内用，语言切换会触发重渲染） */
export function useT(): Translation {
  const lang = useLang()
  return getLoadedLocale(lang) ?? zhHans
}

/** 当前语言的文案表（非组件内用，取一次即时值） */
export function getT(): Translation {
  return getLoadedLocale(getLang()) ?? zhHans
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
