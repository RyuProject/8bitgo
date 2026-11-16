/**
 * Ruffle 的 EditText 按词键盘操作存在越界 panic：坏掉后整局 WASM 都不能继续运行。
 * 在核心加载前把这些组合键降成单字符操作，保留输入能力并绕开不安全的词边界分支。
 */
type RuffleWindow = Window & typeof globalThis

const WORD_SHORTCUT_KEYS: Record<string, { key: string; keyCode: number }> = {
  Backspace: { key: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', keyCode: 46 },
  ArrowLeft: { key: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', keyCode: 39 },
}

/**
 * Ruffle 的 Ctrl/Alt/Command + Backspace/Delete/左右键会进入 Rust 的按词边界计算，
 * 在遇到不一致的文本光标位置时可能因字符串索引越界 panic。普通按键仍交给原生处理。
 */
export function installRuffleWordShortcutGuard(win: RuffleWindow, doc: Document): () => void {
  const normalizeWordShortcut = (event: KeyboardEvent) => {
    if (!event.ctrlKey && !event.metaKey && !event.altKey) return

    const shortcut = WORD_SHORTCUT_KEYS[event.code] ?? WORD_SHORTCUT_KEYS[event.key]
    if (!shortcut) return

    // 避免浏览器执行 Alt+Left 返回等默认动作，同时让 Ruffle 收到安全的单字符按键。
    event.preventDefault()
    event.stopImmediatePropagation()

    const target = event.target ?? doc.activeElement ?? doc.body ?? win
    try {
      const normalized = new win.KeyboardEvent(event.type, {
        key: shortcut.key,
        code: shortcut.key,
        keyCode: shortcut.keyCode,
        location: event.location,
        repeat: event.repeat,
        shiftKey: event.shiftKey,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: win,
      } as KeyboardEventInit)
      target.dispatchEvent(normalized)
    } catch {
      // iframe 正在销毁时，丢掉这次按键比让诊断钩子影响游戏更安全。
    }
  }

  // 必须先于 ruffle.js 安装，让捕获阶段可以拦截原始组合键。
  win.addEventListener('keydown', normalizeWordShortcut, true)
  win.addEventListener('keyup', normalizeWordShortcut, true)

  return () => {
    win.removeEventListener('keydown', normalizeWordShortcut, true)
    win.removeEventListener('keyup', normalizeWordShortcut, true)
  }
}
