/**
 * 会出现在公开 URL 里的语言列表。
 *
 * 前端路由、动态 sitemap 与 IndexNow 必须共用同一份顺序和代码；如果各抄一份，
 * 新增语言时最容易出现「页面已经能打开，但 sitemap 和主动提交永远漏掉它」的情况。
 */
export const SITE_LANGUAGES = Object.freeze([
  Object.freeze({ code: 'zh-Hans', label: '简体中文', english: 'Simplified Chinese', hreflang: 'zh-Hans' }),
  Object.freeze({ code: 'zh-Hant', label: '繁體中文', english: 'Traditional Chinese', hreflang: 'zh-Hant' }),
  Object.freeze({ code: 'en', label: 'English', english: 'English', hreflang: 'en' }),
  Object.freeze({ code: 'es', label: 'Español', english: 'Spanish', hreflang: 'es' }),
  Object.freeze({ code: 'fr', label: 'Français', english: 'French', hreflang: 'fr' }),
  Object.freeze({ code: 'it', label: 'Italiano', english: 'Italian', hreflang: 'it' }),
  Object.freeze({ code: 'de', label: 'Deutsch', english: 'German', hreflang: 'de' }),
  Object.freeze({ code: 'ja', label: '日本語', english: 'Japanese', hreflang: 'ja' }),
])

/** 默认语言使用裸路径，避免既有中文 URL 全部发生迁移。 */
export const SITE_DEFAULT_LANGUAGE = 'zh-Hans'

/** 浏览器语言无法识别时落到英语；也是 hreflang 的 x-default。 */
export const SITE_FALLBACK_LANGUAGE = 'en'

