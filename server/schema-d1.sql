-- ============================================================
-- 8BitGo 数据库结构 · Cloudflare D1（SQLite）版
--
-- 由 schema-v2.sql 一比一转换而来，表、列、索引、外键全部对应得上。
-- 这里只记录**两边不一样的地方**和为什么这么转，逐列的业务说明看 schema-v2.sql。
--
-- 用法：
--   wrangler d1 create 8bitgo
--   wrangler d1 execute 8bitgo --local  --file=server/schema-d1.sql   # 本地先试
--   wrangler d1 execute 8bitgo --remote --file=server/schema-d1.sql   # 线上
--
-- 转换总表：
--   BIGINT UNSIGNED AUTO_INCREMENT  -> INTEGER PRIMARY KEY AUTOINCREMENT
--       SQLite 的 INTEGER PRIMARY KEY 就是 rowid 别名。加 AUTOINCREMENT 是为了
--       **不复用已删除的 id** —— favorites / recents 里存着 game_id，复用会让
--       老收藏莫名其妙指到新游戏上。
--   VARCHAR(n) / TEXT / MEDIUMTEXT  -> TEXT      （SQLite 不限长，长度约束交给应用层）
--   TINYINT(1)                      -> INTEGER   （0 / 1，读出来记得自己转 boolean）
--   INT/SMALLINT UNSIGNED           -> INTEGER   （SQLite 没有无符号，负值靠应用层保证）
--   DATE                            -> TEXT      （'YYYY-MM-DD'，和 MySQL 存的字面量一致）
--   TIMESTAMP                       -> TEXT      （'YYYY-MM-DD HH:MM:SS'，UTC，两边同格式）
--   TIMESTAMP(3)                    -> TEXT      （毫秒，strftime('%f') 带三位小数）
--   ENUM('a','b')                   -> TEXT + CHECK
--   ON UPDATE CURRENT_TIMESTAMP     -> AFTER UPDATE 触发器（见文件末尾）
--   KEY idx (a, b DESC)             -> CREATE INDEX（SQLite 支持索引里的 DESC）
--   KEY idx (col(191))              -> 整列索引（SQLite 没有前缀索引，也不需要）
--
-- 三个**行为**差异，比语法差异更值得注意：
--
--   1. 排序规则。MySQL 这套表是 utf8mb4_unicode_ci，比较**不区分大小写**；
--      SQLite 默认 BINARY，区分。凡是靠「大小写不敏感」才成立的唯一性和查找，
--      这里显式加 COLLATE NOCASE —— 目前只有 email 一处（注册时 Alice@x.com 和
--      alice@x.com 必须算同一个人）。slug 由 slugify() 生成、搜索 token 由
--      search.js 的 normalize() 统一小写，本来就不依赖排序规则。
--      ⚠️ NOCASE 只折叠 ASCII A-Z，中文不受影响 —— 对邮箱够用。
--
--   2. 外键在 D1 默认就是**强制**的，而且导数据时没法像 MySQL 那样
--      SET FOREIGN_KEY_CHECKS=0。所以导入必须按依赖顺序：
--      games / posts / users 在前，关联表在后（scripts/export-d1.mjs 已经排好）。
--
--   3. 没有 UNSIGNED，也没有 max_allowed_packet，但有一条 MySQL 没有的限制：
--      **一条语句最多 100 个绑定参数**。games-repo.js 里 token 批量插入的
--      CHUNK = 200（200×3 = 600 个占位符）在 D1 上会被拒，要改成 33。
-- ============================================================

-- ---------- 游戏 ----------
CREATE TABLE IF NOT EXISTS games (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  title_zh       TEXT,
  platform       TEXT    NOT NULL,
  "year"         INTEGER NOT NULL DEFAULT 0,
  developer      TEXT    NOT NULL DEFAULT '',
  plays          INTEGER NOT NULL DEFAULT 0,
  players        INTEGER NOT NULL DEFAULT 1,
  multiplayer    INTEGER NOT NULL DEFAULT 0,
  coin_reward    INTEGER NOT NULL DEFAULT 0,
  icon           TEXT    NOT NULL DEFAULT '🎮',
  cover          TEXT,
  video          TEXT,
  description    TEXT,
  description_en TEXT,
  body_control   INTEGER NOT NULL DEFAULT 0,
  adult          INTEGER NOT NULL DEFAULT 0,
  hidden         INTEGER NOT NULL DEFAULT 0,
  core           TEXT,
  dos_executable TEXT,
  dos_backend    TEXT,
  dos_system     TEXT,
  -- 3x = Program Manager，9x = Explorer 开始菜单；NULL 按 9x 兼容。
  dos_windows_version TEXT,
  dos_launch_delay INTEGER,
  -- 逐游戏 DOSBox-X 安全配置覆盖，不允许包含 [autoexec]。
  dosbox_config_override TEXT,
  -- 这款 DOS 游戏怎么存档；播放器「保存进度」的说明面板会显示它。
  dos_save_hint  TEXT,
  -- 街机改版包的 FBNeo RomData（.dat 文本）。
  arcade_romdata TEXT,
  home_rank      INTEGER,
  added_at       TEXT,
  created_at     TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at     TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_slug        ON games (slug);
-- hidden 放第一列的理由不变：前台每一条查询都带 hidden = 0
CREATE INDEX IF NOT EXISTS idx_pub_plays           ON games (hidden, plays DESC);
CREATE INDEX IF NOT EXISTS idx_pub_added           ON games (hidden, added_at DESC);
CREATE INDEX IF NOT EXISTS idx_pub_title           ON games (hidden, title);
CREATE INDEX IF NOT EXISTS idx_platform            ON games (hidden, platform, plays DESC);
CREATE INDEX IF NOT EXISTS idx_developer           ON games (hidden, developer);
CREATE INDEX IF NOT EXISTS idx_multiplayer         ON games (hidden, multiplayer, plays DESC);
CREATE INDEX IF NOT EXISTS idx_coin                ON games (hidden, coin_reward);
-- 首页精选位只有寥寥几行 home_rank 非空。SQLite 这里可以比 MySQL 更省：
-- 部分索引只收非空行，索引体积几乎为零
CREATE INDEX IF NOT EXISTS idx_home_rank           ON games (hidden, home_rank) WHERE home_rank IS NOT NULL;

-- ---------- 博客文章 ----------
CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  excerpt    TEXT,
  content    TEXT    NOT NULL,
  icon       TEXT    NOT NULL DEFAULT '📝',
  author     TEXT    NOT NULL DEFAULT '',
  "date"     TEXT,
  published  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_post_slug ON posts (slug);
CREATE INDEX IF NOT EXISTS idx_pub_date          ON posts (published, "date" DESC);

-- ---------- 用户 ----------
CREATE TABLE IF NOT EXISTS users (
  id            TEXT    PRIMARY KEY,
  -- COLLATE NOCASE：见文件头「行为差异 1」
  email         TEXT    NOT NULL COLLATE NOCASE,
  nickname      TEXT    NOT NULL,
  avatar        TEXT    NOT NULL DEFAULT '🕹️',
  password_hash TEXT    NOT NULL,
  coins         INTEGER NOT NULL DEFAULT 0,
  role          TEXT    NOT NULL DEFAULT 'user'   CHECK (role   IN ('user','admin')),
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned')),
  created_at    TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_role          ON users (role, status);

-- ---------- 平台级 BIOS ----------
CREATE TABLE IF NOT EXISTS platform_bios (
  platform   TEXT PRIMARY KEY,
  object_key TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- ---------- 游戏 × 类型 ----------
CREATE TABLE IF NOT EXISTS game_genres (
  game_id  INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  genre_id TEXT    NOT NULL,
  PRIMARY KEY (game_id, genre_id)
);
CREATE INDEX IF NOT EXISTS idx_genre ON game_genres (genre_id, game_id);

-- ---------- 游戏 × 标签 ----------
CREATE TABLE IF NOT EXISTS game_tags (
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  tag     TEXT    NOT NULL,
  PRIMARY KEY (game_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tag ON game_tags (tag, game_id);

-- ---------- 搜索倒排索引 ----------
-- 查询走 token 前缀（token >= 'x' AND token < 'y'），主键就是覆盖索引，
-- 和 MySQL 那边一样是毫秒级。token 由 normalize() 统一小写，不需要 NOCASE。
CREATE TABLE IF NOT EXISTS game_search_tokens (
  token   TEXT    NOT NULL,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  weight  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (token, game_id)
);
CREATE INDEX IF NOT EXISTS idx_game ON game_search_tokens (game_id);

-- ---------- 游戏 × ROM 文件 ----------
CREATE TABLE IF NOT EXISTS game_roms (
  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  lang       TEXT    NOT NULL DEFAULT '*',
  object_key TEXT    NOT NULL,
  PRIMARY KEY (game_id, lang)
);
-- MySQL 那边是 object_key(191) 前缀索引（因为 utf8mb4 下 500 字符超了索引长度上限），
-- SQLite 没这个限制，整列建
CREATE INDEX IF NOT EXISTS idx_object_key ON game_roms (object_key);

-- ---------- 文章 × 标签 ----------
-- ---------- 游玩去重名单 ----------
-- 见 schema-v2.sql 里的说明。SQLite 的 TEXT 默认就是 BINARY 排序规则，
-- 区分大小写，正好是 base64url 需要的，不用像 MySQL 那样特意指定 ascii_bin。
CREATE TABLE IF NOT EXISTS game_plays (
  game_id   INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  kind      TEXT    NOT NULL,   -- 'u' = 账号，'i' = IP
  identity  TEXT    NOT NULL,   -- HMAC-SHA256 的 base64url
  played_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (game_id, kind, identity)
);

CREATE TABLE IF NOT EXISTS post_tags (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag     TEXT    NOT NULL,
  PRIMARY KEY (post_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_post_tag ON post_tags (tag, post_id);

-- ---------- 云存档 ----------
-- ⚠️ 这张表在 schema-v2.sql 里没有，是 v1（schema.sql）建的，升级脚本没动它，
--    而 routes/saves.js 一直在用 —— 迁移时很容易整张漏掉。
--
-- ⚠️⚠️ D1 的硬限制：单行 / 单个 BLOB 最大 2 MB，而接口层现在允许 4 MB
--       （SAVE_MAX_BYTES 默认 4*1024*1024）。原样搬过来，超过 2MB 的存档会写不进去。
--       两条路，二选一：
--         a) 把 SAVE_MAX_BYTES 降到 2MB 以下（jsdos 的变更包偶尔会超）
--         b) 更好：存档本体丢进 R2（按对象存、按量计费、没有 2MB 这道坎），
--            这张表只留 user_id / runtime / game_slug / slot / size / object_key。
--       D1 免费版单库 500MB，200 个存档/人的上限下，几十个活跃用户就能把库填满 ——
--       所以 b) 不只是绕开限制，本来也是更合适的存法。
--
-- game_slug 允许 'local:文件名'（玩家自己传的 ROM 没有 slug），所以不做外键。
CREATE TABLE IF NOT EXISTS saves (
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  runtime    TEXT    NOT NULL,
  game_slug  TEXT    NOT NULL,
  slot       INTEGER NOT NULL DEFAULT 0,
  size       INTEGER NOT NULL,
  data       BLOB    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  PRIMARY KEY (user_id, runtime, game_slug, slot)
);
CREATE INDEX IF NOT EXISTS idx_saves_user_time ON saves (user_id, updated_at);

-- ---------- 稍后玩 ----------
CREATE TABLE IF NOT EXISTS favorites (
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  -- 毫秒精度：秒级会让同一秒内连点几款游戏的时间戳完全相同，「最新在前」变随机
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  PRIMARY KEY (user_id, game_id)
);
CREATE INDEX IF NOT EXISTS idx_fav_user_time ON favorites (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fav_game      ON favorites (game_id);

-- ---------- 最近游玩 ----------
CREATE TABLE IF NOT EXISTS recents (
  user_id   TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id   INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  played_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  PRIMARY KEY (user_id, game_id)
);
CREATE INDEX IF NOT EXISTS idx_recent_user_time ON recents (user_id, played_at DESC);
CREATE INDEX IF NOT EXISTS idx_recent_game      ON recents (game_id);

-- ============================================================
-- ON UPDATE CURRENT_TIMESTAMP 的替代品
--
-- MySQL 这个列属性在 SQLite 里没有对应，只能用触发器。
-- 每个触发器都带 WHEN 守卫：只有当这次 UPDATE **没有显式改**这个时间戳列时才自动写，
-- 这样两件事都成立 ——
--   1. 导数据时带着原始 updated_at 写进来，不会被改成导入时间
--   2. 触发器自己那条 UPDATE 不会再次触发自己（SQLite 默认不递归，这里是双保险）
-- ============================================================

CREATE TRIGGER IF NOT EXISTS trg_games_updated_at
AFTER UPDATE ON games FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE games SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_posts_updated_at
AFTER UPDATE ON posts FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE posts SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_platform_bios_updated_at
AFTER UPDATE ON platform_bios FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE platform_bios SET updated_at = CURRENT_TIMESTAMP WHERE platform = NEW.platform;
END;

CREATE TRIGGER IF NOT EXISTS trg_saves_updated_at
AFTER UPDATE ON saves FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE saves SET updated_at = CURRENT_TIMESTAMP
   WHERE user_id = NEW.user_id AND runtime = NEW.runtime
     AND game_slug = NEW.game_slug AND slot = NEW.slot;
END;

-- recents.played_at 在 MySQL 那边是 ON UPDATE CURRENT_TIMESTAMP(3)：
-- 同一个用户再玩一次同一款游戏时，靠 upsert 把时间刷新
CREATE TRIGGER IF NOT EXISTS trg_recents_played_at
AFTER UPDATE ON recents FOR EACH ROW
WHEN NEW.played_at = OLD.played_at
BEGIN
  UPDATE recents SET played_at = strftime('%Y-%m-%d %H:%M:%f','now')
   WHERE user_id = NEW.user_id AND game_id = NEW.game_id;
END;

-- ============================================================
-- 建完自检：
--   SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;
--   -> 应该是 12 张：favorites game_genres game_roms game_search_tokens game_tags
--                    games platform_bios post_tags posts recents saves users
--
-- 管理员账号同样建不了（要 bcrypt / PBKDF2 哈希）：先在网站上注册，然后
--   UPDATE users SET role='admin' WHERE email='你的邮箱';
-- ============================================================
