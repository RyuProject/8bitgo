/**
 * 只把短期、逐游戏的在线存档会话交给当前 AGI2 实例。
 * Ruffle 的 ExternalInterface 能在不中断 SWF 的情况下调用桥暴露的方法；
 * 这比登录后重启游戏安全，因为重启会丢掉尚未保存的当前波次。
 */
/**
 * 登录框没登录就关掉（或会话签发失败）时，让 AGI2 桥把挂起的 showLogin 回调按当前状态结掉。
 * 桥版本过旧没有这个回调时返回 false，桥自己的超时兜底仍然生效。
 */
export function settleAgi2BridgeLogin(target) {
  if (!target || typeof target.callExternalInterface !== 'function') return false
  try {
    return target.callExternalInterface('eightbitgoLoginSettled') === true
  } catch {
    return false
  }
}

export function updateAgi2BridgeSession(target, parameters) {
  if (!target || typeof target.callExternalInterface !== 'function') return false
  const values = parameters || {}
  try {
    return target.callExternalInterface(
      'eightbitgoSetSession',
      values.eightbitgo_save_token || '',
      values.eightbitgo_username || '',
      values.eightbitgo_avatar_url || '',
      values.eightbitgo_save_mode || 'guest',
    ) === true
  } catch {
    return false
  }
}
