/**
 * STUN / TURN 报文的编解码 —— 纯函数，不碰 socket，可以单独测。
 *
 * 为什么要自己写这一小段二进制：**「自建 TURN 到底能不能用」只有一种可靠的问法，
 * 就是拿着即将下发给玩家的那份凭证，真的向 coturn 发一次 Allocate 看它给不给中继地址。**
 * ping 通、TCP 连得上、端口开着，全都不能证明它能用 —— 线上最常见的两种死法
 * （凭证时间戳过期 → 401；中继端口段 49160-49200/udp 没放行 → 握手过了但分不到地址）
 * 在那几种检查里都是绿的。
 *
 * 相关 RFC：5389（STUN）/ 5766（TURN）/ 7065（turn: URI）。
 * 只实现探活要用到的那几个报文，不实现真正的中继数据面。
 */
import { createHash, createHmac } from 'node:crypto'

export const MAGIC = 0x2112a442
export const MAGIC_BUF = Buffer.from([0x21, 0x12, 0xa4, 0x42])

export const METHOD = { ALLOCATE: 0x003, REFRESH: 0x004 }
export const CLASS = { REQUEST: 0, INDICATION: 1, SUCCESS: 2, ERROR: 3 }

export const ATTR = {
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_TRANSPORT: 0x0019,
  XOR_MAPPED_ADDRESS: 0x0020,
  LIFETIME: 0x000d,
  SOFTWARE: 0x8022,
}

/**
 * 消息类型那 14 位是**被切成三段**塞进去的（中间夹着 class 的两个 bit），
 * 不是「方法 << 4 | 类别」那么简单。写错的话 coturn 直接当畸形包丢掉，一个字都不回。
 */
export const msgType = (method, cls) =>
  ((method & 0xf80) << 2) | ((method & 0x70) << 1) | (method & 0x0f) | ((cls & 0x2) << 7) | ((cls & 0x1) << 4)

export const parseType = (t) => ({
  method: ((t >> 2) & 0xf80) | ((t >> 1) & 0x70) | (t & 0x0f),
  cls: ((t >> 7) & 0x2) | ((t >> 4) & 0x1),
})

/** 属性是 TLV，长度字段写的是**值的真实长度**，但后面要补零对齐到 4 字节 */
export function attrBuf(type, value) {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  const pad = (4 - (v.length % 4)) % 4
  const b = Buffer.alloc(4 + v.length + pad)
  b.writeUInt16BE(type, 0)
  b.writeUInt16BE(v.length, 2)
  v.copy(b, 4)
  return b
}

export function encodeMessage({ method, cls = CLASS.REQUEST, transactionId, attrs = [] }) {
  const body = Buffer.concat(attrs.map(([t, v]) => attrBuf(t, v)))
  const head = Buffer.alloc(20)
  head.writeUInt16BE(msgType(method, cls), 0)
  head.writeUInt16BE(body.length, 2)
  MAGIC_BUF.copy(head, 4)
  transactionId.copy(head, 8)
  return Buffer.concat([head, body])
}

export function decodeMessage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 20) return null
  if (buf.readUInt32BE(4) !== MAGIC) return null
  const len = buf.readUInt16BE(2)
  if (buf.length < 20 + len) return null
  const { method, cls } = parseType(buf.readUInt16BE(0))
  const attrs = new Map()
  let off = 20
  const end = 20 + len
  while (off + 4 <= end) {
    const t = buf.readUInt16BE(off)
    const l = buf.readUInt16BE(off + 2)
    if (off + 4 + l > end) break
    // 同一个属性重复出现时按 RFC 只认第一个
    if (!attrs.has(t)) attrs.set(t, buf.subarray(off + 4, off + 4 + l))
    off += 4 + l + ((4 - (l % 4)) % 4)
  }
  return { method, cls, transactionId: buf.subarray(8, 20), attrs, size: 20 + len }
}

/**
 * 长期凭证的密钥 = MD5("用户名:realm:密码")。
 *
 * ⚠️ coturn 的 `use-auth-secret`（TURN REST API）签出来的那串 base64 **就是「密码」本身** ——
 * 不是再拿 secret 算一遍。username 是 `<过期时间戳>:label`，coturn 会自己校验那个时间戳，
 * 过期就直接 401，这也正是「CDN 缓存住 ICE 接口 → 自建那路对所有人都废了」的机理。
 */
export const longTermKey = (username, realm, password) =>
  createHash('md5').update(`${username}:${realm}:${password}`, 'utf8').digest()

/**
 * 追加 MESSAGE-INTEGRITY。
 *
 * ⚠️ **这是整段代码唯一一处容易写错、而且写错了对方只回 401、绝不告诉你为什么的地方。**
 * HMAC-SHA1 覆盖的是「把消息头里的长度字段**先改成含这条 integrity 之后**」的前半部分
 * （+4 字节属性头 +20 字节值 = +24），而不是当前的长度。测试里专门钉住了这个数字。
 */
export function appendIntegrity(msg, key) {
  const withLen = Buffer.from(msg)
  withLen.writeUInt16BE(msg.length - 20 + 24, 2)
  const mac = createHmac('sha1', key).update(withLen).digest()
  return Buffer.concat([withLen, attrBuf(ATTR.MESSAGE_INTEGRITY, mac)])
}

/** ERROR-CODE：前两字节保留，第三字节是「类」，第四字节是「号」，code = 类*100 + 号 */
export function errorCode(v) {
  if (!Buffer.isBuffer(v) || v.length < 4) return { code: 0, reason: '' }
  return { code: v[2] * 100 + v[3], reason: v.subarray(4).toString('utf8') }
}

/** XOR-*-ADDRESS：端口和地址都被 magic cookie（IPv6 还要接上 transaction id）异或过 */
export function xorAddress(v, transactionId) {
  if (!Buffer.isBuffer(v) || v.length < 8) return null
  const family = v[1]
  const port = v.readUInt16BE(2) ^ (MAGIC >>> 16)
  if (family === 0x01) {
    const a = Buffer.from(v.subarray(4, 8))
    for (let i = 0; i < 4; i++) a[i] ^= MAGIC_BUF[i]
    return `${a.join('.')}:${port}`
  }
  if (family === 0x02 && v.length >= 20) {
    const mask = Buffer.concat([MAGIC_BUF, Buffer.from(transactionId)])
    const a = Buffer.from(v.subarray(4, 20))
    for (let i = 0; i < 16; i++) a[i] ^= mask[i]
    const parts = []
    for (let i = 0; i < 16; i += 2) parts.push(a.readUInt16BE(i).toString(16))
    return `[${parts.join(':')}]:${port}`
  }
  return null
}

/**
 * 解析 turn: / turns: 地址。
 *
 * ⚠️ 别拿 `new URL()` 解 —— `turn:` 不是「特殊 scheme」，host:port 会整段落进 pathname，
 * 而 IPv6 的方括号又要另外处理。RFC 7065 的默认值也得照办：
 * `turn:` 默认 UDP、3478；`turns:` 默认 TCP(TLS)、5349。
 */
export function parseTurnUrl(raw) {
  const m = /^(turns?):([^?]+)(?:\?(.*))?$/i.exec(String(raw || '').trim())
  if (!m) return null
  const secure = m[1].toLowerCase() === 'turns'
  const hostport = m[2]
  let host
  let port = 0
  if (hostport.startsWith('[')) {
    const i = hostport.indexOf(']')
    if (i < 0) return null
    host = hostport.slice(1, i)
    port = Number(hostport.slice(i + 2)) || 0
  } else {
    const i = hostport.lastIndexOf(':')
    if (i > 0) {
      host = hostport.slice(0, i)
      port = Number(hostport.slice(i + 1)) || 0
    } else {
      host = hostport
    }
  }
  if (!host) return null
  if (!port) port = secure ? 5349 : 3478
  const t = (new URLSearchParams(m[3] || '').get('transport') || '').toLowerCase()
  const transport = t === 'udp' ? 'udp' : t === 'tcp' ? 'tcp' : secure ? 'tcp' : 'udp'
  return { host, port, secure, transport, raw: String(raw).trim() }
}
