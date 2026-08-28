/**
 * 启动时对一遍表结构。
 *
 * 为什么需要这个：代码更新了、库没跟着迁移时，症状极具误导性 ——
 * 读接口一切正常（缺的列只是读不出来，不报错），但**所有写操作都 500**，
 * 报的是 `Unknown column 'xxx' in 'INSERT INTO'`。
 * 表现出来就是「后台点保存没反应 / 新功能像没做」，而真正的原因在数据库这一侧。
 *
 * 所以这里在启动时主动查一遍，缺什么直接把话说清楚，并给出该跑的命令。
 * 只警告、不退出：缺列不影响前台读，站点该服务还是要服务。
 */
import { query } from './db.js'

/** 会随版本增加的列。新增迁移时同步往这里加一条 */
const EXPECTED_COLUMNS = [
  { table: 'games', column: 'home_rank', why: '首页精选位' },
  { table: 'games', column: 'core', why: '按游戏覆盖模拟器核心' },
  { table: 'games', column: 'dos_executable', why: 'DOS 启动程序覆盖' },
  { table: 'games', column: 'created_at', why: '真实入库时间' },
]

/**
 * v2 才有的表。少一张不会让服务起不来，但会让**某一条接口**莫名其妙 500，
 * 而且只有真去点到那个功能才发现 —— 比如 game_plays 没建，站点一切正常，
 * 只有玩家真把游戏跑起来那一刻的 POST /api/games/:slug/play 会 500，
 * 表现是「游玩数永远是 0」，没人会想到是数据库缺表。所以宁可启动时全查一遍。
 *
 * 加新表的迁移时同步往这里补一条。
 */
const EXPECTED_TABLES = [
  { table: 'platform_bios', why: '平台级 BIOS' },
  { table: 'game_plays', why: '游玩去重名单；缺了 POST /api/games/:slug/play 会 500，游玩数永远是 0' },
  { table: 'game_roms', why: '按语言分槽的 ROM' },
  { table: 'game_genres', why: '游戏分类' },
  { table: 'game_tags', why: '游戏标签' },
  { table: 'game_search_tokens', why: '搜索倒排索引' },
  { table: 'post_tags', why: '文章标签' },
]

export async function checkSchema() {
  try {
    const cols = await query(
      `SELECT table_name AS t, column_name AS c
         FROM information_schema.COLUMNS
        WHERE table_schema = DATABASE()`,
    )
    const have = new Set(cols.map((r) => `${String(r.t).toLowerCase()}.${String(r.c).toLowerCase()}`))
    const tables = new Set(cols.map((r) => String(r.t).toLowerCase()))

    const missingCols = EXPECTED_COLUMNS.filter(
      // 表本身就不存在时不重复报（下面按表报一次就够了）
      (e) => tables.has(e.table) && !have.has(`${e.table}.${e.column}`),
    )
    const missingTables = EXPECTED_TABLES.filter((e) => !tables.has(e.table))

    if (!missingCols.length && !missingTables.length) return true

    console.warn('')
    console.warn('⚠️  数据库结构落后于代码，以下东西还没有：')
    for (const e of missingTables) console.warn(`     · 表 ${e.table}（${e.why}）`)
    for (const e of missingCols) console.warn(`     · 列 ${e.table}.${e.column}（${e.why}）`)
    console.warn('')
    console.warn('   现在的表现会是：前台读一切正常，但**写操作会 500** ——')
    console.warn('   缺列多半是后台保存报 Unknown column，看起来像「新功能没做」；')
    console.warn('   缺表则是某条接口单独 500（如 game_plays 之于游玩计数），更难联想到库。')
    console.warn('')
    console.warn('   补上：  cd server && npm run migrate')
    console.warn('')
    return false
  } catch (e) {
    // 连不上库之类：这里不是主流程，别把启动搞挂
    console.warn('⚠️  表结构自检没跑成：', e instanceof Error ? e.message : String(e))
    return false
  }
}
