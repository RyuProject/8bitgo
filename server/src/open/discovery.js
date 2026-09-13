/**
 * 开放平台的自发现：JWKS + RFC 8414 授权服务器元数据。纯函数，好测。
 *
 * ## ⚠️ 为什么是 `oauth-authorization-server` 而不是 `openid-configuration`
 *
 * 这套东西**是 OAuth 2.0，不是 OIDC**。实际有的只有：
 * 授权码 + PKCE、client_credentials、设备码（RFC 8628），签出来的只有 access_token。
 *
 * **没有** id_token、没有 userinfo、没有 revoke、没有 refresh_token。
 * （docs/open-platform.md §2 把这四样都写成了现成的 —— 那是设计稿里的目标形态，
 *   不是今天的实现。2026-09-13 核对过：oauth.js 里只有三条路由。）
 *
 * 所以这里**故意不提供** `/.well-known/openid-configuration`。
 * 提供它会更糟而不是更好：接入方的 OIDC 库读到发现文档就会去拿 id_token、
 * 去调 userinfo，然后在一个和真正原因毫无关系的地方失败
 * （「id_token 缺失」「userinfo 404」），而真相是「这个服务压根不是 OIDC」。
 * 一个诚实的 404 比一个撒谎的发现文档省事得多。
 *
 * RFC 8414 那份是准确的：它只登记确实存在的端点、确实支持的 grant type。
 */
/**
 * JWKS。轮换时新旧两把**同时挂**，靠 kid 区分 —— 只挂新的那一把，
 * 所有在飞的令牌当场全废（access token 寿命 15 分钟，也就是最长 15 分钟的全站故障）。
 *
 * @param {object} o
 * @param {string} o.publicKey  SPKI PEM
 * @param {string} o.kid
 * @param {(pem: string) => object} o.createPublicKey  node:crypto 的同名函数，注入进来好测
 */
export function jwksFor({ publicKey, kid, createPublicKey }) {
  if (!publicKey) return { keys: [] }
  const jwk = createPublicKey(publicKey).export({ format: 'jwk' })
  /*
    显式挑字段，不用 `{ ...jwk }`。

    ⚠️ 这里原来写的理由是「展开写法会把私钥的 d / p / q 漏出去」—— **那句是错的**，
    2026-09-13 变异测试证伪：`createPublicKey()` 哪怕喂进去一个私钥 PEM，
    导出的 JWK 也只有 kty / n / e，私钥部分进不来。两种写法在这条路上完全等价。

    留着挑字段的真实理由弱一些，但是真的：`export({ format: 'jwk' })` 的字段集合
    由 Node 决定，将来版本多加一个字段时，展开写法会把它**原样转发到一个公开、
    可缓存的端点**上，而没有任何人审过那是什么。挑字段的写法则是加不进来。
  */
  return {
    keys: [{ kty: jwk.kty, n: jwk.n, e: jwk.e, use: 'sig', alg: 'RS256', kid: String(kid || 'open-1') }],
  }
}

/**
 * RFC 8414 的授权服务器元数据。
 *
 * ⚠️ 只登记**真的存在**的端点。加一条之前先确认路由在，
 * 否则这份文档就成了下一个「文档说有、实际 404」。
 *
 * @param {object} o
 * @param {string} o.issuer   站点根地址，不带尾斜杠
 * @param {string[]} o.scopes 支持的 scope
 */
export function authServerMetadata({ issuer, scopes }) {
  const base = String(issuer || '').replace(/\/+$/, '')
  return {
    issuer: base,
    /*
      ⚠️ 是 `/open/authorize`，**不是** `/oauth/authorize`。
      docs/open-platform.md §2.1 写的是后者，而 src/AppRoutes.tsx 里真实挂的是前者 ——
      我照着文档抄进来，被「每个 endpoint 都要指向真实路由」那条测试当场拦下。
      文档也一起改了。

      这是**前端页面**（登录 + 同意界面），不是后端 302：为的是直接复用站内
      现有的登录弹窗和多语言外壳。后端那两条是 GET/POST /api/oauth/authorize。
    */
    authorization_endpoint: `${base}/open/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    device_authorization_endpoint: `${base}/api/open/v1/device/code`,
    jwks_uri: `${base}/.well-known/jwks.json`,
    /* 自省：不是 RFC 7662 那个 POST introspection，是我们自己的只读自查 */
    'x-token-info_endpoint': `${base}/api/open/v1/me`,
    scopes_supported: [...scopes],
    response_types_supported: ['code'],
    grant_types_supported: [
      'authorization_code',
      'client_credentials',
      'urn:ietf:params:oauth:grant-type:device_code',
    ],
    // ⚠️ 强制 PKCE，而且不收 plain（见 oauth.js）。写进来省得接入方试错
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    service_documentation: `${base}/open`,
    /*
      ⚠️ 显式说明不支持什么，比让接入方自己撞上去强。
      RFC 8414 没定义这个字段，加 x- 前缀表明是我们自己的扩展。
    */
    'x-not-supported': ['id_token', 'userinfo', 'refresh_token', 'revocation'],
  }
}
