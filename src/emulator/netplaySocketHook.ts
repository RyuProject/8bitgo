/**
 * EmulatorJS 联机信令 socket 的两处挂钩（适配器 emulatorjs.ts 的 hookRoomToken 在用）。
 *
 * ## 1. 全局 io 会被引擎自己覆盖（2026-11-11 线上取证）
 *
 * 适配器在 loader.js **之前**把 iframe 的 `io` 换成一层 Proxy，用来给 open-room / join-room 补
 * game_slug、挂 room-token、记录握手轨迹。可自建的 `emulator.min.js` 里**自带一份 socket.io 客户端**，
 * 加载时执行 UMD 的 `(globalThis).io = e()` —— 那层 Proxy 被原样覆盖掉，之后引擎 `io(this.url)`
 * 拿到的是未包装的版本。后果全部静默：
 *   - 服务端按 game_slug 定人数，缺了就回 "game does not support multiplayer"，开房永远被拒；
 *   - 拒绝原因、信令连接 / 断开 / 回执一样都记不到，诊断包只剩「信令 未连上、房间请求 没发出」。
 * 所以不能只赋一次值，要把 `io` 钉成访问器：**之后谁再给它赋值，都先包一层再存**。
 *
 * ## 2. 没连上就断，引擎会把 socket 扔掉
 *
 * socket.io-client 的 `Socket.onclose` 不管连没连上过都会发 `disconnect`；EmulatorJS 收到
 * `disconnect` 就 `leaveRoom()`，里面 `this.socket.disconnect(); this.socket = null`。
 * 握手刚成功、命名空间 CONNECT 还没回来时链路一抖（大陆到海外节点很常见），
 * 本来 socket.io 会自己重连，现在连 socket 带重连一起被扔了，适配器白等到超时。
 * 诊断包里「传输 ?」（socket 已经是 null）就是这个现场。
 * 这里只拦**从未连上过**的那种 disconnect；连上之后的断线照旧交给引擎退房。
 */

type AnyFn = (...args: unknown[]) => unknown

/**
 * 让 `win.io` 之后的每一次赋值都先经过 `wrap`。
 * 已经包过的（wrap 返回值带 __8bit）不会重复包。返回 false 表示这个窗口改不了。
 */
export function installIoHook(win: Record<string, unknown>, wrap: (io: AnyFn) => AnyFn): boolean {
  const wrapOnce = (v: unknown): unknown =>
    typeof v === 'function' && !(v as { __8bit?: boolean }).__8bit ? wrap(v as AnyFn) : v
  let current = wrapOnce(win.io)
  try {
    Object.defineProperty(win, 'io', {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (v: unknown) => {
        current = wrapOnce(v)
      },
    })
    return true
  } catch {
    // 不可配置的属性（理论上不会出现）：退回一次性赋值，至少和以前一样
    try {
      win.io = current
    } catch {
      /* 没办法了 */
    }
    return false
  }
}

/**
 * 给 io(url) 补一个更短的握手超时。
 * socket.io 默认 20 秒才判一次握手超时 —— 恰好等于适配器的整体等待，一次卡住的握手就把机会用光；
 * 缩短后同样的时间里能自动重试两三轮。调用方显式传了 timeout 的不动。
 */
export function withSignalTimeout(args: unknown[], timeoutMs: number): unknown[] {
  const out = [...args]
  if (typeof out[0] === 'string' || out[0] instanceof URL) {
    const opts = out[1]
    if (opts && typeof opts === 'object') {
      if (!('timeout' in opts)) out[1] = { ...(opts as object), timeout: timeoutMs }
    } else if (out.length < 2 || opts === undefined) {
      out[1] = { timeout: timeoutMs }
    }
  } else if (out[0] && typeof out[0] === 'object' && !('timeout' in (out[0] as object))) {
    out[0] = { ...(out[0] as object), timeout: timeoutMs }
  } else if (out.length === 0) {
    out.push({ timeout: timeoutMs })
  }
  return out
}

interface HookableSocket {
  on?: (ev: string, cb: AnyFn) => unknown
}

/**
 * 之后用 sock.on('disconnect', …) 注册的监听，在 socket 从未连上过时一律不触发。
 * 返回 false 表示这个对象没有 on 方法，什么也没改。
 */
export function guardPreConnectDisconnect(sock: HookableSocket | undefined, onSwallowed?: (reason: unknown) => void): boolean {
  if (!sock || typeof sock.on !== 'function') return false
  const realOn = sock.on.bind(sock)
  let everConnected = false
  realOn('connect', () => {
    everConnected = true
  })
  sock.on = (ev: string, cb: AnyFn) => {
    if (ev !== 'disconnect' || typeof cb !== 'function') return realOn(ev, cb)
    return realOn(ev, (...args: unknown[]) => {
      if (!everConnected) {
        onSwallowed?.(args[0])
        return undefined
      }
      return cb(...args)
    })
  }
  return true
}
