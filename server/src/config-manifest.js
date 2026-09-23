/**
 * 环境变量清单 —— 后台「当前生效配置」那一页的数据源。
 *
 * ## 它解决的是哪个问题
 *
 * 不是「我想在网页上改限流」，而是**「我到底配了什么、生效了没有」**。
 * 这套东西的配置项有 130 多个，散在 server/.env 里，而线上和本机那两份又有差异 ——
 * 于是每次出问题都要 ssh 上去 cat 一遍，再回源码里确认默认值是多少。
 * 2026-09-13 就踩了一次：`SUBMIT_GAME_TO_EMAIL` 从来没配过，玩家投稿全发去了
 * noreply@ 那个发件专用地址，没人收；服务端启动时其实**一直在打这条警告**，
 * 只是没人会去翻 systemd 的日志。
 *
 * ## ⚠️ 这一页是**只读**的，而且应该一直只读
 *
 * 想把这些值搬进数据库、让后台能改 —— 别。理由：
 *
 *   1. **双份真相**。值一旦进了库，`.env` 里那行就变成了谎话。
 *      有人改 .env、重启、没反应，查半天 —— 这是这个仓库注释里反复出现的那类 bug。
 *   2. **密钥不能进**。后台自己是靠 ADMIN_TOKEN / JWT_SECRET 鉴权的，
 *      把它们放进「要过鉴权才能改」的地方是循环依赖；而且库被拖走 = 所有密钥一起走。
 *   3. `ADMIN_AUTH_DISABLED` 尤其不能进：让后台有能力关掉自己的鉴权，是最坏的一种设计。
 *
 * 真要热调某几个数值型限额时，正确做法是加一张 site_settings 表做**单向覆盖**
 * （env 提供默认、库只做覆盖），而不是把这一页改成可写。
 *
 * ## 清单和代码的一致性
 *
 * `file` 是这个变量**实际被读取**的地方，由 scripts/test-config-report.mjs 里的
 * 扫描器核对 —— 多一个、少一个、挪了文件，测试都会红。
 *
 * ⚠️ 扫描器认四种读法，加新变量时别用别的写法：
 *   · `env.X` / `process.env.X`
 *   · `process.env['X']`
 *   · 函数名里带 env 的辅助函数，第一个参数是字面量：`trimEnv('X')`、`envMb('X', 20)`
 * 手写正则只认第一种的话会漏 —— 本来就漏过 APPLE_PRIVATE_KEY_PATH /
 * SUBMIT_ROM_MAX_FILE_MB / SUBMIT_ROM_MAX_TOTAL_MB 三个。
 */

/**
 * @typedef {object} EnvSpec
 * @property {string} name
 * @property {string} group  后台按这个分组显示
 * @property {'secret'|'config'} kind  secret 的值**永远不出服务端**，只给长度和指纹
 * @property {string} file   相对 server/src 的读取位置，防漂移测试盯着它
 * @property {string} [note] 给运维看的一句话
 */

/** @type {EnvSpec[]} */
export const ENV_MANIFEST = [
  { name: 'ADMIN_AUTH_DISABLED', group: '安全', kind: 'config', file: 'auth.js', note: '⚠️ 设成 1 时每个请求直接当 admin，整个后台裸奔' },
  { name: 'ADMIN_EMAIL', group: '安全', kind: 'config', file: '../scripts/seed.mjs', note: '只给 npm run seed 建第一个管理员用，建完就该清空' },
  { name: 'ADMIN_NICKNAME', group: '安全', kind: 'config', file: '../scripts/seed.mjs', note: '同上' },
  { name: 'ADMIN_PASSWORD', group: '安全', kind: 'secret', file: '../scripts/seed.mjs', note: '同上' },
  { name: 'ADMIN_TOKEN', group: '安全', kind: 'secret', file: 'auth.js', note: '后台万能钥匙，不对应任何账号' },
  { name: 'ADMIN_USERS_MAX', group: '安全', kind: 'config', file: 'routes/users.js', note: '后台用户列表一次最多取多少人，默认 2000；超过就截断并打日志' },
  { name: 'ALLOWED_ORIGINS', group: '服务与地址', kind: 'config', file: 'index.js', note: '⚠️ 留空 = 退回 *，任何网站都能拿这个后端当 API 用。本文件里唯一一个「删了更危险」的键' },
  { name: 'API_S_MAXAGE', group: '缓存', kind: 'config', file: 'cache.js' },
  { name: 'APPLE_KEY_ID', group: '第三方登录', kind: 'config', file: 'routes/auth.js' },
  { name: 'APPLE_PRIVATE_KEY', group: '第三方登录', kind: 'secret', file: 'routes/auth.js' },
  { name: 'APPLE_PRIVATE_KEY_PATH', group: '第三方登录', kind: 'config', file: 'routes/auth.js', note: 'APPLE_PRIVATE_KEY 的文件路径版本，二选一' },
  { name: 'APPLE_SERVICES_ID', group: '第三方登录', kind: 'config', file: 'routes/auth.js' },
  { name: 'APPLE_TEAM_ID', group: '第三方登录', kind: 'config', file: 'routes/auth.js' },
  { name: 'APPS_SUBMIT_TO_EMAIL', group: '发信', kind: 'config', file: 'routes/apps.js', note: '社区应用提交的收件人；留空时使用内置地址' },
  { name: 'BAIDU_PUSH_ENABLED', group: '搜索引擎推送', kind: 'config', file: 'baidu-push.js' },
  { name: 'BAIDU_PUSH_ENDPOINT', group: '搜索引擎推送', kind: 'config', file: 'baidu-push.js' },
  { name: 'BAIDU_PUSH_LANGUAGES', group: '搜索引擎推送', kind: 'config', file: 'baidu-push.js', note: '留空 = 只推简体中文' },
  { name: 'BAIDU_PUSH_SITE', group: '搜索引擎推送', kind: 'config', file: 'baidu-push.js', note: '必须和搜索资源平台验证过的写法一字不差，否则只回 not_same_site' },
  { name: 'BAIDU_PUSH_TOKEN', group: '搜索引擎推送', kind: 'secret', file: 'baidu-push.js', note: '这个接口只有 http、token 明文过网络，泄露了去控制台换' },
  { name: 'CF_ACCOUNT_ID', group: '发信', kind: 'config', file: 'mail.js' },
  { name: 'CF_API_BASE', group: '发信', kind: 'config', file: 'mail.js', note: '测试用来指向本地 mock，线上不该配' },
  { name: 'CF_EMAIL_TOKEN', group: '发信', kind: 'secret', file: 'mail.js' },
  { name: 'CODE_SEND_GLOBAL_PER_HOUR', group: '发信', kind: 'config', file: 'codes.js' },
  { name: 'CS15_DISABLED', group: '服务与地址', kind: 'config', file: 'index.js', note: '设成 1 让 /web/cs15 整页下线（实验性接入），不影响其它 /web/ 游戏' },
  { name: 'CODE_SEND_PER_IP_PER_HOUR', group: '发信', kind: 'config', file: 'codes.js' },
  { name: 'COVER_BASE_URL', group: '服务与地址', kind: 'config', file: 'site-urls.js', note: '封面 CDN 根地址；留空使用 image.8bitgo.com' },
  { name: 'DB_HOST', group: '数据库', kind: 'config', file: 'db.js' },
  { name: 'DB_NAME', group: '数据库', kind: 'config', file: 'db.js' },
  { name: 'DB_PASSWORD', group: '数据库', kind: 'secret', file: 'db.js', note: '弱口令会被同机进程秒猜；DB_HOST 是回环所以外网打不到，但那不是理由' },
  { name: 'DB_PORT', group: '数据库', kind: 'config', file: 'db.js' },
  { name: 'DB_USER', group: '数据库', kind: 'config', file: 'db.js' },
  { name: 'GOOGLE_CLIENT_ID', group: '第三方登录', kind: 'config', file: 'routes/auth.js', note: '公开值，和前端 VITE_GOOGLE_CLIENT_ID 必须同一个' },
  { name: 'GZIP_LEVEL', group: '缓存', kind: 'config', file: 'compress.js', note: '动态响应的 gzip 级别；越高越省带宽也越吃 CPU，默认 5' },
  { name: 'GZIP_MIN_BYTES', group: '缓存', kind: 'config', file: 'compress.js', note: '小于这个体积的动态响应不压缩，默认 1024' },
  { name: 'ICE_GLOBAL_PER_MIN', group: 'STUN / TURN', kind: 'config', file: 'routes/ice.js' },
  { name: 'ICE_PER_IP_PER_HOUR', group: 'STUN / TURN', kind: 'config', file: 'routes/ice.js', note: '一个人反复进出房间很容易打到；直播/联机量大了要调高' },
  { name: 'INDEXNOW_ENABLED', group: '搜索引擎推送', kind: 'config', file: 'indexnow.js' },
  { name: 'INDEXNOW_ENDPOINT', group: '搜索引擎推送', kind: 'config', file: 'indexnow.js' },
  { name: 'INDEXNOW_KEY', group: '搜索引擎推送', kind: 'config', file: 'indexnow.js', note: '公开的域名验证值，文件在 public/<key>.txt' },
  { name: 'IPX_ENABLED', group: 'ROM / J2ME / IPX', kind: 'config', file: 'index.js' },
  { name: 'IPX_PORT', group: 'ROM / J2ME / IPX', kind: 'config', file: 'index.js' },
  { name: 'IPX_PUBLIC_HOST', group: 'ROM / J2ME / IPX', kind: 'config', file: 'index.js', note: 'IPX_PORT 留空时（共用端口模式）这里填 ipx 才对' },
  { name: 'I_KNOW_ADMIN_AUTH_IS_DISABLED', group: '安全', kind: 'config', file: 'auth.js', note: 'ADMIN_AUTH_DISABLED 的第二道闸，本机调试专用，线上永远不该出现' },
  { name: 'J2ME_MAX_UPLOAD_MB', group: 'ROM / J2ME / IPX', kind: 'config', file: 'j2me.js' },
  { name: 'J2ME_PROXY_CONCURRENCY', group: 'ROM / J2ME / IPX', kind: 'config', file: 'j2me.js', note: 'jar 转发到对象存储的并发上限，按进程算' },
  { name: 'J2ME_PROXY_MAX_MB', group: 'ROM / J2ME / IPX', kind: 'config', file: 'j2me.js', note: '一次转发最多收多少 MB（超过就中止上游）' },
  { name: 'J2ME_PROXY_TIMEOUT_MS', group: 'ROM / J2ME / IPX', kind: 'config', file: 'j2me.js', note: '上游没在期限内给完就 504' },
  { name: 'J2ME_TMP_DIR', group: 'ROM / J2ME / IPX', kind: 'config', file: 'j2me.js' },
  { name: 'J2ME_TMP_TOTAL_MB', group: 'ROM / J2ME / IPX', kind: 'config', file: 'j2me.js' },
  { name: 'J2ME_TMP_TTL_MS', group: 'ROM / J2ME / IPX', kind: 'config', file: 'j2me.js' },
  { name: 'J2ME_UPLOAD_CONCURRENCY', group: 'ROM / J2ME / IPX', kind: 'config', file: 'j2me.js', note: '同时落盘的上传数；配额检查与写盘是串行的' },
  { name: 'J2ME_UPLOAD_GLOBAL_MIN', group: 'ROM / J2ME / IPX', kind: 'config', file: 'j2me.js' },
  { name: 'J2ME_UPLOAD_PER_IP_HOUR', group: 'ROM / J2ME / IPX', kind: 'config', file: 'j2me.js' },
  { name: 'J2ME_UPLOAD_PER_IP_MIN', group: 'ROM / J2ME / IPX', kind: 'config', file: 'j2me.js' },
  { name: 'JWT_SECRET', group: '安全', kind: 'secret', file: 'auth.js', note: '换了所有人当场退出登录' },
  { name: 'FLASH_SAVE_SECRET', group: '云存档', kind: 'secret', file: 'flash-save-token.js', note: '旧 Flash 游戏的短期存档会话；必须与 JWT_SECRET 不同' },
  { name: 'FLASH_SAVE_TTL_SECONDS', group: '云存档', kind: 'config', file: 'flash-save-token.js', note: '默认 8 小时，限制在 5 分钟～24 小时' },
  { name: 'FLASH_SAVE_GAMES', group: '云存档', kind: 'config', file: 'flash-save-contract.js', note: '完成兼容桥验收的 Flash 游戏 slug，逗号分隔' },
  { name: 'FLASH_SAVE_PART_MAX_BYTES', group: '云存档', kind: 'config', file: 'flash-save-contract.js', note: 'Flash 在线档 profile/data 各自上限' },
  { name: 'FLASH_SAVE_SLOT_MAX_BYTES', group: '云存档', kind: 'config', file: 'flash-save-contract.js', note: 'Flash 在线档单槽两部分合计上限' },
  { name: 'FLASH_SAVE_TOTAL_MAX_BYTES', group: '云存档', kind: 'config', file: 'flash-save-contract.js', note: '单账号 Flash 在线档总配额' },
  { name: 'LIVE_FROZEN_CLOSE_MS', group: '直播', kind: 'config', file: 'live.js' },
  { name: 'LIVE_GHOST_SWEEP_MS', group: '直播', kind: 'config', file: 'live.js' },
  { name: 'LIVE_FROZEN_HIDE_MS', group: '直播', kind: 'config', file: 'live.js' },
  { name: 'LIVE_MAX_ROOMS', group: '直播', kind: 'config', file: 'live.js' },
  { name: 'LIVE_MAX_ROOMS_PER_IP', group: '直播', kind: 'config', file: 'live.js' },
  { name: 'LIVE_MAX_VIEWERS', group: '直播', kind: 'config', file: 'live.js' },
  { name: 'LIVE_RESUME_GRACE_MS', group: '直播', kind: 'config', file: 'live.js' },
  { name: 'MAIL_FROM', group: '发信', kind: 'config', file: 'index.js' },
  { name: 'MAIL_FROM_NAME', group: '发信', kind: 'config', file: 'mail.js' },
  { name: 'MAIL_TIMEOUT_MS', group: '发信', kind: 'config', file: 'mail.js' },
  { name: 'MICROSOFT_CLIENT_ID', group: '第三方登录', kind: 'config', file: 'routes/auth.js' },
  { name: 'MICROSOFT_CLIENT_SECRET', group: '第三方登录', kind: 'secret', file: 'routes/auth.js' },
  { name: 'MICROSOFT_TENANT', group: '第三方登录', kind: 'config', file: 'routes/auth.js' },
  { name: 'NETPLAY_CLAIM_MS', group: '联机信令', kind: 'config', file: 'netplay.js' },
  { name: 'NETPLAY_CLAIM_WINDOW_MS', group: '联机信令', kind: 'config', file: 'netplay.js' },
  { name: 'NETPLAY_HOST_GRACE_MS', group: '联机信令', kind: 'config', file: 'netplay.js' },
  { name: 'NETPLAY_MAX_MEMBERS_PER_IP', group: '联机信令', kind: 'config', file: 'netplay.js' },
  { name: 'NETPLAY_MAX_MESSAGE_BYTES', group: '联机信令', kind: 'config', file: 'netplay.js' },
  { name: 'NETPLAY_MAX_ROOMS', group: '联机信令', kind: 'config', file: 'netplay.js' },
  { name: 'NETPLAY_MAX_ROOMS_PER_IP', group: '联机信令', kind: 'config', file: 'netplay.js' },
  { name: 'NETPLAY_MAX_SPECTATORS', group: '联机信令', kind: 'config', file: 'netplay.js' },
  { name: 'NETPLAY_STATE_BUDGET_BYTES', group: '联机信令', kind: 'config', file: 'netplay.js' },
  { name: 'NETPLAY_STATE_PER_IP_BYTES', group: '联机信令', kind: 'config', file: 'netplay.js' },
  { name: 'NODE_ENV', group: '服务与地址', kind: 'config', file: 'auth.js', note: 'production 时即使站点地址是本机，也拒绝固定 JWT 密钥' },
  { name: 'OAUTH_REDIRECT_BASE', group: '服务与地址', kind: 'config', file: 'routes/auth.js' },
  { name: 'OPEN_EMBED_SECRET', group: '开放平台', kind: 'secret', file: 'open/config.js', note: '没配则嵌入地址端点单独 501' },
  { name: 'OPEN_ISSUER', group: '开放平台', kind: 'config', file: 'open/config.js' },
  { name: 'OPEN_JWT_KID', group: '开放平台', kind: 'config', file: 'open/config.js' },
  { name: 'OPEN_JWT_PRIVATE_KEY', group: '开放平台', kind: 'secret', file: 'open/config.js' },
  { name: 'OPEN_JWT_PRIVATE_KEY_PATH', group: '开放平台', kind: 'config', file: 'open/config.js', note: '配不全时开放平台要令牌的那半整块 501；公开目录不受影响' },
  { name: 'OPEN_LIVE_PUBLISH_TTL_SEC', group: '开放平台', kind: 'config', file: 'open/live-publisher.js', note: '外部设备专用开播凭证寿命，默认 12 小时' },
  { name: 'OPEN_ROM_SECRET', group: '开放平台', kind: 'secret', file: 'open/config.js', note: '没配则 ROM 两条端点单独 501' },
  { name: 'PAGE_S_MAXAGE', group: '缓存', kind: 'config', file: 'cache.js' },
  { name: 'PLAY_HASH_SECRET', group: '安全', kind: 'secret', file: 'playcount.js', note: '留空会回退到 JWT_SECRET —— 那样轮换 JWT 会让游玩去重哈希一起失效' },
  { name: 'PORT', group: '服务与地址', kind: 'config', file: 'index.js' },
  { name: 'PRESENCE_EARLY_RTT_MS', group: '房间名片', kind: 'config', file: 'presence.js' },
  { name: 'PRESENCE_RTT_FAIR', group: '房间名片', kind: 'config', file: 'presence.js' },
  { name: 'PRESENCE_RTT_GOOD', group: '房间名片', kind: 'config', file: 'presence.js' },
  { name: 'PUBLIC_SITE_URL', group: '服务与地址', kind: 'config', file: 'auth.js' },
  { name: 'RATING_PRIOR_MEAN', group: '评分', kind: 'config', file: 'ratings-repo.js', note: '改了全站评分排序立刻变，且旧排序回不来' },
  { name: 'RATING_PRIOR_WEIGHT', group: '评分', kind: 'config', file: 'ratings-repo.js', note: '越大越压制「1 票 5 分」的冷门游戏' },
  { name: 'RESEND_API_BASE', group: '发信', kind: 'config', file: 'mail.js', note: '测试用来指向本地 mock，线上不该配' },
  { name: 'RESEND_API_KEY', group: '发信', kind: 'secret', file: 'mail.js' },
  { name: 'ROM_BASE_URL', group: '服务与地址', kind: 'config', file: 'site-urls.js' },
  { name: 'ROM_PACK_KEY_ID', group: 'ROM / J2ME / IPX', kind: 'config', file: 'rom-pack-key.js', note: '当前新包使用的密钥代次；轮换后旧代密钥必须继续保留' },
  { name: 'ROM_PACK_SECRET', group: 'ROM / J2ME / IPX', kind: 'secret', file: 'rom-pack-key.js', note: '8BG 当前代根密钥，至少 32 字节；丢失后对应 ROM 无法恢复' },
  { name: 'ROM_PREFIX', group: 'ROM / J2ME / IPX', kind: 'config', file: 'j2me.js' },
  { name: 'ROOMS_MAX', group: '联机信令', kind: 'config', file: 'routes/rooms.js' },
  { name: 'SAVE_MAX_BYTES', group: '云存档', kind: 'config', file: 'routes/saves.js' },
  { name: 'SAVE_MAX_PER_USER', group: '云存档', kind: 'config', file: 'routes/saves.js' },
  { name: 'SAVE_MAX_TOTAL_BYTES', group: '云存档', kind: 'config', file: 'routes/saves.js' },
  { name: 'SFS_ENABLED', group: 'SFS 1.x', kind: 'config', file: 'sfs.js', note: '默认关闭；只控制旁路桥，不应影响主站启动' },
  { name: 'SSR_INFLIGHT_MAX_MS', group: '缓存', kind: 'config', file: 'content.js', note: '一次 SSR 取数最多允许飞多久，超时后不再复用那个 promise（默认 15 秒）' },
  { name: 'SFS_TCP_HOST', group: 'SFS 1.x', kind: 'config', file: 'sfs.js', note: 'SmartFoxServer sidecar 地址，通常是 127.0.0.1' },
  { name: 'SFS_TCP_PORT', group: 'SFS 1.x', kind: 'config', file: 'sfs.js' },
  { name: 'SFS_WS_PATH', group: 'SFS 1.x', kind: 'config', file: 'sfs.js' },
  { name: 'SFS_PUBLIC_WS_URL', group: 'SFS 1.x', kind: 'config', file: 'sfs.js', note: '留空时按当前请求自动生成 wss 地址' },
  { name: 'SFS_ALLOWED_ORIGINS', group: 'SFS 1.x', kind: 'config', file: 'sfs.js', note: '浏览器 WebSocket 来源白名单；留空只允许同源' },
  { name: 'SFS_PUBLIC_TCP_HOST', group: 'SFS 1.x', kind: 'config', file: 'sfs.js', note: '原生客户端直连地址；不提供原生入口时留空' },
  { name: 'SFS_PUBLIC_TCP_PORT', group: 'SFS 1.x', kind: 'config', file: 'sfs.js' },
  { name: 'SFS_SAS3_MAP_BASE_URL', group: 'SFS 1.x', kind: 'config', file: 'sfs.js', note: 'SAS3 地图资源镜像根地址' },
  { name: 'SFS_MAX_CONNECTIONS', group: 'SFS 1.x', kind: 'config', file: 'sfs.js' },
  { name: 'SFS_MAX_PER_IP', group: 'SFS 1.x', kind: 'config', file: 'sfs.js' },
  { name: 'SFS_MAX_FRAME_BYTES', group: 'SFS 1.x', kind: 'config', file: 'sfs.js' },
  { name: 'SFS_MAX_BUFFERED_BYTES', group: 'SFS 1.x', kind: 'config', file: 'sfs.js' },
  { name: 'SFS_CONNECT_TIMEOUT_MS', group: 'SFS 1.x', kind: 'config', file: 'sfs.js' },
  { name: 'SFS_IDLE_TIMEOUT_MS', group: 'SFS 1.x', kind: 'config', file: 'sfs.js' },
  { name: 'SMTP_FROM', group: '发信', kind: 'config', file: 'index.js' },
  { name: 'SMTP_HOST', group: '发信', kind: 'config', file: 'index.js' },
  { name: 'SMTP_PASS', group: '发信', kind: 'secret', file: 'mail.js' },
  { name: 'SMTP_PORT', group: '发信', kind: 'config', file: 'mail.js' },
  { name: 'SMTP_USER', group: '发信', kind: 'config', file: 'index.js' },
  { name: 'SOCKET_PING_INTERVAL_MS', group: '联机信令', kind: 'config', file: 'netplay.js' },
  { name: 'SSE_MAX_LIFETIME_MS', group: '直播', kind: 'config', file: 'sseGuard.js' },
  { name: 'SSE_MAX_PER_IP', group: '直播', kind: 'config', file: 'sseGuard.js' },
  { name: 'SSE_MAX_TOTAL', group: '直播', kind: 'config', file: 'sseGuard.js' },
  { name: 'SSR_CACHE_MAX', group: '缓存', kind: 'config', file: 'content.js' },
  { name: 'SSR_CACHE_MS', group: '缓存', kind: 'config', file: 'content.js' },
  { name: 'STUN_URLS', group: 'STUN / TURN', kind: 'config', file: 'routes/ice.js', note: '是**替换**内置默认值，不是追加' },
  { name: 'SUBMIT_GAME_TO_EMAIL', group: '发信', kind: 'config', file: 'index.js', note: '玩家投稿的通知信收件人。没配会退回用发件地址（多半没人收）' },
  { name: 'SUBMIT_MAIL_PROVIDER', group: '发信', kind: 'config', file: 'mail.js', note: '带 ROM 附件的投稿建议走 smtp —— Resend 有附件大小上限' },
  { name: 'SUBMIT_ROM_MAX_FILE_MB', group: '发信', kind: 'config', file: 'routes/submit-game.js' },
  { name: 'SUBMIT_ROM_MAX_TOTAL_MB', group: '发信', kind: 'config', file: 'routes/submit-game.js' },
  { name: 'TENCENT_IM_SDK_APPID', group: '翻译 / 站内消息', kind: 'config', file: 'im-sig.js' },
  { name: 'TENCENT_IM_SECRET_KEY', group: '翻译 / 站内消息', kind: 'secret', file: 'im-sig.js', note: '⚠️ 能签出任意用户的 UserSig = 可以冒充站内任何人' },
  { name: 'TENCENT_IM_SIG_TTL_SEC', group: '翻译 / 站内消息', kind: 'config', file: 'im-sig.js' },
  { name: 'TRANSLATE_TIMEOUT_MS', group: '翻译 / 站内消息', kind: 'config', file: 'translate.js' },
  { name: 'TRUST_PROXY', group: '服务与地址', kind: 'config', file: 'index.js', note: '配错时所有访客塌缩成同一个 IP，全站按 IP 的限流一起退化' },
  { name: 'TURN_BACKUP_CREDENTIAL', group: 'STUN / TURN', kind: 'secret', file: 'routes/ice.js' },
  { name: 'TURN_BACKUP_SECRET', group: 'STUN / TURN', kind: 'secret', file: 'routes/ice.js' },
  { name: 'TURN_BACKUP_URLS', group: 'STUN / TURN', kind: 'config', file: 'routes/ice.js' },
  { name: 'TURN_BACKUP_USERNAME', group: 'STUN / TURN', kind: 'config', file: 'routes/ice.js' },
  { name: 'TURN_CF_API_BASE', group: 'STUN / TURN', kind: 'config', file: 'routes/ice.js', note: '测试用来指向本地 mock，线上不该配' },
  { name: 'TURN_CF_API_TOKEN', group: 'STUN / TURN', kind: 'secret', file: 'routes/ice.js', note: 'TURN key 的 API token，不是 Realtime App 的 Secret' },
  { name: 'TURN_CF_KEY_ID', group: 'STUN / TURN', kind: 'config', file: 'routes/ice.js' },
  { name: 'TURN_CF_TIMEOUT_MS', group: 'STUN / TURN', kind: 'config', file: 'routes/ice.js' },
  { name: 'TURN_CF_TTL_SEC', group: 'STUN / TURN', kind: 'config', file: 'routes/ice.js' },
  { name: 'TURN_PROBE', group: 'STUN / TURN', kind: 'config', file: 'turnProbe.js' },
  { name: 'TURN_PROBE_INSECURE_TLS', group: 'STUN / TURN', kind: 'config', file: 'turnProbe.js', note: '⚠️ 关掉 TURN 探测的证书校验，线上不该开' },
  { name: 'TURN_PROBE_INTERVAL_SEC', group: 'STUN / TURN', kind: 'config', file: 'turnProbe.js' },
  { name: 'TURN_PROBE_TIMEOUT_MS', group: 'STUN / TURN', kind: 'config', file: 'turnProbe.js' },
  { name: 'TURN_SECRET', group: 'STUN / TURN', kind: 'secret', file: 'routes/ice.js', note: 'coturn 的 static-auth-secret，改了要两边同步' },
  { name: 'TURN_TTL_SEC', group: 'STUN / TURN', kind: 'config', file: 'routes/ice.js' },
  { name: 'TURN_URLS', group: 'STUN / TURN', kind: 'config', file: 'routes/ice.js' },
  { name: 'VITE_SITE_URL', group: '服务与地址', kind: 'config', file: 'auth.js', note: 'PUBLIC_SITE_URL 的回退别名，配了前者就不用' },
  { name: 'VOLC_AK', group: '翻译 / 站内消息', kind: 'secret', file: 'translate.js' },
  { name: 'VOLC_SK', group: '翻译 / 站内消息', kind: 'secret', file: 'translate.js' },
  { name: 'VOLC_TRANSLATE_BASE_URL', group: '翻译 / 站内消息', kind: 'config', file: 'translate.js', note: '测试用来指向本地 mock，线上不该配' },
]

/** 按名字查。找不到回 undefined —— 调用方要把「清单里没有」当成一种情况处理 */
export function specOf(name) {
  return ENV_MANIFEST.find((s) => s.name === name)
}

/** 清单里出现过的分组，保持声明顺序（后台照这个顺序渲染） */
export function envGroups() {
  const seen = []
  for (const s of ENV_MANIFEST) if (!seen.includes(s.group)) seen.push(s.group)
  return seen
}
