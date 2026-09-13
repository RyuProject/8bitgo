/**
 * 「当前生效配置」的计算层。**纯函数**：吃一份 env 对象，吐一份报告，不碰数据库、不碰全局。
 * 纯的好处很直接 —— 体检规则（下面 CHECKS）每一条都能单独喂一份假 env 去测，
 * 不用起服务、不用造管理员登录态。
 *
 * ## ⚠️ 一条铁律：密钥的**值**永远不出这个文件
 *
 * 这份报告是给后台看的，而后台的响应会进浏览器、进截图、进工单。
 * 所以 kind='secret' 的项一律只回三样：配没配、多长、一个指纹。
 *
 * 指纹为什么是 HMAC 而不是直接 sha256 截断：
 * 直接哈希对**高熵**密钥是安全的（32 字节随机串没法从 8 个十六进制字符倒推），
 * 但对低熵值不是 —— 比如一个 8 位纯数字的数据库口令，搜索空间只有 1e8，
 * 拿着截断哈希在笔记本上几秒就能撞出来。用 JWT_SECRET 当 HMAC 的密钥之后，
 * 不知道 JWT_SECRET 就没法离线撞，指纹退化成一个纯粹的「相等性标记」——
 * 而这正是它唯一的用途：对比线上和本机是不是同一个值。
 */
import { createHmac, createHash } from 'node:crypto'
import { ENV_MANIFEST, envGroups } from './config-manifest.js'

/** 指纹长度。只用来判相等，不用来判内容，短一点省版面 */
const FP_LEN = 8

/**
 * 一个值的指纹。
 * @param {string} value
 * @param {string} key  HMAC 密钥，传 JWT_SECRET
 */
export function fingerprint(value, key) {
  if (!value) return ''
  /*
    ⚠️ key 为空时**不要**退回成裸哈希。
    那正好是「JWT_SECRET 还没配」的机器，而那种机器上的其它密钥同样可能是弱值，
    裸哈希就把上面那段注释里说的离线爆破面又打开了。宁可不给指纹。
  */
  if (!key) return ''
  return createHmac('sha256', key).update(value).digest('hex').slice(0, FP_LEN)
}

/** 这个 env 里这一项算不算「配了」。⚠️ 空串等于没配 —— 代码里一律是 `env.X || 默认` */
function isSet(env, name) {
  return String(env?.[name] ?? '').trim() !== ''
}

/**
 * 非密钥项的展示值。会截断 —— 有些值（TURN_URLS、ALLOWED_ORIGINS）很长，
 * 而这一页是用来「扫一眼确认」的，不是用来读全文的。
 */
const MAX_SHOWN = 160
function shown(raw) {
  const v = String(raw)
  return v.length > MAX_SHOWN ? `${v.slice(0, MAX_SHOWN)}…（共 ${v.length} 字符）` : v
}

/**
 * 生效配置报告。
 *
 * @param {Record<string,string|undefined>} env
 * @returns {{groups: Array<{group: string, items: Array<object>}>, counts: object}}
 */
export function effectiveConfig(env = process.env) {
  const hmacKey = String(env.JWT_SECRET || '')
  const byGroup = new Map(envGroups().map((g) => [g, []]))
  let set = 0
  for (const spec of ENV_MANIFEST) {
    const on = isSet(env, spec.name)
    if (on) set++
    const raw = on ? String(env[spec.name]).trim() : ''
    const item = {
      name: spec.name,
      kind: spec.kind,
      file: spec.file,
      ...(spec.note ? { note: spec.note } : {}),
      // 「来自 .env」还是「用代码内置默认值」—— 这一页存在的头号理由就是这一列
      source: on ? 'env' : 'default',
    }
    if (spec.kind === 'secret') {
      // ⚠️ 这里只有三个字段。任何时候都不要往上面加一个 value
      item.length = raw.length
      item.fingerprint = fingerprint(raw, hmacKey)
    } else if (on) {
      item.value = shown(raw)
    }
    byGroup.get(spec.group).push(item)
  }
  return {
    groups: [...byGroup].map(([group, items]) => ({ group, items })),
    counts: {
      total: ENV_MANIFEST.length,
      set,
      default: ENV_MANIFEST.length - set,
      secret: ENV_MANIFEST.filter((s) => s.kind === 'secret').length,
    },
  }
}

/* ---------------- 体检 ---------------- */

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim())
const val = (env, k) => String(env?.[k] ?? '').trim()

/**
 * 每条规则：`{ id, level, when(env) -> bool, title, detail }`。
 *
 * level：
 *   · 'danger'  —— 现在就有人能利用，或者数据会丢
 *   · 'warn'    —— 功能是坏的 / 悄悄没工作，但不至于被攻击
 *   · 'info'    —— 值得知道，不用今晚处理
 *
 * ⚠️ 写规则时只用 env，不要去查库、不要读文件。这一层是纯的，别把它弄脏。
 */
export const CHECKS = [
  {
    id: 'admin-auth-disabled',
    level: 'danger',
    title: '后台鉴权被整个关掉了',
    detail:
      'ADMIN_AUTH_DISABLED=1 时 roleOfRequest() 对每个请求直接返回 admin、不看任何令牌 —— ' +
      '任何人都能增删改游戏、文章、用户。线上必须是 0。',
    when: (env) => truthy(env.ADMIN_AUTH_DISABLED) && truthy(env.I_KNOW_ADMIN_AUTH_IS_DISABLED),
  },
  {
    id: 'cors-wildcard',
    level: 'danger',
    title: 'ALLOWED_ORIGINS 没配，跨域退回成 *',
    detail:
      '任何网站都能拿这个后端当 API 用，带着访客的 cookie 调 /api/me、/api/admin。' +
      '填成 https://你的域名,https://www.你的域名。',
    when: (env) => !isSet(env, 'ALLOWED_ORIGINS'),
  },
  {
    id: 'secret-reuse',
    level: 'danger',
    title: '有两把密钥用了同一个值',
    detail:
      '每把密钥的作用域不同，复用意味着一把泄露时另一件事跟着失守，而且吊销时没法只废掉其中一件。' +
      '各来一条 openssl rand -base64 32。',
    when: (env) => {
      const names = ENV_MANIFEST.filter((s) => s.kind === 'secret').map((s) => s.name)
      const seen = new Map()
      for (const n of names) {
        const v = val(env, n)
        if (!v) continue
        if (seen.has(v)) return true
        seen.set(v, n)
      }
      return false
    },
  },
  {
    id: 'weak-secret',
    level: 'warn',
    title: '有密钥太短或熵太低',
    detail:
      '少于 16 个字符、或者全是数字 —— 同机的进程可以直接猜。' +
      '数据库口令尤其容易被忽略，因为「反正只监听 127.0.0.1」。',
    when: (env) =>
      ENV_MANIFEST.filter((s) => s.kind === 'secret').some((s) => {
        const v = val(env, s.name)
        if (!v) return false
        return v.length < 16 || /^\d+$/.test(v)
      }),
  },
  {
    id: 'submit-email-missing',
    level: 'warn',
    title: '玩家投稿的通知信没有收件人',
    detail:
      'SUBMIT_GAME_TO_EMAIL 没配时，代码回退到 MAIL_FROM —— 那是个发件专用地址，多半没人收，' +
      '也就是说投稿一直在悄悄丢。填一个你真的会查的邮箱。',
    when: (env) => !isSet(env, 'SUBMIT_GAME_TO_EMAIL'),
  },
  {
    id: 'play-hash-coupled',
    level: 'info',
    title: '游玩去重的盐和登录密钥是同一把',
    detail:
      'PLAY_HASH_SECRET 留空会回退到 JWT_SECRET。哪天轮换 JWT_SECRET（比如泄露了），' +
      '全站的「玩过一次」去重哈希会一起失效，所有人被当成新访客，播放量虚高一次。',
    when: (env) => !isSet(env, 'PLAY_HASH_SECRET') && isSet(env, 'JWT_SECRET'),
  },
  {
    id: 'open-platform-off',
    level: 'info',
    title: '开放平台要令牌的那半是关的',
    detail:
      'OPEN_JWT_PRIVATE_KEY(_PATH) 没配 —— /v1/token、/v1/me、ROM 凭据、设备码一律 501。' +
      '公开目录（/v1/games、/v1/platforms、/v1/collections）不受影响，照常可用。',
    when: (env) => !isSet(env, 'OPEN_JWT_PRIVATE_KEY') && !isSet(env, 'OPEN_JWT_PRIVATE_KEY_PATH'),
  },
  {
    id: 'open-rom-off',
    level: 'info',
    title: 'ROM / 嵌入地址的签名密钥没配',
    detail: '这两条端点会单独 501，其余开放平台接口不受影响。',
    when: (env) =>
      (isSet(env, 'OPEN_JWT_PRIVATE_KEY') || isSet(env, 'OPEN_JWT_PRIVATE_KEY_PATH')) &&
      (!isSet(env, 'OPEN_ROM_SECRET') || !isSet(env, 'OPEN_EMBED_SECRET')),
  },
  {
    id: 'mock-endpoint',
    level: 'danger',
    title: '有接口被指向了测试用的 mock 地址',
    detail:
      'RESEND_API_BASE / CF_API_BASE / TURN_CF_API_BASE / VOLC_TRANSLATE_BASE_URL 是测试用来' +
      '把请求打到本地假服务器的钩子。线上配了它们，对应的功能会静默地不工作 —— ' +
      '不报错，只是信发不出去、TURN 凭证拿不到。',
    when: (env) =>
      ['RESEND_API_BASE', 'CF_API_BASE', 'TURN_CF_API_BASE', 'VOLC_TRANSLATE_BASE_URL'].some((k) =>
        isSet(env, k),
      ),
  },
  {
    id: 'turn-insecure-tls',
    level: 'danger',
    title: 'TURN 探测关掉了证书校验',
    detail: 'TURN_PROBE_INSECURE_TLS=1 只该出现在本机调试里。',
    when: (env) => truthy(env.TURN_PROBE_INSECURE_TLS),
  },
  {
    id: 'no-mail-channel',
    level: 'warn',
    title: '一条发信通道都没配',
    detail: '邮箱验证码会只打印到服务器日志里 —— 也就是说没人能用邮箱注册或登录。',
    when: (env) =>
      !isSet(env, 'RESEND_API_KEY') && !isSet(env, 'SMTP_HOST') && !isSet(env, 'CF_EMAIL_TOKEN'),
  },
  {
    id: 'seed-creds-left',
    level: 'warn',
    title: '建站用的初始管理员口令还留在配置里',
    detail: 'ADMIN_PASSWORD 只给 npm run seed 建第一个管理员用，建完就该清空。',
    when: (env) => isSet(env, 'ADMIN_PASSWORD'),
  },
  {
    id: 'site-url-missing',
    level: 'warn',
    title: '站点公开地址没配',
    detail:
      'PUBLIC_SITE_URL 缺席时，sitemap、og:image、canonical、OAuth 回调都会拼不出绝对地址。',
    when: (env) => !isSet(env, 'PUBLIC_SITE_URL') && !isSet(env, 'VITE_SITE_URL'),
  },
]

/**
 * 跑一遍体检。只回**命中**的那些，按严重程度排序。
 * 没命中就是空数组 —— 后台那边照此显示一句「没有发现问题」。
 */
export function configChecks(env = process.env) {
  const order = { danger: 0, warn: 1, info: 2 }
  return CHECKS.filter((c) => {
    try {
      return c.when(env)
    } catch {
      // 一条规则写崩了不该把整页带下去
      return false
    }
  })
    .map(({ id, level, title, detail }) => ({ id, level, title, detail }))
    .sort((a, b) => order[a.level] - order[b.level])
}

/**
 * 配置的整体指纹：用来回答「线上和我本机是不是同一份配置」。
 * 只吃「哪些项配了」+ 非密钥项的值，密钥只进名字不进值。
 */
export function configDigest(env = process.env) {
  const h = createHash('sha256')
  for (const spec of ENV_MANIFEST) {
    const on = isSet(env, spec.name)
    h.update(spec.name).update(on ? '=1' : '=0')
    if (on && spec.kind !== 'secret') h.update(':').update(String(env[spec.name]).trim())
  }
  return h.digest('hex').slice(0, 12)
}
