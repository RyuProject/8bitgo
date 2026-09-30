/**
 * socket.io 事件参数守卫。
 *
 * 为什么需要：服务端所有 handler 都写成 `(payload, ack)`，并用 `ack?.(...)` 回包。
 * 可 `?.` 只跳过 null/undefined —— 客户端 `emit('join-room', {}, 1)` 把数字塞在 ack 的位置，
 * `ack?.()` 就会抛 “ack is not a function”。socket.io 4.x 在 process.nextTick 里同步调用
 * handler、外面没有 try/catch，同步 handler 抛错直接变成 uncaughtException →
 * index.js 退出进程 → systemd 连续重启 10 次后进入 start-limit，全站下线。
 * 一行浏览器控制台代码、不需要登录就能打挂整站。
 *
 * 做法：每条连接挂一个中间件，只保留「payload + 末尾真正的函数 ack」。
 * socket.io 只有在客户端请求回包时才会在参数末尾追加 ack 函数，所以合法调用不受影响。
 */
export function guardSocketArgs(socket) {
  socket.use((packet, next) => {
    // packet = [event, ...args]
    const args = packet.slice(1)
    const last = args[args.length - 1]
    const ack = typeof last === 'function' ? last : undefined
    const data = args.length > 0 && typeof args[0] !== 'function' ? args[0] : undefined
    packet.length = 1
    packet.push(data)
    if (ack) packet.push(ack)
    next()
  })
}
