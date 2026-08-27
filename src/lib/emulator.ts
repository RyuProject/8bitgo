/**
 * 播放器相关的通用小工具。运行时（EmulatorJS / Ruffle）的挂载逻辑见 src/runtimes/。
 */
import { getT } from '@/services/i18n'
export { EJS_PATH, RUFFLE_PATH } from '@/emulator'


/** 判断文件后缀是否在允许的 ROM 类型内 */
export function isRomFileAccepted(file: File, extensions: string[]): boolean {
  const name = file.name.toLowerCase()
  return extensions.some((ext) => name.endsWith(ext))
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 默认键位表。
 *
 * 两处修正：
 * 1. 以前是 `export const defaultKeymap = [...]`，模块求值时就调了 getT()。
 *    而语言是在 entry-client / entry-server 里 setLangForRender 之后才定下来的，
 *    所以「方向键」那一行永远是默认语言 —— 英文站上会显示中文。改成函数，用的时候再取。
 * 2. NES 实际跑的是 jsnes（见 config/emulators.ts 的扩展名覆盖表），
 *    它的默认键位和 EmulatorJS 不一样：A 是 X、B 是 Z、Select 是右 Ctrl。
 *    以前不分平台一律显示 EmulatorJS 的键位，NES 玩家看到的 A/B 是反的。
 */
export function getDefaultKeymap(runtimeId?: string): Array<{ button: string; key: string }> {
  const dpad = { button: getT().keymap.dpad, key: '↑ ↓ ← →' }
  if (runtimeId === 'jsnes') {
    return [
      dpad,
      { button: 'A', key: 'X' },
      { button: 'B', key: 'Z' },
      { button: 'Turbo A', key: 'S' },
      { button: 'Turbo B', key: 'A' },
      { button: 'Start', key: 'Enter' },
      { button: 'Select', key: 'Right Ctrl' },
    ]
  }
  return [
    dpad,
    { button: 'A', key: 'Z' },
    { button: 'B', key: 'X' },
    { button: 'X', key: 'A' },
    { button: 'Y', key: 'S' },
    { button: 'L', key: 'Q' },
    { button: 'R', key: 'E' },
    { button: 'Start', key: 'Enter' },
    { button: 'Select', key: 'V' },
  ]
}
