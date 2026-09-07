/**
 * 简体中文 → 繁体中文（OpenCC 的 s2t）。
 *
 * ⚠️ **只在服务端用**。这里一个字节都不许进前端 bundle：
 * 词库（STPhrases）光自己就有 1MB，而繁体页面需要的是「已经转好的文本」，
 * 不是「在浏览器里现转的能力」—— 转换发生在预生成阶段（server/scripts/pretranslate.mjs
 * 与文章发布钩子），结果落在 `title_i18n` / `description_i18n` / `excerpt_i18n` /
 * `content_i18n` 这几个 JSON 列里，前端只是按语言取值。
 *
 * ── 为什么繁中不走火山翻译 ──────────────────────────────
 * `translate.js` 原来的方案是「把**英文版**翻成 zh，落到 zh-Hant」，注释里自己写了
 * 「不完美」。实际比不完美更糟：
 *   1. 绕了一圈 简体作者 → 英文 → 机器中文，语气和专有名词都会走形（游戏名尤其）；
 *   2. 没填英文版的条目直接放弃，繁体用户看到的就是简体原文；
 *   3. 火山的 TranslateText 只认 ISO 639-1 短码，`zh-Hans` 和 `zh-Hant` 在它眼里
 *      都是 `zh` —— 「把 zh 翻成 zh」本质上是个空操作，花钱买不确定性。
 * 简繁之间是**字词映射**不是翻译，OpenCC 的词库就是这件事的标准答案：离线、确定、免费，
 * 而且能直接吃简体原文，不需要英文中转。
 *
 * ── 依赖是懒加载的 ────────────────────────────────────
 * `opencc-js` 只在真的要转换时才 import。理由：服务器起不来是天大的事，
 * 而「词库没装」只该让预生成脚本报一句人话，不该让整个站点开不了机。
 * 所以这里不在模块顶层 import，调用方拿到的是一个可能抛错的 Promise。
 *
 * 装：`npm i opencc-js`（纯 JS，无原生依赖，Linux / macOS 通吃）。
 *
 * 回归：`npm run test:zh-convert`
 */

/**
 * 转换器是**记忆化**的：建一次 Trie 要吃掉 1MB 词库，逐条转换时重复建就没法看了。
 * 用 Promise 而不是函数本体做缓存 —— 并发调用时只会 import 一次。
 */
let converterPromise = null

/**
 * 拿到 简→繁 转换函数。用的是 OpenCC 的 **s2twp**（`from.cn` + `to.twp`）。
 *
 * 三档都实测过一遍再选的，别改回去：
 *
 * | 原文 | s2t | s2tw | **s2twp** |
 * |---|---|---|---|
 * | 在浏览器里 | 在瀏覽器**裏** | 在瀏覽器裡 | 在瀏覽器裡 |
 * | 在线玩 | 在線玩 | 在線玩 | **線上玩** |
 * | 默认 / 设置 | 默認 / 設置 | 默認 / 設置 | **預設 / 設定** |
 * | 支持 / 运行 | 支持 / 運行 | 支持 / 運行 | **支援 / 執行** |
 * | 光盘 / 内存 | 光盤 / 內存 | 光盤 / 內存 | **光碟 / 記憶體** |
 *
 * 决定性的理由是**和界面文案对齐**：`src/locales/zh-Hant.ts` 本来就是台湾用词
 * （「免費線上玩」「支援即時存檔」「預設」），只做字形转换的 s2t / s2tw 会让
 * 同一个页面上「介面说 線上玩、正文说 在線玩」，比不转还难看。
 *
 * 担心的「专有名词被换掉」实测没有发生 —— 词库里是通用词条，游戏名一个都没动：
 * `合金弹头 3` → `合金彈頭 3`、`超级马力欧兄弟` → `超級馬力歐兄弟`、
 * `魂斗罗` → `魂鬥羅`、`古惑狼` / `侵略者` 原样不动。
 *
 * @returns {Promise<(text: string) => string>}
 */
export function loadSimplifiedToTraditional() {
  if (!converterPromise) {
    converterPromise = (async () => {
      let core
      let locale
      try {
        core = await import('opencc-js/core')
        locale = await import('opencc-js/preset/cn2t')
      } catch (e) {
        // 缓存一个失败的 Promise 会让后续调用永远拿不到重试机会，所以清掉
        converterPromise = null
        const err = new Error('缺少 opencc-js —— 简繁转换用它的词库。装一下：npm i opencc-js')
        err.code = 'OPENCC_MISSING'
        err.cause = e
        throw err
      }
      return core.ConverterFactory(...locale.from.cn, ...locale.to.twp)
    })()
  }
  return converterPromise
}

/** 有没有汉字。没有就不必进 Trie 走一趟（slug、纯英文标题、纯数字都会命中这条早退） */
const HAS_HAN = /[㐀-䶿一-鿿豈-﫿]|[\ud840-\ud87f][\udc00-\udfff]/

/**
 * 把一段简体文本转成繁体。空值、非字符串、不含汉字的一律原样返回
 * （**返回原值而不是空串** —— 调用方要靠「转换结果 === 原文」判断这条要不要落库）。
 *
 * Markdown 正文直接整篇转，不做代码块保护：s2t 只动汉字，代码里的标识符是 ASCII，
 * 碰不到；代码块里真写了中文注释，转成繁体对繁体读者也是对的。
 *
 * @param {unknown} text
 * @returns {Promise<string>}
 */
export async function toTraditional(text) {
  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : ''
  if (!HAS_HAN.test(text)) return text
  const convert = await loadSimplifiedToTraditional()
  return convert(text)
}

/**
 * 词库在不在（给脚本和路由做「能不能走这条路」的判断，不抛错）。
 * @returns {Promise<boolean>}
 */
export async function isZhConvertAvailable() {
  try {
    await loadSimplifiedToTraditional()
    return true
  } catch {
    return false
  }
}
