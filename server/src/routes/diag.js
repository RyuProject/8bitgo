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
import { turnHealthSnapshot } from '../turnProbe.js'
import { sseStats } from '../sseGuard.js'
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
  /**
   * Cloudflare 认定的访客地址。它和 effective 不一致 = 我们拿到的是 CF 边缘节点，
   * 不是人（见 presence.js 的 warnIfCdnEdgeIp）—— 这是最难自己发现的一种配置错误，
   * 因为每一项功能都还「能用」，只是全站所有人塌缩成了同一个访客。
   */
  const cfIp = headers['cf-connecting-ip'] || null
  const usingEdgeIp = Boolean(cfIp && effective && String(cfIp).trim() !== String(effective).trim())

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
      /** Cloudflare 说访客是谁。有这个头就说明流量确实过了 CF */
      cfConnectingIp: cfIp,
      /**
       * true = **配错了**：我们采用的是 CF 边缘节点的地址。
       * 每 IP 房间上限 / 限流会退化成「同一个 CF 机房共用一个额度」，国旗全站显示同一个国家。
       */
      usingCdnEdgeIp: usingEdgeIp,
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
     * 每一路 TURN 的探活结果（详细版，带错误码和「该去查哪一行」）。
     *
     *   state      up / down / unknown（unknown = 还没探过，下发时一律按能用处理）
     *   urls[]     逐条地址的结果；ok:false 的那条 error 里直接写了怎么查
     *   checkedAt  上次探的时间（unix 秒）。一直是 null = 探活没在跑
     *              （TURN_PROBE=off，或者一路 TURN 都没配）
     *
     * 空对象 {} 就是「没有任何一路 TURN 被登记」—— 先看 /api/netplay/ice 的 turnSources。
     */
    turn: turnHealthSnapshot({ verbose: true }),
    /**
     * 现在挂着多少条 SSE 长连接（`/api/live/events` + `/api/netplay/events` 合计）。
     *
     * 2026-09-09 那次源站猝死就是这两条被爬虫挂满堆出来的，事后再查已经查不到了 ——
     * 所以放在这里，随时一条 curl 就能看见：
     *
     *   curl -s https://8bitgo.com/api/diag | jq .sse
     *
     *   total          当前并发条数。持续贴着 maxTotal = 闸在扛，去查是谁在挂
     *   top / topIp    挂得最多的那个 IP 和它的条数。top 长期顶到 maxPerIp 就不是真人
     *   ips            有多少个不同 IP 挂着流
     *
     * ⚠️ 一条被 nginx 反代出去的 SSE 占它**两个**连接槽（客户端一个 + upstream 一个），
     * 所以 maxTotal 要留足余量，别设到接近 worker_connections。
     */
    sse: sseStats(),
    /** 有问题时直接把该改哪一行写在返回里 —— 排查的人不用再翻文档 */
    hint: usingEdgeIp
      ? 'nginx 每个 location 都要把 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` ' +
        '换成 `proxy_set_header X-Forwarded-For $http_cf_connecting_ip;`（在 Cloudflare 后面时前者追加的是 CF 节点地址）；' +
        '并把源站防火墙锁到 Cloudflare 的 IP 段，否则这个头能被直连源站的人伪造。'
      : isPrivateIp(effective)
        ? '反代没把真实 IP 传进来：每个 location 都要 proxy_set_header X-Forwarded-For（CF 后面用 $http_cf_connecting_ip）。'
        : null,
    /**
     * RTT 量不到这里看不出来 —— 它是长连接上的心跳时延，HTTP 请求没有。
     * 网络那格如果一直 ❓，看房间接口里的 presence.rtt：
     *   curl -s .../api/netplay/rooms | jq '.[0].presence'
     * 连上 1 秒内就该有数（见 presence.js 的 EARLY_RTT_MS）。
     */
    note: 'presence.rtt 要在 /api/netplay/rooms 或 /api/live/rooms 里看，HTTP 请求量不到心跳时延',
  })
})
