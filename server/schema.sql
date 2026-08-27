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
  role          ENUM('user','admin') NOT NULL DEFAULT 'user',
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

-- ---------- 云存档 ----------
-- 存档跟着账号走（必须登录）。没登录的用户不进这张表 —— 他们的存档在浏览器里或者是下载的文件。
-- runtime 区分引擎：emulatorjs 是内存快照，jsdos 是 DOS 文件系统的变更包，两者不能互换。
-- game_slug 允许 `local:文件名` 这种形式（玩家自己上传的 ROM 没有 slug），所以不做外键。
CREATE TABLE IF NOT EXISTS saves (
  user_id    VARCHAR(40)      NOT NULL,
  runtime    VARCHAR(24)      NOT NULL,
  game_slug  VARCHAR(160)     NOT NULL,
  -- 存档位。0 是主存档，DOS 只用 0；快照式引擎以后可以做多格
  slot       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  size       INT UNSIGNED     NOT NULL,
  -- MEDIUMBLOB 上限 16MB，接口层再卡到 SAVE_MAX_BYTES（默认 4MB）
  data       MEDIUMBLOB       NOT NULL,
  created_at TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, runtime, game_slug, slot),
  INDEX idx_saves_user_time (user_id, updated_at),
  CONSTRAINT fk_saves_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 注意：上面都是 CREATE TABLE IF NOT EXISTS，对**已经建好**的表不会补新增的列和索引。
-- 给已有库打补丁的逻辑放在 scripts/migrate.mjs 里（用 JS 逐条判断后执行，
-- 出问题时能看清卡在哪一步），跑 `npm run migrate` 会自动执行。
