-- ============================================================
-- 8BitGo 数据库结构 v2（面向上千款游戏重新设计）
--
-- 与 v1 的主要区别：
--   1. games 用自增 id 做主键，slug 改为唯一键
--      —— 关联表不再背着 120 字节的 slug，索引小一个数量级；slug 也就能改了
--   2. 类型 / 标签 / ROM 从 JSON 列拆成关联表
--      —— JSON 列建不了索引，「按类型筛选」以前只能把全库拉到浏览器再用 JS 过滤
--   3. 日期用真实类型（DATE / TIMESTAMP），不再是 VARCHAR
--   4. favorites / recents 对游戏加了外键，删游戏自动级联，不用再手动清孤儿行
--   5. 去掉 rating / rating_count（站内没有评分功能，留着只会被填成假数据）
--
-- 刻意**没有**放进数据库的：平台表、类型表。
--   它们是配置不是内容 —— platform.runtime / core 直接对应模拟器适配器，
--   PlatformId / GenreId 还是 TypeScript 的联合类型。13 个平台、12 个类型是固定集合，
--   挪进库里会丢掉编译期检查，也省不下任何查询。games.platform 和 game_genres.genre_id
--   存的就是这些代码里定义好的 id（见 src/data/platforms.ts、src/data/genres.ts）。
--
-- 用法：mysql -u root -p < schema-v2.sql
-- 执行完是**空库**：一款游戏、一篇文章都没有，全部由后台自己添加。
-- ============================================================

SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS `8bitgo`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `8bitgo`;

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
  KEY idx_coin         (hidden, coin_reward)
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
