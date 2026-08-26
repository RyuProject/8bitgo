/**
 * 播放器相关的通用小工具。运行时（EmulatorJS / Ruffle）的挂载逻辑见 src/runtimes/。
 */
import { getT } from '@/services/i18n'
export { EJS_PATH } from '@/runtimes/emulatorjs'
export { RUFFLE_PATH } from '@/runtimes/ruffle'

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

/** EmulatorJS 默认键位（出厂设置，可在模拟器设置菜单中修改） */
export const defaultKeymap: Array<{ button: string; key: string }> = [
  { button: getT().keymap.dpad, key: '↑ ↓ ← →' },
  { button: 'A', key: 'Z' },
  { button: 'B', key: 'X' },
  { button: 'X', key: 'A' },
  { button: 'Y', key: 'S' },
  { button: 'L', key: 'Q' },
  { button: 'R', key: 'E' },
  { button: 'Start', key: 'Enter' },
  { button: 'Select', key: 'V' },
]
