-- ============================================================
-- 8BitGo 建库脚本（空表版）：只建库建表，不插入任何数据
-- 直接粘进 DBGate 的 SQL 查询窗口执行即可（可重复执行，幂等）。
-- 表建好后是空的，游戏和文章到后台自己加。
-- ============================================================

-- 用法：
--   mysql -u root -p < 8bitgo-setup-empty.sql
--   或直接把整个文件粘进 DBGate / Navicat / phpMyAdmin 的 SQL 窗口执行
--
-- 三种情况都能用：
--   全新的库      -> 建库建表（空表）
--   已有的旧库    -> 补上后加的列和索引，清掉孤儿数据，已有数据一律不动
--   重复执行      -> 幂等，不会重复插入，也不会动用户数据
--
-- 不会碰的东西：库里已有的任何数据。这个版本只负责把表结构弄对。

-- 强制 utf8mb4：客户端默认 latin1 时中文会被双重编码存成乱码
SET NAMES utf8mb4;

-- ---------- 1. 表结构 ----------
-- 8BitGo 数据库表结构
-- 用法：mysql -u root -p < schema.sql   （或用 npm run migrate 自动执行）
-- 字符集用 utf8mb4，支持中文与 emoji。

-- 强制本次连接用 utf8mb4：有些 mysql/mariadb 客户端默认 latin1，
-- 不加这行会把中文按 latin1 存成「双重编码」，读出来全是乱码。
SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS `8bitgo`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `8bitgo`;

-- ---------- 游戏 ----------
CREATE TABLE IF NOT EXISTS games (
  slug         VARCHAR(120)  NOT NULL PRIMARY KEY,
  title        VARCHAR(200)  NOT NULL,
  title_zh     VARCHAR(200)  NULL,
  platform     VARCHAR(20)   NOT NULL,
  genres       JSON          NOT NULL,
  year         INT           NOT NULL DEFAULT 0,
  developer    VARCHAR(200)  NOT NULL DEFAULT '',
  rating       DECIMAL(3,2)  NOT NULL DEFAULT 0,
  rating_count INT           NOT NULL DEFAULT 0,
  plays        INT           NOT NULL DEFAULT 0,
  players      TINYINT       NOT NULL DEFAULT 1,
  multiplayer  TINYINT(1)    NOT NULL DEFAULT 0,
  coin_reward  INT           NOT NULL DEFAULT 0,
  icon         VARCHAR(16)   NOT NULL DEFAULT '🎮',
  cover        VARCHAR(500)  NULL,
  video        VARCHAR(500)  NULL,
  description  TEXT          NULL,
  tags         JSON          NULL,
  added_at     VARCHAR(20)   NOT NULL DEFAULT '',
  body_control TINYINT(1)    NOT NULL DEFAULT 0,
  hidden       TINYINT(1)    NOT NULL DEFAULT 0,
  rom          VARCHAR(500)  NULL,
  roms         JSON          NULL,
  -- 真实入库时间。added_at（对外的「上线日期」）为空时用它兜底，
  -- 这样新增的游戏不需要人工填日期，也编不出来。
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_platform (platform),
  INDEX idx_hidden (hidden)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 博客文章 ----------
CREATE TABLE IF NOT EXISTS posts (
  slug        VARCHAR(120)  NOT NULL PRIMARY KEY,
  title       VARCHAR(300)  NOT NULL,
  excerpt     TEXT          NULL,
  content     MEDIUMTEXT    NOT NULL,
  icon        VARCHAR(16)   NOT NULL DEFAULT '📝',
  tags        JSON          NOT NULL,
  author      VARCHAR(120)  NOT NULL DEFAULT '',
  date        VARCHAR(20)   NOT NULL DEFAULT '',
  published   TINYINT(1)    NOT NULL DEFAULT 1,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_published (published)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 用户 ----------
CREATE TABLE IF NOT EXISTS users (
  id            VARCHAR(40)   NOT NULL PRIMARY KEY,
  email         VARCHAR(200)  NOT NULL,
  nickname      VARCHAR(60)   NOT NULL,
  avatar        VARCHAR(16)   NOT NULL DEFAULT '🕹️',
  password_hash VARCHAR(200)  NOT NULL,
  coins         INT           NOT NULL DEFAULT 0,
  role          ENUM('user','volunteer','admin') NOT NULL DEFAULT 'user',
  status        ENUM('active','banned') NOT NULL DEFAULT 'active',
  created_at    VARCHAR(20)   NOT NULL DEFAULT '',
  UNIQUE KEY uniq_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 收藏 ----------
CREATE TABLE IF NOT EXISTS favorites (
  user_id    VARCHAR(40)  NOT NULL,
  game_slug  VARCHAR(120) NOT NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, game_slug),
  INDEX idx_fav_user (user_id),
  -- 删除游戏时要按 game_slug 清理孤儿行；联合主键的第二列用不上索引，得单独建
  INDEX idx_fav_game (game_slug),
  CONSTRAINT fk_fav_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 最近游玩 ----------
CREATE TABLE IF NOT EXISTS recents (
  user_id   VARCHAR(40)  NOT NULL,
  game_slug VARCHAR(120) NOT NULL,
  played_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, game_slug),
  INDEX idx_recent_user_time (user_id, played_at),
  -- 同 favorites：删游戏时按 game_slug 清理
  INDEX idx_recent_game (game_slug),
  CONSTRAINT fk_recent_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

USE `8bitgo`;

-- ---------- 1b. 老库升级 ----------
-- 上面是 CREATE TABLE IF NOT EXISTS，对**已经建好**的表不会补新增的列和索引，
-- 所以这里逐条判断后再补。全新的库会全部跳过；重复执行没有副作用。
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE table_schema = DATABASE() AND table_name = 'games' AND column_name = 'created_at') > 0,
  'SELECT 1', 'ALTER TABLE `games` ADD COLUMN `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER `roms`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
     WHERE table_schema = DATABASE() AND table_name = 'favorites' AND index_name = 'idx_fav_game') > 0,
  'SELECT 1', 'ALTER TABLE `favorites` ADD INDEX `idx_fav_game` (`game_slug`)');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
     WHERE table_schema = DATABASE() AND table_name = 'recents' AND index_name = 'idx_recent_game') > 0,
  'SELECT 1', 'ALTER TABLE `recents` ADD INDEX `idx_recent_game` (`game_slug`)');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 清理孤儿收藏 / 最近游玩（指向已被删除的游戏）

DELETE f FROM favorites f LEFT JOIN games g ON g.slug = f.game_slug WHERE g.slug IS NULL;

DELETE r FROM recents   r LEFT JOIN games g ON g.slug = r.game_slug WHERE g.slug IS NULL;

-- ---------- 2. 数据 ----------
-- 空表版本不插入任何游戏 / 文章。要灌内置目录有两条路：
--   A) 执行 8bitgo-setup.sql（同目录，带全部内置数据）
--   B) 后台「数据 → 导入内置数据到数据库」，或 `cd server && npm run seed`

-- ---------- 3. 管理员账号 ----------
-- 管理员不在此脚本创建（需要密码哈希）。两种方式二选一：
--   A) 在网站上正常注册一个账号，然后在 DBGate 执行（把邮箱换成你的）：
--      UPDATE users SET role='admin' WHERE email='you@example.com';
--   B) 在服务器上：server/.env 填 ADMIN_EMAIL / ADMIN_PASSWORD，然后 `npm run seed`。

-- 完成。可执行以下语句自检：
SELECT 'games' AS t, COUNT(*) AS n FROM games
UNION ALL SELECT 'posts', COUNT(*) FROM posts
UNION ALL SELECT 'users', COUNT(*) FROM users;
