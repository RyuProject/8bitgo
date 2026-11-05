import {
  FLASH_SAVE_BRIDGE_COMPAT_RELEASE,
  FLASH_SAVE_BRIDGE_RELEASE,
} from '../../shared/flash-save-games.js'

/** 短期会话令牌必须留在主影片 FlashVars，不能进入桥 SWF 的请求 URL。 */
export function flashSaveBridgeParameters(parameters) {
  const result = { ...(parameters || {}) }
  if (result.eightbitgo_save_protocol === 'agi2') delete result.eightbitgo_save_token
  return result
}

/**
 * Ruffle 只会把 parameters 交给主影片；旧 AGI SDK 是游戏再用 Loader 单独加载的子影片。
 * 因此还要把可公开参数放到桥 SWF 的 URL query，确保旧桥能从自己的 LoaderInfo 取到。
 * AGI2 的短期会话令牌由 flashSaveBridgeParameters 过滤，不应出现在 SWF 请求 URL、CDN 缓存键或访问日志中。
 */
export function flashSaveBridgeRewriteRules(bridgeUrl, rewriteFrom, parameters) {
  const bridge = new URL(bridgeUrl)
  for (const [key, value] of Object.entries(parameters || {})) {
    bridge.searchParams.set(key, String(value ?? ''))
  }
  const target = bridge.href
  const file = bridge.pathname.split('/').pop() || 'AGI.swf'
  const sources = Array.isArray(rewriteFrom) && rewriteFrom.length
    ? rewriteFrom
    : [
        `http://agi.armorgames.com/assets/agi/${file}`,
        `https://agi.armorgames.com/assets/agi/${file}`,
      ]
  const legacySources = []
  const releasePath = `/armor-games/${FLASH_SAVE_BRIDGE_RELEASE}/`
  if (bridge.pathname.includes(releasePath)) {
    // 已打补丁的副本可能直连旧版本目录，或使用从未版本化的兼容路径。
    // 两个旧入口都保留为 source，目标仍是新版本 + 完整 FlashVars。
    legacySources.push(
      new URL(bridge.pathname.replace(releasePath, `/armor-games/${FLASH_SAVE_BRIDGE_COMPAT_RELEASE}/`), bridge.origin).href,
      new URL(bridge.pathname.replace(releasePath, '/armor-games/'), bridge.origin).href,
    )
  }
  const rules = [...new Set([...sources, ...legacySources])].map((source) => [source, target])

  // 新版、旧版和未版本化直连地址都可能写在游戏补丁里；逐个自映射才能补上 query。
  for (const source of [bridgeUrl, ...legacySources]) {
    if (!rules.some(([existing]) => existing === source)) rules.push([source, target])
  }
  return rules
}
