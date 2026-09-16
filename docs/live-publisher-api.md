# 8BitGo 外部设备直播发布协议（Linux / 掌机 / 桌面客户端）

> 协议版本：`8bitgo-live-v1`。画面和声音走 WebRTC 点对点；8BitGo 服务端只转发
> Socket.IO 信令，不接收 RTMP/SRT，也不转码视频。

## 1. 完整流程

1. 应用申请用户级 `live.write`，用设备码流程取得用户 access token。
2. `POST /api/open/v1/live/publish-token` 换专用发布凭证和接入配置。
3. `GET /api/open/v1/live/capacity`；满位时跳过自动开播，游戏继续运行。
4. 请求响应里的 `ice_url`，把 `iceServers` 交给每一条 `RTCPeerConnection`。
5. 用 Socket.IO 4.x 连接 `signaling_url`，握手传 `{publisherToken}`。
6. 发送 `go-live` 创建房间，保存返回的 `roomId` 和续播 `token`。
7. 收到 `viewer-joined` 后，为该观众创建一条 PeerConnection，添加画面/声音轨并发送 offer。
8. 通过 `signal` 双向转发 SDP 和 ICE；每位观众各有一条 PeerConnection。
9. 主动结束时发送 `stop-live`。信令重连后用 `resume-live` 接回原房间。

直播间默认最多 12 位观众。因为主播给每位观众单独推一路，上行带宽和编码开销近似按观众数
线性增长；要做几十人以上需要另加 SFU，不能只调大这个数字。

## 2. 领取发布凭证

```bash
curl -X POST https://8bitgo.com/api/open/v1/live/publish-token \
  -H "Authorization: Bearer $BITGO_ACCESS_TOKEN"
```

```json
{
  "publisher_token": "eyJ...",
  "token_type": "LivePublisher",
  "expires_in": 43200,
  "protocol": "8bitgo-live-v1",
  "signaling_url": "https://8bitgo.com/live",
  "socket_path": "/socket.io",
  "namespace": "/live",
  "auth_field": "publisherToken",
  "capacity_url": "https://8bitgo.com/api/open/v1/live/capacity",
  "ice_url": "https://8bitgo.com/api/netplay/ice"
}
```

发布凭证不要写进日志、URL 或命令行参数。它只能开播，不能读取收藏、存档或其它用户数据；
默认有效 12 小时。OAuth access token 仍只有 15 分钟，领取成功后不应继续交给直播模块。

## 3. 容量预检、Socket.IO 握手与开房

先请求响应里的 `capacity_url`，做一次无鉴权、无缓存的容量预检：

```http
GET /api/open/v1/live/capacity HTTP/1.1
Host: 8bitgo.com
```

```json
{
  "used": 37,
  "max": 200,
  "remaining": 163,
  "available": true
}
```

`used` 使用服务端真实房间数，包含已经从大厅隐藏、但仍在等待主播恢复或尚未关闭的房间。
不要用 `/v1/live/rooms` 的数组长度推算容量。

这个请求只给出瞬时快照，**不会预留席位**。`available: true` 后仍可能有别的客户端先开房，
所以 `go-live` 回调的 `server is full` 必须处理。自动开播在 `available: false` 时应结束开播流程，
不要启动抓屏、取 ICE 或连接 Socket.IO；游戏本身继续运行。容量请求超时或暂时失败时可以继续
尝试 `go-live`，由服务端最终裁决。

```js
import { io } from 'socket.io-client'

const socket = io(config.signaling_url, {
  path: config.socket_path,
  transports: ['websocket', 'polling'],
  auth: { publisherToken: config.publisher_token },
})

socket.emit('go-live', {
  title: 'Linux 掌机实况',
  gameSlug: 'contra',
  gameName: 'Contra',
  platform: 'nes',
}, (error, session) => {
  if (error) throw new Error(error)
  // 安全保存；断线接回房间时两项都要用。
  console.log(session.roomId, session.token)
})
```

成功回调的 `session` 是 `{roomId, token}`：`roomId` 可以公开分享，`token` 是断线续播凭证，
必须按秘密保存。失败回调目前可能返回：

| error | 含义 | 客户端处理 |
|---|---|---|
| `server is full` | 全站直播房间已满 | 本局不开播；稍后或下次启动再检查 |
| `too many rooms` | 当前公网 IP 同时开的房间达到上限 | 停止自动重试，避免重试风暴 |
| `already in a room` | 这条 Socket 已在直播或观看房间中 | 复用当前会话，或先 `leave` / `stop-live` |
| `already opening a room` | 同一条 Socket 重复并发发送 `go-live` | 等待第一次调用的回调 |
| `publisher account unavailable` | 发布账号不存在或已被封禁 | 停止发布并要求重新登录/联系管理员 |
| `failed` | 服务端处理时出现意外错误 | 指数退避后重试，并保留日志 |

预检和 `go-live` 的关系是“减少无效工作 + 最终一致性”：前者避免已知满位时启动昂贵的采集，
后者才是权威准入。客户端不能因为预检返回空位就假定房间已经创建。

设备发布凭证绑定用户和应用。`hostName` 即使上传也不会采信，服务端会使用账号昵称。

握手失败时 Socket.IO 的 `connect_error.data.code`：

| code | 含义 |
|---|---|
| `invalid_publisher_token` | 凭证伪造或过期，重新用用户 access token领取 |
| `publisher_auth_unavailable` | 服务器尚未配置开放平台 RSA 密钥 |

## 4. WebRTC 信令

### 服务端发给主播

| 事件 | 数据 | 动作 |
|---|---|---|
| `viewer-joined` | `{viewerId, replaces?}` | 为 viewerId 新建 PeerConnection；若有 replaces，先释放旧连接 |
| `viewer-rebound` | `{from,to}` | 观众只换了信令 socket；连接仍活着时把映射键改成 to |
| `viewer-left` | `{viewerId}` | 关闭并删除该观众的 PeerConnection |
| `signal` | `{from,data}` | 处理观众的 answer 或 ICE candidate |
| `viewers` | `{count,list}` | 更新人数；list 不包含 socket id |
| `live-ended` | `{roomId,reason}` | 服务端已收房，释放采集和所有 PeerConnection |

### 主播发给服务端

主播给某位观众发送 offer：

```js
socket.emit('signal', {
  target: viewerId,
  data: { sdp: peer.localDescription.toJSON(), gen: connectionGeneration },
})
```

发送 trickle ICE：

```js
socket.emit('signal', {
  target: viewerId,
  data: { candidate: candidate.toJSON(), gen: connectionGeneration },
})
```

收到 `signal` 时，`data.sdp` 必须是观众的 `answer`；`data.candidate` 在
`setRemoteDescription()` 完成前要先排队，WebRTC 不会重发丢掉的候选。

每个 `signal.data` 只能包含 `sdp`、`candidate`、`error` 三者之一，可额外带非负整数 `gen`。
SDP 上限 128 KB，ICE candidate 字符串上限 4096 字符；服务端还会做速率限制。

## 5. 断线续播

Socket.IO 重连后，用开房时保存的房号与续播令牌：

```js
socket.emit('resume-live', {
  roomId: savedRoomId,
  token: savedResumeToken,
}, (error, result) => {
  if (error) throw new Error(error)
  // result.viewers 是仍在房里的观众 id；缺失的旧连接应释放，存在但已断的应重新 offer。
})
```

外部设备房间还要求新连接携带同一用户、同一应用的有效 `publisherToken`。因此别人即使拿到
房间续播 token，也不能接管直播。发布凭证即将过期时，可在 OAuth access token 仍有效时提前
换新票；已建立的直播不会因为票到期被强行掐断，但过期票无法重新握手。

## 6. Linux 采集建议

- Wayland：优先用 PipeWire/xdg-desktop-portal；不要假设能直接抓 `/dev/fb0`。
- X11：可用 FFmpeg/GStreamer 的 `x11grab`，音频从 PipeWire 或 PulseAudio monitor 获取。
- 掌机/嵌入式：把模拟器输出纹理或 DMA-BUF 直接接硬件编码器，避免“GPU → CPU → GPU”拷贝。
- WebRTC 库可选 GStreamer `webrtcbin`、libwebrtc、Pion、aiortc 或浏览器 WebView；信令层只要求
  能使用 Socket.IO 4.x，并按上面的事件交换标准 SDP/ICE。
- 编码优先 H.264 constrained baseline 或 VP8；观众是浏览器，使用冷门硬件私有编码会协商失败。
- 没有观众时可以暂停采集/编码，但保持 Socket.IO 连接；收到第一位 `viewer-joined` 再启动编码。

## 7. 与游玩统计配合

直播与游玩统计是两件事。游戏真正进入可玩状态后，设备仍应单独调用：

```http
POST /api/open/v1/games/<slug>/play
Authorization: Bearer <带 library.write 的用户 access token>
```

同一账号跨网页、Linux 客户端和其它设备只统计一次，并同步“最近在玩”。
