import { Router } from 'express'
import { activeRomPackKeyId, deriveRomPackKey } from '../rom-pack-key.js'
import { clientKey, isMeaningfulIp, take } from '../rateLimit.js'

export const romPackRouter = Router()

/**
 * 站点允许匿名试玩，所以浏览器最终一定能拿到本局的数据密钥；这条接口防的是把主密钥
 * 写进静态 JS、公开对象被拿走后离线批量解包，不是假装能阻止已获授权的玩家抓内存。
 * 响应不缓存，之后若改成登录/播放票据鉴权，容器格式与已经上传的包都不用动。
 */
romPackRouter.get('/key', (req, res) => {
  // 成功、限流和配置错误都不能被 CDN 记住；尤其是部署时短暂的 503，缓存后会让密钥已经
  // 配好的新进程继续被旧错误挡住。
  res.set('Cache-Control', 'private, no-store')
  // 匿名试玩决定了这不是 DRM 接口，但也不能让一台脚本无限速地把整个库的数据密钥扫走，
  // 更不能让任意 packageId 的 HMAC 计算把 API 进程拖死。全站闸在反代 IP 配错时仍然有效。
  const globalGate = take('rompack:key:global', 6000, 60_000)
  if (!globalGate.ok) {
    res.set('Retry-After', String(globalGate.retryAfter))
    return res.status(429).json({ error: 'ROM 包密钥请求过于频繁，请稍后重试' })
  }
  const ip = clientKey(req)
  if (isMeaningfulIp(ip)) {
    const ipGate = take(`rompack:key:ip:${ip}`, 240, 60_000)
    if (!ipGate.ok) {
      res.set('Retry-After', String(ipGate.retryAfter))
      return res.status(429).json({ error: 'ROM 包密钥请求过于频繁，请稍后重试' })
    }
  }
  const packageId = String(req.query.packageId || '')
  const keyId = String(req.query.keyId || activeRomPackKeyId())
  try {
    const key = deriveRomPackKey(packageId, keyId)
    res.json({ packageId, keyId, key: key.toString('base64url') })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ROM 包密钥不可用'
    const status = /未配置|长度不足/.test(message) ? 503 : 400
    res.status(status).json({ error: message })
  }
})
