/**
 * 站内消息（腾讯云即时通信 IM）的客户端。
 *
 * ## 它在整个结构里的位置
 *
 *   顶栏按钮 ChatButton ──> services/im.ts（接缝：开关 + 未读数，零 import）
 *   抽屉 ImPanel ─────────> **本文件** ──动态 import──> @tencentcloud/chat
 *                              └──────> services/imSession.ts（状态机 + epoch，零 import）
 *   服务端 /api/im/sig ────────┘（只签发短期 UserSig，密钥不出服务器）
 *
 * ## 为什么 SDK 是动态 import
 *
 * `@tencentcloud/chat` 3.6.7 的产物 700 KB 上下。本文件被抽屉静态引用、抽屉被 Layout
 * 静态引用，写成顶层 import 这 700 KB 就进主包 —— 没登录、根本看不到那颗按钮的访客
 * 也要下载。顶部那个是 `import type`，编译后整行消失，别改成值导入。
 *
 * ## 2026-09-07 自查修掉的几件事（都不是理论问题）
 *
 * 1. **跨账号冒充（致命）**。第一版用一个裸的 `starting` promise 防重入，既不记它属于谁、
 *    也没有 await 之后的存活检查。A 的连接在飞时登出、B 登录后再连，会**原样拿到 A 那次**
 *    带着 A 的 sig 的连接 —— B 看到 A 的会话、以 A 的身份发消息。
 *    现在交给 imSession.ts 的 epoch 机制，并且**每跨一个 await 都问一次 isStale**。
 * 2. **监听泄漏 / 重复注册**。`TencentCloudChat.create()` 是按 SDKAppID **缓存实例**的
 *    （源码：`if(o&&Fr[o])return Fr[o]`），destroy() 没走完就再 create 会拿到同一个
 *    事件发射器，于是每个事件的处理器**翻倍**且再也解不掉。现在把 handler 存起来，
 *    拆的时候逐个 off()。
 * 3. **未连接时静默假成功**。`sendImText` 原来在 `chat` 为 null 时返回 null，
 *    调用方当成功处理 —— 消息看起来发出去了，其实一个字节都没走。现在一律抛。
 * 4. **profile 每次重连都重写一遍**。SDK_READY 不是一次性的（断网、休眠唤醒都会再来），
 *    每次都写一遍完全相同的昵称。现在只在内容变了才写。
 *
 * ## 后台也要能收到消息
 *
 * 连接不依赖抽屉开着：登录后空闲时就建立，抽屉只是个视图。此外做了两件事：
 *   · **标题未读数**：`(3) 8BitGo — …`。标签页在后台时用户只看得到标题，这是唯一
 *     不需要授权就能提醒的通道（浏览器通知要权限，没经用户同意不该弹）。
 *   · **回到前台自检**：桌面浏览器会限制后台标签页的定时器，移动端更会直接冻结整个页面，
 *     SDK 的心跳可能已经断了而它自己还不知道。切回来时如果状态不是 ready 就重连。
 * ⚠️ 移动端浏览器把后台标签页彻底冻结时，任何前端手段都收不到消息 —— 那需要
 *    离线推送（腾讯的 push 服务 + Service Worker），属于另一个量级的接入，本版没有。
 */
import type TencentCloudChatSDK from '@tencentcloud/chat'
import { api, apiEnabled, ApiError } from './api'
import { getCurrentUser } from './auth'
import { getImUnread, imUnreadLabel, onImChange, registerImOpener, setImUnread } from './im'
import { imState, invalidate, isStale, setState, setStateIf, startOnce } from './imSession'

// 状态相关的读接口原样透传，让 UI 只认这一个模块
export { imState, imStateDetail, onImStateChange, type ImState } from './imSession'

/* ---------------- 对外的数据形状 ---------------- */

/** 一条会话（本版只有单聊） */
export interface ImConversation {
  /** 腾讯的 conversationID，形如 C2Cu_0123456789ab */
  id: string
  /** 对方的 userID = 本站的 users.id */
  peerId: string
  /** 对方昵称。对方没登录过 IM 时可能是空的，UI 自己兜底 */
  nick: string
  /** 对方头像。本站的头像是 emoji，所以这里通常是一个字 —— UI 直接当文字画 */
  avatar: string
  lastText: string
  /** 秒级时间戳；拿不到时是 0，UI 据此不显示时间 */
  lastTime: number
  unread: number
}

export interface ImMessage {
  id: string
  mine: boolean
  text: string
  time: number
  status?: 'sending' | 'failed'
}

/** 没连上就调发送/拉取时抛这个。UI 据此提示「未连接」而不是假装成功 */
export class ImNotConnectedError extends Error {
  constructor() {
    super('IM 未连接')
    this.name = 'ImNotConnectedError'
  }
}

/* ---------------- 内部状态 ---------------- */

type ChatNS = typeof TencentCloudChatSDK
type Chat = NonNullable<ReturnType<ChatNS['create']>>

let TC: ChatNS | null = null
let chat: Chat | null = null
/**
 * 当前这条连接属于哪个 userID。
 *
 * ⚠️ 取的是**服务端签发时用的那个 id**（sig.userId，源头是 req.user.id），
 * 不是前端缓存的 user.id —— 后者在 hydrateAuth 落地前可能是 localStorage 里的旧值，
 * 而这个字段正是换账号判断要比对的东西，用错了等于判断失效。
 */
let boundUserId = ''
/** 已注册到 SDK 的事件处理器。拆连接时要逐个 off()，见文件头第 2 条 */
let handlers: Array<[string, (...args: never[]) => void]> = []
let unregisterOpener: (() => void) | null = null
/** 抽屉挂载时把「怎么打开我」交上来 */
let panelOpener: (() => void) | null = null
/** 上一次同步给腾讯的 昵称|头像。相同就不再写 */
let syncedProfile = ''

const convListeners = new Set<() => void>()
const msgListeners = new Set<(conversationId: string) => void>()
const dmListeners = new Set<() => void>()

/** 拷一份再遍历：监听者在回调里退订是常事（React 的 cleanup 就会） */
function emitVoid(set: Set<() => void>) {
  for (const fn of [...set]) {
    try {
      fn()
    } catch {
      /* 一个监听者炸了不该连累其他人 */
    }
  }
}
function emitConv(id: string) {
  for (const fn of [...msgListeners]) {
    try {
      fn(id)
    } catch {
      /* 同上 */
    }
  }
}

export function onImConversationsChange(fn: () => void): () => void {
  convListeners.add(fn)
  return () => convListeners.delete(fn)
}
export function onImMessagesChange(fn: (conversationId: string) => void): () => void {
  msgListeners.add(fn)
  return () => msgListeners.delete(fn)
}
/** 有人请求「打开某个人的私信」时通知。抽屉已经开着时也要能响应，所以单独一路 */
export function onImDmRequest(fn: () => void): () => void {
  dmListeners.add(fn)
  return () => dmListeners.delete(fn)
}

/* ---------------- 抽屉的注册 ---------------- */

/**
 * 抽屉挂载时调这个。返回注销函数。
 *
 * 和 services/im.ts 的 registerImOpener 分两层：那一层是给顶栏按钮看的
 * 「IM 到底接上了没有」，只有真连上才注册；这一层是本文件内部知道「抽屉在哪」。
 * 抽屉一直挂着，连接却是空闲时才建立，两者时机不同。
 */
export function registerImPanel(fn: () => void): () => void {
  panelOpener = fn
  return () => {
    // 严格模式下 effect 会跑两遍（挂、卸、再挂），不判一下会把新的那次注销掉
    if (panelOpener === fn) panelOpener = null
  }
}

function publishOpener() {
  if (unregisterOpener) return
  unregisterOpener = registerImOpener(() => {
    panelOpener?.()
  })
}

function retractOpener() {
  unregisterOpener?.()
  unregisterOpener = null
  setImUnread(0)
}

/* ---------------- 连接 ---------------- */

interface SigResponse {
  sdkAppId: number
  userId: string
  userSig: string
  expiresAt: number
}

/**
 * 连上 IM。可以随便重复调用。
 *
 * 返回 false 的几种情况都是「正常地不可用」，不是异常：没登录、纯前端模式、
 * 后端没配（/api/im/sig 回 501）、以及**这次尝试已经被更新的一代作废**。
 * 前几种下顶栏保持占位面板，和接入之前的行为一致。
 */
export function ensureImStarted(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false)
  const user = getCurrentUser()
  if (!user || !apiEnabled()) return Promise.resolve(false)
  if (chat && boundUserId === user.id && imState() === 'ready') return Promise.resolve(true)

  return startOnce(user.id, async (epoch) => {
    setStateIf(epoch, 'connecting')

    // 换账号：先把旧连接彻底收掉，否则会拿着 A 的连接读 B 的会话
    if (chat) await teardown()
    if (isStale(epoch)) return false

    let sig: SigResponse
    try {
      sig = await api.get<SigResponse>('/api/im/sig')
    } catch (e) {
      if (isStale(epoch)) return false
      // 501 = 后端没配。不是错误，是「功能没开」—— UI 不报红，顶栏继续显示占位面板
      if (e instanceof ApiError && e.status === 501) {
        setStateIf(epoch, 'unavailable')
        return false
      }
      console.warn('[im] 取凭证失败：', e)
      setStateIf(epoch, 'error', e instanceof Error ? e.message : String(e))
      return false
    }
    if (isStale(epoch)) return false

    try {
      const mod = await import('@tencentcloud/chat')
      if (isStale(epoch)) return false
      // UMD 产物经 Vite 的 CJS 互操作后具名导出挂在 default 上；两种形状都兜一下，
      // 免得换成 ESM 产物或升级 Vite 时这里静默拿到 undefined
      TC = ((mod as { default?: ChatNS }).default ?? (mod as unknown as ChatNS)) as ChatNS
      const created = TC.create({ SDKAppID: sig.sdkAppId })
      if (!created) throw new Error('TencentCloudChat.create 返回空 —— SDKAppID 不合法？')
      // 日志等级 1 = 只留 release 级别。默认 0 会往控制台刷大量 SDK 内部日志，
      // 而这个站的控制台本来就有模拟器的输出，叠一层就没法看了。排查时临时改 0。
      created.setLogLevel(1)
      chat = created
      boundUserId = sig.userId
      wireEvents(created, epoch)
      await created.login({ userID: sig.userId, userSig: sig.userSig })
    } catch (e) {
      console.warn('[im] 连接失败：', e)
      await teardown()
      setStateIf(epoch, 'error', e instanceof Error ? e.message : String(e))
      return false
    }

    // login 兑现之后这一代可能已经作废了（登出、换账号）。此时**必须把已经建立的连接
    // 拆掉** —— 光把 chat 置空没用：SDK 按 SDKAppID 缓存实例，而它已经登录成功了
    if (isStale(epoch)) {
      await teardown()
      return false
    }

    // 注意：login 兑现 ≠ 可以发消息。要等 SDK_READY（见 wireEvents），所以这里
    // **不**把状态改成 ready
    return true
  })
}

/**
 * 拆掉当前连接：先逐个 off()，再 logout + destroy。
 *
 * off 那一步是必须的，不是洁癖：create() 按 SDKAppID 缓存实例，destroy() 没走完
 * 就再 create 会拿到同一个事件发射器 —— 处理器翻倍，而且没有句柄再也解不掉。
 */
async function teardown(): Promise<void> {
  const c = chat
  const hs = handlers
  chat = null
  handlers = []
  boundUserId = ''
  TC = null
  syncedProfile = ''
  retractOpener()
  if (!c) return
  for (const [event, fn] of hs) {
    try {
      c.off(event, fn)
    } catch {
      /* 已经 destroy 过时会抛，无所谓 */
    }
  }
  try {
    await c.logout()
  } catch {
    /* 已经掉线时会抛，无所谓 */
  }
  try {
    await c.destroy()
  } catch {
    /* 同上 */
  }
}

/** 退出登录 / 换账号时调。之后顶栏回到占位面板 */
export async function imStop(): Promise<void> {
  invalidate()
  setState('off')
  await teardown()
}

/** 用户点「重新连接」 */
export async function imReconnect(): Promise<boolean> {
  // 必须先 invalidate：不作废的话下面那次 ensureImStarted 会复用正在飞的旧尝试，
  // 而那次的赋值会在 teardown 之后把刚清掉的状态又写回去
  invalidate()
  setState('off')
  await teardown()
  return ensureImStarted()
}

function wireEvents(c: Chat, epoch: number) {
  const T = TC!
  const E = T.EVENT
  const on = (event: string, fn: (...args: never[]) => void) => {
    handlers.push([event, fn])
    c.on(event, fn)
  }
  /** 事件回调跑在这一代之外，所以每个都先确认自己还算数 */
  const live = () => !isStale(epoch) && chat === c

  on(E.SDK_READY, () => {
    if (!live()) return
    setState('ready')
    publishOpener()
    // 昵称同步不在服务端签发接口里做（见 routes/im.js）。失败不影响聊天，不 await
    void syncProfile()
    // 这里刻意**不**主动拉会话列表：状态变成 ready 会让抽屉自己去拉。
    // 第一版在这儿多拉了一次且把结果扔掉，而且那次 emit 通常发生在抽屉订阅之前，
    // 纯浪费一个请求。
    emitVoid(convListeners)
  })

  on(E.SDK_NOT_READY, () => {
    // 断线重连中间会经过这个状态。不改成 error：SDK 自己会重试，
    // 报错会让抽屉闪一下红字然后自己好，比不报更让人困惑
    if (live() && imState() === 'ready') setState('connecting')
  })

  /** 未读**总数**由 SDK 报，我们只转发。绝不自己 +1 —— 断线重连后本地累加值一定是错的 */
  on(E.TOTAL_UNREAD_MESSAGE_COUNT_UPDATED, (e: { data: number }) => {
    if (!live()) return
    setImUnread(Number(e.data))
  })

  on(E.CONVERSATION_LIST_UPDATED, () => {
    if (live()) emitVoid(convListeners)
  })

  on(E.MESSAGE_RECEIVED, (e: { data: Array<{ conversationID?: string }> }) => {
    if (!live()) return
    const ids = new Set((e.data ?? []).map((m) => m.conversationID).filter(Boolean) as string[])
    for (const id of ids) emitConv(id)
  })

  /*
    被踢下线。**这里刻意不自动重连**（除了 sig 过期）。

    腾讯控制台的「Web 端最大在线实例数」默认是 1 —— 同一个账号开第二个标签页就会把
    第一个踢掉。这个站用户开多标签是常态（一个在玩、一个在翻游戏库），如果收到
    KICKED_OUT 就自动重登，两个标签会**互相踢来踢去、无限循环**，每轮一次 login 请求，
    很快撞上腾讯的频率限制。所以进 kicked 状态，让用户决定哪个标签在线。
    ⚠️ 真正的解法是去控制台把那个实例数调大。

    USERSIG_EXPIRED 是另一回事 —— sig 过期，重新取一份就好，可以自动。
  */
  on(E.KICKED_OUT, (e: { data: { type: string } }) => {
    if (!live()) return
    const type = e.data?.type ?? ''
    if (type === T.TYPES.KICKED_OUT_USERSIG_EXPIRED) {
      void (async () => {
        invalidate()
        setState('off')
        await teardown()
        await ensureImStarted()
      })()
      return
    }
    void (async () => {
      invalidate()
      // 先改状态再拆：teardown 里的 logout + destroy 是两个网络往返，那段时间里
      // UI 不能还显示 ready —— 否则用户在里面打字，发出去的是静默失败
      setState('kicked', type)
      await teardown()
    })()
  })
}

/**
 * 把本站的昵称和头像同步给腾讯，让对方看到的是人名而不是一串 id。
 *
 * ⚠️ avatar 塞的是**一个 emoji**，不是 URL。腾讯那个字段文档里说是头像地址，但它就是
 * 一个不超过 500 字节的自由字符串，服务端不校验。UI 那边判一下是不是 http 开头，
 * 不是就当文字画 —— 本站的头像本来就是 emoji（users.avatar），没有图片可传。
 *
 * 只在内容变了才写：SDK_READY 不是一次性的，断网、休眠唤醒、切网络都会再来一次，
 * 每次都写一遍完全相同的昵称是在白耗腾讯那边的写频率配额。
 */
async function syncProfile(): Promise<void> {
  const u = getCurrentUser()
  if (!chat || !u) return
  const nick = (u.nickname || '').slice(0, 32)
  const avatar = u.avatar || '🕹️'
  const key = `${nick}|${avatar}`
  if (key === syncedProfile) return
  try {
    await chat.updateMyProfile({ nick, avatar })
    syncedProfile = key
  } catch (e) {
    console.warn('[im] 昵称同步失败（不影响聊天）：', e)
  }
}

/* ---------------- 会话与消息 ---------------- */

/** C2C 会话 id ↔ 对方 userID */
export const convIdFor = (peerId: string) => `C2C${peerId}`
const peerIdFrom = (convId: string) => (convId.startsWith('C2C') ? convId.slice(3) : '')

interface RawConversation {
  conversationID: string
  type: string
  unreadCount?: number
  userProfile?: { userID?: string; nick?: string; avatar?: string }
  lastMessage?: { lastTime?: number; messageForShow?: string; type?: string; payload?: { text?: string } }
}

function textOfLast(lc: RawConversation['lastMessage'], T: ChatNS): string {
  if (!lc) return ''
  if (lc.type === T.TYPES.MSG_TEXT) return lc.payload?.text ?? lc.messageForShow ?? ''
  // 非文字消息本版不渲染内容，只给个摘要。messageForShow 是 SDK 现成的
  return lc.messageForShow ?? ''
}

/**
 * 拉一次会话列表。只保留单聊 —— 本版没有群。
 *
 * 没连上时**抛**而不是返回空数组：那两种情况在 UI 上完全不同（「还没有消息」
 * 和「连接断了」），返回空数组会把断线渲染成一个空空的收件箱。
 */
export async function listImConversations(): Promise<ImConversation[]> {
  if (!chat || !TC) throw new ImNotConnectedError()
  const T = TC
  const res = (await chat.getConversationList()) as { data?: { conversationList?: RawConversation[] } }
  const list = res?.data?.conversationList ?? []
  return list
    .filter((c) => c.type === T.TYPES.CONV_C2C)
    .map((c) => ({
      id: c.conversationID,
      peerId: c.userProfile?.userID || peerIdFrom(c.conversationID),
      nick: c.userProfile?.nick || '',
      avatar: c.userProfile?.avatar || '',
      lastText: textOfLast(c.lastMessage, T),
      lastTime: Number(c.lastMessage?.lastTime) || 0,
      unread: Number(c.unreadCount) || 0,
    }))
    .sort((a, b) => b.lastTime - a.lastTime)
}

interface RawMessage {
  ID: string
  flow: string
  type: string
  time: number
  status?: string
  isRevoked?: boolean
  payload?: { text?: string }
  messageForShow?: string
}

/**
 * 拉一页历史消息。
 *
 * 腾讯的翻页是**游标式**的：传上一次返回的 nextReqMessageID 拿更早的一页，不能按页码跳。
 * `done` 为真表示已经到最早那条。
 */
export async function listImMessages(
  conversationId: string,
  cursor?: string,
): Promise<{ items: ImMessage[]; cursor: string; done: boolean }> {
  if (!chat || !TC) throw new ImNotConnectedError()
  const T = TC
  const res = (await chat.getMessageList({ conversationID: conversationId, nextReqMessageID: cursor })) as {
    data?: { messageList?: RawMessage[]; nextReqMessageID?: string; isCompleted?: boolean }
  }
  const raw = res?.data?.messageList ?? []
  const items = raw
    // 撤回的消息 SDK 仍然会给。本版不做「XX 撤回了一条消息」的占位，直接不显示
    .filter((m) => !m.isRevoked)
    .map<ImMessage>((m) => ({
      id: m.ID,
      mine: m.flow === 'out',
      text: m.type === T.TYPES.MSG_TEXT ? (m.payload?.text ?? '') : (m.messageForShow ?? ''),
      time: Number(m.time) || 0,
      status: m.status === 'unSend' ? 'sending' : m.status === 'fail' ? 'failed' : undefined,
    }))
  return { items, cursor: res?.data?.nextReqMessageID ?? '', done: Boolean(res?.data?.isCompleted) }
}

/** 发一条文字消息。没连上时抛 ImNotConnectedError —— 绝不静默假成功 */
export async function sendImText(peerId: string, text: string): Promise<ImMessage> {
  if (!chat || !TC) throw new ImNotConnectedError()
  const body = text.trim()
  if (!body) throw new Error('消息为空')
  const msg = chat.createTextMessage({ to: peerId, conversationType: TC.TYPES.CONV_C2C, payload: { text: body } })
  const res = (await chat.sendMessage(msg)) as { data?: { message?: RawMessage } }
  const m = res?.data?.message
  // 这里**不**手动通知会话列表：SDK 自己会发 CONVERSATION_LIST_UPDATED。
  // 第一版两边都发，于是每发一条消息就拉两次会话列表。
  return {
    id: m?.ID ?? `sent-${Date.now()}`,
    mine: true,
    text: body,
    time: Number(m?.time) || Math.floor(Date.now() / 1000),
  }
}

/** 标记整条会话已读。未读总数由 SDK 通过事件报回来，这里不自己减 */
export async function markImRead(conversationId: string): Promise<void> {
  if (!chat) return
  try {
    await chat.setMessageRead({ conversationID: conversationId })
  } catch (e) {
    console.warn('[im] 标记已读失败：', e)
  }
}

/* ---------------- 从别处发起私信 ---------------- */

let pendingDm: { peerId: string; nick: string; avatar: string } | null = null

/**
 * 「给这个人发私信」。评论区点头像走这里。
 *
 * 顺序：寄存对方 -> 确保连上 -> 打开抽屉 + 通知抽屉去取。
 * 中间那步可能几百毫秒（拉 sig + 下 SDK + 登录），所以调用方要给 loading。
 */
export async function requestImDm(peer: { peerId: string; nick?: string; avatar?: string }): Promise<boolean> {
  const me = getCurrentUser()
  if (!me || !peer.peerId || peer.peerId === me.id) return false
  pendingDm = { peerId: peer.peerId, nick: peer.nick ?? '', avatar: peer.avatar ?? '' }
  const ok = await ensureImStarted()
  if (!ok || !panelOpener) {
    // 连不上就别把目标留在那儿 —— 留着会在下一次打开抽屉时把用户莫名带进一个
    // 几分钟前点过的会话。第一版就是这个毛病，而且还会返回 true。
    pendingDm = null
    return false
  }
  panelOpener()
  // 抽屉可能**本来就开着**，此时 open / state 都没变，光靠 effect 的依赖数组是不会
  // 重跑的。所以单独通知一路，让它去 take。
  emitVoid(dmListeners)
  return true
}

/** 抽屉取走寄存的目标（取一次就清掉） */
export function takePendingImDm(): { peerId: string; nick: string; avatar: string } | null {
  const p = pendingDm
  pendingDm = null
  return p
}

/* ---------------- 按邮箱找人 ---------------- */

/** 找人失败的原因。**用 code 而不是文案**：服务端只会说中文，站里有八种语言 */
export type ImLookupCode = 'bad_email' | 'self' | 'not_found' | 'unusable' | 'rate_limited' | 'disabled' | 'failed'

/**
 * 找人失败。
 *
 * `code` 是给 UI 查文案表用的，`message` 是服务端的中文原话 —— 只进 console，
 * 不直接渲染。第一版曾经把 ApiError.message 直接显示出来，结果一个法语用户
 * 收到了一句中文报错。
 */
export class ImLookupError extends Error {
  readonly code: ImLookupCode
  // message 必须显式标成 string：写成 `message = code` 会让 TS 把形参推成 ImLookupCode，
  // 于是传服务端那句中文原话过不了编译
  constructor(code: ImLookupCode, message: string = code) {
    super(message)
    this.name = 'ImLookupError'
    this.code = code
  }
}

export interface ImPeer {
  id: string
  nickname: string
  avatar: string
}

/** 和服务端 im-lookup.js 里那条保持一致。前端先判一次，省掉一次必然失败的往返和一次限流额度 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * 按注册邮箱找一个人，用来主动发起会话。
 *
 * ⚠️ 这里**只查人，不建会话**。腾讯的 C2C 会话是「发出第一条消息时才真正存在」的，
 * 所以查到之后前端直接进一个空会话就行 —— 不需要、也没有「创建会话」这个调用。
 * ChatView 首屏拉历史会失败（服务端还没有这条会话），那条路径已经处理过了：
 * 见它 fetchLatest 里 `if (first) setDone(true)` 那段注释。
 *
 * 邮箱在这里就 trim + 转小写，和服务端 normalizeLookupEmail 同一套规则 ——
 * 两边都做，是因为「用户手输的地址」这件事上，任何一边单独可信都不成立。
 */
export async function lookupImUserByEmail(email: string): Promise<ImPeer> {
  const addr = String(email ?? '').trim().toLowerCase()
  if (!EMAIL_RE.test(addr)) throw new ImLookupError('bad_email')
  if (!apiEnabled()) throw new ImLookupError('disabled')

  const me = getCurrentUser()
  // 自己的邮箱在本地就能判掉，不必为此花一次限流额度。
  // 但服务端那条判断**不能因此删掉** —— 这里能改，那里不能。
  if (me?.email && String(me.email).toLowerCase() === addr) throw new ImLookupError('self')

  try {
    const peer = await api.post<ImPeer>('/api/im/lookup', { email: addr })
    if (!peer?.id) throw new ImLookupError('failed', '响应里没有 id')
    return peer
  } catch (e) {
    if (e instanceof ImLookupError) throw e
    if (e instanceof ApiError) {
      const code = (e.data as { code?: string } | null)?.code
      // 认服务端给的 code；没有 code（网关的 502、被兜底成 HTML 的响应）就按状态码兜一下
      throw new ImLookupError((code as ImLookupCode) || (e.status === 404 ? 'not_found' : 'failed'), e.message)
    }
    throw new ImLookupError('failed', e instanceof Error ? e.message : String(e))
  }
}

/* ---------------- 空闲时自动连 + 后台也能收到 ---------------- */

let idleScheduled = false
let ambientWired = false

/**
 * 登录之后在浏览器空闲时把 IM 连起来。
 *
 * 不在登录成功那一刻就连：SDK 有 700 KB，会和首屏的字体、封面图抢带宽。
 * requestIdleCallback 等到主线程真空下来；没有它（Safari 长期不支持）就退回一个
 * 3 秒的 setTimeout —— 比首屏抢带宽晚，比用户找到那颗按钮早。
 *
 * 幂等：多次调用只排一次。
 */
export function startImWhenIdle(): void {
  if (typeof window === 'undefined') return
  wireAmbient()
  if (idleScheduled) return
  if (!getCurrentUser() || !apiEnabled()) return
  idleScheduled = true
  const go = () => {
    idleScheduled = false
    void ensureImStarted()
  }
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
    .requestIdleCallback
  if (typeof ric === 'function') ric(go, { timeout: 8000 })
  else window.setTimeout(go, 3000)
}

/** 标题上的未读前缀，形如 `(3) `。用它把用户自己看到的标题和我们加的前缀区分开 */
const TITLE_BADGE = /^\(\d+\+?\)\s+/

/**
 * 标签页在后台时，用户唯一看得到的就是**标题**。所以未读数写进 document.title。
 *
 * 为什么要 MutationObserver：services/seo.ts 在每次换页时都会整条重写 document.title，
 * 会把我们加的前缀冲掉。监听 <title> 的变化、发现不是自己写的就重新贴一次 ——
 * 比去改 seo.ts 干净（那边不该知道 IM 的存在）。
 *
 * 死循环的防护是「想写的和现在的一样就不写」：自己那次写入触发的回调会原样退出。
 *
 * 没用浏览器通知（Notification API）：那要先向用户要权限，没经他同意就弹权限框
 * 是最招人烦的一类交互。想要的话应该做成设置里的一个开关。
 */
function wireTitleBadge() {
  if (typeof document === 'undefined') return
  const titleEl = document.querySelector('title')
  let base = document.title.replace(TITLE_BADGE, '')

  const apply = () => {
    const label = imUnreadLabel(getImUnread())
    const want = label ? `(${label}) ${base}` : base
    if (document.title !== want) document.title = want
  }

  onImChange(apply)
  if (titleEl) {
    new MutationObserver(() => {
      const stripped = document.title.replace(TITLE_BADGE, '')
      if (stripped === base) return // 自己写的，忽略
      base = stripped
      apply()
    }).observe(titleEl, { childList: true, characterData: true, subtree: true })
  }
  apply()
}

/**
 * 回到前台时自检一次。
 *
 * 桌面浏览器会节流后台标签页的定时器，移动端更会直接冻结整个页面 —— SDK 的心跳
 * 可能早断了而它自己还没反应过来。切回来时如果不是 ready 就重连一次。
 *
 * ready / connecting 不动：SDK 自己有重连逻辑，插一脚只会打断它。
 * kicked / unavailable 也不动：那两种要用户决定，自动重连正是要避免的事。
 */
function wireVisibility() {
  if (typeof document === 'undefined') return
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (!getCurrentUser() || !apiEnabled()) return
    const s = imState()
    if (s === 'ready' || s === 'connecting' || s === 'kicked' || s === 'unavailable') return
    void ensureImStarted()
  })
}

/** 标题未读数和前台自检只装一次，且不依赖有没有登录 */
function wireAmbient() {
  if (ambientWired) return
  ambientWired = true
  wireTitleBadge()
  wireVisibility()
}
