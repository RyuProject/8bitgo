/**
 * 对外的游戏形状。**独立一层，绝不复用 `mappers.js` 的 `gameRowToApi`**。
 *
 * 那一份是给站内前端用的，它的前提是「调用方是自己人」，所以原样带着
 * `hidden`、`arcade_romdata`、`dos_*`、以及**对象存储 key 的原文**（`rom` / `roms` / `cover`）。
 * 把它直接发给第三方，等于把 ROM 的真实地址、后台的运行参数一起送出去 ——
 * 而那正是我们绕了一大圈做签名凭据要防的事。
 *
 * 所以这里是**白名单**：想加字段必须在这个文件里显式写一行。
 * 反过来（黑名单「删掉几个不该给的」）在这种地方是错的做法 ——
 * 明天 games 表加一列，黑名单不会报错，它会直接把新列发出去。
 */
import { pickDescription, pickTitle, romLangs } from './i18n.js'

/**
 * @param row  games 表的一行（**原始行**，不是 gameRowToApi 的结果）
 * @param rel  { genres, tags, roms } —— 同 games-repo 的 attachRelations
 * @param ctx  { lang, coverUrl(key) -> string, hasRomScope: boolean }
 */
export function openGame(row, rel = {}, ctx = {}) {
  const lang = ctx.lang
  const title = pickTitle(row, lang)
  const description = pickDescription(row, lang)
  const roms = rel.roms ?? {}

  const out = {
    slug: String(row.slug),
    title: title.text,
    description: description.text,
    /**
     * 这两段文字**实际**是哪一门语言（`und` = 原名，没有语言可言）。
     * 接入方靠它决定要不要显示「暂无译文」、以及页面上该打什么 hreflang ——
     * 没有这个字段的话，他只能假设「我要了 fr 就是 fr」，而库里的译文是残缺的。
     */
    lang_requested: lang,
    lang_actual: { title: title.lang, description: description.lang },

    platform: String(row.platform),
    genres: rel.genres ?? [],
    tags: rel.tags ?? [],
    year: Number(row.year) || 0,
    developer: row.developer || '',
    players: Number(row.players) || 1,
    multiplayer: Boolean(Number(row.multiplayer)),
    /** emoji，没封面时的兜底显示 */
    icon: row.icon || '🎮',
    /** 绝对地址。给不出来时是 null，**不给一个必然 404 的 URL** */
    cover: ctx.coverUrl ? ctx.coverUrl(row.cover) || null : null,
    rating: Number(row.rating_weight) > 0
      ? Math.round((Number(row.rating_sum) / Number(row.rating_weight)) * 10) / 10
      : 0,
    rating_count: Number(row.rating_count) || 0,
    plays: Number(row.plays) || 0,
    added_at: dateOnly(row.added_at) || dateOnly(row.created_at),
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    adult: Boolean(Number(row.adult)),
    /**
     * 有哪些 ROM 语言可选（`*` = 通用件）。**只报语言码，绝不报 object key**。
     * 没有 games.rom 权限的应用也看得到这一栏 —— 它是「这款有没有日文版」这种展示信息，
     * 不是下载凭据。
     */
    rom_langs: romLangs(roms),
  }
  return out
}

function dateOnly(v) {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/**
 * ⚠️ 绝不能出现在对外响应里的字段名。测试拿它逐个断言。
 *
 * 为什么把名单写在这儿而不只写在测试里：它是**这个文件的契约**。
 * 有人往 openGame 里加字段时，会先看到这张表。
 */
export const FORBIDDEN_OUT_KEYS = Object.freeze([
  'hidden',          // 下架状态是运营信息
  'rom', 'roms',     // 对象 key 原文 —— 给了就等于绕过全部凭据
  'object_key',
  'arcade_romdata',  // 街机改版包的内部清单
  'dos_executable', 'dos_backend', 'dos_system', 'dos_windows_version',
  'dos_launch_delay', 'dosbox_config_override', 'dosboxConfig',
  'core',            // 我们用哪个核心跑是实现细节，会变
  'coin_reward', 'coinReward', // G 币永不开放
  'home_rank', 'homeRank',     // 首页运营位
  'body_control',
  'video',
  'title_zh', 'title_i18n', 'description_en', 'description_i18n', // 内部多语言列，对外已折成单语言
  'id',              // 自增主键，对外只认 slug
])

/** 列表分页的对外形状。字段名用下划线，和整套开放接口保持一致 */
export function openPage({ items, total, page, pageSize, totalPages }) {
  return { items, page, page_size: pageSize, total, total_pages: totalPages }
}
