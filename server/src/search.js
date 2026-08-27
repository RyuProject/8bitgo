/**
 * 搜索索引：分词、归一化、拼音，以及查询侧的词条切分。
 *
 * 为什么自己建倒排表，而不用 MySQL 的 FULLTEXT：
 *   1. 中文必须用 ngram 解析器，那是 MySQL 5.7+ 独有的，MariaDB 根本没有这个解析器 ——
 *      用了就把部署绑死在特定数据库上，而 mysql2 这个驱动两边都能连。
 *   2. 拼音、首字母、繁简互通这些东西没法塞进 FULLTEXT，只能另做一套；
 *      既然都要另做，不如统一进同一张倒排表，一次查询全部命中。
 *   3. ngram 的 token 长度是全库一个设置（默认 2），单字搜索直接失效。
 *
 * 表结构（见 migrate）：
 *   game_search_tokens(token, game_id, weight)  PRIMARY KEY (token, game_id)
 *
 * 查询走主键前缀，几万款游戏也是毫秒级；LIKE '%…%' 那种全表扫在上万行时会明显拖慢，
 * 而联想下拉是每敲一个字就查一次，扛不住。
 */
import { pinyinOfChar, simplify } from './data/zh-data.js'

/** 命中不同字段给的分。同一款游戏多处命中会累加 */
export const WEIGHT = {
  /** 原名（多为英文/日文罗马字） */
  title: 100,
  /** 中文译名 */
  titleZh: 100,
  /** 别名（预留：目前没有别名表，调用方可以自己传） */
  alias: 80,
  /** 整串拼音 / 首字母 */
  pinyin: 60,
  /** 从中间截断的拼音（「赛车」之于「超级马里奥赛车」），比整串低一档 */
  pinyinPart: 35,
  developer: 40,
  tag: 30,
}

/** token 列的长度上限，超长的直接截断（正常 token 都在 20 以内） */
export const MAX_TOKEN = 32

const CJK = /[㐀-鿿豈-﫿]/
const isCjk = (ch) => CJK.test(ch)
const isWordChar = (ch) => /[a-z0-9]/.test(ch)

/**
 * 归一化：全角转半角、繁转简、转小写、罗马音的长音记号去掉。
 * 索引和查询走的是同一个函数 —— 只要两边一致，映射准不准反而是次要的。
 */
export function normalize(text) {
  return simplify(
    String(text ?? '')
      // NFKC 把全角字母数字、①②、㈱ 之类折叠成常见形态
      .normalize('NFKC')
      .toLowerCase(),
  )
    // 日文罗马字常见的长音标记，去掉音调符号后 pokemon / pokémon 能互相搜到
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

/** 把一段文本切成「拉丁词」和「汉字串」两类片段 */
function segments(text) {
  const out = []
  let buf = ''
  let kind = null
  const flush = () => {
    if (buf) out.push({ kind, text: buf })
    buf = ''
  }
  for (const ch of text) {
    const k = isCjk(ch) ? 'cjk' : isWordChar(ch) ? 'word' : null
    if (k !== kind) {
      flush()
      kind = k
    }
    if (k) buf += ch
  }
  flush()
  return out
}

/**
 * 一段文本产生的索引 token。
 *
 * 拉丁：整个词。
 * 汉字：每个单字 + 每个相邻二字组。
 *   为什么两者都要：只存二字组的话，单字搜索（「魂」）全部落空；
 *   只存单字的话，「斗罗」会匹配到任何同时含「斗」和「罗」的游戏，噪音很大。
 */
export function tokenize(text) {
  const out = new Set()
  for (const seg of segments(normalize(text))) {
    if (seg.kind === 'word') {
      out.add(seg.text.slice(0, MAX_TOKEN))
    } else {
      const chars = [...seg.text]
      for (let i = 0; i < chars.length; i++) {
        out.add(chars[i])
        if (i + 1 < chars.length) out.add(chars[i] + chars[i + 1])
      }
    }
  }
  return out
}

/**
 * 一段中文的拼音 token。
 *
 * 只存「每个后缀」的整串拼音和首字母，不存所有子串 —— 因为查询侧最后一个词是按前缀匹配的，
 * 任意连续片段都可以表示成「某个后缀的前缀」。
 *   魂斗罗 → hundouluo/hdl、douluo/dl、luo/l（长度不足 2 的丢掉）
 *   查 hundou → LIKE 'hundou%' 命中 hundouluo
 *   查 dl     → 精确命中 dl
 * 这样一个 n 字的标题只产生 2n 个 token，而不是 n² 个。
 */
export function pinyinTokens(text) {
  /** token -> 权重（同一个 token 取最高的那档） */
  const out = new Map()
  const put = (tok, weight) => {
    if (!tok || tok.length < 2 || tok.length > MAX_TOKEN) return
    const cur = out.get(tok)
    if (cur === undefined || weight > cur) out.set(tok, weight)
  }
  for (const seg of segments(normalize(text))) {
    if (seg.kind !== 'cjk') continue
    const py = [...seg.text].map(pinyinOfChar)
    // 有汉字查不到读音时整段跳过：拼出来的串会缺字，反而会误命中
    if (py.some((p) => !p)) continue
    for (let i = 0; i < py.length; i++) {
      const weight = i === 0 ? WEIGHT.pinyin : WEIGHT.pinyinPart
      put(py.slice(i).join(''), weight)
      put(py.slice(i).map((p) => p[0]).join(''), weight)
    }
  }
  return out
}

/**
 * 一款游戏的全部索引条目。
 * @param {{title?, title_zh?, developer?, tags?: string[], aliases?: string[]}} game
 * @returns {Map<string, number>} token -> 权重（取最高的一档）
 */
export function buildGameTokens(game) {
  const out = new Map()
  const put = (tok, weight) => {
    if (!tok || tok.length > MAX_TOKEN) return
    const cur = out.get(tok)
    if (cur === undefined || weight > cur) out.set(tok, weight)
  }
  const addText = (text, weight) => {
    if (!text) return
    for (const tok of tokenize(text)) put(tok, weight)
  }

  addText(game.title, WEIGHT.title)
  addText(game.title_zh, WEIGHT.titleZh)
  addText(game.developer, WEIGHT.developer)
  for (const tag of game.tags ?? []) addText(tag, WEIGHT.tag)
  for (const alias of game.aliases ?? []) addText(alias, WEIGHT.alias)

  // 拼音只从中文来源取：英文标题拼出来的东西没有意义
  for (const text of [game.title_zh, ...(game.aliases ?? [])]) {
    if (!text) continue
    for (const [tok, weight] of pinyinTokens(text)) put(tok, weight)
  }
  return out
}

/**
 * 查询侧：把用户输入切成「必须命中」和「只加分」两组。
 *
 * 为什么中文要分两组：用户打中文是不加空格的，而标题里往往夹着别的字。
 * 「塞尔达时之笛」切成二字组是 塞尔/尔达/达时/时之/之笛，而《塞尔达传说：时之笛》
 * 里根本没有「达时」—— 全都要命中的话，这个再正常不过的搜法会零结果。
 *
 * 所以：
 *   必须命中 = 每个**单字**（保召回，够精确 —— 六个字都在的游戏不会太多）
 *   只加分   = 每个**二字组**（保排序 —— 连着的字挨在一起的排前面）
 * 拉丁词还是整词必须命中，最后一个词放宽成前缀（联想下拉里用户正打到一半）。
 *
 * @returns {{required: Array<{token, prefix}>, optional: Array<{token, prefix}>, empty: boolean}}
 */
export function queryTerms(q, { prefixLast = true } = {}) {
  const text = normalize(q).trim()
  if (!text) return { required: [], optional: [], empty: true }

  const required = []
  const optional = []
  const segs = segments(text)
  segs.forEach((seg, si) => {
    const last = si === segs.length - 1
    if (seg.kind === 'word') {
      required.push({
        token: seg.text.slice(0, MAX_TOKEN),
        prefix: prefixLast && last,
      })
      return
    }
    const chars = [...seg.text]
    for (const ch of chars) required.push({ token: ch, prefix: false })
    for (let i = 0; i + 1 < chars.length; i++) optional.push({ token: chars[i] + chars[i + 1], prefix: false })
  })

  if (!required.length) return { required: [], optional: [], empty: true }
  return { required, optional, empty: false }
}

/** 一个词条对应的子查询。req=1 的会被计入「是否每个必须项都命中」 */
function termSql(t, req) {
  if (t.prefix) {
    // 前缀命中也分远近：token 正好就是用户打的那串，比「只是以它开头」更该排前面。
    // 不加这一档的话，搜 hdl 时《魂斗罗力量》(hdllq) 会和《魂斗罗》(hdl) 同分，
    // 谁在前只能看 plays 撞运气。
    return {
      sql: `SELECT game_id, MAX(weight + IF(token = ?, 40, 0)) AS w, ${req} AS req FROM game_search_tokens WHERE token LIKE ? GROUP BY game_id`,
      params: [t.token, `${t.token.replace(/[%_\\]/g, '\\$&')}%`],
    }
  }
  return {
    sql: `SELECT game_id, MAX(weight) AS w, ${req} AS req FROM game_search_tokens WHERE token = ? GROUP BY game_id`,
    params: [t.token],
  }
}

/**
 * 拼出「按相关性排序的候选 game_id」子查询。
 *
 * 每个词条各自一条子查询，UNION ALL 之后按 game_id 聚合：
 * SUM(req) = 必须项个数 就意味着每个必须项都命中了。
 * 不能写成 `token IN (...)` + COUNT(DISTINCT token) —— 前缀匹配会让
 * 一个词命中好几个 token，把计数撑大，变成「命中一个词就算全中」。
 *
 * @returns {{sql: string, params: any[]}}
 */
export function tokenMatchSql({ required, optional = [] }) {
  const parts = []
  const params = []
  for (const t of required) {
    const p = termSql(t, 1)
    parts.push(p.sql)
    params.push(...p.params)
  }
  // 二字组：命中就加分，没命中也不影响能不能搜出来
  for (const t of optional.slice(0, 12)) {
    const p = termSql(t, 0)
    parts.push(p.sql)
    params.push(...p.params)
  }
  const sql = `SELECT game_id, SUM(w) AS score FROM (${parts.join(' UNION ALL ')}) m
               GROUP BY game_id HAVING SUM(req) = ${required.length}`
  return { sql, params }
}
