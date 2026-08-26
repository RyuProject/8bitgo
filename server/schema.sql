-- 8BitGo 数据库表结构
-- 用法：mysql -u root -p < schema.sql   （或用 npm run migrate 自动执行）
-- 字符集用 utf8mb4，支持中文与 emoji。

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
  CONSTRAINT fk_fav_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 最近游玩 ----------
CREATE TABLE IF NOT EXISTS recents (
  user_id   VARCHAR(40)  NOT NULL,
  game_slug VARCHAR(120) NOT NULL,
  played_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, game_slug),
  INDEX idx_recent_user_time (user_id, played_at),
  CONSTRAINT fk_recent_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
