/**
 * 建库建表 + 给已有库打补丁。
 * 用法：cd server && npm run migrate
 * 需要 .env 里的 DB_* 有建库权限（root 或有 CREATE 权限的账号）。
 *
 * 分三步：
 *   1. 建库并选中 —— 库名一律以 .env 的 DB_NAME 为准
 *   2. 执行 schema.sql —— 都是 CREATE TABLE IF NOT EXISTS，只对全新的库有效
 *   3. 打补丁 —— CREATE TABLE IF NOT EXISTS 不会给**已经建好**的表补上新增的列和索引，
 *      所以后来加的东西都要在这里逐条判断后执行。每条都是幂等的，重复跑没有副作用。
 *
 * ⚠️ schema.sql 里的 CREATE DATABASE / USE 写死了 `8bitgo`。以前是整个文件原样执行的，
 * 于是 DB_NAME 配成别的名字时，表建在 `8bitgo`，而后端和补丁检查连的是 DB_NAME 那个库 ——
 * 两边对不上，补丁会把「表根本不在这个库里」误判成「已是最新」，非常难查。
 * 现在把那两行剥掉，由本脚本按 DB_NAME 建库并 USE。
 */
import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

const DB_NAME = process.env.DB_NAME || '8bitgo'

/** 剥掉写死库名的 CREATE DATABASE / USE，库名统一由 DB_NAME 决定 */
async function loadSchema(file) {
  const raw = await readFile(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8')
  return raw
    .replace(/^\s*CREATE\s+DATABASE[\s\S]*?;\s*$/gim, '')
    .replace(/^\s*USE\s+[`'"]?[\w-]+[`'"]?\s*;\s*$/gim, '')
}

const conn = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  multipleStatements: true,
})

const one = async (q, p) => (await conn.query(q, p))[0][0]

/** 用 DATABASE() 而不是变量，保证检查的就是当前真正选中的库 */
async function hasTable(table) {
  const r = await one(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE table_schema = DATABASE() AND table_name = ?',
    [table],
  )
  return Number(r?.n ?? 0) > 0
}
async function hasColumn(table, column) {
  const r = await one(
    'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    [table, column],
  )
  return Number(r?.n ?? 0) > 0
}
/**
 * 列的完整定义（ENUM 要看的就是它：'enum(\'user\',\'admin\')'）。
 * 列不存在时返回空串，调用方按「不需要改」处理。
 */
async function columnType(table, column) {
  const r = await one(
    'SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    [table, column],
  )
  return String(r?.t ?? '')
}
async function hasIndex(table, index) {
  const r = await one(
    'SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?',
    [table, index],
  )
  return Number(r?.n ?? 0) > 0
}

/**
 * 补丁清单。每条给出 table，跑之前统一确认表在不在（table 为 null 表示这条自己建表）——
 * 「表不存在」和「已经是最新」是两回事，不能都报成 OK。
 * 新增补丁往后面追加，不要修改已有的。
 */
const patches = [
  {
    name: 'games.created_at（真实入库时间，用于自动生成上线日期）',
    table: 'games',
    needed: async () => !(await hasColumn('games', 'created_at')),
    run: () => conn.query('ALTER TABLE `games` ADD COLUMN `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER `roms`'),
  },
  {
    name: 'games.home_rank（首页精选位的排序号）',
    table: 'games',
    needed: async () => !(await hasColumn('games', 'home_rank')),
    run: async () => {
      await conn.query('ALTER TABLE `games` ADD COLUMN `home_rank` SMALLINT UNSIGNED NULL AFTER `hidden`')
      // 索引单独一条语句：老库可能已经手动加过列但没加索引
      if (!(await hasIndex('games', 'idx_home_rank'))) {
        await conn.query('ALTER TABLE `games` ADD INDEX `idx_home_rank` (`hidden`, `home_rank`)')
      }
    },
  },
  {
    name: 'games.core（按游戏覆盖模拟器核心）',
    table: 'games',
    needed: async () => !(await hasColumn('games', 'core')),
    run: () => conn.query('ALTER TABLE `games` ADD COLUMN `core` VARCHAR(32) NULL AFTER `hidden`'),
  },
  {
    name: 'games.description_en（英文简介）',
    table: 'games',
    needed: async () => !(await hasColumn('games', 'description_en')),
    run: () => conn.query('ALTER TABLE `games` ADD COLUMN `description_en` TEXT NULL AFTER `description`'),
  },
  {
    name: 'games.description_i18n（其它六种语言按需翻译的译文缓存）',
    // 形状：{ "zh-Hant": "...", "es": "...", "fr": "...", "it": "...", "de": "...", "ja": "..." }
    // 翻译接口写的时候用 JSON_SET 增量写，已经有的语种不会被覆盖掉。
    // 后台改 description / description_en 时清空（见 mappers.js 的 partial row 逻辑），
    // 否则旧译文会和改过的新基准对不上。
    table: 'games',
    needed: async () => !(await hasColumn('games', 'description_i18n')),
    /**
     * 用 GENERATED 列做只读视图行不通：MySQL 的 GENERATED 只能基于本行其它列计算，
     * 不能存「外部 API 调用结果」这种东西。直接 JSON 列 + 显式 UPDATE 即可。
     * MySQL 5.7.8 起 JSON 是原生类型，server 最低支持版本是 5.7，所以不用走 TEXT 模拟。
     */
    run: () => conn.query('ALTER TABLE `games` ADD COLUMN `description_i18n` JSON NULL AFTER `description_en`'),
  },
  {
    name: 'games.title_i18n（游戏中文译名的繁体版）',
    /**
     * 形状：`{ "zh-Hant": "合金彈頭 3" }` —— **只有繁体这一个键**，而且只有 title_zh
     * 填了的游戏才有。
     *
     * 为什么其它语言不进这张表：非中文界面**刻意**显示原名（通常是英文/日文原题），
     * 见 `src/services/i18nData.ts` 的 gameTitle —— 不然英文页会出现
     * 「Play 超级马力欧兄弟 Online」这种中英夹杂。所以要译名的只有繁体。
     *
     * 为什么不直接加一个 `title_zh_hant VARCHAR(200)`：形状跟 description_i18n 保持一致，
     * 读写复用同一套 readI18nMap / JSON_SET 代码，将来真要给某个语言单独配名字也不用再迁一次。
     */
    table: 'games',
    needed: async () => !(await hasColumn('games', 'title_i18n')),
    run: () => conn.query('ALTER TABLE `games` ADD COLUMN `title_i18n` JSON NULL AFTER `title_zh`'),
  },
  {
    name: 'posts.title_i18n（文章标题的各语言译文）',
    /**
     * 形状同 games.title_i18n，但**键是全部七种非简体语言**（含 en）。
     *
     * posts 和 games 在这里根本不同：games 有 `title`（原名，通常是英文）可以给非中文界面用，
     * 而文章标题只有中文一份 —— 2026-09-07 之前 BlogPage 直接渲染 `post.title`，
     * 于是八种语言的博客列表标题一模一样，Search Console 把 /fr/blog 判成重复页。
     */
    table: 'posts',
    needed: async () => !(await hasColumn('posts', 'title_i18n')),
    run: () => conn.query('ALTER TABLE `posts` ADD COLUMN `title_i18n` JSON NULL AFTER `title`'),
  },
  {
    name: 'posts.excerpt_i18n（文章摘要的按需翻译缓存）',
    // 形状同 games.description_i18n —— 站点八种语言里有两种已经有基准字段
    // （games 是 description / description_en；posts 是 excerpt 一份、母语基准），
    // 所以 i18n 里只存**其余六种**。zh-Hans / en 都不进 JSON：zh-Hans 看 excerpt，en 也退回 excerpt
    // （post 没有 description_en —— 摘要被没填英文版时本来就该显示母语，不强制翻译）。
    table: 'posts',
    needed: async () => !(await hasColumn('posts', 'excerpt_i18n')),
    run: () => conn.query('ALTER TABLE `posts` ADD COLUMN `excerpt_i18n` JSON NULL AFTER `excerpt`'),
  },
  {
    name: 'posts.content_i18n（文章正文 Markdown 的按需翻译缓存）',
    // 形状同上，但内容是分块翻译的（按段落\n\n切，每块单独调火山再拼回去），
    // 所以存的是「整段拼好的 Markdown」。改 content 时清空（posts-repo.js 里的 patchPost），
    // 否则用旧译文 + 新原文混着就乱套了。
    table: 'posts',
    needed: async () => !(await hasColumn('posts', 'content_i18n')),
    run: () => conn.query('ALTER TABLE `posts` ADD COLUMN `content_i18n` JSON NULL AFTER `content`'),
  },
  {
    name: 'games.dos_executable（DOS 启动程序，zip 内相对路径）',
    table: 'games',
    needed: async () => !(await hasColumn('games', 'dos_executable')),
    run: () => conn.query('ALTER TABLE `games` ADD COLUMN `dos_executable` VARCHAR(255) NULL AFTER `core`'),
  },
  {
    name: 'games.dos_backend（DOSBox / DOSBox-X 运行核心）',
    table: 'games',
    needed: async () => !(await hasColumn('games', 'dos_backend')),
    run: () => conn.query('ALTER TABLE `games` ADD COLUMN `dos_backend` VARCHAR(16) NULL AFTER `dos_executable`'),
  },
  {
    name: 'games.dos_system（可复用的 Windows 客体系统镜像）',
    table: 'games',
    needed: async () => !(await hasColumn('games', 'dos_system')),
    run: () => conn.query('ALTER TABLE `games` ADD COLUMN `dos_system` VARCHAR(500) NULL AFTER `dos_backend`'),
  },
  {
    name: 'games.dos_windows_version（Windows 3.x / 9x 自启动方式）',
    table: 'games',
    needed: async () => !(await hasColumn('games', 'dos_windows_version')),
    run: () => conn.query('ALTER TABLE `games` ADD COLUMN `dos_windows_version` VARCHAR(8) NULL AFTER `dos_system`'),
  },
  {
    name: 'games.dos_launch_delay（客体 Windows 自启动等待秒数）',
    table: 'games',
    needed: async () => !(await hasColumn('games', 'dos_launch_delay')),
    run: () => conn.query('ALTER TABLE `games` ADD COLUMN `dos_launch_delay` SMALLINT UNSIGNED NULL AFTER `dos_windows_version`'),
  },
  {
    name: 'games.dosbox_config_override（逐游戏 DOSBox-X 启动配置覆盖）',
    table: 'games',
    needed: async () => !(await hasColumn('games', 'dosbox_config_override')),
    run: () => conn.query('ALTER TABLE `games` ADD COLUMN `dosbox_config_override` TEXT NULL AFTER `dos_launch_delay`'),
  },
  {
    name: 'games.dos_save_hint（这款 DOS 游戏怎么存档）',
    table: 'games',
    needed: async () => !(await hasColumn('games', 'dos_save_hint')),
    run: () => conn.query('ALTER TABLE `games` ADD COLUMN `dos_save_hint` VARCHAR(160) NULL AFTER `dosbox_config_override`'),
  },
  {
    name: 'games.arcade_romdata（街机改版包的 FBNeo RomData）',
    table: 'games',
    needed: async () => !(await hasColumn('games', 'arcade_romdata')),
    run: () => conn.query('ALTER TABLE `games` ADD COLUMN `arcade_romdata` TEXT NULL AFTER `dos_save_hint`'),
  },
  {
    name: 'games.adult（成人游戏，前台启动前验证年满 18 岁）',
    table: 'games',
    needed: async () => !(await hasColumn('games', 'adult')),
    run: () => conn.query('ALTER TABLE `games` ADD COLUMN `adult` TINYINT(1) NOT NULL DEFAULT 0 AFTER `body_control`'),
  },
  {
    name: 'platform_bios（平台级 BIOS，Neo Geo 这类必须有）',
    table: null,
    needed: async () => !(await hasTable('platform_bios')),
    run: () =>
      conn.query(
        'CREATE TABLE IF NOT EXISTS `platform_bios` (' +
          '`platform` VARCHAR(20) NOT NULL,' +
          '`object_key` VARCHAR(500) NOT NULL,' +
          '`updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
          'PRIMARY KEY (`platform`)' +
          ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
      ),
  },
  {
    name: 'developers（开发商的人工资料：logo / 简介 / 官网）',
    table: null,
    needed: async () => !(await hasTable('developers')),
    run: () =>
      conn.query(
        'CREATE TABLE IF NOT EXISTS `developers` (' +
          '`name` VARCHAR(120) NOT NULL,' +
          "`logo` VARCHAR(500) NOT NULL DEFAULT ''," +
          '`description` TEXT NULL,' +
          '`description_en` TEXT NULL,' +
          "`homepage` VARCHAR(300) NOT NULL DEFAULT ''," +
          '`updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
          'PRIMARY KEY (`name`)' +
          ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
      ),
  },
  {
    name: 'game_search_tokens（搜索倒排索引：多词、拼音、繁简）',
    table: null,
    // 只在 v2 库上建：索引维护要读 game_tags，v1 库上建出来也是个永远空着的表。
    // 用 skip 而不是在 needed 里返回 false —— 「跳过」和「已是最新」得说清楚，
    // 否则 v1 用户会以为索引已经建好了，然后困惑于为什么一个字都搜不出来
    skip: async () => (!(await hasTable('game_tags')) ? '这个库还是 v1 结构，搜索索引要 v2 才有意义' : null),
    needed: async () => !(await hasTable('game_search_tokens')),
    run: async () => {
      await conn.query(
        'CREATE TABLE IF NOT EXISTS `game_search_tokens` (' +
          '`token` VARCHAR(32) NOT NULL,' +
          '`game_id` BIGINT UNSIGNED NOT NULL,' +
          '`weight` SMALLINT UNSIGNED NOT NULL DEFAULT 1,' +
          'PRIMARY KEY (`token`, `game_id`),' +
          'KEY `idx_game` (`game_id`)' +
          ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
      )
      // 外键单独加：v1 的库里 games.id 可能是别的类型，加不上也不该让整个迁移失败
      try {
        await conn.query(
          'ALTER TABLE `game_search_tokens` ADD CONSTRAINT `fk_gst_game` ' +
            'FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON DELETE CASCADE',
        )
      } catch (e) {
        console.log(`   （外键没加上，不影响使用：${e.message}）`)
      }
      console.log('   建好了，但还是空的 —— 跑 `npm run backfill-search` 把现有游戏灌进去')
    },
  },
  {
    name: 'game_plays（游玩去重名单：一个人对一款游戏只算一次）',
    table: null,
    skip: async () => (!(await hasTable('games')) ? '还没有 games 表' : null),
    needed: async () => !(await hasTable('game_plays')),
    run: async () => {
      await conn.query(
        'CREATE TABLE IF NOT EXISTS `game_plays` (' +
          '`game_id` BIGINT UNSIGNED NOT NULL,' +
          // ascii_bin 不能省：base64url 区分大小写，默认的 utf8mb4_unicode_ci
          // 会把 'aB…' 和 'Ab…' 当成同一个人，不同的人互相顶掉
          "`kind` CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NOT NULL," +
          "`identity` CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL," +
          '`played_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
          'PRIMARY KEY (`game_id`, `kind`, `identity`)' +
          ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
      )
      // 外键单独加：v1 的库里 games.id 可能是别的类型，加不上也不该让整个迁移失败
      try {
        await conn.query(
          'ALTER TABLE `game_plays` ADD CONSTRAINT `fk_gp_game` ' +
            'FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON DELETE CASCADE',
        )
      } catch (e) {
        console.log(`   （外键没加上，不影响使用：${e.message}）`)
      }
      console.log('   建好了，但还是空的 —— 现有的 plays 数字原样保留，从现在起按新规则去重累加。')
      console.log('   也就是说老玩家回来还会被算一次，此后就不会再重复计了。')
    },
  },
  {
    name: 'favorites.idx_fav_game（删游戏时按 game_slug 清理）',
    table: 'favorites',
    needed: async () => !(await hasIndex('favorites', 'idx_fav_game')),
    run: () => conn.query('ALTER TABLE `favorites` ADD INDEX `idx_fav_game` (`game_slug`)'),
  },
  {
    name: 'recents.idx_recent_game（同上）',
    table: 'recents',
    needed: async () => !(await hasIndex('recents', 'idx_recent_game')),
    run: () => conn.query('ALTER TABLE `recents` ADD INDEX `idx_recent_game` (`game_slug`)'),
  },
  {
    name: 'users.token_version（退出所有设备 / 改密码后作废旧令牌）',
    table: 'users',
    needed: async () => !(await hasColumn('users', 'token_version')),
    run: () =>
      conn.query('ALTER TABLE `users` ADD COLUMN `token_version` INT UNSIGNED NOT NULL DEFAULT 0 AFTER `status`'),
  },
  {
    name: 'users.birth_date（成人内容年龄验证：出生日期记在账号上，填一次锁定）',
    table: 'users',
    needed: async () => !(await hasColumn('users', 'birth_date')),
    /**
     * 可空、不设默认值：NULL 就是「还没填」，应用层只在 IS NULL 时写入，这就是「填一次锁定」的全部实现。
     * 不另加「已验证成人」布尔列 —— 满不满 18 每次按今天现算（shared/age.js），
     * 到生日当天自动放行，省掉一个要靠定时任务维护的状态。
     */
    run: () => conn.query('ALTER TABLE `users` ADD COLUMN `birth_date` DATE NULL DEFAULT NULL AFTER `status`'),
  },
  {
    name: "users.role 加上 'volunteer'（权限分级：管理员 / 志愿者 / 玩家）",
    table: 'users',
    /**
     * ENUM 加值只能整列 MODIFY，没有 ADD VALUE 那种写法。
     * 判据用 COLUMN_TYPE 里有没有 'volunteer' —— 比记「改过没有」可靠，
     * 也让这条补丁天然幂等。
     *
     * 新值排在 user 和 admin **中间**：ENUM 的隐式序号就是权限从小到大的顺序，
     * 以后想按 role 排序或者比大小时不会得到反直觉的结果。
     * 已有数据不受影响 —— MySQL 是按字符串值存的，重排不动现有行。
     */
    needed: async () => {
      const t = await columnType('users', 'role')
      return Boolean(t) && !t.includes("'volunteer'")
    },
    run: () =>
      conn.query(
        "ALTER TABLE `users` MODIFY `role` ENUM('user','volunteer','admin') NOT NULL DEFAULT 'user'",
      ),
  },
  {
    name: 'login_codes（邮箱验证码落库，替掉原来的内存 Map）',
    table: null,
    needed: async () => !(await hasTable('login_codes')),
    run: async () => {
      await conn.query(
        'CREATE TABLE IF NOT EXISTS `login_codes` (' +
          '`email` VARCHAR(200) NOT NULL,' +
          '`purpose` VARCHAR(16) NOT NULL,' +
          '`user_id` VARCHAR(40) NULL,' +
          '`code_hash` CHAR(64) NOT NULL,' +
          '`tries` TINYINT UNSIGNED NOT NULL DEFAULT 0,' +
          // epoch 毫秒。应用层判过期、数据库判清理，统一用应用时钟，省掉时区/时钟差的坑
          '`expires_at` BIGINT UNSIGNED NOT NULL,' +
          '`sent_at` BIGINT UNSIGNED NOT NULL,' +
          'PRIMARY KEY (`email`, `purpose`),' +
          'KEY `idx_codes_expires` (`expires_at`)' +
          ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
      )
      console.log('   建好之前验证码走的是进程内存：重启会丢、多实例会对不上。现在两个问题都没了。')
    },
  },
  {
    name: 'saves（云存档；schema-v2.sql 早期漏了这张表）',
    table: null,
    // ⚠️ 这张表原来只写在 schema.sql（v1）里，v2 那份漏了 —— 按 v2 建的新库压根没有它。
    // 症状极具误导性：站点一切正常，只有玩家点「云端存档」那一刻 /api/saves 全部 500。
    skip: async () => (!(await hasTable('users')) ? '还没有 users 表' : null),
    needed: async () => !(await hasTable('saves')),
    run: async () => {
      await conn.query(
        'CREATE TABLE IF NOT EXISTS `saves` (' +
          '`user_id` VARCHAR(40) NOT NULL,' +
          '`runtime` VARCHAR(24) NOT NULL,' +
          '`game_slug` VARCHAR(160) NOT NULL,' +
          '`slot` TINYINT UNSIGNED NOT NULL DEFAULT 0,' +
          '`size` INT UNSIGNED NOT NULL,' +
          // MEDIUMBLOB 上限 16MB，接口层再卡到 SAVE_MAX_BYTES（默认 4MB）
          '`data` MEDIUMBLOB NOT NULL,' +
          '`created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
          '`updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
          'PRIMARY KEY (`user_id`, `runtime`, `game_slug`, `slot`),' +
          'KEY `idx_saves_user_time` (`user_id`, `updated_at`)' +
          ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
      )
      // 外键单独加：老库的 users.id 类型可能对不上，加不上也不该让整个迁移失败
      try {
        await conn.query(
          'ALTER TABLE `saves` ADD CONSTRAINT `fk_saves_user` ' +
            'FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE',
        )
      } catch (e) {
        console.log(`   （外键没加上，注销账号时要自己清存档：${e.message}）`)
      }
    },
  },
  {
    name: '清理孤儿收藏（指向已删除游戏的记录）',
    table: 'favorites',
    needed: async () => {
      if (!(await hasTable('games'))) return false
      // 这条是 v1 遗留：v1 的 favorites 用 game_slug 关联，v2 改成了 game_id 外键，
      // 由数据库 ON DELETE CASCADE 兜着，压根不会有孤儿。
      // v2 的库里没有 game_slug 这一列，不挡的话整个迁移会在这里崩掉，
      // 后面的补丁全都跑不到。
      if (!(await hasColumn('favorites', 'game_slug'))) return false
      const r = await one('SELECT COUNT(*) AS n FROM favorites f LEFT JOIN games g ON g.slug = f.game_slug WHERE g.slug IS NULL')
      return Number(r?.n ?? 0) > 0
    },
    run: () => conn.query('DELETE f FROM favorites f LEFT JOIN games g ON g.slug = f.game_slug WHERE g.slug IS NULL'),
  },
  {
    name: '清理孤儿最近游玩',
    table: 'recents',
    needed: async () => {
      if (!(await hasTable('games'))) return false
      // 同上：v2 的 recents 用 game_id 外键，没有 game_slug 这一列
      if (!(await hasColumn('recents', 'game_slug'))) return false
      const r = await one('SELECT COUNT(*) AS n FROM recents r LEFT JOIN games g ON g.slug = r.game_slug WHERE g.slug IS NULL')
      return Number(r?.n ?? 0) > 0
    },
    run: () => conn.query('DELETE r FROM recents r LEFT JOIN games g ON g.slug = r.game_slug WHERE g.slug IS NULL'),
  },
  {
    name: 'game_comments（游戏评论：登录用户发表、后台可隐藏、支持引用回复）',
    // table: null —— 这条补丁自己就是建表，不能拿「表不存在」当跳过理由
    table: null,
    needed: async () => !(await hasTable('game_comments')),
    /**
     * 只在 v2 库上建：外键指向 games(id)，而 v1 的 games 主键是 slug，
     * 在 v1 库上跑会直接报 errno 150。
     */
    skip: async () => ((await hasColumn('games', 'id')) ? '' : '这个库是 v1 结构（games 没有 id 主键），评论表的外键挂不上去'),
    run: () =>
      conn.query(`CREATE TABLE IF NOT EXISTS game_comments (
        id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        game_id    BIGINT UNSIGNED NOT NULL,
        user_id    VARCHAR(40)     NOT NULL,
        parent_id  BIGINT UNSIGNED NULL,
        content    VARCHAR(2000)   NOT NULL,
        country    CHAR(2)         NOT NULL DEFAULT 'XX',
        hidden     TINYINT(1)      NOT NULL DEFAULT 0,
        edited_at  TIMESTAMP(3)    NULL DEFAULT NULL,
        deleted_at TIMESTAMP(3)    NULL DEFAULT NULL,
        created_at TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        KEY idx_cmt_game_time (game_id, created_at DESC),
        KEY idx_cmt_user_time (user_id, created_at DESC),
        KEY idx_cmt_parent (parent_id),
        KEY idx_cmt_hidden_time (hidden, created_at DESC),
        CONSTRAINT fk_cmt_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
        CONSTRAINT fk_cmt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_cmt_parent FOREIGN KEY (parent_id) REFERENCES game_comments(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`),
  },
  {
    name: 'collections + collection_items（用户自建的游戏合集）',
    table: null,
    skip: async () => {
      if (!(await hasTable('users'))) return '还没有 users 表'
      if (!(await hasTable('games'))) return '还没有 games 表'
      return null
    },
    needed: async () => !(await hasTable('collections')) || !(await hasTable('collection_items')),
    run: async () => {
      await conn.query(
        'CREATE TABLE IF NOT EXISTS `collections` (' +
          '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,' +
          '`user_id` VARCHAR(40) NOT NULL,' +
          '`title` VARCHAR(80) NOT NULL,' +
          // 「类型」是作者自己填的一行字，不是枚举 —— 见 schema-v2.sql 里的说明
          "`kind` VARCHAR(30) NOT NULL DEFAULT ''," +
          "`description` VARCHAR(500) NOT NULL DEFAULT ''," +
          '`hidden` TINYINT(1) NOT NULL DEFAULT 0,' +
          // 不带 ON UPDATE：什么时候算「有动静」由代码显式决定，否则任何无关的
          // UPDATE 都会把合集顶到列表最前面
          '`updated_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
          '`created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
          'KEY `idx_col_user_time` (`user_id`, `created_at` DESC),' +
          'KEY `idx_col_pub_time` (`hidden`, `updated_at` DESC)' +
          ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
      )
      await conn.query(
        'CREATE TABLE IF NOT EXISTS `collection_items` (' +
          '`collection_id` BIGINT UNSIGNED NOT NULL,' +
          '`game_id` BIGINT UNSIGNED NOT NULL,' +
          // 毫秒精度：封面取「最新放入的四款」，秒级会让同一秒连加的几款排不出先后
          '`created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
          'PRIMARY KEY (`collection_id`, `game_id`),' +
          'KEY `idx_ci_col_time` (`collection_id`, `created_at` DESC),' +
          'KEY `idx_ci_game` (`game_id`)' +
          ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
      )
      // 外键单独加：老库里 users.id / games.id 的类型可能对不上，加不上也不该让整个迁移失败
      for (const [table, name, sql] of [
        ['collections', 'fk_col_user', 'FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE'],
        ['collection_items', 'fk_ci_col', 'FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE CASCADE'],
        ['collection_items', 'fk_ci_game', 'FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON DELETE CASCADE'],
      ]) {
        try {
          await conn.query(`ALTER TABLE \`${table}\` ADD CONSTRAINT \`${name}\` ${sql}`)
        } catch (e) {
          console.log(`   （外键 ${name} 没加上，不影响使用：${e.message}）`)
        }
      }
    },
  },
  {
    name: 'collection_items.position（合集内手动排序）',
    table: 'collection_items',
    needed: async () => !(await hasColumn('collection_items', 'position')),
    // NULL = 作者没排过，顺序退回「最新放入的在前」；所以老数据不用回填
    run: () =>
      conn.query(`ALTER TABLE \`collection_items\`
        ADD COLUMN \`position\` INT NULL,
        ADD KEY \`idx_ci_col_pos\` (\`collection_id\`, \`position\`)`),
  },
  {
    name: 'collection_views（合集浏览量，按人去重）',
    table: null,
    needed: async () => !(await hasTable('collection_views')),
    // 老数据不用回填：没有历史浏览记录可考，从上线那一刻开始数
    run: () =>
      conn.query(
        'CREATE TABLE IF NOT EXISTS `collection_views` (' +
          '`collection_id` BIGINT UNSIGNED NOT NULL,' +
          '`kind` CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,' +
          // ⚠️ ascii_bin，理由同 game_plays：base64url 区分大小写
          '`identity` CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,' +
          '`viewed_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
          'PRIMARY KEY (`collection_id`, `kind`, `identity`),' +
          'CONSTRAINT `fk_cv_collection` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE CASCADE' +
          ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
      ),
  },
  {
    name: 'games 的评分聚合列（rating_sum / rating_weight / rating_count）',
    table: 'games',
    needed: async () => !(await hasColumn('games', 'rating_sum')),
    run: () =>
      conn.query(`ALTER TABLE \`games\`
        ADD COLUMN \`rating_sum\`    DECIMAL(12,1) NOT NULL DEFAULT 0,
        ADD COLUMN \`rating_weight\` DECIMAL(12,1) NOT NULL DEFAULT 0,
        ADD COLUMN \`rating_count\`  INT UNSIGNED  NOT NULL DEFAULT 0`),
  },
  {
    name: 'game_ratings（游戏评分：登录 1.0 分权重、匿名 0.5）',
    // table: null —— 这条补丁自己就是建表，不能拿「表不存在」当跳过理由
    table: null,
    needed: async () => !(await hasTable('game_ratings')),
    /** 同 game_comments：外键指向 games(id)，v1 库的 games 主键是 slug，挂不上去 */
    skip: async () => ((await hasColumn('games', 'id')) ? '' : '这个库是 v1 结构（games 没有 id 主键），评分表的外键挂不上去'),
    run: () =>
      conn.query(`CREATE TABLE IF NOT EXISTS game_ratings (
        id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        game_id    BIGINT UNSIGNED NOT NULL,
        user_id    VARCHAR(40)     NULL,
        anon_id    CHAR(32)        NULL,
        anon_ip    VARCHAR(45)     NULL,
        score      TINYINT UNSIGNED NOT NULL,
        weight     DECIMAL(2,1)    NOT NULL,
        country    CHAR(2)         NOT NULL DEFAULT 'XX',
        created_at TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uniq_rating_user (game_id, user_id),
        UNIQUE KEY uniq_rating_anon (game_id, anon_id),
        UNIQUE KEY uniq_rating_ip (game_id, anon_ip),
        KEY idx_rating_game_time (game_id, created_at DESC),
        KEY idx_rating_user_time (user_id, created_at DESC),
        CONSTRAINT fk_rating_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
        CONSTRAINT fk_rating_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT chk_rating_score CHECK (score BETWEEN 1 AND 5)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`),
  },
  {
    name: 'friend_links（首页特别鸣谢 / 友情链接）',
    // 这张表不依赖用户或游戏，v1 / v2 库都可以安全创建。
    table: null,
    needed: async () => !(await hasTable('friend_links')),
    run: () =>
      conn.query(`CREATE TABLE IF NOT EXISTS friend_links (
        id          BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name        VARCHAR(80)       NOT NULL,
        url         VARCHAR(500)      NOT NULL,
        image       VARCHAR(500)      NOT NULL DEFAULT '',
        sort_order  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        enabled     TINYINT(1)        NOT NULL DEFAULT 1,
        created_at  TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_friend_links_public (enabled, sort_order, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`),
  },

  {
    name: '开放平台五张表（oauth_apps / _app_secrets / _authorizations / _codes / _tokens）',
    table: null,
    /*
      设计稿：docs/open-platform.md。这五张一起建、一起判：
      少建一张的后果不是「某个功能没有」，而是**授权流程走到一半才炸** ——
      换 token 那一步查不到 oauth_codes，接入方看到的是一个 500，无从下手。

      ⚠️ 外键指向 oauth_apps，所以建表顺序不能变（apps 必须最先）。
    */
    skip: async () => (!(await hasTable('users')) ? '还没有 users 表' : null),
    needed: async () => {
      for (const t of ['oauth_apps', 'oauth_app_secrets', 'oauth_authorizations', 'oauth_codes', 'oauth_tokens']) {
        if (!(await hasTable(t))) return true
      }
      return false
    },
    run: async () => {
      await conn.query('CREATE TABLE IF NOT EXISTS oauth_apps ( id              VARCHAR(40)   NOT NULL PRIMARY KEY, owner_id        VARCHAR(40)   NOT NULL, name            VARCHAR(60)   NOT NULL, description     TEXT          NULL, homepage        VARCHAR(300)  NULL, logo            VARCHAR(500)  NULL, privacy_url     VARCHAR(300)  NULL, client_type     ENUM(\'confidential\',\'public\') NOT NULL DEFAULT \'confidential\', redirect_uris   TEXT          NULL, embed_origins   TEXT          NULL, approved_scopes TEXT          NULL, status          ENUM(\'sandbox\',\'live\',\'suspended\') NOT NULL DEFAULT \'sandbox\', rate_tier       VARCHAR(16)   NOT NULL DEFAULT \'sandbox\', created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, KEY idx_owner (owner_id) ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci')
      await conn.query('CREATE TABLE IF NOT EXISTS oauth_app_secrets ( id           VARCHAR(40)  NOT NULL PRIMARY KEY, app_id       VARCHAR(40)  NOT NULL, secret_hash  VARCHAR(200) NOT NULL, hint         CHAR(6)      NOT NULL, created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at   TIMESTAMP    NULL, revoked_at   TIMESTAMP    NULL, last_used_at TIMESTAMP    NULL, KEY idx_app (app_id), CONSTRAINT fk_oas_app FOREIGN KEY (app_id) REFERENCES oauth_apps(id) ON DELETE CASCADE ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci')
      await conn.query('CREATE TABLE IF NOT EXISTS oauth_authorizations ( user_id    VARCHAR(40) NOT NULL, app_id     VARCHAR(40) NOT NULL, scopes     TEXT        NULL, created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (user_id, app_id), KEY idx_auth_app (app_id), CONSTRAINT fk_oauth_app FOREIGN KEY (app_id) REFERENCES oauth_apps(id) ON DELETE CASCADE ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci')
      await conn.query('CREATE TABLE IF NOT EXISTS oauth_codes ( code_hash      CHAR(64)     NOT NULL PRIMARY KEY, app_id         VARCHAR(40)  NOT NULL, user_id        VARCHAR(40)  NOT NULL, scopes         TEXT         NULL, redirect_uri   VARCHAR(500) NOT NULL, code_challenge VARCHAR(128) NOT NULL, nonce          VARCHAR(128) NULL, expires_at     TIMESTAMP    NOT NULL, used_at        TIMESTAMP    NULL, KEY idx_codes_expire (expires_at), CONSTRAINT fk_oc_app FOREIGN KEY (app_id) REFERENCES oauth_apps(id) ON DELETE CASCADE ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci')
      await conn.query('CREATE TABLE IF NOT EXISTS oauth_tokens ( token_hash   CHAR(64)    NOT NULL PRIMARY KEY, app_id       VARCHAR(40) NOT NULL, user_id      VARCHAR(40) NOT NULL, scopes       TEXT        NULL, rotated_from CHAR(64)    NULL, expires_at   TIMESTAMP   NOT NULL, revoked_at   TIMESTAMP   NULL, last_used_at TIMESTAMP   NULL, created_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP, KEY idx_tok_user_app (user_id, app_id), KEY idx_tok_expire (expires_at), CONSTRAINT fk_ot_app FOREIGN KEY (app_id) REFERENCES oauth_apps(id) ON DELETE CASCADE ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci')
    },
  },
  {
    name: '开放平台的申请与审核（oauth_apps 加 8 列 + 流水表 + 沙箱测试账号白名单）',
    table: null,
    /*
      状态机见 server/src/open/review.js。
      ⚠️ 逐列判断而不是一条 ALTER 加八列：这张表是 09-11 当天建的，
      有的库可能已经有了其中几列（比如先手工加过 requested_scopes），
      一条 ALTER 会整条失败，于是后面七列一个都加不上。
    */
    skip: async () => (!(await hasTable('oauth_apps')) ? '还没有 oauth_apps 表（先跑上一条补丁）' : null),
    needed: async () =>
      !(await hasColumn('oauth_apps', 'review_state')) ||
      !(await hasTable('oauth_app_reviews')) ||
      !(await hasTable('oauth_app_testers')),
    run: async () => {
      if (!(await hasColumn('oauth_apps', 'review_state'))) {
        await conn.query('ALTER TABLE `oauth_apps` ADD COLUMN `review_state` ENUM(\'none\',\'pending\',\'rejected\') NOT NULL DEFAULT \'none\' AFTER `status`')
      }
      if (!(await hasColumn('oauth_apps', 'requested_scopes'))) {
        await conn.query('ALTER TABLE `oauth_apps` ADD COLUMN `requested_scopes` TEXT NULL AFTER `approved_scopes`')
      }
      if (!(await hasColumn('oauth_apps', 'review_note'))) {
        await conn.query('ALTER TABLE `oauth_apps` ADD COLUMN `review_note` TEXT NULL AFTER `review_state`')
      }
      if (!(await hasColumn('oauth_apps', 'review_reason'))) {
        await conn.query('ALTER TABLE `oauth_apps` ADD COLUMN `review_reason` VARCHAR(500) NULL AFTER `review_note`')
      }
      if (!(await hasColumn('oauth_apps', 'submitted_at'))) {
        await conn.query('ALTER TABLE `oauth_apps` ADD COLUMN `submitted_at` TIMESTAMP NULL AFTER `review_reason`')
      }
      if (!(await hasColumn('oauth_apps', 'reviewed_by'))) {
        await conn.query('ALTER TABLE `oauth_apps` ADD COLUMN `reviewed_by` VARCHAR(40) NULL AFTER `submitted_at`')
      }
      if (!(await hasColumn('oauth_apps', 'reviewed_at'))) {
        await conn.query('ALTER TABLE `oauth_apps` ADD COLUMN `reviewed_at` TIMESTAMP NULL AFTER `reviewed_by`')
      }
      if (!(await hasColumn('oauth_apps', 'suspended_from'))) {
        await conn.query('ALTER TABLE `oauth_apps` ADD COLUMN `suspended_from` ENUM(\'sandbox\',\'live\') NULL AFTER `reviewed_at`')
      }
      await conn.query('CREATE TABLE IF NOT EXISTS oauth_app_reviews ( id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, app_id     VARCHAR(40) NOT NULL, actor_id   VARCHAR(40) NOT NULL, action     ENUM(\'submit\',\'withdraw\',\'approve\',\'reject\',\'suspend\',\'restore\') NOT NULL, detail     TEXT        NULL, created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP, KEY idx_oar_app (app_id, created_at), CONSTRAINT fk_oar_app FOREIGN KEY (app_id) REFERENCES oauth_apps(id) ON DELETE CASCADE ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci')
      await conn.query('CREATE TABLE IF NOT EXISTS oauth_app_testers ( app_id   VARCHAR(40) NOT NULL, user_id  VARCHAR(40) NOT NULL, added_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (app_id, user_id), CONSTRAINT fk_oat_app FOREIGN KEY (app_id) REFERENCES oauth_apps(id) ON DELETE CASCADE ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci')
    },
  },
]

const TABLES = ['games', 'posts', 'users', 'favorites', 'recents', 'saves', 'login_codes', 'platform_bios', 'game_plays', 'developers', 'friend_links', 'game_comments', 'game_ratings', 'oauth_apps']

try {
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  await conn.query(`USE \`${DB_NAME}\``)

  const server = await one('SELECT VERSION() AS v')
  console.log(`数据库：${DB_NAME} @ ${process.env.DB_HOST || '127.0.0.1'}:${process.env.DB_PORT || 3306}（${server?.v ?? '?'}）`)

  /**
   * 先认清这个库是什么结构再动手 —— 以前是无条件执行 schema.sql（**v1** 那份），
   * 于是在一个空库上跑 migrate 会建出一套 v1 表，而现在的服务端代码是 v2
   * （games 主键是 id、类型/标签/ROM 各自一张关联表）。表面上「建表完成」，
   * 实际上后端一条查询都跑不通，排查起来极其费劲。
   *
   * 判据用 game_tags：v2 有、v1 没有（v1 的标签存在 games.tags 这个 JSON 列里）。
   */
  const version = !(await hasTable('games')) ? 'fresh' : (await hasTable('game_tags')) ? 'v2' : 'v1'
  console.log(`库结构：${version === 'fresh' ? '空库（还没建过表）' : version}\n`)

  if (version === 'v1') {
    console.log('⚠️  这个库是 **v1** 结构，而当前代码是 v2。')
    console.log('   v1 的 games 主键是 slug、标签存 JSON 列，和 v2 不兼容，没法靠 ALTER 补上去。')
    console.log('   要升到 v2 得执行 8bitgo-v2-install.sql —— 那个脚本会**删表重建**，')
    console.log('   games / posts / users / favorites / recents 里的数据全部丢失，执行前务必先 mysqldump 备份。')
    console.log('   下面只会跑那些对 v1 也安全的补丁，v2 专属的会跳过。\n')
  } else {
    // 空库和 v2 库都用 v2 结构。schema-v2.sql 全是 CREATE TABLE IF NOT EXISTS，
    // 对已经建好的表不会有任何动作，所以在 v2 库上重复执行也是安全的
    await conn.query(await loadSchema('schema-v2.sql'))
    console.log('✅ 建表完成（schema-v2.sql 已执行）')
  }

  let applied = 0
  let missing = 0
  let skipped = 0
  for (const p of patches) {
    // table: null = 这条补丁自己就是「建表」，不能拿「表不存在」当跳过理由，
    // 否则新表永远建不出来
    if (p.table && !(await hasTable(p.table))) {
      console.log(`⚠️  ${p.name}：${p.table} 表不存在，已跳过`)
      missing++
      continue
    }
    if (p.skip) {
      const why = await p.skip()
      if (why) {
        console.log(`⏭  ${p.name}：已跳过 —— ${why}`)
        skipped++
        continue
      }
    }
    if (!(await p.needed())) {
      console.log(`· ${p.name}：已是最新`)
      continue
    }
    await p.run()
    console.log(`✅ ${p.name}：已应用`)
    applied++
  }

  // 收尾报告：把库里到底有什么摊开说清楚，省得再出现「说已是最新其实查错了库」这种事
  console.log('\n当前库内容：')
  for (const t of TABLES) {
    if (!(await hasTable(t))) {
      console.log(`  ${t.padEnd(13)} 不存在`)
      continue
    }
    const r = await one(`SELECT COUNT(*) AS n FROM \`${t}\``)
    console.log(`  ${t.padEnd(13)} ${String(r?.n ?? 0).padStart(6)} 行`)
  }

  if (skipped) console.log(`\n⏭  有 ${skipped} 条补丁按库结构跳过了（见上面的说明）。`)
  if (missing) console.log(`\n⚠️  有 ${missing} 条补丁因为表不存在被跳过。表建好之后再跑一次 npm run migrate。`)
  else console.log(applied ? `\n共应用 ${applied} 条补丁。` : '\n数据库结构已是最新，无需改动。')
} catch (e) {
  console.error('❌ 迁移失败：', e.message)
  process.exitCode = 1
} finally {
  await conn.end()
}
