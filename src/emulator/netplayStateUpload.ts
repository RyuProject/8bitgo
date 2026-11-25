type PendingUpload = {
  fingerprint: string
  state: Uint8Array
  keepalive: boolean
}

/**
 * 串行写入联机房间存档，并只保留上传期间最新的一份快照。
 *
 * 定时器可能在上一份存档还没发完时再次触发。并发 POST 的完成顺序不受发送顺序保证，
 * 较早的快照若晚到会覆盖服务端的新进度；因此同一房间只允许一个请求在途。
 */
export function createNetplayStateUploadQueue(
  upload: (state: Uint8Array, keepalive: boolean) => Promise<boolean>,
): { submit: (fingerprint: string, state: Uint8Array, keepalive?: boolean) => void } {
  let inFlight: PendingUpload | null = null
  let latest: PendingUpload | null = null
  let lastUploadedFingerprint = ''

  const pump = () => {
    if (inFlight || !latest) return
    const current = latest
    latest = null
    inFlight = current

    void Promise.resolve()
      .then(() => upload(current.state, current.keepalive))
      .then((ok) => {
        // 失败的内容不能记作已上传，否则后续相同进度会被永久跳过。
        if (ok) lastUploadedFingerprint = current.fingerprint
      })
      .catch(() => {})
      .finally(() => {
        inFlight = null
        // 期间若游戏又变过，只发最后一份；中间快照没有恢复价值。
        if (latest && (latest.keepalive || latest.fingerprint !== lastUploadedFingerprint)) pump()
        else latest = null
      })
  }

  return {
    submit(fingerprint, state, keepalive = false) {
      if (!keepalive && !inFlight && fingerprint === lastUploadedFingerprint) return
      if (!keepalive && inFlight?.fingerprint === fingerprint) {
        // 恢复到当前在途快照时，丢弃期间排队的旧中间态。
        latest = null
        return
      }
      // getState 返回的是快照，但复制后不依赖引擎是否复用底层缓冲区。
      latest = { fingerprint, state: state.slice(), keepalive }
      pump()
    },
  }
}
