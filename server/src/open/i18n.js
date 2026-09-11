/**
 * 开放平台的多语言取值：`?lang=` + **回退链**。纯函数，可以在 node 里直接跑。
 *
 * ## 为什么是「单语言 + 回退链」而不是把八种语言全发出去
 *
 * 库里的译文是**残缺的**，而且残缺得不均匀：`title_i18n` 只有 zh-Hant 一个键
 * （非中文界面刻意用原名），`description_i18n` 按需生成、es/fr 目前整门是空的
 * （见项目记忆里的「多语言正文其实是同一份」）。
 * 把这么一张稀疏表原样发给接入方，等于把「该退到哪一门」这个**我们才知道的规则**
 * 丢给他自己猜 —— 他多半会写成 `i18n[lang] ?? title`，于是繁体读者看到简体、
 * 法语读者看到中文，而我们站内其实是退到英文的。
 *
 * 所以对外只回一门语言的字符串，并且**明确告诉他这一门实际是什么**（`lang_actual`）：
 * 接入方要做 hreflang / 要标「暂无译文」，靠的就是这个字段。
 *
 * ## 回退链必须和站内一模一样
 *
 * 规则的源头是 `src/services/i18nData.ts` 的 `gameTitle()` / `gameDescription()`。
 * 这里是它的服务端镜像（入参是数据库行，不是 API 形状）。
 * ⚠️ 两份实现漂移的话，同一款游戏在 8bitgo.com 上和在接入方站点上会显示不同的简介 ——
 * `server/scripts/test-openapi.mjs` 里有一条用例把两边**都跑一遍**逐格比对，别把它删了。
 */
import { SITE_LANGUAGES, SITE_FALLBACK_LANGUAGE } from '../../../shared/site-languages.js'

export const OPEN_LANGS = Object.freeze(SITE_LANGUAGES.map((l) => l.code))

/**
 * 开放接口不传 `lang` 时用哪一门。
 *
 * ⚠️ 这里**故意**和站内不一样：站内默认是 `zh-Hans`（本站的基准语言、裸路径就是中文），
 * 而开放接口的调用方是第三方开发者，默认给中文只会让一个没读文档的人以为「这库全是中文」。
 * 用站内 hreflang 的 x-default（`en`）作默认，和我们对搜索引擎的承诺一致。
 */
export const OPEN_DEFAULT_LANG = SITE_FALLBACK_LANGUAGE

/**
 * 规整 `?lang=`。认不出来的一律退到 OPEN_DEFAULT_LANG，**不报错**：
 * 一个拼错的语言码不该让整次请求失败，那对接入方来说是个很难查的 400。
 */
export function normalizeLang(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return OPEN_DEFAULT_LANG
  if (OPEN_LANGS.includes(s)) return s
  // 宽松匹配一层：zh-hans / ZH_HANT / en-US 这类写法很常见，认得出来就别为难人
  const lower = s.toLowerCase().replace('_', '-')
  const hit = OPEN_LANGS.find((code) => code.toLowerCase() === lower)
  if (hit) return hit
  const base = lower.split('-')[0]
  const byBase = OPEN_LANGS.find((code) => code.toLowerCase().split('-')[0] === base)
  return byBase || OPEN_DEFAULT_LANG
}

/** JSON 列可能是对象也可能是字符串（取决于驱动和列类型），两种都要认 */
function readMap(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const text = (v) => String(v ?? '').trim()

/**
 * 标题。回退链（和 i18nData.ts 的 gameTitle 同构）：
 *
 *   zh-Hant → title_i18n['zh-Hant'] → title_zh → title
 *   zh-Hans → title_zh → title
 *   其它    → title（原名。**这是刻意的**：非中文界面用游戏的原名，不是把中文名硬翻过去）
 *
 * @returns {{ text: string, lang: string }} lang = 这段文字**实际**是哪一门
 */
export function pickTitle(row, lang) {
  const want = normalizeLang(lang)
  const i18n = readMap(row?.title_i18n)
  if (want === 'zh-Hant') {
    if (text(i18n['zh-Hant'])) return { text: text(i18n['zh-Hant']), lang: 'zh-Hant' }
    if (text(row?.title_zh)) return { text: text(row.title_zh), lang: 'zh-Hans' }
    return { text: text(row?.title), lang: 'und' }
  }
  if (want === 'zh-Hans') {
    if (text(row?.title_zh)) return { text: text(row.title_zh), lang: 'zh-Hans' }
    return { text: text(row?.title), lang: 'und' }
  }
  // 原名没有语言可言（`Contra` / `魂斗羅` 都可能），标成 und 而不是编一个 'en'
  return { text: text(row?.title), lang: 'und' }
}

/**
 * 简介。回退链（和 i18nData.ts 的 gameDescription 同构）：
 *
 *   zh-Hans → description
 *   zh-Hant → description_i18n['zh-Hant'] → description
 *   en      → description_en → description
 *   其它     → description_i18n[lang] → description_en → description
 *
 * ⚠️ 最后一档退到中文看着别扭，但它是**有意**的：填了中文没填英文的游戏，
 * 给一段中文也比给一片空白强（接入方拿 lang_actual 就知道该不该显示「暂无译文」）。
 */
export function pickDescription(row, lang) {
  const want = normalizeLang(lang)
  const i18n = readMap(row?.description_i18n)
  const base = text(row?.description)
  const en = text(row?.description_en)

  if (want === 'zh-Hans') return { text: base, lang: base ? 'zh-Hans' : 'und' }
  if (want === 'zh-Hant') {
    if (text(i18n['zh-Hant'])) return { text: text(i18n['zh-Hant']), lang: 'zh-Hant' }
    return { text: base, lang: base ? 'zh-Hans' : 'und' }
  }
  if (want !== SITE_FALLBACK_LANGUAGE && text(i18n[want])) return { text: text(i18n[want]), lang: want }
  if (en) return { text: en, lang: 'en' }
  return { text: base, lang: base ? 'zh-Hans' : 'und' }
}

/**
 * ROM 的语言选择。`game_roms` 里 `lang='*'` 是通用件。
 *
 * 回退：精确语言 → 通用件。**不做跨语言回退**（要日文版，给不了就给通用件或者没有）——
 * 悄悄发一份别的语言的 ROM，玩家开进去是另一套文字，而接入方无从得知。
 *
 * @param roms {Record<string,string>} lang -> object_key
 * @returns {{ key: string, lang: string } | null}
 */
export const GENERIC_ROM_LANG = '*'
export function pickRom(roms, lang) {
  const table = roms && typeof roms === 'object' ? roms : {}
  const want = String(lang ?? '').trim()
  if (want && want !== GENERIC_ROM_LANG && table[want]) return { key: table[want], lang: want }
  if (table[GENERIC_ROM_LANG]) return { key: table[GENERIC_ROM_LANG], lang: GENERIC_ROM_LANG }
  return null
}

/** 这款游戏有哪些 ROM 语言可选（对外只报语言码，**绝不报 object key**） */
export function romLangs(roms) {
  return Object.keys(roms && typeof roms === 'object' ? roms : {}).sort()
}
