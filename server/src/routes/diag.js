/**
 * 自查：GET /api/diag
 *
 * 房间卡片上的国旗和网络格子是**静默降级**的 —— 反代少一行 X-Forwarded-For，
 * 服务端看到的每个人都是 127.0.0.1，国旗永远 ❓，日志里一个字都没有。
 * 以前排查这个只能靠翻代码猜，这个接口把「服务端到底看到了什么」原样摊开，一次 curl 就有答案。
 *
 *   curl -s https://你的域名/api/diag | jq
 *
 * 看三行就够：
 *   ip.effective   服务端认定的客户端 IP。是 127.0.0.1 / 内网地址 = 反代没把真实 IP 传进来
 *   country.final  最终用的国家码。null 就是两条路都没查出来
 *   geo.loaded     离线国家库有没有加载上（false = npm 依赖没装好）
 *
 * 只回显**这一次请求自己**的信息，不涉及别人的连接，也不吐任何密钥。
 */
import { Router } from 'express'
import {
  clientIpFrom,
  countryFromHeaders,
  countryFromIp,
  deviceFromUa,
  geoReady,
  isPrivateIp,
  resolveCountry,
} from '../presence.js'

export const diagRouter = Router()

diagRouter.get('/', (req, res) => {
  const headers = req.headers || {}
  const direct = req.socket?.remoteAddress || ''
  const effective = clientIpFrom(direct, headers)
  const byIp = countryFromIp(effective)
  const byHeader = countryFromHeaders(headers)

  res.set('Cache-Control', 'no-store')
  res.json({
    ip: {
      /** express 按 trust proxy 算出来的 */
      express: req.ip || null,
      /** socket 对端 —— 经反代时这里就是反代自己 */
      direct,
      /** presence 实际采用的那个（XFF 最后一段） */
      effective,
      /** 内网 / 回环 = 反代没把真实 IP 传进来，国旗会一直 ❓ */
      isPrivate: isPrivateIp(effective),
      xff: headers['x-forwarded-for'] || null,
      xRealIp: headers['x-real-ip'] || null,
      trustProxy: String(process.env.TRUST_PROXY ?? 'loopback'),
    },
    country: {
      /** 按 IP 查离线库的结果 */
      byIp,
      /** 网关（Cloudflare 等）给的 */
      byHeader,
      cfIpCountry: headers['cf-ipcountry'] || null,
      /** 最终用哪个：先 IP 后网关 */
      final: resolveCountry(effective, headers),
    },
    geo: {
      /** 离线国家库加载上没有。false = 依赖没装好，所有 IP 都查不出国家 */
      loaded: geoReady(),
    },
    device: deviceFromUa(headers['user-agent']),
    /**
     * RTT 量不到这里看不出来 —— 它是长连接上的心跳时延，HTTP 请求没有。
     * 网络那格如果一直 ❓，看房间接口里的 presence.rtt：
     *   curl -s .../api/netplay/rooms | jq '.[0].presence'
     * 连上 1 秒内就该有数（见 presence.js 的 EARLY_RTT_MS）。
     */
    note: 'presence.rtt 要在 /api/netplay/rooms 或 /api/live/rooms 里看，HTTP 请求量不到心跳时延',
  })
})
