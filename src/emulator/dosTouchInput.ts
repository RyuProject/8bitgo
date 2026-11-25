/**
 * DOS 触屏输入的按住状态。
 *
 * 浏览器在切后台、系统手势接管或 React 拆掉浮层时可能不再派发 pointerup；统一记住来源，
 * 失焦时松开所有键鼠，避免 DOS 游戏把方向键或鼠标键一直当成按住。
 */
export class DosTouchInputLatch {
  private readonly keys = new Map<number, Set<string>>()
  private readonly buttons = new Map<0 | 1, Set<string>>()
  private readonly sendKey: (key: number, down: boolean) => void
  private readonly sendMouseButton: (button: 0 | 1, down: boolean) => void

  constructor(
    sendKey: (key: number, down: boolean) => void,
    sendMouseButton: (button: 0 | 1, down: boolean) => void,
  ) {
    this.sendKey = sendKey
    this.sendMouseButton = sendMouseButton
  }

  key(source: string, key: number, down: boolean): void {
    this.update(this.keys, key, source, down, this.sendKey)
  }

  mouseButton(source: string, button: 0 | 1, down: boolean): void {
    this.update(this.buttons, button, source, down, this.sendMouseButton)
  }

  releaseAll(): void {
    const keys = [...this.keys.keys()]
    const buttons = [...this.buttons.keys()]
    this.keys.clear()
    this.buttons.clear()
    for (const key of keys) this.safeSend(this.sendKey, key, false)
    for (const button of buttons) this.safeSend(this.sendMouseButton, button, false)
  }

  private update<T extends number>(
    states: Map<T, Set<string>>,
    code: T,
    source: string,
    down: boolean,
    send: (code: T, down: boolean) => void,
  ): void {
    let sources = states.get(code)
    if (down) {
      if (!sources) {
        sources = new Set()
        states.set(code, sources)
      }
      if (sources.has(source)) return
      sources.add(source)
      if (sources.size === 1) this.safeSend(send, code, true)
      return
    }
    if (!sources?.delete(source)) return
    if (sources.size === 0) {
      states.delete(code)
      this.safeSend(send, code, false)
    }
  }

  private safeSend<T extends number>(send: (code: T, down: boolean) => void, code: T, down: boolean): void {
    try {
      send(code, down)
    } catch {
      // 引擎可能已先于浮层卸载；松键清理不能反过来阻止 UI 收尾。
    }
  }
}

/** pointercancel / 失去捕获代表手势被系统接管，不能当成一次点击。 */
export function isDosTouchTap(distance: number, allowTap: boolean): boolean {
  return allowTap && distance < 6
}

/** 页面失焦、离页或切后台时释放虚拟键鼠，返回值供组件卸载时解除监听。 */
export function watchDosTouchInputFocusLoss(latch: DosTouchInputLatch, afterRelease?: () => void): () => void {
  const release = () => {
    latch.releaseAll()
    afterRelease?.()
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') release()
  }
  window.addEventListener('blur', release)
  window.addEventListener('pagehide', release)
  document.addEventListener('visibilitychange', onVisibilityChange)
  return () => {
    window.removeEventListener('blur', release)
    window.removeEventListener('pagehide', release)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}
