# 8BitGo SmartFoxServer 1.x 开发者接入文档

> 适用范围：SAS: Zombie Assault 3（SAS3）的 SmartFoxServer 1.x 联机通信。  
> 公网入口：`https://8bitgo.com`  
> 协议标识：`SmartFoxServer 1.x`  
> 文档基线：2026-09-25

8BitGo 提供一条 WebSocket ↔ SmartFoxServer TCP 的透明字节桥。它适合：

- 在 Ruffle 中运行原版 SAS3 SWF；
- 已经会生成和解析 SmartFoxServer 1.x 数据的浏览器、桌面或 Linux 客户端；
- 启动前发现公开连接地址，以及检查联机 sidecar 是否就绪。

它不是一套新的房间 REST API，也不会把 SmartFoxServer 数据翻译成 JSON。客户端仍需理解 SAS3 原本使用的 SFS 1.x 协议。

机器可读规格见 [`deploy/sfs/openapi.yaml`](../deploy/sfs/openapi.yaml)；服务器私有化部署见 [`deploy/sfs/README.md`](../deploy/sfs/README.md)。
AGI 在线存档与 SFS 联机的统一入口见 [`agi-sfs-api.md`](./agi-sfs-api.md)。

---

## 1. 产品约定

| 项目 | 当前值 |
| --- | --- |
| 配置发现 | `GET https://8bitgo.com/api/sfs/config` |
| 状态检查 | `GET https://8bitgo.com/api/sfs/status` |
| 浏览器联机 | `wss://8bitgo.com/sfs/sas3` |
| 协议 | SmartFoxServer 1.x 原始字节流 |
| 鉴权 | 三个入口都不使用 8BitGo access token |
| 准入 | 浏览器按 `Origin` 白名单；再按 IP 和全局连接数限制 |
| 当前游戏 slug | `sas3`、`sas-zombie-assault-3` |
| 运行时配置缓存 | 服务端回应 `no-store`；调用方不应长期固化地址 |

`games`、`websocket.url` 和限额以 `/api/sfs/config` / `/api/sfs/status` 的实时响应为准。客户端应忽略不认识的新字段，不要对整个 JSON 做完全等值比较。

### 1.1 浏览器 Origin 白名单

8BitGo 当前只允许经过白名单的网页建立 SFS WebSocket。第三方网站接入前，需向 8BitGo 管理员提供精确 Origin，例如：

```text
https://games.example.com
```

Origin 由“协议 + 主机 + 端口”组成，不包含路径。`https://games.example.com/app` 不是有效的 Origin 配置值。
管理员需把它同时加入 HTTP CORS（`ALLOWED_ORIGINS`）和 WebSocket（`SFS_ALLOWED_ORIGINS`）两份白名单；只配一份会出现“能取配置但握手 403”或相反的半通状态。

- 浏览器从非白名单站点请求 `/api/sfs/config` 时会被 CORS 拦截；
- WebSocket 握手的 `Origin` 不在白名单时返回 `403`；
- 桌面、Linux 等非浏览器客户端通常不发 `Origin`，可以直接使用 WSS，但仍受连接数限制。

不要为省略申请流程伪造 `Origin`。原生客户端应当不发这个头，网页客户端则交给浏览器生成。

---

## 2. 快速接入

### 2.1 先取运行时配置

```http
GET /api/sfs/config HTTP/1.1
Host: 8bitgo.com
Accept: application/json
```

当前启用状态的典型响应：

```json
{
  "enabled": true,
  "protocol": "SmartFoxServer 1.x",
  "games": ["sas3", "sas-zombie-assault-3"],
  "websocket": {
    "path": "/sfs/sas3",
    "url": "wss://8bitgo.com/sfs/sas3"
  },
  "native": null,
  "ruffle": {
    "socketProxy": [
      {
        "host": "sas3server.ninjakiwi.com",
        "port": 444,
        "proxyUrl": "wss://8bitgo.com/sfs/sas3"
      }
    ]
  }
}
```

当旁路关闭时，该接口仍返回 HTTP `200`：

```json
{
  "enabled": false,
  "protocol": "SmartFoxServer 1.x",
  "games": ["sas3", "sas-zombie-assault-3"],
  "websocket": null,
  "native": null,
  "ruffle": {}
}
```

调用方必须先看 `enabled`，不能用 HTTP 状态码代替业务开关。如果旁路关闭或配置请求失败，游戏应继续单机启动，不要让一项可选的联机能力阻塞整个游戏。

### 2.2 Ruffle 接入（推荐）

SAS3 SWF 会连接它原本写死的 `sas3server.ninjakiwi.com:444`。将响应中的 `ruffle` 对象原样合并进 Ruffle `load()` 配置，Ruffle 会用 `socketProxy` 把这条连接转到 8BitGo WSS 桥。

```js
async function loadSas3(player, swfUrl) {
  const response = await fetch('https://8bitgo.com/api/sfs/config', {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`SFS config HTTP ${response.status}`)

  const config = await response.json()
  const sfs = config.enabled && config.ruffle ? config.ruffle : {}

  await player.ruffle().load({
    url: swfUrl,
    autoplay: 'on',
    ...sfs,
  })
}
```

如果你的 Ruffle 配置已经有 `urlRewriteRules`，不要简单展开后覆盖其中一份。应按条目合并：

```js
const rewriteRules = [
  ...(Array.isArray(existing.urlRewriteRules) ? existing.urlRewriteRules : []),
  ...(Array.isArray(config.ruffle?.urlRewriteRules) ? config.ruffle.urlRewriteRules : []),
]

await player.ruffle().load({
  url: swfUrl,
  ...existing,
  ...config.ruffle,
  ...(rewriteRules.length ? { urlRewriteRules: rewriteRules } : {}),
})
```

`urlRewriteRules` 只有在 8BitGo 配置了有权分发的 SAS3 外部地图资源时才会出现。客户端不应假定它一定存在。

### 2.3 自定义浏览器 / WebSocket 客户端

只有在客户端本身会生成和解析 SmartFoxServer 1.x 数据时，才应直接使用 WebSocket：

```js
async function connectSfs() {
  const response = await fetch('https://8bitgo.com/api/sfs/config', {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  const config = await response.json()
  if (!response.ok || !config.enabled || !config.websocket?.url) {
    throw new Error('8BitGo SmartFoxServer 当前不可用')
  }

  const socket = new WebSocket(config.websocket.url)
  socket.binaryType = 'arraybuffer'

  socket.addEventListener('open', () => {
    // sfsPacketBytes 必须是你的 SFS 1.x 客户端生成的原始字节。
    // socket.send(sfsPacketBytes)
  })

  socket.addEventListener('message', (event) => {
    const bytes = new Uint8Array(event.data)
    // 将字节追加到 SFS 1.x 流解析器，不要把一个 message 当成一个完整业务包。
    // sfsParser.push(bytes)
  })

  return socket
}
```

传输约定：

1. 客户端应发送二进制 WebSocket 帧，内容是 SFS 1.x 原始字节，不是 JSON、Base64 或额外封装。
2. 发送的一帧会被顺序写入 TCP，但接收边界来自 TCP `data` 分块。一条 SFS 消息可能被拆成多帧，多条消息也可能合在一帧。
3. 客户端必须使用流式解析器，不能依赖 WebSocket 消息边界。
4. 桥不修改、不解密、不伪造 SFS 包，也不提供房间列表的 HTTP 替代接口。

### 2.4 原生 / Linux / 桌面客户端

原生客户端有两种方式：

1. **推荐：**像浏览器一样连接 `websocket.url`，并在 WebSocket 上发送 SFS 1.x 字节流。
2. **可选的裸 TCP：**只有 `/api/sfs/config` 的 `native` 非 `null` 时才可使用返回的 `host` / `port`。

当前生产配置的 `native` 是 `null`。不要猜测 `8bitgo.com:444`，也不要连接内部的 `8044`端口。`8044` 只允许 8BitGo 主 API 在回环网络上使用。

原始 SAS3 SWF 不会读取 `/api/sfs/config`，也不理解 `native`字段。若在原生 Flash Player 中运行未修改的 SWF，需要启动器做 DNS/hosts 映射，或依法重打包 SWF 的服务器地址。

---

## 3. 状态与容量

```http
GET /api/sfs/status HTTP/1.1
Host: 8bitgo.com
Accept: application/json
```

典型响应：

```json
{
  "enabled": true,
  "ready": true,
  "protocol": "SmartFoxServer 1.x",
  "games": ["sas3", "sas-zombie-assault-3"],
  "upstream": {
    "reachable": true,
    "checkedAt": "2026-09-25T03:59:28.065Z"
  },
  "connections": {
    "active": 0,
    "accepted": 12,
    "rejected": 1,
    "limit": 200,
    "perIpLimit": 8
  },
  "traffic": {
    "fromClient": 10240,
    "fromUpstream": 32768
  },
  "lastUpstreamConnectedAt": "2026-09-25T03:59:28.065Z"
}
```

| 字段 | 含义 |
| --- | --- |
| `enabled` | 运维开关是否打开 |
| `ready` | 开关打开，且最近一次 TCP 探测能到达 Java sidecar |
| `upstream.reachable` | 最近一次上游可达性结果；探测结果最多复用约 5 秒 |
| `connections.active` | 当前 WebSocket 会话数 |
| `connections.accepted` / `rejected` | 当前 Node 进程生命周期内的累计值 |
| `connections.limit` | 全局同时连接上限 |
| `connections.perIpLimit` | 单个公网 IP 同时连接上限 |
| `traffic.*` | 当前 Node 进程生命周期内桥接的字节数 |
| `lastUpstreamConnectedAt` | 最近一次成功建立上游 TCP 的时间；从未成功时为 `null` |

`ready: true` 是瞬时健康信号，不会预留连接名额。客户端仍要处理握手后上游暂时失效的情况。

---

## 4. WebSocket 握手、限额与断线

### 4.1 HTTP 升级结果

| HTTP 状态 | 含义 | 建议处理 |
| --- | --- | --- |
| `101` | WebSocket 升级成功 | 开始 SFS 1.x 会话 |
| `403` | 浏览器 `Origin` 不在白名单 | 不要重试；申请加入白名单 |
| `429` | 全局或单 IP 连接数达到上限 | 退避后重试，并检查是否泄漏旧连接 |
| `503` | SFS 旁路关闭 | 回到单机；之后重新读取 `/config` |
| `404` | 路径错误或未经正确反代 | 重新读取 `websocket.url`，不要写死推导路径 |

### 4.2 已连接后的常见关闭码

| WebSocket code | 含义 |
| --- | --- |
| `1013` | 上游不可用、连接超时或缓冲拥塞；可以退避后重试 |
| `1011` | 上游 SmartFoxServer 关闭了连接 |
| `1006` | 异常断开，常见于网络丢失、心跳超时或进程切换 |

运行时默认约束（以 `/status` 和线上配置为准）：

- 全局同时连接：200；
- 单 IP 同时连接：8；
- 单个 WebSocket 帧：64 KiB；
- 单向拥塞缓冲：512 KiB；
- 上游建连超时：3 秒；
- SFS TCP 空闲超时：4 小时；
- WebSocket ping/pong 周期：约 30 秒。浏览器会自动回 pong，不要在业务层再伪造 SFS 心跳代替它。

客户端必须在离开游戏、切换账号或重新建局时主动关闭旧 WebSocket。

### 4.3 重试策略

推荐使用带抖动的指数退避：1s、2s、4s、8s，上限 30s。仅对网络失败、`1013`、`1006` 和可恢复的 `5xx` 重试。

- `403`：配置问题，立即停止重试；
- `429`：至少等待 10 秒，且检查旧连接是否正常释放；
- `503` 或 `enabled:false`：单机继续，30 秒后再取配置；
- 配置请求自身失败：不得阻塞游戏启动，5 秒后再试。

---

## 5. 真实游玩上报（可选）

SFS TCP 连接数不能当作游玩人数：掉线重连、进大厅和进对局都可能产生新连接，而 SFS 桥不知道用户的 8BitGo 账号。

第三方启动器若希望把真实游玩计入 8BitGo，应在游戏**首次真正可操作**后上报一次：

```http
POST /api/open/v1/games/sas-zombie-assault-3/play HTTP/1.1
Host: 8bitgo.com
Authorization: Bearer <用户级 access token，含 library.write>
```

成功响应：

```json
{ "ok": true, "counted": true }
```

同一账号跨设备重复上报同一游戏时，`counted` 为 `false`，但仍会刷新“最近玩过”。请不要在 WebSocket 重连时反复上报。
该接口只接受已在 8BitGo 公开发布的游戏；游戏仍在预发布或隐藏状态时会返回 `404 not_found`，客户端不应重试。

用户级令牌、设备码流程和错误格式见 [`docs/esp-open-api.md`](./esp-open-api.md)。

---

## 6. 故障排查

| 现象 | 首先检查 | 处理 |
| --- | --- | --- |
| `/config` 返回 `enabled:false` | SFS 是否正在维护 | 单机启动，之后重新取配置 |
| `/status` 的 `ready:false` | `upstream.reachable` | 不要连续重连；等待 sidecar 恢复 |
| 浏览器握手 `403` | 开发者工具中的 `Origin` | 申请精确 Origin 白名单 |
| 握手 `429` | 同页面是否重复创建 socket | 关闭旧连接，退避后再试 |
| HTTPS 页面报 mixed content | 是否写死了 `ws://` | 每次使用 `/config` 返回的 `wss://` URL |
| WebSocket 已连，但协议无响应 | 是否发了 JSON/文本，或按 WS 帧边界拆包 | 改用 SFS 1.x 原始字节和流式解析 |
| 能进标题画面，地图一直加载 | `ruffle.urlRewriteRules` 与地图 SWF 是否完整 | SFS 只处理联机协议，不会补齐游戏资源 |
| 连接几十秒后被断开 | 客户端是否正常处理 WebSocket ping/pong | 使用标准 WebSocket 库，不要屏蔽协议级 pong |
| `101` 后立即收到 `1013` | Java sidecar 在握手瞬间不可达或拥塞 | 指数退避，同时查 `/status` |

---

## 7. 安全、兼容与法务

- WSS 入口本身不使用 8BitGo 用户令牌。不要把 access token 放进 WebSocket URL、子协议或 SFS 数据包。
- 不要绕过发现接口直连源站 IP 或内部 TCP 端口；这些都不是公开稳定接口。
- 当前桥只对 SAS3 的 SFS 1.x 交通做过验证。不要将 `protocol` 相同等同于任意 SmartFox 游戏都可接入。
- 自动化监控应使用 `/api/sfs/status`，不要为探活持续建立真实 WebSocket 会话。
- 8BitGo 提供传输与兼容接口，不因此授予 SAS3、SWF、地图或其它游戏资源的版权。接入方必须自行确保有权使用和分发相关内容。

---

## 8. 发布前检查清单

- [ ] 通过 HTTPS 实时读取 `/api/sfs/config`；
- [ ] 确认当前 slug 出现在 `games` 里；
- [ ] 网页的精确 Origin 已加入白名单；
- [ ] 只向 WebSocket 发送 SFS 1.x 原始字节；
- [ ] 接收端按字节流解析，不依赖 WebSocket 帧边界；
- [ ] 处理 `403` / `429` / `503` 和 `1013` / `1011` / `1006`；
- [ ] 旁路失效时单机游戏仍能启动；
- [ ] 离开游戏时主动关闭 socket；
- [ ] 仅在游戏首次可操作后上报真实游玩；
- [ ] 已确认游戏与地图资源的使用授权。
