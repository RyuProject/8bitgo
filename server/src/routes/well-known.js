/**
 * `/.well-known/*` —— 开放平台的自发现端点。公开、匿名、CORS 放开。
 *
 * ⚠️ 这两条**不挂在 /api 下**，所以它们不经过 index.js 里那道 `app.use('/api', noStore)`，
 * 缓存头要自己写。
 */
import { Router } from 'express'
import { createPublicKey } from 'node:crypto'
import { openConfig } from '../open/config.js'
import { jwksFor, authServerMetadata } from '../open/discovery.js'
import { OPEN_SCOPES } from '../open/scopes.js'
import { publicSiteUrl } from '../site-urls.js'

export const wellKnownRouter = Router()

/** 这两条第三方的浏览器和服务端都会直接拉，和 /api/open 同一套 CORS */
function openCors(res) {
  res.set('Access-Control-Allow-Origin', '*')
  res.set('Access-Control-Allow-Headers', 'Content-Type')
}

/**
 * `GET /.well-known/jwks.json` —— access token 的验签公钥。
 *
 * 开放平台没启用时回 **503 而不是 404**：404 的意思是「这个站没有这东西」，
 * 而真相是「有，只是现在没配密钥」。接入方据此重试，而不是去改代码。
 */
wellKnownRouter.get('/jwks.json', (_req, res) => {
  const cfg = openConfig()
  openCors(res)
  if (!cfg) {
    res.set('Cache-Control', 'no-store')
    return res.status(503).json({ error: 'temporarily_unavailable', error_description: '开放平台未启用' })
  }
  /*
    ⚠️ 缓存时间是在「省回源」和「轮换后多久全网生效」之间取舍。
    5 分钟：轮换密钥时，新旧两把同时挂着扛过这 5 分钟就行（见 discovery.js）。
    设太长的话，轮换当天会有一批客户端拿着只认旧 kid 的 JWKS 验不过新令牌。
  */
  res.set('Cache-Control', 'public, max-age=300')
  res.json(jwksFor({ publicKey: cfg.publicKey, kid: cfg.kid, createPublicKey }))
})

/**
 * `GET /.well-known/oauth-authorization-server` —— RFC 8414 元数据。
 *
 * ⚠️ 刻意**不提供** `/.well-known/openid-configuration`：这套是 OAuth 2.0 不是 OIDC，
 * 理由写在 open/discovery.js 的文件头。
 *
 * 这一条不依赖任何密钥（它只是一张地址表），所以**开放平台没启用时照样回**——
 * 接入方正好能从里面看到该往哪儿发请求，再从 token 端点的 501 知道服务端还没配好。
 */
wellKnownRouter.get('/oauth-authorization-server', (_req, res) => {
  openCors(res)
  res.set('Cache-Control', 'public, max-age=3600')
  res.json(authServerMetadata({ issuer: openConfig()?.issuer || publicSiteUrl(), scopes: Object.keys(OPEN_SCOPES) }))
})
