import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

/**
 * 应用壳状态：
 *  - collapsed  桌面端侧边栏是否折叠为图标栏（持久化到 localStorage）
 *  - mobileOpen 移动端抽屉是否打开
 *  - immersive  沉浸模式：隐藏侧边栏与顶栏，只保留内容（游戏运行时使用）
 */
export interface ShellState {
  collapsed: boolean
  setCollapsed: (v: boolean) => void
  toggleCollapsed: () => void
  mobileOpen: boolean
  setMobileOpen: (v: boolean) => void
  immersive: boolean
  setImmersive: (v: boolean) => void
  toggleImmersive: () => void
}

const STORAGE_KEY = '8bitgo.sidebar.collapsed'

const noop = () => {}
const defaultState: ShellState = {
  collapsed: false,
  setCollapsed: noop,
  toggleCollapsed: noop,
  mobileOpen: false,
  setMobileOpen: noop,
  immersive: false,
  setImmersive: noop,
  toggleImmersive: noop,
}

const ShellContext = createContext<ShellState>(defaultState)

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function ShellProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsedState] = useState<boolean>(readCollapsed)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [immersive, setImmersive] = useState(false)

  const setCollapsed = useCallback((v: boolean) => {
    setCollapsedState(v)
    try {
      localStorage.setItem(STORAGE_KEY, v ? '1' : '0')
    } catch {
      /* 忽略：隐私模式等情况下不可用 */
    }
  }, [])

  const toggleCollapsed = useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed])
  const toggleImmersive = useCallback(() => setImmersive((v) => !v), [])

  // 沉浸模式下按 Esc 退出
  useEffect(() => {
    if (!immersive) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setImmersive(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [immersive])

  // 抽屉打开时锁定页面滚动
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [mobileOpen])

  const value = useMemo<ShellState>(
    () => ({
      collapsed,
      setCollapsed,
      toggleCollapsed,
      mobileOpen,
      setMobileOpen,
      immersive,
      setImmersive,
      toggleImmersive,
    }),
    [collapsed, setCollapsed, toggleCollapsed, mobileOpen, immersive, toggleImmersive],
  )

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>
}

export function useShell(): ShellState {
  return useContext(ShellContext)
}
