import { api, apiBase, apiEnabled, getToken } from './api'

/**
 * 每款旧 Flash 的外部 API 面并不相同，只有逐款核过调用契约才能打开改写。
 * 以后接第二款时在这里加配置，同时把后端 FLASH_SAVE_GAMES 加上同一个 slug。
 */
const BRIDGES = new Map([
  ['infectonator-2', '/flash-api/armor-games/AGI.swf'],
])

interface SessionResponse {
  success: boolean
  data: {
    sessionToken: string
    expiresAt: number
    endpoint: string
    bridgeUrl: string
    username: string
    avatar_url: string
  }
}

export interface FlashOnlineSaveLaunch {
  bridgeUrl: string
  parameters: Record<string, string>
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
 * 未登录也返回桥地址：替代 AGI 的 isLoggedIn() 会返回 false，游戏原来的本地三槽照常可用。
 * 登录令牌只在父页面换成短期 sessionToken，完整 JWT 永远不会进入 SWF。
 */
export async function prepareFlashOnlineSave(gameSlug?: string): Promise<FlashOnlineSaveLaunch | null> {
  if (!gameSlug) return null
  const bridgeUrl = BRIDGES.get(gameSlug)
  if (!bridgeUrl) return null
  const guest: FlashOnlineSaveLaunch = {
    bridgeUrl: siteUrl(bridgeUrl),
    parameters: {
      eightbitgo_save_endpoint: saveApiUrl(`/api/flash-saves/v1/${encodeURIComponent(gameSlug)}`),
      eightbitgo_save_token: '',
      eightbitgo_username: '',
      eightbitgo_avatar_url: siteUrl('/ui/logo-mark.png'),
    },
  }
  if (!apiEnabled() || !getToken()) return guest
  try {
    const response = await api.post<SessionResponse>('/api/flash-saves/v1/session', { gameSlug })
    if (!response.success || !response.data?.sessionToken) return guest
    return {
      bridgeUrl: siteUrl(response.data.bridgeUrl || bridgeUrl),
      parameters: {
        eightbitgo_save_endpoint: saveApiUrl(response.data.endpoint),
        eightbitgo_save_token: response.data.sessionToken,
        eightbitgo_username: response.data.username,
        eightbitgo_avatar_url: siteUrl(response.data.avatar_url),
      },
    }
  } catch (error) {
    // 在线槽拿不到不能挡住整个游戏；游戏自己的本地槽和 Ruffle 快照仍然可用。
    console.warn('[flash-save] 申请在线存档会话失败，将按未登录模式启动', error)
    return guest
  }
}

export function flashOnlineSaveRuffleConfig(launch: FlashOnlineSaveLaunch | null): Record<string, unknown> {
  if (!launch) return {}
  return {
    parameters: launch.parameters,
    urlRewriteRules: [
      ['http://agi.armorgames.com/assets/agi/AGI.swf', launch.bridgeUrl],
      ['https://agi.armorgames.com/assets/agi/AGI.swf', launch.bridgeUrl],
    ],
  }
}
