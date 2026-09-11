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
  -- 基准简介。后台写什么语言就是什么语言（本站是中文），其余语言拿不到译文时也用它兜底
  description   TEXT          NULL,
  -- 英文简介。非中文访客优先看这个，和 title / title_zh 是同一套路数：
  -- 一个基准 + 一个译文，而不是给八种语言各开一列
  description_en TEXT         NULL,
  -- 按需缓存的其余六种语言的译文（zh-Hans 走 description，en 走 description_en）。
  -- 形状：{"zh-Hant":"…","es":"…","fr":"…","it":"…","de":"…","ja":"…"}。
  description_i18n JSON         NULL,
  body_control  TINYINT(1)    NOT NULL DEFAULT 0,
  adult         TINYINT(1)    NOT NULL DEFAULT 0,
  -- 评分聚合（见 game_ratings）。冗余在这里是为了让游戏库能直接按评分排序、
  -- 卡片能直接显示星级，不必每次 join 一张会越来越大的明细表。
  -- rating_sum = SUM(score*weight)，rating_weight = SUM(weight)，平均分 = 前者/后者。
  -- rating_count 是**人数**，只用于展示（「128 人评分」），不参与算平均。
  rating_sum    DECIMAL(12,1)   NOT NULL DEFAULT 0,
  rating_weight DECIMAL(12,1)   NOT NULL DEFAULT 0,
  rating_count  INT UNSIGNED    NOT NULL DEFAULT 0,
  hidden        TINYINT(1)    NOT NULL DEFAULT 0,
  -- 模拟器核心覆盖。NULL = 用平台默认（src/data/platforms.ts 的 core 字段）。
  -- 街机尤其需要：同一个「街机」平台底下，拳皇要 fbneo、街霸2 要 fbalpha2012_cps2、
  -- 有些老游戏只有 mame2003_plus 跑得动，一个平台默认值盖不住。
  core          VARCHAR(32)   NULL,
  -- DOS 启动程序（zip 内相对路径）；Windows 客体模式用它生成自动启动脚本。
  dos_executable VARCHAR(255) NULL,
  -- NULL = 普通 DOSBox；dosboxX = DOS 或 Windows 3.x / 9x 客体走 DOSBox-X。
  dos_backend   VARCHAR(16)   NULL,
  -- 可复用的 Windows 客体系统 .jsdos。游戏 ROM 仍单独存，避免每款游戏重复一份系统盘。
  dos_system    VARCHAR(500)  NULL,
  dos_extras     TEXT             NULL,  -- 附加文件：一行一个对象 key，加载时并进游戏目录
  dos_extras_label VARCHAR(60)  NULL,  -- 可选附加文件在开始界面上的名字（「隐秘行动」）
  -- 3x 走 Program Manager 的 File > Run；9x 走开始菜单的 Run；NULL 按 9x 兼容。
  dos_windows_version VARCHAR(8) NULL,
  -- 客体系统切入图形模式后等待多少秒再自动运行 dos_executable。
  dos_launch_delay SMALLINT UNSIGNED NULL,
  -- 只保存硬件 / 性能覆盖；启动命令与动态游戏盘由站点统一生成。
  dosbox_config_override TEXT NULL,
  -- 这款 DOS 游戏怎么存档；播放器「保存进度」的说明面板会显示它。
  dos_save_hint VARCHAR(160) NULL,
  -- 街机改版包的 FBNeo RomData（.dat 文本）。
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

-- ---------- 开发商资料 ----------
-- 开发商本身不是独立实体：名单是从 games.developer 那一列 GROUP BY 出来的
-- （一款游戏可以写多家，用逗号分隔）。这张表只存**人工补充**的那部分资料，
-- 一行都没有也不影响开发商列表页 —— 那时每家仍旧显示代表作封面。
--
-- 主键就用开发商名字本身，跟 games.developer 里写的完全一致（大小写与排序
-- 走 utf8mb4_unicode_ci，和那一列同一套规则，JOIN 才对得上）。不另发 id 的原因：
-- games 那边存的就是名字，多一层 id 就要多一张映射表和一套改名同步逻辑。
-- 代价是改名等于换主键，所以后台的改名做成「新建一行 + 删旧行」。
CREATE TABLE IF NOT EXISTS developers (
  name            VARCHAR(120)  NOT NULL,
  -- 对象存储 key 或完整 URL，语义和 games.cover 一致（见 romUrlForKey）
  logo            VARCHAR(500)  NOT NULL DEFAULT '',
  description     TEXT          NULL,
  -- 留空时所有非中文语种回退到上面那段中文，和 games.description_en 同一套规则
  description_en  TEXT          NULL,
  homepage        VARCHAR(300)  NOT NULL DEFAULT '',
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 首页特别鸣谢 / 友情链接 ----------
-- 图片友链以经典 88×31 为基准；image 为空就是文字友链。
CREATE TABLE IF NOT EXISTS friend_links (
  id          BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(80)       NOT NULL,
  url         VARCHAR(500)      NOT NULL,
  image       VARCHAR(500)      NOT NULL DEFAULT '',
  sort_order  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  enabled     TINYINT(1)        NOT NULL DEFAULT 1,
  created_at  TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_friend_links_public (enabled, sort_order, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 友情链接埋点（双向：我们带出去 / 对方带进来） ----------
-- 记的是「人」不是「次」：主键带 day + identity，每人每天每条链接每个方向只记一次。
-- 身份是 HMAC 摘要，不存明文 IP（同 game_plays，见 src/playcount.js）。
CREATE TABLE IF NOT EXISTS friend_link_hits (
  link_id   BIGINT UNSIGNED NOT NULL,
  -- 'o' = 出站（首页鸣谢位被点），'i' = 入站（从对方站点过来）
  direction CHAR(1)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  day       DATE     NOT NULL,
  -- HMAC-SHA256 的 base64url，固定 43 个字符
  identity  CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  hit_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (link_id, direction, day, identity),
  -- 按天清理旧数据用；不建的话 DELETE ... WHERE day < ? 会全表扫
  KEY idx_flh_day (day),
  CONSTRAINT fk_flh_link FOREIGN KEY (link_id) REFERENCES friend_links(id) ON DELETE CASCADE
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
  excerpt_i18n JSON         NULL,
  content     MEDIUMTEXT    NOT NULL,
  content_i18n JSON         NULL,
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
  role          ENUM('user','volunteer','admin')    NOT NULL DEFAULT 'user',
  status        ENUM('active','banned') NOT NULL DEFAULT 'active',
  -- 出生日期（成人内容年龄验证）。填一次就锁定：应用层只在 birth_date IS NULL 时写入，
  -- 填错由管理员在后台清掉再重填。满不满 18 不另存布尔列 —— 每次按今天现算，
  -- 到生日当天自动放行，不需要定时任务。
  birth_date    DATE          NULL DEFAULT NULL,
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

-- ---------- 游戏评论 ----------
-- 设计与注释见 schema-v2.sql 里的同名表（三种「不可见」、country 快照、parent_id 的 SET NULL）。
CREATE TABLE IF NOT EXISTS game_comments (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 游戏评分：1~5 星。登录用户权重 1.0，未登录 0.5
--
-- 为什么权重不是「登录才算数」：绝大多数访客不会为了打个分去注册，全挡掉等于
-- 这个功能对大部分人不存在；但匿名票天然更容易被刷，也更不负责任，所以打对折。
-- 加权平均 = SUM(score * weight) / SUM(weight)，聚合值冗余在 games 表上（见那三列）。
--
-- 身份与去重（这是这张表最需要小心的地方）：
--   登录用户  user_id 有值、anon_id 与 anon_ip 都是 NULL，靠 uniq_rating_user 保证一人一票
--   匿名用户  user_id 为 NULL，anon_id 是浏览器本地生成的长期标识，anon_ip 是发起时的 IP
--
-- ⚠️ IP 的唯一约束**只能约束匿名行**，所以登录行的 anon_ip 必须写 NULL 而不是空串：
--    MySQL 的唯一索引允许多个 NULL，于是同一个 NAT 后面的多个登录用户互不影响；
--    要是把登录用户的 IP 也存进去，学校/公司里第二个人就再也评不了分。
--
-- ⚠️ anon_id 是客户端自己生成的，换个无痕窗口就能变 —— 它的作用**不是防刷**
--    （防刷靠 anon_ip 那条唯一约束），而是让同一个浏览器能**改自己的分**，
--    以及换了网络（手机切基站）之后还认得出是同一个人。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS game_ratings (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  game_id    BIGINT UNSIGNED NOT NULL,
  -- 登录用户的 id；匿名评分为 NULL
  user_id    VARCHAR(40)     NULL,
  -- 匿名身份：浏览器本地生成并长期保存的随机串。登录评分为 NULL
  anon_id    CHAR(32)        NULL,
  -- 匿名评分发起时的 IP。**登录评分必须为 NULL**，见上面的说明
  anon_ip    VARCHAR(45)     NULL,
  score      TINYINT UNSIGNED NOT NULL,
  -- 1.0 = 登录，0.5 = 匿名。存下来而不是每次按 user_id 现推：
  -- 以后要调权重时，历史票据该按当时的规则还是新规则算是个产品决定，留出选择余地
  weight     DECIMAL(2,1)    NOT NULL,
  -- 发表时的国家快照，和评论同源（CF-IPCountry）。用于事后分析刷分，不对外展示
  country    CHAR(2)         NOT NULL DEFAULT 'XX',
  created_at TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  -- 一个登录用户对一款游戏只有一票（改分是 UPDATE 这一行）
  UNIQUE KEY uniq_rating_user (game_id, user_id),
  -- 同一浏览器同理。登录行 anon_id 是 NULL，不受这条约束
  UNIQUE KEY uniq_rating_anon (game_id, anon_id),
  -- 同一 IP 的匿名票只算一张。登录行 anon_ip 是 NULL，不受影响
  UNIQUE KEY uniq_rating_ip (game_id, anon_ip),
  KEY idx_rating_game_time (game_id, created_at DESC),
  KEY idx_rating_user_time (user_id, created_at DESC),
  CONSTRAINT fk_rating_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  CONSTRAINT fk_rating_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_rating_score CHECK (score BETWEEN 1 AND 5)
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
-- 自检：应该是 12 张表，全部 0 行
SELECT table_name FROM information_schema.TABLES
  WHERE table_schema = DATABASE() ORDER BY table_name;

SELECT 'games' t, COUNT(*) n FROM games
UNION ALL SELECT 'posts', COUNT(*) FROM posts
UNION ALL SELECT 'users', COUNT(*) FROM users;

-- 管理员账号这里建不了（需要 bcrypt 哈希）。先在网站上正常注册，然后：
--   UPDATE users SET role='admin' WHERE email='你的邮箱';
-- ============================================================
