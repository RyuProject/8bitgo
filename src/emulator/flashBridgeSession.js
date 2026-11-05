/**
 * 只把短期、逐游戏的在线存档会话交给当前 AGI2 实例。
 * Ruffle 的 ExternalInterface 能在不中断 SWF 的情况下调用桥暴露的方法；
 * 这比登录后重启游戏安全，因为重启会丢掉尚未保存的当前波次。
 */
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
