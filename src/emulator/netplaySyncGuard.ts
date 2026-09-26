/**
 * 房主接收 socket.io 按键时，把访客的帧号换成房主自己的时间轴。
 *
 * EmulatorJS 访客进房后会冻结本地帧循环，simulateInput() 却仍发送
 * `currentFrame + 20`。房主玩过第 20 帧以后，这些按键会永远留在
 * inputsData[20]：引擎只在那一帧到来时才删它。访客也能故意填一个
 * 极远的帧号制造同样的内存累积；服务器不知道房主当前帧，必须在房主端改。
 */

const MAX_SYNC_ENTRIES = 32
const FRAME_LEAD = 20

type SyncInput = { frame: number; connected_input: [number, number, number] }

function validInput(value: unknown): value is { connected_input: [number, number, number] } {
  if (!value || typeof value !== 'object') return false
  const input = (value as { connected_input?: unknown }).connected_input
  if (!Array.isArray(input) || input.length !== 3) return false
  const [player, index, state] = input
  return Number.isInteger(player) && player >= 0 && player < 4
    && Number.isInteger(index) && index >= 0 && index <= 63
    && typeof state === 'number' && Number.isFinite(state) && Math.abs(state) <= 32768
}

/** 只改房主收到的 sync-control；聊天、暂停等其它字段保持原样。 */
export function normalizeHostSync(message: unknown, owner: boolean, currentFrame: number): unknown {
  if (!owner || !message || typeof message !== 'object' || Array.isArray(message)) return message
  const data = message as Record<string, unknown>
  // Object.hasOwn 要到 Safari 15.4 才有；这里不能让联机按键因为一个语法无关的辅助 API 中断。
  if (!Object.prototype.hasOwnProperty.call(data, 'sync-control')) return message

  // 永远只占用离当前帧约 20 帧的一小段窗口，不能让远期 / 过期帧把 inputsData 撑大。
  const frame = Math.min(2 ** 31 - 1, Math.max(0, Number.isFinite(currentFrame) ? Math.floor(currentFrame) : 0) + FRAME_LEAD)
  const raw = data['sync-control']
  const kept: SyncInput[] = Array.isArray(raw)
    ? raw.filter(validInput).slice(0, MAX_SYNC_ENTRIES).map((entry) => ({ frame, connected_input: entry.connected_input }))
    : []
  const safe = { ...data }
  if (kept.length) safe['sync-control'] = kept
  else delete safe['sync-control']
  return safe
}
