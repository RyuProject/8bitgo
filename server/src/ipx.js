/**
 * DOS 联机用的 IPX 中继服务（DOSBox / DOSBox-X 的 IPX 隧道协议）。
 *
 * 这是 caiiiycuk/dosbox-ipx-server（Go, MIT）的 Node 移植 —— 协议照抄，行为一致，
 * 好处是不用再单独部署一个 Go 服务，跟现有的 Express / ws 跑在一个进程里。
 *
 * 工作方式：每个 js-dos 实例用 WebSocket 连到 ws://<host>:1900/ipx/<房间名>，
 * 服务器按房间把 IPX 数据包转给同房间的其他人：
 *   - 目标 socket=0x2 且 host=0 的是「注册包」，回一个带分配地址的头（DOSBox 据此得到自己的 IPX 地址）
 *   - 目标 host=0xffffffff 是广播，转给房间里其他所有人
 *   - 其余按目标地址精确投递
 *
 * ⚠️ 端口 1900 是 js-dos 写死的（它连的是 `<address>:1900/ipx/<room>`），不能改。
 */
import { WebSocketServer } from 'ws'

const IPX_PORT = 1900
const IPX_PATH = '/ipx/'
/** IPX 头固定 30 字节：校验和(2) 长度(2) 传输控制(1) 类型(1) + 目标(12) + 源(12) */
const HEADER_SIZE = 30

/** 房间名 -> Map<地址字符串, ws> */
const rooms = new Map()

function parseHeader(buf) {
  if (buf.length < HEADER_SIZE) return null
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const at = (o) => ({
    network: v.getUint32(o, false),
    host: v.getUint32(o + 4, false),
    port: v.getUint16(o + 8, false),
    socket: v.getUint16(o + 10, false),
  })
  return { checkSum: v.getUint16(0, false), length: v.getUint16(2, false), dest: at(6), src: at(18) }
}

/** 「1.2.3.4:5678」-> { host: uint32, port: uint16 }，跟 Go 版的 setAddress 等价 */
function addressToParts(address) {
  const i = address.lastIndexOf(':')
  const host = address.slice(0, i).replace(/^\[|\]$/g, '').replace(/^::ffff:/, '')
  const port = Number(address.slice(i + 1)) || 0
  const octets = host.split('.').map(Number)
  const bytes = octets.length === 4 && octets.every((n) => n >= 0 && n <= 255) ? octets : [127, 0, 0, 1]
  return { host: ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0, port }
}

/** uint32 + port -> 「1.2.3.4:5678」，用于按目标地址找人 */
function partsToAddress(host, port) {
  return `${(host >>> 24) & 0xff}.${(host >>> 16) & 0xff}.${(host >>> 8) & 0xff}.${host & 0xff}:${port}`
}

/** 注册包的应答：告诉客户端「你的 IPX 地址是这个」 */
function registrationReply(clientAddress, serverAddress) {
  const buf = Buffer.alloc(HEADER_SIZE)
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const c = addressToParts(clientAddress)
  const s = addressToParts(serverAddress)
  v.setUint16(0, 0xffff, false) // checksum
  v.setUint16(2, HEADER_SIZE, false) // length
  v.setUint8(4, 0) // transport control
  v.setUint8(5, 0) // packet type
  v.setUint32(6, 0, false) // dest.network
  v.setUint32(10, c.host, false)
  v.setUint16(14, c.port, false)
  v.setUint16(16, 0x2, false) // dest.socket
  v.setUint32(18, 1, false) // src.network
  v.setUint32(22, s.host, false)
  v.setUint16(26, s.port, false)
  v.setUint16(28, 0x2, false) // src.socket
  return buf
}

const handleProtocols = (protocols) => (protocols.has('binary') ? 'binary' : false)

/**
 * 挂到已有的 HTTP 服务器上（推荐）。
 *
 * js-dos 客户端原本把端口写死成 1900，配套的 scripts/copy-jsdos.mjs 会在复制资源时
 * 把那一处去掉，于是 IPX 走的就是主站同一个端口的 /ipx/<房间> —— 不用额外开端口，
 * 也就不用为了 1900 去绕开 Cloudflare。
 *
 * 注意用 noServer 模式手动处理 upgrade：同一个服务器上还挂着 socket.io，
 * 不是我们的路径必须原样放过去，不能 destroy。
 */
export function attachIpxToServer(httpServer, { publicHost = 'ipx' } = {}) {
  const wss = new WebSocketServer({ noServer: true, handleProtocols })
  wss.on('error', (e) => console.warn('[ipx] server error:', e.message))

  httpServer.on('upgrade', (req, socket, head) => {
    if (!(req.url || '').startsWith(IPX_PATH)) return // 交给别的监听者（socket.io）
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wire(wss, `${publicHost}:${IPX_PORT}`)
  console.log(`[ipx] DOS 联机中继已启用（与主站同端口）：/ipx/<房间名>`)
  return wss
}

/** 独立端口模式：不打补丁、用原版 js-dos 时走这条 */
export function attachIpx({ port = IPX_PORT, host = '127.0.0.1' } = {}) {
  const wss = new WebSocketServer({ port, handleProtocols })
  wss.on('error', (e) => console.warn('[ipx] server error:', e.message))
  wire(wss, `${host}:${port}`)
  console.log(`[ipx] DOS 联机中继已启用：ws://…:${port}${IPX_PATH}<房间名>`)
  return wss
}

function wire(wss, serverAddress) {
  wss.on('connection', (ws, req) => {
    const parts = (req.url || '').split('/')
    // 路径必须是 /ipx/<room>
    if (parts[1] !== 'ipx' || !parts[2]) return ws.close()
    const room = decodeURIComponent(parts[2])
    const address = `${req.socket.remoteAddress}:${req.socket.remotePort}`

    let clients = rooms.get(room)
    if (!clients) rooms.set(room, (clients = new Map()))
    // 同一个地址重连时踢掉旧连接
    clients.get(address)?.close()
    clients.set(address, ws)
    ws.on('error', (e) => console.warn('[ipx] socket error:', e.message))

    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      const header = parseHeader(buf)
      if (!header) return

      // 注册：客户端问「我的地址是多少」
      if (header.dest.socket === 0x2 && header.dest.host === 0) {
        ws.send(registrationReply(address, serverAddress))
        return
      }

      if (header.dest.host === 0xffffffff) {
        for (const [, peer] of clients) if (peer !== ws && peer.readyState === peer.OPEN) peer.send(buf)
      } else {
        const peer = clients.get(partsToAddress(header.dest.host, header.dest.port))
        if (peer && peer.readyState === peer.OPEN) peer.send(buf)
      }
    })

    ws.on('close', () => {
      clients.delete(address)
      if (clients.size === 0) rooms.delete(room)
    })
  })

}

/** 给测试和监控用 */
export function ipxStats() {
  return [...rooms.entries()].map(([room, clients]) => ({ room, players: clients.size }))
}
