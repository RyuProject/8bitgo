/** 合并键盘、手柄与触屏的同一动作，避免一个输入源松开时误释放另一个仍按住的键。 */
export function createInputSourceRouter<T extends string>(send: (button: T, down: boolean) => void) {
  const sourcesByButton = new Map<T, Set<string>>()

  const set = (button: T, down: boolean, source: string) => {
    let sources = sourcesByButton.get(button)
    if (!sources) {
      if (!down) return
      sources = new Set<string>()
      sourcesByButton.set(button, sources)
    }

    const wasDown = sources.size > 0
    if (down) sources.add(source)
    else sources.delete(source)
    const isDown = sources.size > 0

    if (wasDown !== isDown) send(button, isDown)
    if (!isDown) sourcesByButton.delete(button)
  }

  const releaseSource = (source: string) => {
    for (const [button, sources] of sourcesByButton) {
      if (sources.has(source)) set(button, false, source)
    }
  }

  return { set, releaseSource }
}
