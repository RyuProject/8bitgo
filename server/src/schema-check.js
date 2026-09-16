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
  { table: 'game_roms', column: 'dos_executable', why: '同一 DOS ZIP 按语言选择启动文件；缺列会让后台保存 500' },
  { table: 'game_roms', column: 'dos_startup_commands', why: '各语言 DOS 光盘挂载命令；缺列会让后台保存 500' },
  { table: 'game_roms', column: 'backup_key', why: '同语言 ROM 备用地址；缺列会让后台保存备用源 500' },
  { table: 'games', column: 'dos_backend', why: 'DOS / Windows 客体运行核心选择' },
  { table: 'games', column: 'dos_system', why: '可复用的 Windows 客体系统镜像' },
  { table: 'games', column: 'dos_extras', why: 'DOS 附加文件（资料片 / 补丁）清单；缺了后台保存的附加文件会静默丢失' },
  { table: 'games', column: 'dos_extras_label', why: '可选资料片在开始界面上的名字；缺了开关上只剩「加载扩展包」，玩家不知道那几百 MB 是什么' },
  { table: 'games', column: 'dos_extras_label_en', why: '资料片名字的英文版；缺了非中文界面的玩家会在一句英文里看到一个中文名' },
  { table: 'games', column: 'dos_windows_version', why: 'Windows 3.x / 9x 自启动方式' },
  { table: 'games', column: 'dos_launch_delay', why: '客体 Windows 自启动时机' },
  { table: 'games', column: 'dosbox_config_override', why: '逐游戏 DOSBox-X 启动配置覆盖' },
  { table: 'games', column: 'dos_save_hint', why: '逐游戏的 DOS 存档按键说明' },
  { table: 'games', column: 'arcade_romdata', why: '街机改版包的 FBNeo RomData' },
  { table: 'games', column: 'adult', why: '成人游戏 18 岁验证' },
  { table: 'games', column: 'created_at', why: '真实入库时间' },
  { table: 'games', column: 'rating_sum', why: '评分聚合；缺了详情页星星读得出来，但一有人打分 POST /api/ratings 就 500' },
  { table: 'games', column: 'rating_weight', why: '评分权重合计（登录 1.0 / 匿名 0.5），按评分排序靠它' },
  { table: 'games', column: 'rating_count', why: '评分人数，卡片上「N 人评分」用' },
  { table: 'game_comments', column: 'post_id', why: '博客文章评论；缺了文章页发表评论会 500（评论表的宿主二选一，见 schema-v2.sql）' },
  { table: 'users', column: 'token_version', why: '退出所有设备 / 改完密码作废旧令牌' },
  { table: 'users', column: 'birth_date', why: '成人内容年龄验证：出生日期记在账号上，缺了 PUT /api/me/birth-date 会 500，成人游戏谁也进不去' },
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
  { table: 'open_rom_samples', why: '开放平台未审核应用的逐机型 ROM 测试样本；缺了沙箱领票和样本目录会 500' },
  { table: 'game_genres', why: '游戏分类' },
  { table: 'game_tags', why: '游戏标签' },
  { table: 'game_search_tokens', why: '搜索倒排索引' },
  { table: 'post_tags', why: '文章标签' },
  { table: 'developers', why: '开发商的人工资料（logo / 简介）；缺了开发商列表仍然能看，只是后台那一页读写全 500' },
  { table: 'friend_links', why: '首页特别鸣谢；缺了首页会隐藏这一栏，后台友情链接管理读写会 500' },
  { table: 'saves', why: '云存档；schema-v2 早期漏了这张表，缺了的话 /api/saves 全 500，玩家点「云端存档」就报错' },
  { table: 'flash_save_slots', why: 'Flash 游戏内部的在线槽；缺了的话替代 AGI 接口会全部 500' },
  {
    table: 'game_comments',
    why: '游戏评论；缺了详情页评论区读不出来、发表全 500，而页面其它部分一切正常',
  },
  { table: 'login_codes', why: '邮箱验证码；缺了会自动退回进程内存（重启丢码、多实例对不上），登录能用但不可靠' },
  { table: 'collections', why: '用户自建合集；缺了首页那一栏是空的，/collections 与「我的合集」全 500' },
  { table: 'collection_items', why: '合集里的游戏；缺了合集能建但加不进游戏、封面也取不出来' },
  { table: 'collection_items', column: 'position', why: '合集内手动排序；缺了合集详情整页 500（ORDER BY 找不到列）' },
  {
    table: 'collection_views',
    why: '合集浏览量；**缺了不影响任何页面**（读写两侧都容错，数字显示 0），但那个数字会一直是 0 —— 跑一次 migrate 就好',
  },
  {
    table: 'game_ratings',
    why: '游戏评分明细；缺了详情页的评分卡整块读不出来、打分全 500，而页面其它部分一切正常',
  },
  /*
    开放平台那几张。⚠️ 它们的缺席**特别难联想到库**：

    开放平台是靠 .env 里的 OPEN_JWT_PRIVATE_KEY 开关的，而那个开关和建表是两件事。
    只配了密钥、没跑 migrate 的状态下：/v1/health 正常、/v1/games 正常、
    /.well-known/jwks.json 也正常 —— 看起来「开起来了」——
    但 /open 控制台里一点「创建应用」就 500，取令牌永远 invalid_client。
    查的人会去翻密钥、翻 scope、翻 bcrypt，因为「其它都好的」。
  */
  { table: 'oauth_apps', why: '开放平台的应用表；缺了 /open 控制台创建应用 500、取令牌永远 invalid_client' },
  { table: 'oauth_app_secrets', why: '应用密钥（只存 bcrypt 哈希）；缺了任何 AppID + key 都认不出来' },
  { table: 'oauth_app_reviews', why: '应用审核流水；缺了后台的开放平台审核页整块 500' },
  { table: 'oauth_app_testers', why: '沙箱应用的测试账号白名单；缺了沙箱应用授权时 500' },
  /*
    ⚠️ **只有上面这 4 张。** migrate 里还会建 oauth_codes / oauth_authorizations /
    oauth_tokens，但 2026-09-13 核对：代码一张都不查 ——
    授权码走的是 routes/oauth.js 里的内存 Map（5 分钟 TTL，重启即丢，对一次性短码可以接受），
    access token 是自包含 JWT 不落库。

    把那三张也写进来的话，会对一台**完全正常**的库报「缺表」，
    而运维照着提示跑完 migrate 发现什么都没变 —— 误报比不报更糟，
    因为它会把下一次真实的告警也一起变成噪音。

    （副作用值得知道：oauth_authorizations 不用 = 用户授权过哪些应用没有落库，
      同意页每次都要重新问一遍，也没有「解除授权」的地方。要做那个功能时再把表用起来。）
    */
    { table: 'apps', why: '应用中心：官方 SDK / APP 下载 / 社区上架；缺了 /apps 列表空、后台管理读写全 500' },
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
