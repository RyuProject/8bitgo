import { ApiError, api, apiBase, apiEnabled, getToken } from './api'
import { flashSaveBridgeParameters, flashSaveBridgeRewriteRules } from './flashBridgeUrl.js'
// 「哪款游戏用哪套方言、加载哪个桥」只有一份，前后端共用（见该文件顶部说明）
import {
  flashSaveBridgeOf,
  flashSaveGameKeyOf,
  flashSaveLoginUrlsOf,
  flashSaveProtocolOf,
  flashSaveRewriteSourcesOf,
} from '../../shared/flash-save-games.js'

/** 会话还剩多久之内就不再复用了：太接近到期的话，交给游戏的是一个马上就会失效的令牌 */
const SESSION_REUSE_MARGIN_MS = 5 * 60_000

/**
 * 桥通过 ExternalInterface 只能按名字调 iframe 里的函数。
 * 名字和 FlashVars 放在同一个模块里，避免 AS3 和 Ruffle 适配器各写一份后漂移。
 */
export const FLASH_SAVE_LOGIN_CALLBACK = '__eightbitgoFlashSaveLoginRequired'

export type FlashOnlineSaveMode = 'authenticated' | 'guest' | 'unavailable'

interface SessionResponse {
  success: boolean
  data: {
    sessionToken: string
    expiresAt: number
    endpoint: string
    /** agi1 / agi2，仅供排查；桥地址已经按方言定好了 */
    protocol?: string
    bridgeUrl: string
    username: string
    avatar_url: string
  }
}

export interface FlashOnlineSaveLaunch {
  bridgeUrl: string
  /** 旧 SWF 真正请求的 SDK 地址；存在时不能再按 Armor Games 文件名猜。 */
  rewriteFrom: string[]
  /** navigateToURL 绕过 SDK 时，由 Ruffle iframe 把这些旧登录页接回站内登录框。 */
  loginUrls: string[]
  parameters: Record<string, string>
  /**
   * guest 才表示真的没登录；unavailable 是已登录但会话申请失败。
   * 两者给 SWF 的 token 都是空，但页面绝不能把服务器故障误报成「请登录」。
   */
  mode: FlashOnlineSaveMode
  /**
   * 会话到期时间（毫秒）；0 = 游客模式或拿不到会话。
   * 登录 / 登出可通过 AGI2 的 ExternalInterface 原地换会话；长时间运行导致会话自然到期时，
   * 仍提前提示玩家保存并重新进入续期，避免画面正常但后续云存档静默失败。
   */
  expiresAt: number
}

/**
 * Ruffle 的 data 模式虽然给主 SWF 造了本站虚拟地址，但远程游戏还会带自己的 base。
 * 如果把 `/api/...` 这种根相对地址交给旧 SWF，URLLoader 可能按 ROM 源站解析，最后请求到
 * assets.8bitgo.com/api。进入 FlashVars 前统一变成绝对地址，彻底消除这层歧义。
 */
function absoluteUrl(path: string, base: string): string {
  try {
    return new URL(path, `${base.replace(/\/+$/, '')}/`).href
  } catch {
    return path
  }
}

function siteUrl(path: string): string {
  return absoluteUrl(path, window.location.origin)
}

function saveApiUrl(path: string): string {
  return absoluteUrl(path, apiBase() || window.location.origin)
}

/**
 * 申请一次在线存档会话，网络类失败重试一次。
 *
 * 为什么分两类：切后台回来、弱网抖一下都会让 fetch 直接抛，而一次失败就让整局退成游客态，
 * 玩家看到的是「在线槽忽然不能用了」，也没有任何重试入口。4xx 则是明确的拒绝
 * （令牌失效 / 被限流 / 未启用），重试只是白打一次请求 —— 那种情况直接退不可用模式。
 */
/**
 * 会话请求的总时限。Ruffle 启动链会 `await` 这份会话（和 SWF、WASM 并行），而 api.post
 * 没有超时：API 卡住时已登录玩家会**永远**停在加载遮罩上，游客反而能玩。超时后按
 * 「unavailable」启动 —— 游戏照常进，只是这一局的在线槽不可用，和服务故障时的表现一致。
 */
export const FLASH_SAVE_SESSION_TIMEOUT_MS = 6000

async function requestSessionOnce(gameSlug: string): Promise<SessionResponse | null> {
  try {
    return await api.post<SessionResponse>('/api/flash-saves/v1/session', { gameSlug })
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) return null
    await new Promise((resolve) => window.setTimeout(resolve, 600))
    try {
      return await api.post<SessionResponse>('/api/flash-saves/v1/session', { gameSlug })
    } catch {
      return null
    }
  }
}

async function requestSession(gameSlug: string): Promise<SessionResponse | null> {
  let timer = 0
  const timeout = new Promise<null>((resolve) => {
    timer = window.setTimeout(() => {
      console.warn(`[flash-save] 在线存档会话 ${FLASH_SAVE_SESSION_TIMEOUT_MS}ms 未返回，按不可用模式启动`)
      resolve(null)
    }, FLASH_SAVE_SESSION_TIMEOUT_MS)
  })
  try {
    return await Promise.race([requestSessionOnce(gameSlug), timeout])
  } finally {
    window.clearTimeout(timer)
  }
}

/**
 * 会话缓存（只在内存里，键 = 游戏 slug + **当前登录令牌**）。
 *
 * 为什么要缓存：每重新挂载一次播放器（重开局、切布局、换语言重来）都会申请一次会话，
 * 而服务端对会话申请是限流的。打满之后整小时都退成游客态，玩家只会觉得「在线槽突然坏了」。
 *
 * ⚠️ 键里带上登录令牌，是为了让登出/换号自动失效 —— 否则退出登录后同一个页面里
 * 还留着上一份可写会话，那是个不该有的窗口。令牌本身不落任何持久存储。
 */
const sessionCache = new Map<string, { expiresAt: number; launch: FlashOnlineSaveLaunch }>()

/**
 * 未登录也返回桥地址：替代 AGI 的 isLoggedIn() 会返回 false，游戏原来的本地三槽照常可用。
 * 登录令牌只在父页面换成短期 sessionToken，完整 JWT 永远不会进入 SWF。
 */
export async function prepareFlashOnlineSave(gameSlug?: string): Promise<FlashOnlineSaveLaunch | null> {
  if (!gameSlug) return null
  const bridgeUrl = flashSaveBridgeOf(gameSlug)
  // 没接在线存档的游戏直接返回 null：不申请会话、不改写 URL，行为与接入前完全一致
  if (!bridgeUrl) return null
  const guest: FlashOnlineSaveLaunch = {
    bridgeUrl: siteUrl(bridgeUrl),
    rewriteFrom: flashSaveRewriteSourcesOf(gameSlug),
    loginUrls: flashSaveLoginUrlsOf(gameSlug),
    expiresAt: 0,
    mode: 'guest',
    parameters: {
      eightbitgo_save_endpoint: saveApiUrl(`/api/flash-saves/v1/${encodeURIComponent(gameSlug)}`),
      eightbitgo_save_token: '',
      eightbitgo_username: '',
      eightbitgo_avatar_url: siteUrl('/ui/logo-mark.png'),
      // 桥只在 guest 时呼叫登录弹窗；unavailable 代表故障，不该让用户反复登录。
      eightbitgo_save_mode: 'guest',
      eightbitgo_login_callback: FLASH_SAVE_LOGIN_CALLBACK,
      eightbitgo_game_slug: gameSlug,
      eightbitgo_save_protocol: flashSaveProtocolOf(gameSlug),
      // AGI1 不再把 infect-2 写死在桥里，新游戏只需在共用接入表配一次。
      eightbitgo_agi_game_key: flashSaveGameKeyOf(gameSlug),
    },
  }
  const authToken = getToken()
  if (!apiEnabled() || !authToken) return guest

  const cacheKey = `${gameSlug}|${authToken}`
  const cached = sessionCache.get(cacheKey)
  if (cached && cached.expiresAt - Date.now() > SESSION_REUSE_MARGIN_MS) return cached.launch

  const response = await requestSession(gameSlug)
  if (!response?.success || !response.data?.sessionToken) {
    // 在线槽拿不到不能挡住整个游戏；游戏自己的本地槽和 Ruffle 快照仍然可用。
    console.warn('[flash-save] 已登录但没拿到在线存档会话，按不可用模式启动')
    return {
      ...guest,
      mode: 'unavailable',
      parameters: { ...guest.parameters, eightbitgo_save_mode: 'unavailable' },
    }
  }
  const launch: FlashOnlineSaveLaunch = {
    bridgeUrl: siteUrl(response.data.bridgeUrl || bridgeUrl),
    rewriteFrom: guest.rewriteFrom,
    loginUrls: guest.loginUrls,
    expiresAt: Number(response.data.expiresAt) || 0,
    mode: 'authenticated',
    parameters: {
      ...guest.parameters,
      eightbitgo_save_endpoint: saveApiUrl(response.data.endpoint),
      eightbitgo_save_token: response.data.sessionToken,
      eightbitgo_username: response.data.username,
      eightbitgo_avatar_url: siteUrl(response.data.avatar_url),
      eightbitgo_save_mode: 'authenticated',
    },
  }
  sessionCache.set(cacheKey, { expiresAt: launch.expiresAt, launch })
  return launch
}

export function flashOnlineSaveRuffleConfig(launch: FlashOnlineSaveLaunch | null): Record<string, unknown> {
  if (!launch) return {}
  /*
    只改写这款游戏真正会加载的那个桥文件名（AGI.swf / AGI2.swf）。
    不能把两代的地址都指过来：两套接口不兼容，指错了另一代会拿到错误的实现。
    旧补丁里写死的 Armor Games、旧版本目录和未版本化本站地址都保留为来源，
    再统一转到新版目标 URL；这样桥升级不需要重新打包游戏 SWF。
  */
  /*
    KRF 的 connect({stage}) 能从主影片 LoaderInfo 读取 Ruffle 的 parameters；AGI2 桥自身也有
    URL 参数兜底，但短期会话令牌不应进入 SWF 请求 URL（CDN / 反代访问日志和缓存键会留下它）。
    根影片参数仍由 Ruffle 正常注入，且运行中登录改用 ExternalInterface 更新桥。
  */
  const bridgeParameters = flashSaveBridgeParameters(launch.parameters)
  return {
    parameters: launch.parameters,
    urlRewriteRules: flashSaveBridgeRewriteRules(launch.bridgeUrl, launch.rewriteFrom, bridgeParameters),
  }
}
