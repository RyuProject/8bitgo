-- ============================================================
-- 8BitGo 数据库安装脚本（结构 v2）
--
-- ⚠️ 这个文件会先**删掉**下面这些表，再按 v2 结构重建：
--      games / posts / users / favorites / recents
--    以及它们里面的全部数据。
--
--    为什么必须删：v1 的 games 主键是 slug、posts 的标签存在 JSON 列里，
--    和 v2 不兼容；而 CREATE TABLE IF NOT EXISTS 对已存在的表完全不生效。
--    不删的话 v2 的关联表连建都建不出来（外键指向 games(id)，v1 没有这一列），
--    整个脚本会中途报错。
--
-- 执行前先跑这一句，确认你要丢掉什么：
--
--   SELECT 'games' t, COUNT(*) n FROM games
--   UNION ALL SELECT 'posts', COUNT(*) FROM posts
--   UNION ALL SELECT 'users', COUNT(*) FROM users;
--
--   users 不是 0 就说明已经有人注册过账号，先备份：
--   mysqldump -u root -p -P 3307 <你的库名> > backup.sql
--
-- 用法见下方「不建库、也不切库」那段说明。
--
-- 执行完是**空库**：一款游戏、一篇文章都没有，全部由后台自己添加。
-- ============================================================

SET NAMES utf8mb4;

-- ⚠️ 这个脚本**不建库、也不切库**，直接在你当前选中的数据库里执行。
--    原因：库名写死过一次亏，本项目的 .env 里 DB_NAME 可能是 eightbitgo、8bitgo
--    或者别的名字，写死就会「表建在 A 库、后端连的是 B 库」，非常难查。
--
-- 命令行用法（把 eightbitgo 换成你 .env 里的 DB_NAME）：
--   mysql -u root -p -P 3307 eightbitgo < 8bitgo-v2-install.sql
--
-- 图形客户端（DBGate / Navicat）：先在左侧点开你要用的库，确认标题栏显示的是它，再执行。
--
-- 执行前先确认选对了库：
SELECT DATABASE() AS `当前数据库`;

-- ---------- 0. 清掉旧结构 ----------
-- 关掉外键检查，删除顺序就不用管依赖关系；下面立刻恢复
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS game_genres;
DROP TABLE IF EXISTS game_tags;
DROP TABLE IF EXISTS game_roms;
DROP TABLE IF EXISTS post_tags;
DROP TABLE IF EXISTS favorites;
DROP TABLE IF EXISTS recents;
DROP TABLE IF EXISTS games;
DROP TABLE IF EXISTS posts;
DROP TABLE IF EXISTS users;
SET FOREIGN_KEY_CHECKS = 1;

-- ---------- 游戏 ----------
CREATE TABLE IF NOT EXISTS games (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slug          VARCHAR(120)  NOT NULL,
  title         VARCHAR(200)  NOT NULL,
  title_zh      VARCHAR(200)  NULL,
  -- 平台 id，取值见 src/data/platforms.ts（'nes' / 'snes' / 'psx' …）
  platform      VARCHAR(20)   NOT NULL,
  `year`        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  -- 开发商用字符串而不是单独一张表：站内没有开发商详情页，
  -- /developers 只需要 GROUP BY 出个数，有索引就够了
  developer     VARCHAR(200)  NOT NULL DEFAULT '',
  -- 真实游玩次数，由玩家把游戏跑起来时累加（POST /api/games/:slug/play）
  plays         INT UNSIGNED  NOT NULL DEFAULT 0,
  players       TINYINT UNSIGNED NOT NULL DEFAULT 1,
  multiplayer   TINYINT(1)    NOT NULL DEFAULT 0,
  -- G 币奖励。功能未开放时一律为 0
  coin_reward   INT UNSIGNED  NOT NULL DEFAULT 0,
  -- 没有封面图时的兜底 emoji
  icon          VARCHAR(16)   NOT NULL DEFAULT '🎮',
  cover         VARCHAR(500)  NULL,
  video         VARCHAR(500)  NULL,
  description   TEXT          NULL,
  body_control  TINYINT(1)    NOT NULL DEFAULT 0,
  hidden        TINYINT(1)    NOT NULL DEFAULT 0,
  -- 模拟器核心覆盖。NULL = 用平台默认（src/data/platforms.ts 的 core 字段）。
  -- 街机尤其需要：同一个「街机」平台底下，拳皇要 fbneo、街霸2 要 fbalpha2012_cps2、
  -- 有些老游戏只有 mame2003_plus 跑得动，一个平台默认值盖不住。
  core          VARCHAR(32)   NULL,
  -- 首页「精选」位的排序号。NULL = 不上首页，数字小的排前面。
  -- 一款都没设时，首页那一栏退回按 plays 自动排（见 server/src/content.js 的 loadHome）
  home_rank     SMALLINT UNSIGNED NULL,
  -- 对外的「上线日期」。留空时后端用 created_at 兜底，不用人工编日期
  added_at      DATE          NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uniq_slug (slug),
  -- 下面这几条复合索引对应前台真实的列表查询：
  -- 「最多人玩」「最新上架」「按名称」，以及带平台筛选的同样三种排序。
  -- 把 hidden 放在第一列，是因为前台**每一条**查询都带 hidden = 0。
  KEY idx_pub_plays    (hidden, plays DESC),
  KEY idx_pub_added    (hidden, added_at DESC),
  KEY idx_pub_title    (hidden, title),
  KEY idx_platform     (hidden, platform, plays DESC),
  KEY idx_developer    (hidden, developer),
  KEY idx_multiplayer  (hidden, multiplayer, plays DESC),
  KEY idx_coin         (hidden, coin_reward),
  -- 首页精选位：只有寥寥几行 home_rank 非空，这条索引让首页那一次查询不用扫全表
  KEY idx_home_rank    (hidden, home_rank)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 平台级 BIOS ----------
-- Neo Geo 这类平台必须有 BIOS 才能启动（拳皇、合金弹头都要 neogeo.zip），
-- 而同一个 BIOS 是整个平台共用的，挂在每一款游戏上纯属重复。
-- 这里只存对象存储的 key，文件本身和 ROM 一样放在 R2。
CREATE TABLE IF NOT EXISTS platform_bios (
  platform    VARCHAR(20)  NOT NULL,
  object_key  VARCHAR(500) NOT NULL,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (platform)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 游戏 × 类型 ----------
-- genre_id 取值见 src/data/genres.ts（'action' / 'rpg' / 'puzzle' …）
-- 两个方向的索引都要：按游戏取它的类型（主键），按类型筛游戏（idx_genre）
CREATE TABLE IF NOT EXISTS game_genres (
  game_id   BIGINT UNSIGNED NOT NULL,
  genre_id  VARCHAR(20)     NOT NULL,
  PRIMARY KEY (game_id, genre_id),
  KEY idx_genre (genre_id, game_id),
  CONSTRAINT fk_gg_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 游戏 × 标签 ----------
-- 标签是后台自由填写的，不做成独立的 tags 表：没有标签详情页，
-- 也不需要重命名标签，一张关联表足够，还省一次 join
CREATE TABLE IF NOT EXISTS game_tags (
  game_id  BIGINT UNSIGNED NOT NULL,
  tag      VARCHAR(60)     NOT NULL,
  PRIMARY KEY (game_id, tag),
  KEY idx_tag (tag, game_id),
  CONSTRAINT fk_gt_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 游戏 × ROM 文件 ----------
-- lang 为语言代码（'zh-Hans' / 'zh-Hant' / 'en' / 'ja'），
-- 特殊值 '*' 表示不分语言的通用 ROM —— v1 里这是 games.rom 那一列，
-- 和按语言的 roms JSON 各存一半，两边判断逻辑经常对不上，这里合成一张表。
-- object_key 是 R2 里的对象键，如 roms/nes/contra.zip
CREATE TABLE IF NOT EXISTS game_roms (
  game_id    BIGINT UNSIGNED NOT NULL,
  lang       VARCHAR(10)     NOT NULL DEFAULT '*',
  object_key VARCHAR(500)    NOT NULL,
  PRIMARY KEY (game_id, lang),
  -- 后台「ROM 存储」页要反查「这个文件绑给了哪款游戏」
  KEY idx_object_key (object_key(191)),
  CONSTRAINT fk_gr_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 博客文章 ----------
CREATE TABLE IF NOT EXISTS posts (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slug        VARCHAR(120)  NOT NULL,
  title       VARCHAR(300)  NOT NULL,
  excerpt     TEXT          NULL,
  content     MEDIUMTEXT    NOT NULL,
  icon        VARCHAR(16)   NOT NULL DEFAULT '📝',
  author      VARCHAR(120)  NOT NULL DEFAULT '',
  `date`      DATE          NULL,
  published   TINYINT(1)    NOT NULL DEFAULT 0,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_post_slug (slug),
  -- 前台列表：已发布的按日期倒序
  KEY idx_pub_date (published, `date` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS post_tags (
  post_id  BIGINT UNSIGNED NOT NULL,
  tag      VARCHAR(60)     NOT NULL,
  PRIMARY KEY (post_id, tag),
  KEY idx_post_tag (tag, post_id),
  CONSTRAINT fk_pt_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 用户 ----------
CREATE TABLE IF NOT EXISTS users (
  id            VARCHAR(40)   NOT NULL PRIMARY KEY,
  email         VARCHAR(200)  NOT NULL,
  nickname      VARCHAR(60)   NOT NULL,
  avatar        VARCHAR(16)   NOT NULL DEFAULT '🕹️',
  password_hash VARCHAR(200)  NOT NULL,
  coins         INT UNSIGNED  NOT NULL DEFAULT 0,
  role          ENUM('user','admin')    NOT NULL DEFAULT 'user',
  status        ENUM('active','banned') NOT NULL DEFAULT 'active',
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_email (email),
  KEY idx_role (role, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 稍后玩（v1 叫「收藏」）----------
-- 改用 game_id 外键：删游戏时数据库自己级联，不再需要应用层去清孤儿行
CREATE TABLE IF NOT EXISTS favorites (
  user_id    VARCHAR(40)     NOT NULL,
  game_id    BIGINT UNSIGNED NOT NULL,
  -- 毫秒精度。秒级 TIMESTAMP 会让同一秒里连点几款游戏的记录时间戳完全相同，
  -- 「最新在前」的排序就变成随机的了
  created_at TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, game_id),
  KEY idx_fav_user_time (user_id, created_at DESC),
  KEY idx_fav_game (game_id),
  CONSTRAINT fk_fav_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_fav_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 最近游玩 ----------
CREATE TABLE IF NOT EXISTS recents (
  user_id   VARCHAR(40)     NOT NULL,
  game_id   BIGINT UNSIGNED NOT NULL,
  -- 同 favorites：秒级精度下，快速连开几款游戏会挤在同一个时间戳上，
  -- 结果既排不出先后，「只保留最近 12 条」还会把刚玩的那款当成旧记录删掉
  played_at TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, game_id),
  KEY idx_recent_user_time (user_id, played_at DESC),
  KEY idx_recent_game (game_id),
  CONSTRAINT fk_recent_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_recent_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 完成。库是空的，自检：
--   SELECT table_name, table_rows FROM information_schema.TABLES
--     WHERE table_schema = '8bitgo' ORDER BY table_name;
--
-- 管理员账号建不了（需要 bcrypt 哈希）：先在网站上注册，然后
--   UPDATE users SET role='admin' WHERE email='你的邮箱';
-- ============================================================

-- ============================================================
-- 自检：应该是 9 张表，全部 0 行
SELECT table_name FROM information_schema.TABLES
  WHERE table_schema = DATABASE() ORDER BY table_name;

SELECT 'games' t, COUNT(*) n FROM games
UNION ALL SELECT 'posts', COUNT(*) FROM posts
UNION ALL SELECT 'users', COUNT(*) FROM users;

-- 管理员账号这里建不了（需要 bcrypt 哈希）。先在网站上正常注册，然后：
--   UPDATE users SET role='admin' WHERE email='你的邮箱';
-- ============================================================
