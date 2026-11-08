/** DOS 游戏详情页到播放器之间的 IPX 开房命令通道。 */
let sequence = 0
const listeners = new Set<(sequence: number) => void>()

export function requestIpxHost() {
  sequence += 1
  for (const listener of listeners) listener(sequence)
}

export function onIpxHostRequest(listener: (sequence: number) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
