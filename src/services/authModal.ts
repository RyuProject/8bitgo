/**
 * 全局登录弹窗的开关状态。
 * 用模块级订阅（不依赖 React Context），任何地方都能命令式地 openAuthModal() 打开。
 * 登录成功后由 AuthModal 自身关闭。
 */
import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function openAuthModal() {
  if (open) return
  open = true
  emit()
}

export function closeAuthModal() {
  if (!open) return
  open = false
  emit()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useAuthModalOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open, () => open)
}
