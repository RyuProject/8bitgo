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
--   PlatformId / GenreId 还是 TypeScript 的联合类型。14 个平台、12 个类型是固定集合，
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
  -- 基准简介。后台写什么语言就是什么语言（本站是中文），其余语言拿不到译文时也用它兜底
  description   TEXT          NULL,
  -- 英文简介。非中文访客优先看这个，和 title / title_zh 是同一套路数：
  -- 一个基准 + 一个译文，而不是给八种语言各开一列
  description_en TEXT         NULL,
  body_control  TINYINT(1)    NOT NULL DEFAULT 0,
  -- 成人内容标记。前台据此在挂载模拟器之前要求输入出生日期并验证年满 18 岁。
  adult         TINYINT(1)    NOT NULL DEFAULT 0,
  hidden        TINYINT(1)    NOT NULL DEFAULT 0,
  -- 模拟器核心覆盖。NULL = 用平台默认（src/data/platforms.ts 的 core 字段）。
  -- 街机尤其需要：同一个「街机」平台底下，拳皇要 fbneo、街霸2 要 fbalpha2012_cps2、
  -- 有些老游戏只有 mame2003_plus 跑得动，一个平台默认值盖不住。
  core          VARCHAR(32)   NULL,
  -- DOS 启动程序（zip 内相对路径，如 NFS/TNFS.EXE）。
  -- NULL = 交给前端启发式去猜（src/lib/jsdosBundle.ts 的 pickExecutable）
  dos_executable VARCHAR(255)  NULL,
  -- Windows 3.x / 9x 的完整 .jsdos 磁盘镜像需要 DOSBox-X；NULL = 普通 DOSBox。
  dos_backend    VARCHAR(16)   NULL,
  -- 可复用的 Windows 客体系统 .jsdos。游戏 ROM 仍是独立 ZIP，运行时作为另一块 FAT 盘挂入。
  -- NULL 保留旧模式：ROM 自己就是已经装好系统与游戏的完整 .jsdos。
  dos_system     VARCHAR(500)  NULL,
  -- 3x = Program Manager 的 File > Run；9x = 开始菜单的 Run；NULL 兼容旧数据并按 9x 处理。
  dos_windows_version VARCHAR(8) NULL,
  -- 客体系统切入图形模式后等待多少秒再自动运行 dos_executable；不同系统镜像速度不同，不能写死。
  dos_launch_delay SMALLINT UNSIGNED NULL,
  -- 只保存允许的硬件 / 性能 INI 覆盖；[autoexec] 与挂载参数由应用层拒绝。
  dosbox_config_override TEXT NULL,
  -- 这款 DOS 游戏怎么存档（如「按 F2 存档、F3 读档」）。
  -- js-dos 存的是盘上被改过的文件，玩家得先在游戏里存盘；各家存档键不同，只能逐游戏填。
  dos_save_hint  VARCHAR(160)  NULL,
  -- 街机改版包（汉化、修改版）的 FBNeo RomData：写明包名、借用的驱动和整份 ROM 清单，
  -- 让不在驱动表里的 romset 也能跑。见 src/emulator/adapters/emulatorjs.ts。
  arcade_romdata TEXT NULL,
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

-- ---------- 搜索倒排索引 ----------
-- token -> 游戏，带来源权重。由 server/src/search.js 生成，后台增删改游戏时同步维护，
-- 全量重建用 `npm run backfill-search`。
--
-- 为什么不用 FULLTEXT：中文得靠 ngram 解析器，那是 MySQL 5.7+ 独有的（MariaDB 没有），
-- 用了就把部署绑死在特定数据库上；而且拼音、首字母、繁简互通塞不进 FULLTEXT。
-- 主键放 (token, game_id)，查询按 token 前缀走主键，几万款游戏也是毫秒级。
CREATE TABLE IF NOT EXISTS game_search_tokens (
  token    VARCHAR(32)     NOT NULL,
  game_id  BIGINT UNSIGNED NOT NULL,
  -- 来源权重：原名/译名 100、别名 80、拼音 60、开发商 40、标签 30
  weight   SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (token, game_id),
  KEY idx_game (game_id),
  CONSTRAINT fk_gst_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
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

-- ---------- 游玩去重名单 ----------
-- games.plays 这个数字的来源。一个身份对一款游戏只有一行，主键就是去重规则本身：
-- 重复上报会撞唯一键，直接被数据库挡掉，不需要应用层「先查再写」（那中间有并发窗口）。
--
--   kind = 'u'  identity = HMAC(账号 id)    已登录：换设备换 IP 都算同一个人
--   kind = 'i'  identity = HMAC(客户端 IP)  未登录
--
-- identity 存的是摘要不是明文 —— 库被拖走也反查不回具体 IP（密钥在 .env 里）。
-- ⚠️ 必须是 ascii_bin：base64url 区分大小写，用默认的 utf8mb4_unicode_ci 的话
--    'aB…' 和 'Ab…' 会被当成同一个人，不同的人互相顶掉。
CREATE TABLE IF NOT EXISTS game_plays (
  game_id   BIGINT UNSIGNED NOT NULL,
  -- 'u' = 账号，'i' = IP
  kind      CHAR(1)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- HMAC-SHA256 的 base64url，固定 43 个字符
  identity  CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  played_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_id, kind, identity),
  CONSTRAINT fk_gp_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
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
  -- 令牌版本。JWT 是无状态的，签出去就收不回来 —— 「退出所有设备」和「改完密码踢掉旧会话」
  -- 都靠把这个数 +1 实现：带旧版本号的令牌在 requireUser 里当场作废。
  -- 详见 src/auth.js 的 signToken 注释。
  token_version INT UNSIGNED  NOT NULL DEFAULT 0,
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

-- ---------- 云存档 ----------
-- ⚠️ 这张表以前只写在 schema.sql（v1 那份）里，v2 漏了 —— 于是任何按 v2 建的新库都没有它，
-- 症状是站点一切正常，只有玩家点「云端存档」的那一刻 /api/saves 全部 500，
-- 而后台和前台都看不出任何异常。补在这里，老库靠 scripts/migrate.mjs 的同名补丁补上。
--
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

-- ---------- 邮箱验证码 ----------
-- 登录 / 换绑邮箱 / 注销账号共用这张表，purpose 区分用途，逻辑全在 src/codes.js。
--
-- 为什么不放内存：pm2 重启会把所有待验证的码清空，用户刚收到信、回来填却被告知「已过期」；
-- 多实例部署时发码的实例和验码的实例不是同一个，登录会随机失败一半。
--
-- 为什么存哈希不存明文：一次 mysqldump 泄露就等于把所有人（含管理员）的账号送出去。
-- 哈希拌了 email + purpose，单看哈希值没法拿去别的邮箱或用途上重放。
--
-- 时间用 epoch 毫秒的 BIGINT，不用 TIMESTAMP：应用层判过期、数据库判清理，
-- 两边各用各的时钟 / 时区是很容易踩的坑，统一交给应用时钟最省心。
CREATE TABLE IF NOT EXISTS login_codes (
  email      VARCHAR(200)     NOT NULL,
  purpose    VARCHAR(16)      NOT NULL,
  -- 换绑 / 注销时绑到具体用户：不绑的话，A 拿自己那封「换绑到 x@y」的码
  -- 就能去把 B 的账号也换绑成 x@y。登录用途下为 NULL（那会儿还没有用户）。
  -- 不设外键：登录码没有用户可指，而删用户时也不该因为这张表而失败。
  user_id    VARCHAR(40)      NULL,
  code_hash  CHAR(64)         NOT NULL,
  -- 错误次数。6 位数字共 100 万种，不限次数等于可以直接爆破进任意账号
  tries      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at BIGINT UNSIGNED  NOT NULL,
  sent_at    BIGINT UNSIGNED  NOT NULL,
  PRIMARY KEY (email, purpose),
  KEY idx_codes_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
